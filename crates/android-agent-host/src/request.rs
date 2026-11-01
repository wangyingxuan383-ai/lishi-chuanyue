use serde_json::Value;

pub(crate) fn decode(operation: &str, payload: &str) -> Result<Value, &'static str> {
    let mut request: Value = serde_json::from_str(payload).map_err(|_| "agent_invalid_json")?;
    if !request.is_object() {
        return Err("agent_invalid_json");
    }
    if operation == "agent" {
        // Old native callers may provide an envelope. A real command's
        // `request` is its task/model settings and must never replace `op`.
        if request.get("op").is_none() && request["request"].is_object() {
            request = request["request"].take();
        }
        if request["op"].as_str().is_none_or(|op| op.trim().is_empty()) {
            return Err("agent_invalid_operation");
        }
    } else {
        request["op"] = if operation == "resume" {
            "continue"
        } else {
            operation
        }
        .into();
    }
    Ok(request)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn start_and_queued_input_keep_nested_task_configuration() {
        for op in ["start", "continue", "enqueue_input"] {
            let expected = json!({"op":op,"text":"核对时间","request":{"model":{"slot":"aux","model":"test"},"limits":{"inputTokens":475000}},"taskId":"task"});
            assert_eq!(decode("agent", &expected.to_string()).unwrap(), expected);
        }
    }

    #[test]
    fn explicit_legacy_envelope_and_resume_are_supported() {
        assert_eq!(
            decode("agent", r#"{"request":{"op":"list","worldId":"w"}}"#).unwrap(),
            json!({"op":"list","worldId":"w"})
        );
        assert_eq!(
            decode(
                "resume",
                r#"{"taskId":"t","request":{"model":{"slot":"aux"}}}"#
            )
            .unwrap(),
            json!({"op":"continue","taskId":"t","request":{"model":{"slot":"aux"}}})
        );
    }

    #[test]
    fn missing_operation_and_nonobjects_are_rejected_before_dispatch() {
        for payload in [
            "{}",
            r#"{"request":{"model":{}}}"#,
            r#"{"op":"","request":{"op":"start"}}"#,
        ] {
            assert_eq!(
                decode("agent", payload).unwrap_err(),
                "agent_invalid_operation"
            );
        }
        for payload in ["[]", "null", "{"] {
            assert_eq!(decode("agent", payload).unwrap_err(), "agent_invalid_json");
        }
    }
}
