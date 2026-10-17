use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

#[cfg(target_os = "android")]
use tauri::{plugin::PluginHandle, Manager};

#[cfg(target_os = "android")]
struct AndroidNotifications<R: Runtime>(PluginHandle<R>);

#[tauri::command]
async fn request_notification_permission<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        #[derive(serde::Deserialize)]
        struct Reply {
            granted: bool,
        }
        let reply: Reply = app
            .state::<AndroidNotifications<R>>()
            .0
            .run_mobile_plugin_async("request_notification_permission", serde_json::json!({}))
            .await
            .map_err(|error| error.to_string())?;
        Ok(reply.granted)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(true)
    }
}

/// Whether notifications can show: `granted` is the runtime permission, `enabled` the app's switch.
#[derive(serde::Serialize, serde::Deserialize)]
struct Status {
    granted: bool,
    enabled: bool,
}

#[tauri::command]
async fn notification_status<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Status, String> {
    #[cfg(target_os = "android")]
    {
        app.state::<AndroidNotifications<R>>()
            .0
            .run_mobile_plugin_async("notification_status", serde_json::json!({}))
            .await
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(Status {
            granted: true,
            enabled: true,
        })
    }
}

/// Opens the system screen named by `command` (Android only; elsewhere nothing to open).
async fn open_system<R: Runtime>(app: tauri::AppHandle<R>, command: &str) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        app.state::<AndroidNotifications<R>>()
            .0
            .run_mobile_plugin_async::<serde_json::Value>(command, serde_json::json!({}))
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, command);
        Ok(())
    }
}

#[tauri::command]
async fn open_notification_settings<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    open_system(app, "open_notification_settings").await
}

#[tauri::command]
async fn open_app_settings<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    open_system(app, "open_app_settings").await
}

/// A business-level success signal, independent of request/service lifetime.
#[tauri::command]
async fn story_committed<R: Runtime>(
    app: tauri::AppHandle<R>,
    completion_id: String,
) -> Result<(), String> {
    if completion_id.is_empty()
        || completion_id.len() > 256
        || completion_id.chars().any(char::is_control)
    {
        return Err("invalid completion id".into());
    }
    #[cfg(target_os = "android")]
    {
        app.state::<AndroidNotifications<R>>()
            .0
            .run_mobile_plugin_async::<serde_json::Value>(
                "story_committed",
                serde_json::json!({ "completionId": completion_id }),
            )
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(())
    }
}

#[tauri::command]
async fn set_keep_awake<R: Runtime>(app: tauri::AppHandle<R>, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        app.state::<AndroidNotifications<R>>()
            .0
            .run_mobile_plugin_async::<serde_json::Value>(
                "set_keep_awake",
                serde_json::json!({ "enabled": enabled }),
            )
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, enabled);
        Ok(())
    }
}

/// Opens an https page in the system browser: key consoles, price lists, the release page.
/// (Kept in this plugin, which already owns the app's few system hand-offs.)
#[tauri::command]
async fn open_url<R: Runtime>(app: tauri::AppHandle<R>, url: String) -> Result<(), String> {
    if !crate::link_policy::allowed(&url, false) {
        return Err("这个链接不在应用的可信链接列表中".into());
    }
    #[cfg(target_os = "android")]
    {
        app.state::<AndroidNotifications<R>>()
            .0
            .run_mobile_plugin_async::<serde_json::Value>(
                "open_url",
                serde_json::json!({ "url": url }),
            )
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        // explorer.exe hands a URL to the default browser without a shell parsing it.
        std::process::Command::new("explorer.exe")
            .arg(&url)
            .spawn()
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
    #[cfg(not(any(target_os = "android", target_os = "windows")))]
    {
        let _ = (app, url);
        Err("not supported".into())
    }
}

/// `#rrggbb` only: the colour goes straight to `Color.parseColor` on Android.
fn is_hex_color(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// Paints the area behind the status and navigation bars with the app theme's
/// background and picks icon contrast to match (`dark` = light icons).
#[tauri::command]
async fn set_system_bars<R: Runtime>(
    app: tauri::AppHandle<R>,
    background: String,
    dark: bool,
) -> Result<(), String> {
    if !is_hex_color(&background) {
        return Err("background must be #rrggbb".into());
    }
    #[cfg(target_os = "android")]
    {
        app.state::<AndroidNotifications<R>>()
            .0
            .run_mobile_plugin_async::<serde_json::Value>(
                "set_system_bars",
                serde_json::json!({ "background": background, "dark": dark }),
            )
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, dark);
        Ok(())
    }
}

/// A light native haptic (no VIBRATE permission needed); false where there is none.
#[tauri::command]
async fn haptic<R: Runtime>(app: tauri::AppHandle<R>) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        #[derive(serde::Deserialize)]
        struct Reply {
            done: bool,
        }
        let reply: Reply = app
            .state::<AndroidNotifications<R>>()
            .0
            .run_mobile_plugin_async("haptic", serde_json::json!({}))
            .await
            .map_err(|error| error.to_string())?;
        Ok(reply.done)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(false)
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("notifications")
        .invoke_handler(tauri::generate_handler![
            request_notification_permission,
            notification_status,
            open_notification_settings,
            open_app_settings,
            story_committed,
            set_keep_awake,
            open_url,
            set_system_bars,
            haptic
        ])
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            app.manage(AndroidNotifications(api.register_android_plugin(
                "io.timejump.chuanyue",
                "NotificationsPlugin",
            )?));
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::is_hex_color;

    #[test]
    fn system_bar_colour_is_plain_hex_only() {
        for ok in ["#efe5cf", "#FAF7F0", "#131518"] {
            assert!(is_hex_color(ok), "{ok}");
        }
        for bad in [
            "efe5cf",
            "#efe5c",
            "#efe5cf00",
            "#gggggg",
            "red",
            "",
            "#abc\u{4e2d}",
        ] {
            assert!(!is_hex_color(bad), "{bad}");
        }
    }
}
