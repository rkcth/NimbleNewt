import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BudgetService } from "../budgets/index.js";
import { acceptedArgs, CHAT_OPS, ScriptedInterpreter } from "../chat/index.js";
import { OPERATION_BY_NAME } from "./operations.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
type Reply = { ok: boolean; result?: any; error?: { code: string; message?: string } };

const NEW_OPS: Record<string, "apply" | "propose" | "profile"> = {
  "budget.decide": "propose", "budget.open": "propose", "budget.raise": "propose", "budget.close": "propose", "budget.aggregate.set": "propose",
  "project.branches.set": "propose", "project.branches.change": "propose", "events.configure-idle": "apply",
  "routing.disable": "profile", "routing.reenable": "propose", "routing.failback.set": "propose",
  "difficulty.set-profiles": "propose", "difficulty.set": "profile",
};

test("every operation that had no chat command now has one, with the mode its authority needs, and the interpreter's accepted arguments come from the operation's own table without the command ID (chat gaps)", () => {
  for (const [op, mode] of Object.entries(NEW_OPS)) {
    assert.equal(CHAT_OPS[op]?.mode, mode, op);
    assert.ok(OPERATION_BY_NAME.get(op) !== undefined, `${op} is an operation`);
    const args = acceptedArgs(op);
    assert.ok(args !== undefined && args.length > 0, op);
    assert.equal(args!.includes("commandId"), false, `${op}: the model never picks the command ID`);
  }
  assert.ok(acceptedArgs("budget.aggregate.set")!.includes("amountMicros"));
  assert.ok(acceptedArgs("project.branches.change")!.includes("add"));
  assert.ok(acceptedArgs("routing.disable")!.includes("level") && acceptedArgs("routing.disable")!.includes("name"));
  // Everything that spends more, widens or lifts a limit is shown first; nothing here is "apply" except an idle time.
  for (const [op, mode] of Object.entries(NEW_OPS)) if (mode === "apply") assert.equal(op, "events.configure-idle");
});

const table = {
  providers: { cloudp: { enabled: true, paid: true, location: "cloud" }, localp: { enabled: true, paid: false, location: "local" }, freecloud: { enabled: true, paid: false, location: "cloud" } },
  routes: {
    "localp/small": { contextTokens: 128_000, capabilities: ["tools", "reasoning"] }, "cloudp/big": { contextTokens: 200_000, capabilities: ["tools", "reasoning"] },
    "freecloud/lite": { contextTokens: 64_000, capabilities: ["tools"] },
  },
  profiles: { "r-local": ["localp/small"], "r-cloud": ["cloudp/big", "freecloud/lite"], "r-lite": ["freecloud/lite"] },
  roles: { coordinator: "r-cloud", "safety-supervisor": "r-cloud" },
};

test("the API ops for budgets, the optional aggregate cap and the merging branch change work for the owner only; chat proposes them, shows them first and applies them only when accepted (chat gaps)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-chatgaps-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) } } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const mk = async (n: string, title: string) => (await c.services.projects.createTask({ commandId: `t-${n}`, actor: rob.id, projectId: project, title })).id;
    const root = await mk("root", "Plant the garden"); const other = await mk("other", "Water the bed");
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "budget.manage", project }, { action: "attempt.work", project }] });
    const ann = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string): Promise<Reply> => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as never;
    const O = boot.token;

    // ---- API: budgets open, raise, close are the owner's.
    for (const [op, args] of [["budget.open", { taskId: root, currency: "USD", costMicros: 1000 }], ["budget.raise", { taskId: root, costMicros: 1 }], ["budget.close", { taskId: root }], ["budget.aggregate.set", { enabled: false }]] as const) assert.equal((await call(ann, op, args as never, `n-${op}`)).error?.code, "forbidden", op);
    assert.equal((await call(ann, "budget.aggregate.get", {})).error?.code, "forbidden");
    assert.equal((await call(O, "budget.open", { taskId: root, currency: "usd", costMicros: 1000 }, "o0")).error?.code, "invalid_command", "currency is checked");
    const opened = await call(O, "budget.open", { taskId: root, currency: "USD", costMicros: 1000, computeMs: 5 }, "o1");
    assert.ok(opened.ok, JSON.stringify(opened));
    assert.equal((await call(O, "budget.open", { taskId: root, currency: "USD", costMicros: 1000 }, "o2")).error?.code, "invalid_command", "a second budget on the same task is refused");
    assert.equal((await call(O, "budget.open", { taskId: root, currency: "USD", costMicros: 1000, computeMs: 5 }, "o1")).result.replayed, true);
    assert.ok((await call(O, "budget.raise", { taskId: root, costMicros: 500 }, "r1")).ok);
    assert.equal((await call(O, "budget.report", { taskId: root })).result.item.limit.costMicros, 1500);
    assert.equal((await call(O, "budget.raise", { taskId: other, costMicros: 5 }, "r2")).error?.code, "not_found", "no budget on that task");
    assert.equal((await call(O, "budget.raise", { taskId: root }, "r3")).error?.code, "invalid_command");

    // ---- API: the aggregate cap is unset by default, is owner-set, and turns off again.
    assert.deepEqual((await call(O, "budget.aggregate.get", {})).result.item, { revision: 0, enabled: false, state: "off" });
    const budgets = BudgetService.withEpoch(c.storage, c.epoch);
    const host = await (async () => { await c.services.principals.enroll(rob, { commandId: "e-h", kind: "host", name: "h1", grants: [] }); return c.services.principals.authenticate((await c.services.principals.issueCredential(rob, "host:h1")).token); })();
    const res = (cost: number, id: string) => budgets.reserve(host, { commandId: id, taskId: root, costMicros: cost, agentId: "agent:ann", purpose: "call" });
    await res(100, "x0");
    assert.equal((await call(O, "budget.aggregate.set", { enabled: true }, "g0")).error?.code, "invalid_command", "needs scope, period and amount");
    assert.ok((await call(O, "budget.aggregate.set", { enabled: true, scope: "installation", period: "none", amountMicros: 150 }, "g1")).ok);
    await assert.rejects(res(60, "x1"), /aggregate cap is reached/);
    assert.ok((await call(O, "budget.aggregate.set", { enabled: false }, "g2")).ok);
    await res(60, "x2");

    // ---- API: branches change merges (it never replaces the list).
    assert.deepEqual((await call(O, "project.branches.get", { project })).result.item.protected, ["main", "master"]);
    assert.equal((await call(ann, "project.branches.change", { project, add: ["dev"] }, "bb0")).error?.code, "forbidden");
    assert.ok((await call(O, "project.branches.change", { project, add: ["release/*"], remove: ["master"] }, "bb1")).ok);
    assert.deepEqual((await call(O, "project.branches.get", { project })).result.item.protected, ["main", "release/*"]);
    assert.ok((await call(O, "project.branches.change", { project, landing: "integration" }, "bb2")).ok);
    const kept = (await call(O, "project.branches.get", { project })).result.item;
    assert.deepEqual([kept.protected, kept.landing], [["main", "release/*"], "integration"], "the list is kept when only the landing branch changes");
    for (const bad of [{}, { add: ["a b"] }, { add: ["x"], remove: ["x"] }, { add: "x" }, { add: ["x"], extra: 1 }]) assert.equal((await call(O, "project.branches.change", { project, ...bad }, `bb-${JSON.stringify(bad)}`)).error?.code, "invalid_command", JSON.stringify(bad));
    assert.equal((await call(O, "project.branches.change", { project, add: ["y"], expectedRevision: 0 }, "bb3")).error?.code, "stale_revision");
    assert.equal((await call(O, "project.branches.change", { project, add: ["z"] }, "bb1")).error?.code, "command_conflict", "the same command ID with other content is refused");

    // ---- Chat.
    await c.chat!.setFocus(O, { commandId: "f1", projectId: project });
    let m = 0;
    const turn = async (text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(O, { messageId: `m${m++}`, text })).outcomes; };
    const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });
    const accept = async (proposed: any) => { const out = await turn("yes, go ahead and do that", [{ kind: "apply_proposal", proposalId: proposed.proposalId, evidence: "yes, go ahead and do that", basis: "owner" }]); assert.equal(out[0]!.status, "applied", JSON.stringify(out)); return out; };

    // Money: shown first, nothing happens until accepted.
    let text = "Add 700 millionths to the budget of Plant the garden.";
    let out = await turn(text, [cmd("budget.raise", { taskTitle: "Plant the garden", costMicros: 700 }, text)]);
    assert.equal(out[0]!.status, "proposed", JSON.stringify(out));
    assert.match(JSON.stringify(out), /costMicros=700/);
    assert.equal((await call(O, "budget.report", { taskId: root })).result.item.limit.costMicros, 1500, "nothing changed yet");
    await accept(out[0]);
    assert.equal((await call(O, "budget.report", { taskId: root })).result.item.limit.costMicros, 2200);

    text = "Open a budget of 900 millionths USD for Water the bed.";
    out = await turn(text, [cmd("budget.open", { taskTitle: "Water the bed", currency: "USD", costMicros: 900 }, text)]);
    assert.equal(out[0]!.status, "proposed", JSON.stringify(out));
    await accept(out[0]);
    assert.equal((await call(O, "budget.report", { taskId: other })).result.item.limit.costMicros, 900);

    text = "Close the budget of Water the bed.";
    out = await turn(text, [cmd("budget.close", { taskTitle: "Water the bed" }, text)]);
    assert.equal(out[0]!.status, "proposed");
    await accept(out[0]);
    assert.equal((await call(O, "budget.raise", { taskId: other, costMicros: 1 }, "r9")).error?.code, "invalid_command", "closed");

    text = "Cap all spending at installation level, per day, at 5000 millionths.";
    out = await turn(text, [cmd("budget.aggregate.set", { enabled: true, scope: "installation", period: "day", amountMicros: 5000 }, text)]);
    assert.equal(out[0]!.status, "proposed", JSON.stringify(out));
    assert.equal((await call(O, "budget.aggregate.get", {})).result.item.enabled, false, "still off until accepted");
    await accept(out[0]);
    assert.deepEqual(((await call(O, "budget.aggregate.get", {})).result.item), { revision: 3, enabled: true, state: "on", scope: "installation", period: "day", amountMicros: 5000, currency: "USD" });
    text = "Turn the overall spending cap off.";
    out = await turn(text, [cmd("budget.aggregate.set", { enabled: false }, text)]);
    assert.equal(out[0]!.status, "proposed", "lifting a cap is shown first as well");
    await accept(out[0]);
    assert.equal((await call(O, "budget.aggregate.get", {})).result.item.enabled, false);

    // Branches: the project is named by `project`, comes from the focus, and the preview shows what is added.
    text = "Also protect the branch release/hotfix.";
    out = await turn(text, [cmd("project.branches.change", { add: ["release/hotfix"] }, text)]);
    assert.equal(out[0]!.status, "proposed", JSON.stringify(out));
    assert.deepEqual((await call(O, "project.branches.get", { project })).result.item.protected, ["main", "release/*"]);
    await accept(out[0]);
    assert.deepEqual((await call(O, "project.branches.get", { project })).result.item.protected, ["main", "release/*", "release/hotfix"]);
    // A branch name the owner did not say is not accepted from the model.
    text = "Protect the production branch please.";
    out = await turn(text, [cmd("project.branches.change", { add: ["staging"] }, text)]);
    assert.notEqual(out[0]!.status, "applied");
    assert.deepEqual((await call(O, "project.branches.get", { project })).result.item.protected, ["main", "release/*", "release/hotfix"]);

    // The idle time of event subscriptions is a plain setting.
    text = "Let event subscriptions sit idle for 600 seconds.";
    out = await turn(text, [cmd("events.configure-idle", { idleSeconds: 600 }, text)]);
    assert.equal(out[0]!.status, "applied", JSON.stringify(out));

    // Routing: bringing a route back is shown first.
    text = "Let the route localp/small be used again because the outage is over.";
    out = await turn(text, [cmd("routing.reenable", { level: "model", name: "localp/small", reason: "the outage is over" }, text)]);
    assert.equal(out[0]!.status, "proposed", JSON.stringify(out));
    text = "Set failback to automatic.";
    out = await turn(text, [cmd("routing.failback.set", { policy: { mode: "automatic", minProbes: 3, stableSeconds: 60, holdDownSeconds: 600 } }, text)]);
    assert.equal(out[0]!.status, "proposed", JSON.stringify(out));

    // Difficulty profiles: the revision is read for the owner, so a first-time set needs no number.
    await c.services.routing.setTable(rob, { commandId: "tbl", expectedRevision: 0, table } as never);
    text = "Replace difficulty profiles: lite uses r-lite, and medium maps to lite.";
    out = await turn(text, [cmd("difficulty.set-profiles", { profiles: { profiles: { lite: { routingProfile: "r-lite" } }, mapping: { medium: "lite" } } }, text)]);
    assert.equal(out[0]!.status, "proposed", JSON.stringify(out));
    await accept(out[0]);
    assert.equal((await call(O, "difficulty.profiles", {})).result.item.revision, 1);
    text = "Set the difficulty of Plant the garden to medium.";
    out = await turn(text, [cmd("difficulty.set", { taskTitle: "Plant the garden", difficulty: "medium" }, text)]);
    if (out[0]!.status === "proposed") await accept(out[0]); else assert.equal(out[0]!.status, "applied", JSON.stringify(out));

    // Moving a task up to a profile that may spend more is shown first, in any approval profile; moving it to one that spends no more is not held for that reason.
    text = "Replace difficulty profiles: lite uses r-lite with a spend limit of 0, pricey uses r-cloud with a spend limit of 5000, and medium maps to lite and hard maps to pricey.";
    out = await turn(text, [cmd("difficulty.set-profiles", { profiles: { profiles: { lite: { routingProfile: "r-lite", spendLimitMicros: 0 }, pricey: { routingProfile: "r-cloud", spendLimitMicros: 5000 } }, mapping: { medium: "lite", hard: "pricey" } } }, text)]);
    assert.equal(out[0]!.status, "proposed", JSON.stringify(out));
    await accept(out[0]);
    text = "Set the difficulty of Water the bed to hard.";
    out = await turn(text, [cmd("difficulty.set", { taskTitle: "Water the bed", difficulty: "hard" }, text)]);
    assert.equal(out[0]!.status, "proposed", JSON.stringify(out));
    assert.match(JSON.stringify(out[0]), /may spend more/);
    text = "Set the difficulty of Water the bed to medium.";
    out = await turn(text, [cmd("difficulty.set", { taskTitle: "Water the bed", difficulty: "medium" }, text)]);
    assert.doesNotMatch(JSON.stringify(out[0]), /may spend more/);
    // A profile with NO spend limit allows paid routes with no limit: moving to it from a limited one is shown first too.
    text = "Replace difficulty profiles: lite uses r-lite, open uses r-cloud with no spend limit, and medium maps to lite and hard maps to open.";
    out = await turn(text, [cmd("difficulty.set-profiles", { profiles: { profiles: { lite: { routingProfile: "r-lite", spendLimitMicros: 0 }, open: { routingProfile: "r-cloud" } }, mapping: { medium: "lite", hard: "open" } } }, text)]);
    assert.equal(out[0]!.status, "proposed", JSON.stringify(out));
    await accept(out[0]);
    text = "Set the difficulty of Water the bed to hard.";
    out = await turn(text, [cmd("difficulty.set", { taskTitle: "Water the bed", difficulty: "hard" }, text)]);
    assert.equal(out[0]!.status, "proposed", JSON.stringify(out));
    assert.match(JSON.stringify(out[0]), /may spend more/, "a missing spend limit is the highest, not zero");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
