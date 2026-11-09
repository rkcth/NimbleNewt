import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService } from "../admission/index.js";
import { LocalWorker, type AttemptRuntime } from "../dispatch/local-worker.js";
import type { RouteResolver, WorkerHost } from "../dispatch/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { EXEC_PROFILES, PI, workGrants } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { HostService } from "../hosts/index.js";
import type { Principal } from "../security/principals.js";
import { PolicyService } from "../policy/index.js";
import { DifficultyService } from "../routing/index.js";
import type { JsonObject } from "../storage/types.js";
import { startController, type Controller } from "./index.js";
import type { DispatchStartOptions } from "./dispatch-compose.js";

/**
 * Card C07n through the composed controller. The host's own window map says nothing about the routes work is placed on (which is what an operator whose map has not caught up with the routing table looks like),
 * and no `local.storedTokens` reader is passed. Every first call must still be checked against what the owner configured for the route, every stored conversation judged before it is carried into a new process,
 * and a route neither says must refuse the work visibly rather than admit it unchecked.
 */
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const ANN = "agt-annannannannannannan";
/** What the routing table says the route's window is; the host's own map never mentions the route. A 4096-token window starts 1024 tokens and resumes 2457. */
const WINDOW = 4096;
const table = {
  providers: { localp: { enabled: true, paid: false, location: "local" }, localq: { enabled: true, paid: false, location: "local" } },
  routes: { "localp/small": { contextTokens: WINDOW, capabilities: ["tools"] }, "localq/small": { contextTokens: WINDOW, capabilities: ["tools"] } },
  profiles: { "r-local": ["localp/small", "localq/small"] },
  roles: { coordinator: "r-local", "safety-supervisor": "r-local" },
};
const BIG = { systemPromptChars: 3_000_000, toolSchemaChars: 0, startupTokens: 0, replyReserveTokens: 500 };
const SMALL = { systemPromptChars: 1000, toolSchemaChars: 1000, startupTokens: 100, replyReserveTokens: 200 };
type BuildServices = Parameters<NonNullable<DispatchStartOptions["local"]>["build"]>[0];
interface Opened { readonly attemptId: string; readonly route: string; readonly from: JsonObject | undefined; readonly content?: string }
interface Rig extends RigOptions {
  readonly c: Controller;
  readonly owner: Principal;
  readonly ownerToken: string;
  readonly project: string;
  readonly opened: Opened[];
  readonly ran: string[];
  readonly guardErrors: string[];
  readonly services: BuildServices;
}
interface RigOptions {
  firstCall: () => { systemPromptChars: number; toolSchemaChars: number; startupTokens: number; replyReserveTokens: number };
  checkpoint: (attemptId: string) => JsonObject;
  /** The model process never finishes a turn on its own (the controller is brought down in the middle of it). */
  hang?: boolean;
  route?: RouteResolver;
  /** The embedder's own reader of a checkpoint's size: it answers 40,000 tokens for any checkpoint, whatever that checkpoint holds. */
  reader?: boolean;
  /** A controller brought up over a store another one already configured: the owner's setup is already there, only the host has to be seen again. */
  restarted?: boolean;
  /** The owner's credential from the controller that first configured this store. */
  ownerToken?: string;
  project?: string;
}

/** A local worker with the controller's own guards, a sandbox that holds nothing, and a model process that says how big its first call is and what its checkpoint holds. */
async function rig(dir: string, options: RigOptions): Promise<Rig> {
  const opened: Opened[] = [];
  const ran: string[] = [];
  const guardErrors: string[] = [];
  let build: BuildServices | undefined;
  const c = await startController({
    storage: { kind: "sqlite", path: join(dir, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: {
      timer: new ManualTimer(), manual: true, ...(options.route === undefined ? {} : { route: options.route }),
      local: {
        acceptUnenforcedLimits: true,
        // The operator's map of routes to windows knows nothing about these routes, and (by default) no checkpoint reader is passed either.
        window: () => undefined,
        ...(options.reader === true ? { storedTokens: () => 40_000 } : {}),
        close: async () => undefined,
        build: (s: BuildServices) => {
          build = s;
          return new LocalWorker({
            hostId: "host:w1", resources: { cpus: 1, memoryMb: 1024 }, version: "c07n-test", capabilities: () => ({ os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] }),
            guards: s.guards, onGuardError: (_id, what, error) => { guardErrors.push(`${what}: ${String((error as Error)?.message ?? error)}`); },
            sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) },
            runtimes: {
              open: async (order, _call, from) => {
                const record: { attemptId: string; route: string; from: JsonObject | undefined; content?: string } = { attemptId: order.attemptId, route: order.route, from };
                opened.push(record);
                let release!: () => void;
                const closed = new Promise<void>((ok) => { release = ok; });
                const rt: AttemptRuntime = {
                  firstCall: () => options.firstCall(),
                  compact: async () => undefined,
                  run: async (content) => {
                    record.content = content;
                    ran.push(order.attemptId);
                    if (options.hang === true) { await closed; return { status: "cancelled" } as never; }
                    return { status: "completed", text: "done", checkpoint: options.checkpoint(order.attemptId) };
                  },
                  checkpoint: async () => options.checkpoint(order.attemptId),
                  close: async () => { release(); },
                };
                return rt;
              },
            },
          }) as unknown as WorkerHost;
        },
      },
    },
  } as never);
  const s = c.services;
  const ownerToken = options.ownerToken ?? (await s.principals.bootstrapOwner({ name: "rob" })).token;
  const owner = await s.principals.authenticate(ownerToken);
  const project = options.project ?? (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
  if (options.restarted !== true) {
    const routing = (await s.routing.get())?.revision ?? 0;
    await s.routing.setTable(owner, { commandId: "rt", expectedRevision: routing, table } as never);
    await DifficultyService.withEpoch(c.storage, c.epoch, s.routing, s.contracts).setProfiles(owner, { commandId: "sp", expectedRevision: 0, profiles: EXEC_PROFILES } as never);
    await s.principals.enroll(owner, { commandId: "e-host", kind: "host", name: "w1", grants: [] });
    await s.principals.enroll(owner, { commandId: "e-ann", kind: "agent", name: ANN, grants: workGrants(project) });
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
    await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(owner, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
  }
  const beat = opened.length + 1;
  const hostP = await s.principals.authenticate((await s.principals.issueCredential(owner, "host:w1")).token);
  const hosts = HostService.withEpoch(c.storage, c.epoch, s.assignments);
  await hosts.announce(hostP, { commandId: `an${beat}`, capabilities: { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] } });
  await hosts.heartbeat(hostP, { commandId: `hb${beat}`, sequence: beat });
  assert.ok(build !== undefined, "the controller never built the local host");
  return { ...options, c, owner, ownerToken, project, opened, ran, guardErrors, services: build! };
}

/** A ready task assigned to the agent, with an attempt admitted. */
async function task(c: Controller, owner: Principal, project: string, title: string, n: number): Promise<string> {
  const s = c.services;
  const taskId = (await s.projects.createTask({ commandId: `t${n}`, actor: owner.id, projectId: project, title })).id;
  await s.projects.transitionTask({ commandId: `r${n}`, actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
  await s.assignments.assignTask({ commandId: `as${n}`, actor: owner.id, taskId, owner: { kind: "agent", id: ANN } });
  const a = (await s.assignments.getAssignment(taskId))!;
  return (await s.assignments.admitAttempt({ commandId: `ad${n}`, actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: ANN }, harness: "pi" })).id;
}
const blockersFor = async (c: Controller, taskId: string): Promise<{ type: string; state: string; summary: string }[]> =>
  (await c.storage.listAggregates("blocker", { limit: 100 })).map((b) => b.body as unknown as { type: string; state: string; summary: string; subject: { id: string } }).filter((b) => b.subject?.id === taskId);
const admissions = async (c: Controller): Promise<{ window: number; admit: boolean; routeName?: string }[]> =>
  (await c.storage.listAggregates("ctx-admission", { limit: 50 })).map((a) => a.body as unknown as { window: number; admit: boolean; routeName?: string });

test("a route the host's window map does not know is checked against the routing table's figure for it, and a first call over it is refused with the measurement recorded (card C07n)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-c07n-table-"));
  const r = await rig(d, { firstCall: () => BIG, checkpoint: () => ({}) });
  try {
    assert.ok(r.c.dispatch !== undefined, r.c.dispatchProblem);
    const attemptId = await task(r.c, r.owner, r.project, "Water the beds", 1);
    await r.c.dispatch.dispatcher.tick();
    await r.c.dispatch.dispatcher.idle();
    assert.deepEqual(r.ran, [], "a first call of a million tokens was sent on a route the host's map does not know");
    const failed = (await r.c.dispatch.dispatcher.get(r.c.dispatch.principal, attemptId))!;
    assert.equal(failed.outcome?.status, "failed", JSON.stringify(failed.outcome));
    assert.match(failed.outcome?.summary ?? "", /over the startup limit of 1024 for a 4096-token window/, "the routing table's figure for the route was not used to judge the call");
    // It was judged, not refused for want of a window: the measurement is kept, and the task is blocked where the owner will see it.
    assert.deepEqual((await admissions(r.c)).map((a) => [a.routeName, a.window, a.admit]).slice(0, 1), [["localp/small", WINDOW, false]], JSON.stringify(await admissions(r.c)));
    assert.ok((await admissions(r.c)).every((a) => a.routeName === "localp/small" && a.window === WINDOW && a.admit === false), JSON.stringify(await admissions(r.c)));
    const open = (await blockersFor(r.c, failed.taskId)).filter((b) => b.type === "context_overflow" && b.state === "open");
    assert.equal(open.length, 1, JSON.stringify(await blockersFor(r.c, failed.taskId)));
    assert.match(open[0]!.summary, /first call of attempt/, open[0]!.summary);
    assert.deepEqual(r.guardErrors, [], JSON.stringify(r.guardErrors));
  } finally { await r.c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a first call that fits the routing table's window is sent: the table is a figure to check against, not a reason to refuse everything (card C07n)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-c07n-fits-"));
  const r = await rig(d, { firstCall: () => SMALL, checkpoint: () => ({}) });
  try {
    assert.ok(r.c.dispatch !== undefined, r.c.dispatchProblem);
    const attemptId = await task(r.c, r.owner, r.project, "Water the beds", 1);
    await r.c.dispatch.dispatcher.tick();
    await r.c.dispatch.dispatcher.idle();
    assert.deepEqual(r.ran, [attemptId], "a first call that fits the routing table's window was not sent");
    assert.equal((await r.c.dispatch.dispatcher.get(r.c.dispatch.principal, attemptId))!.outcome?.status, "succeeded");
    assert.deepEqual((await admissions(r.c)).map((a) => [a.routeName, a.window, a.admit]), [["localp/small", WINDOW, true]]);
    assert.deepEqual(r.guardErrors, [], JSON.stringify(r.guardErrors));
  } finally { await r.c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a route with no window in the host's map or the routing table admits nothing: nothing is sent, and a blocker names the route and where its window is set (card C07n)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-c07n-off-"));
  const offtable: RouteResolver = async () => ({ route: "offtable/model", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "local-only", paidAuthorized: false } });
  const r = await rig(d, { firstCall: () => BIG, checkpoint: () => ({}), route: offtable });
  try {
    assert.ok(r.c.dispatch !== undefined, r.c.dispatchProblem);
    const attemptId = await task(r.c, r.owner, r.project, "Water the beds", 1);
    await r.c.dispatch.dispatcher.tick();
    await r.c.dispatch.dispatcher.idle();
    assert.deepEqual(r.ran, [], "a first call was sent on a route nobody gives a window for");
    const ended = (await r.c.dispatch.dispatcher.get(r.c.dispatch.principal, attemptId))!;
    assert.equal(ended.outcome?.status, "failed", JSON.stringify(ended.outcome));
    assert.match(ended.outcome?.summary ?? "", /route offtable\/model has no context window the controller knows/, ended.outcome?.summary ?? "");
    assert.match(ended.outcome?.summary ?? "", /set its window/, "the agent is not told what to fix");
    assert.deepEqual(await admissions(r.c), [], "something was recorded as judged: there was no window to judge against");
    const open = (await blockersFor(r.c, ended.taskId)).filter((b) => b.type === "context_overflow" && b.state === "open");
    assert.equal(open.length, 1, JSON.stringify(await blockersFor(r.c, ended.taskId)));
    assert.match(open[0]!.summary, /offtable\/model/, "the blocker does not name the route");
    assert.match(open[0]!.summary, /contextTokens/, "the blocker does not say where the window is set");
    assert.deepEqual(r.guardErrors, [], JSON.stringify(r.guardErrors));
    // The guards the composition hands the host answer for a checkpoint of the worker package's shape and nothing else, and judge a resume against the routing table's figure.
    const guards = r.services.guards.context!;
    assert.equal(guards.storedTokens!({ nn: { contextTokens: 1234 } } as never), 1234, "the composition passes no reader, so the guards do not read the checkpoint shape");
    assert.equal(guards.storedTokens!({ pi: { conversationId: 7 } } as never), undefined);
    const order = { attemptId, taskId: ended.taskId, route: "localp/small" } as never;
    assert.equal((await guards.resume(order, 100)).resume, true, "a conversation within the routing table's resume share was not resumed");
    const over = await guards.resume(order, 40_000);
    assert.equal(over.resume, false, "a conversation over the routing table's resume share was resumed");
    assert.match(over.reason, /40000 tokens, over 2457 \(60% of this model's 4096\)/, over.reason);
  } finally { await r.c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a stored conversation is judged before it is carried, with no reader passed: the worker package's checkpoint shape is read, and a checkpoint that says nothing is left behind (card C07n)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-c07n-resume-"));
  // The conversation each attempt's process left in its checkpoint: 40,000 tokens for one task (over the 60 % share of a 4096-token window), nothing said for the other.
  const kept: Record<string, JsonObject> = {};
  let over = "";
  let quiet = "";
  const first = await rig(d, { hang: true, firstCall: () => SMALL, checkpoint: (id) => kept[id] ?? { pi: { conversationId: 7 } } });
  try {
    assert.ok(first.c.dispatch !== undefined, first.c.dispatchProblem);
    over = await task(first.c, first.owner, first.project, "Water the beds", 1);
    quiet = await task(first.c, first.owner, first.project, "Weed the paths", 2);
    kept[over] = { pi: { conversationId: 7 }, nn: { contextTokens: 40_000 } };
    kept[quiet] = { pi: { conversationId: 9 } };
    await first.c.dispatch.dispatcher.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(first.ran.sort(), [over, quiet].sort(), "both attempts started");
    // The controller goes down in the middle of the turn: both attempts are left waiting with the checkpoint their process last took.
    assert.deepEqual(await first.c.dispatch.dispatcher.shutdown(), { closed: 2, errors: [] });
    // The closed turns answer now their processes were stopped; nothing is running any more.
    await first.c.dispatch.dispatcher.idle();
  } finally { await first.c.close(); }
  // A second controller over the same store, wired the same way, brings both attempts back.
  const second = await rig(d, { restarted: true, ownerToken: first.ownerToken, project: first.project, firstCall: () => SMALL, checkpoint: (id) => kept[id] ?? {} });
  try {
    assert.ok(second.c.dispatch !== undefined, second.c.dispatchProblem);
    await second.c.dispatch.dispatcher.tick();
    await second.c.dispatch.dispatcher.idle();
    const overCall = second.opened.find((o) => o.attemptId === over)!;
    const quietCall = second.opened.find((o) => o.attemptId === quiet)!;
    assert.deepEqual(second.opened.map((o) => [o.attemptId, o.from === undefined ? "fresh" : "carried"].join(":")).sort(), [`${over}:fresh`, `${quiet}:fresh`].sort(), `a checkpoint was carried into the new process: ${JSON.stringify(second.opened.map((o) => [o.attemptId, o.from !== undefined]))}`);
    assert.match(overCall.content ?? "", /40000 tokens, over 2457 \(60% of this model's 4096\)/, (overCall.content ?? "").slice(-300));
    assert.match(overCall.content ?? "", /starting fresh from the continuation record/, (overCall.content ?? "").slice(-300));
    assert.match(quietCall.content ?? "", /the size of the stored conversation is not known \(its checkpoint does not say\), so it was not resumed/, (quietCall.content ?? "").slice(-300));
    assert.ok(second.guardErrors.some((e) => /resume decision: the checkpoint does not say how large the stored conversation is/.test(e)), JSON.stringify(second.guardErrors));
    // Both carry on from the continuation record rather than the conversation they lost.
    assert.deepEqual(second.ran.sort(), [over, quiet].sort(), "an attempt did not carry on");
    for (const id of [over, quiet]) assert.equal((await second.c.dispatch!.dispatcher.get(second.c.dispatch!.principal, id))!.outcome?.status, "succeeded", id);
  } finally { await second.c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("the checkpoint reader the embedder passes is the one that decides, wherever the checkpoint's own figures come from (card C07n)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-c07n-reader-"));
  let attemptId = "";
  const first = await rig(d, { hang: true, firstCall: () => SMALL, checkpoint: () => ({ pi: { conversationId: 7 } }), reader: true });
  try {
    assert.ok(first.c.dispatch !== undefined, first.c.dispatchProblem);
    attemptId = await task(first.c, first.owner, first.project, "Water the beds", 1);
    await first.c.dispatch.dispatcher.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(first.ran, [attemptId], "the attempt did not start");
    assert.deepEqual(await first.c.dispatch.dispatcher.shutdown(), { closed: 1, errors: [] });
    await first.c.dispatch.dispatcher.idle();
  } finally { await first.c.close(); }
  // The checkpoint says nothing of its size; the host's reader answers 40,000 tokens for any checkpoint, and that is what the resume is judged against.
  const second = await rig(d, { restarted: true, ownerToken: first.ownerToken, project: first.project, firstCall: () => SMALL, checkpoint: () => ({ pi: { conversationId: 7 } }), reader: true });
  try {
    assert.ok(second.c.dispatch !== undefined, second.c.dispatchProblem);
    await second.c.dispatch.dispatcher.tick();
    await second.c.dispatch.dispatcher.idle();
    const call = second.opened.find((o) => o.attemptId === attemptId)!;
    assert.equal(call.from, undefined, "the stored conversation was carried in unchecked");
    assert.match(call.content ?? "", /40000 tokens, over 2457/, (call.content ?? "").slice(-300));
  } finally { await second.c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
