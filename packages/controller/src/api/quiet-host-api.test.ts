import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService } from "../admission/service.js";
import { ScriptedInterpreter } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI, workGrants } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { RemoteWorkerClient } from "../remote/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
const MIN = 60_000, HOUR = 3_600_000;
type Reply = { ok: boolean; result?: any; error?: { code: string; message: string } };

test("host.quiet.get/change and host.move-work through the API: owner only, validated, replay-safe, race-safe; the dispatcher's tick warns once and re-places after the grace period; chat proposes the setting and applies the move on the owner's words", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-quiet-"));
  const say: Record<string, unknown[]> = {};
  let now = Date.parse("2026-10-30T10:00:00.000Z");
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    dispatch: {
      timer: new ManualTimer(), manual: true, clock: () => new Date(now).toISOString(),
      // A lenient lease: a silent worker's attempt is not abandoned by the dispatcher's own lease rule (60 s by default) before the quiet-host pass looks at it.
      dispatcher: { leaseMs: 1000 * HOUR },
      route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: false } }),
      remote: { blobDirectory: join(d, "blobs"), hosts: ["pc", "laptop"].map((n) => ({ hostId: `host:${n}`, checkpointWaitMs: 300, pollMs: 20, resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "cloud-allowed" as const, harness: "pi" }) })) },
    },
  } as never);
  try {
    assert.ok(c.dispatch?.workerUrl !== undefined && c.dispatch.remote !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const clients = new Map<string, RemoteWorkerClient>();
    const seq = new Map<string, number>();
    const beat = async (h: string): Promise<void> => { seq.set(h, (seq.get(h) ?? 0) + 1); await clients.get(h)!.heartbeat(seq.get(h)!); };
    for (const name of ["pc", "laptop"]) {
      await c.services.principals.enroll(rob, { commandId: `e-${name}`, kind: "host", name, grants: [] });
      const token = (await c.services.principals.issueCredential(rob, `host:${name}`)).token;
      const client = new RemoteWorkerClient({ url: c.dispatch.workerUrl, token, workerVersion: "worker-9.1.0" });
      await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: `cap-${name}`, actor: rob.id, host: `host:${name}`, capacity: { cpus: 8, memoryMb: 16_384 } });
      await client.connect({ ...CAPS } as never);
      clients.set(`host:${name}`, client);
      await beat(`host:${name}`);
    }
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "task.read", project }] });
    const ann = (await c.services.principals.issueCredential(rob, "agent:ann")).token;

    // The setting: defaults 12 hours and on; owner only; validated; replay-safe; race-safe; null clears.
    const g0 = (await call(boot.token, "host.quiet.get", {})).result.item;
    assert.deepEqual([g0.revision, g0.graceHours, g0.autoMove, g0.default, g0.effective], [0, null, null, { graceHours: 12, autoMove: true }, { graceHours: 12, autoMove: true }]);
    assert.equal((await call(ann, "host.quiet.get", {})).error?.code, "forbidden");
    assert.equal((await call(ann, "host.quiet.change", { graceHours: 2 }, "q0")).error?.code, "forbidden");
    assert.equal((await call(ann, "host.move-work", { hostId: "host:pc" }, "q0m")).error?.code, "forbidden");
    for (const [i, bad] of ([{}, { graceHours: 0 }, { graceHours: 721 }, { graceHours: 1.5 }, { graceHours: "3" }, { autoMove: "no" }, { autoMove: 0 }, { graceHours: 3, extra: 1 }] as Record<string, unknown>[]).entries()) assert.equal((await call(boot.token, "host.quiet.change", bad, `qb${i}`)).error?.code, "invalid_command", JSON.stringify(bad));
    const set = await call(boot.token, "host.quiet.change", { graceHours: 24, autoMove: false }, "q1");
    assert.ok(set.ok, JSON.stringify(set));
    assert.equal((await call(boot.token, "host.quiet.change", { graceHours: 24, autoMove: false }, "q1")).result.revision, set.result.revision);
    assert.equal((await call(boot.token, "host.quiet.change", { graceHours: 2, expectedRevision: 0 }, "q2")).error?.code, "stale_revision");
    assert.deepEqual((await call(boot.token, "host.quiet.get", {})).result.item.effective, { graceHours: 24, autoMove: false });
    const keep = await call(boot.token, "host.quiet.change", { autoMove: true, expectedRevision: set.result.revision }, "q3");
    assert.deepEqual((await call(boot.token, "host.quiet.get", {})).result.item.effective, { graceHours: 24, autoMove: true }, "a figure not named keeps its value");
    assert.ok((await call(boot.token, "host.quiet.change", { graceHours: null, expectedRevision: keep.result.revision }, "q4")).ok);
    assert.deepEqual((await call(boot.token, "host.quiet.get", {})).result.item.effective, { graceHours: 12, autoMove: true }, "null clears to the default");

    // Chat: the setting is shown first and applies on the owner's word; the move applies at once only when the owner's words say it and name the host.
    const turn = async (id: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: id, text })).outcomes; };
    const text = "give me 6 hours before you move work off a quiet host";
    const shown = await turn("m1", text, [{ kind: "command", op: "host.quiet.change", args: { graceHours: 6 }, evidence: text, basis: "owner" }]);
    assert.equal(shown[0]!.status, "proposed", JSON.stringify(shown));
    assert.equal((await call(boot.token, "host.quiet.get", {})).result.item.effective.graceHours, 12, "nothing changed yet");
    const applied = await turn("m2", "yes, do that", [{ kind: "apply_proposal", proposalId: shown[0]!.proposalId, evidence: "do that", basis: "owner" }]);
    assert.equal(applied[0]!.status, "applied", JSON.stringify(applied));
    assert.equal((await call(boot.token, "host.quiet.get", {})).result.item.effective.graceHours, 6);
    const off = "never move work off a quiet host by yourself";
    const offShown = await turn("m3", off, [{ kind: "command", op: "host.quiet.change", args: { autoMove: false }, evidence: off, basis: "owner" }]);
    assert.equal(offShown[0]!.status, "proposed", "disabling is also shown first");
    const vague = "that laptop is annoying";
    const notSaid = await turn("m4", vague, [{ kind: "command", op: "host.move-work", args: { hostId: "host:laptop" }, evidence: vague, basis: "owner" }]);
    assert.notEqual(notSaid[0]!.status, "applied", "the owner's words neither say the move nor name the host: nothing is done");
    assert.ok((await call(boot.token, "host.quiet.change", { graceHours: 12 }, "q5")).ok);

    // Work on pc; the tick's quiet-host pass warns once, waits the grace period, then re-places it on laptop.
    await c.services.principals.enroll(rob, { commandId: "e-worker", kind: "agent", name: "agt-abcdefghijklmnopqrst", grants: workGrants(project, ["read-file"]) });
    const taskId = (await c.services.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Order seeds" })).id;
    await c.services.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId, expectedRevision: 1, to: "ready" });
    await c.services.assignments.assignTask({ commandId: "as1", actor: rob.id, taskId, owner: { kind: "agent", id: "agt-abcdefghijklmnopqrst" } });
    const a = (await c.services.assignments.getAssignment(taskId))!;
    const attempt = (await c.services.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: "agt-abcdefghijklmnopqrst" }, harness: "pi" })).id;
    const started = await c.dispatch.dispatcher.tick();
    assert.deepEqual(started.started, [attempt], JSON.stringify(started.failures));
    const where = async (): Promise<string> => (await c.dispatch!.remote!.placement(rob, attempt))!.hostId;
    const first = await where();
    const offer = (await clients.get(first)!.offers()).find((o) => o.order.attemptId === attempt)!;
    await clients.get(first)!.attempt(attempt, offer.placement).accept();
    const other = first === "host:pc" ? "host:laptop" : "host:pc";
    const emitted = async (): Promise<number> => {
      let n = 0;
      for (let after = 0; ;) { const page = await c.storage.listAudit({ afterSeq: after, limit: 1000 }); n += page.filter((x) => x.type === "notification.emit").length; if (page.length < 1000) return n; after = page[page.length - 1]!.seq; }
    };
    const before = await emitted();
    now += 2 * MIN; await beat(other);
    await c.dispatch.dispatcher.tick();
    assert.equal(await emitted(), before, "quiet, but not past the threshold: nobody is told");
    now += 5 * MIN; await beat(other);
    await c.dispatch.dispatcher.tick();
    assert.equal(await emitted(), before + 1, "the owner is warned");
    now += 3 * MIN; await beat(other);
    await c.dispatch.dispatcher.tick();
    assert.equal(await emitted(), before + 1, "once per episode");
    assert.equal(await where(), first);
    now += 11 * HOUR; await beat(other);
    await c.dispatch.dispatcher.tick();
    assert.equal(await where(), first, "inside the grace period");
    // Turned off, however long it takes.
    assert.ok((await call(boot.token, "host.quiet.change", { autoMove: false }, "q6")).ok);
    now += 100 * HOUR; await beat(other);
    await c.dispatch.dispatcher.tick();
    assert.equal(await where(), first, "automatic moves are off");
    assert.ok((await call(boot.token, "host.quiet.change", { autoMove: true }, "q7")).ok);
    await c.dispatch.dispatcher.tick();
    assert.equal(await where(), other, "on again, past the grace period: re-placed on the other host");
    assert.equal((await c.dispatch.remote.placement(rob, attempt))!.relocations, 1);

    // The owner's move, in chat and through the API (nothing left on that host now).
    const words = `move the work off ${first}`;
    const said = await turn("m5", words, [{ kind: "command", op: "host.move-work", args: { hostId: first }, evidence: words, basis: "owner" }]);
    assert.equal(said[0]!.status, "applied", JSON.stringify(said));
    const m = await call(boot.token, "host.move-work", { hostId: other }, "mv1");
    assert.ok(m.ok, JSON.stringify(m));
    assert.deepEqual([m.result.moved.length, m.result.skipped.length], [0, 1], "the old host is quiet, so no host is fresh enough to take it");
    assert.equal((await call(boot.token, "host.move-work", { hostId: other }, "mv1")).ok, true, "a repeat is answered");
    assert.equal((await call(boot.token, "host.move-work", { hostId: first }, "mv1")).error?.code, "command_conflict");
    assert.equal((await call(boot.token, "host.move-work", { hostId: "host:nope" }, "mv2")).error?.code, "not_found");
    assert.equal((await call(boot.token, "host.move-work", { hostId: "pc" }, "mv3")).error?.code, "invalid_command");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true }); }
});

test("without remote hosts the move is unavailable and the setting still works; a damaged setting warns once and moves nothing", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-quiet-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [] } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    assert.equal((await call("host.move-work", { hostId: "host:pc" }, "u1")).error?.code, "unavailable");
    assert.ok((await call("host.quiet.change", { graceHours: 5 }, "u2")).ok);
    const real = c.storage.getAggregate.bind(c.storage);
    c.storage.getAggregate = async (ref) => { const a = await real(ref); return ref.kind === "quiet-host-settings" && a !== undefined ? { ...a, body: { graceHours: 99999 } } as never : a; };
    const emitted = async () => (await c.storage.listAudit({ afterSeq: 0, limit: 1000 })).filter((a) => a.type === "notification.emit").length;
    assert.deepEqual((await call("host.quiet.get", {})).result.item.effective, { graceHours: 12, autoMove: false }, "fails closed: no automatic move");
    await call("host.quiet.get", {});
    assert.equal(await emitted(), 1, "one notification per damaged revision");
    c.storage.getAggregate = real;
    assert.ok((await call("host.quiet.change", { graceHours: 7 }, "u3")).ok, "the owner repairs it");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true }); }
});
