import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

// Card U14b: an owner-only operation issues the credential of an agent or a host. It is shown once, only its hash is stored, it is in no record, log or chat turn, and it can be taken away.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
type R = { ok: boolean; result: any; error?: { code: string; message: string } };

function filesUnder(dir: string): string[] { return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)])); }

async function world(script: Record<string, unknown[]> = {}) {
  const d = mkdtempSync(join(tmpdir(), "nn-u14b-"));
  const printed: string[] = [];
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: (l) => { printed.push(l); }, facts: supported, filesystem: ext4, chat: { interpreter: new ScriptedInterpreter((input) => script[input.text] ?? []) } });
  const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
  const call = (op: string, args: Record<string, unknown>, commandId?: string, token = boot.token) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<R>;
  const done = async () => { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); };
  return { c, boot, call, done, d, printed };
}

test("the owner issues a host's credential once: it authenticates, only its hash is stored, a repeat of the request cannot show it again, a new one replaces it and revoking it stops the host (card U14b)", async () => {
  const w = await world();
  try {
    const made = await w.call("credential.issue", { kind: "host", name: "laptop" }, "ci-1");
    assert.ok(made.ok, JSON.stringify(made));
    assert.equal(made.result.id, "host:laptop");
    assert.equal(made.result.enrolled, true, "a new host is enrolled with no rights");
    const token: string = made.result.secret.value;
    assert.match(token, /^host:laptop\./);
    assert.match(made.result.secret.label, /host:laptop/);
    const host = await w.c.services.principals.authenticate(token);
    assert.equal(host.id, "host:laptop");
    assert.deepEqual(host.grants, []);
    // The credential's public identifier is not the secret.
    assert.ok(!JSON.stringify(made.result).replace(token, "").includes(token.split(".")[1]!));

    // The same request again cannot show it again, and does not make a second credential that the first replaced.
    const again = await w.call("credential.issue", { kind: "host", name: "laptop" }, "ci-1");
    assert.equal(again.ok, false);
    assert.equal(again.error!.code, "command_conflict");
    assert.match(again.error!.message, /shown only once/);
    assert.ok(!JSON.stringify(again).includes(token.split(".")[1]!));
    await w.c.services.principals.authenticate(token);

    // A new request makes a new credential and the old one stops at once.
    const second = await w.call("credential.issue", { kind: "host", name: "laptop" }, "ci-2");
    assert.ok(second.ok);
    assert.equal(second.result.enrolled, false);
    await assert.rejects(w.c.services.principals.authenticate(token), /not accepted/);
    const newer: string = second.result.secret.value;
    await w.c.services.principals.authenticate(newer);

    // Revoking takes the credential away; the host stays and a later issue gives a new one.
    const gone = await w.call("credential.revoke", { kind: "host", name: "laptop", reason: "lost laptop" }, "cr-1");
    assert.ok(gone.ok, JSON.stringify(gone));
    assert.equal(gone.result.revoked, true);
    await assert.rejects(w.c.services.principals.authenticate(newer), /not accepted/);
    assert.equal((await w.c.services.principals.get("host:laptop"))!.hasCredential, false);
    const third = await w.call("credential.issue", { kind: "host", name: "laptop" }, "ci-3");
    await w.c.services.principals.authenticate(third.result.secret.value);

    // Nothing printed holds a secret, and neither does any file once the controller is closed.
    const secrets = [token, newer, third.result.secret.value].map((t) => t.split(".")[1]!);
    for (const line of w.printed) for (const s of secrets) assert.ok(!line.includes(s));
    await w.c.close();
    for (const f of filesUnder(w.d)) for (const s of secrets) assert.ok(!readFileSync(f).includes(Buffer.from(s)), `${f} must not hold a credential`);
  } finally { rmSync(w.d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("an agent's credential needs an agent that exists, only the owner may issue or revoke, and wrong or mixed arguments are refused in plain words (card U14b)", async () => {
  const w = await world();
  try {
    const agent = await w.call("agent.create", { friendlyName: "Ann" }, "a1");
    assert.ok(agent.ok, JSON.stringify(agent));
    const made = await w.call("credential.issue", { kind: "agent", agentId: agent.result.id }, "ci-a");
    assert.ok(made.ok, JSON.stringify(made));
    assert.equal(made.result.id, `agent:${agent.result.id}`);
    const principal = await w.c.services.principals.authenticate(made.result.secret.value);
    assert.equal(principal.kind, "agent");
    assert.ok(principal.grants.every((g) => g.action.startsWith("tool.a-")), "issuing a credential gives no right: only the agent's own tool namespace, which agent.create gave it");

    // The agent itself, with its credential, is not the owner.
    for (const [op, args] of [["credential.issue", { kind: "host", name: "other" }], ["credential.revoke", { kind: "agent", agentId: agent.result.id }]] as const) {
      const refused = await w.call(op, args, `x-${op}`, made.result.secret.value);
      assert.equal(refused.ok, false);
      assert.equal(refused.error!.code, "forbidden");
    }
    // An agent that does not exist, and arguments that do not fit the kind.
    assert.equal((await w.call("credential.issue", { kind: "agent", agentId: "agt-aaaaaaaaaaaaaaaaaaaa" }, "n1")).error!.code, "not_found");
    assert.match((await w.call("credential.issue", { kind: "agent", name: "ann" }, "n2")).error!.message, /agentId/);
    assert.match((await w.call("credential.issue", { kind: "host", agentId: agent.result.id }, "n3")).error!.message, /name/);
    assert.match((await w.call("credential.issue", { kind: "service", name: "x" }, "n4")).error!.message, /agent or host/);
    assert.match((await w.call("credential.issue", { kind: "host", name: "Bad Name" }, "n5")).error!.message, /principalId|name/);
    assert.equal((await w.call("credential.issue", { kind: "host", name: "owner" }, "n6")).ok, true, "a host may be called owner; it is host:owner, not the owner");
    assert.equal((await w.call("credential.issue", { kind: "host", name: "x", extra: 1 }, "n7")).ok, false);
    // A credential is revoked once; a second revoke says there was none.
    assert.equal((await w.call("credential.revoke", { kind: "agent", agentId: agent.result.id }, "r1")).result.revoked, true);
    assert.equal((await w.call("credential.revoke", { kind: "agent", agentId: agent.result.id }, "r2")).result.revoked, false);
    await assert.rejects(w.c.services.principals.authenticate(made.result.secret.value), /not accepted/);
  } finally { await w.done(); }
});

test("by chat the credential is shown first, then made on request, handed to the owner once in memory and kept in no turn, proposal or file; a replayed message and the web page's channel do not show it (card U14b)", async () => {
  const intent = (rest: Record<string, unknown>, evidence: string) => ({ ...rest, evidence, basis: "owner" });
  const script: Record<string, unknown[]> = {
    "Give the laptop a credential, I will put it on the machine": [intent({ kind: "command", op: "credential.issue", args: { kind: "host", name: "laptop" } }, "Give the laptop a credential")],
  };
  const w = await world(script);
  try {
    const chat = w.c.chat!;
    const turn = await chat.submit(w.boot.token, { messageId: "m1", text: "Give the laptop a credential, I will put it on the machine" });
    const o = turn.outcomes[0] as unknown as { status: string; proposalId: string; preview: string[] };
    assert.equal(o.status, "proposed", JSON.stringify(turn));
    assert.match(o.preview.join(" "), /credential/i);
    assert.equal(turn.secrets, undefined, "nothing is made by being asked");
    assert.equal((await w.c.services.principals.get("host:laptop")), undefined);

    // The web page keeps what it receives, so it is refused, and nothing is made by the refusal.
    script["yes, go ahead"] = [intent({ kind: "apply_proposal", proposalId: o.proposalId }, "yes, go ahead")];
    const web = await chat.submit(w.boot.token, { messageId: "m2", text: "yes, go ahead" }, { secrets: false });
    assert.equal(web.secrets, undefined);
    assert.match(JSON.stringify(web.outcomes), /cannot show a credential once/);
    assert.equal((await w.c.services.principals.get("host:laptop")), undefined, "refused before anything was made");
    const webApply = await chat.applyProposal(w.boot.token, { commandId: "web-apply", proposalId: o.proposalId }, { secrets: false });
    assert.equal(webApply.applied, false);
    assert.equal(webApply.secrets, undefined);
    assert.equal((await w.c.services.principals.get("host:laptop")), undefined);

    // The terminal channel: shown once.
    script["yes, issue it now"] = [intent({ kind: "apply_proposal", proposalId: o.proposalId }, "yes, issue it now")];
    const done = await chat.submit(w.boot.token, { messageId: "m3", text: "yes, issue it now" });
    assert.equal(done.secrets?.length, 1, JSON.stringify(done));
    const secret = done.secrets![0]!;
    assert.match(secret.label, /host:laptop/);
    assert.equal((await w.c.services.principals.authenticate(secret.value)).id, "host:laptop");
    assert.match(done.reply.join(" "), /shown once/);
    assert.ok(!JSON.stringify(done.outcomes).includes(secret.value) && !done.reply.join(" ").includes(secret.value), "the outcomes and the reply do not hold it");
    const key = secret.value.split(".")[1]!;

    // Sent again, the same message is the first turn and has no secret to show.
    const replay = await chat.submit(w.boot.token, { messageId: "m3", text: "yes, issue it now" });
    assert.equal(replay.replayed, true);
    assert.equal(replay.secrets, undefined);

    // The records: the turns and the proposal hold no secret.
    for (const id of [turn.turnId, web.turnId, done.turnId]) assert.ok(!JSON.stringify(await chat.getTurn(w.boot.token, id)).includes(key));
    await w.c.close();
    for (const f of filesUnder(w.d)) assert.ok(!readFileSync(f).includes(Buffer.from(key)), `${f} must not hold the credential`);
    for (const line of w.printed) assert.ok(!line.includes(key));
  } finally { rmSync(w.d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("the local worker host is off until the owner turns it on, only the owner can, a change needs the current revision, and the answer says it counts from the next start (card U14b)", async () => {
  const w = await world();
  try {
    assert.deepEqual({ ...(await w.call("host.local.get", {})).result.item }, { revision: 0, enabled: false, default: false, takesEffect: "at the next start" });
    assert.equal(await w.c.services.localHost.enabled(), false);
    const on = await w.call("host.local.set", { enabled: true }, "h1");
    assert.ok(on.ok, JSON.stringify(on));
    assert.equal(on.result.enabled, true);
    assert.equal(on.result.takesEffect, "at the next start");
    assert.equal(await w.c.services.localHost.enabled(), true);
    const stale = await w.call("host.local.set", { enabled: false, expectedRevision: 0 }, "h2");
    assert.equal(stale.error!.code, "stale_revision");
    assert.equal((await w.call("host.local.set", { enabled: "yes" }, "h3")).ok, false);
    assert.equal((await w.call("host.local.set", { enabled: false, expectedRevision: on.result.revision }, "h4")).ok, true);
    assert.equal(await w.c.services.localHost.enabled(), false);
    // An agent cannot read or change it.
    const agent = await w.call("agent.create", { friendlyName: "Ann" }, "a1");
    const token = (await w.call("credential.issue", { kind: "agent", agentId: agent.result.id }, "i1")).result.secret.value;
    assert.equal((await w.call("host.local.set", { enabled: true }, "h5", token)).error!.code, "forbidden");
    assert.equal((await w.call("host.local.get", {}, undefined, token)).error!.code, "forbidden");
  } finally { await w.done(); }
});
