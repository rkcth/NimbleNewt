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

    // Loose words, no IDs typed (no magic phrases): "cancel the maintenance window" with none open says so; "install the update ..." takes the one staged release waiting to be installed, and the
    // proposal shows every number it would be set with (length, preparation lead, free space, the UTC instants); "cancel the maintenance window" then cancels the one open window.
    const none = await turn("l0", "cancel the maintenance window", [{ kind: "command", op: "release.window.cancel", args: {}, evidence: "cancel the maintenance window", basis: "owner" }]);
    assert.equal(none[0]!.status, "refused", JSON.stringify(none));
    assert.match(JSON.stringify(none), /No maintenance window is open/);
    const later = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const loose = "install the update the day after tomorrow at 3am London time for 90 minutes";
    const proposed = await turn("l1", loose, [{ kind: "command", op: "release.window.set", args: { date: later, time: "03:00", timeZone: "Europe/London", durationMinutes: 90 }, evidence: loose, basis: "owner" }]);
    assert.equal(proposed[0]!.status, "proposed", JSON.stringify(proposed));
    const seen = JSON.stringify(proposed[0]);
    for (const part of [id, staged.digest, "lasts 90 minutes", "60 (the default) minutes before", `${1024 ** 3} (the default) bytes free`, " UTC"]) assert.ok(seen.includes(part), `${part} in ${seen}`);
    const yes = await turn("l2", `yes, set that window ${proposed[0]!.proposalId}`, [{ kind: "apply_proposal", proposalId: proposed[0]!.proposalId, evidence: `set that window ${proposed[0]!.proposalId}`, basis: "owner" }]);
    assert.equal(yes[0]!.status, "applied", JSON.stringify(yes));
    const set = (await owner("release.window.list", {})).result.windows;
    assert.deepEqual(set.map((w: { candidateId: string; status: string; durationMinutes: number }) => [w.candidateId, w.status, w.durationMinutes]), [[id, "scheduled", 90]]);
    const cancelled = await turn("l3", "actually, cancel the maintenance window", [{ kind: "command", op: "release.window.cancel", args: {}, evidence: "cancel the maintenance window", basis: "owner" }]);
    assert.equal(cancelled[0]!.status, "applied", JSON.stringify(cancelled));
    assert.equal((await owner("release.window.get", { windowId: set[0].windowId })).result.status, "cancelled");
    // A window ID the owner never wrote is not taken from the interpreter.
    const invented = await turn("l4", "cancel that window", [{ kind: "command", op: "release.window.cancel", args: { windowId: set[0].windowId }, evidence: "cancel that window", basis: "owner" }]);
    assert.equal(invented[0]!.status, "refused", JSON.stringify(invented));
    // With two staged releases waiting, which one is asked, never guessed.
    const files2 = { "nn.js": "v2", "compat.json": files["compat.json"] };
    const artifacts2 = Object.fromEntries(Object.entries(files2).map(([k, v]) => [k, sha(v)]));
    const id2 = (await owner("release.submit", { manifest: { ...manifest, artifacts: artifacts2 } }, "sub2")).result.candidateId as string;
    const att2 = (await owner("release.issue", { candidateId: id2, cell: { os: "linux", arch: "x64" }, hostId: "lx", workerId: builder.id, timeoutSeconds: 600, memoryMb: 2048 }, "iss2")).result.attemptId as string;
    assert.ok((await call(builderToken, "release.report", { attemptId: att2, sourceCommit: "c".repeat(40), suiteRevision: "s1", artifactHashes: artifacts2, dependencyLockHashes: { lock: sha("lock") }, environment: { os: "linux", arch: "x64" }, outcome: "pass", counts: { passed: 1, failed: 0, skipped: 0 }, logDigest: sha("log"), summary: "ok" }, "rep2")).ok);
    for (const [k, v] of Object.entries(files2)) { mkdirSync(join(root, "incoming", id2), { recursive: true }); writeFileSync(join(root, "incoming", id2, k), v); }
    assert.ok((await owner("release.stage", { candidateId: id2 }, "st2")).ok);
    const two = await turn("l5", loose, [{ kind: "command", op: "release.window.set", args: { date: later, time: "03:00", timeZone: "Europe/London", durationMinutes: 90 }, evidence: loose, basis: "owner" }]);
    assert.equal(two[0]!.status, "refused", JSON.stringify(two));
    assert.ok(JSON.stringify(two).includes(id) && JSON.stringify(two).includes(id2) && /which one/.test(JSON.stringify(two)), JSON.stringify(two));

    // Every number the window would be set with is the owner's own: a length, a preparation lead or a free-space figure the interpreter added is refused and asked for, and nothing is proposed;
    // the same numbers said in the owner's own way ("from 3 to 5am", "start getting ready 30 minutes before", "make sure 5 GB is free") are proposed and shown.
    const base = { candidateId: id, date: later, time: "03:00", timeZone: "Europe/London" };
    const noLength = `put ${id} on the day after tomorrow at 3am London time`;
    const proposalsBefore = (await owner("release.window.list", {})).result.windows.length;
    for (const [mid, words, extra, why] of [
      ["q1", noLength, { durationMinutes: 60 }, /How long the maintenance window should last is not in your message/],
      ["q2", `${noLength} for an hour`, { durationMinutes: 90 }, /How long the maintenance window should last is not in your message/],
      ["q3", `${noLength} for an hour`, { durationMinutes: 60, prepareLeadMinutes: 30 }, /How early preparation should start is not in your message/],
      ["q4", `${noLength} for an hour`, { durationMinutes: 60, minFreeBytes: 5 * 1024 ** 3 }, /How much free space the update needs is not in your message/],
      ["q5", `${noLength} for an hour`, { durationMinutes: 60, healthDeadlineSeconds: 600 }, /How long the new release has to show it started well is not in your message/],
    ] as const) {
      const out = await turn(mid, words, [{ kind: "command", op: "release.window.set", args: { ...base, ...extra }, evidence: words, basis: "owner" }]);
      assert.equal(out[0]!.status, "refused", JSON.stringify(out));
      assert.match(JSON.stringify(out), why);
      assert.ok(!JSON.stringify(out).includes("proposalId\":\"prop-"), "nothing is proposed");
    }
    const said = `put ${id} on the day after tomorrow from 3 to 5am London time, start getting ready 30 minutes before and make sure 5 GB is free`;
    const ok = await turn("q6", said, [{ kind: "command", op: "release.window.set", args: { ...base, durationMinutes: 120, prepareLeadMinutes: 30, minFreeBytes: 5 * 1024 ** 3 }, evidence: said, basis: "owner" }]);
    assert.equal(ok[0]!.status, "proposed", JSON.stringify(ok));
    for (const part of ["lasts 120 minutes", "starts 30 minutes before", `needs ${5 * 1024 ** 3} bytes free`]) assert.ok(JSON.stringify(ok[0]).includes(part), `${part} in ${JSON.stringify(ok[0])}`);
    assert.equal((await owner("release.window.list", {})).result.windows.length, proposalsBefore, "a proposal sets nothing");

    const shown = await turn("m1", text, [{ kind: "command", op: "release.window.set", args: { candidateId: id, digest: sha("an invented digest"), date, time, timeZone: "UTC", durationMinutes: 60, minFreeBytes: 0 }, evidence: text, basis: "owner" }]);
    assert.equal(shown[0]!.status, "proposed", JSON.stringify(shown));
    assert.ok(JSON.stringify(shown[0]!.preview).includes(staged.digest), "the staged digest is filled in by the controller");
    assert.ok(!JSON.stringify(shown[0]!.preview).includes(sha("an invented digest")));
    assert.equal((await owner("release.window.list", {})).result.windows.length, 1, "a proposal sets nothing (only the cancelled window is there)");
    const applied = await turn("m2", `yes, set it ${shown[0]!.proposalId}`, [{ kind: "apply_proposal", proposalId: shown[0]!.proposalId, evidence: `set it ${shown[0]!.proposalId}`, basis: "owner" }]);
    assert.equal(applied[0]!.status, "applied", JSON.stringify(applied));
    const listed = (await owner("release.window.list", {})).result.windows.filter((w: { status: string }) => w.status !== "cancelled");
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

    // Once a release ran here it stays staged for going back, but it is never taken as "the update waiting": with the first release current, the loose words take the second one; once the second
    // was installed too (the first is now the previous release), nothing is waiting and the owner is told so instead of being offered the first one back.
    const next = await turn("n1", loose, [{ kind: "command", op: "release.window.set", args: { date: later, time: "03:00", timeZone: "Europe/London", durationMinutes: 90 }, evidence: loose, basis: "owner" }]);
    assert.equal(next[0]!.status, "proposed", JSON.stringify(next));
    assert.ok(JSON.stringify(next[0]).includes(`Release ${id2}`) && !JSON.stringify(next[0]).includes(`Release ${id}:`), JSON.stringify(next[0]));
    assert.ok((await owner("release.approve", { candidateId: id2 }, "ap2")).ok);
    const digest2 = (await owner("release.verify", { releaseId: id2 })).result.digest as string;
    assert.ok((await owner("release.activate", { candidateId: id2, digest: digest2 }, "ac2")).ok);
    assert.equal((await owner("release.status", {})).result.item.previous?.id, id);
    const after = await turn("n2", loose, [{ kind: "command", op: "release.window.set", args: { date: later, time: "03:00", timeZone: "Europe/London", durationMinutes: 90 }, evidence: loose, basis: "owner" }]);
    assert.equal(after[0]!.status, "refused", JSON.stringify(after));
    assert.match(JSON.stringify(after), /No staged release is waiting/);
  } finally { await c.close(); unlockAll(join(root, "releases")); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
