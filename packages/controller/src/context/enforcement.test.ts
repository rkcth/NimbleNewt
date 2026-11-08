import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { BlockerService, DomainError, EffectService, ProjectService, type DomainErrorCode } from "../domain/index.js";
import { derivedId } from "../domain/ids.js";
import { CommandRunner } from "../domain/runner.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import { ContextEnforcementService, contextRouteKey, DeskService, HistoryService, RetrievalService, contextBudget, tokensOf, type CompactionOutcome, type HandoffFacts, type SourceRef, type StartupItem, type Summariser } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-22T10:00:00.000Z", pause: async () => undefined };
const told: unknown[] = [];
const clockBox = { at: "2026-10-22T10:00:00.000Z" };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};
const encodeRoute = (route: string): string => route.replace(/[^A-Za-z0-9._:-]/g, (c) => `~${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
const hangs: Summariser = { route: "local", summarise: () => new Promise<string>(() => undefined) };
const writes = (route: string, out: string, calls?: { n: number }): Summariser => ({ route, summarise: async () => { if (calls) calls.n++; return out; } });
const WINDOW = 131_072;
const MATERIAL = "The agents discussed the database at length. ".repeat(200);
const summary = (r: CompactionOutcome): Extract<CompactionOutcome, { kind: "summary" }> => { assert.equal(r.kind, "summary", JSON.stringify(r)); return r as never; };

for (const backend of backends) {
  interface Ctx {
    owner: Principal; host: Principal; ann: Principal; ben: Principal; eve: Principal; a: string; t: string; t2: string;
    enf: ContextEnforcementService; reopen(retrieval?: RetrievalService): ContextEnforcementService; withBlockers(b: BlockerService): ContextEnforcementService; retrieval: RetrievalService; blockers: BlockerService; effects: EffectService;
    note(by: Principal, title: string, body: string, visibility?: "shared" | "private"): Promise<SourceRef>;
    setup(task?: string): Promise<void>;
    /** Writes a record the way an earlier release did (for the migration tests). */
    plant(kind: string, id: string, body: Record<string, unknown>): Promise<void>;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>, enforcement: { maxOverflows?: number; summary?: { timeoutMs: number }; routeSettings?: { effective(): Promise<{ check: boolean; floorChars: number }> }; onError?: (error: unknown) => void; clock?: () => string } = {}) =>
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
        const make = (r: RetrievalService = retrieval, bl: BlockerService = blockers) => ContextEnforcementService.withEpoch(world.storage, projects.epoch, { blockers: bl, retrieval: r }, { ...options, ...enforcement });
        const rights = (p: string): Grant[] => [{ action: "desk.write", project: p }, { action: "desk.read", project: p }, { action: "attempt.work", project: p }];
        const ann = await agent("ann", rights(a));
        const ben = await agent("ben", [{ action: "desk.read", project: a }, { action: "attempt.work", project: a }]);
        const eve = await agent("eve", rights(b));
        await principals.enroll(owner, { commandId: cid("e"), kind: "host", name: "h1", grants: [{ action: "desk.read", project: a }, { action: "desk.write", project: a }] });
        const host = await principals.authenticate((await principals.issueCredential(owner, "host:h1")).token);
        const note = async (by: Principal, title: string, text: string, visibility: "shared" | "private" = "shared"): Promise<SourceRef> => ({ kind: "desk-record", id: (await desks.write(by, { commandId: cid("w"), projectId: a, kind: "note", title, body: text, visibility, status: "accepted" })).id });
        const enf = make();
        const setup = async (task = t): Promise<void> => { await enf.registerCompressor(owner, { taskId: task, compressorId: "pi-before-compact" }); };
        const plant = async (kind: string, id: string, rec: Record<string, unknown>): Promise<void> => {
          const ref = { kind, id };
          await new CommandRunner(world.storage, projects.epoch, options).command("test.plant", { commandId: cid("plant"), actor: "owner:rob" }, async () => ({ payload: {}, build: async () => ({ ref, creates: true, changes: [{ type: "create" as const, ref, body: rec as never }], detail: {} }) }));
        };
        await body({ owner, host, ann, ben, eve, a, t, t2, enf, reopen: (r) => make(r), withBlockers: (b) => make(retrieval, b), retrieval, blockers, effects, note, setup, plant });
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

  suite("an attempt resumed after a restart is judged afresh: a new start of the worker does not replay the answer given when the conversation was small (review fix, cards H12b, H12f)", async ({ enf, owner, blockers, t }) => {
    const call = { systemPromptChars: 9_000, toolSchemaChars: 15_000, startupTokens: 2_000, replyReserveTokens: 8_000 };
    const small = await enf.admit(owner, { taskId: t, attemptId: "att-1", round: 1, launch: "start-a", window: WINDOW, call });
    assert.equal(small.admit, true);
    // The same start asking again is a repeat: it gets the recorded answer.
    assert.equal((await enf.admit(owner, { taskId: t, attemptId: "att-1", round: 1, launch: "start-a", window: WINDOW, call })).replayed, true);
    // The conversation has grown past the limit; the attempt (same ID) is started again. Without the start in the key the old 'admit' would come back and the whole conversation would be sent.
    const grown = await enf.admit(owner, { taskId: t, attemptId: "att-1", round: 1, launch: "start-b", window: WINDOW, call: { ...call, startupTokens: 120_000 } });
    assert.equal(grown.admit, false, JSON.stringify(grown));
    assert.equal(grown.replayed, false);
    assert.notEqual(grown.id, small.id);
    assert.equal((await blockers.list({ limit: 20, openOnly: true })).items.filter((b) => b.type === "context_overflow").length, 1, "and the refusal opened the blocker");
    // While the blocker is open nothing is admitted for a further start either (the open-blocker check is not skipped because an older record exists).
    const later = await enf.admit(owner, { taskId: t, attemptId: "att-1", round: 1, launch: "start-c", window: WINDOW, call });
    assert.equal(later.admit, false);
    await refuses("invalid_command", () => enf.admit(owner, { taskId: t, attemptId: "att-1", launch: "bad launch!", window: WINDOW, call }));
  });

  suite("a refusal the caller will retry after making the call smaller opens no blocker; the refusal of the retry does (card H12f)", async ({ enf, owner, blockers, t }) => {
    const call = { systemPromptChars: 9_000, toolSchemaChars: 100_000, startupTokens: 2_000, replyReserveTokens: 8_000 };
    const first = await enf.admit(owner, { taskId: t, attemptId: "att-1", round: 1, window: WINDOW, call, retry: true });
    assert.deepEqual([first.admit, first.blockerId], [false, undefined]);
    assert.equal((await blockers.list({ limit: 20, openOnly: true })).items.filter((b) => b.type === "context_overflow").length, 0, "nothing for the owner yet");
    // The smaller call passes: no blocker was ever opened for the attempt.
    const second = await enf.admit(owner, { taskId: t, attemptId: "att-1", round: 2, window: WINDOW, call: { ...call, toolSchemaChars: 15_000 } });
    assert.equal(second.admit, true);
    // A repeat of the retried refusal is the recorded decision, still with no blocker.
    assert.deepEqual([(await enf.admit(owner, { taskId: t, attemptId: "att-1", round: 1, window: WINDOW, call, retry: true })).replayed, (await enf.admit(owner, { taskId: t, attemptId: "att-1", round: 1, window: WINDOW, call, retry: true })).blockerId], [true, undefined]);
    // When the retry is refused too, that refusal is final and opens the blocker.
    const bad = await enf.admit(owner, { taskId: t, attemptId: "att-2", round: 1, window: WINDOW, call, retry: true });
    const last = await enf.admit(owner, { taskId: t, attemptId: "att-2", round: 2, window: WINDOW, call });
    assert.deepEqual([bad.blockerId, last.admit], [undefined, false]);
    assert.ok(last.blockerId);
    assert.equal((await blockers.getBlocker(last.blockerId))!.type, "context_overflow");
    await refuses("invalid_command", () => enf.admit(owner, { taskId: t, attemptId: "att-3", window: WINDOW, call, retry: "yes" as never }));
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
    // The cut text is archived with the decision, readable by digest, and the route is named in the record.
    const cut = ok.startup.cuts[0]!;
    const kept = await enf.routeArchive(owner, { taskId: t, digest: cut.digest });
    assert.deepEqual([kept?.digest, kept?.text.length], [cut.digest, cut.originalChars]);
    assert.equal(await enf.routeArchive(owner, { taskId: t, digest: "sha256:" + "0".repeat(64) }), undefined);
    assert.equal(await enf.routeArchive(owner, { taskId: t2, digest: cut.digest }), undefined, "archived per task");
    // Many cut items do not overflow the operation limit.
    const many: StartupItem[] = [{ id: "g", kind: "goal", text: "Goal.", at: at(0) }, { id: "h", kind: "human", text: "Do it.", at: at(1) }];
    for (let i = 0; i < 300; i++) many.push({ id: `m${i}`, kind: "report", text: `${i} `.repeat(400), at: at(i + 2) });
    const big = await enf.changeRoute(owner, { taskId: t, attemptId: "att-3", window: 32_768, fixedTokens: 3_000, items: many });
    assert.ok(big.startup.cuts.length > 150);
    assert.equal((await enf.routeArchive(owner, { taskId: t, digest: big.startup.cuts[big.startup.cuts.length - 1]!.digest }))?.itemId, big.startup.cuts[big.startup.cuts.length - 1]!.id);
    const named = await enf.changeRoute(owner, { taskId: t, attemptId: "att-2", window: 32_768, route: "local-small", fixedTokens: 3_000, items });
    assert.equal(named.rebuilt, true);
    const blocked = await enf.changeRoute(owner, { taskId: t2, attemptId: "att-1", window: 8_192, fixedTokens: 2_000, items });
    assert.equal(blocked.rebuilt, false);
    assert.match(blocked.reason!, /essential constraints do not fit the 8192-token route/);
    assert.deepEqual(blocked.startup.pieces, [], "nothing to send");
    assert.equal((await blockers.getBlocker(blocked.blockerId!))!.type, "context_overflow");
    assert.equal((await enf.changeRoute(owner, { taskId: t2, attemptId: "att-1", window: 8_192, fixedTokens: 2_000, items })).replayed, true);
  });

  suite("a task moved to another route is rebuilt with that route's measured fixed part (card C07f), and the cut text can be read back", async ({ enf, owner, blockers, t, t2 }) => {
    const at = (i: number): string => new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString();
    const items: StartupItem[] = [{ id: "g", kind: "goal", text: "Goal: ship v1.", at: at(0) }, { id: "h", kind: "human", text: "Merge the branch.", at: at(1) }];
    for (let i = 0; i < 20; i++) items.push({ id: `r${i}`, kind: "report", text: "x".repeat(1500), at: at(i + 2) });
    // Nothing measured yet for the route: the figure is 0, said so, and the first call on the route is still admitted against its own measure.
    const before = await enf.routeMoved(owner, { taskId: t, attemptId: "att-1", route: "local/small", window: 65_536, items });
    assert.deepEqual([before.measured, before.rebuilt], [false, true]);
    // A first call on the route measures its system prompt and tool schemas (for every task, kept per route).
    await enf.admit(owner, { taskId: t2, attemptId: "att-1", window: 65_536, route: contextRouteKey("local/small"), call: { systemPromptChars: 12_000, toolSchemaChars: 9_000, startupTokens: 500, replyReserveTokens: 1_000 } });
    assert.deepEqual(await enf.fixedPartOf("local/small", 65_536), { systemPromptChars: 12_000, toolSchemaChars: 9_000, tokens: 7_000 });
    assert.equal(await enf.fixedPartOf("other/route", 65_536), undefined);
    const after = await enf.routeMoved(owner, { taskId: t, attemptId: "att-2", route: "local/small", window: 65_536, items });
    assert.equal(after.measured, true);
    assert.ok(after.rebuilt && after.startup.tokens + 7_000 <= contextBudget(65_536).startupTokens, "the view is built around the real fixed part");
    assert.ok(after.startup.tokens < before.startup.tokens, "a larger fixed part leaves less room, so more is cut");
    // The cut text can be read back by digest.
    const cut = after.startup.cuts[0]!;
    assert.equal((await enf.routeArchive(owner, { taskId: t, digest: cut.digest }))?.text.length, cut.originalChars);
    // Repeating gives the recorded decision; a fixed part that changed is a new decision.
    assert.equal((await enf.routeMoved(owner, { taskId: t, attemptId: "att-2", route: "local/small", window: 65_536, items })).replayed, true);
    // The figure is the median of the recent measurements: it moves once most of them are larger.
    for (const [i, chars] of [24_000, 24_000].entries()) await enf.admit(owner, { taskId: t2, attemptId: `att-g${i}`, window: 65_536, route: contextRouteKey("local/small"), call: { systemPromptChars: chars, toolSchemaChars: 9_000, startupTokens: 500, replyReserveTokens: 1_000 } });
    const grown = await enf.routeMoved(owner, { taskId: t, attemptId: "att-2", route: "local/small", window: 65_536, items });
    assert.equal(grown.replayed, false);
    assert.ok(grown.startup.tokens < after.startup.tokens);
    // Essentials that do not fit beside the measured part block the move with a visible reason.
    await enf.admit(owner, { taskId: t2, attemptId: "att-3", window: 131_072, route: contextRouteKey("tiny/one"), call: { systemPromptChars: 15_000, toolSchemaChars: 9_000, startupTokens: 500, replyReserveTokens: 1_000 } });
    const blocked = await enf.routeMoved(owner, { taskId: t, attemptId: "att-3", route: "tiny/one", window: 8_192, items });
    assert.equal(blocked.rebuilt, false);
    assert.match(blocked.reason!, /essential constraints do not fit the 8192-token route/);
    assert.equal((await blockers.getBlocker(blocked.blockerId!))!.type, "context_overflow");
  });

  suite("the rebuilt view is the prompt the worker sends on the new route: kept pieces in order, cut items by a digest that reads their full text, within the startup share; a worker's measurement makes the route measured (card C07g)", async ({ enf, owner, t, t2 }) => {
    const at = (i: number): string => new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString();
    const items: StartupItem[] = [{ id: "g", kind: "goal", text: "Goal: ship v1.", at: at(0) }, { id: "h", kind: "human", text: "Merge the branch.", at: at(1) }];
    for (let i = 0; i < 20; i++) items.push({ id: `q${i}`, kind: "decision", text: `Open question ${i}: ${"which pot size ".repeat(40)}`, at: at(i + 2) });
    const moved = await enf.routeMoved(owner, { taskId: t, attemptId: "att-1", route: "tiny/one", window: 32_768, items });
    assert.equal(moved.rebuilt, true);
    const view = moved.view;
    assert.ok(moved.startup.cuts.length > 0, "the window is small enough that some questions are cut");
    // The view: a header naming the route, every kept piece in its order, then the footer saying how to read what was cut.
    assert.match(view, /^\[The owner's decisions, goals, permissions and open questions for this task, rebuilt for model route tiny\/one \(a 32768-token window\)\.\]/);
    let from = 0;
    for (const p of moved.startup.pieces) { const i = view.indexOf(p.text, from); assert.ok(i >= from, `piece ${p.id} is in the view, in order`); from = i + p.text.length; }
    assert.ok(view.includes("Goal: ship v1.") && view.includes("Merge the branch."), "the goal and the owner's words whole");
    assert.match(view, new RegExp(`${moved.startup.cuts.length} items were cut or left out to fit this route.*context\\.route-archive\\.read`));
    // Every cut item names the full digest of its text, and that digest reads the full text back.
    for (const cut of moved.startup.cuts) {
      assert.ok(view.includes(cut.digest), `the view names the full digest of ${cut.id}`);
      const back = await enf.routeArchive(owner, { taskId: t, digest: cut.digest });
      assert.equal(back?.text, items.find((x) => x.id === cut.id)!.text, `the full text of ${cut.id} is read back by the digest the view names`);
    }
    // The whole view (header and footer too) stays within the startup share beside the route's fixed part (here the floor: the route was not measured, and the floor fits).
    const budget = contextBudget(32_768);
    assert.deepEqual([moved.measured, moved.warning], [false, undefined]);
    assert.ok(tokensOf(view.length, budget) + tokensOf(14_000, budget) <= budget.startupTokens, `the view (${tokensOf(view.length, budget)} tokens) fits beside the floor in ${budget.startupTokens}`);
    // Nothing to show: no view. A refusal: no view.
    assert.equal((await enf.routeMoved(owner, { taskId: t2, attemptId: "att-1", route: "tiny/one", window: 32_768, items: [] })).view, "");
    // A worker that has its process up measures the route; the route is measured from then on, and the view is built on the real figure (more room than the floor, so fewer cuts).
    assert.deepEqual(await enf.measureRoute(owner, { taskId: t, attemptId: "att-1", launch: "l1", route: "tiny/one", systemPromptChars: 0, toolSchemaChars: 4_500 }), { measured: true });
    assert.deepEqual(await enf.fixedPartOf("tiny/one", 32_768), { systemPromptChars: 0, toolSchemaChars: 4_500, tokens: 1_500 });
    const measured = await enf.routeMoved(owner, { taskId: t, attemptId: "att-1", route: "tiny/one", window: 32_768, items });
    assert.equal(measured.measured, true);
    assert.ok(measured.startup.cuts.length < moved.startup.cuts.length, "the measured figure is smaller than the floor: fewer items cut");
    assert.ok(tokensOf(measured.view.length, budget) + 1_500 <= budget.startupTokens);
    // A measurement of nothing measures nothing; only the dispatcher's principals may measure; bad figures are refused.
    assert.deepEqual(await enf.measureRoute(owner, { taskId: t, attemptId: "att-2", launch: "l2", route: "never/sized", systemPromptChars: 0, toolSchemaChars: 0 }), { measured: false });
    await assert.rejects(enf.measureRoute(owner, { taskId: t, attemptId: "att-2", route: "x/y", systemPromptChars: -1, toolSchemaChars: 0 }), /systemPromptChars/);
    await assert.rejects(enf.measureRoute({ ...owner, kind: "agent", id: "agent:ann" } as never, { taskId: t, attemptId: "att-2", route: "x/y", systemPromptChars: 1, toolSchemaChars: 1 }), /not the dispatcher/);
  });

  const at2 = (i: number): string => new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString();
  const manyItems = (kind: StartupItem["kind"] = "report"): StartupItem[] => {
    const items: StartupItem[] = [{ id: "g", kind: "goal", text: "Goal: ship v1.", at: at2(0) }, { id: "h", kind: "human", text: "Merge the branch.", at: at2(1) }];
    for (let i = 0; i < 20; i++) items.push({ id: `r${i}`, kind, text: `${kind} ${i} `.repeat(600), at: at2(i + 2) });
    return items;
  };
  const small = { systemPromptChars: 100, toolSchemaChars: 100, startupTokens: 100, replyReserveTokens: 100 };

  suite("the same attempt asked again with another window or route is a new decision, never a command conflict; raising the window after a refusal works (findings 1, 4)", async ({ enf, owner, blockers, t }) => {
    const items = manyItems();
    const first = await enf.routeMoved(owner, { taskId: t, attemptId: "att-1", route: "local/small", window: 131_072, items });
    assert.equal(first.rebuilt, true);
    // Same attempt, same route, another window (the owner raised the route's contextTokens): a different decision, not command_conflict.
    const wider = await enf.routeMoved(owner, { taskId: t, attemptId: "att-1", route: "local/small", window: 262_144, items });
    assert.equal(wider.replayed, false);
    assert.notEqual(wider.id, first.id);
    assert.ok(wider.startup.tokens > first.startup.tokens, "more fits in the wider window");
    // Same attempt, another route: also a new decision; repeating either is the recorded one.
    const other = await enf.routeMoved(owner, { taskId: t, attemptId: "att-1", route: "cloud/other", window: 262_144, items });
    assert.notEqual(other.id, wider.id);
    assert.equal((await enf.routeMoved(owner, { taskId: t, attemptId: "att-1", route: "cloud/other", window: 262_144, items })).replayed, true);
    assert.equal((await enf.routeMoved(owner, { taskId: t, attemptId: "att-1", route: "local/small", window: 131_072, items })).replayed, true);
    // changeRoute itself: the same call with a changed window or fixed figure is a new decision as well (the archive batches too).
    const a = await enf.changeRoute(owner, { taskId: t, attemptId: "att-9", window: 131_072, fixedTokens: 3_000, items });
    const b = await enf.changeRoute(owner, { taskId: t, attemptId: "att-9", window: 262_144, fixedTokens: 3_000, items });
    const c = await enf.changeRoute(owner, { taskId: t, attemptId: "att-9", window: 262_144, fixedTokens: 4_000, items });
    assert.equal(new Set([a.id, b.id, c.id]).size, 3);
    // A refusal: the blocker names the ways out; the owner raises the window, resolves the blocker, and the same attempt goes through.
    const refused = await enf.routeMoved(owner, { taskId: t, attemptId: "att-2", route: "tiny/one", window: 4_096, items });
    assert.equal(refused.rebuilt, false);
    const blocker = (await blockers.getBlocker(refused.blockerId!))!;
    assert.match(blocker.summary, /larger window.*task contract.*supersede.*reassign/s);
    await blockers.resolveBlocker({ commandId: "res-1", actor: owner.id, blockerId: blocker.id, expectedRevision: blocker.revision, resolution: "raised the window of tiny/one" });
    const raised = await enf.routeMoved(owner, { taskId: t, attemptId: "att-2", route: "tiny/one", window: 131_072, items });
    assert.equal(raised.rebuilt, true);
    assert.equal(await blockers.openFor("context_overflow", { kind: "task", id: t }), undefined);
  });

  suite("a task back on the route it ran on closes the stale route blocker, and only that one (finding 4)", async ({ enf, owner, blockers, t, t2 }) => {
    const refused = await enf.routeMoved(owner, { taskId: t, attemptId: "att-1", route: "tiny/one", window: 4_096, items: manyItems() });
    assert.ok(refused.blockerId);
    assert.equal((await enf.admit(owner, { taskId: t, attemptId: "att-1", window: 65_536, call: small })).admit, false, "nothing is admitted while it is open");
    assert.deepEqual(await enf.routeKept(owner, { taskId: t }), { closed: refused.blockerId });
    assert.equal(await blockers.openFor("context_overflow", { kind: "task", id: t }), undefined);
    assert.deepEqual(await enf.routeKept(owner, { taskId: t }), {}, "nothing left to close");
    assert.equal((await enf.admit(owner, { taskId: t, attemptId: "att-2", window: 65_536, call: small })).admit, true);
    // A context blocker that is not a route change stays.
    const big = await enf.admit(owner, { taskId: t2, attemptId: "att-1", window: 8_192, call: { systemPromptChars: 90_000, toolSchemaChars: 90_000, startupTokens: 9_000, replyReserveTokens: 1_000 } });
    assert.ok(big.blockerId);
    assert.deepEqual(await enf.routeKept(owner, { taskId: t2 }), {});
    assert.equal((await blockers.openFor("context_overflow", { kind: "task", id: t2 }))?.id, big.blockerId);
  });

  suite("the route's fixed part is written beside the admission and never fails it: concurrent first calls on a new route all pass (finding 2)", async ({ enf, owner, t, t2 }) => {
    const route = contextRouteKey("local/new");
    const results = await Promise.all([t, t2, t, t2].map((task, i) => enf.admit(owner, { taskId: task, attemptId: `att-${i}`, window: 65_536, route, call: { systemPromptChars: 12_000 + i * 1_000, toolSchemaChars: 9_000, startupTokens: 500, replyReserveTokens: 1_000 } })));
    assert.deepEqual(results.map((r) => r.admit), [true, true, true, true]);
    for (const r of results) assert.equal(r.blockerId, undefined);
    const fixed = await enf.fixedPartOf("local/new", 65_536);
    assert.ok(fixed !== undefined, "a figure was kept");
    assert.ok(fixed.systemPromptChars >= 12_000 && fixed.systemPromptChars <= 15_000);
    // All four concurrent measurements were merged (none lost to the race), not just some of them.
    assert.deepEqual((await enf.fixedSamplesOf("local/new")).map((x) => x.systemPromptChars).sort((x, y) => x - y), [12_000, 13_000, 14_000, 15_000]);
  });

  suite("a refused admission leaves the route's figure alone; the figure is per route and harness, the median of the latest few (finding 3)", async ({ enf, owner, t, t2 }) => {
    const route = contextRouteKey("local/fig");
    // A refused first call is a real measurement too: the route becomes measured, so the next move to it is checked with the real size and not the floor (third review, finding 2).
    const refused = await enf.admit(owner, { taskId: t, attemptId: "att-1", window: 8_192, route: contextRouteKey("local/refused"), harness: "pi", call: { systemPromptChars: 400_000, toolSchemaChars: 400_000, startupTokens: 500, replyReserveTokens: 1_000 } });
    assert.equal(refused.admit, false);
    const figure = await enf.fixedPartOf("local/refused", 65_536, "pi");
    assert.deepEqual([figure?.systemPromptChars, figure?.toolSchemaChars], [400_000, 400_000]);
    const moved = await enf.routeMoved(owner, { taskId: t2, attemptId: "att-9", route: "local/refused", harness: "pi", window: 8_192, items: goalOnly });
    assert.deepEqual([moved.measured, moved.rebuilt, moved.warning === undefined], [true, false, true], "the move to a route whose first call overflowed is refused on the real size, not admitted on a floor");
    // A call that measured nothing (no prompt, no tools) is no measurement.
    await enf.admit(owner, { taskId: t2, attemptId: "att-0", window: 65_536, route: contextRouteKey("local/empty"), call: { systemPromptChars: 0, toolSchemaChars: 0, startupTokens: 500, replyReserveTokens: 1_000 } });
    assert.equal(await enf.fixedPartOf("local/empty", 65_536), undefined);
    const sized = (chars: number) => ({ systemPromptChars: chars, toolSchemaChars: 5_000, startupTokens: 500, replyReserveTokens: 1_000 });
    await enf.admit(owner, { taskId: t2, attemptId: "att-1", window: 65_536, route, harness: "pi", call: sized(20_000) });
    assert.equal((await enf.fixedPartOf("local/fig", 65_536, "pi"))?.systemPromptChars, 20_000);
    assert.equal(await enf.fixedPartOf("local/fig", 65_536, "hermes"), undefined, "per harness");
    assert.equal(await enf.fixedPartOf("local/fig", 65_536), undefined, "per harness");
    for (let i = 2; i <= 5; i++) await enf.admit(owner, { taskId: t2, attemptId: `att-${i}`, window: 65_536, route, harness: "pi", call: sized(8_000) });
    assert.equal((await enf.fixedPartOf("local/fig", 65_536, "pi"))?.systemPromptChars, 8_000, "the median of the recent ones: one large measurement does not set the figure");
    assert.equal((await enf.fixedSamplesOf("local/fig", "pi")).length, 5);
    await enf.admit(owner, { taskId: t2, attemptId: "att-6", window: 65_536, route, harness: "pi", call: sized(30_000) });
    assert.equal((await enf.fixedSamplesOf("local/fig", "pi")).length, 5, "at most five are kept");
    assert.equal((await enf.fixedPartOf("local/fig", 65_536, "pi"))?.systemPromptChars, 8_000);
  });

  suite("the median of an even number of measurements is the upper middle one, and a zero-size sample is ignored (third review, finding 5)", async ({ enf, owner, t, t2 }) => {
    const sized = (chars: number) => ({ systemPromptChars: chars, toolSchemaChars: 5_000, startupTokens: 500, replyReserveTokens: 1_000 });
    const route = contextRouteKey("local/even");
    await enf.admit(owner, { taskId: t, attemptId: "att-1", window: 65_536, route, call: sized(10_000) });
    await enf.admit(owner, { taskId: t2, attemptId: "att-2", window: 65_536, route, call: sized(20_000) });
    assert.equal((await enf.fixedPartOf("local/even", 65_536))?.systemPromptChars, 20_000, "two samples: the larger middle, not the smaller");
    await enf.admit(owner, { taskId: t, attemptId: "att-3", window: 65_536, route, call: sized(30_000) });
    await enf.admit(owner, { taskId: t2, attemptId: "att-4", window: 65_536, route, call: sized(40_000) });
    assert.equal((await enf.fixedPartOf("local/even", 65_536))?.systemPromptChars, 30_000, "four samples 10, 20, 30, 40: the upper middle");
  });

  suite("an unmeasured route that cannot hold its floor beside the essentials is built with the room the essentials leave, not the whole startup budget (third review, finding 3)", async ({ enf, owner, t }) => {
    const items: StartupItem[] = [{ id: "g", kind: "goal", text: "Goal: ship v1.", at: at2(0) }, { id: "h", kind: "human", text: "Merge the branch.", at: at2(1) }];
    for (let i = 0; i < 10; i++) items.push({ id: `r${i}`, kind: "report", text: `${"w".repeat(399)}${i}`, at: at2(i + 2) });
    const moved = await enf.routeMoved(owner, { taskId: t, attemptId: "att-1", route: "tiny/fresh", window: 8_192, items });
    assert.deepEqual([moved.measured, moved.rebuilt], [false, true]);
    assert.match(moved.warning!, /has not been measured yet/);
    assert.equal(moved.startup.cuts.length, 4, "the four optional items are cut to the room that is left");
    const record = await enf.routeArchive(owner, { taskId: t, digest: moved.startup.cuts[0]!.digest });
    assert.ok(record, "and archived");
    assert.ok(moved.startup.tokens <= 2_048 - 1_000, "what is recorded as the startup is the real cut");
  });

  suite("a blocker an admission refusal opened meanwhile is never marked as the route change's; a route blocker whose mark was lost or stale is marked on the next refusal and closed when the move fits (third review, finding 4)", async ({ enf, owner, blockers, withBlockers, t, t2, plant }) => {
    const call = { systemPromptChars: 90_000, toolSchemaChars: 90_000, startupTokens: 9_000, replyReserveTokens: 1_000 };
    const adm = await enf.admit(owner, { taskId: t, attemptId: "att-1", window: 8_192, call });
    assert.ok(adm.blockerId);
    // The route-change code looks, finds nothing (the admission's blocker was opened a moment after), and then finds the blocker when it opens its own: it must not take it over.
    let lie = true;
    const blind = new Proxy(blockers, { get: (target, k) => { const v = Reflect.get(target, k, target); if (k === "openFor") return async (...a: unknown[]) => { if (lie) { lie = false; return undefined; } return (v as (...x: unknown[]) => unknown).apply(target, a); }; return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(target) : v; } });
    const racing = withBlockers(blind);
    const refused = await racing.routeMoved(owner, { taskId: t, attemptId: "att-2", route: "tiny/one", window: 4_096, items: manyItems() });
    assert.equal(refused.blockerId, adm.blockerId);
    assert.deepEqual(await enf.routeKept(owner, { taskId: t }), {}, "the admission blocker was not marked");
    assert.equal((await blockers.openFor("context_overflow", { kind: "task", id: t }))?.id, adm.blockerId);
    // A route blocker whose mark does not name it (an earlier mark that was never replaced): the next refusal marks it, and a move that fits closes it.
    const open = await blockers.openBlocker({ commandId: cid("ob"), actor: owner.id, type: "context_overflow", subject: { kind: "task", id: t2 }, summary: "[route change] Attempt att-0 cannot move to the route", resolver: "owner" });
    await plant("ctx-route-block", derivedId("ctx", `${t2}\0routeblock`), { taskId: t2, blockerId: "blk-0000000000000000000000" });
    const again = await enf.routeMoved(owner, { taskId: t2, attemptId: "att-1", route: "tiny/one", window: 4_096, items: manyItems() });
    assert.equal(again.blockerId, open.id);
    const fits = await enf.routeMoved(owner, { taskId: t2, attemptId: "att-2", route: "big/one", window: 131_072, items: manyItems() });
    assert.equal(fits.rebuilt, true);
    assert.equal(await blockers.openFor("context_overflow", { kind: "task", id: t2 }), undefined, "closed: the route blocker was marked");
  });

  const goalOnly: StartupItem[] = [{ id: "g", kind: "goal", text: "Goal: ship v1.", at: at2(0) }, { id: "h", kind: "human", text: "Merge the branch.", at: at2(1) }];

  suite("a refusal of a move is closed when the context fits a route later: the owner raised the window with the blocker still open, or another route fits (finding 2)", async ({ enf, owner, blockers, t, t2 }) => {
    const open = (task: string) => blockers.openFor("context_overflow", { kind: "task", id: task });
    // Scenario A: refused on tiny/one, the owner raises that route's window (the blocker is NOT resolved by hand); the same attempt is asked again and fits.
    const refused = await enf.routeMoved(owner, { taskId: t, attemptId: "att-1", route: "tiny/one", window: 4_096, items: manyItems() });
    assert.equal(refused.rebuilt, false);
    assert.equal((await open(t))?.id, refused.blockerId);
    const raised = await enf.routeMoved(owner, { taskId: t, attemptId: "att-1", route: "tiny/one", window: 131_072, items: manyItems() });
    assert.equal(raised.rebuilt, true);
    assert.equal(await open(t), undefined, "the stale refusal is closed by the move that fits");
    assert.equal((await enf.admit(owner, { taskId: t, attemptId: "att-1", window: 131_072, call: small })).admit, true, "the first call is not held for it");
    // Scenario B: refused on tiny/one, then the dispatcher chooses another route that fits.
    const refusedB = await enf.routeMoved(owner, { taskId: t2, attemptId: "att-1", route: "tiny/one", window: 4_096, items: manyItems() });
    assert.ok(refusedB.blockerId);
    assert.equal((await enf.routeMoved(owner, { taskId: t2, attemptId: "att-2", route: "cloud/other", window: 262_144, items: manyItems() })).rebuilt, true);
    assert.equal(await open(t2), undefined);
    assert.equal((await enf.admit(owner, { taskId: t2, attemptId: "att-2", window: 262_144, call: small })).admit, true);
  });

  suite("a move that fits closes only the blocker a route change opened, by its mark: an admission refusal stays (finding 2, 8)", async ({ enf, owner, blockers, t }) => {
    const big = await enf.admit(owner, { taskId: t, attemptId: "att-1", window: 8_192, call: { systemPromptChars: 90_000, toolSchemaChars: 90_000, startupTokens: 9_000, replyReserveTokens: 1_000 } });
    assert.ok(big.blockerId);
    assert.equal((await enf.routeMoved(owner, { taskId: t, attemptId: "att-2", route: "cloud/other", window: 262_144, items: goalOnly })).rebuilt, true);
    assert.equal((await blockers.openFor("context_overflow", { kind: "task", id: t }))?.id, big.blockerId, "not opened by a route change: it stays");
    // A refusal of a move after the admission blocker was resolved is marked, and a later move that fits closes it.
    await blockers.resolveBlocker({ commandId: cid("res"), actor: owner.id, blockerId: big.blockerId!, expectedRevision: (await blockers.getBlocker(big.blockerId!))!.revision, resolution: "ok" });
    const refused = await enf.routeMoved(owner, { taskId: t, attemptId: "att-3", route: "tiny/one", window: 4_096, items: manyItems() });
    assert.ok(refused.blockerId);
    assert.deepEqual(await enf.routeKept(owner, { taskId: t }), { closed: refused.blockerId });
    // A route refusal asked again while an admission blocker is open does not take that blocker over.
    const big2 = await enf.admit(owner, { taskId: t, attemptId: "att-4", window: 8_192, call: { systemPromptChars: 90_000, toolSchemaChars: 90_000, startupTokens: 9_000, replyReserveTokens: 1_000 } });
    const again = await enf.routeMoved(owner, { taskId: t, attemptId: "att-5", route: "tiny/one", window: 4_096, items: manyItems() });
    assert.equal(again.blockerId, big2.blockerId);
    assert.deepEqual(await enf.routeKept(owner, { taskId: t }), {}, "the admission blocker is not the route change's");
  });

  suite("a route nobody measured is not refused on a guess: it proceeds with a warning, and the first call decides; a measured route that is too small is refused (finding 3)", async ({ enf, owner, blockers, t, t2 }) => {
    const unmeasured = await enf.routeMoved(owner, { taskId: t, attemptId: "att-1", route: "tiny/new", window: 8_192, items: goalOnly });
    assert.deepEqual([unmeasured.measured, unmeasured.rebuilt], [false, true]);
    assert.match(unmeasured.warning!, /has not been measured yet/);
    assert.equal(unmeasured.blockerId, undefined);
    assert.equal(await blockers.openFor("context_overflow", { kind: "task", id: t }), undefined);
    // The first call on it is measured by admission, with the real figure.
    await enf.admit(owner, { taskId: t2, attemptId: "att-1", window: 131_072, route: contextRouteKey("tiny/new"), call: { systemPromptChars: 15_000, toolSchemaChars: 9_000, startupTokens: 500, replyReserveTokens: 100 } });
    const measured = await enf.routeMoved(owner, { taskId: t, attemptId: "att-2", route: "tiny/new", window: 8_192, items: goalOnly });
    assert.equal(measured.measured, true);
    assert.equal(measured.warning, undefined);
    assert.equal(measured.rebuilt, false, "measured and too small");
    assert.ok(measured.blockerId);
    // The essentials that do not fit even without the floor are still refused for an unmeasured route.
    assert.equal((await enf.routeMoved(owner, { taskId: t2, attemptId: "att-3", route: "tiny/never", window: 4_096, items: manyItems() })).rebuilt, false);
  });

  suite("one task with a huge tool set does not refuse another task's move: the figure is the median (finding 4)", async ({ enf, owner, t, t2 }) => {
    const route = contextRouteKey("shared/r");
    const call = (sys: number, tools: number) => ({ systemPromptChars: sys, toolSchemaChars: tools, startupTokens: 500, replyReserveTokens: 100 });
    for (let i = 0; i < 3; i++) await enf.admit(owner, { taskId: t, attemptId: `n-${i}`, window: 131_072, route, call: call(2_000, 1_000) });
    assert.equal((await enf.admit(owner, { taskId: t2, attemptId: "big", window: 131_072, route, call: call(80_000, 15_000) })).admit, true);
    assert.deepEqual(await enf.fixedPartOf("shared/r", 40_000), { systemPromptChars: 2_000, toolSchemaChars: 1_000, tokens: 1_000 });
    const moved = await enf.routeMoved(owner, { taskId: t, attemptId: "att-9", route: "shared/r", window: 40_000, items: goalOnly });
    assert.equal(moved.measured, true);
    assert.equal(moved.rebuilt, true, "the outlier does not decide the figure");
  });

  suite("a window the budgets cannot be made for is one typed refusal, not an error at every tick (finding 9)", async ({ enf, owner, blockers, t }) => {
    const first = await enf.routeMoved(owner, { taskId: t, attemptId: "att-1", route: "odd/route", window: 512, items: goalOnly });
    assert.equal(first.rebuilt, false);
    assert.match(first.reason!, /512 tokens/);
    assert.ok(first.blockerId);
    const again = await enf.routeMoved(owner, { taskId: t, attemptId: "att-1", route: "odd/route", window: 512, items: goalOnly });
    assert.equal(again.blockerId, first.blockerId, "asked again: the same blocker, not another");
    assert.equal((await blockers.openFor("context_overflow", { kind: "task", id: t }))?.id, first.blockerId);
    // The owner sets the real window: the move fits and the refusal is closed.
    assert.equal((await enf.routeMoved(owner, { taskId: t, attemptId: "att-1", route: "odd/route", window: 32_768, items: goalOnly })).rebuilt, true);
    assert.equal(await blockers.openFor("context_overflow", { kind: "task", id: t }), undefined);
    // Admission and changeRoute on such a window refuse the command (invalid_command), never a RangeError.
    await refuses("invalid_command", () => enf.admit(owner, { taskId: t, attemptId: "att-2", window: 100, call: small }));
    await refuses("invalid_command", () => enf.changeRoute(owner, { taskId: t, attemptId: "att-2", window: 100, fixedTokens: 0, items: goalOnly }));
  });

  suite("route keys are injective and always carry a marker no encoded name can contain; calibration written under the old names is still found (finding 7)", async ({ enf, owner, t, t2, plant }) => {
    const names = ["-x", "r-x", "c~r-x", "x", "cx", "a/b", "a:b", "~", "~r", "r~r", "a~007eb", "a~h0123456789abcdef", `${"y".repeat(90)}1`, `${"y".repeat(90)}2`];
    // A long name forged to look like another's cut form.
    const long = "z".repeat(120); const cut = contextRouteKey(long);
    names.push(long, cut, cut.replace(/~h/, "~007eh"));
    assert.equal(new Set(names.map(contextRouteKey)).size, names.length, "no two names share a key");
    for (const n of names) assert.match(contextRouteKey(n), /^c~r[A-Za-z0-9._:~-]{0,77}$/);
    // Records of the previous release (key without the marker) and of the one before (every other character a colon) are read.
    const K = contextRouteKey("local/small");
    assert.equal(K, "c~rlocal~002fsmall");
    await plant("ctx-calibration", derivedId("ctx", `${t}\0local~002fsmall\0calibration`), { taskId: t, route: "local~002fsmall", ratio: 3, charsPerToken: 1, reportedTokens: 1, attemptId: "old" });
    await plant("ctx-calibration", derivedId("ctx", `${t2}\0local:small\0calibration`), { taskId: t2, route: "local:small", ratio: 3, charsPerToken: 1, reportedTokens: 1, attemptId: "old" });
    const call = { systemPromptChars: 3_000, toolSchemaChars: 3_000, startupTokens: 1_000, replyReserveTokens: 100 };
    assert.equal((await enf.admit(owner, { taskId: t, attemptId: "att-1", window: 131_072, route: K, call })).startupTokens, 9_000, "scaled by the previous release's calibration");
    // The oldest form turned every other character into a colon, so local/small and local:small shared one key: it is not read for a name it cannot be told to belong to (third review, finding 6).
    assert.equal((await enf.admit(owner, { taskId: t2, attemptId: "att-1", window: 131_072, route: K, call })).startupTokens, 3_000, "not scaled by another name's calibration");
    await plant("ctx-calibration", derivedId("ctx", `${t2}\0a:b\0calibration`), { taskId: t2, route: "a:b", ratio: 3, charsPerToken: 1, reportedTokens: 1, attemptId: "old" });
    assert.equal((await enf.admit(owner, { taskId: t2, attemptId: "att-2", window: 131_072, route: contextRouteKey("a/b"), routeName: "a/b", call })).startupTokens, 3_000, "a/b does not read the calibration of a:b");
    assert.equal((await enf.admit(owner, { taskId: t2, attemptId: "att-3", window: 131_072, route: contextRouteKey("a:b"), routeName: "a:b", call })).startupTokens, 9_000, "a:b does");
    // A name past 80 characters was cut with a digest of the whole name before; the key alone cannot say which name it was, so the caller's name finds it.
    const longName = `provider/${"m".repeat(100)}`;
    const oldCut = `${`r${longName}`.slice(0, 0)}${encodeRoute(longName).slice(0, 63)}~${createHash("sha256").update(longName).digest("hex").slice(0, 16)}`;
    await plant("ctx-calibration", derivedId("ctx", `${t}\0${oldCut}\0calibration`), { taskId: t, route: oldCut, ratio: 2, charsPerToken: 1, reportedTokens: 1, attemptId: "old" });
    assert.equal((await enf.admit(owner, { taskId: t, attemptId: "att-4", window: 131_072, route: contextRouteKey(longName), routeName: longName, call })).startupTokens, 6_000, "found through the name");
    await refuses("invalid_command", () => enf.admit(owner, { taskId: t, attemptId: "att-5", window: 131_072, route: contextRouteKey(longName), routeName: "other", call }));
    // A route with a leading odd character was prefixed with 'r' before.
    const L = contextRouteKey("/lead");
    await plant("ctx-calibration", derivedId("ctx", `${t}\0r~002flead\0calibration`), { taskId: t, route: "r~002flead", ratio: 2, charsPerToken: 1, reportedTokens: 1, attemptId: "old" });
    assert.equal((await enf.admit(owner, { taskId: t, attemptId: "att-2", window: 131_072, route: L, call })).startupTokens, 6_000);
  });

  suite("a failure to keep the route's figure is reported (once a minute), is never retried when it cannot succeed, and never fails the admission (finding 10)", async ({ enf, owner, t }) => {
    told.length = 0; clockBox.at = "2026-10-22T10:00:00.000Z";
    const call = { systemPromptChars: 2_000, toolSchemaChars: 1_000, startupTokens: 100, replyReserveTokens: 100 };
    // A harness name the record cannot carry: the admission goes through, the fault is told.
    assert.equal((await enf.admit(owner, { taskId: t, attemptId: "att-1", window: 65_536, route: contextRouteKey("r/1"), harness: "bad harness!", call })).admit, true);
    assert.equal((await enf.admit(owner, { taskId: t, attemptId: "att-2", window: 65_536, route: contextRouteKey("r/1"), harness: "bad harness!", call })).admit, true);
    assert.equal(told.length, 1, "rate limited");
    assert.equal((told[0] as DomainError).code, "invalid_command", String(told[0]));
    told.length = 0;
    // The same admission asked again with another harness: its figure command conflicts with itself for ever; that is told, not retried in silence.
    await enf.admit(owner, { taskId: t, attemptId: "att-3", window: 65_536, route: contextRouteKey("r/2"), harness: "pi", call });
    clockBox.at = "2026-10-22T10:05:00.000Z";
    assert.equal((await enf.admit(owner, { taskId: t, attemptId: "att-3", window: 65_536, route: contextRouteKey("r/2"), harness: "hermes", call })).admit, true);
    assert.equal(told.length, 1);
    assert.equal((told[0] as DomainError).code, "command_conflict", String(told[0]));
  }, { onError: (e) => told.push(e), clock: () => clockBox.at });

  const floorBox = { chars: 14_000 };
  suite("a route nobody measured counts a floor, not 0; the floor comes from the setting and can be turned off (finding 6)", async ({ enf, owner, t }) => {
    // About 13,000 tokens: it fits the 16,384-token startup limit whole, but not beside the floor, so the floor shows in what is cut.
    const items: StartupItem[] = [...goalOnly];
    for (let i = 0; i < 20; i++) items.push({ id: `r${i}`, kind: "report", text: `${"w".repeat(1_999)}${i % 10}`, at: at2(i + 2) });
    const on = await enf.routeMoved(owner, { taskId: t, attemptId: "att-1", route: "local/unknown", window: 65_536, items });
    assert.equal(on.measured, false);
    floorBox.chars = 0;
    const off = await enf.routeMoved(owner, { taskId: t, attemptId: "att-2", route: "local/unknown", window: 65_536, items });
    assert.ok(off.startup.tokens > on.startup.tokens, "with the floor less is left for the context");
    floorBox.chars = 4_000_000;
    const huge = await enf.routeMoved(owner, { taskId: t, attemptId: "att-3", route: "local/unknown", window: 65_536, items });
    assert.equal(huge.rebuilt, true, "an unmeasured route is not refused on a guess: a floor larger than the window is set aside and the first call decides");
    assert.match(huge.warning!, /has not been measured yet/);
    assert.equal(huge.blockerId, undefined);
    floorBox.chars = 14_000;
  }, { routeSettings: { effective: async () => ({ check: true, floorChars: floorBox.chars }) } });

  suite("the cut text of project-wide items is read back only with the right to read the project's history; the rest by whoever works on the task (finding 7)", async ({ enf, owner, ann, t }) => {
    const items: StartupItem[] = [{ id: "g", kind: "goal", text: "Goal.", at: at2(0) }, { id: "h", kind: "human", text: "Do it.", at: at2(1) }];
    for (let i = 0; i < 12; i++) items.push({ id: `d${i}`, kind: "decision", text: `decision ${i} `.repeat(300), at: at2(i + 2) }, { id: `r${i}`, kind: "report", text: `report ${i} `.repeat(300), at: at2(i + 2) });
    const moved = await enf.changeRoute(owner, { taskId: t, attemptId: "att-1", window: 65_536, fixedTokens: 1_000, items });
    const cutOf = (kind: StartupItem["kind"]) => moved.startup.cuts.find((c) => c.kind === kind);
    const decision = cutOf("decision"), report = cutOf("report");
    assert.ok(decision && report, "both kinds were cut");
    assert.ok(await enf.routeArchive(owner, { taskId: t, digest: decision.digest }), "the owner reads it");
    assert.equal(await enf.routeArchive(ann, { taskId: t, digest: decision.digest }), undefined, "an agent that only works on the task does not read project-wide decision text");
    assert.equal((await enf.routeArchive(ann, { taskId: t, digest: report.digest }))?.digest, report.digest);
  });

  suite("a route name keeps its identity: a/b and a:b are two routes, long names stay apart, and the result is a valid route key (finding 9)", async ({ enf, owner, t2 }) => {
    assert.notEqual(contextRouteKey("a/b"), contextRouteKey("a:b"));
    assert.notEqual(contextRouteKey("a b"), contextRouteKey("a_b"));
    assert.notEqual(contextRouteKey("a~b"), contextRouteKey("a/b"));
    const long1 = `${"x".repeat(90)}1`, long2 = `${"x".repeat(90)}2`;
    assert.notEqual(contextRouteKey(long1), contextRouteKey(long2));
    for (const r of ["a/b", "a:b", "/leading", long1, "ünï/cödé", "provider/model:tag"]) assert.match(contextRouteKey(r), /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,79}$/);
    assert.equal(contextRouteKey("plain-route.1"), "c~rplain-route.1");
    // Measured under one name is not found under the other.
    await enf.admit(owner, { taskId: t2, attemptId: "att-1", window: 65_536, route: contextRouteKey("a/b"), call: { systemPromptChars: 5_000, toolSchemaChars: 1_000, startupTokens: 100, replyReserveTokens: 100 } });
    assert.ok(await enf.fixedPartOf("a/b", 65_536));
    assert.equal(await enf.fixedPartOf("a:b", 65_536), undefined);
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
    assert.ok(Date.now() - t0 < 60_000, "each hang cost only its own short timeout, not the chain default");
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
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => { started = resolve; });
    // The caller gives up only once the summariser is running, and the summariser records the abort event itself: no clock decides the order.
    const slow: Summariser = { route: "slow", summarise: ({ signal }) => new Promise<string>((_, reject) => { signal.addEventListener("abort", () => { told = true; reject(new Error("stopped")); }); started(); }) };
    void hasStarted.then(() => stop.abort());
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
