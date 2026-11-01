-- Private capabilities and task-owned immutable resources; no credentials.
CREATE TABLE IF NOT EXISTS pi_commit_snapshots (
 batch_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES pi_tasks(id) ON DELETE CASCADE,
 world_version TEXT NOT NULL, snapshot_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_capability_grants (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, scope_json TEXT NOT NULL,
 mode TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_tool_packages (
 id TEXT PRIMARY KEY, package_id TEXT NOT NULL, version TEXT NOT NULL, hash TEXT NOT NULL,
 status TEXT NOT NULL, manifest_json TEXT NOT NULL, files_json TEXT NOT NULL,
 compatibility_json TEXT NOT NULL, created_at TEXT NOT NULL, task_id TEXT REFERENCES pi_tasks(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS pi_resource_snapshots (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES pi_tasks(id) ON DELETE CASCADE,
 world_id TEXT NOT NULL, kind TEXT NOT NULL, resource_key TEXT NOT NULL,
 version TEXT NOT NULL, data_json TEXT NOT NULL, source_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pi_resource_snapshot_task ON pi_resource_snapshots(task_id,kind,resource_key);
