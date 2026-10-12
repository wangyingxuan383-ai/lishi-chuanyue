use std::sync::mpsc;
use std::time::Duration;

use lishi_core::secrets::{SecretSlot, SecretStore, SecretStoreError, SecretValue};
use serde::{Deserialize, Deserializer, Serialize};
use tauri::plugin::PluginHandle;
use tauri::{AppHandle, Manager, Runtime};
use zeroize::Zeroizing;

const READ_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_REPLY_BYTES: usize = 32 * 1024;

pub struct AndroidSecretStore<R: Runtime> {
    plugin: PluginHandle<R>,
    app: AppHandle<R>,
}

#[derive(Serialize)]
struct SlotArgs<'a> {
    slot: &'a str,
}

#[derive(Serialize)]
struct SaveArgs<'a> {
    slot: &'a str,
    secret: &'a str,
}

struct SecretText(Zeroizing<String>);

impl<'de> Deserialize<'de> for SecretText {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        String::deserialize(deserializer).map(|text| Self(Zeroizing::new(text)))
    }
}

#[derive(Deserialize)]
struct NativeReply {
    ok: bool,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    secret: Option<SecretText>,
}

fn error_from_code(code: Option<&str>) -> SecretStoreError {
    match code {
        Some("invalid_slot") => SecretStoreError::InvalidSlot,
        Some("invalid_secret") => SecretStoreError::InvalidSecret,
        Some("corrupted") => SecretStoreError::Corrupted,
        Some("key_unavailable") => SecretStoreError::KeyUnavailable,
        Some("io_error") => SecretStoreError::IoError,
        _ => SecretStoreError::Unavailable,
    }
}

fn decode_load_reply(json: &str) -> Result<Option<SecretValue>, SecretStoreError> {
    if json.len() > MAX_REPLY_BYTES {
        return Err(SecretStoreError::Corrupted);
    }
    let reply: NativeReply =
        serde_json::from_str(json).map_err(|_| SecretStoreError::Unavailable)?;
    if !reply.ok {
        return Err(error_from_code(reply.code.as_deref()));
    }
    reply
        .secret
        .map(|mut value| {
            SecretValue::new(std::mem::take(&mut *value.0)).map_err(|_| SecretStoreError::Corrupted)
        })
        .transpose()
}

impl<R: Runtime> AndroidSecretStore<R> {
    pub fn new(plugin: PluginHandle<R>, app: AppHandle<R>) -> Self {
        Self { plugin, app }
    }

    fn mutation(&self, command: &str, payload: impl Serialize) -> Result<(), SecretStoreError> {
        let reply: NativeReply = self
            .plugin
            .run_mobile_plugin(command, payload)
            .map_err(|_| SecretStoreError::Unavailable)?;
        if reply.ok && reply.secret.is_none() {
            Ok(())
        } else {
            Err(error_from_code(reply.code.as_deref()))
        }
    }
}

impl<R: Runtime> SecretStore for AndroidSecretStore<R> {
    fn save(&self, slot: &SecretSlot, value: &SecretValue) -> Result<(), SecretStoreError> {
        self.mutation(
            "save",
            SaveArgs {
                slot: slot.as_str(),
                secret: value.expose_secret(),
            },
        )
    }

    fn load(&self, slot: &SecretSlot) -> Result<Option<SecretValue>, SecretStoreError> {
        // Call only from a blocking worker, never from Android's UI/JNI callback.
        // There is deliberately no plaintext-returning mobile @Command.
        let slot = slot.as_str().to_owned();
        let (sender, receiver) = mpsc::channel();
        let window = self
            .app
            .get_webview_window("main")
            .ok_or(SecretStoreError::Unavailable)?;
        window
            .with_webview(move |webview| {
                webview.jni_handle().exec(move |env, activity, _| {
                    let references = (|| -> Result<_, jni21::errors::Error> {
                        let context = env
                            .call_method(
                                activity,
                                "getApplicationContext",
                                "()Landroid/content/Context;",
                                &[],
                            )?
                            .l()?;
                        let context = env.new_global_ref(context)?;
                        let loader = env
                            .call_method(
                                activity,
                                "getClassLoader",
                                "()Ljava/lang/ClassLoader;",
                                &[],
                            )?
                            .l()?;
                        let name = env.new_string("io.timejump.lishi.RustSecretStoreBridge")?;
                        let class = env
                            .call_method(
                                loader,
                                "loadClass",
                                "(Ljava/lang/String;)Ljava/lang/Class;",
                                &[(&name).into()],
                            )?
                            .l()?;
                        let class = env.new_global_ref(class)?;
                        Ok((env.get_java_vm()?, context, class))
                    })();
                    let (vm, context, class) = match references {
                        Ok(value) => value,
                        Err(_) => {
                            let _ = env.exception_clear();
                            let _ = sender.send(Err(SecretStoreError::Unavailable));
                            return;
                        }
                    };
                    let failed_sender = sender.clone();
                    let worker = std::thread::Builder::new()
                        .name("lishi-secret-read".into())
                        .spawn(move || {
                            let result = match vm.attach_current_thread() {
                                Ok(mut env) => {
                                    let result = (|| -> Result<_, jni21::errors::Error> {
                                        let slot = env.new_string(slot)?;
                                        let result = env
                                            .call_static_method(
                                                &class,
                                                "loadForRust",
                                                "(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;",
                                                &[context.as_obj().into(), (&slot).into()],
                                            )?
                                            .l()?;
                                        let result = jni21::objects::JString::from(result);
                                        let json: String = env.get_string(&result)?.into();
                                        let json = Zeroizing::new(json);
                                        Ok(decode_load_reply(&json))
                                    })();
                                    if result.is_err() {
                                        let _ = env.exception_clear();
                                    }
                                    // Global references may cross threads; locals never do.
                                    // Release globals while this worker remains attached.
                                    drop(context);
                                    drop(class);
                                    result.unwrap_or(Err(SecretStoreError::Unavailable))
                                }
                                Err(_) => Err(SecretStoreError::Unavailable),
                            };
                            // A timed-out receiver drops (and zeroizes) the result.
                            let _ = sender.send(result);
                        });
                    if worker.is_err() {
                        let _ = failed_sender.send(Err(SecretStoreError::Unavailable));
                    }
                });
            })
            .map_err(|_| SecretStoreError::Unavailable)?;
        receiver
            .recv_timeout(READ_TIMEOUT)
            .map_err(|_| SecretStoreError::Unavailable)?
    }

    fn delete(&self, slot: &SecretSlot) -> Result<(), SecretStoreError> {
        self.mutation(
            "delete",
            SlotArgs {
                slot: slot.as_str(),
            },
        )
    }
}
