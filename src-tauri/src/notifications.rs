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

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("notifications")
        .invoke_handler(tauri::generate_handler![request_notification_permission])
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
