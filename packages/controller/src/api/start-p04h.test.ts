import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { CoverageGapService } from "../projects/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
type Reply = { ok: boolean; result?: any; error?: { code: string; message?: string } };

test("through the running controller: a lease that keeps others waiting is told once and closed when it ends; an expiry notice closes when the lease is taken over; gaps narrow to what a responsibility depends on; a suspended agent's responsibilities get a note (card P04h)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-p04h-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], dispatch: { timer: new ManualTimer(), intervalMs: 1000 } });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const owner = await c.services.principals.authenticate(boot.token);
    const call = (op: string, args: Record<string, unknown>, commandId?: string, token = boot.token) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    const project = (await call("project.create", { name: "Ops" }, "p1")).result.id as string;
    const res = (await call("resource.bind", { projectId: project, kind: "service", label: "Web", locator: "https://example.test" }, "b1")).result.id as string;
    const res2 = (await call("resource.bind", { projectId: project, kind: "service", label: "Db", locator: "https://db.example.test" }, "b2")).result.id as string;
    const duty = (await call("responsibility.create", { projectId: project, title: "Keep web up", objective: "Up", everyMinutes: 60, managed: [res, res2], escalation: { to: "owner" } }, "r1")).result.id as string;
    await c.services.principals.enroll(owner, { commandId: "e-rival", kind: "agent", name: "rival", grants: [{ action: "responsibility.read", project }, { action: "responsibility.write", project }] as never });
    const rival = (await c.services.principals.issueCredential(owner, "agent:rival")).token;
    const items = async (needle: string) => (await c.storage.listAggregates("notification-item", { limit: 100 })).filter((a) => JSON.stringify(a.body).includes(needle));
    const open = (list: { body: unknown }[]) => list.filter((a) => (a.body as { state: string }).state !== "settled" && (a.body as { state: string }).state !== "answered");
    const tickN = async (k = 3): Promise<void> => { for (let i = 0; i < k; i++) await c.dispatch!.dispatcher.tick(); };
    const patch = async (resourceId: string, tag: string, change: (b: any) => any): Promise<void> => {
      const lease = (await c.storage.listAggregates("maintenance-lease", { limit: 50 })).find((a) => (a.body as { resourceId?: string }).resourceId === resourceId)!;
      await c.storage.applyOperation({ operationId: `patch-${tag}`, epoch: c.epoch, actor: "owner:rob", correlationId: `patch-${tag}`, at: new Date().toISOString(), changes: [{ type: "update", ref: { kind: "maintenance-lease", id: lease.id }, expectedRevision: lease.revision, body: change(lease.body) }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
    };
    const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

    // 1. A lease still in time keeps the rival waiting: told only once the wait is long, once, and the notice closes when the lease is released.
    assert.equal((await call("lease.acquire", { resourceId: res, purpose: "upgrade", minutes: 240 }, "a1")).result.status, "granted");
    assert.equal((await call("lease.acquire", { resourceId: res, purpose: "patch" }, "a2", rival)).result.status, "blocked");
    await tickN();
    assert.equal((await items("kept 1 other attempt")).length, 0, "a short wait tells nothing");
    await patch(res, "w", (b) => ({ ...b, acquiredAt: ago(90), blocked: b.blocked.map((x: any) => ({ ...x, at: ago(45) })) }));
    await tickN();
    assert.equal(open(await items("kept 1 other attempt")).length, 1, "the owner was told");
    await tickN();
    assert.equal((await items("kept 1 other attempt")).length, 1, "once");
    assert.equal((await call("lease.list", { projectId: project })).result.items.find((l: any) => l.resourceId === res).status, "held", "telling does not release it");
    assert.ok((await call("lease.release", { resourceId: res, evidence: "holder is gone" }, "a3")).ok);
    await tickN();
    assert.equal(open(await items("kept 1 other attempt")).length, 0, "released: the notice is closed");

    // 2. An expiry notice is closed when another agent takes the lease over.
    assert.equal((await call("lease.acquire", { resourceId: res2, purpose: "migrate", minutes: 30 }, "a4")).result.status, "granted");
    await patch(res2, "e", (b) => ({ ...b, expiresAt: ago(10) }));
    await tickN();
    assert.equal(open(await items("ran out with nobody releasing")).length, 1);
    await tickN();
    assert.equal(open(await items("ran out with nobody releasing")).length, 1, "stays while the lease is still expired");
    assert.equal((await call("lease.acquire", { resourceId: res2, purpose: "take over" }, "a5", rival)).result.status, "granted");
    await tickN();
    assert.equal(open(await items("ran out with nobody releasing")).length, 0, "taken over: closed");
    assert.equal((await items("ran out with nobody releasing")).length, 1);

    // 3. Gaps narrow: a source outage concerns only a responsibility that names the source; a provider outage only one with an answering agent.
    const watcher = (await call("responsibility.create", { projectId: project, title: "Watch files", objective: "React", eventSources: ["files:changed"], escalation: { to: "owner" } }, "r2")).result.id as string;
    const byKind = (await call("responsibility.create", { projectId: project, title: "Watch pushes", objective: "React", eventSources: ["push"], escalation: { to: "owner" } }, "r2b")).result.id as string;
    const gaps = CoverageGapService.withEpoch(c.storage, c.epoch);
    const start = ago(5);
    await gaps.open(owner, { key: "source:git", reason: "event-source-outage", start, detail: "git unreadable" } as never);
    await gaps.open(owner, { key: "source:files", reason: "event-source-outage", start, detail: "files unreadable" } as never);
    await gaps.open(owner, { key: "provider:model:m1", reason: "provider-outage", start, detail: "route down" } as never);
    const reasons = async (id: string) => ((await call("responsibility.observed", { responsibilityId: id })).result.item.coverageGaps as any[]).map((g) => `${g.reason}`);
    assert.deepEqual(await reasons(watcher), ["event-source-outage"], "only the source it names (no answering agent, so the provider route is not about it)");
    assert.deepEqual(await reasons(duty), [], "names no source and has no answering agent: neither gap is about it");
    assert.deepEqual(await reasons(byKind), ["event-source-outage", "event-source-outage"], "a bare name may be a kind any source sends: every source outage is listed");
    assert.equal((await call("responsibility.gaps", { projectId: project })).result.items.length, 3, "the list of gaps stays whole");

    // 4. A Suspend of the answering agent leaves a note on each of its responsibilities.
    const agent = (await call("agent.create", { friendlyName: "Ann" }, "ag1")).result.id as string;
    const owned = (await call("responsibility.create", { projectId: project, title: "Keep db up", objective: "Up", everyMinutes: 60, ownerId: `agent:${agent}`, escalation: { to: "owner" } }, "r3"))
    assert.ok(owned.ok, JSON.stringify(owned));
    const stop = await call("lifecycle.stop", { scope: { kind: "agent", id: agent }, mode: "suspend", reason: "night" }, "st1");
    assert.ok(stop.ok, JSON.stringify(stop));
    await call("lifecycle.sweep", {}); await tickN();
    const history = (await call("responsibility.history", { responsibilityId: owned.result.id, limit: 20 })).result.items as { kind: string; summary: string }[];
    const note = history.filter((h) => h.kind === "note" && h.summary.includes("does not stop the service it maintains"));
    assert.equal(note.length, 1, JSON.stringify(history));
    assert.match(note[0]!.summary, /agent:.* was suspended\..*"Keep db up"/);
    assert.equal((note[0] as unknown as { by: string }).by, "service:stop-notes", "written under the controller's own name, not the name of whoever settled the request");
    assert.deepEqual((await call("responsibility.history", { responsibilityId: duty, limit: 20 })).result.items.filter((h: any) => h.summary.includes("was suspended")), [], "another agent's responsibility is not noted");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
