fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().plugin(
        "notifications",
        tauri_build::InlinedPlugin::new().commands(&["request_notification_permission"]),
    ))
    .expect("Tauri build failed")
}
