-- Story-owned adoption/source records outlive deletion of an Agent chat.
CREATE TABLE IF NOT EXISTS pi_commit_batches(
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL, world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
 line_id TEXT NOT NULL, intent_revision INTEGER NOT NULL, before_version TEXT NOT NULL,
 after_version TEXT NOT NULL, receipt_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pi_batches_task ON pi_commit_batches(task_id,created_at,id);
CREATE TABLE IF NOT EXISTS story_fact_sources(
 id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
 line_id TEXT NOT NULL, node_id TEXT, resource_kind TEXT NOT NULL, resource_id TEXT NOT NULL,
 batch_id TEXT NOT NULL, task_id TEXT NOT NULL, basis TEXT NOT NULL,
 claim TEXT NOT NULL, source_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fact_sources_world ON story_fact_sources(world_id,line_id,node_id);
CREATE TABLE IF NOT EXISTS database_maintenance(
 id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN(0,1)),
 epoch INTEGER NOT NULL, updated_at TEXT NOT NULL, expires_at_ms INTEGER NOT NULL DEFAULT 0
);
