import { defineStreamKillTests } from "./g04-stream-suite.js";

// The sweep where Pi reads the whole reply before the controller completes it (the production relay's order); the other order is in g04-stream-sqlite.test.ts.
defineStreamKillTests("SQLite", "read first");
