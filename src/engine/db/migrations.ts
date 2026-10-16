// Schema migrations, applied in order. Each entry is plain SQL run inside one
// sql.batch transaction together with the version bump. Never edit a shipped
// migration; append a new one. The same SQL runs on sql.js and native SQLite.

export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE worlds (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  era_id TEXT NOT NULL,
  current_line_id TEXT,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  played_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES nodes(id),
  last_child_id TEXT,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  action_mode TEXT,
  action_text TEXT,
  director_note TEXT,
  narrative TEXT NOT NULL DEFAULT '',
  record_json TEXT,
  choices_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'ok',
  rewritten INTEGER NOT NULL DEFAULT 0,
  fate TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX nodes_parent ON nodes(parent_id);
CREATE INDEX nodes_world ON nodes(world_id, seq);

CREATE TABLE states (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  state_json TEXT NOT NULL
);

CREATE TABLE lines (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  kind TEXT NOT NULL DEFAULT 'line',
  auto_named INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX lines_world ON lines(world_id);

CREATE TABLE pins (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  origin_node_id TEXT REFERENCES nodes(id),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE chapters (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  first_node_id TEXT NOT NULL,
  last_node_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  model TEXT,
  prompt_version TEXT,
  edited INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE usage (
  id TEXT PRIMARY KEY,
  world_id TEXT,
  node_id TEXT,
  purpose TEXT NOT NULL,
  profile_id TEXT,
  model TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  estimated INTEGER NOT NULL DEFAULT 0,
  first_token_ms INTEGER,
  total_ms INTEGER,
  outcome TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX usage_at ON usage(at);

CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  base_url TEXT NOT NULL,
  main_model TEXT NOT NULL,
  aux_model TEXT,
  params_json TEXT NOT NULL DEFAULT '{}',
  key_slot TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  },
];
