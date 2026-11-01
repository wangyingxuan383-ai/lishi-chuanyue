CREATE TABLE IF NOT EXISTS pi_sessions(
 id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
 line_id TEXT NOT NULL, title TEXT NOT NULL, session_file TEXT,
 upstream_commit TEXT NOT NULL DEFAULT '973b74c55fcf096ad5976f8d8850c147ee2e62d4',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pi_session_world ON pi_sessions(world_id,line_id,updated_at);
CREATE TABLE IF NOT EXISTS pi_model_endpoints(
 id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, slot TEXT NOT NULL,
 protocol TEXT NOT NULL, expected_base TEXT NOT NULL, endpoint TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pi_tasks(
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES pi_sessions(id) ON DELETE CASCADE,
 world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE, line_id TEXT NOT NULL,
 text TEXT NOT NULL, status TEXT NOT NULL, policy TEXT NOT NULL,
 read_only INTEGER NOT NULL DEFAULT 0 CHECK(read_only IN (0,1)),
 base_json TEXT NOT NULL, base_world_version TEXT NOT NULL,
 workspace_json TEXT NOT NULL DEFAULT '{}', model_json TEXT NOT NULL DEFAULT '{}',
 metadata_json TEXT NOT NULL DEFAULT '{}', lease_json TEXT NOT NULL DEFAULT '{}',
 plan_json TEXT NOT NULL DEFAULT '[]', question_json TEXT,
 intent_revision INTEGER NOT NULL DEFAULT 0, consumed_intent_revision INTEGER NOT NULL DEFAULT 0,
 stop_revision INTEGER NOT NULL DEFAULT 0, host_owner TEXT NOT NULL DEFAULT '',
 result_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pi_task_session ON pi_tasks(session_id,created_at);
CREATE INDEX IF NOT EXISTS pi_task_world ON pi_tasks(world_id,status);
CREATE TABLE IF NOT EXISTS pi_message_anchors(
 task_id TEXT NOT NULL REFERENCES pi_tasks(id) ON DELETE CASCADE,
 message_id TEXT NOT NULL, entry_id TEXT NOT NULL,
 PRIMARY KEY(task_id,message_id), UNIQUE(task_id,entry_id)
);
CREATE TABLE IF NOT EXISTS pi_session_messages(
 session_id TEXT NOT NULL REFERENCES pi_sessions(id) ON DELETE CASCADE,
 seq INTEGER NOT NULL, message_id TEXT NOT NULL, entry_id TEXT NOT NULL,
 message_json TEXT NOT NULL, PRIMARY KEY(session_id,seq), UNIQUE(session_id,message_id)
);
CREATE TABLE IF NOT EXISTS pi_events(
 task_id TEXT NOT NULL REFERENCES pi_tasks(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
 event_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(task_id,seq)
);
CREATE TABLE IF NOT EXISTS pi_calls(
 task_id TEXT NOT NULL REFERENCES pi_tasks(id) ON DELETE CASCADE, call_id TEXT NOT NULL,
 tool TEXT NOT NULL, args_hash TEXT NOT NULL, world_version TEXT NOT NULL,
 intent_revision INTEGER NOT NULL, external_write INTEGER NOT NULL CHECK(external_write IN (0,1)),
 status TEXT NOT NULL, output_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(task_id,call_id)
);
CREATE INDEX IF NOT EXISTS pi_call_external ON pi_calls(tool,args_hash,status,external_write);
CREATE TABLE IF NOT EXISTS pi_inputs(
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES pi_sessions(id) ON DELETE CASCADE,
 task_id TEXT REFERENCES pi_tasks(id) ON DELETE CASCADE,
 seq INTEGER NOT NULL, delivery TEXT NOT NULL, content_json TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending', intent_revision INTEGER,
 created_at TEXT NOT NULL, delivered_at TEXT, UNIQUE(session_id,seq)
);
CREATE INDEX IF NOT EXISTS pi_input_pending ON pi_inputs(task_id,status,seq);
CREATE TABLE IF NOT EXISTS story_recovery_points(
 id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
 task_id TEXT NOT NULL, before_json TEXT NOT NULL, post_fingerprint TEXT NOT NULL,
 result_json TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS story_recovery_world ON story_recovery_points(world_id,created_at);
CREATE TABLE IF NOT EXISTS pi_external_effects(
 id TEXT PRIMARY KEY, world_id TEXT NOT NULL, task_id TEXT NOT NULL, call_id TEXT NOT NULL,
 tool TEXT NOT NULL, args_hash TEXT NOT NULL, status TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(task_id,call_id)
);
CREATE INDEX IF NOT EXISTS pi_external_unknown ON pi_external_effects(world_id,tool,args_hash,status);
CREATE TABLE IF NOT EXISTS pi_model_requests(
 task_id TEXT NOT NULL REFERENCES pi_tasks(id) ON DELETE CASCADE,
 request_id TEXT NOT NULL, source TEXT NOT NULL, model_json TEXT NOT NULL,
 status TEXT NOT NULL, usage_json TEXT, started_at TEXT NOT NULL, finished_at TEXT,
 PRIMARY KEY(task_id,request_id)
);
CREATE INDEX IF NOT EXISTS pi_model_active ON pi_model_requests(task_id,status);
CREATE TABLE IF NOT EXISTS pi_children(
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES pi_tasks(id) ON DELETE CASCADE,
 parent_call_id TEXT NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL,
 status TEXT NOT NULL, world_version TEXT NOT NULL, intent_revision INTEGER NOT NULL,
 provided_json TEXT NOT NULL DEFAULT '[]', session_file TEXT,
 result_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pi_children_parent ON pi_children(task_id,parent_call_id,status);
CREATE UNIQUE INDEX IF NOT EXISTS pi_children_identity ON pi_children(task_id,id);
CREATE TABLE IF NOT EXISTS pi_child_calls(
 task_id TEXT NOT NULL, call_id TEXT NOT NULL, child_id TEXT NOT NULL,
 PRIMARY KEY(task_id,call_id),
 FOREIGN KEY(task_id,call_id) REFERENCES pi_calls(task_id,call_id) ON DELETE CASCADE,
 FOREIGN KEY(task_id,child_id) REFERENCES pi_children(task_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS pi_tool_deliveries(
 task_id TEXT NOT NULL, call_id TEXT NOT NULL, actor_id TEXT NOT NULL DEFAULT '',
 delivery_hash TEXT NOT NULL, source_json TEXT NOT NULL, pages_json TEXT NOT NULL,
 world_version TEXT NOT NULL, intent_revision INTEGER NOT NULL,
 PRIMARY KEY(task_id,call_id),
 FOREIGN KEY(task_id,call_id) REFERENCES pi_calls(task_id,call_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS pi_context_deliveries(
 task_id TEXT NOT NULL, request_id TEXT NOT NULL, actor_id TEXT NOT NULL,
 call_id TEXT NOT NULL, delivery_hash TEXT NOT NULL,
 world_version TEXT NOT NULL, intent_revision INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'admitted',
 PRIMARY KEY(task_id,request_id,actor_id,call_id),
 FOREIGN KEY(task_id,request_id) REFERENCES pi_model_requests(task_id,request_id) ON DELETE CASCADE,
 FOREIGN KEY(task_id,call_id) REFERENCES pi_tool_deliveries(task_id,call_id) ON DELETE CASCADE
);

-- Rebuildable process projection cursor, independent of event render limits.
CREATE TABLE IF NOT EXISTS pi_call_updates (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES pi_tasks(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pi_call_updates_task ON pi_call_updates(task_id,seq);
CREATE TRIGGER IF NOT EXISTS pi_call_project_insert AFTER INSERT ON pi_calls BEGIN
  INSERT INTO pi_call_updates(task_id,call_id) VALUES(NEW.task_id,NEW.call_id);
END;
CREATE TRIGGER IF NOT EXISTS pi_call_project_update AFTER UPDATE OF status,output_json ON pi_calls BEGIN
  INSERT INTO pi_call_updates(task_id,call_id) VALUES(NEW.task_id,NEW.call_id);
END;
CREATE TABLE IF NOT EXISTS pi_progress_calls (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES pi_tasks(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  coverage TEXT,
  summary TEXT NOT NULL,
  UNIQUE(task_id,call_id)
);
CREATE INDEX IF NOT EXISTS pi_progress_task ON pi_progress_calls(task_id,seq);
CREATE TABLE IF NOT EXISTS pi_read_cache (
 task_id TEXT NOT NULL REFERENCES pi_tasks(id) ON DELETE CASCADE,
 cache_key TEXT NOT NULL,
 data_json TEXT NOT NULL,
 PRIMARY KEY(task_id,cache_key)
);
