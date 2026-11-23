-- Idempotent Reader ("阅读器与书摘") schema (R35-T004).
-- IMPORTANT:
-- 1. Never insert initial rows here; empty_database() checks row existence
--    across tables for one-time legacy handoff and backup validation.
-- 2. Never add BLOB columns or hard REFERENCES constraints; soft TEXT keys
--    keep reading progress, bookmarks, and highlights intact across story
--    branching, book re-imports, and SQLite backups.

CREATE TABLE IF NOT EXISTS reader_progress (
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  section_index INTEGER NOT NULL DEFAULT 0,
  page_index INTEGER NOT NULL DEFAULT 0,
  scroll_ratio REAL NOT NULL DEFAULT 0,
  anchor_text TEXT NOT NULL DEFAULT '',
  node_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (target_type, target_id)
);

CREATE TABLE IF NOT EXISTS reader_bookmarks (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  section_index INTEGER NOT NULL,
  section_title TEXT NOT NULL,
  snippet TEXT NOT NULL,
  paragraph_index INTEGER NOT NULL DEFAULT 0,
  node_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reader_bookmarks_target_created
  ON reader_bookmarks(target_type, target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reader_highlights (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  world_id TEXT,
  section_index INTEGER NOT NULL,
  section_title TEXT NOT NULL,
  paragraph_index INTEGER NOT NULL DEFAULT 0,
  char_start INTEGER NOT NULL DEFAULT 0,
  char_end INTEGER NOT NULL DEFAULT 0,
  selected_text TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'cinnabar',
  node_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reader_highlights_target_section
  ON reader_highlights(target_type, target_id, section_index);
CREATE INDEX IF NOT EXISTS reader_highlights_created
  ON reader_highlights(created_at DESC);
