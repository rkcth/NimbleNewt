import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTION_CLASSES, ActionCatalog, tierOf, type ActionClass, type Environment } from "./catalog.js";
import { CELL_KEYS, PROFILE_TABLES, evaluate, type GrantView, type PolicyRequest, type PolicyView, type Profile } from "./engine.js";

const view = (profile: Profile, extra: Partial<PolicyView> = {}): PolicyView => ({ profile, allCommandGate: false, cells: Object.fromEntries(CELL_KEYS.map((k) => [k, PROFILE_TABLES[profile][k.slice(0, k.lastIndexOf(".")) as ActionClass][k.slice(k.lastIndexOf(".") + 1) as "free" | "guarded" | "live"]])) as PolicyView["cells"], mandatoryHuman: [], ...extra });
const catalog = ActionCatalog.default;
const req = (tool: string, environment: Environment = "development", extra: Partial<PolicyRequest> = {}): PolicyRequest => ({ tool, cls: catalog.classify(tool, "repository"), environment, now: "2026-10-21T12:00:00.000Z", ...extra });
const ask = (profile: Profile, tool: string, environment: Environment = "development", extra: Partial<PolicyRequest> = {}, held: GrantView[] = [], view_: Partial<PolicyView> = {}) => evaluate(view(profile, view_), req(tool, environment, extra), held, false);

test("the catalogue puts a tool in one class, runs in the checkout as edits and elsewhere as mutations, and leaves the unknown unknown", () => {
  assert.deepEqual(["read-file", "edit-file", "git-commit", "git-push", "git-merge", "deploy", "send-email", "publish-release", "pay", "install-package", "grant-access", "update-database"].map((t) => catalog.classify(t)), ["inspect", "workspace-edit", "commit", "push", "merge", "deploy", "external-send", "publish", "spend", "install-executable", "access-change", "mutate"]);
  assert.equal(catalog.classify("run-script", "workspace"), "workspace-edit");
  assert.equal(catalog.classify("run-script", "repository"), "mutate");
  assert.equal(catalog.classify("shell"), "mutate");
  assert.equal(catalog.classify("mystery-tool"), "unknown");
  assert.equal(catalog.classify("__proto__"), "unknown");
  assert.equal(ActionCatalog.with({ "my-deploy": "deploy" }).classify("my-deploy"), "deploy");
  assert.deepEqual(ACTION_CLASSES.length, 12);
  assert.deepEqual(["development", "testing", "staging", "customer-live"].map((e) => tierOf(e as Environment)), ["free", "free", "guarded", "live"]);
});

test("strict asks the owner for every consequential class, anywhere, and an unknown action goes to the owner", () => {
  for (const env of ["development", "testing", "staging", "customer-live"] as const) {
    for (const tool of ["git-commit", "git-push", "git-merge", "deploy", "update-database", "send-email", "publish-post", "pay", "install-package", "grant-access"]) assert.equal(ask("strict", tool, env).mode, "owner", `${tool} in ${env}`);
    for (const tool of ["read-file", "list-files", "edit-file", "write-file"]) assert.equal(ask("strict", tool, env).mode, "allow", `${tool} in ${env}`);
  }
  const unknown = ask("strict", "mystery-tool");
  assert.deepEqual([unknown.mode, unknown.via], ["owner", "unknown-action"]);
});

test("derived leans toward less asking: routine work flows in development and testing, staging gets a review, customer-live and the reserved kinds ask the owner", () => {
  for (const env of ["development", "testing"] as const) for (const tool of ["read-file", "edit-file", "git-commit", "git-push", "git-merge", "deploy", "update-database"]) assert.equal(ask("derived", tool, env).mode, "allow", `${tool} in ${env}`);
  assert.deepEqual(["git-merge", "deploy", "update-database", "install-package"].map((t) => ask("derived", t, "staging").mode), ["agent-review", "agent-review", "agent-review", "agent-review"]);
  assert.deepEqual(["deploy", "update-database", "git-merge"].map((t) => ask("derived", t, "customer-live").mode), ["owner", "owner", "owner"]);
  assert.deepEqual(["grant-access", "send-email", "publish-post"].map((t) => ask("derived", t, "development").mode), ["owner", "owner", "owner"]);
  assert.equal(ask("derived", "install-package").mode, "agent-review");
  const unknown = ask("derived", "mystery-tool");
  assert.deepEqual([unknown.mode, unknown.via], ["agent-review", "unknown-action"]);
});

test("the things that stay decisions stay decisions in every profile unless the owner's instruction named that very tool", () => {
  for (const profile of ["derived", "autonomous"] as const) {
    assert.deepEqual([ask(profile, "deploy", "customer-live").mode, ask(profile, "deploy", "customer-live").via], ["owner", "must-decide"], `${profile} customer-live deploy`);
    assert.equal(ask(profile, "git-push", "development", { branchProtected: true }).mode, "owner");
    assert.equal(ask(profile, "git-merge", "development", { branchProtected: true }).mode, "owner");
    assert.equal(ask(profile, "grant-access", "development").mode, "owner");
    assert.equal(ask(profile, "update-database", "development", { irreversible: true }).mode, "owner");
    // A class-level ceiling is not naming the tool.
    const scope = { ceiling: ["class.deploy"], approvedBy: "owner:rob" };
    assert.equal(ask(profile, "deploy", "customer-live", { scope }).mode, "owner");
    // Naming it, in an owner-approved instruction, is the owner's decision.
    const named = ask(profile, "deploy", "customer-live", { scope: { ceiling: ["tool.deploy"], approvedBy: "owner:rob" } });
    assert.deepEqual([named.mode, named.via], ["allow", "scope"]);
    // The owner's instruction naming git-push covers a protected branch only for an integrator (card A07g).
    const ceilingNamed = { ceiling: ["tool.git-push"], approvedBy: "owner:rob" };
    assert.equal(ask(profile, "git-push", "development", { branchProtected: true, scope: ceilingNamed, actorRoles: ["integrator"] }).mode, "allow");
    for (const roles of [undefined, [], ["author"], ["reviewer", "qa", "docs", "director"], ["integrators"]]) {
      assert.equal(ask(profile, "git-push", "development", { branchProtected: true, scope: ceilingNamed, ...(roles === undefined ? {} : { actorRoles: roles }) }).mode, "owner", `roles ${JSON.stringify(roles)}`);
    }
    assert.equal(ask(profile, "git-push", "development", { scope: ceilingNamed, actorRoles: ["author"] }).mode, "allow", "an unprotected branch is unaffected");
    // Named by an agent's say-so it is not.
    assert.equal(ask(profile, "deploy", "customer-live", { scope: { ceiling: ["tool.deploy"], approvedBy: "agent:x" } }).mode, "owner");
  }
});

test("spending is allowed only inside the estimate; with no estimate, or beyond it, it is the owner's", () => {
  const within = ask("derived", "pay", "development", { estimatedSpend: 5, scope: { ceiling: [], approvedBy: "owner:rob", budgetRemaining: 20 } });
  assert.equal(within.mode, "allow");
  const beyond = ask("derived", "pay", "development", { estimatedSpend: 50, scope: { ceiling: [], approvedBy: "owner:rob", budgetRemaining: 20 } });
  assert.deepEqual([beyond.mode, beyond.via], ["owner", "must-decide"]);
  assert.match(beyond.reasons.join(" "), /beyond the 20 left/);
  assert.equal(ask("derived", "pay", "development", { estimatedSpend: 5 }).mode, "owner");
  assert.equal(ask("derived", "deploy", "development", { estimatedSpend: 50, scope: { ceiling: [], approvedBy: "owner:rob", budgetRemaining: 20 } }).mode, "owner", "an action that would overspend asks too");
});

test("a send or a publication goes to the owner unless a grant names its audience", () => {
  const grant: GrantView = { id: "grt-1", action: "approve.tool.publish-post", audiences: ["blog"] };
  assert.equal(ask("derived", "publish-post", "development", { audience: "blog" }, [grant]).via, "grant");
  assert.equal(ask("derived", "publish-post", "development", { audience: "newsletter" }, [grant]).mode, "owner");
  assert.match(ask("derived", "publish-post", "development", { audience: "newsletter" }, [grant]).reasons.join(" "), /does not name the audience newsletter/);
  assert.equal(ask("derived", "publish-post", "development", {}, [grant]).mode, "owner");
  assert.equal(ask("autonomous", "send-email", "development", { audience: "team" }).mode, "owner");
});

test("a grant allows only inside its terms: environment, time window and spend limit", () => {
  const dev: GrantView = { id: "grt-d", action: "approve.tool.deploy", environments: ["development"] };
  assert.equal(ask("strict", "deploy", "development", {}, [dev]).via, "grant");
  assert.equal(ask("strict", "deploy", "staging", {}, [dev]).mode, "owner");
  const window: GrantView = { id: "grt-w", action: "approve.class.deploy", window: { start: "09:00", end: "17:00", days: [3] } };
  assert.equal(ask("strict", "deploy", "development", {}, [window]).via, "grant", "2026-10-21 is a Wednesday, 12:00 UTC");
  assert.equal(ask("strict", "deploy", "development", { now: "2026-10-21T20:00:00.000Z" }, [window]).mode, "owner");
  assert.equal(ask("strict", "deploy", "development", { now: "2026-10-22T12:00:00.000Z" }, [window]).mode, "owner");
  const overnight: GrantView = { id: "grt-n", action: "approve.class.deploy", window: { start: "22:00", end: "06:00" } };
  assert.equal(ask("strict", "deploy", "development", { now: "2026-10-21T23:30:00.000Z" }, [overnight]).via, "grant");
  assert.equal(ask("strict", "deploy", "development", { now: "2026-10-21T12:00:00.000Z" }, [overnight]).mode, "owner");
  const spend: GrantView = { id: "grt-s", action: "approve.tool.pay", spendLimit: 10 };
  assert.equal(ask("strict", "pay", "development", { estimatedSpend: 8 }, [spend]).via, "grant");
  assert.equal(ask("strict", "pay", "development", { estimatedSpend: 12 }, [spend]).mode, "owner");
  assert.equal(ask("strict", "pay", "development", { estimatedSpend: 8 }, [{ id: "grt-x", action: "approve.tool.pay" }]).mode, "owner", "a spend grant has to state its limit");
  assert.equal(ask("strict", "pay", "development", { estimatedSpend: 1e9 }, [{ id: "grt-u", action: "approve.tool.pay", spendUnlimited: true }]).via, "grant", "an explicit no-limit spend grant has no ceiling");
  assert.equal(ask("strict", "git-commit", "development", {}, [{ id: "grt-p", action: "approve.tool.*" }]).via, "grant", "a prefix grant covers the tool");
  assert.equal(ask("strict", "git-commit", "development", {}, [{ id: "grt-o", action: "approve.tool.deploy" }]).mode, "owner");
});

test("only an approval grant waives asking: a grant that gives the capability to use a tool never does", () => {
  for (const action of ["*", "tool.*", "tool.git-commit", "class.commit", "git-commit"]) assert.equal(ask("strict", "git-commit", "development", {}, [{ id: "grt-cap", action }]).mode, "owner", action);
  assert.equal(ask("strict", "deploy", "customer-live", {}, [{ id: "grt-cap", action: "*" }]).mode, "owner");
  assert.equal(ask("strict", "grant-access", "development", {}, [{ id: "grt-cap", action: "tool.*" }]).mode, "owner");
  assert.equal(ask("strict", "git-commit", "development", {}, [{ id: "grt-ok", action: "approve.class.commit" }]).via, "grant");
  assert.equal(ask("strict", "git-commit", "development", {}, [{ id: "grt-ok", action: "approve.class.*" }]).via, "grant", "a wildcard approval covers ordinary actions");
  assert.equal(ask("strict", "git-commit", "development", {}, [{ id: "grt-ok", action: "approve.*" }]).via, "grant");
  assert.equal(ask("strict", "git-commit", "development", {}, [{ id: "grt-no", action: "approve.class.push" }]).mode, "owner");
  assert.equal(ask("strict", "git-commit", "development", {}, [{ id: "grt-no", action: "approve.tool.deploy" }]).mode, "owner");
});

test("what stays a decision is waived only by a grant that names the tool or class exactly, never by a wildcard, and a live deployment also needs the environment named", () => {
  const wild: GrantView[] = [{ id: "w1", action: "approve.*" }, { id: "w2", action: "approve.class.*" }, { id: "w3", action: "approve.tool.*" }];
  for (const [tool, env, extra] of [["deploy", "customer-live", {}], ["grant-access", "development", {}], ["git-push", "development", { branchProtected: true }], ["update-database", "development", { irreversible: true }], ["publish-post", "development", { audience: "newsletter" }]] as const) {
    for (const profile of ["strict", "derived", "autonomous"] as const) {
      const d = ask(profile, tool, env, extra, wild);
      assert.deepEqual([d.mode, d.via], ["owner", "must-decide"], `${profile} ${tool}`);
      assert.match(d.reasons.join(" "), /wildcard and cannot waive/);
    }
  }
  assert.equal(ask("strict", "grant-access", "development", {}, [{ id: "x", action: "approve.class.access-change" }]).via, "grant");
  // An approval waives a change to a protected branch only if it names that branch (card A07f): one that names none, or another, does not.
  const onMain = { branchProtected: true, branch: "main" };
  assert.equal(ask("strict", "git-push", "development", onMain, [{ id: "x", action: "approve.tool.git-push" }]).via, "must-decide", "an approval that names no branch cannot waive a protected one");
  assert.equal(ask("strict", "git-push", "development", onMain, [{ id: "x", action: "approve.tool.git-push", branches: ["release/1"] }]).via, "must-decide", "nor one that names another branch");
  assert.equal(ask("strict", "git-push", "development", { branchProtected: true }, [{ id: "x", action: "approve.tool.git-push", branches: ["main"] }]).via, "must-decide", "nor when the branch is not known");
  assert.equal(ask("strict", "git-push", "development", onMain, [{ id: "x", action: "approve.tool.git-push", branches: ["main"] }]).via, "grant", "one that names it does");
  assert.equal(ask("strict", "git-push", "development", onMain, [{ id: "x", action: "approve.tool.git-push", branches: ["main"], source: "standing" }]).via, "must-decide", "a standing grant still never does");
  assert.equal(ask("strict", "update-database", "development", { irreversible: true }, [{ id: "x", action: "approve.class.mutate" }]).via, "grant");
  // A live deployment: the exact grant has to name customer-live.
  const bare = ask("strict", "deploy", "customer-live", {}, [{ id: "x", action: "approve.tool.deploy" }]);
  assert.deepEqual([bare.mode, /does not name customer-live/.test(bare.reasons.join(" "))], ["owner", true]);
  assert.equal(ask("strict", "deploy", "customer-live", {}, [{ id: "x", action: "approve.tool.deploy", environments: ["development"] }]).mode, "owner");
  assert.equal(ask("strict", "deploy", "customer-live", {}, [{ id: "x", action: "approve.tool.deploy", environments: ["customer-live"] }]).via, "grant");
  // Naming the audience in a wildcard approval is naming it.
  assert.equal(ask("derived", "publish-post", "development", { audience: "blog" }, [{ id: "w", action: "approve.class.*", audiences: ["blog"] }]).via, "grant");
});

test("nothing overrides a reservation: not a grant, a ceiling, the autonomous profile or a named tool", () => {
  const reserved = { mandatoryHuman: ["git-commit", "deploy"] };
  const grant: GrantView = { id: "grt-1", action: "approve.*" };
  for (const profile of ["strict", "derived", "autonomous"] as const) {
    const d = ask(profile, "git-commit", "development", { scope: { ceiling: ["tool.git-commit", "class.commit"], approvedBy: "owner:rob" } }, [grant], reserved);
    assert.deepEqual([d.mode, d.via], ["owner", "reserved"], profile);
    assert.equal(ask(profile, "deploy", "development", {}, [grant], reserved).mode, "owner");
  }
  assert.equal(ask("autonomous", "git-push", "development", {}, [], reserved).mode, "allow", "other tools are unaffected");
});

test("the all-command gate asks before every execution, in every profile; a restriction denies", () => {
  for (const profile of ["strict", "derived", "autonomous"] as const) {
    assert.equal(ask(profile, "run-script", "development", { cls: "workspace-edit" }, [], { allCommandGate: true }).via, "all-command-gate");
    assert.equal(ask(profile, "shell", "development", { cls: "mutate" }, [{ id: "g", action: "approve.*" }], { allCommandGate: true }).via, "all-command-gate");
    assert.equal(ask(profile, "read-file", "development", {}, [], { allCommandGate: true }).mode, "allow", "reading is not execution");
    assert.equal(ask(profile, "install-package", "development", {}, [{ id: "g", action: "approve.*" }], { allCommandGate: true }).via, "all-command-gate", "an install runs code");
  }
  assert.equal(evaluate(view("autonomous"), req("git-commit"), [{ id: "g", action: "approve.*" }], true).mode, "deny");
});

test("an instruction's ceiling covers what it names: owner-approved in any profile, any in derived, never customer-live by class, never beyond a reservation", () => {
  const owner = { ceiling: ["tool.git-commit"], approvedBy: "owner:rob" };
  assert.deepEqual([ask("strict", "git-commit", "development", { scope: owner }).mode, ask("strict", "git-commit", "development", { scope: owner }).via], ["allow", "scope"]);
  assert.equal(ask("strict", "git-commit", "development", { scope: { ceiling: ["tool.git-commit"], approvedBy: "agent:x" } }).mode, "owner", "an agent's say-so is not an instruction in strict");
  assert.equal(ask("strict", "git-push", "development", { scope: owner }).mode, "owner", "outside the ceiling it asks");
  assert.equal(ask("derived", "install-package", "development", { scope: { ceiling: ["class.install-executable"], approvedBy: "agent:lead" } }).mode, "allow");
  assert.equal(ask("derived", "update-database", "customer-live", { scope: { ceiling: ["class.mutate"], approvedBy: "owner:rob" } }).mode, "owner");
  assert.equal(ask("derived", "git-push", "development", {}, [], { mandatoryHuman: ["git-push"] }).via, "reserved");
});

test("every decision says why, in order", () => {
  const d = ask("derived", "publish-post", "development", { audience: "newsletter" }, [{ id: "grt-1", action: "approve.tool.publish-post", audiences: ["blog"] }]);
  assert.ok(d.reasons.length >= 2 && /grt-1 does not apply/.test(d.reasons[0]!) && /stays a decision/.test(d.reasons[1]!), d.reasons.join(" | "));
  assert.equal(ask("derived", "deploy", "customer-live").profile, "derived");
});
