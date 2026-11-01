import schema9 from "../../../crates/story-core/src/migrations/009.sql?raw";
import schema11 from "../../../crates/story-core/src/migrations/011.sql?raw";
import schema10 from "../../../crates/story-core/src/migrations/010.sql?raw";
// The native host and browser apply these same versioned SQL sources.
// Shipped migrations remain unchanged; append a new version.

import schema1 from "../../../crates/story-core/src/migrations/001.sql?raw";
import schema2 from "../../../crates/story-core/src/migrations/002.sql?raw";
import schema3 from "../../../crates/story-core/src/migrations/003.sql?raw";
import schema4 from "../../../crates/story-core/src/migrations/004.sql?raw";
import schema6 from "../../../crates/story-core/src/migrations/006.sql?raw";
import schema5 from "../../../crates/story-core/src/schema.sql?raw";
import schema7 from "../../../crates/story-core/src/agent_schema.sql?raw";
import schema8 from "../../../crates/story-core/src/pi_schema.sql?raw";
import executionLeaseSchema from "../../../crates/story-core/src/execution_lease_schema.sql?raw";

export const MIGRATIONS: { version: number; sql: string }[] = [
  { version: 1, sql: schema1 },
  { version: 2, sql: schema2 },
  { version: 3, sql: schema3 },
  { version: 4, sql: schema4 },
  { version: 5, sql: schema5 },
  { version: 6, sql: schema6 },
  { version: 7, sql: schema7 },
  { version: 8, sql: executionLeaseSchema + "\n" + schema8 },
  { version: 9, sql: schema9 },
  { version: 10, sql: schema10 },
  { version: 11, sql: schema11 },
];
