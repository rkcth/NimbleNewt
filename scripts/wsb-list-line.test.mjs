// Card wsb-repair: the one-line record of what the product's launcher tried for `wsb list` (scripts/wsb-list-line.mjs). The line is built from noted calls, so it runs on every OS.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PREFIX, callText, lineFor } from "./wsb-list-line.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const VIA = "through a one-shot scheduled task in the signed-in session";

test("the line says what was tried (how each call was launched) and the outcome, in fixed words", () => {
  assert.equal(lineFor([{ verb: "wsb list", via: VIA, code: 0, timedOut: false, ms: 1204.4 }], "none"),
    `${PREFIX}tried wsb list ${VIA}: answered, exit code 0 after 1204 ms; outcome: OK: the list answered, no sandbox is running`);
  const failed = lineFor([
    { verb: "wsb list", via: "scheduled task not available (the task did not begin within 20 s (is anyone signed in on this machine?)); direct call used", code: 2148734208, timedOut: false, ms: 30010 },
    { verb: "wsb list", code: null, timedOut: true, ms: 60000 },
  ], "unknown");
  assert.match(failed, /^wsb list \(product launcher\): tried wsb list scheduled task not available \(.*\); direct call used: failed, exit code 2148734208 after 30010 ms; then wsb list directly: timed out after 60000 ms; outcome: FAILED: no list could be had$/);
  assert.match(lineFor([], "unknown"), /no wsb call was made \(the client could not be verified\); outcome: FAILED/);
  assert.match(lineFor([{ verb: "wsb list", code: 0, ms: 5 }], "running"), /outcome: OK: the list answered, a sandbox is running$/);
  assert.equal(callText({ verb: "wsb list", code: null, ms: 1 }), "wsb list directly: failed, exit code none after 1 ms");
});

test("run off Windows: says so, tries nothing, exits 0", { skip: process.platform === "win32" ? "the off-Windows answer" : false }, () => {
  const r = spawnSync(process.execPath, [join(root, "scripts", "wsb-list-line.mjs")], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `${PREFIX}not Windows; nothing tried\n`);
});
