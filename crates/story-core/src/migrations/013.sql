-- Canon notes (R29, D162): AI digests of a book by chapter range, person,
-- setting, timeline or question. Shared by every story bound to the book
-- unless world_id names the one story it was saved from.
CREATE TABLE canon_notes(
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES source_books(id) ON DELETE CASCADE,
  world_id TEXT REFERENCES worlds(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  scope_json TEXT NOT NULL DEFAULT '{}',
  content TEXT NOT NULL DEFAULT '',
  refs_json TEXT NOT NULL DEFAULT '[]',
  model TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'paused',
  active INTEGER NOT NULL DEFAULT 1,
  progress_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX canon_notes_book ON canon_notes(book_id, active);
