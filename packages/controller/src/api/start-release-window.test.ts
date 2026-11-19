import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { NotificationService } from "../notifications/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
type Reply = { ok: boolean; result?: any; error?: { code: string; message?: string } };
const unlockAll = (dir: string): void => { try { chmodSync(dir, 0o700); for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) unlockAll(join(dir, e.name)); } catch { /* gone */ } };

/**
 * Card K07 (first slice) through the real controller: a maintenance window is proposed by chat with the staged digest filled in from the record, set through the API, and the dispatcher's
 * `release.windows` sweep activates the release while it is open; the owner's confirmation of the start commits it and one notice reaches the owner's inbox.
 */
test("a maintenance window set by chat activates its release in the dispatcher's sweep and commits once the start is confirmed, telling the owner once (card K07)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-k07-"));
  const root = join(d, "rel");
  const say: Record<string, unknown[]> = {};
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [],
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    dispatch: { timer: new ManualTimer(), manual: true, intervalMs: 1000 },
    releases: { root, switcher: "pointer", platform: { os: "linux", arch: "x64" } },
  } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    await c.services.principals.enroll(rob, { commandId: "e1", kind: "agent", name: "builder", grants: [{ action: "release.report", project: "*" }] });
    const builderToken = (await c.services.principals.issueCredential(rob, "agent:builder")).token;
    const builder = await c.services.principals.authenticate(builderToken);
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    const owner = (op: string, args: Record<string, unknown>, id?: string) => call(boot.token, op, args, id);
    assert.ok((await owner("release.host", { hostId: "lx", os: "linux", arch: "x64" }, "h1")).ok);
    const files = { "nn.js": "v1", "compat.json": JSON.stringify({ protocol: { min: 1, max: 1 } }) };
    const artifacts = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha(v)]));
    const manifest = { sourceCommit: "c".repeat(40), suiteRevision: "s1", artifacts, dependencyLocks: { lock: sha("lock") }, matrix: [{ os: "linux", arch: "x64" }] };
    const id = (await owner("release.submit", { manifest }, "sub")).result.candidateId as string;
    const att = (await owner("release.issue", { candidateId: id, cell: { os: "linux", arch: "x64" }, hostId: "lx", workerId: builder.id, timeoutSeconds: 600, memoryMb: 2048 }, "iss")).result.attemptId as string;
    assert.ok((await call(builderToken, "release.report", { attemptId: att, sourceCommit: "c".repeat(40), suiteRevision: "s1", artifactHashes: artifacts, dependencyLockHashes: { lock: sha("lock") }, environment: { os: "linux", arch: "x64" }, outcome: "pass", counts: { passed: 1, failed: 0, skipped: 0 }, logDigest: sha("log"), summary: "ok" }, "rep")).ok);
    for (const [k, v] of Object.entries(files)) { mkdirSync(join(root, "incoming", id), { recursive: true }); writeFileSync(join(root, "incoming", id, k), v); }
    const staged = (await owner("release.stage", { candidateId: id }, "st")).result;
    assert.ok((await owner("release.approve", { candidateId: id }, "ap")).ok);

    // An agent cannot set a window; the owner's chat proposes one, with the digest from the staged record (never the interpreter's) and the time shown.
    assert.equal((await call(builderToken, "release.window.set", { candidateId: id, digest: staged.digest, date: "2030-01-01", time: "02:00", timeZone: "UTC", durationMinutes: 60 }, "bw")).error?.code, "forbidden");
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const time = now.toISOString().slice(11, 16);
    const text = `set a maintenance window for release ${id} today now for an hour, keep 0 bytes free`;
    const turn = async (mid: string, words: string, intents: unknown[]) => { say[words] = intents; return (await c.chat!.submit(boot.token, { messageId: mid, text: words })).outcomes; };
    const shown = await turn("m1", text, [{ kind: "command", op: "release.window.set", args: { candidateId: id, digest: sha("an invented digest"), date, time, timeZone: "UTC", durationMinutes: 60, minFreeBytes: 0 }, evidence: text, basis: "owner" }]);
    assert.equal(shown[0]!.status, "proposed", JSON.stringify(shown));
    assert.ok(JSON.stringify(shown[0]!.preview).includes(staged.digest), "the staged digest is filled in by the controller");
    assert.ok(!JSON.stringify(shown[0]!.preview).includes(sha("an invented digest")));
    assert.equal((await owner("release.window.list", {})).result.windows.length, 0, "a proposal sets nothing");
    const applied = await turn("m2", "yes, set it", [{ kind: "apply_proposal", proposalId: shown[0]!.proposalId, evidence: "set it", basis: "owner" }]);
    assert.equal(applied[0]!.status, "applied", JSON.stringify(applied));
    const listed = (await owner("release.window.list", {})).result.windows;
    assert.equal(listed.length, 1);
    const windowId = listed[0].windowId as string;
    assert.deepEqual([listed[0].status, listed[0].digest], ["scheduled", staged.digest]);

    // The sweep prepares and activates in one pass (the window is open, no attempt runs).
    const sweep = async () => { const t = await c.dispatch!.dispatcher.tick(); const loop = t.loops.find((x) => x.name === "release.windows"); assert.ok(loop?.ok === true, JSON.stringify(t.loops.filter((x) => !x.ok))); };
    await sweep();
    assert.equal((await owner("release.window.get", { windowId })).result.status, "activated");
    assert.equal((JSON.parse(readFileSync(join(root, "current.json"), "utf8")) as { release: string }).release, id);
    assert.equal((await owner("release.window.cancel", { windowId }, "cx")).error?.code, "invalid_transition", "an activated window is rolled back, not cancelled");
    assert.ok((await owner("release.confirm", { releaseId: id }, "cf")).ok);
    await sweep();
    await sweep();
    assert.equal((await owner("release.window.get", { windowId })).result.status, "committed");
    const items = (await NotificationService.withEpoch(c.storage, c.epoch, {}).inbox(rob)).items.filter((i) => i.ref.kind === "release-window");
    assert.equal(items.length, 1, JSON.stringify(items));
    assert.ok(existsSync(join(root, "current.json")));
    // The owner can ask about the windows in chat: a status answer in plain lines.
    const asked = "how are the maintenance windows doing";
    const answer = JSON.stringify(await turn("m3", asked, [{ kind: "status", request: { kind: "release_windows" }, evidence: asked, basis: "owner" }]));
    assert.ok(answer.includes(windowId) && answer.includes("committed"), answer);
  } finally { await c.close(); unlockAll(join(root, "releases")); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
