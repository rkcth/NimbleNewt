// Tests for the bench's optional test slot (card W01): the bench's own build and grading run inside a held slot.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withSlot } from "./lib/slot.mjs";

// A stand-in slot command: records "acquired", runs the command it is given, records "released" when it exits.
const fakeSlot = (dir) => {
  const script = join(dir, "fake-slot.mjs");
  const events = join(dir, "events.txt");
  writeFileSync(script, `import { appendFileSync } from "node:fs"; import { spawn } from "node:child_process";
appendFileSync(${JSON.stringify(events)}, "acquired\\n");
const c = spawn(process.argv[2], process.argv.slice(3), { stdio: "inherit" });
c.on("exit", (code) => { appendFileSync(${JSON.stringify(events)}, "released\\n"); process.exit(code ?? 0); });
`);
  return { argv: [process.execPath, script], events };
};

test("withSlot runs the work only while the slot is held, and frees it after, also when the work throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-eval-slot-"));
  try {
    const { argv, events } = fakeSlot(dir);
    const seen = [];
    const out = await withSlot(argv, async () => { seen.push(readFileSync(events, "utf8")); return 42; });
    assert.equal(out, 42);
    assert.equal(seen[0], "acquired\n", "the work starts after the slot is granted and before it is freed");
    assert.equal(readFileSync(events, "utf8"), "acquired\nreleased\n");
    await assert.rejects(withSlot(argv, async () => { throw new Error("suite blew up"); }), /suite blew up/);
    assert.equal(readFileSync(events, "utf8"), "acquired\nreleased\nacquired\nreleased\n", "freed after a throw too");
    // No slot command: the work just runs.
    assert.equal(await withSlot(null, async () => "plain"), "plain");
    // A slot command that exits without granting is an error, not a silent run without a slot.
    await assert.rejects(withSlot([process.execPath, "-e", "process.exit(3)"], async () => "never"), /exited \(3\) before granting a slot/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
