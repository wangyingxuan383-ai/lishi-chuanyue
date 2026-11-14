//! A process-wide lease for the Android generation foreground service.
use std::{
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

struct Held {
    count: usize,
    until: Instant,
}

pub struct KeepAlive {
    held: Mutex<Held>,
    transition: Box<dyn Fn(bool, u64) + Send + Sync>,
}

impl KeepAlive {
    pub fn new(transition: impl Fn(bool, u64) + Send + Sync + 'static) -> Self {
        Self {
            held: Mutex::new(Held {
                count: 0,
                until: Instant::now(),
            }),
            transition: Box::new(transition),
        }
    }

    pub fn acquire(self: &Arc<Self>) -> Lease {
        self.acquire_for(300_000)
    }

    pub fn acquire_for(self: &Arc<Self>, duration_ms: u64) -> Lease {
        let mut held = self.held.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        let until = now + Duration::from_millis(duration_ms.clamp(1, 7_200_000) + 5_000);
        held.until = if held.count == 0 {
            until
        } else {
            held.until.max(until)
        };
        held.count += 1;
        let remaining = held.until.saturating_duration_since(now).as_millis() as u64;
        if held.count == 1 {
            self.notify(true, remaining);
        } else {
            // A later run can outlive the first run's bounded wake lock.
            // Android's idempotent start refreshes it without restarting the
            // service; only the final lease still sends stop.
            #[cfg(target_os = "android")]
            android::transition(true, remaining);
        }
        Lease(Arc::clone(self))
    }

    fn notify(&self, running: bool, remaining: u64) {
        // Serialize the callback with count changes: an old stop must never
        // overtake the next start. Even a failed platform callback owns a lease.
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            (self.transition)(running, remaining)
        }))
        .is_err()
        {
            eprintln!("generation service callback failed");
        }
    }

    #[cfg(test)]
    pub fn count(&self) -> usize {
        self.held.lock().unwrap_or_else(|e| e.into_inner()).count
    }
}

pub struct Lease(Arc<KeepAlive>);

impl Drop for Lease {
    fn drop(&mut self) {
        let mut held = self.0.held.lock().unwrap_or_else(|e| e.into_inner());
        held.count -= 1;
        if held.count == 0 {
            self.0.notify(false, 0);
        }
    }
}

pub fn shared() -> Arc<KeepAlive> {
    static SHARED: OnceLock<Arc<KeepAlive>> = OnceLock::new();
    Arc::clone(SHARED.get_or_init(|| Arc::new(KeepAlive::new(platform_transition))))
}

static ON_TIMEOUT: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();
pub fn set_timeout_handler(handler: impl Fn() + Send + Sync + 'static) {
    let _ = ON_TIMEOUT.set(Box::new(handler));
}

#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub extern "system" fn Java_io_timejump_chuanyue_GenerationService_nativeTimeout(
    _env: jni21::JNIEnv<'_>,
    _class: jni21::objects::JClass<'_>,
) {
    if let Some(handler) = ON_TIMEOUT.get() {
        handler();
    }
}

/// R29-T006: what the generation notification shows, and a notice when a run
/// stopped without a passage. Elsewhere there is nothing to show.
pub fn signal(signal: story_core::runtime::RunSignal) {
    #[cfg(target_os = "android")]
    android::signal(signal);
    #[cfg(not(target_os = "android"))]
    let _ = signal;
}

fn platform_transition(running: bool, remaining: u64) {
    #[cfg(target_os = "android")]
    android::transition(running, remaining);
    #[cfg(not(target_os = "android"))]
    let _ = (running, remaining);
}

#[cfg(target_os = "android")]
pub use android::initialize;

#[cfg(target_os = "android")]
mod android {
    use jni21::{objects::GlobalRef, JavaVM};
    use std::ffi::{c_char, c_int, CStr};
    use std::sync::OnceLock;
    use tauri::Manager;

    struct Bridge {
        vm: JavaVM,
        context: GlobalRef,
        class: GlobalRef,
    }

    static BRIDGE: OnceLock<Bridge> = OnceLock::new();

    #[link(name = "log")]
    unsafe extern "C" {
        fn __android_log_write(priority: c_int, tag: *const c_char, text: *const c_char) -> c_int;
    }

    fn warn(message: &CStr) {
        // Fixed strings only, independent of JNI availability. Native stderr
        // is not reliably routed to logcat on Android.
        unsafe { __android_log_write(5, c"GenerationService".as_ptr(), message.as_ptr()) };
    }

    // Capture the application's loader and Context while Wry provides an
    // Activity. Starts/stops then need no UI dispatch, including in background.
    pub fn initialize<R: tauri::Runtime>(app: &tauri::App<R>) {
        let Some(window) = app.get_webview_window("main") else {
            warn(c"generation service initialization: window unavailable");
            return;
        };
        if window
            .with_webview(|webview| {
                webview.jni_handle().exec(|env, activity, _| {
                    let result = (|| -> Result<_, jni21::errors::Error> {
                        let context = env
                            .call_method(
                                activity,
                                "getApplicationContext",
                                "()Landroid/content/Context;",
                                &[],
                            )?
                            .l()?;
                        let loader = env
                            .call_method(
                                activity,
                                "getClassLoader",
                                "()Ljava/lang/ClassLoader;",
                                &[],
                            )?
                            .l()?;
                        let name = env.new_string("io.timejump.chuanyue.GenerationService")?;
                        let class = env
                            .call_method(
                                loader,
                                "loadClass",
                                "(Ljava/lang/String;)Ljava/lang/Class;",
                                &[(&name).into()],
                            )?
                            .l()?;
                        Ok(Bridge {
                            vm: env.get_java_vm()?,
                            context: env.new_global_ref(context)?,
                            class: env.new_global_ref(class)?,
                        })
                    })();
                    match result {
                        Ok(bridge) => {
                            let _ = BRIDGE.set(bridge);
                        }
                        Err(_) => {
                            let _ = env.exception_clear();
                            warn(c"generation service initialization: JNI failed");
                        }
                    }
                });
            })
            .is_err()
        {
            warn(c"generation service initialization: dispatch failed");
        }
    }

    pub fn signal(signal: story_core::runtime::RunSignal) {
        use story_core::runtime::RunSignal;
        let Some(bridge) = BRIDGE.get() else { return };
        let Ok(mut env) = bridge.vm.attach_current_thread() else {
            warn(c"generation service: JNI attachment failed");
            return;
        };
        let result = (|| -> Result<(), jni21::errors::Error> {
            match signal {
                RunSignal::Phase { title, phase, chars, .. } => {
                    let phase = env.new_string(phase)?;
                    let title = env.new_string(title)?;
                    env.call_static_method(
                        &bridge.class,
                        "update",
                        "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;I)V",
                        &[bridge.context.as_obj().into(), (&phase).into(), (&title).into(), (chars.min(i32::MAX as usize) as i32).into()],
                    )?;
                }
                RunSignal::Ended { world_id, title, status, reason, .. } => {
                    let line = story_core::notice::reason(status, &reason);
                    let world = env.new_string(world_id)?;
                    let title = env.new_string(title)?;
                    let status = env.new_string(status)?;
                    let line = env.new_string(line)?;
                    env.call_static_method(
                        &bridge.class,
                        "storyIssue",
                        "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
                        &[bridge.context.as_obj().into(), (&world).into(), (&title).into(), (&status).into(), (&line).into()],
                    )?;
                }
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = env.exception_clear();
            warn(c"generation service: progress JNI call failed");
        }
    }

    pub fn transition(running: bool, remaining: u64) {
        let Some(bridge) = BRIDGE.get() else {
            warn(c"generation service: JNI bridge unavailable");
            return;
        };
        let Ok(mut env) = bridge.vm.attach_current_thread() else {
            warn(c"generation service: JNI attachment failed");
            return;
        };
        let result = if running {
            env.call_static_method(
                &bridge.class,
                "start",
                "(Landroid/content/Context;J)V",
                &[bridge.context.as_obj().into(), (remaining as i64).into()],
            )
        } else {
            env.call_static_method(
                &bridge.class,
                "stop",
                "(Landroid/content/Context;)V",
                &[bridge.context.as_obj().into()],
            )
        };
        if result.is_err() {
            let _ = env.exception_clear();
            warn(c"generation service: JNI call failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;

    #[test]
    fn concurrent_leases_start_once_and_stop_only_after_last_release() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&events);
        let keep_alive = Arc::new(KeepAlive::new(move |on, _| {
            recorded.lock().unwrap().push(on)
        }));
        let barrier = Arc::new(Barrier::new(9));
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let keep_alive = Arc::clone(&keep_alive);
                let barrier = Arc::clone(&barrier);
                scope.spawn(move || {
                    let _lease = keep_alive.acquire();
                    barrier.wait();
                    barrier.wait();
                });
            }
            barrier.wait();
            assert_eq!(keep_alive.count(), 8);
            assert_eq!(*events.lock().unwrap(), [true]);
            barrier.wait();
        });
        assert_eq!(keep_alive.count(), 0);
        assert_eq!(*events.lock().unwrap(), [true, false]);
    }

    #[test]
    fn unwind_and_callback_failure_still_release_the_lease() {
        let keep_alive = Arc::new(KeepAlive::new(|_, _| panic!("simulated platform failure")));
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _lease = keep_alive.acquire();
            panic!("simulated task panic");
        }));
        assert!(result.is_err());
        assert_eq!(keep_alive.count(), 0);
        drop(keep_alive.acquire());
        assert_eq!(keep_alive.count(), 0);
    }

    #[test]
    fn a_short_stream_cannot_shorten_the_whole_task_deadline() {
        let keep_alive = Arc::new(KeepAlive::new(|_, _| {}));
        let task = keep_alive.acquire_for(900_000);
        let deadline = keep_alive.held.lock().unwrap().until;
        let stream = keep_alive.acquire_for(30_000);
        assert!(keep_alive.held.lock().unwrap().until >= deadline);
        drop(task);
        assert_eq!(keep_alive.count(), 1);
        drop(stream);
        assert_eq!(keep_alive.count(), 0);
    }
}
