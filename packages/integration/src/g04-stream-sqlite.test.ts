import { defineStreamKillTests } from "./g04-stream-suite.js";

// The sweep where the controller records the reply's end first; the production relay's order is in g04-stream-sqlite-read-first.test.ts.
defineStreamKillTests("SQLite", "recorded first");
