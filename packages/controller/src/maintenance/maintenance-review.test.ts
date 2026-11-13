import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { AgentService } from "../agents/index.js";
import { GrantService, PrincipalService, type Principal } from "../security/index.js";
import { scopedCommandId } from "../security/credentials.js";
import { FakeApplier, MaintenanceService, type ArtifactInspection, type MaintenanceBody, type MaintenanceOptions } from "./index.js";

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
  service(extra?: { heartbeatMs?: number; applyTimeoutMs?: number; held?: (agentId: string) => Promise<boolean>; inspector?: NonNullable<MaintenanceOptions["inspector"]>; inspectTimeoutMs?: number; inspectQueue?: number }): MaintenanceService;
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
    const service = (extra: { heartbeatMs?: number; applyTimeoutMs?: number; held?: (agentId: string) => Promise<boolean>; inspector?: NonNullable<MaintenanceOptions["inspector"]>; inspectTimeoutMs?: number; inspectQueue?: number } = {}) => MaintenanceService.withEpoch(open.storage, projects.epoch, { applier, heartbeatMs, ...extra }, options);
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
        assert.equal(got.rollback, "the requester's plan, not checked by the platform: undo it", "the rollback plan is shown as the requester's claim");
        assert.deepEqual(got.requesterClaims, ["installScripts", "rollback"]);
        assert.match(String(got.access), /runs with whatever access the agent itself has/, "installed code is not said to have no access");
        assert.equal(got.warning, undefined);
        assert.match(String(got.checked), /who made them is not checked/, "the name is not presented as proof of what the package is");
        assert.equal(got.reversible, true);
      }
      const s = (await w.m.get(w.owner, scripted.maintenanceId)).review as Record<string, unknown>;
      assert.equal(s.installScripts, true);
      assert.match(String(s.installBehaviour), /only after approval of exactly this digest, and only inside the sandbox with no network \(in the disposable trial and again when the agent's environment is built\)/);
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

  test(`the summary cleans what it shows: a direction-changing or invisible character and a secret-shaped value are left out or marked, with a warning; a source carrying one is refused at the door; nothing calls the change safe (${backend.name})`, async () => {
    await world(index, async (w) => {
      const ann = await w.make("Ann");
      const rlo = "‮", zw = "​";
      // A URL never needs an invisible character: one in the source is refused, for a request and for the owner's catalogue.
      for (const bad of [`${SRC}/x${rlo}gpj.exe`, `${SRC}/a${zw}b`, `${SRC}/a\u0085b`]) {
        await refuses("invalid_command", () => request(w, ann.principal, "package", pkg("hidden-src", { source: bad })));
        await refuses("invalid_command", () => w.m.catalogue(w.owner, { commandId: cid("c"), add: true, name: "hidden-src", version: "1.2.3", digest: D("a"), source: bad }));
      }
      // Free text keeps its characters in the record, and the reviewer reads it cleaned and warned about.
      const key = "gh" + "p_" + "Q7".repeat(18);
      const tricky = await w.m.request(ann.principal, { commandId: cid("r"), kind: "package", spec: pkg("tricky", { source: `${SRC}/tricky` }), reason: "needed", rollbackPlan: `remove it${rlo}${zw} and keep the data` });
      const r = (await w.m.get(w.owner, tricky.maintenanceId)).review as Record<string, unknown>;
      const all = JSON.stringify(r);
      assert.equal([...all].some((ch) => ch === rlo || ch === zw), false, "no direction-changing or invisible character is shown");
      assert.equal(all.includes(key), false, "the secret-shaped value is not shown");
      assert.match(String(r.rollback), /^the requester's plan, not checked by the platform: remove it and keep the data$/);
      assert.match(String(r.warning), /invisible or direction-changing characters or a secret-shaped value/);
      // An older record (stored before the source rule) is shown cleaned as well.
      const rec = (await w.storage.getAggregate({ kind: "maintenance", id: tricky.maintenanceId }))!;
      const body = rec.body as unknown as MaintenanceBody;
      await w.storage.applyOperation({ operationId: cid("old-op"), epoch: await w.storage.currentEpoch(), actor: "owner:test", correlationId: cid("co"), at: "2026-10-31T10:00:00.000Z", changes: [{ type: "update", ref: rec, expectedRevision: rec.revision, body: { ...body, spec: { ...body.spec, source: `${SRC}/old${rlo}exe.txt` } } as never }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeTimers: [], settleEffects: [], completeDeliveries: [] } as never);
      const old = (await w.m.get(ann.principal, tricky.maintenanceId)).review as Record<string, unknown>;
      assert.equal(old.source, `${SRC}/oldexe.txt`);
      assert.equal(typeof old.warning, "string");
      // A source stored before the query-string rule (the request is refused today, see the sixth slice) is still shown without its secret.
      await w.storage.applyOperation({ operationId: cid("old-op"), epoch: await w.storage.currentEpoch(), actor: "owner:test", correlationId: cid("co"), at: "2026-10-31T10:00:00.000Z", changes: [{ type: "update", ref: { kind: "maintenance", id: tricky.maintenanceId }, expectedRevision: (await w.storage.getAggregate({ kind: "maintenance", id: tricky.maintenanceId }))!.revision, body: { ...body, spec: { ...body.spec, source: `${SRC}/tricky?access=${key}` } } as never }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeTimers: [], settleEffects: [], completeDeliveries: [] } as never);
      const older = (await w.m.get(ann.principal, tricky.maintenanceId)).review as Record<string, unknown>;
      assert.equal(JSON.stringify(older).includes(key), false, "the secret-shaped value in an older source is not shown");
      assert.match(String(older.source), /\[redacted\]/);
      // No summary of any kind judges the change: it never says safe.
      const kinds: [string, unknown][] = [["package", pkg("p1")], ["extension", { ...pkg("e1"), installScripts: true }], ["mount", { mountPath: "/data/x", resource: "shared.x", mode: "write" }], ["network", { site: "n.example.net", port: 22 }], ["skill", { name: "s1", digest: D("b") }], ["host-policy", { setting: "cpu", change: "more" }], ["base", { change: "add a tool" }]];
      for (const [kind, spec] of kinds) {
        const made = await w.m.request(w.owner, { commandId: cid("r"), agentId: ann.principal.id, kind, spec, reason: "needed", ...(kind === "skill" ? {} : { rollbackPlan: "undo it" }) });
        const text = JSON.stringify((await w.m.get(w.owner, made.maintenanceId)).review);
        assert.doesNotMatch(text, /\bsafe(ly)?\b/i, `${kind}: ${text}`);
      }
    });
  });

  test(`nobody decides their own request, even where the record says the requester supervises itself (a record no command can write) (${backend.name})`, async () => {
    await world(index, async (w) => {
      const ann = await w.make("Ann");
      await w.m.toggle(w.owner, { commandId: cid("t"), what: "bosses", enabled: true });
      await w.m.change(w.owner, { commandId: cid("s"), bossKinds: ["network", "package"] });
      await settle(w);
      const rec = (await w.storage.getAggregate({ kind: "agent", id: ann.id }))!;
      await w.storage.applyOperation({ operationId: cid("self-op"), epoch: await w.storage.currentEpoch(), actor: "owner:test", correlationId: cid("co"), at: "2026-10-31T10:00:00.000Z", changes: [{ type: "update", ref: { kind: "agent", id: ann.id }, expectedRevision: rec.revision, body: { ...(rec.body as Record<string, unknown>), supervisorId: ann.id, supervisorSetBy: w.owner.id } as never }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeTimers: [], settleEffects: [], completeDeliveries: [] } as never);
      for (const [kind, spec] of [["network", { site: "self.example.net" }], ["package", pkg("self-pkg")]] as const) {
        const asked = await request(w, ann.principal, kind, spec);
        assert.equal(asked.status, "pending");
        const digestOf = await specOf(w, asked.maintenanceId);
        await refuses("forbidden", () => w.m.decide(ann.principal, { commandId: cid("d"), maintenanceId: asked.maintenanceId, verdict: "approve", specDigest: digestOf }));
        await refuses("forbidden", () => w.m.decide(ann.principal, { commandId: cid("d"), maintenanceId: asked.maintenanceId, verdict: "reject", specDigest: digestOf }));
        assert.equal((await w.body(asked.maintenanceId)).status, "pending");
        await w.m.revoke(ann.principal, { commandId: cid("v"), maintenanceId: asked.maintenanceId, reason: "mine" });
        assert.equal((await w.body(asked.maintenanceId)).status, "withdrawn", "the requester may withdraw its own request, never approve it");
      }
      assert.equal(w.applier.calls.length, 0);
      // A real supervisor decides a kind handed over, but never with the credential its worker holds for a task: a task credential never decides.
      const boss = await w.make("Boss");
      const bob = await w.make("Bob", w.owner, boss.id);
      const asked = await request(w, bob.principal, "network", { site: "bob.example.net" });
      const digest = await specOf(w, asked.maintenanceId);
      const onTask = { ...boss.principal, taskScope: { taskId: "tsk-anything", projectId: "prj-anything" } } as Principal;
      await refuses("forbidden", () => w.m.decide(onTask, { commandId: cid("d"), maintenanceId: asked.maintenanceId, verdict: "approve", specDigest: digest }));
      assert.equal((await w.body(asked.maintenanceId)).status, "pending");
      assert.equal((await w.m.decide(boss.principal, { commandId: cid("d"), maintenanceId: asked.maintenanceId, verdict: "approve", specDigest: digest })).status, "applied");
    });
  });

  test(`a preapproved catalogue entry approves only its exact artifact: another digest, another source or install scripts it does not allow wait for a decider, and nothing is applied (${backend.name})`, async () => {
    await world(index, async (w) => {
      const ann = await w.make("Ann");
      await w.m.catalogue(w.owner, { commandId: cid("c"), add: true, name: "cat-pkg", version: "1.2.3", digest: D("a"), source: SRC });
      await settle(w);
      for (const [label, extra] of [["another digest", { digest: D("b") }], ["another source", { source: `${SRC}/elsewhere` }], ["install scripts", { installScripts: true }], ["another version", { version: "1.2.4" }]] as const) {
        const asked = await request(w, ann.principal, "package", pkg("cat-pkg", extra));
        await settle(w);
        assert.equal(asked.status, "pending", label);
        assert.equal((await w.body(asked.maintenanceId)).decision, undefined, label);
      }
      assert.equal(w.applier.calls.length, 0, "nothing outside the entry was applied");
      const exact = await request(w, ann.principal, "package", pkg("cat-pkg"));
      await settle(w);
      assert.equal((await w.body(exact.maintenanceId)).decision?.rule, "catalogue");
      assert.equal((await w.body(exact.maintenanceId)).status, "applied");
    });
  });

  test(`a supervisor's approval is judged again when the application starts: one that waited and whose authority the owner took back meanwhile goes back to waiting and is never applied (${backend.name})`, async () => {
    await world(index, async (w) => {
      const boss = await w.make("Boss");
      const bob = await w.make("Bob", w.owner, boss.id);
      await w.m.toggle(w.owner, { commandId: cid("t"), what: "bosses", enabled: true });
      await w.m.change(w.owner, { commandId: cid("s"), bossKinds: ["package", "network"] });
      await settle(w);
      for (const takeBack of ["bosses off", "kind withdrawn"] as const) {
        const asked = await request(w, bob.principal, "package", pkg(`boss-${takeBack.replace(" ", "-")}`));
        w.applier.nextApply.push({ outcome: "unsupported", reason: "the host cannot take it now" });
        const decided = await w.m.decide(boss.principal, { commandId: cid("d"), maintenanceId: asked.maintenanceId, verdict: "approve", specDigest: await specOf(w, asked.maintenanceId) });
        assert.equal(decided.status, "approved", "it waits for the host");
        const before = w.applier.calls.filter((c) => c.op === "apply" && c.id === asked.maintenanceId).length;
        if (takeBack === "bosses off") await w.m.toggle(w.owner, { commandId: cid("t"), what: "bosses", enabled: false });
        else await w.m.change(w.owner, { commandId: cid("s"), bossKinds: ["network"] });
        await settle(w);
        for (let i = 0; i < 2; i++) { await w.m.tick(); await w.m.resume(); }
        await settle(w);
        const b = await w.body(asked.maintenanceId);
        assert.equal(b.status, "pending", `${takeBack}: ${b.status}`);
        assert.equal(w.applier.calls.filter((c) => c.op === "apply" && c.id === asked.maintenanceId).length, before, `${takeBack}: the applier was not asked again`);
        // Put the authority back for the next round.
        await w.m.toggle(w.owner, { commandId: cid("t"), what: "bosses", enabled: true });
        await w.m.change(w.owner, { commandId: cid("s"), bossKinds: ["package", "network"] });
        await settle(w);
      }
    });
  });

  test(`two decisions at the same moment, from two controllers' services on one storage: exactly one counts and the applier runs at most once; an approval racing the requester's withdrawal never applies a withdrawn request (${backend.name})`, async () => {
    await world(index, async (w) => {
      const ann = await w.make("Ann");
      for (let round = 0; round < 3; round++) {
        const asked = await request(w, ann.principal, "package", pkg(`race-${round}`));
        const digest = await specOf(w, asked.maintenanceId);
        const a = w.service(), b = w.service();
        const got = await Promise.allSettled([
          a.decide(w.owner, { commandId: cid("d"), maintenanceId: asked.maintenanceId, verdict: "approve", specDigest: digest }),
          b.decide(w.owner, { commandId: cid("d"), maintenanceId: asked.maintenanceId, verdict: "reject", specDigest: digest }),
        ]);
        await a.idle(); await b.idle(); await settle(w);
        assert.equal(got.filter((g) => g.status === "fulfilled").length, 1, JSON.stringify(got.map((g) => g.status === "rejected" ? String(g.reason) : g.value)));
        const final = await w.body(asked.maintenanceId);
        const applied = w.applier.calls.filter((c) => c.op === "apply" && c.id === asked.maintenanceId).length;
        if (final.status === "rejected") assert.equal(applied, 0); else { assert.equal(final.status, "applied"); assert.equal(applied, 1); }
        assert.equal(final.decision?.by, w.owner.id);

        const second = await request(w, ann.principal, "package", pkg(`race-w-${round}`));
        const d2 = await specOf(w, second.maintenanceId);
        const both = await Promise.allSettled([
          a.decide(w.owner, { commandId: cid("d"), maintenanceId: second.maintenanceId, verdict: "approve", specDigest: d2 }),
          b.revoke(ann.principal, { commandId: cid("v"), maintenanceId: second.maintenanceId, reason: "not needed any more" }),
        ]);
        await a.idle(); await b.idle(); await settle(w);
        const end = await w.body(second.maintenanceId);
        const ran = w.applier.calls.filter((c) => c.op === "apply" && c.id === second.maintenanceId).length;
        assert.ok(both.some((g) => g.status === "fulfilled"));
        if (end.status === "withdrawn") assert.equal(ran, 0, "a withdrawn request is never applied");
        else assert.ok(["applied", "revoked"].includes(end.status), end.status);
      }
    });
  });
}

// ---- A09 sixth slice: secrets in a source's query string, and a supervisor that is held (2026-11-12) ---------------------------------------------

// Secret-shaped values are built at run time, never written whole.
const ghKey = "gh" + "p_" + "Q7".repeat(18);
const skKey = "s" + "k-" + "Zx3".repeat(12);

for (const [index, backend] of backends.entries()) {
  test(`a source whose query string or fragment carries a secret is refused at the door, for a request and for the catalogue, without repeating it; ordinary query strings and the same text in the path are accepted (${backend.name})`, async () => {
    await world(index, async (w) => {
      const ann = await w.make("Ann");
      const secret = [
        `${SRC}?token=abc123`, `${SRC}?access_token=abc123`, `${SRC}?api_key=abc123`, `${SRC}?api%5Fkey=abc123`, `${SRC}?API-KEY=abc123`, `${SRC}?X-Amz-Signature=0123abcd`, `${SRC}?sig=abc`, `${SRC}?key=abc`, `${SRC}?password=hunter2`,
        `${SRC}?download=1&secret=abc`, `${SRC}?download=1;auth=abc`, `${SRC}#token=abc`, `${SRC}?a=1#access_key=abc`, `${SRC}?%74oken=abc`, `${SRC}?t=${ghKey}`, `${SRC}?t=${skKey}`, `${SRC}?t=${encodeURIComponent(ghKey)}`, `${SRC}#${ghKey}`, `${SRC}?${ghKey}`,
        `${SRC}?authorization=Bearer%20abcdef`, `${SRC}?sessionid=abc`,
      ];
      for (const bad of secret) {
        for (const run of [() => request(w, ann.principal, "package", pkg("q-pkg", { source: bad })), () => w.m.catalogue(w.owner, { commandId: cid("c"), add: true, name: "q-pkg", version: "1.2.3", digest: D("a"), source: bad })]) {
          await assert.rejects(run, (e: unknown) => {
            assert.ok(e instanceof DomainError, String(e)); assert.equal(e.code, "invalid_command", bad);
            assert.equal(e.message.includes(ghKey) || e.message.includes(skKey) || e.message.includes("abc123"), false, "the refusal never repeats the secret");
            assert.match(e.message, /secret in its query string or fragment/);
            return true;
          });
        }
      }
      const fine = [`${SRC}?download=1`, `${SRC}?v=1.2.3&format=tgz`, `${SRC}#readme`, `${SRC}?author=bob`, `${SRC}?token=`, `${SRC}/token/abc`, `${SRC}/access_token`, `${SRC}?mirror=eu-west&arch=x86_64`];
      for (const ok of fine) {
        const made = await request(w, ann.principal, "package", pkg(`q-ok-${n}`, { source: ok }));
        assert.equal((await w.body(made.maintenanceId)).status, "pending", ok);
      }
      // Review fix: a parameter named pass or pw is a password too; a token in the PATH (as some private registries put it) is refused like one in the query string, also encoded twice.
      for (const bad of [`${SRC}?pass=abc123`, `${SRC}?pw=abc123`]) await assert.rejects(() => request(w, ann.principal, "package", pkg("q-pkg", { source: bad })), (e: unknown) => e instanceof DomainError && e.code === "invalid_command" && /secret in its query string/.test(e.message) && !e.message.includes("abc123"));
      for (const bad of [`${SRC}/${ghKey}/simple/x.tgz`, `${SRC}/r/${skKey}/x.tgz`, `${SRC}/${encodeURIComponent(encodeURIComponent(ghKey))}/x.tgz`]) {
        for (const run of [() => request(w, ann.principal, "package", pkg("q-pkg", { source: bad })), () => w.m.catalogue(w.owner, { commandId: cid("c"), add: true, name: "q-pkg", version: "1.2.3", digest: D("a"), source: bad })]) {
          await assert.rejects(run, (e: unknown) => e instanceof DomainError && e.code === "invalid_command" && /value shaped like a secret/.test(e.message) && !e.message.includes(ghKey) && !e.message.includes(skKey), bad);
        }
      }
      // Content-addressed paths and digests are not secrets: a registry file path with a long hex segment, an IPFS-style name, a pip `#sha256=` link.
      const hex = "d4dc8cbf4b79a37c8ef04c2e1361cfa027182c0e450b5f4a1c2e3d9b7a6f";
      for (const ok of [`https://files.example.org/packages/3f/2a/${hex}/requests-2.31.0-py3-none-any.whl`, `https://files.example.org/dl/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/file.tgz`, `https://files.example.org/p/requests-2.31.0.tar.gz#sha256=${hex}0a1b`]) {
        const made = await request(w, ann.principal, "package", pkg(`q-ok-${n}`, { source: ok }));
        assert.equal((await w.body(made.maintenanceId)).status, "pending", ok);
      }
      // Nothing was stored for a refusal.
      assert.equal((await w.m.list(w.owner, {})).items.every((i) => !JSON.stringify(i).includes("abc123")), true);
    });
  });

  test(`a supervisor that a pause, suspend or stop gate holds does not decide: refused while held, also when the gate cannot be read; an approval that waited is judged again at the claim; the owner is never held; once released the supervisor decides (${backend.name})`, async () => {
    const held = new Set<string>();
    let broken = false;
    await world(index, async (w) => {
      const mm = w.service({ held: async (id) => { if (broken) throw new Error("the pause gates cannot be read"); return held.has(id); } });
      const boss = await w.make("Boss");
      const bob = await w.make("Bob", w.owner, boss.id);
      await mm.toggle(w.owner, { commandId: cid("t"), what: "bosses", enabled: true });
      await mm.change(w.owner, { commandId: cid("s"), bossKinds: ["package"] });
      await mm.idle();
      const ask = (name: string) => mm.request(bob.principal, { commandId: cid("r"), kind: "package", spec: pkg(name), reason: "needed", rollbackPlan: "undo it" });
      const decide = async (by: Principal, id: string, verdict: "approve" | "reject" = "approve") => mm.decide(by, { commandId: cid("d"), maintenanceId: id, verdict, specDigest: await specOf(w, id) });
      // Held: refused, nothing changes, the request still waits.
      const one = await ask("held-1");
      held.add(boss.id);
      await refuses("forbidden", () => decide(boss.principal, one.maintenanceId));
      await refuses("forbidden", () => decide(boss.principal, one.maintenanceId, "reject"));
      assert.equal((await w.body(one.maintenanceId)).status, "pending");
      assert.equal(w.applier.calls.filter((c) => c.id === one.maintenanceId).length, 0);
      // Reading is not deciding: the held supervisor still reads its report's request.
      assert.equal((await mm.get(boss.principal, one.maintenanceId)).status, "pending");
      // The gate cannot be read: also refused (fail closed).
      held.delete(boss.id); broken = true;
      await refuses("forbidden", () => decide(boss.principal, one.maintenanceId));
      broken = false;
      // The owner is not held by anything.
      held.add(boss.id);
      assert.equal((await decide(w.owner, one.maintenanceId)).status === "pending", false);
      await mm.idle();
      // Released: the supervisor decides again.
      held.clear();
      const two = await ask("held-2");
      assert.notEqual((await decide(boss.principal, two.maintenanceId)).status, "pending");
      await mm.idle();
      // An approval made while free that waited for the host is judged again at the claim: held meanwhile, it goes back to waiting and the applier is not asked.
      const three = await ask("held-3");
      w.applier.nextApply.push({ outcome: "unsupported", reason: "the host cannot take it now" });
      assert.equal((await decide(boss.principal, three.maintenanceId)).status, "approved");
      const before = w.applier.calls.filter((c) => c.op === "apply" && c.id === three.maintenanceId).length;
      held.add(boss.id);
      for (let i = 0; i < 2; i++) { await mm.tick(); await mm.resume(); }
      await mm.idle();
      assert.equal((await w.body(three.maintenanceId)).status, "pending");
      assert.equal(w.applier.calls.filter((c) => c.op === "apply" && c.id === three.maintenanceId).length, before);
    });
  });
}

// ---- A09 seventh slice: the reviewer reads what the artifact declares before approving it -------------------------------------------------------

const read = (scripts: { phase: string; entry: string; text: string }[] = [], extra: Partial<Extract<ArtifactInspection, { ok: true }>> = {}): ArtifactInspection => ({ ok: true, name: "native-thing", version: "1.2.3", digestVerified: true, files: 4, bytes: 900, scripts: scripts.map((x) => ({ ...x, bytes: x.text.length, sha256: D("e"), truncated: false })), ...extra });
const reviewOf = async (w: World, by: Principal, id: string): Promise<Record<string, unknown>> => (await w.m.get(by, id)).review as Record<string, unknown>;

for (const [index, backend] of backends.entries()) {
  test(`a waiting package request shows the reviewer the install scripts the host read from the artifact, bound to the exact request, to readers only, and without anything being installed (${backend.name})`, async () => {
    await world(index, async (w) => {
      const asked: unknown[] = [];
      const m = w.service({ inspector: async (a) => { asked.push(a); return read([{ phase: "postinstall", entry: "setup.js", text: "console.log('building');" }]); } });
      const boss = await w.make("Boss");
      const ann = await w.make("Ann", w.owner, boss.id);
      const eve = await w.make("Eve");
      const r = await m.request(ann.principal, { commandId: cid("r"), kind: "package", spec: pkg("native-thing", { installScripts: true, digest: D("c") }), reason: "needed", rollbackPlan: "undo it" });
      assert.equal(r.status, "pending");
      await m.idle();
      assert.deepEqual(asked, [{ name: "native-thing", version: "1.2.3", digest: D("c"), source: SRC }], "the host was asked about exactly the requested artifact");
      for (const reader of [w.owner, ann.principal, boss.principal]) {
        const got = ((await m.get(reader, r.maintenanceId)).review as Record<string, any>);
        assert.equal(got.inspection.read, true);
        assert.equal(got.inspection.digestVerified, true);
        assert.equal(got.inspection.scripts[0].phase, "postinstall");
        assert.equal(got.inspection.scripts[0].file, "setup.js");
        assert.match(got.inspection.scripts[0].text, /building/);
        assert.match(got.inspection.note, /nothing was installed or run/);
        assert.equal(got.inspectionWarning, undefined, "the requester said it has scripts and it has");
      }
      await refuses("not_found", () => m.get(eve.principal, r.maintenanceId));
      assert.equal((await w.body(r.maintenanceId) as unknown as Record<string, unknown>).inspection, undefined, "the request record itself is unchanged by the reading");
      assert.equal(w.applier.effects.size, 0, "reading applied nothing");
      assert.equal((await w.m.list(w.owner, { agentId: ann.principal.id })).items.every((i) => typeof (i.review as Record<string, unknown>).inspection === "object"), true, "listing carries it too");
      const again = await m.request(ann.principal, { commandId: "same", kind: "package", spec: pkg("native-thing", { installScripts: true, digest: D("c") }), reason: "needed", rollbackPlan: "undo it" });
      await m.request(ann.principal, { commandId: "same", kind: "package", spec: pkg("native-thing", { installScripts: true, digest: D("c") }), reason: "needed", rollbackPlan: "undo it" });
      await m.idle();
      assert.equal(asked.length, 2, "a replayed request does not ask the host again");
      assert.ok(again.maintenanceId);
    });
  });

  test(`what the artifact declares is compared with what the requester said, and a text with a secret, hidden characters or a huge size is cleaned and bounded (${backend.name})`, async () => {
    await world(index, async (w) => {
      const ann = await w.make("Ann");
      const bad = "line one\u202Eevil\nAWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE1234567890abcdefghij\n" + "z".repeat(5000);
      const scripts = Array.from({ length: 9 }, (_, i) => ({ phase: "install", entry: `s${i}.js`, text: i === 0 ? bad : "ok" }));
      let result: ArtifactInspection = read(scripts);
      const m = w.service({ inspector: async () => result });
      // the requester says no scripts, the artifact declares some
      const liar = await m.request(ann.principal, { commandId: cid("r"), kind: "package", spec: pkg("liar"), reason: "needed", rollbackPlan: "undo" });
      await m.idle();
      const a = await reviewOf(w, w.owner, liar.maintenanceId) as Record<string, any>;
      assert.match(a.inspectionWarning, /declares install scripts although the requester said it has none/);
      assert.equal(a.inspection.scripts.length, 6, "at most six scripts are shown");
      assert.equal(a.inspection.omittedScripts, 3, "and the rest is counted, not hidden silently");
      const text = String(a.inspection.scripts[0].text);
      assert.ok(text.length <= 2003, "one script's text is bounded");
      assert.doesNotMatch(text, /AKIAIOSFODNN7EXAMPLE1234567890/, "a secret-shaped value is redacted");
      assert.doesNotMatch(text, /\u202E/, "a direction-changing character is removed");
      assert.equal(a.inspection.scripts[0].truncated, true);
      // the requester says scripts, the artifact has none
      result = read([]);
      const other = await m.request(ann.principal, { commandId: cid("r"), kind: "package", spec: pkg("other", { installScripts: true, digest: D("d") }), reason: "needed", rollbackPlan: "undo" });
      await m.idle();
      assert.match(String((await reviewOf(w, w.owner, other.maintenanceId)).inspectionWarning), /declares none: approving it runs nothing/);
    });
  });

  test(`a host that cannot read the artifact, throws or is too slow leaves the request waiting with the reason shown; no inspector, or an approved or non-package request, is never read (${backend.name})`, async () => {
    await world(index, async (w) => {
      const ann = await w.make("Ann");
      let calls = 0;
      let mode: "no" | "throw" | "slow" | "ok" = "no";
      const m = w.service({ inspectTimeoutMs: 50, inspector: async () => { calls++; if (mode === "throw") throw new Error("registry says token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 is bad"); if (mode === "slow") await sleep(400); return mode === "no" ? { ok: false, reason: "no way to fetch" } : read(); } });
      for (const next of ["no", "throw", "slow"] as const) {
        mode = next;
        const r = await m.request(ann.principal, { commandId: cid("r"), kind: "package", spec: pkg(`p-${next}`, { digest: D("b") }), reason: "needed", rollbackPlan: "undo" });
        await m.idle();
        assert.equal((await w.body(r.maintenanceId)).status, "pending", `${next}: the request still waits for a person`);
        const got = (await reviewOf(w, w.owner, r.maintenanceId)).inspection as Record<string, unknown>;
        assert.equal(got.read, false, next);
        assert.match(String(got.note), /requester's own claims are all there is/);
        if (next === "throw") assert.doesNotMatch(String(got.why), /ghp_abcdefghijklmnopqrstuvwxyz/, "a secret in the host's error is not shown");
        if (next === "slow") assert.match(String(got.why), /too long/);
      }
      assert.equal(calls, 3);
      // an owner's request approved by a rule, a mount and a request on a service without an inspector are never read
      await m.change(w.owner, { commandId: cid("s"), catalogueAdd: [{ name: "listed", version: "1.2.3", digest: D("a"), source: SRC }] });
      mode = "ok";
      const approved = await m.request(ann.principal, { commandId: cid("r"), kind: "package", spec: pkg("listed"), reason: "needed", rollbackPlan: "undo" });
      await m.request(ann.principal, { commandId: cid("r"), kind: "mount", spec: { mountPath: "/data/x", resource: `${ann.id.replace(/^agent:/, "")}.x`, mode: "read" }, reason: "needed", rollbackPlan: "undo" });
      await m.idle();
      assert.equal(calls, 3, "an approved request and a mount ask the host nothing");
      assert.equal((await reviewOf(w, w.owner, approved.maintenanceId)).inspection, undefined);
      const plain = w.service();
      const r2 = await plain.request(ann.principal, { commandId: cid("r"), kind: "package", spec: pkg("noinspector", { digest: D("9") }), reason: "needed", rollbackPlan: "undo" });
      await plain.idle();
      assert.equal((await reviewOf(w, w.owner, r2.maintenanceId)).inspection, undefined, "without an inspector the review shows only the requester's claims");
    });
  });

  test(`a request decided before the host answers is not written to afterwards, and a review does not show a reading while the host is still reading (${backend.name})`, async () => {
    await world(index, async (w) => {
      const ann = await w.make("Ann");
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const m = w.service({ inspector: async () => { await gate; return read([{ phase: "install", entry: "a.js", text: "a" }]); } });
      const r = await m.request(ann.principal, { commandId: cid("r"), kind: "package", spec: pkg("native-thing", { installScripts: true, digest: D("c") }), reason: "needed", rollbackPlan: "undo it" });
      assert.equal((await reviewOf(w, w.owner, r.maintenanceId)).inspection, undefined, "while the host is still reading, the review says nothing of it");
      await m.decide(w.owner, { commandId: cid("d"), maintenanceId: r.maintenanceId, verdict: "reject", specDigest: await specOf(w, r.maintenanceId) });
      release(); await m.idle();
      assert.equal((await w.storage.getAggregate({ kind: "maintenance-inspection", id: r.maintenanceId })), undefined, "a request that is no longer waiting is not read on");
    });
  });

  test(`readings run one at a time, a reading given up at the limit is told to stop, and past the queue bound a request is recorded as not read (${backend.name})`, async () => {
    await world(index, async (w) => {
      const ann = await w.make("Ann");
      // One at a time: three waiting requests never have two readings running together.
      let running = 0, most = 0, entered = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const m = w.service({ inspector: async () => { running++; entered++; most = Math.max(most, running); try { await gate; return read(); } finally { running--; } } });
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push((await m.request(ann.principal, { commandId: cid("r"), kind: "package", spec: pkg(`q${i}`, { digest: D(String(i + 1)) }), reason: "needed", rollbackPlan: "undo" })).maintenanceId);
      // Give readings that could overlap the chance to (bounded); one that waits its turn never starts while the gate holds.
      for (let k = 0; k < 50 && entered < 2; k++) await sleep(10);
      assert.equal(entered, 1, "the second reading waits for the first");
      release(); await m.idle();
      assert.equal(most, 1, "never two readings at once");
      for (const id of ids) assert.equal(((await reviewOf(w, w.owner, id)).inspection as Record<string, unknown>).read, true, "each was read in turn");
      // A reading given up at the limit is told to stop (its fetch is aborted).
      let aborted = false;
      const slow = w.service({ inspectTimeoutMs: 50, inspector: async (_a, signal) => { await new Promise<void>((r) => { if (signal === undefined) return; signal.addEventListener("abort", () => { aborted = true; r(); }); }); return read(); } });
      const s = await slow.request(ann.principal, { commandId: cid("r"), kind: "package", spec: pkg("slow", { digest: D("5") }), reason: "needed", rollbackPlan: "undo" });
      await slow.idle();
      assert.equal(aborted, true, "the host was told to stop");
      assert.match(String(((await reviewOf(w, w.owner, s.maintenanceId)).inspection as Record<string, unknown>).why), /too long/);
      // Past the bound a request is not queued: it is recorded as not read, and the host is not asked.
      let asked = 0;
      let open!: () => void;
      const held = new Promise<void>((r) => { open = r; });
      const small = w.service({ inspectQueue: 2, inspector: async () => { asked++; await held; return read(); } });
      const q: string[] = [];
      for (let i = 0; i < 3; i++) q.push((await small.request(ann.principal, { commandId: cid("r"), kind: "package", spec: pkg(`b${i}`, { digest: D(String(i + 6)) }), reason: "needed", rollbackPlan: "undo" })).maintenanceId);
      open(); await small.idle();
      assert.equal(asked, 2, "the third was not handed to the host");
      const third = (await reviewOf(w, w.owner, q[2]!)).inspection as Record<string, unknown>;
      assert.equal(third.read, false);
      assert.match(String(third.why), /too many artifacts were waiting/);
    });
  });
}
