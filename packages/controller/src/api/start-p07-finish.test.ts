import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import { EffectService, SIMULATED_EFFECT_LABEL } from "../domain/effects.js";
import { derivedId } from "../domain/ids.js";
import { stopServer } from "../domain/testing/backends.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { scopedCommandId } from "../security/credentials.js";
import { SimulatedServices } from "../service-ops/index.js";
import { SimulationService } from "../simulation/index.js";
import { startTestServer, type TestServer } from "../storage/postgres/testing/server.js";
import type { ControllerStorage } from "../storage/types.js";
import { startController, type Controller } from "./start.js";

after(stopServer);

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const LAYOUT = {
  billing: { db: { state: { size: 10 } }, api: { state: { mode: "on" } }, cache: { state: { ttl: 1 } } },
  shop: { cart: { state: { replicas: 1 } } },
};
type Storage = "sqlite" | { pg: TestServer };

// Card P07 (the rest): a workflow runs end to end in a simulation scope through the RUNNING controller, from free words in chat: stand-in agents, the R02 fallback over stand-in providers after an
// injected outage, a competing edit; every effect in the ledger is the scope's, nothing reaches the real service target, the outbox, the routing state or a model. The owner reads it in a status view,
// grants real access as a separate step (shown first), replay reruns land in the task's own scope every time, and a crash part-way is finished by the start-up reconciler after a restart.
async function story(storage: Storage): Promise<void> {
  const d = mkdtempSync(join(tmpdir(), "nn-p07f-"));
  const choice = storage === "sqlite" ? { kind: "sqlite" as const, path: join(d, "c.sqlite") } : { kind: "postgres" as const, url: storage.pg.url(), schema: `p7_${process.pid}_${Math.random().toString(36).slice(2, 8)}` };
  const say: { [text: string]: unknown[] } = {};
  let interpreted = 0;
  const interpreter = new ScriptedInterpreter((input) => { interpreted++; return say[input.text] ?? []; });
  const real = new SimulatedServices(LAYOUT);
  const start = (): Promise<Controller> => startController({ storage: choice, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], artifacts: { directory: join(d, "blobs") }, serviceTarget: real, chat: { interpreter },
    dispatch: { timer: new ManualTimer(), intervalMs: 1000, route: async () => ({ route: "cloud/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: true } }) } } as never);
  let c = await start();
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const task = (await s.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Resize the billing database" })).id;
    const annId = `agent:${(await s.agents.create(rob, { commandId: "mk-ann", friendlyName: "Ann", roles: ["author"] })).id}`;
    await s.grants.grant(rob, { commandId: "g-ann", grantee: annId, action: "task.read", project, source: "direct", basis: "test" } as never);
    const ann = (await s.principals.issueCredential(rob, annId)).token;
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const chat = async (messageId: string, text: string) => (await c.chat!.submit(boot.token, { messageId, text })) as any;
    const readTable = async (table: "deliveries" | "state"): Promise<Record<string, unknown>[]> => { const snap = await c.storage.snapshot(); try { return await snap.read(table, { limit: 500 }); } finally { await snap.close(); } };
    const outbox = async () => JSON.stringify({ rows: await readTable("deliveries"), seq: (await readTable("state"))[0]!["delivery_seq"] });
    const effectsOf = async () => c.storage.listAggregates("effect", { limit: 500 });
    const grantCount = async () => (await c.storage.listAggregates("grant-record", { limit: 500 })).length;
    const outbox0 = await outbox();
    const effects0 = (await effectsOf()).length;
    const grants0 = await grantCount();

    const opened = await call(boot.token, "simulation.open", { taskId: task, layout: LAYOUT, purpose: "try the resize first" }, "o1");
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const scopeId = opened.result.id as string;

    // ---- A workflow run from free words: applied at once (nothing real changes) ----
    const words = "in that simulation let ann set the billing db size to 20, then with the main provider down let bob restart the cart, and while ann sets the api owner to ann another writer puts the api into maintenance";
    const steps = [
      { agent: "ann", service: "billing", resource: "db", fields: { size: 20 } },
      { event: "provider-failure" },
      { agent: "bob", service: "shop", resource: "cart", action: { type: "restart" } },
      { event: "competing-edit", service: "billing", resource: "api", fields: { mode: "maintenance" } },
      { agent: "ann", service: "billing", resource: "api", fields: { owner: "ann" } },
    ];
    say[words] = [{ kind: "command", op: "simulation.run", args: { scopeId, steps }, evidence: words, basis: "owner" }];
    const ran = await chat("m1", words);
    const runOutcome = (ran.outcomes as readonly { status: string; op?: string; id?: string }[]).find((o) => o.status === "applied" && o.op === "simulation.run");
    assert.ok(runOutcome?.id !== undefined, JSON.stringify(ran));
    const runId = runOutcome.id as string;
    const run = (await call(boot.token, "simulation.run.get", { runId })).result.run;
    assert.equal(run.outcome, "completed", JSON.stringify(run.results));
    assert.deepEqual(run.results.map((r: any) => r.outcome), ["done", "armed", "done", "armed", "retried"]);
    assert.deepEqual(run.results[2].attempts.map((a: any) => [a.route, a.outcome]), [["sim-primary/model", "failed"], ["sim-backup/model", "answered"]], "the R02 fallback moved to the backup route");
    assert.deepEqual((await call(boot.token, "simulation.observe", { scopeId, service: "billing", resource: "api" })).result.state, { mode: "maintenance", owner: "ann" });
    // A field value the owner did not say is refused, nothing run.
    const invented = "in that simulation let ann label the cart";
    say[invented] = [{ kind: "command", op: "simulation.run", args: { scopeId, steps: [{ agent: "ann", service: "shop", resource: "cart", fields: { note: "made up by the model" } }] }, evidence: invented, basis: "owner" }];
    assert.ok(((await chat("m1b", invented)).outcomes as readonly { code?: string }[]).some((o) => o.code === "unsupported_value"));

    // ---- The ledger: every new effect is the scope's and labelled; nothing reached the real target, the outbox, the routing state or a model ----
    const fresh = (await effectsOf()).slice(effects0);
    assert.ok(fresh.length >= 7, `${fresh.length} effects`);
    for (const e of fresh) assert.equal((e.body as { simulation?: string }).simulation, scopeId, e.id);
    for (const id of run.effects as string[]) { const rec = (await c.storage.getEffect(id))!; if (rec.status !== "intended") assert.equal(rec.evidence?.["label"], SIMULATED_EFFECT_LABEL, id); }
    assert.deepEqual(real.calls, [], "the connected service target was never reached");
    assert.equal(await outbox(), outbox0, "no delivery was queued");
    assert.equal((await c.storage.listAggregates("model-call", { limit: 10 })).length, 0, "the real routing state holds no call");
    assert.equal((await c.storage.listAggregates(`msp-${task}`, { limit: 10 })).length, 0, "nothing was spent on the task");
    assert.equal(await grantCount(), grants0, "the scope granted nothing");

    // ---- The owner reads it in plain words (status view, from chat) ----
    const why = "what is that simulation doing?";
    say[why] = [{ kind: "status", request: { kind: "simulations", taskId: task }, evidence: why, basis: "owner" }];
    const view = JSON.stringify(await chat("m2", why));
    assert.match(view, /nothing real is written, sent or spent/);
    assert.match(view, /fallback sim-backup\/model answered/);
    assert.match(view, /another writer changed billing\/api after ann read it/);
    assert.match(view, /No real access was granted after this scope/);
    // The task named by its title in the owner's words, as the prompt offers (taskId|taskTitle).
    const byTitle = "what are the simulations of resize the billing database doing?";
    say[byTitle] = [{ kind: "status", request: { kind: "simulations", taskTitle: "resize the billing database" }, evidence: byTitle, basis: "owner" }];
    await c.chat!.setFocus(boot.token, { commandId: "f1", projectId: project });
    const titled = JSON.stringify(await chat("m2b", byTitle));
    assert.match(titled, /for task Resize the billing database/);
    assert.match(titled, /fallback sim-backup\/model answered/);
    assert.equal((await call(ann, "simulation.list", {})).ok, false, "an agent reads no scope");

    // ---- Real access is the owner's separate step: shown first, granted only on yes, through the grant service ----
    const give = "give Ann the real access that simulation showed she needs";
    say[give] = [{ kind: "command", op: "simulation.grant", args: { scopeId, agentName: "Ann" }, evidence: give, basis: "owner" }];
    const proposed = (await chat("m3", give)).outcomes as readonly { status: string; proposalId?: string }[];
    assert.equal(proposed[0]!.status, "proposed", JSON.stringify(proposed));
    assert.equal(await grantCount(), grants0, "nothing is granted until the owner agrees");
    assert.equal((await s.grants.explain((await s.principals.authenticate(ann)) as never, "effect.perform", project, new Date().toISOString(), { kind: "service", id: "billing/db" })).allowed, false);
    say["yes, go ahead"] = [{ kind: "apply_proposal", proposalId: proposed[0]!.proposalId, evidence: "yes, go ahead", basis: "owner" }];
    const applied = (await chat("m4", "yes, go ahead")).outcomes as readonly { status: string }[];
    assert.equal(applied[0]!.status, "applied", JSON.stringify(applied));
    assert.equal(await grantCount(), grants0 + 3, "one narrow grant for each resource the run changed");
    const made = (await c.storage.listAggregates("grant-record", { limit: 500 })).map((g) => g.body as Record<string, unknown>).filter((g) => g["grantee"] === annId && g["action"] === "effect.perform");
    assert.equal(made.length, 3);
    assert.ok(made.every((g) => g["basis"] === `owner chat: ${give}` && g["decidedBy"] === rob.id), JSON.stringify(made));
    const annNow = (await s.principals.authenticate(ann)) as never;
    for (const id of ["billing/db", "billing/api", "shop/cart"]) assert.equal((await s.grants.explain(annNow, "effect.perform", project, new Date().toISOString(), { kind: "service", id })).allowed, true, id);
    assert.equal((await s.grants.explain(annNow, "effect.perform", project, new Date().toISOString(), { kind: "service", id: "billing/cache" })).allowed, false, "only what the run changed");
    assert.match(JSON.stringify(await chat("m5", why)), /Real access you granted after run/);
    assert.equal((await call(ann, "simulation.grant", { scopeId, grantee: annId, basis: "self" }, "sg-ann")).error.code, "forbidden");

    // ---- Replay reruns use the same isolated scope ----
    const r1 = await call(boot.token, "activity.replay.simulate", { taskId: task }, "rp1");
    const r2 = await call(boot.token, "activity.replay.simulate", { taskId: task }, "rp2");
    assert.equal(r1.ok, true, JSON.stringify(r1));
    const replayScope = r1.result.simulation.scope.scopeId as string;
    assert.match(replayScope, /^sms-/);
    assert.equal(r2.result.simulation.scope.scopeId, replayScope, "the same scope every time");
    const rerunWords = "rerun the resize replay as a simulation";
    say[rerunWords] = [{ kind: "command", op: "activity.replay.simulate", args: { taskId: task }, evidence: rerunWords, basis: "owner" }];
    assert.ok(((await chat("m6", rerunWords)).outcomes as readonly { status: string }[]).some((o) => o.status === "applied"));
    const rs = (await call(boot.token, "simulation.get", { scopeId: replayScope })).result.scope;
    assert.equal(rs.taskId, task);
    assert.equal(rs.replays.length, 3);
    assert.deepEqual(rs.isolation, { world: "stand-in", realServices: false, tools: false, providers: false, messages: false, grants: false });
    const named = await call(boot.token, "activity.replay.simulate", { taskId: task, scopeId }, "rp3");
    assert.equal(named.result.simulation.scope.scopeId, scopeId, "a scope the owner names");
    assert.equal((await call(boot.token, "activity.replay.simulate", { taskId: task }, "rp1")).result.id, r1.result.id, "a repeat answers the same rerun");
    assert.equal((await call(boot.token, "simulation.get", { scopeId: replayScope })).result.scope.replays.length, 3);

    // ---- A crash part-way: the stand-in holds the change, the ledger does not; the start-up reconciler finishes it after a restart, the repeated command the rest ----
    const epoch = await c.storage.currentEpoch();
    const crashId = "crash-run";
    const crashRun = derivedId("smr", scopedCommandId(rob.id, crashId));
    const toolId = derivedId("eff", `simrun:${crashRun}:s0:tool`);
    const dying = new Proxy(c.storage, {
      get(target, name, receiver) {
        const value = Reflect.get(target, name, receiver) as unknown;
        if (typeof value !== "function") return value;
        if (name === "applyOperation") return async (input: Parameters<ControllerStorage["applyOperation"]>[0]) => { if (input.settleEffects.some((x) => x.effectId === toolId)) throw Object.assign(new Error("died"), { kind: "unavailable", name: "StorageError" }); return target.applyOperation(input); };
        return value.bind(target);
      },
    });
    const doomed = SimulationService.withEpoch(c.storage, epoch, { effects: EffectService.withEpoch(dying, epoch, undefined, { holder: "dies" }) });
    const crashSteps = [{ agent: "cy", service: "billing", resource: "cache", action: { type: "restart" } }, { agent: "cy", service: "shop", resource: "cart", fields: { replicas: 5 } }];
    await assert.rejects(doomed.run(rob, { commandId: crashId, scopeId, steps: crashSteps }));
    assert.equal((await c.storage.getEffect(toolId))!.status, "intended");
    await c.close();
    c = await start();
    await c.dispatch!.dispatcher.tick();
    const settled = (await c.storage.getEffect(toolId))!;
    assert.equal(settled.status, "confirmed", "the start-up reconciler finished it on the scope's stand-in");
    assert.equal(settled.evidence?.["simulated"], true);
    const resumed = await call(boot.token, "simulation.run", { scopeId, steps: crashSteps }, crashId);
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    assert.equal(resumed.result.id, crashRun);
    assert.deepEqual(resumed.result.run.results.map((r: any) => r.outcome), ["done", "done"]);
    assert.equal((await call(boot.token, "simulation.observe", { scopeId, service: "billing", resource: "cache" })).result.state.restarts, 1, "done once");
    assert.equal((await call(boot.token, "simulation.observe", { scopeId, service: "shop", resource: "cart" })).result.state.replicas, 5);
    assert.deepEqual(real.calls, [], "still nothing real");
    assert.equal(await outbox(), outbox0);
    // Kept over the restart: the scope's runs and grants.
    const listed = (await call(boot.token, "simulation.list", { taskId: task })).result.scopes.find((x: any) => x.id === scopeId);
    assert.deepEqual(listed.runs.map((r: any) => r.id), [runId, crashRun]);
    assert.equal(listed.scope.grants.length, 3);
    assert.ok(interpreted > 0);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

test("a workflow run in a simulation scope through the composed controller (SQLite): chat, R02 fallback, competing edit, ledger, status, separate grant, replay scope, crash and restart (card P07)", async () => { await story("sqlite"); });

test("the same on PostgreSQL (card P07)", async () => {
  const pg = await startTestServer();
  try { await story({ pg }); } finally { await pg.stop(); }
});
