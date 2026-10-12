//! Rust-only JNI bridge. ContentResolver I/O runs on the caller's blocking
//! worker, rather than Android's UI/plugin-dispatch thread.

use std::fs::File;
use std::os::fd::FromRawFd;
use std::sync::mpsc;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_fs::FilePath;

pub fn open_document(
    app: &AppHandle,
    selected: &FilePath,
    mode: &str,
) -> Result<File, &'static str> {
    let FilePath::Url(uri) = selected else {
        return Err("file_unavailable");
    };
    if uri.scheme() != "content" || !matches!(mode, "r" | "wt") {
        return Err("file_unavailable");
    }
    let (sender, receiver) = mpsc::channel();
    app.get_webview_window("main")
        .ok_or("file_unavailable")?
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
                        .call_method(activity, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?
                        .l()?;
                    let name = env.new_string("io.timejump.lishi.RustFileAccessBridge")?;
                    let class = env
                        .call_method(
                            loader,
                            "loadClass",
                            "(Ljava/lang/String;)Ljava/lang/Class;",
                            &[(&name).into()],
                        )?
                        .l()?;
                    Ok((env.get_java_vm()?, context, env.new_global_ref(class)?))
                })();
                if references.is_err() {
                    let _ = env.exception_clear();
                }
                let _ = sender.send(references.map_err(|_| "file_unavailable"));
            });
        })
        .map_err(|_| "file_unavailable")?;
    let (vm, context, class) = receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "file_unavailable")??;
    let mut env = vm.attach_current_thread().map_err(|_| "file_unavailable")?;
    let result = (|| -> Result<i32, jni21::errors::Error> {
        let uri = env.new_string(uri.as_str())?;
        let mode = env.new_string(mode)?;
        env.call_static_method(
            &class,
            "openFdForRust",
            "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)I",
            &[context.as_obj().into(), (&uri).into(), (&mode).into()],
        )?
        .i()
    })();
    if result.is_err() {
        let _ = env.exception_clear();
    }
    // Only globals cross threads; drop them while this worker is attached.
    drop(context);
    drop(class);
    let descriptor = result.map_err(|_| "file_unavailable")?;
    if descriptor < 0 {
        return Err("file_io_error");
    }
    // The Kotlin bridge detaches exactly one owned descriptor. Rust closes it
    // on every success/failure path; no descriptor or URI is returned to JS.
    Ok(unsafe { File::from_raw_fd(descriptor) })
}
