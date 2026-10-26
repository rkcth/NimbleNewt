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
import { controllerGuards } from "./runtime-guards.js";
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
      const after = await storage.listAggregates("ctx-admission", { limit: 10 });
      assert.equal(after.length, 2);
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
}
