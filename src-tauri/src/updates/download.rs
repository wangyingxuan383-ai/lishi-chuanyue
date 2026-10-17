//! Verified download of a release package: resumes with HTTP Range, retries
//! transient failures with backoff, enforces the published size and checks
//! the SHA-256 before the file gets its final name.
//!
//! Files in the update folder: `<version>.apk` (verified), `<version>.apk.part`
//! (bytes so far) and `<version>.apk.part.json` (the size and hash the part
//! belongs to, so a changed release never resumes onto old bytes).
use crate::link_policy;
use reqwest::{header, Client, Response, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, SeekFrom},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tokio::{
    fs::{self, File, OpenOptions},
    io::{AsyncSeekExt, AsyncWriteExt},
};
use tokio_util::sync::CancellationToken;

/// What the update sheet shows while a download runs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Event {
    Progress {
        received: u64,
        total: u64,
    },
    /// A transient failure; the next attempt resumes after `wait_ms`.
    Retrying {
        attempt: u32,
        #[serde(rename = "waitMs")]
        wait_ms: u64,
    },
    Verifying,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    /// Not a release asset of this app, or redirected somewhere else.
    Url,
    /// A permanent HTTP answer such as 404.
    Http,
    /// Still failing after the retries; the part is kept for the next try.
    Network,
    /// The server's size disagrees with the release (the part is deleted).
    Size,
    /// Complete but not the published SHA-256 (the part is deleted).
    Hash,
    Storage,
    /// Cancelled by the player; the part is kept for the next try.
    Cancelled,
}

pub struct Asset<'a> {
    pub url: &'a str,
    pub size: u64,
    pub sha256: [u8; 32],
}

/// Timeouts and retry budget; tests use much shorter ones.
#[derive(Clone)]
pub struct Tuning {
    /// Connecting and receiving the response headers.
    pub headers: Duration,
    /// The longest silence between body chunks.
    pub idle: Duration,
    /// The first retry waits this long, doubling up to `max_backoff`.
    pub backoff: Duration,
    pub max_backoff: Duration,
    /// Attempts in a row that bring no new bytes before giving up.
    pub attempts: u32,
    /// Also allow http://127.0.0.1 / localhost test servers (debug builds and tests only).
    pub loopback: bool,
}

impl Tuning {
    pub fn app(loopback: bool) -> Self {
        Self {
            headers: Duration::from_secs(30),
            idle: Duration::from_secs(30),
            backoff: Duration::from_secs(1),
            max_backoff: Duration::from_secs(30),
            attempts: 6,
            loopback,
        }
    }
}

const MAX_REDIRECTS: usize = 5;
const PROGRESS_EVERY: Duration = Duration::from_millis(150);

/// A URL the update may fetch: this repository's release assets and GitHub's
/// download redirect hosts; with `loopback`, also a local test server.
pub fn allowed(raw: &str, redirect: bool, loopback: bool) -> bool {
    (loopback && is_loopback(raw)) || link_policy::download_allowed(raw, redirect)
}

/// `http://127.0.0.1:<port>/…` or `http://localhost:<port>/…`.
pub fn is_loopback(raw: &str) -> bool {
    if raw
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || c == '"' || c == '\\')
    {
        return false;
    }
    let Ok(url) = Url::parse(raw) else {
        return false;
    };
    url.scheme() == "http"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_some()
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 64 hex digits (either case) into the raw digest.
pub fn parse_sha256(text: &str) -> Option<[u8; 32]> {
    if text.len() != 64 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut digest = [0; 32];
    for (index, byte) in digest.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(digest)
}

fn with_suffix(file: &Path, suffix: &str) -> PathBuf {
    let mut name = file.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    file.with_file_name(name)
}

pub fn part_path(file: &Path) -> PathBuf {
    with_suffix(file, ".part")
}

fn meta_path(file: &Path) -> PathBuf {
    with_suffix(file, ".part.json")
}

#[derive(Serialize, Deserialize, PartialEq)]
struct PartMeta {
    sha256: String,
    size: u64,
}

/// The hash state and length of a file, or None when it is longer than `limit`.
async fn hash_file(path: PathBuf, limit: u64) -> std::io::Result<Option<(Sha256, u64)>> {
    tokio::task::spawn_blocking(move || {
        let mut file = std::fs::File::open(path)?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0; 256 * 1024];
        let mut length = 0u64;
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                return Ok(Some((hasher, length)));
            }
            length += count as u64;
            if length > limit {
                return Ok(None);
            }
            hasher.update(&buffer[..count]);
        }
    })
    .await
    .map_err(std::io::Error::other)?
}

#[derive(Debug, PartialEq, Eq)]
pub enum Check {
    Matches,
    Missing,
    /// Present but not the expected size or hash.
    Differs,
}

/// Is `file` exactly the published package?
pub async fn verify(file: &Path, size: u64, sha256: &[u8; 32]) -> Check {
    match hash_file(file.to_path_buf(), size).await {
        Ok(Some((hasher, length))) => {
            if length == size && hasher.finalize()[..] == sha256[..] {
                Check::Matches
            } else {
                Check::Differs
            }
        }
        Ok(None) => Check::Differs,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Check::Missing,
        Err(_) => Check::Differs,
    }
}

async fn discard(file: &Path) {
    let _ = fs::remove_file(part_path(file)).await;
    let _ = fs::remove_file(meta_path(file)).await;
}

/// Bytes received so far: the open part file and the running hash.
struct Partial {
    file: File,
    hasher: Sha256,
    received: u64,
}

impl Partial {
    /// Resumes a part from an earlier attempt or run when it belongs to the same release file.
    async fn open(file: &Path, asset: &Asset<'_>) -> Result<Self, Failure> {
        let part = part_path(file);
        let meta = meta_path(file);
        let expected = PartMeta {
            sha256: hex(&asset.sha256),
            size: asset.size,
        };
        let same = fs::read(&meta)
            .await
            .ok()
            .and_then(|bytes| serde_json::from_slice::<PartMeta>(&bytes).ok())
            .is_some_and(|found| found == expected);
        let resumed = if same {
            hash_file(part.clone(), asset.size).await.ok().flatten()
        } else {
            None
        };
        if !same {
            let record = serde_json::to_vec(&expected).map_err(|_| Failure::Storage)?;
            fs::write(&meta, record)
                .await
                .map_err(|_| Failure::Storage)?;
        }
        let (hasher, received) = resumed.unwrap_or_else(|| (Sha256::new(), 0));
        let mut handle = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(received == 0)
            .open(&part)
            .await
            .map_err(|_| Failure::Storage)?;
        handle
            .seek(SeekFrom::Start(received))
            .await
            .map_err(|_| Failure::Storage)?;
        Ok(Self {
            file: handle,
            hasher,
            received,
        })
    }

    async fn write(&mut self, bytes: &[u8]) -> Result<(), Failure> {
        self.file
            .write_all(bytes)
            .await
            .map_err(|_| Failure::Storage)?;
        self.hasher.update(bytes);
        self.received += bytes.len() as u64;
        Ok(())
    }

    /// The server sent the whole file (or resumed elsewhere): start over.
    async fn restart(&mut self) -> Result<(), Failure> {
        self.file.flush().await.map_err(|_| Failure::Storage)?;
        self.file.set_len(0).await.map_err(|_| Failure::Storage)?;
        self.file
            .seek(SeekFrom::Start(0))
            .await
            .map_err(|_| Failure::Storage)?;
        self.hasher = Sha256::new();
        self.received = 0;
        Ok(())
    }
}

enum Step {
    Retry,
    Fail(Failure),
}

impl From<Failure> for Step {
    fn from(failure: Failure) -> Self {
        Self::Fail(failure)
    }
}

/// Sends a GET and follows redirects by hand, checking every hop's host.
/// Each attempt starts again at the release URL, so GitHub signs a fresh
/// asset link (they expire after a few minutes).
async fn open(
    client: &Client,
    start: &str,
    range: u64,
    tuning: &Tuning,
    cancel: &CancellationToken,
) -> Result<Response, Step> {
    let mut url = Url::parse(start).map_err(|_| Failure::Url)?;
    for hop in 0..=MAX_REDIRECTS {
        let mut request = client
            .get(url.clone())
            .header(header::USER_AGENT, "lishi-chuanyue")
            .header(header::ACCEPT, "application/octet-stream");
        if range > 0 {
            request = request.header(header::RANGE, format!("bytes={range}-"));
        }
        let response = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Failure::Cancelled.into()),
            result = tokio::time::timeout(tuning.headers, request.send()) => match result {
                Ok(Ok(response)) => response,
                _ => return Err(Step::Retry),
            },
        };
        if !response.status().is_redirection() {
            return Ok(response);
        }
        let next = response
            .headers()
            .get(header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|location| url.join(location).ok())
            .filter(|next| hop < MAX_REDIRECTS && allowed(next.as_str(), true, tuning.loopback));
        match next {
            Some(next) => url = next,
            None => return Err(Failure::Url.into()),
        }
    }
    Err(Failure::Url.into())
}

/// `Content-Range: bytes <start>-<end>/<total or *>`.
fn content_range(response: &Response) -> Option<(u64, Option<u64>)> {
    let value = response
        .headers()
        .get(header::CONTENT_RANGE)?
        .to_str()
        .ok()?;
    let (range, total) = value.strip_prefix("bytes ")?.split_once('/')?;
    let (start, _) = range.split_once('-')?;
    let total = match total.trim() {
        "*" => None,
        total => Some(total.parse().ok()?),
    };
    Some((start.trim().parse().ok()?, total))
}

struct Reporter<'a> {
    sink: &'a (dyn Fn(Event) + Sync),
    last: Option<Instant>,
}

impl Reporter<'_> {
    fn progress(&mut self, received: u64, total: u64, force: bool) {
        if force
            || self
                .last
                .is_none_or(|last| last.elapsed() >= PROGRESS_EVERY)
        {
            self.last = Some(Instant::now());
            (self.sink)(Event::Progress { received, total });
        }
    }
}

async fn attempt(
    asset: &Asset<'_>,
    client: &Client,
    tuning: &Tuning,
    cancel: &CancellationToken,
    partial: &mut Partial,
    reporter: &mut Reporter<'_>,
) -> Result<(), Step> {
    let mut response = open(client, asset.url, partial.received, tuning, cancel).await?;
    match response.status().as_u16() {
        200 => {
            if partial.received > 0 {
                partial.restart().await?;
                reporter.progress(0, asset.size, true);
            }
            if response
                .content_length()
                .is_some_and(|length| length != asset.size)
            {
                return Err(Failure::Size.into());
            }
        }
        206 => match content_range(&response) {
            Some((start, total)) if total.is_none_or(|total| total == asset.size) => {
                if start != partial.received {
                    partial.restart().await?;
                    return Err(Step::Retry);
                }
            }
            Some(_) => return Err(Failure::Size.into()),
            None => {
                partial.restart().await?;
                return Err(Step::Retry);
            }
        },
        // Nothing to send from this offset: the part does not fit the file. Start over.
        416 => {
            partial.restart().await?;
            return Err(Step::Retry);
        }
        // 403 included: an expired asset signature is fixed by asking GitHub again.
        403 | 408 | 429 | 500..=599 => return Err(Step::Retry),
        _ => return Err(Failure::Http.into()),
    }
    loop {
        let chunk = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Failure::Cancelled.into()),
            result = tokio::time::timeout(tuning.idle, response.chunk()) => match result {
                Ok(Ok(chunk)) => chunk,
                _ => return Err(Step::Retry),
            },
        };
        let Some(chunk) = chunk else {
            break;
        };
        if partial.received + chunk.len() as u64 > asset.size {
            return Err(Failure::Size.into());
        }
        partial.write(&chunk).await?;
        reporter.progress(partial.received, asset.size, partial.received == asset.size);
    }
    // A connection that ends early is a drop; the next attempt resumes from here.
    if partial.received < asset.size {
        Err(Step::Retry)
    } else {
        Ok(())
    }
}

fn backoff(tuning: &Tuning, failures: u32) -> Duration {
    let factor = 2u32.saturating_pow(failures.saturating_sub(1).min(16));
    tuning
        .backoff
        .saturating_mul(factor)
        .min(tuning.max_backoff)
}

/// Downloads `asset` to `file`, resuming an earlier part. On success `file`
/// holds exactly the published bytes; nothing else ever gets that name.
pub async fn fetch(
    asset: &Asset<'_>,
    file: &Path,
    client: &(dyn Fn() -> Option<Client> + Sync),
    tuning: &Tuning,
    cancel: &CancellationToken,
    sink: &(dyn Fn(Event) + Sync),
) -> Result<(), Failure> {
    if !allowed(asset.url, false, tuning.loopback) {
        return Err(Failure::Url);
    }
    // A package left by an earlier run is checked again, never trusted by name.
    match verify(file, asset.size, &asset.sha256).await {
        Check::Matches => {
            sink(Event::Verifying);
            return Ok(());
        }
        Check::Differs => {
            let _ = fs::remove_file(file).await;
        }
        Check::Missing => {}
    }
    let mut partial = Partial::open(file, asset).await?;
    let mut reporter = Reporter { sink, last: None };
    reporter.progress(partial.received, asset.size, true);
    let mut failures = 0;
    let outcome = loop {
        if partial.received >= asset.size {
            break Ok(());
        }
        let before = partial.received;
        let result = match client() {
            Some(client) => {
                attempt(asset, &client, tuning, cancel, &mut partial, &mut reporter).await
            }
            // Not ready yet (Android TLS) or no usable proxy: try again shortly.
            None => Err(Step::Retry),
        };
        match result {
            Ok(()) => continue,
            Err(Step::Fail(failure)) => break Err(failure),
            Err(Step::Retry) => {
                if partial.received > before {
                    failures = 0;
                }
                failures += 1;
                if failures >= tuning.attempts {
                    break Err(Failure::Network);
                }
                let wait = backoff(tuning, failures);
                sink(Event::Retrying {
                    attempt: failures,
                    wait_ms: u64::try_from(wait.as_millis()).unwrap_or(u64::MAX),
                });
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => break Err(Failure::Cancelled),
                    _ = tokio::time::sleep(wait) => {}
                }
            }
        }
    };
    // Whatever happens next, the bytes received so far must be on disk.
    let flushed = partial.file.flush().await;
    match outcome {
        Err(failure @ (Failure::Size | Failure::Hash)) => {
            drop(partial);
            discard(file).await;
            return Err(failure);
        }
        Err(failure) => return Err(failure),
        Ok(()) => {}
    }
    sink(Event::Verifying);
    flushed.map_err(|_| Failure::Storage)?;
    partial
        .file
        .sync_all()
        .await
        .map_err(|_| Failure::Storage)?;
    let Partial {
        file: handle,
        hasher,
        received,
    } = partial;
    drop(handle);
    if received != asset.size || hasher.finalize()[..] != asset.sha256[..] {
        discard(file).await;
        return Err(Failure::Hash);
    }
    fs::rename(part_path(file), file)
        .await
        .map_err(|_| Failure::Storage)?;
    let _ = fs::remove_file(meta_path(file)).await;
    Ok(())
}

/// A small text asset (SHA256SUMS.txt) from the same hosts, at most `limit` bytes.
pub async fn fetch_small(
    url: &str,
    client: &Client,
    tuning: &Tuning,
    limit: usize,
) -> Result<Vec<u8>, Failure> {
    if !allowed(url, false, tuning.loopback) {
        return Err(Failure::Url);
    }
    let cancel = CancellationToken::new();
    let mut response = match open(client, url, 0, tuning, &cancel).await {
        Ok(response) => response,
        Err(Step::Fail(failure)) => return Err(failure),
        Err(Step::Retry) => return Err(Failure::Network),
    };
    match response.status().as_u16() {
        200 => {}
        403 | 408 | 429 | 500..=599 => return Err(Failure::Network),
        _ => return Err(Failure::Http),
    }
    let mut body = Vec::new();
    loop {
        match tokio::time::timeout(tuning.idle, response.chunk()).await {
            Ok(Ok(Some(chunk))) => {
                if body.len() + chunk.len() > limit {
                    return Err(Failure::Size);
                }
                body.extend_from_slice(&chunk);
            }
            Ok(Ok(None)) => return Ok(body),
            _ => return Err(Failure::Network),
        }
    }
}
