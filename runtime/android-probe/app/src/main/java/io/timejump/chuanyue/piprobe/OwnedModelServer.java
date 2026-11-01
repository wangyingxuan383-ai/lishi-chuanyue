package io.timejump.chuanyue.piprobe;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** Fixed owned responses only; no external model, credentials or personal data. */
final class OwnedModelServer implements AutoCloseable {
    private final ServerSocket listener;
    private final File ledger;
    private final List<Socket> sockets = Collections.synchronizedList(new ArrayList<>());
    private final List<JSONObject> requests = Collections.synchronizedList(new ArrayList<>());
    private final AtomicInteger sequence = new AtomicInteger();
    private final CountDownLatch held = new CountDownLatch(1);
    private volatile boolean closed;
    OwnedModelServer(File runDirectory) throws Exception {
        ledger = new File(runDirectory, "mock-ledger.jsonl");
        if (!ledger.createNewFile()) throw new IllegalStateException("Owned model ledger already exists");
        listener = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
        Thread thread = new Thread(() -> {
            while (!closed) {
                try {
                    Socket socket = listener.accept(); sockets.add(socket);
                    new Thread(() -> respond(socket), "owned-model-response").start();
                } catch (Exception error) { if (!closed) throw new RuntimeException(error); }
            }
        }, "owned-model-listener");
        thread.setDaemon(true); thread.start();
    }
    int port() { return listener.getLocalPort(); }
    int count() { return sequence.get(); }
    String requestText(int index) { synchronized (requests) { return requests.get(index).toString(); } }
    boolean awaitHeld() throws Exception { return held.await(30, TimeUnit.SECONDS); }
    private static String line(InputStream input) throws Exception {
        ByteArrayOutputStream value = new ByteArrayOutputStream(); int b;
        while ((b = input.read()) >= 0 && b != '\n') {
            if (b != '\r') value.write(b);
            if (value.size() > 16384) throw new IllegalStateException("Unexpected mock header size");
        }
        return value.toString("UTF-8");
    }
    private static JSONObject tool(int index, String id, String name, JSONObject arguments) throws Exception {
        return new JSONObject().put("index", index).put("id", id).put("type", "function").put("function", new JSONObject().put("name", name).put("arguments", arguments.toString()));
    }
    private static void event(OutputStream output, int number, JSONObject delta, Object finish) throws Exception {
        JSONObject event = new JSONObject().put("id", "probe-" + number).put("object", "chat.completion.chunk").put("created", 1).put("model", "owned-pi-probe").put("choices", new JSONArray().put(new JSONObject().put("index", 0).put("delta", delta).put("finish_reason", finish)));
        output.write(("data: " + event + "\n\n").getBytes(StandardCharsets.UTF_8)); output.flush();
    }
    private void respond(Socket socket) {
        try {
            InputStream input = socket.getInputStream(); OutputStream output = socket.getOutputStream();
            line(input); int length = 0; String header;
            while (!(header = line(input)).isEmpty()) {
                if (header.toLowerCase(java.util.Locale.ROOT).startsWith("content-length:")) length = Integer.parseInt(header.substring(header.indexOf(':') + 1).trim());
            }
            if (length < 1 || length > 1024 * 1024) throw new IllegalStateException("Unexpected owned request size");
            byte[] body = new byte[length]; int at = 0;
            while (at < length) { int count = input.read(body, at, length - at); if (count < 0) throw new IllegalStateException("Incomplete owned request"); at += count; }
            int number;
            synchronized (requests) {
                requests.add(new JSONObject(new String(body, StandardCharsets.UTF_8)));
                number = sequence.incrementAndGet();
                JSONObject record = new JSONObject().put("requestId", "owned-request-" + number).put("sequence", number).put("mockRequests", 1).put("realRequests", 0).put("elapsedRealtimeMs", android.os.SystemClock.elapsedRealtime());
                try (FileOutputStream saved = new FileOutputStream(ledger, true)) { saved.write((record + "\n").getBytes(StandardCharsets.UTF_8)); saved.getFD().sync(); }
            }
            output.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
            if (number == 1) {
                event(output, number, new JSONObject().put("role", "assistant").put("content", "先读独立资料并尝试设置日期。").put("tool_calls", new JSONArray()
                    .put(tool(0, "probe-read", "read_resource", new JSONObject()))
                    .put(tool(1, "probe-clock", "stage_clock", new JSONObject().put("year", 0)))), JSONObject.NULL);
                event(output, number, new JSONObject(), "tool_calls");
            } else if (number == 2) {
                event(output, number, new JSONObject().put("role", "assistant").put("tool_calls", new JSONArray().put(tool(0, "probe-edit", "stage_edit", new JSONObject().put("text", "独立Rust草稿")))), JSONObject.NULL);
                event(output, number, new JSONObject(), "tool_calls");
            } else if (number == 5) {
                event(output, number, new JSONObject().put("role", "assistant").put("content", "正在等待取消验证。"), JSONObject.NULL);
                held.countDown(); return;
            } else {
                event(output, number, new JSONObject().put("role", "assistant").put("content", number == 3 ? "独立草稿已准备，日期设置失败，未写入正式故事。" : "原文和独立草稿结果已恢复。"), JSONObject.NULL);
                event(output, number, new JSONObject(), "stop");
            }
            output.write("data: [DONE]\n\n".getBytes(StandardCharsets.UTF_8)); output.flush(); socket.close();
        } catch (Exception error) {
            try { socket.close(); } catch (Exception ignored) { }
        }
    }
    @Override public void close() throws Exception {
        closed = true; listener.close(); synchronized (sockets) { for (Socket socket : sockets) socket.close(); }
    }
}
