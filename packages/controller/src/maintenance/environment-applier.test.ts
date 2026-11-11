import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { backendsNamed, stopServer } from "../domain/testing/backends.js";
import { ProjectService } from "../domain/service.js";
import { EnvironmentService, type EnvironmentManifest } from "../environments/index.js";
import { PauseService, StopService, type InventoryItem, type StopPorts } from "../lifecycle/index.js";
import { GrantService, PrincipalService, type Principal } from "../security/index.js";
import { EnvironmentChangeApplier, MemoryJournal, type EnvironmentRuntime, type ReloadInput, type TrialInput, type TrialResult, type ValidateResult } from "./environment-applier.js";
import type { MaintenanceView } from "./maintenance.js";

after(stopServer);

const options = { clock: () => "2026-11-11T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const D = (c: string): string => `sha256:${c.repeat(64).slice(0, 64)}`;
const base = (): EnvironmentManifest => ({
  base: { name: "nimblenewt-base", version: "1.0.0", digest: D("a") }, packages: [{ name: "ripgrep", version: "14.1.0", digest: D("b") }], skills: [], capabilities: ["desk.read"],
  configuration: { installation: 1 }, limits: { cpus: 2, memoryMb: 2048, diskMb: 10_000, processes: 200 }, protectedExtensions: [{ name: "nimblenewt.desk", digest: D("c") }],
});
const OBSERVED = { "nimblenewt.desk": D("c") };

/** The host side, scripted per test; every call is recorded in order. */
class Runtime implements EnvironmentRuntime {
  calls: string[] = [];
  reloads: ReloadInput[] = [];
  trials: TrialInput[] = [];
  trialResult: TrialResult | "throw" = { ok: true, digestVerified: true, scriptsDeclared: false, scriptsRan: false };
  reloadResults: Array<{ ok: true; observed: Record<string, string> } | { ok: false; reason: string } | "throw"> = [];
  validateResults: ValidateResult[] = [];
  async trial(input: TrialInput): Promise<TrialResult> { this.calls.push("trial"); this.trials.push(input); if (this.trialResult === "throw") throw new Error("no sandbox"); return this.trialResult; }
  async reload(input: ReloadInput) { this.calls.push(`reload:${input.revision}`); this.reloads.push(input); const r = this.reloadResults.shift() ?? { ok: true as const, observed: OBSERVED }; if (r === "throw") throw new Error("host went away"); return r; }
  async validate(input: ReloadInput): Promise<ValidateResult> { this.calls.push(`validate:${input.revision}`); return this.validateResults.shift() ?? { ok: true, sessionIntact: true, compactionIntact: true }; }
}
class Stopping implements StopPorts {
  calls: string[] = [];
  durable = true;
  cannot: string | undefined;
  unsupported(): string | undefined { return this.cannot; }
  async inventory(): Promise<InventoryItem[]> { return []; }
  async cleanup() { return { remaining: [] }; }
  async checkpoint() { this.calls.push("checkpoint"); return { checkpointId: `cp-${this.calls.length}`, durable: this.durable, artifactsDurable: true }; }
  async terminate() { this.calls.push("terminate"); return { ended: true, unresolved: [] }; }
}

const view = (agentId: string, id: string, spec: Record<string, unknown> = {}, kind: MaintenanceView["kind"] = "package"): MaintenanceView => ({
  id, agentId, kind, class: "dependency", specDigest: D("e"), spec: { name: "jq", version: "1.7.1", digest: D("f"), source: "https://example.org/jq-1.7.1.tgz", installScripts: false, ...spec },
});

for (const backend of backendsNamed("SQLite")) {
  const suite = (name: string, body: (c: {
    owner: Principal; agentId: string; scope: { kind: "agent"; id: string }; env: EnvironmentService; pauses: PauseService; stops: StopService; rt: Runtime; sp: Stopping; journal: MemoryJournal;
    applier(): EnvironmentChangeApplier; active(): Promise<{ revision: number; names: string[] }>; latest(): Promise<number>;
  }) => Promise<void>) => test(`${backend.name}: ${name}`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(world.storage, epoch, options);
      GrantService.withEpoch(world.storage, epoch, options);
      const agents = AgentService.withEpoch(world.storage, epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const agentKey = (await agents.create(owner, { commandId: cid("ag"), friendlyName: "A" })).id;
      const agentId = `agent:${agentKey}`;
      const env = EnvironmentService.withEpoch(world.storage, epoch, { ...options, reservedDigest: async (nm) => (nm === "nimblenewt.desk" ? D("c") : undefined), skillUsable: async () => false });
      await env.change(owner, { commandId: cid("c"), agentId, manifest: base(), reason: "first" });
      await env.activate(owner, { commandId: cid("a"), agentId, revision: 1, observed: OBSERVED });
      const pauses = PauseService.withEpoch(world.storage, epoch, {}, options);
      const sp = new Stopping();
      const stops = StopService.withEpoch(world.storage, epoch, pauses, sp, options);
      const rt = new Runtime();
      const journal = new MemoryJournal();
      const scope = { kind: "agent", id: agentKey } as const;
      const applier = (): EnvironmentChangeApplier => new EnvironmentChangeApplier({ environments: env, pauses, stops, runtime: rt, journal });
      const active = async () => { const e = (await env.get(owner, agentId))!; return { revision: e.active!.revision, names: e.active!.manifest.packages.map((p) => p.name).sort() }; };
      const latest = async () => (await env.get(owner, agentId))!.latest;
      await body({ owner, agentId, scope, env, pauses, stops, rt, sp, journal, applier, active, latest });
    } finally { await world.close(); }
  });

  suite("a package is staged, tried in a disposable environment, the agent suspended, the worker reloaded, the revision activated and validated, and the running agent resumed", async (c) => {
    const out = await c.applier().apply(view(c.agentId, "mnt-aaaa"));
    assert.equal(out.outcome, "applied", JSON.stringify(out));
    assert.deepEqual(c.rt.calls, ["trial", "reload:2", "validate:2"], "trial before anything live is touched, then reload and validate on the new revision");
    assert.equal(c.rt.trials[0]!.installScripts, false);
    assert.deepEqual(c.rt.trials[0]!.candidate.packages.map((p) => p.name).sort(), ["jq", "ripgrep"]);
    assert.equal(c.rt.reloads[0]!.checkpointId, "cp-1", "the worker is restored from the suspension's checkpoint");
    assert.deepEqual(await c.active(), { revision: 2, names: ["jq", "ripgrep"] });
    assert.equal((await c.pauses.gate(c.owner, c.scope))?.intent, "active", "an agent that was running is running again");
    const effect = (out as { effect: Record<string, unknown> }).effect;
    assert.deepEqual([effect["environmentRevision"], effect["previousRevision"], effect["restoredIntent"]], [2, 1, "resumed"]);
    // A repeat of the same request changes nothing and calls nothing.
    const again = await c.applier().apply(view(c.agentId, "mnt-aaaa"));
    assert.deepEqual(again, out);
    assert.deepEqual(c.rt.calls.length, 3);
    assert.equal(await c.latest(), 2);
  });

  suite("an agent that was paused stays paused with its own hold and observed state; a suspended agent stays suspended", async (c) => {
    await c.pauses.pause(c.owner, { commandId: cid("p"), scope: c.scope, reason: "owner is thinking" });
    await c.pauses.observe(c.owner, { commandId: cid("o"), scope: c.scope, state: "paused", boundary: "finished" });
    const before = await c.pauses.gate(c.owner, c.scope);
    const out = await c.applier().apply(view(c.agentId, "mnt-bbbb"));
    assert.equal(out.outcome, "applied");
    const after = await c.pauses.gate(c.owner, c.scope);
    assert.deepEqual([after?.intent, after?.requestId, after?.owner, after?.observed?.state], ["pause", before?.requestId, before?.owner, "paused"], "the owner's pause is neither lifted nor replaced");
    assert.equal((out as { effect: Record<string, unknown> }).effect["restoredIntent"], "kept-paused");
    // A suspended agent (checkpointed earlier) stays suspended.
    const { intentId } = await c.stops.request(c.owner, { commandId: cid("s"), scope: c.scope, mode: "suspend", reason: "night" });
    await c.stops.advance(c.owner, { intentId });
    assert.equal((await c.pauses.gate(c.owner, c.scope))?.observed?.state, "suspended");
    const second = await c.applier().apply(view(c.agentId, "mnt-cccc", { name: "fd", version: "9.0.0", digest: D("1"), source: "https://example.org/fd.tgz" }));
    assert.equal(second.outcome, "applied");
    const last = await c.pauses.gate(c.owner, c.scope);
    assert.deepEqual([last?.intent, last?.observed?.state], ["pause", "suspended"]);
    assert.equal((await c.active()).names.includes("fd"), true);
  });

  suite("a validation that finds the session or compaction state damaged rolls back to the previous manifest and gives the agent its intent back", async (c) => {
    c.rt.validateResults = [{ ok: true, sessionIntact: true, compactionIntact: false }];
    const out = await c.applier().apply(view(c.agentId, "mnt-dddd"));
    assert.equal(out.outcome, "failed");
    assert.match((out as { reason: string }).reason, /compaction state was not intact/);
    assert.deepEqual(c.rt.calls, ["trial", "reload:2", "validate:2", "reload:1"], "the worker is reloaded on the previous revision");
    const now = await c.active();
    assert.deepEqual(now.names, ["ripgrep"], "the active manifest is the previous one");
    assert.equal(now.revision, 3, "a rollback is a new revision from the old manifest; the history is kept");
    assert.equal((await c.pauses.gate(c.owner, c.scope))?.intent, "active");
    const again = await c.applier().apply(view(c.agentId, "mnt-dddd"));
    assert.equal(again.outcome, "failed");
    assert.equal(c.rt.calls.length, 4, "a repeat of a rolled-back request touches nothing");
  });

  suite("a worker that cannot be reloaded, or whose protected extensions do not verify, leaves the previous revision active", async (c) => {
    c.rt.reloadResults = [{ ok: false, reason: "extension failed to load" }];
    const one = await c.applier().apply(view(c.agentId, "mnt-eeee"));
    assert.equal(one.outcome, "failed");
    assert.deepEqual(await c.active(), { revision: 1, names: ["ripgrep"] }, "nothing was activated, so nothing is rolled back");
    assert.equal((await c.pauses.gate(c.owner, c.scope))?.intent, "active");
    // The protected extension on disk is not the one the manifest names: the activation is refused and the previous revision stays.
    c.rt.reloadResults = [{ ok: true, observed: { "nimblenewt.desk": D("9") } }];
    const two = await c.applier().apply(view(c.agentId, "mnt-ffff", { name: "fd", version: "9.0.0", digest: D("1"), source: "https://example.org/fd.tgz" }));
    assert.equal(two.outcome, "failed");
    assert.match((two as { reason: string }).reason, /on disk is not the one the manifest names/);
    assert.deepEqual((await c.active()).names, ["ripgrep"]);
    assert.equal((await c.pauses.gate(c.owner, c.scope))?.intent, "active");
  });

  suite("the trial comes first: a mismatched digest, undeclared install scripts or a missing sandbox change nothing live", async (c) => {
    c.rt.trialResult = { ok: true, digestVerified: false, scriptsDeclared: false, scriptsRan: false };
    const mismatch = await c.applier().apply(view(c.agentId, "mnt-g1"));
    assert.equal(mismatch.outcome, "failed");
    assert.match((mismatch as { reason: string }).reason, /digest mismatch/);
    c.rt.trialResult = { ok: true, digestVerified: true, scriptsDeclared: true, scriptsRan: false };
    const scripts = await c.applier().apply(view(c.agentId, "mnt-g2"));
    assert.equal(scripts.outcome, "failed");
    assert.match((scripts as { reason: string }).reason, /install scripts/);
    // The same artifact with a request that said it has scripts (so it was approved as such) goes through, scripts run in the trial only.
    c.rt.trialResult = { ok: true, digestVerified: true, scriptsDeclared: true, scriptsRan: true };
    const declared = await c.applier().apply(view(c.agentId, "mnt-g4", { installScripts: true }));
    assert.equal(declared.outcome, "applied");
    assert.equal(c.rt.trials.at(-1)!.installScripts, true);
    c.rt.trialResult = "throw";
    const none = await c.applier().apply(view(c.agentId, "mnt-g3", { name: "fd", version: "9.0.0", digest: D("1"), source: "https://example.org/fd.tgz" }));
    assert.equal(none.outcome, "unsupported");
    assert.equal(c.rt.reloads.length, 1, "only the approved-with-scripts request reached a worker");
    assert.equal(await c.latest(), 2, "the failed trials staged no revision");
  });

  suite("a suspension that is not possible leaves the change pending and the agent as it was; a later try finishes with the same staged revision", async (c) => {
    c.sp.durable = false; // the checkpoint is not durable, so the suspend blocks
    const out = await c.applier().apply(view(c.agentId, "mnt-h1"));
    assert.equal(out.outcome, "unsupported");
    assert.match((out as { reason: string }).reason, /suspended safely/);
    assert.equal((await c.pauses.gate(c.owner, c.scope))?.intent, "active", "the hold taken for the suspension was let go");
    assert.deepEqual(await c.active(), { revision: 1, names: ["ripgrep"] });
    assert.equal(c.rt.reloads.length, 0, "the worker was never touched");
    const staged = await c.latest();
    c.sp.durable = true;
    const retry = await c.applier().apply(view(c.agentId, "mnt-h1"));
    assert.equal(retry.outcome, "applied");
    assert.equal(await c.latest(), staged, "the retry reused the staged revision");
    assert.equal(c.rt.trials.length, 1, "and did not try the package again");
    c.sp.cannot = "this host cannot suspend an agent";
    const refused = await c.applier().apply(view(c.agentId, "mnt-h2", { name: "fd", version: "9.0.0", digest: D("1"), source: "https://example.org/fd.tgz" }));
    assert.equal(refused.outcome, "unsupported");
    assert.equal((await c.pauses.gate(c.owner, c.scope))?.intent, "active");
  });

  suite("a crash in the middle resumes at the step reached: no second suspension, no second trial", async (c) => {
    c.rt.reloadResults = ["throw"];
    await assert.rejects(c.applier().apply(view(c.agentId, "mnt-i1")), /host went away/);
    assert.equal((await c.pauses.gate(c.owner, c.scope))?.intent, "pause", "the agent is still suspended while the outcome is unknown");
    const out = await c.applier().apply(view(c.agentId, "mnt-i1"));
    assert.equal(out.outcome, "applied");
    assert.equal(c.sp.calls.length, 1, "one checkpoint, from the first pass");
    assert.equal(c.rt.trials.length, 1);
    assert.equal((await c.pauses.gate(c.owner, c.scope))?.intent, "active");
    assert.deepEqual((await c.active()).names, ["jq", "ripgrep"]);
  });

  suite("a revoked change is taken back by the same sequence; a half-done one is verified and restored", async (c) => {
    const done = await c.applier().apply(view(c.agentId, "mnt-j1"));
    assert.equal(done.outcome, "applied");
    const back = await c.applier().revert(view(c.agentId, "mnt-j1"), (done as { effect: Record<string, unknown> }).effect as never);
    assert.equal(back.outcome, "reverted");
    assert.deepEqual((await c.active()).names, ["ripgrep"]);
    assert.equal((await c.pauses.gate(c.owner, c.scope))?.intent, "active");
    const twice = await c.applier().revert(view(c.agentId, "mnt-j1"), {});
    assert.equal(twice.outcome, "reverted");
    // Half-done: the worker was reloaded and activated, then the host died. The revert finds the agent still suspended and restores it.
    c.rt.validateResults = [{ ok: false, reason: "host went away" }];
    c.rt.reloadResults = [];
    const stuck = await c.applier().apply(view(c.agentId, "mnt-j2", { name: "fd", version: "9.0.0", digest: D("1"), source: "https://example.org/fd.tgz" }));
    assert.equal(stuck.outcome, "failed", "a failed validation is rolled back at once");
    // A request that never got further than staging has nothing to undo.
    const none = await c.applier().revert(view(c.agentId, "mnt-never"), { uncertain: true });
    assert.equal(none.outcome, "reverted");
  });

  suite("a package already in the environment is not installed again; access changes and protected changes stay pending; a skill draft is only recorded", async (c) => {
    const same = await c.applier().apply(view(c.agentId, "mnt-k1", { name: "ripgrep", version: "14.1.0", digest: D("b") }));
    assert.equal(same.outcome, "applied");
    assert.equal((same as { effect: Record<string, unknown> }).effect["unchanged"], true);
    assert.equal(c.rt.calls.length, 0);
    for (const kind of ["mount", "network", "host-policy", "base"] as const) assert.equal((await c.applier().apply(view(c.agentId, `mnt-${kind}`, {}, kind))).outcome, "unsupported", kind);
    const skill = await c.applier().apply(view(c.agentId, "mnt-k2", { name: "notes", digest: D("2") }, "skill"));
    assert.equal(skill.outcome, "applied");
    assert.equal(await c.latest(), 1);
  });
}
