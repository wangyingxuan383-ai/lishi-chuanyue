//! A process-wide lease for the Android generation foreground service.
use std::sync::{Arc, Mutex, OnceLock};

pub struct KeepAlive {
    count: Mutex<usize>,
    transition: Box<dyn Fn(bool) + Send + Sync>,
}

impl KeepAlive {
    pub fn new(transition: impl Fn(bool) + Send + Sync + 'static) -> Self {
        Self {
            count: Mutex::new(0),
            transition: Box::new(transition),
        }
    }

    pub fn acquire(self: &Arc<Self>) -> Lease {
        let mut count = self.count.lock().unwrap_or_else(|e| e.into_inner());
        *count += 1;
        if *count == 1 {
            self.notify(true);
        }
        Lease(Arc::clone(self))
    }

    fn notify(&self, running: bool) {
        // Serialize the callback with count changes: an old stop must never
        // overtake the next start. Even a failed platform callback owns a lease.
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (self.transition)(running)))
            .is_err()
        {
            eprintln!("generation service callback failed");
        }
    }

    #[cfg(test)]
    pub fn count(&self) -> usize {
        *self.count.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub struct Lease(Arc<KeepAlive>);

impl Drop for Lease {
    fn drop(&mut self) {
        let mut count = self.0.count.lock().unwrap_or_else(|e| e.into_inner());
        *count -= 1;
        if *count == 0 {
            self.0.notify(false);
        }
    }
}

pub fn shared() -> Arc<KeepAlive> {
    static SHARED: OnceLock<Arc<KeepAlive>> = OnceLock::new();
    Arc::clone(SHARED.get_or_init(|| Arc::new(KeepAlive::new(platform_transition))))
}

fn platform_transition(running: bool) {
    #[cfg(target_os = "android")]
    android::transition(running);
    #[cfg(not(target_os = "android"))]
    let _ = running;
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

    pub fn transition(running: bool) {
        let Some(bridge) = BRIDGE.get() else {
            warn(c"generation service: JNI bridge unavailable");
            return;
        };
        let Ok(mut env) = bridge.vm.attach_current_thread() else {
            warn(c"generation service: JNI attachment failed");
            return;
        };
        if env
            .call_static_method(
                &bridge.class,
                if running { "start" } else { "stop" },
                "(Landroid/content/Context;)V",
                &[bridge.context.as_obj().into()],
            )
            .is_err()
        {
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
        let keep_alive = Arc::new(KeepAlive::new(move |on| recorded.lock().unwrap().push(on)));
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
        let keep_alive = Arc::new(KeepAlive::new(|_| panic!("simulated platform failure")));
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _lease = keep_alive.acquire();
            panic!("simulated task panic");
        }));
        assert!(result.is_err());
        assert_eq!(keep_alive.count(), 0);
        drop(keep_alive.acquire());
        assert_eq!(keep_alive.count(), 0);
    }
}
