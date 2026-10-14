//! Native-only Android SAF import picker. Its plugin namespace is denied to JS.
//! URI replies go directly to the existing bounded Rust staging reader.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

#[cfg(target_os = "android")]
use tauri::{plugin::PluginHandle, AppHandle, Manager};

#[cfg(any(target_os = "android", test))]
use serde::Deserialize;
#[cfg(any(target_os = "android", test))]
use tauri_plugin_fs::FilePath;

#[cfg(target_os = "android")]
struct AndroidDocumentPicker<R: Runtime>(PluginHandle<R>);

#[cfg(any(target_os = "android", test))]
#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "lowercase", deny_unknown_fields)]
enum NativeReply {
    Idle {},
    Selected { uri: String },
    Cancelled {},
    Failed { code: String },
}

#[cfg(any(target_os = "android", test))]
fn selected_document(reply: NativeReply) -> Result<Option<FilePath>, &'static str> {
    match reply {
        NativeReply::Selected { uri } => {
            if uri.len() > 8192 || uri.chars().any(char::is_control) {
                return Err("file_unavailable");
            }
            let uri = tauri::Url::parse(&uri).map_err(|_| "file_unavailable")?;
            if uri.scheme() != "content" || uri.host_str().is_none() {
                return Err("file_unavailable");
            }
            Ok(Some(FilePath::Url(uri)))
        }
        NativeReply::Cancelled {} => Ok(None),
        NativeReply::Failed { code } => Err(match code.as_str() {
            "file_busy" => "file_busy",
            "file_unconfirmed" => "file_unconfirmed",
            _ => "file_unavailable",
        }),
        NativeReply::Idle {} => Err("file_unavailable"),
    }
}

/// Kotlin may keep a timed-out picker quarantined until it actually returns.
/// Exports must also respect it because Tauri's result callback is shared.
#[cfg(target_os = "android")]
pub async fn ensure_idle(app: &AppHandle) -> Result<(), &'static str> {
    let picker = app.state::<AndroidDocumentPicker<tauri::Wry>>();
    let reply: NativeReply = picker
        .0
        .run_mobile_plugin_async("ensureIdle", serde_json::json!({}))
        .await
        .map_err(|_| "file_unavailable")?;
    match reply {
        NativeReply::Idle {} => Ok(()),
        NativeReply::Failed { code } if code == "file_busy" => Err("file_busy"),
        _ => Err("file_unavailable"),
    }
}

#[cfg(target_os = "android")]
pub async fn pick_import(app: &AppHandle) -> Result<Option<FilePath>, &'static str> {
    let picker = app.state::<AndroidDocumentPicker<tauri::Wry>>();
    // Do not timeout/drop this future: Tauri 2.12.3's late native callback
    // unwraps sending to its receiver. Kotlin owns timeout and single resolution.
    let reply = picker
        .0
        .run_mobile_plugin_async("openDocument", serde_json::json!({}))
        .await
        .map_err(|_| "file_unavailable")?;
    selected_document(reply)
}

/// Rust's invoke handler rejects and handles every frontend invocation, so
/// Tauri cannot fall through to the Kotlin commands or return a URI to JS.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("document-picker")
        .invoke_handler(|invoke| {
            invoke.resolver.reject("file_unavailable");
            true
        })
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let plugin =
                    api.register_android_plugin("io.timejump.lishi", "DocumentPickerPlugin")?;
                app.manage(AndroidDocumentPicker(plugin));
            }
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(json: &str) -> Result<Option<FilePath>, &'static str> {
        selected_document(serde_json::from_str(json).map_err(|_| "file_unavailable")?)
    }

    #[test]
    fn selected_uri_is_content_only_bounded_and_native() {
        assert!(matches!(
            decode(r#"{"status":"selected","uri":"content://example.documents/document/42"}"#),
            Ok(Some(FilePath::Url(_)))
        ));
        for uri in [
            "file:///private/key",
            "https://example.com/file",
            "content:/missing",
        ] {
            let json = serde_json::json!({"status":"selected", "uri":uri}).to_string();
            assert!(matches!(decode(&json), Err("file_unavailable")));
        }
        let oversized = serde_json::json!({"status":"selected", "uri":format!("content://example/{}", "a".repeat(8192))}).to_string();
        assert!(matches!(decode(&oversized), Err("file_unavailable")));
    }

    #[test]
    fn cancel_and_failure_never_include_paths_or_details() {
        assert!(matches!(decode(r#"{"status":"cancelled"}"#), Ok(None)));
        assert!(matches!(
            decode(r#"{"status":"failed","code":"file_busy"}"#),
            Err("file_busy")
        ));
        assert!(matches!(
            decode(r#"{"status":"failed","code":"file_unconfirmed"}"#),
            Err("file_unconfirmed")
        ));
        assert!(matches!(
            decode(r#"{"status":"failed","code":"provider secret detail"}"#),
            Err("file_unavailable")
        ));
        assert!(matches!(
            decode(r#"{"status":"cancelled","uri":"content://unexpected/file"}"#),
            Err("file_unavailable")
        ));
        assert!(matches!(
            decode(r#"{"status":"selected","uri":null}"#),
            Err("file_unavailable")
        ));
    }
}
