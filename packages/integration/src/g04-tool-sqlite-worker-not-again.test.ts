import { defineToolKillTests } from "./g04-tool-suite.js";

// The sweep where the interrupted call is not presented again; the other sweep is in g04-tool-sqlite-worker.test.ts.
defineToolKillTests("SQLite on a worker thread", true, "not presented again");
