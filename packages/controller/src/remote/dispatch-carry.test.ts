import assert from "node:assert/strict";
import { after } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { DoneCheckReport, DoneCheckRequest } from "../dispatch/ports.js";
import type { WorkspaceCall } from "../workspace-ops/index.js";
import { RemoteWorkerHost } from "./host.js";
import { WorkspaceResponder } from "./responder.js";
import { remoteSuite, refuses } from "./testing/suite.js";

after(stopServer);

// Card H12a (leftovers of H12t): a landing asked of a remote host carries the owner's landing policy, and a done on a remote host is checked there, over the same authenticated workspace channel.
let n = 0;
const id = (): string => `wsr-${"qrstuvwxyz234567abcd".slice(0, 20 - 4)}${(++n + 4096).toString(8).split("").map((d) => "abcdefgh"[Number(d)]).join("").slice(-4)}`;
const TASK = "task-aaaaaaaaaaaaaaaaaaaa", PROJECT = "proj-aaaaaaaaaaaaaaaaaaaa", ATT = "att-aaaaaaaaaaaaaaaaaaaa";
const landing = (more: Partial<WorkspaceCall> = {}): WorkspaceCall => ({ requestId: id(), operation: "landing", taskId: TASK, projectId: PROJECT, reason: "land the work", quietAttempts: [], ...more });
const wait = async (read: () => Promise<readonly unknown[]>): Promise<void> => { for (let i = 0; i < 100 && (await read()).length === 0; i++) await new Promise((ok) => setTimeout(ok, 10)); };
const request: DoneCheckRequest = { checks: [{ name: "tests", run: ["npm", "test"], timeoutMs: 1000 }], evidence: ["docs/out.md"], maxOutputBytes: 1000 };
const good: DoneCheckReport = { checkout: true, tree: { uncommitted: [], uncommittedCount: 0, ahead: 1, changed: 2 }, evidence: [{ path: "docs/out.md", present: true }], checks: [{ name: "tests", state: "passed", exitCode: 0, ms: 5 }] };

for (const backend of backends) {
  const suite = remoteSuite(backend);
  const hostWith = (c: { remote: never; dispatcherPrincipal: never }, options: Record<string, unknown> = {}) => new RemoteWorkerHost("host:r1", c.remote, c.dispatcherPrincipal, { resources: { cpus: 1, memoryMb: 1 }, requirements: () => ({}) as never, workspaceWaitMs: 3000, ...options } as never);

  suite("a landing asked of a remote host carries the owner's policy read fresh by the controller; a caller's own landing figures are never taken; any other operation carries none (card H12a)", async (c) => {
    const r1 = await c.host("r1");
    let policy: { branch: string; requirePermit: boolean; protectedPaths: string[]; protectDefaults: boolean } = { branch: "main", requirePermit: true, protectedPaths: ["docs/"], protectDefaults: true };
    const reads: string[] = [];
    const handle = hostWith(c as never, { landingPolicy: async (x: { taskId: string; projectId: string }) => { reads.push(`${x.taskId}/${x.projectId}`); return policy; } });
    const seen: WorkspaceCall[] = [];
    const responder = new WorkspaceResponder({ client: r1.client, busy: () => [], port: { run: async (x) => { seen.push(x); return { ok: true, summary: "ok" }; } } });
    const go = async (call: WorkspaceCall) => { const pending = handle.workspace.run(call); await wait(() => r1.client.workspaceRequests()); responder.handle(await r1.client.workspaceRequests()); return pending; };
    await go(landing({ landing: { branch: "evil", requirePermit: false } }));
    assert.deepEqual(seen[0]!.landing, policy, "the owner's figures reach the host's port, not what the caller put in the request");
    // Read fresh at each landing: a change counts from the next one.
    policy = { ...policy, branch: "trunk", requirePermit: false, protectedPaths: [] };
    await go(landing());
    assert.deepEqual(seen[1]!.landing, policy);
    assert.deepEqual(reads, [`${TASK}/${PROJECT}`, `${TASK}/${PROJECT}`]);
    // Another operation carries no policy, even if a caller put one in.
    await go(landing({ operation: "refresh", landing: { branch: "main" } }));
    assert.equal(seen[2]!.operation, "refresh");
    assert.equal("landing" in seen[2]!, false);
  });

  suite("a landing whose policy cannot be read, names no branch, or has no reader is not sent at all, and says so (fail closed; card H12a)", async (c) => {
    const r1 = await c.host("r1");
    for (const options of [{}, { landingPolicy: async () => ({}) }, { landingPolicy: async () => { throw new Error("settings down"); } }, { landingPolicy: async () => ({ branch: "" }) }]) {
      const answer = await hostWith(c as never, options).workspace.run(landing());
      assert.equal(answer.ok, false);
      assert.match((answer as { reason: string }).reason, /could not be read here, or names no landing branch.*nothing was changed/);
    }
    assert.deepEqual(await r1.client.workspaceRequests(), [], "nothing was listed for the host");
  });

  suite("the carried policy is checked and bounded before it is sent: unknown fields, a path-like branch, wrong types, too many paths, and a policy on any operation but a landing are refused (card H12a)", async (c) => {
    await c.host("r1");
    const ask = (x: WorkspaceCall) => c.remote.askWorkspace(c.dispatcherPrincipal, "host:r1", x, { waitMs: 100 });
    for (const bad of [{ extra: 1 }, { branch: "../x" }, { branch: "-rf" }, { branch: "a b" }, { branch: 7 }, { requirePermit: "no" }, { protectDefaults: 0 }, { protectedPaths: "docs/" }, { protectedPaths: [1] }, { protectedPaths: [""] }, { protectedPaths: ["x".repeat(301)] }, { protectedPaths: Array.from({ length: 101 }, (_, i) => `p${i}`) }, { protectedPaths: ["a\0b"] }, null, []]) {
      await refuses("invalid_command", () => ask(landing({ landing: bad as never })));
    }
    await refuses("invalid_command", () => ask(landing({ operation: "integration", landing: { branch: "main" } })));
  });

  suite("a host that is slow or refuses a landing leaves the policy in no record the host could keep: the request is the same wire shape and the host's refusal comes back as a refusal (card H12a)", async (c) => {
    const r1 = await c.host("r1");
    const handle = hostWith(c as never, { landingPolicy: async () => ({ branch: "main" }) });
    const responder = new WorkspaceResponder({ client: r1.client, busy: () => [], port: { run: async (x) => ({ ok: false, reason: `the owner's landing branch is ${x.landing?.branch}` }) } });
    const pending = handle.workspace.run(landing());
    await wait(() => r1.client.workspaceRequests());
    const listed = await r1.client.workspaceRequests();
    assert.deepEqual(listed[0]!.landing, { branch: "main" });
    responder.handle(listed);
    assert.deepEqual(await pending, { ok: false, reason: "the owner's landing branch is main" });
  });

  suite("a done on a remote host is checked there: the controller's request reaches the host's check and the typed report comes back for the dispatcher (card H12a)", async (c) => {
    const r1 = await c.host("r1");
    const calls: { attemptId: string; scope: unknown; request: DoneCheckRequest }[] = [];
    const responder = new WorkspaceResponder({ client: r1.client, busy: () => [ATT], port: { run: async () => ({ ok: false, reason: "not a workspace request" }) }, verify: async (attemptId, scope, req) => { calls.push({ attemptId, scope, request: req }); return good; } });
    const handle = hostWith(c as never);
    const pending = handle.verify(ATT, { taskId: TASK, projectId: PROJECT }, request);
    await wait(() => r1.client.workspaceRequests());
    const listed = await r1.client.workspaceRequests();
    assert.equal(listed[0]!.operation, "verify");
    assert.deepEqual(listed[0]!.verify, { attemptId: ATT, checks: request.checks, evidence: request.evidence, maxOutputBytes: 1000 });
    responder.handle(listed);
    assert.deepEqual(await pending, good);
    assert.deepEqual(calls, [{ attemptId: ATT, scope: { taskId: TASK, projectId: PROJECT }, request }], "asked while the attempt itself is busy (it is at its end): the busy check does not hold a check back");
  });

  suite("a host that cannot check, fails, or sends a report that does not fit gives no report: the dispatcher is told it could not look, never a pass (card H12a)", async (c) => {
    const r1 = await c.host("r1");
    const run = async (verify: WorkspaceResponder extends never ? never : ConstructorParameters<typeof WorkspaceResponder>[0]["verify"], req: DoneCheckRequest = request) => {
      const responder = new WorkspaceResponder({ client: r1.client, busy: () => [], port: { run: async () => ({ ok: false, reason: "no" }) }, ...(verify === undefined ? {} : { verify }) });
      const outcome = hostWith(c as never).verify(ATT, { taskId: TASK, projectId: PROJECT }, req).then((r) => r, (e: Error) => e);
      await wait(() => r1.client.workspaceRequests());
      responder.handle(await r1.client.workspaceRequests());
      return outcome;
    };
    const refused = async (verify: Parameters<typeof run>[0], text: RegExp) => { const got = await run(verify); assert.ok(got instanceof Error, JSON.stringify(got)); assert.match(got.message, text); };
    await refused(undefined, /cannot check work/);
    await refused(async () => { throw new Error("the sandbox is gone"); }, /could not check the work: the sandbox is gone/);
    // Reports that do not fit what was asked.
    const bogus: [string, unknown][] = [
      ["no checkout flag", { checks: [] }], ["not an object", [1]], ["a check that was not asked", { checkout: true, checks: [{ name: "other", state: "passed" }] }],
      ["a check twice", { checkout: true, checks: [{ name: "tests", state: "passed" }, { name: "tests", state: "passed" }] }], ["a state that is not one", { checkout: true, checks: [{ name: "tests", state: "ok" }] }],
      ["evidence that was not asked", { checkout: true, evidence: [{ path: "etc/passwd", present: true }], checks: [] }], ["a fractional tree figure", { checkout: true, tree: { uncommitted: [], uncommittedCount: 0, ahead: 0.5 }, checks: [] }],
      ["a negative count", { checkout: true, tree: { uncommitted: [], uncommittedCount: -1, ahead: 0 }, checks: [] }], ["too many files named", { checkout: true, tree: { uncommitted: Array.from({ length: 21 }, (_, i) => `f${i}`), uncommittedCount: 21, ahead: 0 }, checks: [] }],
    ];
    for (const [what, report] of bogus) await refused(async () => report as never, /report of the check was not usable|could not check the work: the check gave no report/).catch((e) => { throw new Error(`${what}: ${(e as Error).message}`); });
    // A report too big for an answer is cut (output first), and one that cannot fit at all is a refusal.
    const loud = await run(async () => ({ ...good, checks: [{ name: "tests", state: "failed", exitCode: 1, output: "x".repeat(60_000) }] }));
    assert.ok(!(loud instanceof Error), String(loud));
    assert.equal((loud as DoneCheckReport).checks[0]!.state, "failed");
    assert.ok(((loud as DoneCheckReport).checks[0]!.output ?? "").length <= 600);
    const huge = Array.from({ length: 20 }, (_, i) => ({ name: `c${i}`, run: ["x"], timeoutMs: 10 }));
    const tooBig = await run(async () => ({ checkout: true, tree: { uncommitted: Array.from({ length: 20 }, () => "f".repeat(250)), uncommittedCount: 20, ahead: 1 }, checks: [] }), { ...request, checks: huge });
    assert.ok(tooBig instanceof Error);
    assert.match((tooBig as Error).message, /did not fit in an answer/);
  });

  suite("a check request is bounded before it is sent, and only the owner and dispatcher may ask for one (card H12a)", async (c) => {
    const r1 = await c.host("r1");
    const ann = await c.agent("ann");
    const annPrincipal = await c.principals.authenticate((await c.principals.issueCredential(c.owner, ann.id)).token);
    const ask = (more: Partial<{ attempt: string; req: DoneCheckRequest; scope: { taskId: string; projectId: string } }> = {}) => c.remote.askVerify(c.dispatcherPrincipal, "host:r1", id(), more.attempt ?? ATT, more.scope ?? { taskId: TASK, projectId: PROJECT }, more.req ?? request, { waitMs: 100 });
    await refuses("forbidden", () => c.remote.askVerify(annPrincipal, "host:r1", id(), ATT, { taskId: TASK, projectId: PROJECT }, request, { waitMs: 100 }));
    await refuses("forbidden", () => c.remote.askVerify(r1.principal, "host:r1", id(), ATT, { taskId: TASK, projectId: PROJECT }, request, { waitMs: 100 }));
    await refuses("invalid_command", () => ask({ attempt: "../../x" }));
    await refuses("invalid_command", () => ask({ scope: { taskId: "a/b", projectId: PROJECT } }));
    for (const req of [{ ...request, checks: Array.from({ length: 21 }, () => request.checks[0]!) }, { ...request, checks: [{ name: "", run: ["x"], timeoutMs: 1 }] }, { ...request, checks: [{ name: "t", run: [], timeoutMs: 1 }] }, { ...request, checks: [{ name: "t", run: ["x"], timeoutMs: 0 }] },
      { ...request, checks: [{ name: "t", run: ["x"], timeoutMs: 3_600_001 }] }, { ...request, evidence: [""] }, { ...request, evidence: Array.from({ length: 101 }, (_, i) => `f${i}`) }, { ...request, maxOutputBytes: 0 }, { ...request, maxOutputBytes: 2_000_000 }] as DoneCheckRequest[]) {
      await refuses("invalid_command", () => ask({ req }));
    }
    assert.deepEqual(await r1.client.workspaceRequests(), [], "nothing hostile was sent");
  });
}
