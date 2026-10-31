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
  say: (id: string, text: string, intents: unknown[]) => Promise<{ turnId: string; outcomes: any[] }>; ownerPrincipal: any; callsBefore: () => Promise<any[]>;
}) => Promise<void>, extra: { revocationPolicy?: "finish" | "cancel"; run?: Run; second?: boolean } = {}) {
  const d = mkdtempSync(join(tmpdir(), "nn-revoke-"));
  const out: { aborted: boolean; running?: Record<string, any>; later?: BridgeResponse; failure?: unknown; name?: string } = { aborted: false };
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
    tools: { runner, isLocalHost: (h) => h === "host:w1", facts: async () => ({ os: "linux", arch: "x64", interpreters: { node: "22.19.0" }, packages: {}, cpus: 8, memoryMb: 16_384 }), ...(extra.revocationPolicy === undefined ? {} : { revocationPolicy: () => extra.revocationPolicy! }) },
  });
  try {
    assert.ok(c.dispatch !== undefined && c.tools !== undefined, c.dispatchProblem);
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
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
        await hasStarted;
        await act({ c, name, owner: boot.token, agent: annToken, call, say, ownerPrincipal: rob, callsBefore: async () => (await call(boot.token, "catalog.running", { name, version: "1.0.0" })).result.items });
        await sleep(30);
        release();
        out.running = good(await running);
        out.later = await send("tool.invoke", args, "another-call");
      } catch (error) { failure = error; throw error; }
      return { status: "completed", text: "done" };
    };
    await c.dispatch.dispatcher.tick();
    await c.dispatch.dispatcher.idle();
    if (failure !== undefined) throw failure;
    assert.ok(out.running !== undefined, "the scenario ran to its end");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  return out as Required<Pick<typeof out, "aborted" | "running" | "later" | "name">>;
}

test("the owner revokes a version through the API and says what happens to running calls: cancel aborts them (they end failed), finish lets them end, a later call is refused; the running calls are listed without their input (card T02b)", async () => {
  const seen: { before?: any[]; agentRead?: string | undefined; agentRevoke?: string | undefined; badChoice?: string | undefined; noId?: string | undefined; unknown?: string | undefined; stillRunning?: boolean } = {};
  const out = await scenario(async ({ name, owner, agent, call, callsBefore, c }) => {
    seen.before = await callsBefore();
    // Owner only: neither the list nor the revocation is open to an agent, and nothing is revoked by the refused attempt.
    seen.agentRead = (await call(agent, "catalog.running", { name, version: "1.0.0" })).error?.code;
    seen.agentRevoke = (await call(agent, "catalog.revoke", { name, version: "1.0.0", reason: "no", runningCalls: "cancel" }, "x1")).error?.code;
    seen.badChoice = (await call(owner, "catalog.revoke", { name, version: "1.0.0", reason: "bad", runningCalls: "pause" }, "x2")).error?.code;
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

test("in chat the revoke lists the running calls and asks whether they finish or are cancelled; the answer is the owner's, the proposal repeats the calls, nothing happens until it is accepted (card T02b)", async () => {
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
  assert.deepEqual([...seen.awaiting.choices].sort(), ["cancel", "finish"]);
  assert.equal(seen.runningWhileAsked, 1, "asking changed nothing");
  assert.equal(seen.proposedStatus, "proposed", JSON.stringify(seen));
  assert.match(seen.preview.join("\n"), /runningCalls=cancel/);
  assert.match(seen.preview.join("\n"), /1 running call.*long-call/, "the proposal lists the calls it would reach");
  assert.equal(seen.abortedBeforeAccept, 1, "nothing was cancelled before the owner accepted");
  assert.equal(seen.appliedStatus, "applied", JSON.stringify(seen.appliedAll));
  assert.equal(out.aborted, true);
  assert.equal(out.running["state"], "failed");
});

test("in chat, when the owner already said finish no question is asked and a choice the owner did not say is refused (card T02b)", async () => {
  const seen: Record<string, any> = {};
  const out = await scenario(async ({ name, say, call, owner }) => {
    const text = `revoke ${name} 1.0.0 because it is bad, let the running calls finish`;
    const said = await say("m1", text, [{ kind: "command", op: "catalog.revoke", args: { name, version: "1.0.0", reason: "it is bad", runningCalls: "finish" }, evidence: text, basis: "owner" }]);
    seen.said = said.outcomes[0].status;
    seen.saidPreview = said.outcomes[0].preview;
    // A model cannot choose for the owner: a choice that is not in the owner's words is refused.
    const text2 = `revoke ${name} 1.0.0 because it is bad`;
    const forged = await say("m2", text2, [{ kind: "command", op: "catalog.revoke", args: { name, version: "1.0.0", reason: "it is bad", runningCalls: "cancel" }, evidence: text2, basis: "owner" }]);
    seen.forged = forged.outcomes[0].status;
    const applied = await say("m3", "yes, do that", [{ kind: "apply_proposal", proposalId: said.outcomes[0].proposalId, evidence: "do that", basis: "owner" }]);
    seen.applied = applied.outcomes[0].status; seen.appliedAll = applied.outcomes[0];
    assert.equal((await call(owner, "catalog.running", { name, version: "1.0.0" })).ok, true);
  });
  assert.equal(seen.said, "proposed", JSON.stringify(seen));
  assert.match(seen.saidPreview.join("\n"), /runningCalls=finish/);
  assert.equal(seen.forged, "refused", "a choice the owner did not say is refused");
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
