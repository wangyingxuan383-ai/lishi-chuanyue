//! Android platform certificate verification bootstrap for reqwest's Rustls backend.
//!
//! Tauri/Wry currently exposes jni 0.21 while the verifier uses jni 0.22. The
//! only cross-version boundary is scoped to Wry's JNI callback on its own thread.
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::Manager;

static INITIALIZED: AtomicBool = AtomicBool::new(false);

pub fn is_ready() -> bool {
    INITIALIZED.load(Ordering::Acquire)
}

/// Queue initialization without waiting on the Android UI thread.
/// The network command must check `is_ready()` before sending any request.
pub fn initialize<R: tauri::Runtime>(app: &tauri::App<R>) -> Result<(), &'static str> {
    if is_ready() {
        return Ok(());
    }
    let window = app
        .get_webview_window("main")
        .ok_or("Android TLS initialization could not find the application window.")?;
    window
        .with_webview(|webview| {
            webview.jni_handle().exec(|env21, activity, _webview| {
                if is_ready() {
                    return;
                }

                // This creates a new local reference. Retain Application context,
                // rather than Activity context, for the verifier's process lifetime.
                let context = env21
                    .call_method(
                        activity,
                        "getApplicationContext",
                        "()Landroid/content/Context;",
                        &[],
                    )
                    .and_then(|value| value.l());
                let initialized = match context {
                    Ok(context) if !context.is_null() => {
                        let raw_context = context.into_raw();
                        let raw_env = env21.get_raw();

                        // SAFETY: Wry supplied a valid JNI attachment for this
                        // callback's current thread. The 0.22 wrapper stays within
                        // this scope; no 0.21 calls run while it is being used.
                        let mut env22 = unsafe { jni::EnvUnowned::from_raw(raw_env.cast()) };
                        let outcome = env22
                            .with_env(|env| {
                                // SAFETY: into_raw consumed the 0.21 owning wrapper
                                // for this newly created local reference. There is
                                // no duplicate owning wrapper, and it remains on
                                // the same thread within the original JNI frame.
                                let context = unsafe {
                                    jni::objects::JObject::from_raw(env, raw_context.cast())
                                };
                                rustls_platform_verifier::android::init_with_env(env, context)
                            })
                            .into_outcome();
                        matches!(outcome, jni::Outcome::Ok(()))
                    }
                    _ => false,
                };
                if !initialized {
                    // Do not leak a pending Java exception back into Wry or log
                    // raw errors. Callers receive the fixed TLS-unavailable error.
                    let _ = env21.exception_clear();
                }
                INITIALIZED.store(initialized, Ordering::Release);
            });
        })
        .map_err(|_| "Android TLS initialization could not be queued.")
}
