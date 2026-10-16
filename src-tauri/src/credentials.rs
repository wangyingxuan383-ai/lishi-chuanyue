use crate::{
    error::{io_error, PlatformError, Result},
    secrets::{SecretSlot, SecretStore, SecretValue},
};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::PathBuf,
    sync::{Arc, Mutex},
};

pub struct Credentials {
    store: Arc<dyn SecretStore>,
    bindings: Mutex<BTreeMap<String, String>>,
    path: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStatus {
    pub configured: bool,
    pub bound_base_url: Option<String>,
}

fn secret_error(_: crate::secrets::SecretStoreError) -> PlatformError {
    PlatformError::new("secret_failed", "密钥操作失败，请检查槽位与密钥格式")
}

pub fn normalize_base(value: &str) -> Result<String> {
    let url = reqwest::Url::parse(value).map_err(|_| binding_error())?;
    if !value.starts_with("https://") && !value.starts_with("http://") {
        return Err(binding_error());
    }
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(binding_error());
    }
    Ok(value.trim_end_matches('/').to_owned())
}

fn binding_error() -> PlatformError {
    PlatformError::new(
        "secret_base_url",
        "绑定地址必须为不含认证、查询或片段的 HTTP 绝对地址",
    )
}

pub fn check_bound(base: &str, target: &str) -> Result<()> {
    let valid_prefix = target
        .strip_prefix(base)
        .is_some_and(|tail| tail.is_empty() || tail.starts_with('/') || tail.starts_with('?'));
    let base_url = reqwest::Url::parse(base).map_err(|_| binding_error())?;
    let valid_url = reqwest::Url::parse(target).is_ok_and(|url| {
        url.origin() == base_url.origin()
            && url.username().is_empty()
            && url.password().is_none()
            && matches!(url.scheme(), "https" | "http")
    });
    if !valid_prefix || !valid_url {
        return Err(PlatformError::new(
            "llm_url_not_bound",
            "请求地址与密钥绑定地址不符",
        ));
    }
    Ok(())
}

impl Credentials {
    pub fn open(directory: PathBuf, store: Arc<dyn SecretStore>) -> Result<Self> {
        fs::create_dir_all(&directory).map_err(|_| io_error())?;
        let path = directory.join("secret-bindings.json");
        let bindings = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| io_error())?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(_) => return Err(io_error()),
        };
        Ok(Self {
            store,
            bindings: Mutex::new(bindings),
            path,
        })
    }

    fn persist(&self, bindings: &BTreeMap<String, String>) -> Result<()> {
        let mut file = tempfile::NamedTempFile::new_in(self.path.parent().ok_or_else(io_error)?)
            .map_err(|_| io_error())?;
        serde_json::to_writer(&mut file, bindings).map_err(|_| io_error())?;
        file.flush().map_err(|_| io_error())?;
        file.as_file().sync_all().map_err(|_| io_error())?;
        file.persist(&self.path).map_err(|_| io_error())?;
        Ok(())
    }

    pub fn set(&self, slot: &str, value: String, base: &str) -> Result<()> {
        let slot = SecretSlot::new(slot).map_err(secret_error)?;
        let value = SecretValue::new(value).map_err(secret_error)?;
        let base = normalize_base(base)?;
        let mut bindings = self.bindings.lock().map_err(|_| io_error())?;
        // Rebinding fails closed even if saving either file is interrupted.
        bindings.remove(slot.as_str());
        self.persist(&bindings)?;
        self.store.save(&slot, &value).map_err(secret_error)?;
        bindings.insert(slot.as_str().to_owned(), base);
        if let Err(error) = self.persist(&bindings) {
            bindings.remove(slot.as_str());
            return Err(error);
        }
        Ok(())
    }

    pub fn has(&self, slot: &str) -> Result<SecretStatus> {
        let slot = SecretSlot::new(slot).map_err(secret_error)?;
        let bindings = self.bindings.lock().map_err(|_| io_error())?;
        let base = bindings.get(slot.as_str()).cloned();
        let configured = base.is_some() && self.store.load(&slot).map_err(secret_error)?.is_some();
        Ok(SecretStatus {
            configured,
            bound_base_url: base,
        })
    }

    pub fn remove(&self, slot: &str) -> Result<()> {
        let slot = SecretSlot::new(slot).map_err(secret_error)?;
        let mut bindings = self.bindings.lock().map_err(|_| io_error())?;
        self.store.delete(&slot).map_err(secret_error)?;
        bindings.remove(slot.as_str());
        self.persist(&bindings)
    }

    pub fn authorize(&self, slot: &str, url: &str) -> Result<SecretValue> {
        let slot = SecretSlot::new(slot).map_err(secret_error)?;
        let bindings = self.bindings.lock().map_err(|_| io_error())?;
        let missing = || PlatformError::new("llm_no_secret", "尚未配置密钥");
        let base = bindings.get(slot.as_str()).ok_or_else(missing)?;
        check_bound(base, url)?;
        self.store
            .load(&slot)
            .map_err(secret_error)?
            .ok_or_else(missing)
    }
}

#[cfg(test)]
#[path = "credentials_tests.rs"]
pub(crate) mod tests;
