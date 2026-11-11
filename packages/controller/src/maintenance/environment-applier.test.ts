import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { backendsNamed, stopServer } from "../domain/testing/backends.js";
import { ProjectService } from "../domain/service.js";
import { EnvironmentService, MAINTENANCE_PRINCIPAL, type EnvironmentManifest } from "../environments/index.js";
import { PauseService, StopService, type InventoryItem, type StopPorts } from "../lifecycle/index.js";
import { GrantService, PrincipalService, type Principal } from "../security/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { EnvironmentChangeApplier, MemoryJournal, StorageJournal, type JournalBody, type EnvironmentRuntime, type ReloadInput, type TrialInput, type TrialResult, type ValidateResult } from "./environment-applier.js";
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
  /** When set, a reload waits for this before it answers (to hold an application part way). */
  gate: Promise<void> | undefined;
  async trial(input: TrialInput): Promise<TrialResult> { this.calls.push("trial"); this.trials.push(input); if (this.trialResult === "throw") throw new Error("no sandbox"); return this.trialResult; }
  async reload(input: ReloadInput) { this.calls.push(`reload:${input.revision}`); this.reloads.push(input); if (this.gate !== undefined) await this.gate; const r = this.reloadResults.shift() ?? { ok: true as const, observed: OBSERVED }; if (r === "throw") throw new Error("host went away"); return r; }
  async validate(input: ReloadInput): Promise<ValidateResult> { this.calls.push(`validate:${input.revision}`); return this.validateResults.shift() ?? { ok: true, sessionIntact: true, compactionIntact: true }; }
}
class Stopping implements StopPorts {
  calls: string[] = [];
  durable = true;
  cannot: string | undefined;
  /** How many cleanups still report work running (a busy agent settles over several looks). */
  busy = 0;
  unsupported(): string | undefined { return this.cannot; }
  async inventory(): Promise<InventoryItem[]> { return []; }
  async cleanup() { if (this.busy > 0) { this.busy--; return { remaining: [{ kind: "foreground" as const, ref: "tool-call-1", state: "running" as const }] }; } return { remaining: [] }; }
  async checkpoint() { this.calls.push("checkpoint"); return { checkpointId: `cp-${this.calls.length}`, durable: this.durable, artifactsDurable: true }; }
  async terminate() { this.calls.push("terminate"); return { ended: true, unresolved: [] }; }
}

const view = (agentId: string, id: string, spec: Record<string, unknown> = {}, kind: MaintenanceView["kind"] = "package"): MaintenanceView => ({
  id, agentId, kind, class: "dependency", specDigest: D("e"), spec: { name: "jq", version: "1.7.1", digest: D("f"), source: "https://example.org/jq-1.7.1.tgz", installScripts: false, ...spec },
});

for (const backend of backendsNamed("SQLite")) {
  const suite = (name: string, body: (c: {
    owner: Principal; agentId: string; scope: { kind: "agent"; id: string }; env: EnvironmentService; pauses: PauseService; stops: StopService; rt: Runtime; sp: Stopping; journal: MemoryJournal;
    applier(): EnvironmentChangeApplier; active(): Promise<{ revision: number; names: string[] }>; latest(): Promise<number>; storage: ControllerStorage; epoch: number;
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
      const applier = (): EnvironmentChangeApplier => new EnvironmentChangeApplier({ environments: env, pauses, stops, runtime: rt, journal, pollMs: 1 });
      const active = async () => { const e = (await env.get(owner, agentId))!; return { revision: e.active!.revision, names: e.active!.manifest.packages.map((p) => p.name).sort() }; };
      const latest = async () => (await env.get(owner, agentId))!.latest;
      await body({ owner, agentId, scope, env, pauses, stops, rt, sp, journal, applier, active, latest, storage: world.storage, epoch });
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

  suite("a revision the agent wrote with the request's marker is never taken for the staged one: the trial still runs and only the approved artifact is activated", async (c) => {
    // An agent may write its own package revisions (environment.manage). It knows its request's ID, so it can write a revision whose reason carries the applier's marker.
    const self = { id: c.agentId, kind: "agent", name: "A", grants: [{ action: "environment.manage", project: "*" }], restrictions: [], asOf: "2026-11-11T00:00:00.000Z" } as unknown as Principal;
    const evil = { ...base(), packages: [...base().packages, { name: "jq", version: "1.7.1", digest: D("f") }, { name: "evil", version: "6.6.6", digest: D("6") }] };
    await c.env.change(self, { commandId: cid("spoof"), agentId: c.agentId, manifest: evil, reason: "maintenance mnt-spoof: package jq@1.7.1 (was revision 1)", expectedRevision: 1 });
    const out = await c.applier().apply(view(c.agentId, "mnt-spoof"));
    assert.equal(out.outcome, "applied", JSON.stringify(out));
    assert.equal(c.rt.trials.length, 1, "the approved artifact was tried; nothing skipped the trial");
    assert.deepEqual(await c.active(), { revision: 3, names: ["jq", "ripgrep"] }, "the agent's own revision was not activated");
  });

  suite("only the controller's own maintenance principal manages environments: a service enrolled under the same name gains nothing", async (c) => {
    const forged = { id: "service:maintenance", kind: "service", name: "maintenance", grants: [], restrictions: [], asOf: "2026-11-11T00:00:00.000Z" } as unknown as Principal;
    await assert.rejects(c.env.change(forged, { commandId: cid("f"), agentId: c.agentId, manifest: base(), reason: "x", expectedRevision: 1 }), /may not change/);
    await assert.rejects(c.env.activate(forged, { commandId: cid("f"), agentId: c.agentId, revision: 1, observed: OBSERVED }), /not the owner/);
    await assert.rejects(c.env.rollback(forged, { commandId: cid("f"), agentId: c.agentId, toRevision: 1, reason: "x", observed: OBSERVED, expectedRevision: 1 }), /not the owner/);
    assert.equal(await c.env.get(forged, c.agentId), undefined, "nor may it read another agent's environment");
    assert.equal((await c.env.get(MAINTENANCE_PRINCIPAL, c.agentId))?.latest, 1);
  });

  suite("the intent given back is the one right before the suspension: a pause lifted while the change waited does not leave the applier's own hold in place", async (c) => {
    await c.pauses.pause(c.owner, { commandId: cid("p"), scope: c.scope, reason: "owner is thinking" });
    c.sp.durable = false;
    assert.equal((await c.applier().apply(view(c.agentId, "mnt-l1"))).outcome, "unsupported");
    assert.equal((await c.pauses.gate(c.owner, c.scope))?.intent, "pause", "the owner's pause stays");
    await c.pauses.resume(c.owner, { commandId: cid("r"), scope: c.scope, reason: "go on" });
    c.sp.durable = true;
    const out = await c.applier().apply(view(c.agentId, "mnt-l1"));
    assert.equal(out.outcome, "applied", JSON.stringify(out));
    assert.equal((out as { effect: Record<string, unknown> }).effect["restoredIntent"], "resumed");
    assert.equal((await c.pauses.gate(c.owner, c.scope))?.intent, "active", "the agent runs again: the hold the suspension made was lifted");
  });

  suite("a busy agent whose work settles over several looks is suspended, not given up on at the first look", async (c) => {
    c.sp.busy = 3;
    const out = await c.applier().apply(view(c.agentId, "mnt-busy"));
    assert.equal(out.outcome, "applied", JSON.stringify(out));
    assert.equal(c.sp.busy, 0);
  });

  suite("a change reverted after an unclear application is applied afresh when it is tried again, never reported from the old round", async (c) => {
    const first = await c.applier().apply(view(c.agentId, "mnt-m1"));
    assert.equal(first.outcome, "applied");
    const back = await c.applier().revert(view(c.agentId, "mnt-m1"), { uncertain: true });
    assert.equal(back.outcome, "reverted");
    assert.deepEqual((await c.active()).names, ["ripgrep"]);
    const again = await c.applier().apply(view(c.agentId, "mnt-m1"));
    assert.equal(again.outcome, "applied", JSON.stringify(again));
    assert.deepEqual((await c.active()).names, ["jq", "ripgrep"], "the application that reports applied really is active");
    assert.equal((again as { effect: Record<string, unknown> }).effect["environmentRevision"], (await c.active()).revision);
    assert.equal(c.rt.trials.length, 2, "the new round tried the artifact again");
    assert.equal((await c.pauses.gate(c.owner, c.scope))?.intent, "active");
    // Revoked now: the active round is taken back; a second revert has nothing more to do.
    assert.equal((await c.applier().revert(view(c.agentId, "mnt-m1"), {})).outcome, "reverted");
    assert.deepEqual((await c.active()).names, ["ripgrep"]);
    assert.equal((await c.applier().revert(view(c.agentId, "mnt-m1"), {})).outcome, "reverted");
    assert.deepEqual((await c.active()).names, ["ripgrep"]);
  });

  suite("an environment the owner changed after the change was staged is not undone: the change is staged again on what is active", async (c) => {
    c.sp.durable = false;
    assert.equal((await c.applier().apply(view(c.agentId, "mnt-n1"))).outcome, "unsupported");
    assert.equal(await c.latest(), 2, "staged and waiting");
    const owners = { ...base(), packages: [...base().packages, { name: "fd", version: "9.0.0", digest: D("1") }] };
    await c.env.change(c.owner, { commandId: cid("c"), agentId: c.agentId, manifest: owners, reason: "owner adds fd", expectedRevision: 2 });
    await c.env.activate(c.owner, { commandId: cid("a"), agentId: c.agentId, revision: 3, observed: OBSERVED });
    c.sp.durable = true;
    const moved = await c.applier().apply(view(c.agentId, "mnt-n1"));
    assert.equal(moved.outcome, "unsupported");
    assert.match((moved as { reason: string }).reason, /environment changed/);
    assert.deepEqual(await c.active(), { revision: 3, names: ["fd", "ripgrep"] }, "the owner's revision stays active");
    const out = await c.applier().apply(view(c.agentId, "mnt-n1"));
    assert.equal(out.outcome, "applied", JSON.stringify(out));
    assert.deepEqual((await c.active()).names, ["fd", "jq", "ripgrep"], "the change is made on top of the owner's");
    assert.equal((await c.pauses.gate(c.owner, c.scope))?.intent, "active");
  });

  suite("an agent resumed between its suspension and the reload is not reloaded while it may run; the revert suspends it again first", async (c) => {
    c.rt.reloadResults = ["throw"];
    await assert.rejects(c.applier().apply(view(c.agentId, "mnt-o1")), /host went away/);
    await c.pauses.resume(c.owner, { commandId: cid("r"), scope: c.scope, reason: "I need it now" });
    const out = await c.applier().apply(view(c.agentId, "mnt-o1"));
    assert.equal(out.outcome, "unsupported", JSON.stringify(out));
    assert.equal(c.rt.reloads.length, 1, "the running agent's worker was not reloaded");
    // The service's verify-and-restore pass after the throw: the agent runs, so it is suspended again before its worker is touched.
    c.rt.reloadResults = ["throw"];
    await assert.rejects(c.applier().apply(view(c.agentId, "mnt-o2", { name: "fd", version: "9.0.0", digest: D("1"), source: "https://example.org/fd.tgz" })), /host went away/);
    await c.pauses.resume(c.owner, { commandId: cid("r"), scope: c.scope, reason: "again" });
    const checkpoints = c.sp.calls.filter((x) => x === "checkpoint").length;
    const back = await c.applier().revert(view(c.agentId, "mnt-o2", { name: "fd", version: "9.0.0", digest: D("1"), source: "https://example.org/fd.tgz" }), { uncertain: true });
    assert.equal(back.outcome, "reverted", JSON.stringify(back));
    assert.equal(c.sp.calls.filter((x) => x === "checkpoint").length, checkpoints + 1, "suspended again before the reload");
    assert.equal((await c.pauses.gate(c.owner, c.scope))?.intent, "active");
    assert.deepEqual((await c.active()).names, ["ripgrep"]);
  });

  suite("a revert or a second application never races an application still running", async (c) => {
    let release!: () => void;
    c.rt.gate = new Promise<void>((r) => { release = r; });
    const a = c.applier();
    const running = a.apply(view(c.agentId, "mnt-p1"));
    for (let i = 0; i < 200 && c.rt.reloads.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(c.rt.reloads.length, 1);
    assert.equal((await a.revert(view(c.agentId, "mnt-p1"), { uncertain: true })).outcome, "unsupported");
    assert.equal((await a.apply(view(c.agentId, "mnt-p1"))).outcome, "unsupported");
    release();
    assert.equal((await running).outcome, "applied");
    assert.deepEqual((await c.active()).names, ["jq", "ripgrep"]);
  });

  suite("a rollback whose activation failed is finished by the repeat with the same new revision; the reloads carry the approved script behaviour", async (c) => {
    c.rt.validateResults = [{ ok: false, reason: "session lost" }];
    c.rt.reloadResults = [{ ok: true, observed: OBSERVED }, { ok: true, observed: { "nimblenewt.desk": D("9") } }];
    await assert.rejects(c.applier().apply(view(c.agentId, "mnt-q1")), /could not be activated/);
    assert.equal(await c.latest(), 3, "the rollback revision exists, not active");
    assert.equal((await c.active()).revision, 2);
    const back = await c.applier().revert(view(c.agentId, "mnt-q1"), { uncertain: true });
    assert.equal(back.outcome, "reverted", JSON.stringify(back));
    assert.deepEqual(await c.active(), { revision: 3, names: ["ripgrep"] }, "the same rollback revision was activated; no second one was written");
    assert.equal(await c.latest(), 3);
    assert.equal(c.rt.reloads[0]!.change?.installScripts, false, "the forward reload says scripts stay off");
    assert.equal(c.rt.reloads[1]!.change, undefined, "a rollback reload installs nothing with scripts");
  });

  suite("access changes are never applied here, so a revert of one has nothing to undo; the stored journal takes a body written again after another", async (c) => {
    for (const kind of ["mount", "network"] as const) assert.equal((await c.applier().revert(view(c.agentId, `mnt-r-${kind}`, {}, kind), { uncertain: true })).outcome, "reverted", kind);
    const j = new StorageJournal(c.storage, c.epoch, options);
    const a: JournalBody = { agentId: c.agentId, previousRevision: 1, stagedRevision: 2, prior: { paused: false }, phase: "staged", suspends: 1 };
    await j.write("mnt-s1", a);
    await j.write("mnt-s1", { ...a, phase: "suspended", checkpointId: "cp-1" });
    await j.write("mnt-s1", a);
    assert.equal((await j.read("mnt-s1"))?.phase, "staged");
  });
}
