-- 本局札记 (R30 step 2, D174): notes digested from a story's own passages, the
-- way 原著札记 digest a book. They belong to one story and go with it. Notes
-- carried over from an earlier story keep where they came from (D177).
CREATE TABLE story_notes(
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  scope_json TEXT NOT NULL DEFAULT '{}',
  content TEXT NOT NULL DEFAULT '',
  previous_content TEXT,
  refs_json TEXT NOT NULL DEFAULT '[]',
  model TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'paused',
  active INTEGER NOT NULL DEFAULT 1,
  progress_json TEXT NOT NULL DEFAULT '{}',
  origin_world_id TEXT,
  origin_title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX story_notes_world ON story_notes(world_id, active);
-- An AI update keeps the version before it, for 恢复上一版.
ALTER TABLE canon_notes ADD COLUMN previous_content TEXT;
