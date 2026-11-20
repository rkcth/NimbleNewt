import { defineKillTests } from "./g04-kill-suite.js";

// The other half of the boundaries of g04-kill-sqlite-worker.test.ts.
defineKillTests("SQLite on a worker thread", true, { index: 2, of: 2 });
