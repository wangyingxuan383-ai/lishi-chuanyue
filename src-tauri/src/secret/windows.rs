//! Current-user Windows DPAPI adapter. Files contain only bounded ciphertext.
//! DPAPI identity protection is tied to the Windows user/profile; this is not
//! a portable credential export and never uses LOCAL_MACHINE protection.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::ptr;
use std::sync::atomic::{compiler_fence, Ordering};
use std::sync::Mutex;

use crate::secrets::{SecretSlot, SecretStore, SecretStoreError, SecretValue, MAX_SECRET_BYTES};
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

const MAGIC: &[u8] = b"LISHI-DPAPI\x01";
const MAX_ENVELOPE_BYTES: usize = 64 * 1024;
const ENTROPY_NAMESPACE: &[u8] = b"io.timejump.chuanyue.secret.v1\0";

pub struct WindowsSecretStore {
    directory: PathBuf,
    access: Mutex<()>,
}

impl WindowsSecretStore {
    pub fn open(directory: PathBuf) -> Result<Self, SecretStoreError> {
        fs::create_dir_all(&directory).map_err(|_| SecretStoreError::IoError)?;
        Ok(Self {
            directory,
            access: Mutex::new(()),
        })
    }

    fn path_for(&self, slot: &SecretSlot) -> PathBuf {
        // Hex preserves case-sensitive slot identity on case-insensitive Windows
        // filesystems, without hashes, path components, or token-derived names.
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut encoded = String::with_capacity(slot.as_str().len() * 2);
        for byte in slot.as_str().bytes() {
            encoded.push(char::from(HEX[usize::from(byte >> 4)]));
            encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
        self.directory.join(format!("secret-v1-{encoded}.dpapi"))
    }
}

impl SecretStore for WindowsSecretStore {
    fn save(&self, slot: &SecretSlot, value: &SecretValue) -> Result<(), SecretStoreError> {
        let _access = self
            .access
            .lock()
            .map_err(|_| SecretStoreError::Unavailable)?;
        let ciphertext = protect(slot, value)?;
        let mut envelope = Vec::with_capacity(MAGIC.len() + 4 + ciphertext.len());
        envelope.extend_from_slice(MAGIC);
        envelope.extend_from_slice(
            &u32::try_from(ciphertext.len())
                .map_err(|_| SecretStoreError::Unavailable)?
                .to_le_bytes(),
        );
        envelope.extend_from_slice(&ciphertext);
        if envelope.len() > MAX_ENVELOPE_BYTES {
            return Err(SecretStoreError::Unavailable);
        }
        // Only ciphertext reaches the temporary file. Flush it before the
        // same-directory atomic replacement; failed persistence drops the temp
        // file and leaves the previous destination intact.
        let mut temporary = tempfile::NamedTempFile::new_in(&self.directory)
            .map_err(|_| SecretStoreError::IoError)?;
        temporary
            .write_all(&envelope)
            .map_err(|_| SecretStoreError::IoError)?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|_| SecretStoreError::IoError)?;
        temporary
            .persist(self.path_for(slot))
            .map_err(|_| SecretStoreError::IoError)?;
        Ok(())
    }

    fn load(&self, slot: &SecretSlot) -> Result<Option<SecretValue>, SecretStoreError> {
        let _access = self
            .access
            .lock()
            .map_err(|_| SecretStoreError::Unavailable)?;
        let file = match File::open(self.path_for(slot)) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(SecretStoreError::IoError),
        };
        // Bound the actual read, including a growth race after metadata lookup.
        let mut envelope = Vec::new();
        file.take(
            u64::try_from(MAX_ENVELOPE_BYTES + 1).map_err(|_| SecretStoreError::Unavailable)?,
        )
        .read_to_end(&mut envelope)
        .map_err(|_| SecretStoreError::IoError)?;
        let ciphertext = decode_envelope(&envelope)?;
        unprotect(slot, ciphertext).map(Some)
    }

    fn delete(&self, slot: &SecretSlot) -> Result<(), SecretStoreError> {
        let _access = self
            .access
            .lock()
            .map_err(|_| SecretStoreError::Unavailable)?;
        match fs::remove_file(self.path_for(slot)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(SecretStoreError::IoError),
        }
    }
}

fn decode_envelope(envelope: &[u8]) -> Result<&[u8], SecretStoreError> {
    let header_len = MAGIC.len() + 4;
    if envelope.len() > MAX_ENVELOPE_BYTES
        || envelope.len() <= header_len
        || !envelope.starts_with(MAGIC)
    {
        return Err(SecretStoreError::Corrupted);
    }
    let encoded_len = <[u8; 4]>::try_from(&envelope[MAGIC.len()..header_len])
        .map_err(|_| SecretStoreError::Corrupted)?;
    let declared_len = usize::try_from(u32::from_le_bytes(encoded_len))
        .map_err(|_| SecretStoreError::Corrupted)?;
    let ciphertext = &envelope[header_len..];
    if declared_len != ciphertext.len() {
        return Err(SecretStoreError::Corrupted);
    }
    Ok(ciphertext)
}

fn entropy(slot: &SecretSlot) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(ENTROPY_NAMESPACE.len() + slot.as_str().len());
    bytes.extend_from_slice(ENTROPY_NAMESPACE);
    bytes.extend_from_slice(slot.as_str().as_bytes());
    bytes
}

fn input_blob(bytes: &[u8]) -> Result<CRYPT_INTEGER_BLOB, SecretStoreError> {
    Ok(CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(bytes.len()).map_err(|_| SecretStoreError::Unavailable)?,
        // DPAPI's input is read-only despite the legacy mutable byte pointer in
        // DATA_BLOB. Neither adapter lends a Rust mutable reference to this data.
        pbData: bytes.as_ptr().cast_mut(),
    })
}

/// Owns only a LocalAlloc buffer returned by DPAPI. Never cloned or exposed.
struct NativeBlob {
    blob: CRYPT_INTEGER_BLOB,
    wipe: bool,
}

impl NativeBlob {
    fn empty(wipe: bool) -> Self {
        Self {
            blob: CRYPT_INTEGER_BLOB {
                cbData: 0,
                pbData: ptr::null_mut(),
            },
            wipe,
        }
    }

    fn bytes(&self) -> Result<&[u8], SecretStoreError> {
        let len = usize::try_from(self.blob.cbData).map_err(|_| SecretStoreError::Corrupted)?;
        if self.blob.pbData.is_null() || len == 0 || len > MAX_ENVELOPE_BYTES {
            return Err(SecretStoreError::Corrupted);
        }
        // SAFETY: DPAPI produced this non-null allocation and its byte length;
        // the owning guard keeps it live for the borrowed slice's lifetime.
        Ok(unsafe { std::slice::from_raw_parts(self.blob.pbData, len) })
    }
}

impl Drop for NativeBlob {
    fn drop(&mut self) {
        if self.blob.pbData.is_null() {
            return;
        }
        if self.wipe {
            // SAFETY: the pointer and cbData describe the DPAPI-owned allocation,
            // including any output allocated on a failing API call. Volatile
            // writes and the fence keep clearing before LocalFree observable.
            for offset in 0..self.blob.cbData as usize {
                unsafe { self.blob.pbData.add(offset).write_volatile(0) };
            }
            compiler_fence(Ordering::SeqCst);
        }
        // SAFETY: this pointer is null-initialized and only assigned by DPAPI;
        // DPAPI documents that returned buffers must be released with LocalFree.
        let _ = unsafe { LocalFree(self.blob.pbData.cast()) };
        self.blob.pbData = ptr::null_mut();
        self.blob.cbData = 0;
    }
}

fn protect(slot: &SecretSlot, value: &SecretValue) -> Result<Vec<u8>, SecretStoreError> {
    let plaintext = input_blob(value.expose_secret().as_bytes())?;
    let entropy = entropy(slot);
    let additional = input_blob(&entropy)?;
    let mut output = NativeBlob::empty(false);
    // SAFETY: all input slices outlive this call; output points to a live,
    // initialized DATA_BLOB. DPAPI reads input bytes and owns the returned
    // allocation. Null prompt/description/reserved and UI_FORBIDDEN prohibit UI.
    let success = unsafe {
        CryptProtectData(
            &plaintext,
            ptr::null(),
            &additional,
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output.blob,
        )
    };
    if success == 0 {
        return Err(SecretStoreError::KeyUnavailable);
    }
    Ok(output.bytes()?.to_vec())
}

fn unprotect(slot: &SecretSlot, ciphertext: &[u8]) -> Result<SecretValue, SecretStoreError> {
    let ciphertext = input_blob(ciphertext)?;
    let entropy = entropy(slot);
    let additional = input_blob(&entropy)?;
    let mut output = NativeBlob::empty(true);
    // SAFETY: input allocations remain live; output is initialized and uniquely
    // owned. No description allocation is requested. The guard wipes and frees
    // all returned plaintext, including error and validation-failure paths.
    let success = unsafe {
        CryptUnprotectData(
            &ciphertext,
            ptr::null_mut(),
            &additional,
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output.blob,
        )
    };
    if success == 0 {
        return Err(SecretStoreError::Corrupted);
    }
    let plaintext = output.bytes()?;
    if plaintext.len() > MAX_SECRET_BYTES {
        return Err(SecretStoreError::Corrupted);
    }
    let plaintext = std::str::from_utf8(plaintext).map_err(|_| SecretStoreError::Corrupted)?;
    SecretValue::new(plaintext.to_owned()).map_err(|_| SecretStoreError::Corrupted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::fs::OpenOptionsExt;

    fn fake_secret(directory: &std::path::Path) -> SecretValue {
        let nonce = directory
            .file_name()
            .expect("isolated random directory")
            .to_string_lossy();
        SecretValue::new(format!("fake-dpapi-probe-{nonce}-🙂")).expect("create fake token")
    }

    #[test]
    fn real_dpapi_reopen_reprotect_and_delete_work_without_plaintext_files() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<WindowsSecretStore>();
        let directory = tempfile::tempdir().expect("create isolated store");
        let slot = SecretSlot::new("model_api").unwrap();
        let value = fake_secret(directory.path());
        let store = WindowsSecretStore::open(directory.path().to_owned()).unwrap();
        assert!(store.load(&slot).unwrap().is_none());
        store
            .delete(&slot)
            .expect("delete missing slot is idempotent");
        store
            .save(&slot, &value)
            .expect("protect fake token under current user");
        let first = fs::read(store.path_for(&slot)).unwrap();
        assert!(first.starts_with(MAGIC));
        assert!(!first
            .windows(value.expose_secret().len())
            .any(|bytes| bytes == value.expose_secret().as_bytes()));
        store
            .save(&slot, &value)
            .expect("protect the same fake token again");
        let second = fs::read(store.path_for(&slot)).unwrap();
        assert_ne!(
            first, second,
            "DPAPI ciphertext uses fresh protection randomness"
        );
        drop(store);
        let reopened = WindowsSecretStore::open(directory.path().to_owned()).unwrap();
        assert_eq!(
            reopened.load(&slot).unwrap().unwrap().expose_secret(),
            value.expose_secret()
        );
        let changed = SecretValue::new("fake-replacement-token".into()).unwrap();
        reopened.save(&slot, &changed).unwrap();
        assert_eq!(
            reopened.load(&slot).unwrap().unwrap().expose_secret(),
            changed.expose_secret()
        );
        reopened.delete(&slot).unwrap();
        reopened.delete(&slot).unwrap();
        assert!(reopened.load(&slot).unwrap().is_none());
    }

    #[test]
    fn tampering_and_wrong_slot_are_handled() {
        let directory = tempfile::tempdir().unwrap();
        let store = WindowsSecretStore::open(directory.path().to_owned()).unwrap();
        let source = SecretSlot::new("other").unwrap();
        let destination = SecretSlot::new("model").unwrap();
        let value = fake_secret(directory.path());
        store.save(&source, &value).unwrap();
        let other = SecretValue::new("fake-other-slot-token".into()).unwrap();
        store.save(&destination, &other).unwrap();
        assert_ne!(store.path_for(&source), store.path_for(&destination));
        assert_eq!(
            store.load(&source).unwrap().unwrap().expose_secret(),
            value.expose_secret()
        );
        assert_eq!(
            store.load(&destination).unwrap().unwrap().expose_secret(),
            other.expose_secret()
        );
        fs::copy(store.path_for(&source), store.path_for(&destination)).unwrap();
        assert!(matches!(
            store.load(&destination),
            Err(SecretStoreError::Corrupted)
        ));
        let mut corrupted = fs::read(store.path_for(&source)).unwrap();
        *corrupted.last_mut().unwrap() ^= 0x01;
        fs::write(store.path_for(&source), corrupted).unwrap();
        assert!(matches!(
            store.load(&source),
            Err(SecretStoreError::Corrupted)
        ));
    }

    #[test]
    fn invalid_envelopes_are_bounded_and_never_treated_as_missing() {
        let directory = tempfile::tempdir().unwrap();
        let store = WindowsSecretStore::open(directory.path().to_owned()).unwrap();
        let slot = SecretSlot::new("model_api").unwrap();
        let value = fake_secret(directory.path());
        store.save(&slot, &value).unwrap();
        let valid = fs::read(store.path_for(&slot)).unwrap();
        let mut wrong_version = valid.clone();
        wrong_version[MAGIC.len() - 1] ^= 0x01;
        let mut wrong_length = valid.clone();
        wrong_length[MAGIC.len()..MAGIC.len() + 4].copy_from_slice(&u32::MAX.to_le_bytes());
        for invalid in [
            Vec::new(),
            MAGIC.to_vec(),
            wrong_version,
            wrong_length,
            vec![0; MAX_ENVELOPE_BYTES + 1],
        ] {
            fs::write(store.path_for(&slot), invalid).unwrap();
            assert!(matches!(
                store.load(&slot),
                Err(SecretStoreError::Corrupted)
            ));
        }
    }

    #[test]
    fn validation_and_atomic_replace_failure_preserve_the_previous_secret() {
        let directory = tempfile::tempdir().unwrap();
        let store = WindowsSecretStore::open(directory.path().to_owned()).unwrap();
        let slot = SecretSlot::new("model_api").unwrap();
        let value = fake_secret(directory.path());
        store.save(&slot, &value).unwrap();
        let original = fs::read(store.path_for(&slot)).unwrap();
        assert!(SecretValue::new("x".repeat(MAX_SECRET_BYTES + 1)).is_err());
        assert!(SecretValue::new(" invalid-token ".into()).is_err());
        assert!(SecretSlot::new("../model_api").is_err());
        assert_eq!(fs::read(store.path_for(&slot)).unwrap(), original);

        // Denying sharing makes MoveFileExW replacement fail deterministically
        // while the previous encrypted destination still exists.
        let hold = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(store.path_for(&slot))
            .unwrap();
        let replacement = SecretValue::new("fake-uncommitted-replacement".into()).unwrap();
        assert_eq!(
            store.save(&slot, &replacement),
            Err(SecretStoreError::IoError)
        );
        drop(hold);
        assert_eq!(fs::read(store.path_for(&slot)).unwrap(), original);
        assert_eq!(
            store.load(&slot).unwrap().unwrap().expose_secret(),
            value.expose_secret()
        );
        assert_eq!(
            fs::read_dir(directory.path()).unwrap().count(),
            1,
            "failed ciphertext temp was removed"
        );
    }
}
