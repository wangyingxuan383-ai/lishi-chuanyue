//! Shared native model-reference resolver. Included by both native hosts so a
//! frontend request can select a saved service, never supply its credentials.
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, path::Path};
use story_core::{Error, Result, Store};

fn invalid() -> Error {
    Error::Invalid("模型配置或凭据绑定不可用，请检查所选服务".into())
}
fn endpoint_error(message: &str) -> Error {
    Error::Invalid(message.into())
}

#[derive(Clone, PartialEq)]
struct EndpointGrant {
    id: String,
    profile_id: String,
    slot: String,
    protocol: String,
    expected_base: String,
    endpoint: String,
}
impl EndpointGrant {
    fn new(profile: &str, slot: &str, protocol: &str, base: &str, endpoint: &str) -> Self {
        let mut grant = Self {
            id: String::new(),
            profile_id: profile.into(),
            slot: slot.into(),
            protocol: protocol.into(),
            expected_base: base.into(),
            endpoint: endpoint.into(),
        };
        grant.id = grant.identity();
        grant
    }
    fn identity(&self) -> String {
        story_core::pi_store::arguments_hash(
            &json!({"profileId":self.profile_id,"slot":self.slot,"protocol":self.protocol,"expectedBase":self.expected_base,"endpoint":self.endpoint}),
        )
    }
}

fn endpoint_path(raw: &str) -> Result<String> {
    let mut bytes = raw.as_bytes().to_vec();
    for depth in 0..8 {
        let mut decoded = Vec::with_capacity(bytes.len());
        let mut index = 0;
        let mut changed = false;
        while index < bytes.len() {
            if bytes[index] != b'%' {
                decoded.push(bytes[index]);
                index += 1;
                continue;
            }
            let hex = |value: u8| match value {
                b'0'..=b'9' => Some(value - b'0'),
                b'a'..=b'f' => Some(value - b'a' + 10),
                b'A'..=b'F' => Some(value - b'A' + 10),
                _ => None,
            };
            let high = bytes.get(index + 1).and_then(|v| hex(*v));
            let low = bytes.get(index + 2).and_then(|v| hex(*v));
            let value = high
                .zip(low)
                .map(|(a, b)| a * 16 + b)
                .ok_or_else(|| endpoint_error("自定义接口地址包含无效的路径编码"))?;
            // Never authorize a path whose hierarchy changes after decoding.
            if matches!(value, b'/' | b'\\' | b'.') {
                return Err(endpoint_error("自定义接口地址包含不明确的路径层级"));
            }
            decoded.push(value);
            index += 3;
            changed = true;
        }
        bytes = decoded;
        if !changed {
            break;
        }
        if depth == 7 {
            return Err(endpoint_error("自定义接口地址包含过多层路径编码"));
        }
    }
    let path =
        String::from_utf8(bytes).map_err(|_| endpoint_error("自定义接口地址的路径编码无效"))?;
    if path
        .chars()
        .any(|c| c.is_control() || matches!(c, '?' | '#' | '\\'))
        || path.split('/').any(|part| matches!(part, "." | ".."))
    {
        return Err(endpoint_error("自定义接口地址的路径无效"));
    }
    Ok(path.trim_end_matches('/').into())
}

fn scoped_endpoint(raw: &str, expected_base: &str) -> Result<String> {
    if raw.len() > 8192 || raw.chars().any(char::is_control) || raw.contains('\\') {
        return Err(endpoint_error("自定义接口地址无效"));
    }
    // Check the spelling as well as URL::path(): the URL parser normalizes
    // dot segments before callers can inspect them.
    if let Some((_, authority_and_path)) = raw.trim().split_once("://") {
        if let Some(index) = authority_and_path.find('/') {
            endpoint_path(&authority_and_path[index..])?;
        }
    }
    let endpoint = normalize_base(raw.trim()).map_err(|_| {
        endpoint_error("自定义接口地址无效，请填写不含认证信息、查询参数或片段的完整地址")
    })?;
    let base = reqwest::Url::parse(expected_base).map_err(|_| invalid())?;
    let parsed =
        reqwest::Url::parse(&endpoint).map_err(|_| endpoint_error("自定义接口地址无效"))?;
    if parsed.origin() != base.origin() {
        return Err(endpoint_error(
            "自定义接口地址不属于所选服务，请选择对应的 AI 服务后重试",
        ));
    }
    let prefix = endpoint_path(base.path())?;
    let target = endpoint_path(parsed.path())?;
    if !(target == prefix || target.starts_with(&format!("{prefix}/"))) {
        return Err(endpoint_error(
            "自定义接口地址超出所选服务的路径范围，请检查服务与密钥绑定",
        ));
    }
    Ok(parsed.as_str().trim_end_matches('/').into())
}

fn saved_endpoint(
    db: &rusqlite::Connection,
    profile: &str,
    protocol: &str,
    base: &str,
    requested: &str,
) -> Result<String> {
    let raw: Option<String> = db
        .query_row(
            "SELECT value FROM settings WHERE key='agent:preferences'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let preferences: Value = raw
        .as_deref()
        .and_then(|raw| serde_json::from_str(raw).ok())
        .ok_or_else(|| endpoint_error("请先在 Agent 设置中保存自定义接口地址"))?;
    if preferences["profileId"].as_str() != Some(profile)
        || preferences["protocol"]
            .as_str()
            .unwrap_or("chat-completions")
            != protocol
    {
        return Err(endpoint_error(
            "自定义接口地址与已保存的 Agent 服务或接口类型不一致，请重新保存设置",
        ));
    }
    let saved = preferences["modelUrl"]
        .as_str()
        .filter(|raw| !raw.trim().is_empty())
        .ok_or_else(|| endpoint_error("请先在 Agent 设置中保存自定义接口地址"))?;
    let saved = scoped_endpoint(saved, base)?;
    if saved != requested {
        return Err(endpoint_error(
            "自定义接口地址尚未保存，或已被修改，请保存设置后重试",
        ));
    }
    Ok(saved)
}

fn load_grant(db: &rusqlite::Connection, id: &str) -> Result<EndpointGrant> {
    if id.len() != 64
        || !id
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(endpoint_error("已保存的模型接口定位无效，请重新选择服务"));
    }
    db.query_row("SELECT id,profile_id,slot,protocol,expected_base,endpoint FROM pi_model_endpoints WHERE id=?", [id], |row| Ok(EndpointGrant { id: row.get(0)?, profile_id: row.get(1)?, slot: row.get(2)?, protocol: row.get(3)?, expected_base: row.get(4)?, endpoint: row.get(5)? })).optional()?.ok_or_else(|| endpoint_error("已保存的模型接口定位不存在，请重新保存 Agent 设置"))
}

/// `authorize` must use the platform's native secret adapter and fresh binding
/// storage. A custom endpoint is usable only through a saved configuration or
/// an immutable native grant; frontend credentials are never examined.
pub fn resolve(
    store: &Store,
    data_root: &Path,
    reference: &Value,
    authorize: impl FnOnce(&str, &str) -> Result<String>,
) -> Result<Value> {
    resolve_profile(store, reference, |slot, expected| {
        let binding_path = data_root.join("secret-bindings.json");
        if fs::metadata(&binding_path).map_err(|_| invalid())?.len() > 1024 * 1024 {
            return Err(invalid());
        }
        let bindings: BTreeMap<String, String> =
            serde_json::from_slice(&fs::read(binding_path).map_err(|_| invalid())?)
                .map_err(|_| invalid())?;
        let bound = bindings.get(slot).ok_or_else(invalid)?;
        if normalize_base(bound)? != expected {
            return Err(invalid());
        }
        authorize(slot, bound)
    })
}

/// Reuses saved profile selection and wire configuration for a development
/// secret adapter. That adapter must independently authorize `expected_base`
/// against its current persisted binding before returning a secret.
pub fn resolve_profile(
    store: &Store,
    reference: &Value,
    authorize: impl FnOnce(&str, &str) -> Result<String>,
) -> Result<Value> {
    let profile = reference["profileId"].as_str().filter(|id| !id.is_empty());
    let slot = reference["slot"].as_str().unwrap_or("");
    if profile.is_none() && slot.is_empty() {
        return Err(invalid());
    }
    let (id, base, key_slot, main_model, params): (String, String, String, String, String) = {
        let db = store.lock()?;
        let query = if profile.is_some() {
            "SELECT id,base_url,key_slot,main_model,params_json FROM profiles WHERE id=?"
        } else {
            "SELECT id,base_url,key_slot,main_model,params_json FROM profiles WHERE key_slot=? ORDER BY id LIMIT 1"
        };
        db.query_row(query, [profile.unwrap_or(slot)], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .map_err(|_| invalid())?
    };
    if !slot.is_empty() && slot != key_slot {
        return Err(invalid());
    }
    let parameters: Value = serde_json::from_str(&params).map_err(|_| invalid())?;
    let protocol = reference["protocol"]
        .as_str()
        .or_else(|| parameters["protocol"].as_str())
        .unwrap_or("chat-completions");
    if ![
        "chat-completions",
        "openai-responses",
        "anthropic",
        "gemini",
    ]
    .contains(&protocol)
    {
        return Err(invalid());
    }
    // Saved profiles permit a bare host, /v1 base or full /chat/completions
    // address. Match the existing serviceBase() normalization used when a key
    // is bound. Pi receives the native binding, not the frontend URL.
    let normalized = normalize_base(base.trim())?;
    let parsed = reqwest::Url::parse(&normalized).map_err(|_| invalid())?;
    let expected = if let Some(base) = normalized.strip_suffix("/chat/completions") {
        base.to_owned()
    } else if parsed.path().trim_matches('/').is_empty() {
        format!("{normalized}/v1")
    } else {
        normalized
    };
    let model = reference["id"]
        .as_str()
        .or_else(|| reference["model"].as_str())
        .filter(|value| !value.is_empty())
        .unwrap_or(&main_model);
    if model.trim().is_empty() || model.len() > 512 || model.chars().any(char::is_control) {
        return Err(invalid());
    }
    let raw_endpoint = match reference.get("modelUrl") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => Some(value.trim()).filter(|v| !v.is_empty()),
        _ => return Err(endpoint_error("自定义接口地址格式无效")),
    };
    let endpoint_ref = match reference.get("endpointRef") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if !value.is_empty() => Some(value.as_str()),
        _ => return Err(endpoint_error("已保存的模型接口定位无效，请重新选择服务")),
    };
    let grant = if let Some(endpoint_ref) = endpoint_ref {
        let grant = load_grant(&*store.lock()?, endpoint_ref)?;
        if grant.id != grant.identity()
            || grant.profile_id != id
            || grant.slot != key_slot
            || grant.protocol != protocol
            || grant.expected_base != expected
        {
            return Err(endpoint_error(
                "原任务的模型接口绑定已变更，请重新选择对应服务后继续",
            ));
        }
        if scoped_endpoint(&grant.endpoint, &expected)? != grant.endpoint {
            return Err(endpoint_error(
                "已保存的模型接口定位无效，请重新保存 Agent 设置",
            ));
        }
        if let Some(raw) = raw_endpoint {
            if scoped_endpoint(raw, &expected)? != grant.endpoint {
                return Err(endpoint_error(
                    "本次接口地址与原任务保存的定位不一致，请重新选择服务后继续",
                ));
            }
        }
        Some(grant)
    } else if let Some(raw) = raw_endpoint {
        let endpoint = scoped_endpoint(raw, &expected)?;
        saved_endpoint(&*store.lock()?, &id, protocol, &expected, &endpoint)?;
        Some(EndpointGrant::new(
            &id, &key_slot, protocol, &expected, &endpoint,
        ))
    } else {
        None
    };
    // This callback is deliberately outside the database lock. Native secret
    // access independently checks the current binding immediately before use.
    let secret = authorize(&key_slot, &expected)?;
    if let Some(grant) = &grant {
        let mut db = store.lock()?;
        let tx = db.transaction()?;
        let (current_base, current_slot): (String, String) = tx
            .query_row(
                "SELECT base_url,key_slot FROM profiles WHERE id=?",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|_| invalid())?;
        if current_base != base || current_slot != key_slot {
            return Err(endpoint_error(
                "模型服务在读取凭据时已变更，请重新选择后重试",
            ));
        }
        if endpoint_ref.is_none() {
            saved_endpoint(&tx, &id, protocol, &expected, &grant.endpoint)?;
        }
        tx.execute("INSERT OR IGNORE INTO pi_model_endpoints(id,profile_id,slot,protocol,expected_base,endpoint) VALUES(?,?,?,?,?,?)", rusqlite::params![grant.id,grant.profile_id,grant.slot,grant.protocol,grant.expected_base,grant.endpoint])?;
        if load_grant(&tx, &grant.id)? != *grant {
            return Err(endpoint_error(
                "模型接口定位发生冲突，请重新保存 Agent 设置",
            ));
        }
        tx.commit()?;
    }
    let mut wire = json!({"id":model,"profileId":id,"slot":key_slot,"protocol":protocol,
        "baseUrl":expected,"apiKey":secret,"inputTokens":475000,"maxOutputTokens":8192});
    if let Some(grant) = grant {
        wire["baseUrl"] = grant.endpoint.into();
        wire["endpointRef"] = grant.id.into();
    }
    for field in [
        "inputTokens",
        "contextWindowTokens",
        "maxOutputTokens",
        "reasoning",
        "temperature",
        "topP",
    ] {
        if let Some(value) = reference
            .get(field)
            .filter(|v| !v.is_object() && !v.is_array() && !v.is_null())
        {
            wire[field] = value.clone();
        }
    }
    if reference.get("inputTokens").is_none() {
        if let Some(value) = reference.get("contextTokens").filter(|v| v.is_u64()) {
            wire["inputTokens"] = value.clone();
        }
    }
    Ok(wire)
}

fn normalize_base(value: &str) -> Result<String> {
    let parsed = reqwest::Url::parse(value).map_err(|_| invalid())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !value.starts_with(&format!("{}://", parsed.scheme()))
    {
        return Err(invalid());
    }
    Ok(value.trim_end_matches('/').to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };

    fn fixture() -> Store {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE profiles(id TEXT PRIMARY KEY,base_url TEXT NOT NULL,key_slot TEXT NOT NULL,main_model TEXT NOT NULL,params_json TEXT NOT NULL);
CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE pi_model_endpoints(id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,slot TEXT NOT NULL,protocol TEXT NOT NULL,expected_base TEXT NOT NULL,endpoint TEXT NOT NULL);
INSERT INTO profiles VALUES('own-profile','https://fixture.invalid/v1','own-slot','owned-model','{}');").unwrap();
        Store(Arc::new(Mutex::new(db)))
    }
    fn preferences(store: &Store, value: Value) {
        store
            .lock()
            .unwrap()
            .execute(
                "INSERT OR REPLACE INTO settings(key,value) VALUES('agent:preferences',?)",
                [value.to_string()],
            )
            .unwrap();
    }
    fn configured(store: &Store, endpoint: &str) {
        preferences(
            store,
            json!({"profileId":"own-profile","protocol":"chat-completions","modelUrl":endpoint}),
        );
    }
    fn run(store: &Store, reference: Value) -> Result<Value> {
        resolve_profile(store, &reference, |slot, base| {
            assert_eq!(slot, "own-slot");
            assert_eq!(base, "https://fixture.invalid/v1");
            Ok("in-memory-fixture-secret".into())
        })
    }
    #[test]
    fn saved_custom_endpoint_issues_an_immutable_locator_after_native_authorization() {
        let store = fixture();
        configured(&store, "https://fixture.invalid/v1/proxy/chat/completions");
        let wire=run(&store,json!({"profileId":"own-profile","protocol":"chat-completions","modelUrl":"https://fixture.invalid/v1/proxy/chat/completions","apiKey":"not-authority","baseUrl":"https://not-authority.invalid"})).unwrap();
        assert_eq!(
            wire["baseUrl"],
            "https://fixture.invalid/v1/proxy/chat/completions"
        );
        assert_eq!(wire["apiKey"], "in-memory-fixture-secret");
        let reference = wire["endpointRef"].as_str().unwrap();
        assert_eq!(reference.len(), 64);
        let grant = load_grant(&store.lock().unwrap(), reference).unwrap();
        assert_eq!(grant.identity(), reference);
        assert_eq!(grant.slot, "own-slot");
        assert_eq!(grant.expected_base, "https://fixture.invalid/v1");
        assert_eq!(
            store
                .lock()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM pi_model_endpoints", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        let unchanged=run(&store,json!({"profileId":"own-profile","url":"https://ignored.invalid","baseUrl":"https://ignored.invalid"})).unwrap();
        assert_eq!(unchanged["baseUrl"], "https://fixture.invalid/v1");
        assert!(unchanged["endpointRef"].is_null());
    }
    #[test]
    fn arbitrary_ui_or_saved_out_of_scope_endpoints_do_not_receive_native_credentials() {
        let store = fixture();
        let calls = AtomicUsize::new(0);
        for endpoint in [
            "https://other.invalid/v1/chat/completions",
            "http://fixture.invalid/v1/chat/completions",
            "https://fixture.invalid:444/v1/chat/completions",
            "https://fixture.invalid/v1-other/chat/completions",
            "https://fixture.invalid/v1/%2e%2e/chat/completions",
            "https://fixture.invalid/v1/proxy%2f..%2fchat/completions",
            "https://fixture.invalid/v1/proxy%252f..%252fchat/completions",
            "https://fixture.invalid/v1/chat/completions?api_key=forbidden",
            "https://user:pass@fixture.invalid/v1/chat/completions",
            "https://fixture.invalid/v1/chat/completions#fragment",
        ] {
            configured(&store, endpoint);
            let resolved = resolve_profile(
                &store,
                &json!({"profileId":"own-profile","modelUrl":endpoint}),
                |_, _| {
                    calls.fetch_add(1, Ordering::Relaxed);
                    Ok("unreachable".into())
                },
            );
            assert!(resolved.is_err(), "out-of-scope endpoint accepted");
        }
        configured(&store, "https://fixture.invalid/v1/chat/completions");
        assert!(resolve_profile(&store,&json!({"profileId":"own-profile","modelUrl":"https://fixture.invalid/v1/not-saved/chat/completions"}),|_,_| {calls.fetch_add(1,Ordering::Relaxed);Ok("unreachable".into())}).is_err());
        assert_eq!(calls.load(Ordering::Relaxed), 0);
        assert_eq!(
            store
                .lock()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM pi_model_endpoints", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn saved_profile_protocol_and_slot_must_match_the_selected_service() {
        let store = fixture();
        let endpoint = "https://fixture.invalid/v1/messages";
        configured(&store, endpoint);
        assert!(run(
            &store,
            json!({"profileId":"own-profile","protocol":"anthropic","modelUrl":endpoint})
        )
        .is_err());
        preferences(
            &store,
            json!({"profileId":"different-profile","protocol":"anthropic","modelUrl":endpoint}),
        );
        assert!(run(
            &store,
            json!({"profileId":"own-profile","protocol":"anthropic","modelUrl":endpoint})
        )
        .is_err());
        preferences(
            &store,
            json!({"profileId":"own-profile","protocol":"anthropic","modelUrl":endpoint}),
        );
        assert!(run(&store,json!({"profileId":"own-profile","slot":"different-slot","protocol":"anthropic","modelUrl":endpoint})).is_err());
        let wire=run(&store,json!({"profileId":"own-profile","slot":"own-slot","protocol":"anthropic","modelUrl":endpoint})).unwrap();
        assert_eq!(wire["baseUrl"], endpoint);
        assert_eq!(wire["protocol"], "anthropic");
    }
    #[test]
    fn restoring_a_grant_keeps_the_frozen_endpoint_when_global_preferences_change() {
        let store = fixture();
        let original = "https://fixture.invalid/v1/old/chat/completions";
        configured(&store, original);
        let wire = run(
            &store,
            json!({"profileId":"own-profile","modelUrl":original}),
        )
        .unwrap();
        configured(&store, "https://fixture.invalid/v1/new/chat/completions");
        let frozen = run(
            &store,
            json!({"profileId":"own-profile","endpointRef":wire["endpointRef"]}),
        )
        .unwrap();
        assert_eq!(frozen["baseUrl"], original);
        assert_eq!(frozen["endpointRef"], wire["endpointRef"]);
        assert!(run(&store,json!({"profileId":"own-profile","endpointRef":wire["endpointRef"],"modelUrl":"https://fixture.invalid/v1/new/chat/completions"})).is_err());
        let next=run(&store,json!({"profileId":"own-profile","modelUrl":"https://fixture.invalid/v1/new/chat/completions"})).unwrap();
        assert_ne!(next["endpointRef"], wire["endpointRef"]);
    }
    #[test]
    fn changed_bindings_and_denied_fresh_authorization_cannot_restore_an_endpoint() {
        let store = fixture();
        let endpoint = "https://fixture.invalid/v1/chat/completions";
        configured(&store, endpoint);
        let wire = run(
            &store,
            json!({"profileId":"own-profile","modelUrl":endpoint}),
        )
        .unwrap();
        let reference = json!({"profileId":"own-profile","endpointRef":wire["endpointRef"]});
        let calls = AtomicUsize::new(0);
        assert!(resolve_profile(&store, &reference, |_, _| {
            calls.fetch_add(1, Ordering::Relaxed);
            Err(invalid())
        })
        .is_err());
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        store
            .lock()
            .unwrap()
            .execute(
                "UPDATE profiles SET base_url='https://fixture.invalid/v2' WHERE id='own-profile'",
                [],
            )
            .unwrap();
        assert!(resolve_profile(&store, &reference, |_, _| {
            calls.fetch_add(1, Ordering::Relaxed);
            Ok("unreachable".into())
        })
        .is_err());
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        store.lock().unwrap().execute("UPDATE profiles SET base_url='https://fixture.invalid/v1',key_slot='changed-slot' WHERE id='own-profile'",[]).unwrap();
        assert!(resolve_profile(&store, &reference, |_, _| {
            calls.fetch_add(1, Ordering::Relaxed);
            Ok("unreachable".into())
        })
        .is_err());
        assert_eq!(calls.load(Ordering::Relaxed), 1);
    }
    #[test]
    fn concurrent_configuration_change_during_secret_access_does_not_create_a_grant() {
        let store = fixture();
        let endpoint = "https://fixture.invalid/v1/chat/completions";
        configured(&store, endpoint);
        assert!(resolve_profile(
            &store,
            &json!({"profileId":"own-profile","modelUrl":endpoint}),
            |_, _| {
                // This also demonstrates that native credential access runs outside
                // the database mutex instead of deadlocking the service.
                configured(
                    &store,
                    "https://fixture.invalid/v1/changed/chat/completions",
                );
                Ok("fixture-only".into())
            }
        )
        .is_err());
        assert_eq!(
            store
                .lock()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM pi_model_endpoints", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}
