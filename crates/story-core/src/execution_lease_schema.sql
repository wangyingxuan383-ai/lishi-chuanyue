CREATE TABLE IF NOT EXISTS world_execution_leases(
 world_id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 owner_instance TEXT NOT NULL,
 fence INTEGER NOT NULL,
 heartbeat_at_ms INTEGER NOT NULL,
 expires_at_ms INTEGER NOT NULL
);
