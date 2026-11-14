import assert from "node:assert/strict";
import { after } from "node:test";
import { CatalogService, personalNamespace } from "../catalog/index.js";
import { DeskService } from "../context/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { workGrants } from "../dispatch/testing/world.js";
import type { Grant } from "../security/index.js";
import type { JsonObject } from "../storage/types.js";
import { RunningCallStore, ToolExecutionService, type BridgeResponse, type ToolExecutionDeps } from "../toolbridge/index.js";
import { FULL_ABILITIES, remoteSuite, type Ctx } from "./testing/suite.js";
import type { RemoteAttempt } from "./client.js";
import type { RemoteHost } from "./testing/world.js";
import type { SequencedControl } from "./protocol.js";
import { RemoteScriptRuns, type HostScriptLaunch, type HostScriptRunner } from "./script-runs.js";

after(stopServer);

// Card T02d: the whole path. An agent on a REMOTE worker host calls a catalogue tool through the controller's tool bridge; the controller checks the call as it does for a local one and orders the script of the host that holds the attempt; the
// host runs it in its own (fake) sandbox and reports; and a revocation of the version reaches the running call there with the owner's recorded choice, in this process (the listener) and in another one (the store check).

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean | Promise<boolean>, what = "the condition"): Promise<void> => {
  for (let i = 0; i < 750; i++) { if (await cond()) return; await sleepMs(20); }
  assert.fail(`${what} never held`);
};
let n = 0;
const uid = (label: string): string => `${label}-${n++}`;
const manifest = (extra: Record<string, unknown> = {}) => ({
  purpose: "check a page", input: { type: "object", properties: { url: { type: "string", maxLength: 200 } }, required: ["url"], additionalProperties: false },
  output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }, entryPoint: "bin/check.js", interpreter: { name: "node", version: "22.19.0" },
  os: ["linux", "darwin", "win32"], arch: ["x64", "arm64"], dependencies: [], requestedAccess: [], limits: { cpus: 1, memoryMb: 128, seconds: 30 }, cancellation: "cooperative", recovery: "none", ...extra,
});
const bad = (r: BridgeResponse): { code: string; message: string } => { assert.equal(r.ok, false, JSON.stringify(r)); return r as never; };
const good = (r: BridgeResponse): JsonObject => { assert.equal(r.ok, true, JSON.stringify(r)); return (r as { result: JsonObject }).result; };
const hostFacts = { os: "linux" as const, arch: "x64" as const, interpreters: { node: "22.19.0" }, packages: {}, cpus: 8, memoryMb: 16_384 };
const TOOL_SOURCE = "console.log('{\"ok\":true}') // REMOTE-TOOL-SOURCE";

for (const backend of backends) {
  const suite = remoteSuite(backend);

  interface Rig {
    readonly svc: ToolExecutionService;
    readonly catalog: CatalogService;
    readonly desks: DeskService;
    readonly attemptId: string;
    readonly taskId: string;
    readonly token: string;
    readonly attempt: RemoteAttempt;
    readonly host: RemoteHost;
    readonly launches: HostScriptLaunch[];
    readonly behave: { run: (launch: HostScriptLaunch, signal: AbortSignal) => Promise<{ text: string; cpuMs?: number }> };
    readonly seen: SequencedControl[];
    readonly paused: string[];
    readonly send: (op: string, args?: JsonObject, callId?: string) => Promise<BridgeResponse>;
    readonly install: (name: string, version: string) => Promise<string>;
    readonly invoke: (args: JsonObject, callId: string) => Promise<BridgeResponse>;
    readonly make: (over?: Partial<ToolExecutionDeps>) => ToolExecutionService;
    end(): Promise<void>;
  }

  /** An agent on a remote host with everything the bridge needs, a tool service whose remote runs go through the real remote service, and a host loop with a fake sandbox. */
  async function rig(c: Ctx, o: { choice?: "finish" | "cancel" | "pause"; protocol?: { min: number; max: number }; hostName?: string } = {}): Promise<Rig> {
    const desks = DeskService.withEpoch(c.storage, c.epoch, c.options);
    const catalog = CatalogService.withEpoch(c.storage, c.epoch, desks, c.options);
    const host = await c.host(o.hostName ?? "r1", o.protocol === undefined ? {} : { protocol: o.protocol });
    const p = "agent:ann";
    const grants: Grant[] = [...workGrants(c.project), { action: "desk.write", project: c.project }, { action: "desk.read", project: c.project }, { action: "catalog.register", project: "*" }, { action: "catalog.read", project: "*" }, { action: `tool.${personalNamespace(p).replace(/^a_/, "a-")}.*`, project: c.project }];
    const ann = await c.agent("ann", grants);
    c.prefer(host);
    const { taskId, attemptId } = await c.task("Check pages", ann);
    const report = await c.tick();
    assert.ok(report.started.includes(attemptId!), JSON.stringify(report.skipped));
    const offer = (await host.client.offers()).find((x) => x.order.attemptId === attemptId)!;
    const attempt = host.client.attempt(attemptId!, offer.placement);
    await attempt.accept();
    assert.deepEqual(await attempt.honorContract(offer.order, FULL_ABILITIES, c.clock.now()), { ok: true });
    await c.policy.set(c.owner, { scope: "installation", commandId: uid("pol"), profile: "autonomous" });

    const launches: HostScriptLaunch[] = [];
    const behave: Rig["behave"] = { run: async () => ({ text: '{"ok":true}', cpuMs: 3 }) };
    const runner: HostScriptRunner = { run: async (launch, signal) => { launches.push(launch); return behave.run(launch, signal); } };
    const scripts = new RemoteScriptRuns({ runner, retryMs: 5 });
    // The host's loop.
    let stop = false;
    let after = 0;
    const seen: SequencedControl[] = [];
    const loop = (async () => {
      while (!stop) {
        const messages = await attempt.pollControl(after).catch(() => [] as SequencedControl[]);
        for (const m of messages) { after = Math.max(after, m.seq); seen.push(m); await scripts.handle(attempt, attemptId!, m); }
        await sleepMs(10);
      }
    })();

    const paused: string[] = [];
    const make = (over: Partial<ToolExecutionDeps> = {}): ToolExecutionService => new ToolExecutionService({
      principal: c.dispatcherPrincipal, credentials: c.credentials, dispatch: { get: (...a: Parameters<typeof c.current.get>) => c.current.get(...a), toolOperation: (...a: Parameters<typeof c.current.toolOperation>) => c.current.toolOperation(...a) } as never,
      assignments: c.assignments, catalog, hosts: c.hosts, admission: c.admission, pauses: c.pauses, desks, facts: async () => hostFacts,
      // Nothing is local: a call that reached this runner would be a call that ran on the wrong machine.
      runner: { run: async () => { throw new Error("the local runner must not run a remote host's tool"); } }, isLocalHost: () => false,
      remoteRuns: { run: (call, launch, signal, onRevoke) => c.remote.runScript(c.dispatcherPrincipal, call, launch, signal, onRevoke) },
      revocationPolicy: () => o.choice ?? "finish", revocationWatchMs: 0,
      pauseTask: async (owner, taskId, reason, commandId) => { paused.push(taskId); return c.pauses.pause(owner, { commandId, scope: { kind: "task", id: taskId }, reason }); },
      runRecords: RunningCallStore.withEpoch(c.storage, c.epoch),
      ...over,
    });
    const svc = make();
    const gateway = c.current.gateway(attemptId!);
    const token = offer.order.credential;
    const send = (op: string, args: JsonObject = {}, callId: string = uid("call")) => svc.handle(token, gateway, { op, callId, args });
    const install = async (name: string, version: string): Promise<string> => {
      const doc = good(await send("desk.write", { kind: "note", title: `${name} notes`, body: `how to use ${name}`, visibility: "shared", status: "accepted" }));
      const code = good(await send("desk.write", { kind: "note", title: `${name} code`, body: TOOL_SOURCE, visibility: "shared", status: "accepted" }));
      const made = good(await send("tool.register", { name, kind: "tool", version, manifest: manifest(), instructionsRecordId: doc["id"] as string, executableRecordId: code["id"] as string }));
      return made["name"] as string;
    };
    // An unclassified tool is parked for the owner's review on first use; the owner allows it and the same call is made again.
    const invoke = async (args: JsonObject, callId: string): Promise<BridgeResponse> => {
      const first = good(await send("tool.invoke", args, callId));
      assert.equal(first["state"], "awaiting-approval", JSON.stringify(first));
      const review = (await c.reviews.get(c.owner, first["reviewId"] as string))!;
      await c.reviews.decide(c.owner, { commandId: uid("dec"), requestId: review.id, expectedRevision: review.revision, verdict: "allow", reason: "fine" });
      return send("tool.invoke", args, callId);
    };
    return { svc, catalog, desks, attemptId: attemptId!, taskId, token, attempt, host, launches, behave, seen, paused, send, install, invoke, make, end: async () => { stop = true; await loop; svc.dispose(); } };
  }

  suite("T02d: an agent on a remote host calls a catalogue tool: it runs in the host's sandbox on the exact bytes, with an empty environment and no credential, and the answer comes back through the bridge", async (c) => {
    const r = await rig(c);
    try {
      const name = await r.install("check", "1.0.0");
      let sawRunning: unknown;
      r.behave.run = async () => { sawRunning = await r.svc.runningEverywhere(name, "1.0.0"); return { text: '{"ok":true}', cpuMs: 3 }; };
      const out = good(await r.invoke({ tool: name, version: "1.0.0", input: { url: "https://example.org" } }, "call-a"));
      assert.equal(out["state"], "confirmed", JSON.stringify(out));
      assert.equal(out["version"], "1.0.0");
      assert.equal(r.launches.length, 1);
      const launch = r.launches[0]!;
      assert.equal(launch.source, TOOL_SOURCE);
      assert.equal(launch.stdin, '{"url":"https://example.org"}');
      assert.deepEqual([launch.program, launch.argv, launch.env, launch.tool.name, launch.tool.version], ["node", ["bin/check.js"], {}, name, "1.0.0"]);
      assert.equal(JSON.stringify(launch).includes(r.token), false, "no task credential reaches the host's script");
      // The call was a running call of its version while it ran (the record other processes read), and is gone now.
      assert.deepEqual((sawRunning as { calls: { callId: string }[]; total: number }).calls.map((x) => x.callId), ["call-a"]);
      assert.equal((await r.svc.runningEverywhere(name, "1.0.0")).total, 0);
      assert.equal(r.svc.runningTotal(name, "1.0.0"), 0);
      // The same call asked again is answered from its record and runs nothing more.
      const again = good(await r.send("tool.invoke", { tool: name, version: "1.0.0", input: { url: "https://example.org" } }, "call-a"));
      assert.equal(again["state"], "confirmed");
      assert.equal(r.launches.length, 1);
      // The placement holds the order's run ID and digest only.
      const stored = JSON.stringify(await c.remote.placement(c.dispatcherPrincipal, r.attemptId));
      for (const marker of ["REMOTE-TOOL-SOURCE", "example.org", r.token]) assert.equal(stored.includes(marker), false, marker);
    } finally { await r.end(); }
  });

  suite("T02d: the tool's own checks still apply to a remote host: arguments against the manifest, the host's facts against the manifest, a revoked version, a skill; a job stays on this machine; a host at protocol 1 fails the call with the reason", async (c) => {
    const r = await rig(c);
    try {
      const name = await r.install("check", "1.0.0");
      assert.equal(bad(await r.send("tool.invoke", { tool: name, version: "1.0.0", input: { nope: 1 } }, "c-args")).code, "invalid_command");
      // A tool that needs an OS this host is not.
      const doc = good(await r.send("desk.write", { kind: "note", title: "w notes", body: "x", visibility: "shared", status: "accepted" }));
      const code = good(await r.send("desk.write", { kind: "note", title: "w code", body: "1", visibility: "shared", status: "accepted" }));
      const other = good(await r.send("tool.register", { name: "macs", kind: "tool", version: "1.0.0", manifest: manifest({ os: ["darwin"] }), instructionsRecordId: doc["id"] as string, executableRecordId: code["id"] as string }));
      assert.match(bad(await r.send("tool.invoke", { tool: other["name"] as string, version: "1.0.0", input: { url: "u" } }, "c-os")).message, /cannot run on this host/);
      // A job runs on this machine only.
      const withJobs = r.make({ jobs: { get: async () => undefined } as never, jobRuns: { room: () => undefined } as never });
      try {
        const refused = bad(await withJobs.handle(r.token, c.current.gateway(r.attemptId), { op: "job.start", callId: "c-job", args: { tool: name, version: "1.0.0", input: { url: "u" } } }));
        assert.equal(refused.code, "unavailable");
        assert.match(refused.message, /runs on this machine only/);
      } finally { withJobs.dispose(); }
      // Nothing was run, and nothing was ordered, for any of those.
      assert.equal(r.launches.length, 0);
      assert.deepEqual((await c.remote.placement(c.dispatcherPrincipal, r.attemptId))!.control.filter((m) => m.kind === "run"), []);
      // Revoked: refused at the call, whatever happens to the old list.
      await r.catalog.revoke(c.owner, { commandId: uid("rv"), name, version: "1.0.0", reason: "bad" });
      assert.equal(bad(await r.send("tool.invoke", { tool: name, version: "1.0.0", input: { url: "u" } }, "c-rev")).code, "forbidden");
    } finally { await r.end(); }
  });

  suite("T02d: a tool service with no remote runner still refuses a call from a host that is not this machine, as before", async (c) => {
    const r = await rig(c);
    try {
      const name = await r.install("check", "1.0.0");
      const plain = r.make({ remoteRuns: undefined as never });
      try {
        const refused = bad(await plain.handle(r.token, c.current.gateway(r.attemptId), { op: "tool.invoke", callId: "c-plain", args: { tool: name, version: "1.0.0", input: { url: "u" } } }));
        assert.equal(refused.code, "unavailable");
        assert.match(refused.message, /not this machine/);
      } finally { plain.dispose(); }
    } finally { await r.end(); }
  });

  suite("T02d: a host at protocol 1 cannot run a catalogue tool: the call fails with the reason and nothing is ordered", async (c) => {
    const r = await rig(c, { protocol: { min: 1, max: 1 } });
    try {
      const name = await r.install("check", "1.0.0");
      const out = good(await r.invoke({ tool: name, version: "1.0.0", input: { url: "u" } }, "c-v1"));
      assert.equal(out["state"], "failed", JSON.stringify(out));
      assert.match(JSON.stringify(out), /protocol 1/);
      assert.equal(r.launches.length, 0);
      assert.deepEqual((await c.remote.placement(c.dispatcherPrincipal, r.attemptId))!.control.filter((m) => m.kind === "run"), []);
    } finally { await r.end(); }
  });

  for (const choice of ["finish", "cancel", "pause"] as const) {
    suite(`T02d: revoking a version while its call runs on a remote host (choice ${choice}) ${choice === "finish" ? "tells the host and lets the call end" : "stops the run on the host, ends the call as failed" + (choice === "pause" ? " and pauses the task" : "")}; the record of the running call goes with it`, async (c) => {
      const r = await rig(c);
      let release!: () => void; const gate = new Promise<void>((x) => { release = x; });
      try {
        const name = await r.install("slow", "1.0.0");
        let started!: () => void; const hasStarted = new Promise<void>((x) => { started = x; });
        let killed = false;
        r.behave.run = async (_l, signal) => {
          started();
          await new Promise<void>((resolve, reject) => { signal.addEventListener("abort", () => { killed = true; reject(new Error("killed")); }, { once: true }); void gate.then(resolve); });
          return { text: '{"ok":true}', cpuMs: 1 };
        };
        const args = { tool: name, version: "1.0.0", input: { url: "u" } };
        const first = good(await r.send("tool.invoke", args, "long-call"));
        assert.equal(first["state"], "awaiting-approval");
        const review = (await c.reviews.get(c.owner, first["reviewId"] as string))!;
        await c.reviews.decide(c.owner, { commandId: uid("dec"), requestId: review.id, expectedRevision: review.revision, verdict: "allow", reason: "fine" });
        const running = r.send("tool.invoke", args, "long-call");
        await hasStarted;
        assert.equal((await r.svc.runningEverywhere(name, "1.0.0")).total, 1, "listed while it runs on the host");
        await r.catalog.revoke(c.owner, { commandId: uid("rv"), name, version: "1.0.0", reason: "bad", runningCalls: choice });
        if (choice === "finish") {
          await until(() => r.seen.some((m) => m.kind === "revoke"), "the revoke message on the host");
          await sleepMs(100);
          assert.equal(killed, false, "a finishing call is left alone on the host");
          release();
          assert.equal(good(await running)["state"], "confirmed");
        } else {
          const ran = good(await running);
          assert.equal(ran["state"], "failed", JSON.stringify(ran));
          await until(() => killed, "the host to stop the run");
          await until(() => c.remote.scriptRuns(c.dispatcherPrincipal, r.attemptId).length === 0, "the host's acknowledgement");
        }
        const revoke = r.seen.find((m) => m.kind === "revoke");
        assert.deepEqual([revoke?.kind === "revoke" && revoke.name, revoke?.kind === "revoke" && revoke.version, revoke?.kind === "revoke" && revoke.choice], [name, "1.0.0", choice], "the message carries the choice recorded on the revocation");
        assert.deepEqual(r.paused, choice === "pause" ? [r.taskId] : []);
        if (choice === "pause") assert.ok((await c.pauses.guard(r.taskId)).blockedBy.some((b) => b.kind === "task" && b.id === r.taskId));
        await until(async () => (await r.svc.runningEverywhere(name, "1.0.0")).total === 0, "the running-call record to be removed");
        // A later call is refused whatever was chosen (a paused task refuses every write first).
        assert.equal(bad(await r.send("tool.invoke", args, "later")).code, choice === "pause" ? "paused" : "forbidden");
      } finally { release(); await r.end(); }
    });
  }

  for (const choice of ["cancel", "finish"] as const) {
    suite(`T02d: a revocation taken by ANOTHER controller process reaches the call running on the remote host with the recorded choice (${choice})`, async (c) => {
      const r = await rig(c);
      // The process that holds the call does not hear the revoke command (no listener): only its store check can.
      const view = { get: r.catalog.get.bind(r.catalog), list: r.catalog.list.bind(r.catalog), register: r.catalog.register.bind(r.catalog), content: r.catalog.content.bind(r.catalog), authorizeRun: r.catalog.authorizeRun.bind(r.catalog), revocationOf: r.catalog.revocationOf.bind(r.catalog) };
      let release!: () => void; const gate = new Promise<void>((x) => { release = x; });
      const holder = r.make({ catalog: view, revocationWatchMs: 15, revocationPolicy: () => "finish", revocationOwner: async (id) => (id === c.owner.id ? c.owner : undefined) });
      try {
        const name = await r.install("slow", "1.0.0");
        let started!: () => void; const hasStarted = new Promise<void>((x) => { started = x; });
        let killed = false;
        r.behave.run = async (_l, signal) => { started(); await new Promise<void>((resolve, reject) => { signal.addEventListener("abort", () => { killed = true; reject(new Error("killed")); }, { once: true }); void gate.then(resolve); }); return { text: '{"ok":true}' }; };
        const args = { tool: name, version: "1.0.0", input: { url: "u" } };
        const first = good(await r.send("tool.invoke", args, "long-call"));
        const review = (await c.reviews.get(c.owner, first["reviewId"] as string))!;
        await c.reviews.decide(c.owner, { commandId: uid("dec"), requestId: review.id, expectedRevision: review.revision, verdict: "allow", reason: "fine" });
        const gateway = c.current.gateway(r.attemptId);
        const running = holder.handle(r.token, gateway, { op: "tool.invoke", callId: "long-call", args });
        await hasStarted;
        await r.catalog.revoke(c.owner, { commandId: uid("rv"), name, version: "1.0.0", reason: "bad", runningCalls: choice });
        if (choice === "cancel") {
          assert.equal(good(await running)["state"], "failed");
          await until(() => killed, "the host to stop the run");
        } else {
          await until(() => r.seen.some((m) => m.kind === "revoke"), "the revoke message on the host");
          await sleepMs(100);
          assert.equal(killed, false);
          release();
          assert.equal(good(await running)["state"], "confirmed");
        }
        const revoke = r.seen.find((m) => m.kind === "revoke");
        assert.equal(revoke?.kind === "revoke" && revoke.choice, choice, "the choice on the revocation record, not the standing policy (finish)");
      } finally { release(); holder.dispose(); await r.end(); }
    });
  }
}
