fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().plugin(
        "notifications",
        tauri_build::InlinedPlugin::new().commands(&[
            "request_notification_permission",
            "notification_status",
            "open_notification_settings",
            "open_app_settings",
            "open_url",
            "set_system_bars",
            "haptic",
        ]),
    ))
    .expect("Tauri build failed")
}
