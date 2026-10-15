//! Optional, single-request historical research. Search snippets are untrusted
//! data, never tools, a world-state patch, or verified full-page reading.
//! Brave contract checked 2026-10-15:
//! https://api-dashboard.search.brave.com/api-reference/web/search/get
//! https://api-dashboard.search.brave.com/documentation/guides/authentication

use crate::{secrets::SecretValue, CancellationToken};
use reqwest::{header, Client, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fmt,
    future::Future,
    pin::Pin,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub const MAX_RESEARCH_RESULTS: usize = 5;
pub const MAX_RESEARCH_QUERY_BYTES: usize = 1800;
pub const MAX_RESEARCH_EXCERPT_BYTES: usize = 4096;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
pub const BRAVE_WEB_ENDPOINT: &str = "https://api.search.brave.com/res/v1/web/search";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResearchError {
    InvalidInput,
    InvalidScope,
    Unavailable,
    Busy,
    IncompatibleDatabase,
    Database,
    DuplicateOperation,
    InvalidTransition,
    Missing,
    TooLarge,
    MissingCredential,
    Transport,
    Timeout,
    HttpStatus,
    InvalidResponse,
    CredentialEcho,
    Cancelled,
    Clock,
    Conflict,
    InvisibleSource,
}
impl fmt::Display for ResearchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidInput => "research_invalid_input",
            Self::InvalidScope => "research_invalid_scope",
            Self::Unavailable => "research_unavailable",
            Self::Busy => "research_busy",
            Self::IncompatibleDatabase => "research_incompatible_database",
            Self::Database => "research_database",
            Self::DuplicateOperation => "research_duplicate_operation",
            Self::InvalidTransition => "research_invalid_transition",
            Self::Missing => "research_missing",
            Self::TooLarge => "research_too_large",
            Self::MissingCredential => "research_missing_credential",
            Self::Transport => "research_transport",
            Self::Timeout => "research_timeout",
            Self::HttpStatus => "research_http_status",
            Self::InvalidResponse => "research_invalid_response",
            Self::CredentialEcho => "research_credential_echo",
            Self::Cancelled => "research_cancelled",
            Self::Clock => "research_clock",
            Self::Conflict => "research_conflict",
            Self::InvisibleSource => "research_invisible_source",
        })
    }
}
impl std::error::Error for ResearchError {}
pub type ResearchResult<T> = Result<T, ResearchError>;

pub(crate) fn id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}
pub(crate) fn text(value: &str, max: usize, empty: bool) -> bool {
    value.len() <= max
        && (empty || !value.trim().is_empty())
        && !value
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
}
pub(crate) fn hash(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}
pub(crate) fn now_ms() -> ResearchResult<i64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ResearchError::Clock)?
        .as_millis()
        .try_into()
        .map_err(|_| ResearchError::Clock)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResearchEra {
    pub start_year: i32,
    pub end_year: i32,
}
impl ResearchEra {
    pub fn validate(self) -> ResearchResult<()> {
        if self.start_year == 0
            || self.end_year == 0
            || self.start_year < -999_999
            || self.end_year > 999_999
            || self.start_year > self.end_year
        {
            Err(ResearchError::InvalidInput)
        } else {
            Ok(())
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResearchTopic {
    General,
    Person,
    Office,
    Place,
    Technology,
    Chronology,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResearchQuery {
    pub query: String,
    pub topic: ResearchTopic,
    pub era: Option<ResearchEra>,
    /// Search concepts, not a grant to disclose global character identities.
    pub entity_tags: Vec<String>,
    pub region: Option<String>,
}
impl ResearchQuery {
    pub fn validate(&self) -> ResearchResult<()> {
        if !text(&self.query, MAX_RESEARCH_QUERY_BYTES, false)
            || self.query.chars().count() > 600
            || self.query.split_whitespace().count() > 75
            || self.entity_tags.len() > 16
            || self.entity_tags.iter().any(|tag| !text(tag, 128, false))
            || self.region.as_ref().is_some_and(|v| !text(v, 128, false))
        {
            return Err(ResearchError::InvalidInput);
        }
        if let Some(era) = self.era {
            era.validate()?;
        }
        Ok(())
    }
    pub fn cache_key(&self, namespace: &str) -> ResearchResult<String> {
        self.validate()?;
        if !text(namespace, 256, false) {
            return Err(ResearchError::InvalidInput);
        }
        let mut normalized = self.clone();
        normalized.query = self.query.split_whitespace().collect::<Vec<_>>().join(" ");
        normalized.entity_tags.sort();
        normalized.entity_tags.dedup();
        Ok(hash(
            &serde_json::to_vec(&(1u8, namespace, normalized))
                .map_err(|_| ResearchError::InvalidInput)?,
        ))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResearchCandidate {
    pub query: ResearchQuery,
    pub important: bool,
    pub missing_evidence: bool,
}
/// Caller-produced candidates come from explicit requests or important entity/
/// date questions. Ordinary narrative has no default search or model planner.
pub fn choose_research_candidate(
    explicit: Option<&ResearchQuery>,
    candidates: &[ResearchCandidate],
) -> ResearchResult<Option<ResearchQuery>> {
    if candidates.len() > 32 {
        return Err(ResearchError::TooLarge);
    }
    if let Some(query) = explicit {
        query.validate()?;
        return Ok(Some(query.clone()));
    }
    for candidate in candidates {
        candidate.query.validate()?;
        if candidate.important && candidate.missing_evidence {
            return Ok(Some(candidate.query.clone()));
        }
    }
    Ok(None)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BraveResearchConfig {
    pub endpoint: String,
    pub search_language: Option<String>,
}
impl Default for BraveResearchConfig {
    fn default() -> Self {
        Self {
            endpoint: BRAVE_WEB_ENDPOINT.into(),
            search_language: None,
        }
    }
}
impl BraveResearchConfig {
    pub fn validate(&self) -> ResearchResult<()> {
        validate_endpoint(&self.endpoint, false)?;
        if self.search_language.as_ref().is_some_and(|v| {
            v.len() < 2 || v.len() > 16 || !v.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
        }) {
            return Err(ResearchError::InvalidInput);
        }
        Ok(())
    }
}
fn validate_endpoint(value: &str, fixture: bool) -> ResearchResult<()> {
    if !text(value, 2048, false)
        || value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(ResearchError::InvalidInput);
    }
    let url = Url::parse(value).map_err(|_| ResearchError::InvalidInput)?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "::1"));
    if url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https"
            || (fixture && url.scheme() == "http" && loopback && url.port().is_some()))
    {
        return Err(ResearchError::InvalidInput);
    }
    Ok(())
}
pub fn validate_source_url(value: &str) -> ResearchResult<()> {
    if !text(value, 2048, false)
        || value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(ResearchError::InvalidInput);
    }
    let url = Url::parse(value).map_err(|_| ResearchError::InvalidInput)?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(ResearchError::InvalidInput);
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExcerptOrigin {
    SearchSnippet,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResearchSource {
    pub id: String,
    pub title: String,
    pub url: String,
    pub excerpt: String,
    pub excerpt_origin: ExcerptOrigin,
    pub accessed_at_ms: i64,
    /// Query scope only: Brave page freshness is not the era of historical facts.
    pub requested_era: Option<ResearchEra>,
    pub entity_tags: Vec<String>,
}
impl ResearchSource {
    pub fn validate(&self) -> ResearchResult<()> {
        validate_source_url(&self.url)?;
        if !id(&self.id)
            || !text(&self.title, 1024, false)
            || !text(&self.excerpt, MAX_RESEARCH_EXCERPT_BYTES, true)
            || self.accessed_at_ms < 0
            || self.entity_tags.len() > 16
            || self.entity_tags.iter().any(|v| !text(v, 128, false))
        {
            return Err(ResearchError::InvalidInput);
        }
        if let Some(era) = self.requested_era {
            era.validate()?;
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConclusionStatus {
    Evidence,
    Inference,
    Disputed,
    Unknown,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TemporalConstraint {
    pub label: String,
    pub era: ResearchEra,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResearchConclusion {
    pub id: String,
    pub statement: String,
    pub status: ConclusionStatus,
    pub source_ids: Vec<String>,
    pub conflicts_with: Vec<String>,
    pub temporal_constraints: Vec<TemporalConstraint>,
}
impl ResearchConclusion {
    pub fn validate(&self) -> ResearchResult<()> {
        if !id(&self.id)
            || !text(&self.statement, 4096, false)
            || self.source_ids.len() > 5
            || self.source_ids.iter().any(|v| !id(v))
            || self.conflicts_with.len() > 16
            || self.conflicts_with.iter().any(|v| !id(v) || v == &self.id)
            || self.temporal_constraints.len() > 16
            || self.status != ConclusionStatus::Unknown && self.source_ids.is_empty()
        {
            return Err(ResearchError::InvalidInput);
        }
        if self.source_ids.iter().collect::<BTreeSet<_>>().len() != self.source_ids.len()
            || self.conflicts_with.iter().collect::<BTreeSet<_>>().len()
                != self.conflicts_with.len()
        {
            return Err(ResearchError::InvalidInput);
        }
        for constraint in &self.temporal_constraints {
            if !text(&constraint.label, 256, false) {
                return Err(ResearchError::InvalidInput);
            }
            constraint.era.validate()?;
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TemporalWarning {
    pub conclusion_id: String,
    pub source_ids: Vec<String>,
    pub label: String,
    pub status: ConclusionStatus,
}
pub fn temporal_warnings(
    conclusions: &[ResearchConclusion],
    year: i32,
) -> ResearchResult<Vec<TemporalWarning>> {
    ResearchEra {
        start_year: year,
        end_year: year,
    }
    .validate()?;
    if conclusions.len() > 128 {
        return Err(ResearchError::TooLarge);
    }
    let mut warnings = Vec::new();
    for conclusion in conclusions {
        conclusion.validate()?;
        for constraint in &conclusion.temporal_constraints {
            if year < constraint.era.start_year || year > constraint.era.end_year {
                warnings.push(TemporalWarning {
                    conclusion_id: conclusion.id.clone(),
                    source_ids: conclusion.source_ids.clone(),
                    label: constraint.label.clone(),
                    status: conclusion.status,
                });
            }
        }
    }
    Ok(warnings)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResearchOperationStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Interrupted,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResearchDiagnostics {
    pub http_attempts: u8,
    pub http_status: Option<u16>,
    pub elapsed_ms: u64,
    pub error: Option<ResearchError>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResearchSearchOutcome {
    pub status: ResearchOperationStatus,
    pub sources: Vec<ResearchSource>,
    pub diagnostics: ResearchDiagnostics,
}
impl ResearchSearchOutcome {
    pub fn validate(&self) -> ResearchResult<()> {
        if self.diagnostics.http_attempts > 1
            || self
                .diagnostics
                .http_status
                .is_some_and(|status| !(100..=599).contains(&status))
            || self.sources.len() > MAX_RESEARCH_RESULTS
        {
            return Err(ResearchError::InvalidInput);
        }
        match self.status {
            ResearchOperationStatus::Succeeded if self.diagnostics.error.is_none() => {}
            ResearchOperationStatus::Failed | ResearchOperationStatus::Cancelled
                if self.sources.is_empty() && self.diagnostics.error.is_some() => {}
            _ => return Err(ResearchError::InvalidInput),
        }
        let mut ids = BTreeSet::new();
        let mut urls = BTreeSet::new();
        for source in &self.sources {
            source.validate()?;
            if !ids.insert(&source.id) || !urls.insert(&source.url) {
                return Err(ResearchError::InvalidInput);
            }
        }
        Ok(())
    }
}
pub trait ResearchProvider: Send + Sync {
    /// Hash/profile protocol identifier. No Key or raw authentication metadata.
    fn cache_namespace(&self) -> String;
    fn search<'a>(
        &'a self,
        query: &'a ResearchQuery,
        credential: Option<SecretValue>,
        cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = ResearchSearchOutcome> + Send + 'a>>;
}
#[derive(Debug, Clone, Copy)]
pub struct ResearchTransportOptions {
    pub connect_timeout: Duration,
    pub read_timeout: Duration,
    pub total_timeout: Duration,
}
impl Default for ResearchTransportOptions {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_secs(10),
            read_timeout: Duration::from_secs(10),
            total_timeout: Duration::from_secs(30),
        }
    }
}
impl ResearchTransportOptions {
    fn validate(self) -> ResearchResult<()> {
        if self.connect_timeout.is_zero()
            || self.read_timeout.is_zero()
            || self.total_timeout.is_zero()
            || self.connect_timeout > Duration::from_secs(30)
            || self.read_timeout > Duration::from_secs(30)
            || self.total_timeout > Duration::from_secs(90)
        {
            Err(ResearchError::InvalidInput)
        } else {
            Ok(())
        }
    }
}
pub struct BraveResearchProvider {
    config: BraveResearchConfig,
    client: Client,
    options: ResearchTransportOptions,
}
impl fmt::Debug for BraveResearchProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("BraveResearchProvider { bounded_single_request: true }")
    }
}
impl BraveResearchProvider {
    pub fn new(config: BraveResearchConfig) -> ResearchResult<Self> {
        config.validate()?;
        Self::build(config, ResearchTransportOptions::default())
    }
    /// Isolated tests only. Literal loopback and explicit port; production
    /// config remains HTTPS and never receives URLs extracted from documents.
    pub fn fixture(endpoint: &str, options: ResearchTransportOptions) -> ResearchResult<Self> {
        validate_endpoint(endpoint, true)?;
        if Url::parse(endpoint)
            .map_err(|_| ResearchError::InvalidInput)?
            .scheme()
            != "http"
        {
            return Err(ResearchError::InvalidInput);
        }
        Self::build(
            BraveResearchConfig {
                endpoint: endpoint.into(),
                search_language: None,
            },
            options,
        )
    }
    fn build(
        config: BraveResearchConfig,
        options: ResearchTransportOptions,
    ) -> ResearchResult<Self> {
        options.validate()?;
        let client = Client::builder()
            .connect_timeout(options.connect_timeout)
            .read_timeout(options.read_timeout)
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .no_proxy()
            .build()
            .map_err(|_| ResearchError::Unavailable)?;
        Ok(Self {
            config,
            client,
            options,
        })
    }
    async fn search_once(
        &self,
        query: &ResearchQuery,
        credential: Option<SecretValue>,
        cancel: CancellationToken,
    ) -> ResearchSearchOutcome {
        let started = Instant::now();
        let mut diagnostics = ResearchDiagnostics {
            http_attempts: 0,
            http_status: None,
            elapsed_ms: 0,
            error: None,
        };
        let result = async {
            query.validate()?;
            if cancel.is_cancelled() {
                return Err(ResearchError::Cancelled);
            }
            let credential = credential.ok_or(ResearchError::MissingCredential)?;
            if query.query.contains(credential.expose_secret()) {
                return Err(ResearchError::CredentialEcho);
            }
            let mut token = header::HeaderValue::from_str(credential.expose_secret())
                .map_err(|_| ResearchError::MissingCredential)?;
            token.set_sensitive(true);
            let mut endpoint =
                Url::parse(&self.config.endpoint).map_err(|_| ResearchError::InvalidInput)?;
            endpoint.query_pairs_mut().extend_pairs([
                ("q", query.query.trim()),
                ("count", "5"),
                ("offset", "0"),
                ("result_filter", "web"),
                ("text_decorations", "false"),
                ("spellcheck", "false"),
                ("operators", "false"),
            ]);
            if let Some(language) = &self.config.search_language {
                endpoint
                    .query_pairs_mut()
                    .append_pair("search_lang", language);
            }
            let request = self
                .client
                .get(endpoint)
                .header(header::ACCEPT, "application/json")
                .header("X-Subscription-Token", token);
            diagnostics.http_attempts = 1;
            let mut response = request.send().await.map_err(|error| {
                if error.is_timeout() {
                    ResearchError::Timeout
                } else {
                    ResearchError::Transport
                }
            })?;
            diagnostics.http_status = Some(response.status().as_u16());
            if !response.status().is_success() {
                return Err(ResearchError::HttpStatus);
            }
            if response
                .content_length()
                .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
            {
                return Err(ResearchError::TooLarge);
            }
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|error| {
                if error.is_timeout() {
                    ResearchError::Timeout
                } else {
                    ResearchError::Transport
                }
            })? {
                if body
                    .len()
                    .checked_add(chunk.len())
                    .is_none_or(|size| size > MAX_RESPONSE_BYTES)
                {
                    return Err(ResearchError::TooLarge);
                }
                body.extend_from_slice(&chunk);
            }
            if body
                .windows(credential.expose_secret().len())
                .any(|window| window == credential.expose_secret().as_bytes())
            {
                return Err(ResearchError::CredentialEcho);
            }
            normalize_response(&body, query, now_ms()?)
        };
        let result = tokio::select! {biased;_ = cancel.cancelled()=>Err(ResearchError::Cancelled),result=tokio::time::timeout(self.options.total_timeout,result)=>result.unwrap_or(Err(ResearchError::Timeout))};
        diagnostics.elapsed_ms = started.elapsed().as_millis().try_into().unwrap_or(u64::MAX);
        match result {
            Ok(sources) => ResearchSearchOutcome {
                status: ResearchOperationStatus::Succeeded,
                sources,
                diagnostics,
            },
            Err(error) => {
                diagnostics.error = Some(error);
                ResearchSearchOutcome {
                    status: if error == ResearchError::Cancelled {
                        ResearchOperationStatus::Cancelled
                    } else {
                        ResearchOperationStatus::Failed
                    },
                    sources: Vec::new(),
                    diagnostics,
                }
            }
        }
    }
}
impl ResearchProvider for BraveResearchProvider {
    fn cache_namespace(&self) -> String {
        hash(&serde_json::to_vec(&("brave_web_v1", &self.config)).expect("serializable config"))
    }
    fn search<'a>(
        &'a self,
        query: &'a ResearchQuery,
        credential: Option<SecretValue>,
        cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = ResearchSearchOutcome> + Send + 'a>> {
        Box::pin(self.search_once(query, credential, cancel))
    }
}
fn normalize_response(
    body: &[u8],
    query: &ResearchQuery,
    accessed_at_ms: i64,
) -> ResearchResult<Vec<ResearchSource>> {
    let json: serde_json::Value =
        serde_json::from_slice(body).map_err(|_| ResearchError::InvalidResponse)?;
    if json["type"].as_str() != Some("search") {
        return Err(ResearchError::InvalidResponse);
    }
    let Some(web) = json.get("web").filter(|web| !web.is_null()) else {
        return Ok(Vec::new());
    };
    let rows = web["results"]
        .as_array()
        .ok_or(ResearchError::InvalidResponse)?;
    let mut result = Vec::new();
    let mut urls = BTreeSet::new();
    for row in rows.iter().take(20) {
        let title = row["title"]
            .as_str()
            .ok_or(ResearchError::InvalidResponse)?
            .to_owned();
        let raw_url = row["url"].as_str().ok_or(ResearchError::InvalidResponse)?;
        validate_source_url(raw_url).map_err(|_| ResearchError::InvalidResponse)?;
        let mut parsed = Url::parse(raw_url).map_err(|_| ResearchError::InvalidResponse)?;
        parsed.set_fragment(None);
        let url = parsed.to_string();
        if !urls.insert(url.clone()) {
            continue;
        }
        let excerpt = match row.get("description") {
            None | Some(serde_json::Value::Null) => String::new(),
            Some(value) => value
                .as_str()
                .ok_or(ResearchError::InvalidResponse)?
                .to_owned(),
        };
        let source = ResearchSource {
            id: format!(
                "source-{}",
                hash(
                    &serde_json::to_vec(&(&title, &url, &excerpt, accessed_at_ms))
                        .map_err(|_| ResearchError::InvalidResponse)?
                )
            ),
            title,
            url,
            excerpt,
            excerpt_origin: ExcerptOrigin::SearchSnippet,
            accessed_at_ms,
            requested_era: query.era,
            entity_tags: query.entity_tags.clone(),
        };
        source
            .validate()
            .map_err(|_| ResearchError::InvalidResponse)?;
        result.push(source);
        if result.len() == MAX_RESEARCH_RESULTS {
            break;
        }
    }
    Ok(result)
}
