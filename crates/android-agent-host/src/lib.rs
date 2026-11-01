//! Dedicated Android service entry. It never initializes Tauri or the old Engine.
#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "android")]
mod resolver;
#[cfg(target_os = "android")]
mod network;
#[cfg(any(target_os = "android", test))]
mod request;

// Reuse the application's exact slot validation and authorization policy.
#[cfg(target_os = "android")]
#[path = "../../../src-tauri/src/credentials.rs"]
mod credentials;
#[cfg(target_os = "android")]
#[path = "../../../src-tauri/src/secrets.rs"]
mod secrets;

#[cfg(target_os = "android")]
mod error {
    pub use story_core::error::PlatformError;
    pub type Result<T> = std::result::Result<T, PlatformError>;
    pub fn io_error() -> PlatformError {
        PlatformError::new("file_failed", "文件操作失败")
    }
}
