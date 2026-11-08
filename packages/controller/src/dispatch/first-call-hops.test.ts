import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ContextEnforcementService, DeskService, HistoryService, RetrievalService, contextBudget, handoffFromFacts, tokensOf } from "../context/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { HandoffService, StopService, controllerHandoffSources, type StopPorts } from "../lifecycle/index.js";
import type { JsonObject } from "../storage/types.js";
import type { RouteResolver } from "./dispatcher.js";
import { LocalWorker, type AttemptRuntime } from "./local-worker.js";
import { controllerGuards } from "./runtime-guards.js";
import { buildWorld, workGrants } from "./testing/world.js";

/**
 * Card C07l: what the next agent is actually given in a call, over 50 hand-offs. One task is handed A to B to A fifty times with the real hand-off service; after each hand-off the real dispatcher starts the new
 * owner's attempt on a real local worker whose guards are bound to the real context service (`controllerGuards`, as `api/dispatch-compose.ts` binds them). Only the model process is a stand-in, sized the way the
 * worker package's host sizes its first call (`packages/worker/src/host/local.ts`: the prompt at three characters a token plus the stored conversation). The hops mix in what happens to real tasks: a lease that runs out
 * (the attempt is lost and the next one admitted), a controller restart (the attempt resumes from its checkpoint with a resume note, its stored conversation growing with the hops, so it is first resumed whole, then
 * compacted to fit, then started fresh), and a fallback to a route with half the window.
 *
 * Measured at every call that is sent: the first call's size against the startup limit of its route, the stored conversation against the resume share, and the resume note. What holds today is asserted plainly; what
 * does not is a finding, marked `todo` with the follow-up card that fixes it (the C07h convention). The card's other candidates, read in the code, are recorded with file and line on their cards and in the notes.
 */
after(stopServer);

const HOPS = 50;
/** The routes and their windows, as the routing table says them (the window the guards are bound to). The fallback route has half the window. */
const ROUTES: Readonly<Record<string, number>> = { "localp/small": 32_768, "localp/tiny": 16_384 };
/** What the model process sends besides the prompt (its system prompt and tool schemas), in characters. */
const SYSTEM = 4500, TOOLS = 6000;
const FIXED_TOKENS = tokensOf(SYSTEM + TOOLS, contextBudget(32_768));
const OWNER_WORDS = "OWNER-WORDS: never delete a customer file; ask first";
const GOAL = "Goal: every fixture imports";
const OPEN_QUESTION = "OPEN-QUESTION: which encoding do the oldest fixtures use";
const OPEN_BLOCKER = "OPEN-BLOCKER: the fixture server is down until the owner restarts it";
/** What each hop adds to the story (the kinds repeat every five hops, so the first ten and the last ten hold the same mix). */
const KIND = ["plain", "lease", "restart", "fallback", "plain"] as const;
type Kind = (typeof KIND)[number];
const kindOf = (hop: number): Kind => KIND[hop % 5]!;

/** A call the model was sent: its size as the real admission counts it, and how it came to be. */
interface Sent { readonly hop: number; readonly kind: Kind; readonly agent: string; readonly attemptId: string; readonly route: string; readonly tokens: number; readonly stored: number; readonly resumed: boolean; /** The resume note the order carried (before the worker adds why it started fresh). */ readonly resumeNote?: string; readonly content: string }
/** A runtime opened for an attempt: whether it was given a stored conversation, and how big the checkpoint said it was. */
interface Opened { readonly hop: number; readonly attemptId: string; readonly offered?: number; readonly resumed: boolean; readonly route: string }
interface Hop { readonly hop: number; readonly kind: Kind; readonly to: string; readonly handoffId: string; readonly nextAction: string; readonly lost: number }
interface Run { readonly sent: readonly Sent[]; readonly opened: readonly Opened[]; readonly hops: readonly Hop[]; readonly compactions: number; readonly controllerNotes: readonly string[]; readonly guardErrors: readonly string[] }

const stub: StopPorts = { unsupported: () => undefined, release: async () => undefined, inventory: async () => [], cleanup: async () => ({ remaining: [] }), checkpoint: async () => ({ checkpointId: "cp", durable: true, artifactsDurable: true }), terminate: async () => ({ ended: true, unresolved: [] }) } as unknown as StopPorts;

for (const backend of backends) {
  const simulate = async (): Promise<Run> => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      await w.routing.setTable(w.owner, { commandId: "c07l-routes", expectedRevision: 1, table: { providers: { localp: { enabled: true, paid: false, location: "local" } }, routes: Object.fromEntries(Object.entries(ROUTES).map(([r, n]) => [r, { contextTokens: n, capabilities: ["tools"] }])), profiles: { "r-local": ["localp/small"] }, roles: {} } });
      const options = { clock: w.clock.now, pause: async () => undefined };
      const histories = HistoryService.withEpoch(store.storage, w.epoch, options);
      const desks = DeskService.withEpoch(store.storage, w.epoch, options);
      const retrieval = RetrievalService.withEpoch(store.storage, w.epoch, desks, histories, options);
      const context = ContextEnforcementService.withEpoch(store.storage, w.epoch, { blockers: w.blockers, retrieval }, options);
      const guardErrors: string[] = [];
      const guards = controllerGuards({
        context, pause: w.pauses, messages: { readable: async () => ({ items: [] }), acknowledge: async () => ({ refused: [] }) } as never, system: w.dispatcherPrincipal,
        agent: (order) => w.credentials.authenticate(order.credential), assignee: (order) => w.credentials.agentOf(w.dispatcherPrincipal, order.attemptId),
        window: (order) => ROUTES[order.route],
        storedTokens: (from) => { const t = (from["nn"] as JsonObject | undefined)?.["contextTokens"]; return typeof t === "number" ? t : undefined; },
      });

      // The model process: its conversation grows by `grow` tokens with each turn it runs, a compaction leaves 200, and a checkpoint says how big it is (as the worker package's host writes it).
      let hop = 0;
      let mode: "complete" | "hang" = "complete";
      let grow = 2000;
      let compactions = 0;
      const sent: Sent[] = [];
      const opened: Opened[] = [];
      const local = new LocalWorker({
        hostId: "host:w1", resources: { cpus: 1, memoryMb: 1024 }, version: "worker-c07l", capabilities: () => ({}) as never, guards,
        onGuardError: (_id, what, error) => { guardErrors.push(`${what}: ${String((error as Error)?.message ?? error)}`); },
        sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) },
        runtimes: {
          open: async (order, _call, from) => {
            const offered = (from?.["nn"] as JsonObject | undefined)?.["contextTokens"] as number | undefined;
            let ctx = offered ?? 0;
            opened.push({ hop, attemptId: order.attemptId, ...(offered === undefined ? {} : { offered }), resumed: from !== undefined, route: order.route });
            let release!: () => void; const closed = new Promise<void>((ok) => { release = ok; });
            const rt: AttemptRuntime = {
              firstCall: (text) => ({ systemPromptChars: SYSTEM, toolSchemaChars: TOOLS, startupTokens: Math.ceil(text.length / 3) + ctx, replyReserveTokens: 1000 }),
              compact: async () => { compactions++; ctx = Math.min(ctx, 200); },
              run: async (content) => {
                sent.push({ hop, kind: kindOf(hop), agent: order.agentId, attemptId: order.attemptId, route: order.route, tokens: FIXED_TOKENS + Math.ceil(content.length / 3) + ctx, stored: ctx, resumed: from !== undefined, ...(order.resumeNote === undefined ? {} : { resumeNote: order.resumeNote }), content });
                ctx += grow;
                if (mode === "hang") { await closed; return { status: "cancelled" } as never; }
                return { status: "completed", text: "ok", checkpoint: { nn: { contextTokens: ctx } } };
              },
              checkpoint: async () => ({ nn: { contextTokens: ctx } }),
              close: async () => { release(); },
            };
            return rt;
          },
        },
      });
      let fallback = false;
      const base = w.deps.route;
      const route: RouteResolver = async (a) => { const r = await base(a); return fallback && "route" in r ? { ...r, route: "localp/tiny" } : r; };
      const deps = { workers: [local], context, route };
      let d = w.restart(deps);

      const a = await w.agent("ann", workGrants(w.project));
      const b = await w.agent("bob", workGrants(w.project));
      const taskId = (await w.projects.createTask({ commandId: "c07l-t", actor: w.owner.id, projectId: w.project, title: "Ship the importer", description: `${OWNER_WORDS}. ${GOAL}.` })).id;
      await w.projects.transitionTask({ commandId: "c07l-r", actor: w.owner.id, taskId, expectedRevision: 1, to: "ready" });
      await w.assignments.assignTask({ commandId: "c07l-as", actor: w.owner.id, taskId, owner: { kind: "agent", id: a.aid } });
      // An open blocker on the task the next agent must know about (it does not stop dispatch).
      await w.blockers.openBlocker({ commandId: "c07l-blk", actor: w.owner.id, type: "wait_overdue", subject: { kind: "task", id: taskId }, summary: OPEN_BLOCKER, resolver: "owner" });

      // The run's continuation, as the hand-off package source reads it (the C07h shape): a next action and decisions per hop, and the open question from another service.
      const contracts = {
        runner: {
          get: async (kind: string) => {
            if (kind === "continuation-head") return { body: { latestCompleteId: "c" } };
            if (kind === "continuation") return { body: { seq: hop, capturedAt: "2026-10-28T10:00:00.000Z", continuation: { artifacts: [], decisions: ["dsk-decisionaaaaaaaaaaaa"], pendingEffects: [{ effectId: "eff-pendingaaaaaaaaaaaaa", state: "unknown" }], nextStep: `NEXT-ACTION-${hop}: rerun fixture batch ${hop}` }, manifest: { routingRevision: 1, environmentRevision: 1 }, checkpoint: { runtime: { name: "pi", version: "1" } }, nonCheckpointableTools: [] } };
            if (kind === "task-contract") return { body: { version: 1, acceptanceCriteria: ["Every fixture imports", "Rejected rows are listed"], requiredEvidence: ["fixture report"] } };
            return undefined;
          },
        },
      };
      const sources = controllerHandoffSources({ getTask: (id) => w.projects.getTask(id), contracts: contracts as never, agentState: async () => "active", more: async () => ({ outstandingQuestions: OPEN_QUESTION }) });
      const stops = StopService.withEpoch(store.storage, w.epoch, w.pauses, stub, options);
      const handoffs = HandoffService.withEpoch(store.storage, w.epoch, { pauses: w.pauses, stops, assignments: w.assignments, sources, responsibilities: { check: async () => undefined, apply: async () => ({ moved: [], failed: [] }) }, onTransferred: async () => undefined }, options);

      const admit = async (agent: string, label: string): Promise<string> => {
        const asg = (await w.assignments.getAssignment(taskId))!;
        return (await w.assignments.admitAttempt({ commandId: `c07l-ad-${label}`, actor: "inbox", taskId, expectedRevision: asg.revision, generation: asg.generation, owner: { kind: "agent", id: agent }, harness: "pi" })).id;
      };
      const run = async (): Promise<Awaited<ReturnType<typeof d.tick>>> => { const r = await d.tick(); await d.idle(); return r; };

      // Hop 0: the first owner's own attempt.
      await admit(a.aid, "0");
      await run();
      const hops: Hop[] = [];
      for (hop = 1; hop <= HOPS; hop++) {
        const to = hop % 2 === 1 ? b : a;
        const kind = kindOf(hop);
        await w.heartbeatHost();
        const prepared = await handoffs.prepare(w.owner, { commandId: `c07l-h-${hop}`, taskId, to: { kind: "agent", id: to.aid }, reason: `hop ${hop}` });
        const done = await handoffs.complete(w.owner, { commandId: `c07l-c-${hop}`, handoffId: prepared.id });
        assert.equal(done.phase, "transferred", `hop ${hop}`);
        const attemptId = await admit(to.aid, String(hop));
        let lost = 0;
        if (kind === "lease") {
          // The worker stops beating: its lease runs out, the attempt is lost and the next one is admitted and started.
          mode = "hang";
          assert.deepEqual((await d.tick()).started, [attemptId], `hop ${hop}: started`);
          w.clock.advance(61_000);
          await w.heartbeatHost();
          mode = "complete";
          const report = await d.tick();
          lost = report.lost.length;
          assert.deepEqual(report.lost, [attemptId], `hop ${hop}: the attempt was lost`);
          assert.equal(report.readmitted.length, 1, `hop ${hop}: the next attempt was admitted`);
          await d.idle();
          await run();
        } else if (kind === "restart") {
          // The controller restarts while the turn runs: the attempt resumes from its checkpoint, whose conversation is larger at every such hop (900 tokens a hop).
          mode = "hang"; grow = 900 * hop;
          assert.deepEqual((await d.tick()).started, [attemptId], `hop ${hop}: started`);
          assert.equal((await d.shutdown()).closed, 1, `hop ${hop}: the running attempt was closed`);
          await d.idle();
          mode = "complete"; grow = 2000;
          d = w.restart(deps);
          const resumedReport = await run();
          assert.deepEqual(resumedReport.started, [attemptId], `hop ${hop}: the same attempt resumed`);
        } else {
          fallback = kind === "fallback";
          assert.deepEqual((await run()).started, [attemptId], `hop ${hop}: started`);
          fallback = false;
        }
        hops.push({ hop, kind, to: to.id, handoffId: prepared.id, nextAction: `NEXT-ACTION-${hop}`, lost });
      }
      const controllerNotes = (await store.storage.listAggregates("ctx-handoff", { limit: 500 })).map((r) => (r.body as unknown as { text: string }).text);
      return { sent, opened, hops, compactions, controllerNotes, guardErrors };
    } finally { await store.close(); }
  };

  /** One simulation per backend, shared by the checks below. */
  let cached: Promise<Run> | undefined;
  const sim = (): Promise<Run> => (cached ??= simulate());
  const sentIn = (r: Run, hop: number): Sent[] => r.sent.filter((s) => s.hop === hop);
  const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

  test(`${backend.name}: 50 hand-offs: every hop's new owner was sent a call, and the hops held lease timeouts, resumes, compactions, fresh starts and the smaller route`, async () => {
    const r = await sim();
    assert.deepEqual(r.guardErrors, [], "no guard failed");
    for (const h of r.hops) {
      const calls = sentIn(r, h.hop);
      assert.ok(calls.length > 0, `hop ${h.hop} (${h.kind}): nothing was sent to the agent the task was handed to`);
      assert.ok(calls.every((c) => c.agent === h.to), `hop ${h.hop}: a call went to an agent the task was not handed to`);
    }
    assert.ok(r.hops.filter((h) => h.lost > 0).length >= 10, "lease timeouts");
    const resumed = r.sent.filter((s) => s.kind === "restart" && s.resumed);
    assert.ok(resumed.length >= 2, "resumed from the stored conversation");
    assert.ok(r.compactions >= 2, "a resumed first call over the limit was compacted to fit");
    assert.ok(r.sent.some((s) => s.kind === "restart" && !s.resumed), "a stored conversation over the resume share started fresh");
    assert.ok(r.sent.filter((s) => s.route === "localp/tiny").length >= 10, "the smaller route");
  });

  test(`${backend.name}: 50 hand-offs: every call sent stays under the startup limit of its route`, async () => {
    for (const s of (await sim()).sent) {
      const limit = contextBudget(ROUTES[s.route]!).startupTokens;
      assert.ok(s.tokens <= limit, `hop ${s.hop} (${s.kind}) on ${s.route}: the first call is ${s.tokens} tokens, over the startup limit of ${limit}`);
    }
  });

  test(`${backend.name}: 50 hand-offs: the first calls of the last 10 hops average no more than 5 percent above the first 10`, async () => {
    const r = await sim();
    // The largest call of each hop: what the hop's agent was given at most.
    const size = (hop: number): number => Math.max(...sentIn(r, hop).map((s) => s.tokens));
    const first = mean(r.hops.slice(0, 10).map((h) => size(h.hop)));
    const lastTen = mean(r.hops.slice(-10).map((h) => size(h.hop)));
    assert.ok(lastTen <= first * 1.05, `first 10 average ${Math.round(first)} tokens, last 10 average ${Math.round(lastTen)}: the first call grows with the number of hand-offs`);
    // The same without the stored conversation: the hops' design front-loads it (the restarts of the first ten resume theirs, those of the last ten start fresh), which would hide a prompt that grows.
    // Today nothing carried across hand-offs reaches the prompt (C07m), so neither comparison can fail on a defect of the code under test; they guard the prompt once C07m adds the hand-off to it.
    const prompt = (hop: number): number => Math.max(...sentIn(r, hop).map((s) => s.tokens - s.stored));
    const firstPrompt = mean(r.hops.slice(0, 10).map((h) => prompt(h.hop)));
    const lastPrompt = mean(r.hops.slice(-10).map((h) => prompt(h.hop)));
    assert.ok(lastPrompt <= firstPrompt * 1.05, `without the stored conversation: first 10 average ${Math.round(firstPrompt)} tokens, last 10 average ${Math.round(lastPrompt)}`);
  });

  test(`${backend.name}: 50 hand-offs: a stored conversation is continued only within the resume share of its route, and a fresh start says why`, async () => {
    const r = await sim();
    for (const o of r.opened) {
      const share = contextBudget(ROUTES[o.route]!).resumeTokens;
      if (o.resumed) assert.ok((o.offered ?? 0) <= share, `hop ${o.hop}: a stored conversation of ${o.offered} tokens was continued, over the resume share of ${share}`);
    }
    // Every restart hop whose checkpoint was over the share started fresh, and its call says so (the agent is told it lost the conversation and why).
    for (const h of r.hops.filter((x) => x.kind === "restart")) {
      const calls = sentIn(r, h.hop);
      const last = calls.at(-1)!;
      if (last.resumed) continue;
      assert.match(last.content, /\[the controller restarted; carry on from the checkpoint\nthe stored conversation is \d+ tokens, over \d+ \(60% of this model's \d+\); starting fresh from the continuation record\]$/, `hop ${h.hop}: the fresh start does not say why`);
    }
  });

  test(`${backend.name}: 50 hand-offs: a resumed call carries its resume note, and the note stays bounded`, async () => {
    const r = await sim();
    const plain = r.sent.find((s) => s.kind === "plain")!.content;
    for (const h of r.hops.filter((x) => x.kind === "restart")) assert.ok(sentIn(r, h.hop).some((s) => s.resumeNote !== undefined), `hop ${h.hop}: the resumed start carried no resume note`);
    for (const s of r.sent) {
      // What a call carries beyond the task's own text and rules is its resume note, as the last bracketed paragraph (and nothing for a call that is not a resume).
      assert.ok(s.content.startsWith(plain), `hop ${s.hop}: the call does not start with the task's text and rules`);
      const extra = s.content.slice(plain.length);
      if (s.resumeNote === undefined) { assert.equal(extra, "", `hop ${s.hop}: a call that is not a resume carries something more`); continue; }
      assert.ok(extra.startsWith(`\n\n[${s.resumeNote}`) && extra.endsWith("]"), `hop ${s.hop}: the resume note is not given: ${JSON.stringify(extra)}`);
      assert.ok(extra.length <= 1000, `hop ${s.hop}: the resume note is ${extra.length} characters`);
    }
  });

  test(`${backend.name}: 50 hand-offs: the owner's words, the goal and the rules that bind the agent are in every call`, async () => {
    for (const s of (await sim()).sent) {
      assert.ok(s.content.includes(OWNER_WORDS), `hop ${s.hop}: the owner's words are missing`);
      assert.ok(s.content.includes(GOAL), `hop ${s.hop}: the goal is missing`);
      assert.match(s.content, /Rules that bind you in this project[^\n]*\n- Approval profile: /, `hop ${s.hop}: the permissions are missing`);
    }
  });

  // Findings: what the next agent is given names nothing of the hand-off. The package (next action, decisions, acceptance criteria, open questions) is read only through `handoff.get`, which no call names;
  // the controller's own hand-off note of the ended attempt is written and never given; an open blocker is in neither. Card C07m.
  const C07M = "C07m: dispatch/dispatcher.ts:1863 builds the call from the task's title and description, the rules and the route view only; nothing names the hand-off package, the controller's hand-off note (written at dispatcher.ts:2163, read by no caller of context/enforcement.ts:914) or the open blockers";
  test(`${backend.name}: 50 hand-offs: the call names the hand-off package, so its next action, decisions, acceptance criteria and open question can be read by reference`, { todo: C07M }, async () => {
    const r = await sim();
    for (const h of r.hops) for (const s of sentIn(r, h.hop)) assert.ok(s.content.includes(h.handoffId) || s.content.includes(h.nextAction), `hop ${h.hop}: the call neither carries nor names the hand-off ${h.handoffId}`);
  });
  test(`${backend.name}: 50 hand-offs: the call names the open blockers of the task`, { todo: C07M }, async () => {
    for (const s of (await sim()).sent) assert.ok(s.content.includes(OPEN_BLOCKER) || /blk-[a-z2-7]{20}/.test(s.content), `hop ${s.hop}: the open blocker is not named`);
  });
  test(`${backend.name}: 50 hand-offs: the controller's hand-off note of the ended attempt reaches the next attempt`, { todo: C07M }, async () => {
    const r = await sim();
    assert.ok(r.controllerNotes.length >= HOPS, "the controller wrote a note at the end of each attempt");
    for (const h of r.hops) for (const s of sentIn(r, h.hop)) assert.ok(/Hand-off written by the controller|hof-[a-z2-7]{20}/.test(s.content), `hop ${h.hop}: the previous attempt's hand-off note is not given or named`);
  });
}

// Findings checked outside the 50 hops (each a small direct case, `todo` until its card lands).

test("a route whose window the controller does not know is checked anyway: a first call far over any window is not sent", { todo: "C07n: dispatch/runtime-guards.ts:57 admits every first call (and :74 resumes every stored conversation) when the binding's window for the route is undefined" }, async () => {
  const guards = controllerGuards({ context: { admit: async () => { throw new Error("not asked"); }, budget: (n: number) => contextBudget(n), confirmUsage: async () => { throw new Error("not asked"); } } as never, pause: {} as never, messages: {} as never, system: {} as never, agent: async () => ({}) as never, assignee: async () => ({}) as never, window: () => undefined });
  const decision = await guards.context!.admit({ attemptId: "att-1", taskId: "tsk-1", route: "unknown/route" } as never, { systemPromptChars: 3_000_000, toolSchemaChars: 0, startupTokens: 0, replyReserveTokens: 0 }, 1);
  assert.equal(decision.admit, false, "a first call of a million tokens on a route of unknown window was admitted");
});

test("the controller's hand-off note that does not fit names where its whole text is kept", { todo: "C07p: context/budget.ts:178 cuts the controller's hand-off note at its tail ([… hand-off cut at N characters]) and keeps no original" }, () => {
  const effects = Array.from({ length: 200 }, (_, i) => ({ id: `eff-${i}`, state: "unknown", summary: `effect ${i} on the fixtures` }));
  const note = handoffFromFacts({ task: "Ship the importer", endedBecause: "lost", effects, artifacts: [], lastKnownState: "running", nextStep: "LAST-LINE" });
  assert.ok(note.length <= 4000);
  assert.match(note, /archive|hof-[a-z2-7]{20}|spl-[a-z2-7]{20}/, "the cut note does not say where the rest is kept");
});
