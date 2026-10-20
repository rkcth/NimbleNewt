import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { SqliteStorage } from "../storage/sqlite/index.js";
import { DomainError, EffectService, derivedId, type EffectBridge } from "./index.js";

const child = fileURLToPath(new URL("./testing/effects-child.js", import.meta.url));
const guard = pathToFileURL(fileURLToPath(new URL("../../../../scripts/offline-guard.mjs", import.meta.url))).href;
const T = "2026-10-20T10:00:00.000Z";
const LATER = "2026-10-20T10:10:00.000Z";
const command = { commandId: "crash-effect", actor: "child", kind: "git-push", target: "repo:main", input: { commit: "abc" } };

function run(mode: string, directory: string): Promise<{ killed: boolean; out: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", guard, child, mode, directory], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("error", reject);
    proc.on("exit", (code, signal) => resolve({ killed: signal !== null || code !== 0, out }));
  });
}

async function scenario(mode: "keyed" | "opaque", check: (dir: string, effects: EffectService, id: string, lines: () => string[]) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "nn effect-crash-"));
  try {
    const seed = await SqliteStorage.open({ path: join(dir, "db.sqlite") });
    await seed.acquireEpoch({ holder: "seed", at: T });
    await seed.close();
    const crashed = await run(mode, dir);
    assert.equal(crashed.killed, true, "the child should have been killed");
    assert.equal(crashed.out.includes("finished"), false);
    const log = join(dir, "outside.log");
    const lines = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
    const id = derivedId("eff", "crash-effect");
    assert.deepEqual(lines(), [id], "the effect happened outside before the kill");
    const storage = await SqliteStorage.open({ path: join(dir, "db.sqlite") });
    try {
      assert.equal((await storage.getEffect(id))?.status, "intended", "but the result was not saved");
      const effects = EffectService.withEpoch(storage, await storage.currentEpoch(), undefined, { holder: "restart", clock: () => LATER });
      await check(dir, effects, id, lines);
    } finally { await storage.close(); }
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

const bridgeFor = (dir: string, idempotent: boolean): EffectBridge => ({
  idempotent,
  execute: async (r) => {
    const log = join(dir, "outside.log");
    const seen = existsSync(log) ? readFileSync(log, "utf8").split("\n") : [];
    if (!(idempotent && seen.includes(r.key))) appendFileSync(log, `${r.key}\n`);
    return { receipt: "r2" };
  },
});

test("killed after the outside success and before the result was saved (real SIGKILL): an idempotent target is retried with its key and applies once", () =>
  scenario("keyed", async (dir, effects, id, lines) => {
    const done = await effects.perform(command, bridgeFor(dir, true));
    assert.equal(done.status, "confirmed");
    assert.deepEqual(lines(), [id], "the protected effect occurred once");
    assert.equal((await effects.perform(command, bridgeFor(dir, true))).status, "confirmed");
    assert.deepEqual(lines(), [id]);
  }));

test("killed after the outside success and before the result was saved (real SIGKILL): an unsupported target becomes uncertain and is not retried", () =>
  scenario("opaque", async (dir, effects, id, lines) => {
    const first = await effects.run(id, bridgeFor(dir, false));
    assert.equal(first.status, "uncertain");
    await assert.rejects(effects.run(id, bridgeFor(dir, false)), (e: unknown) => e instanceof DomainError && e.code === "effect_uncertain");
    await assert.rejects(effects.perform(command, bridgeFor(dir, false)), (e: unknown) => e instanceof DomainError && e.code === "effect_uncertain");
    assert.deepEqual(lines(), [id], "nothing was sent again");
  }));
