import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { DeskService, HistoryService, RetrievalService } from "../context/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { BlockerService } from "../domain/blockers.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { WaitService } from "../domain/waits.js";
import { InquiryService } from "../inquiries/index.js";
import { ContractService, WaitGraphService } from "../planning/index.js";
import { PrincipalService, TaskCredentialService } from "../security/index.js";
import { API_VERSION, StateApi } from "./index.js";

after(stopServer);

/**
 * Card U11d, refusal counting: a `forbidden` answer of the state API to an AGENT (its own credential or a task credential) goes to the denial hook, once per refused request, with the agent's ID (and the task's
 * project for a task credential); the owner, a bad credential, a missing record and any other error are not refusals; a hook that throws or rejects changes nothing in the answer.
 */
const options = { clock: () => "2026-10-21T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

for (const backend of backends) {
  for (const hook of ["works", "throws", "rejects"] as const) {
    test(`${backend.name}: the API's forbidden answer to an agent is counted as a refusal (hook that ${hook})`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const assignments = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
        const waits = WaitService.withEpoch(world.storage, projects.epoch, assignments, options);
        const desks = DeskService.withEpoch(world.storage, projects.epoch, options);
        const histories = HistoryService.withEpoch(world.storage, projects.epoch, options);
        const retrieval = RetrievalService.withEpoch(world.storage, projects.epoch, desks, histories, options);
        const inquiries = InquiryService.withEpoch(world.storage, projects.epoch, { histories, retrieval, waits, assignments }, options);
        const agents = AgentService.withEpoch(world.storage, projects.epoch, options);
        const contracts = ContractService.withEpoch(world.storage, projects.epoch, options);
        const graph = WaitGraphService.withEpoch(world.storage, projects.epoch, contracts, BlockerService.withEpoch(world.storage, projects.epoch, options), options);
        const taskCredentials = TaskCredentialService.withEpoch(world.storage, projects.epoch, options);
        const told: { agentId: string; projectId?: string }[] = [];
        const onDenied = (d: { agentId: string; projectId?: string }): unknown => {
          told.push(d);
          if (hook === "throws") throw new Error("the counter is down");
          if (hook === "rejects") return Promise.reject(new Error("the counter is down"));
          return undefined;
        };
        const api = new StateApi({ principals, taskCredentials, projects, assignments, retrieval, inquiries, agents, contracts, graph, onDenied });
        const ownerToken = (await principals.bootstrapOwner({ name: "rob" })).token;
        const owner = (await principals.authenticate(ownerToken))!;
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [] });
        const annToken = (await principals.issueCredential(owner, "agent:ann")).token;
        const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "A" })).id;
        const other = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "B" })).id;
        const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "in A" })).id;
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "bob", grants: [{ action: "task.read", project }] });
        const taskToken = (await taskCredentials.issue(owner, { commandId: cid("i"), taskId: task, agentId: "agent:bob" })).token;
        const ask = (token: string, op: string, args: Record<string, unknown> = {}) => api.handle(token, { v: API_VERSION, op, args });

        // An agent asking for what it has no grant for.
        const a = await ask(annToken, "task.list", { projectId: project });
        assert.ok(!a.ok && a.error.code === "forbidden", JSON.stringify(a));
        assert.deepEqual(told, [{ agentId: "agent:ann" }]);
        const b = await ask(annToken, "task.get", { taskId: task });
        assert.ok(!b.ok && b.error.code === "forbidden", JSON.stringify(b));
        assert.equal(told.length, 2, "each refused request is one refusal");
        // A task credential naming another project: its own project goes with the refusal.
        const c = await ask(taskToken, "task.list", { projectId: other });
        assert.ok(!c.ok && c.error.code === "forbidden", JSON.stringify(c));
        assert.deepEqual(told[2], { agentId: "agent:bob", projectId: project });
        // Not refusals: a request the agent may make, a missing record, a bad request, a bad credential, and the owner.
        const before = told.length;
        assert.ok((await ask(taskToken, "task.get", { taskId: task })).ok);
        assert.ok(!(await ask(taskToken, "no.such.op")).ok);
        assert.ok(!(await ask(`${taskToken}x`, "task.get", { taskId: task })).ok);
        assert.ok(!(await ask("nope", "task.get", { taskId: task })).ok);
        assert.ok((await ask(ownerToken, "task.list", { projectId: other })).ok);
        assert.equal(told.length, before);
        // Only an agent's refusal is counted: a host that asks for what it may not is refused all the same, and not told.
        await principals.enroll(owner, { commandId: cid("e"), kind: "host", name: "w1", grants: [] });
        const hostToken = (await principals.issueCredential(owner, "host:w1")).token;
        const h = await ask(hostToken, "task.list", { projectId: project });
        assert.ok(!h.ok && h.error.code === "forbidden", JSON.stringify(h));
        assert.equal(told.length, before);
      } finally { await world.close(); }
    });
  }
}
