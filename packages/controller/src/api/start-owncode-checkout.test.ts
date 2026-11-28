import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import { programRoot } from "../owncode/index.js";
import { startController } from "./index.js";
import { ownCodeExtraGuards } from "./start.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

// Card B06, third slice, in the composed controller: the NimbleNewt development project works only in a checkout of its own. The controller's own folders are guarded: its program files (the source tree
// these tests run from), its data directory (the SQLite file's folder) and the rest. A checkout bound inside them, or reached through a link to them, keeps the feature from being enabled, with the owner told
// where and why; a separate one lets it be enabled. A checkout moved into the data directory after an attempt was admitted makes the dispatcher hold that attempt with a refusal that names no folder; after a
// restart it is judged again; moved back, the attempt goes on.
test("the NimbleNewt development project works only in its own checkout, apart from the running installation's program files and data directory (card B06, third slice)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-b06c-"));
  const co = mkdtempSync(join(tmpdir(), "nn-b06c-co-"));
  const links = mkdtempSync(join(tmpdir(), "nn-b06c-ln-"));
  const open = () => startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true, route: async () => ({ route: "cloud/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: true } }) } });
  let c = await open();
  let n = 0;
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const devProject = (await c.services.projects.createProject({ commandId: "p-dev", actor: rob.id, name: "NimbleNewt development" })).id;
    const made = await c.services.agents.create(rob, { commandId: "mk-ann", friendlyName: "Ann", roles: ["author"] });
    const ann = `agent:${made.id}`;
    const annToken = (await c.services.principals.issueCredential(rob, ann)).token;
    const bind = async (label: string, locator: string) => c.services.resources.bindResource(rob, { commandId: `b${++n}`, projectId: devProject, kind: "repository", label, locator, access: "write" } as never);
    const unbind = async (r: { id: string; revision: number }) => { await c.services.resources.unbindResource(rob, { commandId: `u${++n}`, resourceId: r.id, expectedRevision: r.revision }); };
    const enable = async () => call(boot.token, "owncode.enable", { projectId: devProject }, `en-${++n}`);

    // Inside the program files the controller runs from.
    const live = await bind("live", join(programRoot(), "packages", "controller"));
    const inProgram = await enable();
    assert.equal(inProgram.error?.code, "unavailable", JSON.stringify(inProgram));
    assert.match(inProgram.error.message, /repository "live" at .*packages[\\/]controller is inside the running installation's program files/);
    await unbind(live);
    // Inside the data directory (the database's folder).
    mkdirSync(join(d, "dev"));
    const inData = await bind("in data", join(d, "dev"));
    assert.match((await enable()).error.message, /inside the controller's data directory/);
    await unbind(inData);
    // Through a link to the program files.
    symlinkSync(programRoot(), join(links, "nn"));
    const linked = await bind("linked", join(links, "nn"));
    assert.match((await enable()).error.message, /is the same folder as the running installation's program files/);
    await unbind(linked);
    assert.deepEqual((await call(boot.token, "owncode.settings", {})).result, { revision: 0, enabled: false, history: [] }, "no refused enable wrote anything");

    // Its own checkout: enabled, and the owner reads that it is separate.
    const own = await bind("NimbleNewt source", co);
    const enabled = await enable();
    assert.deepEqual(enabled.result, { revision: 1, projectId: devProject }, JSON.stringify(enabled));
    assert.deepEqual((await call(boot.token, "owncode.settings", {})).result.checkout, { separate: true });
    const asked = await call(annToken, "owncode.request", { what: "list blocked tasks first", why: "owners miss them", effort: "two hours", cost: "a few cents" }, "ask-1");
    const taskId = (await call(boot.token, "owncode.decide", { requestId: asked.result.id, expectedRevision: 1, decision: "approve" }, "d-1")).result.taskId as string;
    const s = c.services;
    const t = (await s.projects.getTask(taskId))!;
    await s.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId, expectedRevision: t.revision, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: rob.id, taskId, owner: { kind: "agent", id: ann } });
    const a = (await s.assignments.getAssignment(taskId))!;
    const admitted = (await s.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: ann }, harness: "pi" })).id;
    const heldFor = async (): Promise<string | undefined> => (await c.dispatch!.dispatcher.tick()).skipped.find((x) => x.attemptId === admitted && x.check === "decision")?.reason;
    assert.equal(await heldFor(), undefined, "its own checkout: not held by the B06 gate");

    // The checkout is moved into the data directory after the admission: the dispatcher holds the attempt. Its reason names no folder; the owner's settings say where and why.
    const moved = await c.services.resources.moveResource(rob, { commandId: "mv1", resourceId: own.id, expectedRevision: own.revision, locator: join(d, "dev") });
    const held = (await heldFor()) ?? "";
    assert.match(held, /not confirmed to be apart from the running installation/);
    assert.ok(!held.includes(d) && !held.includes(tmpdir()), held);
    assert.match((await call(boot.token, "owncode.settings", {})).result.checkout.reason, /repository "NimbleNewt source" at .* is inside the controller's data directory/);
    assert.equal((await call(annToken, "owncode.settings", {})).error.code, "forbidden", "only the owner reads where the checkout is and why");

    // After a restart it is judged again, from the records and the disk as they are then.
    await c.close();
    c = await open();
    assert.match((await heldFor()) ?? "", /not confirmed to be apart/);
    // Moved back to its own checkout: the attempt is no longer held.
    await c.services.resources.moveResource(rob, { commandId: "mv2", resourceId: own.id, expectedRevision: moved.revision, locator: co });
    assert.equal(await heldFor(), undefined);
    assert.deepEqual((await call(boot.token, "owncode.settings", {})).result.checkout, { separate: true });

    // No child task is made in the development project (the parent's approval is of the parent's own text); another project's task spawns as before.
    const WANT = { expectedResult: "a short list", acceptanceCriteria: ["the list is there"], costMicros: 100_000, computeMs: 60_000 };
    assert.ok((await call(boot.token, "budget.open", { taskId, currency: "USD", costMicros: 1_000_000, computeMs: 7_200_000 }, "b-dev")).ok);
    const refused = await call(boot.token, "swarm.spawn", { parentTaskId: taskId, title: "half of it", ...WANT }, "sp-dev");
    assert.equal(refused.error?.code, "invalid_command", JSON.stringify(refused));
    assert.match(refused.error.message, /no child task is made in the NimbleNewt development project: .* ask for the part as a new request/);
    assert.equal((await c.services.projects.listTasks({ projectId: devProject, limit: 10 })).items.length, 1, "nothing was made");
    const garden = (await c.services.projects.createProject({ commandId: "p-garden", actor: rob.id, name: "Garden" })).id;
    const weed = (await c.services.projects.createTask({ commandId: "t-weed", actor: rob.id, projectId: garden, title: "weed" })).id;
    assert.ok((await call(boot.token, "budget.open", { taskId: weed, currency: "USD", costMicros: 1_000_000, computeMs: 7_200_000 }, "b-weed")).ok);
    const spawned = await call(boot.token, "swarm.spawn", { parentTaskId: weed, title: "the left bed", ...WANT }, "sp-weed");
    assert.ok(spawned.ok, JSON.stringify(spawned));
  } finally {
    await c.close();
    for (const p of [d, co, links]) rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// First review: the artifact store and the backup folder are the controller's own records too; a checkout inside either, or holding one, is refused. Both lie apart from the data directory here, and the
// backup folder is given relative to the working directory, as the controller opens it.
test("a checkout inside the artifact store, or one that holds the backup folder, is refused (card B06, third slice, first review)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-b06c-g-"));
  const store = mkdtempSync(join(tmpdir(), "nn-b06c-art-"));
  const outer = mkdtempSync(join(tmpdir(), "nn-b06c-bk-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    artifacts: { directory: store }, backup: { directory: relative(process.cwd(), join(outer, "backups")) } });
  let n = 0;
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const devProject = (await c.services.projects.createProject({ commandId: "p-dev", actor: rob.id, name: "NimbleNewt development" })).id;
    const call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const bind = async (label: string, locator: string) => c.services.resources.bindResource(rob, { commandId: `b${++n}`, projectId: devProject, kind: "repository", label, locator, access: "write" } as never);
    mkdirSync(join(store, "dev"));
    const inStore = await bind("in store", join(store, "dev"));
    assert.match((await call("owncode.enable", { projectId: devProject }, `en-${++n}`)).error.message, /repository "in store" at .* is inside the controller's artifact store/);
    await c.services.resources.unbindResource(rob, { commandId: `u${++n}`, resourceId: inStore.id, expectedRevision: inStore.revision });
    await bind("around backups", outer);
    assert.match((await call("owncode.enable", { projectId: devProject }, `en-${++n}`)).error.message, /repository "around backups" at .* holds the controller's backup folder/);
  } finally {
    await c.close();
    for (const p of [d, store, outer]) rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// B06 fourth slice: the outside watchdog's record file, the launcher's heartbeat file (here from the environment, as the launcher gives it) and the recovery manifest folder are the installation's files too.
// A checkout holding one of them is refused; a checkout of its own is still enabled, whether the program files the tests run from are a plain checkout or a `git worktree` (their git folders are judged too).
test("a checkout holding the watchdog record, the heartbeat file or the recovery manifests is refused (card B06, fourth slice)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-b06d-"));
  const side = mkdtempSync(join(tmpdir(), "nn-b06d-side-"));
  const co = mkdtempSync(join(tmpdir(), "nn-b06d-co-"));
  for (const f of ["wd", "hb", "rec"]) mkdirSync(join(side, f));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: { NIMBLENEWT_HEARTBEAT_FILE: join(side, "hb", "beat"), NIMBLENEWT_HEARTBEAT_TOKEN: "t".repeat(32) }, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    watchdog: { file: join(side, "wd", "watchdog.json") }, recovery: { manifestDirectory: join(side, "rec") } });
  let n = 0;
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const devProject = (await c.services.projects.createProject({ commandId: "p-dev", actor: rob.id, name: "NimbleNewt development" })).id;
    const call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const bind = async (label: string, locator: string) => c.services.resources.bindResource(rob, { commandId: `b${++n}`, projectId: devProject, kind: "repository", label, locator, access: "write" } as never);
    const unbind = async (r: { id: string; revision: number }) => { await c.services.resources.unbindResource(rob, { commandId: `u${++n}`, resourceId: r.id, expectedRevision: r.revision }); };
    for (const [folder, what] of [["wd", "the outside watchdog's record file"], ["hb", "the launcher's heartbeat file"], ["rec", "the recovery manifest folder"]] as const) {
      const r = await bind(`around ${folder}`, join(side, folder));
      const got = await call("owncode.enable", { projectId: devProject }, `en-${++n}`);
      assert.equal(got.error?.code, "unavailable", JSON.stringify(got));
      assert.match(got.error.message, new RegExp(`repository "around ${folder}" at .* (holds|is the same folder as) ${what.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      await unbind(r);
    }
    await bind("own", co);
    const enabled = await call("owncode.enable", { projectId: devProject }, `en-${++n}`);
    assert.ok(enabled.ok, JSON.stringify(enabled));
  } finally {
    await c.close();
    for (const p of [d, side, co]) rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// First review of the fourth slice: each of the six extra files is the path the controller opens, resolved against the working directory as it opens it (the keyring, passcode and recovery files were
// wired with no test). The heartbeat comes from the options, else from the launcher's environment; none when it is off or named empty (an empty name resolved would be the working directory itself).
test("the installation's extra guarded files are the paths the controller opens, resolved against the working directory (card B06, fourth slice, first review)", () => {
  const env = { NIMBLENEWT_HEARTBEAT_FILE: "env/beat" };
  assert.deepEqual(ownCodeExtraGuards({ env: {} }), {});
  assert.deepEqual(ownCodeExtraGuards({ env, backup: { directory: "b", encryption: { keyringFile: "k/ring", passcodeFile: "k/pass", recoveryFile: "/abs/rec" } }, recovery: { manifestDirectory: "m" }, watchdog: { file: "w/wd.json" } } as never), {
    backupKeyring: resolve("k/ring"), backupPasscode: resolve("k/pass"), backupRecovery: resolve("/abs/rec"), recoveryManifests: resolve("m"), watchdogFile: resolve("w/wd.json"), heartbeatFile: resolve("env/beat"),
  });
  assert.deepEqual(ownCodeExtraGuards({ env, backup: { directory: "b", encryption: { keyringFile: "k/ring" } } } as never), { backupKeyring: resolve("k/ring"), heartbeatFile: resolve("env/beat") });
  assert.deepEqual(ownCodeExtraGuards({ env, heartbeat: { file: "opt/beat" } } as never), { heartbeatFile: resolve("opt/beat") });
  assert.deepEqual(ownCodeExtraGuards({ env, heartbeat: false }), {});
  assert.deepEqual(ownCodeExtraGuards({ env: { NIMBLENEWT_HEARTBEAT_FILE: "" } }), {});
  assert.deepEqual(ownCodeExtraGuards({ env, heartbeat: { file: "" } } as never), {});
});
