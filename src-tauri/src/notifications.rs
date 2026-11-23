use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

#[cfg(target_os = "android")]
use tauri::{plugin::PluginHandle, Manager};

#[cfg(target_os = "android")]
struct AndroidNotifications<R: Runtime>(PluginHandle<R>);

#[derive(Clone, Copy)]
struct DesktopNotifyPrefs {
    excerpt: bool,
    sound: bool,
}

impl Default for DesktopNotifyPrefs {
    fn default() -> Self {
        Self {
            excerpt: true,
            sound: true,
        }
    }
}

fn desktop_prefs() -> &'static Mutex<DesktopNotifyPrefs> {
    static PREFS: OnceLock<Mutex<DesktopNotifyPrefs>> = OnceLock::new();
    PREFS.get_or_init(|| Mutex::new(DesktopNotifyPrefs::default()))
}

fn remember_completion(id: &str) -> bool {
    static SEEN: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();
    let mut seen = SEEN
        .get_or_init(|| Mutex::new(VecDeque::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if seen.iter().any(|item| item == id) {
        return false;
    }
    if seen.len() >= 256 {
        seen.pop_front();
    }
    seen.push_back(id.to_owned());
    true
}

#[cfg(windows)]
mod win_toast {
    use windows::core::{h, w, HSTRING};
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, REG_SZ,
    };
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

    pub fn ensure_aumid() {
        static INIT: std::sync::Once = std::sync::Once::new();
        INIT.call_once(|| unsafe {
            let mut key = HKEY::default();
            let status = RegCreateKeyW(
                HKEY_CURRENT_USER,
                w!("Software\\Classes\\AppUserModelId\\io.timejump.chuanyue"),
                &mut key,
            );
            if status.is_ok() {
                let display: Vec<u16> = "穿越小说模拟\0".encode_utf16().collect();
                let bytes =
                    std::slice::from_raw_parts(display.as_ptr() as *const u8, display.len() * 2);
                let _ = RegSetValueExW(key, w!("DisplayName"), Some(0), REG_SZ, Some(bytes));
                let _ = RegCloseKey(key);
            }
        });
    }

    pub fn escape_xml(input: &str) -> String {
        let mut out = String::with_capacity(input.len());
        for ch in input.chars() {
            if ch.is_control() && ch != '\n' {
                continue;
            }
            match ch {
                '&' => out.push_str("&amp;"),
                '<' => out.push_str("&lt;"),
                '>' => out.push_str("&gt;"),
                '"' => out.push_str("&quot;"),
                '\'' => out.push_str("&apos;"),
                _ => out.push(ch),
            }
        }
        out
    }

    pub fn show_toast(title: &str, body: &str, sound: bool) -> Result<(), String> {
        ensure_aumid();
        let audio = if sound {
            r#"<audio src="ms-winsoundevent:Notification.Default"/>"#
        } else {
            r#"<audio silent="true"/>"#
        };
        let xml = format!(
            r#"<toast><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text></binding></visual>{}</toast>"#,
            escape_xml(title),
            escape_xml(body),
            audio
        );
        let doc = XmlDocument::new().map_err(|e| e.to_string())?;
        doc.LoadXml(&HSTRING::from(xml)).map_err(|e| e.to_string())?;
        let toast = ToastNotification::CreateToastNotification(&doc).map_err(|e| e.to_string())?;
        let notifier = ToastNotificationManager::CreateToastNotifierWithId(h!(
            "io.timejump.chuanyue"
        ))
        .map_err(|e| e.to_string())?;
        notifier.Show(&toast).map_err(|e| e.to_string())
    }
}

#[cfg(windows)]
fn any_webview_focused<R: Runtime>(app: &tauri::AppHandle<R>) -> bool {
    use tauri::Manager;
    app.webview_windows().values().any(|window| {
        window.is_focused().unwrap_or(false) && !window.is_minimized().unwrap_or(false)
    })
}

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
#[serde(rename_all = "camelCase")]
struct Status {
    granted: bool,
    enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    oem: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel_importance: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    can_float: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reminder_audible: Option<bool>,
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
    #[cfg(windows)]
    {
        let _ = app;
        win_toast::ensure_aumid();
        let prefs = *desktop_prefs().lock().unwrap_or_else(|e| e.into_inner());
        Ok(Status {
            granted: true,
            enabled: true,
            oem: Some("generic".into()),
            channel_importance: Some(4),
            can_float: Some(true),
            reminder_audible: Some(prefs.sound),
        })
    }
    #[cfg(not(any(target_os = "android", windows)))]
    {
        let _ = app;
        Ok(Status {
            granted: true,
            enabled: true,
            oem: None,
            channel_importance: None,
            can_float: None,
            reminder_audible: Some(true),
        })
    }
}

/// Opens the system screen named by `command` (Android only; elsewhere nothing to open).
async fn open_system<R: Runtime>(
    app: tauri::AppHandle<R>,
    command: &str,
    args: serde_json::Value,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        app.state::<AndroidNotifications<R>>()
            .0
            .run_mobile_plugin_async::<serde_json::Value>(command, args)
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, command, args);
        Ok(())
    }
}

#[tauri::command]
async fn open_notification_settings<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    open_system(app, "open_notification_settings", serde_json::json!({})).await
}

#[tauri::command]
async fn open_app_settings<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    open_system(app, "open_app_settings", serde_json::json!({})).await
}

#[tauri::command]
async fn open_system_settings<R: Runtime>(
    app: tauri::AppHandle<R>,
    target: String,
) -> Result<(), String> {
    if !matches!(
        target.as_str(),
        "notifications" | "app" | "channel_done" | "channel_failed" | "battery" | "autostart"
    ) {
        return Err("invalid settings target".into());
    }
    open_system(
        app,
        "open_system_settings",
        serde_json::json!({ "target": target }),
    )
    .await
}

#[cfg(windows)]
fn notify_done_windows<R: Runtime>(
    app: &tauri::AppHandle<R>,
    completion_id: &str,
    title: &str,
    excerpt: &str,
) -> Result<(), String> {
    if !remember_completion(completion_id) {
        return Ok(());
    }
    if any_webview_focused(app) {
        return Ok(());
    }
    let prefs = *desktop_prefs().lock().unwrap_or_else(|e| e.into_inner());
    let heading = if title.trim().is_empty() {
        "穿越小说模拟".to_owned()
    } else {
        format!("《{}》写好了", title.trim().chars().take(60).collect::<String>())
    };
    let line: String = if prefs.excerpt && !excerpt.trim().is_empty() {
        excerpt.trim().chars().take(120).collect()
    } else {
        "下一段写好了，回来看看".into()
    };
    win_toast::show_toast(&heading, &line, prefs.sound)
}

#[cfg(windows)]
fn notify_failed_windows<R: Runtime>(
    app: &tauri::AppHandle<R>,
    title: &str,
    status: &str,
    line: &str,
) -> Result<(), String> {
    if status == "cancelled" || any_webview_focused(app) {
        return Ok(());
    }
    let prefs = *desktop_prefs().lock().unwrap_or_else(|e| e.into_inner());
    let heading = if title.trim().is_empty() {
        "这一段没写完".to_owned()
    } else {
        format!("《{}》没写完", title.trim().chars().take(60).collect::<String>())
    };
    let body: String = if line.trim().is_empty() {
        "切回来可以接着写完".into()
    } else {
        line.trim().chars().take(120).collect()
    };
    win_toast::show_toast(&heading, &body, prefs.sound)
}

/// A business-level success signal, independent of request/service lifetime.
#[tauri::command]
pub(crate) async fn story_committed<R: Runtime>(
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
    #[cfg(windows)]
    {
        let _ = notify_done_windows(&app, &completion_id, "", "");
        Ok(())
    }
    #[cfg(not(any(target_os = "android", windows)))]
    {
        let _ = app;
        let _ = remember_completion(&completion_id);
        Ok(())
    }
}

/// The engine's commit with the story's title and first line, so "写好了" can name the story and open it.
pub(crate) async fn story_ready<R: Runtime>(
    app: tauri::AppHandle<R>,
    completion_id: String,
    notice: Option<story_core::notice::Notice>,
) -> Result<(), String> {
    let (world, title, excerpt) = notice
        .map(|n| (n.world_id, n.title, n.excerpt))
        .unwrap_or_default();
    #[cfg(target_os = "android")]
    {
        app.state::<AndroidNotifications<R>>()
            .0
            .run_mobile_plugin_async::<serde_json::Value>(
                "story_committed",
                serde_json::json!({ "completionId": completion_id, "worldId": world, "title": title, "excerpt": excerpt }),
            )
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
    #[cfg(windows)]
    {
        let _ = world;
        let _ = notify_done_windows(&app, &completion_id, &title, &excerpt);
        Ok(())
    }
    #[cfg(not(any(target_os = "android", windows)))]
    {
        let _ = (app, completion_id, world, title, excerpt);
        Ok(())
    }
}

#[tauri::command]
pub(crate) async fn notify_done<R: Runtime>(
    app: tauri::AppHandle<R>,
    completion_id: String,
    world_id: Option<String>,
    title: Option<String>,
    excerpt: Option<String>,
) -> Result<(), String> {
    if completion_id.is_empty()
        || completion_id.len() > 256
        || completion_id.chars().any(char::is_control)
    {
        return Err("invalid completion id".into());
    }
    let world = world_id.unwrap_or_default();
    let title = title.unwrap_or_default();
    let excerpt = excerpt.unwrap_or_default();
    #[cfg(target_os = "android")]
    {
        app.state::<AndroidNotifications<R>>()
            .0
            .run_mobile_plugin_async::<serde_json::Value>(
                "story_committed",
                serde_json::json!({
                    "completionId": completion_id,
                    "worldId": world,
                    "title": title,
                    "excerpt": excerpt
                }),
            )
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
    #[cfg(windows)]
    {
        let _ = world;
        notify_done_windows(&app, &completion_id, &title, &excerpt)
    }
    #[cfg(not(any(target_os = "android", windows)))]
    {
        let _ = (app, completion_id, world, title, excerpt);
        Ok(())
    }
}

#[tauri::command]
pub(crate) async fn notify_failed<R: Runtime>(
    app: tauri::AppHandle<R>,
    world_id: Option<String>,
    title: Option<String>,
    status: Option<String>,
    line: Option<String>,
    run_id: Option<String>,
) -> Result<(), String> {
    let world = world_id.unwrap_or_default();
    let title = title.unwrap_or_default();
    let status = status.unwrap_or_else(|| "failed".into());
    let line = line.unwrap_or_default();
    let run = run_id.unwrap_or_default();
    #[cfg(target_os = "android")]
    {
        app.state::<AndroidNotifications<R>>()
            .0
            .run_mobile_plugin_async::<serde_json::Value>(
                "story_failed",
                serde_json::json!({
                    "worldId": world,
                    "title": title,
                    "status": status,
                    "line": line,
                    "runId": run
                }),
            )
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
    #[cfg(windows)]
    {
        let _ = (world, run);
        notify_failed_windows(&app, &title, &status, &line)
    }
    #[cfg(not(any(target_os = "android", windows)))]
    {
        let _ = (app, world, title, status, line, run);
        Ok(())
    }
}

/// Battery optimisation state, and the notification preferences the service reads.
#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Background {
    ignoring_battery: bool,
    xiaomi: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    oem: Option<String>,
}

async fn android_call<R: Runtime, T: serde::de::DeserializeOwned + Default>(
    app: tauri::AppHandle<R>,
    command: &str,
    args: serde_json::Value,
) -> Result<T, String> {
    #[cfg(target_os = "android")]
    {
        app.state::<AndroidNotifications<R>>()
            .0
            .run_mobile_plugin_async::<T>(command, args)
            .await
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, command, args);
        Ok(T::default())
    }
}

#[tauri::command]
async fn background_status<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Background, String> {
    android_call(app, "background_status", serde_json::json!({})).await
}

#[tauri::command]
async fn request_battery_exemption<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    android_call::<R, serde_json::Value>(app, "request_battery_exemption", serde_json::json!({}))
        .await
        .map(|_| ())
}

#[tauri::command]
async fn open_autostart_settings<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    android_call::<R, serde_json::Value>(app, "open_autostart_settings", serde_json::json!({}))
        .await
        .map(|_| ())
}

/// `progress`: the live notification while writing; `excerpt`: the first line in "写好了"; `lockscreen`: that line on the lock screen too.
/// `sound`: "写好了" and "没写完" ring and vibrate; absent from older pages means on.
#[tauri::command]
async fn set_notify_prefs<R: Runtime>(
    app: tauri::AppHandle<R>,
    progress: bool,
    excerpt: bool,
    lockscreen: bool,
    sound: Option<bool>,
) -> Result<(), String> {
    let sound = sound.unwrap_or(true);
    {
        let mut prefs = desktop_prefs().lock().unwrap_or_else(|e| e.into_inner());
        *prefs = DesktopNotifyPrefs { excerpt, sound };
    }
    android_call::<R, serde_json::Value>(
        app,
        "set_notify_prefs",
        serde_json::json!({ "progress": progress, "excerpt": excerpt, "lockscreen": lockscreen, "sound": sound }),
    )
    .await
    .map(|_| ())
}

/// Whether the reminder will ring: the app's switch, and what the system will actually do.
#[derive(serde::Serialize, serde::Deserialize)]
struct ReminderStatus {
    sound: bool,
    audible: bool,
}
impl Default for ReminderStatus {
    fn default() -> Self {
        Self {
            sound: true,
            audible: true,
        }
    }
}

#[tauri::command]
async fn reminder_status<R: Runtime>(app: tauri::AppHandle<R>) -> Result<ReminderStatus, String> {
    #[cfg(target_os = "android")]
    {
        android_call(app, "reminder_status", serde_json::json!({})).await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        let prefs = *desktop_prefs().lock().unwrap_or_else(|e| e.into_inner());
        Ok(ReminderStatus {
            sound: prefs.sound,
            audible: true,
        })
    }
}

#[tauri::command]
async fn test_reminder<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        android_call::<R, serde_json::Value>(app, "test_reminder", serde_json::json!({}))
            .await
            .map(|_| ())
    }
    #[cfg(windows)]
    {
        let _ = app;
        let prefs = *desktop_prefs().lock().unwrap_or_else(|e| e.into_inner());
        win_toast::show_toast(
            "试一下：写好了提醒",
            "以后切到其他窗口时写好一段，会这样弹窗并响铃提醒你。",
            prefs.sound,
        )
    }
    #[cfg(not(any(target_os = "android", windows)))]
    {
        let _ = app;
        Ok(())
    }
}

#[tauri::command]
async fn open_reminder_settings<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    open_system(app, "open_reminder_settings", serde_json::json!({})).await
}

/// The story a tapped notification asked to open, once: `{worldId, action}` or nulls.
#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LaunchTarget {
    world_id: Option<String>,
    action: Option<String>,
    run_id: Option<String>,
}

#[tauri::command]
async fn take_launch_target<R: Runtime>(app: tauri::AppHandle<R>) -> Result<LaunchTarget, String> {
    android_call(app, "take_launch_target", serde_json::json!({})).await
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
            open_system_settings,
            story_committed,
            notify_done,
            notify_failed,
            set_keep_awake,
            open_url,
            set_system_bars,
            haptic,
            background_status,
            request_battery_exemption,
            open_autostart_settings,
            set_notify_prefs,
            take_launch_target,
            reminder_status,
            test_reminder,
            open_reminder_settings
        ])
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            app.manage(AndroidNotifications(api.register_android_plugin(
                "io.timejump.chuanyue",
                "NotificationsPlugin",
            )?));
            #[cfg(windows)]
            {
                let _ = (app, api);
                win_toast::ensure_aumid();
            }
            #[cfg(not(any(target_os = "android", windows)))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::{is_hex_color, remember_completion};

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

    #[test]
    fn completion_dedup_and_toast_xml_escape_are_safe() {
        assert!(remember_completion("test-commit-1"));
        assert!(!remember_completion("test-commit-1"));
        #[cfg(windows)]
        {
            assert_eq!(
                super::win_toast::escape_xml("《大唐 & 西域》<1>\"'"),
                "《大唐 &amp; 西域》&lt;1&gt;&quot;&apos;"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "live Windows WinRT Toast + HKCU AppUserModelId smoke check"]
    fn windows_toast_aumid_and_live_banner_smoke() {
        use windows::core::w;
        use windows::Win32::System::Registry::{
            RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ,
        };

        super::win_toast::ensure_aumid();
        let mut buf = [0u16; 128];
        let mut byte_len = (buf.len() * 2) as u32;
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                w!("Software\\Classes\\AppUserModelId\\io.timejump.chuanyue"),
                w!("DisplayName"),
                RRF_RT_REG_SZ,
                None,
                Some(buf.as_mut_ptr() as *mut _),
                Some(&mut byte_len),
            )
        };
        assert!(status.is_ok(), "AUMID registry read failed: {status:?}");
        let nul = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        let display = String::from_utf16_lossy(&buf[..nul]);
        assert_eq!(display, "穿越小说模拟");

        super::win_toast::show_toast(
            "试一下：写好了提醒",
            "《长安雪夜行》下一段写好了，回来看看。",
            true,
        )
        .expect("live audible WinRT Toast failed");
        super::win_toast::show_toast(
            "《长安雪夜行》没写完",
            "静音提醒模式校验通过。",
            false,
        )
        .expect("live silent WinRT Toast failed");
    }
}
