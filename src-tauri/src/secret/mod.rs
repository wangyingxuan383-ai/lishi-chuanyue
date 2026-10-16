//! Platform adapters plus a denied native-plugin namespace. No plaintext getter IPC.

use std::sync::Arc;

use crate::secrets::SecretStore;
#[cfg(not(target_os = "android"))]
use crate::secrets::{SecretSlot, SecretStoreError, SecretValue};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Trusted native services share adapters; this managed state has no IPC getter.
pub(crate) struct PlatformSecrets(pub Arc<dyn SecretStore>);

#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(not(target_os = "android"))]
struct UnavailableStore(SecretStoreError);

#[cfg(not(target_os = "android"))]
impl SecretStore for UnavailableStore {
    fn save(&self, _: &SecretSlot, _: &SecretValue) -> Result<(), SecretStoreError> {
        Err(self.0)
    }
    fn load(&self, _: &SecretSlot) -> Result<Option<SecretValue>, SecretStoreError> {
        Err(self.0)
    }
    fn delete(&self, _: &SecretSlot) -> Result<(), SecretStoreError> {
        Err(self.0)
    }
}

/// Internal Kotlin operations use PluginHandle directly. An unhandled frontend
/// plugin command otherwise falls through to Kotlin on mobile, so reject it
/// explicitly and report it handled. Kotlin's plaintext helper is unannotated too.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("secret-store")
        .invoke_handler(|invoke| {
            invoke.resolver.reject("secret_unavailable");
            true
        })
        .setup(|app, api| {
            #[cfg(target_os = "windows")]
            let store: Arc<dyn SecretStore> = {
                use tauri::Manager;
                let directory = app.path().app_data_dir()?.join("secrets");
                let opened = tauri::async_runtime::block_on(tauri::async_runtime::spawn_blocking(
                    move || windows::WindowsSecretStore::open(directory),
                ))
                .unwrap_or(Err(SecretStoreError::Unavailable));
                match opened {
                    Ok(store) => Arc::new(store),
                    Err(error) => Arc::new(UnavailableStore(error)),
                }
            };
            #[cfg(target_os = "android")]
            let store: Arc<dyn SecretStore> = {
                let handle =
                    api.register_android_plugin("io.timejump.chuanyue", "SecretStorePlugin")?;
                Arc::new(android::AndroidSecretStore::new(handle, app.clone()))
            };
            #[cfg(not(any(target_os = "windows", target_os = "android")))]
            let store: Arc<dyn SecretStore> =
                Arc::new(UnavailableStore(SecretStoreError::Unavailable));
            #[cfg(not(target_os = "android"))]
            let _ = api;
            use tauri::Manager;
            app.manage(PlatformSecrets(Arc::clone(&store)));
            Ok(())
        })
        .build()
}
