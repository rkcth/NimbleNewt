import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { StatusService } from "../status/status.js";
import { ActivityService, REPLAY_LABELS, ReplayLimitsService, ReplayService } from "./index.js";

after(stopServer);

let now = Date.parse("2026-10-31T10:00:00.000Z");
const options = { clock: () => new Date((now += 1000)).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, (error as Error).message); return true; });
};
/** Only these storage calls read. Any other call (a write, a claim, an epoch, a retry, ...) counts, so a new mutator cannot slip through unnoticed. */
const READS = new Set(["currentEpoch", "getOperation", "getAggregate", "listAggregates", "listAudit", "getDelivery", "getEffect", "getTimer", "snapshot"]);
const counting = (storage: ControllerStorage): { storage: ControllerStorage; calls: () => string[] } => {
  const calls: string[] = [];
  const proxy = new Proxy(storage, { get(target, key) {
    const value = (target as never)[key] as unknown;
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => { if (typeof key === "string" && !READS.has(key)) calls.push(key); return (value as (...a: unknown[]) => unknown).apply(target, args); };
  } });
  return { storage: proxy, calls: () => calls };
};

for (const backend of backends) {
  test(`${backend.name}: replay review fixes (reviewer scope, forgery, labels, windows, limits, thinking, ambiguity)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const make = async (nm: string, grants: Grant[]) => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants }); return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token); };
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "A" })).id;
      const assignedTask = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "assigned" })).id;
      const otherTask = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "not assigned" })).id;
      const worker = await make("ann", [{ action: "attempt.work", project }]);
      const rival = await make("bob", [{ action: "attempt.work", project }]);
      const reviewer = await make("rev", [{ action: "history.read", project }]);
      const director = await make("dir", [{ action: "history.read", project }]);
      const deep = await make("dee", [{ action: "history.read", project }, { action: "history.sensitive.read", project }]);
      const roles: Record<string, string[]> = { [reviewer.id]: ["reviewer"], [director.id]: ["reviewer", "director"] };
      const guarded = ActivityService.withEpoch(world.storage, projects.epoch, { ...options, roles: async (id) => roles[id] ?? [], reviewAssignments: async (id, taskId) => (id === reviewer.id && taskId === assignedTask ? ["sbm-x"] : []) });
      const open = ActivityService.withEpoch(world.storage, projects.epoch, options);
      const service: Principal = { id: "service:reviews", kind: "service", name: "reviews", grants: [] };
      const rec = (svc: ActivityService, by: Principal, taskId: string, c: Record<string, unknown>) => svc.record(by, { commandId: cid("r"), taskId, ...c } as never);
      for (const t of [assignedTask, otherTask]) {
        await rec(open, owner, t, { kind: "instruction", summary: `instruction for ${t.slice(0, 8)}` });
        await rec(open, worker, t, { kind: "tool-call", summary: "ran something", payload: { text: "secret tool output" } });
      }
      const replay = ReplayService.withEpoch(world.storage, projects.epoch, guarded);

      // 1. A reviewer reads only the task it was asked to review (steps, payload, explanations, and every replay read), whatever history.read its role bundle carries.
      for (const read of [
        () => replay.open(reviewer, otherTask), () => replay.step(reviewer, otherTask, 1), () => replay.led(reviewer, otherTask, 2), () => replay.search(reviewer, otherTask, "x"), () => replay.export(reviewer, otherTask),
        () => guarded.steps(reviewer, otherTask), () => guarded.payload(reviewer, otherTask, 1), () => guarded.explanations(reviewer, otherTask), () => guarded.explainLater(reviewer, { commandId: cid("l"), taskId: otherTask, seq: 1 }),
      ]) await refuses("not_found", read);
      assert.equal((await replay.open(reviewer, assignedTask)).entries.length, 2);
      assert.equal((await replay.step(reviewer, assignedTask, 2)).step.seq, 2);
      assert.equal((await replay.export(reviewer, assignedTask)).entries.length, 2);
      // ... and not the sensitive content even of the assigned task (that needs the owner or an explicit sensitive grant).
      await refuses("not_found", () => guarded.payload(reviewer, assignedTask, 2));
      assert.equal(((await replay.step(reviewer, assignedTask, 2, { withContent: true })).step.content as { readable?: boolean }).readable, false);
      assert.equal((await guarded.payload(deep, assignedTask, 2))!.text, "secret tool output");
      assert.equal((await guarded.payload(owner, otherTask, 2))!.text, "secret tool output");
      // The project timeline has the same scope: a reviewer sees the steps of the assigned task only; a director, the owner and a plain reader of the project see all.
      const tlTasks = async (who: Principal): Promise<string[]> => [...new Set((await guarded.timeline(who, project, { limit: 100 })).steps.map((x) => x.taskId))].sort();
      assert.deepEqual(await tlTasks(reviewer), [assignedTask]);
      assert.deepEqual(await tlTasks(director), [assignedTask, otherTask].sort());
      assert.deepEqual(await tlTasks(owner), [assignedTask, otherTask].sort());
      // Asking for an explanation after the fact writes to the task: reading it (even as its assigned reviewer) is not enough.
      await refuses("forbidden", () => guarded.explainLater(reviewer, { commandId: cid("l"), taskId: assignedTask, seq: 1 }));
      assert.ok((await guarded.explainLater(worker, { commandId: cid("l"), taskId: assignedTask, seq: 1 })).explanation !== undefined);
      // A director signs off for the project as a whole: the project-wide read stays. A reviewer with no assignment source at all reads nothing (fail closed, as for submissions).
      assert.equal((await replay.open(director, otherTask)).entries.length, 2);
      const noSource = ActivityService.withEpoch(world.storage, projects.epoch, { ...options, roles: async () => ["reviewer"] });
      await refuses("not_found", () => ReplayService.withEpoch(world.storage, projects.epoch, noSource).open(reviewer, assignedTask));
      // A host reads only a task it holds an attempt of, when that is known.
      const host: Principal = { id: "host:h1", kind: "host", name: "h1", grants: [] };
      const hosted = ActivityService.withEpoch(world.storage, projects.epoch, { ...options, hostOwnsAttempt: async (hostId, taskId) => hostId === host.id && taskId === assignedTask });
      assert.equal((await hosted.steps(host, assignedTask)).steps.length, 2);
      await refuses("not_found", () => hosted.steps(host, otherTask));

      // 3. Nobody can retire another's step by claiming to supersede it: only its writer, the owner or a service, and only on the same line.
      await refuses("forbidden", () => rec(open, worker, assignedTask, { kind: "tool-call", summary: "the owner is wrong", supersedes: 1 }));
      await refuses("forbidden", () => rec(open, rival, assignedTask, { kind: "tool-call", summary: "replace ann's", supersedes: 2 }));
      await refuses("forbidden", () => rec(open, worker, assignedTask, { kind: "tool-call", summary: "own step, other line", supersedes: 2, branch: "made-up" }));
      await refuses("invalid_command", () => rec(open, worker, assignedTask, { kind: "tool-call", summary: "no such step", supersedes: 40 }));
      assert.equal((await rec(open, worker, assignedTask, { kind: "tool-call", summary: "redo of my own", supersedes: 2 })).seq, 3);                                   // 3
      assert.equal((await rec(open, owner, assignedTask, { kind: "owner-message", summary: "owner replaces ann's redo", supersedes: 3 })).seq, 4);                      // 4
      assert.equal((await rec(open, service, assignedTask, { kind: "lifecycle", summary: "service replaces", supersedes: 4 })).seq, 5);                                 // 5
      const afterForgery = await replay.open(owner, assignedTask);
      assert.equal(afterForgery.entries.find((e) => e.seq === 1 && "authority" in e && e.authority === "superseded"), undefined, "the owner's instruction is still current");

      // 3b. An old record that claims to supersede another's step (written before the check existed, or some other way) does not retire it when replayed.
      const forged = { steps: async (...a: Parameters<ActivityService["steps"]>) => { const r = await open.steps(...a); return { ...r, steps: r.steps.map((x) => ("seq" in x && x.seq === 3 && !("unavailable" in x) ? { ...x, supersedes: 1 } : x)) }; }, payload: open.payload.bind(open), explanations: open.explanations.bind(open), explanationsPage: open.explanationsPage.bind(open), contentReadable: open.contentReadable.bind(open) };
      const viaForged = await ReplayService.withEpoch(world.storage, projects.epoch, forged as never).open(owner, assignedTask);
      assert.equal(viaForged.entries.find((e) => e.seq === 1 && "authority" in e && e.authority === "superseded"), undefined, "a forged supersede of the owner's instruction is not honoured");
      assert.equal(viaForged.entries.find((e) => e.seq === 3 && "authority" in e && e.authority === "superseded") !== undefined, true, "a genuine one (the owner replacing ann's redo) still is");

      // 4. Outcome and branch are the recorder's claims unless a controller service set them.
      await rec(open, worker, assignedTask, { kind: "branch", summary: "side work", branch: "invented", outcome: "confirmed" });                                         // 6
      await rec(open, service, assignedTask, { kind: "tool-call", summary: "service saw it", outcome: "confirmed", branch: "svc-line" });                               // 7
      await rec(open, owner, assignedTask, { kind: "instruction", summary: "owner says: keep the schema" });                                                            // 8
      await rec(open, worker, assignedTask, { kind: "tool-call", summary: "work on the invented line", branch: "invented", outcome: "dispatched" });                     // 9
      const lined = await replay.open(owner, assignedTask, { limit: 50 });
      const by = (seq: number) => lined.entries.find((e) => e.seq === seq) as Extract<(typeof lined.entries)[number], { lane: string }>;
      assert.equal(by(6).outcomeNote, "reported by agent");
      assert.equal(by(6).laneStatus, "unverified");
      assert.equal(by(6).laneNote, REPLAY_LABELS.unverifiedLane);
      assert.equal(by(7).outcomeNote, undefined, "a service's outcome is the controller's");
      assert.equal(by(7).laneStatus, "controller");
      assert.equal(by(1).laneStatus, "main");
      const registry = ReplayService.withEpoch(world.storage, projects.epoch, guarded, { branchKnown: async (_t, lane) => lane === "invented" });
      assert.equal(((await registry.open(owner, assignedTask, { limit: 50 })).entries.find((e) => e.seq === 6) as { laneStatus: string }).laneStatus, "verified");
      // A step on a made-up line still shows the owner's main-line instruction that led to it.
      const led = await replay.led(owner, assignedTask, 9);
      assert.ok(led.links.some((l) => l.relation === "earlier-step" && l.seq === 8 && /owner says: keep the schema/.test(l.note ?? "")), JSON.stringify(led.links));
      assert.ok(led.links.some((l) => l.seq === 1 && /instruction for/.test(l.note ?? "")), "the first owner instruction too");

      // 5. Windows by step number, bounds that are settings, and flags when a bound cut the answer short.
      const limits = ReplayLimitsService.withEpoch(world.storage, projects.epoch, options);
      const bounded = ReplayService.withEpoch(world.storage, projects.epoch, guarded, { limits });
      await refuses("forbidden", () => limits.get(worker));
      assert.equal((await limits.get(owner)).enabled, true);
      const rev = (await limits.get(owner)).revision;
      await limits.set(owner, { commandId: cid("ls"), scan: 4, expectedRevision: rev });
      await refuses("stale_revision", () => limits.set(owner, { commandId: cid("ls"), scan: 5, expectedRevision: rev }));
      await refuses("invalid_command", () => limits.set(owner, { commandId: cid("ls"), scan: 0 }));
      const newest = await bounded.open(owner, assignedTask, { limit: 50 });
      assert.deepEqual(newest.entries.map((e) => e.seq), [6, 7, 8, 9], "the newest steps are kept, not the oldest");
      assert.deepEqual(newest.summary.range, { first: 6, last: 9, of: 9 });
      assert.equal(newest.summary.scanLimited, true);
      assert.equal(newest.next, undefined);
      // Paging by step number reaches the older ones, and `next` is the next step to show.
      const older = await bounded.open(owner, assignedTask, { from: 1, limit: 3 });
      assert.deepEqual(older.entries.map((e) => e.seq), [1, 2, 3]);
      assert.equal(older.next, 4);
      assert.deepEqual((await bounded.open(owner, assignedTask, { from: older.next!, limit: 3 })).entries.map((e) => e.seq), [4, 5, 6]);
      assert.deepEqual((await bounded.open(owner, assignedTask, { from: 1, limit: 50 })).entries.map((e) => e.seq), [1, 2, 3, 4], "a window ends at the bound and says where to go on");
      assert.equal((await bounded.open(owner, assignedTask, { from: 1, limit: 50 })).next, 5);
      // A step anywhere in the record is found by step/led, and the answer says the window.
      const first = await bounded.step(owner, assignedTask, 1);
      assert.equal(first.step.seq, 1);
      assert.ok(first.window !== undefined && first.window.of === 9);
      assert.equal((await bounded.led(owner, assignedTask, 2)).seq, 2);
      await refuses("not_found", () => bounded.step(owner, assignedTask, 10));
      assert.equal((await bounded.search(owner, assignedTask, "instruction")).scanLimited, true);
      assert.equal((await bounded.export(owner, assignedTask)).truncated.entries, true);
      // Turning the bounds off reads the whole record; the figures stay stored for when they are turned on again.
      await limits.set(owner, { commandId: cid("ls"), enabled: false });
      const whole = await bounded.open(owner, assignedTask, { limit: 50 });
      assert.deepEqual([whole.entries.length, whole.summary.scanLimited, whole.next], [9, false, undefined]);
      assert.equal((await limits.get(owner)).values.scan, 4);
      await limits.set(owner, { commandId: cid("ls"), enabled: true, scan: null });
      assert.equal((await limits.get(owner)).values.scan, 50_000, "null puts the default back");

      // Explanations: an export or a step detail cut by its page bound says so, and the afterwards ones carry their label.
      const pages = (count: number): ActivityService => new Proxy(guarded, { get(target, key) {
        const value = (target as never)[key] as unknown;
        if (key === "explanationsPage") return async (_by: Principal, _t: string, _s: number | undefined, after: number) => ({ items: [], ...(after / 100 + 1 < count ? { next: after + 100 } : {}) });
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      } });
      const longList = ReplayService.withEpoch(world.storage, projects.epoch, pages(5), { limits });
      assert.equal((await longList.export(owner, assignedTask)).truncated.explanations, false);
      await limits.set(owner, { commandId: cid("ls"), exportPages: 2, stepPages: 3 });
      const cut = await longList.export(owner, assignedTask);
      assert.equal(cut.truncated.explanations, true);
      assert.equal(cut.explanations.retrospective.label, REPLAY_LABELS.retrospective);
      assert.equal(cut.explanations.contemporaneous.label, REPLAY_LABELS.contemporaneous);
      assert.equal((await longList.step(owner, assignedTask, 1)).retrospectiveTruncated, true);
      assert.equal((await ReplayService.withEpoch(world.storage, projects.epoch, pages(2), { limits }).step(owner, assignedTask, 1)).retrospectiveTruncated, undefined);

      // 8. Thinking: where the store or the retention marker is not part of this controller the owner is told "unavailable (not wired)", never "none"; everyone else is told there is none.
      const thinking = await replay.thinking(owner, { commandId: cid("th"), taskId: assignedTask, reason: "looking" });
      assert.deepEqual(thinking, { collapsed: true, state: "unavailable", label: REPLAY_LABELS.thinkingUnavailable });
      assert.match(REPLAY_LABELS.thinkingUnavailable, /unavailable \(not wired\)/);
      assert.equal((await replay.step(owner, assignedTask, 1)).thinking?.state, "unavailable");
      await refuses("not_found", () => replay.thinking(worker, { commandId: cid("th"), taskId: assignedTask, reason: "x" }));
      const onlyStore = ReplayService.withEpoch(world.storage, projects.epoch, guarded, { thinking: { read: async () => { throw new Error("must not be read"); } } });
      assert.equal((await onlyStore.thinking(owner, { commandId: cid("th"), taskId: assignedTask, reason: "x" })).state, "unavailable", "without the retention marker removal cannot be judged");

      // 9 and 4 in words: the status view says what was only reported, marks a line nobody verified, and `next` is the step to continue from.
      const status = StatusService.withEpoch(world.storage, projects.epoch, { replay } as never, options);
      const said = (await status.replayLines(owner, { taskId: assignedTask, from: 6, limit: 2 }))!.lines.map((l) => l.text);
      assert.ok(said.some((l) => /^Step 6, .*confirmed, reported by agent, branch invented \(unverified lane\)/.test(l)), said.join("\n"));
      assert.ok(said.some((l) => /^Step 7, .*confirmed, branch svc-line\)/.test(l) && !/reported by/.test(l)), said.join("\n"));
      assert.ok(said.includes("More steps follow; continue from step 8."), said.join("\n"));
      assert.match((await status.replayLines(owner, { taskId: assignedTask, from: 8, limit: 2 }))!.lines[1]!.text, /^Step 8, /, "the continuation starts at the step named, repeating none");

      // 10. Zero effects: no storage call other than a read goes through while replaying (opening, stepping, linking, searching, exporting, thinking, the status view), as any principal.
      const spy = counting(world.storage);
      const spied = ReplayService.withEpoch(spy.storage, projects.epoch, ActivityService.withEpoch(spy.storage, projects.epoch, { ...options, roles: async (id) => roles[id] ?? [], reviewAssignments: async (id, taskId) => (id === reviewer.id && taskId === assignedTask ? ["sbm-x"] : []) }), { limits });
      for (const who of [owner, reviewer, director, worker]) {
        await spied.open(who, assignedTask).catch(() => undefined); await spied.step(who, assignedTask, 1).catch(() => undefined); await spied.led(who, assignedTask, 9).catch(() => undefined);
        await spied.search(who, assignedTask, "work").catch(() => undefined); await spied.export(who, assignedTask).catch(() => undefined); await spied.thinking(who, { commandId: cid("th"), taskId: assignedTask, reason: "x" }).catch(() => undefined);
        await spied.open(who, otherTask).catch(() => undefined); // a refusal writes nothing either
      }
      assert.deepEqual(spy.calls(), []);
    } finally { await world.close(); }
  });
}
