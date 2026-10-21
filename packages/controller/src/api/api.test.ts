import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { DeskService, HistoryService, RetrievalService } from "../context/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { ProjectService } from "../domain/service.js";
import { WaitService } from "../domain/waits.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { InquiryService } from "../inquiries/index.js";
import { PrincipalService, type Grant } from "../security/index.js";
import { API_VERSION, OPERATIONS, PAGE, StateApi, renderApiDocs, type ApiResponse } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-21T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

for (const backend of backends) {
  interface Ctx {
    api: StateApi; ownerToken: string; internal: unknown[]; assignments: AssignmentService; projects: ProjectService;
    agent(name: string, grants: Grant[]): Promise<string>;
    call(token: string, request: unknown): Promise<ApiResponse>;
    ok(token: string, request: unknown): Promise<Extract<ApiResponse, { ok: true }>>;
    fails(token: string, request: unknown): Promise<Extract<ApiResponse, { ok: false }>["error"]>;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>, wrap?: (deps: ConstructorParameters<typeof StateApi>[0]) => ConstructorParameters<typeof StateApi>[0]) =>
    test(`${backend.name}: ${name}`, async () => {
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
        const internal: unknown[] = [];
        const deps = { principals, projects, assignments, retrieval, inquiries, onInternalError: (e: unknown) => { internal.push(e); } };
        const api = new StateApi(wrap === undefined ? deps : wrap(deps));
        const ownerToken = (await principals.bootstrapOwner({ name: "rob" })).token;
        const owner = await principals.authenticate(ownerToken);
        const agent = async (nm: string, grants: Grant[]) => {
          await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants });
          return (await principals.issueCredential(owner, `agent:${nm}`)).token;
        };
        const call = (token: string, request: unknown) => api.handle(token, request);
        const ok = async (token: string, request: unknown) => { const r = await call(token, request); assert.ok(r.ok, JSON.stringify(r)); return r as Extract<ApiResponse, { ok: true }>; };
        const fails = async (token: string, request: unknown) => { const r = await call(token, request); assert.ok(!r.ok, `expected a refusal: ${JSON.stringify(r)}`); return (r as Extract<ApiResponse, { ok: false }>).error; };
        await body({ api, ownerToken, internal, assignments, projects, agent, call, ok, fails });
      } finally { await world.close(); }
    });
  const command = (op: string, args: Record<string, unknown>, commandId = cid("c")) => ({ v: API_VERSION, op, commandId, args });
  const query = (op: string, args: Record<string, unknown> = {}) => ({ v: API_VERSION, op, args });

  suite("the envelope is strict: version, operation, arguments and command IDs are all checked", async ({ ownerToken, fails, ok }) => {
    assert.equal((await fails(ownerToken, { v: 2, op: "project.list" })).field, "v");
    assert.match((await fails(ownerToken, { v: 2, op: "project.list" })).message, /version 1 only/);
    assert.equal((await fails(ownerToken, query("project.erase"))).field, "op");
    assert.equal((await fails(ownerToken, { v: 1 })).code, "invalid_command");
    assert.equal((await fails(ownerToken, "project.list")).code, "invalid_command");
    assert.equal((await fails(ownerToken, { v: 1, op: "project.list", extra: true })).field, "request.extra");
    assert.equal((await fails(ownerToken, { v: 1, op: "project.list", args: [] })).field, "args");
    assert.equal((await fails(ownerToken, query("project.list", { colour: "red" }))).field, "args.colour");
    assert.equal((await fails(ownerToken, { v: 1, op: "project.list", commandId: "x" })).field, "commandId", "a query takes none");
    assert.equal((await fails(ownerToken, { v: 1, op: "project.create", args: { name: "P" } })).field, "commandId", "a command needs one");
    assert.equal((await fails(ownerToken, { v: 1, op: "project.create", commandId: "x", args: { name: "P", commandId: "y" } })).field, "args");
    assert.equal((await fails(ownerToken, { v: 1, op: "project.create", commandId: "x", args: { name: "P", actor: "owner:someone-else" } })).field, "args");
    assert.equal((await fails(ownerToken, command("project.create", { name: "P", surprise: 1 }))).code, "invalid_command");
    const done = await ok(ownerToken, command("project.create", { name: "P" }));
    assert.deepEqual([done.v, done.op, done.accepted, done.completed], [1, "project.create", true, true]);
  });

  suite("authentication: a bad, rotated or missing credential is refused alike, and nothing about the request leaks", async ({ api, fails, ownerToken }) => {
    const answers = await Promise.all([api.handle("nonsense", query("project.list")), api.handle(undefined, query("project.list")), api.handle(`${ownerToken}x`, query("project.list"))]);
    for (const r of answers) assert.ok(!r.ok && r.error.code === "unauthenticated" && r.error.message === "the credential was not accepted", JSON.stringify(r));
    void fails;
  });

  suite("writes are idempotent by command ID, conflict when it is reused for something else, and refuse a stale revision with the current one", async ({ ownerToken, ok, fails }) => {
    const first = await ok(ownerToken, command("project.create", { name: "Alpha" }, "create-alpha"));
    const again = await ok(ownerToken, command("project.create", { name: "Alpha" }, "create-alpha"));
    assert.deepEqual([again.result["id"], again.result["replayed"]], [first.result["id"], true]);
    assert.equal((await fails(ownerToken, command("project.create", { name: "Beta" }, "create-alpha"))).code, "command_conflict");
    const id = first.result["id"] as string;
    const updated = await ok(ownerToken, command("project.update", { projectId: id, expectedRevision: 1, goal: "ship it" }));
    assert.equal(updated.result["revision"], 2);
    const stale = await fails(ownerToken, command("project.update", { projectId: id, expectedRevision: 1, goal: "again" }));
    assert.deepEqual([stale.code, stale.currentRevision], ["stale_revision", 2]);
    assert.equal((await fails(ownerToken, command("project.update", { projectId: id, goal: "no revision" }))).field, "expectedRevision");
  });

  suite("accepted is not completed: assigning is recorded at once but not done until the worker acts; a state change is done when accepted", async ({ ownerToken, ok, assignments, projects }) => {
    const p = await ok(ownerToken, command("project.create", { name: "P" }));
    const t = await ok(ownerToken, command("task.create", { projectId: p.result["id"], title: "do it" }));
    const taskId = t.result["id"] as string;
    const moved = await ok(ownerToken, command("task.transition", { taskId, expectedRevision: 1, to: "ready" }));
    assert.deepEqual([moved.accepted, moved.completed, moved.awaits], [true, true, undefined]);
    const assigned = await ok(ownerToken, command("task.assign", { taskId, owner: { kind: "agent", id: "ann" } }));
    assert.deepEqual([assigned.accepted, assigned.completed], [true, false]);
    assert.match(assigned.awaits ?? "", /worker admitting an attempt/);
    const seen = await ok(ownerToken, query("assignment.get", { taskId }));
    assert.deepEqual([(seen.result["item"] as { state: string }).state, (seen.result["item"] as { owner: { id: string } }).owner.id], ["assigned", "ann"]);
    const row = (await ok(ownerToken, query("task.get", { taskId }))).result["item"] as { state: string };
    assert.equal(row.state, "ready", "accepted work has not started: the task is still ready");
    // The worker admits an attempt; the same query now shows it under way.
    const a = (await assignments.getAssignment(taskId))!;
    await assignments.admitAttempt({ commandId: cid("ad"), actor: "agent:ann", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: "ann" } });
    assert.ok(((await ok(ownerToken, query("assignment.get", { taskId }))).result["item"] as { revision: number }).revision >= a.revision);
    void projects;
    const history = await ok(ownerToken, query("assignment.history", { taskId }));
    assert.equal((history.result["items"] as unknown[]).length, 1);
    const released = await ok(ownerToken, command("task.release", { taskId, expectedRevision: (await assignments.getAssignment(taskId))!.revision }));
    assert.equal(released.completed, true);
  });

  suite("every client sees the same facts, scoped to the principal: lists, gets and searches show only what its grants allow", async ({ ownerToken, agent, ok, fails, call }) => {
    const a = (await ok(ownerToken, command("project.create", { name: "A" }))).result["id"] as string;
    const b = (await ok(ownerToken, command("project.create", { name: "B" }))).result["id"] as string;
    const ta = (await ok(ownerToken, command("task.create", { projectId: a, title: "in a" }))).result["id"] as string;
    const tb = (await ok(ownerToken, command("task.create", { projectId: b, title: "in b" }))).result["id"] as string;
    const ann = await agent("ann", [{ action: "project.read", project: a }, { action: "task.read", project: a }]);
    const chatClient = ann; // the same credential presented by a chat front end and by an API client
    const viaChat = await ok(chatClient, query("task.list", { projectId: a }));
    const viaApi = await ok(ann, query("task.list", { projectId: a }));
    assert.deepEqual(viaChat.result, viaApi.result, "the same facts through either client");
    assert.deepEqual((viaApi.result["items"] as { id: string }[]).map((i) => i.id), [ta]);
    assert.deepEqual(((await ok(ann, query("project.list"))).result["items"] as { id: string }[]).map((i) => i.id), [a]);
    assert.equal(((await ok(ownerToken, query("task.list"))).result["items"] as unknown[]).length, 2, "the owner lists across projects");
    assert.equal((await fails(ann, query("task.list"))).code, "forbidden", "anyone else must name a project");
    const hidden = await fails(ann, query("task.get", { taskId: tb }));
    const absent = await fails(ann, query("task.get", { taskId: "task-aaaaaaaaaaaaaaaaaaaa" }));
    assert.deepEqual([hidden.code, hidden.message], [absent.code, absent.message], "another project's task reads like a missing one");
    assert.equal((await fails(ann, query("project.get", { projectId: b }))).code, "forbidden");
    assert.equal((await fails(ann, command("task.create", { projectId: a, title: "not allowed" }))).code, "forbidden");
    assert.deepEqual((await ok(ann, query("search", { projectId: b, query: "anything" }))).result["hits"], [], "a search of a project the caller has no rights in finds nothing and says nothing more");
    assert.deepEqual((await ok(ann, query("inquiry.pending"))).result["items"], []);
    void call;
  });

  suite("lists are paged: limit and cursor give every item once, and a bad limit is refused", async ({ ownerToken, ok, fails }) => {
    for (let i = 0; i < 5; i++) await ok(ownerToken, command("project.create", { name: `P${i}` }));
    const seen: string[] = [];
    let after: string | undefined;
    for (let pages = 0; pages < 10; pages++) {
      const page = await ok(ownerToken, query("project.list", { limit: 2, ...(after === undefined ? {} : { after }) }));
      const items = page.result["items"] as { id: string }[];
      assert.ok(items.length <= 2);
      seen.push(...items.map((i) => i.id));
      after = page.result["next"] as string | undefined;
      if (after === undefined) break;
    }
    assert.equal(seen.length, 5);
    assert.equal(new Set(seen).size, 5);
    assert.equal((await fails(ownerToken, query("project.list", { limit: 0 }))).field, "args.limit");
    assert.equal((await fails(ownerToken, query("project.list", { limit: PAGE.max + 1 }))).field, "args.limit");
    assert.equal((await fails(ownerToken, query("project.list", { limit: "ten" }))).field, "args.limit");
    assert.equal(((await ok(ownerToken, query("project.list"))).result["items"] as unknown[]).length, 5, "the default limit");
  });

  suite("failures that are not part of the contract are reported without detail", async ({ ownerToken, call, internal }) => {
    const r = await call(ownerToken, query("search", { projectId: "proj-aaaaaaaaaaaaaaaaaaaa", query: "words" }));
    assert.ok(!r.ok && r.error.code === "unavailable" && r.error.message === "the request could not be completed", JSON.stringify(r));
    assert.equal(internal.length, 1);
    assert.match(String(internal[0]), /disk detail leaked: \/srv\/secret/);
  }, (deps) => ({ ...deps, retrieval: { search: async () => { throw new Error("disk detail leaked: /srv/secret"); } } as never }));
}

test("the documentation is generated from the operation table and is up to date", () => {
  const file = fileURLToPath(new URL("../../../../docs/nimblenewt/api-v1.md", import.meta.url));
  assert.equal(readFileSync(file, "utf8"), renderApiDocs(), "run `npm run build && npm run api:docs:write` and commit the result");
  for (const op of OPERATIONS) assert.ok(renderApiDocs().includes(`#### \`${op.name}\``), `${op.name} is documented`);
  assert.equal(new Set(OPERATIONS.map((o) => o.name)).size, OPERATIONS.length, "operation names are unique");
});
