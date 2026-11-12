import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fallbackClean, safeMessage, usesSharedScanner } from "./safe-error.mjs";

// The launcher and host scripts print errors through safeMessage (the shared scanner of the built contracts package) instead of stripping only `Bearer ...`. Every key is built at run time
// (push protection scans each commit) from invented characters.
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const body = (n, seed) => Array.from({ length: n }, (_, i) => ALNUM[(i * 7 + seed * 13 + (i % 5) * 11) % ALNUM.length]).join("");
const KEY = "gh" + "p_" + body(36, 1);
const SK = "s" + "k-" + body(40, 2);
const cyr = (...n) => String.fromCodePoint(...n);
const here = (f) => fileURLToPath(new URL(f, import.meta.url));

test("the scripts use the shared scanner when the contracts package is built (the test run builds first)", () => {
  assert.ok(existsSync(here("../packages/contracts/dist/index.js")), "the contracts package is built");
  assert.equal(usesSharedScanner(), true);
});

test("an error message loses every credential form, not only Bearer text", () => {
  const forms = [
    KEY, SK, `Bearer ${body(30, 3)}`, `token=${body(14, 4)}`, `password: ${body(12, 5)}`, `Authorization: Basic ${body(24, 6)}`,
    KEY.replace("ghp_", cyr(0xff47, 0xff48, 0xff50, 0xff3f)), // fullwidth
    `${KEY.slice(0, 9)}${cyr(0x200b)}${KEY.slice(9)}`, `${KEY.slice(0, 9)}\n${KEY.slice(9)}`, `"${KEY.slice(0, 6)}" + "${KEY.slice(6)}"`,
    `gh${cyr(0x440)}_${KEY.slice(4)}`, `t${cyr(0x43e)}ken=${body(14, 7)}`, body(44, 8),
  ];
  for (const form of forms) {
    for (const wrap of [(t) => new Error(`failed with ${t} in it`), (t) => `failed with ${t} in it`]) {
      const out = safeMessage(wrap(form), 2000);
      assert.ok(out.includes("[redacted]"), `kept: ${JSON.stringify(out)}`);
      assert.ok(!out.includes(body(36, 1).slice(10)) && !out.includes(body(14, 4)) && !out.includes(body(24, 6)) && !out.includes(body(44, 8)), `leaked: ${JSON.stringify(out)}`);
    }
  }
});

test("a short word after Bearer is still removed (the old rule), and a long one becomes one mark", () => {
  assert.equal(safeMessage("failed with Bearer abc.def.ghi here", 400), "failed with Bearer [removed] here");
  assert.equal(safeMessage(`failed with Bearer ${body(30, 3)} here`, 400), "failed with [redacted] here");
});

test("an ordinary message is kept, and a key is cleaned before the message is cut", () => {
  assert.equal(safeMessage(new Error("ENOENT: no such file or directory, open '/home/rob/nimblenewt/config.json'"), 400), "ENOENT: no such file or directory, open '/home/rob/nimblenewt/config.json'");
  assert.equal(safeMessage(new Error("x".repeat(500)), 100).length, 100);
  const cut = safeMessage(`${"a ".repeat(190)}${KEY}`, 392);
  assert.ok(!cut.includes(KEY.slice(4, 14)) && !cut.includes("ghp_"), `a half key is left: ${cut.slice(-40)}`);
  assert.equal(safeMessage(undefined), "undefined");
  assert.equal(typeof safeMessage({ get message() { throw new Error("no"); } }), "string");
});

test("the fallback (contracts not built) removes at least what the old Bearer rule did, and a key shape", () => {
  for (const form of [KEY, SK, `Bearer ${body(30, 3)}`, `token=${body(14, 4)}`, body(44, 8), `${KEY.slice(0, 9)}${cyr(0x200b)}${KEY.slice(9)}`]) {
    const out = fallbackClean(`oops ${form} end`);
    assert.ok(out.includes("[removed]") && !out.includes(form.slice(8, 18)), out);
  }
  assert.equal(fallbackClean("could not open the folder /home/rob/x"), "could not open the folder /home/rob/x");
});

test("the entry scripts print a key in their own error text cleaned", () => {
  const flag = `--bogus-${KEY}`;
  for (const [script, args] of [["remote-worker.mjs", [`/nonexistent/${KEY}.json`]], ["nimblenewt-controller.mjs", [flag]], ["nimblenewt-launcher.mjs", [flag]], ["nimblenewt-service.mjs", [flag]], ["nimblenewt-updater.mjs", [flag]]]) {
    const run = spawnSync(process.execPath, [here(script), ...(script === "remote-worker.mjs" ? ["--config", ...args] : args)], { encoding: "utf8", timeout: 60000 });
    const text = `${run.stdout}${run.stderr}`;
    assert.ok(text.length > 0, `${script} printed nothing`);
    assert.ok(!text.includes(KEY.slice(4, 20)), `${script} printed the key: ${text.slice(0, 200)}`);
  }
});
