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
CREATE TABLE IF NOT EXISTS agent_control(
 task_id TEXT PRIMARY KEY REFERENCES agent_tasks(id) ON DELETE CASCADE,
 intent_revision INTEGER NOT NULL DEFAULT 0, consumed_seq INTEGER NOT NULL DEFAULT 0,
 stop_revision INTEGER NOT NULL DEFAULT 0, plan_json TEXT NOT NULL DEFAULT '[]',
 question_json TEXT, context_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS agent_inputs(
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
 task_id TEXT, delivery TEXT NOT NULL, content_json TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL,
 delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS agent_input_pending ON agent_inputs(session_id,status,delivery);
CREATE TABLE IF NOT EXISTS agent_session_links(
 session_id TEXT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
 parent_session_id TEXT NOT NULL, parent_message_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_subtasks(
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
 name TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL,
 intent_revision INTEGER NOT NULL, base_fingerprint TEXT NOT NULL,
 state_json TEXT NOT NULL DEFAULT '{}', result_json TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_subtask_parent ON agent_subtasks(task_id,created_at);
