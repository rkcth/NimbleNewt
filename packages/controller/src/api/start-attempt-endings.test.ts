import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { AdmissionService } from "../admission/index.js";
import { ModelInterpreter } from "../chat/model-interpreter.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { EXEC_PROFILES, PI, ScriptedWorker, workGrants } from "../dispatch/testing/world.js";
import { DifficultyService } from "../routing/index.js";
import type { WorkerTurnResult } from "../dispatch/ports.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { HostService } from "../hosts/index.js";
import { PolicyService } from "../policy/index.js";
import { startTestServer, withClient, type TestServer } from "../storage/postgres/testing/server.js";
import { startController, type Controller, type StartOptions } from "./index.js";

// Card W08 through the composed controller: an agent's turns keep ending before it says its work is done (cut off, a step announced and not taken, prose with no work.end), each after nudges, until the task gets the
// agent_stopped_early blocker. The owner asks in free words, through the chat's model interpreter, why the last attempt stopped and how far it got: no fixed phrase, the interpreter is told of the `attempt_endings` view in
// its prompt and picks it. The answer shows each end kind in plain words, the nudges, the plan progress and the blocker with the agent's last text; the state API (the browser's source) gives the same lines.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const TABLE = {
  providers: { localp: { enabled: true, paid: false, location: "local" }, localq: { enabled: true, paid: false, location: "local" } },
  routes: { "localp/small": { contextTokens: 128_000, capabilities: ["tools"] }, "localp/other": { contextTokens: 128_000, capabilities: ["tools"] }, "localq/judge": { contextTokens: 128_000, capabilities: ["tools"] }, "localq/backup": { contextTokens: 128_000, capabilities: ["tools"] } },
  profiles: { "r-local": ["localp/small", "localq/backup"], judge: ["localq/judge", "localp/other"] }, roles: { coordinator: "r-local", "safety-supervisor": "judge" },
};

let server: Promise<TestServer> | undefined;
after(async () => { if (server !== undefined) await (await server).stop(); });
interface Store { readonly name: string; open(): Promise<{ storage: StartOptions["storage"]; close(): Promise<void> }> }
const stores: Store[] = [
  { name: "SQLite", open: async () => { const d = mkdtempSync(join(tmpdir(), "nn-endings-")); return { storage: { kind: "sqlite", path: join(d, "c.sqlite") }, close: async () => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }; } },
  ...(process.env["NIMBLENEWT_TIER"] === "typical" ? [] : [{ name: "PostgreSQL", open: async () => {
    server ??= startTestServer();
    const s = await server;
    const schema = `endings_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    return { storage: { kind: "postgres" as const, url: s.url(), schema }, close: async () => { await withClient(s.url(), async (cl) => { await cl.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }); } };
  } }]),
];

/**
 * A scripted stand-in for the chat's model: it reads the prompt it is given as a model would (the status kinds listed in the system text, the owner's words in the user text) and answers with one status intent. It finds the view
 * by what the prompt says the view is for, not by its name, so a view the prompt does not describe is not found; and it copies the task's title and the evidence from the owner's own words.
 */
function fakeModel(seen: { system: string; user: string }[]) {
  return {
    complete: async (_route: string, request: { system: string; user: string }): Promise<string> => {
      seen.push(request);
      const kinds = /request\.kind is one of \(with its keys; `a\|b` means either\): (.*)$/m.exec(request.system)?.[1] ?? "";
      const kind = kinds.split("; ").find((k) => /why did the last attempt stop or how far did it get/.test(k))?.split("(")[0];
      const words = /OWNER:\n<<<\n([\s\S]*?)\n>>>/.exec(request.user)?.[1] ?? "";
      const title = /Fix the parser/.exec(words)?.[0];
      if (kind === undefined || title === undefined) return JSON.stringify([{ kind: "none", reason: "no view fits" }]);
      return JSON.stringify([{ kind: "status", request: { kind, taskTitle: title }, evidence: title, basis: "owner" }]);
    },
  };
}

for (const store of stores) {
  test(`${store.name}: the owner asks in free words why the last attempt stopped and how far it got, through the model interpreter, and sees each end kind, the nudges, the plan progress and the blocker with the last text; the state API shows the same (card W08)`, async () => {
    const db = await store.open();
    const kinds = ["length", "announced-step-without-tool-call", "no-work-end"] as const;
    let n = 0;
    const worker = new ScriptedWorker("host:w1", async (): Promise<WorkerTurnResult> => { const k = kinds[n++ % 3]!; return { status: "completed", text: `Now I will run the parser tests (turn ${n}).`, endKind: k, visibleChars: 40, nudges: 3, checkpoint: { turn: n } }; });
    worker.progress = async () => ({ plan: { done: ["read the parser"], open: ["fix the bug", "run the tests"] }, diffStat: "1 file changed, 2 insertions(+)" });
    const seen: { system: string; user: string }[] = [];
    const c: Controller = await startController({
      storage: db.storage, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
      dispatch: { timer: new ManualTimer(), manual: true, workers: [worker] },
      chat: { interpreter: new ModelInterpreter(fakeModel(seen), () => ["localp/chat"]) },
    } as never);
    try {
      const s = c.services;
      const boot = await s.principals.bootstrapOwner({ name: "rob" });
      const owner = await s.principals.authenticate(boot.token);
      await s.routing.setTable(owner, { commandId: "rt", expectedRevision: 0, table: TABLE } as never);
      await DifficultyService.withEpoch(c.storage, c.epoch, s.routing, s.contracts).setProfiles(owner, { commandId: "sp", expectedRevision: 0, profiles: EXEC_PROFILES } as never);
      await s.principals.enroll(owner, { commandId: "e-host", kind: "host", name: "w1", grants: [] });
      const hostP = await s.principals.authenticate((await s.principals.issueCredential(owner, "host:w1")).token);
      const hosts = HostService.withEpoch(c.storage, c.epoch, s.assignments);
      await hosts.announce(hostP, { commandId: "an", capabilities: { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] } });
      let beat = 0;
      const heartbeat = async (): Promise<void> => { await hosts.heartbeat(hostP, { commandId: `hb${++beat}`, sequence: beat }); };
      await heartbeat();
      await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
      await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(owner, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
      const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
      const annId = (await s.agents.create(owner, { commandId: "ag-a", friendlyName: "ann" })).id;
      for (const g of workGrants(project)) await s.grants.grant(owner, { commandId: `g-${g.action}`, grantee: `agent:${annId}`, action: g.action, project, source: "direct", basis: "test" });
      const taskId = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "Fix the parser" })).id;
      await s.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
      await s.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId, owner: { kind: "agent", id: annId } });
      const a = (await s.assignments.getAssignment(taskId))!;
      const attemptId = (await s.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: annId }, harness: "pi" })).id;
      for (let i = 0; i < 5 && (await c.dispatch!.dispatcher.get(c.dispatch!.principal, attemptId))?.state !== "finished"; i++) { await heartbeat(); await c.dispatch!.dispatcher.tick(); await c.dispatch!.dispatcher.idle(); }
      const ended = await c.dispatch!.dispatcher.get(c.dispatch!.principal, attemptId);
      assert.equal(ended?.outcome?.status, "stopped-early", JSON.stringify({ ended, starts: worker.starts.length }));

      await c.chat!.setFocus(boot.token, { commandId: "f1", projectId: project });
      const ask = async (messageId: string, text: string): Promise<string[]> => {
        const out = (await c.chat!.submit(boot.token, { messageId, text })).outcomes[0] as { status: string; lines?: readonly { text: string }[] };
        assert.equal(out.status, "answered", JSON.stringify(out));
        return (out.lines ?? []).map((l) => l.text);
      };
      const why = await ask("m1", "why did the last attempt on Fix the parser stop?");
      // The interpreter's prompt lists the view with what it answers; the stand-in found it by that description.
      assert.match(seen[0]!.system, /attempt_endings\(taskId\|taskTitle\) - how each attempt of a task ended or stands/);
      const text = why.join("\n");
      assert.match(why[0]!, /^1 attempt\(s\) of Fix the parser on record, newest first\.$/);
      assert.match(text, new RegExp(`Attempt 1 \\(${attemptId}\\), agent ${annId} on route [^ ]+ as [^:]+: started [^;]+; it ended stopped early: the agent kept stopping before it said its work was done`));
      assert.match(text, /Its last turn: it ended with prose and no work\.end \(40 visible characters\)/);
      assert.match(text, /stopped before saying its work was done 3 time\(s\) \(the model ran out of length; it announced a step but made no call; it ended with prose and no work\.end\)/);
      assert.match(text, /Nudges to go on: 9 \(3 in its last turn\)\./);
      assert.match(text, /Plan: 1 of 3 step\(s\) checked\./);
      assert.match(text, /Open blocker agent_stopped_early since \S+: The agent stopped before it said its work was done, 3 time\(s\) in a row .*Last visible text \(quoted\): "Now I will run the parser tests \(turn 3\)\."/);

      // Other words, the same view: no fixed phrase is needed.
      const far = await ask("m2", "how far did it get with Fix the parser before it gave up");
      assert.deepEqual(far, why);

      // The state API, which the browser reads, shows the same figures.
      const viewed = (await c.api.handle(boot.token, { v: 1, op: "status.ask", args: { request: { kind: "attempt_endings", taskId } } } as never)) as { ok: boolean; result?: { item: { lines: { text: string }[] } } };
      assert.ok(viewed.ok, JSON.stringify(viewed));
      assert.deepEqual(viewed.result!.item.lines.map((l) => l.text), why);

      // Another agent that may read the task but not who works on it is told nothing of it.
      await s.principals.enroll(owner, { commandId: "e-bob", kind: "agent", name: "bob", grants: [{ action: "task.read", project }] });
      const bob = (await s.principals.issueCredential(owner, "agent:bob")).token;
      const hidden = await c.api.handle(bob, { v: 1, op: "status.ask", args: { request: { kind: "attempt_endings", taskId } } } as never);
      assert.ok(!JSON.stringify(hidden).includes("Now I will run"), JSON.stringify(hidden));
      assert.equal((hidden as { ok: boolean }).ok, false);
    } finally { await c.close(); await db.close(); }
  });
}
