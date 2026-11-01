use crate::secrets::{SecretSlot, SecretStore, SecretStoreError, SecretValue};
use jni::{
    objects::{GlobalRef, JClass, JObject, JString, JValue},
    sys::{jboolean, jint, jlong},
    JNIEnv, JavaVM,
};
use pi_host::{AgentConnection, TransportOptions};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    os::fd::{FromRawFd, OwnedFd},
    panic::{catch_unwind, AssertUnwindSafe},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use story_core::{pi_service::AgentHostService, sql::SqlStore};
use tokio::runtime::Runtime;
use tokio::sync::Notify;
use zeroize::Zeroizing;

// Match the bounded Binder/file envelope and the private Pi transport.
const MAX_JSON_BYTES: usize = 8 * 1024 * 1024;
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(75);
const CLEANUP_OWNER_TIMEOUT: Duration = Duration::from_secs(120);
static HANDLES: OnceLock<Mutex<HashMap<jlong, Arc<NativeHost>>>> = OnceLock::new();
static RUNTIME: OnceLock<Runtime> = OnceLock::new();
static TLS_INITIALIZED: AtomicBool = AtomicBool::new(false);

pub(crate) struct JavaBridge {
    vm: JavaVM,
    context: GlobalRef,
    callback: GlobalRef,
    secrets: GlobalRef,
}
struct NativeHost {
    service: AgentHostService,
    connection: AgentConnection,
    java: Arc<JavaBridge>,
    closed: AtomicBool,
    pending: Mutex<HashSet<jlong>>,
    requests_done: Notify,
    cleanup: Mutex<CleanupState>,
    cleanup_done: Notify,
}
#[derive(Default)]
struct CleanupState {
    started: bool,
    result: Option<bool>,
}

fn handles() -> &'static Mutex<HashMap<jlong, Arc<NativeHost>>> {
    HANDLES.get_or_init(|| Mutex::new(HashMap::new()))
}
fn host(handle: jlong) -> Option<Arc<NativeHost>> {
    handles().lock().ok()?.get(&handle).cloned()
}
fn runtime() -> Result<&'static Runtime, &'static str> {
    if RUNTIME.get().is_none() {
        let value = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .thread_name("lishi-agent-host")
            .build()
            .map_err(|_| "agent_runtime_unavailable")?;
        if let Err(extra) = RUNTIME.set(value) {
            extra.shutdown_background();
        }
    }
    RUNTIME.get().ok_or("agent_runtime_unavailable")
}
fn failure(code: &str) -> Value {
    json!({"ok":false,"error":{"code":code,"message":"助手原生服务未完成此操作，请查看当前任务状态"}})
}
fn error_code(error: &story_core::Error) -> &'static str {
    match error {
        story_core::Error::Stale => "agent_stale",
        story_core::Error::Cancelled => "agent_cancelled",
        story_core::Error::Limit(_) => "agent_limit",
        _ => "agent_request_failed",
    }
}
fn request_failure(error: &story_core::Error) -> Value {
    // Shared service errors contain player-facing diagnostics; discarding them
    // here would turn a useful validation failure into an opaque JNI failure.
    if let story_core::Error::Tool{code,field,message,next}=error {
        json!({"ok":false,"error":{"code":code,"field":field,"message":message,"next":next}})
    }else{json!({"ok":false,"error":{"code":error_code(error),"message":error.to_string()}})}
}
fn java_string(env: &mut JNIEnv<'_>, value: JString<'_>) -> Result<String, &'static str> {
    let size = env
        .call_method(&value, "length", "()I", &[])
        .and_then(|value| value.i())
        .map_err(|_| "agent_invalid_json")?;
    if size < 0 || size as usize > MAX_JSON_BYTES {
        return Err("agent_json_too_large");
    }
    let value: String = env
        .get_string(&value)
        .map_err(|_| "agent_invalid_json")?
        .into();
    if value.len() > MAX_JSON_BYTES {
        return Err("agent_json_too_large");
    }
    Ok(value)
}
impl JavaBridge {
    pub(crate) fn document(&self,request:&Value)->story_core::Result<Value>{
        let unavailable=||story_core::Error::Invalid("安卓资料宿主不可用，未确认本次操作".into());
        let mut env=self.vm.attach_current_thread().map_err(|_|unavailable())?;
        let loader=env.call_method(self.context.as_obj(),"getClassLoader","()Ljava/lang/ClassLoader;",&[]).and_then(|v|v.l()).map_err(|_|unavailable())?;
        let name=env.new_string("io.timejump.chuanyue.AgentDocumentAccess").map_err(|_|unavailable())?;
        let class=env.call_method(loader,"loadClass","(Ljava/lang/String;)Ljava/lang/Class;",&[JValue::Object(&name)]).and_then(|v|v.l()).map_err(|_|unavailable())?;
        let payload=env.new_string(request.to_string()).map_err(|_|unavailable())?;
        let reply=env.call_static_method(JClass::from(class),"execute","(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;",&[JValue::Object(self.context.as_obj()),JValue::Object(&payload)]).and_then(|v|v.l()).map_err(|_|{let _=env.exception_clear();unavailable()})?;
        let raw=java_string(&mut env,JString::from(reply)).map_err(|_|unavailable())?;
        serde_json::from_str(&raw).map_err(|_|unavailable())
    }
    pub(crate) fn cancel_document(&self,id:&str){
        let Ok(mut env)=self.vm.attach_current_thread()else{return;};
        let result=(||->jni::errors::Result<()>{
            let loader=env.call_method(self.context.as_obj(),"getClassLoader","()Ljava/lang/ClassLoader;",&[])?.l()?;
            let name=env.new_string("io.timejump.chuanyue.AgentDocumentAccess")?;
            let class=env.call_method(loader,"loadClass","(Ljava/lang/String;)Ljava/lang/Class;",&[JValue::Object(&name)])?.l()?;
            let id=env.new_string(id)?;env.call_static_method(JClass::from(class),"cancel","(Ljava/lang/String;)V",&[JValue::Object(&id)])?;Ok(())
        })();if result.is_err(){let _=env.exception_clear();}
    }
    pub(crate) fn browser(&self,request:&Value)->story_core::Result<Value>{
        let unavailable=||story_core::Error::Invalid("安卓网页宿主不可用，未取得资料".into());
        let mut env=self.vm.attach_current_thread().map_err(|_|unavailable())?;
        let loader=env.call_method(self.context.as_obj(),"getClassLoader","()Ljava/lang/ClassLoader;",&[]).and_then(|v|v.l()).map_err(|_|unavailable())?;
        let name=env.new_string("io.timejump.chuanyue.AgentBrowserClient").map_err(|_|unavailable())?;
        let class=env.call_method(loader,"loadClass","(Ljava/lang/String;)Ljava/lang/Class;",&[JValue::Object(&name)]).and_then(|v|v.l()).map_err(|_|unavailable())?;
        let payload=env.new_string(request.to_string()).map_err(|_|unavailable())?;
        let reply=env.call_static_method(JClass::from(class),"execute","(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;",&[JValue::Object(self.context.as_obj()),JValue::Object(&payload)]).and_then(|v|v.l()).map_err(|_|{let _=env.exception_clear();unavailable()})?;
        let raw=java_string(&mut env,JString::from(reply)).map_err(|_|unavailable())?;
        serde_json::from_str(&raw).map_err(|_|unavailable())
    }
    pub(crate) fn cancel_browser(&self,request:&Value){
        let Ok(mut env)=self.vm.attach_current_thread()else{return;};
        let result=(||->jni::errors::Result<()>{
            let loader=env.call_method(self.context.as_obj(),"getClassLoader","()Ljava/lang/ClassLoader;",&[])?.l()?;
            let name=env.new_string("io.timejump.chuanyue.AgentBrowserClient")?;
            let class=env.call_method(loader,"loadClass","(Ljava/lang/String;)Ljava/lang/Class;",&[JValue::Object(&name)])?.l()?;
            let id=env.new_string(request.to_string())?;env.call_static_method(JClass::from(class),"cancel","(Landroid/content/Context;Ljava/lang/String;)V",&[JValue::Object(self.context.as_obj()),JValue::Object(&id)])?;Ok(())
        })();if result.is_err(){let _=env.exception_clear();}
    }
    pub(crate) fn ensure_tls(&self) -> story_core::Result<()> {
        if TLS_INITIALIZED.load(Ordering::Acquire) { return Ok(()); }
        let invalid = || story_core::Error::Invalid("Android证书验证尚未就绪，联网操作未执行".into());
        let env21 = self.vm.attach_current_thread().map_err(|_| invalid())?;
        let context = env21.new_local_ref(self.context.as_obj()).map_err(|_| invalid())?;
        let raw_context = context.into_raw();
        let raw_env = env21.get_raw();
        // Match the app's verifier bootstrap, but use only the independent
        // service's Application Context. The two JNI wrappers never overlap
        // calls, and ownership of this newly created local reference transfers.
        let initialized = {
            let mut env22 = unsafe { jni22::EnvUnowned::from_raw(raw_env.cast()) };
            let outcome = env22.with_env(|env| {
                let context = unsafe { jni22::objects::JObject::from_raw(env, raw_context.cast()) };
                rustls_platform_verifier::android::init_with_env(env, context)
            }).into_outcome();
            matches!(outcome, jni22::Outcome::Ok(()))
        };
        if !initialized {
            let _ = env21.exception_clear();
            return Err(invalid());
        }
        TLS_INITIALIZED.store(true, Ordering::Release);
        Ok(())
    }

    fn new(
        env: &mut JNIEnv<'_>,
        class: &JClass<'_>,
        service: &JObject<'_>,
    ) -> Result<(Self, PathBuf), &'static str> {
        let context = env
            .call_method(
                service,
                "getApplicationContext",
                "()Landroid/content/Context;",
                &[],
            )
            .and_then(|v| v.l())
            .map_err(|_| "agent_context_unavailable")?;
        let info = env
            .call_method(
                &context,
                "getApplicationInfo",
                "()Landroid/content/pm/ApplicationInfo;",
                &[],
            )
            .and_then(|v| v.l())
            .map_err(|_| "agent_context_unavailable")?;
        let data = env
            .get_field(&info, "dataDir", "Ljava/lang/String;")
            .and_then(|v| v.l())
            .map_err(|_| "agent_context_unavailable")?;
        let data: String = env
            .get_string(&JString::from(data))
            .map_err(|_| "agent_context_unavailable")?
            .into();
        let loader = env
            .call_method(&context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
            .and_then(|v| v.l())
            .map_err(|_| "agent_context_unavailable")?;
        let secret_name = env
            .new_string("io.timejump.chuanyue.RustSecretStoreBridge")
            .map_err(|_| "agent_context_unavailable")?;
        let secret_class = env
            .call_method(
                loader,
                "loadClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[(&secret_name).into()],
            )
            .and_then(|v| v.l())
            .map_err(|_| "agent_context_unavailable")?;
        Ok((
            Self {
                vm: env.get_java_vm().map_err(|_| "agent_context_unavailable")?,
                context: env
                    .new_global_ref(context)
                    .map_err(|_| "agent_context_unavailable")?,
                callback: env
                    .new_global_ref(class)
                    .map_err(|_| "agent_context_unavailable")?,
                secrets: env
                    .new_global_ref(secret_class)
                    .map_err(|_| "agent_context_unavailable")?,
            },
            PathBuf::from(data),
        ))
    }
    fn reply(&self, handle: jlong, id: jlong, value: &Value) {
        let Ok(mut env) = self.vm.attach_current_thread() else {
            return;
        };
        // A callback can also run on the original JNI dispatch thread after a
        // malformed Java argument raised an exception. Clear it before any
        // allocation/call, otherwise this terminal reply would be dropped.
        let _ = env.exception_clear();
        let Ok(text) = env.new_string(value.to_string()) else {
            return;
        };
        if env
            .call_static_method(
                &self.callback,
                "onNativeReply",
                "(JJLjava/lang/String;)V",
                &[JValue::Long(handle), JValue::Long(id), (&text).into()],
            )
            .is_err()
        {
            let _ = env.exception_clear();
        }
    }
    fn activity(&self, handle: jlong, active: bool) {
        let Ok(mut env) = self.vm.attach_current_thread() else {
            return;
        };
        if env
            .call_static_method(
                &self.callback,
                "onNativeActivity",
                "(JZ)V",
                &[
                    JValue::Long(handle),
                    JValue::Bool(if active { 1 as jboolean } else { 0 }),
                ],
            )
            .is_err()
        {
            let _ = env.exception_clear();
        }
    }
}

#[derive(Deserialize)]
struct SecretReply {
    ok: bool,
    secret: Option<String>,
}
impl SecretStore for JavaBridge {
    fn save(&self, _: &SecretSlot, _: &SecretValue) -> Result<(), SecretStoreError> {
        Err(SecretStoreError::Unavailable)
    }
    fn delete(&self, _: &SecretSlot) -> Result<(), SecretStoreError> {
        Err(SecretStoreError::Unavailable)
    }
    fn load(&self, slot: &SecretSlot) -> Result<Option<SecretValue>, SecretStoreError> {
        let mut env = self
            .vm
            .attach_current_thread()
            .map_err(|_| SecretStoreError::Unavailable)?;
        let outcome =
            (|| -> Result<Result<Option<SecretValue>, SecretStoreError>, jni::errors::Error> {
                let slot = env.new_string(slot.as_str())?;
                let value = env
                    .call_static_method(
                        &self.secrets,
                        "loadForRust",
                        "(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;",
                        &[self.context.as_obj().into(), (&slot).into()],
                    )?
                    .l()?;
                let value = JString::from(value);
                let text: String = env.get_string(&value)?.into();
                let text = Zeroizing::new(text);
                if text.len() > 32 * 1024 {
                    return Ok(Err(SecretStoreError::Corrupted));
                }
                let mut reply: SecretReply = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(_) => return Ok(Err(SecretStoreError::Unavailable)),
                };
                if !reply.ok {
                    if let Some(secret) = reply.secret.take() {
                        drop(Zeroizing::new(secret));
                    }
                    return Ok(Err(SecretStoreError::Unavailable));
                }
                Ok(reply
                    .secret
                    .take()
                    .map(|value| SecretValue::new(value).map_err(|_| SecretStoreError::Corrupted))
                    .transpose())
            })();
        match outcome {
            Ok(value) => value,
            Err(_) => {
                let _ = env.exception_clear();
                Err(SecretStoreError::Unavailable)
            }
        }
    }
}

fn initialize(
    env: &mut JNIEnv<'_>,
    class: JClass<'_>,
    context: JObject<'_>,
    data: JString<'_>,
    resources: JString<'_>,
    fd: jint,
) -> Result<jlong, &'static str> {
    if fd < 3 {
        return Err("agent_invalid_transport");
    }
    // Ownership transfers on entry, including validation failure paths.
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    let (java, expected) = JavaBridge::new(env, &class, &context)?;
    let data = PathBuf::from(java_string(env, data)?);
    let resources = PathBuf::from(java_string(env, resources)?);
    if !data.is_absolute() || !resources.is_absolute() {
        return Err("agent_invalid_directory");
    }
    let data = data.canonicalize().map_err(|_| "agent_invalid_directory")?;
    if data
        != expected
            .canonicalize()
            .map_err(|_| "agent_invalid_directory")?
    {
        return Err("agent_database_directory_mismatch");
    }
    pi_host::validate_runtime(&resources).map_err(|_| "agent_runtime_integrity_failed")?;
    let resources = resources
        .canonicalize()
        .map_err(|_| "agent_invalid_directory")?;
    if !resources.starts_with(&data) {
        return Err("agent_invalid_directory");
    }
    let sql = SqlStore::open(data.clone()).map_err(|_| "agent_database_unavailable")?;
    let store = sql.shared();
    let java = Arc::new(java);
    let handle = loop {
        let value = (uuid::Uuid::new_v4().as_u128() & i64::MAX as u128) as jlong;
        if value != 0
            && !handles()
                .lock()
                .map_err(|_| "agent_registry_unavailable")?
                .contains_key(&value)
        {
            break value;
        }
    };
    let rt = runtime()?;
    let _entered = rt.enter();
    let socket = std::os::unix::net::UnixStream::from(fd);
    socket
        .set_nonblocking(true)
        .map_err(|_| "agent_invalid_transport")?;
    let socket = tokio::net::UnixStream::from_std(socket).map_err(|_| "agent_invalid_transport")?;
    let (reader, writer) = socket.into_split();
    let (connection, incoming) =
        AgentConnection::attach(reader, writer, TransportOptions::default())
            .map_err(|_| "agent_invalid_transport")?;
    let activity = java.clone();
    let committed = java.clone();
    let service = AgentHostService::new(
        store.clone(),
        connection.clone(),
        incoming,
        data.join("agent-sessions"),
        crate::resolver::model_resolver(store.clone(), data.clone(), java.clone()),
        Arc::new(move |active| activity.activity(handle, active)),
        Arc::new(move |world| {
            committed.reply(
                handle,
                0,
                &json!({"type":"story_committed","worldId":world}),
            )
        }),
    )
    .map_err(|_| "agent_service_unavailable")?;
    let attempts=java.clone();
    service.set_attempt_sink(Arc::new(move|task,attempt|attempts.reply(handle,0,&json!({"event":"execution_started","taskId":task,"attemptId":attempt}))));
    let control=java.clone();
    service.set_control_timeout(Arc::new(move|task,attempt|control.reply(handle,0,&json!({"event":"stop_timeout","taskId":task,"attemptId":attempt}))));
    service.set_model_http(crate::network::model_host(store.clone(),data.clone(),java.clone()))
        .map_err(|_| "agent_model_http_unavailable")?;
    service.set_network(crate::network::host(store, data, java.clone()))
        .map_err(|_| "agent_network_adapter_unavailable")?;
    handles()
        .lock()
        .map_err(|_| "agent_registry_unavailable")?
        .insert(
            handle,
            Arc::new(NativeHost {
                service,
                connection,
                java,
                closed: AtomicBool::new(false),
                pending: Mutex::new(HashSet::new()),
                requests_done: Notify::new(),
                cleanup: Mutex::new(CleanupState::default()),
                cleanup_done: Notify::new(),
            }),
        );
    Ok(handle)
}

#[no_mangle]
pub extern "system" fn Java_io_timejump_chuanyue_AgentNative_nativeInitialize(
    mut env: JNIEnv<'_>,
    class: JClass<'_>,
    context: JObject<'_>,
    data: JString<'_>,
    resources: JString<'_>,
    fd: jint,
) -> jlong {
    match catch_unwind(AssertUnwindSafe(|| {
        initialize(&mut env, class, context, data, resources, fd)
    })) {
        Ok(Ok(handle)) => handle,
        result => {
            let code = match result {
                Ok(Err(code)) => code,
                _ => "agent_native_initialize_failed",
            };
            let _ = env.exception_clear();
            let _ = env.throw_new("java/lang/IllegalStateException", code);
            0
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_io_timejump_chuanyue_AgentNative_nativeDispatch(
    mut env: JNIEnv<'_>,
    class: JClass<'_>,
    handle: jlong,
    id: jlong,
    operation: JString<'_>,
    payload: JString<'_>,
) {
    let dispatched = catch_unwind(AssertUnwindSafe(|| {
        let parsed = (|| {
            let operation = java_string(&mut env, operation)?;
            let payload = java_string(&mut env, payload)?;
            crate::request::decode(&operation, &payload)
        })();
        let Some(owner) = host(handle) else {
            reply_current(
                &mut env,
                &class,
                handle,
                id,
                &failure("agent_handle_closed"),
            );
            return;
        };
        let request = match parsed {
            Ok(value) => value,
            Err(code) => {
                owner.java.reply(handle, id, &failure(code));
                return;
            }
        };
        if id <= 0 || owner.closed.load(Ordering::Acquire) {
            owner
                .java
                .reply(handle, id, &failure("agent_handle_closed"));
            return;
        }
        let inserted = owner
            .pending
            .lock()
            .map(|mut ids| ids.insert(id))
            .unwrap_or(false);
        if !inserted {
            owner
                .java
                .reply(handle, id, &failure("agent_request_in_flight"));
            return;
        }
        let Ok(rt) = runtime() else {
            if let Ok(mut ids) = owner.pending.lock() {
                ids.remove(&id);
            }
            owner.requests_done.notify_waiters();
            owner
                .java
                .reply(handle, id, &failure("agent_runtime_unavailable"));
            return;
        };
        // Join the worker rather than abandoning a request if service code
        // panics. The UI waiter can disappear independently of this owner.
        rt.spawn(async move {
            let request_owner = owner.clone();
            let result = match tokio::spawn(async move {
                if request_owner.closed.load(Ordering::Acquire) {
                    failure("agent_handle_closed")
                } else {
                    match request_owner.service.request(request).await {
                        Ok(value) => json!({"ok":true,"data":value}),
                        Err(error) => request_failure(&error),
                    }
                }
            })
            .await
            {
                Ok(value) => value,
                Err(_) => failure("agent_request_interrupted"),
            };
            if let Ok(mut ids) = owner.pending.lock() {
                ids.remove(&id);
            }
            owner.requests_done.notify_waiters();
            owner.java.reply(handle, id, &result);
        });
    }));
    if dispatched.is_err() {
        if let Some(owner) = host(handle) {
            if let Ok(mut ids) = owner.pending.lock() {
                ids.remove(&id);
            }
            owner.requests_done.notify_waiters();
        }
        // JNI exceptions from malformed Java input must be cleared before the
        // callback; never leave a pending request without a terminal response.
        let _ = env.exception_clear();
        reply_current(
            &mut env,
            &class,
            handle,
            id,
            &failure("agent_request_interrupted"),
        );
    }
    let _ = env.exception_clear();
}

fn reply_current(
    env: &mut JNIEnv<'_>,
    class: &JClass<'_>,
    handle: jlong,
    id: jlong,
    value: &Value,
) {
    let _ = env.exception_clear();
    if let Ok(text) = env.new_string(value.to_string()) {
        let _ = env.call_static_method(
            class,
            "onNativeReply",
            "(JJLjava/lang/String;)V",
            &[JValue::Long(handle), JValue::Long(id), (&text).into()],
        );
    }
    let _ = env.exception_clear();
}

#[no_mangle]
pub extern "system" fn Java_io_timejump_chuanyue_AgentNative_nativeRuntimeExited(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
    _exit: jint,
) -> jboolean {
    cleanup_entry(&mut env, handle, true)
}

#[no_mangle]
pub extern "system" fn Java_io_timejump_chuanyue_AgentNative_nativeShutdown(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
) -> jboolean {
    cleanup_entry(&mut env, handle, false)
}

fn cleanup_entry(env: &mut JNIEnv<'_>, handle: jlong, runtime_exited: bool) -> jboolean {
    // Both callers are dedicated Java workers. A mistaken main-thread call
    // fails closed instead of blocking the Android lifecycle for this bound.
    let main_thread = (|| -> jni::errors::Result<bool> {
        let current = env
            .call_static_method(
                "android/os/Looper",
                "myLooper",
                "()Landroid/os/Looper;",
                &[],
            )?
            .l()?;
        let main = env
            .call_static_method(
                "android/os/Looper",
                "getMainLooper",
                "()Landroid/os/Looper;",
                &[],
            )?
            .l()?;
        Ok(!current.is_null() && env.is_same_object(&current, &main)?)
    })();
    let _ = env.exception_clear();
    if main_thread.unwrap_or(true) {
        return 0;
    }
    let complete =
        catch_unwind(AssertUnwindSafe(|| cleanup_host(handle, runtime_exited))).unwrap_or(false);
    if !complete {
        if let Some(owner) = host(handle) {
            owner
                .java
                .reply(handle, 0, &failure("agent_shutdown_incomplete"));
        }
    }
    if complete {
        1
    } else {
        0
    }
}

/// Keep the retired handle as a completion tombstone until this dedicated
/// process exits. A simultaneous shutdown/Node-exit call waits on the same
/// result; absence from the registry must never masquerade as cleanup success.
fn cleanup_host(handle: jlong, runtime_exited: bool) -> bool {
    let Some(owner) = host(handle) else {
        return false;
    };
    owner.closed.store(true, Ordering::Release);
    let Ok(rt) = runtime() else {
        return false;
    };
    if runtime_exited {
        // This may race with graceful shutdown waiting for a Pi abort reply.
        // Break that wait before joining the other cleanup owner.
        let connection = owner.connection.clone();
        rt.spawn(async move {
            connection.close_transport().await;
        });
    }
    {
        let Ok(mut state) = owner.cleanup.lock() else {
            return false;
        };
        if let Some(result) = state.result {
            return result;
        }
        if !state.started {
            state.started = true;
            let owner = owner.clone();
            // The cleanup owner survives a Java caller's bounded wait. It is
            // unique for this handle and can issue a late truthful completion
            // event rather than turning a wait timeout into a successful reset.
            rt.spawn(async move {
                let runner = owner.clone();
                let complete = tokio::spawn(async move {
                    tokio::time::timeout(CLEANUP_OWNER_TIMEOUT, drain_host(runner))
                        .await
                        .unwrap_or(false)
                })
                .await
                .unwrap_or(false);
                if let Ok(mut state) = owner.cleanup.lock() {
                    state.result = Some(complete);
                }
                if complete {
                    owner
                        .java
                        .reply(handle, 0, &json!({"event":"host_cleanup_confirmed"}));
                } else {
                    owner
                        .java
                        .reply(handle, 0, &failure("agent_shutdown_incomplete"));
                }
                owner.cleanup_done.notify_waiters();
                owner.java.activity(handle, false);
            });
        }
    }
    rt.block_on(async {
        tokio::time::timeout(CLEANUP_TIMEOUT, async {
            loop {
                let done = owner.cleanup_done.notified();
                tokio::pin!(done);
                done.as_mut().enable();
                if let Some(result) = owner.cleanup.lock().ok().and_then(|state| state.result) {
                    return result;
                }
                done.await;
            }
        })
        .await
        .unwrap_or(false)
    })
}

async fn drain_host(owner: Arc<NativeHost>) -> bool {
    let first = owner.service.shutdown().await;
    owner.connection.close_transport().await;
    // If graceful stop could not receive an abort acknowledgement, the now
    // closed transport releases that prompt. Re-check the real idle barrier;
    // this does not rerun a task or replay a business/tool operation.
    let shutdown = if first.is_err() {
        owner.service.shutdown().await
    } else {
        first
    };
    // Control operations already admitted before closing may still be applying
    // a SQLite change. Await those owners, not just the active model prompt.
    loop {
        let done = owner.requests_done.notified();
        tokio::pin!(done);
        done.as_mut().enable();
        if owner
            .pending
            .lock()
            .map(|ids| ids.is_empty())
            .unwrap_or(false)
        {
            break;
        }
        done.await;
    }
    shutdown.is_ok()
}
