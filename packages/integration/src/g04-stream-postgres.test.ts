import { defineStreamKillTests } from "./g04-stream-suite.js";

// The sweep where the controller records the reply's end first; the production relay's order is in g04-stream-postgres-read-first.test.ts.
defineStreamKillTests("PostgreSQL", "recorded first");
