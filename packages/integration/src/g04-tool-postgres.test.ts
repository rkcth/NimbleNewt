import { defineToolKillTests } from "./g04-tool-suite.js";

// The sweep where the interrupted call is presented again; the other sweep is in g04-tool-postgres-not-again.test.ts.
defineToolKillTests("PostgreSQL", false, "presented again");
