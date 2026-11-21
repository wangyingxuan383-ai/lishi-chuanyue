-- 章节摘要过期 (R30 step 3, D183): a passage inside the chapter was edited after
-- the summary was written. NULL or 0 is fresh; 1 waits to be summarized again.
-- Nullable, so archives and inserts that do not name it keep working.
ALTER TABLE chapters ADD COLUMN stale INTEGER;
