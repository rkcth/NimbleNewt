import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BudgetService, PolicyService, launch, type EnvironmentFacts, type FilesystemDetector, type LauncherConfig, type LauncherSecrets } from "@nimblenewt/controller";

// Card M02h (wiring): the product's own launcher gives the meeting records a steward and a narrator over the same HTTP model client as the chat. The model is a scripted OpenAI-compatible endpoint behind an injected fetch; nothing
// leaves the machine and no real model is called. Five budget raises adopted in one meeting under the strict approval policy wait for the owner unless the owner switched the steward on in chat; the steward's allow is held to the
// owner's ceiling on raises; a failing, timing-out or nonsense reply sends the change to the owner as before; an ended meeting gets its overview from the narrator; no key or credential reaches a prompt or a log.

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const facts: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const PROVIDER_KEY = "sk-backup-secret-value-0123456789abcdef";
/** A secret-looking value an agent writes into a change's description: refused at the door, and in no prompt. */
const PLANTED = "sk-live-planted0123456789abcdefABCDEF";

type Mode = "allow" | "ask" | "http-error" | "timeout" | "nonsense" | "empty";

const memorySecrets = (seed: Record<string, string>): LauncherSecrets & { values: Map<string, string> } => { const values = new Map(Object.entries(seed)); return { values, resolve: async (n) => values.get(n), set: async (n, v) => { values.set(n, v); }, remove: async (n) => values.delete(n) }; };

function fakeModel() {
  const script: Record<string, unknown[]> = {};
  const mode = { steward: "allow" as Mode, narrator: "ok" as "ok" | "http-error" | "timeout" };
  const calls: { kind: "interpreter" | "steward" | "narrator"; url: string; system: string; user: string }[] = [];
  const reply = (content: string): Response => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
  const fetchAll: typeof globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
    const system = body.messages.find((m) => m.role === "system")!.content;
    const user = body.messages.find((m) => m.role === "user")!.content;
    const kind = system.startsWith("You are the steward") ? "steward" : system.startsWith("You write the short overview") ? "narrator" : "interpreter";
    calls.push({ kind, url: String(url), system, user });
    if (kind === "interpreter") return reply(JSON.stringify(script[/OWNER:\n<<<\n([\s\S]*?)\n>>>/.exec(user)?.[1] ?? ""] ?? [{ kind: "none", reason: "nothing asked" }]));
    const m = kind === "steward" ? mode.steward : mode.narrator;
    if (m === "http-error") return new Response("upstream failure", { status: 503 });
    if (m === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (kind === "narrator") return reply("The team agreed to five small budget raises; nothing is left open.");
    if (m === "nonsense") return reply("I think you should probably raise them, great idea!");
    if (m === "empty") return reply(" ");
    return reply(JSON.stringify({ verdict: m === "allow" ? "allow" : "ask", reason: "small raise inside the meeting's decision" }));
  };
  return { fetch: fetchAll, script, mode, calls, of: (kind: string) => calls.filter((c) => c.kind === kind) };
}

const configFor = (dir: string): LauncherConfig => ({ installation: { name: "test", dataDir: dir }, controller: { storage: { kind: "sqlite", path: join(dir, "controller.sqlite") } }, models: { providers: {
  primary: { adapter: "openai-compatible", endpoint: "http://127.0.0.1:8002/v1", enabled: true, paid: false, models: ["local-x"] },
  backup: { adapter: "openai-compatible", endpoint: "https://free.example.invalid/v1", credential: { secret: "backup-key" }, enabled: true, paid: false, models: ["free-y"] },
} } });

test("the launcher's own steward and narrator: switching the steward on in chat lets a strict policy's budget raise through up to the owner's ceiling, a bad model reply goes to the owner, an ended meeting gets an overview, no secret reaches a prompt (card M02h)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-m02h-launch-"));
  const model = fakeModel();
  const printed: string[] = [];
  const secrets = memorySecrets({ "backup-key": PROVIDER_KEY });
  const l = await launch({ config: configFor(dir), secrets, argv: [], env: {}, print: (line) => { printed.push(String(line)); }, start: { facts, filesystem: ext4 }, fetch: model.fetch });
  try {
    const c = l.controller;
    const rob = await c.services.principals.authenticate(l.ownerToken);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    await PolicyService.withEpoch(c.storage, c.epoch, c.services.grants, {}).set(rob, { commandId: "pol1", scope: "installation", profile: "strict" } as never);
    const configured = await c.services.configuration.stage(rob, { commandId: "cfg1", layer: "installation", set: { "meeting.decision.maxPolicyWidening": 50 } as never });
    await c.services.configuration.apply(rob, { commandId: "cfg2", layer: "installation", expectedRevision: configured.revision });

    /** Five budget raises adopted in one meeting of a project of its own, applied; returns what the apply did and ways to look at the outcome. */
    const needsAll = async () => ((await call(l.ownerToken, "status.ask", { request: { kind: "needs_you" } })).result.item.lines as { text: string }[]).filter((x) => /meeting decision waits for you/.test(x.text)).length;
    const meeting = async (tag: string) => {
      const needsBefore = await needsAll();
      const project = (await call(l.ownerToken, "project.create", { name: `Garden ${tag}` }, `p-${tag}`)).result.id as string;
      const tasks: { id: string; revision: number }[] = [];
      for (let i = 0; i < 5; i++) {
        const t = (await call(l.ownerToken, "task.create", { projectId: project, title: `Bed ${i}` }, `t-${tag}-${i}`)).result;
        await BudgetService.withEpoch(c.storage, c.epoch, {}).open(rob, { commandId: `bo-${tag}-${i}`, taskId: t.id, currency: "USD", costMicros: 1_000_000 });
        tasks.push(t);
      }
      const tok = async (name: string, grants: { action: string; project: string }[]) => { await c.services.principals.enroll(rob, { commandId: `e-${tag}-${name}`, kind: "agent", name: `${name}${tag}`, grants }); return (await c.services.principals.issueCredential(rob, `agent:${name}${tag}`)).token; };
      const ann = await tok("ann", [{ action: "task.read", project }, { action: "meeting.attend", project }, { action: "budget.manage", project }]);
      const bob = await tok("bob", [{ action: "task.read", project }, { action: "meeting.attend", project }]);
      const changes = tasks.map((t, i) => ({ kind: "budget.raise", agent: `agent:ann${tag}`, target: { kind: "task", id: t.id }, expectedRevision: t.revision, patch: { costMicros: 500_000 }, summary: `raise ${i}` }));
      const urgent = await call(l.ownerToken, "meeting.call-urgent", { projectId: project, title: "Money", reason: "frost", roster: [`agent:ann${tag}`, `agent:bob${tag}`] }, `mu-${tag}`);
      assert.ok(urgent.ok, JSON.stringify(urgent));
      const rec = (await call(l.ownerToken, "meeting.record.open", { occurrenceId: urgent.result.id, chair: `agent:ann${tag}` }, `mo-${tag}`)).result.id as string;
      for (const [t, id] of [[ann, "j1"], [bob, "j2"]] as const) await call(t, "meeting.record.join", { recordId: rec }, `${id}-${tag}`);
      // A key written into a change is refused at the door, so it can never be in a prompt.
      assert.equal((await call(ann, "meeting.record.move", { recordId: rec, text: "Raise all.", topic: "unrelated topic", changes: [{ ...changes[0]!, summary: `raise (the vendor key is ${PLANTED})` }] }, `mvx-${tag}`)).ok, false);
      const moved = await call(ann, "meeting.record.move", { recordId: rec, text: "Raise all.", topic: "unrelated topic", changes }, `mv-${tag}`);
      assert.ok(moved.ok, JSON.stringify(moved));
      const mid = moved.result.id as string;
      assert.ok((await call(l.ownerToken, "meeting.record.open-vote", { motionId: mid, expectedVersion: 1 }, `ov-${tag}`)).ok);
      for (const [t, id] of [[ann, "b1"], [bob, "b2"]] as const) assert.ok((await call(t, "meeting.record.cast-ballot", { motionId: mid, version: 1, value: "yes", reason: "agreed" }, `${id}-${tag}`)).ok, id);
      const closed = await call(l.ownerToken, "meeting.record.close-vote", { motionId: mid }, `cv-${tag}`);
      assert.equal(closed.result.state, "adopted", JSON.stringify(closed));
      const applied = await call(l.ownerToken, "meeting.record.apply", { decisionId: closed.result.decisionId }, `ap-${tag}`);
      assert.ok(applied.ok, JSON.stringify(applied));
      const raised = async () => { let n = 0; for (const t of tasks) if ((await call(l.ownerToken, "budget.report", { taskId: t.id })).result.item.limit.costMicros === 1_500_000) n++; return n; };
      return { project, rec, applied: applied.result as { applied: number; pending: number; waitingFor?: string }, raised, needs: async () => (await needsAll()) - needsBefore };
    };
    const logged = async (): Promise<string[]> => ((await call(l.ownerToken, "meeting.decisions.log", {})).result.item.entries as { outcome: string; decidedBy: string }[]).map((e) => `${e.outcome}:${e.decidedBy}`);

    // 1. Switch off (the default): the strict policy leaves every raise to the owner and the model is not asked.
    const off = await meeting("off");
    assert.deepEqual([off.applied.applied, off.applied.waitingFor], [0, "owner"]);
    assert.equal(model.of("steward").length, 0, "nothing is asked while the owner's switch is off");
    assert.equal(await off.needs(), 1);

    // 2. The owner switches the steward on in chat. The launcher has a steward, so the proposal carries no warning that it does nothing.
    const say = (text: string, intents: unknown[]) => { model.script[text] = intents; return l.controller.chat!.submit(l.ownerToken, { messageId: `m-${Math.random().toString(36).slice(2)}`, text }); };
    const switchOn = "let the steward agent decide small budget raises for the meetings";
    const turn = await say(switchOn, [{ kind: "policy_edit", change: { type: "setting", layer: "installation", key: "meeting.decision.steward", value: true }, evidence: switchOn, basis: "owner" }]);
    const outcome = (turn.outcomes as unknown as { status: string; proposalId?: string }[])[0]!;
    assert.equal(outcome.status, "proposed", JSON.stringify(turn.outcomes));
    assert.doesNotMatch(JSON.stringify(turn.outcomes), /no effect for now/);
    const yes = `yes, go ahead with ${outcome.proposalId}`;
    const done = await say(yes, [{ kind: "apply_proposal", proposalId: outcome.proposalId, evidence: yes, basis: "owner" }]);
    assert.deepEqual((done.outcomes as unknown as { status: string }[]).map((o) => o.status), ["applied"], JSON.stringify(done.outcomes));
    assert.equal((await c.services.configuration.installationValues(["meeting.decision.steward"]))["meeting.decision.steward"], true);

    // 3. Switched on, a ceiling on raises below each raise: the steward's allow is held to the ceiling, nothing is raised, and the log says the steward's answer did not carry out.
    assert.ok((await call(l.ownerToken, "agreed.limits.change", { set: { raiseMaxCostMicros: 100_000 } }, "lim1")).ok);
    const before = model.of("steward").length;
    const held = await meeting("low");
    assert.ok(model.of("steward").length > before, "turning the steward on caused a model call");
    assert.equal(await held.raised(), 0);
    assert.deepEqual([held.applied.applied, held.applied.pending], [0, 0], JSON.stringify(held.applied));
    assert.equal((await logged()).filter((e) => e === "not-applied:steward").length, 5);

    // 4. At the ceiling the same five raises go through, decided by the steward.
    assert.ok((await call(l.ownerToken, "agreed.limits.change", { set: { raiseMaxCostMicros: 500_000 } }, "lim2")).ok);
    const through = await meeting("ok");
    assert.equal(through.applied.applied, 5, JSON.stringify(through.applied));
    assert.equal(await through.raised(), 5);
    assert.equal((await logged()).filter((e) => e === "applied:steward").length, 5);
    assert.equal(await through.needs(), 0);

    // 5. A model that fails, times out, answers nonsense or answers nothing: the change goes to the owner exactly as with the switch off.
    for (const bad of ["http-error", "timeout", "nonsense", "empty", "ask"] as const) {
      model.mode.steward = bad;
      const m = await meeting(`bad-${bad}`);
      assert.deepEqual([m.applied.applied, m.applied.waitingFor], [0, "owner"], bad);
      assert.equal(await m.raised(), 0, bad);
      assert.equal(await m.needs(), 1, bad);
    }
    model.mode.steward = "allow";

    // 6. The narrator: an ended meeting gets an overview from the model; a failing narrator leaves the summary without one, marked.
    const fin = await call(l.ownerToken, "meeting.record.finish", { recordId: through.rec }, "fin-ok");
    assert.ok(fin.ok, JSON.stringify(fin));
    const sum = await call(l.ownerToken, "meeting.record.summarize", { recordId: through.rec }, "sum-ok");
    assert.ok(sum.ok, JSON.stringify(sum));
    assert.equal((await call(l.ownerToken, "meeting.record.summary", { recordId: through.rec })).result.item.overview, "The team agreed to five small budget raises; nothing is left open.");
    assert.equal(model.of("narrator").length, 1);
    model.mode.narrator = "timeout";
    const failing = await call(l.ownerToken, "meeting.record.finish", { recordId: off.rec }, "fin-off");
    assert.ok(failing.ok, JSON.stringify(failing));
    const sum2 = await call(l.ownerToken, "meeting.record.summarize", { recordId: off.rec }, "sum-off");
    assert.ok(sum2.ok, JSON.stringify(sum2));
    assert.match(String(sum2.result.overviewFailed), /timed out/);
    assert.equal((await call(l.ownerToken, "meeting.record.summary", { recordId: off.rec })).result.item.overview, undefined);

    // 7. Secrets: not the planted key from an agent's description, not the provider's key, not the owner's credential, in any prompt or any printed line.
    assert.ok(model.of("steward").length > 5 && model.of("narrator").length >= 2);
    const everything = [...model.calls.flatMap((x) => [x.system, x.user, x.url]), ...printed].join("\n");
    for (const secret of [PLANTED, PROVIDER_KEY, l.ownerToken]) assert.ok(!everything.includes(secret), "a secret reached a prompt or a log");
    assert.ok(model.of("steward").every((x) => x.url.startsWith("http://127.0.0.1:8002/")), "the steward uses the chat's local route");
  } finally { await l.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("the launcher with no usable model route: the steward switch set on through the configuration counts as off, so a strict policy's budget raise waits for the owner from the vote on and no model is called (card M02h review)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-m02h-noroute-"));
  const model = fakeModel();
  const config: LauncherConfig = { installation: { name: "test", dataDir: dir }, controller: { storage: { kind: "sqlite", path: join(dir, "controller.sqlite") } }, models: { providers: {} } };
  const l = await launch({ config, secrets: memorySecrets({}), argv: [], env: {}, print: () => undefined, start: { facts, filesystem: ext4 }, fetch: model.fetch });
  try {
    const c = l.controller;
    const rob = await c.services.principals.authenticate(l.ownerToken);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    await PolicyService.withEpoch(c.storage, c.epoch, c.services.grants, {}).set(rob, { commandId: "pol1", scope: "installation", profile: "strict" } as never);
    const staged = await c.services.configuration.stage(rob, { commandId: "cfg1", layer: "installation", set: { "meeting.decision.maxPolicyWidening": 50, "meeting.decision.steward": true } as never });
    await c.services.configuration.apply(rob, { commandId: "cfg2", layer: "installation", expectedRevision: staged.revision });
    const project = (await call(l.ownerToken, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const t = (await call(l.ownerToken, "task.create", { projectId: project, title: "Bed" }, "t1")).result;
    await BudgetService.withEpoch(c.storage, c.epoch, {}).open(rob, { commandId: "bo1", taskId: t.id, currency: "USD", costMicros: 1_000_000 });
    const tok = async (name: string, grants: { action: string; project: string }[]) => { await c.services.principals.enroll(rob, { commandId: `e-${name}`, kind: "agent", name, grants }); return (await c.services.principals.issueCredential(rob, `agent:${name}`)).token; };
    const ann = await tok("ann", [{ action: "task.read", project }, { action: "meeting.attend", project }, { action: "budget.manage", project }]);
    const bob = await tok("bob", [{ action: "task.read", project }, { action: "meeting.attend", project }]);
    const urgent = await call(l.ownerToken, "meeting.call-urgent", { projectId: project, title: "Money", reason: "frost", roster: ["agent:ann", "agent:bob"] }, "mu1");
    const rec = (await call(l.ownerToken, "meeting.record.open", { occurrenceId: urgent.result.id, chair: "agent:ann" }, "mo1")).result.id as string;
    for (const [tk, id] of [[ann, "j1"], [bob, "j2"]] as const) await call(tk, "meeting.record.join", { recordId: rec }, id);
    const moved = await call(ann, "meeting.record.move", { recordId: rec, text: "Raise it.", topic: "unrelated topic", changes: [{ kind: "budget.raise", agent: "agent:ann", target: { kind: "task", id: t.id }, expectedRevision: t.revision, patch: { costMicros: 500_000 }, summary: "raise" }] }, "mv1");
    assert.ok(moved.ok, JSON.stringify(moved));
    assert.ok((await call(l.ownerToken, "meeting.record.open-vote", { motionId: moved.result.id, expectedVersion: 1 }, "ov1")).ok);
    for (const [tk, id] of [[ann, "b1"], [bob, "b2"]] as const) assert.ok((await call(tk, "meeting.record.cast-ballot", { motionId: moved.result.id, version: 1, value: "yes", reason: "agreed" }, id)).ok, id);
    const closed = await call(l.ownerToken, "meeting.record.close-vote", { motionId: moved.result.id }, "cv1");
    assert.equal(closed.result.state, "adopted", JSON.stringify(closed));
    // Before anything applies the decision, it already waits for the owner (with a steward counted as able it would wait, unasked, for an apply).
    const needs = async () => ((await call(l.ownerToken, "status.ask", { request: { kind: "needs_you" } })).result.item.lines as { text: string }[]).filter((x) => /meeting decision waits for you/.test(x.text)).length;
    assert.equal(await needs(), 1, "the decision waits for the owner from the vote on");
    const applied = await call(l.ownerToken, "meeting.record.apply", { decisionId: closed.result.decisionId }, "ap1");
    assert.deepEqual([applied.result.applied, applied.result.waitingFor], [0, "owner"], JSON.stringify(applied));
    assert.equal((await call(l.ownerToken, "budget.report", { taskId: t.id })).result.item.limit.costMicros, 1_000_000);
    assert.equal(model.calls.length, 0, "no model is called without a route");
  } finally { await l.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a steward and a narrator the host passes to the launcher win over the launcher's own: the model behind the chat route is not asked for either (card M02h review)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-m02h-host-"));
  const model = fakeModel();
  const asked: string[] = [];
  const steward = async (input: { kind: string }) => { asked.push(`steward:${input.kind}`); return { verdict: "allow" as const, reason: "the host's own steward" }; };
  const narrate = async () => { asked.push("narrator"); return "The host's own overview."; };
  const l = await launch({ config: configFor(dir), secrets: memorySecrets({ "backup-key": PROVIDER_KEY }), argv: [], env: {}, print: () => undefined, start: { facts, filesystem: ext4, meetingRecords: { steward, narrate } } as never, fetch: model.fetch });
  try {
    const c = l.controller;
    const rob = await c.services.principals.authenticate(l.ownerToken);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    await PolicyService.withEpoch(c.storage, c.epoch, c.services.grants, {}).set(rob, { commandId: "pol1", scope: "installation", profile: "strict" } as never);
    const staged = await c.services.configuration.stage(rob, { commandId: "cfg1", layer: "installation", set: { "meeting.decision.maxPolicyWidening": 50, "meeting.decision.steward": true } as never });
    await c.services.configuration.apply(rob, { commandId: "cfg2", layer: "installation", expectedRevision: staged.revision });
    assert.ok((await call(l.ownerToken, "agreed.limits.change", { set: { raiseMaxCostMicros: 500_000 } }, "lim1")).ok);
    const project = (await call(l.ownerToken, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const t = (await call(l.ownerToken, "task.create", { projectId: project, title: "Bed" }, "t1")).result;
    await BudgetService.withEpoch(c.storage, c.epoch, {}).open(rob, { commandId: "bo1", taskId: t.id, currency: "USD", costMicros: 1_000_000 });
    const tok = async (name: string, grants: { action: string; project: string }[]) => { await c.services.principals.enroll(rob, { commandId: `e-${name}`, kind: "agent", name, grants }); return (await c.services.principals.issueCredential(rob, `agent:${name}`)).token; };
    const ann = await tok("ann", [{ action: "task.read", project }, { action: "meeting.attend", project }, { action: "budget.manage", project }]);
    const bob = await tok("bob", [{ action: "task.read", project }, { action: "meeting.attend", project }]);
    const urgent = await call(l.ownerToken, "meeting.call-urgent", { projectId: project, title: "Money", reason: "frost", roster: ["agent:ann", "agent:bob"] }, "mu1");
    const rec = (await call(l.ownerToken, "meeting.record.open", { occurrenceId: urgent.result.id, chair: "agent:ann" }, "mo1")).result.id as string;
    for (const [tk, id] of [[ann, "j1"], [bob, "j2"]] as const) await call(tk, "meeting.record.join", { recordId: rec }, id);
    const moved = await call(ann, "meeting.record.move", { recordId: rec, text: "Raise it.", topic: "unrelated topic", changes: [{ kind: "budget.raise", agent: "agent:ann", target: { kind: "task", id: t.id }, expectedRevision: t.revision, patch: { costMicros: 500_000 }, summary: "raise" }] }, "mv1");
    assert.ok((await call(l.ownerToken, "meeting.record.open-vote", { motionId: moved.result.id, expectedVersion: 1 }, "ov1")).ok);
    for (const [tk, id] of [[ann, "b1"], [bob, "b2"]] as const) assert.ok((await call(tk, "meeting.record.cast-ballot", { motionId: moved.result.id, version: 1, value: "yes", reason: "agreed" }, id)).ok, id);
    const closed = await call(l.ownerToken, "meeting.record.close-vote", { motionId: moved.result.id }, "cv1");
    const applied = await call(l.ownerToken, "meeting.record.apply", { decisionId: closed.result.decisionId }, "ap1");
    assert.equal(applied.result.applied, 1, JSON.stringify(applied));
    assert.ok((await call(l.ownerToken, "meeting.record.finish", { recordId: rec }, "fin1")).ok);
    assert.ok((await call(l.ownerToken, "meeting.record.summarize", { recordId: rec }, "sum1")).ok);
    assert.equal((await call(l.ownerToken, "meeting.record.summary", { recordId: rec })).result.item.overview, "The host's own overview.");
    assert.deepEqual(asked, ["steward:budget.raise", "narrator"]);
    assert.equal(model.of("steward").length + model.of("narrator").length, 0, "the launcher's own helpers were not used");
  } finally { await l.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
