//! Platform adapters plus a denied native-plugin namespace. No plaintext getter IPC.

use std::sync::Arc;

use lishi_core::secret_probe::SecretProbe;
use lishi_core::secrets::SecretStore;
#[cfg(not(target_os = "android"))]
use lishi_core::secrets::{SecretSlot, SecretStoreError, SecretValue};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

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
                match windows::WindowsSecretStore::open(directory) {
                    Ok(store) => Arc::new(store),
                    Err(error) => Arc::new(UnavailableStore(error)),
                }
            };
            #[cfg(target_os = "android")]
            let store: Arc<dyn SecretStore> = {
                let handle =
                    api.register_android_plugin("io.timejump.lishi", "SecretStorePlugin")?;
                Arc::new(android::AndroidSecretStore::new(handle, app.clone()))
            };
            #[cfg(not(any(target_os = "windows", target_os = "android")))]
            let store: Arc<dyn SecretStore> =
                Arc::new(UnavailableStore(SecretStoreError::Unavailable));
            #[cfg(not(target_os = "android"))]
            let _ = api;
            use tauri::Manager;
            app.manage(Arc::new(SecretProbe::new(store)?));
            Ok(())
        })
        .build()
}
