import { defineKillTests } from "./g04-kill-suite.js";

// The other half of the boundaries of g04-kill-sqlite.test.ts.
defineKillTests("SQLite", false, { index: 2, of: 2 });
