import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ArtifactService, FileBlobStore } from "../artifacts/index.js";
import {
  ASSIGNMENT_EVENTS, AssignmentService, BlockerService, ConversationBridge, EffectService, InboxService, RecoveryPoints, Reconciler, TASK_EVENTS, assignmentEventId, derivedId, inboxMessageId, taskEventId,
  type BridgeRun, type ConversationSubmitter, type Delivery, type EffectBridge, type Fence, type Owner,
} from "../domain/index.js";
import { ProjectService } from "../domain/service.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import type { Chaos } from "./chaos.js";

export const WORKER: Owner = { kind: "agent", id: "worker-1" };
export const T = "2026-10-20T10:00:00.000Z";

/** A clock that moves on every reading (so leases of a dead process end) and can be pushed forward (the time a restart takes). */
export class Clock {
  #ms = Date.parse(T);
  readonly now = (): string => new Date(this.#ms++ * 1).toISOString();
  advance(ms: number): void { this.#ms += ms; }
}

/** Where the "outside world" lives: a file with one line per application of the effect, and the artifact blob folder. */
export interface SliceWorld {
  readonly storage: ControllerStorage;
  readonly directory: string;
  readonly chaos: Chaos;
  readonly clock: () => string;
  /** The conversation the worker's model step talks to. Default: a durable stand-in that records each distinct request once. A real runtime can be supplied. */
  readonly conversation?: (world: SliceWorld) => ConversationSubmitter;
}

export const ANSWER = "20 packets of seed";

/** A durable stand-in for a model conversation: idempotent by request ID (a request already recorded is answered, not run again) and killable like everything else. */
export function fakeConversation(world: SliceWorld): ConversationSubmitter {
  const file = join(world.directory, "conversation.log");
  const recorded = (): string[] => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
  return {
    submit: async (request) => {
      world.chaos.alive();
      world.chaos.hit("conversation: before the request is recorded");
      if (!recorded().includes(request.requestId)) appendFileSync(file, `${request.requestId}\n`);
      world.chaos.hit("conversation: request recorded, answer not yet read");
      return { result: async () => ({ status: "completed", text: ANSWER }) };
    },
    lookup: async (requestId) => (recorded().includes(requestId) ? { status: "completed", text: ANSWER } : undefined),
  };
}

export const conversationRequests = (dir: string): string[] => (existsSync(join(dir, "conversation.log")) ? readFileSync(join(dir, "conversation.log"), "utf8").split("\n").filter(Boolean) : []);

export interface Slice {
  readonly projects: ProjectService;
  readonly assign: AssignmentService;
  readonly inbox: InboxService;
  readonly effects: EffectService;
  readonly artifacts: ArtifactService;
  readonly blockers: BlockerService;
  readonly reconciler: Reconciler;
  readonly recovery: RecoveryPoints;
  readonly bridge: ConversationBridge;
  readonly taskEvents: string[];
  readonly ids: { project: string; task: string; effect: string; messageId: string; attemptId: string };
}

// The bridge needs the world; the slice carries it privately so `runPath` has one argument.
const worlds = new WeakMap<Slice, SliceWorld>();

const outsideLog = (dir: string): string => join(dir, "outside.log");
export const executedLines = (dir: string): string[] => (existsSync(join(dir, "executed.log")) ? readFileSync(join(dir, "executed.log"), "utf8").split("\n").filter(Boolean) : []);
export const outsideLines = (dir: string): string[] => (existsSync(outsideLog(dir)) ? readFileSync(outsideLog(dir), "utf8").split("\n").filter(Boolean) : []);

/** The push target: honours the idempotency key. Its two steps are crash boundaries: before it applies the effect, and after it applied it and before it answers. */
const target = (world: SliceWorld): EffectBridge => ({
  idempotent: true,
  execute: async (request) => {
    world.chaos.hit("outside: before applying the effect");
    // Every call that reaches the target is logged raw, so a second execution would show even though the target itself dedupes by key.
    appendFileSync(join(world.directory, "executed.log"), `${request.key}\n`);
    if (!outsideLines(world.directory).includes(request.key)) appendFileSync(outsideLog(world.directory), `${request.key}\n`);
    world.chaos.hit("outside: after applying the effect, before answering");
    return { receipt: `pushed ${request.key}` };
  },
  reconcile: async (request) => ({ state: outsideLines(world.directory).includes(request.key) ? "applied" : "not_applied" }),
});

/** A process start: a new primary epoch (earlier processes are fenced out) and fresh services over the same storage, blob folder and outside world. */
export async function startProcess(world: SliceWorld, holder: string): Promise<Slice> {
  const storage = world.chaos.wrap(world.storage);
  const options = { clock: world.clock, pause: async () => undefined };
  const projects = await ProjectService.open(storage, { holder, ...options });
  const epoch = projects.epoch;
  const assign = AssignmentService.withEpoch(storage, epoch, projects, options);
  const inbox = InboxService.withEpoch(storage, epoch, assign, options);
  const effects = EffectService.withEpoch(storage, epoch, assign, { ...options, holder, leaseMs: 1 });
  const blockers = BlockerService.withEpoch(storage, epoch, options);
  const blobs = await FileBlobStore.open({ directory: join(world.directory, "blobs"), testHooks: { afterTempWrite: () => world.chaos.hit("blob: written to a temporary file"), afterRename: () => world.chaos.hit("blob: named") } });
  // The blob folder is part of the outside world: a dead process cannot write to it.
  const gatedBlobs = new Proxy(blobs, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver) as unknown;
      return typeof value === "function" ? (...args: unknown[]) => { world.chaos.alive(); return (value as (...a: unknown[]) => unknown).apply(target, args); } : value;
    },
  });
  const artifacts = ArtifactService.withEpoch(storage, epoch, gatedBlobs, options);
  const recovery = new RecoveryPoints(storage, epoch, options);
  const taskEvents: string[] = [];
  const reconciler = new Reconciler(storage, epoch, {
    projects, inbox, effects, blockers, bridges: { "git-push": target(world) },
    destinations: [
      { name: TASK_EVENTS, handler: async (d: Delivery) => { taskEvents.push(d.deliveryId); } },
      { name: ASSIGNMENT_EVENTS, handler: inbox.handler("worker-1") },
    ],
  }, { ...options, claimant: holder });
  const project = derivedId("proj", "slice-project");
  const task = derivedId("task", "slice-task");
  const bridge = new ConversationBridge({ inbox, projects, assign, blockers }, world.conversation?.(world) ?? fakeConversation(world), { boundary: (label) => world.chaos.hit(label) });
  const slice: Slice = {
    projects, assign, inbox, effects, artifacts, blockers, reconciler, recovery, bridge, taskEvents,
    ids: { project, task, effect: derivedId("eff", "slice-effect"), messageId: inboxMessageId("worker-1", assignmentEventId(task, 1)), attemptId: derivedId("att", `adm:${inboxMessageId("worker-1", assignmentEventId(task, 1))}`) },
  };
  worlds.set(slice, world);
  return slice;
}

/** Passes until a pass finds nothing to do (bounded). The reconciler is what finds work after a dropped wake-up or a restart. */
async function settle(slice: Slice): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const r = await slice.reconciler.runPass();
    const worked = Object.values(r.delivered).reduce((a, b) => a + b, 0) + r.inboxAdmitted + r.effectsRun + r.eventsRepaired;
    if (worked === 0) return;
  }
}

/**
 * The whole path, from a chat-command stub to a worker result, as fixed commands: running it again after any crash completes it exactly once.
 * 1. chat: create project, create task, make it ready, assign it to the worker (what an owner's chat command does);
 * 2. controller: deliver the assignment, the worker's inbox receives it and admits the attempt (the reconciler pass);
 * 3. worker, under its fence: start the task, perform the outside effect through the ledger, publish the result artifact, complete the task,
 *    finish the attempt;
 * 4. controller: deliver what is left (events) until nothing is pending.
 */
export async function runPath(slice: Slice): Promise<void> {
  const { projects, assign, effects, artifacts, ids } = slice;
  const me = "owner-chat";
  await projects.createProject({ commandId: "slice-project", actor: me, name: "Garden", goal: "Plan the beds" });
  await projects.createTask({ commandId: "slice-task", actor: me, projectId: ids.project, title: "Order seeds", description: "from the supplier" });
  await projects.transitionTask({ commandId: "slice-ready", actor: me, taskId: ids.task, expectedRevision: 1, to: "ready" });
  await assign.assignTask({ commandId: "slice-assign", actor: me, taskId: ids.task, owner: WORKER });
  await settle(slice);

  const fence: Fence = { generation: 1, attemptId: ids.attemptId };
  const w = "worker-1";
  await assign.transitionTask({ commandId: "slice-start", actor: w, taskId: ids.task, expectedRevision: 2, to: "in_progress", fence });
  // The worker's model step: the controller's inbox bridge submits the admitted attempt's work to the conversation, once.
  const run: BridgeRun = await slice.bridge.run(ids.messageId);
  await effects.intend({ commandId: "slice-effect", actor: w, kind: "git-push", target: "repo:main", input: { commit: "abc123" } as JsonObject, taskId: ids.task, fence });
  await effects.run(ids.effect, target(slice_world(slice)));
  const published = await artifacts.publish({ commandId: "slice-artifact", actor: w, name: "order", projectId: ids.project, taskId: ids.task, files: [{ path: "order.txt", content: Buffer.from(run.text) }, { path: "receipt.txt", content: Buffer.from("pushed abc123") }] });
  await slice.recovery.record({ commandId: "slice-recovery", actor: w, attemptId: ids.attemptId, taskId: ids.task, requestIds: [run.requestId], artifactId: published.id, ...(run.checkpoint === undefined ? {} : { checkpoint: run.checkpoint }), resultText: run.text });
  await assign.transitionTask({ commandId: "slice-done", actor: w, taskId: ids.task, expectedRevision: 3, to: "done", fence });
  await assign.finishAttempt({ commandId: "slice-finish", actor: w, taskId: ids.task, expectedRevision: 2, fence, outcome: "succeeded", summary: "ordered" });
  await settle(slice);
}

function slice_world(slice: Slice): SliceWorld { return worlds.get(slice)!; }

/** What must be true of the finished state, however many times the process died on the way. */
export async function check(slice: Slice, world: SliceWorld, crashLabel?: string): Promise<string[]> {
  const { projects, assign, effects, artifacts, blockers, ids } = slice;
  const problems: string[] = [];
  const expect = (ok: boolean, what: string) => { if (!ok) problems.push(what); };
  const task = await projects.getTask(ids.task);
  expect(task?.state === "done", `task is ${task?.state}, not done`);
  expect((await projects.listProjects({ limit: 10 })).length === 1, "not exactly one project");
  expect((await projects.listTasks({ limit: 10 })).items.length === 1, "not exactly one task");
  const assignment = await assign.getAssignment(ids.task);
  expect(assignment?.generation === 1 && assignment.state === "assigned" && assignment.owner?.id === WORKER.id && assignment.attempts === 1 && assignment.activeAttemptId === undefined, `assignment disagrees: ${JSON.stringify(assignment)}`);
  expect((await assign.history(ids.task)).length === 1, "not exactly one generation");
  const attempt = await assign.getAttempt(ids.attemptId);
  expect(attempt?.state === "succeeded" && attempt.generation === assignment?.generation && attempt.number === 1, `attempt disagrees: ${JSON.stringify(attempt)}`);
  const effect = await effects.get(ids.effect);
  expect(effect?.status === "confirmed", `effect is ${effect?.status}`);
  const lines = outsideLines(world.directory);
  expect(lines.length === 1 && lines[0] === ids.effect, `the outside world holds ${lines.length} application(s): ${lines.join(",")}`);
  const artifactList = await artifacts.list({ limit: 10 });
  expect(artifactList.length === 1, `${artifactList.length} artifacts`);
  for (const a of artifactList) expect((await artifacts.verify(a.id)).ok, "artifact does not verify");
  // Raw: how many times anything reached the target at all (the target itself dedupes by key, so this is the number that could catch a second execution).
  expect(executedLines(world.directory).length === 1, `the target was reached ${executedLines(world.directory).length} time(s)`);
  const requests = conversationRequests(world.directory);
  expect(world.conversation !== undefined || (requests.length === 1 && requests[0] === `cmd:adm:${ids.messageId}`), `the conversation holds ${requests.length} request(s): ${requests.join(",")}`);
  const point = await slice.recovery.forAttempt(ids.attemptId);
  expect(point !== undefined && point.requestIds.length === 1 && point.requestIds[0] === `cmd:adm:${ids.messageId}` && point.resultText === ANSWER && point.artifactId === derivedId("art", "slice-artifact"), `recovery point disagrees: ${JSON.stringify(point)}`);
  const file = await artifacts.readFile(derivedId("art", "slice-artifact"), "order.txt").then((b) => Buffer.from(b).toString(), () => undefined);
  expect(file === ANSWER, `the artifact holds ${JSON.stringify(file)}`);
  const tmp = join(world.directory, "blobs", "tmp");
  const stray = existsSync(tmp) ? readdirSync(tmp) : [];
  expect(stray.length === 0 || (crashLabel?.startsWith("blob: written to a temporary file") ?? false), `${stray.length} stray temporary blob file(s) after a crash at ${crashLabel ?? "no crash"}`);
  // Nothing more was announced than the path calls for.
  for (const id of [taskEventId(ids.task, 5), assignmentEventId(ids.task, 4)]) expect((await world.storage.getDelivery(id)) === undefined, `unexpected delivery ${id}`);
  const open = await blockers.list({ limit: 10, openOnly: true });
  expect(open.items.length === 0, `open blockers: ${open.items.map((b) => b.type).join(",")}`);
  // Every message was delivered and the receiving side holds each once.
  for (const id of [taskEventId(ids.task, 1), taskEventId(ids.task, 2), taskEventId(ids.task, 3), taskEventId(ids.task, 4), assignmentEventId(ids.task, 1), assignmentEventId(ids.task, 2), assignmentEventId(ids.task, 3)]) {
    const d = await world.storage.getDelivery(id);
    expect(d?.state === "delivered", `delivery ${id} is ${d?.state}`);
  }
  const message = await slice.inbox.getMessage(ids.messageId);
  expect(message?.state === "admitted" && message.admission?.attemptId === ids.attemptId, `inbox message is ${message?.state}`);
  return problems;
}

/**
 * The finished state, to compare a crashed-and-recovered run with a clean one: every aggregate kind the path touches (body and revision, with
 * timestamps and the runtime's opaque checkpoint left out), how many times each one-per-command audit record was written, and the blob files. Left out on purpose: scan cursors
 * (their position depends on how many passes ran) and the effect record's revision and claim (a crash during execution legitimately adds claim
 * cycles).
 */
export async function signature(world: SliceWorld): Promise<string> {
  const rows: string[] = [];
  const kinds = ["project", "task", "assignment", "assignment-generation", "attempt", "effect", "artifact", "inbox-message", "blocker", "blocker-slot", "wait", "wait-slot", "recovery-point", "delivery-failures"];
  for (const kind of kinds) {
    for (const a of await world.storage.listAggregates(kind, { limit: 1000 })) {
      const body = JSON.parse(JSON.stringify(a.body, (key, value: unknown) => (key.endsWith("At") || key === "until" || key === "claim" || key === "checkpoint" ? undefined : value))) as unknown;
      rows.push(`${kind} ${a.id}${kind === "effect" ? "" : ` r${a.revision}`} ${JSON.stringify(body)}`);
    }
  }
  const counts = new Map<string, number>();
  for (let after = 0; ;) {
    const page = await world.storage.listAudit({ afterSeq: after, limit: 1000 });
    for (const r of page) { counts.set(r.type, (counts.get(r.type) ?? 0) + 1); after = r.seq; }
    if (page.length < 1000) break;
  }
  for (const type of ["project.create", "task.create", "task.transition", "task.assign", "attempt.admit", "attempt.finish", "inbox.receive", "inbox.admit", "effect.intend", "artifact.publish", "recovery-point.record", "delivery.receipt"]) rows.push(`audit ${type} ${counts.get(type) ?? 0}`);
  const blobDir = join(world.directory, "blobs");
  const files: string[] = [];
  const walk = (dir: string): void => { for (const e of readdirSync(dir, { withFileTypes: true })) { if (e.name === "tmp") continue; if (e.isDirectory()) walk(join(dir, e.name)); else files.push(e.name); } };
  if (existsSync(blobDir)) walk(blobDir);
  rows.push(`blobs ${files.sort().join(",")}`);
  return rows.sort().join("\n");
}
