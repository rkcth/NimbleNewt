import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

// W01 acceptance for grant-proposals: grant.create in chat has no phrase gate; it is a proposal whose line states the
// consequence; the scope may be a project's name; a missing scope is asked; model-supplied dates are not drawn up.

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("a right given in chat is a proposal in any words, says it has no end and where it reaches, and is granted only on the owner's confirmation", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-chat-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4,
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
  });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    await c.services.principals.enroll(rob, { commandId: "e-scan", kind: "service", name: "scanner", grants: [] });
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string } }>;
    const turn = async (id: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: id, text })).outcomes; };
    const owner = (rest: Record<string, unknown>, evidence: string) => ({ kind: "command", ...rest, evidence, basis: "owner" });
    const args = { grantee: "service:scanner", action: "recovery.stall-scan", project: "*", basis: "run stall detection" };
    const activeNow = async (): Promise<number> => (await call(boot.token, "grant.list", { grantee: "service:scanner" })).result.items.filter((g: { state: string }) => g.state === "active").length;
    const DICTATES = /\bsay (only|that|everywhere|it exactly)\b|for example "/i;

    // Any words: a hedge, a dropped time limit, no "permanently" or "everywhere", a scope said about something else.
    for (const [n, said] of [["semi", "give service:scanner the recovery.stall-scan right everywhere semi-permanent"], ["til", "give service:scanner the recovery.stall-scan right everywhere permanently til Friday"], ["plain", "The scanner keeps waiting on me. Let service:scanner do recovery.stall-scan from now on, in every project."], ["noScope", "give service:scanner the recovery.stall-scan right permanently"], ["elsewhere", "give service:scanner the recovery.stall-scan right permanently. There are bugs everywhere."], ["limited", "give service:scanner the recovery.stall-scan right everywhere permanently, expires Friday"]] as const) {
      const r = await turn(`c3${n}`, said, [owner({ op: "grant.create", args }, said)]);
      assert.equal(r[0]!.status, "proposed", `${said}: ${JSON.stringify(r)}`);
      const line = (r[0]!.preview ?? []).join(" ");
      assert.match(line, /no end: it never runs out and stays until you revoke it/, `${n}: the proposal says the right has no end`);
      assert.match(line, /everywhere: it covers every project/, `${n}: and that it covers every project`);
      assert.doesNotMatch(`${r[0]!.message ?? ""} ${line}`, DICTATES, `${n}: nothing tells the owner what to say`);
      assert.equal(await activeNow(), 0, `${n}: a proposal grants nothing`);
      if (n === "limited") {
        const no = await turn("c3no", "no, that is not what I meant", [{ kind: "discard_proposal", proposalId: r[0]!.proposalId, evidence: "that is not what I meant", basis: "owner" }]);
        assert.equal(no[0]!.status, "discarded", JSON.stringify(no));
        assert.equal(await activeNow(), 0, "the owner's no ends it");
      }
    }
    // Confirming the shown proposal is what grants it.
    const text = "give service:scanner the recovery.stall-scan right everywhere permanently";
    const shownFirst = await turn("c1", text, [owner({ op: "grant.create", args }, text)]);
    assert.equal(shownFirst[0]!.status, "proposed", JSON.stringify(shownFirst));
    const applied = await turn("c2", "yes, do that", [{ kind: "apply_proposal", proposalId: shownFirst[0]!.proposalId, evidence: "do that", basis: "owner" }]);
    assert.equal(applied[0]!.status, "applied", JSON.stringify(applied));
    assert.equal(await activeNow(), 1);
    const held = await activeNow();

    // The value guards stay: a principal or action the owner did not name is refused.
    const prefix = await turn("c3b", text, [owner({ op: "grant.create", args: { ...args, grantee: "service:scan" } }, text)]);
    assert.equal(prefix[0]!.status, "refused", JSON.stringify(prefix));
    const foreign = await turn("c3c", text, [owner({ op: "grant.create", args: { ...args, action: "recovery.read" } }, text)]);
    assert.equal(foreign[0]!.status, "refused", JSON.stringify(foreign));
    // A project name the owner never said is not used.
    const named = await turn("c3d", "give service:scanner the recovery.stall-scan right permanently", [owner({ op: "grant.create", args: { grantee: "service:scanner", action: "recovery.stall-scan", projectName: "Garden" } }, "give service:scanner the recovery.stall-scan right permanently")]);
    assert.equal(named[0]!.status, "refused", JSON.stringify(named));

    // A project named in ordinary words is the scope: the proposal says it reaches only that project.
    const garden = (await call(boot.token, "project.create", { name: "Garden" }, "pg1")).result.id as string;
    const inGarden = "The scanner keeps stalling in Garden. Let service:scanner do recovery.stall-scan there from now on.";
    const scoped = await turn("c3g", inGarden, [owner({ op: "grant.create", args: { grantee: "service:scanner", action: "recovery.stall-scan", projectName: "Garden" } }, inGarden)]);
    assert.equal(scoped[0]!.status, "proposed", JSON.stringify(scoped));
    const scopedLine = (scoped[0]!.preview ?? []).join(" ");
    assert.match(scopedLine, /no end: it never runs out and stays until you revoke it; only in "Garden"/, scopedLine);
    assert.doesNotMatch(scopedLine, /everywhere|every project/);
    assert.equal(await activeNow(), held, "a proposal grants nothing");
    const gardenDone = await turn("c3g-ok", "yes, go ahead", [{ kind: "apply_proposal", proposalId: scoped[0]!.proposalId, evidence: "go ahead", basis: "owner" }]);
    assert.equal(gardenDone[0]!.status, "applied", JSON.stringify(gardenDone));
    const gardenGrant = (await call(boot.token, "grant.list", { grantee: "service:scanner" })).result.items.filter((g: { state: string; project: string }) => g.state === "active" && g.project === garden);
    assert.equal(gardenGrant.length, 1, "the right reaches that one project");
    // A name that is only part of a longer word the owner said is not their project.
    const longer = "Let service:scanner do recovery.stall-scan in Gardening from now on.";
    const part = await turn("c3k", longer, [owner({ op: "grant.create", args: { grantee: "service:scanner", action: "recovery.stall-scan", projectName: "Garden" } }, longer)]);
    assert.equal(part[0]!.status, "refused", JSON.stringify(part));
    // A name and a different scope together: the owner is asked which, nothing is drawn up.
    const both = await turn("c3j", inGarden, [owner({ op: "grant.create", args: { grantee: "service:scanner", action: "recovery.stall-scan", projectName: "Garden", project: "*" } }, inGarden)]);
    assert.equal(both[0]!.status, "asked", JSON.stringify(both));
    assert.match(both[0]!.question ?? "", /\?\s*$/);
    // No scope at all is asked as a plain question.
    const noProject = "let service:scanner do recovery.stall-scan";
    const asked = await turn("c3h", noProject, [owner({ op: "grant.create", args: { grantee: "service:scanner", action: "recovery.stall-scan" } }, noProject)]);
    assert.ok(asked[0]!.status === "refused" || asked[0]!.status === "asked", JSON.stringify(asked));
    const question = `${asked[0]!.message ?? ""}${asked[0]!.question ?? ""}`;
    assert.match(question, /\?\s*$/, "it asks which project");
    assert.doesNotMatch(question, /\bsay\b/i);
    // Dates the model supplied are not drawn up in chat.
    const until = "give service:scanner the recovery.stall-scan right everywhere until 2030-01-01";
    const dated = await turn("c3i", until, [owner({ op: "grant.create", args: { ...args, expiresAt: "2030-01-01T00:00:00.000Z" } }, until)]);
    assert.equal(dated[0]!.status, "refused", JSON.stringify(dated));
    const later = await turn("c3l", until, [owner({ op: "grant.create", args: { ...args, notBefore: "2030-01-01T00:00:00.000Z" } }, until)]);
    assert.equal(later[0]!.status, "refused", JSON.stringify(later));
    assert.equal(await activeNow(), held + 1, "nothing else was granted");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
