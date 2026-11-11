import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkRemoteConfig, readRemoteConfig, startRemoteWorker } from "./remote-host.mjs";

// Card L05e: what the remote worker host wires together, with stand-ins for the packages (the real composition is shown by the integration test with a real process).
const config = (extra = {}) => ({ url: "https://controller.example:8443", token: "host-credential-0123", base: "/tmp/nn-l05e-base", routes: { "localp/small": { url: "http://127.0.0.1:1/v1", keyEnv: "L05E_STUB_KEY" } }, ...extra });

function packages() {
  const seen = { security: undefined, parts: undefined, reportSecurity: [], poller: undefined, runnerOptions: undefined, bridged: [], verdicts: [], taps: [], relayed: [], workspaceOptions: undefined };
  class RemoteWorkerClient { constructor(options) { seen.clientOptions = options; } async reportSecurity(event) { seen.reportSecurity.push(event); if (event.key === "fails") throw new Error("Bearer abc.def.ghi could not be sent"); return { itemId: "n", held: false }; } }
  class ModelRelay { constructor(options) { seen.relayOptions = options; } forAttempt(options) { seen.taps.push(options.stream); return { relay: async (request) => { seen.relayed.push(request); if (request === "fail") throw new Error("down"); return { ok: true }; } }; } }
  class LocalWorker { constructor(options) { seen.localOptions = options; } busyAttempts() { return []; } }
  class RemoteOfferRunner {
    constructor(options) { seen.runnerOptions = options; }
    async bridge(attemptId, token, request) { seen.bridged.push({ attemptId, token, request }); return { ok: true, result: {} }; }
    tap(attemptId) { return { attemptId }; }
    async verdict(attemptId, verdict) { seen.verdicts.push([attemptId, verdict]); }
    async run(offer) { (seen.ran ??= []).push(offer.order.attemptId); return "completed"; }
  }
  class WorkspaceResponder { constructor(options) { seen.responderOptions = options; } handle() {} }
  class HostPoller { constructor(options) { seen.poller = options; } run() { return new Promise((resolve) => { seen.stopPoller = resolve; }); } }
  const controller = { RemoteWorkerClient, ModelRelay, LocalWorker, RemoteOfferRunner, WorkspaceResponder, HostPoller };
  class LocalWorkspaces { constructor(options) { seen.workspaceOptions = options; this.port = { run: async () => ({ ok: true }) }; } progress() {} async ensure() { return { checkout: "/c", gitDir: "/g" }; } }
  const worker = {
    SandboxLauncher: { create: async () => ({ capacity: { available: true, backend: "bubblewrap" }, stop: async () => { seen.launcherStopped = true; } }) },
    GitBridge: { create: async () => ({}) },
    LocalWorkspaces,
    detectLimitCapabilities: async () => ({ platform: "linux" }),
    limitedPlan: () => ({ report: [{ limit: "cpus", enforced: "full" }, { limit: "memoryMb", enforced: "partial" }] }),
    appFromRepository: () => ({}),
    localWorkerParts: (options) => { seen.parts = options; return { sandbox: {}, runtimes: { open: async () => ({}) } }; },
  };
  const piAdapter = { PINNED_PI_DURABLE_VERSION: "1.3.0" };
  return { seen, load: async (name) => ({ controller, worker, "pi-adapter": piAdapter })[name] };
}

test("the configuration is checked in plain words that never repeat a value: the address, the credential, the folders and the routes", () => {
  assert.deepEqual(checkRemoteConfig({ root: "/r", ...config() }), []);
  const bad = checkRemoteConfig({ root: "relative", url: "http://controller.example", token: "x", base: "rel", routes: { "no-slash": { url: 3 } } });
  assert.ok(checkRemoteConfig({ root: "/r", ...config({ routes: { "a/b": { url: "http://x", keyEnv: "lower" } } }) }).some((p) => /keyEnv: must be the NAME/.test(p)));
  assert.equal(bad.length, 6, bad.join("; "));
  assert.ok(bad.some((p) => /must not cross a network in the clear/.test(p)));
  assert.ok(bad.every((p) => !p.includes("controller.example") || /url:/.test(p)));
  assert.ok(checkRemoteConfig({ root: "/r", ...config({ routes: {} }) }).some((p) => /routes/.test(p)));
  // A loopback address may be plain http (a controller on the same machine).
  assert.deepEqual(checkRemoteConfig({ root: "/r", ...config({ url: "http://127.0.0.1:8443" }) }), []);
});

test("a configuration file holds no credential: the host credential comes from the environment or a file of its own", () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-l05e-cfg-"));
  try {
    const file = join(dir, "w.json");
    writeFileSync(file, JSON.stringify({ url: "https://c", token: "written-in-the-file", base: "/b", routes: {} }));
    assert.throws(() => readRemoteConfig(file, {}), /must not be written in the configuration/);
    assert.equal(String(assert.throws(() => readRemoteConfig(file, {}))?.message).includes("written-in-the-file"), false);
    writeFileSync(file, JSON.stringify({ url: "https://c", base: "/b", routes: {}, tokenFile: join(dir, "t") }));
    writeFileSync(join(dir, "t"), "from-the-token-file\n", { mode: 0o644 });
    chmodSync(join(dir, "t"), 0o644);
    // A token file other users can read is refused (as ssh refuses such a key), and the refusal holds no part of it.
    const open = assert.throws(() => readRemoteConfig(file, {}), /tokenFile: other users can read or change it/);
    void open;
    assert.equal(String((() => { try { readRemoteConfig(file, {}); } catch (e) { return e.message; } })()).includes("from-the-token-file"), false);
    chmodSync(join(dir, "t"), 0o600);
    assert.equal(readRemoteConfig(file, {}).token, "from-the-token-file");
    assert.equal(readRemoteConfig(file, { NIMBLENEWT_WORKER_TOKEN: "from-the-environment" }).token, "from-the-environment");
    assert.equal("tokenFile" in readRemoteConfig(file, {}), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the workspace host's security hook is the client's reportSecurity; the process's bridge requests go through the runner's route; its model calls take the runner's tap; verdicts reach the runner", async () => {
  const lines = [];
  const { seen, load } = packages();
  const host = await startRemoteWorker({ root: "/srv/nimblenewt", load }, config({ log: (l) => lines.push(l) }));
  try {
    // Security: the hook handed to the workspace host sends the sign over the host channel, and a failure is logged without anything that looks like a credential.
    assert.equal(typeof seen.workspaceOptions.security, "function");
    seen.workspaceOptions.security({ kind: "protected-path-touched", key: "ws:landing:abc", projectId: "proj-aaaaaaaaaaaaaaaaaaaa" });
    seen.workspaceOptions.security({ kind: "sandbox-escape-attempt", key: "fails", projectId: "proj-aaaaaaaaaaaaaaaaaaaa" });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(seen.reportSecurity.map((e) => e.kind), ["protected-path-touched", "sandbox-escape-attempt"]);
    assert.ok(lines.some((l) => /a security report could not be sent/.test(l)));
    assert.equal(lines.join("\n").includes("abc.def.ghi"), false, "a bearer text is cut out of a logged failure");
    // The bridge: the process's request and the credential it presented go to the runner's bridge for that attempt.
    const order = { attemptId: "att-1", taskId: "task-1", projectId: "proj-1", agentId: "agent:ann", route: "localp/small" };
    const answer = await seen.parts.bridge(order, () => undefined, "task-credential", { op: "task.get", callId: "c1", args: {} });
    assert.deepEqual(answer, { ok: true, result: {} });
    assert.deepEqual(seen.bridged, [{ attemptId: "att-1", token: "task-credential", request: { op: "task.get", callId: "c1", args: {} } }]);
    // The model call: the relay for the attempt takes the runner's tap as its stream, and a failure is logged and still thrown.
    assert.deepEqual(await seen.parts.relay(order, "ok"), { ok: true });
    assert.deepEqual(seen.taps, [{ attemptId: "att-1" }]);
    await assert.rejects(seen.parts.relay(order, "fail"), /down/);
    assert.ok(lines.some((l) => /the model call was refused or failed \(down\)/.test(l)));
    // The provider key is read from the environment variable the configuration names, at each call; a missing one is said by name only.
    delete process.env.L05E_STUB_KEY;
    assert.throws(() => seen.relayOptions.endpoint("localp/small").headers(), /environment variable L05E_STUB_KEY/);
    process.env.L05E_STUB_KEY = "key-1";
    assert.deepEqual(seen.relayOptions.endpoint("localp/small").headers(), { authorization: "Bearer key-1" });
    process.env.L05E_STUB_KEY = "key-2";
    assert.deepEqual(seen.relayOptions.endpoint("localp/small").headers(), { authorization: "Bearer key-2" }, "read afresh at each call");
    assert.equal(seen.relayOptions.endpoint("localp/other"), undefined);
    assert.equal(seen.relayOptions.endpoint("constructor"), undefined, "a route is an own entry of the configuration");
    // The reconnect handshake: what is held is listed, and each verdict goes to the runner.
    assert.deepEqual(seen.poller.held(), []);
    await seen.poller.onReconciled({ verdicts: [{ attemptId: "att-1", verdict: "stop" }, { attemptId: "att-2", verdict: "reaccept" }] });
    assert.deepEqual(seen.verdicts, [["att-1", "stop"], ["att-2", "reaccept"]]);
    // The abilities the host states come from what its sandbox really does.
    assert.deepEqual(seen.runnerOptions.abilities, { formats: [1], features: ["limits", "wall-time"], enforces: { cpus: "full", memoryMb: "partial", wallTimeMs: "full" } });
    // The workspace responder answers over the same client; the client holds the credential from the configuration only.
    assert.equal(seen.clientOptions.token, "host-credential-0123");
    assert.equal(typeof seen.poller.onWorkspace, "function");
  } finally { seen.stopPoller(); await host.stop(); }
  assert.equal(seen.launcherStopped, true, "stopping the host stops the sandbox launcher");
});

test("an offer whose attempt ID is not an attempt ID (a path, `..`) is not run and makes no folder of this host", async () => {
  const lines = [];
  const { seen, load } = packages();
  const base = mkdtempSync(join(tmpdir(), "nn-l05e-ids-"));
  const host = await startRemoteWorker({ root: "/srv/nimblenewt", load }, config({ base, log: (l) => lines.push(l) }));
  try {
    const good = "att-abcdefghijklmnopqrst";
    await seen.poller.onOffers([{ placement: 1, order: { attemptId: "../../escaped" } }, { placement: 1, order: { attemptId: "att-../x" } }, { placement: 1, order: { attemptId: good } }]);
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(seen.ran, [good]);
    assert.equal(lines.filter((l) => /not an attempt ID was not run/.test(l)).length, 2);
    await assert.rejects(seen.parts.workspace({ attemptId: "../../escaped", taskId: "task-1", projectId: "proj-1" }), /not an attempt ID/);
    assert.equal(existsSync(join(base, "escaped")), false);
    assert.equal(existsSync(join(base, "..", "escaped")), false);
    const made = await seen.parts.workspace({ attemptId: good, taskId: "task-1", projectId: "proj-1" });
    assert.equal(made.home, join(base, "attempts", good, "home"));
  } finally { seen.stopPoller(); await host.stop(); rmSync(base, { recursive: true, force: true }); }
});

test("a host that cannot confine agents does not start, and says why without a value that could be a secret", async () => {
  const { load } = packages();
  const noSandbox = async (name) => { const m = await load(name); return name === "worker" ? { ...m, SandboxLauncher: { create: async () => ({ capacity: { available: false, reason: "no bubblewrap" }, stop: async () => undefined }) } } : m; };
  await assert.rejects(startRemoteWorker({ root: "/r", load: noSandbox }, config()), /the sandbox is not usable here \(no bubblewrap\)/);
  await assert.rejects(startRemoteWorker({ root: "/r", load }, config({ token: undefined })), (e) => /token:/.test(e.message) && !e.message.includes("host-credential"));
});
