import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { personalNamespace } from "../catalog/index.js";
import { ScriptedInterpreter } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { ROUTING_TABLE, EXEC_PROFILES, PI, ScriptedWorker, workGrants } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { AdmissionService } from "../admission/index.js";
import { HostService } from "../hosts/index.js";
import { PolicyService } from "../policy/index.js";
import { DifficultyService } from "../routing/index.js";
import type { BridgeResponse, ScriptLaunch } from "../toolbridge/index.js";
import { guardedSignal } from "../toolbridge/service.js";
import { derivedId } from "../domain/ids.js";
import { canonicalJson, sha256 } from "../storage/json.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const AGENT = "agt-abcdefghijklmnopqrst";
const manifest = {
  purpose: "check a page", input: { type: "object", properties: { url: { type: "string", maxLength: 200 } }, required: ["url"], additionalProperties: false },
  output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }, entryPoint: "bin/check.js", interpreter: { name: "node", version: "22.19.0" },
  os: ["linux"], arch: ["x64"], dependencies: [], requestedAccess: [], limits: { cpus: 1, memoryMb: 128, seconds: 30 }, cancellation: "cooperative", recovery: "none",
};
type Reply = { ok: boolean; result?: any; error?: { code: string; message: string } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const good = (r: BridgeResponse): Record<string, any> => { assert.equal(r.ok, true, JSON.stringify(r)); return (r as { result: Record<string, any> }).result; };

interface Run {
  /** The runner's behaviour for the long call: by default it waits for `release` or for its signal to abort. */
  hook?: (signal: AbortSignal) => void;
}

/**
 * A controller with the bridge on, one agent whose attempt is running, and a catalogue tool call of version 1.0.0 that has started and waits. `act` runs while the call is running (the owner revokes, by whatever way the test
 * is about); the result says what happened to the call.
 */
async function scenario(act: (x: {
  c: Awaited<ReturnType<typeof startController>>; name: string; owner: string; agent: string; call: (token: string, op: string, args: Record<string, unknown>, commandId?: string) => Promise<Reply>;
  say: (id: string, text: string, intents: unknown[]) => Promise<{ turnId: string; outcomes: any[] }>; ownerPrincipal: any; callsBefore: () => Promise<any[]>; /** Lets the long call end now. */ release: () => void;
  /** The SQLite file of this controller (a second controller may be started on it). */ path: string; /** Whether the runner's signal was aborted so far. */ aborted: () => boolean;
}) => Promise<void>, extra: { /** The store check's period (`tools.revocationWatchMs`). */ watchMs?: number; /** Another controller took the epoch during `act`: this one's writes are refused, so the call's answer is kept as it comes and no later call is made. */ fenced?: boolean; revocationPolicy?: "finish" | "cancel" | "pause"; run?: Run; second?: boolean; pauseTask?: unknown; notice?: (n: { commandId: string; taskId: string; text: string }) => Promise<unknown>; /** Runs once the controller is up (a test may wrap a service). */ install?: (c: Awaited<ReturnType<typeof startController>>, owner: () => any) => void; slowPolicyMs?: number; /** The call is expected never to launch. */ noLaunch?: boolean } = {}) {
  const d = mkdtempSync(join(tmpdir(), "nn-revoke-"));
  const out: { aborted: boolean; running?: Record<string, any>; later?: BridgeResponse; failure?: unknown; name?: string; raw?: unknown } = { aborted: false };
  const sayText: Record<string, unknown[]> = {};
  let started!: () => void; const hasStarted = new Promise<void>((r) => { started = r; });
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  const runner = {
    run: async (_l: ScriptLaunch, signal: AbortSignal) => {
      extra.run?.hook?.(signal);
      started();
      await new Promise<void>((resolve) => { signal.addEventListener("abort", () => { out.aborted = true; resolve(); }); void gate.then(resolve); });
      return { text: '{"ok":true}', cpuMs: 1 };
    },
  };
  let script: (ctx: { order: any; gateway: any }) => Promise<any> = async () => ({ status: "completed", text: "done" });
  const worker = new ScriptedWorker("host:w1", (ctx) => script(ctx as never));
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    chat: { interpreter: new ScriptedInterpreter((input) => sayText[input.text] ?? []) },
    dispatch: { timer: new ManualTimer(), manual: true, workers: [worker] },
    tools: { runner, isLocalHost: (h) => h === "host:w1", facts: async () => ({ os: "linux", arch: "x64", interpreters: { node: "22.19.0" }, packages: {}, cpus: 8, memoryMb: 16_384 }), ...(extra.revocationPolicy === undefined ? {} : { revocationPolicy: async () => { if (extra.slowPolicyMs !== undefined) await sleep(extra.slowPolicyMs); return extra.revocationPolicy!; } }), ...("pauseTask" in extra ? { pauseTask: extra.pauseTask as never } : {}), ...(extra.notice === undefined ? {} : { notice: extra.notice }), ...(extra.watchMs === undefined ? {} : { revocationWatchMs: extra.watchMs }) },
  });
  try {
    assert.ok(c.dispatch !== undefined && c.tools !== undefined, c.dispatchProblem);
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    extra.install?.(c, () => rob);
    // The route, the host and the autonomous profile the dispatcher needs to start an attempt.
    await s.routing.setTable(rob, { commandId: "rt", expectedRevision: 0, table: { ...ROUTING_TABLE, roles: { coordinator: "r-cloud", "safety-supervisor": "r-cloud" } } } as never);
    await DifficultyService.withEpoch(c.storage, c.epoch, s.routing, s.contracts).setProfiles(rob, { commandId: "sp", expectedRevision: 0, profiles: EXEC_PROFILES } as never);
    await s.principals.enroll(rob, { commandId: "e-host", kind: "host", name: "w1", grants: [] });
    const hostP = await s.principals.authenticate((await s.principals.issueCredential(rob, "host:w1")).token);
    const hosts = HostService.withEpoch(c.storage, c.epoch, s.assignments);
    await hosts.announce(hostP, { commandId: "an", capabilities: { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] } });
    await hosts.heartbeat(hostP, { commandId: "hb", sequence: 1 });
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: rob.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
    await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(rob, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    await s.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: AGENT, grants: [...workGrants(project), { action: "desk.write", project }, { action: "desk.read", project }, { action: "catalog.register", project: "*" }, { action: "catalog.read", project: "*" }, { action: `tool.${personalNamespace(`agent:${AGENT}`).replace(/^a_/, "a-")}.*`, project }] });
    const annToken = (await s.principals.issueCredential(rob, `agent:${AGENT}`)).token;
    const taskId = (await s.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Check a page" })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: rob.id, taskId, owner: { kind: "agent", id: AGENT } });
    const a = (await s.assignments.getAssignment(taskId))!;
    await s.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: AGENT }, harness: "pi" });
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    const say = async (id: string, text: string, intents: unknown[]) => { sayText[text] = intents; const r = await c.chat!.submit(boot.token, { messageId: id, text }); return { turnId: r.turnId, outcomes: r.outcomes as any[] }; };
    let failure: unknown;
    script = async ({ order, gateway }) => {
      const send = (op: string, args: Record<string, unknown> = {}, callId = `call-${Math.random().toString(36).slice(2)}`) => c.tools!.handle(order.credential, gateway, { op, callId, args } as never);
      try {
        const doc = good(await send("desk.write", { kind: "note", title: "slow notes", body: "how to use slow", visibility: "shared", status: "accepted" }));
        const code = good(await send("desk.write", { kind: "note", title: "slow code", body: "console.log('{\"ok\":true}')", visibility: "shared", status: "accepted" }));
        const made = good(await send("tool.register", { name: "slow", kind: "tool", version: "1.0.0", manifest, instructionsRecordId: doc["id"], executableRecordId: code["id"] }));
        const name = made["name"] as string;
        out.name = name;
        // An unclassified tool is parked for review first; the owner approves and the same call is made again.
        const args = { tool: name, version: "1.0.0", input: { url: "u" } };
        const first = good(await send("tool.invoke", args, "long-call"));
        assert.equal(first["state"], "awaiting-approval", JSON.stringify(first));
        const review = (await s.reviews.get(rob, first["reviewId"] as string))!;
        await s.reviews.decide(rob, { commandId: "dec", requestId: review.id, expectedRevision: review.revision, verdict: "allow", reason: "fine" } as never);
        const running = send("tool.invoke", args, "long-call");
        if (extra.noLaunch === true) await Promise.race([hasStarted, sleep(400)]); else await hasStarted;
        await act({ c, name, owner: boot.token, agent: annToken, call, say, ownerPrincipal: rob, release, path: join(d, "c.sqlite"), aborted: () => out.aborted, callsBefore: async () => (await call(boot.token, "catalog.running", { name, version: "1.0.0" })).result.items });
        await sleep(30);
        release();
        if (extra.fenced === true) { out.raw = await running.catch((error: unknown) => ({ threw: String(error) })); return { status: "completed", text: "done" }; }
        out.running = good(await running);
        out.later = await send("tool.invoke", args, "another-call");
      } catch (error) { failure = error; throw error; }
      return { status: "completed", text: "done" };
    };
    await c.dispatch.dispatcher.tick().catch((error: unknown) => { if (extra.fenced !== true) throw error; });
    await c.dispatch.dispatcher.idle().catch((error: unknown) => { if (extra.fenced !== true) throw error; });
    if (failure !== undefined) throw failure;
    assert.ok(out.running !== undefined || (extra.fenced === true && "raw" in out), "the scenario ran to its end");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  return out as Required<Pick<typeof out, "aborted" | "running" | "later" | "name">> & { raw?: unknown };
}

test("the owner revokes a version through the API and says what happens to running calls: cancel aborts them (they end failed), finish lets them end, a later call is refused; the running calls are listed without their input (card T02b)", async () => {
  const seen: { before?: any[]; agentRead?: string | undefined; agentRevoke?: string | undefined; badChoice?: string | undefined; noId?: string | undefined; unknown?: string | undefined; stillRunning?: boolean } = {};
  const out = await scenario(async ({ name, owner, agent, call, callsBefore, c }) => {
    seen.before = await callsBefore();
    // Owner only: neither the list nor the revocation is open to an agent, and nothing is revoked by the refused attempt.
    seen.agentRead = (await call(agent, "catalog.running", { name, version: "1.0.0" })).error?.code;
    seen.agentRevoke = (await call(agent, "catalog.revoke", { name, version: "1.0.0", reason: "no", runningCalls: "cancel" }, "x1")).error?.code;
    seen.badChoice = (await call(owner, "catalog.revoke", { name, version: "1.0.0", reason: "bad", runningCalls: "stop" }, "x2")).error?.code;
    seen.noId = (await call(owner, "catalog.revoke", { name, version: "1.0.0", reason: "bad", runningCalls: "cancel" })).error?.code;
    seen.unknown = (await call(owner, "catalog.revoke", { name, version: "9.9.9", reason: "bad", runningCalls: "cancel" }, "x3")).error?.code;
    await sleep(20);
    seen.stillRunning = (await c.tools!.runningCalls(name, "1.0.0")).length === 1;
    const done = await call(owner, "catalog.revoke", { name, version: "1.0.0", reason: "found a bug", runningCalls: "cancel" }, "rv1");
    assert.ok(done.ok, JSON.stringify(done));
  });
  assert.equal(seen.before!.length, 1);
  assert.deepEqual(Object.keys(seen.before![0]).sort(), ["agentId", "attemptId", "callId", "taskId"], "no input, no output");
  assert.equal(seen.before![0].callId, "long-call");
  assert.deepEqual([seen.agentRead, seen.agentRevoke, seen.badChoice, seen.noId, seen.unknown, seen.stillRunning], ["forbidden", "forbidden", "invalid_command", "invalid_command", "not_found", true]);
  assert.equal(out.aborted, true, "cancel aborted the run");
  assert.equal(out.running["state"], "failed", JSON.stringify(out.running));
  assert.equal((out.later as { ok: boolean; code?: string }).ok, false);
  assert.equal((out.later as { code: string }).code, "forbidden");
});

test("with no choice (nobody was asked) the running call finishes; an explicit finish beats a policy that would cancel, and the policy is only the fallback (card T02b)", async () => {
  const none = await scenario(async ({ owner, name, call }) => { assert.ok((await call(owner, "catalog.revoke", { name, version: "1.0.0", reason: "bad" }, "rv-none")).ok); });
  assert.equal(none.aborted, false);
  assert.equal(none.running["state"], "confirmed", JSON.stringify(none.running));
  const choice = await scenario(async ({ owner, name, call }) => { assert.ok((await call(owner, "catalog.revoke", { name, version: "1.0.0", reason: "bad", runningCalls: "finish" }, "rv-fin")).ok); }, { revocationPolicy: "cancel" });
  assert.equal(choice.aborted, false, "the owner's finish was not overridden by the policy");
  assert.equal(choice.running["state"], "confirmed");
  const fallback = await scenario(async ({ owner, name, call }) => { assert.ok((await call(owner, "catalog.revoke", { name, version: "1.0.0", reason: "bad" }, "rv-fb")).ok); }, { revocationPolicy: "cancel" });
  assert.equal(fallback.aborted, true, "with no choice the dependency's policy is read");
  assert.equal(fallback.running["state"], "failed");
});

test("the controller has ONE catalogue and ONE tool service: a revocation through the controller's catalogue (not only the API) cancels the running call (card T02b)", async () => {
  const out = await scenario(async ({ c, name, ownerPrincipal }) => {
    assert.ok(c.tools !== undefined);
    await c.services.catalog.revoke(ownerPrincipal, { commandId: "rv-direct", name, version: "1.0.0", reason: "bad", runningCalls: "cancel" });
  });
  assert.equal(out.aborted, true);
  assert.equal(out.running["state"], "failed");
});

test("the same command ID again answers again without a second effect, and the same ID with another choice is a conflict (card T02b)", async () => {
  const seen: Record<string, any> = {};
  const out = await scenario(async ({ owner, name, call }) => {
    const args = { name, version: "1.0.0", reason: "bad", runningCalls: "finish" };
    seen.first = await call(owner, "catalog.revoke", args, "rv-same");
    seen.again = await call(owner, "catalog.revoke", args, "rv-same");
    seen.other = await call(owner, "catalog.revoke", { ...args, runningCalls: "cancel" }, "rv-same");
    seen.fresh = await call(owner, "catalog.revoke", args, "rv-new");
    await sleep(30);
  });
  assert.ok(seen.first.ok && seen.again.ok, JSON.stringify([seen.first, seen.again]));
  assert.equal(seen.other.error?.code, "command_conflict", "a different choice is not the same command");
  assert.equal(seen.fresh.error?.code, "invalid_command", "a new command for an already revoked version is refused");
  assert.equal(out.aborted, false, "the replay did not turn finish into cancel");
  assert.equal(out.running["state"], "confirmed");
});

test("a runner whose abort listener throws does not take the controller down: the call still ends failed (card T02b)", async () => {
  let crashed: unknown;
  const onCrash = (e: unknown): void => { crashed = e; };
  process.on("uncaughtException", onCrash);
  try {
    const out = await scenario(async ({ owner, name, call }) => {
      assert.ok((await call(owner, "catalog.revoke", { name, version: "1.0.0", reason: "bad", runningCalls: "cancel" }, "rv-throw")).ok);
      await sleep(50);
    }, { run: { hook: (signal) => { signal.addEventListener("abort", () => { throw new Error("listener blew up"); }); (signal as unknown as { onabort: unknown }).onabort = () => { throw new Error("onabort blew up"); }; } } });
    assert.equal(out.aborted, true);
    assert.equal(out.running["state"], "failed");
    await sleep(20);
    assert.equal(crashed, undefined, String(crashed));
  } finally { process.off("uncaughtException", onCrash); }
});

test("guardedSignal: listeners that throw are contained, ordinary listeners still run, an already aborted source aborts it (card T02b)", async () => {
  const source = new AbortController();
  const signal = guardedSignal(source.signal);
  let ran = 0;
  signal.addEventListener("abort", () => { throw new Error("one"); });
  signal.addEventListener("abort", () => { ran++; });
  signal.onabort = () => { throw new Error("two"); };
  let crashed: unknown;
  const onCrash = (e: unknown): void => { crashed = e; };
  process.on("uncaughtException", onCrash);
  try {
    source.abort(new Error("why"));
    await sleep(20);
    assert.equal(signal.aborted, true);
    assert.equal(ran, 1);
    assert.equal(crashed, undefined);
    assert.equal(guardedSignal(source.signal).aborted, true);
  } finally { process.off("uncaughtException", onCrash); }
});

test("in chat the revoke lists the running calls and asks whether they finish, are cancelled or their tasks are paused; the answer is the owner's, the proposal repeats the calls, nothing happens until it is accepted (card T02b; pause added by T02c)", async () => {
  const seen: Record<string, any> = {};
  const out = await scenario(async ({ c, name, say, call, owner }) => {
    const text = `revoke ${name} 1.0.0 because it is bad`;
    const asked = await say("m1", text, [{ kind: "command", op: "catalog.revoke", args: { name, version: "1.0.0", reason: "it is bad" }, evidence: text, basis: "owner" }]);
    seen.askedStatus = asked.outcomes[0].status;
    seen.question = asked.outcomes[0].message ?? asked.outcomes[0].question;
    seen.awaiting = (await c.chat!.context(owner)).awaiting;
    await sleep(20);
    seen.runningWhileAsked = (await call(owner, "catalog.running", { name, version: "1.0.0" })).result.items.length;
    const proposed = await say("m2", "cancel them", [{ kind: "answer", turnId: asked.turnId, choice: "cancel", evidence: "cancel them", basis: "owner" }]);
    seen.proposedStatus = proposed.outcomes[0].status;
    seen.preview = proposed.outcomes[0].preview;
    await sleep(30);
    seen.abortedBeforeAccept = (await call(owner, "catalog.running", { name, version: "1.0.0" })).result.items.length;
    const applied = await say("m3", "yes, do that", [{ kind: "apply_proposal", proposalId: proposed.outcomes[0].proposalId, evidence: "do that", basis: "owner" }]);
    seen.appliedStatus = applied.outcomes[0].status; seen.appliedAll = applied.outcomes[0];
  });
  assert.equal(seen.askedStatus, "asked", JSON.stringify(seen));
  assert.match(String(seen.question), /1 running call/);
  assert.match(String(seen.question), /long-call/);
  assert.deepEqual([...seen.awaiting.choices].sort(), ["cancel", "finish", "pause"]);
  assert.equal(seen.runningWhileAsked, 1, "asking changed nothing");
  assert.equal(seen.proposedStatus, "proposed", JSON.stringify(seen));
  assert.match(seen.preview.join("\n"), /runningCalls=cancel/);
  assert.match(seen.preview.join("\n"), /1 running call.*long-call/, "the proposal lists the calls it would reach");
  assert.equal(seen.abortedBeforeAccept, 1, "nothing was cancelled before the owner accepted");
  assert.equal(seen.appliedStatus, "applied", JSON.stringify(seen.appliedAll));
  assert.equal(out.aborted, true);
  assert.equal(out.running["state"], "failed");
});

test("in chat, when the owner already said finish no question is asked and a choice the owner did not say is not taken and the owner is asked instead (card T02b)", async () => {
  const seen: Record<string, any> = {};
  const out = await scenario(async ({ name, say, call, owner }) => {
    const text = `revoke ${name} 1.0.0 because it is bad, let the running calls finish`;
    const said = await say("m1", text, [{ kind: "command", op: "catalog.revoke", args: { name, version: "1.0.0", reason: "it is bad", runningCalls: "finish" }, evidence: text, basis: "owner" }]);
    seen.said = said.outcomes[0].status;
    seen.saidPreview = said.outcomes[0].preview;
    // A model cannot choose for the owner: a choice that is not in the owner's words is dropped and the owner is asked (ASSUMPTION 2026-11-07: ask rather than refuse).
    const text2 = `revoke ${name} 1.0.0 because it is bad`;
    const forged = await say("m2", text2, [{ kind: "command", op: "catalog.revoke", args: { name, version: "1.0.0", reason: "it is bad", runningCalls: "cancel" }, evidence: text2, basis: "owner" }]);
    seen.forged = forged.outcomes[0].status;
    const applied = await say("m3", "yes, do that", [{ kind: "apply_proposal", proposalId: said.outcomes[0].proposalId, evidence: "do that", basis: "owner" }]);
    seen.applied = applied.outcomes[0].status; seen.appliedAll = applied.outcomes[0];
    assert.equal((await call(owner, "catalog.running", { name, version: "1.0.0" })).ok, true);
  });
  assert.equal(seen.said, "proposed", JSON.stringify(seen));
  assert.match(seen.saidPreview.join("\n"), /runningCalls=finish/);
  assert.equal(seen.forged, "asked", "a choice the owner did not say is not taken: the owner is asked");
  assert.equal(seen.applied, "applied", JSON.stringify(seen.appliedAll));
  assert.equal(out.aborted, false);
  assert.equal(out.running["state"], "confirmed");
});

test("guardedSignal: removeEventListener removes what addEventListener added (also with once and capture), so a finished call leaks no listener and cannot kill an ended run (card T02b fix)", async () => {
  const source = new AbortController();
  const signal = guardedSignal(source.signal);
  const ran: string[] = [];
  const stop = (): void => { ran.push("stop"); };
  signal.addEventListener("abort", stop);
  signal.addEventListener("abort", stop); // the same listener twice is one registration, as natively
  signal.removeEventListener("abort", stop);
  const once = (): void => { ran.push("once"); };
  signal.addEventListener("abort", once, { once: true });
  signal.removeEventListener("abort", once);
  const cap = (): void => { ran.push("cap"); };
  signal.addEventListener("abort", cap, true);
  signal.removeEventListener("abort", cap, { capture: true });
  const kept = (): void => { ran.push("kept"); };
  signal.addEventListener("abort", kept, { once: true });
  const object = { handleEvent: (): void => { ran.push("object"); } };
  signal.addEventListener("abort", object);
  signal.removeEventListener("abort", object);
  signal.removeEventListener("abort", () => undefined); // an unknown listener is ignored
  source.abort(new Error("why"));
  await sleep(10);
  assert.deepEqual(ran, ["kept"]);
});

test("catalog.revoke without a choice keeps the digest the command had before the choice existed, so a replay recorded earlier still matches; catalog.running reports the total (card T02b fix)", async () => {
  const seen: Record<string, any> = {};
  await scenario(async ({ c, name, owner, call, ownerPrincipal }) => {
    const listed = await call(owner, "catalog.running", { name, version: "1.0.0" });
    seen.total = [listed.result.items.length, listed.result.total, c.tools!.runningTotal(name, "1.0.0")];
    await c.services.catalog.revoke(ownerPrincipal, { commandId: "rv-nochoice", name, version: "1.0.0", reason: "bad" });
    const audit = (await c.storage.listAudit({ afterSeq: 0, limit: 500 })).filter((a) => a.type === "catalog.revoke");
    seen.digest = (audit[0]?.detail as Record<string, unknown> | undefined)?.["commandDigest"];
    seen.expected = sha256(canonicalJson({ v: 1, type: "catalog.revoke", actor: ownerPrincipal.id, payload: { versionId: derivedId("cav", `${name}|1.0.0`), reason: "bad" } }));
  });
  assert.deepEqual(seen.total, [1, 1, 1]);
  assert.equal(seen.digest, seen.expected);
});

test("startController refuses tools without dispatch, with a clear message (card T02b fix)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-revoke-"));
  try {
    await assert.rejects(startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], tools: { runner: { run: async () => ({ text: "{}", cpuMs: 1 }) }, isLocalHost: () => true } }), /options\.tools needs options\.dispatch/);
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

const reasonOf = (r: Reply): string => JSON.stringify(r);

test("pause stops the running call AND pauses its task: what the revoked tool writes never reaches the agent, the pause stays until the owner resumes, and a paused task starts no tool (card T02c)", async () => {
  const seen: Record<string, any> = {};
  const out = await scenario(async ({ c, name, owner, call, callsBefore }) => {
    const [running] = await callsBefore();
    seen.taskId = running.taskId;
    assert.deepEqual((await c.services.pauses.guard(running.taskId)).blockedBy, [], "not paused before");
    assert.ok((await call(owner, "catalog.revoke", { name, version: "1.0.0", reason: "bad", runningCalls: "pause" }, "rv-pause")).ok);
    await sleep(30);
    seen.blockedBy = (await c.services.pauses.guard(running.taskId)).blockedBy;
  });
  assert.equal(out.aborted, true, "pause stops the call as well");
  assert.equal(out.running["state"], "failed", `its output does not reach the agent: ${JSON.stringify(out.running)}`);
  assert.deepEqual(seen.blockedBy.map((b: any) => [b.kind, b.id]), [["task", seen.taskId]]);
  assert.equal(out.later.ok, false);
  assert.equal((out.later as { code: string }).code, "paused", "a paused task starts no tool, revoked or not");
});

test("when the task cannot be paused the call is stopped all the same and the owner is told; a task that is already paused is held already and needs no notice; with no pause available the owner is told (card T02c fix)", async () => {
  const notices: { taskId: string; text: string }[] = [];
  const notice = async (n: { commandId: string; taskId: string; text: string }): Promise<void> => { notices.push({ taskId: n.taskId, text: n.text }); };
  const failing = await scenario(async ({ owner, name, call }) => { assert.ok((await call(owner, "catalog.revoke", { name, version: "1.0.0", reason: "bad", runningCalls: "pause" }, "rv-f")).ok); await sleep(30); }, { pauseTask: async () => { throw new Error("cannot pause"); }, notice });
  assert.equal(failing.aborted, true, "the call is stopped although the pause failed");
  assert.equal(failing.running["state"], "failed");
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.text, /could not be paused/);
  notices.length = 0;
  const absent = await scenario(async ({ owner, name, call }) => { assert.ok((await call(owner, "catalog.revoke", { name, version: "1.0.0", reason: "bad", runningCalls: "pause" }, "rv-a")).ok); await sleep(30); }, { pauseTask: undefined, notice });
  assert.equal(absent.aborted, true);
  assert.equal(notices.length, 1, "no pause available: the owner is told");
  notices.length = 0;
  // Already paused (by the owner, before): held already, so nothing to tell, and pauseTask is not even needed.
  const already = await scenario(async ({ c, owner, name, call, callsBefore, ownerPrincipal }) => {
    const [running] = await callsBefore();
    await c.services.pauses.pause(ownerPrincipal, { commandId: "pre-pause", scope: { kind: "task", id: running.taskId }, reason: "owner paused it" });
    assert.ok((await call(owner, "catalog.revoke", { name, version: "1.0.0", reason: "bad", runningCalls: "pause" }, "rv-p")).ok);
    await sleep(30);
  }, { pauseTask: async () => { throw new Error("already paused"); }, notice });
  assert.equal(already.aborted, true);
  assert.deepEqual(notices, [], "a task that is paused already is held, nothing to tell");
});

test("a revocation pause pauses the task itself even while a wider scope (the installation) is paused (that pause can be lifted alone) (card T02c re-review)", async () => {
  const seen: { blockedBy?: readonly { kind: string }[] } = {};
  await scenario(async ({ c, owner, name, call, callsBefore, ownerPrincipal }) => {
    const [running] = await callsBefore();
    await c.services.pauses.pause(ownerPrincipal, { commandId: "wide-pause", scope: { kind: "installation", id: "installation" }, reason: "owner paused everything" });
    assert.ok((await call(owner, "catalog.revoke", { name, version: "1.0.0", reason: "bad", runningCalls: "pause" }, "rv-pp2")).ok);
    await sleep(30);
    seen.blockedBy = (await c.services.pauses.guard(running.taskId)).blockedBy;
  });
  assert.ok(seen.blockedBy!.some((b) => b.kind === "task"), JSON.stringify(seen.blockedBy));
});

test("a call that is recorded but has not launched when its version is revoked does not launch: the revocation is read again just before the launch, even while the owner's choice is still being worked out (card T02c fix)", async () => {
  let launched = 0;
  const out = await scenario(async () => undefined, {
    noLaunch: true,
    run: { hook: () => { launched += 1; } },
    // The standing policy answers late, as a slow setting read would: the revocation is visible before the choice is.
    revocationPolicy: "cancel", slowPolicyMs: 150,
    install: (c, owner) => {
      const catalog = c.services.catalog;
      const original = catalog.authorizeRun.bind(catalog);
      (catalog as { authorizeRun: typeof original }).authorizeRun = async (...args) => {
        const ready = await original(...args);
        // The owner revokes (no choice named) after the run is recorded and before it launches.
        await catalog.revoke(owner(), { commandId: "rv-window", name: args[1].name, version: "1.0.0", reason: "bad" });
        return ready;
      };
    },
  });
  assert.equal(launched, 0, "the tool never launched");
  assert.equal(out.running["state"], "failed");
});

test("under finish only calls that are actually running continue: a call recorded and authorized but not yet launched when its version is revoked is refused, and the choice finish does not let it start (card T02c re-review)", async () => {
  let launched = 0;
  const out = await scenario(async () => undefined, {
    noLaunch: true,
    run: { hook: () => { launched += 1; } },
    install: (c, owner) => {
      const catalog = c.services.catalog;
      const original = catalog.authorizeRun.bind(catalog);
      (catalog as { authorizeRun: typeof original }).authorizeRun = async (...args) => {
        const ready = await original(...args);
        await catalog.revoke(owner(), { commandId: "rv-window-finish", name: args[1].name, version: "1.0.0", reason: "bad", runningCalls: "finish" });
        return ready;
      };
    },
  });
  assert.equal(launched, 0, "the tool never launched although the owner chose finish");
  assert.equal(out.running["state"], "failed");
});

test("the standing policy for running calls is a setting: owner only, race-safe (chat is in the next test); a revoke with no choice follows it and an explicit choice beats it (card T02c)", async () => {
  const seen: Record<string, any> = {};
  const cancelled = await scenario(async ({ owner, agent, name, call }) => {
    seen.initial = (await call(owner, "catalog.policy.get", {})).result.item;
    seen.agentGet = (await call(agent, "catalog.policy.get", {})).error?.code;
    seen.agentSet = (await call(agent, "catalog.policy.change", { runningCalls: "cancel" }, "ap")).error?.code;
    seen.bad = (await call(owner, "catalog.policy.change", { runningCalls: "stop" }, "bad")).error?.code;
    seen.set = (await call(owner, "catalog.policy.change", { runningCalls: "cancel", expectedRevision: 0 }, "p1")).result;
    seen.stale = (await call(owner, "catalog.policy.change", { runningCalls: "pause", expectedRevision: 0 }, "p2")).error?.code;
    seen.replay = (await call(owner, "catalog.policy.change", { runningCalls: "cancel", expectedRevision: 0 }, "p1")).result;
    seen.after = (await call(owner, "catalog.policy.get", {})).result.item;
    assert.ok((await call(owner, "catalog.revoke", { name, version: "1.0.0", reason: "bad" }, "rv-follow")).ok);
    // The setting moves on; a replay of p3 still answers with what it replaced (cancel), not with what the record holds now (finish).
    seen.p3 = (await call(owner, "catalog.policy.change", { runningCalls: "pause", expectedRevision: 1 }, "p3")).result;
    assert.ok((await call(owner, "catalog.policy.change", { runningCalls: "finish", expectedRevision: 2 }, "p4")).ok);
    seen.replayLater = (await call(owner, "catalog.policy.change", { runningCalls: "pause", expectedRevision: 1 }, "p3")).result;
  });
  assert.deepEqual([seen.initial.revision, seen.initial.runningCalls, seen.initial.effective, seen.initial.default], [0, null, "finish", "finish"]);
  assert.deepEqual([seen.agentGet, seen.agentSet, seen.bad, seen.stale], ["forbidden", "forbidden", "invalid_command", "stale_revision"]);
  assert.deepEqual([seen.set.revision, seen.set.old, seen.set.new, seen.after.effective, seen.after.revision], [1, null, "cancel", "cancel", 1]);
  assert.equal(seen.replay.revision, 1, "the same command answers again");
  assert.deepEqual([seen.replayLater.old, seen.replayLater.new, seen.replayLater.revision], ["cancel", "pause", 2], "a replay tells the old value truthfully, not the current one");
  assert.deepEqual([seen.set.effective, seen.set.source], ["cancel", "setting"]);
  assert.equal(cancelled.aborted, true, "no choice named: the standing policy cancels");
  assert.equal(cancelled.running["state"], "failed");

  const paused = await scenario(async ({ c, owner, name, call, callsBefore }) => {
    const [running] = await callsBefore();
    assert.ok((await call(owner, "catalog.policy.change", { runningCalls: "pause" }, "pp")).ok);
    assert.ok((await call(owner, "catalog.revoke", { name, version: "1.0.0", reason: "bad" }, "rv-pp")).ok);
    await sleep(30);
    seen.pausedBy = (await c.services.pauses.guard(running.taskId)).blockedBy.length;
  });
  assert.equal(seen.pausedBy, 1);
  assert.equal(paused.aborted, true, "pause stops the call as well as the task");

  const explicit = await scenario(async ({ owner, name, call }) => {
    assert.ok((await call(owner, "catalog.policy.change", { runningCalls: "cancel" }, "pc")).ok);
    assert.ok((await call(owner, "catalog.revoke", { name, version: "1.0.0", reason: "bad", runningCalls: "finish" }, "rv-ex")).ok);
    assert.ok((await call(owner, "catalog.policy.change", { runningCalls: null }, "pn")).ok);
    seen.cleared = (await call(owner, "catalog.policy.get", {})).result.item;
  });
  assert.equal(explicit.aborted, false, "the explicit finish beats the standing cancel");
  assert.deepEqual([seen.cleared.runningCalls, seen.cleared.effective], [null, "finish"]);
});

test("past revocations are read by the owner through the API and in chat; the standing policy is asked for and changed in chat, with the revision read for the owner (card T02c)", async () => {
  const seen: Record<string, any> = {};
  await scenario(async ({ c, name, owner, agent, call, say, ownerPrincipal }) => {
    seen.empty = (await call(owner, "catalog.revocations", {})).result;
    assert.ok((await call(owner, "catalog.revoke", { name, version: "1.0.0", reason: "leaks tokens", runningCalls: "finish" }, "rv-list")).ok);
    seen.list = (await call(owner, "catalog.revocations", {})).result;
    seen.byName = (await call(owner, "catalog.revocations", { name })).result.total;
    seen.other = (await call(owner, "catalog.revocations", { name: "toolbox.other" })).result.total;
    seen.agent = (await call(agent, "catalog.revocations", {})).error?.code;
    seen.badLimit = (await call(owner, "catalog.revocations", { limit: 0 })).error?.code;
    const text = "which tool versions were revoked";
    const asked = await say("s1", text, [{ kind: "status", request: { kind: "revocations" }, evidence: text, basis: "owner" }]);
    seen.chat = asked.outcomes[0];
    // The standing policy can be asked for in chat too: owner only, and it tells the policy in force, its source and the owner's setting.
    const ask = "what happens to running calls when I revoke a tool";
    seen.policyBefore = (await say("s0", ask, [{ kind: "status", request: { kind: "catalog_policy" }, evidence: ask, basis: "owner" }])).outcomes[0];
    // Policy by chat: shown first with the revision filled in; a change made meanwhile makes the stale proposal fail instead of overwriting it.
    const say2 = "from now on pause the tasks of running calls when I revoke a tool";
    const proposed = await say("s2", say2, [{ kind: "command", op: "catalog.policy.change", args: { runningCalls: "pause" }, evidence: say2, basis: "owner" }]);
    seen.proposed = proposed.outcomes[0];
    seen.proposedWhy = proposed.outcomes[0].message;
    seen.beforeAccept = (await call(owner, "catalog.policy.get", {})).result.item.runningCalls;
    const applied = await say("s3", "yes, do that", [{ kind: "apply_proposal", proposalId: proposed.outcomes[0].proposalId, evidence: "do that", basis: "owner" }]);
    seen.applied = applied.outcomes[0].status;
    seen.afterAccept = (await call(owner, "catalog.policy.get", {})).result.item;
    void c; void ownerPrincipal;
    const again = "now let them cancel";
    const p2 = await say("s4", again, [{ kind: "command", op: "catalog.policy.change", args: { runningCalls: "cancel" }, evidence: again, basis: "owner" }]);
    assert.ok((await call(owner, "catalog.policy.change", { runningCalls: "finish" }, "meanwhile")).ok);
    const a2 = await say("s5", "yes", [{ kind: "apply_proposal", proposalId: p2.outcomes[0].proposalId, evidence: "yes", basis: "owner" }]);
    seen.stale = a2.outcomes[0];
    seen.final = (await call(owner, "catalog.policy.get", {})).result.item.runningCalls;
    const askAfter = "and what is it now";
    seen.policyAfter = (await say("s6", askAfter, [{ kind: "status", request: { kind: "catalog_policy" }, evidence: askAfter, basis: "owner" }])).outcomes[0];
    seen.policyAgent = (await call(agent, "status.ask", { request: { kind: "catalog_policy" } })).error?.code;
  });
  assert.equal(seen.policyAgent, "not_found", "an agent is not told the owner's policy");
  assert.equal(seen.policyBefore.status, "answered", JSON.stringify(seen.policyBefore));
  assert.match(seen.policyBefore.lines.map((l: any) => l.text).join("\n"), /are let finish \(finish\), from the default\.\nYou have set none/);
  assert.ok(seen.policyBefore.lines.every((l: any) => l.cites.length > 0));
  assert.match(seen.policyAfter.lines.map((l: any) => l.text).join("\n"), /\(finish\), from your setting\.\nYour setting is finish/);
  assert.deepEqual([seen.empty.total, seen.empty.items], [0, []]);
  assert.deepEqual([seen.list.total, seen.list.items[0].version, seen.list.items[0].reason, seen.list.items[0].revokedBy.startsWith("owner:")], [1, "1.0.0", "leaks tokens", true]);
  assert.deepEqual([seen.byName, seen.other, seen.agent, seen.badLimit], [1, 0, "forbidden", "invalid_command"]);
  assert.equal(seen.chat.status, "answered", JSON.stringify(seen.chat));
  assert.match(seen.chat.lines.map((l: any) => l.text).join("\n"), /1\.0\.0 was revoked at .* by owner:.*: leaks tokens/);
  assert.ok(seen.chat.lines.every((l: any) => l.cites.length > 0));
  assert.equal(seen.proposed.status, "proposed", JSON.stringify(seen.proposed));
  assert.match(String(seen.proposedWhy), /what happens to running tool calls when a version is revoked is shown first/, "the policy is not described as a withdrawal");
  assert.doesNotMatch(String(seen.proposedWhy), /withdrawing/);
  assert.equal(seen.beforeAccept, null, "nothing changed before the owner accepted");
  assert.equal(seen.applied, "applied");
  assert.deepEqual([seen.afterAccept.runningCalls, seen.afterAccept.revision], ["pause", 1]);
  assert.notEqual(seen.stale.status, "applied", reasonOf(seen.stale));
  assert.equal(seen.final, "finish", "the stale proposal did not overwrite the owner's later change");
});

test("catalog.policy.get reports the policy in force: an operator's startup answer beats the owner's setting and says so; chat tells it, and a revoke that names no choice follows it (the running call is cancelled) instead of assuming finish (card T02c fix)", async () => {
  const seen: Record<string, any> = {};
  const out = await scenario(async ({ owner, name, call, say }) => {
    seen.set = (await call(owner, "catalog.policy.change", { runningCalls: "pause" }, "op1")).result;
    seen.get = (await call(owner, "catalog.policy.get", {})).result.item;
    const text = "from now on let running calls finish when I revoke a tool";
    const proposed = await say("o1", text, [{ kind: "command", op: "catalog.policy.change", args: { runningCalls: "finish" }, evidence: text, basis: "owner" }]);
    seen.preview = proposed.outcomes[0].preview;
    // The revoke follows the operator's answer (cancel), not the setting (pause) and not an assumed finish.
    assert.ok((await call(owner, "catalog.revoke", { name, version: "1.0.0", reason: "bad" }, "rv-op")).ok);
  }, { revocationPolicy: "cancel" });
  assert.deepEqual([seen.get.runningCalls, seen.get.effective, seen.get.source], ["pause", "cancel", "operator"]);
  assert.deepEqual([seen.set.effective, seen.set.source], ["cancel", "operator"], "the answer to a change says it does not apply");
  assert.match(seen.preview.join("\n"), /operator set this at startup \(cancel\)/);
  assert.equal(out.aborted, true);
});

test("in chat a revoke with no call running does not assume finish: the preview says what a call that slips in will get, and no choice is recorded (card T02c fix)", async () => {
  const seen: Record<string, any> = {};
  await scenario(async ({ name, say, call, owner, release }) => {
    release(); await sleep(150);
    assert.equal((await call(owner, "catalog.running", { name, version: "1.0.0" })).result.total, 0, "nothing is running");
    assert.ok((await call(owner, "catalog.policy.change", { runningCalls: "cancel" }, "idle-1")).ok);
    const text = `revoke ${name} 1.0.0 because it is bad`;
    const said = await say("i1", text, [{ kind: "command", op: "catalog.revoke", args: { name, version: "1.0.0", reason: "it is bad" }, evidence: text, basis: "owner" }]);
    seen.status = said.outcomes[0].status; seen.preview = said.outcomes[0].preview;
  });
  assert.equal(seen.status, "proposed", JSON.stringify(seen));
  assert.match(seen.preview.join("\n"), /follows the standing policy: cancel/);
  assert.doesNotMatch(seen.preview.join("\n"), /runningCalls=finish/);
});

test("in chat the owner sets the standing policy in their own words (no fixed word needed), asks what it is, and a real retention run is bound to the preview the chat makes just now; the retention values and the reasons a record is kept can be asked for (card T02c)", async () => {
  const seen: Record<string, any> = {};
  await scenario(async ({ say, name }) => {
    const finish = "from now on let running calls end on their own when I revoke a tool";
    seen.finish = (await say("f1", finish, [{ kind: "command", op: "catalog.policy.change", args: { runningCalls: "finish" }, evidence: finish, basis: "owner" }])).outcomes[0];
    seen.finishApplied = (await say("f3", "yes, do that", [{ kind: "apply_proposal", proposalId: seen.finish.proposalId, evidence: "do that", basis: "owner" }])).outcomes[0].status;
    const cancel = "when I revoke a tool stop running calls right away";
    seen.cancel = (await say("f2", cancel, [{ kind: "command", op: "catalog.policy.change", args: { runningCalls: "cancel" }, evidence: cancel, basis: "owner" }])).outcomes[0];
    const ask = "what happens to running calls when I revoke a tool now";
    seen.policyAsked = (await say("f4", ask, [{ kind: "status", request: { kind: "catalog_policy" }, evidence: ask, basis: "owner" }])).outcomes[0];
    // A choice said with an ending ("cancelled") counts as said, so the owner is not asked again; one the owner did not say is asked about.
    const inflected = `revoke ${name} 1.0.0 because it is bad and have the running calls cancelled`;
    seen.inflected = (await say("f5", inflected, [{ kind: "command", op: "catalog.revoke", args: { name, version: "1.0.0", reason: "it is bad", runningCalls: "cancel" }, evidence: inflected, basis: "owner" }])).outcomes[0];
    const unsaid = `revoke ${name} 1.0.0 because it is bad`;
    seen.unsaid = (await say("f6", unsaid, [{ kind: "command", op: "catalog.revoke", args: { name, version: "1.0.0", reason: "it is bad", runningCalls: "cancel" }, evidence: unsaid, basis: "owner" }])).outcomes[0];
    // A model that adds a digest to a preview does not turn it into a real run.
    const justLook = "just show me what retention would remove";
    seen.look = (await say("f7", justLook, [{ kind: "command", op: "retention.run", args: { dryRun: true, confirm: "e".repeat(64) }, evidence: justLook, basis: "owner" }])).outcomes[0];
    // A real run: the chat makes the preview itself and the proposal carries its digest (a digest the model wrote is dropped).
    const run = "clean up what retention may remove, for real";
    const proposed = (await say("r1", run, [{ kind: "command", op: "retention.run", args: { dryRun: false, confirm: "f".repeat(64) }, evidence: run, basis: "owner" }])).outcomes[0];
    seen.runProposed = proposed;
    const applied = (await say("r2", "yes, do that", [{ kind: "apply_proposal", proposalId: proposed.proposalId, evidence: "do that", basis: "owner" }])).outcomes[0];
    seen.runApplied = applied;
    const hold = `why is ${name} 1.0.0 kept`;
    const q = (text: string, request: Record<string, unknown>, mid: string) => say(mid, text, [{ kind: "status", request, evidence: text, basis: "owner" }]).then((r) => r.outcomes[0]);
    seen.values = await q("what are my retention values", { kind: "retention" }, "q1");
    seen.hold = await q(hold, { kind: "retention_hold", recordKind: "catalog-version", name, version: "1.0.0" }, "q2");
  });
  assert.equal(seen.finish.status, "proposed", JSON.stringify(seen.finish));
  assert.match(seen.finish.preview.join("\n"), /runningCalls=finish/);
  assert.equal(seen.cancel.status, "proposed", JSON.stringify(seen.cancel));
  assert.equal(seen.finishApplied, "applied");
  assert.match(seen.policyAsked.lines.map((l: any) => l.text).join("\n"), /\(finish\), from your setting\.\nYour setting is finish/);
  assert.equal(seen.inflected.status, "proposed", JSON.stringify(seen.inflected));
  assert.match(seen.inflected.preview.join("\n"), /runningCalls=cancel/);
  assert.equal(seen.unsaid.status, "asked", "a choice the owner did not say is asked about");
  assert.equal(seen.look.status, "proposed", JSON.stringify(seen.look));
  assert.doesNotMatch(seen.look.preview.join("\n"), /dryRun=false|confirm=/, "a preview stays a preview");
  assert.match(seen.look.message, /only previews/);
  assert.equal(seen.runProposed.status, "proposed", JSON.stringify(seen.runProposed));
  const preview = seen.runProposed.preview.join("\n");
  assert.doesNotMatch(preview, /f{64}/, "the model's digest is not used");
  assert.match(preview, /confirm=[0-9a-f]{64}/);
  assert.match(preview, /What retention would do, worked out just now: Retention preview/);
  assert.equal(seen.runApplied.status, "applied", JSON.stringify(seen.runApplied));
  assert.match(JSON.stringify(seen.runApplied), /Retention ran:/, "the confirmed run really ran");
  assert.equal(seen.values.status, "answered", JSON.stringify(seen.values));
  assert.match(seen.values.lines.map((l: any) => l.text).join("\n"), /Retention values in force[\s\S]*derivedDays: none/);
  assert.equal(seen.hold.status, "answered", JSON.stringify(seen.hold));
  assert.match(seen.hold.lines.map((l: any) => l.text).join("\n"), /1\.0\.0 is kept from deletion for \d+ reason\(s\):/);
});

test("T02d close-out, composed: a second controller started on the same store takes the epoch while the first runs a call; the owner's chat on the second lists that call as running in another process, asks, and the cancel chosen there stops the call in the first", async () => {
  const seen: Record<string, any> = {};
  const out = await scenario(async ({ c, name, owner, path, aborted }) => {
    // The second controller: same SQLite file, its own dispatcher (no workers) and tool bridge, its own chat. It takes the epoch from the first (card F04i).
    const told: Record<string, unknown[]> = {};
    const b = await startController({
      storage: { kind: "sqlite", path }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
      chat: { interpreter: new ScriptedInterpreter((input) => told[input.text] ?? []) },
      dispatch: { timer: new ManualTimer(), manual: true, workers: [] },
      tools: { runner: { run: async () => { throw new Error("the second controller runs nothing in this test"); } }, isLocalHost: () => true },
    });
    try {
      seen.epochs = [c.epoch, b.epoch];
      const sayB = async (id: string, text: string, intents: unknown[]) => { told[text] = intents; const r = await b.chat!.submit(owner, { messageId: id, text }); return { turnId: r.turnId, outcomes: r.outcomes as any[] }; };
      const callB = (op: string, args: Record<string, unknown>) => b.api.handle(owner, { v: 1, op, args } as never) as Promise<Reply>;
      seen.listed = (await callB("catalog.running", { name, version: "1.0.0" })).result;
      const text = `revoke ${name} 1.0.0 because it is bad`;
      const asked = await sayB("b1", text, [{ kind: "command", op: "catalog.revoke", args: { name, version: "1.0.0", reason: "it is bad" }, evidence: text, basis: "owner" }]);
      seen.askedStatus = asked.outcomes[0].status;
      seen.question = asked.outcomes[0].message ?? asked.outcomes[0].question;
      const proposed = await sayB("b2", "cancel them", [{ kind: "answer", turnId: asked.turnId, choice: "cancel", evidence: "cancel them", basis: "owner" }]);
      seen.proposedStatus = proposed.outcomes[0].status;
      await sleep(80);
      seen.abortedBeforeAccept = aborted();
      const applied = await sayB("b3", "yes, do that", [{ kind: "apply_proposal", proposalId: proposed.outcomes[0].proposalId, evidence: "do that", basis: "owner" }]);
      seen.appliedStatus = applied.outcomes[0].status;
      seen.recorded = (await b.services.catalog.revocationOf(name, "1.0.0"))?.runningCalls;
      // The first controller hears from the store (its own revoke listener never fired: the command was taken by the second).
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !aborted()) await sleep(10);
      seen.aborted = aborted();
    } finally { await b.close(); }
  }, { watchMs: 20, fenced: true });
  assert.ok(seen.epochs[1] > seen.epochs[0], `the second controller took the epoch: ${JSON.stringify(seen.epochs)}`);
  assert.equal(seen.listed.total, 1, JSON.stringify(seen.listed));
  assert.equal(seen.listed.items[0].callId, "long-call");
  assert.equal(seen.listed.items[0].elsewhere, true, "the call runs in the first controller, not in the one asked");
  assert.equal(seen.askedStatus, "asked", JSON.stringify(seen));
  assert.match(String(seen.question), /1 running call.*long-call.*in another controller process/);
  assert.equal(seen.proposedStatus, "proposed", JSON.stringify(seen));
  assert.equal(seen.abortedBeforeAccept, false, "nothing happens before the owner accepts");
  assert.equal(seen.appliedStatus, "applied", JSON.stringify(seen));
  assert.equal(seen.recorded, "cancel", "the owner's choice is on the revocation record");
  assert.equal(seen.aborted, true, "the cancel reached the call in the other controller process");
  assert.equal(out.aborted, true);
  // The first controller lost the epoch, so the call's end cannot be written there: it answers that, never a success.
  assert.equal((out.raw as { ok?: boolean }).ok, false, JSON.stringify(out.raw));
});
