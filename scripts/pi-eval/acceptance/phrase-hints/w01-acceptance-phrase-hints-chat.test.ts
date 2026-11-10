import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService } from "../admission/service.js";
import { ScriptedInterpreter } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { RemoteWorkerClient } from "../remote/index.js";
import { startController } from "./index.js";

// W01 acceptance for phrase-hints: a right the owner dated is drawn up as a proposal with its days; refusals ask or
// state what is missing; a host move is a proposal whatever the words.

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
const HOUR = 3_600_000;
type Reply = { ok: boolean; result?: any; error?: { code: string; message: string } };
const DICTATES = /\bsay\b|for example/i;

test("a right for a day the owner wrote is a proposal that shows its days; a day not given, a backwards window or a past end is refused with a question", async () => {
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
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    const turn = async (id: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: id, text })).outcomes; };
    const owner = (rest: Record<string, unknown>, evidence: string) => ({ kind: "command", ...rest, evidence, basis: "owner" });
    const args = { grantee: "service:scanner", action: "recovery.stall-scan", project: "*" };
    const activeNow = async (): Promise<number> => (await call(boot.token, "grant.list", { grantee: "service:scanner" })).result.items.filter((g: { state: string }) => g.state === "active").length;

    // An end day the owner wrote: proposed, its line says the moment, confirmed it is recorded as shown.
    const until = "give service:scanner the recovery.stall-scan right everywhere until 2030-01-01";
    const dated = await turn("c1", until, [owner({ op: "grant.create", args: { ...args, expiresAt: "2030-01-01T00:00:00.000Z" } }, until)]);
    assert.equal(dated[0]!.status, "proposed", JSON.stringify(dated));
    const datedLine = (dated[0]!.preview ?? []).join(" ");
    assert.match(datedLine, /\(ends 2030-01-01T00:00:00\.000Z; everywhere: it covers every project/, datedLine);
    assert.doesNotMatch(datedLine, /no end/);
    assert.equal(await activeNow(), 0, "a proposal grants nothing");
    const datedDone = await turn("c1-ok", "yes, go ahead", [{ kind: "apply_proposal", proposalId: dated[0]!.proposalId, evidence: "go ahead", basis: "owner" }]);
    assert.equal(datedDone[0]!.status, "applied", JSON.stringify(datedDone));
    const withEnd = (await call(boot.token, "grant.list", { grantee: "service:scanner" })).result.items.filter((g: { state: string; expiresAt?: string }) => g.state === "active" && g.expiresAt !== undefined);
    assert.equal(withEnd.length, 1);
    assert.equal(withEnd[0].expiresAt, "2030-01-01T00:00:00.000Z", "the moment shown is the moment recorded");
    await call(boot.token, "grant.revoke", { grantId: withEnd[0].id, expectedRevision: withEnd[0].revision, reason: "test done" }, "rg2");
    const held = await activeNow();

    // Both days in one sentence, the second written out: the line says when it ends and when it starts.
    const window = "from 2030-12-01 until 20 December 2030 let service:scanner do recovery.stall-scan in every project";
    const windowed = await turn("c2", window, [owner({ op: "grant.create", args: { ...args, notBefore: "2030-12-01T00:00:00.000Z", expiresAt: "2030-12-20T00:00:00.000Z" } }, window)]);
    assert.equal(windowed[0]!.status, "proposed", JSON.stringify(windowed));
    assert.match((windowed[0]!.preview ?? []).join(" "), /ends 2030-12-20T00:00:00\.000Z; starts 2030-12-01T00:00:00\.000Z/);
    assert.equal(await activeNow(), held);

    // A day the message does not give is refused with a question.
    const monthEnd = "give service:scanner the recovery.stall-scan right everywhere until the end of the month";
    const noday = await turn("c3", monthEnd, [owner({ op: "grant.create", args: { ...args, expiresAt: "2030-11-30T23:59:59.000Z" } }, monthEnd)]);
    assert.equal(noday[0]!.status, "refused", JSON.stringify(noday));
    assert.equal(noday[0]!.code, "unsupported_value");
    assert.match(noday[0]!.message ?? "", /\?\s*$/);
    assert.doesNotMatch(noday[0]!.message ?? "", DICTATES);
    const noStart = "give service:scanner the recovery.stall-scan right everywhere from next month on";
    const nostart = await turn("c3b", noStart, [owner({ op: "grant.create", args: { ...args, notBefore: "2030-12-01T00:00:00.000Z" } }, noStart)]);
    assert.equal(nostart[0]!.status, "refused", JSON.stringify(nostart));
    assert.equal(nostart[0]!.code, "unsupported_value");

    // An end before the start: refused, called backwards.
    const backwards = "give service:scanner the recovery.stall-scan right everywhere from 2030-02-01 until 2030-01-01";
    const reversed = await turn("c4", backwards, [owner({ op: "grant.create", args: { ...args, notBefore: "2030-02-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z" } }, backwards)]);
    assert.equal(reversed[0]!.status, "refused", JSON.stringify(reversed));
    assert.equal(reversed[0]!.proposalId, undefined);
    assert.match(reversed[0]!.message ?? "", /backwards|before it (starts|begins|began)/i);
    // An end already past: refused, says so, asks.
    const gone = "give service:scanner the recovery.stall-scan right everywhere until 2020-01-01";
    const past = await turn("c5", gone, [owner({ op: "grant.create", args: { ...args, expiresAt: "2020-01-01T00:00:00.000Z" } }, gone)]);
    assert.equal(past[0]!.status, "refused", JSON.stringify(past));
    assert.equal(past[0]!.proposalId, undefined, "nothing is proposed");
    assert.match(past[0]!.message ?? "", /already passed/);
    assert.match(past[0]!.message ?? "", /\?\s*$/);
    assert.equal(await activeNow(), held);

    // The owner's own calendar day at a western offset: drawn up, shown in UTC.
    const western = "give service:scanner the recovery.stall-scan right everywhere until Nov 30 2030";
    const local = await turn("c6", western, [owner({ op: "grant.create", args: { ...args, expiresAt: "2030-11-30T23:59:00-08:00" } }, western)]);
    assert.equal(local[0]!.status, "proposed", JSON.stringify(local));
    assert.match((local[0]!.preview ?? []).join(" "), /ends 2030-12-01T07:59:00\.000Z/);
    assert.equal(await activeNow(), held);

    // The remaining refusals state what is missing or ask; none tells the owner what to say.
    const text = "give service:scanner the recovery.stall-scan right everywhere";
    const prefix = await turn("c7", text, [owner({ op: "grant.create", args: { ...args, grantee: "service:scan" } }, text)]);
    assert.equal(prefix[0]!.status, "refused", JSON.stringify(prefix));
    assert.doesNotMatch(prefix[0]!.message ?? "", DICTATES, String(prefix[0]!.message));
    const elsewhere = "give service:scanner the recovery.stall-scan right in proj-aaaaaaaaaaaaaaaaaaaa";
    const wrongProject = await turn("c8", elsewhere, [owner({ op: "grant.create", args: { ...args, project: "proj-bbbbbbbbbbbbbbbbbbbb" } }, elsewhere)]);
    assert.equal(wrongProject[0]!.status, "refused", JSON.stringify(wrongProject));
    assert.doesNotMatch(wrongProject[0]!.message ?? "", DICTATES, String(wrongProject[0]!.message));
    const quoted = await turn("c9", text, [{ kind: "command", op: "grant.create", args, evidence: text, basis: "quoted" }]);
    assert.equal(quoted[0]!.status, "refused", JSON.stringify(quoted));
    assert.equal(quoted[0]!.code, "untrusted_authority");
    assert.doesNotMatch(quoted[0]!.message ?? "", DICTATES, String(quoted[0]!.message));
    assert.equal(await activeNow(), held);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("moving the work off a host is a proposal whatever the owner's words, says which host, and happens on the owner's confirmation", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-quiet-"));
  const say: Record<string, unknown[]> = {};
  const now = Date.parse("2026-10-30T10:00:00.000Z");
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    dispatch: {
      timer: new ManualTimer(), manual: true, quietHosts: { maxGapMs: 1_000_000 * HOUR }, clock: () => new Date(now).toISOString(),
      dispatcher: { leaseMs: 1000 * HOUR },
      route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: false } }),
      remote: { blobDirectory: join(d, "blobs"), hosts: ["pc", "laptop"].map((n) => ({ hostId: `host:${n}`, checkpointWaitMs: 300, pollMs: 20, resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "cloud-allowed" as const, harness: "pi" }) })) },
    },
  } as never);
  try {
    assert.ok(c.dispatch?.workerUrl !== undefined && c.dispatch.remote !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    for (const name of ["pc", "laptop"]) {
      await c.services.principals.enroll(rob, { commandId: `e-${name}`, kind: "host", name, grants: [] });
      const token = (await c.services.principals.issueCredential(rob, `host:${name}`)).token;
      const client = new RemoteWorkerClient({ url: c.dispatch.workerUrl, token, workerVersion: "worker-9.1.0" });
      await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: `cap-${name}`, actor: rob.id, host: `host:${name}`, capacity: { cpus: 8, memoryMb: 16_384 } });
      await client.connect({ ...CAPS } as never);
      await client.heartbeat(1);
    }
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    const turn = async (id: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: id, text })).outcomes; };
    const wordings = ["move the work off host:laptop", "Take a look at host:laptop", "Don't move the work off host:laptop", "host:laptop has been slow all day, can its jobs run somewhere else?", "host:laptop, please get its work onto the other machine"];
    for (const [i, words] of wordings.entries()) {
      const r = await turn(`mw${i}`, words, [{ kind: "command", op: "host.move-work", args: { hostId: "host:laptop" }, evidence: words, basis: "owner" }]);
      const shown = `${r[0]!.message ?? ""} ${(r[0]!.preview ?? []).join(" ")}`;
      assert.equal(r[0]!.status, "proposed", `${words}: ${JSON.stringify(r[0])}`);
      assert.match(shown, /host:laptop/, "the proposal says which host");
      assert.doesNotMatch(shown, /\bfor example\b|\bsay\b|your own words/i, shown);
      assert.equal((await call(boot.token, "host.quiet.get", {})).result.item.effective.autoMove, true, "a shown move changes nothing");
    }
    // A host the owner did not name is not the chat's to invent.
    const unnamed = await turn("mw-none", "that laptop is annoying", [{ kind: "command", op: "host.move-work", args: { hostId: "host:laptop" }, evidence: "that laptop is annoying", basis: "owner" }]);
    assert.equal(unnamed[0]!.status, "refused", JSON.stringify(unnamed[0]));
    assert.equal(unnamed[0]!.code, "unsupported_value");
    // Confirmed, the move is made.
    const words = "move the work off host:pc";
    const said = await turn("m5", words, [{ kind: "command", op: "host.move-work", args: { hostId: "host:pc" }, evidence: words, basis: "owner" }]);
    assert.equal(said[0]!.status, "proposed", JSON.stringify(said));
    const done = await turn("m5-ok", "yes, do it", [{ kind: "apply_proposal", proposalId: said[0]!.proposalId, evidence: "yes, do it", basis: "owner" }]);
    assert.equal(done[0]!.status, "applied", JSON.stringify(done));
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
