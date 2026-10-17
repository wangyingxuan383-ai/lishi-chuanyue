//! Update download against a local test server: resume after a drop, hash and
//! size rejection, cancellation, retries, redirects and the host policy.
use super::download::{self, Asset, Check, Event, Failure, Tuning};
use super::*;
use reqwest::Client;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::mpsc,
};

const DOWNLOAD: &str = "/wangyingxuan383-ai/lishi-chuanyue/releases/download/v9.9.9/pkg.apk";

#[derive(Clone, Debug)]
struct Seen {
    path: String,
    range: Option<u64>,
}

/// What the server sends for one request.
struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    /// Announced Content-Length when it should differ from the body.
    length: Option<u64>,
    /// No Content-Length at all: the body ends when the connection closes.
    unannounced: bool,
    /// Close the connection after this many body bytes (a dropped download).
    cut: Option<usize>,
    /// Pause before each 4 KiB piece.
    pace: Duration,
}

impl Reply {
    fn new(status: u16, body: &[u8]) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: body.to_vec(),
            length: None,
            unannounced: false,
            cut: None,
            pace: Duration::ZERO,
        }
    }

    fn redirect(location: &str) -> Self {
        let mut reply = Self::new(302, b"");
        reply.headers.push(("Location".into(), location.into()));
        reply
    }

    /// 206 from the requested offset, like GitHub's asset host; 200 without a Range.
    fn ranged(body: &[u8], seen: &Seen) -> Self {
        match seen.range {
            Some(start) => {
                let start = start as usize;
                let mut reply = Self::new(206, &body[start..]);
                reply.headers.push((
                    "Content-Range".into(),
                    format!("bytes {start}-{}/{}", body.len() - 1, body.len()),
                ));
                reply
            }
            None => Self::new(200, body),
        }
    }

    fn cut(mut self, after: usize) -> Self {
        self.cut = Some(after);
        self
    }
}

type Handler = Arc<dyn Fn(usize, &Seen) -> Reply + Send + Sync>;

async fn serve(handler: Handler) -> (String, Arc<Mutex<Vec<Seen>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let handler = Arc::clone(&handler);
            let log = Arc::clone(&log);
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut buffer = [0; 4096];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match socket.read(&mut buffer).await {
                        Ok(0) | Err(_) => return,
                        Ok(count) => request.extend_from_slice(&buffer[..count]),
                    }
                }
                let text = String::from_utf8_lossy(&request).into_owned();
                let path = text.split_whitespace().nth(1).unwrap_or("/").to_owned();
                let range = text.lines().find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("range: bytes=")
                        .and_then(|value| value.trim().trim_end_matches('-').parse().ok())
                });
                let seen = Seen { path, range };
                let index = {
                    let mut log = log.lock().unwrap();
                    log.push(seen.clone());
                    log.len() - 1
                };
                let reply = handler(index, &seen);
                let mut head = format!("HTTP/1.1 {} Test\r\nConnection: close\r\n", reply.status);
                if !reply.unannounced {
                    let length = reply.length.unwrap_or(reply.body.len() as u64);
                    head.push_str(&format!("Content-Length: {length}\r\n"));
                }
                for (name, value) in &reply.headers {
                    head.push_str(&format!("{name}: {value}\r\n"));
                }
                head.push_str("\r\n");
                if socket.write_all(head.as_bytes()).await.is_err() {
                    return;
                }
                let end = reply.cut.unwrap_or(reply.body.len()).min(reply.body.len());
                for piece in reply.body[..end].chunks(4096) {
                    if !reply.pace.is_zero() {
                        tokio::time::sleep(reply.pace).await;
                    }
                    if socket.write_all(piece).await.is_err() {
                        return;
                    }
                }
                let _ = socket.flush().await;
                // Dropping the socket closes the connection, early when `cut` is set.
            });
        }
    });
    (base, seen)
}

fn package() -> Vec<u8> {
    (0..200_000u32).map(|i| (i * 7 % 251) as u8).collect()
}

fn digest(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn quick() -> Tuning {
    Tuning {
        headers: Duration::from_secs(3),
        idle: Duration::from_secs(2),
        backoff: Duration::from_millis(10),
        max_backoff: Duration::from_millis(40),
        attempts: 4,
        loopback: true,
    }
}

fn client() -> Option<Client> {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()
}

struct Run {
    result: std::result::Result<(), Failure>,
    events: Vec<Event>,
}

async fn fetch_with(
    url: &str,
    body: &[u8],
    file: &Path,
    tuning: &Tuning,
    cancel: &CancellationToken,
) -> Run {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let sink = move |event: Event| {
        let _ = tx.send(event);
    };
    let asset = Asset {
        url,
        size: body.len() as u64,
        sha256: digest(body),
    };
    let result = download::fetch(&asset, file, &client, tuning, cancel, &sink).await;
    drop(sink);
    let mut events = Vec::new();
    while let Some(event) = rx.recv().await {
        events.push(event);
    }
    Run { result, events }
}

async fn fetch(url: &str, body: &[u8], file: &Path) -> Run {
    fetch_with(url, body, file, &quick(), &CancellationToken::new()).await
}

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn last_progress(events: &[Event]) -> Option<(u64, u64)> {
    events.iter().rev().find_map(|event| match event {
        Event::Progress { received, total } => Some((*received, *total)),
        _ => None,
    })
}

#[tokio::test]
async fn resumes_after_a_mid_stream_drop_through_a_redirect() {
    let body = Arc::new(package());
    let served = Arc::clone(&body);
    let blobs = Arc::new(AtomicUsize::new(0));
    let (base, seen) = serve(Arc::new(move |_, seen: &Seen| {
        if seen.path == DOWNLOAD {
            return Reply::redirect("/blob/pkg?sig=fresh");
        }
        let reply = Reply::ranged(&served, seen);
        if blobs.fetch_add(1, AtomicOrdering::SeqCst) == 0 {
            reply.cut(70_000)
        } else {
            reply
        }
    }))
    .await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("9.9.9.apk");
    let run = fetch(&format!("{base}{DOWNLOAD}"), &body, &file).await;
    assert_eq!(run.result, Ok(()));
    assert_eq!(std::fs::read(&file).unwrap(), *body);
    assert_eq!(names(dir.path()), ["9.9.9.apk"]);
    let seen = seen.lock().unwrap().clone();
    let blob: Vec<Option<u64>> = seen
        .iter()
        .filter(|s| s.path.starts_with("/blob/"))
        .map(|s| s.range)
        .collect();
    // The second attempt asked GitHub again (fresh redirect) and resumed at the drop.
    assert_eq!(blob, [None, Some(70_000)]);
    assert_eq!(seen.iter().filter(|s| s.path == DOWNLOAD).count(), 2);
    assert!(run
        .events
        .iter()
        .any(|e| matches!(e, Event::Retrying { attempt: 1, .. })));
    assert_eq!(last_progress(&run.events), Some((200_000, 200_000)));
    assert_eq!(run.events.last(), Some(&Event::Verifying));
    let mut previous = 0;
    for event in &run.events {
        if let Event::Progress { received, .. } = event {
            assert!(*received >= previous, "progress went backwards");
            previous = *received;
        }
    }
}

#[tokio::test]
async fn a_part_left_by_an_earlier_run_resumes_with_a_range_request() {
    let body = Arc::new(package());
    let served = Arc::clone(&body);
    let (base, _) = serve(Arc::new(move |_, seen: &Seen| {
        Reply::ranged(&served, seen).cut(50_000)
    }))
    .await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("9.9.9.apk");
    let tuning = Tuning {
        attempts: 1,
        ..quick()
    };
    // The network gives out: the bytes so far stay on disk.
    let run = fetch_with(
        &format!("{base}{DOWNLOAD}"),
        &body,
        &file,
        &tuning,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(run.result, Err(Failure::Network));
    assert_eq!(names(dir.path()), ["9.9.9.apk.part", "9.9.9.apk.part.json"]);
    assert_eq!(
        std::fs::metadata(dir.path().join("9.9.9.apk.part"))
            .unwrap()
            .len(),
        50_000
    );

    // Next time (a new server, as after an app restart) only the rest is fetched.
    let served = Arc::clone(&body);
    let (base, seen) = serve(Arc::new(move |_, seen: &Seen| Reply::ranged(&served, seen))).await;
    let run = fetch(&format!("{base}{DOWNLOAD}"), &body, &file).await;
    assert_eq!(run.result, Ok(()));
    assert_eq!(std::fs::read(&file).unwrap(), *body);
    assert_eq!(seen.lock().unwrap()[0].range, Some(50_000));
    assert_eq!(names(dir.path()), ["9.9.9.apk"]);
    // First progress already counts the resumed bytes.
    assert!(matches!(
        run.events[0],
        Event::Progress {
            received: 50_000,
            ..
        }
    ));
}

#[tokio::test]
async fn a_hash_mismatch_is_rejected_and_the_bytes_deleted() {
    let body = package();
    let mut corrupt = body.clone();
    corrupt[123_456] ^= 0xff;
    let (base, _) = serve(Arc::new(move |_, seen: &Seen| {
        Reply::ranged(&corrupt, seen)
    }))
    .await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("9.9.9.apk");
    let run = fetch(&format!("{base}{DOWNLOAD}"), &body, &file).await;
    assert_eq!(run.result, Err(Failure::Hash));
    assert!(names(dir.path()).is_empty());
}

#[tokio::test]
async fn a_size_that_disagrees_with_the_release_is_rejected() {
    let body = package();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("9.9.9.apk");

    // The full answer announces another length.
    let short = body[..body.len() - 1].to_vec();
    let (base, _) = serve(Arc::new(move |_, _: &Seen| Reply::new(200, &short))).await;
    let run = fetch(&format!("{base}{DOWNLOAD}"), &body, &file).await;
    assert_eq!(run.result, Err(Failure::Size));
    assert!(names(dir.path()).is_empty());

    // More bytes than published, without a length to warn first.
    let long = [body.clone(), vec![1, 2, 3]].concat();
    let (base, _) = serve(Arc::new(move |_, _: &Seen| {
        let mut reply = Reply::new(200, &long);
        reply.unannounced = true;
        reply
    }))
    .await;
    let run = fetch(&format!("{base}{DOWNLOAD}"), &body, &file).await;
    assert_eq!(run.result, Err(Failure::Size));
    assert!(names(dir.path()).is_empty());

    // A resumed answer for a file of another total size.
    let served = body.clone();
    let (base, _) = serve(Arc::new(move |index, seen: &Seen| {
        if index == 0 {
            return Reply::ranged(&served, seen).cut(10_000);
        }
        let mut reply = Reply::new(206, &served[10_000..]);
        reply.headers.push((
            "Content-Range".into(),
            format!("bytes 10000-{}/{}", served.len(), served.len() + 1),
        ));
        reply
    }))
    .await;
    let run = fetch(&format!("{base}{DOWNLOAD}"), &body, &file).await;
    assert_eq!(run.result, Err(Failure::Size));
    assert!(names(dir.path()).is_empty());
}

#[tokio::test]
async fn cancelling_keeps_the_part_and_the_next_try_resumes() {
    let body = Arc::new(package());
    let served = Arc::clone(&body);
    let (base, _) = serve(Arc::new(move |_, seen: &Seen| {
        let mut reply = Reply::ranged(&served, seen);
        reply.pace = Duration::from_millis(15);
        reply
    }))
    .await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("9.9.9.apk");
    let cancel = CancellationToken::new();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let url = format!("{base}{DOWNLOAD}");
    let asset = Asset {
        url: &url,
        size: body.len() as u64,
        sha256: digest(&body),
    };
    let sink = move |event: Event| {
        let _ = tx.send(event);
    };
    let tuning = quick();
    let running = download::fetch(&asset, &file, &client, &tuning, &cancel, &sink);
    let watcher = async {
        while let Some(event) = rx.recv().await {
            if matches!(event, Event::Progress { received, .. } if received >= 20_000) {
                cancel.cancel();
                break;
            }
        }
    };
    let (result, ()) = tokio::join!(running, watcher);
    assert_eq!(result, Err(Failure::Cancelled));
    let kept = std::fs::metadata(dir.path().join("9.9.9.apk.part"))
        .unwrap()
        .len();
    assert!(kept >= 20_000 && kept < body.len() as u64, "{kept}");
    assert!(!file.exists());

    let served = Arc::clone(&body);
    let (base, seen) = serve(Arc::new(move |_, seen: &Seen| Reply::ranged(&served, seen))).await;
    let run = fetch(&format!("{base}{DOWNLOAD}"), &body, &file).await;
    assert_eq!(run.result, Ok(()));
    assert_eq!(seen.lock().unwrap()[0].range, Some(kept));
    assert_eq!(std::fs::read(&file).unwrap(), *body);
}

#[tokio::test]
async fn hosts_outside_the_release_policy_are_refused() {
    assert!(download::allowed(
        &format!("http://127.0.0.1:9{DOWNLOAD}"),
        false,
        true
    ));
    assert!(!download::allowed(
        &format!("http://127.0.0.1:9{DOWNLOAD}"),
        false,
        false
    ));
    assert!(!download::allowed("http://127.0.0.1/no-port", false, true));
    assert!(!download::allowed(
        "http://10.0.0.2:8080/a.apk",
        false,
        true
    ));
    assert!(!download::allowed("https://evil.test/a.apk", true, true));
    assert!(download::allowed(
        "https://github.com/wangyingxuan383-ai/lishi-chuanyue/releases/download/v1/a.apk",
        false,
        false
    ));
    assert!(!download::allowed(
        "https://release-assets.githubusercontent.com/x",
        false,
        false
    ));

    let body = package();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("9.9.9.apk");
    // Not even a request for a starting URL outside the policy.
    let run = fetch("https://example.com/chuanyue.apk", &body, &file).await;
    assert_eq!(run.result, Err(Failure::Url));

    // A redirect to another host is not followed.
    let (base, seen) = serve(Arc::new(|_, _: &Seen| {
        Reply::redirect("https://evil.test/blob")
    }))
    .await;
    let run = fetch(&format!("{base}{DOWNLOAD}"), &body, &file).await;
    assert_eq!(run.result, Err(Failure::Url));
    assert_eq!(seen.lock().unwrap().len(), 1);

    // Release builds never accept a local server.
    let tuning = Tuning {
        loopback: false,
        ..quick()
    };
    let run = fetch_with(
        &format!("{base}{DOWNLOAD}"),
        &body,
        &file,
        &tuning,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(run.result, Err(Failure::Url));
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert!(!file.exists());
}

#[tokio::test]
async fn transient_errors_are_retried_then_given_up() {
    let body = Arc::new(package());
    let served = Arc::clone(&body);
    let (base, seen) = serve(Arc::new(move |index, seen: &Seen| {
        if index < 2 {
            Reply::new(503, b"busy")
        } else {
            Reply::ranged(&served, seen)
        }
    }))
    .await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("9.9.9.apk");
    let run = fetch(&format!("{base}{DOWNLOAD}"), &body, &file).await;
    assert_eq!(run.result, Ok(()));
    assert_eq!(seen.lock().unwrap().len(), 3);
    let retries: Vec<(u32, u64)> = run
        .events
        .iter()
        .filter_map(|e| match e {
            Event::Retrying { attempt, wait_ms } => Some((*attempt, *wait_ms)),
            _ => None,
        })
        .collect();
    assert_eq!(retries, [(1, 10), (2, 20)]);

    let (base, seen) = serve(Arc::new(|_, _: &Seen| Reply::new(503, b"busy"))).await;
    let file = dir.path().join("9.9.8.apk");
    let run = fetch(&format!("{base}{DOWNLOAD}"), &body, &file).await;
    assert_eq!(run.result, Err(Failure::Network));
    assert_eq!(seen.lock().unwrap().len(), 4);
}

#[tokio::test]
async fn permanent_http_errors_fail_without_retrying() {
    let (base, seen) = serve(Arc::new(|_, _: &Seen| Reply::new(404, b"missing"))).await;
    let dir = tempfile::tempdir().unwrap();
    let body = package();
    let run = fetch(
        &format!("{base}{DOWNLOAD}"),
        &body,
        &dir.path().join("9.9.9.apk"),
    )
    .await;
    assert_eq!(run.result, Err(Failure::Http));
    assert_eq!(seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_server_ignoring_range_restarts_from_zero() {
    let body = Arc::new(package());
    let served = Arc::clone(&body);
    let (base, seen) = serve(Arc::new(move |index, _: &Seen| {
        let reply = Reply::new(200, &served);
        if index == 0 {
            reply.cut(70_000)
        } else {
            reply
        }
    }))
    .await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("9.9.9.apk");
    let run = fetch(&format!("{base}{DOWNLOAD}"), &body, &file).await;
    assert_eq!(run.result, Ok(()));
    assert_eq!(seen.lock().unwrap()[1].range, Some(70_000));
    assert_eq!(std::fs::read(&file).unwrap(), *body);
}

#[tokio::test]
async fn a_verified_package_is_reused_and_a_tampered_one_replaced() {
    let body = Arc::new(package());
    let served = Arc::clone(&body);
    let (base, seen) = serve(Arc::new(move |_, seen: &Seen| Reply::ranged(&served, seen))).await;
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("9.9.9.apk");
    let url = format!("{base}{DOWNLOAD}");
    assert_eq!(fetch(&url, &body, &file).await.result, Ok(()));
    let run = fetch(&url, &body, &file).await;
    assert_eq!(run.result, Ok(()));
    assert_eq!(run.events, [Event::Verifying]);
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert_eq!(
        download::verify(&file, body.len() as u64, &digest(&body)).await,
        Check::Matches
    );

    let mut tampered = body.to_vec();
    tampered[5] ^= 1;
    std::fs::write(&file, &tampered).unwrap();
    assert_eq!(
        download::verify(&file, body.len() as u64, &digest(&body)).await,
        Check::Differs
    );
    assert_eq!(fetch(&url, &body, &file).await.result, Ok(()));
    assert_eq!(std::fs::read(&file).unwrap(), *body);
    assert_eq!(seen.lock().unwrap().len(), 2);
    assert_eq!(
        download::verify(&dir.path().join("none.apk"), 1, &digest(&body)).await,
        Check::Missing
    );
}

#[tokio::test]
async fn small_text_follows_redirects_and_is_bounded() {
    let sums = format!("{}  pkg.apk\n", download::hex(&digest(&package())));
    let text = sums.clone();
    let (base, _) = serve(Arc::new(move |_, seen: &Seen| {
        if seen.path.ends_with("SHA256SUMS.txt") {
            Reply::redirect("/blob/sums")
        } else {
            Reply::new(200, text.as_bytes())
        }
    }))
    .await;
    let url =
        format!("{base}/wangyingxuan383-ai/lishi-chuanyue/releases/download/v9.9.9/SHA256SUMS.txt");
    let client = client().unwrap();
    assert_eq!(
        download::fetch_small(&url, &client, &quick(), 1024)
            .await
            .unwrap(),
        sums.as_bytes()
    );
    assert_eq!(
        download::fetch_small(&url, &client, &quick(), 10).await,
        Err(Failure::Size)
    );
    assert_eq!(
        download::fetch_small("https://evil.test/SHA256SUMS.txt", &client, &quick(), 1024).await,
        Err(Failure::Url)
    );
}

#[test]
fn sha256_text_round_trips_and_rejects_malformed_digests() {
    let digest = digest(b"abc");
    let text = download::hex(&digest);
    assert_eq!(
        text,
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(download::parse_sha256(&text), Some(digest));
    assert_eq!(download::parse_sha256(&text.to_uppercase()), Some(digest));
    for bad in [
        "",
        "abc",
        &text[1..],
        &format!("{text}0"),
        &format!("g{}", &text[1..]),
    ] {
        assert_eq!(download::parse_sha256(bad), None, "{bad}");
    }
}

#[test]
fn versions_follow_semver_precedence() {
    let ordered = [
        "0.9.0",
        "0.10.0-alpha",
        "0.10.0-alpha.1",
        "0.10.0-alpha.beta",
        "0.10.0-beta.2",
        "0.10.0-beta.11",
        "0.10.0-rc.1",
        "0.10.0",
        "0.10.1",
        "0.11.0",
        "1.0.0",
        "10.0.0",
    ];
    for (i, a) in ordered.iter().enumerate() {
        for (j, b) in ordered.iter().enumerate() {
            let order = compare(&parse_version(a).unwrap(), &parse_version(b).unwrap());
            assert_eq!(order, i.cmp(&j), "{a} vs {b}");
        }
    }
    let equal = compare(
        &parse_version("0.10.0+one").unwrap(),
        &parse_version("0.10.0+two").unwrap(),
    );
    assert_eq!(equal, Ordering::Equal);
    for bad in [
        "",
        "v0.10.0",
        "1",
        "1.0",
        "1.0.0.1",
        "01.0.0",
        "1.01.0",
        "1.0.0-",
        "1.0.0-01",
        "1.0.0-a..b",
        "1.0.0+",
        "1.0.0 ",
        "1.0.0/../x",
        "1.0.0-测试",
    ] {
        assert!(parse_version(bad).is_none(), "{bad}");
    }
    assert!(parse_version(&format!("1.0.0-{}", "a".repeat(60))).is_none());
    // Only newer than this build may be fetched or installed.
    assert!(newer_version("999.0.0").is_ok());
    assert_eq!(
        newer_version(env!("CARGO_PKG_VERSION")).unwrap_err().code,
        "update_version"
    );
    assert_eq!(newer_version("0.0.1").unwrap_err().code, "update_version");
    assert_eq!(newer_version("../../x").unwrap_err().code, "update_version");
}

#[test]
fn tidy_keeps_only_newer_packages() {
    let dir = tempfile::tempdir().unwrap();
    for name in [
        "0.9.0.apk",
        "0.10.0.apk",
        "0.10.0.apk.part",
        "0.10.1.apk",
        "0.10.1.apk.part.json",
        "0.11.0-rc.1.apk.part",
        "junk.txt",
    ] {
        std::fs::write(dir.path().join(name), b"x").unwrap();
    }
    std::fs::create_dir(dir.path().join("old")).unwrap();
    tidy(dir.path(), "0.10.0", None);
    assert_eq!(
        names(dir.path()),
        ["0.10.1.apk", "0.10.1.apk.part.json", "0.11.0-rc.1.apk.part"]
    );
    tidy(dir.path(), "0.10.0", Some("0.11.0-rc.1"));
    assert_eq!(names(dir.path()), ["0.11.0-rc.1.apk.part"]);
    tidy(&dir.path().join("missing"), "0.10.0", None);
}

#[test]
fn a_test_update_source_is_loopback_only_and_rewrites_the_release_list() {
    assert_eq!(
        normalize_dev_source(" http://127.0.0.1:18990/ ").as_deref(),
        Some("http://127.0.0.1:18990")
    );
    assert_eq!(
        normalize_dev_source("http://localhost:1").as_deref(),
        Some("http://localhost:1")
    );
    for bad in [
        "http://127.0.0.1",
        "https://127.0.0.1:1",
        "http://10.0.0.2:1",
        "http://127.0.0.1:1/x",
        "http://127.0.0.1:1/?q",
        "http://user@127.0.0.1:1",
        "ftp://127.0.0.1:1",
        "",
    ] {
        assert!(normalize_dev_source(bad).is_none(), "{bad}");
    }
    let api = "https://api.github.com/repos/wangyingxuan383-ai/lishi-chuanyue/releases?per_page=5";
    *DEV_SOURCE.write().unwrap() = Some("http://127.0.0.1:18990".into());
    assert_eq!(
        dev_release_url(api).as_deref(),
        Some("http://127.0.0.1:18990/repos/wangyingxuan383-ai/lishi-chuanyue/releases?per_page=5")
    );
    assert_eq!(
        dev_release_url("https://api.github.com/repos/other/repo/releases"),
        None
    );
    *DEV_SOURCE.write().unwrap() = None;
    assert_eq!(dev_release_url(api), None);
}
