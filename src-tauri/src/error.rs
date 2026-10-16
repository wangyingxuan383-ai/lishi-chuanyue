use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct PlatformError {
    pub code: &'static str,
    pub message: &'static str,
}

impl PlatformError {
    pub fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }
}

pub type Result<T> = std::result::Result<T, PlatformError>;

pub async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|_| PlatformError::new("platform_failed", "平台任务失败"))?
}

pub fn io_error() -> PlatformError {
    PlatformError::new("file_failed", "文件操作失败")
}
