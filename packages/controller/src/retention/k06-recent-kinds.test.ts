import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AdoptionService, AffectedWorkLook, LOOK_LIMITS, affectedLine, stoppedText, type AdoptionLookPorts, type LookBody } from "../adoptions/index.js";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { EnvironmentService } from "../environments/index.js";
import { ExperimentService } from "../experiments/index.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import type { ControllerStorage, JsonObject, OperationInput } from "../storage/types.js";
import { METERED, QuotaMeter, addedBy, guardStorage, netAdded } from "./guard.js";
import { EXPORT_KINDS, RETENTION_DEFAULTS, RetentionService, type RetentionValues } from "./index.js";

// Card K06, retention of the record kinds cards B04, B05, B06 and M05 added (adoptions, experiments, their indexes, the looks at affected work and their pending list, the own-code requests, the list of
// open owner inquiries). Built here: the status counts them (bounded), a look that keeps failing gets a limit (stopped after LOOK_LIMITS.stopDays, out of the pending list, the owner told and the count
// shown; nothing it found is dropped), a quota holds only NEW adoptions, experiments and own-code requests (a decision or withdrawal is never refused for room), and the owner's project export carries
// them. Real storage on each backend; a fresh service at every step (as after a restart); the only clock is the test's, and it moves.

after(stopServer);

const DAY = 86_400_000;
const t0 = Date.parse("2026-11-27T10:00:00.000Z");
let clockAt = t0;
const options = { clock: () => new Date(clockAt).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const hex = (c: string): string => c.repeat(64);
const PROPOSAL = { problem: "reviews send back handlers without error tests", affectedWork: "request handler reviews", change: "add a checklist to the coder prompt", effort: "one afternoon", runningCost: "no extra tokens", benefit: "less rework", evaluation: "the same five handler tasks", stoppingCondition: "two runs" };
const CRITERIA = {
  baseline: { label: "prompt v4", ref: "commit abc123", digest: hex("a") }, evaluator: { label: "review rubric", ref: "rubric 2", digest: hex("b") },
  cases: [{ id: "c1", text: "handler with a missing field" }], baselinePassing: ["c1"],
  baselineMetrics: { timeToAcceptedSeconds: 100, reworkCount: 4 }, budget: { maxRuns: 3, maxCost: 30 }, minRuns: 2, minImprovementPct: 5, maxRegressionPct: 0,
};
const GOOD = { timeToAcceptedSeconds: 80, reworkCount: 3 };
const GUARD = `sha256:${hex("9")}`;
const MANIFEST = { base: { name: "nimblenewt-base", version: "1.0.0", digest: `sha256:${hex("1")}` }, packages: [], skills: [], capabilities: ["desk.read"], configuration: { installation: 1 }, limits: { cpus: 1, memoryMb: 512, diskMb: 1024, processes: 64 }, protectedExtensions: [{ name: "nimblenewt.guard", digest: GUARD }] };
const PRACTICE = { kind: "practice" };
const off: RetentionValues = { ...RETENTION_DEFAULTS, reserveBytes: 0, thinkingAuto: false };

interface Notice { commandId: string; detail: string; adoptionId: string; projectId: string }
interface Ctx {
  owner: Principal; mgr: Principal; mgr2: Principal; dev: Principal; reader: Principal; eve: Principal;
  a: string; b: string; storage: ControllerStorage; epoch: number; notices: Notice[];
  /** Ports where the owner's notice of a finished look fails (for every look, or only those in `failOnly`) unless `notifyOk`; a stop notice is given, or fails or conflicts for the looks named in `stop`. */
  ports(o?: { notifyOk?: boolean; failOnly?: readonly string[]; stop?: Readonly<Record<string, "fail" | "conflict">> }): AdoptionLookPorts;
  make(o?: { looks?: AdoptionLookPorts | undefined; storage?: ControllerStorage }): AdoptionService;
  exps(storage?: ControllerStorage): ExperimentService;
  improved(): Promise<string>;
  /** An improved experiment, asked for by `reader`, approved by mgr2: an adoption in force. */
  active(): Promise<string>;
  rev(id: string): Promise<number>;
  withdraw(id: string, svc?: AdoptionService): Promise<void>;
  put(kind: string, id: string, body: Record<string, unknown>, at?: number): Promise<void>;
  pending(): Promise<string[]>;
  retention(o?: { growthScanLimit?: number }): RetentionService;
}

for (const backend of backends) {
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      clockAt = t0;
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const epoch = projects.epoch;
        const principals = PrincipalService.withEpoch(world.storage, epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const enroll = async (nm: string, grants: Grant[]): Promise<Principal> => {
          await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants });
          return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        };
        const a = (await projects.createProject({ commandId: cid("pa"), actor: owner.id, name: "A" })).id;
        const b = (await projects.createProject({ commandId: cid("pb"), actor: owner.id, name: "B" })).id;
        const reserved = new Map<string, string>([["nimblenewt.guard", GUARD]]);
        const env = EnvironmentService.withEpoch(world.storage, epoch, { ...options, reservedDigest: async (nm) => reserved.get(nm), skillUsable: async () => true });
        const mgr = await enroll("mgr", [{ action: "meeting.manage", project: a }]);
        const mgr2 = await enroll("mgr2", [{ action: "meeting.manage", project: a }]);
        const dev = await enroll("dev", [{ action: "meeting.agenda", project: a }]);
        const reader = await enroll("reader", [{ action: "meeting.read", project: a }]);
        const eve = await enroll("eve", [{ action: "meeting.manage", project: b }, { action: "meeting.agenda", project: b }]);
        await env.change(owner, { commandId: cid("env"), agentId: dev.id, manifest: MANIFEST, reason: "first" });
        const notices: Notice[] = [];
        const exps = (storage: ControllerStorage = world.storage) => ExperimentService.withEpoch(storage, epoch, { ...options, environments: env });
        const make = (o: { looks?: AdoptionLookPorts | undefined; storage?: ControllerStorage } = {}) => AdoptionService.withEpoch(o.storage ?? world.storage, epoch, { ...options, ...("looks" in o ? (o.looks === undefined ? {} : { looks: o.looks }) : {}) });
        const ctx: Ctx = {
          owner, mgr, mgr2, dev, reader, eve, a, b, storage: world.storage, epoch, notices, make, exps,
          ports: (o = {}) => ({
            usage: async () => ({ items: [] }),
            tell: async () => undefined,
            notify: async (x) => {
              if (x.commandId.startsWith("adoption-look-stopped-")) {
                const how = o.stop?.[x.adoptionId];
                if (how === "conflict") throw new DomainError("command_conflict", "that notice was given before");
                if (how === "fail") throw new DomainError("unavailable", "the notifications store cannot be reached");
              } else if (o.failOnly !== undefined ? o.failOnly.includes(x.adoptionId) : o.notifyOk !== true) throw new DomainError("unavailable", "the notifications store cannot be reached");
              notices.push({ ...x });
            },
          }),
          improved: async () => {
            const id = (await exps().propose(dev, { commandId: cid("x"), projectId: a, title: "Checklist prompt", proposal: PROPOSAL, affectedKey: `reviews ${n}` } as never)).id;
            await exps().pin(mgr, { commandId: cid("p"), experimentId: id, expectedRevision: (await exps().get(owner, id))!.revision, criteria: CRITERIA } as never);
            for (let i = 0; i < 2; i++) await exps().recordRun(dev, { commandId: cid("r"), experimentId: id, environment: { agentId: dev.id, revision: 1, observed: { "nimblenewt.guard": GUARD }, disposable: true }, cost: 1, metrics: GOOD, cases: [{ id: "c1", passed: true }] } as never);
            await exps().conclude(mgr, { commandId: cid("c"), experimentId: id, expectedRevision: (await exps().get(owner, id))!.revision, finding: "read the runs" });
            return id;
          },
          active: async () => {
            const exp = await ctx.improved();
            const id = (await make().request(reader, { commandId: cid("q"), experimentId: exp, target: PRACTICE, reason: "it helped" })).id;
            await make().approve(mgr2, { commandId: cid("ap"), adoptionId: id, expectedRevision: await ctx.rev(id), review: "the runs agree" });
            return id;
          },
          rev: async (id) => (await make().get(owner, id))!.revision,
          withdraw: async (id, svc = make()) => { await svc.withdraw(mgr, { commandId: cid("w"), adoptionId: id, expectedRevision: await ctx.rev(id), reason: "we stop using it" }); },
          put: async (kind, id, body, at = clockAt) => {
            const found = await world.storage.getAggregate({ kind, id });
            await world.storage.applyOperation({ operationId: cid("put"), epoch, actor: "test", correlationId: "put", at: new Date(at).toISOString(), changes: [found === undefined ? { type: "create", ref: { kind, id }, body: body as JsonObject } : { type: "update", ref: { kind, id }, expectedRevision: found.revision, body: body as JsonObject }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
          },
          pending: async () => (((await world.storage.getAggregate({ kind: "adoption-looks", id: "installation" }))?.body as { pending?: string[] } | undefined)?.pending ?? []),
          retention: (o = {}) => RetentionService.withEpoch(world.storage, epoch, { settings: { effective: async () => off }, now: () => clockAt, ...o }, options),
        };
        await body(ctx);
      } finally { await world.close(); }
    });

  suite("a look that keeps failing is stopped once it is 14 days old: out of the pending list, partial, what it found kept, the owner told once and the count shown; younger or working looks are not stopped", async (c) => {
    const failing = await c.active();
    // Withdrawn with ports whose owner notice fails: the withdrawal stands, the look (a practice's: no task to find) is done but cannot tell the owner, so it stays pending.
    await c.withdraw(failing, c.make({ looks: c.ports() }));
    assert.deepEqual(await c.pending(), [failing]);
    // A second withdrawal with no ports at all (a controller without them): recorded and pending, with nothing failing yet.
    const later = await c.active();
    await c.withdraw(later, c.make({ looks: undefined }));
    assert.deepEqual((await c.pending()).sort(), [failing, later].sort());

    // Thirteen days on, the failing one still fails and stays (not yet its limit); the other is carried on and finished (its notice also fails here, so it stays too).
    clockAt = t0 + 13 * DAY;
    assert.deepEqual(await c.make({ looks: c.ports() }).sweepAffected(), { looked: 0, failed: 2 });
    assert.deepEqual((await c.pending()).sort(), [failing, later].sort());
    assert.equal((await c.make().affected(c.owner, failing))!.stopped, undefined);

    // At 14 days both are past the limit and still failing: each is stopped, its stop notice goes out, and both leave the pending list in the same write.
    clockAt = t0 + 14 * DAY;
    assert.deepEqual(await c.make({ looks: c.ports() }).sweepAffected(), { looked: 0, failed: 2, stopped: 2 });
    assert.deepEqual(await c.pending(), []);
    const look = (await c.make().affected(c.owner, failing))!;
    // The practice's look had finished (only its notice failed): its result stands, it is not called partial, and the stop notice gives the owner that result (first review).
    assert.deepEqual([look.state, look.partial, look.stopped, look.notified, look.why, look.scope], ["done", undefined, { at: new Date(clockAt).toISOString(), told: true, finished: true }, undefined, "decision", "not-recorded"]);
    assert.equal(c.notices.length, 2);
    const mine = c.notices.find((x) => x.adoptionId === failing)!;
    assert.deepEqual([mine.commandId, mine.projectId], [`adoption-look-stopped-${failing}`, c.a]);
    assert.ok(mine.detail.length <= 200);
    assert.equal(mine.detail, stoppedText(look, failing));
    assert.equal(mine.detail, `Adoption ${failing} withdrawn. Which tasks applied a practice is not recorded, so no task was told. (Sent at the look's 14-day limit; the first notice kept failing.)`);
    assert.equal(affectedLine(look), "Which tasks applied the practice is not recorded, so no task was found or told. Telling the owner kept failing for 14 days, so the look was closed and the result sent then.");
    assert.doesNotMatch(affectedLine(look), /could not be sent/);
    // A reader of the adoption sees the stop the same way (counts, no task IDs).
    assert.deepEqual((await c.make().affected(c.reader, failing))?.stopped, look.stopped);

    // Stopped is final: a later sweep has nothing pending and writes nothing; carrying the look on by hand (working ports) neither runs it nor sends the finish notice.
    const before = JSON.stringify(await c.storage.getAggregate({ kind: "adoption-look", id: failing }));
    clockAt = t0 + 30 * DAY;
    assert.deepEqual(await c.make({ looks: c.ports({ notifyOk: true }) }).sweepAffected(), { looked: 0, failed: 0 });
    assert.equal((await c.make({ looks: c.ports({ notifyOk: true }) }).lookAtAffected(failing))?.stopped?.told, true);
    assert.equal(JSON.stringify(await c.storage.getAggregate({ kind: "adoption-look", id: failing })), before, "the stopped record is not written again");
    assert.equal(c.notices.length, 2, "no finish notice for a stopped look");

    // A look that is old but whose attempt works (a controller that was down for weeks) is finished, never stopped.
    const slow = await c.active();
    await c.withdraw(slow, c.make({ looks: undefined }));
    clockAt = t0 + 60 * DAY;
    assert.deepEqual(await c.make({ looks: c.ports({ notifyOk: true }) }).sweepAffected(), { looked: 1, failed: 0 });
    const done = (await c.make().affected(c.owner, slow))!;
    assert.deepEqual([done.state, done.notified, done.stopped, done.partial], ["done", true, undefined, undefined]);
    assert.deepEqual(await c.pending(), []);

    // The owner reads the counts in the retention status: two stopped, nothing pending; the kinds are counted.
    const st = await c.retention().status(c.owner) as unknown as { adoptionLooks: Record<string, unknown>; growth: Record<string, number | string> };
    assert.deepEqual(st.adoptionLooks, { pending: 0, looking: 0, notTold: 0, stopped: 2 });
    assert.deepEqual([st.growth["adoption"], st.growth["adoption-look"], st.growth["adoption-looks"], st.growth["experiment"], st.growth["adoption-index"], st.growth["experiment-index"]], [3, 3, 1, 3, 1, 1]);
    for (const k of ["owncode-request", "owncode-task", "owncode-index", "owncode-settings", "meeting-floor-inquiries"]) assert.equal(st.growth[k], 0, k);
    // Card P10b's kinds (first review of its fifth slice): counted too, none here.
    for (const k of ["integrator-wake", "landing-task", "landing-charge-pin"]) assert.equal(st.growth[k], 0, k);
  });

  suite("the stop notice cannot be sent: the look is stopped anyway (it never holds its place for good) and says so; a notice given before counts as told; the status counts each state", async (c) => {
    const quiet = await c.active();
    await c.withdraw(quiet, c.make({ looks: c.ports() }));
    const given = await c.active();
    await c.withdraw(given, c.make({ looks: c.ports() }));
    // A third look, still looking (no ports ever ran it), and a fourth, done and told: the status tells them apart.
    const waiting = await c.active();
    await c.withdraw(waiting, c.make({ looks: undefined }));
    const told = await c.active();
    await c.withdraw(told, c.make({ looks: c.ports({ notifyOk: true }) }));
    let st = await c.retention().status(c.owner) as unknown as { adoptionLooks: Record<string, unknown> };
    assert.deepEqual(st.adoptionLooks, { pending: 3, looking: 1, notTold: 2, stopped: 0 });

    clockAt = t0 + 15 * DAY;
    const ports = c.ports({ failOnly: [quiet, given], stop: { [quiet]: "fail", [given]: "conflict" } });
    // Carrying a look on by hand never stops it (only the tick does): the attempt fails and the look stays.
    assert.equal(await c.make({ looks: ports }).lookAtAffected(quiet).then(() => "ran", () => "failed"), "failed");
    assert.ok((await c.pending()).includes(quiet));
    const svc = c.make({ looks: ports });
    for (let i = 0; i < 4 && (await c.pending()).length > 0; i++) await svc.sweepAffected();
    assert.deepEqual(await c.pending(), []);
    const q = (await c.make().affected(c.owner, quiet))!;
    assert.deepEqual(q.stopped, { at: new Date(clockAt).toISOString(), told: false, finished: true });
    assert.match(affectedLine(q), /the owner's notice of this could not be sent\./i);
    assert.deepEqual((await c.make().affected(c.owner, given))!.stopped, { at: new Date(clockAt).toISOString(), told: true, finished: true }, "a conflict on the stop notice's ID means it was given before");
    // The still-looking one was never failing: the same sweep finished it and told the owner.
    assert.deepEqual([(await c.make().affected(c.owner, waiting))!.notified, (await c.make().affected(c.owner, waiting))!.stopped], [true, undefined]);
    st = await c.retention().status(c.owner) as unknown as { adoptionLooks: Record<string, unknown> };
    assert.deepEqual(st.adoptionLooks, { pending: 0, looking: 0, notTold: 0, stopped: 2 });
    assert.equal(c.notices.filter((x) => x.commandId.startsWith("adoption-look-stopped-")).length, 0, "neither stop notice reached the inbox here");
  });

  suite("hostile looks: a damaged look body is stopped by the age of its stored record (not a date it claims), a malformed or unknown pending ID leaves the list, a damaged pending list counts as empty", async (c) => {
    const ok = "adp-aaaaaaaaaaaaaaaaaaaa"; const forged = "adp-bbbbbbbbbbbbbbbbbbbb"; const gone = "adp-cccccccccccccccccccc";
    // A damaged record written 20 days ago (no target, tasks a string, told not a number): every attempt fails.
    await c.put("adoption-look", ok, { state: 5, target: null, tasks: "x", told: "many", projectId: 7 }, t0 - 20 * DAY);
    // A record written now that claims to have begun long ago: its claim is not believed.
    await c.put("adoption-look", forged, { state: "looking", target: null, startedAt: new Date(t0 - 400 * DAY).toISOString(), tasks: {}, told: 0, projectId: c.a }, t0);
    // A damaged record that says the owner was told yet is still pending and fails: it too is stopped, not left in the list for good.
    const toldBad = "adp-dddddddddddddddddddd";
    await c.put("adoption-look", toldBad, { state: "looking", target: null, tasks: {}, told: 0, notified: true, projectId: c.a }, t0 - 20 * DAY);
    await c.put("adoption-looks", "installation", { pending: ["../../etc", ok, forged, gone, 42, "__proto__", toldBad] });
    const svc = c.make({ looks: c.ports({ notifyOk: true }) });
    for (let i = 0; i < 8; i++) await svc.sweepAffected();
    assert.equal(((await c.storage.getAggregate({ kind: "adoption-look", id: toldBad }))!.body["stopped"] as { told?: unknown } | undefined)?.told, true);
    assert.deepEqual(await c.pending(), [forged], "the malformed and unknown IDs left, the damaged old look was stopped, the young one stays");
    const stopped = (await c.storage.getAggregate({ kind: "adoption-look", id: ok }))!.body as unknown as LookBody;
    assert.deepEqual([stopped.state, stopped.partial, stopped.stopped?.told], ["done", true, true]);
    assert.equal((stopped as unknown as { tasks: unknown }).tasks, "x", "what the record held is kept, not dropped");
    const note = c.notices.find((x) => x.adoptionId === ok)!;
    assert.deepEqual([note.projectId, note.detail], ["", stoppedText({ told: "many" } as never, ok)]);
    assert.match(note.detail, / 0 task\(s\) were told/);
    assert.match(affectedLine(stopped), /0 task\(s\) found and 0 told/);
    // An unfinished stop: the line says the owner's notice could not be sent only when it was not (second review).
    assert.doesNotMatch(affectedLine(stopped), /could not be sent/);
    assert.match(affectedLine({ ...stopped, stopped: { ...stopped.stopped!, told: false } }), /kept failing for 14 days and was stopped: .* The owner's notice of this could not be sent\.$/);
    assert.equal((await c.storage.getAggregate({ kind: "adoption-look", id: forged }))!.body["stopped"], undefined);
    // A finished tool look whose finish notice kept failing: stopped with its result in the notice (counts, partial kept as it was, no `partial` added).
    const toolDone = "adp-eeeeeeeeeeeeeeeeeeee"; const toldDone = "adp-ffffffffffffffffffff"; const nul = "adp-gggggggggggggggggggg";
    await c.put("adoption-look", toolDone, { adoptionId: toolDone, projectId: c.a, state: "done", scope: "tool-runs", target: { kind: "tool", name: "toolbox.fetch", version: "1.0.0" }, pages: 1, runs: 3, tasks: { "task-a": "paused", "task-b": "open", "task-c": "finished", "task-d": "missing" }, untracked: 0, told: 2, why: "regression", startedAt: new Date(t0 - 20 * DAY).toISOString(), doneAt: new Date(t0 - 19 * DAY).toISOString() }, t0 - 20 * DAY);
    // A finished look whose owner was told, yet still pending (a damaged store): it leaves the list at its turn, with no second notice and no stop.
    await c.put("adoption-look", toldDone, { adoptionId: toldDone, projectId: c.a, state: "done", scope: "tool-runs", target: null, pages: 1, runs: 0, tasks: {}, untracked: 0, told: 0, notified: true, why: "decision", startedAt: new Date(t0 - 20 * DAY).toISOString() }, t0 - 20 * DAY);
    // A damaged `stopped` (null) is not a stop: the look is carried on (and here finished), and the view line does not throw.
    await c.put("adoption-look", nul, { adoptionId: nul, projectId: c.a, state: "looking", scope: "not-recorded", target: { kind: "practice" }, pages: 0, runs: 0, tasks: {}, untracked: 0, told: 0, why: "decision", startedAt: new Date(t0).toISOString(), stopped: null }, t0);
    assert.doesNotThrow(() => affectedLine({ ...(stopped as object), stopped: null } as never));
    await c.put("adoption-looks", "installation", { pending: [forged, toolDone, toldDone, nul] });
    const before2 = c.notices.length;
    const svc2 = c.make({ looks: c.ports({ failOnly: [toolDone, toldDone] }) });
    for (let i = 0; i < 6; i++) await svc2.sweepAffected();
    assert.deepEqual(await c.pending(), [forged]);
    const td = (await c.storage.getAggregate({ kind: "adoption-look", id: toolDone }))!.body as unknown as LookBody;
    assert.deepEqual([td.state, td.partial, td.stopped?.finished, td.stopped?.told, td.doneAt], ["done", undefined, true, true, new Date(t0 - 19 * DAY).toISOString()]);
    const tdNote = c.notices.find((x) => x.adoptionId === toolDone)!;
    assert.equal(tdNote.detail, `Adoption ${toolDone} withdrawn. 4 task(s) ran it: 1 paused, 1 open (told), 2 finished. (Sent at the look's 14-day limit; the first notice kept failing.)`);
    assert.doesNotMatch(affectedLine({ ...td, counts: undefined } as never), /has not been told yet/);
    assert.match(affectedLine({ ...td, counts: undefined } as never), /^Affected work, from the tool's run records: 4 task\(s\) ran this version; 1 paused and 1 open were told .* Telling the owner kept failing for 14 days, so the look was closed and the result sent then\.$/);
    const tk = (await c.storage.getAggregate({ kind: "adoption-look", id: toldDone }))!.body as unknown as LookBody;
    assert.deepEqual([tk.stopped, tk.partial, tk.notified], [undefined, undefined, true]);
    assert.equal(c.notices.filter((x) => x.adoptionId === toldDone).length, 0, "an owner who was told is not told again");
    assert.doesNotMatch(affectedLine(tk), /kept failing|closed/);
    const nb = (await c.storage.getAggregate({ kind: "adoption-look", id: nul }))!.body as unknown as LookBody;
    assert.deepEqual([nb.state, nb.notified], ["done", true]);
    assert.equal(c.notices.length - before2, 2, "the tool look's stop notice and the null-stopped look's finish notice");
    // A finished, told look that is still pending and whose leaving the list keeps failing: at its limit it is stopped in one write that also unlists it, and the owner, already told, is not told again.
    const stuck = "adp-hhhhhhhhhhhhhhhhhhhh";
    await c.put("adoption-look", stuck, { adoptionId: stuck, projectId: c.a, state: "done", scope: "not-recorded", target: { kind: "practice" }, pages: 0, runs: 0, tasks: {}, untracked: 0, told: 0, notified: true, why: "decision", startedAt: new Date(t0 - 20 * DAY).toISOString() }, t0 - 20 * DAY);
    await c.put("adoption-looks", "installation", { pending: [forged, stuck] });
    const unlistFails = new Proxy(c.storage, { get(target, prop) {
      if (prop === "applyOperation") return async (input: OperationInput) => { if (input.changes.length === 1 && input.changes[0]!.ref.kind === "adoption-looks") throw new Error("the list cannot be written"); return target.applyOperation(input); };
      const v = Reflect.get(target, prop, target) as unknown; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    } });
    const before3 = c.notices.length;
    const svc3 = c.make({ looks: c.ports({ notifyOk: true }), storage: unlistFails });
    for (let i = 0; i < 4; i++) await svc3.sweepAffected();
    assert.deepEqual(await c.pending(), [forged]);
    const sk = (await c.storage.getAggregate({ kind: "adoption-look", id: stuck }))!.body as unknown as LookBody;
    assert.deepEqual([sk.stopped?.told, sk.stopped?.finished, sk.partial, sk.notified], [true, true, undefined, true]);
    assert.equal(c.notices.length, before3, "no stop notice for an owner already told");
    assert.equal(affectedLine(sk), "Which tasks applied the practice is not recorded, so no task was found or told.");
    // A stopped look listed again (a restored list): it leaves the list at its turn, its record is not written and no notice is given (second review: it kept its place for good).
    await c.put("adoption-looks", "installation", { pending: [forged, stuck, ok] });
    const skBefore = JSON.stringify(await c.storage.getAggregate({ kind: "adoption-look", id: stuck }));
    const okBefore = JSON.stringify(await c.storage.getAggregate({ kind: "adoption-look", id: ok }));
    const before4 = c.notices.length;
    const svc4 = c.make({ looks: c.ports({ notifyOk: true }) });
    for (let i = 0; i < 3; i++) await svc4.sweepAffected();
    assert.deepEqual(await c.pending(), [forged]);
    assert.equal(JSON.stringify(await c.storage.getAggregate({ kind: "adoption-look", id: stuck })), skBefore);
    assert.equal(JSON.stringify(await c.storage.getAggregate({ kind: "adoption-look", id: ok })), okBefore);
    assert.equal(c.notices.length, before4, "no notice for a stopped look");
    // Bad and odd clocks never stop a look.
    assert.equal(AffectedWorkLook.overdue("not a time", new Date(t0).toISOString()), false);
    assert.equal(AffectedWorkLook.overdue(new Date(t0).toISOString(), "not a time"), false);
    assert.equal(AffectedWorkLook.overdue(new Date(t0).toISOString(), new Date(t0 + LOOK_LIMITS.stopDays * DAY - 1).toISOString()), false);
    assert.equal(AffectedWorkLook.overdue(new Date(t0).toISOString(), new Date(t0 + LOOK_LIMITS.stopDays * DAY).toISOString()), true);
    // A pending list that is not a list: the status counts none, and the sweep reads none.
    await c.put("adoption-looks", "installation", { pending: { 0: forged, length: 1 } });
    const st = await c.retention().status(c.owner) as unknown as { adoptionLooks: Record<string, unknown> };
    assert.deepEqual(st.adoptionLooks, { pending: 0, looking: 1, notTold: 0, stopped: 4 });
    assert.deepEqual(await svc.sweepAffected(), { looked: 0, failed: 0 });
  });

  suite("the status count of each kind is bounded: past the scan limit it says n+, and the looks' figures say partial", async (c) => {
    const looks = Array.from({ length: 501 }, (_, i) => `adp-${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + (Math.floor(i / 26) % 26))}${"a".repeat(17)}${"abcdefghijklmnopqrstuvwxyz234567"[Math.floor(i / 676)]}`);
    assert.equal(new Set(looks).size, 501);
    for (let i = 0; i < looks.length; i += 100) {
      await c.storage.applyOperation({ operationId: cid("many"), epoch: c.epoch, actor: "test", correlationId: "many", at: new Date(clockAt).toISOString(), changes: looks.slice(i, i + 100).map((id) => ({ type: "create" as const, ref: { kind: "adoption-look", id }, body: { state: "looking" } as JsonObject })), audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
    }
    const cut = await c.retention({ growthScanLimit: 500 }).status(c.owner) as unknown as { adoptionLooks: Record<string, unknown>; growth: Record<string, number | string> };
    assert.equal(cut.growth["adoption-look"], "500+");
    assert.deepEqual(cut.adoptionLooks, { pending: 0, looking: 500, notTold: 0, stopped: 0, partial: true });
    const whole = await c.retention().status(c.owner) as unknown as { adoptionLooks: Record<string, unknown>; growth: Record<string, number | string> };
    assert.equal(whole.growth["adoption-look"], 501);
    assert.deepEqual(whole.adoptionLooks, { pending: 0, looking: 501, notTold: 0, stopped: 0 });
    await assert.rejects(c.retention().status(c.mgr), /may not read the retention status/);
  });

  suite("a quota holds new adoptions, experiments and own-code requests only: a new one is refused over the project's or the asker's quota, a decision, take-back or withdrawal of an existing one never is", async (c) => {
    const values: { v: RetentionValues } = { v: off };
    const meter = new QuotaMeter(c.storage, { ttlMs: 0, now: () => clockAt });
    const guarded = guardStorage(c.storage, { meter, values: async () => values.v, now: () => new Date(clockAt).toISOString() });
    const svc = () => c.make({ storage: guarded });
    const exp = await c.improved();
    const live = (await svc().request(c.reader, { commandId: cid("q"), experimentId: exp, target: PRACTICE, reason: "it helped" })).id;
    await svc().approve(c.mgr2, { commandId: cid("ap"), adoptionId: live, expectedRevision: await c.rev(live), review: "the runs agree" });
    const asked = (await svc().request(c.dev, { commandId: cid("q"), experimentId: exp, target: { kind: "tool", name: "toolbox.fetch", version: "1.0.0" }, reason: "it helped too" })).id;
    // The bytes of these records count toward the project and the asker.
    const usage = await meter.usage();
    assert.ok((usage.byProject.get(c.a) ?? 0) > 0);
    assert.ok((usage.byAgent.get(c.reader.id) ?? 0) > 0 && (usage.byAgent.get(c.dev.id) ?? 0) > 0);
    assert.ok((usage.byAgent.get(c.dev.id) ?? 0) >= Buffer.byteLength(JSON.stringify((await c.storage.getAggregate({ kind: "experiment", id: exp }))!.body)) - 64, "the proposer's experiment counts");
    // A project quota of one byte: a new request is refused and nothing is stored; the existing ones are still decided and withdrawn.
    values.v = { ...off, quotaProjectBytes: 1 };
    const before = JSON.stringify(await c.storage.getAggregate({ kind: "adoption-index", id: c.a }));
    await assert.rejects(svc().request(c.reader, { commandId: cid("q"), experimentId: exp, target: { kind: "tool", name: "toolbox.grab", version: "1.0.0" }, reason: "again" }), (e: unknown) => e instanceof DomainError && e.code === "unavailable" && /over its storage quota/.test(e.message));
    assert.equal(JSON.stringify(await c.storage.getAggregate({ kind: "adoption-index", id: c.a })), before, "nothing written for the refused request");
    await svc().decline(c.mgr, { commandId: cid("d"), adoptionId: asked, expectedRevision: await c.rev(asked), reason: "not now, and a much longer reason than the request had, so the record grows" });
    await svc().withdraw(c.mgr, { commandId: cid("w"), adoptionId: live, expectedRevision: await c.rev(live), reason: "monitoring says stop" });
    assert.deepEqual([(await c.make().get(c.owner, asked))!.status, (await c.make().get(c.owner, live))!.status], ["declined", "withdrawn"]);
    // An asker's quota: a proposal is refused for the proposer; another project's agent is not held up by this project's use.
    values.v = { ...off, quotaAgentBytes: 1 };
    await assert.rejects(c.exps(guarded).propose(c.dev, { commandId: cid("x"), projectId: c.a, title: "T", proposal: PROPOSAL, affectedKey: "k" } as never), /over its storage quota/);
    values.v = { ...off, quotaProjectBytes: (usage.byProject.get(c.a) ?? 0) * 100 };
    assert.ok((await c.exps(guarded).propose(c.eve, { commandId: cid("x"), projectId: c.b, title: "T", proposal: PROPOSAL, affectedKey: "k" } as never)).id.startsWith("exp-"));
    // A repeat of a request that went through is answered from its record even over the quota (nothing new is written).
    const replayId = cid("q");
    values.v = off;
    const first = await svc().request(c.reader, { commandId: replayId, experimentId: exp, target: { kind: "tool", name: "toolbox.other", version: "1.0.0" }, reason: "once" });
    values.v = { ...off, quotaProjectBytes: 1 };
    assert.equal((await svc().request(c.reader, { commandId: replayId, experimentId: exp, target: { kind: "tool", name: "toolbox.other", version: "1.0.0" }, reason: "once" })).id, first.id);
    // The same at the guard itself (a repeat that reaches the storage, as after a lost answer): a stored operation that created an adoption is answered, not refused for room.
    const op: OperationInput = { operationId: cid("raw"), epoch: c.epoch, actor: "test", correlationId: "raw", at: new Date(clockAt).toISOString(), changes: [{ type: "create", ref: { kind: "adoption", id: "adp-rrrrrrrrrrrrrrrrrrrr" }, body: { projectId: c.a, requestedBy: c.reader.id, status: "declined" } as JsonObject }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] };
    values.v = off;
    await guarded.applyOperation(op);
    values.v = { ...off, quotaProjectBytes: 1 };
    await guarded.applyOperation(op);
    await assert.rejects(guarded.applyOperation({ ...op, operationId: cid("raw"), changes: [{ type: "create", ref: { kind: "adoption", id: "adp-ssssssssssssssssssss" }, body: { projectId: c.a, requestedBy: c.reader.id } as JsonObject }] }), /over its storage quota/);
  });

  suite("the owner's project export carries the project's adoptions, experiments and looks, masks secret-shaped text in them, and leaves another project's out", async (c) => {
    const live = await c.active();
    await c.withdraw(live, c.make({ looks: c.ports({ notifyOk: true }) }));
    // A record with secret-shaped text (as a damaged or older store could hold) and one of project B.
    await c.put("adoption", "adp-zzzzzzzzzzzzzzzzzzzz", { projectId: c.a, experimentId: "exp-zzzzzzzzzzzzzzzzzzzz", status: "declined", requestedBy: c.reader.id, reason: "see sk-abcdefghijklmnopqrstuvwx for it", reports: [], reportCount: 0, history: [] });
    await c.put("adoption", "adp-yyyyyyyyyyyyyyyyyyyy", { projectId: c.b, status: "declined", requestedBy: c.eve.id, reason: "B's own", reports: [], reportCount: 0, history: [] });
    // Own-code requests: exported with the project they were approved into; a waiting one (no project yet) and another project's are not.
    await c.put("owncode-request", "ocr-aaaaaaaaaaaaaaaaaaaa", { requestedBy: c.dev.id, status: "approved", projectId: c.a, taskId: "task-zzzzzzzzzzzzzzzzzzzz", request: { what: "w", why: "token sk-abcdefghijklmnopqrstuvwy" }, history: [] });
    await c.put("owncode-request", "ocr-bbbbbbbbbbbbbbbbbbbb", { requestedBy: c.dev.id, status: "pending", request: { what: "waiting one" }, history: [] });
    await c.put("owncode-request", "ocr-cccccccccccccccccccc", { requestedBy: c.eve.id, status: "approved", projectId: c.b, taskId: "task-yyyyyyyyyyyyyyyyyyyy", request: { what: "B's request" }, history: [] });
    const items: { kind: string; id: string; body: JsonObject }[] = []; let redactions = 0;
    for (let after: string | undefined; ;) {
      const page = await c.retention().export(c.owner, { projectId: c.a, limit: 200, ...(after === undefined ? {} : { after }) });
      items.push(...page.items); redactions += page.redactions;
      if (page.next === undefined) break;
      after = page.next;
    }
    const ids = (kind: string) => items.filter((i) => i.kind === kind).map((i) => i.id).sort();
    assert.deepEqual(ids("adoption"), [live, "adp-zzzzzzzzzzzzzzzzzzzz"].sort());
    assert.equal(ids("experiment").length, 1);
    assert.deepEqual(ids("adoption-look"), [live]);
    assert.deepEqual(ids("owncode-request"), ["ocr-aaaaaaaaaaaaaaaaaaaa"]);
    assert.doesNotMatch(JSON.stringify(items), /waiting one|sk-abcdefghijklmnopqrstuvwy/);
    assert.ok(redactions >= 2);
    assert.doesNotMatch(JSON.stringify(items), /sk-abcdefghijklmnopqrstuvwx/);
    assert.doesNotMatch(JSON.stringify(items), /B's own/);
    // The new kinds come after the older ones, so a cursor from an earlier export still names the same kind.
    assert.deepEqual(EXPORT_KINDS.slice(0, 9), ["project", "task", "desk-record", "summary-record", "artifact", "retention-archive", "responsibility-check", "stall-concern", "responsibility-incident"]);
    await assert.rejects(c.retention().export(c.reader, { projectId: c.a }), /may not export/);
  });
}

test("the meter: a create of an adoption, experiment or own-code request counts for its project and asker; a change or removal of one counts nothing; a kind named like an object's own key is not a meter", async () => {
  const create = (kind: string, body: Record<string, unknown>): OperationInput => ({ changes: [{ type: "create", ref: { kind, id: "x" }, body: body as JsonObject }] } as unknown as OperationInput);
  const update = (kind: string, body: Record<string, unknown>): OperationInput => ({ changes: [{ type: "update", ref: { kind, id: "x" }, expectedRevision: 1, body: body as JsonObject }] } as unknown as OperationInput);
  const remove = (kind: string): OperationInput => ({ changes: [{ type: "delete", ref: { kind, id: "x" }, expectedRevision: 1 }] } as unknown as OperationInput);
  for (const [kind, by] of [["adoption", "requestedBy"], ["experiment", "proposedBy"], ["owncode-request", "requestedBy"]] as const) {
    assert.equal(METERED[kind]?.createsOnly, true, kind);
    const made = addedBy(create(kind, { projectId: "proj-a", [by]: "agent:x", reason: "r" }));
    assert.ok((made.project.get("proj-a") ?? 0) > 0 && (made.agent.get("agent:x") ?? 0) > 0, kind);
    const changed = addedBy(update(kind, { projectId: "proj-a", [by]: "agent:x", reason: "a much longer reason ".repeat(20) }));
    assert.deepEqual([changed.project.size, changed.agent.size], [0, 0], `${kind}: a change is never held`);
    const store = { getAggregate: async () => ({ kind, id: "x", revision: 1, body: { projectId: "proj-a", [by]: "agent:x" }, createdAt: "", updatedAt: "" }) } as never;
    const net = await netAdded(store, update(kind, { projectId: "proj-a", [by]: "agent:x", reason: "longer" }));
    assert.deepEqual([net.project.size, net.agent.size], [0, 0]);
    const gone = await netAdded(store, remove(kind));
    assert.deepEqual([gone.project.size, gone.agent.size], [0, 0]);
  }
  // An own-code request before approval has no project: it counts for its asker only.
  assert.deepEqual([...addedBy(create("owncode-request", { requestedBy: "agent:y" })).project.keys()], []);
  // Kinds that are an object's own keys elsewhere are not meters (no inherited entry is taken for one).
  for (const kind of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    const out = addedBy(create(kind, { projectId: "proj-a", createdBy: "agent:x" }));
    assert.deepEqual([out.project.size, out.agent.size], [0, 0], kind);
    const net = await netAdded({ getAggregate: async () => ({ kind, id: "x", revision: 1, body: {}, createdAt: "", updatedAt: "" }) } as never, update(kind, {}));
    assert.deepEqual([net.project.size, net.agent.size], [0, 0], kind);
  }
  // The look records, their pending list and the indexes are written by the controller, not at an asker's request: not metered.
  for (const kind of ["adoption-look", "adoption-looks", "adoption-index", "experiment-index", "meeting-floor-inquiries"]) assert.equal(Object.hasOwn(METERED, kind), false, kind);
});
