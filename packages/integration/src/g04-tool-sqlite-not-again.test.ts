import { defineToolKillTests } from "./g04-tool-suite.js";

// The sweep where the interrupted call is not presented again; the other sweep is in g04-tool-sqlite.test.ts.
defineToolKillTests("SQLite", false, "not presented again");
