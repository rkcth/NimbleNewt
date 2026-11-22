import assert from "node:assert/strict";
import { after, test } from "node:test";
import { derivedId } from "../domain/ids.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { ControllerStorage, JsonObject, OperationInput } from "../storage/types.js";
import { NotificationService } from "../notifications/index.js";
import { QaEvidenceService } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-11-18T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const tree = "e".repeat(64);
const MANY = 120; // above the 100-change limit of one operation (two changes per stale record)

/** The storage with a switch: the next write of an operation type fails once it is its `nth` (a stop in the middle of a multi-write task). */
function stopping(storage: ControllerStorage): { storage: ControllerStorage; arm(type: string, nth: number): void; disarm(): void; count(type: string): number } {
  let armed: { type: string; nth: number } | undefined;
  const seen = new Map<string, number>();
  const proxy = new Proxy(storage, {
    get(target, key) {
      if (key === "applyOperation") {
        return async (input: OperationInput) => {
          const type = input.audit[0]?.type ?? "";
          const before = seen.get(type) ?? 0;
          if (armed !== undefined && armed.type === type && before + 1 === armed.nth) throw new Error("stopped");
          const result = await target.applyOperation(input);
          seen.set(type, before + 1);
          return result;
        };
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { storage: proxy, arm: (type, nth) => { armed = { type, nth: (seen.get(type) ?? 0) + nth }; }, disarm: () => { armed = undefined; }, count: (type) => seen.get(type) ?? 0 };
}

for (const backend of backends) {
  test(`${backend.name}: ${MANY} records gone stale at once are invalidated in chunks, with one re-check and one notice each; a stop in the middle is resumed by a repeat (card Q02, batch fix)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
      const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T" })).id;
      const roles = new Map<string, string[]>();
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "qa", grants: [{ action: "task.read", project }] });
      const qa: Principal = await principals.authenticate((await principals.issueCredential(owner, "agent:qa")).token);
      roles.set(qa.id, ["qa"]);
      const runner = new CommandRunner(world.storage, projects.epoch, options);
      const plant = async (kind: string, id: string, body: object, update = false): Promise<void> => {
        const found = await runner.get(kind, id);
        await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { kind, id, update }, build: async () => ({ ref: { kind, id }, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref: { kind, id }, body: body as JsonObject } : { type: "update" as const, ref: { kind, id }, expectedRevision: found.revision, body: body as JsonObject }], detail: {} }) }));
      };
      const delivered = new Map<string, number>();
      const hooked = new Map<string, number>();
      const flaky = stopping(world.storage);
      const ports = {
        rolesOf: async (id: string) => roles.get(id) ?? [],
        // The controller keeps one notice per notice ID; counting the calls of a port would count its repeats, so count distinct IDs and keep the calls apart.
        notify: async (x: { commandId: string }) => { delivered.set(x.commandId, (delivered.get(x.commandId) ?? 0) + 1); },
        invalidated: async (e: { evidence: readonly { evidenceId: string }[] }) => { for (const v of e.evidence) hooked.set(v.evidenceId, (hooked.get(v.evidenceId) ?? 0) + 1); },
      };
      const healthy = QaEvidenceService.withEpoch(world.storage, projects.epoch, ports, options);
      const svc = QaEvidenceService.withEpoch(flaky.storage, projects.epoch, ports, options);
      const sub = derivedId("sbm", cid("sub"));
      await plant("submission", sub, { taskId: task, projectId: project, kind: "code", role: "author", submittedBy: "agent:ann", submittedAt: "2026-11-18T09:00:00.000Z", makesCommit: true, base: "a".repeat(40), tree, patchId: "c".repeat(40), evidence: [] });
      const contract = (v: number, criteria: string[]) => ({ taskId: task, projectId: project, version: v, changedBy: owner.id, acceptanceCriteria: criteria, priority: 5, budget: {}, workClass: "P", requiredEvidence: [], checks: [{ name: "unit", run: ["true"] }], permissions: [], recovery: "native-continuation" });
      const setContract = async (v: number): Promise<void> => {
        const criteria = ["works", ...Array.from({ length: v - 1 }, (_, i) => `c${i}`)];
        await plant("task-contract", task, contract(v, criteria), v > 1);
        await plant("task-contract-version", `${task}.${v}`, { ...contract(v, criteria), changedAt: `2026-11-18T08:0${v}:00.000Z` });
      };
      await setContract(1);
      const ids: string[] = [];
      for (let i = 0; i < MANY; i++) {
        ids.push((await healthy.record(qa, { commandId: cid("r"), submissionId: sub, criteriaRevision: 1, decisions: [], environment: `env-${i}`, observedAt: "2026-11-18T09:30:00.000Z", checks: [{ name: "unit", result: "passed" }] })).id);
      }

      // The criteria change: all of them are stale. One check handles them in chunks (before the fix: invalid_command, nothing written).
      await setContract(2);
      const id = cid("k");
      flaky.arm("qa.evidence.check", 2); // the second chunk's write is lost
      await assert.rejects(svc.check(qa, { commandId: id, taskId: task }), /stopped/);
      const afterStop = await healthy.list(owner, task);
      assert.equal(afterStop.items.filter((i) => i.state === "invalidated").length, 40, "the first chunk was written");
      assert.equal(delivered.size, 40, "its notices went out right away, once each");
      const revisions = new Map(afterStop.items.filter((i) => i.state === "invalidated").map((i) => [i.id, i.revision]));

      // The same command sent again resumes: no record is written twice, the rest is invalidated, the answer reports the whole run.
      flaky.disarm();
      const answer = await svc.check(qa, { commandId: id, taskId: task });
      assert.deepEqual([answer.replayed, answer.invalidated.length, answer.rechecks.length], [false, MANY, MANY]);
      assert.deepEqual([...answer.invalidated].sort(), [...ids].sort());
      const done = await healthy.list(owner, task);
      assert.equal(done.items.filter((i) => i.state === "invalidated").length, MANY);
      assert.equal(done.rechecks.filter((r) => r.state === "pending").length, MANY, "one pending re-check each");
      for (const item of done.items) if (revisions.has(item.id) && item.state === "invalidated") assert.equal(item.revision, revisions.get(item.id), "a record written by the first run is not written again");
      assert.equal(flaky.count("qa.evidence.check"), 3, "three chunk writes in all: 40, 40, 40");
      assert.deepEqual([delivered.size, hooked.size], [MANY, MANY]);
      assert.deepEqual([...delivered.values()].filter((c) => c > 2), [], "no notice more than the one made up for the stopped run's first chunk");

      // A further repeat answers as a repeat and writes nothing.
      const writes = flaky.count("qa.evidence.check");
      assert.deepEqual(await svc.check(qa, { commandId: id, taskId: task }), { taskId: task, invalidated: [], rechecks: [], replayed: false });
      assert.equal(flaky.count("qa.evidence.check"), writes);
    } finally { await world.close(); }
  });

  test(`${backend.name}: an automatic check over ${MANY} stale records stopped in the middle is resumed by the next automatic call, which also makes up the notices of the chunk the stop lost (card Q02, batch fix)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
      const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T" })).id;
      const roles = new Map<string, string[]>();
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "qa", grants: [{ action: "task.read", project }] });
      const qa: Principal = await principals.authenticate((await principals.issueCredential(owner, "agent:qa")).token);
      roles.set(qa.id, ["qa"]);
      const runner = new CommandRunner(world.storage, projects.epoch, options);
      const plant = async (kind: string, id: string, body: object, update = false): Promise<void> => {
        const found = await runner.get(kind, id);
        await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { kind, id, update }, build: async () => ({ ref: { kind, id }, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref: { kind, id }, body: body as JsonObject } : { type: "update" as const, ref: { kind, id }, expectedRevision: found.revision, body: body as JsonObject }], detail: {} }) }));
      };
      const notifications = NotificationService.withEpoch(world.storage, projects.epoch, options);
      const hooked = new Map<string, number>();
      let down = true;
      const flaky = stopping(world.storage);
      const ports = {
        rolesOf: async (id: string) => roles.get(id) ?? [],
        notify: async (x: { commandId: string; recheckId: string; text: string; projectId: string }) => { if (down) throw new Error("not delivered"); await notifications.emitFromController({ commandId: x.commandId, kind: "maintenance", level: "notice", ref: { kind: "qa-recheck", id: x.recheckId }, detail: x.text, projectId: x.projectId }); },
        invalidated: async (e: { evidence: readonly { evidenceId: string }[] }) => { if (down) throw new Error("not run"); for (const v of e.evidence) hooked.set(v.evidenceId, (hooked.get(v.evidenceId) ?? 0) + 1); },
      };
      const healthy = QaEvidenceService.withEpoch(world.storage, projects.epoch, ports, options);
      const svc = QaEvidenceService.withEpoch(flaky.storage, projects.epoch, ports, options);
      const sub = derivedId("sbm", cid("sub"));
      await plant("submission", sub, { taskId: task, projectId: project, kind: "code", role: "author", submittedBy: "agent:ann", submittedAt: "2026-11-18T09:00:00.000Z", makesCommit: true, base: "a".repeat(40), tree, patchId: "c".repeat(40), evidence: [] });
      const contract = (v: number, criteria: string[]) => ({ taskId: task, projectId: project, version: v, changedBy: owner.id, acceptanceCriteria: criteria, priority: 5, budget: {}, workClass: "P", requiredEvidence: [], checks: [{ name: "unit", run: ["true"] }], permissions: [], recovery: "native-continuation" });
      const setContract = async (v: number): Promise<void> => {
        const criteria = ["works", ...Array.from({ length: v - 1 }, (_, i) => `c${i}`)];
        await plant("task-contract", task, contract(v, criteria), v > 1);
        await plant("task-contract-version", `${task}.${v}`, { ...contract(v, criteria), changedAt: `2026-11-18T08:0${v}:00.000Z` });
      };
      await setContract(1);
      const ids: string[] = [];
      for (let i = 0; i < MANY; i++) ids.push((await healthy.record(qa, { commandId: cid("r"), submissionId: sub, criteriaRevision: 1, decisions: [], environment: `env-${i}`, observedAt: "2026-11-18T09:30:00.000Z", checks: [{ name: "unit", result: "passed" }] })).id);
      const items = async (): Promise<Map<string, string[]>> => {
        const out = new Map<string, string[]>();
        for (const a of await world.storage.listAggregates("notification-item", { limit: 1000 })) {
          const ref = (a.body as { ref?: { id?: string } }).ref?.id;
          if (ref !== undefined) out.set(ref, [...(out.get(ref) ?? []), (a.body as { state: string }).state]);
        }
        return out;
      };

      // The contract changes; the first chunk is written but its follow-ups fail, and the second chunk's write is lost.
      await setContract(2);
      flaky.arm("qa.evidence.check", 2);
      await assert.rejects(svc.contractChanged(task), /stopped/);
      flaky.disarm();
      assert.equal(flaky.count("qa.evidence.check"), 1);
      assert.deepEqual([(await items()).size, hooked.size], [0, 0], "the first chunk's follow-ups were lost");

      // The next automatic call (the decision pass) has a new command ID (the index moved): it makes up the lost chunk's follow-ups and carries on with the rest.
      down = false;
      const rest = await svc.decisionChanged(task);
      assert.equal(rest.invalidated.length, MANY - 40, "the records the stopped run did not reach");
      assert.equal(flaky.count("qa.evidence.check"), 1 + 2);
      const sent = await items();
      assert.equal(sent.size, MANY, "a notice for every re-check, including those of the chunk whose follow-ups were lost");
      for (const states of sent.values()) assert.deepEqual(states, ["queued"], "one notice per re-check");
      assert.deepEqual([...hooked.keys()].sort(), [...ids].sort());
      for (const c of hooked.values()) assert.equal(c, 1, "the documentation hook once per record");

      // Everything is written now; a further automatic call has nothing to do and nothing to send twice.
      const writes = flaky.count("qa.evidence.check");
      assert.deepEqual(await svc.contractChanged(task), { taskId: task, invalidated: [], rechecks: [] });
      assert.equal(flaky.count("qa.evidence.check"), writes);
      for (const states of (await items()).values()) assert.deepEqual(states, ["queued"]);
    } finally { await world.close(); }
  });

  test(`${backend.name}: more pending re-checks than one operation takes are settled in chunks by a newer code submission, and a stop in the middle is resumed (card Q02, batch fix)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
      const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T" })).id;
      const roles = new Map<string, string[]>();
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "qa", grants: [{ action: "task.read", project }] });
      const qa: Principal = await principals.authenticate((await principals.issueCredential(owner, "agent:qa")).token);
      roles.set(qa.id, ["qa"]);
      const runner = new CommandRunner(world.storage, projects.epoch, options);
      const plant = async (kind: string, id: string, body: object, update = false): Promise<void> => {
        const found = await runner.get(kind, id);
        await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { kind, id, update }, build: async () => ({ ref: { kind, id }, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref: { kind, id }, body: body as JsonObject } : { type: "update" as const, ref: { kind, id }, expectedRevision: found.revision, body: body as JsonObject }], detail: {} }) }));
      };
      const flaky = stopping(world.storage);
      const healthy = QaEvidenceService.withEpoch(world.storage, projects.epoch, { rolesOf: async (id) => roles.get(id) ?? [] }, options);
      const svc = QaEvidenceService.withEpoch(flaky.storage, projects.epoch, { rolesOf: async (id) => roles.get(id) ?? [] }, options);
      const sub = derivedId("sbm", cid("sub"));
      await plant("submission", sub, { taskId: task, projectId: project, kind: "code", role: "author", submittedBy: "agent:ann", submittedAt: "2026-11-18T09:00:00.000Z", makesCommit: true, base: "a".repeat(40), tree, patchId: "c".repeat(40), evidence: [] });
      const contract = (v: number, criteria: string[]) => ({ taskId: task, projectId: project, version: v, changedBy: owner.id, acceptanceCriteria: criteria, priority: 5, budget: {}, workClass: "P", requiredEvidence: [], checks: [{ name: "unit", run: ["true"] }], permissions: [], recovery: "native-continuation" });
      await plant("task-contract", task, contract(1, ["works"]));
      await plant("task-contract-version", `${task}.1`, { ...contract(1, ["works"]), changedAt: "2026-11-18T08:00:00.000Z" });
      for (let i = 0; i < MANY + 10; i++) await healthy.record(qa, { commandId: cid("r"), submissionId: sub, criteriaRevision: 1, decisions: [], environment: `env-${i}`, observedAt: "2026-11-18T09:30:00.000Z", checks: [{ name: "unit", result: "passed" }] });
      await plant("task-contract", task, contract(2, ["works", "more"]), true);
      await plant("task-contract-version", `${task}.2`, { ...contract(2, ["works", "more"]), changedAt: "2026-11-18T08:01:00.000Z" });
      const checked = await healthy.check(qa, { commandId: cid("k"), taskId: task });
      assert.equal(checked.rechecks.length, MANY + 10);
      assert.equal((await healthy.list(owner, task)).rechecks.filter((r) => r.state === "pending").length, MANY + 10);

      // A newer code submission settles them all; the second chunk's write is lost once.
      const newer = derivedId("sbm", cid("sub"));
      await plant("submission", newer, { taskId: task, projectId: project, kind: "code", role: "author", submittedBy: "agent:ann", submittedAt: "2026-11-18T09:45:00.000Z", makesCommit: true, base: "a".repeat(40), tree: "f".repeat(64), patchId: "d".repeat(40), evidence: [] });
      flaky.arm("qa.recheck.supersede", 2);
      await assert.rejects(svc.submitted(newer), /stopped/);
      flaky.disarm();
      const mid = (await healthy.list(owner, task)).rechecks;
      assert.equal(mid.filter((r) => r.state === "done").length, 80, "the first chunk was written");
      const resumed = await svc.submitted(newer);
      assert.equal(resumed.settled.length, MANY + 10 - 80, "the repeat settles what is left and nothing twice");
      const end = (await healthy.list(owner, task)).rechecks;
      assert.equal(end.filter((r) => r.state === "done" && r.supersededBy === newer).length, MANY + 10);
      assert.deepEqual(await svc.submitted(newer), { settled: [] });
    } finally { await world.close(); }
  });
}
