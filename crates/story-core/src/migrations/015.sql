-- Preserve only the latest full streamed text. Keep its event number so
-- existing and reconnected readers share the same monotonic cursor.
CREATE TABLE IF NOT EXISTS execution_progress(
 run_id TEXT PRIMARY KEY REFERENCES execution_runs(id) ON DELETE CASCADE,
 seq INTEGER NOT NULL,
 event_json TEXT NOT NULL
);
INSERT OR IGNORE INTO execution_progress(run_id,seq,event_json)
 SELECT e.run_id,e.seq,e.event_json FROM execution_events e
 JOIN (SELECT run_id,MAX(seq) AS seq FROM execution_events
       WHERE json_extract(event_json,'$.type')='text' GROUP BY run_id) latest
 ON e.run_id=latest.run_id AND e.seq=latest.seq;
DELETE FROM execution_events WHERE json_extract(event_json,'$.type')='text';
