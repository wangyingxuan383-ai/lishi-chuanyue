use super::*;
use crate::secrets::SecretStoreError;

#[derive(Default)]
pub(crate) struct MemoryStore(Mutex<BTreeMap<String, String>>);

impl SecretStore for MemoryStore {
    fn save(
        &self,
        slot: &SecretSlot,
        value: &SecretValue,
    ) -> std::result::Result<(), SecretStoreError> {
        self.0
            .lock()
            .unwrap()
            .insert(slot.as_str().into(), value.expose_secret().into());
        Ok(())
    }
    fn load(
        &self,
        slot: &SecretSlot,
    ) -> std::result::Result<Option<SecretValue>, SecretStoreError> {
        self.0
            .lock()
            .unwrap()
            .get(slot.as_str())
            .cloned()
            .map(SecretValue::new)
            .transpose()
    }
    fn delete(&self, slot: &SecretSlot) -> std::result::Result<(), SecretStoreError> {
        self.0.lock().unwrap().remove(slot.as_str());
        Ok(())
    }
}

#[test]
fn binding_and_secret_status_persist_without_plaintext() {
    let dir = tempfile::tempdir().unwrap();
    let adapter = Arc::new(MemoryStore::default());
    let service = Credentials::open(dir.path().into(), adapter.clone()).unwrap();
    assert!(!service.has("model").unwrap().configured);
    service
        .set(
            "model",
            "fake-only-credential-value".into(),
            "https://a.com/v1///",
        )
        .unwrap();
    assert!(service.has("model").unwrap().configured);
    assert_eq!(
        service.has("model").unwrap().bound_base_url.as_deref(),
        Some("https://a.com/v1")
    );
    let json = fs::read_to_string(dir.path().join("secret-bindings.json")).unwrap();
    assert!(!json.contains("fake-only-credential-value"));
    drop(service);
    let service = Credentials::open(dir.path().into(), adapter).unwrap();
    assert!(service.authorize("model", "https://a.com/v1/chat").is_ok());
    assert_eq!(
        service
            .authorize("model", "https://a.com/v11/chat")
            .unwrap_err()
            .code,
        "llm_url_not_bound"
    );
    service.remove("model").unwrap();
    service.remove("model").unwrap();
    assert!(!service.has("model").unwrap().configured);
    assert!(service.has("model").unwrap().bound_base_url.is_none());
    assert_eq!(
        service
            .authorize("model", "https://a.com")
            .unwrap_err()
            .code,
        "llm_no_secret"
    );
}

#[test]
fn addresses_require_prefix_boundary_and_valid_absolute_url() {
    for url in [
        "https://a.com",
        "https://a.com/x",
        "https://a.com?x=1",
        "https://a.com/x#fragment",
    ] {
        check_bound("https://a.com", url).unwrap();
    }
    for url in [
        "https://a.com.evil/x",
        "https://a.com@evil/x",
        "https://a.com:999/x",
        "https://a.com\\@evil/x",
        "http://a.com/x",
    ] {
        assert_eq!(
            check_bound("https://a.com", url).unwrap_err().code,
            "llm_url_not_bound"
        );
    }
    for base in [
        "ftp://a.com",
        "https://u:p@a.com",
        "https://a.com?x",
        "https://a.com#x",
        "relative",
    ] {
        assert!(normalize_base(base).is_err());
    }
}

#[tokio::test]
async fn unbound_url_is_rejected_before_network_access() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let dir = tempfile::tempdir().unwrap();
    let service = Credentials::open(dir.path().into(), Arc::new(MemoryStore::default())).unwrap();
    service
        .set("model", "fake-no-network-token".into(), &base)
        .unwrap();
    assert_eq!(
        service
            .authorize("model", &format!("{base}evil/x"))
            .unwrap_err()
            .code,
        "llm_url_not_bound"
    );
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(50), listener.accept())
            .await
            .is_err()
    );
}
