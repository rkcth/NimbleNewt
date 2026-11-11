// Card U14: the launcher's command line. Only what needs no secret store and no running controller is tested here (the start, the owner and the chat are in
// packages/integration/src/u14-launcher.test.ts with an injected secret store and model).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main, parseArgs, starterConfig } from "./nimblenewt.mjs";

const capture = () => { let text = ""; return { io: { stdin: { isTTY: false }, stdout: { write: (t) => { text += t; } }, stderr: { write: (t) => { text += t; } }, env: {} }, get text() { return text; } }; };

test("arguments: flags with values, switches and commands", () => {
  const a = parseArgs(["init", "--data", "/x", "--model-paid", "--model=m", "secret", "set"]);
  assert.deepEqual(a._, ["init", "secret", "set"]);
  assert.equal(a.flags.data, "/x");
  assert.equal(a.flags["model-paid"], true);
  assert.equal(a.flags.model, "m");
});

test("init writes a valid configuration that holds only the names of secrets, once; a second init leaves it alone; unknown commands print the help (card U14)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-u14-cli-"));
  try {
    const c = capture();
    const code = await main(["init", "--data", dir, "--model-endpoint", "http://127.0.0.1:8002/v1", "--model", "local-x", "--backup-endpoint", "https://free.example.invalid/v1", "--backup-model", "free-y", "--backup-key-secret", "backup-key"], c.io);
    assert.equal(code, 0, c.text);
    const file = join(dir, "nimblenewt.config.json");
    assert.ok(existsSync(file));
    assert.equal(statSync(file).mode & 0o077, 0, "owner-only");
    const doc = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(doc.models.providers.backup.credential, { secret: "backup-key" });
    assert.equal(doc.models.providers.primary.credential, undefined);
    assert.equal(doc.controller.storage.kind, "sqlite");
    assert.match(c.text, /secret set backup-key/);
    assert.doesNotMatch(readFileSync(file, "utf8"), /sk-|Bearer|password/);
    const again = capture();
    assert.equal(await main(["init", "--data", dir], again.io), 1);
    assert.match(again.text, /already exists and was left as it is/);
    const help = capture();
    assert.equal(await main(["frobnicate"], help.io), 1);
    assert.match(help.text, /NimbleNewt launcher/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a model address without a model name, and a database choice, are handled in plain words (card U14)", () => {
  assert.throws(() => starterConfig("/x", { "model-endpoint": "http://127.0.0.1:1/v1" }), /needs --model/);
  assert.throws(() => starterConfig("/x", { "backup-endpoint": "http://127.0.0.1:1/v1" }), /needs --backup-model/);
  const pg = starterConfig("/x", { "postgres-secret": "db-address" });
  assert.deepEqual(pg.controller.storage, { kind: "postgres", url: { secret: "db-address" }, maxConnections: 10 });
});
