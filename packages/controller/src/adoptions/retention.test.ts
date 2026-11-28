import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { keptWindow, waitingOf } from "../domain/kept-window.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { EnvironmentService } from "../environments/index.js";
import { ExperimentService } from "../experiments/index.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import { AdoptionService } from "./index.js";

// Cards B04 and B05, retention slice: only OPEN adoptions and experiments count toward a project's limit, one asker or proposer has at most 5 waiting for a decision in a project, and when the listed window
// (300) is full the oldest ENDED record leaves the list (archived: kept, readable by ID) in the same write as the new one. So someone with only meeting.read (adoptions) or meeting.agenda (experiments)
// can no longer use up the project by asking and taking back. Real storage on each backend; every step uses a fresh service over the same storage (as after a restart); the clock is the test's.

after(stopServer);

const now = Date.parse("2026-11-27T10:00:00.000Z");
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};
const hex = (c: string): string => c.repeat(64);
const PROPOSAL = { problem: "reviews send back handlers without error tests", affectedWork: "request handler reviews", change: "add a checklist to the coder prompt", effort: "one afternoon", runningCost: "no extra tokens", benefit: "less rework", evaluation: "the same five handler tasks", stoppingCondition: "two runs" };
const CRITERIA = {
  baseline: { label: "prompt v4", ref: "commit abc123", digest: hex("a") }, evaluator: { label: "review rubric", ref: "rubric 2", digest: hex("b") },
  cases: [{ id: "c1", text: "handler with a missing field" }], baselinePassing: ["c1"],
  baselineMetrics: { timeToAcceptedSeconds: 100, reworkCount: 4, adoptionCount: 5 }, budget: { maxRuns: 3, maxCost: 30 }, minRuns: 2, minImprovementPct: 5, maxRegressionPct: 0,
};
const GOOD = { timeToAcceptedSeconds: 80, reworkCount: 3, adoptionCount: 6 };
const GUARD = `sha256:${hex("9")}`;
const MANIFEST = { base: { name: "nimblenewt-base", version: "1.0.0", digest: `sha256:${hex("1")}` }, packages: [], skills: [], capabilities: ["desk.read"], configuration: { installation: 1 }, limits: { cpus: 1, memoryMb: 512, diskMb: 1024, processes: 64 }, protectedExtensions: [{ name: "nimblenewt.guard", digest: GUARD }] };
const PRACTICE = { kind: "practice" };
const tool = (name: string) => ({ kind: "tool", name, version: "1.0.0" });
/** 300 distinct, well-formed IDs of a kind that no record has (so none is open). */
const fakeIds = (prefix: string, count: number): string[] => Array.from({ length: count }, (_, i) => `${prefix}-${String.fromCharCode(97 + (i % 26)).repeat(18)}${String.fromCharCode(97 + Math.floor(i / 26) % 26)}${String.fromCharCode(97 + Math.floor(i / 676))}`);

test("keptWindow: the oldest ended records leave a full list, in order; an open one never does; a list of only open records has no room", () => {
  const open = new Set(["b", "d"]);
  assert.deepEqual(keptWindow(["a", "b"], (x) => open.has(x), 3, "z"), { ids: ["a", "b", "z"], archived: [] });
  assert.deepEqual(keptWindow(["a", "b", "c"], (x) => open.has(x), 3, "z"), { ids: ["b", "c", "z"], archived: ["a"] });
  assert.deepEqual(keptWindow(["b", "a", "d", "c"], (x) => open.has(x), 3, "z"), { ids: ["b", "d", "z"], archived: ["a", "c"] }, "a list over the cap (an older index) comes back under it");
  assert.equal(keptWindow(["b", "d"], (x) => open.has(x), 2, "z"), undefined);
  assert.deepEqual(keptWindow([], () => true, 1, "z"), { ids: ["z"], archived: [] });
  assert.equal(waitingOf({ x: "p", y: "q", z: "p" }, "p"), 2);
  assert.equal(waitingOf({}, "p"), 0);
});

interface Ctx {
  owner: Principal; mgr: Principal; mgr2: Principal; dev: Principal; dev2: Principal; reader: Principal; reader2: Principal; eve: Principal;
  a: string; storage: ControllerStorage; runner: CommandRunner;
  exps(): ExperimentService; adoptions(): AdoptionService;
  /** An experiment of project A proposed by dev, pinned by mgr, run twice and concluded `improved` by mgr. */
  improved(proposer?: Principal, affectedKey?: string): Promise<string>;
  ask(experimentId: string, target?: Record<string, unknown>, by?: Principal): Promise<string>;
  takeBack(id: string, by?: Principal): Promise<void>;
  propose(by?: Principal): Promise<string>;
  /** Replaces the stored body of a project index (as an older controller or a damaged store left it). */
  setIndex(kind: string, body: Record<string, unknown>): Promise<void>;
  index(kind: string): Promise<{ revision: number; body: Record<string, unknown> }>;
}

for (const backend of backends) {
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
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
        const exps = () => ExperimentService.withEpoch(world.storage, epoch, { ...options, environments: env });
        const adoptions = () => AdoptionService.withEpoch(world.storage, epoch, options);
        const mgr = await enroll("mgr", [{ action: "meeting.manage", project: a }]);
        const mgr2 = await enroll("mgr2", [{ action: "meeting.manage", project: a }]);
        const dev = await enroll("dev", [{ action: "meeting.agenda", project: a }]);
        const dev2 = await enroll("dev2", [{ action: "meeting.agenda", project: a }]);
        const reader = await enroll("reader", [{ action: "meeting.read", project: a }]);
        const reader2 = await enroll("reader2", [{ action: "meeting.read", project: a }]);
        const eve = await enroll("eve", [{ action: "meeting.manage", project: b }, { action: "meeting.agenda", project: b }]);
        await env.change(owner, { commandId: cid("env"), agentId: dev.id, manifest: MANIFEST, reason: "first" });
        const runner = new CommandRunner(world.storage, epoch, options);
        const ctx: Ctx = {
          owner, mgr, mgr2, dev, dev2, reader, reader2, eve, a, storage: world.storage, runner, exps, adoptions,
          improved: async (proposer = dev, affectedKey = `reviews ${n}`) => {
            const id = (await exps().propose(proposer, { commandId: cid("x"), projectId: a, title: "Checklist prompt", proposal: PROPOSAL, affectedKey } as never)).id;
            await exps().pin(mgr, { commandId: cid("p"), experimentId: id, expectedRevision: (await exps().get(owner, id))!.revision, criteria: CRITERIA } as never);
            for (let i = 0; i < 2; i++) await exps().recordRun(proposer === dev ? dev : owner, { commandId: cid("r"), experimentId: id, environment: { agentId: dev.id, revision: 1, observed: { "nimblenewt.guard": GUARD }, disposable: true }, cost: 1, metrics: GOOD, cases: [{ id: "c1", passed: true }] } as never);
            await exps().conclude(mgr, { commandId: cid("c"), experimentId: id, expectedRevision: (await exps().get(owner, id))!.revision, finding: "read the runs" });
            return id;
          },
          ask: async (experimentId, target = PRACTICE, by = reader) => (await adoptions().request(by, { commandId: cid("q"), experimentId, target, reason: "it helped" })).id,
          takeBack: async (id, by = reader) => { await adoptions().decline(by, { commandId: cid("d"), adoptionId: id, expectedRevision: (await adoptions().get(owner, id))!.revision, reason: "taken back" }); },
          propose: async (by = dev) => (await exps().propose(by, { commandId: cid("x"), projectId: a, title: "T", proposal: PROPOSAL, affectedKey: `k ${n}` } as never)).id,
          index: async (kind) => { const f = (await runner.get(kind, a))!; return { revision: f.revision, body: f.body as Record<string, unknown> }; },
          setIndex: async (kind, body) => {
            const f = await runner.get(kind, a);
            await runner.command("test.set", { commandId: cid("t"), actor: owner.id }, async () => ({ payload: {}, build: async () => ({ ref: { kind, id: a }, creates: f === undefined, changes: [f === undefined ? { type: "create" as const, ref: { kind, id: a }, body: body as JsonObject } : { type: "update" as const, ref: { kind, id: a }, expectedRevision: f.revision, body: body as JsonObject }], detail: {} }) }));
          },
        };
        await body(ctx);
      } finally { await world.close(); }
    });

  suite("adoptions: a reader who asks and takes back again and again no longer fills the project; the oldest ended one leaves the full list and stays readable by its ID", async (c) => {
    const exp = await c.improved();
    // A full list of 300 ended adoptions (IDs with no open adoption), as many cycles of asking and taking back would leave it.
    const old = fakeIds("adp", 300);
    await c.setIndex("adoption-index", { ids: old, open: {}, waiting: {}, archived: 0 });
    // Real cycles of asking and taking back by a reader: each is accepted; the list stays at 300 and the archived count grows by one each time.
    const mine: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const id = await c.ask(exp);
      mine.push(id);
      await c.takeBack(id);
      const ix = await c.index("adoption-index");
      assert.deepEqual([(ix.body["ids"] as string[]).length, ix.body["archived"], (ix.body["ids"] as string[]).at(-1), Object.keys(ix.body["open"] as object).length, Object.keys(ix.body["waiting"] as object).length], [300, i, id, 0, 0]);
    }
    const ids = (await c.index("adoption-index")).body["ids"] as string[];
    assert.deepEqual(ids.slice(0, 294), old.slice(6), "the oldest ended ones left, in order");
    // The reader's own taken-back requests keep moving out of the list as more come; they stay readable by ID with the same rights, and nothing is deleted.
    await c.setIndex("adoption-index", { ...(await c.index("adoption-index")).body, ids: [...mine, ...old.slice(0, 294)] });
    const next = await c.adoptions().request(c.reader, { commandId: "archives-one", experimentId: exp, target: PRACTICE, reason: "r" });
    const ix = (await c.index("adoption-index")).body;
    assert.equal((ix["ids"] as string[]).includes(mine[0]!), false);
    assert.equal(ix["archived"], 7);
    const archived = await c.adoptions().get(c.reader, mine[0]!);
    assert.deepEqual([archived?.status, archived?.requestedBy], ["declined", c.reader.id]);
    assert.equal((await c.adoptions().get(c.owner, mine[0]!))?.status, "declined");
    // No existence oracle: someone who may not read the project gets the same nothing for an archived adoption as for one that never existed.
    assert.equal(await c.adoptions().get(c.eve, mine[0]!), undefined);
    assert.equal(await c.adoptions().get(c.eve, `adp-${"q".repeat(20)}`), undefined);
    assert.equal(await c.adoptions().list(c.eve, c.a), undefined);
    // The list says how many left it.
    const page = (await c.adoptions().list(c.reader, c.a, { limit: 1 }))!;
    assert.deepEqual([page.archived, page.items.length], [7, 1]);
    // A repeat of the request that archived one (as after a restart) is answered from its record: the same adoption, and nothing more is archived.
    const repeat = await c.adoptions().request(c.reader, { commandId: "archives-one", experimentId: exp, target: PRACTICE, reason: "r" });
    assert.deepEqual([repeat.id, repeat.replayed, (await c.index("adoption-index")).body["archived"]], [next.id, true, 7]);
  });

  suite("adoptions: one asker has at most 5 requests waiting for a review in a project; deciding or taking one back frees a place; others are not held up; a replay is still answered", async (c) => {
    const exp = await c.improved();
    const targets = [PRACTICE, tool("toolbox.a"), tool("toolbox.b"), tool("toolbox.c"), tool("toolbox.d")];
    const asked: string[] = [];
    for (const t of targets) asked.push(await c.ask(exp, t));
    const before = await c.index("adoption-index");
    await refuses("unavailable", () => c.ask(exp, tool("toolbox.e")), /you already have 5 adoption requests waiting/);
    assert.equal((await c.index("adoption-index")).revision, before.revision, "a refused request stores nothing");
    // Another asker in the same project is not held up.
    const other = await c.ask(exp, tool("toolbox.e"), c.reader2);
    // Approved, an adoption no longer waits for a review (it stays open): the asker may ask again.
    await c.adoptions().approve(c.mgr2, { commandId: cid("ap"), adoptionId: asked[0]!, expectedRevision: (await c.adoptions().get(c.owner, asked[0]!))!.revision, review: "the runs agree" });
    const sixth = await c.ask(exp, tool("toolbox.f"));
    await refuses("unavailable", () => c.ask(exp, tool("toolbox.g")), /5 adoption requests waiting/);
    // Taken back (or declined by a reviewer), it frees a place too.
    await c.takeBack(asked[1]!);
    const again = await c.adoptions().request(c.reader, { commandId: "replay-ok", experimentId: exp, target: tool("toolbox.g"), reason: "r" });
    const repeat = await c.adoptions().request(c.reader, { commandId: "replay-ok", experimentId: exp, target: tool("toolbox.g"), reason: "r" });
    assert.deepEqual([repeat.id, repeat.replayed, again.replayed], [again.id, true, false], "a replay at the limit is the same request");
    await c.adoptions().decline(c.mgr2, { commandId: cid("d"), adoptionId: asked[2]!, expectedRevision: (await c.adoptions().get(c.owner, asked[2]!))!.revision, reason: "not now" });
    await c.ask(exp, tool("toolbox.h"));
    const w = (await c.index("adoption-index")).body["waiting"] as Record<string, string>;
    assert.deepEqual([Object.values(w).filter((x) => x === c.reader.id).length, w[other], w[asked[0]!], w[sixth]], [5, c.reader2.id, undefined, c.reader.id]);
    // The limit is the asker's own: the refusal names no one else's requests, and someone who may not read the project is refused as before (forbidden), not told about the limit.
    await refuses("forbidden", () => c.ask(exp, tool("toolbox.z"), c.eve));
  });

  suite("adoptions: at most 300 open in a project (asked or in force); two requests at once at the asker's limit give one result; an older index without the waiting map is rebuilt from the records", async (c) => {
    const exp = await c.improved();
    // 300 open adoptions (keys to IDs, as many askers and approvals would leave them): the next request is refused and nothing is stored.
    const open = Object.fromEntries(fakeIds("adp", 300).map((id, i) => [`tool:toolbox.t${i}@1.0.0`, id]));
    await c.setIndex("adoption-index", { ids: Object.values(open), open, waiting: {}, archived: 0 });
    const full = await c.index("adoption-index");
    await refuses("unavailable", () => c.ask(exp), /300 adoptions are open/);
    assert.equal((await c.index("adoption-index")).revision, full.revision);
    // Back to an empty index. Two requests at once when the asker has 4 waiting: one is accepted, the other refused (the index is revision-guarded).
    await c.setIndex("adoption-index", { ids: [], open: {}, waiting: {}, archived: 0 });
    for (const t of ["toolbox.a", "toolbox.b", "toolbox.c", "toolbox.d"]) await c.ask(exp, tool(t));
    const both = await Promise.allSettled([c.ask(exp, tool("toolbox.e")), c.ask(exp, tool("toolbox.f"))]);
    assert.deepEqual(both.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
    const lost = both.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(lost.reason instanceof DomainError && lost.reason.code === "unavailable", String(lost.reason));
    // An index written before this slice (no waiting map, no archived count): the waiting requests are found from the records, so the limit still holds.
    const cur = (await c.index("adoption-index")).body;
    await c.setIndex("adoption-index", { ids: cur["ids"], open: cur["open"] });
    await refuses("unavailable", () => c.ask(exp, tool("toolbox.g")), /5 adoption requests waiting/);
    await c.ask(exp, tool("toolbox.g"), c.reader2);
    const rebuilt = (await c.index("adoption-index")).body;
    assert.equal(Object.values(rebuilt["waiting"] as Record<string, string>).filter((x) => x === c.reader.id).length, 5, "the rebuilt map is written with the next change");
    assert.equal(rebuilt["archived"], 0);
    // A list or in-force read of an older index works without rebuilding.
    await c.setIndex("adoption-index", { ids: rebuilt["ids"], open: rebuilt["open"] });
    assert.equal((await c.adoptions().list(c.reader, c.a, { limit: 100 }))!.items.length, 6);
    assert.equal((await c.adoptions().list(c.reader, c.a))!.archived, undefined);
    // An approved adoption is open but no longer waiting: an older index rebuilt from the records does not count it against its asker.
    const mineNow = Object.entries(rebuilt["waiting"] as Record<string, string>).filter(([, v]) => v === c.reader.id).map(([k]) => k);
    await c.takeBack(mineNow[0]!);
    const practice = await c.ask(exp, PRACTICE);
    await c.adoptions().approve(c.mgr2, { commandId: cid("ap"), adoptionId: practice, expectedRevision: (await c.adoptions().get(c.owner, practice))!.revision, review: "the runs agree" });
    const approved = (await c.index("adoption-index")).body;
    await c.setIndex("adoption-index", { ids: approved["ids"], open: approved["open"] });
    await c.ask(exp, tool("toolbox.h"));
    // A damaged archived count is read as none rather than trusted, and the next write stores a sound one.
    await c.setIndex("adoption-index", { ...(await c.index("adoption-index")).body, archived: -4 });
    assert.equal((await c.adoptions().list(c.reader, c.a))!.archived, undefined);
    await c.ask(exp, tool("toolbox.i"), c.reader2);
    assert.equal((await c.index("adoption-index")).body["archived"], 0);
  });

  suite("experiments: proposing and withdrawing again and again no longer fills the project; at most 5 proposals of one proposer wait for criteria; an archived experiment is still read and adopted", async (c) => {
    // Up to 5 proposals of one proposer wait; the 6th is refused and stores nothing; another proposer is not held up.
    const mine: string[] = [];
    for (let i = 0; i < 5; i++) mine.push(await c.propose());
    const before = await c.index("experiment-index");
    await refuses("unavailable", () => c.propose(), /you already have 5 proposals waiting/);
    assert.equal((await c.index("experiment-index")).revision, before.revision);
    await c.propose(c.dev2);
    // Pinned (it runs) or withdrawn, a proposal no longer waits.
    await c.exps().pin(c.mgr, { commandId: cid("p"), experimentId: mine[0]!, expectedRevision: (await c.exps().get(c.owner, mine[0]!))!.revision, criteria: CRITERIA } as never);
    const sixth = await c.propose();
    await refuses("unavailable", () => c.propose(), /5 proposals waiting/);
    await c.exps().withdraw(c.dev, { commandId: cid("w"), experimentId: mine[1]!, expectedRevision: (await c.exps().get(c.owner, mine[1]!))!.revision, reason: "not now" });
    await c.propose();
    let ix = (await c.index("experiment-index")).body;
    assert.deepEqual([Object.keys(ix["open"] as object).length, Object.values(ix["waiting"] as Record<string, string>).filter((x) => x === c.dev.id).length, (ix["open"] as Record<string, string>)[mine[0]!], (ix["waiting"] as Record<string, string>)[mine[0]!], (ix["open"] as Record<string, string>)[mine[1]!], (ix["waiting"] as Record<string, string>)[sixth]],
      [7, 5, c.dev.id, undefined, undefined, c.dev.id]);
    // Concluded, it is no longer open.
    const done = await c.improved(c.dev2);
    ix = (await c.index("experiment-index")).body;
    assert.equal((ix["open"] as Record<string, string>)[done], undefined);
    // A full list of ended experiments: proposing still works; the oldest ended one (a concluded, improved experiment here) leaves the list and is kept; it is still read and adopted by its ID.
    const listed = ix["ids"] as string[];
    const openNow = ix["open"] as Record<string, string>;
    await c.setIndex("experiment-index", { ...ix, ids: [mine[0]!, done, ...fakeIds("exp", 300 - listed.length), ...listed.filter((x) => x !== done && x !== mine[0])] });
    await c.exps().withdraw(c.dev, { commandId: cid("w"), experimentId: sixth, expectedRevision: (await c.exps().get(c.owner, sixth))!.revision, reason: "room" });
    const fresh = await c.propose();
    ix = (await c.index("experiment-index")).body;
    assert.deepEqual([(ix["ids"] as string[]).length, (ix["ids"] as string[]).includes(done), (ix["ids"] as string[]).at(-1), ix["archived"]], [300, false, fresh, 1]);
    assert.equal((ix["open"] as Record<string, string>)[mine[0]!], c.dev.id, "the running experiment listed first is open");
    assert.equal((ix["ids"] as string[])[0], mine[0], "an open experiment at the head of the list does not leave it; the ended one after it does");
    for (const id of Object.keys(openNow)) assert.ok((ix["ids"] as string[]).includes(id), "an open experiment never leaves the list");
    assert.equal((await c.exps().get(c.reader, done))?.result?.verdict, "improved");
    assert.equal((await c.exps().list(c.reader, c.a, { limit: 1 }))!.archived, 1);
    await c.exps().withdraw(c.dev, { commandId: cid("w"), experimentId: fresh, expectedRevision: (await c.exps().get(c.owner, fresh))!.revision, reason: "later" });
    assert.equal((await c.index("experiment-index")).body["archived"], 1, "a withdrawal keeps the archived count");
    const adopted = await c.ask(done);
    assert.equal((await c.adoptions().get(c.owner, adopted))?.experimentId, done);
    assert.equal(await c.exps().get(c.eve, done), undefined, "no existence oracle for an archived experiment");
    // Someone who may not propose in the project is refused as before, not told about the limit.
    await refuses("forbidden", () => c.propose(c.eve));
  });

  suite("experiments: at most 300 open in a project; an older index is rebuilt from the records, a record that cannot be read counting as open (stricter, not looser); a repeat after a restart stores no second archive", async (c) => {
    const p = await c.propose();
    // An index from before this slice (ids and claims only), listing 299 IDs no record has and one real proposal: the unreadable ones count as open, so the project is full and nothing is stored.
    await c.setIndex("experiment-index", { ids: [...fakeIds("exp", 299), p], claims: {} });
    const old = await c.index("experiment-index");
    await refuses("unavailable", () => c.propose(c.dev2), /300 experiments are open/);
    assert.equal((await c.index("experiment-index")).revision, old.revision);
    // Listing an older index works without rebuilding it.
    assert.equal((await c.exps().list(c.reader, c.a, { limit: 100 }))!.items.length, 1);
    // The same older index with 295 unreadable IDs: dev's one waiting proposal is found from its record.
    await c.setIndex("experiment-index", { ids: [...fakeIds("exp", 295), p], claims: {} });
    for (let i = 0; i < 4; i++) await c.propose();
    await refuses("unavailable", () => c.propose(), /5 proposals waiting/);
    const ix = (await c.index("experiment-index")).body;
    assert.deepEqual([Object.keys(ix["open"] as object).length, (ix["waiting"] as Record<string, string>)[p]], [300, c.dev.id]);
    // A full list of ended experiments: a proposal moves one out; repeating the same command after a restart is the same proposal and moves out nothing more.
    await c.setIndex("experiment-index", { ids: fakeIds("exp", 300), claims: {}, open: {}, waiting: {}, archived: 0 });
    const first = await c.exps().propose(c.dev2, { commandId: "once", projectId: c.a, title: "T", proposal: PROPOSAL, affectedKey: "k once" } as never);
    const again = await c.exps().propose(c.dev2, { commandId: "once", projectId: c.a, title: "T", proposal: PROPOSAL, affectedKey: "k once" } as never);
    assert.deepEqual([again.id, again.replayed], [first.id, true]);
    const after2 = (await c.index("experiment-index")).body;
    assert.deepEqual([(after2["ids"] as string[]).length, after2["archived"], (after2["ids"] as string[]).filter((x) => x === first.id).length], [300, 1, 1]);
    // A damaged archived count is read as none rather than trusted, and the next write stores a sound one.
    await c.setIndex("experiment-index", { ...after2, archived: -4 });
    assert.equal((await c.exps().list(c.reader, c.a))!.archived, undefined);
    await c.propose(c.dev2);
    assert.equal((await c.index("experiment-index")).body["archived"], 1, "the damaged count is read as 0, and the proposal moves one more ended experiment out of the full list");
  });

  suite("adoptions: an adoption in force at the head of a full list never leaves it and is still consulted, monitored and withdrawn; one withdrawn by a regression is ended and may then leave; a damaged waiting map is rebuilt", async (c) => {
    const exp = await c.improved();
    const live = await c.ask(exp);
    await c.adoptions().approve(c.mgr2, { commandId: cid("ap"), adoptionId: live, expectedRevision: (await c.adoptions().get(c.owner, live))!.revision, review: "the runs agree" });
    const cur = (await c.index("adoption-index")).body;
    // The in-force one is listed first, then 299 ended ones: the next request moves out the first ENDED one, not the one in force.
    const old = fakeIds("adp", 299);
    await c.setIndex("adoption-index", { ...cur, ids: [live, ...old] });
    const t1 = await c.ask(exp, tool("toolbox.a"), c.reader2);
    let ix = (await c.index("adoption-index")).body;
    assert.deepEqual([(ix["ids"] as string[])[0], (ix["ids"] as string[]).includes(old[0]!), (ix["ids"] as string[]).length, ix["archived"]], [live, false, 300, 1]);
    assert.equal((await c.adoptions().list(c.reader, c.a, { limit: 1 }))!.archived, 1);
    assert.equal((await c.adoptions().inForce(c.reader, { projectId: c.a, experimentId: exp, target: PRACTICE }))?.adoptionId, live);
    // Monitored; a regression withdraws it (ended), frees its open place, and the next full-list request may then move it out.
    const report = await c.adoptions().monitor(c.mgr, { commandId: cid("m"), adoptionId: live, metrics: { timeToAcceptedSeconds: 200, reworkCount: 4, adoptionCount: 5 } });
    assert.equal(report.status, "withdrawn");
    ix = (await c.index("adoption-index")).body;
    assert.equal(Object.values(ix["open"] as Record<string, string>).includes(live), false);
    assert.equal(await c.adoptions().inForce(c.reader, { projectId: c.a, experimentId: exp, target: PRACTICE }), undefined);
    await c.ask(exp, tool("toolbox.b"), c.reader2);
    ix = (await c.index("adoption-index")).body;
    assert.deepEqual([(ix["ids"] as string[]).includes(live), ix["archived"]], [false, 2]);
    assert.equal((await c.adoptions().get(c.reader, live))?.status, "withdrawn", "archived, still readable by ID");
    // A waiting map that is not a map (an array, a damaged store) is rebuilt from the records, not read as none waiting.
    for (const t of ["toolbox.c", "toolbox.d", "toolbox.e"]) await c.ask(exp, tool(t), c.reader2);
    await c.setIndex("adoption-index", { ...(await c.index("adoption-index")).body, waiting: [] });
    await refuses("unavailable", () => c.ask(exp, tool("toolbox.f"), c.reader2), /5 adoption requests waiting/);
    // An in-force adoption is still withdrawn by a manager after its list moved on.
    const live2 = await c.ask(exp, PRACTICE);
    await c.adoptions().approve(c.mgr2, { commandId: cid("ap"), adoptionId: live2, expectedRevision: (await c.adoptions().get(c.owner, live2))!.revision, review: "again" });
    await c.setIndex("adoption-index", { ...(await c.index("adoption-index")).body, ids: [live2, ...fakeIds("adp", 299)] });
    await c.ask(exp, tool("toolbox.g"));
    assert.equal(((await c.index("adoption-index")).body["ids"] as string[])[0], live2);
    await c.adoptions().withdraw(c.mgr, { commandId: cid("w"), adoptionId: live2, expectedRevision: (await c.adoptions().get(c.owner, live2))!.revision, reason: "done" });
    assert.equal((await c.adoptions().get(c.owner, live2))?.status, "withdrawn");
  });

  suite("experiments: a paused experiment never leaves a full list; an archived improvement's savings stay counted; an older index longer than the window counts the unread IDs as open", async (c) => {
    // Paused: its budget (3 runs) is used up. It is open, so a full list moves out the ended one after it, not it.
    const paused = await c.propose();
    await c.exps().pin(c.mgr, { commandId: cid("p"), experimentId: paused, expectedRevision: (await c.exps().get(c.owner, paused))!.revision, criteria: CRITERIA } as never);
    for (let i = 0; i < 3; i++) await c.exps().recordRun(c.dev, { commandId: cid("r"), experimentId: paused, environment: { agentId: c.dev.id, revision: 1, observed: { "nimblenewt.guard": GUARD }, disposable: true }, cost: 1, metrics: GOOD, cases: [{ id: "c1", passed: true }] } as never);
    assert.equal((await c.exps().get(c.owner, paused))?.status, "paused");
    // An older index (no open map) is rebuilt from the records: a paused experiment counts as open.
    await c.setIndex("experiment-index", { ids: [paused], claims: {} });
    await c.propose(c.dev2);
    assert.equal(((await c.index("experiment-index")).body["open"] as Record<string, string>)[paused], c.dev.id, "a paused experiment is open when an older index is rebuilt");
    const done = await c.improved(c.dev2, "shared work");
    let ix = (await c.index("experiment-index")).body;
    const claimed = Object.entries(ix["claims"] as Record<string, string>).filter(([, v]) => v === done).map(([k]) => k);
    assert.ok(claimed.length > 0, "the improvement claimed its savings");
    await c.setIndex("experiment-index", { ...ix, ids: [paused, done, ...fakeIds("exp", 298)] });
    await c.propose(c.dev2);
    ix = (await c.index("experiment-index")).body;
    assert.deepEqual([(ix["ids"] as string[])[0], (ix["ids"] as string[]).includes(done), ix["archived"]], [paused, false, 1]);
    // The archived improvement keeps its claims: a later improvement over the same metric and work is recorded as not counted and names it.
    for (const k of claimed) assert.equal((ix["claims"] as Record<string, string>)[k], done);
    const later = await c.improved(c.dev2, "shared work");
    const savings = (await c.exps().get(c.owner, later))?.result?.savings ?? [];
    assert.equal((await c.index("experiment-index")).body["archived"], 2, "each full-list proposal moved one out; the pin and conclusion in between kept the count");
    assert.ok(savings.length > 0 && savings.every((s) => !s.counted && s.duplicateOf === done), JSON.stringify(savings));
    // The paused one is still raised, run and concluded by its ID.
    await c.exps().raiseBudget(c.mgr, { commandId: cid("b"), experimentId: paused, expectedRevision: (await c.exps().get(c.owner, paused))!.revision, maxRuns: 4, maxCost: 40, reason: "one more" } as never);
    assert.equal((await c.exps().get(c.owner, paused))?.status, "running");
    // An older index (no open map) longer than the window: the IDs before the last 300 are not read and count as open, so none of them leaves the list.
    // (301 listed: the running one first, outside the last 300; then 298 unreadable IDs, which count as open; then the two concluded ones, which leave.)
    await c.setIndex("experiment-index", { ids: [paused, ...fakeIds("exp", 298), done, later], claims: {} });
    const fresh = await c.propose(c.dev2);
    ix = (await c.index("experiment-index")).body;
    assert.deepEqual([(ix["ids"] as string[])[0], (ix["ids"] as string[]).length, (ix["ids"] as string[]).at(-1), ix["archived"], (ix["open"] as Record<string, string>)[paused]], [paused, 300, fresh, 2, ""]);
    // The paused-then-running one counted as open in the rebuilt index, the ended ones are not.
    await c.setIndex("experiment-index", { ids: [paused, done, later], claims: {} });
    await c.propose(c.dev2);
    ix = (await c.index("experiment-index")).body;
    assert.deepEqual([(ix["open"] as Record<string, string>)[paused], (ix["open"] as Record<string, string>)[done], (ix["open"] as Record<string, string>)[later]], [c.dev.id, undefined, undefined]);
    assert.equal((ix["waiting"] as Record<string, string>)[paused], undefined, "a running experiment does not wait for criteria");
    // An index with the open map but no waiting map (a damaged store) is rebuilt too: the waiting proposal is found from its record.
    const { waiting: _w, ...partial } = ix;
    void _w;
    await c.setIndex("experiment-index", partial);
    await c.propose(c.dev2);
    const w = (await c.index("experiment-index")).body["waiting"] as Record<string, string>;
    assert.equal(Object.values(w).filter((x) => x === c.dev2.id).length, 2);
  });

  suite("damaged archived counts read as 0; a null waiting map is rebuilt; an approval keeps the archived count; a pin on an older index keeps every open experiment counted; a page after an archived ID is refused", async (c) => {
    const exp = await c.improved();
    // A fractional archived count (damaged) is read as 0, not carried on.
    await c.setIndex("adoption-index", { ids: [], open: {}, waiting: {}, archived: 1.5 });
    const first = await c.ask(exp);
    assert.equal((await c.index("adoption-index")).body["archived"], 0);
    // Approving takes the adoption out of the waiting map and keeps the archived count.
    await c.setIndex("adoption-index", { ...(await c.index("adoption-index")).body, archived: 4 });
    await c.adoptions().approve(c.mgr2, { commandId: cid("ap"), adoptionId: first, expectedRevision: (await c.adoptions().get(c.owner, first))!.revision, review: "the runs agree" });
    let ix = (await c.index("adoption-index")).body;
    assert.deepEqual([ix["archived"], (ix["waiting"] as Record<string, string>)[first], Object.values(ix["open"] as Record<string, string>).includes(first)], [4, undefined, true]);
    // A waiting map stored as null is rebuilt from the records: the asker's limit still holds.
    const asked: string[] = [];
    for (const t of ["toolbox.a", "toolbox.b", "toolbox.c", "toolbox.d", "toolbox.e"]) asked.push(await c.ask(exp, tool(t)));
    await c.setIndex("adoption-index", { ...(await c.index("adoption-index")).body, waiting: null });
    await refuses("unavailable", () => c.ask(exp, tool("toolbox.f")), /5 adoption requests waiting/);
    // A page continued after an ID that was archived in between is refused with a clear field error; the archived adoption stays readable by its ID.
    await c.takeBack(asked[0]!);
    const cur = (await c.index("adoption-index")).body;
    const rest = (cur["ids"] as string[]).filter((x) => x !== asked[0]);
    await c.setIndex("adoption-index", { ...cur, ids: [asked[0]!, ...fakeIds("adp", 300 - 1 - rest.length), ...rest] });
    const page = (await c.adoptions().list(c.reader, c.a, { limit: 1 }))!;
    assert.deepEqual([page.items[0]?.id, page.next], [asked[0], asked[0]]);
    await c.ask(exp, tool("toolbox.f"));
    ix = (await c.index("adoption-index")).body;
    assert.deepEqual([(ix["ids"] as string[]).includes(asked[0]!), (ix["ids"] as string[]).length, ix["archived"]], [false, 300, 5]);
    await refuses("invalid_command", () => c.adoptions().list(c.reader, c.a, { afterId: asked[0]! }), /afterId: is not in the list/);
    assert.equal((await c.adoptions().get(c.reader, asked[0]!))?.status, "declined");

    // Experiments: an older index (no open or waiting map, a fractional archived count). A pin rebuilds it from the records before it writes: the other proposal stays open and waiting,
    // the pinned one stays open, and a withdrawn one is ended (not open, so it may leave a full list).
    const p1 = await c.propose();
    const p2 = await c.propose();
    const gone = await c.propose();
    await c.exps().withdraw(c.dev, { commandId: cid("w"), experimentId: gone, expectedRevision: (await c.exps().get(c.owner, gone))!.revision, reason: "not needed" });
    const old = (await c.index("experiment-index")).body;
    await c.setIndex("experiment-index", { ids: old["ids"], claims: old["claims"], archived: 2.5 });
    await c.exps().pin(c.mgr, { commandId: cid("p"), experimentId: p1, expectedRevision: (await c.exps().get(c.owner, p1))!.revision, criteria: CRITERIA } as never);
    const ex = (await c.index("experiment-index")).body;
    const open = ex["open"] as Record<string, string>;
    const waiting = ex["waiting"] as Record<string, string>;
    assert.deepEqual([open[p1], open[p2], open[gone], open[exp], waiting[p1], waiting[p2], waiting[gone], ex["archived"]], [c.dev.id, c.dev.id, undefined, undefined, undefined, c.dev.id, undefined, 0]);
  });
}
