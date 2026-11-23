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
    Selected {
        uri: String,
        #[serde(default)]
        name: Option<String>,
    },
    Cancelled {},
    Failed { code: String },
}

#[cfg(any(target_os = "android", test))]
fn percent_decode_str(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (
                (bytes[i + 1] as char).to_digit(16),
                (bytes[i + 2] as char).to_digit(16),
            ) {
                out.push(((hi << 4) | lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(any(target_os = "android", test))]
fn sanitize_document_name(raw: &str) -> Option<String> {
    let leaf = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = leaf
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(512)
        .collect();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        None
    } else {
        Some(cleaned)
    }
}

#[cfg(any(target_os = "android", test))]
fn fallback_uri_name(uri: &tauri::Url) -> Option<String> {
    let last_segment = uri.path_segments()?.next_back().filter(|s| !s.is_empty())?;
    let decoded = percent_decode_str(last_segment);
    let mut leaf = decoded.rsplit(['/', '\\']).next().unwrap_or("");
    if leaf.contains(':') && !decoded.contains('/') && !decoded.contains('\\') {
        if let Some((prefix, rest)) = leaf.split_once(':') {
            if !prefix.is_empty()
                && prefix
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
                && !rest.trim().is_empty()
            {
                leaf = rest;
            }
        }
    }
    sanitize_document_name(leaf)
}

#[cfg(any(target_os = "android", test))]
fn selected_document(
    reply: NativeReply,
) -> Result<Option<(FilePath, Option<String>)>, &'static str> {
    match reply {
        NativeReply::Selected { uri, name } => {
            if uri.len() > 8192 || uri.chars().any(char::is_control) {
                return Err("file_unavailable");
            }
            let uri = tauri::Url::parse(&uri).map_err(|_| "file_unavailable")?;
            if uri.scheme() != "content" || uri.host_str().is_none() {
                return Err("file_unavailable");
            }
            let resolved_name = name
                .as_deref()
                .and_then(sanitize_document_name)
                .or_else(|| fallback_uri_name(&uri));
            Ok(Some((FilePath::Url(uri), resolved_name)))
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
pub async fn pick_import(
    app: &AppHandle,
) -> Result<Option<(FilePath, Option<String>)>, &'static str> {
    ensure_idle(app).await?;
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

#[cfg(target_os = "android")]
pub async fn pick_agent_grant(app:&AppHandle,directory:bool,writable:bool)->Result<Option<(FilePath,String,bool)>,&'static str>{
    ensure_idle(app).await?;
    let picker=app.state::<AndroidDocumentPicker<tauri::Wry>>();
    let reply:serde_json::Value=picker.0.run_mobile_plugin_async("grantDocument",serde_json::json!({"directory":directory,"writable":writable})).await.map_err(|_|"file_unavailable")?;
    let explicit_name=reply["name"].as_str().and_then(sanitize_document_name);
    let safe=serde_json::json!({"status":reply["status"],"uri":reply["uri"]});
    if reply["status"]=="cancelled"{return Ok(None);}
    if reply["status"]!="selected"{return Err("file_unavailable");}
    let default_name=if directory{"资料目录"}else{"资料文件"};
    selected_document(serde_json::from_value(safe).map_err(|_|"file_unavailable")?).map(|selected|selected.map(|(file,fallback)|(file,explicit_name.or(fallback).unwrap_or_else(||default_name.into()),writable&&reply["writable"]==true)))
}

#[cfg(target_os = "android")]
pub async fn pick_export(
    app: &AppHandle,
    suggested_name: &str,
) -> Result<Option<FilePath>, &'static str> {
    ensure_idle(app).await?;
    let picker = app.state::<AndroidDocumentPicker<tauri::Wry>>();
    let reply = picker
        .0
        .run_mobile_plugin_async(
            "createDocument",
            serde_json::json!({"suggestedName": suggested_name}),
        )
        .await
        .map_err(|_| "file_unavailable")?;
    selected_document(reply).map(|selected| selected.map(|(file, _)| file))
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
                    api.register_android_plugin("io.timejump.chuanyue", "DocumentPickerPlugin")?;
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

    fn decode(json: &str) -> Result<Option<(FilePath, Option<String>)>, &'static str> {
        selected_document(serde_json::from_str(json).map_err(|_| "file_unavailable")?)
    }

    #[test]
    fn selected_uri_is_content_only_bounded_and_native() {
        assert!(matches!(
            decode(r#"{"status":"selected","uri":"content://example.documents/document/42"}"#),
            Ok(Some((FilePath::Url(_), Some(_))))
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

    #[test]
    fn selected_document_preserves_display_name_and_falls_back_to_decoded_uri_segment() {
        let (_, name) = decode(
            r#"{"status":"selected","uri":"content://example.documents/document/42","name":"三国演义.epub"}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(name.as_deref(), Some("三国演义.epub"));

        let (_, name) = decode(
            r#"{"status":"selected","uri":"content://example.documents/document/42","name":"History: Part 1.pdf"}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(name.as_deref(), Some("History: Part 1.pdf"));

        let (_, name) = decode(
            r#"{"status":"selected","uri":"content://com.android.externalstorage.documents/document/primary%3ADownload%2F%E8%B5%84%E6%B2%BB%E9%80%9A%E9%89%B4.epub","name":"   "}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(name.as_deref(), Some("资治通鉴.epub"));

        let (_, name) = decode(
            r#"{"status":"selected","uri":"content://com.android.externalstorage.documents/document/primary%3Askill-pack.zip"}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(name.as_deref(), Some("skill-pack.zip"));

        let (_, name) = decode(
            r#"{"status":"selected","uri":"content://example.documents/document/42","name":"/storage/emulated/0/Download/notes.docx"}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(name.as_deref(), Some("notes.docx"));
    }
}
