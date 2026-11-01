fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        // The APK loads this exact library name; retain an explicit identity
        // for the native dependency/integrity gate as well as the file name.
        println!("cargo:rustc-link-arg-cdylib=-Wl,-soname,liblishi_agent_host.so");
    }
}
