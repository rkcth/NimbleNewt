import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ReviewService } from "../review/index.js";
import { GrantService, PrincipalService, type Grant, type Principal } from "../security/index.js";
import { ContractService } from "../planning/index.js";
import { PolicyService } from "./index.js";

after(stopServer);

let now = Date.parse("2026-10-21T12:00:00.000Z");
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};

for (const backend of backends) {
  interface Ctx { policy: PolicyService; grants: GrantService; review: ReviewService; contracts: ContractService; owner: Principal; ann: Principal; reader: Principal; a: string; b: string; task: string; lead: Principal; agent(name: string, g?: Grant[]): Promise<Principal> }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      now = Date.parse("2026-10-21T12:00:00.000Z");
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const grants = GrantService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const agent = async (nm: string, g: Grant[] = []) => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: g }); return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token); };
        const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const b = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
        const task = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: a, title: "the task" })).id;
        const lead = await agent("lead", [{ action: "task.read", project: a }, { action: "task.contract.write", project: a }]);
        await body({ policy: PolicyService.withEpoch(world.storage, projects.epoch, grants, options), grants, review: ReviewService.withEpoch(world.storage, projects.epoch, options), contracts: ContractService.withEpoch(world.storage, projects.epoch, options), owner, ann: await agent("ann", [{ action: "task.read", project: a }, { action: "task.contract.write", project: a }]), reader: await agent("reader", [{ action: "config.read", project: "*" }]), a, b, task, lead, agent });
      } finally { await world.close(); }
    });
  const ask = (c: Ctx, tool: string, extra: Record<string, unknown> = {}, project?: string) => c.policy.evaluate({ principalId: "agent:ann", projectId: project ?? c.a, tool, ...extra });

  suite("a new installation is strict; the owner picks a profile; changes are versioned, recorded and only the owner's", async (c) => {
    const first = (await c.policy.effective(c.owner))!;
    assert.deepEqual([first.profile, first.allCommandGate, first.revisions.installation, first.cells["deploy.free"]!.mode, first.cells["inspect.live"]!.mode, first.takesEffect], ["strict", false, 0, "owner", "allow", "next evaluation"]);
    assert.equal((await ask(c, "deploy")).mode, "owner");
    await refuses("forbidden", () => c.policy.set(c.ann, { commandId: cid("p"), scope: "installation", profile: "derived" }));
    const set = await c.policy.set(c.owner, { commandId: cid("p"), scope: "installation", profile: "derived" });
    assert.equal((await c.policy.effective(c.owner))!.profile, "derived");
    assert.equal((await ask(c, "deploy")).mode, "allow", "counts at the next request");
    await refuses("stale_revision", () => c.policy.set(c.owner, { commandId: cid("p"), scope: "installation", profile: "strict" }));
    await refuses("stale_revision", () => c.policy.set(c.owner, { commandId: cid("p"), scope: "installation", profile: "strict", expectedRevision: 9 }));
    await c.policy.set(c.owner, { commandId: cid("p"), scope: "installation", profile: "strict", expectedRevision: set.revision });
    const stored = (await c.policy.get(c.owner, "installation"))!;
    assert.deepEqual(stored.history.map((h) => [h.by, h.summary]), [["owner:rob", "profile derived"], ["owner:rob", "profile strict"]]);
    assert.equal(await c.policy.get(c.ann, "installation"), undefined);
    assert.ok(await c.policy.effective(c.reader));
    assert.equal(await c.policy.effective(c.ann), undefined);
    for (const bad of [{ profile: "loose" }, { allCommandGate: "yes" }, { environment: "mars" }, { overrides: { "deploy.moon": "allow" } }, { overrides: { "deploy.free": "sometimes" } }, { lock: ["nope"] }, { overrides: "x" }, {}]) {
      await refuses("invalid_command", () => c.policy.set(c.owner, { commandId: cid("p"), scope: "installation", expectedRevision: stored.revision, ...(bad as object) } as never));
    }
    await refuses("invalid_command", () => c.policy.set(c.owner, { commandId: cid("p"), scope: "installation", expectedRevision: stored.revision, environment: "testing" }), (e) => assert.match(e.message, /belongs to a project/));
    await refuses("invalid_command", () => c.policy.set(c.owner, { commandId: cid("p"), scope: c.a, profile: "derived" }), (e) => assert.match(e.message, /belong to the installation/));
    await refuses("not_found", () => c.policy.set(c.owner, { commandId: cid("p"), scope: "proj-aaaaaaaaaaaaaaaaaaaa", environment: "testing" }));
  });

  suite("a project's environment decides how freely its work flows; a customer-live project still asks", async (c) => {
    await c.policy.set(c.owner, { commandId: cid("p"), scope: "installation", profile: "derived" });
    await c.policy.set(c.owner, { commandId: cid("p"), scope: c.a, environment: "testing" });
    await c.policy.set(c.owner, { commandId: cid("p"), scope: c.b, environment: "customer-live" });
    assert.deepEqual([(await ask(c, "deploy")).mode, (await ask(c, "git-push")).mode, (await ask(c, "deploy", {}, c.b)).mode, (await ask(c, "git-push", {}, c.b)).mode], ["allow", "allow", "owner", "agent-review"]);
    assert.equal((await ask(c, "deploy", { environment: "staging" })).mode, "agent-review", "a request can name the environment it targets");
    assert.equal((await c.policy.effective(c.owner, c.b))!.environment, "customer-live");
  });

  suite("a project can tighten or loosen cells, but not make loose what the installation locked; the lock also holds against a looser setting stored earlier", async (c) => {
    await c.policy.set(c.owner, { commandId: cid("p"), scope: "installation", profile: "derived", overrides: { "deploy.free": "owner" }, lock: ["deploy.free", "gate"] });
    await refuses("forbidden", () => c.policy.set(c.owner, { commandId: cid("p"), scope: c.a, overrides: { "deploy.free": "allow" } }), (e) => assert.match(e.message, /locked by the installation at owner/));
    await c.policy.set(c.owner, { commandId: cid("p"), scope: c.a, overrides: { "mutate.free": "agent-review", "merge.free": "owner" } });
    assert.equal((await ask(c, "update-database")).mode, "agent-review");
    assert.equal((await ask(c, "git-merge")).mode, "owner");
    assert.equal((await ask(c, "deploy")).mode, "owner");
    const eff = (await c.policy.effective(c.owner, c.a))!;
    assert.deepEqual([eff.cells["mutate.free"]!.source, eff.cells["deploy.free"]!.locked, eff.cells["deploy.free"]!.mode, eff.cells["commit.free"]!.source, eff.cells["deploy.free"]!.source], ["project override", true, "owner", "profile", "installation override"]);
    // The all-command gate: on at the installation and locked, a project cannot turn it off.
    await c.policy.set(c.owner, { commandId: cid("p"), scope: "installation", expectedRevision: 1, allCommandGate: true });
    await refuses("forbidden", () => c.policy.set(c.owner, { commandId: cid("p"), scope: c.a, expectedRevision: 1, allCommandGate: false }), (e) => assert.match(e.message, /locked on/));
    assert.equal((await ask(c, "run-script")).via, "all-command-gate");
    // A looser setting stored before the lock existed is held to it when read.
    await c.policy.set(c.owner, { commandId: cid("p"), scope: c.b, environment: "customer-live" });
    await c.policy.set(c.owner, { commandId: cid("p"), scope: c.b, expectedRevision: 1, overrides: { "commit.live": "allow" } });
    assert.equal((await ask(c, "git-commit", {}, c.b)).mode, "allow");
    await c.policy.set(c.owner, { commandId: cid("p"), scope: "installation", expectedRevision: 2, overrides: { "commit.live": "owner" }, lock: ["commit.live"] });
    assert.equal((await ask(c, "git-commit", {}, c.b)).mode, "owner");
    assert.equal((await c.policy.effective(c.owner, c.b))!.cells["commit.live"]!.source, "locked by the installation");
    // Unlocking lets the project's own setting count again.
    await c.policy.set(c.owner, { commandId: cid("p"), scope: "installation", expectedRevision: 3, unlock: ["commit.live"], overrides: { "commit.live": null } });
    assert.equal((await ask(c, "git-commit", {}, c.b)).mode, "allow");
  });

  suite("changing the profile keeps the cells, locks and reserved tools the owner set, and a standing grant keeps working after a restart", async (c) => {
    await c.policy.set(c.owner, { commandId: cid("p"), scope: "installation", profile: "derived", overrides: { "deploy.free": "owner" }, lock: ["deploy.free"] });
    await c.review.setPolicy(c.owner, { commandId: cid("rp"), projectId: c.a, policy: { mandatoryHuman: ["git-commit"] } });
    await c.grants.grant(c.owner, { commandId: cid("g"), grantee: "agent:ann", action: "approve.tool.git-merge", project: c.a, source: "standing", basis: "ann merges for the team" });
    for (const profile of ["autonomous", "strict", "derived"] as const) {
      const rev = (await c.policy.effective(c.owner))!.revisions.installation;
      await c.policy.set(c.owner, { commandId: cid("p"), scope: "installation", expectedRevision: rev, profile });
      assert.equal((await ask(c, "deploy")).mode, "owner", `${profile}: the cell the owner set stays`);
      assert.equal((await ask(c, "git-commit")).via, "reserved", `${profile}: the reserved tool stays reserved`);
      assert.equal((await ask(c, "git-merge")).via, "grant", `${profile}: the standing grant still applies`);
      assert.equal((await c.policy.effective(c.owner))!.cells["deploy.free"]!.locked, true);
    }
  });

  suite("a preview says what a change would do, in cells and in words, and writes nothing", async (c) => {
    const before = (await c.policy.effective(c.owner))!.revisions.installation;
    const preview = await c.policy.preview(c.owner, { scope: "installation", profile: "derived" });
    assert.ok(preview.loosened.length > 5 && preview.tightened.length === 0);
    assert.ok(preview.changes.some((x) => x.cell === "deploy.free" && x.from === "owner" && x.to === "allow"));
    assert.ok(preview.notes.some((t) => t === "the profile goes from strict to derived"));
    assert.ok(preview.notes.some((t) => /deploy in free environments would run without asking instead of asking you/.test(t)), preview.notes.join(" | "));
    assert.equal((await c.policy.effective(c.owner))!.revisions.installation, before);
    assert.equal((await c.policy.effective(c.owner))!.profile, "strict");
    const gate = await c.policy.preview(c.owner, { scope: "installation", allCommandGate: true });
    assert.deepEqual([gate.changes.length, gate.notes], [0, ["every program run would ask you first"]]);
    const none = await c.policy.preview(c.owner, { scope: "installation", overrides: { "inspect.free": "allow" } });
    assert.deepEqual(none.notes, ["nothing about how actions are decided would change"]);
    await c.policy.set(c.owner, { commandId: cid("p"), scope: "installation", profile: "derived" });
    const tighter = await c.policy.preview(c.owner, { scope: c.a, overrides: { "deploy.free": "owner" } });
    assert.deepEqual(tighter.tightened.map((x) => x.cell), ["deploy.free"]);
    await refuses("forbidden", () => c.policy.preview(c.ann, { scope: "installation", profile: "derived" }));
    await refuses("invalid_command", () => c.policy.preview(c.owner, { scope: "installation", overrides: { "nope.free": "allow" } }));
  });

  suite("grants carry terms, and a grant allows only inside them; revoked, expired and other projects' grants do not count", async (c) => {
    await c.grants.grant(c.owner, { commandId: cid("g"), grantee: "agent:ann", action: "approve.tool.publish-post", project: c.a, source: "standing", basis: "the blog is ann's to post to", terms: { audiences: ["blog"], environments: ["development", "testing"] } });
    assert.equal((await ask(c, "publish-post", { audience: "blog" })).via, "grant");
    assert.equal((await ask(c, "publish-post", { audience: "blog", environment: "staging" })).mode, "owner");
    assert.equal((await ask(c, "publish-post", { audience: "newsletter" })).mode, "owner");
    assert.equal((await ask(c, "publish-post", { audience: "blog" }, c.b)).mode, "owner", "another project");
    const spend = await c.grants.grant(c.owner, { commandId: cid("g"), grantee: "agent:ann", action: "approve.class.spend", project: "*", source: "direct", basis: "up to ten", expiresAt: new Date(now + 3_600_000).toISOString(), terms: { spendLimit: 10 } });
    assert.equal((await ask(c, "pay", { estimatedSpend: 8 })).via, "grant");
    assert.equal((await ask(c, "pay", { estimatedSpend: 12 })).mode, "owner");
    now += 2 * 3_600_000;
    assert.equal((await ask(c, "pay", { estimatedSpend: 8 })).mode, "owner", "expired");
    now -= 2 * 3_600_000;
    await c.grants.revoke(c.owner, { commandId: cid("r"), grantId: spend.id, expectedRevision: spend.revision, reason: "done" });
    assert.equal((await ask(c, "pay", { estimatedSpend: 8 })).mode, "owner", "revoked");
    // Terms are checked when the grant is made.
    for (const terms of [{ spendLimit: -1 }, { environments: ["Mars!"] }, { window: { start: "9am", end: "17:00" } }, { window: { start: "09:00", end: "17:00", days: [9] } }, { surprise: 1 }, { audiences: "blog" }, { delegation: "yes" }, { branches: "main" }, { branches: ["*"] }, { branches: ["release/*"] }, { branches: ["a..b"] }]) {
      await refuses("invalid_command", () => c.grants.grant(c.owner, { commandId: cid("g"), grantee: "agent:ann", action: "tool.pay", project: c.a, source: "direct", basis: "x", terms: terms as never }));
    }
    const view = (await c.policy.effective(c.owner, c.a, "agent:ann"))!;
    assert.deepEqual(view.grants!.map((g) => [g.action, g.project]), [["approve.tool.publish-post", c.a]]);
    assert.deepEqual((view.grants![0]!.terms as { audiences: string[] }).audiences, ["blog"]);
  });

  suite("an approval waives a change to a protected branch only by naming that branch (card A07f)", async (c) => {
    await c.grants.grant(c.owner, { commandId: cid("g"), grantee: "agent:ann", action: "approve.tool.git-push", project: c.a, source: "direct", basis: "ann may push to main in this project", terms: { branches: ["main"] } });
    assert.equal((await ask(c, "git-push", { branchProtected: true, branch: "main" })).via, "grant", "the named branch");
    assert.equal((await ask(c, "git-push", { branchProtected: true, branch: "master" })).mode, "owner", "another protected branch");
    assert.equal((await ask(c, "git-push", { branchProtected: true })).mode, "owner", "a protected change that names no branch");
    assert.equal((await ask(c, "git-push", { branchProtected: true, branch: "main" }, c.b)).mode, "owner", "another project");
    const view = (await c.policy.effective(c.owner, c.a, "agent:ann"))!;
    assert.deepEqual((view.grants![0]!.terms as { branches: string[] }).branches, ["main"]);
  });

  suite("a restriction denies, a tool the review policy reserves for the owner is the owner's in every profile, and the owner decides for itself", async (c) => {
    await c.policy.set(c.owner, { commandId: cid("p"), scope: "installation", profile: "autonomous" });
    await c.grants.grant(c.owner, { commandId: cid("g"), grantee: "agent:ann", action: "approve.*", project: "*", source: "standing", basis: "everything ordinary" });
    assert.equal((await ask(c, "git-commit")).mode, "allow");
    await c.review.setPolicy(c.owner, { commandId: cid("rp"), projectId: c.a, policy: { mandatoryHuman: ["git-commit"] } });
    assert.deepEqual([(await ask(c, "git-commit")).via, (await ask(c, "git-commit")).mode], ["reserved", "owner"]);
    assert.equal((await ask(c, "git-commit", {}, c.b)).mode, "allow", "reserved per project");
    assert.deepEqual((await c.policy.effective(c.owner, c.a))!.mandatoryHuman, ["git-commit"]);
    await c.grants.restrict(c.owner, { commandId: cid("rs"), subject: "agent:ann", action: "tool.git-push", project: c.a, reason: "frozen" });
    assert.deepEqual([(await ask(c, "git-push")).mode, (await ask(c, "git-push")).via], ["deny", "restriction"]);
    assert.equal((await ask(c, "git-push", {}, c.b)).mode, "allow");
    const view = (await c.policy.effective(c.owner, c.a, "agent:ann"))!;
    assert.deepEqual(view.restrictions!.map((r) => [r.action, r.reason]), [["tool.git-push", "frozen"]]);
    const asOwner = await c.policy.evaluate({ principalId: "owner:rob", projectId: c.a, tool: "deploy", environment: "customer-live" });
    assert.equal(asOwner.mode, "allow");
    await refuses("forbidden", () => c.policy.evaluate({ principalId: "agent:nobody", projectId: c.a, tool: "deploy" }));
    await refuses("invalid_command", () => c.policy.evaluate({ principalId: "agent:ann", projectId: c.a, tool: "Bad Tool" }));
    await refuses("invalid_command", () => c.policy.evaluate({ principalId: "agent:ann", projectId: c.a, tool: "deploy", environment: "mars" as never }));
  });

  suite("an unknown action goes to review and is never allowed; a conversation's action request is only ever a request", async (c) => {
    assert.deepEqual([(await ask(c, "mystery-tool")).mode, (await ask(c, "mystery-tool")).via], ["owner", "unknown-action"]);
    await c.policy.set(c.owner, { commandId: cid("p"), scope: "installation", profile: "autonomous" });
    assert.equal((await ask(c, "mystery-tool")).mode, "agent-review");
    await c.grants.grant(c.owner, { commandId: cid("g"), grantee: "agent:ann", action: "approve.*", project: "*", source: "standing", basis: "all tools" });
    const request = await c.policy.evaluateRequest({ principalId: "agent:ann", projectId: c.a });
    assert.deepEqual([request.executed, request.mode === "allow"], [false, false]);
    await c.policy.set(c.owner, { commandId: cid("p"), scope: "installation", expectedRevision: 1, profile: "strict" });
    assert.deepEqual([(await c.policy.evaluateRequest({ principalId: "agent:ann", projectId: c.a })).mode], ["owner"]);
  });

  suite("the instruction's scope is read from the task's stored contract: who set the ceiling counts, the caller cannot say, and an agent's own words do not widen its own ceiling", async (c) => {
    await c.contracts.setContract(c.owner, { commandId: cid("c"), taskId: c.task, expectedVersion: 0, permissions: ["tool.git-commit", "tool.git-push"], budget: { maxCost: 20 } });
    assert.deepEqual([(await ask(c, "git-commit", { taskId: c.task })).via, (await ask(c, "git-push", { taskId: c.task })).via, (await ask(c, "git-merge", { taskId: c.task })).mode], ["scope", "scope", "owner"]);
    assert.equal((await ask(c, "git-commit")).mode, "owner", "with no task there is no scope");
    // A later change to another field does not change who set the ceiling.
    await c.contracts.setContract(c.owner, { commandId: cid("c"), taskId: c.task, expectedVersion: 1, expectedResult: "ship it" });
    assert.equal((await ask(c, "git-commit", { taskId: c.task })).via, "scope");
    // The ceiling is the owner's, so naming a protected-branch push in it is the owner's decision; an unnamed one is not.
    assert.equal((await ask(c, "git-push", { taskId: c.task, branchProtected: true })).via, "scope");
    assert.equal((await ask(c, "git-merge", { taskId: c.task, branchProtected: true })).mode, "owner");
    // Another project's task gives no scope here.
    assert.equal((await ask(c, "git-commit", { taskId: c.task }, c.b)).mode, "owner");
    // The estimate left is the contract's, less what was spent.
    await c.policy.set(c.owner, { commandId: cid("p"), scope: "installation", profile: "derived" });
    assert.equal((await ask(c, "pay", { taskId: c.task, estimatedSpend: 4, spentSoFar: 10 })).mode, "allow");
    assert.deepEqual([(await ask(c, "pay", { taskId: c.task, estimatedSpend: 8, spentSoFar: 15 })).mode, (await ask(c, "pay", { taskId: c.task, estimatedSpend: 1 })).mode], ["owner", "allow"]);
  });

  suite("a ceiling written by an agent counts only where an instruction from anyone counts, never as the owner's, and never when the acting agent wrote it itself", async (c) => {
    const second = (await c.policy.evaluate({ principalId: "agent:ann", projectId: c.a, tool: "git-commit" })).mode;
    assert.equal(second, "owner");
    // The lead (not the actor) writes the ceiling.
    await c.contracts.setContract(c.lead, { commandId: cid("c"), taskId: c.task, expectedVersion: 0, permissions: ["tool.git-commit", "class.install-executable", "tool.deploy"] });
    assert.equal((await ask(c, "git-commit", { taskId: c.task })).mode, "owner", "strict: an agent's say-so is not an instruction");
    await c.policy.set(c.owner, { commandId: cid("p"), scope: "installation", profile: "derived" });
    assert.deepEqual([(await ask(c, "install-package", { taskId: c.task })).via, (await ask(c, "git-commit", { taskId: c.task })).mode], ["scope", "allow"]);
    // Naming customer-live deployment by an agent is not the owner naming it.
    assert.deepEqual([(await ask(c, "deploy", { taskId: c.task, environment: "customer-live" })).mode, (await ask(c, "deploy", { taskId: c.task, environment: "customer-live" })).via], ["owner", "must-decide"]);
    // The acting agent writing its own ceiling: ignored.
    const mine = (await c.policy.evaluate({ principalId: "agent:lead", projectId: c.a, tool: "install-package", taskId: c.task })).via;
    assert.equal(mine, "profile", "the lead wrote this ceiling, so it is not the lead's instruction");
    // A reservation still wins over a ceiling.
    await c.review.setPolicy(c.owner, { commandId: cid("rp"), projectId: c.a, policy: { mandatoryHuman: ["git-commit"] } });
    assert.equal((await ask(c, "git-commit", { taskId: c.task })).via, "reserved");
  });

  suite("a capability grant never waives asking: only an approval grant does, and what stays a decision needs one that names it", async (c) => {
    await c.grants.grant(c.owner, { commandId: cid("g"), grantee: "agent:ann", action: "*", project: "*", source: "standing", basis: "everything" });
    await c.grants.grant(c.owner, { commandId: cid("g"), grantee: "agent:ann", action: "tool.*", project: "*", source: "standing", basis: "all tools" });
    for (const tool of ["git-commit", "git-push", "grant-access"]) assert.equal((await ask(c, tool)).mode, "owner", tool);
    assert.equal((await ask(c, "deploy", { environment: "customer-live" })).mode, "owner");
    await c.grants.grant(c.owner, { commandId: cid("g"), grantee: "agent:ann", action: "approve.*", project: "*", source: "standing", basis: "ordinary things" });
    assert.equal((await ask(c, "git-commit")).via, "grant");
    for (const [tool, extra] of [["grant-access", {}], ["deploy", { environment: "customer-live" }], ["git-push", { branchProtected: true }]] as const) assert.equal((await ask(c, tool, extra)).via, "must-decide", tool);
    await c.grants.grant(c.owner, { commandId: cid("g"), grantee: "agent:ann", action: "approve.tool.deploy", project: c.a, source: "direct", basis: "this deployment", terms: { environments: ["customer-live"] } });
    assert.equal((await ask(c, "deploy", { environment: "customer-live" })).via, "grant");
    assert.equal((await ask(c, "deploy", { environment: "customer-live" }, c.b)).mode, "owner", "another project");
  });
}
