//! Application service for the single-slot M01 storage probe. No model calls.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;

use crate::secrets::{SecretSlot, SecretStore, SecretStoreError, SecretValue};

/// Deliberately contains no token, length, prefix, or fingerprint.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ProbeSecretStatus {
    pub configured: bool,
}

pub struct SecretProbe {
    store: Arc<dyn SecretStore>,
    slot: SecretSlot,
    busy: Arc<AtomicBool>,
}

impl SecretProbe {
    pub fn new(store: Arc<dyn SecretStore>) -> Result<Self, SecretStoreError> {
        Ok(Self {
            store,
            slot: SecretSlot::new("m01-provider")?,
            busy: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Reserve before enqueueing a platform worker, including its queued time.
    pub fn reserve(&self) -> Result<ProbeSecretOperation, SecretStoreError> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| SecretStoreError::Unavailable)?;
        Ok(ProbeSecretOperation {
            store: Arc::clone(&self.store),
            slot: self.slot.clone(),
            busy: Arc::clone(&self.busy),
        })
    }

    pub fn status(&self) -> Result<ProbeSecretStatus, SecretStoreError> {
        self.reserve()?.status()
    }

    pub fn save(&self, value: SecretValue) -> Result<ProbeSecretStatus, SecretStoreError> {
        self.reserve()?.save(value)
    }

    pub fn delete(&self) -> Result<ProbeSecretStatus, SecretStoreError> {
        self.reserve()?.delete()
    }
}

/// An owned, single-use reservation. It travels with the queued/running worker.
/// Drop releases occupancy after completion, panic, or cancellation before start.
pub struct ProbeSecretOperation {
    store: Arc<dyn SecretStore>,
    slot: SecretSlot,
    busy: Arc<AtomicBool>,
}

impl Drop for ProbeSecretOperation {
    fn drop(&mut self) {
        self.busy.store(false, Ordering::Release);
    }
}

impl ProbeSecretOperation {
    pub fn status(self) -> Result<ProbeSecretStatus, SecretStoreError> {
        self.checked_status()
    }

    pub fn save(self, value: SecretValue) -> Result<ProbeSecretStatus, SecretStoreError> {
        self.store.save(&self.slot, &value)?;
        let restored = self
            .store
            .load(&self.slot)?
            .ok_or(SecretStoreError::Corrupted)?;
        if restored.expose_secret() != value.expose_secret() {
            return Err(SecretStoreError::Corrupted);
        }
        Ok(ProbeSecretStatus { configured: true })
    }

    pub fn delete(self) -> Result<ProbeSecretStatus, SecretStoreError> {
        self.store.delete(&self.slot)?;
        let status = self.checked_status()?;
        if status.configured {
            return Err(SecretStoreError::Corrupted);
        }
        Ok(status)
    }

    fn checked_status(&self) -> Result<ProbeSecretStatus, SecretStoreError> {
        Ok(ProbeSecretStatus {
            configured: self.store.load(&self.slot)?.is_some(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    enum BrokenStore {
        MissingAfterSave,
        WrongValue,
        NoopDelete,
    }

    // Deliberately broken backends exercise the service's postconditions.
    // No real platform files or credentials are used by these tests.
    impl SecretStore for BrokenStore {
        fn save(&self, _: &SecretSlot, _: &SecretValue) -> Result<(), SecretStoreError> {
            Ok(())
        }
        fn load(&self, _: &SecretSlot) -> Result<Option<SecretValue>, SecretStoreError> {
            match self {
                Self::MissingAfterSave => Ok(None),
                Self::WrongValue | Self::NoopDelete => {
                    Ok(Some(SecretValue::new("invalid-test-other".into())?))
                }
            }
        }
        fn delete(&self, _: &SecretSlot) -> Result<(), SecretStoreError> {
            Ok(())
        }
    }

    #[test]
    fn save_never_reports_success_for_missing_or_different_restored_value() {
        for backend in [BrokenStore::MissingAfterSave, BrokenStore::WrongValue] {
            let probe = SecretProbe::new(Arc::new(backend)).unwrap();
            assert_eq!(
                probe
                    .save(SecretValue::new("invalid-test-input".into()).unwrap())
                    .unwrap_err(),
                SecretStoreError::Corrupted
            );
        }
    }

    #[test]
    fn delete_does_not_report_success_if_the_backend_kept_the_value() {
        let probe = SecretProbe::new(Arc::new(BrokenStore::NoopDelete)).unwrap();
        assert_eq!(probe.delete().unwrap_err(), SecretStoreError::Corrupted);
    }

    #[test]
    fn frontend_status_serializes_only_a_boolean() {
        assert_eq!(
            serde_json::to_value(ProbeSecretStatus { configured: true }).unwrap(),
            serde_json::json!({"configured":true})
        );
    }

    #[test]
    fn owned_reservation_blocks_new_operations_before_worker_start() {
        let probe = SecretProbe::new(Arc::new(BrokenStore::MissingAfterSave)).unwrap();
        let queued = probe.reserve().unwrap();
        assert!(matches!(
            probe.reserve(),
            Err(SecretStoreError::Unavailable)
        ));
        assert_eq!(probe.status().unwrap_err(), SecretStoreError::Unavailable);
        assert_eq!(probe.delete().unwrap_err(), SecretStoreError::Unavailable);
        assert_eq!(
            probe
                .save(SecretValue::new("invalid-queued-test".into()).unwrap())
                .unwrap_err(),
            SecretStoreError::Unavailable
        );
        drop(queued); // A cancelled queue entry releases its owned reservation.
        assert!(!probe.status().unwrap().configured);
    }

    #[test]
    fn pending_operation_rejects_new_operations_until_it_really_finishes() {
        use std::sync::mpsc;
        struct PendingStore {
            entered: Mutex<Option<mpsc::Sender<()>>>,
            release: Mutex<mpsc::Receiver<()>>,
        }
        impl SecretStore for PendingStore {
            fn save(&self, _: &SecretSlot, _: &SecretValue) -> Result<(), SecretStoreError> {
                Ok(())
            }
            fn delete(&self, _: &SecretSlot) -> Result<(), SecretStoreError> {
                Ok(())
            }
            fn load(&self, _: &SecretSlot) -> Result<Option<SecretValue>, SecretStoreError> {
                if let Some(entered) = self.entered.lock().unwrap().take() {
                    entered.send(()).unwrap();
                    self.release.lock().unwrap().recv().unwrap();
                }
                Ok(None)
            }
        }
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let probe = Arc::new(
            SecretProbe::new(Arc::new(PendingStore {
                entered: Mutex::new(Some(entered_tx)),
                release: Mutex::new(release_rx),
            }))
            .unwrap(),
        );
        let running = Arc::clone(&probe);
        let worker = std::thread::spawn(move || running.status());
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        assert_eq!(probe.status().unwrap_err(), SecretStoreError::Unavailable);
        assert_eq!(probe.delete().unwrap_err(), SecretStoreError::Unavailable);
        assert_eq!(
            probe
                .save(SecretValue::new("invalid-pending-test".into()).unwrap())
                .unwrap_err(),
            SecretStoreError::Unavailable
        );
        release_tx.send(()).unwrap();
        assert!(!worker.join().unwrap().unwrap().configured);
        assert!(!probe.status().unwrap().configured);
    }
}
