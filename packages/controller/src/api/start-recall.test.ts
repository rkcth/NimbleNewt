import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService } from "../admission/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI, ScriptedWorker, EXEC_PROFILES, ROUTING_TABLE, workGrants } from "../dispatch/testing/world.js";
import type { ToolGateway, WorkOrder } from "../dispatch/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { HostService } from "../hosts/index.js";
import { PolicyService } from "../policy/index.js";
import { DifficultyService } from "../routing/index.js";
import type { BridgeResponse } from "../toolbridge/index.js";
import { startController } from "./index.js";
import type { DispatchStartOptions } from "./dispatch-compose.js";

// Card W13 through the composed controller and its real tool bridge: attempt one ends and the controller writes a hand-off note too long to keep whole (card C07p); attempt two, after its own notes, calls task.recall exactly as a worker
// process does (its task credential and a request) and gets its own task's notes, the hand-off, the cut note's whole text and the activity digest back. Another task's IDs read as missing. The owner's switch and the call cap, set through the
// API the chat uses, apply at the next call; the anchor of the next start carries the one-line mention only while the tool is on.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const EFFECTS = Array.from({ length: 200 }, (_, i) => ({ id: `eff-${String(i).padStart(3, "0")}`, state: "confirmed" as const, summary: `watered bed ${i} twice` }));
type BuildServices = Parameters<NonNullable<DispatchStartOptions["local"]>["build"]>[0];
const good = (r: BridgeResponse): Record<string, any> => { assert.equal(r.ok, true, JSON.stringify(r)); return (r as { result: Record<string, any> }).result; };

test("an attempt calls task.recall through the real bridge with its task credential and gets its own task's records back; foreign IDs read as missing; the owner's switch and cap apply; the anchor mentions the tool only while it is on (W13)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-w13-start-"));
  let services: BuildServices | undefined;
  let script: (ctx: { order: WorkOrder; gateway: ToolGateway }) => Promise<any> = async () => ({ status: "completed", text: "the worker stopped" });
  const worker = new ScriptedWorker("host:w1", (ctx) => script(ctx as never));
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: {
      timer: new ManualTimer(), manual: true, local: { window: () => 32768, acceptUnenforcedLimits: true, build: (s: BuildServices) => { services = s; return worker; } },
      handoffFacts: async ({ taskId }: { taskId: string }) => ({ task: `Water the beds ${taskId.slice(-4)}`, effects: EFFECTS, artifacts: [{ id: "art-001", title: "the bed plan" }], lastKnownState: "beds 1-3 watered" }),
    },
    tools: { runner: { run: async () => ({ text: "{}", cpuMs: 1 }) }, isLocalHost: (h: string) => h === "host:w1", facts: async () => ({ os: "linux", arch: "x64", interpreters: { node: "22.19.0" }, packages: [], extensions: [] }) },
  } as never);
  try {
    assert.ok(c.dispatch !== undefined && c.tools !== undefined, c.dispatchProblem);
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const callAs = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
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
    const annId = (await s.agents.create(rob, { commandId: "ag-a", friendlyName: "ann" })).id;
    const bobId = (await s.agents.create(rob, { commandId: "ag-b", friendlyName: "bob" })).id;
    for (const who of [annId, bobId]) for (const g of workGrants(project)) await s.grants.grant(rob, { commandId: `g-${who}-${g.action}`, grantee: `agent:${who}`, action: g.action, project, source: "direct", basis: "test" });

    const mk = async (title: string, agent: string): Promise<{ taskId: string; attemptId: string }> => {
      const k = title.replace(/[^A-Za-z]/g, "");
      const taskId = (await s.projects.createTask({ commandId: `t-${k}`, actor: rob.id, projectId: project, title })).id;
      await s.projects.transitionTask({ commandId: `r-${k}`, actor: rob.id, taskId, expectedRevision: 1, to: "ready" });
      await s.assignments.assignTask({ commandId: `as-${k}`, actor: rob.id, taskId, owner: { kind: "agent", id: agent } });
      const a = (await s.assignments.getAssignment(taskId))!;
      const attemptId = (await s.assignments.admitAttempt({ commandId: `ad-${k}`, actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agent }, harness: "pi" })).id;
      return { taskId, attemptId };
    };
    const ended = async (): Promise<void> => { for (let i = 0; i < 6; i++) { await c.dispatch!.dispatcher.tick(); await c.dispatch!.dispatcher.idle(); } };
    const first = await mk("Water the beds", annId);
    const bobs = await mk("Prune the roses", bobId);
    await ended();
    const handoffs = (await c.storage.listAggregates("ctx-handoff", { limit: 50 })).map((r) => r.body as unknown as { taskId: string; source: string; text: string });
    const digestOf = (taskId: string): string => /sha256:[0-9a-f]{64}/.exec(handoffs.find((h) => h.taskId === taskId && h.source === "controller")!.text)![0];
    const mine = digestOf(first.taskId), theirs = digestOf(bobs.taskId);
    const hofIds = (await c.storage.listAggregates("ctx-handoff", { limit: 50 })).map((r) => ({ id: r.id, taskId: (r.body as unknown as { taskId: string }).taskId }));
    const bobHof = hofIds.find((h) => h.taskId === bobs.taskId)!.id;

    // The second attempt of the first task.
    const asg = (await s.assignments.getAssignment(first.taskId))!;
    const second = (await s.assignments.admitAttempt({ commandId: "ad2", actor: "inbox", taskId: first.taskId, expectedRevision: asg.revision, generation: asg.generation, owner: { kind: "agent", id: annId }, harness: "pi" })).id;
    const out: Record<string, BridgeResponse> = {};
    let failure: unknown;
    let prompt = "";
    script = async ({ order, gateway }) => {
      prompt = order.content;
      const send = (op: string, args: Record<string, unknown>, callId: string, token = order.credential) => services!.bridge!(order, gateway.call, token, { op, callId, args });
      try {
        good(await send("work.note", { kind: "did", text: "decided to use the rain barrel" }, "n1"));
        out["decisions"] = await send("task.recall", { part: "decisions" }, "r1");
        out["list"] = await send("task.recall", { part: "archives" }, "r2");
        out["whole"] = await send("task.recall", { part: "archives", id: mine, maxChars: 8000 }, "r3");
        out["foreign"] = await send("task.recall", { part: "archives", id: theirs }, "r4");
        out["foreign-note"] = await send("task.recall", { part: "decisions", id: bobHof }, "r5");
        out["missing"] = await send("task.recall", { part: "archives", id: `sha256:${"7".repeat(64)}` }, "r6");
        out["named"] = await send("task.recall", { taskId: bobs.taskId }, "r7");
        out["forged"] = await send("task.recall", { part: "anchor" }, "r8", "nn_forged_credential");
        out["activity"] = await send("task.recall", { part: "activity" }, "r9");
        // The owner turns the tool off: the next call is refused.
        const off = await callAs(boot.token, "context.route.change", { disable: ["recall"] }, "off-1");
        assert.equal(off.ok, true, JSON.stringify(off));
        out["off"] = await send("task.recall", { part: "anchor" }, "r10");
        const on = await callAs(boot.token, "context.route.change", { enable: ["recall"], set: { recallCalls: 9 } }, "on-1");
        assert.equal(on.ok, true, JSON.stringify(on));
        out["on"] = await send("task.recall", { part: "anchor" }, "r11");
      } catch (error) { failure = error; throw error; }
      return { status: "completed", text: "the worker stopped" };
    };
    await ended();
    if (failure !== undefined) throw failure;

    assert.match(prompt, /nimblenewt__task-recall \(task\.recall\)/, "the anchor at the top of the prompt says the tool exists");
    const decisions = good(out["decisions"]!);
    assert.equal(decisions["part"], "decisions");
    assert.ok((decisions["text"] as string).includes("decided to use the rain barrel"), "the agent's own note");
    assert.match(decisions["text"] as string, /hand-off hof-[a-z2-7]{20} \(controller\) of attempt/, "the hand-off note of the first attempt");
    assert.ok((good(out["list"]!)["text"] as string).includes(mine) && !(good(out["list"]!)["text"] as string).includes(theirs));
    const whole = good(out["whole"]!);
    assert.equal(whole["found"], true);
    assert.ok((whole["text"] as string).includes("eff-000") || whole["next"] !== undefined, "the cut note's text comes back (in pages)");
    assert.ok(whole["chars"] <= 8000 && (whole["text"] as string).length <= 8000);
    // Another task's IDs behave exactly like missing ones.
    const foreign = good(out["foreign"]!), foreignNote = good(out["foreign-note"]!), missing = good(out["missing"]!);
    assert.equal(foreign["found"], false);
    assert.equal(foreignNote["found"], false);
    assert.equal(missing["found"], false);
    assert.deepEqual(Object.keys(foreign).sort(), Object.keys(missing).sort());
    assert.equal(foreign["text"], missing["text"]);
    assert.ok(!JSON.stringify([foreign, foreignNote]).includes("Prune the roses"));
    const named = out["named"] as { ok: false; code: string };
    assert.deepEqual([named.ok, named.code], [false, "invalid_command"], "a task named in the arguments is refused");
    assert.equal((out["forged"] as { code: string }).code, "unauthenticated");
    const activity = good(out["activity"]!);
    assert.ok((activity["text"] as string).includes(second) && (activity["text"] as string).includes("(this one)"));
    assert.equal((out["off"] as { code: string }).code, "recall_off");
    good(out["on"]!);

    // The owner sees it was used: counts only, in the task's activity.
    const steps = await s.activity.steps(rob, first.taskId, { limit: 100 });
    const used = steps.steps.filter((x) => "summary" in x && /task\.recall/.test(x.summary)) as { summary: string }[];
    assert.ok(used.length >= 6, `${used.length} steps`);
    assert.ok(used.every((x) => /characters/.test(x.summary) && !/rain barrel|eff-000/.test(x.summary)), JSON.stringify(used));

    // With the tool off, the next start's anchor does not mention it.
    await callAs(boot.token, "context.route.change", { disable: ["recall"] }, "off-2");
    const third = await (async () => { const a = (await s.assignments.getAssignment(first.taskId))!; return (await s.assignments.admitAttempt({ commandId: "ad3", actor: "inbox", taskId: first.taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: annId }, harness: "pi" })).id; })();
    script = async ({ order }) => { prompt = order.content; return { status: "completed", text: "the worker stopped" }; };
    prompt = "";
    await ended();
    assert.ok(prompt.length > 0 && !/task\.recall/.test(prompt), `attempt ${third}: with the switch off the anchor says nothing about the tool`);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
