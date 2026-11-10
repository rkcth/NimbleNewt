import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AssignmentService } from "../domain/assignments.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { DeskService, HistoryService, RetrievalService } from "../context/index.js";
import { InquiryService } from "../inquiries/index.js";
import { ContextEnforcementService } from "../context/index.js";
import { MeetingService } from "../meetings/index.js";
import { AgentMessageService } from "../messaging/index.js";
import { NotificationService } from "../notifications/index.js";
import type { JsonObject } from "../storage/types.js";
import { LocalWorker, type AttemptRuntime } from "./local-worker.js";
import type { RouteResolver } from "./dispatcher.js";
import { KEPT_ROUNDS, controllerGuards } from "./runtime-guards.js";
import { buildWorld, workGrants } from "./testing/world.js";

after(stopServer);

// Card H12f with the controller's real services behind the guards: a message and a pause arriving in the middle of a turn.
for (const backend of backends) {
  test(`${backend.name}: an interrupt reaches the running attempt, a pause shows as pausing until its call settles and then as paused, and nothing is delivered to a paused attempt; an over-budget first call is refused with a blocker`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      await w.principals.enroll(w.owner, { commandId: "eh", kind: "host", name: "local", grants: [] });
      const self = await w.principals.authenticate((await w.principals.issueCredential(w.owner, "host:local")).token);
      await w.admission.setCapacity({ commandId: "cap2", actor: w.owner.id, host: "host:local", capacity: { cpus: 4, memoryMb: 8192 } });
      const { storage, epoch, options } = w;
      const histories = HistoryService.withEpoch(storage, epoch, options);
      const desks = DeskService.withEpoch(storage, epoch, options);
      const retrieval = RetrievalService.withEpoch(storage, epoch, desks, histories, options);
      const assignments = AssignmentService.withEpoch(storage, epoch, w.projects, options);
      const inquiries = InquiryService.withEpoch(storage, epoch, { histories, retrieval, waits: w.waits, assignments }, options);
      const notifications = NotificationService.withEpoch(storage, epoch, options);
      const meetings = MeetingService.withEpoch(storage, epoch, { inquiries }, { availability: w.pauses.availability, invitations: { async invite() { /* not needed */ } }, ...options });
      const messages = AgentMessageService.withEpoch(storage, epoch, { availability: w.pauses.availability, taskPaused: (t) => w.pauses.isPaused(t), guard: (t) => w.pauses.guard(t), waits: w.waits, assignments: w.assignments, meetings, inquiries, notifications, ...options });
      const enforcement = ContextEnforcementService.withEpoch(storage, epoch, { blockers: w.blockers, retrieval }, options);

      const ann = await w.agent("ann", [...workGrants(w.project, ["read-file"]), { action: "message.receive", project: w.project }]);
      const { attemptId, taskId } = await w.task("t", ann);
      const told: string[] = [];
      const errors: string[] = [];
      let bound: ((r: object, e: object) => Promise<unknown>) | undefined;
      let beat!: () => Promise<void>;
      let started!: () => void;
      const inCall = new Promise<void>((ok) => { started = ok; });
      let release!: () => void;
      const hold = new Promise<void>((ok) => { release = ok; });
      let window = 32768;
      let admitted = 0;
      let opened: unknown;
      const guards = controllerGuards({
        context: enforcement, pause: w.pauses, messages, system: w.dispatcherPrincipal,
        agent: async (order) => w.credentials.authenticate(order.credential), assignee: (order) => w.credentials.agentOf(w.dispatcherPrincipal, order.attemptId),
        window: () => window,
      });
      const local = new LocalWorker({
        hostId: "host:local", resources: { cpus: 1, memoryMb: 1024 }, version: "v", capabilities: () => ({ os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] }), guards, onGuardError: (_a, what, e) => { errors.push(`${what}: ${(e as Error).message}`); },
        schedule: (b) => { beat = b; return () => undefined; },
        sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) },
        runtimes: { open: async (_o, call) => { bound = call as never; opened = _o; return {
          firstCall: () => { admitted++; return { systemPromptChars: 3000, toolSchemaChars: 6000, startupTokens: 400, replyReserveTokens: 1000 }; },
          run: async () => { await bound!({ callId: "c1", tool: { name: "read-file", version: "1" }, args: {} }, { kind: "local", run: async () => { started(); await hold; return { text: "x" }; } }); return { status: "completed", text: "done" }; },
          checkpoint: async () => ({}), tell: async (t: string) => { told.push(t); }, close: async () => undefined,
        } as AttemptRuntime; } },
      });
      await local.register(w.hosts, self);
      const d = w.restart({ workers: [local] });
      void window;
      const report = await d.tick();
      assert.deepEqual(report.started, [attemptId]);
      assert.equal(admitted, 1, "the first call was checked");
      await inCall;
      // The provider's count of that first call is recorded against its admission (card C07b), and calibrates the route.
      await guards.context!.confirm!(opened as never, { reportedInputTokens: 2500, promptChars: 9000 });
      const admissions = await storage.listAggregates("ctx-admission", { limit: 10 });
      assert.deepEqual(admissions.map((a) => (a.body as unknown as { reported?: { inputTokens: number } }).reported?.inputTokens), [2500]);
      // Once recorded the round is forgotten; and a count no prompt could have is not recorded.
      await guards.context!.confirm!(opened as never, { reportedInputTokens: 99_999_999, promptChars: 9000 });
      assert.equal((await storage.listAggregates("ctx-admission", { limit: 10 })).length, 1);
      // An impossible count is refused by the check itself: admit a second round, which it would otherwise be recorded against. Over four windows (window 32768), and then too few characters for the tokens.
      assert.equal((await guards.context!.admit(opened as never, { systemPromptChars: 3000, toolSchemaChars: 6000, startupTokens: 400, replyReserveTokens: 1000 }, 2)).admit, true);
      await guards.context!.confirm!(opened as never, { reportedInputTokens: 200_000, promptChars: 400_000 });
      // Then too few characters for the tokens (under half a character a token): another round, also not recorded.
      assert.equal((await guards.context!.admit(opened as never, { systemPromptChars: 3000, toolSchemaChars: 6000, startupTokens: 400, replyReserveTokens: 1000 }, 3)).admit, true);
      await guards.context!.confirm!(opened as never, { reportedInputTokens: 20_000, promptChars: 5_000 });
      const after = await storage.listAggregates("ctx-admission", { limit: 10 });
      assert.equal(after.length, 3);
      assert.deepEqual(after.map((a) => (a.body as unknown as { reported?: { inputTokens: number } }).reported?.inputTokens).filter((x) => x !== undefined), [2500], "the impossible count was not recorded");

      // An urgent message from the owner reaches the running attempt at once, labelled as another party's words.
      await messages.send(w.owner, { commandId: "m1", taskId, to: "agent:ann", class: "urgent-control", purpose: "safety", text: "stop writing to the shared folder" });
      await beat();
      assert.equal(told.length, 1, JSON.stringify(told));
      assert.match(told[0]!, /<<message amg-\S+ sender="owner:rob" purpose="safety" from the owner>>\nstop writing to the shared folder\n<<end message amg-\S+>>/);
      assert.equal((await messages.inbox(w.owner, "agent:ann"))?.items.length ?? 0, 0, "it is delivered, no longer queued");

      // The owner pauses the task while the call is in flight: pausing, not paused.
      await w.pauses.pause(w.owner, { commandId: "p1", scope: { kind: "task", id: taskId }, reason: "look at it" });
      await beat();
      assert.equal((await w.pauses.gate(w.owner, { kind: "task", id: taskId }))!.observed?.state, "pausing");
      // A second interrupt arrives while it is paused: it is not delivered.
      await messages.send(w.owner, { commandId: "m2", taskId, to: "agent:ann", class: "urgent-control", purpose: "safety", text: "another" });
      await beat();
      assert.equal(told.length, 1, "nothing reaches a paused attempt");

      // The call settles: the attempt is reported paused with the safe-boundary statement.
      release();
      await d.idle();
      assert.deepEqual(errors, []);
      const gate = (await w.pauses.gate(w.owner, { kind: "task", id: taskId }))!;
      assert.equal(gate.observed?.state, "paused");
      assert.equal(gate.observed?.boundary, "finished");
    } finally { await store.close(); }
  });

  test(`${backend.name}: a first call over the model's window is refused: the attempt ends failed, a context_overflow blocker is open, and nothing was sent`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      await w.principals.enroll(w.owner, { commandId: "eh", kind: "host", name: "local", grants: [] });
      const self = await w.principals.authenticate((await w.principals.issueCredential(w.owner, "host:local")).token);
      await w.admission.setCapacity({ commandId: "cap2", actor: w.owner.id, host: "host:local", capacity: { cpus: 4, memoryMb: 8192 } });
      const histories = HistoryService.withEpoch(w.storage, w.epoch, w.options);
      const desks = DeskService.withEpoch(w.storage, w.epoch, w.options);
      const retrieval = RetrievalService.withEpoch(w.storage, w.epoch, desks, histories, w.options);
      const enforcement = ContextEnforcementService.withEpoch(w.storage, w.epoch, { blockers: w.blockers, retrieval }, w.options);
      const ann = await w.agent("ann", workGrants(w.project, []));
      const { attemptId, taskId } = await w.task("t", ann);
      let ran = false;
      const guards = controllerGuards({ context: enforcement, pause: w.pauses, messages: undefined as never, system: w.dispatcherPrincipal, agent: async (o) => w.credentials.authenticate(o.credential), assignee: (o) => w.credentials.agentOf(w.dispatcherPrincipal, o.attemptId), window: () => 4096 });
      const local = new LocalWorker({
        hostId: "host:local", resources: { cpus: 1, memoryMb: 1024 }, version: "v", capabilities: () => ({ os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] }), guards: { context: guards.context! },
        sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) },
        runtimes: { open: async () => ({ firstCall: () => ({ systemPromptChars: 9000, toolSchemaChars: 9000, startupTokens: 3000, replyReserveTokens: 500 }), run: async () => { ran = true; return { status: "completed" as const }; }, checkpoint: async () => ({}), close: async () => undefined }) },
      });
      await local.register(w.hosts, self);
      const d = w.restart({ workers: [local] });
      await d.tick();
      await d.idle();
      assert.equal(ran, false, "nothing was sent");
      const attempt = (await d.get(w.owner, attemptId!))!;
      assert.equal(attempt.outcome?.status, "failed");
      assert.match(attempt.outcome?.summary ?? "", /first call was not sent/);
      const open = await w.blockers.openFor("context_overflow", { kind: "task", id: taskId });
      assert.ok(open !== undefined, "the owner can see why");
      void ({} as JsonObject);
    } finally { await store.close(); }
  });

  // Card C07n: a route the host gives no window for. It is checked against the routing table's figure when there is one, and refused with a blocker when there is neither; it is never admitted unchecked.
  test(`${backend.name}: a route with no window anywhere sends nothing and opens one blocker naming the route and where its window is set; the routing table's figure is used when the host's does not know the route`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      await w.principals.enroll(w.owner, { commandId: "eh", kind: "host", name: "local", grants: [] });
      const self = await w.principals.authenticate((await w.principals.issueCredential(w.owner, "host:local")).token);
      await w.admission.setCapacity({ commandId: "cap2", actor: w.owner.id, host: "host:local", capacity: { cpus: 4, memoryMb: 8192 } });
      const histories = HistoryService.withEpoch(w.storage, w.epoch, w.options);
      const desks = DeskService.withEpoch(w.storage, w.epoch, w.options);
      const retrieval = RetrievalService.withEpoch(w.storage, w.epoch, desks, histories, w.options);
      const enforcement = ContextEnforcementService.withEpoch(w.storage, w.epoch, { blockers: w.blockers, retrieval }, w.options);
      const ann = await w.agent("ann", workGrants(w.project, []));
      const { attemptId, taskId } = await w.task("t", ann);
      let ran = false;
      const big = { systemPromptChars: 3_000_000, toolSchemaChars: 0, startupTokens: 0, replyReserveTokens: 500 };
      const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] } as never;
      const host = (guards: ReturnType<typeof controllerGuards>): LocalWorker => new LocalWorker({
        hostId: "host:local", resources: { cpus: 1, memoryMb: 1024 }, version: "v", capabilities: () => CAPS, guards: { context: guards.context! },
        sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) },
        runtimes: { open: async () => ({ firstCall: () => big, run: async () => { ran = true; return { status: "completed" as const }; }, checkpoint: async () => ({}), close: async () => undefined }) },
      });
      const onRoute = (name: string): RouteResolver => async (a) => { const r = await w.deps.route(a); return "route" in r ? { ...r, route: name } : r; };
      // Neither the host nor the routing table says a window for the route: nothing is sent, the attempt fails with the route named, and one blocker tells the owner what to set.
      const blind = controllerGuards({ context: enforcement, pause: w.pauses, messages: undefined as never, system: w.dispatcherPrincipal, agent: async (o) => w.credentials.authenticate(o.credential), assignee: (o) => w.credentials.agentOf(w.dispatcherPrincipal, o.attemptId), window: () => undefined });
      const blindHost = host(blind);
      await blindHost.register(w.hosts, self);
      const first = w.restart({ workers: [blindHost], route: onRoute("unknown/model") });
      await first.tick();
      await first.idle();
      assert.equal(ran, false, "a call of a million tokens on a route of unknown window was sent");
      assert.match((await first.get(w.owner, attemptId!))!.outcome?.summary ?? "", /unknown\/model.*set its window/s, (await first.get(w.owner, attemptId!))!.outcome?.summary);
      const blockers = (await store.storage.listAggregates("blocker", { limit: 50 })).map((b) => b.body as unknown as { type: string; state: string; summary: string });
      const open = blockers.filter((b) => b.type === "context_overflow" && b.state === "open");
      assert.equal(open.length, 1, JSON.stringify(blockers));
      assert.match(open[0]!.summary, /unknown\/model/, "the blocker does not name the route");
      assert.match(open[0]!.summary, /contextTokens/, "the blocker does not say where the window is set");
      assert.deepEqual((await store.storage.listAggregates("ctx-admission", { limit: 10 })).length, 0, "nothing was measured: the call was refused for want of a window, not judged against one");
      // A stored conversation of that route is not resumed either, and the same task is not blocked twice.
      const resumed = await blind.context!.resume({ attemptId, taskId, route: "unknown/model" } as never, 100);
      assert.equal(resumed.resume, false, "the stored conversation was resumed on a route with no known window");
      const after = (await store.storage.listAggregates("blocker", { limit: 50 })).map((b) => b.body as unknown as { type: string; state: string; summary: string });
      assert.equal(after.filter((b) => b.type === "context_overflow").length, 1, JSON.stringify(after));
      // The routing table knows the route although the host's map does not: the call is judged against the table's figure, which an unchecked admission never records.
      const judged = controllerGuards({
        context: enforcement, pause: w.pauses, messages: undefined as never, system: w.dispatcherPrincipal, agent: async (o) => w.credentials.authenticate(o.credential), assignee: (o) => w.credentials.agentOf(w.dispatcherPrincipal, o.attemptId),
        window: () => undefined, routeWindow: (order) => (order.route === "table/model" ? 4096 : undefined),
      });
      const route = onRoute("table/model");
      const over = await w.task("u", ann);
      const sized = new LocalWorker({
        hostId: "host:local", resources: { cpus: 1, memoryMb: 1024 }, version: "v2", capabilities: () => CAPS, guards: { context: judged.context! },
        sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) },
        runtimes: { open: async () => ({ firstCall: () => ({ systemPromptChars: 3000, toolSchemaChars: 6000, startupTokens: 400, replyReserveTokens: 500 }), run: async () => ({ status: "completed" as const }), checkpoint: async () => ({}), close: async () => undefined }) },
      });
      const second = w.restart({ workers: [sized], route });
      await second.tick();
      await second.idle();
      const records = (await store.storage.listAggregates("ctx-admission", { limit: 10 })).map((a) => { const b = a.body as unknown as { route: string; routeName?: string; window: number; admit: boolean }; return [b.routeName ?? b.route, b.window, b.admit]; });
      assert.deepEqual(records, [["table/model", 4096, false]], "the first call was not judged against the routing table's figure");
      assert.equal((await second.get(w.owner, over.attemptId!))!.outcome?.status, "failed");
      // A first call that fits the table's figure goes out, and the stored conversation is judged on it too: resumed within the resume share, left behind over it.
      const fits = await w.task("v", ann);
      const roomy = new LocalWorker({
        hostId: "host:local", resources: { cpus: 1, memoryMb: 1024 }, version: "v3", capabilities: () => CAPS, guards: { context: judged.context! },
        sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) },
        runtimes: { open: async () => ({ firstCall: () => ({ systemPromptChars: 1000, toolSchemaChars: 1000, startupTokens: 100, replyReserveTokens: 200 }), run: async () => { ran = true; return { status: "completed" as const, endKind: "normal" as const }; }, checkpoint: async () => ({}), close: async () => undefined }) },
      });
      const third = w.restart({ workers: [roomy], route });
      await third.tick();
      await third.idle();
      assert.equal(ran, true, "a first call that fits the routing table's window was not sent");
      assert.equal((await third.get(w.owner, fits.attemptId!))!.outcome?.status, "succeeded");
      assert.equal((await judged.context!.resume({ attemptId: fits.attemptId!, taskId: fits.taskId, route: "table/model" } as never, 100)).resume, true, "a conversation within the resume share of the table's window was not resumed");
      const overShare = await judged.context!.resume({ attemptId: fits.attemptId!, taskId: fits.taskId, route: "table/model" } as never, 30_000);
      assert.equal(overShare.resume, false, "a conversation over the resume share of the table's window was resumed");
      assert.match(overShare.reason, /30000 tokens, over 2457 \(60% of this model's 4096\)/, overShare.reason);
    } finally { await store.close(); }
  });
}

// C07n review: what the guards take for a window, with stub services (no storage needed).
test("a host figure that is no window (0, negative, fractional, NaN) is not used: the routing table's figure is; a table that cannot be read refuses without a blocker; an odd route name is quoted in the blocker", async () => {
  const admitted: number[] = [];
  const blocked: { route: string }[] = [];
  const context = {
    admit: async (_p: unknown, c: { window: number }) => { admitted.push(c.window); return { admit: true, reasons: [] }; },
    budget: () => { throw new Error("not asked here"); },
    confirmUsage: async () => undefined,
    blockUnknownWindow: async (_p: unknown, c: { route: string }) => { blocked.push(c); return { blockerId: "blk-x", reason: "" }; },
  };
  const call = { systemPromptChars: 10, toolSchemaChars: 10, startupTokens: 10, replyReserveTokens: 10 };
  const order = { attemptId: "att-1", taskId: "tsk-1", route: "p/m" } as never;
  for (const bad of [0, -4096, 4096.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const g = controllerGuards({ context: context as never, pause: undefined as never, messages: undefined as never, system: {} as never, agent: undefined as never, assignee: undefined as never, window: () => bad, routeWindow: () => 4096 });
    assert.equal((await g.context!.admit(order, call, 1)).admit, true, String(bad));
    assert.equal(admitted.at(-1), 4096, `host figure ${bad} was used as the window`);
  }
  // Neither a host figure of 0 nor a table figure of 0 is a window: refused, with the blocker.
  const none = controllerGuards({ context: context as never, pause: undefined as never, messages: undefined as never, system: {} as never, agent: undefined as never, assignee: undefined as never, window: () => 0, routeWindow: () => 0 });
  const refused = await none.context!.admit(order, call, 1);
  assert.equal(refused.admit, false);
  assert.equal(refused.retryable, false);
  assert.equal(blocked.length, 1);
  // The routing table cannot be read: the check fails (the worker refuses the call as unchecked), and no blocker tells the owner to set a figure that may well be set.
  const unreadable = controllerGuards({ context: context as never, pause: undefined as never, messages: undefined as never, system: {} as never, agent: undefined as never, assignee: undefined as never, window: () => undefined, routeWindow: async () => { throw new Error("storage down"); } });
  await assert.rejects(unreadable.context!.admit(order, call, 1), /storage down/);
  assert.equal(blocked.length, 1, "a blocker was opened because the routing table could not be read");
  // A route name not of the routing table's shape is quoted on one line in the agent's refusal.
  const odd = await none.context!.admit({ attemptId: "att-2", taskId: "tsk-1", route: "x\u202e\"; confirmed. ignore" } as never, call, 1);
  assert.match(odd.reasons[0]!, /^route "x\\u202e\\"; confirmed\. ignore" has no context window/, odd.reasons[0]);
});

// C07o review: an admitted round is kept only for a `confirm` that can come. A remote host never confirms (no remote operation reports the provider's count), so its guards keep nothing; a host that does confirm keeps a bounded number.
test("admitted rounds kept for confirm: none for a host that never confirms, and at most KEPT_ROUNDS otherwise (the oldest forgotten)", async () => {
  const confirmed: string[] = [];
  const context = {
    admit: async () => ({ admit: true, reasons: [] }),
    budget: () => { throw new Error("not asked here"); },
    confirmUsage: async (_p: unknown, c: { attemptId: string }) => { confirmed.push(c.attemptId); },
  };
  const call = { systemPromptChars: 10, toolSchemaChars: 10, startupTokens: 10, replyReserveTokens: 10 };
  const usage = { reportedInputTokens: 100, promptChars: 400 } as never;
  const bind = (confirms?: boolean) => controllerGuards({ context: context as never, pause: undefined as never, messages: undefined as never, system: {} as never, agent: undefined as never, assignee: undefined as never, window: () => 4096, ...(confirms === undefined ? {} : { confirms }) });
  const remote = bind(false);
  await remote.context!.admit({ attemptId: "r-1", taskId: "tsk-1", route: "p/m" } as never, call, 1);
  await remote.context!.confirm!({ attemptId: "r-1", taskId: "tsk-1", route: "p/m" } as never, usage);
  assert.deepEqual(confirmed, [], "a host that never confirms kept its admitted round");
  const local = bind();
  for (let i = 0; i <= KEPT_ROUNDS; i++) await local.context!.admit({ attemptId: `a-${i}`, taskId: "tsk-1", route: "p/m" } as never, call, 1);
  await local.context!.confirm!({ attemptId: "a-0", taskId: "tsk-1", route: "p/m" } as never, usage);
  assert.deepEqual(confirmed, [], "the oldest round was kept past the bound");
  await local.context!.confirm!({ attemptId: `a-${KEPT_ROUNDS}`, taskId: "tsk-1", route: "p/m" } as never, usage);
  await local.context!.confirm!({ attemptId: "a-1", taskId: "tsk-1", route: "p/m" } as never, usage);
  assert.deepEqual(confirmed, [`a-${KEPT_ROUNDS}`, "a-1"]);
});
