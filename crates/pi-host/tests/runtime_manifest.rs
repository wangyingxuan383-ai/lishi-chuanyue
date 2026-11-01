#![cfg(not(target_os = "android"))]
//! Synthetic resources keep these checks local and do not start Node/models.
use pi_host::NodeProcess;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const SOURCE: &str = include_str!("../../../agent-host/upstream-lock.json");
const REQUIRED: &[&str] = &[
    "pi/dist/bundle/index.js",
    "memory-credentials.mjs",
    "node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm",
    "node_modules/jiti/package.json",
    "host/src/entry.mjs",
    "host/upstream-lock.json",
    "notices/dependencies.json",
];

struct Fixture {
    owned: PathBuf,
    runtime: PathBuf,
    artifacts: BTreeMap<String, Vec<u8>>,
}
impl Fixture {
    fn new() -> Self {
        static COUNT: AtomicU64 = AtomicU64::new(0);
        let name = format!(
            "pi-host-manifest-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            COUNT.fetch_add(1, Ordering::Relaxed)
        );
        let owned = std::env::temp_dir().join(name);
        fs::create_dir(&owned).unwrap();
        let runtime = owned.join("runtime");
        fs::create_dir(&runtime).unwrap();
        let artifacts = REQUIRED
            .iter()
            .map(|name| {
                (
                    (*name).to_owned(),
                    format!("owned fixture {name}").into_bytes(),
                )
            })
            .collect();
        let fixture = Self {
            owned,
            runtime,
            artifacts,
        };
        for (name, data) in &fixture.artifacts {
            let path = fixture.runtime.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, data).unwrap();
        }
        fixture.write_manifest(&fixture.manifest());
        fixture
    }
    fn manifest(&self) -> Value {
        let source: Value = serde_json::from_str(SOURCE).unwrap();
        json!({"schemaVersion":1,"built":true,"fullCodingAgent":true,
            "commit":source["commit"],"codingAgentVersion":source["codingAgentVersion"],"nodeVersion":source["nodeVersion"],
            "sourceArchiveSha256":source["archive"]["sha256"],"sourceNpmLockSha256":source["sourceNpmLockSha256"],"modelCatalogSha256":source["modelCatalog"]["sha256"],
            "files":self.artifacts.iter().map(|(name,data)|json!({"path":name,"bytes":data.len(),"sha256":format!("{:x}",Sha256::digest(data))})).collect::<Vec<_>>()})
    }
    fn write_manifest(&self, manifest: &Value) {
        fs::write(
            self.runtime.join("manifest.json"),
            serde_json::to_vec(manifest).unwrap(),
        )
        .unwrap();
    }
    fn validate(&self) -> bool {
        NodeProcess::validate_runtime(&self.runtime).is_ok()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // Only the exact uniquely-created fixture directory is removed.
        if self.owned.parent() == Some(std::env::temp_dir().as_path())
            && self
                .owned
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("pi-host-manifest-"))
        {
            let _ = fs::remove_dir_all(&self.owned);
        }
    }
}

#[test]
fn complete_resource_list_detects_tampering_missing_and_extra_files() {
    let fixture = Fixture::new();
    assert!(fixture.validate());
    let entry = fixture.runtime.join("host/src/entry.mjs");
    let mut bytes = fs::read(&entry).unwrap();
    bytes[0] ^= 1;
    fs::write(&entry, &bytes).unwrap();
    assert!(
        !fixture.validate(),
        "same-size entry tampering must fail before Node can start"
    );
    fs::write(&entry, &fixture.artifacts["host/src/entry.mjs"]).unwrap();
    let extra = fixture.runtime.join("extra.mjs");
    fs::write(&extra, b"unlisted").unwrap();
    assert!(!fixture.validate(), "unlisted files must be rejected");
    fs::remove_file(extra).unwrap();
    assert!(fixture.validate());
    fs::remove_file(entry).unwrap();
    assert!(!fixture.validate());
}

#[test]
fn invalid_paths_duplicates_and_changed_source_lock_are_rejected() {
    let fixture = Fixture::new();
    for path in [
        "../outside.mjs",
        "/outside.mjs",
        "C:/outside.mjs",
        "host\\entry.mjs",
        "host//entry.mjs",
        "host/./entry.mjs",
        "host/../entry.mjs",
        "manifest.json",
    ] {
        let mut manifest = fixture.manifest();
        manifest["files"][0]["path"] = path.into();
        fixture.write_manifest(&manifest);
        assert!(!fixture.validate(), "invalid manifest path {path}");
    }
    let mut duplicate = fixture.manifest();
    let item = duplicate["files"][0].clone();
    duplicate["files"].as_array_mut().unwrap().push(item);
    fixture.write_manifest(&duplicate);
    assert!(!fixture.validate());
    for field in [
        "commit",
        "codingAgentVersion",
        "nodeVersion",
        "sourceArchiveSha256",
        "sourceNpmLockSha256",
        "modelCatalogSha256",
    ] {
        let mut manifest = fixture.manifest();
        manifest[field] = "other".into();
        fixture.write_manifest(&manifest);
        assert!(
            !fixture.validate(),
            "fixed source field {field} must remain mandatory"
        );
    }
    fixture.write_manifest(&fixture.manifest());
    assert!(fixture.validate());
}

#[cfg(unix)]
#[test]
fn symbolic_links_are_rejected_even_when_target_bytes_match() {
    let fixture = Fixture::new();
    let entry = fixture.runtime.join("host/src/entry.mjs");
    let outside = fixture.owned.join("outside.mjs");
    fs::rename(&entry, &outside).unwrap();
    std::os::unix::fs::symlink(&outside, &entry).unwrap();
    assert!(
        !fixture.validate(),
        "a resource must not escape through a symlink"
    );
    let alias = fixture.owned.join("runtime-alias");
    std::os::unix::fs::symlink(&fixture.runtime, &alias).unwrap();
    assert!(NodeProcess::validate_runtime(&alias).is_err());
}
