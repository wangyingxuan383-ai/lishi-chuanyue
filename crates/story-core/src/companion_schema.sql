-- Idempotent Companion ("伴聊") schema (R33, D187).
-- IMPORTANT: Never insert built-in rows here; SqlStore::is_empty() inspects row
-- existence across user tables for one-time legacy IndexedDB handoff.
-- Soft foreign keys on world/line/book/pi_session ensure deleting a story or
-- book never destroys the player's companion chat history.

CREATE TABLE IF NOT EXISTS companion_personas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '',
  tagline TEXT NOT NULL DEFAULT '',
  role_kind TEXT NOT NULL DEFAULT 'assistant',
  system_prompt TEXT NOT NULL,
  greeting TEXT NOT NULL DEFAULT '',
  starters_json TEXT NOT NULL DEFAULT '[]',
  style_notes TEXT NOT NULL DEFAULT '',
  memory_scope TEXT NOT NULL DEFAULT 'persona',
  pure_roleplay INTEGER NOT NULL DEFAULT 0,
  source_world_id TEXT,
  source_person_id TEXT,
  source_head_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS companion_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  active_gear TEXT NOT NULL DEFAULT 'chat',
  bound_world_id TEXT,
  bound_line_id TEXT,
  bound_book_id TEXT,
  book_scope_json TEXT,
  pi_session_id TEXT,
  active_leaf_id TEXT,
  summary_text TEXT NOT NULL DEFAULT '',
  summary_up_to_msg_id TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS companion_sessions_updated ON companion_sessions(archived, pinned DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS companion_sessions_world ON companion_sessions(bound_world_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS companion_sessions_pi ON companion_sessions(pi_session_id);

CREATE TABLE IF NOT EXISTS companion_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES companion_sessions(id) ON DELETE CASCADE,
  parent_id TEXT,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  gear TEXT NOT NULL DEFAULT 'chat',
  status TEXT NOT NULL DEFAULT 'done',
  content TEXT NOT NULL DEFAULT '',
  thinking TEXT NOT NULL DEFAULT '',
  steps_json TEXT NOT NULL DEFAULT '[]',
  citations_json TEXT NOT NULL DEFAULT '[]',
  pi_task_id TEXT,
  model_id TEXT NOT NULL DEFAULT '',
  usage_json TEXT,
  error_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS companion_messages_session_seq ON companion_messages(session_id, seq);
CREATE INDEX IF NOT EXISTS companion_messages_parent ON companion_messages(session_id, parent_id, seq);

CREATE TABLE IF NOT EXISTS companion_memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'persona',
  persona_id TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'fact',
  content TEXT NOT NULL,
  source_session_id TEXT,
  source_message_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS companion_memories_lookup ON companion_memories(scope, persona_id, enabled, pinned DESC, updated_at DESC);
