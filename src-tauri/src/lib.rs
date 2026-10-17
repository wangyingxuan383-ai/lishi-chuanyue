mod commands;
mod credentials;
mod document_picker;
mod error;
mod files;
mod keep_alive;
mod link_policy;
mod notifications;
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
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(secret::init())
        .plugin(document_picker::init())
        .plugin(notifications::init())
        .plugin(updates::init())
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
            files::file_export_text,
            files::file_import_text,
            commands::platform_info
        ])
        .run(tauri::generate_context!())
        .expect("平台服务启动失败");
}
