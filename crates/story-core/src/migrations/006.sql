CREATE TABLE IF NOT EXISTS agent_sessions(
 id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
 line_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_session_world ON agent_sessions(world_id,line_id,updated_at);
CREATE TABLE IF NOT EXISTS agent_tasks(
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
 run_id TEXT NOT NULL UNIQUE, text TEXT NOT NULL, policy TEXT NOT NULL, status TEXT NOT NULL,
 base_json TEXT NOT NULL, workspace_json TEXT NOT NULL DEFAULT '{}', backup_json TEXT,
 result_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_task_session ON agent_tasks(session_id,created_at);
CREATE TABLE IF NOT EXISTS agent_messages(
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
 task_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_message_session ON agent_messages(session_id,created_at);
