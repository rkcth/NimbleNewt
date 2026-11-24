import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { NotificationService } from "../notifications/index.js";
import { RemoteWorkerClient } from "../remote/index.js";
import { RELEASE_LIMITS, ReleaseService, releaseDeadline } from "../release/index.js";
import { StatusService } from "../status/index.js";
import { releaseNoticeText } from "./dispatch-compose.js";
import { startController } from "./index.js";

/**
 * The outer watch over a release host (card X09b), on a running controller with the real worker transport: a host that took a release test and then stopped sending heartbeats is told to the owner once per
 * silence, the owner's release view (the one the chat answers from) says for a running test when its host was last heard and when it ends as timed out, and the timed-out notice reaches the owner even for a
 * host with a long name (it used to pass the notice limit and be dropped). Nothing here ends a test early: a reboot test silences its host on purpose.
 */
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
const linux = { os: "linux", arch: "x64" } as const;
const h = (c: string): string => c.repeat(64);
const COMMIT = "a".repeat(40);
const MIN = 60_000;
/** The longest host name the controller accepts (40 characters after `host:`). */
const LONG = "a-very-long-release-test-machine-name-01";

async function rig(clock: () => string, dir?: string) {
  const d = dir ?? mkdtempSync(join(tmpdir(), "nn-x09b-watch-"));
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    chat: { interpreter: new ScriptedInterpreter(() => []) },
    // The notification service reads the same fake clock as the dispatcher: left on the real clock it closed any notice older than its seven-day retention by the real date, so these tests passed only while the fake date was within a week of the real one.
    notifications: { clock },
    dispatch: { timer: new ManualTimer(), intervalMs: 1000, clock, route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: false } }), remote: { blobDirectory: join(d, "blobs"), hosts: [] } },
  } as never);
  assert.ok(c.dispatch?.workerUrl !== undefined, c.dispatchProblem);
  // A second start on the same data folder (a restart) signs in with the owner credential the first one made.
  const boot = dir === undefined ? await c.services.principals.bootstrapOwner({ name: "rob" }) : { token: ownerTokens.get(d)! };
  ownerTokens.set(d, boot.token);
  const rob = await c.services.principals.authenticate(boot.token);
  const host = async (name: string) => {
    await c.services.principals.enroll(rob, { commandId: `e-${name}`, kind: "host", name, grants: [] });
    const token = (await c.services.principals.issueCredential(rob, `host:${name}`)).token;
    return new RemoteWorkerClient({ url: c.dispatch!.workerUrl!, token, workerVersion: "release-host-test" });
  };
  const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string; message: string } }>;
  const inbox = async (about: string) => (await NotificationService.withEpoch(c.storage, c.epoch).inbox(rob)).items.filter((i) => JSON.stringify(i).includes(about));
  const view = async (candidateId: string) => {
    const v = await call("status.ask", { request: { kind: "release", candidateId } });
    assert.ok(v.ok, JSON.stringify(v));
    return (v.result.item.lines as { text: string }[]).map((l) => l.text);
  };
  return { c, d, rob, call, host, inbox, view, stop: () => c.close(), close: async () => { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } };
}
const ownerTokens = new Map<string, string>();

test("a host that took a release test and went quiet is told to the owner once per silence; the release view says when it was last heard and when the test ends; nothing is ended early (card X09b watch)", async () => {
  let now = Date.parse("2026-11-17T10:00:00.000Z");
  const w = await rig(() => new Date(now).toISOString());
  try {
    const manifest = { sourceCommit: COMMIT, suiteRevision: "suite-7", artifacts: { "nimblenewt.tgz": h("1") }, dependencyLocks: { "package-lock.json": h("2") }, matrix: [linux] };
    const candidateId = (await w.call("release.submit", { manifest }, "sub1")).result.candidateId as string;
    assert.ok((await w.call("release.host", { hostId: "host:rig", os: "linux", arch: "x64" }, "hst1")).ok);
    const client = await w.host("rig");
    await client.connect({ ...CAPS } as never);
    const started = await w.call("release.start", { candidateId, cell: linux, hostId: "host:rig", timeoutSeconds: 3600 }, "go1");
    assert.ok(started.ok, JSON.stringify(started));
    const attemptId = started.result.attemptId as string;

    // Not picked up yet: the view says it waits for the host, and when it would end.
    let lines = await w.view(candidateId);
    const issuedAt = new Date(now).toISOString();
    const line = (all: string[]) => all.find((l) => l.startsWith(`  attempt ${attemptId}`)) ?? "";
    assert.match(line(lines), /waiting for the host to pick it up/);
    assert.ok(line(lines).includes(`ends as timed out at ${releaseDeadline({ issuedAt, limits: { timeoutSeconds: 3600, memoryMb: 1 } })}`), line(lines));

    now += MIN;
    await client.releasePickUp(attemptId);
    const pickedAt = new Date(now).toISOString();
    await client.heartbeat(1);
    const heardAt = new Date(now).toISOString();
    lines = await w.view(candidateId);
    assert.ok(line(lines).includes(`picked up ${pickedAt}`), line(lines));
    assert.ok(line(lines).includes(`the host was last heard ${heardAt}`), line(lines));
    const ends = releaseDeadline({ issuedAt, pickedUpAt: pickedAt, limits: { timeoutSeconds: 3600, memoryMb: 1 } });
    assert.ok(line(lines).includes(`ends as timed out at ${ends}`), line(lines));
    // The heartbeat time is the owner's alone: an owner object limited to one task reads the view exactly as a view that does not exist, as the other owner-only views do (second review).
    const status = StatusService.withEpoch(w.c.storage, w.c.epoch, { release: ReleaseService.withEpoch(w.c.storage, w.c.epoch) } as never);
    assert.ok((await status.releaseLines(w.rob, { candidateId }))?.lines.some((l) => l.text.includes(`the host was last heard ${heardAt}`)));
    assert.equal(await status.releaseLines({ ...w.rob, taskScope: { taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: "proj-aaaaaaaaaaaaaaaaaaaa" } }, { candidateId }), undefined);

    // Inside the quiet threshold: nothing said.
    now += RELEASE_LIMITS.silentSeconds * 1000 - MIN;
    await w.c.dispatch!.dispatcher.tick();
    assert.equal((await w.inbox(attemptId)).length, 0);
    // Past it: one notice, which names the test, the platform, when the host was last heard and when it ends; ticking again says nothing more.
    now += 2 * MIN;
    await w.c.dispatch!.dispatcher.tick();
    await w.c.dispatch!.dispatcher.tick();
    let told = await w.inbox(attemptId);
    assert.equal(told.length, 1, "told once");
    const said = JSON.stringify(told[0]);
    assert.match(said, /went quiet/);
    assert.match(said, /"level":"notice"/, "told as a notice, not folded into another item");
    assert.match(said, /"ref":\{"id":"[^"]+","kind":"release-silence"\}/);
    assert.ok(said.includes(heardAt.slice(0, 16).replace("T", " ")), said);
    assert.ok(said.includes(ends.slice(0, 16).replace("T", " ")), said);
    assert.match(said, /host:rig/);
    assert.equal((await w.call("release.attempts", { candidateId })).result.attempts[0].state, "issued", "the watch ends nothing");

    // The host comes back, then goes quiet again: a second notice for the second silence.
    await client.heartbeat(2);
    await w.c.dispatch!.dispatcher.tick();
    assert.equal((await w.inbox(attemptId)).length, 1);
    now += RELEASE_LIMITS.silentSeconds * 1000 + MIN;
    await w.c.dispatch!.dispatcher.tick();
    await w.c.dispatch!.dispatcher.tick();
    told = await w.inbox(attemptId);
    assert.equal(told.length, 1, "the silences of one test gather on one item");
    assert.equal((told[0] as unknown as { count: number }).count, 2, "a new silence is told again (counted); the same one never twice");
    const firstSaid = said;

    // A result ends the watch: the test passed, and no further notice comes however long the host stays quiet.
    await client.releaseReport(attemptId, { sourceCommit: COMMIT, suiteRevision: "suite-7", artifactHashes: { "nimblenewt.tgz": h("1") }, dependencyLockHashes: { "package-lock.json": h("2") }, environment: linux, outcome: "pass", counts: { passed: 3, failed: 0, skipped: 0 }, logDigest: h("9"), summary: "green" } as never);
    assert.equal((await w.call("release.attempts", { candidateId })).result.attempts[0].state, "passed");
    now += 30 * MIN;
    await w.c.dispatch!.dispatcher.tick();
    told = await w.inbox(attemptId);
    assert.equal(told.length, 1);
    assert.equal((told[0] as unknown as { count: number }).count, 2, "nothing more after the result");
    assert.notEqual(JSON.stringify(told[0]), firstSaid);
    lines = await w.view(candidateId);
    assert.doesNotMatch(line(lines), /last heard|ends as timed out/, "an ended test says neither");
  } finally { await w.close(); }
});

test("the timed-out notice reaches the owner for a host with the longest name allowed (it used to pass the 200-character notice limit and be dropped) (card X09b watch)", async () => {
  let now = Date.parse("2026-11-17T10:00:00.000Z");
  const w = await rig(() => new Date(now).toISOString());
  try {
    const manifest = { sourceCommit: COMMIT, suiteRevision: "suite-7", artifacts: { "nimblenewt.tgz": h("1") }, dependencyLocks: { "package-lock.json": h("2") }, matrix: [linux] };
    const candidateId = (await w.call("release.submit", { manifest }, "sub1")).result.candidateId as string;
    assert.ok((await w.call("release.host", { hostId: `host:${LONG}`, os: "linux", arch: "x64" }, "hst1")).ok);
    const client = await w.host(LONG);
    await client.connect({ ...CAPS } as never);
    const started = await w.call("release.start", { candidateId, cell: linux, hostId: `host:${LONG}`, timeoutSeconds: 60 }, "go1");
    assert.ok(started.ok, JSON.stringify(started));
    const attemptId = started.result.attemptId as string;
    await client.releasePickUp(attemptId);
    now += 6 * MIN;
    await w.c.dispatch!.dispatcher.tick();
    const quiet = await w.inbox(attemptId);
    assert.equal(quiet.length, 1, "the quiet notice is sent for a long name too");
    now += (60 + RELEASE_LIMITS.graceSeconds) * 1000;
    await w.c.dispatch!.dispatcher.tick();
    assert.equal((await w.call("release.attempts", { candidateId })).result.attempts[0].state, "timed_out");
    const told = await w.inbox(attemptId);
    assert.equal(told.length, 2, "the timed-out notice is not lost to its length (its own item, beside the quiet one)");
    assert.match(JSON.stringify(told), new RegExp(`host:${LONG}: silent since`), "the whole host name fits in the quiet notice");
    const out = told.find((i) => JSON.stringify(i).includes("ended as timed out, not passed")) as unknown as { ref: { kind: string; id: string }; level: string; count: number } | undefined;
    assert.ok(out !== undefined, JSON.stringify(told));
    // Its own item, pointing at the test: under the dispatcher's own name it was gathered with any other dispatcher notice and its text or level could be replaced by theirs.
    assert.deepEqual([out.ref, out.level, out.count], [{ kind: "release-attempt", id: attemptId }, "notice", 1]);
  } finally { await w.close(); }
});

test("a release notice is cut to the notice limit by whole characters, never refused for its length (card X09b watch)", () => {
  assert.equal(releaseNoticeText("short"), "short");
  const long = `${"x".repeat(195)}😀😀😀`;
  const cut = releaseNoticeText(long);
  assert.ok(cut.length <= 200, String(cut.length));
  assert.ok(cut.endsWith("…"));
  assert.doesNotMatch(cut, /[\ud800-\udbff](?![\udc00-\udfff])/, "no half of a character is left");
  assert.equal(releaseNoticeText("y".repeat(200)), "y".repeat(200));
  assert.equal(releaseNoticeText("y".repeat(201)).length, 200);
});

test("a silence already told is not told again after the controller restarts, and a new one after the restart is (card X09b watch, first review)", async () => {
  let now = Date.parse("2026-11-17T10:00:00.000Z");
  const clock = () => new Date(now).toISOString();
  const w = await rig(clock);
  let again: Awaited<ReturnType<typeof rig>> | undefined;
  try {
    const manifest = { sourceCommit: COMMIT, suiteRevision: "suite-7", artifacts: { "nimblenewt.tgz": h("1") }, dependencyLocks: { "package-lock.json": h("2") }, matrix: [linux] };
    const candidateId = (await w.call("release.submit", { manifest }, "sub1")).result.candidateId as string;
    assert.ok((await w.call("release.host", { hostId: "host:rig", os: "linux", arch: "x64" }, "hst1")).ok);
    const client = await w.host("rig");
    await client.connect({ ...CAPS } as never);
    const attemptId = (await w.call("release.start", { candidateId, cell: linux, hostId: "host:rig", timeoutSeconds: 3600 }, "go1")).result.attemptId as string;
    await client.releasePickUp(attemptId);
    now += RELEASE_LIMITS.silentSeconds * 1000 + MIN;
    await w.c.dispatch!.dispatcher.tick();
    assert.equal(((await w.inbox(attemptId))[0] as unknown as { count: number } | undefined)?.count, 1);
    await w.stop();
    // The new controller remembers nothing in memory: the notice's command ID is what keeps the same silence to one notice.
    again = await rig(clock, w.d);
    await again.c.dispatch!.dispatcher.tick();
    await again.c.dispatch!.dispatcher.tick();
    let told = await again.inbox(attemptId);
    assert.equal(told.length, 1);
    assert.equal((told[0] as unknown as { count: number }).count, 1, "the same silence is not told again after a restart");
    // The host comes back to the restarted controller (a new credential: the old address is gone), then goes quiet again.
    const owner = await again.c.services.principals.authenticate(ownerTokens.get(w.d)!);
    const client2 = new RemoteWorkerClient({ url: again.c.dispatch!.workerUrl!, token: (await again.c.services.principals.issueCredential(owner, "host:rig")).token, workerVersion: "release-host-test" });
    await client2.connect({ ...CAPS } as never);
    await client2.heartbeat(1);
    now += RELEASE_LIMITS.silentSeconds * 1000 + MIN;
    await again.c.dispatch!.dispatcher.tick();
    told = await again.inbox(attemptId);
    assert.equal((told[0] as unknown as { count: number }).count, 2, "a new silence after the restart is told");
  } finally { if (again !== undefined) await again.close(); else await w.close(); }
});

test("the timed-out notice shows a host name with control or bidirectional characters escaped (card X09b watch, first review)", async () => {
  let now = Date.parse("2026-11-17T10:00:00.000Z");
  const w = await rig(() => new Date(now).toISOString());
  try {
    const manifest = { sourceCommit: COMMIT, suiteRevision: "suite-7", artifacts: { "nimblenewt.tgz": h("1") }, dependencyLocks: { "package-lock.json": h("2") }, matrix: [linux] };
    const candidateId = (await w.call("release.submit", { manifest }, "sub1")).result.candidateId as string;
    // The owner may authorize a release host under any name; a test issued to it and never picked up still ends as timed out and is told.
    const name = "lab\u202egpj.exe\u0085box";
    assert.ok((await w.call("release.host", { hostId: name, os: "linux", arch: "x64" }, "hst1")).ok);
    const started = await w.call("release.start", { candidateId, cell: linux, hostId: name, timeoutSeconds: 60 }, "go1");
    assert.ok(started.ok, JSON.stringify(started));
    const attemptId = started.result.attemptId as string;
    now += (60 + RELEASE_LIMITS.graceSeconds) * 1000 + MIN;
    await w.c.dispatch!.dispatcher.tick();
    const told = await w.inbox(attemptId);
    assert.equal(told.length, 1, JSON.stringify(told));
    const detail = (told[0] as unknown as { detail: string }).detail;
    assert.ok(detail.includes("Host: lab\\u202egpj.exe\\u0085box"), detail);
    assert.doesNotMatch(detail, /[\u202e\u0085]/);
  } finally { await w.close(); }
});

test("the timed-out notice reaches the owner whatever date the controller's clock shows, even one months before the machine's own date (a fixed fake date went stale a week after it was written)", async () => {
  // A clock thirty days behind the real one: the notice retention (seven days) is counted on the controller's own clock, so the notice is not closed as old.
  let now = Date.now() - 30 * 24 * 60 * MIN;
  const w = await rig(() => new Date(now).toISOString());
  try {
    const manifest = { sourceCommit: COMMIT, suiteRevision: "suite-7", artifacts: { "nimblenewt.tgz": h("1") }, dependencyLocks: { "package-lock.json": h("2") }, matrix: [linux] };
    const candidateId = (await w.call("release.submit", { manifest }, "sub1")).result.candidateId as string;
    assert.ok((await w.call("release.host", { hostId: "host:rig", os: "linux", arch: "x64" }, "hst1")).ok);
    const attemptId = (await w.call("release.start", { candidateId, cell: linux, hostId: "host:rig", timeoutSeconds: 60 }, "go1")).result.attemptId as string;
    now += (60 + RELEASE_LIMITS.graceSeconds) * 1000 + MIN;
    await w.c.dispatch!.dispatcher.tick();
    await w.c.dispatch!.dispatcher.tick();
    assert.equal((await w.inbox(attemptId)).length, 1);
  } finally { await w.close(); }
});
