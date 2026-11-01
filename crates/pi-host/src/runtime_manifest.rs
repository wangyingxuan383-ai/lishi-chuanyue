//! Complete runtime validation shared by desktop launch and Android JNI.
use crate::HostError;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, File, Metadata},
    io::Read,
    path::{Path, PathBuf},
};
const COMMIT: &str = "973b74c55fcf096ad5976f8d8850c147ee2e62d4";
const APPROVED_SOURCE: &str = include_str!("../../../agent-host/upstream-lock.json");
const REQUIRED_ARTIFACTS: &[&str] = &[
    "pi/dist/bundle/index.js",
    "memory-credentials.mjs",
    "node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm",
    "node_modules/jiti/package.json",
    "host/src/entry.mjs",
    "host/upstream-lock.json",
    "notices/dependencies.json",
];

pub(crate) fn io_error(error: std::io::Error) -> HostError {
    HostError::Io(error.kind().to_string())
}

pub(crate) fn absolute(path: &Path) -> Result<PathBuf, HostError> {
    if !path.is_absolute() {
        return Err(HostError::Protocol(
            "native launch paths must be absolute".into(),
        ));
    }
    path.canonicalize().map_err(io_error)
}

fn linked(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    // Windows directory junctions and other reparse paths are not necessarily
    // represented as a symlink by every filesystem implementation.
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

fn artifact_names(runtime: &Path) -> Result<Vec<String>, HostError> {
    let mut directories = vec![runtime.to_path_buf()];
    let mut names = Vec::new();
    while let Some(directory) = directories.pop() {
        for entry in fs::read_dir(directory).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(io_error)?;
            if linked(&metadata) {
                return Err(HostError::Protocol(
                    "runtime artifacts contain a symbolic or reparse link".into(),
                ));
            }
            if metadata.is_dir() {
                directories.push(path);
                continue;
            }
            if !metadata.is_file() {
                return Err(HostError::Protocol(
                    "unexpected runtime artifact type".into(),
                ));
            }
            let relative = path.strip_prefix(runtime).map_err(|_| {
                HostError::Protocol("runtime artifact escaped its directory".into())
            })?;
            let name = relative
                .components()
                .map(|component| {
                    component.as_os_str().to_str().ok_or_else(|| {
                        HostError::Protocol("runtime artifact path is not UTF-8".into())
                    })
                })
                .collect::<Result<Vec<_>, _>>()?
                .join("/");
            if name != "manifest.json" {
                names.push(name);
            }
        }
    }
    // Match JavaScript's Array.sort() comparison used by artifacts.mjs.
    names.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    Ok(names)
}

pub fn validate_runtime(directory: &Path) -> Result<Value, HostError> {
    if !directory.is_absolute() {
        return Err(HostError::Protocol(
            "native runtime path must be absolute".into(),
        ));
    }
    let metadata = fs::symlink_metadata(directory).map_err(io_error)?;
    if linked(&metadata) || !metadata.is_dir() {
        return Err(HostError::Protocol(
            "runtime directory must not be a symbolic or reparse link".into(),
        ));
    }
    let runtime = absolute(directory)?;
    let manifest_path = runtime.join("manifest.json");
    let metadata = fs::symlink_metadata(&manifest_path).map_err(io_error)?;
    if linked(&metadata) || !metadata.is_file() {
        return Err(HostError::Protocol(
            "runtime manifest must be a regular file".into(),
        ));
    }
    if metadata.len() > 2 * 1024 * 1024 {
        return Err(HostError::Protocol("runtime manifest is too large".into()));
    }
    let manifest: Value = serde_json::from_slice(&fs::read(manifest_path).map_err(io_error)?)
        .map_err(|_| HostError::Protocol("invalid runtime manifest".into()))?;
    let approved: Value = serde_json::from_str(APPROVED_SOURCE)
        .map_err(|_| HostError::Protocol("invalid compiled Pi source lock".into()))?;
    if manifest["schemaVersion"] != 1
        || manifest["built"] != true
        || manifest["fullCodingAgent"] != true
        || manifest["commit"] != COMMIT
        || manifest["codingAgentVersion"] != "1.4.0"
        || manifest["nodeVersion"] != "24.19.0"
        || manifest["sourceArchiveSha256"] != approved["archive"]["sha256"]
        || manifest["sourceNpmLockSha256"] != approved["sourceNpmLockSha256"]
        || manifest["modelCatalogSha256"] != approved["modelCatalog"]["sha256"]
    {
        return Err(HostError::Protocol(
            "runtime is not the pinned complete Pi distribution".into(),
        ));
    }
    let files = manifest["files"]
        .as_array()
        .filter(|files| !files.is_empty())
        .ok_or_else(|| HostError::Protocol("runtime has no artifact manifest".into()))?;
    let mut listed = Vec::with_capacity(files.len());
    let mut unique = BTreeSet::new();
    for item in files {
        let name = item["path"]
            .as_str()
            .ok_or_else(|| HostError::Protocol("invalid runtime artifact path".into()))?;
        if name.is_empty()
            || name.starts_with('/')
            || name.contains('\\')
            || name.contains(':')
            || name.contains('\0')
            || name
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
            || name == "manifest.json"
            || !unique.insert(name.to_owned())
        {
            return Err(HostError::Protocol(
                "invalid or duplicate runtime artifact path".into(),
            ));
        }
        listed.push(name.to_owned());
        if item["bytes"].as_u64().is_none()
            || !item["sha256"].as_str().is_some_and(|hash| {
                hash.len() == 64
                    && hash
                        .bytes()
                        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            })
        {
            return Err(HostError::Protocol(
                "invalid runtime artifact length or checksum".into(),
            ));
        }
    }
    if listed != artifact_names(&runtime)? {
        return Err(HostError::Protocol("runtime artifact list changed".into()));
    }
    for required in REQUIRED_ARTIFACTS {
        if !unique.contains(*required) {
            return Err(HostError::Protocol(
                "required complete Pi runtime resource is absent".into(),
            ));
        }
    }
    for item in files {
        let name = item["path"].as_str().expect("validated artifact name");
        let path = runtime.join(name);
        let metadata = fs::symlink_metadata(&path).map_err(io_error)?;
        if linked(&metadata) || !metadata.is_file() || !absolute(&path)?.starts_with(&runtime) {
            return Err(HostError::Protocol(
                "runtime artifact escaped its directory".into(),
            ));
        }
        if metadata.len() != item["bytes"].as_u64().expect("validated artifact length") {
            return Err(HostError::Protocol(
                "runtime artifact length changed".into(),
            ));
        }
        let mut input = File::open(path).map_err(io_error)?;
        let mut digest = Sha256::new();
        let mut buffer = [0_u8; 32_768];
        loop {
            let count = input.read(&mut buffer).map_err(io_error)?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        if format!("{:x}", digest.finalize())
            != item["sha256"]
                .as_str()
                .expect("validated artifact checksum")
        {
            return Err(HostError::Protocol(
                "runtime artifact checksum mismatch".into(),
            ));
        }
    }
    Ok(manifest)
}
