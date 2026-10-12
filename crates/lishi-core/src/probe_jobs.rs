//! In-memory transport-probe coordination, independent of the native shell.
//! No game facts, URLs, credentials, or database records are stored here.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use serde::Serialize;

use crate::stream::{
    ProbeStreamEvent, StreamErrorCode, StreamEventKind, StreamResult, StreamStatus,
};
use crate::CancellationToken;

const HISTORY_LIMIT: usize = 10;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProbeJobState {
    Running,
    Completed,
    Cancelled,
    Failed,
}

impl From<StreamStatus> for ProbeJobState {
    fn from(status: StreamStatus) -> Self {
        match status {
            StreamStatus::Completed => Self::Completed,
            StreamStatus::Cancelled => Self::Cancelled,
            StreamStatus::Failed => Self::Failed,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeStreamSnapshot {
    pub operation_id: String,
    pub state: ProbeJobState,
    pub sequence: u64,
    pub text: String,
    pub delta_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<StreamErrorCode>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProbeCancelState {
    CancelRequested,
    Finished,
    NotFound,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeCancelReply {
    pub operation_id: String,
    pub state: ProbeCancelState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeJobError {
    Busy,
    Duplicate,
    InvalidId,
    Unavailable,
}

struct Job {
    cancel: CancellationToken,
    last_sequence: Option<u64>,
    snapshot: ProbeStreamSnapshot,
}

#[derive(Default)]
struct Jobs {
    active: Option<String>,
    records: HashMap<String, Job>,
    finished: VecDeque<String>,
}

#[derive(Default)]
pub struct ProbeJobs {
    inner: Mutex<Jobs>,
}

impl ProbeJobs {
    /// Reserves an ID before starting HTTP; rejected requests perform no I/O.
    pub fn register(&self, id: &str) -> Result<CancellationToken, ProbeJobError> {
        if !(8..=128).contains(&id.len())
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(ProbeJobError::InvalidId);
        }
        let mut jobs = self.inner.lock().map_err(|_| ProbeJobError::Unavailable)?;
        if jobs.records.contains_key(id) {
            return Err(ProbeJobError::Duplicate);
        }
        if jobs.active.is_some() {
            return Err(ProbeJobError::Busy);
        }
        let cancel = CancellationToken::new();
        jobs.records.insert(
            id.to_owned(),
            Job {
                cancel: cancel.clone(),
                last_sequence: None,
                snapshot: ProbeStreamSnapshot {
                    operation_id: id.to_owned(),
                    state: ProbeJobState::Running,
                    sequence: 0,
                    text: String::new(),
                    delta_count: 0,
                    error_code: None,
                },
            },
        );
        jobs.active = Some(id.to_owned());
        Ok(cancel)
    }

    /// Records reliable deltas before the shell sends them to a UI Channel.
    pub fn record_event(&self, event: &ProbeStreamEvent) -> bool {
        let Ok(mut jobs) = self.inner.lock() else {
            return false;
        };
        if jobs.active.as_deref() != Some(&event.operation_id) {
            return false;
        }
        let Some(job) = jobs.records.get_mut(&event.operation_id) else {
            return false;
        };
        let expected = match job.last_sequence {
            Some(sequence) => sequence.checked_add(1),
            None => Some(0),
        };
        if expected != Some(event.sequence) || job.snapshot.state != ProbeJobState::Running {
            return false;
        }
        if job.last_sequence.is_none() && event.kind != StreamEventKind::Started {
            return false;
        }
        match event.kind {
            StreamEventKind::Started => {
                if event.sequence != 0 {
                    return false;
                }
            }
            StreamEventKind::Delta => {
                let Some(text) = event.text.as_deref() else {
                    return false;
                };
                if job.snapshot.text.len().saturating_add(text.len()) > 256 * 1024 {
                    return false;
                }
                job.snapshot.text.push_str(text);
                job.snapshot.delta_count += 1;
            }
            StreamEventKind::Finished => {
                let Some(status) = event.status else {
                    return false;
                };
                job.snapshot.state = status.into();
                job.snapshot.error_code = event.error_code;
            }
        }
        job.last_sequence = Some(event.sequence);
        job.snapshot.sequence = event.sequence;
        true
    }

    /// The returned result is authoritative even if the UI Channel disappeared.
    pub fn finish(&self, result: &StreamResult) -> Result<(), ProbeJobError> {
        let mut jobs = self.inner.lock().map_err(|_| ProbeJobError::Unavailable)?;
        if jobs.active.as_deref() != Some(&result.operation_id) {
            return Err(ProbeJobError::Unavailable);
        }
        let job = jobs
            .records
            .get_mut(&result.operation_id)
            .ok_or(ProbeJobError::Unavailable)?;
        job.snapshot.state = result.status.into();
        job.snapshot.text = result.text.clone();
        job.snapshot.delta_count = result.delta_count;
        job.snapshot.error_code = result.error_code;
        jobs.active = None;
        jobs.finished.push_back(result.operation_id.clone());
        while jobs.finished.len() > HISTORY_LIMIT {
            if let Some(id) = jobs.finished.pop_front() {
                jobs.records.remove(&id);
            }
        }
        Ok(())
    }

    pub fn cancel(&self, id: &str) -> Result<ProbeCancelReply, ProbeJobError> {
        let jobs = self.inner.lock().map_err(|_| ProbeJobError::Unavailable)?;
        let state = match jobs.records.get(id) {
            None => ProbeCancelState::NotFound,
            Some(job) if job.snapshot.state != ProbeJobState::Running => ProbeCancelState::Finished,
            Some(job) => {
                job.cancel.cancel();
                ProbeCancelState::CancelRequested
            }
        };
        Ok(ProbeCancelReply {
            operation_id: id.to_owned(),
            state,
        })
    }

    /// None identifies the active job during UI re-mount, without another HTTP call.
    pub fn snapshot(&self, id: Option<&str>) -> Result<Option<ProbeStreamSnapshot>, ProbeJobError> {
        let jobs = self.inner.lock().map_err(|_| ProbeJobError::Unavailable)?;
        let id = id.or(jobs.active.as_deref());
        Ok(id
            .and_then(|id| jobs.records.get(id))
            .map(|job| job.snapshot.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(id: &str, status: StreamStatus) -> StreamResult {
        StreamResult {
            operation_id: id.into(),
            status,
            error_code: None,
            text: "草稿".into(),
            delta_count: 1,
        }
    }

    #[test]
    fn reservation_prevents_duplicate_and_parallel_requests() {
        let jobs = ProbeJobs::default();
        assert_eq!(jobs.register("bad").unwrap_err(), ProbeJobError::InvalidId);
        jobs.register("operation-one").unwrap();
        assert_eq!(
            jobs.register("operation-one").unwrap_err(),
            ProbeJobError::Duplicate
        );
        assert_eq!(
            jobs.register("operation-two").unwrap_err(),
            ProbeJobError::Busy
        );
        assert_eq!(
            jobs.snapshot(None).unwrap().unwrap().operation_id,
            "operation-one"
        );
        jobs.finish(&result("operation-one", StreamStatus::Completed))
            .unwrap();
        assert_eq!(
            jobs.register("operation-one").unwrap_err(),
            ProbeJobError::Duplicate
        );
        assert!(jobs.register("operation-two").is_ok());
    }

    #[test]
    fn cancelling_requests_a_stop_but_does_not_invent_a_terminal_state() {
        let jobs = ProbeJobs::default();
        let token = jobs.register("operation-one").unwrap();
        assert_eq!(
            jobs.cancel("operation-one").unwrap().state,
            ProbeCancelState::CancelRequested
        );
        assert!(token.is_cancelled());
        assert_eq!(
            jobs.snapshot(None).unwrap().unwrap().state,
            ProbeJobState::Running
        );
        jobs.finish(&result("operation-one", StreamStatus::Completed))
            .unwrap();
        assert_eq!(
            jobs.cancel("operation-one").unwrap().state,
            ProbeCancelState::Finished
        );
        assert_eq!(
            jobs.snapshot(Some("operation-one")).unwrap().unwrap().state,
            ProbeJobState::Completed
        );
        assert_eq!(
            jobs.cancel("missing-operation").unwrap().state,
            ProbeCancelState::NotFound
        );
    }

    #[test]
    fn stale_events_do_not_modify_other_jobs_and_finished_history_is_bounded() {
        let jobs = ProbeJobs::default();
        for index in 0..12 {
            let id = format!("operation-{index:02}");
            jobs.register(&id).unwrap();
            jobs.finish(&result(&id, StreamStatus::Completed)).unwrap();
        }
        assert!(jobs.snapshot(Some("operation-00")).unwrap().is_none());
        assert!(jobs.snapshot(Some("operation-02")).unwrap().is_some());
        jobs.register("new-operation").unwrap();
        let stale = ProbeStreamEvent {
            operation_id: "operation-11".into(),
            sequence: 0,
            kind: StreamEventKind::Started,
            text: None,
            status: None,
            error_code: None,
        };
        assert!(!jobs.record_event(&stale));
        assert_eq!(jobs.snapshot(None).unwrap().unwrap().text, "");
    }
}
