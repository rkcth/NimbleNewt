import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AssignmentService } from "../domain/assignments.js";
import { BlockerService } from "../domain/blockers.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ContractService, type Difficulty } from "../planning/index.js";
import { GrantService, PrincipalService, type Grant, type Principal } from "../security/index.js";
import { DIFFICULTY_LIMITS, DifficultyService, RoutingService, type DecisionBody, type EscalationBody } from "./index.js";

after(stopServer);

let now = Date.parse("2026-10-22T20:00:00.000Z");
const BLOCKER_KINDS = ["manual_hold", "wait_overdue", "scan_failure", "runtime_hold", "unexplained_block", "delivery_exhausted", "effect_uncertain"] as const;
const options = { clock: () => new Date(now += 1000).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};

// Illustrative names only: nothing here is a default of the product.
const table = {
  providers: { cloudp: { enabled: true, paid: true, location: "cloud" }, localp: { enabled: true, paid: false, location: "local" }, freecloud: { enabled: true, paid: false, location: "cloud" } },
  routes: {
    "localp/small": { contextTokens: 128_000, capabilities: ["tools", "reasoning"] }, "cloudp/big": { contextTokens: 200_000, capabilities: ["tools", "reasoning"] },
    "freecloud/lite": { contextTokens: 64_000, capabilities: ["tools"] },
  },
  profiles: { "r-local": ["localp/small"], "r-cloud": ["cloudp/big", "freecloud/lite"], "r-lite": ["freecloud/lite"] },
  roles: {},
};
const profiles = {
  profiles: {
    quick: { harness: "h-one", routingProfile: "r-local", reasoning: { effort: "low" }, tools: ["task.read"] },
    deep: { harness: "h-two", provider: "cloudp", model: "big", routingProfile: "r-local", reasoning: { effort: "high", maxThinkingTokens: 8000 }, contextTokens: 100_000, needs: ["reasoning"], spendLimitMicros: 5_000_000 },
    thrifty: { routingProfile: "r-cloud", spendLimitMicros: 0 },
    lite: { routingProfile: "r-lite" },
  },
  // An expert task on the small local model and a trivial one on the cloud: the owner's choice, and the point of the test: no tier implies where it runs.
  mapping: { trivial: "deep", easy: "quick", medium: "lite", hard: "deep", expert: "quick" },
};
const ask = { role: "coder", data: "cloud-allowed" as const, paidAuthorized: true };

for (const backend of backends) {
  interface Ctx {
    owner: Principal; host: Principal; parent: Principal; writer: Principal; storage: import("../storage/types.js").ControllerStorage; epoch: number; child: Principal; outsider: Principal; granted: Principal; svc: DifficultyService; routing: RoutingService; contracts: ContractService;
    project: string; task: string; blockers: BlockerService; attempts(taskId: string, count: number): Promise<void>;
    delegated(ceiling?: Difficulty, extra?: { retryBudget?: number; totalBudget?: number }): Promise<void>;
    contract(): Promise<{ version: number; difficulty?: Difficulty; priority: number }>;
    openBlocker(): Promise<string>;
    projects: ProjectService;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      now = Date.parse("2026-10-22T20:00:00.000Z");
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const grantService = GrantService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const project = (await projects.createProject({ commandId: cid("p"), actor: "owner:rob", name: "A" })).id;
        const agent = async (nm: string, grants: Grant[]) => {
          await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants });
          return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        };
        await principals.enroll(owner, { commandId: cid("e"), kind: "host", name: "h1", grants: [] });
        const host = await principals.authenticate((await principals.issueCredential(owner, "host:h1")).token);
        const parent = await agent("pam", [{ action: "task.read", project }, { action: "task.contract.write", project }, { action: "task.difficulty.write", project }]);
        const writer = await agent("quin", [{ action: "task.read", project }, { action: "task.contract.write", project }]);
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "rae", grants: [] });
        const child = await agent("cal", [{ action: "task.read", project }]);
        const outsider = await agent("oz", []);
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "gil", grants: [] });
        const task = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: project, title: "t" })).id;
        await grantService.grant(owner, { commandId: cid("g"), grantee: "agent:gil", action: "task.difficulty.write", project, resource: { kind: "task", id: task }, source: "direct", basis: "test" });
        await grantService.grant(owner, { commandId: cid("g"), grantee: "agent:gil", action: "task.read", project, resource: { kind: "task", id: task }, source: "direct", basis: "test" });
        const granted = await principals.authenticate((await principals.issueCredential(owner, "agent:gil")).token);
        const routing = RoutingService.withEpoch(world.storage, projects.epoch, options);
        await routing.setTable(owner, { commandId: cid("t"), expectedRevision: 0, table });
        const contracts = ContractService.withEpoch(world.storage, projects.epoch, options);
        const svc = DifficultyService.withEpoch(world.storage, projects.epoch, routing, contracts, options);
        const blockers = BlockerService.withEpoch(world.storage, projects.epoch, options);
        let blockerCount = 0;
        const assignments = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
        await projects.transitionTask({ commandId: cid("tr"), actor: "owner:rob", taskId: task, expectedRevision: 1, to: "ready" });
        const owner0 = { kind: "agent" as const, id: "cal" };
        await assignments.assignTask({ commandId: cid("as"), actor: "owner:rob", taskId: task, owner: owner0 });
        const attempts = async (taskId: string, count: number) => {
          for (let i = 0; i < count; i++) {
            const a = (await assignments.getAssignment(taskId))!;
            const r = await assignments.admitAttempt({ commandId: cid("ad"), actor: "owner:rob", taskId, expectedRevision: a.revision, generation: a.generation, owner: owner0 });
            const b = (await assignments.getAssignment(taskId))!;
            await assignments.finishAttempt({ commandId: cid("fi"), actor: "owner:rob", taskId, expectedRevision: b.revision, fence: { generation: a.generation, attemptId: r.id }, outcome: "failed", summary: "no luck" });
          }
        };
        await body({
          owner, host, parent, writer, storage: world.storage, epoch: projects.epoch, child, outsider, granted, svc, routing, contracts, project, task, blockers, attempts, projects,
          delegated: async (ceiling = "medium", extra = {}) => { await svc.delegate(parent, { commandId: cid("d"), taskId: task, child: "agent:cal", ceiling, ...extra }); },
          contract: async () => { const c = (await contracts.get(owner, task))!; return { version: c.version, ...(c.difficulty === undefined ? {} : { difficulty: c.difficulty }), priority: c.priority }; },
          openBlocker: async () => { const r = await blockers.openBlocker({ commandId: cid("b"), actor: "owner:rob", type: BLOCKER_KINDS[blockerCount++ % BLOCKER_KINDS.length]!, subject: { kind: "task", id: task }, summary: "stuck", resolver: "pam" }); return r.id; },
        });
      } finally { await world.close(); }
    });
  const setProfiles = (c: Ctx, proposal: unknown = profiles, expectedRevision = 0) => c.svc.setProfiles(c.owner, { commandId: cid("sp"), expectedRevision, profiles: proposal });
  const level = async (c: Ctx, difficulty: Difficulty | null) => { const v = (await c.contract()).version; await c.svc.setDifficulty(c.owner, { commandId: cid("sd"), taskId: c.task, expectedVersion: v, difficulty }); };
  const resolve = (c: Ctx, label = "r", extra: Record<string, unknown> = {}): Promise<DecisionBody & { id: string }> => c.svc.resolve(c.host, { commandId: cid(label), taskId: c.task, ...ask, ...extra });

  suite("there are no built-in profiles: until the owner configures them a dispatch has no choice, and a bad proposal applies nothing", async (c) => {
    assert.equal(await c.svc.profiles(c.owner), undefined);
    await level(c, "hard");
    const d = await resolve(c);
    assert.equal(d.outcome, "no-choice");
    assert.equal(d.route, undefined);
    assert.match(d.reasons.join(), /no difficulty profiles are configured/);
    const bad: [string, unknown][] = [
      ["unknown route", { ...profiles, profiles: { ...profiles.profiles, deep: { provider: "cloudp", model: "nope" } } }],
      ["unknown routing profile", { ...profiles, profiles: { ...profiles.profiles, quick: { routingProfile: "nope" } } }],
      ["provider alone", { ...profiles, profiles: { ...profiles.profiles, quick: { provider: "cloudp" } } }],
      ["no route at all", { ...profiles, profiles: { ...profiles.profiles, quick: { harness: "h-one" } } }],
      ["mapped to nothing", { ...profiles, mapping: { hard: "ghost" } }],
      ["not a difficulty", { ...profiles, mapping: { huge: "quick" } }],
      ["unknown field", { ...profiles, profiles: { ...profiles.profiles, quick: { routingProfile: "r-local", defaultModel: "x" } } }],
      ["bad effort", { ...profiles, profiles: { ...profiles.profiles, quick: { routingProfile: "r-local", reasoning: { effort: "extreme" } } } }],
      ["negative limit", { ...profiles, profiles: { ...profiles.profiles, quick: { routingProfile: "r-local", spendLimitMicros: -1 } } }],
    ];
    for (const [label, proposal] of bad) await refuses("invalid_command", () => setProfiles(c, proposal), () => undefined).catch((e) => { throw new Error(`${label}: ${String(e)}`); });
    assert.equal(await c.svc.profiles(c.owner), undefined, "nothing was applied");
    await refuses("forbidden", () => c.svc.setProfiles(c.parent, { commandId: cid("sp"), expectedRevision: 0, profiles }));
    const r = await setProfiles(c);
    await refuses("stale_revision", () => setProfiles(c, profiles, 0));
    assert.equal((await c.svc.profiles(c.owner))!.revision, r.revision);
    await refuses("forbidden", () => c.svc.profiles(c.outsider));
    // a difficulty with no mapping, and a task with no difficulty, have no profile: nothing is made up
    await level(c, null);
    assert.match((await resolve(c)).reasons.join(), /no profile is configured for a task with no difficulty/);
    await c.svc.setProfiles(c.owner, { commandId: cid("sp"), expectedRevision: r.revision, profiles: { ...profiles, mapping: { easy: "quick" } } });
    await level(c, "hard");
    assert.match((await resolve(c)).reasons.join(), /no profile is configured for difficulty hard/);
  });

  suite("the difficulty set by the parent selects the configured profile at dispatch; a changed mapping affects only the next dispatch", async (c) => {
    const first = await setProfiles(c);
    await c.delegated("expert");
    await c.svc.setDifficulty(c.parent, { commandId: cid("sd"), taskId: c.task, expectedVersion: 0, difficulty: "hard" });
    const d1 = await resolve(c);
    assert.deepEqual([d1.difficulty, d1.profileName, d1.route, d1.outcome], ["hard", "deep", "cloudp/big", "chosen"]);
    assert.deepEqual([d1.profile?.harness, d1.profile?.reasoning, d1.request.contextTokens, d1.request.needs], ["h-two", { effort: "high", maxThinkingTokens: 8000 }, 100_000, ["reasoning"]]);
    assert.equal(d1.profilesRevision, first.revision);
    // The owner remaps hard to the quick profile.
    await c.svc.setProfiles(c.owner, { commandId: cid("sp"), expectedRevision: first.revision, profiles: { ...profiles, mapping: { ...profiles.mapping, hard: "quick" } } });
    const stored = (await c.svc.decisions(c.owner, c.task)).items;
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.profileName, "deep", "the decision already made keeps the profile it used");
    const d2 = await resolve(c);
    assert.deepEqual([d2.profileName, d2.route], ["quick", "localp/small"]);
    assert.equal((await c.svc.decisions(c.owner, c.task)).items.length, 2);
    const repeat = await c.svc.resolve(c.host, { commandId: cid("fresh"), taskId: c.task, ...ask });
    assert.equal((await c.svc.decisions(c.owner, c.task)).items.length, 3);
    assert.equal(repeat.profileName, "quick");
  });

  suite("repeating a dispatch command returns the recorded decision", async (c) => {
    await setProfiles(c);
    await level(c, "easy");
    const commandId = cid("once");
    const a = await c.svc.resolve(c.host, { commandId, taskId: c.task, ...ask });
    await c.svc.setProfiles(c.owner, { commandId: cid("sp"), expectedRevision: 1, profiles: { ...profiles, mapping: { easy: "lite" } } });
    const b = await c.svc.resolve(c.host, { commandId, taskId: c.task, ...ask });
    assert.deepEqual([b.id, b.profileName, b.revision], [a.id, "quick", a.revision]);
    assert.equal((await c.svc.decisions(c.owner, c.task)).items.length, 1);
    await refuses("command_conflict", () => c.svc.resolve(c.host, { commandId, taskId: c.task, ...ask, role: "other" }));
  });

  suite("changing priority does not change the profile, and changing difficulty does not change priority", async (c) => {
    await setProfiles(c);
    await level(c, "hard");
    const before = await resolve(c);
    await c.contracts.setContract(c.owner, { commandId: cid("pr"), taskId: c.task, expectedVersion: (await c.contract()).version, priority: 9 });
    const after = await resolve(c);
    for (const field of ["difficulty", "profileName", "route", "outcome", "profilesRevision", "routingRevision"] as const) assert.deepEqual(after[field], before[field], field);
    assert.deepEqual(after.profile, before.profile);
    assert.deepEqual(after.candidates, before.candidates);
    assert.equal(await c.contracts.priorityOf(c.task), 9);
    await level(c, "trivial");
    assert.equal(await c.contracts.priorityOf(c.task), 9, "difficulty did not touch priority");
    assert.equal((await resolve(c)).difficulty, "trivial");
    await c.contracts.setContract(c.owner, { commandId: cid("pr"), taskId: c.task, expectedVersion: (await c.contract()).version, priority: 1 });
    assert.equal((await resolve(c)).profileName, "deep");
    assert.equal(JSON.stringify(Object.keys(after.request).sort()), JSON.stringify(["contextTokens", "data", "needs", "paidAuthorized"]), "priority is not part of the request");
  });

  suite("no tier implies locality, provider or model, and the routing rules still apply to the profile's routes", async (c) => {
    await setProfiles(c);
    // trivial is mapped to a cloud model and expert to a local one.
    await level(c, "trivial");
    assert.equal((await resolve(c)).route, "cloudp/big");
    await level(c, "expert");
    assert.equal((await resolve(c)).route, "localp/small");
    // Data that may not leave: the cloud-mapped tier falls back to its own local route; the cloud-only tier has no choice and says why.
    await level(c, "trivial");
    const local = await resolve(c, "r", { data: "local-only" });
    assert.equal(local.route, "localp/small");
    assert.match(local.candidates.find((x) => x.route === "cloudp/big")!.reasons.join(), /may not leave the installation/);
    await level(c, "medium");
    const none = await resolve(c, "r", { data: "local-only" });
    assert.deepEqual([none.outcome, none.route], ["no-choice", undefined]);
    assert.match(none.reasons.join("\n"), /freecloud\/lite: runs in the cloud/);
    // Spending: not authorized, or a limit of 0, skips paid routes; the profile's own context and capability needs apply.
    await level(c, "hard");
    assert.equal((await resolve(c, "r", { paidAuthorized: false })).route, "localp/small");
    await c.svc.setProfiles(c.owner, { commandId: cid("sp"), expectedRevision: 1, profiles: { ...profiles, profiles: { ...profiles.profiles, deep: { ...profiles.profiles.deep, spendLimitMicros: 0 } } } });
    const zero = await resolve(c);
    assert.equal(zero.route, "localp/small", "a limit of 0 means nothing paid");
    assert.match(zero.candidates[0]!.reasons.join(), /paid and spending is not authorized/);
    assert.match(zero.candidates.find((x) => x.route === "localp/small")?.reasons.join() ?? "", /^$/);
    // The route table is the owner's: excluding the chosen route moves the next dispatch on, with no cache.
    await c.routing.exclude(c.owner, { commandId: cid("x"), kind: "route", name: "localp/small", reason: "maintenance" });
    const gone = await resolve(c);
    assert.equal(gone.outcome, "no-choice");
    assert.match(gone.reasons.join("\n"), /maintenance/);
    assert.equal(gone.routingRevision! > zero.routingRevision!, true);
  });

  suite("a dispatch is the dispatcher's: agents cannot ask, and a task they cannot name is not found", async (c) => {
    await setProfiles(c);
    await refuses("forbidden", () => c.svc.resolve(c.child, { commandId: cid("r"), taskId: c.task, ...ask }));
    await refuses("not_found", () => c.svc.resolve(c.host, { commandId: cid("r"), taskId: "task-aaaaaaaaaaaaaaaaaaaa", ...ask }));
    await refuses("invalid_command", () => c.svc.resolve(c.host, { commandId: cid("r"), taskId: c.task, ...ask, role: "bad role" }));
    await refuses("invalid_command", () => c.svc.resolve(c.host, { commandId: cid("r"), taskId: c.task, ...ask, extra: 1 } as never));
  });

  suite("a non-parent without a grant cannot set difficulty; the parent and a grant holder can", async (c) => {
    await c.delegated("medium");
    const set = (who: Principal, difficulty: Difficulty | null, version: number) => c.svc.setDifficulty(who, { commandId: cid("sd"), taskId: c.task, expectedVersion: version, difficulty });
    await refuses("forbidden", () => set(c.child, "hard", 0));
    await refuses("forbidden", () => set(c.outsider, "hard", 0));
    assert.equal((await c.contract()).difficulty, undefined);
    // The child may hold ordinary grants and still is no parent: only the difficulty grant counts.
    const r = await set(c.parent, "easy", 0);
    assert.equal(r.revision, 1);
    assert.equal((await c.contract()).difficulty, "easy");
    await set(c.granted, "hard", 1);
    assert.equal((await c.contract()).difficulty, "hard");
    await refuses("stale_revision", () => set(c.parent, "medium", 1));
    await refuses("invalid_command", () => set(c.parent, "hard", 2), (e) => assert.match(e.message, /already/));
    await refuses("invalid_command", () => set(c.parent, "enormous" as never, 2));
    await set(c.parent, null, 2);
    assert.equal((await c.contract()).difficulty, undefined);
    // Each change is a stored contract version under the principal who made it.
    const history = (await c.contracts.history(c.owner, c.task))!;
    assert.deepEqual(history.map((h) => [h.version, h.difficulty ?? null, h.changedBy]), [[1, "easy", "agent:pam"], [2, "hard", "agent:gil"], [3, null, "agent:pam"]]);
    // A task nobody delegated has no parent: a task reader without the grant is refused.
    const other = (await c.projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: c.project, title: "u" })).id;
    await refuses("forbidden", () => c.svc.setDifficulty(c.writer, { commandId: cid("sd"), taskId: other, expectedVersion: 0, difficulty: "easy" }));
    // The parent has no more than that: no difficulty change on the task, no grant on another field.
    await refuses("forbidden", () => c.contracts.setContract(c.parent, { commandId: cid("pr"), taskId: c.task, expectedVersion: 3, priority: 8 }));
  });

  suite("delegation: only someone with task.contract.write delegates, to an active agent other than themselves, and only the parent changes it", async (c) => {
    const d = (who: Principal, extra: Record<string, unknown> = {}) => c.svc.delegate(who, { commandId: cid("d"), taskId: c.task, child: "agent:cal", ceiling: "medium", ...extra } as never);
    await refuses("forbidden", () => d(c.child));
    await refuses("forbidden", () => d(c.outsider));
    await refuses("invalid_command", () => d(c.parent, { child: "agent:nobody" }));
    await refuses("invalid_command", () => d(c.parent, { child: "agent:pam" }));
    await refuses("invalid_command", () => d(c.parent, { ceiling: "legendary" }));
    await refuses("invalid_command", () => d(c.parent, { retryBudget: 0 }));
    await d(c.parent);
    assert.deepEqual((({ parent, child, ceiling, retryBudget, totalBudget }) => [parent, child, ceiling, retryBudget, totalBudget])((await c.svc.delegation(c.owner, c.task))!), ["agent:pam", "agent:cal", "medium", DIFFICULTY_LIMITS.defaultRetry, DIFFICULTY_LIMITS.defaultTotal]);
    await c.svc.delegate(c.owner, { commandId: cid("d"), taskId: c.task, child: "agent:cal", ceiling: "hard" });
    assert.equal((await c.svc.delegation(c.owner, c.task))!.parent, "agent:pam", "the owner changing it does not make the owner the parent");
    await refuses("forbidden", () => c.svc.delegate(c.granted, { commandId: cid("d"), taskId: c.task, child: "agent:cal", ceiling: "expert" }));
    assert.equal(await c.svc.delegation(c.outsider, c.task), undefined);
    assert.equal((await c.svc.delegation(c.child, c.task))!.child, "agent:cal");
  });

  suite("a blocked child escalates within its ceiling at once, and above it to its parent, who decides", async (c) => {
    await setProfiles(c);
    await c.delegated("medium");
    await level(c, "easy");
    const blocker = await c.openBlocker();
    const e1 = await c.svc.escalate(c.child, { commandId: cid("es"), taskId: c.task, kind: "blocked", reason: "the local model cannot follow this", blockerId: blocker });
    assert.deepEqual([e1.state, e1.route, e1.from, e1.to, e1.requestedBy, e1.evidence], ["applied", "ceiling", "easy", "medium", "agent:cal", { blockerId: blocker }]);
    assert.equal((await c.contract()).difficulty, "medium");
    assert.equal((await resolve(c)).profileName, "lite", "the new difficulty selects the next dispatch's profile");
    // above the ceiling: waits for the parent, changes nothing yet
    const e2 = await c.svc.escalate(c.child, { commandId: cid("es"), taskId: c.task, kind: "blocked", reason: "still stuck", blockerId: await c.openBlocker() });
    assert.deepEqual([e2.state, e2.route, e2.to], ["pending", "parent", "hard"]);
    assert.equal((await c.contract()).difficulty, "medium");
    await refuses("invalid_transition", () => c.svc.escalate(c.child, { commandId: cid("es"), taskId: c.task, kind: "blocked", reason: "again", blockerId: blocker }), (e) => assert.match(e.message, /already waiting/));
    await refuses("forbidden", () => c.svc.decide(c.child, { commandId: cid("de"), taskId: c.task, escalationId: e2.id, approve: true, reason: "me" }));
    await refuses("not_found", () => c.svc.decide(c.outsider, { commandId: cid("de"), taskId: c.task, escalationId: e2.id, approve: true, reason: "me" }));
    const done = await c.svc.decide(c.parent, { commandId: cid("de"), taskId: c.task, escalationId: e2.id, approve: true, reason: "go ahead" });
    assert.deepEqual([done.state, done.decidedBy, done.decisionReason], ["approved", "agent:pam", "go ahead"]);
    assert.equal((await c.contract()).difficulty, "hard");
    assert.equal((await c.svc.delegation(c.owner, c.task))!.ceiling, "hard", "approval raised the ceiling to the target");
    await refuses("invalid_transition", () => c.svc.decide(c.parent, { commandId: cid("de"), taskId: c.task, escalationId: e2.id, approve: false, reason: "late" }), (e) => assert.match(e.message, /approved/));
    // a denial changes nothing but the record
    const e3 = await c.svc.escalate(c.child, { commandId: cid("es"), taskId: c.task, kind: "blocked", reason: "needs the best", blockerId: await c.openBlocker(), to: "expert" });
    assert.equal(e3.state, "pending");
    const denied = await c.svc.decide(c.owner, { commandId: cid("de"), taskId: c.task, escalationId: e3.id, approve: false, reason: "too expensive" });
    assert.equal(denied.state, "denied");
    assert.equal((await c.contract()).difficulty, "hard");
    assert.deepEqual((await c.svc.escalations(c.parent, c.task)).map((e) => e.state), ["applied", "approved", "denied"]);
    // Each change of difficulty is a contract version under who made it.
    assert.deepEqual((await c.contracts.history(c.owner, c.task))!.map((h) => [h.difficulty, h.changedBy]), [["easy", "owner:rob"], ["medium", "agent:cal"], ["hard", "agent:pam"]]);
  });

  suite("escalation needs real evidence and the right caller", async (c) => {
    await c.delegated("hard");
    const es = (who: Principal, extra: Record<string, unknown>) => c.svc.escalate(who, { commandId: cid("es"), taskId: c.task, kind: "blocked", reason: "why", ...extra } as never);
    await refuses("invalid_command", () => es(c.child, {}), (e) => assert.match(e.message, /names the open blocker/));
    await refuses("invalid_command", () => es(c.child, { blockerId: "blk-aaaaaaaaaaaaaaaaaaaa" }));
    const blocker = await c.openBlocker();
    await refuses("invalid_command", () => es(c.child, { kind: "failing" }), (e) => assert.match(e.message, /at least 2 attempts/));
    await refuses("forbidden", () => es(c.parent, { blockerId: blocker }));
    await refuses("not_found", () => es(c.outsider, { blockerId: blocker }));
    await refuses("not_found", () => c.svc.escalate(c.child, { commandId: cid("es"), taskId: "task-aaaaaaaaaaaaaaaaaaaa", kind: "blocked", reason: "x", blockerId: blocker }));
    await refuses("invalid_command", () => es(c.child, { blockerId: blocker, reason: "my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" }));
    await refuses("invalid_command", () => es(c.child, { blockerId: blocker, kind: "tired" }));
    await c.attempts(c.task, 1);
    await refuses("invalid_command", () => es(c.child, { kind: "failing" }), (e) => assert.match(e.message, /had 1/));
    await c.attempts(c.task, 1);
    const failing = await es(c.child, { kind: "failing", reason: "two attempts failed" });
    assert.deepEqual([failing.state, failing.evidence, failing.to], ["applied", { attempts: 2 }, "trivial"]);
    await refuses("invalid_command", () => es(c.child, { blockerId: blocker, to: "trivial" }), (e) => assert.match(e.message, /above the current/));
    // a blocker on another task, or a resolved one, is not evidence
    const other = (await c.projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: c.project, title: "u" })).id;
    const foreign = (await c.blockers.openBlocker({ commandId: cid("b"), actor: "owner:rob", type: "manual_hold", subject: { kind: "task", id: other }, summary: "x", resolver: "pam" })).id;
    await refuses("invalid_command", () => es(c.child, { blockerId: foreign }), (e) => assert.match(e.message, /open blocker on this task/));
    await c.blockers.resolveBlocker({ commandId: cid("rb"), actor: "owner:rob", blockerId: blocker, expectedRevision: 1, resolution: "fixed" });
    await refuses("invalid_command", () => es(c.child, { blockerId: blocker }), (e) => assert.match(e.message, /open blocker/));
  });

  suite("a task that nobody delegated cannot be escalated", async (c) => {
    await refuses("not_found", () => c.svc.escalate(c.child, { commandId: cid("es"), taskId: c.task, kind: "blocked", reason: "x", blockerId: "blk-aaaaaaaaaaaaaaaaaaaa" }));
  });

  suite("the retry budget stops a loop of the same ask, once, in a record", async (c) => {
    await setProfiles(c);
    await c.delegated("trivial", { retryBudget: 2, totalBudget: 10 });
    await level(c, "easy");
    const ask1 = async (reason: string) => c.svc.escalate(c.child, { commandId: cid("es"), taskId: c.task, kind: "blocked", reason, blockerId: await c.openBlocker() });
    for (let i = 0; i < 2; i++) {
      const e = await ask1(`try ${i}`);
      assert.deepEqual([e.state, e.to], ["pending", "medium"]);
      await c.svc.decide(c.parent, { commandId: cid("de"), taskId: c.task, escalationId: e.id, approve: false, reason: "not yet" });
    }
    const stopped = await ask1("try 3");
    assert.equal(stopped.state, "stopped");
    assert.match(stopped.stopReason!, /retry budget is 2/);
    assert.equal((await c.contract()).difficulty, "easy", "a stopped request changes nothing");
    await refuses("invalid_transition", () => ask1("try 4"), (e) => assert.match(e.message, /has stopped/));
    assert.equal((await c.svc.escalations(c.owner, c.task)).length, 3, "the loop wrote one stopped record, not one per ask");
    // the parent can still act on its own
    await c.svc.setDifficulty(c.parent, { commandId: cid("sd"), taskId: c.task, expectedVersion: 1, difficulty: "medium" });
    assert.equal((await resolve(c)).profileName, "lite");
  });

  suite("the total budget stops a climb that never ends, and the top of the ladder has nowhere to go", async (c) => {
    await c.delegated("expert", { retryBudget: 5, totalBudget: 3 });
    const go = async () => c.svc.escalate(c.child, { commandId: cid("es"), taskId: c.task, kind: "blocked", reason: "still blocked", blockerId: await c.openBlocker() });
    const states: string[] = [];
    for (let i = 0; i < 4; i++) states.push((await go()).state);
    assert.deepEqual(states, ["applied", "applied", "applied", "stopped"]);
    assert.equal((await c.contract()).difficulty, "medium");
    assert.match((await c.svc.escalations(c.owner, c.task)).at(-1)!.stopReason!, /total budget of 3/);
    await refuses("invalid_transition", () => go());
  });

  suite("at the highest difficulty there is nothing to escalate to", async (c) => {
    await c.delegated("expert");
    await level(c, "expert");
    const blocker = await c.openBlocker();
    await refuses("invalid_command", () => c.svc.escalate(c.child, { commandId: cid("es"), taskId: c.task, kind: "blocked", reason: "x", blockerId: blocker }), (e) => assert.match(e.message, /highest/));
    assert.equal((await c.svc.escalations(c.owner, c.task)).length, 0);
  });

  suite("repeating an escalation or a decision by command ID applies once", async (c) => {
    await c.delegated("trivial");
    const blocker = await c.openBlocker();
    const command = { commandId: cid("es"), taskId: c.task, kind: "blocked" as const, reason: "stuck", blockerId: blocker };
    const a = await c.svc.escalate(c.child, command);
    const b = await c.svc.escalate(c.child, command);
    assert.equal(a.id, b.id);
    assert.equal((await c.svc.escalations(c.owner, c.task)).length, 1);
    assert.equal((await c.contract()).version, 1);
    await refuses("command_conflict", () => c.svc.escalate(c.child, { ...command, reason: "different" }));
    const e2 = await c.svc.escalate(c.child, { commandId: cid("es"), taskId: c.task, kind: "blocked", reason: "more", blockerId: await c.openBlocker() });
    const decision = { commandId: cid("de"), taskId: c.task, escalationId: e2.id, approve: true, reason: "ok" };
    await c.svc.decide(c.parent, decision);
    const again = await c.svc.decide(c.parent, decision);
    assert.equal(again.state, "approved");
    assert.equal((await c.contract()).version, 2);
  });

  suite("routing decisions and escalations are persisted with reasons and queryable by those who may see the task", async (c) => {
    await setProfiles(c);
    await c.delegated("hard");
    await level(c, "medium");
    const blocker = await c.openBlocker();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await resolve(c, "r", { data: i === 0 ? "local-only" : "cloud-allowed" })).id);
    const page1 = await c.svc.decisions(c.owner, c.task, { limit: 2 });
    assert.equal(page1.items.length, 2);
    const page2 = await c.svc.decisions(c.owner, c.task, { limit: 2, ...(page1.next === undefined ? {} : { afterId: page1.next }) });
    assert.deepEqual([...page1.items, ...page2.items].map((d) => d.id).sort(), [...ids].sort());
    const noChoice = [...page1.items, ...page2.items].find((d) => d.request.data === "local-only")!;
    assert.deepEqual([noChoice.outcome, noChoice.profileName, noChoice.candidates.length > 0, noChoice.reasons.length > 0, noChoice.decidedBy], ["no-choice", "lite", true, true, "host:h1"]);
    assert.equal((await c.svc.decision(c.owner, c.task, ids[1]!))!.route, "freecloud/lite");
    await c.svc.escalate(c.child, { commandId: cid("es"), taskId: c.task, kind: "blocked", reason: "needs more", blockerId: blocker });
    for (const who of [c.parent, c.child, c.granted]) assert.equal((await c.svc.escalations(who, c.task)).length, 1);
    assert.equal((await c.svc.escalations(c.child, c.task))[0]!.reason, "needs more");
    // someone who cannot read the task sees what a missing task would show
    assert.deepEqual(await c.svc.escalations(c.outsider, c.task), []);
    assert.deepEqual((await c.svc.decisions(c.outsider, c.task)).items, []);
    assert.equal(await c.svc.decision(c.outsider, c.task, ids[0]!), undefined);
    assert.deepEqual((await c.svc.decisions(c.child, c.task)).items.length, 3);
    // the owner's routing change shows in the next decision, with the revisions that were used
    const last = await resolve(c);
    assert.equal(last.routingRevision, (await c.routing.get())!.revision);
    assert.equal(last.profilesRevision, (await c.svc.profiles(c.owner))!.revision);
  });

  suite("two escalations or two decisions at the same moment: one wins", async (c) => {
    await c.delegated("easy", { retryBudget: 5, totalBudget: 10 });
    for (let i = 0; i < 4; i++) {
      const fresh = await c.openBlocker();
      const go = (label: string) => c.svc.escalate(c.child, { commandId: cid(label), taskId: c.task, kind: "blocked", reason: label, blockerId: fresh });
      const results = await Promise.allSettled([go("x"), go("y")]);
      // Either one lost the race (stale) or was refused for what the other left (a request waiting), or they ran one after the other and both are in the chain; never two from the same level.
      assert.ok(results.some((r) => r.status === "fulfilled"), `round ${i}`);
      for (const r of results) if (r.status === "rejected") assert.ok(r.reason instanceof DomainError && ["stale_revision", "invalid_transition", "command_conflict", "invalid_command"].includes(r.reason.code), String(r.reason));
      const all = await c.svc.escalations(c.owner, c.task);
      const pending = all.filter((e: EscalationBody) => e.state === "pending");
      if (pending.length > 0) {
        const decide = (label: string) => c.svc.decide(c.parent, { commandId: cid(label), taskId: c.task, escalationId: pending[0]!.id, approve: true, reason: label });
        const both = await Promise.allSettled([decide("p"), decide("q")]);
        assert.equal(both.filter((r) => r.status === "fulfilled").length, 1);
      }
      const after = await c.svc.escalations(c.owner, c.task);
      assert.equal(after.filter((e) => e.state === "pending").length, 0);
      const chain = after.filter((e) => e.state === "applied" || e.state === "approved");
      for (let k = 1; k < chain.length; k++) assert.equal(chain[k]!.from, chain[k - 1]!.to, "each step starts where the one before ended: no two from the same level");
      // the stored difficulty is the one the winner set, once
      const versions = (await c.contracts.history(c.owner, c.task))!;
      assert.equal(new Set(versions.map((v) => v.difficulty)).size, versions.length, "no duplicate difficulty step");
    }
  });

  suite("task.contract.write alone cannot make someone the parent: delegating, setting difficulty and setting the ceiling need authority over difficulty", async (c) => {
    const delegate = (who: Principal, ceiling: Difficulty) => c.svc.delegate(who, { commandId: cid("d"), taskId: c.task, child: "agent:cal", ceiling });
    await refuses("forbidden", () => delegate(c.writer, "expert"), (e) => assert.match(e.message, /difficulty/));
    assert.equal(await c.svc.delegation(c.owner, c.task), undefined, "nothing was created");
    await refuses("forbidden", () => c.svc.setDifficulty(c.writer, { commandId: cid("sd"), taskId: c.task, expectedVersion: 0, difficulty: "hard" }));
    await delegate(c.parent, "easy");
    await refuses("forbidden", () => delegate(c.writer, "expert"));
    const d = (await c.svc.delegation(c.owner, c.task))!;
    assert.deepEqual([d.parent, d.ceiling], ["agent:pam", "easy"], "the parent and the ceiling are untouched");
    await refuses("forbidden", () => c.svc.setDifficulty(c.writer, { commandId: cid("sd"), taskId: c.task, expectedVersion: 0, difficulty: "hard" }));
    await refuses("forbidden", () => c.svc.decide(c.writer, { commandId: cid("de"), taskId: c.task, escalationId: "esc-aaaaaaaaaaaaaaaaaaaa", approve: true, reason: "x" }));
    assert.equal((await c.contract()).difficulty, undefined);
  });

  suite("an owner can replace the parent; nobody else can, and the new parent must be an active agent other than the child", async (c) => {
    await c.delegated("easy");
    const re = (who: Principal, parent: string) => c.svc.reassignParent(who, { commandId: cid("rp"), taskId: c.task, parent });
    await refuses("forbidden", () => re(c.parent, "agent:quin"));
    await refuses("forbidden", () => re(c.writer, "agent:quin"));
    await refuses("invalid_command", () => re(c.owner, "agent:cal"));
    await refuses("invalid_command", () => re(c.owner, "agent:nobody"));
    await refuses("invalid_command", () => re(c.owner, "agent:pam"), (e) => assert.match(e.message, /already/));
    await refuses("not_found", () => c.svc.reassignParent(c.owner, { commandId: cid("rp"), taskId: "task-aaaaaaaaaaaaaaaaaaaa", parent: "agent:quin" }));
    await refuses("forbidden", () => c.svc.setDifficulty(c.writer, { commandId: cid("sd"), taskId: c.task, expectedVersion: 0, difficulty: "easy" }));
    await re(c.owner, "agent:quin");
    const d = (await c.svc.delegation(c.owner, c.task))!;
    assert.deepEqual([d.parent, d.child, d.ceiling, d.setBy], ["agent:quin", "agent:cal", "easy", "owner:rob"]);
    await c.svc.setDifficulty(c.writer, { commandId: cid("sd"), taskId: c.task, expectedVersion: 0, difficulty: "easy" });
    assert.equal((await c.contract()).difficulty, "easy");
  });

  const proxied = (c: Ctx, hook: { run?: () => Promise<void> }): DifficultyService => {
    const storage = new Proxy(c.storage, {
      get(target, prop) {
        if (prop === "getAggregate") return async (ref: { kind: string; id: string }) => { const r = await target.getAggregate(ref); if (ref.kind === "task-contract" && hook.run !== undefined) { const h = hook.run; delete hook.run; await h(); } return r; };
        const v = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    return DifficultyService.withEpoch(storage, c.epoch, c.routing, ContractService.withEpoch(storage, c.epoch, options), options);
  };

  suite("a parent's difficulty change that lands while an escalation is being applied is not overwritten by a lower step", async (c) => {
    await c.delegated("hard");
    await level(c, "easy");
    const blocker = await c.openBlocker();
    const hook: { run?: () => Promise<void> } = { run: async () => { await c.svc.setDifficulty(c.parent, { commandId: cid("sd"), taskId: c.task, expectedVersion: 1, difficulty: "hard" }); } };
    await refuses("stale_revision", () => proxied(c, hook).escalate(c.child, { commandId: cid("es"), taskId: c.task, kind: "blocked", reason: "stuck", blockerId: blocker }));
    assert.equal((await c.contract()).difficulty, "hard");
    assert.equal((await c.svc.escalations(c.owner, c.task)).length, 0, "the refused request left no record");
    // the same for a decision: the parent's own later setting wins over the approval of a lower request
    await c.svc.delegate(c.parent, { commandId: cid("d"), taskId: c.task, child: "agent:cal", ceiling: "easy" });
    await level(c, "easy");
    const e = await c.svc.escalate(c.child, { commandId: cid("es"), taskId: c.task, kind: "blocked", reason: "stuck", blockerId: blocker });
    assert.equal(e.state, "pending");
    const v = (await c.contract()).version;
    const hook2: { run?: () => Promise<void> } = { run: async () => { await c.svc.setDifficulty(c.owner, { commandId: cid("sd"), taskId: c.task, expectedVersion: v, difficulty: "expert" }); } };
    await refuses("stale_revision", () => proxied(c, hook2).decide(c.parent, { commandId: cid("de"), taskId: c.task, escalationId: e.id, approve: true, reason: "ok" }));
    assert.equal((await c.contract()).difficulty, "expert");
    assert.equal((await c.svc.escalations(c.owner, c.task))[0]!.state, "pending", "the decision did not apply");
  });

  suite("failing counts attempts since the last change, and a blocker is evidence once", async (c) => {
    await c.delegated("expert");
    const failing = () => c.svc.escalate(c.child, { commandId: cid("es"), taskId: c.task, kind: "failing", reason: "attempts failed" });
    await c.attempts(c.task, 2);
    const e1 = await failing();
    assert.deepEqual([e1.state, e1.attemptsAtChange, e1.evidence], ["applied", 2, { attempts: 2 }]);
    await refuses("invalid_command", () => failing(), (e) => assert.match(e.message, /since the last change; this task has had 0/));
    await c.attempts(c.task, 1);
    await refuses("invalid_command", () => failing(), (e) => assert.match(e.message, /has had 1/));
    await c.attempts(c.task, 1);
    assert.equal((await failing()).to, "easy");
    const blocker = await c.openBlocker();
    const blocked = () => c.svc.escalate(c.child, { commandId: cid("es"), taskId: c.task, kind: "blocked", reason: "stuck", blockerId: blocker });
    assert.equal((await blocked()).state, "applied");
    await refuses("invalid_command", () => blocked(), (e) => assert.match(e.message, /already used/));
  });

  suite("the parent's decision on a stopped request, or a redelegation, begins new budgets", async (c) => {
    await c.delegated("trivial", { retryBudget: 1, totalBudget: 10 });
    await level(c, "easy");
    const ask1 = async () => c.svc.escalate(c.child, { commandId: cid("es"), taskId: c.task, kind: "blocked", reason: "stuck", blockerId: await c.openBlocker() });
    const deny = (id: string) => c.svc.decide(c.parent, { commandId: cid("de"), taskId: c.task, escalationId: id, approve: false, reason: "no" });
    const first = await ask1();
    assert.equal(first.state, "pending");
    await deny(first.id);
    const stopped = await ask1();
    assert.deepEqual([stopped.state, stopped.route], ["stopped", undefined], "a stopped request carries no route");
    await refuses("invalid_transition", () => ask1(), (e) => assert.match(e.message, /has stopped/));
    await refuses("forbidden", () => c.svc.decide(c.child, { commandId: cid("de"), taskId: c.task, escalationId: stopped.id, approve: true, reason: "me" }));
    const decided = await deny(stopped.id);
    assert.deepEqual([decided.state, decided.route, decided.decidedBy], ["denied", "parent", "agent:pam"]);
    const second = await ask1();
    assert.equal(second.state, "pending", "a new round: the budgets start again");
    await deny(second.id);
    assert.equal((await ask1()).state, "stopped");
    await c.svc.delegate(c.parent, { commandId: cid("d"), taskId: c.task, child: "agent:cal", ceiling: "trivial", retryBudget: 1, totalBudget: 10 });
    const third = await ask1();
    assert.equal(third.state, "pending", "a redelegation begins a new round too");
    // approving a stopped request applies it
    await deny(third.id);
    const stop2 = await ask1();
    assert.equal(stop2.state, "stopped");
    const ok = await c.svc.decide(c.parent, { commandId: cid("de"), taskId: c.task, escalationId: stop2.id, approve: true, reason: "fine" });
    assert.equal(ok.state, "approved");
    assert.equal((await c.contract()).difficulty, "medium");
    assert.equal((await c.svc.delegation(c.owner, c.task))!.ceiling, "medium");
  });
}
