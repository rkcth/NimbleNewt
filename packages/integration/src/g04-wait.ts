import { ASSIGNMENT_EVENTS, Reconciler, TASK_EVENTS, WaitService, type ControllerStorage, type Delivery } from "@nimblenewt/controller";
import * as harness from "@nimblenewt/controller/testing";
import { Chaos, Clock as ClockImpl, OperationSpy, operationsOf, startProcess, type Clean, type Clock, type Slice, type SliceWorld } from "./g04-fixture.js";

// Card G04, waits. Production services only (S08 WaitService and Reconciler over the slice's database); the scenario is a fixed list of commands, so running it again after
// any kill completes it exactly once.

const OWNER = "owner-chat";
export const DEADLINE = "2026-10-20T10:01:00.000Z";

export interface WaitServices { readonly waits: WaitService; readonly reconciler: Reconciler; readonly storage: ControllerStorage }

/** The wait service and a reconciler that also settles waits, over the same (chaos-wrapped) database and epoch as the slice's other services. */
export function waitServices(slice: Slice, world: SliceWorld, holder = "waits"): WaitServices {
  const storage = world.chaos.wrap(world.storage);
  const options = { clock: world.clock, pause: async () => undefined };
  const epoch = slice.projects.epoch;
  const waits = WaitService.withEpoch(storage, epoch, slice.assign, options);
  const reconciler = new Reconciler(storage, epoch, {
    projects: slice.projects, inbox: slice.inbox, effects: slice.effects, blockers: slice.blockers, waits, bridges: {},
    destinations: [{ name: TASK_EVENTS, handler: async (_d: Delivery) => undefined }, { name: ASSIGNMENT_EVENTS, handler: slice.inbox.handler("worker-1") }],
  }, { ...options, claimant: holder });
  return { waits, reconciler, storage };
}

export async function settleWaits(services: WaitServices): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const r = await services.reconciler.runPass();
    const worked = Object.values(r.delivered).reduce((a, b) => a + b, 0) + r.eventsRepaired + r.waitsTimedOut + r.waitsOrphaned + r.blockersOpened + r.unexplainedBlocks;
    if (worked === 0) return;
  }
}


/** Two tasks, one wait without a deadline (an owner has it) and one that falls due. Returns the wait IDs. */
export async function openWaits(slice: Slice, services: WaitServices): Promise<{ a: string; b: string; taskA: string; taskB: string }> {
  const { projects } = slice;
  const p = await projects.createProject({ commandId: "wait-project", actor: OWNER, name: "Beds", goal: "Decide about the old beds" });
  const make = async (label: string) => {
    const t = await projects.createTask({ commandId: `wait-task-${label}`, actor: OWNER, projectId: p.id, title: `Task ${label}`, description: "waits for the owner" });
    await projects.transitionTask({ commandId: `wait-ready-${label}`, actor: OWNER, taskId: t.id, expectedRevision: 1, to: "ready" });
    return t.id;
  };
  const taskA = await make("A");
  const taskB = await make("B");
  const base = { actor: OWNER, reason: "approval" as const, resolver: "owner", summary: "may I delete the old beds?", nextAction: "delete the beds and continue" };
  const a = await services.waits.openWait({ ...base, commandId: "wait-open-A", taskId: taskA, indefinite: { owner: "rob" } });
  const b = await services.waits.openWait({ ...base, commandId: "wait-open-B", taskId: taskB, deadline: DEADLINE, onDeadline: "resume" });
  return { a: a.id, b: b.id, taskA, taskB };
}

/** The whole scenario as fixed commands: open both waits, let time pass beyond the deadline, settle, answer the other wait. */
export async function waitScenario(slice: Slice, world: SliceWorld, clock: Clock): Promise<void> {
  const services = waitServices(slice, world);
  const opened = await openWaits(slice, services);
  clock.advance(2 * 60_000);
  await settleWaits(services);
  await services.waits.answerWait({ commandId: "wait-answer-A", actor: "rob", waitId: opened.a, expectedRevision: 1, resolverId: "owner", answer: "yes, delete them" });
  await settleWaits(services);
}

const WAIT_AUDIT = ["wait.open", "wait.answer", "wait.deadline", "wait.cancel"];

/** The audit records of waits, counted: each is written once however often the scenario ran. */
export async function waitAuditCounts(storage: ControllerStorage): Promise<string> {
  const counts = new Map<string, number>();
  for (let after = 0; ;) {
    const page = await storage.listAudit({ afterSeq: after, limit: 1000 });
    for (const r of page) { counts.set(r.type, (counts.get(r.type) ?? 0) + 1); after = r.seq; }
    if (page.length < 1000) break;
  }
  return WAIT_AUDIT.map((t) => `${t}=${counts.get(t) ?? 0}`).join(" ");
}

/** What must be true of the finished scenario, however many times the process died on the way. */
export async function checkWaits(slice: Slice, world: SliceWorld): Promise<string[]> {
  const problems: string[] = [];
  const expect = (ok: boolean, what: string) => { if (!ok) problems.push(what); };
  const services = waitServices(slice, world, "checker");
  const tasks = (await slice.projects.listTasks({ limit: 10 })).items;
  expect(tasks.length === 2, `${tasks.length} tasks`);
  expect(tasks.every((t) => t.state === "ready"), `task states: ${tasks.map((t) => t.state).join(",")}`);
  const all = await world.storage.listAggregates("wait", { limit: 10 });
  expect(all.length === 2, `${all.length} waits`);
  const outcomes = all.map((w) => (w.body as { state: string; outcome?: string }).outcome).sort();
  expect(outcomes.join(",") === "resumed,timed_out_resumed", `wait outcomes: ${outcomes.join(",")}`);
  for (const w of all) expect((await services.waits.openFor((w.body as { taskId: string }).taskId)) === undefined, "a task still has an open wait");
  const counts = await waitAuditCounts(world.storage);
  expect(counts === "wait.open=2 wait.answer=1 wait.deadline=1 wait.cancel=0", `wait audit records: ${counts}`);
  const open = await slice.blockers.list({ limit: 10, openOnly: true });
  expect(open.items.length === 0, `open blockers: ${open.items.map((b) => b.type).join(",")}`);
  for (const w of all) {
    const timer = await world.storage.getTimer(`wt:${w.id}`);
    const deadline = (w.body as { deadline?: string }).deadline;
    expect(deadline === undefined ? timer === undefined : timer?.state === "completed", `timer of ${w.id}: ${timer?.state}`);
  }
  return problems;
}

export const waitSignature = async (world: SliceWorld): Promise<string> => `${await harness.signature(world)}\n${await waitAuditCounts(world.storage)}`;

/** An uncrashed run of the wait scenario on a database, with its boundaries, operations and final state. */
export async function cleanWaitRun(storage: ControllerStorage, directory: string): Promise<Clean> {
  const spy = new OperationSpy();
  const chaos = new Chaos();
  const clock = new ClockImpl();
  const world: SliceWorld = { storage: spy.wrap(storage), directory, chaos, clock: clock.now };
  const slice = await startProcess(world, "child");
  await waitScenario(slice, world, clock);
  const problems = await checkWaits(slice, world);
  if (problems.length > 0) throw new Error(`the uncrashed wait scenario is wrong: ${problems.join("; ")}`);
  return { labels: [...chaos.labels], operations: await operationsOf(storage, spy, chaos.labels), signature: await waitSignature(world) };
}
