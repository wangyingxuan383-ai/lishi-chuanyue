-- Derived, rebuildable lookups. Original text and established locators are unchanged.
CREATE TABLE IF NOT EXISTS reference_index_versions(
 book_id TEXT PRIMARY KEY REFERENCES source_books(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL DEFAULT 1,index_version INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO reference_index_versions(book_id) SELECT id FROM source_books;
CREATE TABLE IF NOT EXISTS reference_lookup_cache(
 cache_key TEXT PRIMARY KEY,book_id TEXT NOT NULL REFERENCES source_books(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL,scope_json TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reference_cache_book ON reference_lookup_cache(book_id,created_at);
CREATE TRIGGER IF NOT EXISTS reference_chunks_insert AFTER INSERT ON source_chunks BEGIN
 INSERT INTO reference_index_versions(book_id) VALUES(NEW.book_id) ON CONFLICT(book_id) DO UPDATE SET revision=revision+1;
 DELETE FROM reference_lookup_cache WHERE book_id=NEW.book_id;
END;
CREATE TRIGGER IF NOT EXISTS reference_chunks_update AFTER UPDATE ON source_chunks BEGIN
 INSERT INTO reference_index_versions(book_id) VALUES(NEW.book_id) ON CONFLICT(book_id) DO UPDATE SET revision=revision+1;
 DELETE FROM reference_lookup_cache WHERE book_id=NEW.book_id;
END;
CREATE TRIGGER IF NOT EXISTS reference_chunks_delete AFTER DELETE ON source_chunks BEGIN
 UPDATE reference_index_versions SET revision=revision+1 WHERE book_id=OLD.book_id;
 DELETE FROM reference_lookup_cache WHERE book_id=OLD.book_id;
END;
