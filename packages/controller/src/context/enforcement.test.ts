import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BlockerService, DomainError, EffectService, ProjectService, type DomainErrorCode } from "../domain/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import { ContextEnforcementService, DeskService, HistoryService, RetrievalService, contextBudget, type CompactionOutcome, type HandoffFacts, type SourceRef, type StartupItem, type Summariser } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-22T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};
const hangs: Summariser = { route: "local", summarise: () => new Promise<string>(() => undefined) };
const writes = (route: string, out: string, calls?: { n: number }): Summariser => ({ route, summarise: async () => { if (calls) calls.n++; return out; } });
const WINDOW = 131_072;
const MATERIAL = "The agents discussed the database at length. ".repeat(200);
const summary = (r: CompactionOutcome): Extract<CompactionOutcome, { kind: "summary" }> => { assert.equal(r.kind, "summary", JSON.stringify(r)); return r as never; };

for (const backend of backends) {
  interface Ctx {
    owner: Principal; host: Principal; ann: Principal; ben: Principal; eve: Principal; a: string; t: string; t2: string;
    enf: ContextEnforcementService; reopen(retrieval?: RetrievalService): ContextEnforcementService; retrieval: RetrievalService; blockers: BlockerService; effects: EffectService;
    note(by: Principal, title: string, body: string, visibility?: "shared" | "private"): Promise<SourceRef>;
    setup(task?: string): Promise<void>;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>, enforcement: { maxOverflows?: number; summary?: { timeoutMs: number } } = {}) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const agent = async (nm: string, grants: Grant[]) => {
          await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants });
          return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        };
        const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const b = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
        const t = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: a, title: "the task" })).id;
        const t2 = (await projects.createTask({ commandId: cid("t2"), actor: "owner:rob", projectId: a, title: "another task" })).id;
        const histories = HistoryService.withEpoch(world.storage, projects.epoch, options);
        const desks = DeskService.withEpoch(world.storage, projects.epoch, options);
        const retrieval = RetrievalService.withEpoch(world.storage, projects.epoch, desks, histories, options);
        const blockers = BlockerService.withEpoch(world.storage, projects.epoch, options);
        const effects = EffectService.withEpoch(world.storage, projects.epoch, undefined, options);
        const make = (r: RetrievalService = retrieval) => ContextEnforcementService.withEpoch(world.storage, projects.epoch, { blockers, retrieval: r }, { ...options, ...enforcement });
        const rights = (p: string): Grant[] => [{ action: "desk.write", project: p }, { action: "desk.read", project: p }, { action: "attempt.work", project: p }];
        const ann = await agent("ann", rights(a));
        const ben = await agent("ben", [{ action: "desk.read", project: a }, { action: "attempt.work", project: a }]);
        const eve = await agent("eve", rights(b));
        await principals.enroll(owner, { commandId: cid("e"), kind: "host", name: "h1", grants: [{ action: "desk.read", project: a }, { action: "desk.write", project: a }] });
        const host = await principals.authenticate((await principals.issueCredential(owner, "host:h1")).token);
        const note = async (by: Principal, title: string, text: string, visibility: "shared" | "private" = "shared"): Promise<SourceRef> => ({ kind: "desk-record", id: (await desks.write(by, { commandId: cid("w"), projectId: a, kind: "note", title, body: text, visibility, status: "accepted" })).id });
        const enf = make();
        const setup = async (task = t): Promise<void> => { await enf.registerCompressor(owner, { taskId: task, compressorId: "pi-before-compact" }); };
        await body({ owner, host, ann, ben, eve, a, t, t2, enf, reopen: make, retrieval, blockers, effects, note, setup });
      } finally { await world.close(); }
    });
  const compactCmd = (task: string, k: string, sources: SourceRef[], extra: Record<string, unknown> = {}) => ({ taskId: task, attemptId: "att-1", key: k, compressorId: "pi-before-compact", title: `summary ${k}`, material: MATERIAL, sources, ...extra });

  suite("the first call is checked with Pi's fixed part and the reported size; a refusal is a visible blocker and a repeat finds the same record", async ({ enf, owner, blockers, t }) => {
    const call = { systemPromptChars: 9_000, toolSchemaChars: 15_000, startupTokens: 2_000, replyReserveTokens: 8_000 };
    const ok = await enf.admit(owner, { taskId: t, attemptId: "att-1", window: WINDOW, call });
    assert.deepEqual([ok.admit, ok.basis, ok.blockerId], [true, "estimated", undefined]);
    assert.equal((await enf.admit(owner, { taskId: t, attemptId: "att-1", window: WINDOW, call })).replayed, true);
    // The fixed part alone (Pi's prompt and the schemas of many MCP tools) is over the limit: refused, never sent, with a blocker.
    const big = await enf.admit(owner, { taskId: t, attemptId: "att-2", window: WINDOW, call: { ...call, toolSchemaChars: 100_000 } });
    assert.equal(big.admit, false);
    assert.match(big.reasons[0]!, /startup limit of 32768/);
    assert.ok(big.blockerId);
    const blocker = (await blockers.getBlocker(big.blockerId))!;
    assert.deepEqual([blocker.type, blocker.state, blocker.resolver, blocker.subject], ["context_overflow", "open", "owner", { kind: "task", id: t }]);
    assert.match(blocker.summary, /was not sent/);
    // A repeat is the recorded decision (and the same blocker), even from a restarted service.
    const again = await enf.admit(owner, { taskId: t, attemptId: "att-2", window: WINDOW, call: { ...call, toolSchemaChars: 100_000 } });
    assert.deepEqual([again.replayed, again.blockerId], [true, big.blockerId]);
    // The provider's count of the same prompt is larger than the estimate: it wins.
    const reported = await enf.admit(owner, { taskId: t, attemptId: "att-3", window: WINDOW, call: { ...call, reportedInputTokens: 50_000 } });
    assert.deepEqual([reported.admit, reported.basis, reported.startupTokens], [false, "reported", 50_000]);
    // Same attempt, different numbers, same round: refused (a new round is how an attempt asks again).
    await refuses("command_conflict", () => enf.admit(owner, { taskId: t, attemptId: "att-1", window: WINDOW, call: { ...call, startupTokens: 3_000 } }));
    // While the blocker opened by the refusals above is open, nothing is admitted on the task; once it is resolved, a new round is.
    const blocked = await enf.admit(owner, { taskId: t, attemptId: "att-1", round: 2, window: WINDOW, call: { ...call, startupTokens: 3_000 } });
    assert.equal(blocked.admit, false);
    assert.match(blocked.reasons[0]!, /context_overflow blocker is open on this task/);
    const open = (await blockers.getBlocker(big.blockerId!))!;
    await blockers.resolveBlocker({ commandId: cid("rb"), actor: owner.id, blockerId: open.id, expectedRevision: open.revision, resolution: "route changed" });
    assert.equal((await enf.admit(owner, { taskId: t, attemptId: "att-1", round: 3, window: WINDOW, call: { ...call, startupTokens: 3_000 } })).admit, true);
  });

  suite("after the call: the reported size is recorded with the characters per token it implies, and an estimate that was too low is flagged", async ({ enf, owner, t }) => {
    await enf.admit(owner, { taskId: t, attemptId: "att-1", window: WINDOW, call: { systemPromptChars: 9_000, toolSchemaChars: 9_000, startupTokens: 2_000, replyReserveTokens: 8_000 } });
    const c = await enf.confirmUsage(owner, { taskId: t, attemptId: "att-1", reportedInputTokens: 40_000, promptChars: 80_000 });
    assert.deepEqual([c.charsPerToken, c.overStartupLimit, c.replayed], [2, true, false]);
    assert.equal((await enf.confirmUsage(owner, { taskId: t, attemptId: "att-1", reportedInputTokens: 40_000, promptChars: 80_000 })).replayed, true);
    await refuses("not_found", () => enf.confirmUsage(owner, { taskId: t, attemptId: "att-9", reportedInputTokens: 10, promptChars: 30 }));
  });

  suite("falling back to a smaller-window route rebuilds the context view, or blocks with a visible reason when the essentials do not fit", async ({ enf, owner, blockers, t, t2 }) => {
    const at = (i: number): string => new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString();
    const items: StartupItem[] = [{ id: "g", kind: "goal", text: "Goal: ship v1.", at: at(0) }, { id: "h", kind: "human", text: "Merge the branch.", at: at(1) }];
    for (let i = 0; i < 20; i++) items.push({ id: `r${i}`, kind: "report", text: "x".repeat(1500), at: at(i + 2) });
    const ok = await enf.changeRoute(owner, { taskId: t, attemptId: "att-1", window: 32_768, fixedTokens: 3_000, items });
    assert.equal(ok.rebuilt, true);
    assert.ok(ok.startup.cuts.length > 0 && ok.startup.archive.length === ok.startup.cuts.length, "rebuilt, with the cut text returned for archiving");
    assert.ok(ok.startup.tokens + 3_000 <= contextBudget(32_768).startupTokens);
    const blocked = await enf.changeRoute(owner, { taskId: t2, attemptId: "att-1", window: 8_192, fixedTokens: 2_000, items });
    assert.equal(blocked.rebuilt, false);
    assert.match(blocked.reason!, /essential constraints do not fit the 8192-token route/);
    assert.deepEqual(blocked.startup.pieces, [], "nothing to send");
    assert.equal((await blockers.getBlocker(blocked.blockerId!))!.type, "context_overflow");
    assert.equal((await enf.changeRoute(owner, { taskId: t2, attemptId: "att-1", window: 8_192, fixedTokens: 2_000, items })).replayed, true);
  });

  suite("one compressor per context: a second is refused at registration, the same one again is a no-op, and only the registered one compacts", async ({ enf, owner, note, ann, t, t2 }) => {
    assert.equal((await enf.registerCompressor(owner, { taskId: t, compressorId: "pi-before-compact" })).replayed, false);
    assert.equal((await enf.registerCompressor(owner, { taskId: t, compressorId: "pi-before-compact" })).replayed, true);
    await refuses("invalid_command", () => enf.registerCompressor(owner, { taskId: t, compressorId: "hermes-compressor" }), (e) => assert.match(e.message, /already registered/));
    const src = await note(ann, "d", "decision text");
    await refuses("invalid_command", () => enf.compact(owner, { ...compactCmd(t, "k1", [src]), compressorId: "hermes-compressor" }, [writes("a", "s")]), (e) => assert.match(e.message, /not the registered compressor/));
    await refuses("invalid_command", () => enf.compact(owner, compactCmd(t2, "k1", [src]), [writes("a", "s")]), (e) => assert.match(e.message, /no compressor is registered/));
    // Two at once: exactly one wins.
    const results = await Promise.allSettled([enf.registerCompressor(owner, { taskId: t2, compressorId: "one" }), enf.registerCompressor(owner, { taskId: t2, compressorId: "two" })]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  });

  suite("a hung summariser hits its own timeout and the fallback route is used; with every route hung the fallback summary is used; with no fallback the attempt ends as context_overflow, without hanging", async ({ enf, owner, note, ann, setup, t, blockers }) => {
    await setup();
    const src = await note(ann, "d", "x");
    const t0 = Date.now();
    const viaCloud = summary(await enf.compact(owner, compactCmd(t, "k1", [src]), [hangs, writes("cloud", "A short summary of the database discussion.")]));
    assert.deepEqual([viaCloud.route, viaCloud.degraded, viaCloud.attempts.map((x) => x.outcome)], ["cloud", true, ["timeout", "ok"]]);
    const viaFallback = summary(await enf.compact(owner, compactCmd(t, "k2", [src], { parent: viaCloud.id }), [hangs]));
    assert.deepEqual([viaFallback.route, viaFallback.degraded], ["controller-extractive", true]);
    assert.match(viaFallback.summary, /made without a model/);
    const failed = await enf.compact(owner, compactCmd(t, "k3", [src], { parent: viaFallback.id }), [hangs], { extractive: false });
    assert.equal(failed.kind, "overflow");
    assert.match((failed as { reason: string }).reason, /context_overflow/);
    assert.equal((failed as { overflow: { action: string } }).overflow.action, "restart-fresh", "one overflow: restart fresh, not blocked yet");
    assert.ok(Date.now() - t0 < 3000, "each hang cost only its own short timeout");
    // The failure is recorded: asking again answers from the record without calling anything.
    const calls = { n: 0 };
    const repeat = await enf.compact(owner, compactCmd(t, "k3", [src], { parent: viaFallback.id }), [writes("never", "x", calls)]);
    assert.deepEqual([repeat.kind, (repeat as { replayed: boolean }).replayed, calls.n], ["overflow", true, 0]);
    void blockers;
  }, { summary: { timeoutMs: 40 } });

  suite("a restart in the middle of the hook neither duplicates nor loses the summary", async ({ enf, reopen, retrieval, owner, note, ann, setup, t }) => {
    await setup();
    const src = await note(ann, "d", "x");
    // 1. The process dies after the summary was recorded and before it was published as a retrieval summary.
    let dies = true;
    const flaky = new Proxy(retrieval, { get: (target, key) => {
      const value = (target as never)[key] as unknown;
      if (key !== "summarize") return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      return async (...args: unknown[]) => { if (dies) { dies = false; throw new Error("process died"); } return (target.summarize as (...a: unknown[]) => unknown)(...args); };
    } });
    const first = { n: 0 };
    await assert.rejects(() => reopen(flaky).compact(owner, compactCmd(t, "k1", [src]), [writes("local", "The one summary.", first)]), /process died/);
    assert.equal(first.n, 1);
    // 2. The restarted service is asked again, and has a different summariser: the recorded summary is used, the summariser is not called, one retrieval summary exists.
    const second = { n: 0 };
    const done = summary(await enf.compact(owner, compactCmd(t, "k1", [src]), [writes("other", "A different summary.", second)]));
    assert.equal(done.summary.startsWith("The one summary."), true, done.summary);
    assert.deepEqual([second.n, done.route], [0, "local"]);
    const again = summary(await enf.compact(owner, compactCmd(t, "k1", [src]), [writes("other", "Yet another.", second)]));
    assert.deepEqual([again.summaryId, again.replayed, again.id], [done.summaryId, true, done.id]);
    assert.equal((await retrieval.resolve(owner, done.summaryId))!.text, done.summary);
    // 3. Two runs of one key at the same time: one summary wins, both answer with it, the chain advanced once.
    const both = await Promise.all([enf.compact(owner, compactCmd(t, "k2", [src], { parent: done.id }), [writes("a", "Summary from A.")]), reopen().compact(owner, compactCmd(t, "k2", [src], { parent: done.id }), [writes("b", "Summary from B.")])]);
    const [x, y] = both.map(summary);
    assert.equal(x!.summary, y!.summary);
    assert.equal(x!.summaryId, y!.summaryId);
    assert.equal((await enf.latestCompaction(owner, t))!.generation, 2);
  });

  suite("summary lineage is recorded and the owner's decisions stay retrievable after repeated compactions and a change of model; a compaction continues the latest one", async ({ enf, owner, note, ann, setup, t }) => {
    await setup();
    const src = await note(ann, "log", "work log");
    const decision = await note(ann, "decision", "The owner decided: use PostgreSQL, never SQLite, for the controller. Do not revisit.");
    const c1 = summary(await enf.compact(owner, compactCmd(t, "k1", [src], { pinned: [decision] }), [writes("local-8k", "Early work: schema drafted.")]));
    assert.match(c1.summary, /Owner decisions kept[\s\S]*use PostgreSQL, never SQLite/);
    // The model falls back to another route between compactions; the next summariser is different and writes nothing about the decision.
    const c2 = summary(await enf.compact(owner, compactCmd(t, "k2", [src], { parent: c1.id }), [writes("cloud", "Middle work: tests added.")]));
    const c3 = summary(await enf.compact(owner, compactCmd(t, "k3", [src], { parent: c2.id }), [hangs, writes("cloud-2", "Late work: review done.")]));
    assert.deepEqual([c1.generation, c2.generation, c3.generation], [1, 2, 3]);
    assert.deepEqual(c3.lineage, [c1.id, c2.id]);
    assert.match(c3.summary, /use PostgreSQL, never SQLite/, "carried into every later summary");
    const rec = (await enf.getCompaction(owner, c3.id))!;
    assert.deepEqual([rec.parent, rec.route, rec.generation, "summary" in rec], [c2.id, "cloud-2", 3, false]);
    assert.deepEqual((await enf.getCompaction(owner, c1.id))!.route, "local-8k");
    const kept = await enf.keptDecisions(owner, t);
    assert.deepEqual(kept.map((k) => [k.state, k.text!.slice(0, 22)]), [["available", "The owner decided: use"]]);
    // The chain is a line: continuing an older compaction, or starting a second root, is refused.
    await refuses("invalid_command", () => enf.compact(owner, compactCmd(t, "k4", [src], { parent: c1.id }), [writes("x", "y")]), (e) => assert.match(e.message, /latest compaction/));
    await refuses("invalid_command", () => enf.compact(owner, compactCmd(t, "k5", [src]), [writes("x", "y")]), (e) => assert.match(e.message, /latest compaction/));
    // Two different compactions of the same context started together: one of them is refused.
    const c4 = { ...compactCmd(t, "k6", [src], { parent: c3.id }) }, c5 = { ...compactCmd(t, "k7", [src], { parent: c3.id }) };
    const race = await Promise.allSettled([enf.compact(owner, c4, [writes("a", "Two A.")]), enf.compact(owner, c5, [writes("b", "Two B.")])]);
    const won = race.filter((r) => r.status === "fulfilled" && r.value.kind === "summary");
    assert.equal(won.length, 1, "exactly one of two compactions of the same context wins");
    const other = race.find((r) => !won.includes(r))!;
    if (other.status === "fulfilled") {
      // Both began before either finished: the loser is closed as superseded, not left started.
      assert.equal(other.value.kind, "superseded");
      assert.equal((await enf.getCompaction(owner, other.value.id))!.state, "failed");
      assert.equal((await enf.getCompaction(owner, other.value.id))!.superseded, true);
    } else {
      // The winner had already finished when the other began: it is refused at the start.
      assert.ok(other.reason instanceof DomainError && other.reason.code === "invalid_command" && /latest compaction/.test(other.reason.message), String(other.reason));
    }
    // The decision cap: too many to keep is refused rather than silently dropped.
    const many: SourceRef[] = []; for (let i = 0; i < 13; i++) many.push(await note(ann, `d${i}`, `decision ${i}`));
    const latest = (await enf.latestCompaction(owner, t))!.id;
    await refuses("invalid_command", () => enf.compact(owner, compactCmd(t, "k8", [src], { pinned: many, parent: latest }), [writes("x", "y")]));
  }, { summary: { timeoutMs: 40 } });

  suite("a compaction that loses the race for the chain is closed as superseded, not left started, and is not an overflow", async ({ enf, owner, note, ann, setup, t }) => {
    await setup();
    const src = await note(ann, "d", "x");
    const gates: (() => void)[] = [];
    const gated = (route: string, out: string): Summariser => ({ route, summarise: () => new Promise<string>((resolve) => { gates.push(() => resolve(out)); }) });
    const a = enf.compact(owner, compactCmd(t, "ka", [src]), [gated("a", "Summary A.")]);
    const b = enf.compact(owner, { ...compactCmd(t, "kb", [src]), attemptId: "att-2" }, [gated("b", "Summary B.")]);
    while (gates.length < 2) await new Promise((r) => setTimeout(r, 5));
    gates[0]!(); const first = await a;
    gates[1]!(); const second = await b;
    assert.deepEqual([first.kind, second.kind], ["summary", "superseded"]);
    const rec = (await enf.getCompaction(owner, second.id))!;
    assert.deepEqual([rec.state, rec.superseded], ["failed", true]);
    assert.match((second as { reason: string }).reason, /another compaction of this task finished first/);
    assert.equal((await enf.reportOverflow(owner, { taskId: t, attemptId: "att-9", failure: "context length exceeded" })).count, 1, "being superseded did not count as an overflow");
    // Asking again for the lost key answers from the record.
    assert.equal((await enf.compact(owner, { ...compactCmd(t, "kb", [src]), attemptId: "att-2" }, [writes("z", "zz")])).kind, "superseded");
  }, { summary: { timeoutMs: 5000 } });

  suite("a compressed view keeps its sources and is readable only by someone who can read every one of them", async ({ enf, owner, note, ann, ben, eve, setup, t, a, retrieval }) => {
    await setup();
    const open = await note(ann, "open", "shared notes");
    const secret = await note(ann, "scratch", "ann's private scratch", "private");
    const c = summary(await enf.compact(owner, compactCmd(t, "k1", [open, secret]), [writes("local", "Notes and scratch were summarised.")]));
    const rec = (await enf.getCompaction(owner, c.id))!;
    assert.equal(rec.projectId, a, "the compaction keeps the source project");
    assert.deepEqual(rec.sources, [open, secret], "and the origins");
    const full = (await enf.readSummary(owner, c.id))!;
    assert.equal(full.withheld, false);
    assert.deepEqual(full.sources.map((x) => x.source), [open, secret], "the published summary lists the same origins");
    for (const src of [open, secret]) assert.equal((await retrieval.fetch(owner, src))!.projectId, a, "each origin is in the project");
    assert.match(full.text!, /Notes and scratch were summarised/);
    const forBen = (await enf.readSummary(ben, c.id))!;
    assert.deepEqual([forBen.withheld, forBen.text], [true, undefined], "ben can read one source but not the other: the text is withheld");
    assert.deepEqual(forBen.sources.map((s) => s.state), ["current", "unavailable"]);
    // A reader outside the task and project reads it like nothing.
    assert.equal(await enf.getCompaction(eve, c.id), undefined);
    assert.equal(await enf.readSummary(eve, c.id), undefined);
    // Sources the writer cannot read, or from another project, cannot be summarised.
    await refuses("invalid_command", () => enf.compact(owner, compactCmd(t, "k2", [{ kind: "desk-record", id: "dsk-aaaaaaaaaaaaaaaaaaaa" }], { parent: c.id }), [writes("x", "y")]));
  });

  suite("repeated overflow stops with a visible blocker; only context failures count; an owner resolution or a good attempt starts the count again", async ({ enf, owner, blockers, t }) => {
    const none = await enf.reportOverflow(owner, { taskId: t, attemptId: "att-0", failure: "rate limit: too many requests per minute, context window 131072" });
    assert.deepEqual([none.action, none.count], ["none", 0], "a rate-limit lookalike is not an overflow");
    const one = await enf.reportOverflow(owner, { taskId: t, attemptId: "att-1", failure: "Context compression timed out without reducing this conversation" });
    assert.deepEqual([one.action, one.count], ["restart-fresh", 1]);
    assert.equal((await enf.reportOverflow(owner, { taskId: t, attemptId: "att-1", failure: "Context compression timed out without reducing this conversation" })).count, 1, "the same attempt counts once");
    assert.equal(await blockers.openFor("context_overflow", { kind: "task", id: t }), undefined);
    const two = await enf.reportOverflow(owner, { taskId: t, attemptId: "att-2", failure: "prompt is too long: 140000 tokens > 131072" });
    assert.deepEqual([two.action, two.count], ["blocked", 2]);
    const open = (await blockers.openFor("context_overflow", { kind: "task", id: t }))!;
    assert.equal(open.id, two.blockerId);
    assert.match(open.summary, /overflowed 2 times in a row/);
    // The owner resolves it and resets: the count starts again and a new overflow opens a new blocker only at the limit.
    await blockers.resolveBlocker({ commandId: cid("rb"), actor: owner.id, blockerId: open.id, expectedRevision: open.revision, resolution: "switched to the 1M-token route" });
    await enf.resetOverflow(owner, { taskId: t, attemptId: "att-3" });
    assert.equal((await enf.reportOverflow(owner, { taskId: t, attemptId: "att-4", failure: "context length exceeded" })).action, "restart-fresh");
    const again = await enf.reportOverflow(owner, { taskId: t, attemptId: "att-5", failure: "context length exceeded" });
    assert.equal(again.action, "blocked");
    assert.notEqual(again.blockerId, open.id, "a second blocker for the second run of failures");
    await enf.resetOverflow(owner, { taskId: t, attemptId: "att-3" });
  });

  suite("tool output over the window's limit is cut, the remainder kept and paged, for Pi's tools and MCP tools alike; images count; unreadable reads like missing", async ({ enf, owner, ann, eve, t }) => {
    const budget = enf.budget(WINDOW);
    const big = "line of output\n".repeat(5000);
    const r = await enf.limitTool(owner, { taskId: t, callId: "call-1", tool: "bash", window: WINDOW, output: { text: big, keep: "tail" } });
    assert.ok(r.truncated && r.text.length < budget.toolOutputChars + 300, `${r.text.length}`);
    assert.ok(r.spillId && r.remainderChars > 0);
    assert.match(r.text, /read it in pages/);
    // The kept remainder pages back to the whole (tail kept: the remainder is the front).
    let rebuilt = ""; let index = 0;
    for (;;) { const p = (await enf.readSpill(ann, r.spillId!, index, 10_000))!; rebuilt += p.text; if (p.next === undefined) break; index = p.next; }
    assert.equal(rebuilt.length, r.remainderChars);
    assert.ok(big.startsWith(rebuilt));
    assert.equal(await enf.readSpill(eve, r.spillId!, 0), undefined, "a reader without rights on the task sees nothing");
    assert.equal(await enf.readSpill(ann, "spl-aaaaaaaaaaaaaaaaaaaa", 0), undefined);
    // An MCP tool's result goes through the same gate; repeating the call gives the same spill.
    const m = await enf.limitTool(owner, { taskId: t, callId: "call-2", tool: "mcp__files__read", window: WINDOW, output: { text: "w".repeat(40_000) } });
    assert.equal(m.truncated, true);
    assert.equal((await enf.limitTool(owner, { taskId: t, callId: "call-2", tool: "mcp__files__read", window: WINDOW, output: { text: "w".repeat(40_000) } })).spillId, m.spillId);
    // Small results pass untouched; images are counted and dropped with a note when they do not fit.
    const small = await enf.limitTool(owner, { taskId: t, callId: "call-3", tool: "read", window: WINDOW, output: { text: "tiny" } });
    assert.deepEqual([small.text, small.truncated, small.spillId], ["tiny", false, undefined]);
    const imgs = await enf.limitTool(owner, { taskId: t, callId: "call-4", tool: "screenshot", window: WINDOW, output: { text: "see images", nonText: Array.from({ length: 5 }, () => ({ kind: "image", bytes: 900_000 })) } });
    assert.ok(imgs.nonTextDropped >= 1 && /left out/.test(imgs.text), imgs.text);
    // Credentials are removed before the remainder is cut to the kept bound, so none can be left half-cut at the edge.
    const seeded = await enf.limitTool(owner, { taskId: t, callId: "call-6", tool: "bash", window: WINDOW, output: { text: "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 ".repeat(30000) } });
    let kept = ""; let at = 0;
    for (;;) { const p = (await enf.readSpill(owner, seeded.spillId!, at, 50_000))!; kept += p.text; if (p.next === undefined) break; at = p.next; }
    assert.ok(seeded.lostChars > 0 && kept.length === 256_000);
    assert.ok(!/ghp_|token=/.test(kept), "no credential, whole or cut, in the kept remainder");
    // A remainder past the kept bound says what could not be kept.
    const huge = await enf.limitTool(owner, { taskId: t, callId: "call-5", tool: "bash", window: WINDOW, output: { text: "h".repeat(400_000) } });
    assert.ok(huge.lostChars > 0 && /could not be kept/.test(huge.text));
  });

  suite("a crash after a confirmed effect and before the hand-off still yields a hand-off written from the ledger and artifacts, with credentials removed, once", async ({ enf, owner, ann, effects, t, t2 }) => {
    const intended = await effects.intend({ commandId: cid("ef"), actor: owner.id, kind: "git-merge", target: "origin/main", input: { branch: "wip/x", note: "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789" }, taskId: t });
    const merge = await effects.perform({ commandId: cid("ef2"), actor: owner.id, kind: "git-merge", target: "origin/main", input: { branch: "wip/y" }, taskId: t }, { idempotent: true, execute: async () => ({ merged: true }) });
    assert.equal(merge.status, "confirmed");
    const facts = async (): Promise<HandoffFacts> => {
      const lines = [];
      for (const id of [intended.id, merge.effectId]) { const e = (await effects.get(id))!; lines.push({ id, state: e.status, summary: `${e.kind} ${e.target} ${JSON.stringify(e.input)}` }); }
      return { task: "Merge the branch and report", endedBecause: "", effects: lines, artifacts: [{ id: "art-1", title: "merge report" }], checkpoint: { at: 12, digest: "sha256:abc" }, lastKnownState: "merge confirmed, hand-off not written", nextStep: "tell the owner it is merged" };
    };
    const h = await enf.ensureHandoff(owner, { taskId: t, attemptId: "att-1", endedBecause: "the attempt died after the merge" }, facts);
    assert.equal(h.source, "controller");
    assert.match(h.text, /git-merge origin\/main/);
    assert.match(h.text, /\[confirmed\]/);
    assert.match(h.text, /art-1 merge report/);
    assert.match(h.text, /the attempt died after the merge/);
    assert.ok(!h.text.includes("ghp_abcdefgh"), "credentials are removed");
    // Again (a restart, or the dispatcher retrying): the same hand-off, and the facts are not asked for again.
    let asked = 0;
    const again = await enf.ensureHandoff(owner, { taskId: t, attemptId: "att-1", endedBecause: "later" }, async () => { asked++; return facts(); });
    assert.deepEqual([again.id, again.text, asked], [h.id, h.text, 0]);
    assert.equal((await enf.latestHandoff(owner, t))!.id, h.id);
    // The attempt's own hand-off, when it exists, is the one returned; and one that arrives after the controller's is kept beside it and becomes the latest.
    await enf.recordHandoff(ann, { taskId: t2, attemptId: "att-1", text: "Merged wip/x. Next: tag the release. token=ghp_abcdefghijklmnopqrstuvwxyz0123456789" });
    const own = await enf.ensureHandoff(owner, { taskId: t2, attemptId: "att-1", endedBecause: "ended" }, facts);
    assert.equal(own.source, "attempt");
    assert.match(own.text, /tag the release/);
    assert.ok(!own.text.includes("ghp_abcdefgh"));
    const late = await enf.recordHandoff(ann, { taskId: t, attemptId: "att-1", text: "late own hand-off" });
    assert.equal(late.controllerKept, true);
    const latest = (await enf.latestHandoff(owner, t))!;
    assert.deepEqual([latest.source, latest.text], ["attempt", "late own hand-off"], "the attempt's own is preferred as the head");
    const both = await enf.handoffsOf(owner, t, "att-1");
    assert.deepEqual([both.attempt, both.controller], ["late own hand-off", h.text], "and the controller's stays readable");
    // The controller's hand-off for the same attempt written after the attempt's own does not take the head back.
    await enf.recordHandoff(ann, { taskId: t2, attemptId: "att-2", text: "own first" });
    await enf.ensureHandoff(owner, { taskId: t2, attemptId: "att-2", endedBecause: "ended" }, facts);
    assert.equal((await enf.latestHandoff(owner, t2))!.text, "own first");
  });

  suite("the dispatcher's methods are for the owner, hosts and services, never an agent; reading and the attempt's own hand-off stay open to whoever may work on the task", async ({ enf, owner, host, ann, ben, eve, t, setup, note }) => {
    const call = { systemPromptChars: 100, toolSchemaChars: 100, startupTokens: 100, replyReserveTokens: 100 };
    const src = await note(ann, "d", "x");
    await setup();
    const gated: [string, (p: Principal) => Promise<unknown>][] = [
      ["admit", (p) => enf.admit(p, { taskId: t, attemptId: "x", window: WINDOW, call })],
      ["confirmUsage", (p) => enf.confirmUsage(p, { taskId: t, attemptId: "x", reportedInputTokens: 10, promptChars: 30 })],
      ["changeRoute", (p) => enf.changeRoute(p, { taskId: t, attemptId: "x", window: 32_768, fixedTokens: 100, items: [] })],
      ["registerCompressor", (p) => enf.registerCompressor(p, { taskId: t, compressorId: "pi-before-compact" })],
      ["compact", (p) => enf.compact(p, compactCmd(t, "k1", [src]), [writes("a", "s")])],
      ["reportOverflow", (p) => enf.reportOverflow(p, { taskId: t, attemptId: "x", failure: "context length exceeded" })],
      ["resetOverflow", (p) => enf.resetOverflow(p, { taskId: t, attemptId: "x" })],
      ["limitTool", (p) => enf.limitTool(p, { taskId: t, callId: "c", tool: "bash", window: WINDOW, output: { text: "x" } })],
      ["ensureHandoff", (p) => enf.ensureHandoff(p, { taskId: t, attemptId: "x", endedBecause: "e" }, async () => { throw new Error("must not be asked"); })],
    ];
    // An agent is refused by every one of them, even with attempt.work and desk grants on the task's project (ann and ben) and with none (eve).
    for (const who of [ann, ben, eve]) for (const [name, run] of gated) await refuses("forbidden", () => run(who), (e) => assert.match(e.message, /not the dispatcher/, name));
    // A host and the owner may.
    assert.equal((await enf.admit(host, { taskId: t, attemptId: "x", window: WINDOW, call })).admit, true);
    assert.equal((await enf.admit(owner, { taskId: t, attemptId: "y", window: WINDOW, call })).admit, true);
    assert.equal((await enf.limitTool(host, { taskId: t, callId: "c", tool: "bash", window: WINDOW, output: { text: "x" } })).truncated, false);
    // Reads and the attempt's own hand-off are open to whoever may work on the task, and read like nothing to anyone else.
    assert.equal((await enf.recordHandoff(ben, { taskId: t, attemptId: "x", text: "own" })).controllerKept, false);
    assert.equal((await enf.latestHandoff(ann, t))!.text, "own");
    assert.equal(await enf.latestHandoff(eve, t), undefined);
    assert.equal(await enf.latestCompaction(ben, t), undefined);
    assert.deepEqual(await enf.keptDecisions(ben, t), []);
    await refuses("forbidden", () => enf.recordHandoff(eve, { taskId: t, attemptId: "x", text: "no" }));
    await refuses("invalid_command", () => enf.admit(owner, { taskId: t, attemptId: "bad id", window: WINDOW, call }));
    await refuses("invalid_command", () => enf.admit(owner, { taskId: t, attemptId: "z", window: WINDOW, call, extra: 1 } as never));
    await refuses("invalid_command", () => enf.admit(owner, { taskId: t, attemptId: "z", window: WINDOW, call: { ...call, startupTokens: -1 } }));
    await refuses("not_found", () => enf.admit(owner, { taskId: "task-aaaaaaaaaaaaaaaaaaaa", attemptId: "z", window: WINDOW, call }));
  });

  suite("a failed compaction counts under the attempt that ran it, once; a long key still counts; an extractive result is not an overflow", async ({ enf, owner, note, ann, setup, t, blockers }) => {
    await setup();
    const src = await note(ann, "d", "x");
    // The compaction fails, then the same attempt's generation fails with the provider's own message: one attempt, one count.
    const failed = await enf.compact(owner, compactCmd(t, "k1", [src]), [hangs], { extractive: false });
    assert.deepEqual([failed.kind, (failed as { overflow: { action: string; count: number } }).overflow.action, (failed as { overflow: { count: number } }).overflow.count], ["overflow", "restart-fresh", 1]);
    const same = await enf.reportOverflow(owner, { taskId: t, attemptId: "att-1", failure: "prompt is too long: 140000 tokens > 131072" });
    assert.deepEqual([same.action, same.count], ["restart-fresh", 1], "the same attempt counts once");
    assert.equal(await blockers.openFor("context_overflow", { kind: "task", id: t }), undefined);
    // A second attempt reaches the limit.
    const second = await enf.compact(owner, { ...compactCmd(t, "k2", [src]), attemptId: "att-2" }, [hangs], { extractive: false });
    assert.equal((second as { overflow: { action: string } }).overflow.action, "blocked");
    assert.ok(await blockers.openFor("context_overflow", { kind: "task", id: t }));
  }, { summary: { timeoutMs: 30 } });

  suite("a compaction key of the longest length that fails is still counted", async ({ enf, owner, note, ann, setup, t }) => {
    await setup();
    const src = await note(ann, "d", "x");
    const long = "k".repeat(80);
    const failed = await enf.compact(owner, { ...compactCmd(t, long, [src]), attemptId: "a".repeat(80) }, [hangs], { extractive: false });
    assert.equal((failed as { overflow: { count: number } }).overflow.count, 1, "an 80-character key and attempt ID are counted");
    await refuses("invalid_command", () => enf.compact(owner, compactCmd(t, "k".repeat(81), [src]), [hangs]));
  }, { summary: { timeoutMs: 30 } });

  suite("when the caller gives up, the summarisers are told to stop and nothing is recorded as done or published; the key resumes later", async ({ enf, owner, note, ann, setup, t, retrieval }) => {
    await setup();
    const src = await note(ann, "d", "x");
    const stop = new AbortController();
    let told = false;
    const slow: Summariser = { route: "slow", summarise: ({ signal }) => new Promise<string>((_, reject) => { signal.addEventListener("abort", () => { told = true; reject(new Error("stopped")); }); }) };
    setTimeout(() => stop.abort(), 40);
    const r = await enf.compact(owner, compactCmd(t, "k1", [src]), [slow], { signal: stop.signal });
    assert.equal(r.kind, "aborted");
    assert.equal(told, true, "the summariser saw the abort");
    const rec = (await enf.getCompaction(owner, r.id))!;
    assert.deepEqual([rec.state, rec.summaryId, await enf.latestCompaction(owner, t)], ["started", undefined, undefined], "no summary exists that the conversation does not have");
    assert.equal(await retrieval.resolve(owner, "sum-aaaaaaaaaaaaaaaaaaaa"), undefined);
    // A summariser that finishes just after the abort is not recorded either.
    const late = new AbortController();
    const finishesAfter: Summariser = { route: "late", summarise: async () => { late.abort(); return "A summary that arrives after the caller left."; } };
    assert.equal((await enf.compact(owner, compactCmd(t, "k1", [src]), [finishesAfter], { signal: late.signal })).kind, "aborted");
    assert.equal((await enf.getCompaction(owner, r.id))!.state, "started");
    // The same key later (a retry) completes normally.
    assert.equal(summary(await enf.compact(owner, compactCmd(t, "k1", [src]), [writes("again", "A summary at last.")])).route, "again");
  }, { summary: { timeoutMs: 5000 } });

  suite("an estimate that a confirmed call showed to be too low is scaled for later rounds on the route; a task with an open overflow blocker admits nothing", async ({ enf, owner, blockers, t, t2 }) => {
    const call = { systemPromptChars: 9_000, toolSchemaChars: 9_000, startupTokens: 2_000, replyReserveTokens: 8_000 };
    const first = await enf.admit(owner, { taskId: t, attemptId: "att-1", window: WINDOW, call });
    assert.equal(first.admit, true);
    const c = await enf.confirmUsage(owner, { taskId: t, attemptId: "att-1", reportedInputTokens: 40_000, promptChars: 80_000 });
    assert.deepEqual([c.overStartupLimit, c.ratio], [true, 5]);
    // The same attempt asks again with the same prompt: refused, because the estimate is five times too low on this route.
    const again = await enf.admit(owner, { taskId: t, attemptId: "att-1", round: 2, window: WINDOW, call });
    assert.equal(again.admit, false);
    assert.match(again.reasons.join(" "), /scaled by 5/);
    assert.ok(again.blockerId);
    // Another task, or another route on the same task, is unaffected.
    assert.equal((await enf.admit(owner, { taskId: t2, attemptId: "att-1", window: WINDOW, call })).admit, true);
    assert.equal((await enf.admit(owner, { taskId: t, attemptId: "att-2", round: 1, window: WINDOW, route: "other-route", call })).admit, false, "refused here only because the blocker above is open");
    const open = (await blockers.openFor("context_overflow", { kind: "task", id: t }))!;
    await blockers.resolveBlocker({ commandId: cid("rb"), actor: owner.id, blockerId: open.id, expectedRevision: open.revision, resolution: "fixed" });
    assert.equal((await enf.admit(owner, { taskId: t, attemptId: "att-3", window: WINDOW, route: "other-route", call })).admit, true, "after the blocker is resolved, another route admits");
    // With a provider-reported size given for the very call, the estimate is not scaled again.
    assert.equal((await enf.admit(owner, { taskId: t, attemptId: "att-4", window: WINDOW, call: { ...call, reportedInputTokens: 10_000 } })).admit, true, "a size the provider reported for this very call is used as it is, not scaled");
  });

  test(`${backend.name}: shares and characters per token are configurable and validated at construction`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const blockers = BlockerService.withEpoch(world.storage, projects.epoch, options);
      const desks = DeskService.withEpoch(world.storage, projects.epoch, options);
      const histories = HistoryService.withEpoch(world.storage, projects.epoch, options);
      const retrieval = RetrievalService.withEpoch(world.storage, projects.epoch, desks, histories, options);
      const make = (o: object) => ContextEnforcementService.withEpoch(world.storage, projects.epoch, { blockers, retrieval }, { ...options, ...o });
      assert.equal(make({ budget: { startupShare: 0.1 } }).budget(100_000).startupTokens, 10_000);
      assert.equal(make({ budget: { charsPerToken: 2 } }).budget(100_000).toolOutputChars, 8_000);
      assert.throws(() => make({ budget: { startupShare: 0.9 } }), RangeError);
      assert.throws(() => make({ budget: { charsPerToken: 0 } }), RangeError);
      assert.throws(() => make({ maxOverflows: 0 }), RangeError);
    } finally { await world.close(); }
  });
}
