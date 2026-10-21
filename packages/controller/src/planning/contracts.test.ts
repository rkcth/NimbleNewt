import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DeskService, HistoryService, RetrievalService } from "../context/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { BlockerService } from "../domain/blockers.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { WaitService } from "../domain/waits.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { InquiryService } from "../inquiries/index.js";
import { GrantService, PrincipalService, type Grant, type Principal } from "../security/index.js";
import { ContractService, WaitGraphService } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-21T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};

for (const backend of backends) {
  interface Ctx {
    owner: Principal; a: string; b: string; contracts: ContractService; graph: WaitGraphService; blockers: BlockerService; inquiries: InquiryService; projects: ProjectService; assignments: AssignmentService;
    storage: import("../storage/types.js").ControllerStorage;
    task(project: string, title: string, ownedBy?: string): Promise<string>;
    agent(name: string, grants: Grant[], narrow?: { action: string; project: string; taskId: string }[]): Promise<Principal>;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const grantService = GrantService.withEpoch(world.storage, projects.epoch, options);
        const agent = async (nm: string, grants: Grant[], narrow: { action: string; project: string; taskId: string }[] = []) => {
          await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants });
          for (const g of narrow) await grantService.grant(owner, { commandId: cid("g"), grantee: `agent:${nm}`, action: g.action, project: g.project, resource: { kind: "task", id: g.taskId }, source: "direct", basis: "test" });
          return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        };
        const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const b = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
        const assignments = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
        const task = async (project: string, title: string, ownedBy?: string) => {
          const id = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: project, title })).id;
          if (ownedBy !== undefined) {
            await projects.transitionTask({ commandId: cid("tr"), actor: "owner:rob", taskId: id, expectedRevision: 1, to: "ready" });
            await assignments.assignTask({ commandId: cid("as"), actor: "owner:rob", taskId: id, owner: { kind: "agent", id: ownedBy } });
          }
          return id;
        };
        const contracts = ContractService.withEpoch(world.storage, projects.epoch, options);
        const blockers = BlockerService.withEpoch(world.storage, projects.epoch, options);
        const graph = WaitGraphService.withEpoch(world.storage, projects.epoch, contracts, blockers, options);
        const histories = HistoryService.withEpoch(world.storage, projects.epoch, options);
        const desks = DeskService.withEpoch(world.storage, projects.epoch, options);
        const retrieval = RetrievalService.withEpoch(world.storage, projects.epoch, desks, histories, options);
        const waits = WaitService.withEpoch(world.storage, projects.epoch, assignments, options);
        const inquiries = InquiryService.withEpoch(world.storage, projects.epoch, { histories, retrieval, waits, assignments }, options);
        await body({ owner, a, b, contracts, graph, blockers, inquiries, projects, assignments, storage: world.storage, task, agent });
      } finally { await world.close(); }
    });
  const writer = (project: string, ...actions: string[]): Grant[] => [{ action: "task.read", project }, ...actions.map((action) => ({ action, project }))];

  suite("a task with no contract reads as the defaults, so tasks made before contracts keep working", async (c) => {
    const t = await c.task(c.a, "old task");
    const got = (await c.contracts.get(c.owner, t))!;
    assert.deepEqual([got.version, got.priority, got.workClass, got.acceptanceCriteria, got.difficulty], [0, 5, "P", [], undefined]);
    assert.equal(await c.contracts.priorityOf(t), 5);
    assert.deepEqual(await c.contracts.history(c.owner, t), []);
  });

  suite("a contract change stores a new version and keeps the old ones", async (c) => {
    const t = await c.task(c.a, "t");
    await c.contracts.setContract(c.owner, { commandId: cid("c"), taskId: t, expectedVersion: 0, expectedResult: "A working login page", acceptanceCriteria: ["passes the login tests"], priority: 7, requiredEvidence: ["test run"], budget: { maxAttempts: 3 }, permissions: ["task.update"] });
    await c.contracts.setContract(c.owner, { commandId: cid("c"), taskId: t, expectedVersion: 1, priority: 2, difficulty: "hard" });
    const now = (await c.contracts.get(c.owner, t))!;
    assert.deepEqual([now.version, now.priority, now.difficulty, now.expectedResult, now.budget], [2, 2, "hard", "A working login page", { maxAttempts: 3 }]);
    const history = (await c.contracts.history(c.owner, t))!;
    assert.deepEqual(history.map((h) => [h.version, h.priority, h.difficulty]), [[1, 7, undefined], [2, 2, "hard"]], "the first version still says priority 7");
    assert.equal(await c.contracts.priorityOf(t), 2, "the next admission decision sees the new priority");
    await refuses("stale_revision", () => c.contracts.setContract(c.owner, { commandId: cid("c"), taskId: t, expectedVersion: 1, priority: 3 }));
    await refuses("invalid_command", () => c.contracts.setContract(c.owner, { commandId: cid("c"), taskId: t, expectedVersion: 2, priority: 2 }), (e) => assert.match(e.message, /already has/));
    await refuses("invalid_command", () => c.contracts.setContract(c.owner, { commandId: cid("c"), taskId: t, expectedVersion: 2, priority: 12 }));
    await refuses("invalid_command", () => c.contracts.setContract(c.owner, { commandId: cid("c"), taskId: t, expectedVersion: 2, colour: "red" } as never), (e) => assert.match(e.message, /not a field/));
    await c.contracts.setContract(c.owner, { commandId: cid("c"), taskId: t, expectedVersion: 2, difficulty: null });
    assert.equal((await c.contracts.get(c.owner, t))!.difficulty, undefined);
    const replay = await c.contracts.setContract(c.owner, { commandId: "same-c", taskId: t, expectedVersion: 3, priority: 4 });
    assert.equal((await c.contracts.setContract(c.owner, { commandId: "same-c", taskId: t, expectedVersion: 3, priority: 4 })).replayed, true);
    assert.equal(replay.replayed, false);
  });

  suite("each kind of change needs its own authority: difficulty, priority and the P or PC class are separate", async (c) => {
    const t = await c.task(c.a, "t");
    const editor = await c.agent("editor", writer(c.a, "task.contract.write"));
    const planner = await c.agent("planner", writer(c.a, "task.contract.write", "task.class.write", "task.priority.write", "task.difficulty.write"));
    await c.contracts.setContract(editor, { commandId: cid("c"), taskId: t, expectedVersion: 0, acceptanceCriteria: ["done when tests pass"] });
    await refuses("forbidden", () => c.contracts.setContract(editor, { commandId: cid("c"), taskId: t, expectedVersion: 1, difficulty: "expert" }));
    await refuses("forbidden", () => c.contracts.setContract(editor, { commandId: cid("c"), taskId: t, expectedVersion: 1, priority: 9 }));
    await refuses("forbidden", () => c.contracts.setContract(editor, { commandId: cid("c"), taskId: t, expectedVersion: 1, workClass: "PC" }));
    // Lowering the recovery requirement says losing the work is acceptable: it needs planning authority, raising it does not.
    await refuses("forbidden", () => c.contracts.setContract(editor, { commandId: cid("c"), taskId: t, expectedVersion: 1, recovery: "none" }));
    await c.contracts.setContract(editor, { commandId: cid("c"), taskId: t, expectedVersion: 1, recovery: "portable-reconstruction" });
    await refuses("forbidden", () => c.contracts.setContract(editor, { commandId: cid("c"), taskId: t, expectedVersion: 2, recovery: "native-continuation" }));
    await c.contracts.setContract(planner, { commandId: cid("c"), taskId: t, expectedVersion: 2, workClass: "PC", priority: 9, difficulty: "expert", recovery: "none" });
    const now = (await c.contracts.get(c.owner, t))!;
    assert.deepEqual([now.workClass, now.priority, now.difficulty], ["PC", 9, "expert"]);
    // Sending a value the contract already has asks for no authority for that field.
    await c.contracts.setContract(editor, { commandId: cid("c"), taskId: t, expectedVersion: 3, priority: 9, expectedResult: "x" });
    const audit = (await c.storage.listAudit({ afterSeq: 0, limit: 1000 })).filter((e) => e.type === "contract.set").map((e) => e.actor);
    assert.deepEqual(audit, ["agent:editor", "agent:editor", "agent:planner", "agent:editor"], "each change is audited under the one who made it");
  });

  suite("a grant for one task does not cover another, and a task of an unreadable project looks missing", async (c) => {
    const mine = await c.task(c.a, "mine");
    const theirs = await c.task(c.a, "theirs");
    const other = await c.task(c.b, "other project");
    const scoped = await c.agent("scoped", [{ action: "task.read", project: c.a }], [{ action: "task.contract.write", project: c.a, taskId: mine }]);
    await c.contracts.setContract(scoped, { commandId: cid("c"), taskId: mine, expectedVersion: 0, acceptanceCriteria: ["ok"] });
    await refuses("forbidden", () => c.contracts.setContract(scoped, { commandId: cid("c"), taskId: theirs, expectedVersion: 0, acceptanceCriteria: ["no"] }));
    assert.equal(await c.contracts.get(scoped, other), undefined);
    assert.equal(await c.contracts.history(scoped, other), undefined);
    await refuses("forbidden", () => c.contracts.setContract(scoped, { commandId: cid("c"), taskId: other, expectedVersion: 0, acceptanceCriteria: ["no"] }));
  });

  suite("dependencies: same project only, no self, no duplicate, and no cycle however long", async (c) => {
    const [t1, t2, t3] = [await c.task(c.a, "1"), await c.task(c.a, "2"), await c.task(c.a, "3")];
    const foreign = await c.task(c.b, "foreign");
    await c.contracts.addDependency(c.owner, { commandId: cid("d"), taskId: t1, prerequisiteId: t2 });
    await c.contracts.addDependency(c.owner, { commandId: cid("d"), taskId: t2, prerequisiteId: t3 });
    await refuses("invalid_command", () => c.contracts.addDependency(c.owner, { commandId: cid("d"), taskId: t3, prerequisiteId: t1 }), (e) => assert.match(e.message, /depend on each other/));
    await refuses("invalid_command", () => c.contracts.addDependency(c.owner, { commandId: cid("d"), taskId: t2, prerequisiteId: t1 }));
    await refuses("invalid_command", () => c.contracts.addDependency(c.owner, { commandId: cid("d"), taskId: t1, prerequisiteId: t1 }), (e) => assert.match(e.message, /itself/));
    await refuses("invalid_command", () => c.contracts.addDependency(c.owner, { commandId: cid("d"), taskId: t1, prerequisiteId: t2 }), (e) => assert.match(e.message, /already exists/));
    await refuses("invalid_command", () => c.contracts.addDependency(c.owner, { commandId: cid("d"), taskId: t1, prerequisiteId: foreign }), (e) => assert.match(e.message, /same project/));
    const deps = (await c.contracts.dependencies(c.owner, t2))!;
    assert.deepEqual([deps.dependsOn.map((d) => d.prerequisiteId), deps.dependents.map((d) => d.taskId)], [[t3], [t1]]);
    // Removing the middle link makes the opposite direction possible, and the link can be restored.
    await c.contracts.removeDependency(c.owner, { commandId: cid("d"), taskId: t2, prerequisiteId: t3 });
    await c.contracts.addDependency(c.owner, { commandId: cid("d"), taskId: t3, prerequisiteId: t1 });
    await refuses("invalid_command", () => c.contracts.removeDependency(c.owner, { commandId: cid("d"), taskId: t2, prerequisiteId: t3 }), (e) => assert.match(e.message, /no such/));
    await c.contracts.removeDependency(c.owner, { commandId: cid("d"), taskId: t3, prerequisiteId: t1 });
    await c.contracts.addDependency(c.owner, { commandId: cid("d"), taskId: t2, prerequisiteId: t3 });
  });

  suite("two dependencies added at the same moment cannot make a cycle", async (c) => {
    const [t1, t2] = [await c.task(c.a, "1"), await c.task(c.a, "2")];
    const results = await Promise.allSettled([
      c.contracts.addDependency(c.owner, { commandId: cid("d"), taskId: t1, prerequisiteId: t2 }),
      c.contracts.addDependency(c.owner, { commandId: cid("d"), taskId: t2, prerequisiteId: t1 }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "exactly one of the two may apply");
  });

  suite("changing dependencies needs task.dependency.write for that task, and a grant for another team's task does not help", async (c) => {
    const [mine, other, third] = [await c.task(c.a, "mine"), await c.task(c.a, "other team's"), await c.task(c.a, "third")];
    const ann = await c.agent("ann", [{ action: "task.read", project: c.a }], [{ action: "task.dependency.write", project: c.a, taskId: mine }]);
    await c.contracts.addDependency(ann, { commandId: cid("d"), taskId: mine, prerequisiteId: other });
    await refuses("forbidden", () => c.contracts.addDependency(ann, { commandId: cid("d"), taskId: other, prerequisiteId: third }));
    const reader = await c.agent("reader", [{ action: "task.read", project: c.a }]);
    await refuses("forbidden", () => c.contracts.removeDependency(reader, { commandId: cid("d"), taskId: mine, prerequisiteId: other }));
    assert.equal((await c.contracts.dependencies(reader, mine))!.dependsOn.length, 1, "reading needs only read access");
  });

  const rights = (p: string): Grant[] => [{ action: "history.*", project: p }, { action: "desk.write", project: p }, { action: "desk.read", project: p }, { action: "attempt.work", project: p }, { action: "task.read", project: p }];

  suite("ordinary sequential work is not a circular wait: one agent with dependent tasks, or two agents whose dependencies cross but can each finish", async (c) => {
    const [w1, w2] = [await c.task(c.a, "first", "worker"), await c.task(c.a, "second", "worker")];
    await c.contracts.addDependency(c.owner, { commandId: cid("d"), taskId: w1, prerequisiteId: w2 });
    assert.deepEqual(await c.graph.cycles(c.a), [], "one agent doing its own tasks in order");
    const [t1, t2, t3, t4] = [await c.task(c.a, "ann's", "ann"), await c.task(c.a, "ben's", "ben"), await c.task(c.a, "ben's other", "ben"), await c.task(c.a, "ann's other", "ann")];
    await c.contracts.addDependency(c.owner, { commandId: cid("d"), taskId: t1, prerequisiteId: t2 });
    await c.contracts.addDependency(c.owner, { commandId: cid("d"), taskId: t3, prerequisiteId: t4 });
    assert.deepEqual(await c.graph.cycles(c.a), [], "ann waits for ben on one task and ben for ann on another, and neither task waits on the other's");
    assert.deepEqual((await c.graph.detect(c.owner, { commandId: cid("s"), projectId: c.a })).cycles, []);
  });

  suite("a ring of tasks through an inquiry and a dependency is found and becomes one blocker for that ring; it is a new blocker when the ring forms again", async (c) => {
    const t1 = await c.task(c.a, "ann's", "ann");
    const t3 = await c.task(c.a, "ben's", "ben");
    const ann = await c.agent("ann", rights(c.a));
    const ben = await c.agent("ben", rights(c.a));
    await c.contracts.addDependency(c.owner, { commandId: cid("d"), taskId: t3, prerequisiteId: t1 });
    assert.deepEqual(await c.graph.cycles(c.a), [], "ben's task waits for ann's; nothing waits back yet");
    const ask = await c.inquiries.ask(ann, { commandId: cid("ask"), taskId: t1, to: "agent:ben", question: "Which approach did you pick?" });
    const found = await c.graph.cycles(c.a);
    assert.equal(found.length, 1);
    assert.deepEqual([found[0]!.tasks, found[0]!.agents], [[t1, t3].sort(), ["agent:ann", "agent:ben"]]);
    assert.deepEqual(new Set(found[0]!.edges.map((e) => e.via)), new Set(["dependency", "inquiry"]));
    const first = await c.graph.detect(c.owner, { commandId: "scan-1", projectId: c.a });
    const blockerId = first.cycles[0]!.blockerId!;
    const blocker = (await c.blockers.getBlocker(blockerId))!;
    assert.deepEqual([blocker.type, blocker.state, blocker.subject.kind], ["circular_wait", "open", "wait-ring"]);
    assert.match(blocker.summary, /agent:ann/);
    assert.equal(blocker.resolver, [t1, t3].sort()[0] === t1 ? "agent:ann" : "agent:ben", "the owner of the ring's lowest task is who to ask");
    assert.equal((await c.graph.detect(c.owner, { commandId: "scan-2", projectId: c.a })).cycles[0]!.blockerId, blockerId, "the same ring has one open blocker");
    // Answering the inquiry breaks the ring; closing the blocker and asking again makes a new ring and a new blocker.
    await c.inquiries.answer(ben, { commandId: cid("ans"), inquiryId: ask.id, answer: "PostgreSQL." });
    assert.deepEqual(await c.graph.cycles(c.a), [], "an answered inquiry no longer holds anyone up");
    await c.blockers.resolveBlocker({ commandId: cid("rb"), actor: c.owner.id, blockerId, expectedRevision: (await c.blockers.getBlocker(blockerId))!.revision, resolution: "answered" });
    await c.inquiries.ask(ann, { commandId: cid("ask"), taskId: t1, to: "agent:ben", question: "And the schema?" });
    const second = await c.graph.detect(c.owner, { commandId: "scan-3", projectId: c.a });
    assert.notEqual(second.cycles[0]!.blockerId, blockerId, "a ring that forms again after its blocker was resolved gets a new one");
  });

  suite("different rings get different blockers, and a finished task takes its ring away", async (c) => {
    const [a1, b1, a2, b2] = [await c.task(c.a, "a1", "ann"), await c.task(c.a, "b1", "ben"), await c.task(c.a, "a2", "ann"), await c.task(c.a, "b2", "ben")];
    const ann = await c.agent("ann", rights(c.a));
    const ben = await c.agent("ben", rights(c.a));
    await c.inquiries.ask(ann, { commandId: cid("ask"), taskId: a1, to: "agent:ben", question: "First question for you?" });
    await c.inquiries.ask(ben, { commandId: cid("ask"), taskId: b1, to: "agent:ann", question: "First question for you?" });
    await c.inquiries.ask(ann, { commandId: cid("ask"), taskId: a2, to: "agent:ben", question: "Second question for you?" });
    await c.inquiries.ask(ben, { commandId: cid("ask"), taskId: b2, to: "agent:ann", question: "Second question for you?" });
    const { cycles } = await c.graph.detect(c.owner, { commandId: "scan-4", projectId: c.a });
    assert.ok(cycles.length >= 1);
    assert.equal(new Set(cycles.map((x) => x.blockerId)).size, cycles.length, "every ring has its own blocker");
    await refuses("forbidden", async () => c.graph.detect(await c.agent("nobody", []), { commandId: cid("s"), projectId: c.a }));
  });

  suite("a dependency may not name a prerequisite the caller cannot read, and the answers hide tasks the caller cannot see; the responsible agent must exist", async (c) => {
    const [mine, hidden] = [await c.task(c.a, "mine"), await c.task(c.a, "hidden")];
    const ann = await c.agent("ann", [], [{ action: "task.read", project: c.a, taskId: mine }, { action: "task.dependency.write", project: c.a, taskId: mine }]);
    await refuses("invalid_command", () => c.contracts.addDependency(ann, { commandId: cid("d"), taskId: mine, prerequisiteId: hidden }), (e) => assert.match(e.message, /same project/));
    await c.contracts.addDependency(c.owner, { commandId: cid("d"), taskId: hidden, prerequisiteId: mine });
    assert.deepEqual((await c.contracts.dependencies(ann, mine))!.dependents, [], "ann cannot read the hidden task, so the edge to it is not shown");
    assert.equal((await c.contracts.dependencies(c.owner, mine))!.dependents.length, 1);
    const third = await c.task(c.a, "third");
    await c.agent("worker", []);
    await refuses("invalid_command", () => c.contracts.addDependency(c.owner, { commandId: cid("d"), taskId: mine, prerequisiteId: third, responsible: "agent:nobody-here" }), (e) => assert.match(e.message, /active agent/));
    await refuses("invalid_command", () => c.contracts.addDependency(c.owner, { commandId: cid("d"), taskId: mine, prerequisiteId: third, responsible: "owner:rob" }), (e) => assert.match(e.message, /active agent/));
    await c.contracts.addDependency(c.owner, { commandId: cid("d"), taskId: mine, prerequisiteId: third, responsible: "agent:worker" });
  });

  suite("a contract change does not fail because the task itself was edited meanwhile", async (c) => {
    const t = await c.task(c.a, "t");
    await c.projects.updateTask({ commandId: cid("u"), actor: "owner:rob", taskId: t, expectedRevision: 1, title: "renamed" });
    await c.contracts.setContract(c.owner, { commandId: cid("c"), taskId: t, expectedVersion: 0, priority: 8 });
    assert.equal(await c.contracts.priorityOf(t), 8);
  });
}
