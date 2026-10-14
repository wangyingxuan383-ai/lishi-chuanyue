//! Provider configuration is separate from world saves. No credential is stored
//! here; native callers own the secret store and pass frozen protected values.
use crate::game_context::ContextBudget;
use crate::game_protocol::{GameError, TurnOutput, WorldState};
use crate::game_store::{GameActionKind, GameTurnRequest, WorldView};
use crate::model_probe::{CredentialMode, ModelProbeRequest, SavedEndpointPolicy};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fmt, path::Path, sync::Mutex};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    Demo,
    Compatible,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    Unknown,
    Supported,
    Unsupported,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub endpoint: String,
    pub model: String,
    pub revision: u64,
    pub allow_insecure_http: bool,
    /// Application/user budget, not a verified capability of the named model.
    pub context_budget: ContextBudget,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilities {
    pub streaming: Capability,
    pub structured_output: Capability,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    pub config: Option<ProviderConfig>,
    pub configured: bool,
    pub capabilities: ProviderCapabilities,
    pub revision: u64,
}

#[derive(Clone)]
pub struct StoredProvider {
    pub config: ProviderConfig,
    pub secret_slot: String,
    pub streaming: Capability,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GamePreset {
    pub preset_id: String,
    pub name: String,
    pub setup: crate::game_protocol::WorldSetup,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderError {
    Database,
    InvalidConfig,
    Missing,
    Stale,
    Incompatible,
    ContextTooLarge,
}
impl fmt::Display for ProviderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Database => "game_database",
            Self::InvalidConfig => "game_provider_invalid",
            Self::Missing => "game_provider_missing",
            Self::Stale => "game_provider_stale",
            Self::Incompatible => "game_incompatible_schema",
            Self::ContextTooLarge => "game_context_too_large",
        })
    }
}
impl std::error::Error for ProviderError {}
impl From<rusqlite::Error> for ProviderError {
    fn from(_: rusqlite::Error) -> Self {
        Self::Database
    }
}

pub fn validate_config(endpoint: &str, model: &str) -> Result<(), ProviderError> {
    validate_config_with_http_opt_in(endpoint, model, false)
}
pub fn validate_config_with_http_opt_in(
    endpoint: &str,
    model: &str,
    allow_insecure_http: bool,
) -> Result<(), ProviderError> {
    ModelProbeRequest {
        operation_id: "provider-validation".into(),
        endpoint: endpoint.into(),
        model: model.into(),
        prompt: "连接验证".into(),
        include_usage: false,
        credential_mode: CredentialMode::Saved,
    }
    .validate_with_endpoint_policy(if allow_insecure_http {
        SavedEndpointPolicy::ExplicitHttp
    } else {
        SavedEndpointPolicy::HttpsOnly
    })
    .map_err(|_| ProviderError::InvalidConfig)
}

pub struct ProviderStore {
    connection: Mutex<Connection>,
}
impl ProviderStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, ProviderError> {
        let mut c = Connection::open(path)?;
        c.busy_timeout(std::time::Duration::from_secs(5))?;
        let version: i64 = c.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version > 1 {
            return Err(ProviderError::Incompatible);
        }
        c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
          CREATE TABLE IF NOT EXISTS provider(singleton INTEGER PRIMARY KEY CHECK(singleton=1),
            endpoint TEXT NOT NULL, model TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
            secret_slot TEXT NOT NULL, streaming TEXT NOT NULL CHECK(streaming IN ('unknown','supported','unsupported'))) STRICT;
          CREATE TABLE IF NOT EXISTS allocated_slots(slot TEXT PRIMARY KEY) STRICT;
          CREATE TABLE IF NOT EXISTS provider_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL CHECK(revision>=0)) STRICT;
          INSERT OR IGNORE INTO provider_meta(singleton,revision) SELECT 1,COALESCE(MAX(revision),0) FROM provider;
          CREATE TABLE IF NOT EXISTS presets(preset_id TEXT PRIMARY KEY,name TEXT NOT NULL,setup TEXT NOT NULL) STRICT;
          PRAGMA user_version=1;")?;
        // Additive nullable metadata preserves old profiles and old readers.
        // NULL is the legacy application's conservative default, not a model
        // context-window claim. The selected row/revision/secret reference do
        // not change during this schema update.
        let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let has_context_budget = {
            let mut columns = tx.prepare("PRAGMA table_info(provider)")?;
            let names = columns.query_map([], |row| row.get::<_, String>(1))?;
            let mut found = false;
            for name in names {
                found |= name? == "context_budget";
            }
            found
        };
        if !has_context_budget {
            tx.execute_batch("ALTER TABLE provider ADD COLUMN context_budget TEXT CHECK(context_budget IS NULL OR json_valid(context_budget));")?;
        }
        tx.commit()?;
        Ok(Self {
            connection: Mutex::new(c),
        })
    }
    pub fn stored(&self) -> Result<Option<StoredProvider>, ProviderError> {
        let c = self
            .connection
            .lock()
            .map_err(|_| ProviderError::Database)?;
        Self::read_stored(&c)
    }
    fn read_stored(c: &Connection) -> Result<Option<StoredProvider>, ProviderError> {
        let raw:Option<(String,String,i64,String,String,Option<String>)>=c.query_row(
          "SELECT endpoint,model,revision,secret_slot,streaming,context_budget FROM provider WHERE singleton=1",[],
          |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()?;
        raw.map(
            |(endpoint, model, revision, secret_slot, streaming, context_json)| {
                // HTTP metadata can only be written through the explicit native
                // save policy. Its persisted scheme records that opt-in.
                validate_config_with_http_opt_in(&endpoint, &model, true)?;
                let allow_insecure_http = endpoint
                    .get(..5)
                    .is_some_and(|p| p.eq_ignore_ascii_case("http:"));
                let revision = u64::try_from(revision).map_err(|_| ProviderError::Database)?;
                let current = Self::read_revision(c)?;
                if current != revision {
                    return Err(ProviderError::Database);
                }
                let streaming = match streaming.as_str() {
                    "unknown" => Capability::Unknown,
                    "supported" => Capability::Supported,
                    "unsupported" => Capability::Unsupported,
                    _ => return Err(ProviderError::Database),
                };
                crate::secrets::SecretSlot::new(&secret_slot)
                    .map_err(|_| ProviderError::Database)?;
                let context_budget = context_json
                    .map(|json| {
                        serde_json::from_str::<ContextBudget>(&json)
                            .map_err(|_| ProviderError::Database)
                    })
                    .transpose()?
                    .unwrap_or_default();
                context_budget
                    .effective_input_limit_bytes()
                    .map_err(|_| ProviderError::Database)?;
                Ok(StoredProvider {
                    config: ProviderConfig {
                        endpoint,
                        model,
                        revision,
                        allow_insecure_http,
                        context_budget,
                    },
                    secret_slot,
                    streaming,
                })
            },
        )
        .transpose()
    }
    pub fn view(&self) -> Result<ProviderView, ProviderError> {
        let c = self
            .connection
            .lock()
            .map_err(|_| ProviderError::Database)?;
        let stored = Self::read_stored(&c)?;
        let revision = Self::read_revision(&c)?;
        Ok(ProviderView {
            configured: stored.is_some(),
            config: stored.as_ref().map(|s| s.config.clone()),
            capabilities: ProviderCapabilities {
                streaming: stored.as_ref().map_or(Capability::Unknown, |s| s.streaming),
                structured_output: Capability::Unknown,
            },
            revision,
        })
    }
    pub fn revision(&self) -> Result<u64, ProviderError> {
        let c = self
            .connection
            .lock()
            .map_err(|_| ProviderError::Database)?;
        Self::read_revision(&c)
    }
    fn read_revision(c: &Connection) -> Result<u64, ProviderError> {
        let revision: i64 = c.query_row(
            "SELECT revision FROM provider_meta WHERE singleton=1",
            [],
            |r| r.get(0),
        )?;
        u64::try_from(revision).map_err(|_| ProviderError::Database)
    }
    /// Allocated generations are never reused, including failed secret writes.
    pub fn allocate_slot(&self, slot: &str) -> Result<(), ProviderError> {
        crate::secrets::SecretSlot::new(slot).map_err(|_| ProviderError::InvalidConfig)?;
        self.connection
            .lock()
            .map_err(|_| ProviderError::Database)?
            .execute("INSERT INTO allocated_slots(slot) VALUES(?1)", [slot])?;
        Ok(())
    }
    pub fn save(
        &self,
        endpoint: &str,
        model: &str,
        slot: &str,
        expected_revision: u64,
    ) -> Result<ProviderView, ProviderError> {
        self.save_with_http_opt_in(endpoint, model, slot, expected_revision, false)
    }
    pub fn save_with_http_opt_in(
        &self,
        endpoint: &str,
        model: &str,
        slot: &str,
        expected_revision: u64,
        allow_insecure_http: bool,
    ) -> Result<ProviderView, ProviderError> {
        self.save_with_optional_context_budget(
            endpoint,
            model,
            slot,
            expected_revision,
            allow_insecure_http,
            None,
        )
    }
    pub fn save_with_context_budget(
        &self,
        endpoint: &str,
        model: &str,
        slot: &str,
        expected_revision: u64,
        allow_insecure_http: bool,
        context_budget: ContextBudget,
    ) -> Result<ProviderView, ProviderError> {
        self.save_with_optional_context_budget(
            endpoint,
            model,
            slot,
            expected_revision,
            allow_insecure_http,
            Some(context_budget),
        )
    }
    fn save_with_optional_context_budget(
        &self,
        endpoint: &str,
        model: &str,
        slot: &str,
        expected_revision: u64,
        allow_insecure_http: bool,
        context_budget: Option<ContextBudget>,
    ) -> Result<ProviderView, ProviderError> {
        validate_config_with_http_opt_in(endpoint, model, allow_insecure_http)?;
        if let Some(budget) = context_budget {
            budget
                .effective_input_limit_bytes()
                .map_err(|_| ProviderError::InvalidConfig)?;
        }
        crate::secrets::SecretSlot::new(slot).map_err(|_| ProviderError::InvalidConfig)?;
        if expected_revision >= 9_007_199_254_740_991 {
            return Err(ProviderError::Stale);
        }
        let mut c = self
            .connection
            .lock()
            .map_err(|_| ProviderError::Database)?;
        let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let revision: i64 = tx.query_row(
            "SELECT revision FROM provider_meta WHERE singleton=1",
            [],
            |r| r.get(0),
        )?;
        if u64::try_from(revision).ok() != Some(expected_revision) {
            return Err(ProviderError::Stale);
        }
        let budget = context_budget.unwrap_or(
            Self::read_stored(&tx)?
                .map(|stored| stored.config.context_budget)
                .unwrap_or_default(),
        );
        let context_json =
            serde_json::to_string(&budget).map_err(|_| ProviderError::InvalidConfig)?;
        tx.execute("INSERT INTO provider(singleton,endpoint,model,revision,secret_slot,streaming,context_budget) VALUES(1,?1,?2,?3,?4,'unknown',?5)
          ON CONFLICT(singleton) DO UPDATE SET endpoint=excluded.endpoint,model=excluded.model,revision=excluded.revision,
          secret_slot=excluded.secret_slot,streaming='unknown',context_budget=excluded.context_budget",params![endpoint,model,revision+1,slot,context_json])?;
        tx.execute(
            "UPDATE provider_meta SET revision=?1 WHERE singleton=1",
            [revision + 1],
        )?;
        tx.commit()?;
        drop(c);
        self.view()
    }
    pub fn record_streaming(
        &self,
        revision: u64,
        capability: Capability,
    ) -> Result<(), ProviderError> {
        let revision = i64::try_from(revision).map_err(|_| ProviderError::Stale)?;
        let value = match capability {
            Capability::Unknown => "unknown",
            Capability::Supported => "supported",
            Capability::Unsupported => "unsupported",
        };
        self.connection
            .lock()
            .map_err(|_| ProviderError::Database)?
            .execute(
                "UPDATE provider SET streaming=?1 WHERE singleton=1 AND revision=?2",
                params![value, revision],
            )?;
        Ok(())
    }
    pub fn clear(&self, expected_revision: u64) -> Result<ProviderView, ProviderError> {
        if expected_revision >= 9_007_199_254_740_991 {
            return Err(ProviderError::Stale);
        }
        let mut c = self
            .connection
            .lock()
            .map_err(|_| ProviderError::Database)?;
        let tx = c.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let revision: i64 = tx.query_row(
            "SELECT revision FROM provider_meta WHERE singleton=1",
            [],
            |r| r.get(0),
        )?;
        if u64::try_from(revision).ok() != Some(expected_revision) {
            return Err(ProviderError::Stale);
        }
        tx.execute("DELETE FROM provider WHERE singleton=1", [])?;
        tx.execute(
            "UPDATE provider_meta SET revision=?1 WHERE singleton=1",
            [revision + 1],
        )?;
        tx.commit()?;
        drop(c);
        self.view()
    }
    pub fn presets(&self) -> Result<Vec<GamePreset>, ProviderError> {
        let c = self
            .connection
            .lock()
            .map_err(|_| ProviderError::Database)?;
        let mut stmt = c.prepare(
            "SELECT preset_id,name,setup FROM presets ORDER BY name,preset_id LIMIT 100",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        let mut result = Vec::new();
        for row in rows {
            let (preset_id, name, raw) = row?;
            let setup = serde_json::from_str(&raw).map_err(|_| ProviderError::Database)?;
            crate::game_protocol::validate_setup(&setup).map_err(|_| ProviderError::Database)?;
            result.push(GamePreset {
                preset_id,
                name,
                setup,
            });
        }
        Ok(result)
    }
    pub fn save_preset(
        &self,
        preset_id: &str,
        name: &str,
        setup: &crate::game_protocol::WorldSetup,
    ) -> Result<Vec<GamePreset>, ProviderError> {
        if name.trim().is_empty() || name.len() > 128 {
            return Err(ProviderError::InvalidConfig);
        }
        crate::game_protocol::validate_setup(setup).map_err(|_| ProviderError::InvalidConfig)?;
        let mut setup = setup.clone();
        setup.world_id = "preset-config".into();
        let raw = serde_json::to_string(&setup).map_err(|_| ProviderError::Database)?;
        let c = self
            .connection
            .lock()
            .map_err(|_| ProviderError::Database)?;
        let count: i64 = c.query_row("SELECT COUNT(*) FROM presets", [], |r| r.get(0))?;
        if count >= 100 {
            return Err(ProviderError::InvalidConfig);
        }
        c.execute(
            "INSERT INTO presets(preset_id,name,setup) VALUES(?1,?2,?3)",
            params![preset_id, name, raw],
        )?;
        drop(c);
        self.presets()
    }
}

pub fn opening_narrative(setup: &crate::game_protocol::WorldSetup) -> String {
    let year = if setup.era_year < 0 {
        format!("公元前{}年", setup.era_year.unsigned_abs())
    } else {
        format!("公元{}年", setup.era_year)
    };
    format!("{year}，{}。\n你以{}的身份来到{}，随身有行囊和100记账单位的游戏初始资金。你可以自由描述行动，也可以从下方选项开始。\n\n背景与初始资源是本次游戏设定，历史资料尚未研究。",setup.country,setup.protagonist_name,setup.location_name)
}

/// Production inference may wait longer for response headers or thinking
/// metadata than a transport fixture. It is still one cancellable attempt.
pub fn production_stream_options() -> crate::StreamOptions {
    crate::StreamOptions {
        connect_timeout: std::time::Duration::from_secs(30),
        idle_timeout: std::time::Duration::from_secs(30),
        ..crate::StreamOptions::default()
    }
}

pub fn initial_choices() -> Vec<crate::game_protocol::Choice> {
    serde_json::from_value(serde_json::json!([
      {"id":"ask","text":"向当地人打听消息"},{"id":"buy","text":"购买补给"},
      {"id":"work","text":"寻找短工赚取报酬"}]))
    .expect("static choices satisfy the protocol")
}

/// Fixed demo rules deliberately have no network access or claimed AI ability.
pub fn demo_output(state: &WorldState, request: &GameTurnRequest) -> Result<TurnOutput, GameError> {
    let action = if request.action_kind == GameActionKind::Continue {
        "继续观察周围"
    } else {
        request.action_text.as_str()
    };
    let player = state.entities.iter().find(|e| e.id == state.protagonist_id);
    let name = player.map_or("主角", |e| e.name.as_str());
    let cash = state
        .resources
        .iter()
        .find(|r| r.owner_id == state.protagonist_id && r.key == "cash");
    let mut changes = Vec::new();
    let mut elapsed = 3600_u64;
    let suffix = Sha256::digest(request.operation_id.as_bytes())[..16]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let consequence = if action.contains("购买") || action.contains("买") {
        let amount = cash.map_or(0, |r| r.amount);
        if amount >= 5 {
            changes.push(serde_json::json!({"type":"change_resource","ownerId":state.protagonist_id,
          "key":"cash","unit":cash.map_or("记账单位",|r|r.unit.as_str()),"delta":-5,"expectedAmount":amount}));
            "你支付5记账单位购买补给，资金已按规则扣除。".to_owned()
        } else {
            "资金不足，购买没有发生。".to_owned()
        }
    } else if action.contains("短工") || action.contains("赚钱") || action.contains("工作") {
        changes.push(serde_json::json!({"type":"change_resource","ownerId":state.protagonist_id,"key":"cash",
          "unit":cash.map_or("记账单位",|r|r.unit.as_str()),"delta":10,"expectedAmount":cash.map_or(0,|r|r.amount)}));
        elapsed = 7200;
        "完成两小时短工，获得10记账单位报酬。".to_owned()
    } else if action.contains("受伤") {
        changes.push(serde_json::json!({"type":"add_condition","condition":{"id":format!("injury-{suffix}"),
          "entityId":state.protagonist_id,"description":"需要休息的伤病（演示设定）","active":true}}));
        "一次意外造成伤病，持续状态已记录。".to_owned()
    } else if action.contains("休息") {
        for condition in state
            .conditions
            .iter()
            .filter(|c| c.entity_id == state.protagonist_id && c.active)
        {
            changes
                .push(serde_json::json!({"type":"resolve_condition","conditionId":condition.id}));
        }
        elapsed = 7200;
        "休息两小时，演示规则中的伤病状态得到解决。".to_owned()
    } else if action.contains("死亡") {
        changes.push(serde_json::json!({"type":"set_life_status","entityId":state.protagonist_id,"alive":false}));
        "本段人生在这里结束，已发生的剧情与状态保留。".to_owned()
    } else {
        "周围的生活继续推进，你留意到新的交谈与动静。".to_owned()
    };
    crate::game_protocol::parse_output(&serde_json::json!({"protocolVersion":1,
      "narrative":format!("{name}尝试：{action}。\n{consequence}"),"choices":initial_choices(),
      "timeAdvance":{"elapsedSeconds":elapsed},"stateChanges":changes,
      "events":[{"id":format!("event-{suffix}"),"description":action.chars().take(256).collect::<String>(),"entityIds":[state.protagonist_id]}],
      "sourceReferences":[],"uncertainties":["当前是固定规则演示，不代表AI推演或经过考证的史实。"]}).to_string())
}

pub fn compile_game_prompt(
    view: &WorldView,
    request: &GameTurnRequest,
) -> Result<String, ProviderError> {
    let state = serde_json::to_string(&view.state).map_err(|_| ProviderError::Database)?;
    let instruction="你是单人历史穿越游戏的叙事者。仅返回完整JSON，不输出SQL/工具/思考。协议字段全部必填：protocolVersion:1,narrative:string,choices:[{id,text}],timeAdvance:{elapsedSeconds:非负整数},stateChanges:[],events:[{id,description,entityIds:[]}],sourceReferences:[],uncertainties:[]。没有历史来源时sourceReferences必须为空，不伪造考证。stateChanges允许type=change_resource(ownerId,key,unit,delta,expectedAmount:null或当前整数)、move(locationId)、set_life_status(entityId,alive)、set_attribute(entityId,key,value,expectedValue:null或当前值)、create_entity(entity:{id,kind,name,alive:null或bool,attributes:{}})、change_relationship(fromId,toId,kind,strength)、add_condition(condition:{id,entityId,description,active})、resolve_condition(conditionId)、record_knowledge(actorId,factId)。只引用现有或本次创建实体，资源不为负，死亡不复活，正文和结算一致。当前角色已死亡时不能行动。choices最多6条，不替玩家选择后续。历史不确定内容写uncertainties。";
    let limits="所有ID用1至64字节ASCII字母数字、下划线或连字符；不增加额外字段。entity.kind仅person/place/organization/item；person.alive必须bool，其余为null。属性不得用name/alive/kind/id改变核心字段。关系强度-100至100，双方不同；factId必须指向已有或本次事件。数字均整数，时间增量/资源绝对值不超过9007199254740991；事件描述最多2048字节。未知年代制度技术应说明不确定。";
    let details="可空字段也必须显式提供。attributes是字符串到字符串的对象，数量写\"1\"，不可写数字或嵌套对象。物品只含id/kind/name/alive/attributes，ownerId只能作为attributes中的字符串，不能加在entity顶层。资源delta是增减量，支出为负数；key和unit逐字复用当前资源，expectedAmount是操作前余额。新实体/事件/持续状态ID不得重复；先创建实体再移动或引用。示例仅说明结构，勿照抄ID或金额：{\"type\":\"create_entity\",\"entity\":{\"id\":\"example-food\",\"kind\":\"item\",\"name\":\"口粮\",\"alive\":null,\"attributes\":{\"ownerId\":\"player\",\"quantity\":\"1\"}}}。记账单位是游戏抽象，正文金额使用这一单位，不擅自等同历史货币。";
    let mut prompt=format!("{instruction}\n{limits}\n{details}\n开局背景：{} / {} / {}。\n开局叙事偏好：{}\n世界外叙事方针（不是角色行动）：{}\n当前正式状态：{state}\n",view.setup.country,view.setup.era_year,view.setup.location_name,view.setup.narrative_style,view.narrative_policy);
    if prompt
        .len()
        .saturating_add(request.action_text.len())
        .saturating_add(512)
        > 8192
    {
        return Err(ProviderError::ContextTooLarge);
    }
    let recent = view.turns.iter().rev().take(4).rev();
    for turn in recent {
        let text = turn.narrative.chars().take(200).collect::<String>();
        if prompt
            .len()
            .saturating_add(text.len())
            .saturating_add(request.action_text.len())
            .saturating_add(512)
            <= 8192
        {
            prompt.push_str("近期已提交剧情：");
            prompt.push_str(&text);
            prompt.push('\n');
        }
    }
    prompt.push_str(if request.action_kind == GameActionKind::Continue {
        "当前操作：让剧情自然继续。"
    } else {
        "当前玩家行动："
    });
    prompt.push_str(&request.action_text);
    if prompt.len() > 8192 {
        return Err(ProviderError::ContextTooLarge);
    }
    Ok(prompt)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_have_no_key_and_stale_save_cannot_change_live_profile() {
        let dir = tempfile::tempdir().unwrap();
        let store = ProviderStore::open(dir.path().join("providers.sqlite")).unwrap();
        assert!(!store.view().unwrap().configured);
        store.allocate_slot("game-key-generation-one").unwrap();
        let saved = store
            .save(
                "https://example.com/v1/chat/completions",
                "model-one",
                "game-key-generation-one",
                0,
            )
            .unwrap();
        assert_eq!(saved.config.unwrap().revision, 1);
        assert_eq!(
            store
                .save(
                    "https://other.example/v1/chat/completions",
                    "model-two",
                    "game-key-generation-two",
                    0
                )
                .err(),
            Some(ProviderError::Stale)
        );
        let value = serde_json::to_string(&store.view().unwrap()).unwrap();
        assert!(!value.contains("secret_slot"));
        assert!(!value.contains("game-key"));
        store.record_streaming(1, Capability::Supported).unwrap();
        store
            .save(
                "https://example.com/v1/chat/completions",
                "model-two",
                "game-key-generation-one",
                1,
            )
            .unwrap();
        store.record_streaming(1, Capability::Unsupported).unwrap();
        assert_eq!(
            store.view().unwrap().capabilities.streaming,
            Capability::Unknown
        );
        drop(store);
        assert_eq!(
            ProviderStore::open(dir.path().join("providers.sqlite"))
                .unwrap()
                .view()
                .unwrap()
                .config
                .unwrap()
                .model,
            "model-two"
        );
    }
    #[test]
    fn provider_validation_rejects_plaintext_credential_urls_and_slot_reuse() {
        for url in [
            "http://127.0.0.1/v1/chat/completions",
            "https://u:p@example.com/a",
            "https://example.com/a?key=x",
            "https://example.com/a#key",
        ] {
            assert_eq!(
                validate_config(url, "model").err(),
                Some(ProviderError::InvalidConfig)
            );
        }
        let dir = tempfile::tempdir().unwrap();
        let store = ProviderStore::open(dir.path().join("p.sqlite")).unwrap();
        store.allocate_slot("new-key-generation").unwrap();
        assert!(store.allocate_slot("new-key-generation").is_err());
    }
    #[test]
    fn deleted_profiles_keep_monotonic_revision_and_reject_old_observations() {
        let dir = tempfile::tempdir().unwrap();
        let store = ProviderStore::open(dir.path().join("p.sqlite")).unwrap();
        store
            .save(
                "https://example.com/v1/chat/completions",
                "first",
                "game-key-first",
                0,
            )
            .unwrap();
        let empty = store.clear(1).unwrap();
        assert!(!empty.configured);
        assert_eq!(empty.revision, 2);
        assert_eq!(
            store
                .save(
                    "https://example.com/v1/chat/completions",
                    "stale",
                    "game-key-old",
                    0
                )
                .err(),
            Some(ProviderError::Stale)
        );
        let next = store
            .save(
                "https://example.com/v1/chat/completions",
                "second",
                "game-key-second",
                2,
            )
            .unwrap();
        assert_eq!(next.revision, 3);
        assert_eq!(next.config.unwrap().revision, 3);
        store.record_streaming(1, Capability::Supported).unwrap();
        assert_eq!(
            store.view().unwrap().capabilities.streaming,
            Capability::Unknown
        );
        assert_eq!(store.clear(1).err(), Some(ProviderError::Stale));
        drop(store);
        let reopened = ProviderStore::open(dir.path().join("p.sqlite")).unwrap();
        assert_eq!(reopened.view().unwrap().revision, 3);
        assert_eq!(reopened.stored().unwrap().unwrap().config.model, "second");
    }
    #[test]
    fn http_profile_requires_explicit_save_and_preserves_opt_in_across_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("http-profile.sqlite");
        let store = ProviderStore::open(&path).unwrap();
        assert_eq!(
            store
                .save(
                    "http://192.0.2.1:8317/v1/chat/completions",
                    "test-model",
                    "test-http-slot",
                    0
                )
                .err(),
            Some(ProviderError::InvalidConfig)
        );
        assert!(!store.view().unwrap().configured);
        let saved = store
            .save_with_http_opt_in(
                "http://192.0.2.1:8317/v1/chat/completions",
                "test-model",
                "test-http-slot",
                0,
                true,
            )
            .unwrap();
        assert!(saved.config.unwrap().allow_insecure_http);
        drop(store);
        let store = ProviderStore::open(&path).unwrap();
        assert!(store.view().unwrap().config.unwrap().allow_insecure_http);
        assert_eq!(
            store
                .save(
                    "http://192.0.2.2:8317/v1/chat/completions",
                    "test-model",
                    "test-http-slot",
                    1
                )
                .err(),
            Some(ProviderError::InvalidConfig)
        );
        assert_eq!(
            store.view().unwrap().config.unwrap().endpoint,
            "http://192.0.2.1:8317/v1/chat/completions"
        );
        let secure = store
            .save(
                "https://example.com/v1/chat/completions",
                "test-model",
                "test-http-slot",
                1,
            )
            .unwrap();
        assert!(!secure.config.unwrap().allow_insecure_http);
    }
}
