import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AssignmentService, type Owner } from "../domain/index.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { OWNCODE_OFF, OWNCODE_STOP, OwnCodeService, taskIdOf, type OwnCodeOptions, type OwnCodeRunning, type OwnCodeStops } from "./index.js";

// Card B06, first slice: optional agent work on NimbleNewt's own code. Off by default (a request is refused with a message saying the owner can enable it); on, an agent asks first and only the owner approves;
// no attempt starts in the development project without an approved request, and a withdrawn approval stops further starts. Real storage on each backend, real admissions through the attempt gate; the only
// clock is the test's, and nothing sleeps.

after(stopServer);

let now = Date.parse("2026-11-27T15:00:00.000Z");
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};
const ASK = { what: "make the stand-up brief list blocked tasks first", why: "owners miss blocked work at the bottom", effort: "about two hours", cost: "a few cents of local model time" };

/** L02's Stop as the stop look sees it: records what was asked, replays a repeated command ID, and holds what the test says is held. */
function fakeStops() {
  const held = new Map<string, string>();
  const asked: { by: string; commandId: string; taskId: string; mode: string; reason: string }[] = [];
  const advanced: string[] = [];
  const known = new Map<string, string>();
  const failFor = new Set<string>();
  const stops: OwnCodeStops = {
    holding: async (taskId) => (held.has(taskId) ? { intentId: `stp-held-${taskId}`, mode: held.get(taskId)! } : undefined),
    request: async (by, command) => {
      if (failFor.has(command.scope.id)) throw new DomainError("unavailable", "the stop could not be recorded");
      const old = known.get(command.commandId);
      if (old !== undefined) return { intentId: old, replayed: true };
      const intentId = `stp-${known.size}`;
      known.set(command.commandId, intentId);
      asked.push({ by: by.id, commandId: command.commandId, taskId: command.scope.id, mode: command.mode, reason: command.reason });
      return { intentId, replayed: false };
    },
    advance: async (_by, command) => { advanced.push(command.intentId); },
  };
  return { stops, held, asked, advanced, failFor };
}

interface Ctx {
  owner: Principal; dev: Principal; dev2: Principal; host: Principal; confined: Principal;
  devProject: string; other: string; svc: OwnCodeService; projects: ProjectService; assign: AssignmentService; storage: ControllerStorage; epoch: number;
  make(o?: OwnCodeOptions): OwnCodeService;
  enable(): Promise<void>;
  ask(by?: Principal, over?: Record<string, unknown>): Promise<string>;
  rev(id: string): Promise<number>;
  approve(id: string): Promise<string>;
  /** Makes the task ready, assigns it to `dev` and admits an attempt; returns the attempt ID or throws the admission's refusal. */
  start(taskId: string): Promise<string>;
  finish(taskId: string, attemptId: string): Promise<void>;
}

for (const backend of backends) {
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      now = Date.parse("2026-11-27T15:00:00.000Z");
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const epoch = projects.epoch;
        const principals = PrincipalService.withEpoch(world.storage, epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const enroll = async (nm: string, kind: "agent" | "host" = "agent"): Promise<Principal> => {
          await principals.enroll(owner, { commandId: cid("e"), kind, name: nm, grants: [] });
          return principals.authenticate((await principals.issueCredential(owner, `${kind}:${nm}`)).token);
        };
        const devProject = (await projects.createProject({ commandId: cid("pd"), actor: owner.id, name: "NimbleNewt development" })).id;
        const other = (await projects.createProject({ commandId: cid("po"), actor: owner.id, name: "Garden" })).id;
        const make = (o: OwnCodeOptions = {}) => OwnCodeService.withEpoch(world.storage, epoch, { ...options, projects, ...o });
        const svc = make();
        const assign = AssignmentService.withEpoch(world.storage, epoch, projects, { ...options, attemptGate: (taskId) => svc.checkAttempt(taskId) });
        const dev = await enroll("dev");
        const ctx: Ctx = {
          owner, dev, dev2: await enroll("dev2"), host: await enroll("box", "host"), confined: { ...owner, taskScope: { taskId: derivedId("task", "x"), projectId: other } },
          devProject, other, svc, projects, assign, storage: world.storage, epoch, make,
          enable: async () => { await svc.enable(owner, { commandId: cid("en"), projectId: devProject }); },
          ask: async (by = dev, over = {}) => (await svc.request(by, { commandId: cid("rq"), ...ASK, ...over } as never)).id,
          rev: async (id) => (await svc.get(owner, id))!.revision,
          approve: async (id) => (await svc.decide(owner, { commandId: cid("ok"), requestId: id, expectedRevision: await ctx.rev(id), decision: "approve" })).taskId!,
          start: async (taskId) => {
            const task = await projects.getTask(taskId);
            if (task!.state === "proposed") await projects.transitionTask({ commandId: cid("ready"), actor: owner.id, taskId, expectedRevision: task!.revision, to: "ready" });
            let a = await assign.getAssignment(taskId);
            const who: Owner = { kind: "agent", id: "dev" };
            if (a === undefined || a.state !== "assigned") { await assign.assignTask({ commandId: cid("as"), actor: owner.id, taskId, owner: who, ...(a === undefined ? {} : { expectedRevision: a.revision }) }); a = await assign.getAssignment(taskId); }
            return (await assign.admitAttempt({ commandId: cid("ad"), actor: owner.id, taskId, expectedRevision: a!.revision, generation: a!.generation, owner: who })).id;
          },
          finish: async (taskId, attemptId) => {
            const a = (await assign.getAssignment(taskId))!;
            await assign.finishAttempt({ commandId: cid("fin"), actor: owner.id, taskId, expectedRevision: a.revision, fence: { generation: a.generation, attemptId }, outcome: "succeeded" });
          },
        };
        await body(ctx);
      } finally { await world.close(); }
    });

  suite("off by default: a request is refused with a message saying the owner can enable it, nothing is written, and only the owner reads the settings", async (c) => {
    assert.deepEqual(await c.svc.settings(c.owner), { revision: 0, enabled: false, history: [] });
    assert.equal(await c.svc.settings(c.dev), undefined);
    assert.equal(await c.svc.settings(c.confined), undefined, "an owner token confined to a task is not the owner here");
    await refuses("unavailable", () => c.ask(), /off in this installation\. The owner can enable it/);
    await refuses("unavailable", () => c.ask(c.owner), /The owner can enable it/);
    assert.deepEqual((await c.svc.list(c.owner)).items, []);
    // Nothing is gated while no development project was ever named: work everywhere starts as before.
    const t = (await c.projects.createTask({ commandId: cid("t"), actor: c.owner.id, projectId: c.devProject, title: "edit" })).id;
    assert.ok(await c.start(t));
  });

  suite("enabling: only the owner, the first time naming an existing active project, which then never changes; revisions guard every switch", async (c) => {
    await refuses("forbidden", () => c.svc.enable(c.dev, { commandId: cid("en"), projectId: c.devProject }), /only the owner/);
    await refuses("forbidden", () => c.svc.enable(c.confined, { commandId: cid("en"), projectId: c.devProject }), /confined to a task/);
    await refuses("invalid_command", () => c.svc.enable(c.owner, { commandId: cid("en") }), /name the NimbleNewt development project/);
    await refuses("not_found", () => c.svc.enable(c.owner, { commandId: cid("en"), projectId: derivedId("proj", "nowhere") }));
    await refuses("invalid_command", () => c.svc.enable(c.owner, { commandId: cid("en"), projectId: "../etc" }), /projectId/);
    await refuses("invalid_command", () => c.svc.enable(c.owner, { commandId: cid("en"), projectId: c.devProject, extra: 1 } as never));
    await refuses("stale_revision", () => c.svc.enable(c.owner, { commandId: cid("en"), projectId: c.devProject, expectedRevision: 1 }));
    const archived = (await c.projects.createProject({ commandId: cid("px"), actor: c.owner.id, name: "Old" })).id;
    await c.projects.updateProject({ commandId: cid("arch"), actor: c.owner.id, projectId: archived, expectedRevision: 1, state: "archived" });
    await refuses("invalid_command", () => c.svc.enable(c.owner, { commandId: cid("en"), projectId: archived }), /not active/);
    const first = await c.svc.enable(c.owner, { commandId: cid("en"), projectId: c.devProject });
    assert.deepEqual(first, { revision: 1, projectId: c.devProject });
    await refuses("invalid_command", () => c.svc.enable(c.owner, { commandId: cid("en"), expectedRevision: 1 }), /already enabled/);
    await refuses("forbidden", () => c.svc.disable(c.dev, { commandId: cid("dis"), expectedRevision: 1 }));
    await refuses("stale_revision", () => c.svc.disable(c.owner, { commandId: cid("dis"), expectedRevision: 7 }));
    await c.svc.disable(c.owner, { commandId: cid("dis"), expectedRevision: 1 });
    await refuses("invalid_command", () => c.svc.disable(c.owner, { commandId: cid("dis"), expectedRevision: 2 }), /already off/);
    await refuses("invalid_command", () => c.svc.enable(c.owner, { commandId: cid("en"), expectedRevision: 2, projectId: c.other }), /stays the same once named/);
    assert.deepEqual(await c.svc.enable(c.owner, { commandId: cid("en"), expectedRevision: 2 }), { revision: 3, projectId: c.devProject });
    const s = (await c.svc.settings(c.owner))!;
    assert.equal(s.enabled, true);
    assert.deepEqual(s.history.map((h) => h.enabled), [true, false, true]);
    // A repeated command answers from its record.
    const again = await c.svc.disable(c.owner, { commandId: "same-off", expectedRevision: 3 });
    assert.deepEqual(await c.svc.disable(c.owner, { commandId: "same-off", expectedRevision: 3 }), again);
  });

  suite("no work starts in the development project without an approved request; other projects are unaffected; approval creates the task there", async (c) => {
    await c.enable();
    const direct = (await c.projects.createTask({ commandId: cid("t"), actor: c.owner.id, projectId: c.devProject, title: "made by hand" })).id;
    await refuses("invalid_command", () => c.start(direct), /came from no approved request/);
    const elsewhere = (await c.projects.createTask({ commandId: cid("t"), actor: c.owner.id, projectId: c.other, title: "weed" })).id;
    assert.ok(await c.start(elsewhere), "a task of another project starts as before");

    const id = await c.ask();
    const pending = (await c.svc.get(c.dev, id))!;
    assert.equal(pending.status, "pending");
    assert.deepEqual(pending.request, ASK);
    assert.equal(pending.taskId, undefined, "a request creates no task");
    await refuses("forbidden", () => c.svc.decide(c.dev, { commandId: cid("d"), requestId: id, expectedRevision: 1, decision: "approve" }), /only the owner/);
    await refuses("forbidden", () => c.svc.decide(c.dev2, { commandId: cid("d"), requestId: id, expectedRevision: 1, decision: "approve" }));
    await refuses("forbidden", () => c.svc.decide(c.confined, { commandId: cid("d"), requestId: id, expectedRevision: 1, decision: "approve" }), /confined to a task/);
    await refuses("stale_revision", () => c.svc.decide(c.owner, { commandId: cid("d"), requestId: id, expectedRevision: 5, decision: "approve" }));
    const taskId = await c.approve(id);
    assert.equal(taskId, taskIdOf(id));
    const task = (await c.projects.getTask(taskId))!;
    assert.equal(task.projectId, c.devProject);
    assert.equal(task.state, "proposed", "approval creates the task; starting it is the usual ready, assign and admit");
    assert.match(task.title, /^NimbleNewt: make the stand-up brief/);
    assert.match(task.description, new RegExp(`Approved request ${id} from agent:dev`));
    const approved = (await c.svc.get(c.owner, id))!;
    assert.equal(approved.status, "approved");
    assert.equal(approved.decidedBy, c.owner.id);
    assert.ok(await c.start(taskId));
    await refuses("invalid_command", () => c.svc.decide(c.owner, { commandId: cid("d"), requestId: id, expectedRevision: approved.revision, decision: "reject" }), /only a waiting request is decided/);
  });

  suite("a withdrawn approval stops further starts; switching the feature off stops them too and switching it on restores the approval; approving while off is refused", async (c) => {
    await c.enable();
    const id = await c.ask();
    const taskId = await c.approve(id);
    const first = await c.start(taskId);
    await c.finish(taskId, first);
    // Off: the approval stays recorded but nothing starts, and nothing new is approved.
    const s = (await c.svc.settings(c.owner))!;
    await c.svc.disable(c.owner, { commandId: cid("dis"), expectedRevision: s.revision });
    await refuses("invalid_command", () => c.start(taskId), /The owner can enable it/);
    await refuses("unavailable", () => c.ask(), /The owner can enable it/);
    const waiting = await (async () => { await c.svc.enable(c.owner, { commandId: cid("en"), expectedRevision: s.revision + 1 }); const w = await c.ask(c.dev2); await c.svc.disable(c.owner, { commandId: cid("dis"), expectedRevision: s.revision + 2 }); return w; })();
    await refuses("unavailable", () => c.svc.decide(c.owner, { commandId: cid("d"), requestId: waiting, expectedRevision: 1, decision: "approve" }), /off in this installation/);
    assert.equal((await c.svc.get(c.owner, waiting))!.status, "pending");
    await c.svc.decide(c.owner, { commandId: cid("d"), requestId: waiting, expectedRevision: 1, decision: "reject", note: "not now" });
    assert.equal((await c.svc.get(c.dev2, waiting))!.status, "rejected");
    await c.svc.enable(c.owner, { commandId: cid("en"), expectedRevision: s.revision + 3 });
    const second = await c.start(taskId);
    await c.finish(taskId, second);
    // Withdrawn: the requester cannot withdraw an approval, the owner can, and the next start is refused.
    await refuses("forbidden", async () => c.svc.withdraw(c.dev, { commandId: cid("w"), requestId: id, expectedRevision: await c.rev(id), reason: "changed my mind" }), /only the owner withdraws an approval/);
    await c.svc.withdraw(c.owner, { commandId: cid("w"), requestId: id, expectedRevision: await c.rev(id), reason: "no longer wanted" });
    const after = (await c.svc.get(c.dev, id))!;
    assert.equal(after.status, "withdrawn");
    assert.equal(after.withdrawnFrom, "approved");
    await refuses("invalid_command", () => c.start(taskId), /withdrawn \(the owner withdrew the approval\), so no work starts/);
    await refuses("invalid_command", () => c.svc.withdraw(c.owner, { commandId: cid("w"), requestId: id, expectedRevision: after.revision, reason: "again" }), /only a waiting or approved request/);
  });

  suite("a rejected request creates nothing; a requester withdraws its own waiting request only; others neither see nor touch it; at most five wait per requester", async (c) => {
    await c.enable();
    const id = await c.ask();
    const r = await c.svc.decide(c.owner, { commandId: cid("d"), requestId: id, expectedRevision: 1, decision: "reject", note: "out of scope" });
    assert.deepEqual(r, { revision: 2, status: "rejected" });
    assert.equal(await c.projects.getTask(taskIdOf(id)), undefined, "no task for a rejected request");
    const mine = await c.ask();
    assert.equal(await c.svc.get(c.dev2, mine), undefined);
    await refuses("not_found", () => c.svc.withdraw(c.dev2, { commandId: cid("w"), requestId: mine, expectedRevision: 1, reason: "not yours" }));
    await c.svc.withdraw(c.dev, { commandId: cid("w"), requestId: mine, expectedRevision: 1, reason: "will ask later" });
    assert.equal((await c.svc.get(c.dev, mine))!.withdrawnFrom, "pending");
    for (let i = 0; i < 5; i++) await c.ask();
    await refuses("unavailable", () => c.ask(), /at most 5 wait at a time/);
    assert.ok(await c.ask(c.dev2), "another requester still asks");
    // Deciding one frees a place.
    const listed = await c.svc.list(c.dev, { status: "pending" });
    assert.equal(listed.items.length, 5);
    assert.ok(listed.items.every((i) => i.requestedBy === c.dev.id));
    await c.svc.decide(c.owner, { commandId: cid("d"), requestId: listed.items[0]!.id, expectedRevision: 1, decision: "reject" });
    assert.ok(await c.ask());
    const all = await c.svc.list(c.owner, { limit: 3 });
    assert.equal(all.items.length, 3);
    assert.ok(all.next !== undefined);
    const rest = await c.svc.list(c.owner, { afterId: all.next!, limit: 100 });
    assert.equal(all.items.length + rest.items.length, 9, "rejected, withdrawn, five waiting then one decided, one more and one of dev2");
    assert.equal((await c.svc.list(c.dev2)).items.length, 1, "an agent lists only its own");
    await refuses("invalid_command", () => c.svc.list(c.owner, { status: "approvedish" }));
    await refuses("invalid_command", () => c.svc.list(c.owner, { afterId: "ocr-aaaaaaaaaaaaaaaaaaaa" }));
  });

  suite("hostile input: credential-shaped or oversized text, unknown fields, bad IDs and decisions, and principals that may not ask are refused before anything is written", async (c) => {
    await c.enable();
    await refuses("invalid_command", () => c.ask(c.dev, { why: "use key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }), /credential/);
    await refuses("invalid_command", () => c.ask(c.dev, { what: "x".repeat(601) }), /what/);
    await refuses("invalid_command", () => c.ask(c.dev, { cost: "" }), /cost/);
    await refuses("invalid_command", () => c.ask(c.dev, { effort: 5 }), /effort/);
    await refuses("invalid_command", () => c.ask(c.dev, { grants: ["*"] }));
    await refuses("forbidden", () => c.ask(c.host), /agents and the owner ask/);
    assert.deepEqual((await c.svc.list(c.owner)).items, []);
    const id = await c.ask();
    await refuses("invalid_command", () => c.svc.decide(c.owner, { commandId: cid("d"), requestId: id, expectedRevision: 1, decision: "maybe" as never }), /approve or reject/);
    await refuses("invalid_command", () => c.svc.decide(c.owner, { commandId: cid("d"), requestId: "task-../../x", expectedRevision: 1, decision: "approve" }), /not a request ID/);
    await refuses("not_found", () => c.svc.decide(c.owner, { commandId: cid("d"), requestId: "ocr-aaaaaaaaaaaaaaaaaaaa", expectedRevision: 1, decision: "approve" }));
    await refuses("invalid_command", () => c.svc.decide(c.owner, { commandId: cid("d"), requestId: id, expectedRevision: 1, decision: "approve", note: "token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }), /credential/);
    await refuses("invalid_command", () => c.svc.decide(c.owner, { commandId: cid("d"), requestId: id, expectedRevision: 1, decision: "approve", taskId: "task-x" } as never));
    assert.equal(await c.svc.get(c.owner, "../../etc/passwd"), undefined);
    assert.equal((await c.svc.get(c.owner, id))!.status, "pending");
  });

  suite("repeats and a lost task creation: the same request command answers with its request; a repeated approval finds the same task and finishes a task creation that did not happen", async (c) => {
    await c.enable();
    const once = await c.svc.request(c.dev, { commandId: "ask-1", ...ASK });
    const twice = await c.svc.request(c.dev, { commandId: "ask-1", ...ASK });
    assert.deepEqual(twice, { id: once.id, replayed: true });
    assert.equal((await c.svc.list(c.owner)).items.length, 1);
    await refuses("command_conflict", () => c.svc.request(c.dev, { commandId: "ask-1", ...ASK, why: "other words" }));
    // The project records fail when the approval tries to create the task: the approval is recorded, the task is not, and no attempt can start.
    let fail = true;
    const flaky = c.make({ projects: { createTask: async (cmd) => { if (fail) throw new DomainError("unavailable", "project records offline"); return c.projects.createTask(cmd); } } });
    await refuses("unavailable", () => flaky.decide(c.owner, { commandId: "approve-1", requestId: once.id, expectedRevision: 1, decision: "approve" }), /offline/);
    assert.equal((await c.svc.get(c.owner, once.id))!.status, "approved");
    const taskId = taskIdOf(once.id);
    assert.equal(await c.projects.getTask(taskId), undefined);
    fail = false;
    const replay = await flaky.decide(c.owner, { commandId: "approve-1", requestId: once.id, expectedRevision: 1, decision: "approve" });
    assert.deepEqual(replay, { revision: 2, status: "approved", taskId });
    assert.equal((await c.projects.getTask(taskId))!.projectId, c.devProject);
    assert.deepEqual(await c.svc.decide(c.owner, { commandId: "approve-1", requestId: once.id, expectedRevision: 1, decision: "approve" }), replay, "a third repeat changes nothing");
    assert.ok(await c.start(taskId));
    // A lost task creation is also finished by a new approval with another command ID (review): the task is created once, and with it in place the request is decided, so a further approval is refused.
    const second = await c.ask(c.dev, { what: "a second change" });
    fail = true;
    await refuses("unavailable", () => flaky.decide(c.owner, { commandId: "approve-2", requestId: second, expectedRevision: 1, decision: "approve" }), /offline/);
    fail = false;
    await refuses("forbidden", () => flaky.decide(c.dev, { commandId: "approve-2b", requestId: second, expectedRevision: 2, decision: "approve" }), /only the owner/);
    await refuses("stale_revision", () => flaky.decide(c.owner, { commandId: "approve-2c", requestId: second, expectedRevision: 1, decision: "approve" }));
    await refuses("invalid_command", () => flaky.decide(c.owner, { commandId: "reject-2", requestId: second, expectedRevision: 2, decision: "reject" }), /only a waiting request/);
    assert.equal(await c.projects.getTask(taskIdOf(second)), undefined);
    assert.deepEqual(await flaky.decide(c.owner, { commandId: "approve-2d", requestId: second, expectedRevision: 2, decision: "approve" }), { revision: 2, status: "approved", taskId: taskIdOf(second) });
    assert.equal((await c.projects.getTask(taskIdOf(second)))!.projectId, c.devProject);
    assert.equal((await c.svc.get(c.owner, second))!.revision, 2, "finishing the task creation writes nothing to the request");
    await refuses("invalid_command", () => flaky.decide(c.owner, { commandId: "approve-2e", requestId: second, expectedRevision: 2, decision: "approve" }), /only a waiting request/);
    assert.ok(await c.start(taskIdOf(second)));
    // A service without the project records approves nothing.
    const bare = OwnCodeService.withEpoch(c.storage, c.epoch, options);
    const other = await c.ask(c.dev2);
    await refuses("unavailable", () => bare.decide(c.owner, { commandId: cid("d"), requestId: other, expectedRevision: 1, decision: "approve" }), /project records are not available/);
  });

  suite("the gate reads the request now: a link to a request that is missing, or to one approved for another task, refuses; an archived development project refuses approval", async (c) => {
    await c.enable();
    // The development project archived: nothing is approved into it; once active again, the same request is approved.
    const id = await c.ask();
    await c.projects.updateProject({ commandId: cid("arch"), actor: c.owner.id, projectId: c.devProject, expectedRevision: 1, state: "archived" });
    await refuses("unavailable", () => c.svc.decide(c.owner, { commandId: cid("d"), requestId: id, expectedRevision: 1, decision: "approve" }), /not active/);
    assert.equal((await c.svc.get(c.owner, id))!.status, "pending");
    await c.projects.updateProject({ commandId: cid("act"), actor: c.owner.id, projectId: c.devProject, expectedRevision: 2, state: "active" });
    const taskId = await c.approve(id);
    // Link records written past the service (a damaged store): the gate judges the request as it is now and refuses.
    const runner = new CommandRunner(c.storage, c.epoch, options);
    const link = async (task: string, requestId: string): Promise<void> => {
      await runner.command("test.put", { commandId: cid("put"), actor: c.owner.id }, async () => ({ payload: {}, build: async () => ({ ref: { kind: "owncode-task", id: task }, creates: true, changes: [{ type: "create" as const, ref: { kind: "owncode-task", id: task }, body: { requestId } as never }], detail: {} }) }));
    };
    const forged = (await c.projects.createTask({ commandId: cid("t"), actor: c.owner.id, projectId: c.devProject, title: "forged" })).id;
    await link(forged, id);
    await refuses("invalid_command", () => c.start(forged), /its request ocr-[a-z2-7]{20} is approved, so no work starts/);
    const orphan = (await c.projects.createTask({ commandId: cid("t"), actor: c.owner.id, projectId: c.devProject, title: "orphan" })).id;
    await link(orphan, "ocr-aaaaaaaaaaaaaaaaaaaa");
    await refuses("invalid_command", () => c.start(orphan), /is not found, so no work starts/);
    assert.ok(await c.start(taskId), "the real task still starts");
    // Review: the approval is of the work as asked. A task whose title or description was changed afterwards does not start; put back as approved, it starts again.
    await c.finish(taskId, (await c.assign.getAssignment(taskId))!.activeAttemptId!);
    const before = (await c.projects.getTask(taskId))!;
    await c.projects.updateTask({ commandId: cid("ed"), actor: c.owner.id, taskId, expectedRevision: before.revision, title: "NimbleNewt: rewrite the access checks" });
    await refuses("invalid_command", () => c.start(taskId), /was changed after the owner approved request/);
    const edited = (await c.projects.getTask(taskId))!;
    await c.projects.updateTask({ commandId: cid("ed"), actor: c.owner.id, taskId, expectedRevision: edited.revision, title: before.title, description: `${before.description}\nAlso: the access checks` });
    await refuses("invalid_command", () => c.start(taskId), /its title or description is not the approved one/);
    const edited2 = (await c.projects.getTask(taskId))!;
    await c.projects.updateTask({ commandId: cid("ed"), actor: c.owner.id, taskId, expectedRevision: edited2.revision, description: before.description });
    assert.ok(await c.start(taskId), "the task as approved starts again");
    // A long request in characters outside the basic plane: the title is cut to the task title's limit in UTF-16 code units, never inside a pair, so the approval's task is created.
    const wide = await c.ask(c.dev2, { what: "\u{1F331}".repeat(300) });
    const wideTask = await c.approve(wide);
    const title = (await c.projects.getTask(wideTask))!.title;
    assert.ok(title.length <= 200 && title.length >= 199, String(title.length));
    assert.ok(!/[\ud800-\udbff]$/.test(title), "no half of a pair at the end");
    assert.ok(await c.start(wideTask));
    // Second review: an odd number of code units before the pairs (the prefix is 12), so a pair would end past the limit at 201: it is left out and the task is still created and starts.
    const odd = await c.ask(c.dev2, { what: `a${"\u{1F331}".repeat(299)}` });
    const oddTask = await c.approve(odd);
    const oddTitle = (await c.projects.getTask(oddTask))!.title;
    assert.equal(oddTitle.length, 199, String(oddTitle.length));
    assert.ok(await c.start(oddTask));
    // Second review: a request whose words run over lines (newlines are allowed in a request, not in a task title) is titled on one line with single spaces; its task is created and starts untouched.
    const lines = await c.ask(c.dev2, { what: "  list blocked tasks\nfirst   in\n\nthe brief " });
    const linesTask = await c.approve(lines);
    const made = (await c.projects.getTask(linesTask))!;
    assert.equal(made.title, "NimbleNewt: list blocked tasks first in the brief");
    assert.match(made.description, /\nWhat: {3}list blocked tasks\nfirst {3}in\n\nthe brief \nWhy: /, "the description keeps the request's own words");
    assert.ok(await c.start(linesTask), "not refused as changed");
  });

  // Card B06, second slice: work already running in the development project is stopped through L02's Stop when the gate would no longer let it start.
  suite("running work in the development project is stopped through L02's Stop of its task once the approval is withdrawn or the feature is switched off; other work is not touched", async (c) => {
    const f = fakeStops();
    let looks = 0;
    let running: OwnCodeRunning[] = [];
    const told: string[] = [];
    const look = () => c.svc.stopRefused(c.owner, { stops: f.stops, running: async () => { looks++; return { items: running, next: 0 }; }, told: async (x) => { told.push(`${x.attemptId}|${x.intentId}|${x.reason}`); } });
    // Never enabled: nothing is looked at.
    assert.deepEqual(await look(), { stopped: [], failed: [] });
    assert.equal(looks, 0, "an installation that never named a development project does not look at the dispatcher");
    await c.enable();
    const reqA = await c.ask();
    const a = await c.approve(reqA);
    const b = await c.approve(await c.ask(c.dev2));
    const byHand = (await c.projects.createTask({ commandId: cid("t"), actor: c.owner.id, projectId: c.devProject, title: "by hand" })).id;
    const garden = (await c.projects.createTask({ commandId: cid("t"), actor: c.owner.id, projectId: c.other, title: "weed" })).id;
    const attA = await c.start(a);
    const attB = await c.start(b);
    running = [{ attemptId: attA, taskId: a, projectId: c.devProject }, { attemptId: attB, taskId: b, projectId: c.devProject }, { attemptId: "att-garden", taskId: garden, projectId: c.other },
      // An entry that says it is in the development project but whose task is not: the gate judges the task, so nothing of another project is stopped.
      { attemptId: "att-mislabelled", taskId: garden, projectId: c.devProject },
      // Work in the development project that no approved request made (running from before the project was named, for example) is not work the owner approved: it is stopped.
      { attemptId: "att-hand", taskId: byHand, projectId: c.devProject }];
    let r = await look();
    assert.deepEqual(r, { stopped: ["att-hand"], failed: [] });
    assert.deepEqual(f.asked.map((x) => [x.commandId, x.taskId, x.mode, x.by]), [["owncode-stop:att-hand", byHand, "stop", c.owner.id]]);
    assert.match(f.asked[0]!.reason, /^Stopped NimbleNewt development work: task .* came from no approved request/);
    assert.deepEqual(f.advanced, ["stp-0"], "the Stop's first steps run at once");
    f.held.set(byHand, "stop");

    // The owner withdraws the approval of A: A is stopped, with the gate's reason; B (still approved) and the garden are not.
    await c.svc.withdraw(c.owner, { commandId: cid("w"), requestId: reqA, expectedRevision: await c.rev(reqA), reason: "not wanted now" });
    r = await look();
    assert.deepEqual(r, { stopped: [attA], failed: [] });
    assert.equal(f.asked.at(-1)!.taskId, a);
    assert.match(f.asked.at(-1)!.reason, /the owner withdrew the approval\), so no work starts$/);
    assert.ok(told.at(-1)!.startsWith(`${attA}|stp-1|Stopped NimbleNewt development work: task ${a}`), told.at(-1));
    // The next tick: A's Stop is in force (the Stop's sweep carries it on), so nothing is asked again.
    f.held.set(a, "stop");
    assert.deepEqual(await look(), { stopped: [], failed: [] });
    assert.equal(f.asked.length, 2);
    // If the Stop is not seen as in force (its pause was lifted), the same command ID is replayed: nothing more is done, nothing is advanced or told again.
    f.held.delete(a);
    const told0 = told.length;
    assert.deepEqual(await look(), { stopped: [], failed: [] });
    assert.deepEqual([f.asked.length, f.advanced.length, told.length], [2, 2, told0]);

    // The feature is switched off: B is stopped too, saying the owner can enable it.
    await c.svc.disable(c.owner, { commandId: cid("dis"), expectedRevision: (await c.svc.settings(c.owner))!.revision });
    r = await look();
    assert.deepEqual(r, { stopped: [attB], failed: [] });
    assert.ok(f.asked.at(-1)!.reason.endsWith(OWNCODE_OFF), f.asked.at(-1)!.reason);
    assert.ok(f.asked.every((x) => x.taskId !== garden), "the garden is never stopped");
  });

  suite("the stop look is bounded per tick, takes over a Suspend, leaves a Stop or Force Stop in force alone, stops a task whose text changed, and one failure does not keep the others running", async (c) => {
    const f = fakeStops();
    await c.enable();
    const tasks: string[] = [];
    for (let i = 0; i < OWNCODE_STOP.perTick + 3; i++) tasks.push(await c.approve(await c.ask(i % 2 === 0 ? c.dev : c.dev2, { what: `change number ${i}` })));
    const running: OwnCodeRunning[] = tasks.map((t, i) => ({ attemptId: `att-${i}`, taskId: t, projectId: c.devProject }));
    // The same task twice in the look (two entries, side by side) is judged once.
    running.splice(1, 0, { attemptId: "att-0b", taskId: tasks[0]!, projectId: c.devProject });
    const look = () => c.svc.stopRefused(c.owner, { stops: f.stops, running: async () => ({ items: running, next: 0 }) });
    assert.deepEqual(await look(), { stopped: [], failed: [] }, "all approved and unchanged: nothing is stopped");
    // One task's text changed after its approval: its running work is not the approved work.
    const edited = (await c.projects.getTask(tasks[1]!))!;
    await c.projects.updateTask({ commandId: cid("ed"), actor: c.owner.id, taskId: tasks[1]!, expectedRevision: edited.revision, title: "NimbleNewt: something else" });
    let r = await look();
    assert.deepEqual(r.stopped, ["att-1"]);
    assert.match(f.asked[0]!.reason, /was changed after the owner approved request/);
    f.held.set(tasks[1]!, "stop");
    // Off: a Suspend in force on task 2 is taken over by the Stop; a Force Stop on task 3 is left alone; task 4's Stop cannot be recorded this tick.
    f.held.set(tasks[2]!, "suspend");
    f.held.set(tasks[3]!, "force-stop");
    f.failFor.add(tasks[4]!);
    await c.svc.disable(c.owner, { commandId: cid("dis"), expectedRevision: (await c.svc.settings(c.owner))!.revision });
    r = await look();
    assert.equal(r.stopped.length + r.failed.length, OWNCODE_STOP.perTick, "at most this many Stops are asked for in one tick");
    assert.deepEqual(r.stopped, ["att-0", "att-2", "att-5", "att-6"]);
    assert.deepEqual(r.failed.map((x) => x.attemptId), ["att-4"]);
    assert.match(r.failed[0]!.error, /could not be recorded/);
    assert.ok(!f.asked.some((x) => x.taskId === tasks[3]), "a Force Stop in force is left to itself");
    for (const t of [tasks[0]!, tasks[2]!, tasks[5]!, tasks[6]!]) f.held.set(t, "stop");
    // The next tick: the failed one is asked again (and now succeeds), and the rest are reached.
    f.failFor.clear();
    r = await look();
    assert.deepEqual(r, { stopped: ["att-4", "att-7"], failed: [] });
    assert.equal(new Set(f.asked.map((x) => x.commandId)).size, f.asked.length, "each attempt's Stop is asked for once");
  });

  suite("the stop look reads a bounded part of the live list per tick and goes on from where it stopped, so work beyond the first part is reached on a later tick", async (c) => {
    const f = fakeStops();
    await c.enable();
    const byHand = (await c.projects.createTask({ commandId: cid("t"), actor: c.owner.id, projectId: c.devProject, title: "by hand" })).id;
    const garden = (await c.projects.createTask({ commandId: cid("t"), actor: c.owner.id, projectId: c.other, title: "weed" })).id;
    // 150 live attempts; only the 121st is work of the development project.
    const live: OwnCodeRunning[] = Array.from({ length: 150 }, (_, i) => (i === 120 ? { attemptId: "att-hand", taskId: byHand, projectId: c.devProject } : { attemptId: `att-g${i}`, taskId: garden, projectId: c.other }));
    const asked: [number, number][] = [];
    const running = async (from: number, limit: number) => { asked.push([from, limit]); const n = Math.min(limit, live.length); return { items: Array.from({ length: n }, (_, i) => live[(from + i) % live.length]!), next: (from + n) % live.length }; };
    const look = () => c.svc.stopRefused(c.owner, { stops: f.stops, running });
    assert.deepEqual(await look(), { stopped: [], failed: [] }, "the first look reads the first 100 only");
    assert.deepEqual(await look(), { stopped: ["att-hand"], failed: [] }, "the next look goes on from there");
    assert.deepEqual(asked, [[0, OWNCODE_STOP.look], [100, OWNCODE_STOP.look]]);
    await look();
    assert.deepEqual(asked.at(-1), [50, OWNCODE_STOP.look], "and wraps round");
  });
}
