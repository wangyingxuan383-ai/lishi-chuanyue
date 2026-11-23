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
    bindings_unavailable: bool,
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

fn matches_bound_prefix(candidate_base: &str, target: &str) -> bool {
    target
        .strip_prefix(candidate_base)
        .is_some_and(|tail| tail.is_empty() || tail.starts_with('/') || tail.starts_with('?'))
}

fn gemini_native_dual_base(base: &str, base_path: &str) -> Option<(String, String)> {
    let trimmed_base = base.trim_end_matches('/');
    let trimmed_path = base_path.trim_end_matches('/');
    let native_base = trimmed_base.strip_suffix("/openai")?;
    let native_path = trimmed_path.strip_suffix("/openai")?;
    if !native_base.ends_with("/v1beta") || !native_path.ends_with("/v1beta") {
        return None;
    }
    Some((native_base.to_owned(), native_path.to_owned()))
}

pub fn check_bound(base: &str, target: &str) -> Result<()> {
    let base_trimmed = base.trim_end_matches('/');
    let base_url = reqwest::Url::parse(base_trimmed).map_err(|_| binding_error())?;
    let base_path = base_url.path().trim_end_matches('/');
    let valid_url_and_prefix = reqwest::Url::parse(target).is_ok_and(|url| {
        if url.origin() != base_url.origin()
            || !url.username().is_empty()
            || url.password().is_some()
            || !matches!(url.scheme(), "https" | "http")
        {
            return false;
        }
        let target_path = url.path();
        let direct_match = matches_bound_prefix(base_trimmed, target)
            && matches_bound_prefix(base_path, target_path);
        if direct_match {
            return true;
        }
        gemini_native_dual_base(base_trimmed, base_path).is_some_and(|(alt_base, alt_path)| {
            matches_bound_prefix(&alt_base, target)
                && matches_bound_prefix(&alt_path, target_path)
        })
    });
    if !valid_url_and_prefix {
        return Err(PlatformError::new(
            "llm_url_not_bound",
            "请求地址与密钥绑定地址不符",
        ));
    }
    Ok(())
}

impl Credentials {
    pub fn open(directory: PathBuf, store: Arc<dyn SecretStore>) -> Result<Self> {
        let directory_ready = fs::create_dir_all(&directory).is_ok();
        let path = directory.join("secret-bindings.json");
        let bindings = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).ok(),
            Err(e) if directory_ready && e.kind() == std::io::ErrorKind::NotFound => Some(BTreeMap::new()),
            Err(_) => None,
        };
        let bindings_unavailable = bindings.is_none();
        Ok(Self {
            store,
            bindings: Mutex::new(bindings.unwrap_or_default()),
            path,
            bindings_unavailable,
        })
    }

    fn require_bindings(&self) -> Result<()> {
        if self.bindings_unavailable {
            return Err(PlatformError::new("llm_bindings_unavailable", "AI 服务配置文件无法读取，故事仍可阅读。"));
        }
        Ok(())
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
        self.require_bindings()?;
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
        self.require_bindings()?;
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
        self.require_bindings()?;
        let slot = SecretSlot::new(slot).map_err(secret_error)?;
        let mut bindings = self.bindings.lock().map_err(|_| io_error())?;
        self.store.delete(&slot).map_err(secret_error)?;
        bindings.remove(slot.as_str());
        self.persist(&bindings)
    }

    pub fn authorize(&self, slot: &str, url: &str) -> Result<SecretValue> {
        self.require_bindings()?;
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

#[cfg(test)]
mod gemini_binding_tests {
    use super::*;
    use crate::credentials::tests::MemoryStore;

    #[test]
    fn gemini_v1beta_openai_and_native_v1beta_authorize_each_other_on_same_origin() {
        let dir = tempfile::tempdir().unwrap();
        let service = Credentials::open(dir.path().into(), Arc::new(MemoryStore::default())).unwrap();

        service
            .set(
                "gemini-preset",
                "AIzaFakeTestCredential000001".into(),
                "https://generativelanguage.googleapis.com/v1beta/openai",
            )
            .unwrap();
        for allowed in [
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
            "https://generativelanguage.googleapis.com/v1beta/openai/models",
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        ] {
            assert!(service.authorize("gemini-preset", allowed).is_ok(), "{allowed}");
        }

        service
            .set(
                "gemini-native",
                "AIzaFakeTestCredential000002".into(),
                "https://generativelanguage.googleapis.com/v1beta",
            )
            .unwrap();
        for allowed in [
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
            "https://generativelanguage.googleapis.com/v1beta/openai/models",
        ] {
            assert!(service.authorize("gemini-native", allowed).is_ok(), "{allowed}");
        }

        check_bound(
            "https://relay.example.com:8443/gemini/v1beta/openai",
            "https://relay.example.com:8443/gemini/v1beta/models/gemini-2.5-flash:generateContent",
        )
        .unwrap();
    }

    #[test]
    fn gemini_dual_binding_never_loosens_host_port_scheme_or_arbitrary_paths() {
        let base = "https://generativelanguage.googleapis.com/v1beta/openai";
        for rejected in [
            "https://evil.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
            "http://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
            "https://generativelanguage.googleapis.com:8443/v1beta/models/gemini-2.5-flash:generateContent",
            "https://generativelanguage.googleapis.com/v1alpha/models/gemini-2.5-flash:generateContent",
            "https://generativelanguage.googleapis.com/v1/chat/completions",
            "https://generativelanguage.googleapis.com/v1beta2/models/gemini-2.5-flash:generateContent",
            "https://generativelanguage.googleapis.com/v1beta/../v1alpha/models/gemini-2.5-flash:generateContent",
            "https://relay.example.com/other",
        ] {
            assert_eq!(
                check_bound(base, rejected).unwrap_err().code,
                "llm_url_not_bound",
                "should reject {rejected}"
            );
        }
        assert_eq!(
            check_bound(
                "https://relay.example.com/foov1beta/openai",
                "https://relay.example.com/foov1beta/models/x"
            )
            .unwrap_err()
            .code,
            "llm_url_not_bound"
        );
    }
}
