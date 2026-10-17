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

/// Opens an https page in the system browser: key consoles, price lists, the release page.
/// (Kept in this plugin, which already owns the app's few system hand-offs.)
#[tauri::command]
async fn open_url<R: Runtime>(app: tauri::AppHandle<R>, url: String) -> Result<(), String> {
    if !url.starts_with("https://") || url.chars().any(|c| c.is_whitespace() || c == '"') {
        return Err("only https links".into());
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
        std::process::Command::new("explorer")
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

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("notifications")
        .invoke_handler(tauri::generate_handler![
            request_notification_permission,
            notification_status,
            open_notification_settings,
            open_app_settings,
            open_url
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
