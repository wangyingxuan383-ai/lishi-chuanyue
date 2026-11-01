use pi_host::{AgentConnection, HostError, Incoming, TransportOptions, MAX_FRAME_BYTES};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::io::{
    AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf,
};

struct Peer {
    input: BufReader<ReadHalf<DuplexStream>>,
    output: WriteHalf<DuplexStream>,
}
impl Peer {
    async fn read(&mut self) -> Value {
        let mut line = String::new();
        assert!(self.input.read_line(&mut line).await.unwrap() > 0);
        serde_json::from_str(&line).unwrap()
    }
    async fn send(&mut self, value: Value) {
        let mut bytes = serde_json::to_vec(&value).unwrap();
        bytes.push(b'\n');
        self.output.write_all(&bytes).await.unwrap();
    }
    async fn reply(&mut self, record: &Value, data: Value) {
        self.send(json!({"type":"response","id":record["id"],"ok":true,"data":data}))
            .await;
    }
}
fn pair(options: TransportOptions) -> (AgentConnection, pi_host::IncomingReceiver, Peer) {
    let (native, host) = tokio::io::duplex(4096);
    let (read, write) = tokio::io::split(native);
    let (connection, events) = AgentConnection::attach(read, write, options).unwrap();
    let (read, write) = tokio::io::split(host);
    (
        connection,
        events,
        Peer {
            input: BufReader::new(read),
            output: write,
        },
    )
}
async fn bounded<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), future)
        .await
        .expect("transport must not deadlock")
}

#[tokio::test]
async fn abort_and_steer_are_not_blocked_by_prompt_or_a_tool() {
    let (connection, mut incoming, mut peer) = pair(TransportOptions::default());
    let host = tokio::spawn(async move {
        let prompt = peer.read().await;
        assert_eq!(prompt["method"], "prompt");
        peer.send(json!({"type":"tool_request","requestId":"request-1","sessionId":"session-1","taskId":"task-1","toolCallId":"call-1","name":"read_resource","args":{"kind":"world"}})).await;
        let steer = peer.read().await;
        assert_eq!(steer["method"], "steer");
        peer.reply(&steer, Value::Null).await;
        let abort = peer.read().await;
        assert_eq!(abort["method"], "abort");
        peer.send(json!({"type":"tool_cancel","requestId":"request-1"}))
            .await;
        peer.reply(&abort, Value::Null).await;
        peer.reply(&prompt, json!({"streaming":false,"text":"stopped"}))
            .await;
    });
    let prompt_connection = connection.clone();
    let prompt = tokio::spawn(async move {
        prompt_connection
            .request("prompt", json!({"text":"查原著"}))
            .await
    });
    match bounded(incoming.recv()).await.unwrap() {
        Incoming::ToolRequest(request) => {
            assert_eq!(request.tool_call_id, "call-1");
            assert_eq!(request.args["kind"], "world");
        }
        _ => panic!("expected native tool request"),
    }
    bounded(connection.request("steer", json!({"text":"只读分析"})))
        .await
        .unwrap();
    bounded(connection.request("abort", json!({})))
        .await
        .unwrap();
    assert!(
        matches!(bounded(incoming.recv()).await.unwrap(), Incoming::ToolCancel { request_id } if request_id=="request-1")
    );
    assert!(matches!(
        connection
            .tool_result("request-1", json!({"ok":true}))
            .await,
        Err(HostError::ToolCancelled)
    ));
    assert_eq!(bounded(prompt).await.unwrap().unwrap()["text"], "stopped");
    bounded(host).await.unwrap();
    bounded(connection.close_transport()).await;
}

#[tokio::test]
async fn tool_result_and_actual_error_reach_the_matching_prompt() {
    let (connection, mut incoming, mut peer) = pair(TransportOptions::default());
    let host = tokio::spawn(async move {
        let prompt = peer.read().await;
        peer.send(json!({"type":"event","sessionId":"session-1","taskId":"task-1","event":{"type":"tool_execution_start","toolCallId":"call-1"}})).await;
        peer.send(json!({"type":"tool_request","requestId":"request-1","sessionId":"session-1","taskId":"task-1","toolCallId":"call-1","name":"stage_clock","args":{"year":0}})).await;
        let result = peer.read().await;
        assert_eq!(result["method"], "tool_result");
        assert_eq!(result["params"]["requestId"], "request-1");
        assert_eq!(result["params"]["result"]["error"]["code"], "invalid_year");
        assert!(result.get("id").is_none(), "tool results are notifications");
        peer.reply(&prompt, json!({"text":"年份无效"})).await;
    });
    let request_connection = connection.clone();
    let prompt = tokio::spawn(async move {
        request_connection
            .request("prompt", json!({"text":"调整日期"}))
            .await
    });
    assert!(
        matches!(bounded(incoming.recv()).await.unwrap(), Incoming::Event(value) if value["event"]["toolCallId"]=="call-1")
    );
    let Incoming::ToolRequest(request) = bounded(incoming.recv()).await.unwrap() else {
        panic!("expected tool");
    };
    connection.tool_result(&request.request_id, json!({"ok":false,"error":{"code":"invalid_year","field":"year","message":"year must be positive"}})).await.unwrap();
    assert_eq!(bounded(prompt).await.unwrap().unwrap()["text"], "年份无效");
    bounded(host).await.unwrap();
    bounded(connection.close_transport()).await;
}

#[tokio::test]
async fn out_of_order_responses_keep_command_identity_and_error_details() {
    let (connection, _incoming, mut peer) = pair(TransportOptions::default());
    let first = connection.clone();
    let second = connection.clone();
    let a = tokio::spawn(async move { first.request("inspect", json!({"name":"first"})).await });
    let b = tokio::spawn(async move { second.request("compact", json!({"name":"second"})).await });
    let host = tokio::spawn(async move {
        let first = peer.read().await;
        let second = peer.read().await;
        for request in [second, first] {
            if request["method"] == "compact" {
                peer.send(json!({"type":"response","id":request["id"],"ok":false,"error":{"code":"input_budget_exceeded","message":"budget too small","details":{"input":12001,"budget":12000}}})).await;
            } else {
                peer.reply(&request, json!({"name":request["params"]["name"]}))
                    .await;
            }
        }
    });
    assert_eq!(bounded(a).await.unwrap().unwrap()["name"], "first");
    assert!(
        matches!(bounded(b).await.unwrap(), Err(HostError::Host { code, details:Some(details), .. }) if code=="input_budget_exceeded" && details["budget"]==12000)
    );
    bounded(host).await.unwrap();
    assert_eq!(connection.pending_requests(), 0);
    bounded(connection.close_transport()).await;
}

#[tokio::test]
async fn dropped_waiter_does_not_cancel_or_resend_the_command() {
    let (connection, _incoming, mut peer) = pair(TransportOptions::default());
    let (seen_send, seen) = tokio::sync::oneshot::channel();
    let (continue_send, proceed) = tokio::sync::oneshot::channel();
    let host = tokio::spawn(async move {
        let old = peer.read().await;
        seen_send.send(()).unwrap();
        proceed.await.unwrap();
        peer.reply(&old, json!({"late":true})).await;
        let next = peer.read().await;
        assert_eq!(next["method"], "inspect", "no implicit abort or replay");
        peer.reply(&next, json!({"ready":true})).await;
    });
    let prompt_connection = connection.clone();
    let prompt = tokio::spawn(async move {
        prompt_connection
            .request("prompt", json!({"text":"keep running"}))
            .await
    });
    bounded(seen).await.unwrap();
    assert_eq!(connection.pending_requests(), 1);
    prompt.abort();
    let _ = prompt.await;
    assert_eq!(connection.pending_requests(), 0);
    continue_send.send(()).unwrap();
    assert_eq!(
        bounded(connection.request("inspect", json!({})))
            .await
            .unwrap()["ready"],
        true
    );
    bounded(host).await.unwrap();
    bounded(connection.close_transport()).await;
}

#[tokio::test]
async fn eof_fails_all_pending_without_replay() {
    let (connection, _incoming, mut peer) = pair(TransportOptions::default());
    let c = connection.clone();
    let request = tokio::spawn(async move { c.request("prompt", json!({"text":"pending"})).await });
    assert_eq!(bounded(peer.read()).await["method"], "prompt");
    drop(peer);
    assert!(matches!(
        bounded(request).await.unwrap(),
        Err(HostError::Closed(_))
    ));
    assert_eq!(connection.pending_requests(), 0);
    assert!(matches!(
        connection.request("inspect", json!({})).await,
        Err(HostError::Closed(_))
    ));
    bounded(connection.close_transport()).await;
}

#[tokio::test]
async fn full_event_queue_reports_backpressure_and_releases_pending_abort() {
    let options = TransportOptions {
        incoming_capacity: 1,
        ..TransportOptions::default()
    };
    let (connection, _incoming, mut peer) = pair(options);
    let c = connection.clone();
    let request = tokio::spawn(async move { c.request("abort", json!({})).await });
    peer.read().await;
    for index in 0..2 {
        peer.send(
            json!({"type":"event","sessionId":"s","event":{"type":"progress","index":index}}),
        )
        .await;
    }
    assert!(matches!(
        bounded(request).await.unwrap(),
        Err(HostError::Backpressure)
    ));
    assert!(matches!(
        bounded(connection.wait_closed()).await,
        HostError::Backpressure
    ));
    bounded(connection.close_transport()).await;
}

#[tokio::test]
async fn partial_utf8_frames_are_reassembled_without_rewriting_events() {
    let (connection, mut incoming, mut peer) = pair(TransportOptions::default());
    let bytes = serde_json::to_vec(&json!({"type":"event","sessionId":"s","taskId":"t","event":{"type":"message_update","text":"核对玄幻纪年与人物经历"}})).unwrap();
    let writer = tokio::spawn(async move {
        for part in bytes.chunks(2) {
            peer.output.write_all(part).await.unwrap();
        }
        peer.output.write_all(b"\r\n").await.unwrap();
    });
    assert!(
        matches!(bounded(incoming.recv()).await.unwrap(), Incoming::Event(event) if event["event"]["text"]=="核对玄幻纪年与人物经历")
    );
    bounded(writer).await.unwrap();
    bounded(connection.close_transport()).await;
}

#[tokio::test]
async fn oversized_and_truncated_records_close_cleanly() {
    let (connection, _incoming, mut peer) = pair(TransportOptions::default());
    let writer = tokio::spawn(async move {
        let _ = peer
            .output
            .write_all(&vec![b' '; MAX_FRAME_BYTES + 1])
            .await;
    });
    assert!(matches!(
        bounded(connection.wait_closed()).await,
        HostError::FrameTooLarge
    ));
    bounded(connection.close_transport()).await;
    bounded(writer).await.unwrap();

    let (connection, _incoming, mut peer) = pair(TransportOptions::default());
    peer.output.write_all(b"{\"type\":\"event\"").await.unwrap();
    drop(peer);
    assert!(
        matches!(bounded(connection.wait_closed()).await, HostError::Protocol(reason) if reason=="truncated JSON line")
    );
    bounded(connection.close_transport()).await;
}

#[tokio::test]
async fn close_and_last_handle_drop_release_streams_without_business_ack() {
    let (connection, _incoming, mut peer) = pair(TransportOptions::default());
    let c = connection.clone();
    let request = tokio::spawn(async move { c.request("prompt", json!({})).await });
    peer.read().await;
    bounded(connection.close_transport()).await;
    assert!(matches!(
        bounded(request).await.unwrap(),
        Err(HostError::Closed(_))
    ));
    let mut byte = [0];
    assert_eq!(bounded(peer.input.read(&mut byte)).await.unwrap(), 0);

    let (connection, _incoming, mut peer) = pair(TransportOptions::default());
    drop(connection);
    assert_eq!(bounded(peer.input.read(&mut byte)).await.unwrap(), 0);
}
