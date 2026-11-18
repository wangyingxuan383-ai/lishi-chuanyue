-- Typed failures (R30, D166): why a run stopped, kept as a structured record
-- with the run, and every failed attempt kept in order so a retry does not
-- erase what happened before. error/error_kind stay for older readers.
ALTER TABLE execution_runs ADD COLUMN failure_json TEXT;
CREATE TABLE execution_failures(
  run_id TEXT NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  failure_json TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY(run_id, seq)
);
-- A passage of a sequence names its sequence in a column, not only inside
-- plan_json, so finding a sequence's passages no longer scans every run.
ALTER TABLE execution_runs ADD COLUMN parent_run TEXT;
UPDATE execution_runs SET parent_run=json_extract(plan_json,'$.meta.parentRun')
  WHERE json_extract(plan_json,'$.meta.parentRun') IS NOT NULL;
CREATE INDEX execution_runs_parent ON execution_runs(parent_run) WHERE parent_run IS NOT NULL;
