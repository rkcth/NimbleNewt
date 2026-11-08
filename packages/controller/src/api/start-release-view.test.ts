import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startController } from "./index.js";

const ext4 = async () => ({ type: "ext4" as const, network: false });
const supported = { platform: "linux" as const, arch: "x64" as const, osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const h = (c: string): string => c.repeat(64);
const linux = { os: "linux" as const, arch: "x64" as const };

/**
 * The owner's `release` status view through the running controller (card X09b part 2 review, item 8): `startController` wires the release reads and the staging state into StatusService, so
 * `status.ask` with `{ kind: "release" }` answers on the real wiring — the same answer the owner gets by chat, over the same records.
 */
test("the release status view answers through startController: the gate per platform, the attempts newest first, the staging line, and nothing at all to a worker", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-release-view-"));
  const open = () => startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4 });
  try {
    const c = await open();
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    await c.services.principals.enroll(rob, { commandId: "e1", kind: "agent", name: "tester", grants: [{ action: "release.report", project: "*" }] });
    const testerToken = (await c.services.principals.issueCredential(rob, "agent:tester")).token;
    const tester = await c.services.principals.authenticate(testerToken);
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
    const manifest = { sourceCommit: "a".repeat(40), suiteRevision: "s1", artifacts: { "a.tgz": h("1") }, dependencyLocks: { "lock": h("2") }, matrix: [linux, { os: "win32" as const, arch: "x64" as const }] };
    const sub = await call(boot.token, "release.submit", { manifest }, "r1");
    assert.equal(sub.ok, true, JSON.stringify(sub));
    const candidateId = sub.result.candidateId as string;
    assert.equal((await call(boot.token, "release.host", { hostId: "host:rig", os: "linux", arch: "x64" }, "r2")).ok, true);
    const first = await call(boot.token, "release.issue", { candidateId, cell: linux, hostId: "host:rig", workerId: tester.id, timeoutSeconds: 600, memoryMb: 2048 }, "r3");
    assert.equal(first.ok, true, JSON.stringify(first));
    // The platform's first attempt fails and the retry passes: the view calls that flaky, and lists the newer attempt first.
    const report = (attemptId: string, extra: Record<string, unknown>) => ({
      attemptId, sourceCommit: "a".repeat(40), suiteRevision: "s1", artifactHashes: { "a.tgz": h("1") }, dependencyLockHashes: { "lock": h("2") }, environment: linux,
      outcome: "pass", counts: { passed: 9, failed: 0, skipped: 0 }, logDigest: h("5"), summary: "ok", ...extra,
    });
    assert.equal((await call(testerToken, "release.report", report(first.result.attemptId, { outcome: "fail", counts: { passed: 7, failed: 2, skipped: 0 }, summary: "two failed" }), "r4")).ok, true);
    const second = await call(boot.token, "release.issue", { candidateId, cell: linux, hostId: "host:rig", workerId: tester.id, timeoutSeconds: 600, memoryMb: 2048 }, "r5");
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal((await call(testerToken, "release.report", report(second.result.attemptId, { summary: "green on the retry" }), "r6")).ok, true);

    const view = await call(boot.token, "status.ask", { request: { kind: "release", candidateId } });
    assert.equal(view.ok, true, JSON.stringify(view));
    const lines = view.result.item.lines as { text: string; cites: { kind: string; id: string }[] }[];
    const text = lines.map((l) => l.text).join("\n");
    assert.match(text, new RegExp(`Candidate ${candidateId}: not approved`), "the approval state is there");
    assert.match(text, /"linux x64": flaky pass \(passed only after 1 earlier failure\) \(2 attempts\)/, "the flaky platform is labelled");
    assert.match(text, /"win32 x64": not run \(0 attempts\)/, "a platform with no attempt is said, not left out");
    const attempts = lines.filter((l) => l.text.startsWith("  attempt "));
    assert.equal(attempts.length, 2);
    assert.ok(attempts[0]!.text.includes(second.result.attemptId), "the newest attempt is shown first");
    assert.match(attempts[0]!.text, /the host said "green on the retry"/, "what the host reported is quoted, not followed");
    assert.match(text, /^Staging: /m, "the staging line is part of the owner's answer");
    assert.ok(lines.every((l) => l.cites.length > 0), "every line says which records it comes from");
    assert.ok(lines.length <= 30, "the answer stays bounded");

    // The list view (no candidate named) and the staging state on a controller that stages nothing.
    const list = await call(boot.token, "status.ask", { request: { kind: "release" } });
    assert.equal(list.ok, true, JSON.stringify(list));
    assert.match((list.result.item.lines as { text: string }[]).map((l) => l.text).join("\n"), new RegExp(`Candidate ${candidateId}`), "the list view names the candidate");

    // A worker may not read release records: the view it gets is exactly the view that does not exist.
    const denied = await call(testerToken, "status.ask", { request: { kind: "release" } });
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "not_found");

    // A candidate that is not there reads exactly like a view that does not exist, whatever asked it.
    const missing = await call(boot.token, "status.ask", { request: { kind: "release", candidateId: "rcn-not-a-candidate" } });
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, "not_found");
    await c.close();
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
