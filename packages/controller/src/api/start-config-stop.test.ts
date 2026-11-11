import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { unguarded } from "../retention/guard.js";
import { SqliteStorage } from "../storage/index.js";
import { startTestServer, withClient, type TestServer } from "../storage/postgres/testing/server.js";
import type { OperationInput } from "../storage/types.js";
import { sqliteTarget } from "../transfer/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
let pgServer: Promise<TestServer> | undefined;
const pg = (): Promise<TestServer> => (pgServer ??= startTestServer());
after(async () => { if (pgServer !== undefined) await (await pgServer).stop(); });

type Controller = Awaited<ReturnType<typeof startController>>;

/**
 * Stops the controller's writes right after the first write of an installation setting commits (beneath the storage guard, so every service's write goes through it): what a process that dies at
 * that moment leaves in the database. `arm` starts watching; once triggered every later write fails as if the process were gone.
 */
function stopAfterFirstSettingWrite(c: Controller): { arm(): void; triggered(): boolean; release(): void } {
  const raw = unguarded(c.storage) as unknown as { applyOperation(input: OperationInput): Promise<unknown> };
  const original = raw.applyOperation.bind(raw);
  let armed = false, stopped = false;
  raw.applyOperation = async (input: OperationInput) => {
    if (stopped) throw new Error("the controller process stopped");
    const result = await original(input);
    if (armed && input.changes.some((ch) => ch.ref.kind === "config-layer")) stopped = true;
    return result;
  };
  return { arm: () => { armed = true; }, triggered: () => stopped, release: () => { raw.applyOperation = original; } };
}

// Review of card F04m, third slice (left as is (a)): a chat setting edit used to stage and then apply (two writes). A controller stopped between them left a STAGED change nobody could discard; it blocked
// the transfer switches and the next chat edit of the layer put it into force with its own change. A setting change is now one write: the same stop leaves the change in force and nothing staged.
for (const backend of ["sqlite", "postgres"] as const) {
  test(`a controller stopped right after the first settings write of a chat edit leaves nothing staged; after the restart the owner's resend finishes the edit, the next edit and the transfer switches carry nothing unseen into force (${backend}, review of card F04m)`, async () => {
    const d = mkdtempSync(join(tmpdir(), "nn-cfs-"));
    const say: Record<string, unknown[]> = {};
    const url = backend === "postgres" ? (await pg()).url() : undefined;
    const schema = `cs_${process.pid}_${Math.random().toString(36).slice(2, 7)}`;
    const storage = backend === "postgres" ? { kind: "postgres", url, schema } : { kind: "sqlite", path: join(d, "c.sqlite") };
    const newPath = join(d, "moved.sqlite");
    const open = async (): Promise<Controller> => startController({ storage, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), tickMs: 3_600_000 },
      chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
      transfer: { stateDirectory: d, targets: [{ ...(await sqliteTarget({ name: "moved", path: newPath, open: () => SqliteStorage.open({ path: newPath }) })), freeBytes: async () => 1e12 }], restart: { delayMs: 20, run: () => undefined } } } as never);
    const tell = async (c: Controller, token: string, id: string, text: string, intent: Record<string, unknown>) => {
      say[text] = [{ ...intent, evidence: text, basis: "owner" }];
      return (await c.chat!.submit(token, { messageId: id, text })).outcomes as any[];
    };
    const door = (value: boolean) => ({ kind: "policy_edit", change: { type: "setting", layer: "installation", key: "conversation.mcp.enabled", value } });
    let c = await open();
    try {
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
      let rob = await c.services.principals.authenticate(boot.token);
      const shown = await tell(c, boot.token, "m1", "shut the outside app door", door(false));
      assert.equal(shown[0].status, "proposed", JSON.stringify(shown));
      const before = (await c.services.configuration.layer(rob, "installation"))?.revision ?? 0;

      // The owner agrees; the controller stops right after the first write to the installation settings.
      const stop = stopAfterFirstSettingWrite(c);
      stop.arm();
      await tell(c, boot.token, "m2", "yes, shut it", { kind: "apply_proposal", proposalId: shown[0].proposalId }).catch(() => undefined);
      assert.equal(stop.triggered(), true, "the stop happened at a settings write");
      stop.release();
      await c.close().catch(() => undefined);

      // A real restart on the same database. Nothing is staged: the one write that happened is the whole change, in force.
      c = await open();
      rob = await c.services.principals.authenticate(boot.token);
      const layer = (await c.services.configuration.layer(rob, "installation"))!;
      assert.equal(layer.draft, undefined, "nothing was left staged");
      assert.equal(layer.revision, before + 1, "one write");
      assert.equal(await c.services.configuration.installationValue("conversation.mcp.enabled"), false, "the change the owner agreed to is in force");

      // The owner says yes again: the edit is finished from the record (no second write).
      const resent = await tell(c, boot.token, "m3", "yes, shut the door please", { kind: "apply_proposal", proposalId: shown[0].proposalId });
      assert.equal(resent[0].status, "applied", JSON.stringify(resent));
      assert.equal((await c.services.configuration.layer(rob, "installation"))!.revision, before + 1, "the resend wrote no setting again");

      // A draft an older controller left (or anyone staged) in the same layer: the next chat edit applies only its own change, and the draft stays out of force.
      const r1 = (await c.services.configuration.layer(rob, "installation"))!.revision;
      await c.services.configuration.stage(rob, { commandId: "old-left", layer: "installation", expectedRevision: r1, set: { "database.transfer.restart": false, "grants.maxDays": 2 } } as never);
      const next = await tell(c, boot.token, "m4", "open the outside app door again", door(true));
      assert.equal(next[0].status, "proposed", JSON.stringify(next));
      const yes = await tell(c, boot.token, "m5", "yes, open it", { kind: "apply_proposal", proposalId: next[0].proposalId });
      assert.equal(yes[0].status, "applied", JSON.stringify(yes));
      assert.equal(await c.services.configuration.installationValue("conversation.mcp.enabled"), true);
      assert.notEqual(await c.services.configuration.installationValue("database.transfer.restart"), false, "the draft did not ride along with the chat edit");
      assert.equal(await c.services.configuration.installationValue("grants.maxDays"), undefined, "nor its other key");

      // The transfer switches are not blocked by it and do not carry it either; the draft is untouched.
      const sw = await c.api.handle(boot.token, { v: 1, op: "database.transfer.set", commandId: "sw-1", args: { enabled: false } } as never) as any;
      assert.equal(sw.ok, true, JSON.stringify(sw));
      assert.notEqual(await c.services.configuration.installationValue("database.transfer.restart"), false);
      assert.deepEqual(Object.keys((await c.services.configuration.layer(rob, "installation"))!.draft!.set).sort(), ["database.transfer.restart", "grants.maxDays"]);

      // The same stop in a transfer switch change leaves nothing staged either.
      const stop2 = stopAfterFirstSettingWrite(c);
      const r2 = (await c.services.configuration.layer(rob, "installation"))!.revision;
      await c.services.configuration.discard(rob, { commandId: "drop-old", layer: "installation", expectedRevision: r2 } as never);
      stop2.arm();
      await c.api.handle(boot.token, { v: 1, op: "database.transfer.set", commandId: "sw-2", args: { restart: false } } as never);
      assert.equal(stop2.triggered(), true);
      stop2.release();
      await c.close().catch(() => undefined);
      c = await open();
      rob = await c.services.principals.authenticate(boot.token);
      const after2 = (await c.services.configuration.layer(rob, "installation"))!;
      assert.deepEqual([after2.draft, after2.revision], [undefined, r2 + 2], "discard, then the one switch write");
      assert.equal(await c.services.configuration.installationValue("database.transfer.restart"), false);
    } finally {
      await c.close().catch(() => undefined);
      if (url !== undefined) await withClient(url, async (client) => { await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }).catch(() => undefined);
      rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
}
