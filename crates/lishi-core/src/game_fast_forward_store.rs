//! Same-world job metadata. Formal turns and segment progress commit in the
//! branch store's one short transaction; no network belongs in this module.
use super::*;
use crate::game_fast_forward::*;

fn int(value: u64) -> Result<i64, GameStoreError> {
    i64::try_from(value).map_err(|_| GameStoreError::RevisionOverflow)
}
fn bump(value: u64) -> Result<u64, GameStoreError> {
    value
        .checked_add(1)
        .filter(|value| *value <= 9_007_199_254_740_991)
        .ok_or(GameStoreError::RevisionOverflow)
}
fn job_status(status: FastForwardStatus) -> &'static str {
    match status {
        FastForwardStatus::Ready => "ready",
        FastForwardStatus::Running => "running",
        FastForwardStatus::PausedDecision => "paused_decision",
        FastForwardStatus::SegmentLimit => "segment_limit",
        FastForwardStatus::Completed => "completed",
        FastForwardStatus::Cancelled => "cancelled",
        FastForwardStatus::Interrupted => "interrupted",
        FastForwardStatus::Failed => "failed",
    }
}
fn exists(db: &Connection) -> Result<bool, GameStoreError> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='game_fast_forward_schema')",
        [],
        |row| row.get(0),
    )?)
}
fn require_backend(db: &Connection) -> Result<(), GameStoreError> {
    if !branches::enabled(db)? || !exists(db)? {
        return Err(GameStoreError::IncompatibleSchema);
    }
    let version: i64 = db.query_row(
        "SELECT version FROM game_fast_forward_schema WHERE id=1",
        [],
        |row| row.get(0),
    )?;
    if version != 1
        || db.query_row("SELECT count(*) FROM game_fast_forward_schema", [], |row| {
            row.get::<_, i64>(0)
        })? != 1
    {
        return Err(GameStoreError::IncompatibleSchema);
    }
    for (name, trigger) in [
        ("game_fast_forward_schema", false),
        ("game_fast_forward_jobs", false),
        ("game_fast_forward_segments", false),
        ("fast_forward_job_origin_immutable", true),
        ("fast_forward_job_no_delete", true),
        ("fast_forward_segment_origin_immutable", true),
        ("fast_forward_segment_no_delete", true),
    ] {
        let actual: Option<String> = db
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name=?1",
                [name],
                |row| row.get(0),
            )
            .optional()?;
        let marker = format!(
            "CREATE {} {name}",
            if trigger { "TRIGGER" } else { "TABLE" }
        );
        let offset = FAST_FORWARD_SCHEMA
            .find(&marker)
            .ok_or(GameStoreError::IncompatibleSchema)?;
        let suffix = &FAST_FORWARD_SCHEMA[offset..];
        let end = suffix
            .find(if trigger { " END;" } else { ") STRICT;" })
            .ok_or(GameStoreError::IncompatibleSchema)?;
        let expected = &suffix[..end + if trigger { 4 } else { 8 }];
        let normalize = |value: &str| {
            value
                .chars()
                .filter(|c| !c.is_ascii_whitespace() && *c != ';')
                .collect::<String>()
                .to_ascii_lowercase()
        };
        if actual.as_deref().map(normalize) != Some(normalize(expected)) {
            return Err(GameStoreError::IncompatibleSchema);
        }
    }
    Ok(())
}
fn read_job(db: &Connection, id: &str) -> Result<FastForwardJob, GameStoreError> {
    if !valid_game_id(id) {
        return Err(GameStoreError::InvalidRequest);
    }
    let raw: String = db
        .query_row(
            "SELECT record FROM game_fast_forward_jobs WHERE job_id=?1",
            [id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or(GameStoreError::NotFound)?;
    let job: FastForwardJob = decode(&raw)?;
    validate_job(&job)?;
    let matches:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM game_fast_forward_jobs WHERE job_id=?1 AND world_id=?2 AND branch_id=?3 AND start_head_turn_id IS ?4 AND start_elapsed_seconds=?5 AND target_elapsed_seconds=?6 AND max_segment_seconds=?7 AND focus=?8 AND created_at_ms=?9 AND status=?10 AND active_operation_id IS ?11 AND revision=?12 AND head_turn_id IS ?13 AND elapsed_seconds=?14)",
        params![id,job.world_id,job.branch_id,job.start_head_turn_id,int(job.start_elapsed_seconds)?,int(job.target_elapsed_seconds)?,int(job.max_segment_seconds)?,job.focus,job.created_at_ms,job_status(job.status),job.active_operation_id,int(job.revision)?,job.head_turn_id,int(job.elapsed_seconds)?],|row|row.get(0))?;
    let origin:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM game_branch_controls WHERE operation_id=?1 AND branch_id=?2 AND kind='fast_forward_start')",params![id,job.branch_id],|row|row.get(0))?;
    if job.job_id != id
        || !matches
        || !origin
        || job
            .last_error
            .as_deref()
            .is_some_and(|code| !safe_error_code(code))
    {
        return Err(GameStoreError::Database);
    }
    Ok(job)
}
fn write_job(db: &Connection, job: &FastForwardJob) -> Result<(), GameStoreError> {
    validate_job(job)?;
    if db.execute("UPDATE game_fast_forward_jobs SET status=?2,active_operation_id=?3,revision=?4,head_turn_id=?5,elapsed_seconds=?6,record=?7 WHERE job_id=?1",params![job.job_id,job_status(job.status),job.active_operation_id,int(job.revision)?,job.head_turn_id,int(job.elapsed_seconds)?,json(job)?])?!=1{return Err(GameStoreError::NotFound);}
    Ok(())
}
fn read_segment(db: &Connection, id: &str) -> Result<FastForwardSegmentRecord, GameStoreError> {
    let raw: String = db
        .query_row(
            "SELECT record FROM game_fast_forward_segments WHERE operation_id=?1",
            [id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or(GameStoreError::NotFound)?;
    let record: FastForwardSegmentRecord = decode(&raw)?;
    validate_usage(&record.usage).map_err(|_| GameStoreError::Database)?;
    if record.operation_id != id
        || !valid_game_id(&record.job_id)
        || record.prompt_version != FAST_FORWARD_PROMPT_VERSION
        || record.model_requests_reserved > MAX_SEGMENT_MODEL_REQUESTS
        || record.created_at_ms < 0
        || record.finished_at_ms.is_some_and(|time| time < 0)
        || (record.status.is_active() == record.finished_at_ms.is_some())
        || record
            .last_error
            .as_deref()
            .is_some_and(|code| !safe_error_code(code))
    {
        return Err(GameStoreError::Database);
    }
    if !db.query_row("SELECT EXISTS(SELECT 1 FROM game_fast_forward_segments WHERE operation_id=?1 AND job_id=?2 AND status=?3 AND model_requests_reserved=?4)",params![id,record.job_id,status_name(record.status),record.model_requests_reserved],|row|row.get::<_,bool>(0))? {return Err(GameStoreError::Database);}
    Ok(record)
}
fn write_segment(db: &Connection, record: &FastForwardSegmentRecord) -> Result<(), GameStoreError> {
    validate_usage(&record.usage)?;
    if db.execute("UPDATE game_fast_forward_segments SET status=?2,model_requests_reserved=?3,record=?4 WHERE operation_id=?1",params![record.operation_id,status_name(record.status),record.model_requests_reserved,json(record)?])?!=1{return Err(GameStoreError::NotFound);}
    Ok(())
}
fn active(db: &Connection) -> Result<(), GameStoreError> {
    if db.query_row("SELECT EXISTS(SELECT 1 FROM game_operations WHERE status IN ('pending','generating','validating'))",[],|row|row.get::<_,bool>(0))?{Err(GameStoreError::Busy)}else{Ok(())}
}
fn unique(db: &Connection, id: &str) -> Result<(), GameStoreError> {
    if !valid_game_id(id) {
        return Err(GameStoreError::InvalidRequest);
    }
    if db.query_row("SELECT EXISTS(SELECT 1 FROM game_operations WHERE operation_id=?1) OR EXISTS(SELECT 1 FROM game_branch_controls WHERE operation_id=?1)",[id],|row|row.get::<_,bool>(0))?{return Err(GameStoreError::Duplicate);}
    Ok(())
}
fn check_world(
    db: &Connection,
    world: &str,
    branch: &str,
    head: Option<&str>,
) -> Result<WorldViewV2, GameStoreError> {
    let view = branches::read_context(db, branch)?.view;
    let archived: bool = db.query_row(
        "SELECT archived FROM game_branches WHERE branch_id=?1",
        [branch],
        |row| row.get(0),
    )?;
    if view.setup.world_id != world || archived {
        return Err(GameStoreError::InvalidRequest);
    }
    if view.head_turn_id.as_deref() != head {
        return Err(GameStoreError::StaleHead);
    }
    Ok(view)
}
fn terminalize(
    db: &Connection,
    id: &str,
    status: GameOperationStatus,
    code: Option<&str>,
) -> Result<FastForwardJob, GameStoreError> {
    if !matches!(
        status,
        GameOperationStatus::Failed
            | GameOperationStatus::Cancelled
            | GameOperationStatus::Interrupted
    ) || code.is_some_and(|code| !safe_error_code(code))
    {
        return Err(GameStoreError::InvalidRequest);
    }
    let mut record = read_segment(db, id)?;
    let mut job = read_job(db, &record.job_id)?;
    let operation = read_operation(db, id)?.ok_or(GameStoreError::NotFound)?;
    if job.status != FastForwardStatus::Running
        || job.active_operation_id.as_deref() != Some(id)
        || !record.status.is_active()
        || operation.status == GameOperationStatus::Committed
    {
        return Err(GameStoreError::InvalidTransition);
    }
    if !operation.status.is_active() && operation.status != status {
        return Err(GameStoreError::InvalidTransition);
    }
    db.execute(
        "UPDATE game_operations SET status=?2,candidate=NULL,error_code=?3 WHERE operation_id=?1",
        params![id, status_name(status), code],
    )?;
    db.execute(
        "UPDATE game_fast_forward_segments SET candidate=NULL WHERE operation_id=?1",
        [id],
    )?;
    record.status = status;
    record.last_error = code.map(str::to_owned);
    record.finished_at_ms = Some(now_ms()?);
    write_segment(db, &record)?;
    job.status = match status {
        GameOperationStatus::Cancelled => FastForwardStatus::Cancelled,
        GameOperationStatus::Failed => FastForwardStatus::Failed,
        _ => FastForwardStatus::Interrupted,
    };
    job.active_operation_id = None;
    job.last_error = code.map(str::to_owned);
    job.updated_at_ms = now_ms()?;
    job.revision = bump(job.revision)?;
    write_job(db, &job)?;
    Ok(job)
}

impl GameStoreV2 {
    /// Explicit writer action, never called by discovery or job listing. Adds
    /// no formal facts and leaves the existing schema3 migration receipt alone.
    pub fn ensure_fast_forward_backend(&self) -> Result<(), GameStoreError> {
        let mut db = self.connection()?;
        if !branches::enabled(&db)? {
            return Err(GameStoreError::IncompatibleSchema);
        }
        if exists(&db)? {
            return require_backend(&db);
        }
        if db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name LIKE 'game_fast_forward_%')",
            [],
            |row| row.get::<_, bool>(0),
        )? {
            return Err(GameStoreError::IncompatibleSchema);
        }
        active(&db)?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(FAST_FORWARD_SCHEMA)?;
        require_backend(&tx)?;
        tx.commit()?;
        Ok(())
    }
    pub fn start_fast_forward(
        &self,
        r: &StartFastForwardRequest,
    ) -> Result<FastForwardJob, GameStoreError> {
        if !valid_game_id(&r.world_id)
            || !branch_id(&r.branch_id)
            || !plain(&r.focus, MAX_FAST_FORWARD_FOCUS_BYTES, true)
            || r.max_segment_seconds == 0
            || r.max_segment_seconds > crate::game_protocol::MAX_ELAPSED_SECONDS
            || r.target_elapsed_seconds > crate::game_protocol::MAX_ELAPSED_SECONDS
        {
            return Err(GameStoreError::InvalidRequest);
        }
        let mut db = self.connection()?;
        require_backend(&db)?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        active(&tx)?;
        unique(&tx, &r.job_id)?;
        let view = check_world(
            &tx,
            &r.world_id,
            &r.branch_id,
            r.expected_head_turn_id.as_deref(),
        )?;
        if r.target_elapsed_seconds <= view.state.time.elapsed_seconds
            || view
                .state
                .entities
                .iter()
                .find(|entity| entity.id == view.state.protagonist_id)
                .is_none_or(|entity| entity.alive != Some(true))
        {
            return Err(GameStoreError::InvalidRequest);
        }
        let timestamp = now_ms()?;
        let job = FastForwardJob {
            job_id: r.job_id.clone(),
            world_id: r.world_id.clone(),
            branch_id: r.branch_id.clone(),
            start_head_turn_id: view.head_turn_id.clone(),
            head_turn_id: view.head_turn_id,
            start_elapsed_seconds: view.state.time.elapsed_seconds,
            elapsed_seconds: view.state.time.elapsed_seconds,
            target_elapsed_seconds: r.target_elapsed_seconds,
            max_segment_seconds: r.max_segment_seconds,
            focus: r.focus.clone(),
            status: FastForwardStatus::Ready,
            revision: 0,
            segments_committed: 0,
            model_requests_reserved: 0,
            active_operation_id: None,
            decision: None,
            last_error: None,
            created_at_ms: timestamp,
            updated_at_ms: timestamp,
        };
        validate_job(&job)?;
        tx.execute("INSERT INTO game_branch_controls(operation_id,branch_id,kind,created_at_ms) VALUES(?1,?2,'fast_forward_start',?3)",params![job.job_id,job.branch_id,timestamp])?;
        tx.execute("INSERT INTO game_fast_forward_jobs(job_id,world_id,branch_id,start_head_turn_id,start_elapsed_seconds,target_elapsed_seconds,max_segment_seconds,focus,created_at_ms,status,active_operation_id,revision,head_turn_id,elapsed_seconds,record) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'ready',NULL,0,?4,?5,?10)",params![job.job_id,job.world_id,job.branch_id,job.start_head_turn_id,int(job.start_elapsed_seconds)?,int(job.target_elapsed_seconds)?,int(job.max_segment_seconds)?,job.focus,timestamp,json(&job)?])?;
        tx.commit()?;
        Ok(job)
    }
    pub fn get_fast_forward_job(&self, id: &str) -> Result<FastForwardJob, GameStoreError> {
        let db = self.connection()?;
        require_backend(&db)?;
        read_job(&db, id)
    }
    pub fn list_fast_forward_jobs(
        &self,
        branch: &str,
    ) -> Result<Vec<FastForwardJob>, GameStoreError> {
        let db = self.connection()?;
        if !exists(&db)? {
            return Ok(vec![]);
        }
        require_backend(&db)?;
        branches::read_context(&db, branch)?;
        let mut statement=db.prepare("SELECT job_id FROM game_fast_forward_jobs WHERE branch_id=?1 ORDER BY created_at_ms DESC,job_id DESC LIMIT 64")?;
        let ids = statement
            .query_map([branch], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.iter().map(|id| read_job(&db, id)).collect()
    }
    pub fn fast_forward_segments(
        &self,
        job_id: &str,
    ) -> Result<Vec<FastForwardSegmentRecord>, GameStoreError> {
        let db = self.connection()?;
        require_backend(&db)?;
        read_job(&db, job_id)?;
        let mut statement=db.prepare("SELECT operation_id FROM game_fast_forward_segments WHERE job_id=?1 ORDER BY rowid DESC LIMIT 128")?;
        let ids = statement
            .query_map([job_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.iter().map(|id| read_segment(&db, id)).collect()
    }
    pub fn begin_fast_forward_segment(
        &self,
        r: &ContinueFastForwardRequest,
    ) -> Result<FastForwardSegmentStart, GameStoreError> {
        let mut db = self.connection()?;
        require_backend(&db)?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        active(&tx)?;
        unique(&tx, &r.operation_id)?;
        let mut job = read_job(&tx, &r.job_id)?;
        if job.world_id != r.world_id || job.branch_id != r.branch_id {
            return Err(GameStoreError::InvalidRequest);
        }
        if job.revision != r.expected_job_revision || job.head_turn_id != r.expected_head_turn_id {
            return Err(GameStoreError::StaleHead);
        }
        if !matches!(
            job.status,
            FastForwardStatus::Ready
                | FastForwardStatus::SegmentLimit
                | FastForwardStatus::Interrupted
                | FastForwardStatus::Cancelled
                | FastForwardStatus::Failed
        ) || job.decision.is_some()
        {
            return Err(GameStoreError::InvalidTransition);
        }
        let view = check_world(
            &tx,
            &r.world_id,
            &r.branch_id,
            r.expected_head_turn_id.as_deref(),
        )?;
        if view.state.time.elapsed_seconds != job.elapsed_seconds {
            return Err(GameStoreError::StaleHead);
        }
        if view
            .state
            .entities
            .iter()
            .find(|entity| entity.id == view.state.protagonist_id)
            .is_none_or(|entity| entity.alive != Some(true))
        {
            return Err(GameStoreError::InvalidRequest);
        }
        let request = GameTurnRequest {
            world_id: r.world_id.clone(),
            branch_id: r.branch_id.clone(),
            operation_id: r.operation_id.clone(),
            expected_head_turn_id: r.expected_head_turn_id.clone(),
            action_kind: GameActionKind::Action,
            action_text: fast_forward_action(&job)?,
        };
        let timestamp = now_ms()?;
        tx.execute("INSERT INTO game_operations(operation_id,expected_head_turn_id,action_kind,action_text,status,candidate,error_code,created_at_ms) VALUES(?1,?2,'action',?3,'pending',NULL,NULL,?4)",params![request.operation_id,request.expected_head_turn_id,request.action_text,timestamp])?;
        tx.execute(
            "INSERT INTO game_operation_branches VALUES(?1,?2)",
            params![request.operation_id, request.branch_id],
        )?;
        let record = FastForwardSegmentRecord {
            operation_id: r.operation_id.clone(),
            job_id: r.job_id.clone(),
            status: GameOperationStatus::Pending,
            model_requests_reserved: 0,
            usage: FastForwardUsage::default(),
            prompt_version: FAST_FORWARD_PROMPT_VERSION,
            stop_reason: None,
            created_at_ms: timestamp,
            finished_at_ms: None,
            last_error: None,
        };
        tx.execute("INSERT INTO game_fast_forward_segments(operation_id,job_id,status,model_requests_reserved,record,candidate) VALUES(?1,?2,'pending',0,?3,NULL)",params![r.operation_id,r.job_id,json(&record)?])?;
        job.status = FastForwardStatus::Running;
        job.active_operation_id = Some(r.operation_id.clone());
        job.last_error = None;
        job.revision = bump(job.revision)?;
        job.updated_at_ms = timestamp;
        write_job(&tx, &job)?;
        tx.commit()?;
        Ok(FastForwardSegmentStart { job, request })
    }
    pub fn reserve_fast_forward_model_request(
        &self,
        id: &str,
    ) -> Result<FastForwardJob, GameStoreError> {
        let mut db = self.connection()?;
        require_backend(&db)?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut record = read_segment(&tx, id)?;
        let mut job = read_job(&tx, &record.job_id)?;
        let op = read_operation(&tx, id)?.ok_or(GameStoreError::NotFound)?;
        if job.active_operation_id.as_deref() != Some(id)
            || job.status != FastForwardStatus::Running
            || !matches!(
                op.status,
                GameOperationStatus::Pending | GameOperationStatus::Generating
            )
            || record.model_requests_reserved >= MAX_SEGMENT_MODEL_REQUESTS
        {
            return Err(GameStoreError::InvalidTransition);
        }
        record.model_requests_reserved += 1;
        write_segment(&tx, &record)?;
        job.model_requests_reserved = bump(job.model_requests_reserved)?;
        job.revision = bump(job.revision)?;
        job.updated_at_ms = now_ms()?;
        write_job(&tx, &job)?;
        tx.commit()?;
        Ok(job)
    }
    pub fn record_fast_forward_usage(
        &self,
        id: &str,
        usage: FastForwardUsage,
    ) -> Result<(), GameStoreError> {
        validate_usage(&usage)?;
        let mut db = self.connection()?;
        require_backend(&db)?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut record = read_segment(&tx, id)?;
        if record.model_requests_reserved != 1
            || (record.usage != FastForwardUsage::default() && record.usage != usage)
        {
            return Err(GameStoreError::InvalidTransition);
        }
        record.usage = usage;
        write_segment(&tx, &record)?;
        tx.commit()?;
        Ok(())
    }
    pub fn stage_fast_forward_segment(
        &self,
        id: &str,
        segment: &FastForwardSegment,
    ) -> Result<(), GameStoreError> {
        let mut db = self.connection()?;
        require_backend(&db)?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut record = read_segment(&tx, id)?;
        let job = read_job(&tx, &record.job_id)?;
        let view = check_world(
            &tx,
            &job.world_id,
            &job.branch_id,
            job.head_turn_id.as_deref(),
        )?;
        validate_fast_forward_segment(&job, id, &view.state, segment)?;
        let raw = json(segment)?;
        if raw.len() > MAX_CANDIDATE_BYTES {
            return Err(GameStoreError::InvalidOutput);
        }
        if tx.execute("UPDATE game_operations SET status='validating',candidate=?2 WHERE operation_id=?1 AND status='generating'",params![id,json(&segment.output)?])?!=1{return Err(GameStoreError::InvalidTransition);}
        record.status = GameOperationStatus::Validating;
        record.stop_reason = Some(segment.stop_reason);
        write_segment(&tx, &record)?;
        tx.execute(
            "UPDATE game_fast_forward_segments SET candidate=?2 WHERE operation_id=?1",
            params![id, raw],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn commit_fast_forward_segment_with_hook<F: FnOnce() -> Result<(), GameStoreError>>(
        &self,
        id: &str,
        segment: &FastForwardSegment,
        before_commit: F,
    ) -> Result<FastForwardCommit, GameStoreError> {
        let (job, record, status) = {
            let db = self.connection()?;
            require_backend(&db)?;
            let record = read_segment(&db, id)?;
            let job = read_job(&db, &record.job_id)?;
            let view = check_world(
                &db,
                &job.world_id,
                &job.branch_id,
                job.head_turn_id.as_deref(),
            )?;
            let status = validate_fast_forward_segment(&job, id, &view.state, segment)?;
            let candidate: Option<String> = db.query_row(
                "SELECT candidate FROM game_fast_forward_segments WHERE operation_id=?1",
                [id],
                |row| row.get(0),
            )?;
            if record.status != GameOperationStatus::Validating
                || parse_fast_forward_segment(
                    candidate
                        .as_deref()
                        .ok_or(GameStoreError::InvalidTransition)?,
                )? != *segment
            {
                return Err(GameStoreError::InvalidOutput);
            }
            (job, record, status)
        };
        let mut committed_job = None;
        let world = self.commit_branch_with_transaction_hook(id, &segment.output, |tx| {
            before_commit()?;
            if read_job(tx, &job.job_id)? != job || read_segment(tx, id)? != record {
                return Err(GameStoreError::StaleHead);
            }
            let mut next = job.clone();
            next.head_turn_id = Some(id.into());
            next.elapsed_seconds = next
                .elapsed_seconds
                .checked_add(segment.output.time_advance.elapsed_seconds)
                .ok_or(GameStoreError::RevisionOverflow)?;
            next.status = status;
            next.active_operation_id = None;
            next.decision = segment.decision.clone();
            next.last_error = None;
            next.segments_committed = bump(next.segments_committed)?;
            next.revision = bump(next.revision)?;
            next.updated_at_ms = now_ms()?;
            write_job(tx, &next)?;
            let mut completed = record.clone();
            completed.status = GameOperationStatus::Committed;
            completed.finished_at_ms = Some(now_ms()?);
            write_segment(tx, &completed)?;
            tx.execute(
                "UPDATE game_fast_forward_segments SET candidate=NULL WHERE operation_id=?1",
                [id],
            )?;
            committed_job = Some(next);
            Ok(())
        })?;
        Ok(FastForwardCommit {
            job: committed_job.ok_or(GameStoreError::Database)?,
            world,
        })
    }
    pub fn commit_fast_forward_segment(
        &self,
        id: &str,
        segment: &FastForwardSegment,
    ) -> Result<FastForwardCommit, GameStoreError> {
        self.commit_fast_forward_segment_with_hook(id, segment, || Ok(()))
    }
    pub fn finish_fast_forward_segment(
        &self,
        id: &str,
        status: GameOperationStatus,
        code: Option<&str>,
    ) -> Result<FastForwardJob, GameStoreError> {
        let mut db = self.connection()?;
        require_backend(&db)?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let job = terminalize(&tx, id, status, code)?;
        tx.commit()?;
        Ok(job)
    }
    pub fn cancel_fast_forward_job(
        &self,
        id: &str,
        expected_revision: u64,
    ) -> Result<FastForwardJob, GameStoreError> {
        let mut db = self.connection()?;
        require_backend(&db)?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut job = read_job(&tx, id)?;
        if job.revision != expected_revision {
            return Err(GameStoreError::StaleHead);
        }
        if matches!(
            job.status,
            FastForwardStatus::Completed | FastForwardStatus::Cancelled
        ) {
            return Err(GameStoreError::InvalidTransition);
        }
        if let Some(op) = job.active_operation_id.clone() {
            job = terminalize(
                &tx,
                &op,
                GameOperationStatus::Cancelled,
                Some("game_cancelled"),
            )?;
        } else {
            job.status = FastForwardStatus::Cancelled;
            job.last_error = Some("game_cancelled".into());
            job.revision = bump(job.revision)?;
            job.updated_at_ms = now_ms()?;
            write_job(&tx, &job)?;
        }
        tx.commit()?;
        Ok(job)
    }
    pub fn resume_fast_forward_after_decision(
        &self,
        r: &DecisionResumeRequest,
    ) -> Result<FastForwardJob, GameStoreError> {
        let mut db = self.connection()?;
        require_backend(&db)?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        active(&tx)?;
        let mut job = read_job(&tx, &r.job_id)?;
        if job.world_id != r.world_id || job.branch_id != r.branch_id {
            return Err(GameStoreError::InvalidRequest);
        }
        if job.revision != r.expected_job_revision {
            return Err(GameStoreError::StaleHead);
        }
        if !matches!(
            job.status,
            FastForwardStatus::PausedDecision | FastForwardStatus::Cancelled
        ) || job.decision.is_none()
        {
            return Err(GameStoreError::InvalidTransition);
        }
        let view = check_world(&tx, &r.world_id, &r.branch_id, Some(&r.decision_turn_id))?;
        let parent: Option<String> = tx.query_row(
            "SELECT parent_turn_id FROM game_turns WHERE turn_id=?1",
            [&r.decision_turn_id],
            |row| row.get(0),
        )?;
        let operation =
            read_operation(&tx, &r.decision_turn_id)?.ok_or(GameStoreError::NotFound)?;
        let op_branch: String = tx.query_row(
            "SELECT branch_id FROM game_operation_branches WHERE operation_id=?1",
            [&r.decision_turn_id],
            |row| row.get(0),
        )?;
        if parent != job.head_turn_id
            || operation.status != GameOperationStatus::Committed
            || operation.action_kind != GameActionKind::Action
            || op_branch != job.branch_id
            || tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM game_fast_forward_segments WHERE operation_id=?1)",
                [&r.decision_turn_id],
                |row| row.get::<_, bool>(0),
            )?
        {
            return Err(GameStoreError::InvalidRequest);
        }
        job.head_turn_id = Some(r.decision_turn_id.clone());
        job.elapsed_seconds = view.state.time.elapsed_seconds;
        job.decision = None;
        let protagonist_dead = view
            .state
            .entities
            .iter()
            .find(|entity| entity.id == view.state.protagonist_id)
            .is_none_or(|entity| entity.alive != Some(true));
        job.status = if job.elapsed_seconds >= job.target_elapsed_seconds {
            FastForwardStatus::Completed
        } else if protagonist_dead {
            FastForwardStatus::Cancelled
        } else {
            FastForwardStatus::Ready
        };
        job.last_error = if protagonist_dead && job.status == FastForwardStatus::Cancelled {
            Some("game_protagonist_dead".into())
        } else {
            None
        };
        job.revision = bump(job.revision)?;
        job.updated_at_ms = now_ms()?;
        write_job(&tx, &job)?;
        tx.commit()?;
        Ok(job)
    }
    /// Called explicitly by the owner after opening/recovering formal rows.
    /// A missing backend remains missing; process recovery never creates it.
    pub fn recover_fast_forward_jobs(&self) -> Result<u64, GameStoreError> {
        let mut db = self.connection()?;
        if !exists(&db)? {
            return Ok(0);
        }
        require_backend(&db)?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut statement = tx.prepare(
            "SELECT active_operation_id FROM game_fast_forward_jobs WHERE status='running'",
        )?;
        let ids = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        for id in &ids {
            let operation = read_operation(&tx, id)?.ok_or(GameStoreError::Database)?;
            let status = if operation.status.is_active() {
                GameOperationStatus::Interrupted
            } else {
                operation.status
            };
            let code = if status == GameOperationStatus::Interrupted {
                Some("process_interrupted")
            } else {
                operation.error_code.as_deref()
            };
            terminalize(&tx, id, status, code)?;
        }
        tx.commit()?;
        Ok(ids.len() as u64)
    }
}

pub const FAST_FORWARD_SCHEMA:&str="
CREATE TABLE game_fast_forward_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL CHECK(version=1)) STRICT;
INSERT INTO game_fast_forward_schema VALUES(1,1);
CREATE TABLE game_fast_forward_jobs(job_id TEXT PRIMARY KEY REFERENCES game_branch_controls(operation_id),world_id TEXT NOT NULL,branch_id TEXT NOT NULL REFERENCES game_branches(branch_id),start_head_turn_id TEXT REFERENCES game_turns(turn_id),start_elapsed_seconds INTEGER NOT NULL,target_elapsed_seconds INTEGER NOT NULL,max_segment_seconds INTEGER NOT NULL,focus TEXT NOT NULL,created_at_ms INTEGER NOT NULL,status TEXT NOT NULL,active_operation_id TEXT REFERENCES game_operations(operation_id),revision INTEGER NOT NULL,head_turn_id TEXT REFERENCES game_turns(turn_id),elapsed_seconds INTEGER NOT NULL,record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
CREATE TABLE game_fast_forward_segments(operation_id TEXT PRIMARY KEY REFERENCES game_operations(operation_id),job_id TEXT NOT NULL REFERENCES game_fast_forward_jobs(job_id),status TEXT NOT NULL,model_requests_reserved INTEGER NOT NULL CHECK(model_requests_reserved BETWEEN 0 AND 1),record TEXT NOT NULL CHECK(json_valid(record)),candidate TEXT CHECK(candidate IS NULL OR json_valid(candidate))) STRICT;
CREATE TRIGGER fast_forward_job_origin_immutable BEFORE UPDATE OF job_id,world_id,branch_id,start_head_turn_id,start_elapsed_seconds,target_elapsed_seconds,max_segment_seconds,focus,created_at_ms ON game_fast_forward_jobs BEGIN SELECT RAISE(ABORT,'immutable fast-forward origin'); END;
CREATE TRIGGER fast_forward_job_no_delete BEFORE DELETE ON game_fast_forward_jobs BEGIN SELECT RAISE(ABORT,'preserve fast-forward progress'); END;
CREATE TRIGGER fast_forward_segment_origin_immutable BEFORE UPDATE OF operation_id,job_id ON game_fast_forward_segments BEGIN SELECT RAISE(ABORT,'immutable fast-forward segment'); END;
CREATE TRIGGER fast_forward_segment_no_delete BEFORE DELETE ON game_fast_forward_segments BEGIN SELECT RAISE(ABORT,'preserve fast-forward segment'); END;
";
