import { defineKillTests } from "./g04-kill-suite.js";

// The sampled boundaries are divided between this file and g04-kill-sqlite-part2.test.ts (see `share` in g04-fixture.ts).
defineKillTests("SQLite", false, { index: 1, of: 2 });
