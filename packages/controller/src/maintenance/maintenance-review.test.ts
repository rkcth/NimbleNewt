import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { AgentService } from "../agents/index.js";
import { GrantService, PrincipalService, type Principal } from "../security/index.js";
import { scopedCommandId } from "../security/credentials.js";
import { FakeApplier, MaintenanceService, type MaintenanceBody } from "./index.js";

after(stopServer);

const D = (c: string): string => `sha256:${c.repeat(64)}`;
const SRC = "https://registry.example.org/pkg";
const pkg = (name: string, extra: Record<string, unknown> = {}) => ({ name, version: "1.2.3", digest: D("a"), source: SRC, installScripts: false, ...extra });
let n = 0;
const cid = (l: string): string => `${l}-${n++}`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface World {
  readonly m: MaintenanceService; readonly applier: FakeApplier; readonly owner: Principal; readonly agents: AgentService; readonly grants: GrantService; readonly principals: PrincipalService;
  readonly time: { ms: number };
  service(extra?: { heartbeatMs?: number; applyTimeoutMs?: number }): MaintenanceService;
  make(name: string, by?: Principal, supervisorId?: string): Promise<{ id: string; principal: Principal }>;
  body(id: string): Promise<MaintenanceBody & { revision: number }>;
  until(id: string, want: string): Promise<void>;
  storage: import("../storage/types.js").ControllerStorage;
  /** A service on another view of the same storage (to step into the middle of a command). */
  serviceOn(storage: import("../storage/types.js").ControllerStorage): MaintenanceService;
}
async function world(backendIndex: number, body: (w: World) => Promise<void>, heartbeatMs = 0): Promise<void> {
  const backend = backends[backendIndex]!;
  const open = await backend.open();
  try {
    const time = { ms: Date.parse("2026-10-31T10:00:00.000Z") };
    const options = { clock: () => new Date(time.ms).toISOString(), pause: async () => undefined };
    const projects = await ProjectService.open(open.storage, { holder: "c1", ...options });
    const principals = PrincipalService.withEpoch(open.storage, projects.epoch, options);
    const agents = AgentService.withEpoch(open.storage, projects.epoch, options);
    const grants = GrantService.withEpoch(open.storage, projects.epoch, options);
    const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
    const applier = new FakeApplier();
    const service = (extra: { heartbeatMs?: number; applyTimeoutMs?: number } = {}) => MaintenanceService.withEpoch(open.storage, projects.epoch, { applier, heartbeatMs, ...extra }, options);
    const m = service();
    const make: World["make"] = async (friendlyName, by = owner, supervisorId) => {
      const created = await agents.create(by, { commandId: cid("a"), friendlyName, ...(supervisorId === undefined ? {} : { supervisorId }) });
      return { id: created.id, principal: await principals.authenticate((await principals.issueCredential(owner, `agent:${created.id}`)).token) };
    };
    const getBody = async (id: string) => { const a = (await open.storage.getAggregate({ kind: "maintenance", id }))!; return { ...(a.body as unknown as MaintenanceBody), revision: a.revision }; };
    const until = async (id: string, want: string): Promise<void> => { for (let i = 0; i < 200 && (await getBody(id)).status !== want; i++) await sleep(10); assert.equal((await getBody(id)).status, want); };
    const serviceOn = (storage: import("../storage/types.js").ControllerStorage) => MaintenanceService.withEpoch(storage, projects.epoch, { applier, heartbeatMs }, options);
    await body({ m, applier, owner, agents, grants, principals, time, service, make, body: getBody, until, storage: open.storage, serviceOn });
    await m.idle();
  } finally { await open.close(); }
}
const settle = async (w: World): Promise<void> => { await w.m.idle(); };
const request = (w: World, p: Principal, kind: string, spec: unknown, label = cid("r")) => w.m.request(p, { commandId: label, kind, spec, reason: "needed", rollbackPlan: "undo it" });
const refuses = async (code: string, run: () => Promise<unknown>): Promise<void> => { await assert.rejects(run, (e: unknown) => { assert.ok(e instanceof DomainError, String(e)); assert.equal(e.code, code, (e as Error).message); return true; }); };
const specOf = (w: World, id: string) => w.body(id).then((b) => b.specDigest);
const approve = async (w: World, id: string) => w.m.decide(w.owner, { commandId: cid("d"), maintenanceId: id, verdict: "approve", specDigest: await specOf(w, id) });

// ---- A09 fifth slice: what a reviewer sees, a review that does not come, and the approval gate (2026-11-12) ---------------------------------

for (const [index, backend] of backends.entries()) {
  test(`the owner, the requester and the requester's supervisor read one summary of the exact artifact, source, access, install behaviour and rollback plan; it is derived, not stored, and nobody else reads it (${backend.name})`, async () => {
    await world(index, async (w) => {
      const boss = await w.make("Boss");
      const ann = await w.make("Ann", w.owner, boss.id);
      const eve = await w.make("Eve");
      const plain = await request(w, ann.principal, "package", pkg("ripgrep"));
      const scripted = await request(w, ann.principal, "package", pkg("native-thing", { installScripts: true, digest: D("c") }));
      const mount = await request(w, ann.principal, "mount", { mountPath: "/data/shared", resource: "shared.docs", mode: "read" });
      const base = await request(w, ann.principal, "base", { change: "add a compiler" });
      for (const reader of [w.owner, ann.principal, boss.principal]) {
        const got = (await w.m.get(reader, plain.maintenanceId)).review as Record<string, unknown>;
        assert.equal(got.change, "package ripgrep@1.2.3");
        assert.equal(got.source, SRC);
        assert.equal(got.digest, D("a"));
        assert.equal(got.installScripts, false);
        assert.match(String(got.installBehaviour), /no install scripts/);
        assert.equal(got.rollback, "undo it");
        assert.equal(got.reversible, true);
      }
      const s = (await w.m.get(w.owner, scripted.maintenanceId)).review as Record<string, unknown>;
      assert.equal(s.installScripts, true);
      assert.match(String(s.installBehaviour), /only after approval of exactly this digest, inside the sandbox with no network/);
      assert.equal(s.digest, D("c"));
      assert.match(String(((await w.m.get(w.owner, mount.maintenanceId)).review as Record<string, unknown>).access), /read access to shared\.docs/);
      const b = (await w.m.get(w.owner, base.maintenanceId)).review as Record<string, unknown>;
      assert.equal(b.reversible, false); assert.match(String(b.access), /owner decides/);
      assert.equal((await w.body(plain.maintenanceId) as unknown as Record<string, unknown>).review, undefined, "the summary is derived from the record, not kept in it");
      assert.equal((await w.m.list(w.owner, { agentId: ann.principal.id })).items.every((i) => typeof i.review === "object"), true, "listing carries it too");
      await refuses("not_found", () => w.m.get(eve.principal, plain.maintenanceId));
    });
  });

  test(`a review that does not come leaves the request pending and nothing installed, through ticks, enforcement and a restart; a decision that is refused changes nothing; the decision that finally comes applies once (${backend.name})`, async () => {
    await world(index, async (w) => {
      const ann = await w.make("Ann");
      const ben = await w.make("Ben");
      const asked = await request(w, ann.principal, "package", pkg("slow-review"));
      assert.equal(asked.status, "pending");
      for (let i = 0; i < 3; i++) { await w.m.tick(); await w.m.enforce(); await w.service().resume(); }
      await settle(w);
      assert.equal((await w.body(asked.maintenanceId)).status, "pending", "still waiting");
      assert.equal(w.applier.calls.length, 0, "the applier was never asked");
      // The approval gate: the requester, a peer, a wrong digest and a stale revision change nothing.
      const digest = await specOf(w, asked.maintenanceId);
      await refuses("forbidden", () => w.m.decide(ann.principal, { commandId: cid("d"), maintenanceId: asked.maintenanceId, verdict: "approve", specDigest: digest }));
      await refuses("not_found", () => w.m.decide(ben.principal, { commandId: cid("d"), maintenanceId: asked.maintenanceId, verdict: "approve", specDigest: digest }));
      await refuses("invalid_command", () => w.m.decide(w.owner, { commandId: cid("d"), maintenanceId: asked.maintenanceId, verdict: "approve", specDigest: D("9") }));
      await refuses("stale_revision", () => w.m.decide(w.owner, { commandId: cid("d"), maintenanceId: asked.maintenanceId, verdict: "approve", specDigest: digest, expectedRevision: 99 }));
      await settle(w);
      assert.equal((await w.body(asked.maintenanceId)).status, "pending");
      assert.equal(w.applier.calls.length, 0);
      // A restart of the controller (a new service on the same storage) still finds it waiting; the owner's decision then applies it once.
      const again = w.service();
      await again.resume(); await again.idle();
      assert.equal((await w.body(asked.maintenanceId)).status, "pending");
      await again.decide(w.owner, { commandId: cid("d"), maintenanceId: asked.maintenanceId, verdict: "approve", specDigest: digest });
      await again.idle();
      assert.equal((await w.body(asked.maintenanceId)).status, "applied");
      assert.equal(w.applier.calls.filter((c) => c.op === "apply").length, 1);
      // Deciding again is refused, and does not apply a second time.
      await refuses("invalid_transition", () => w.m.decide(w.owner, { commandId: cid("d"), maintenanceId: asked.maintenanceId, verdict: "approve", specDigest: digest }));
      assert.equal(w.applier.calls.filter((c) => c.op === "apply").length, 1);
    });
  });
}
