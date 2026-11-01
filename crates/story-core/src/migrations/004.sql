
CREATE TABLE source_books(id TEXT PRIMARY KEY,title TEXT NOT NULL,format TEXT NOT NULL,created_at TEXT NOT NULL,json TEXT NOT NULL);
CREATE TABLE source_chunks(book_id TEXT NOT NULL REFERENCES source_books(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,section INTEGER NOT NULL,text TEXT NOT NULL,PRIMARY KEY(book_id,ordinal));
CREATE TABLE source_sections(book_id TEXT NOT NULL REFERENCES source_books(id) ON DELETE CASCADE,section INTEGER NOT NULL,title TEXT NOT NULL,page INTEGER,PRIMARY KEY(book_id,section));
CREATE TABLE source_terms(book_id TEXT NOT NULL REFERENCES source_books(id) ON DELETE CASCADE,term TEXT NOT NULL,postings TEXT NOT NULL,PRIMARY KEY(book_id,term));
CREATE TABLE source_jobs(id TEXT PRIMARY KEY,book_id TEXT NOT NULL REFERENCES source_books(id) ON DELETE CASCADE,json TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE source_analysis(job_id TEXT NOT NULL REFERENCES source_jobs(id) ON DELETE CASCADE,book_id TEXT NOT NULL REFERENCES source_books(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,section INTEGER NOT NULL,text TEXT NOT NULL,PRIMARY KEY(job_id,ordinal));
