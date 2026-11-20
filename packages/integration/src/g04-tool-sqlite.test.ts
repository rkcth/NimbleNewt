import { defineToolKillTests } from "./g04-tool-suite.js";

// The sweep where the interrupted call is presented again; the other sweep is in g04-tool-sqlite-not-again.test.ts.
defineToolKillTests("SQLite", false, "presented again");
