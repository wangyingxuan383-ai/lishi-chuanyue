//! User-entered current prices, separate from credentials and immutable calls.
//! All currency arithmetic is integer micro-units; no service prices are inferred.
use crate::{game_call_log::CallAttempt, stream::TokenUsage};
use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
    fs::File,
    path::Path,
    sync::{Mutex, MutexGuard},
};

pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub const MAX_MODEL_PRICES: usize = 128;
pub const MAX_COST_ATTEMPTS: usize = 100;
const SCALE: u64 = 1_000_000;
const MAX_PRICE_MICROS: u64 = 1_000_000 * SCALE;
const APPLICATION_ID: i32 = 0x4c505243;
const SCHEMA_VERSION: i32 = 1;
const META_SCHEMA: &str = "CREATE TABLE price_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991)) STRICT";
const PRICE_SCHEMA: &str = "CREATE TABLE model_prices (model TEXT NOT NULL PRIMARY KEY, currency TEXT NOT NULL CHECK(currency IN ('CNY','USD')), input_micros INTEGER NOT NULL CHECK(input_micros BETWEEN 0 AND 1000000000000), output_micros INTEGER NOT NULL CHECK(output_micros BETWEEN 0 AND 1000000000000)) STRICT";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PriceError {
    Invalid,
    Stale,
    Store,
}
impl fmt::Display for PriceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Invalid => "game_price_invalid",
            Self::Stale => "game_price_stale",
            Self::Store => "game_price_store",
        })
    }
}
impl std::error::Error for PriceError {}
impl From<rusqlite::Error> for PriceError {
    fn from(_: rusqlite::Error) -> Self {
        Self::Store
    }
}
pub type PriceResult<T> = Result<T, PriceError>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelPrice {
    pub model: String,
    pub currency: String,
    pub input_per_million: String,
    pub output_per_million: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PriceUpdate {
    pub model: String,
    pub currency: String,
    pub input_per_million: String,
    pub output_per_million: String,
    pub expected_revision: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PriceSettings {
    pub revision: u64,
    pub entries: Vec<ModelPrice>,
}
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CostEstimate {
    pub currency: String,
    pub total_amount: String,
    pub rounded_to_zero: bool,
}
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CostAttempt {
    pub world_id: String,
    pub branch_id: String,
    pub operation_id: String,
    pub sequence: u8,
    pub model: String,
    pub estimate: Option<CostEstimate>,
}
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CostReply {
    pub price_revision: u64,
    pub attempts: Vec<CostAttempt>,
}

fn valid_model(model: &str) -> bool {
    (1..=256).contains(&model.len()) && !model.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// Decimal input is deliberately narrower than Rust/JSON numeric syntax.
pub fn parse_price(value: &str) -> PriceResult<u64> {
    if value.is_empty() || value.len() > 14 {
        return Err(PriceError::Invalid);
    }
    let (whole, fraction) = match value.split_once('.') {
        Some((whole, fraction)) if !fraction.is_empty() && fraction.len() <= 6 => (whole, fraction),
        Some(_) => return Err(PriceError::Invalid),
        None => (value, ""),
    };
    if whole.is_empty()
        || (whole.len() > 1 && whole.starts_with('0'))
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || !fraction.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(PriceError::Invalid);
    }
    let whole = whole.parse::<u64>().map_err(|_| PriceError::Invalid)?;
    let fraction = if fraction.is_empty() {
        0
    } else {
        fraction.parse::<u64>().map_err(|_| PriceError::Invalid)?
            * 10_u64.pow(6 - fraction.len() as u32)
    };
    whole
        .checked_mul(SCALE)
        .and_then(|v| v.checked_add(fraction))
        .filter(|v| *v <= MAX_PRICE_MICROS)
        .ok_or(PriceError::Invalid)
}
fn format_micros(value: u128) -> String {
    format!(
        "{}.{:06}",
        value / u128::from(SCALE),
        value % u128::from(SCALE)
    )
}
fn validated_price(price: &ModelPrice) -> PriceResult<(u64, u64)> {
    if !valid_model(&price.model) || !matches!(price.currency.as_str(), "CNY" | "USD") {
        return Err(PriceError::Invalid);
    }
    Ok((
        parse_price(&price.input_per_million)?,
        parse_price(&price.output_per_million)?,
    ))
}
fn validate_usage(usage: &TokenUsage) -> PriceResult<()> {
    if usage.prompt_tokens > MAX_SAFE_INTEGER
        || usage.completion_tokens > MAX_SAFE_INTEGER
        || usage.total_tokens > MAX_SAFE_INTEGER
        || usage.prompt_tokens.checked_add(usage.completion_tokens) != Some(usage.total_tokens)
    {
        Err(PriceError::Invalid)
    } else {
        Ok(())
    }
}

pub fn estimate_cost(price: &ModelPrice, usage: &TokenUsage) -> PriceResult<CostEstimate> {
    let (input, output) = validated_price(price)?;
    validate_usage(usage)?;
    // Validated operands fit far inside u128. Sum before rounding exactly once.
    let numerator = u128::from(usage.prompt_tokens) * u128::from(input)
        + u128::from(usage.completion_tokens) * u128::from(output);
    let micros = (numerator + u128::from(SCALE / 2)) / u128::from(SCALE);
    Ok(CostEstimate {
        currency: price.currency.clone(),
        total_amount: format_micros(micros),
        rounded_to_zero: numerator != 0 && micros == 0,
    })
}

/// The native boundary supplies only its most recent 100 ledger entries.
/// Failure state does not erase trustworthy reported token usage.
pub fn estimate_attempts(
    settings: &PriceSettings,
    attempts: &[CallAttempt],
) -> PriceResult<CostReply> {
    if settings.revision > MAX_SAFE_INTEGER
        || settings.entries.len() > MAX_MODEL_PRICES
        || (settings.revision == 0 && !settings.entries.is_empty())
        || attempts.len() > MAX_COST_ATTEMPTS
    {
        return Err(PriceError::Invalid);
    }
    let mut prices = BTreeMap::new();
    for price in &settings.entries {
        validated_price(price)?;
        if prices.insert(&price.model, price).is_some() {
            return Err(PriceError::Invalid);
        }
    }
    let mut reservations = BTreeSet::new();
    let attempts = attempts
        .iter()
        .map(|attempt| {
            if !valid_model(&attempt.model)
                || !(1..=2).contains(&attempt.sequence)
                || !reservations.insert((&attempt.operation_id, attempt.sequence))
            {
                return Err(PriceError::Invalid);
            }
            // Invalid usage is never accepted merely because its price is unknown.
            if let Some(usage) = &attempt.usage {
                validate_usage(usage)?;
            }
            let estimate = match (prices.get(&attempt.model), &attempt.usage) {
                (Some(price), Some(usage)) => Some(estimate_cost(price, usage)?),
                _ => None,
            };
            Ok(CostAttempt {
                world_id: attempt.world_id.clone(),
                branch_id: attempt.branch_id.clone(),
                operation_id: attempt.operation_id.clone(),
                sequence: attempt.sequence,
                model: attempt.model.clone(),
                estimate,
            })
        })
        .collect::<PriceResult<Vec<_>>>()?;
    Ok(CostReply {
        price_revision: settings.revision,
        attempts,
    })
}

fn identity(c: &Connection) -> PriceResult<()> {
    let application: i32 = c.pragma_query_value(None, "application_id", |r| r.get(0))?;
    let version: i32 = c.pragma_query_value(None, "user_version", |r| r.get(0))?;
    let objects: Vec<(String, String, String)> = c
        .prepare(
            "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 3",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<_, _>>()?;
    if application != APPLICATION_ID
        || version != SCHEMA_VERSION
        || objects
            != [
                ("table".into(), "model_prices".into(), PRICE_SCHEMA.into()),
                ("table".into(), "price_meta".into(), META_SCHEMA.into()),
            ]
    {
        return Err(PriceError::Store);
    }
    Ok(())
}
fn read_settings(c: &Connection) -> PriceResult<PriceSettings> {
    identity(c)?;
    let revisions = c
        .prepare("SELECT singleton,revision FROM price_meta LIMIT 2")?
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    let revision = match revisions.as_slice() {
        [(1, revision)] if (0..=MAX_SAFE_INTEGER as i64).contains(revision) => *revision as u64,
        _ => return Err(PriceError::Store),
    };
    let rows = c
        .prepare(
            "SELECT model,currency,input_micros,output_micros FROM model_prices ORDER BY model LIMIT 129",
        )?
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if rows.len() > MAX_MODEL_PRICES || (revision == 0 && !rows.is_empty()) {
        return Err(PriceError::Store);
    }
    let entries = rows
        .into_iter()
        .map(|(model, currency, input, output)| {
            if !(0..=MAX_PRICE_MICROS as i64).contains(&input)
                || !(0..=MAX_PRICE_MICROS as i64).contains(&output)
            {
                return Err(PriceError::Store);
            }
            let price = ModelPrice {
                model,
                currency,
                input_per_million: format_micros(input as u128),
                output_per_million: format_micros(output as u128),
            };
            validated_price(&price).map_err(|_| PriceError::Store)?;
            Ok(price)
        })
        .collect::<PriceResult<Vec<_>>>()?;
    Ok(PriceSettings { revision, entries })
}

pub struct PriceStore {
    connection: Mutex<Connection>,
    _owner_lock: File,
}
impl fmt::Debug for PriceStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PriceStore { user_entered_current_prices: true }")
    }
}
impl PriceStore {
    pub fn open(path: impl AsRef<Path>) -> PriceResult<Self> {
        let path = path.as_ref();
        let existed = path.exists();
        if existed {
            // Before any write/open pragma, refuse corrupt, foreign and future DBs.
            let read = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            let check: String = read.pragma_query_value(None, "quick_check", |r| r.get(0))?;
            if check != "ok" {
                return Err(PriceError::Store);
            }
            read_settings(&read)?;
        }
        let mut lock_path = path.as_os_str().to_os_string();
        lock_path.push(".model-price-owner-lock");
        let lock = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(Path::new(&lock_path))
            .map_err(|_| PriceError::Store)?;
        lock.try_lock().map_err(|_| PriceError::Store)?;
        if !existed {
            // Atomically own creation: never initialize somebody else's empty DB.
            File::options()
                .write(true)
                .create_new(true)
                .open(path)
                .map_err(|_| PriceError::Store)?;
        }
        let mut connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        if existed {
            read_settings(&connection)?;
        } else {
            // Refuse a file that appeared between the initial check and owner lock.
            let objects: i64 =
                connection.query_row("SELECT COUNT(*) FROM sqlite_master", [], |r| r.get(0))?;
            let version: i32 = connection.pragma_query_value(None, "user_version", |r| r.get(0))?;
            let application: i32 =
                connection.pragma_query_value(None, "application_id", |r| r.get(0))?;
            if objects != 0 || version != 0 || application != 0 {
                return Err(PriceError::Store);
            }
        }
        connection.busy_timeout(std::time::Duration::from_millis(200))?;
        connection.execute_batch(
            "PRAGMA trusted_schema=OFF;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;",
        )?;
        if !existed {
            let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch(&format!(
                "{META_SCHEMA};{PRICE_SCHEMA};INSERT INTO price_meta VALUES(1,0);"
            ))?;
            tx.pragma_update(None, "application_id", APPLICATION_ID)?;
            tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
            tx.commit()?;
        }
        let store = Self {
            connection: Mutex::new(connection),
            _owner_lock: lock,
        };
        store.settings()?;
        Ok(store)
    }
    fn connection(&self) -> PriceResult<MutexGuard<'_, Connection>> {
        self.connection.lock().map_err(|_| PriceError::Store)
    }
    pub fn settings(&self) -> PriceResult<PriceSettings> {
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Deferred)?;
        let settings = read_settings(&tx)?;
        tx.commit()?;
        Ok(settings)
    }
    pub fn set(&self, input: &PriceUpdate) -> PriceResult<PriceSettings> {
        let price = ModelPrice {
            model: input.model.clone(),
            currency: input.currency.clone(),
            input_per_million: input.input_per_million.clone(),
            output_per_million: input.output_per_million.clone(),
        };
        let (input_micros, output_micros) = validated_price(&price)?;
        if input.expected_revision > MAX_SAFE_INTEGER {
            return Err(PriceError::Invalid);
        }
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = read_settings(&tx)?;
        if current.revision != input.expected_revision {
            return Err(PriceError::Stale);
        }
        if current.revision == MAX_SAFE_INTEGER
            || (current.entries.len() == MAX_MODEL_PRICES
                && !current
                    .entries
                    .iter()
                    .any(|entry| entry.model == price.model))
        {
            return Err(PriceError::Invalid);
        }
        tx.execute("INSERT INTO model_prices(model,currency,input_micros,output_micros) VALUES(?1,?2,?3,?4) ON CONFLICT(model) DO UPDATE SET currency=excluded.currency,input_micros=excluded.input_micros,output_micros=excluded.output_micros",params![price.model,price.currency,input_micros as i64,output_micros as i64])?;
        tx.execute(
            "UPDATE price_meta SET revision=revision+1 WHERE singleton=1",
            [],
        )?;
        let result = read_settings(&tx)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn clear(&self, model: &str, expected_revision: u64) -> PriceResult<PriceSettings> {
        if !valid_model(model) || expected_revision > MAX_SAFE_INTEGER {
            return Err(PriceError::Invalid);
        }
        let mut connection = self.connection()?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = read_settings(&tx)?;
        if current.revision != expected_revision {
            return Err(PriceError::Stale);
        }
        if current.entries.iter().any(|entry| entry.model == model) {
            if current.revision == MAX_SAFE_INTEGER {
                return Err(PriceError::Invalid);
            }
            tx.execute("DELETE FROM model_prices WHERE model=?1", [model])?;
            tx.execute(
                "UPDATE price_meta SET revision=revision+1 WHERE singleton=1",
                [],
            )?;
        }
        let result = read_settings(&tx)?;
        tx.commit()?;
        Ok(result)
    }
}
