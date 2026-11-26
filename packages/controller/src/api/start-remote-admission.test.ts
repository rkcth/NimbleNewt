import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService } from "../admission/service.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI, workGrants } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { RemoteAttempt, RemoteWorkerClient, workspaceDeclaration } from "../remote/index.js";
import { startController } from "./index.js";

// Card P02 (remote hosts): the composed controller, with its own default admission, gives a remote host a task's workspace work only when the folder that host declares for the project is a repository bound to the project with
// write access to all of it. Scripted hosts speak the real worker protocol over the real transport.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const caps = (workspaces: readonly string[]) => ({ os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [...workspaces] });
const AGENT = "agt-abcdefghijklmnopqrst";
const GARDEN = "/srv/hosts/garden";
const ORCHARD = "/srv/hosts/orchard";
let n = 0;
const rid = (): string => `wsr-${"abcdefghijklmnopqrst".slice(0, 18)}${"abcdefghijklmnopqrstuvwxyz234567"[Math.floor(n / 32) % 32]}${"abcdefghijklmnopqrstuvwxyz234567"[n++ % 32]}`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function world(t: { after: (fn: () => Promise<void>) => void }, extra: { readonly onPolicy?: () => Promise<void>; readonly workspaceAdmission?: () => Promise<string[]> } = {}) {
  const d = mkdtempSync(join(tmpdir(), "nn-p02r-"));
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: {
      timer: new ManualTimer(), manual: true,
      route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "local-only", paidAuthorized: false } }),
      remote: {
        ...(extra.workspaceAdmission === undefined ? {} : { workspaceAdmission: extra.workspaceAdmission }),
        blobDirectory: join(d, "blobs"), placementPolicy: async () => { await extra.onPolicy?.(); return { dataHosts: ["host:r1", "host:r2"] }; }, relocationPolicy: async () => ({ dataHosts: ["host:r1", "host:r2"] }),
        hosts: ["r1", "r2"].map((h) => ({ hostId: `host:${h}`, window: () => 131_072, checkpointWaitMs: 300, pollMs: 20, workspaceWaitMs: 5_000, resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "local-only" as const, harness: "pi" }) })),
      },
    },
  });
  t.after(async () => { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  assert.ok(c.dispatch?.workerUrl !== undefined, c.dispatchProblem);
  const s = c.services;
  const rob = await s.principals.authenticate((await s.principals.bootstrapOwner({ name: "rob" })).token);
  const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
  await s.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: AGENT, grants: workGrants(project, ["read-file"]) });
  const clients = new Map<string, RemoteWorkerClient>();
  let k = 0;
  const host = async (name: string, workspaces: readonly string[]): Promise<RemoteWorkerClient> => {
    let client = clients.get(name);
    if (client === undefined) {
      await s.principals.enroll(rob, { commandId: `e-${name}`, kind: "host", name, grants: [] });
      const token = (await s.principals.issueCredential(rob, `host:${name}`)).token;
      await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: `cap-${name}`, actor: rob.id, host: `host:${name}`, capacity: { cpus: 8, memoryMb: 16_384 } });
      client = new RemoteWorkerClient({ url: c.dispatch!.workerUrl!, token, workerVersion: "worker-9.1.0" });
      clients.set(name, client);
    }
    // A host announces what it holds when it connects; connecting again announces anew (a restarted host with another configuration).
    await client.connect(caps(workspaces) as never, `connect-${name}-${k++}`);
    await client.heartbeat(k * 10);
    return client;
  };
  const task = async (title: string, repositoryId?: string): Promise<{ taskId: string; attemptId: string }> => {
    const taskId = (await s.projects.createTask({ commandId: `t-${title}`, actor: rob.id, projectId: project, title, ...(repositoryId === undefined ? {} : { repositoryId }) })).id;
    await s.projects.transitionTask({ commandId: `r-${title}`, actor: rob.id, taskId, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: `as-${title}`, actor: rob.id, taskId, owner: { kind: "agent", id: AGENT } });
    const a = (await s.assignments.getAssignment(taskId))!;
    const attemptId = (await s.assignments.admitAttempt({ commandId: `ad-${title}`, actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: AGENT }, harness: "pi" })).id;
    return { taskId, attemptId };
  };
  const q = (taskId: string) => ({ taskId, projectId: project, agentId: AGENT, requirements: { data: "local-only" as const, harness: "pi" } });
  const reasonsOf = async (taskId: string, hostId: string): Promise<string> => (await c.dispatch!.remote!.candidates(rob, q(taskId))).refused.find((r) => r.hostId === hostId)?.reasons.join("; ") ?? "";
  return { c, s, rob, project, host, task, q, reasonsOf, clients };
}

test("a remote host is chosen for a task's workspace only on a repository bound to the project with write access to all of it; another folder, an unbound one, a read-only or path-limited one, or none (an older host) is passed over with the reason (card P02)", async (t) => {
  const w = await world(t);
  const garden = await w.s.resources.bindResource(w.rob, { commandId: "b-garden", projectId: w.project, kind: "repository", label: "garden", locator: GARDEN, repositoryId: "garden", access: "write" });
  await w.host("r1", [workspaceDeclaration(w.project, GARDEN)!]);
  // r2 speaks the protocol as a host built before this check: it announces no folder.
  const r2 = await w.host("r2", []);
  const first = await w.task("dig");
  const looked = await w.c.dispatch!.remote!.candidates(w.rob, w.q(first.taskId));
  assert.deepEqual(looked.eligible, ["host:r1"], JSON.stringify(looked));
  assert.match(await w.reasonsOf(first.taskId, "host:r2"), /^host:r2 does not say which folder it uses for project proj-[a-z2-7]{20}, so no workspace is opened there \(a host older than this controller says nothing: update it; otherwise set the project's folder in that host's configuration and bind that folder to the project with write access\)$/);
  // The admitted host works: the dispatcher places the attempt there, and the older host is offered nothing.
  const report = await w.c.dispatch!.dispatcher.tick();
  assert.deepEqual(report.started, [first.attemptId], JSON.stringify(report));
  assert.equal((await w.c.dispatch!.remote!.placement(w.rob, first.attemptId))!.hostId, "host:r1");
  assert.deepEqual(await r2.offers(), [], "the older host is given no workspace work");
  // The same host with each other kind of folder: refused with the owner's fix in words.
  await w.host("r2", [workspaceDeclaration(w.project, "/srv/hosts/elsewhere")!]);
  assert.match(await w.reasonsOf(first.taskId, "host:r2"), /host:r2 may not open this task's workspace: the folder that host uses for the project is not a repository bound to the project; bind that folder, written exactly as in the host's configuration, to the project with write access first \(resource\.bind\)/);
  await w.host("r2", [workspaceDeclaration(w.project, `${GARDEN}/`)!]);
  assert.match(await w.reasonsOf(first.taskId, "host:r2"), /not a repository bound to the project/, "the folder is compared as written");
  const orchard = await w.s.resources.bindResource(w.rob, { commandId: "b-orchard", projectId: w.project, kind: "repository", label: "orchard", locator: ORCHARD, repositoryId: "orchard", access: "read" });
  await w.host("r2", [workspaceDeclaration(w.project, ORCHARD)!]);
  assert.match(await w.reasonsOf(first.taskId, "host:r2"), /host:r2 may not open this task's workspace: the project has read access only to repository "orchard", and an agent's workspace is written in; give the project write access to it first/);
  await w.s.resources.setScope(w.rob, { commandId: "s-orchard", resourceId: orchard.id, expectedRevision: (await w.s.resources.get(w.rob, orchard.id))!.revision, access: "write", paths: ["beds"] });
  assert.match(await w.reasonsOf(first.taskId, "host:r2"), /may use only some paths of repository "orchard" \(beds\), and a workspace holds all of it/);
  await w.host("r2", [workspaceDeclaration(w.project, GARDEN)!, workspaceDeclaration(w.project, ORCHARD)!]);
  assert.match(await w.reasonsOf(first.taskId, "host:r2"), /host:r2 names more than one folder for project/);
  // A task that names a repository: before the pin the look judges the binding the pin will take; a host on another bound repository of the project is refused, the one on the named repository is chosen and the pin is written.
  await w.s.resources.setScope(w.rob, { commandId: "s-orchard2", resourceId: orchard.id, expectedRevision: (await w.s.resources.get(w.rob, orchard.id))!.revision, access: "write" });
  await w.host("r2", [workspaceDeclaration(w.project, ORCHARD)!]);
  const named = await w.task("water", "garden");
  assert.match(await w.reasonsOf(named.taskId, "host:r2"), /is not where repository garden \(bound as "garden"\) is, and the task names that one/);
  // r1 holds the first attempt's agent store; a second attempt of the same agent waits for it, so the first is ended first.
  await w.c.dispatch!.remote!.end(w.rob, first.attemptId, "test: done with the first attempt");
  for (let i = 0; i < 100 && (await w.c.dispatch!.dispatcher.get(w.rob, first.attemptId))?.state === "running"; i++) await sleep(20);
  let started: readonly string[] = [];
  for (let i = 0; i < 50 && !started.includes(named.attemptId); i++) { if (i > 0) await sleep(20); started = (await w.c.dispatch!.dispatcher.tick()).started; }
  assert.ok(started.includes(named.attemptId), "the task that names garden starts on the host that holds garden");
  assert.equal((await w.c.dispatch!.remote!.placement(w.rob, named.attemptId))!.hostId, "host:r1");
  assert.equal((await w.s.resources.getPin(w.rob, named.taskId))?.resourceId, garden.id, "pinned to garden");
});

test("when no host may open the workspace the attempt waits with every host's reason in the plan and the owner is told; binding the host's folder lets it start (card P02)", async (t) => {
  const w = await world(t);
  await w.host("r1", [workspaceDeclaration(w.project, GARDEN)!]);
  await w.host("r2", []);
  const { attemptId } = await w.task("dig");
  const tick = await w.c.dispatch!.dispatcher.tick();
  assert.deepEqual(tick.started, []);
  const entry = tick.skipped.find((x) => x.attemptId === attemptId);
  assert.ok(entry !== undefined, JSON.stringify(tick));
  assert.match(entry.reason, /host:r1 may not open this task's workspace: the folder that host uses for the project is not a repository bound to the project[\s\S]*host:r2 does not say which folder it uses/, entry.reason);
  assert.equal(await w.c.dispatch!.remote!.placement(w.rob, attemptId), undefined, "nothing was offered");
  let blocked = false;
  for (let i = 0; i < 6 && !blocked; i++) blocked = (await w.c.dispatch!.dispatcher.tick()).blocked.some((b) => b.attemptId === attemptId);
  assert.ok(blocked, "after a few ticks the owner is told");
  // The owner binds the folder r1 uses: the same attempt starts there.
  await w.s.resources.bindResource(w.rob, { commandId: "b-garden", projectId: w.project, kind: "repository", label: "garden", locator: GARDEN, repositoryId: "garden", access: "write" });
  const later = await w.c.dispatch!.dispatcher.tick();
  assert.deepEqual(later.started, [attemptId], JSON.stringify({ s: later.skipped, b: later.blocked }));
  assert.equal((await w.c.dispatch!.remote!.placement(w.rob, attemptId))!.hostId, "host:r1");
});

test("an integration or a landing is judged again when it is sent: after the binding is narrowed or unbound, or the host's folder changed, nothing is sent; an older host still takes work that opens no workspace (card P02)", async (t) => {
  const w = await world(t);
  const garden = await w.s.resources.bindResource(w.rob, { commandId: "b-garden", projectId: w.project, kind: "repository", label: "garden", locator: GARDEN, repositoryId: "garden", access: "write" });
  const r1 = await w.host("r1", [workspaceDeclaration(w.project, GARDEN)!]);
  const r2 = await w.host("r2", []);
  const { taskId, attemptId } = await w.task("dig");
  assert.deepEqual((await w.c.dispatch!.dispatcher.tick()).started, [attemptId]);
  const placed = (await w.c.dispatch!.remote!.placement(w.rob, attemptId))!;
  assert.equal(placed.hostId, "host:r1");
  await new RemoteAttempt(r1, attemptId, placed.placement).accept();
  const remote = w.c.dispatch!.remote!;
  const call = (operation: "integration" | "landing" | "refresh") => ({ requestId: rid(), operation, taskId, projectId: w.project, reason: "the owner asked", quietAttempts: [], ...(operation === "landing" ? { landing: { branch: "main" } } : {}) });
  // An answering host: every request it lists is answered as done.
  const answered: string[] = [];
  const answerAll = async (client: RemoteWorkerClient): Promise<void> => { for (const r of await client.workspaceRequests()) { answered.push(`${r.operation}:${r.requestId}`); await client.answerWorkspace(r.requestId, { ok: true, summary: `${r.operation} done` }); } };
  const ask = async (client: RemoteWorkerClient, hostId: string, c: ReturnType<typeof call>) => {
    const pending = remote.askWorkspace(w.rob, hostId, c as never, { waitMs: 5_000 });
    for (let i = 0; i < 50; i++) { await answerAll(client); const done = await Promise.race([pending.then((a) => a), sleep(20).then(() => undefined)]); if (done !== undefined) return done; }
    return pending;
  };
  // Admitted: both are sent and answered.
  assert.deepEqual(await ask(r1, "host:r1", call("integration")), { ok: true, summary: "integration done" });
  assert.deepEqual(await ask(r1, "host:r1", call("landing")), { ok: true, summary: "landing done" });
  // The owner narrows the binding to reading: neither reaches the host.
  await w.s.resources.setScope(w.rob, { commandId: "narrow", resourceId: garden.id, expectedRevision: (await w.s.resources.get(w.rob, garden.id))!.revision, access: "read" });
  const before = answered.length;
  for (const op of ["integration", "landing"] as const) {
    const a = await remote.askWorkspace(w.rob, "host:r1", call(op) as never, { waitMs: 5_000 });
    assert.equal(a.ok, false);
    assert.match((a as { reason: string }).reason, /^nothing was sent to host:r1, so nothing was written to the shared repository: host:r1 may not open this task's workspace: the project has read access only to repository "garden"/);
  }
  assert.deepEqual(await r1.workspaceRequests(), [], "nothing was listed for the host");
  // Work that writes only the task's own checkout (a refresh) is not judged here, as on the local host.
  assert.deepEqual(await ask(r1, "host:r1", call("refresh")), { ok: true, summary: "refresh done" });
  assert.equal(answered.length, before + 1);
  // Write access again: sent.
  await w.s.resources.setScope(w.rob, { commandId: "widen", resourceId: garden.id, expectedRevision: (await w.s.resources.get(w.rob, garden.id))!.revision, access: "write" });
  assert.deepEqual(await ask(r1, "host:r1", call("landing")), { ok: true, summary: "landing done" });
  // The host comes back with another folder for the project: refused.
  await w.host("r1", [workspaceDeclaration(w.project, ORCHARD)!]);
  const moved = await remote.askWorkspace(w.rob, "host:r1", call("integration") as never, { waitMs: 5_000 });
  assert.match((moved as { reason: string }).reason, /nothing was sent to host:r1[\s\S]*not a repository bound to the project/);
  // Comes back as an older host (no folder said): refused.
  await w.host("r1", []);
  const older = await remote.askWorkspace(w.rob, "host:r1", call("landing") as never, { waitMs: 5_000 });
  assert.match((older as { reason: string }).reason, /nothing was sent to host:r1[\s\S]*does not say which folder it uses/);
  assert.deepEqual(await r1.workspaceRequests(), []);
  // The older host r2 still takes work that opens no workspace: a request to purge stored thinking reaches it and is answered.
  const purge = remote.askThinkingPurge(w.rob, "host:r2", rid(), [attemptId], { waitMs: 5_000 });
  let listed: string[] = [];
  for (let i = 0; i < 100 && listed.length === 0; i++) { if (i > 0) await sleep(20); listed = (await r2.workspaceRequests()).map((r) => r.operation); }
  assert.deepEqual(listed, ["pi-thinking-purge"]);
  for (const r of await r2.workspaceRequests()) await r2.answerWorkspace(r.requestId, { ok: true, summary: "purged" });
  assert.equal((await purge).ok, true);
});

test("an offer is judged again when the host reads it, and a move is judged against the target host: a binding narrowed before delivery withdraws the offer, and an older host is refused as a move's target (card P02)", async (t) => {
  const w = await world(t);
  const garden = await w.s.resources.bindResource(w.rob, { commandId: "b-garden", projectId: w.project, kind: "repository", label: "garden", locator: GARDEN, repositoryId: "garden", access: "write" });
  const r1 = await w.host("r1", [workspaceDeclaration(w.project, GARDEN)!]);
  await w.host("r2", []);
  const { attemptId } = await w.task("dig");
  assert.deepEqual((await w.c.dispatch!.dispatcher.tick()).started, [attemptId]);
  assert.equal((await w.c.dispatch!.remote!.placement(w.rob, attemptId))!.state, "offered");
  // Narrowed after the offer was made and before r1 read it: the offer is withdrawn, never delivered, and the attempt ends with the reason.
  await w.s.resources.setScope(w.rob, { commandId: "narrow", resourceId: garden.id, expectedRevision: (await w.s.resources.get(w.rob, garden.id))!.revision, access: "read" });
  assert.deepEqual(await r1.offers(), [], "nothing reaches the host");
  const ended = (await w.c.dispatch!.remote!.placement(w.rob, attemptId))!;
  assert.equal(ended.state, "ended");
  assert.match(ended.history.at(-1)!.reason, /withdrawn before it was delivered, host:r1 would now refuse it: host:r1 may not open this task's workspace: the project has read access only/);
  for (let i = 0; i < 100 && (await w.c.dispatch!.dispatcher.get(w.rob, attemptId))?.state === "running"; i++) await sleep(20);
  assert.match((await w.c.dispatch!.dispatcher.get(w.rob, attemptId))!.outcome?.summary ?? "", /read access only/);
  // Write access again: the readmitted attempt starts on r1 and is taken up; a move to the older host r2 is refused with the reason and leaves it where it is.
  await w.s.resources.setScope(w.rob, { commandId: "widen", resourceId: garden.id, expectedRevision: (await w.s.resources.get(w.rob, garden.id))!.revision, access: "write" });
  let next: string | undefined;
  for (let i = 0; i < 150 && next === undefined; i++) { if (i > 0) await sleep(20); next = (await w.c.dispatch!.dispatcher.tick()).started.find((id) => id !== attemptId); }
  assert.ok(next !== undefined, "the readmitted attempt starts");
  const placed = (await w.c.dispatch!.remote!.placement(w.rob, next))!;
  assert.equal(placed.hostId, "host:r1");
  await new RemoteAttempt(r1, next, placed.placement).accept();
  await assert.rejects(w.c.dispatch!.remote!.relocate(w.rob, { commandId: "move-1", attemptId: next, toHostId: "host:r2", reason: "the owner moves it" }), /host:r2 does not say which folder it uses for project/);
  assert.equal((await w.c.dispatch!.remote!.placement(w.rob, next))!.hostId, "host:r1", "it stays where it was");
});

test("the placement is judged again after the pin: a binding narrowed between the dispatcher's look and the offer refuses the offer, nothing reaches the host, and the attempt waits with the reason (card P02)", async (t) => {
  // The placement policy is read by the dispatcher's looks (before the pin) and again by the placement (after it). The first read after the pin narrows the binding, as an owner's change could land between the two.
  let narrowed = false;
  let narrow: (() => Promise<void>) | undefined;
  const w = await world(t, { onPolicy: async () => { if (!narrowed && narrow !== undefined) await narrow(); } });
  const garden = await w.s.resources.bindResource(w.rob, { commandId: "b-garden", projectId: w.project, kind: "repository", label: "garden", locator: GARDEN, repositoryId: "garden", access: "write" });
  let taskId = "";
  narrow = async () => {
    if (taskId === "" || (await w.s.resources.getPin(w.rob, taskId)) === undefined) return;
    narrowed = true;
    await w.s.resources.setScope(w.rob, { commandId: "narrow", resourceId: garden.id, expectedRevision: (await w.s.resources.get(w.rob, garden.id))!.revision, access: "read" });
  };
  const r1 = await w.host("r1", [workspaceDeclaration(w.project, GARDEN)!]);
  const made = await w.task("dig", "garden");
  const attemptId = made.attemptId;
  taskId = made.taskId;
  const tick = await w.c.dispatch!.dispatcher.tick();
  assert.ok(narrowed, "the binding was narrowed after the pin, before the placement's own judgement");
  assert.deepEqual(tick.started, [], JSON.stringify(tick));
  assert.match(tick.skipped.find((x) => x.attemptId === attemptId)?.reason ?? "", /host:r1 cannot take attempt[\s\S]*host:r1 may not open this task's workspace: the project has read access only to repository "garden"/);
  assert.deepEqual(await r1.offers(), [], "nothing was offered");
});

test("an admission that cannot be read refuses an integration or a landing: nothing is sent (card P02)", async (t) => {
  const w = await world(t, { workspaceAdmission: async () => { throw new Error("the records could not be read"); } });
  const r1 = await w.host("r1", [workspaceDeclaration(w.project, GARDEN)!]);
  for (const operation of ["integration", "landing"] as const) {
    const a = await w.c.dispatch!.remote!.askWorkspace(w.rob, "host:r1", { requestId: rid(), operation, taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: w.project, reason: "the owner asked", quietAttempts: [], ...(operation === "landing" ? { landing: { branch: "main" } } : {}) } as never, { waitMs: 2_000 });
    assert.match((a as { reason: string }).reason, /^nothing was sent to host:r1, so nothing was written to the shared repository: whether host:r1 may write this task's repository could not be checked \(the records could not be read\)/);
  }
  assert.deepEqual(await r1.workspaceRequests(), []);
});
