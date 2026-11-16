import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AdminViewService } from "../admin/index.js";
import { ConfigurationService } from "../configuration/index.js";
import { ConversationService } from "../conversations/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PolicyService } from "../policy/index.js";
import { RoutingService } from "../routing/index.js";
import { ReviewService } from "../review/index.js";
import { GrantService } from "../security/index.js";
import { SetupProviderService } from "../setup/index.js";
import { StatusService } from "../status/index.js";
import { WaitService } from "../domain/waits.js";
import { BlockerService } from "../domain/blockers.js";
import { adminIntent } from "../web/door.js";
import { ModelInterpreter } from "./model-interpreter.js";
import { PolicyEditService } from "./index.js";
import { cid, openWorld, options } from "./testing/harness.js";

// Card U08: the settings and administration views are reachable in free-form chat (no magic phrase), an edit made from the page is the same edit the chat makes (same durable revision), a secret is never
// typed in chat, and everything is owner only. All four storage backends.

after(stopServer);
const LEAK = "sk-LEAK-0123456789abcdef";
const ask = (request: Record<string, unknown>, evidence: string) => ({ kind: "status", request, evidence, basis: "owner" });
const pe = (change: Record<string, unknown>, evidence: string) => ({ kind: "policy_edit", change, evidence, basis: "owner" });
const lines = (outcomes: readonly { lines?: readonly { text: string }[] }[]): string => outcomes.flatMap((o) => (o.lines ?? []).map((l) => l.text)).join("\n");

test("the interpreter is told the administration views, that a secret value is never typed in chat, and where it goes instead (card U08)", async () => {
  let system = "";
  const m = new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]);
  await m.interpret({ text: "what providers do I have?", quoted: [], focus: {}, proposals: [] });
  for (const kind of ["settings", "providers", "secrets", "sandbox"]) assert.match(system, new RegExp(`${kind}\\(`), `${kind} is a status kind the model is told`);
  assert.match(system, /A secret VALUE is never typed in chat/);
  assert.match(system, /Secrets form of the web page/);
  assert.match(system, /policy_edit setting change for the whole installation/);
  assert.match(system, /macOS Seatbelt is process-level and weaker/);
  assert.match(system, /provider\.<name>\.enabled/);
});

for (const backend of backends) {
  test(`${backend.name}: the owner reads the settings, providers, secrets and sandbox in free words, an edit from the page equals the same edit typed in chat, and nobody else reads any of it (card U08)`, async () => {
    const script: Record<string, unknown[]> = {};
    const secrets = new Map<string, string>();
    let statusSvc: StatusService | undefined;
    let hostList: { hostId: string; os?: string }[] = [{ hostId: "host:mac", os: "darwin" }, { hostId: "host:lin", os: "linux" }];
    const w = await openWorld(backend, script, undefined, (storage, epoch, built) => {
      const routing = RoutingService.withEpoch(storage, epoch, options);
      const configuration = ConfigurationService.withEpoch(storage, epoch, { ...options, routing });
      const providers = SetupProviderService.withEpoch(storage, epoch, options, {});
      const admin = new AdminViewService({ configuration, routing: async () => { const t = await routing.get(); return t === undefined ? undefined : { providers: t.providers, routes: t.routes }; }, endpoints: () => providers.endpoints(), secrets: { has: async (n) => secrets.has(n) }, hosts: async () => hostList.map((h) => ({ ...h, freshness: "fresh", identity: "active" })) });
      const status = StatusService.withEpoch(storage, epoch, { assignments: built.assignments, waits: WaitService.withEpoch(storage, epoch, built.assignments, options), blockers: BlockerService.withEpoch(storage, epoch, options), contracts: built.contracts, admin }, options);
      statusSvc = status;
      return { admin, status, setupProviders: providers, configuration } as never;
    });
    try {
      const storage = w.world.storage, epoch = w.projects.epoch;
      const configuration = ConfigurationService.withEpoch(storage, epoch, { ...options, routing: RoutingService.withEpoch(storage, epoch, options) });
      const grants = GrantService.withEpoch(storage, epoch, options);
      const policy = PolicyService.withEpoch(storage, epoch, grants, options);
      const edits = PolicyEditService.withEpoch(storage, epoch, { policy, reviews: ReviewService.withEpoch(storage, epoch, options), grants, configuration, conversations: ConversationService.withEpoch(storage, epoch, options), interpreter: w.interpreter }, options);
      const chat = w.chat({ policy, policyEdits: edits, status: statusSvc! });
      const say = async (text: string, intents: unknown[]) => { script[text] = intents; return chat.submit(w.ownerToken, { messageId: cid("m"), text }); };
      const as = (token: string, op: string, args: Record<string, unknown>) => w.api.handle(token, { v: 1, op, args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string } }>;

      // Providers (added the way the guided setup does), then a secret that is set: the chat answers in free words, names the secret and says whether it is set, never shows it.
      await SetupProviderService.withEpoch(storage, epoch, options, {}).add(w.owner, { commandId: cid("pr"), providers: [
        { name: "local-a", location: "local", endpoint: "http://127.0.0.1:8002/v1", models: ["m1"], contextTokens: 32768 },
        { name: "cloud-b", location: "cloud", paid: true, endpoint: "https://api.example.test/v1", models: ["big"], contextTokens: 65536, credentialName: "cloud-b-key" },
      ] });
      const q1 = "which model providers have I got and are their keys in place?";
      const p1 = await say(q1, [ask({ kind: "providers" }, q1)]);
      assert.equal(p1.outcomes[0]!.status, "answered", JSON.stringify(p1.outcomes));
      assert.match(lines(p1.outcomes as never), /cloud-b: cloud, on, costs money, at https:\/\/api\.example\.test\/v1; secret cloud-b-key is not set/);
      secrets.set("cloud-b-key", LEAK);
      const q2 = "are the secrets all set?";
      const p2 = await say(q2, [ask({ kind: "secrets" }, q2)]);
      assert.match(lines(p2.outcomes as never), /cloud-b-key: set; used by provider cloud-b/);
      assert.match(lines(p2.outcomes as never), /never type it in chat/);
      assert.doesNotMatch(JSON.stringify([p1, p2]), /sk-LEAK/);

      // The sandbox: the weaker boundary is said plainly.
      const q3 = "where do my agents run and how safe is that?";
      const p3 = await say(q3, [ask({ kind: "sandbox" }, q3)]);
      assert.match(lines(p3.outcomes as never), /Host host:mac \(fresh\): Seatbelt on darwin, a WEAKER boundary/);
      assert.match(lines(p3.outcomes as never), /Host host:lin \(fresh\): bubblewrap on linux, a strong boundary/);

      // Settings: read, then changed typed in words (shown first, applied on the owner's say), and the same change made by the page's button lands in the same kind of revision.
      const q4 = "what are my grant settings?";
      const s1 = await say(q4, [ask({ kind: "settings", prefix: "grants" }, q4)]);
      assert.match(lines(s1.outcomes as never), /grants\.maxDays: not set; /);
      const typed = "let standing grants last at most 12 days";
      const t1 = await say(typed, [pe({ type: "setting", layer: "installation", key: "grants.maxDays", value: 12 }, "at most 12 days")]);
      assert.equal(t1.outcomes[0]!.status, "proposed", "a setting is shown first");
      assert.equal((await configuration.layer(w.owner, "installation")), undefined, "nothing changed yet");
      const applyText = "yes, apply that";
      const t2 = await say(applyText, [{ kind: "apply_proposal", proposalId: (t1.outcomes[0] as any).editId, evidence: "apply that", basis: "owner" }]);
      assert.equal(t2.outcomes[0]!.status, "applied", JSON.stringify(t2.outcomes));
      const afterTyped = (await configuration.layer(w.owner, "installation"))!;
      assert.deepEqual([afterTyped.applied["grants.maxDays"]!.value, afterTyped.history.length], [12, 1]);

      // The page's button: exactly the sentence and the one intent the door builds, run as a chat turn with fixed intents; shown first, applied on Apply, and the same kind of revision follows.
      const { text, intent } = adminIntent("setting", { key: "grants.defaultDays", value: 5 });
      const ui = await chat.submit(w.ownerToken, { messageId: cid("ui"), text }, { fixedIntents: [intent] } as never);
      assert.equal(ui.outcomes[0]!.status, "proposed", JSON.stringify(ui.outcomes));
      assert.equal((await configuration.layer(w.owner, "installation"))!.history.length, 1, "nothing is applied by the button alone");
      const applied = await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: ((ui.outcomes[0] as any).proposalId ?? (ui.outcomes[0] as any).editId) as string } as never);
      assert.equal((applied as any).applied ?? true, true, JSON.stringify(applied));
      const again = await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: ((ui.outcomes[0] as any).proposalId) as string } as never);
      assert.deepEqual([(again as any).applied, (again as any).replayed], [true, true], "a second Apply changes nothing");
      const afterUi = (await configuration.layer(w.owner, "installation"))!;
      assert.deepEqual([afterUi.applied["grants.defaultDays"]!.value, afterUi.history.length, afterUi.revision > afterTyped.revision], [5, 2, true]);
      assert.deepEqual(Object.keys(afterUi.history[1]!.effects), ["grants.defaultDays"], "the same history entry the chat's change makes: who, what, when it counts");
      assert.equal(afterUi.history[0]!.by, afterUi.history[1]!.by, "the same actor");
      // Discard from the page's button: the edit is dropped and nothing changes.
      const drop = adminIntent("setting", { key: "grants.defaultDays", value: 40 });
      const dropped = await chat.submit(w.ownerToken, { messageId: cid("ui"), text: drop.text }, { fixedIntents: [drop.intent] } as never);
      const gone = await chat.discardProposal(w.ownerToken, { commandId: cid("dp"), proposalId: (dropped.outcomes[0] as any).proposalId });
      assert.equal(gone.replayed, false);
      assert.equal((await configuration.layer(w.owner, "installation"))!.applied["grants.defaultDays"]!.value, 5);
      // The effective values the page reads now show both, set by the owner.
      const read = (await as(w.ownerToken, "settings.effective", { prefix: "grants" })).result.item.items as { key: string; value: unknown; state: string }[];
      assert.deepEqual(read.map((i) => [i.key, i.value, i.state]), [["grants.defaultDays", 5, "set"], ["grants.maxDays", 12, "set"]]);

      // A value the setting refuses is refused in words addressed to the setting, and nothing is staged.
      const bad = adminIntent("setting", { key: "grants.maxDays", value: 0 });
      const refused = await chat.submit(w.ownerToken, { messageId: cid("ui"), text: bad.text }, { fixedIntents: [bad.intent] } as never);
      const finishing = refused.outcomes[0]!.status === "proposed" ? await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: ((refused.outcomes[0] as any).proposalId ?? (refused.outcomes[0] as any).editId) as string } as never).catch((e) => ({ error: String(e) })) : refused;
      assert.notEqual((finishing as any).applied, true, JSON.stringify(finishing));
      assert.equal((await configuration.layer(w.owner, "installation"))!.applied["grants.maxDays"]!.value, 12, "the value in force is untouched");

      // Owner only, bounded, checked: an agent reads none of it; an unknown field or a bad window is refused.
      const ann = await w.agent("ann", [{ action: "*", project: "*" }]);
      for (const op of ["settings.effective", "provider.list", "secret.status", "sandbox.status"]) assert.equal((await as(ann.token, op, {})).error?.code, "forbidden", op);
      assert.equal((await as(w.ownerToken, "provider.list", { x: 1 })).error?.code, "invalid_command");
      assert.equal((await as(w.ownerToken, "settings.effective", { agentId: "agt-bogus" })).error?.code, "invalid_command");
      const forAgent = await w.api.handle(ann.token, { v: 1, op: "status.ask", args: { request: { kind: "secrets" } } } as never) as any;
      assert.doesNotMatch(JSON.stringify(forAgent), /cloud-b-key/, "an agent is not told the names");
    } finally { await w.close(); }
  });
}

// Follow-up to card U08: the Administration page edits an agent and takes a right back through the chat's own operations (`agent.update`, `grant.revoke`). Whatever the profile, the change is shown
// first and applied only on Apply; a second Apply changes nothing; a stale view is refused. All four storage backends.
for (const backend of backends) {
  test(`${backend.name}: an agent edit and a take-back of a right from the page are shown first, applied only on Apply, applied once, and refused when stale (card U08 follow-up)`, async () => {
    const w = await openWorld(backend, {}, undefined, (storage, epoch) => ({ grants: GrantService.withEpoch(storage, epoch, options) }));
    try {
      const grants = GrantService.withEpoch(w.world.storage, w.projects.epoch, options);
      const chat = w.chat();
      const page = async (what: string, body: Record<string, unknown>) => { const b = adminIntent(what, body); return chat.submit(w.ownerToken, { messageId: cid("ui"), text: b.text }, { fixedIntents: [b.intent] } as never); };
      const apply = (proposalId: string) => chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId } as never);
      await w.agents.seedStandardRoles();
      const ann = await w.agents.create(w.owner, { commandId: cid("a"), friendlyName: "Ann", roles: ["author"] });
      const agentId = ann.id;

      // A new name alone is an ordinary edit that the chat applies at once when typed; from the page it is shown first all the same.
      const rename = await page("agent", { agentId, friendlyName: "Annie" });
      assert.equal(rename.outcomes[0]!.status, "proposed", JSON.stringify(rename.outcomes));
      assert.equal((await w.agents.get(w.owner, agentId))!.friendlyName, "Ann", "nothing changed before Apply");
      const proposalId = (rename.outcomes[0] as any).proposalId as string;
      const done = await apply(proposalId);
      assert.equal((done as any).applied, true, JSON.stringify(done));
      const afterRename = (await w.agents.get(w.owner, agentId))!;
      assert.equal(afterRename.friendlyName, "Annie");
      const again = await apply(proposalId);
      assert.deepEqual([(again as any).applied, (again as any).replayed], [true, true]);
      assert.equal((await w.agents.get(w.owner, agentId))!.revision, afterRename.revision, "a second Apply changes nothing");

      // Roles are authority: shown first, and a discard leaves the agent as it was.
      const roles = await page("agent", { agentId, roles: ["author", "reviewer"] });
      assert.equal(roles.outcomes[0]!.status, "proposed");
      assert.match(lines(roles.outcomes as never) + JSON.stringify(roles.outcomes), /reviewer/);
      await chat.discardProposal(w.ownerToken, { commandId: cid("dp"), proposalId: (roles.outcomes[0] as any).proposalId });
      assert.deepEqual((await w.agents.get(w.owner, agentId))!.roles, ["author"]);

      // A view that went stale (the agent was changed after the page was drawn) is refused when applied, and the other change stands.
      const stale = await page("agent", { agentId, friendlyName: "Anna" });
      await w.agents.update(w.owner, { commandId: cid("u"), agentId, expectedRevision: (await w.agents.get(w.owner, agentId))!.revision, friendlyName: "Annette" });
      const refused = await apply((stale.outcomes[0] as any).proposalId).catch((e) => ({ error: String(e) }));
      assert.notEqual((refused as any).applied, true, JSON.stringify(refused));
      assert.equal((await w.agents.get(w.owner, agentId))!.friendlyName, "Annette");

      // Taking a right back: shown first in every profile, the reason is the owner's words, and the right counts until Apply.
      await w.agent("ann", []);
      const given = await grants.grant(w.owner, { commandId: cid("g"), grantee: "agent:ann", action: "task.update", project: "*", source: "direct", basis: "test" });
      const revoke = await page("grant-revoke", { grantId: given.id, reason: "the project is finished" });
      assert.equal(revoke.outcomes[0]!.status, "proposed", JSON.stringify(revoke.outcomes));
      assert.equal((await grants.getGrant(given.id))!.state, "active", "still in force before Apply");
      const taken = await apply((revoke.outcomes[0] as any).proposalId);
      assert.equal((taken as any).applied, true, JSON.stringify(taken));
      const after = (await grants.getGrant(given.id))!;
      assert.equal(after.state, "revoked");
      const rev = after.revision;
      assert.equal((await apply((revoke.outcomes[0] as any).proposalId) as any).replayed, true);
      assert.equal((await grants.getGrant(given.id))!.revision, rev, "a second Apply changes nothing");
      // Already revoked: refused when asked again.
      const twice = await page("grant-revoke", { grantId: given.id, reason: "once more" });
      const twiceDone = twice.outcomes[0]!.status === "proposed" ? await apply((twice.outcomes[0] as any).proposalId).catch((e) => ({ error: String(e) })) : twice;
      assert.notEqual((twiceDone as any).applied, true, JSON.stringify(twiceDone));
      // The agent cannot do either through the API.
      const annTok = await w.agent("bob", [{ action: "task.read", project: "*" }]);
      for (const [op, args] of [["grant.revoke", { grantId: given.id, expectedRevision: 1, reason: "x" }], ["agent.update", { agentId, expectedRevision: 1, friendlyName: "Zed" }]] as const)
        assert.equal(((await w.api.handle(annTok.token, { v: 1, op, commandId: cid("x"), args } as never)) as any).error?.code, "forbidden", op);
    } finally { await w.close(); }
  });
}
