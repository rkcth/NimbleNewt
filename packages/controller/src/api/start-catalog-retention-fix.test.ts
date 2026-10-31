import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { personalNamespace, protectedVersions } from "../catalog/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { RetainedMaterial } from "../retention/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const manifest = {
  purpose: "check a page", input: { type: "object" }, output: { type: "object" }, entryPoint: "bin/check.js", interpreter: { name: "node", version: "22.19.0" },
  os: ["linux"], arch: ["x64"], dependencies: [], requestedAccess: [], limits: { cpus: 1, memoryMb: 128, seconds: 30 }, cancellation: "cooperative", recovery: "none",
};
const host = { os: "linux" as const, arch: "x64" as const, interpreters: { node: "22.19.0" }, packages: {}, cpus: 4, memoryMb: 4096 };
type Reply = { ok: boolean; result?: any; error?: { code: string; message?: string } };

async function world(d: string, startup: Record<string, unknown> = {}) {
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], ...startup });
  const s = c.services;
  const boot = await s.principals.bootstrapOwner({ name: "rob" });
  const rob = await s.principals.authenticate(boot.token);
  const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
  const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
  await s.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "desk.write", project }, { action: "desk.read", project }, { action: "catalog.register", project: "*" }, { action: "catalog.read", project: "*" }, { action: `tool.${personalNamespace("agent:ann").replace(/^a_/, "a-")}.*`, project }] });
  const ann = await s.principals.authenticate((await s.principals.issueCredential(rob, "agent:ann")).token);
  const task = async (n: string) => { const id = (await s.projects.createTask({ commandId: `t-${n}`, actor: rob.id, projectId: project, title: `Task ${n}` })).id; await s.projects.transitionTask({ commandId: `r-${n}`, actor: rob.id, taskId: id, expectedRevision: 1, to: "ready" }); return id; };
  const note = async (t: string) => (await s.desks.write(ann, { commandId: `w-${t}`, projectId: project, kind: "note", title: t, body: t, visibility: "shared", status: "accepted" } as never)).id;
  const publish = async (versions: string[]) => {
    const readme = await note("readme"); let name = "";
    for (const v of versions) name = (await s.catalog.register(ann, { commandId: `reg-${v}`, name: "check", kind: "tool", version: v, manifest, instructionsRecordId: readme, executableRecordId: await note(`code ${v}`) } as never)).name;
    return name;
  };
  return { c, s, boot: boot.token, rob, ann, call, project, task, note, publish };
}
const cleanup = (d: string): void => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
const candidates = async (call: Awaited<ReturnType<typeof world>>["call"], boot: string, id: string): Promise<string[]> => ((await call(boot, "retention.run", { dryRun: true }, id)).result.catalogVersions.candidates as { version: string }[]).map((v) => v.version);

test("retention never drops the version a tool resolves to: after a rollback the live version is kept although it is old, and a revoked latest leaves the newest unrevoked one (card T02c fix)", async () => {
  assert.deepEqual([...protectedVersions({ latest: "1.2.0", versions: ["1.0.0", "1.1.0", "1.2.0"], revoked: [], deprecated: ["1.1.0", "1.2.0"] })].sort(), ["1.0.0", "1.2.0"]);
  const d = mkdtempSync(join(tmpdir(), "nn-catfx-"));
  const { c, s, boot, rob, call, publish } = await world(d);
  try {
    const name = await publish(["1.0.0", "1.1.0", "1.2.0"]);
    await s.catalog.rollback(rob, { commandId: "rb", name, toVersion: "1.0.0", reason: "1.2 is bad" });
    assert.ok((await call(boot, "retention.settings.set", { catalogVersionsKept: 1 }, "k1")).ok);
    assert.deepEqual(await candidates(call, boot, "p1"), ["1.1.0"], "1.0.0 is what the tool runs on, 1.2.0 is the highest; only 1.1.0 may go");
    const ran = await call(boot, "retention.run", { dryRun: false, confirm: (await call(boot, "retention.run", { dryRun: true }, "p2")).result.digest }, "r1");
    assert.ok(ran.ok, JSON.stringify(ran));
    assert.equal((await s.catalog.get(rob, name))!.version, "1.0.0", "the tool still resolves to the rolled-back version");
  } finally { await c.close(); cleanup(d); }
});

test("a revoked latest still leaves a version to fall back to (card T02c fix)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-catfx-"));
  const { c, s, boot, rob, call, publish } = await world(d);
  try {
    const name = await publish(["1.0.0", "1.1.0", "1.2.0"]);
    await s.catalog.revoke(rob, { commandId: "rv", name, version: "1.2.0", reason: "bad" });
    assert.ok((await call(boot, "retention.settings.set", { catalogVersionsKept: 1 }, "k1")).ok);
    assert.deepEqual(await candidates(call, boot, "p1"), ["1.0.0"], "1.1.0 is the newest unrevoked version and stays");
  } finally { await c.close(); cleanup(d); }
});

test("a version is claimed before it is dropped: while claimed no run starts on it, a use recorded before the claim holds it, and a held version is released again (card T02c fix)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-catfx-"));
  const { c, s, rob, ann, project, task, publish } = await world(d);
  try {
    const name = await publish(["1.0.0", "1.1.0", "1.2.0"]);
    const t = await task("one");
    const row = async (v: string) => { const list = await s.catalog.retentionCandidates(rob, 1, 10); return list.items.find((x) => x.version === v); };
    // Interleaving 1: a run asks for the version at the moment retention is deciding. It is refused while the claim stands, and the drop goes ahead.
    const during: string[] = [];
    const one = (await row("1.0.0"))!;
    const dropped = await s.catalog.dropVersion(rob, { name, version: "1.0.0", revision: one.revision, keep: 1 }, async () => {
      try { await s.catalog.authorizeRun(ann, { commandId: "run-during", name, version: "1.0.0", taskId: t, projectId: project, host }); during.push("started"); } catch (error) { during.push((error as { code?: string }).code ?? "error"); }
      return undefined;
    });
    assert.deepEqual(during, ["unavailable"], "no run starts between the claim and the drop");
    assert.equal(dropped.dropped, true);
    assert.equal(await s.catalog.get(rob, name, "1.0.0"), undefined);
    // After the drop a run is refused as missing, never recorded.
    await assert.rejects(s.catalog.authorizeRun(ann, { commandId: "run-after", name, version: "1.0.0", taskId: t, projectId: project, host }), /forbidden|not_found|may not use|no longer/);

    // Interleaving 2: a run that was recorded before the claim is seen by the hold check inside the drop, so nothing is dropped and the claim is lifted.
    assert.equal((await s.catalog.authorizeRun(ann, { commandId: "run-before", name, version: "1.1.0", taskId: t, projectId: project, host })).ready, true);
    const two = (await s.catalog.retentionCandidates(rob, 1, 10)).items.find((x) => x.version === "1.1.0")!;
    const held = await s.catalog.dropVersion(rob, { name, version: "1.1.0", revision: two.revision, keep: 1 }, async (id) => (await RetainedMaterial.build(c.storage)).why("catalog-version", id));
    assert.equal(held.dropped, false);
    assert.match(String(held.held?.[0]), /run by task/);
    assert.equal((await s.catalog.get(rob, name, "1.1.0"))?.version, "1.1.0");
    assert.equal((await s.catalog.authorizeRun(ann, { commandId: "run-again", name, version: "1.1.0", taskId: t, projectId: project, host })).ready, true, "the claim was lifted");
    // A check that fails keeps the version.
    const three = (await s.catalog.retentionCandidates(rob, 1, 10)).items.find((x) => x.version === "1.1.0")!;
    const failed = await s.catalog.dropVersion(rob, { name, version: "1.1.0", revision: three.revision, keep: 1 }, async () => { throw new Error("boom"); });
    assert.equal(failed.dropped, false);
    assert.equal((await s.catalog.get(rob, name, "1.1.0"))?.version, "1.1.0");
  } finally { await c.close(); cleanup(d); }
});

test("the automatic pass drops catalogue versions only when catalogAutoDrop is on (default off); a run by hand always may (card T02c fix)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-catfx-"));
  const { c, s, boot, rob, call, publish } = await world(d, { retention: { autoEveryMs: 0 } });
  try {
    const name = await publish(["1.0.0", "1.1.0", "1.2.0"]);
    assert.ok((await call(boot, "retention.settings.set", { catalogVersionsKept: 1, autoRun: true }, "k1")).ok);
    assert.equal((await call(boot, "retention.settings.get", {})).result.item.effective.catalogAutoDrop, false);
    const first = await s.retention.sweep(rob);
    assert.equal(first?.catalogVersions, undefined, "the sweep does not touch the catalogue by default");
    assert.ok((await s.catalog.get(rob, name, "1.0.0")) !== undefined);
    assert.ok((await call(boot, "retention.settings.set", { catalogAutoDrop: true }, "k2")).ok);
    const second = await s.retention.sweep(rob);
    assert.equal(second?.catalogVersions?.removed, 2, "with the switch on the sweep drops the old versions");
    assert.deepEqual([await s.catalog.get(rob, name, "1.0.0"), await s.catalog.get(rob, name, "1.1.0")], [undefined, undefined]);
    assert.equal((await s.catalog.get(rob, name))!.version, "1.2.0");
  } finally { await c.close(); cleanup(d); }
});

test("a claim stamped in the future (the clock was set back) is void: runs start on the version again (card T02c re-review)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-catfx-"));
  const { c, s, ann, project, task, publish } = await world(d);
  try {
    const name = await publish(["1.0.0"]);
    const t = await task("one");
    const v = (await c.storage.listAggregates("catalog-version", { limit: 10 })).find((x) => (x.body as { version?: string }).version === "1.0.0")!;
    const claim = async (at: string, n: string): Promise<void> => {
      const cur = (await c.storage.getAggregate({ kind: "catalog-version", id: v.id }))!;
      await c.storage.applyOperation({ operationId: `claim-${n}`, epoch: c.epoch, actor: "test", correlationId: "claim", at: new Date().toISOString(), changes: [{ type: "update", ref: { kind: "catalog-version", id: v.id }, expectedRevision: cur.revision, body: { ...(cur.body as object), dropping: at } as never }], audit: [{ type: "test.claim", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
    };
    await claim(new Date(Date.now() + 3_600_000).toISOString(), "future");
    assert.equal((await s.catalog.authorizeRun(ann, { commandId: "run-future", name, version: "1.0.0", taskId: t, projectId: project, host })).ready, true, "a claim from the future does not hold the version");
    await claim(new Date().toISOString(), "now");
    await assert.rejects(s.catalog.authorizeRun(ann, { commandId: "run-now", name, version: "1.0.0", taskId: t, projectId: project, host }), /being checked for removal/);
  } finally { await c.close(); cleanup(d); }
});

test("revoked versions keep their record and digest; the executable text is blanked after revokedBytesDays (default 90, null keeps it), unless another live version uses the same text (card T02c fix)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-catfx-"));
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const { c, s, boot, rob, ann, call, publish, note } = await world(d);
  try {
    const name = await publish(["1.0.0", "1.1.0"]);
    assert.equal((await call(boot, "retention.settings.get", {})).result.item.effective.revokedBytesDays, 90);
    assert.equal((await call(boot, "retention.settings.get", {})).result.item.effective.revokedBytesBlank, false, "the blanking switch is off by default");
    await s.catalog.revoke(rob, { commandId: "rv", name, version: "1.0.0", reason: "bad" });
    assert.ok((await call(boot, "retention.settings.set", { revokedBytesBlank: true }, "s-on0")).ok);
    const fresh = (await call(boot, "retention.run", { dryRun: true }, "p0")).result;
    assert.deepEqual(fresh.revokedBytes.candidates, [], "a revocation made now is not old enough");
    const ageDays = async (days: number): Promise<void> => {
      // Move the revocation into the past by rewriting its time (the record is the owner's act; a test may only age it).
      const id = (await c.storage.listAggregates("catalog-revocation", { limit: 10 }))[0]!;
      await c.storage.applyOperation({ operationId: `age-${days}-${nowMs++}`, epoch: c.epoch, actor: "test", correlationId: "age", at: new Date().toISOString(), changes: [{ type: "update", ref: { kind: "catalog-revocation", id: id.id }, expectedRevision: id.revision, body: { ...(id.body as object), at: new Date(Date.now() - days * 86_400_000).toISOString() } as never }], audit: [{ type: "test.age", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
    };
    await ageDays(100);
    const preview = (await call(boot, "retention.run", { dryRun: true }, "p1")).result;
    assert.deepEqual(preview.revokedBytes.candidates.map((x: any) => x.version), ["1.0.0"]);
    // The switch is off by default: nothing is a candidate until the owner turns it on.
    assert.ok((await call(boot, "retention.settings.set", { revokedBytesBlank: false }, "s-off0")).ok);
    assert.equal((await call(boot, "retention.run", { dryRun: true }, "p1b")).result.revokedBytes, undefined, "nothing is a candidate while the switch is off");
    // Disabled: nothing.
    assert.ok((await call(boot, "retention.settings.set", { revokedBytesDays: null, revokedBytesBlank: true }, "s-off")).ok);
    assert.equal((await call(boot, "retention.run", { dryRun: true }, "p2")).result.revokedBytes, undefined);
    assert.ok((await call(boot, "retention.settings.set", { revokedBytesDays: "default", revokedBytesBlank: true }, "s-on")).ok);
    const p3 = (await call(boot, "retention.run", { dryRun: true }, "p3")).result;
    const ran = await call(boot, "retention.run", { dryRun: false, confirm: p3.digest }, "r1");
    assert.ok(ran.ok, JSON.stringify(ran));
    assert.equal(ran.result.revokedBytes.blanked, 1);
    // The record, digest and revocation stay; the text is gone and says why.
    const v = (await s.catalog.get(rob, name, "1.0.0"))!;
    assert.equal(v.revoked?.reason, "bad");
    assert.match(v.digest, /^[0-9a-f]{64}$/);
    await assert.rejects(s.catalog.content(rob, name, "1.0.0", "executable"), /removed/);
    assert.equal(await s.catalog.content(rob, name, "1.1.0", "executable"), "code 1.1.0", "a live version keeps its text");
    assert.equal((await call(boot, "catalog.revocations", {})).result.total, 1);
    // A text shared with a live version is not blanked.
    const shared = await note("shared code");
    await s.catalog.register(ann, { commandId: "reg-2", name: "other", kind: "tool", version: "1.0.0", manifest, instructionsRecordId: await note("r2"), executableRecordId: shared } as never);
    await s.catalog.register(ann, { commandId: "reg-3", name: "other", kind: "tool", version: "1.1.0", manifest, instructionsRecordId: await note("r3"), executableRecordId: shared } as never);
    await s.catalog.revoke(rob, { commandId: "rv2", name: (await s.catalog.list(rob)).find((x) => x.name.endsWith("other"))!.name, version: "1.0.0", reason: "bad too" });
    const rows = await c.storage.listAggregates("catalog-revocation", { limit: 10 });
    for (const r of rows) await c.storage.applyOperation({ operationId: `age2-${r.id}-${nowMs++}`, epoch: c.epoch, actor: "test", correlationId: "age", at: new Date().toISOString(), changes: [{ type: "update", ref: { kind: "catalog-revocation", id: r.id }, expectedRevision: r.revision, body: { ...(r.body as object), at: new Date(Date.now() - 200 * 86_400_000).toISOString() } as never }], audit: [{ type: "test.age", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
    const p4 = (await call(boot, "retention.run", { dryRun: true }, "p4")).result;
    assert.deepEqual(p4.revokedBytes.candidates, [], "the text the live 1.1.0 uses stays");
  } finally { await c.close(); cleanup(d); }
});

test("a record that was the source of a registration and has changed since (a new revision) is not blanked when the version is revoked; a cited one is not either (card T02c re-review)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-catfx-"));
  const { c, s, boot, rob, ann, call, project, note } = await world(d);
  try {
    const code = await note("code to ship");
    const readme = await note("readme");
    await s.catalog.register(ann, { commandId: "reg-a", name: "edited", kind: "tool", version: "1.0.0", manifest, instructionsRecordId: readme, executableRecordId: code } as never);
    // The agent keeps working in the same record.
    const cur = await s.desks.read(ann, code);
    await s.desks.revise(ann, { commandId: "rev-1", recordId: code, expectedRevision: cur.revision, status: "superseded" } as never);
    const name = (await s.catalog.list(rob)).find((x) => x.name.endsWith("edited"))!.name;
    await s.catalog.revoke(rob, { commandId: "rv", name, version: "1.0.0", reason: "bad" });
    const row = (await c.storage.listAggregates("catalog-revocation", { limit: 10 }))[0]!;
    await c.storage.applyOperation({ operationId: "age-x", epoch: c.epoch, actor: "test", correlationId: "age", at: new Date().toISOString(), changes: [{ type: "update", ref: { kind: "catalog-revocation", id: row.id }, expectedRevision: row.revision, body: { ...(row.body as object), at: "2020-01-01T00:00:00.000Z" } as never }], audit: [{ type: "test.age", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
    assert.ok((await call(boot, "retention.settings.set", { revokedBytesBlank: true }, "on")).ok);
    const pre = (await call(boot, "retention.run", { dryRun: true }, "p1")).result;
    assert.deepEqual(pre.revokedBytes.candidates, [], "an edited record is not the revoked content");
    const ran = await call(boot, "retention.run", { dryRun: false, confirm: pre.digest }, "r1");
    assert.ok(ran.ok, JSON.stringify(ran));
    const after = (await c.storage.getAggregate({ kind: "desk-record", id: code }))!;
    assert.equal((after.body as unknown as { body: string }).body, "code to ship", "the record keeps its text");
    assert.ok(after.revision > cur.revision);
    assert.equal((after.body as unknown as { deleted?: unknown }).deleted, undefined);
    void project;
  } finally { await c.close(); cleanup(d); }
});

test("a catalogue rule changed between the preview and the run makes the old confirmation fail, and nothing is dropped (card T02c fix)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-catfx-"));
  const { c, s, boot, rob, call, publish } = await world(d);
  try {
    const name = await publish(["1.0.0", "1.1.0", "1.2.0"]);
    assert.ok((await call(boot, "retention.settings.set", { catalogVersionsKept: 2 }, "k1")).ok);
    const preview = (await call(boot, "retention.run", { dryRun: true }, "p1")).result;
    assert.deepEqual(preview.catalogVersions.candidates.map((v: any) => v.version), ["1.0.0"]);
    assert.ok((await call(boot, "retention.settings.set", { catalogVersionsKept: 1 }, "k2")).ok);
    const refused = await call(boot, "retention.run", { dryRun: false, confirm: preview.digest }, "r1");
    assert.equal(refused.error?.code, "invalid_command");
    assert.ok((await s.catalog.get(rob, name, "1.0.0")) !== undefined && (await s.catalog.get(rob, name, "1.1.0")) !== undefined, "nothing was dropped");
  } finally { await c.close(); cleanup(d); }
});

test("a damaged policy record reads as cancel and says so (card T02c fix)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-catfx-"));
  const { c, boot, call } = await world(d);
  try {
    await c.storage.applyOperation({ operationId: "damage-1", epoch: c.epoch, actor: "test", correlationId: "d", at: new Date().toISOString(), changes: [{ type: "create", ref: { kind: "catalog-policy", id: "main" }, body: { runningCalls: "explode" } as never }], audit: [{ type: "test.damage", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
    const item = (await call(boot, "catalog.policy.get", {})).result.item;
    assert.deepEqual([item.damaged, item.runningCalls, item.effective, item.source], [true, null, "cancel", "damaged"]);
  } finally { await c.close(); cleanup(d); }
});
