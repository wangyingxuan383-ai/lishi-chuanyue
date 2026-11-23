mod commands;
#[cfg(not(target_os="android"))]
mod agent_browser;
mod credentials;
mod document_picker;
mod error;
mod execution;
mod files;
mod keep_alive;
mod link_policy;
mod notifications;
mod pi_agent;
mod secret;
mod secrets;
mod sql;
mod stream;
mod updates;
#[cfg(desktop)]
mod window_state;

#[cfg(target_os = "android")]
mod android_tls;
#[cfg(target_os = "android")]
mod file_access_android;

use std::sync::Arc;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(secret::init())
        .plugin(document_picker::init())
        .plugin(files::init())
        .plugin(notifications::init())
        .plugin(updates::init())
        .plugin(pi_agent::init())
        .setup(|app| {
            #[cfg(target_os = "android")]
            android_tls::initialize(app)?;
            #[cfg(target_os = "android")]
            keep_alive::initialize(app);
            let data = app.path().app_data_dir()?;
            let cache = app.path().app_cache_dir()?;
            let updates = updates::Updates::new(&cache, &data);
            updates.housekeeping();
            app.manage(updates);
            let secrets = Arc::clone(&app.state::<secret::PlatformSecrets>().0);
            let services = tauri::async_runtime::block_on(error::blocking(move || {
                Ok((
                    Arc::new(sql::SqlStore::open(data.clone())?),
                    Arc::new(credentials::Credentials::open(data, secrets)?),
                    Arc::new(stream::Streams::open(cache)?),
                ))
            }))
            .map_err(|error| std::io::Error::other(error.message))?;
            let model = Arc::new(execution::NativeModel {
                credentials: services.1.clone(),
            });
            let application = app.handle().clone();
            let live_app = app.handle().clone();
            let notices = services.0.shared();
            let companion = Arc::new(story_core::companion_runtime::CompanionRuntime::with_lease(
                services.0.shared(),
                model.clone(),
                Arc::new(|remaining| Box::new(keep_alive::shared().acquire_for(remaining))),
            ));
            let engine = Arc::new(story_core::runtime::Engine::new(
                services.0.shared(),
                model,
                Arc::new(|remaining| Box::new(keep_alive::shared().acquire_for(remaining))),
                Arc::new(move |id| {
                    let app = application.clone();
                    // R29-T006: the story's title and the passage's first line for "写好了".
                    let notice = story_core::notice::committed(&notices, &id);
                    tauri::async_runtime::spawn(async move {
                        let _ = notifications::story_ready(app, id, notice).await;
                    });
                }),
            ));
            // Phase, words written and stops for the progress notification.
            engine.observe(Arc::new(keep_alive::signal));
            // Live stream push to the WebView so streaming doesn't depend on 350ms SQLite polling (R31-P3).
            engine.on_live_event(Arc::new(move |run_id, seq, event| {
                let _ = live_app.emit(
                    "execution://event",
                    serde_json::json!({"runId": run_id, "seq": seq, "event": event}),
                );
            }));
            let weak = Arc::downgrade(&engine);
            engine
                .recover_on_start()
                .map_err(|_| std::io::Error::other("无法读取运行进度"))?;
            // Every caller is Android stopping background work, never the player (R30).
            keep_alive::set_timeout_handler(move || {
                if let Some(engine) = weak.upgrade() {
                    engine.system_stop_all("android");
                }
            });
            let weak = Arc::downgrade(&engine);
            keep_alive::set_stop_handler(move |run,execution| {
                if let Some(engine)=weak.upgrade(){let _=engine.stop_execution(run,execution);}
            });
            app.manage(companion);
            app.manage(engine);
            pi_agent::initialize(app.handle(), services.0.shared())?;
            app.manage(services.0);
            app.manage(services.1);
            app.manage(services.2);
            #[cfg(desktop)]
            window_state::restore(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::sql_query,
            commands::sql_batch,
            commands::sql_backup,
            commands::sql_list_backups,
            commands::sql_backup_inventory,
            commands::sql_delete_backups,
            commands::sql_restore,
            commands::secret_set,
            commands::secret_has,
            commands::secret_remove,
            commands::llm_stream,
            commands::llm_cancel,
            commands::llm_stream_resume,
            commands::llm_stream_list,
            commands::llm_stream_ack,
            commands::llm_get,
            commands::network_set,
            commands::http_get_public,
            execution::execution_start,
            execution::execution_companion,
            pi_agent::pi_agent_request,
            execution::execution_settle,
            execution::execution_context,
            execution::execution_snapshot,
            execution::execution_list,
            execution::execution_stop,
            execution::execution_resume,
            files::file_export_text,
            files::file_export_world,
            commands::file_export_bytes,
            files::file_import_text,
            files::file_import_skill,
            files::file_grant_agent,
            files::file_import_book,
            files::file_extract_pdf,
            files::file_cancel_book,
            commands::platform_info
        ])
        .run(tauri::generate_context!())
        .expect("平台服务启动失败");
}
