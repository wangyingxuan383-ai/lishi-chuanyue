CREATE TABLE IF NOT EXISTS execution_runs(
 id TEXT PRIMARY KEY, world_id TEXT NOT NULL, line_id TEXT NOT NULL, base_head_id TEXT NOT NULL,
 status TEXT NOT NULL, plan_json TEXT NOT NULL, budget_json TEXT NOT NULL, draft_json TEXT NOT NULL,
 result_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS execution_world ON execution_runs(world_id,status);
CREATE TABLE IF NOT EXISTS execution_events(
 run_id TEXT NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
 event_json TEXT NOT NULL, PRIMARY KEY(run_id,seq)
);
CREATE TABLE IF NOT EXISTS execution_steps(
 run_id TEXT NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE, step_key TEXT NOT NULL,
 kind TEXT NOT NULL, status TEXT NOT NULL, input_json TEXT NOT NULL, output_json TEXT,
 PRIMARY KEY(run_id,step_key)
);
CREATE TABLE IF NOT EXISTS canon_facts(
 id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES source_books(id) ON DELETE CASCADE,
 job_id TEXT REFERENCES source_jobs(id) ON DELETE CASCADE, section INTEGER NOT NULL,
 chunk INTEGER NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, aliases_json TEXT NOT NULL DEFAULT '[]',
 statement TEXT NOT NULL, quote TEXT NOT NULL, valid_from INTEGER, valid_through INTEGER,
 UNIQUE(job_id,section,chunk,kind,subject,statement)
);
CREATE INDEX IF NOT EXISTS canon_book_section ON canon_facts(book_id,section);
CREATE TABLE IF NOT EXISTS fact_corrections(
 id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
 node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, original_node_id TEXT NOT NULL REFERENCES nodes(id),
 json TEXT NOT NULL, created_at TEXT NOT NULL
);
