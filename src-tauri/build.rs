fn main() {
    // Cargo examples do not link the main application's resource manifest.
    // The isolated WebView probe still requires Common Controls v6.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref()==Ok("windows") {
        let manifest=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("examples/agent-browser.manifest");
        println!("cargo:rerun-if-changed={}",manifest.display());
        println!("cargo:rustc-link-arg-examples=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg-examples=/MANIFESTINPUT:{}",manifest.display());
    }
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .plugin(
                "notifications",
                tauri_build::InlinedPlugin::new().commands(&[
                    "request_notification_permission",
                    "notification_status",
                    "open_notification_settings",
                    "open_app_settings",
                    "story_committed",
                    "set_keep_awake",
                    "open_url",
                    "set_system_bars",
                    "haptic",
                ]),
            )
            .plugin(
                "updates",
                tauri_build::InlinedPlugin::new().commands(&[
                    "download",
                    "cancel",
                    "fetch_text",
                    "install",
                    "can_install",
                    "dev_source",
                    "set_dev_source",
                ]),
            ),
    )
    .expect("Tauri build failed")
}
