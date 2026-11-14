import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ReleaseService } from "../release/index.js";
import { openWorld, options } from "./testing/harness.js";

after(stopServer);

/**
 * Submitting a release candidate by free-form chat (card X09b finish). The owner states the commit, the suite revision, the hashes and the platforms in their own words; the chat shows the candidate with every
 * platform first (a platform left out would never be tested, so approval would not need it) and records it only when the owner agrees. Nothing the owner did not say reaches the record: a hash, commit or suite
 * revision the model supplied, or a platform the owner never named, is refused. Real StateApi, ReleaseService and chat on every storage backend.
 */
const COMMIT = "a".repeat(40);
const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const words = `Get build ${COMMIT} tested: suite revision suite-7, artifact nimblenewt.tgz ${H1}, lock file package-lock.json ${H2}, on linux x64 and windows x64.`;
const manifest = (extra: Record<string, unknown> = {}) => ({ sourceCommit: COMMIT, suiteRevision: "suite-7", artifacts: { "nimblenewt.tgz": H1 }, dependencyLocks: { "package-lock.json": H2 }, matrix: [{ os: "linux", arch: "x64" }, { os: "win32", arch: "x64" }], ...extra });

for (const backend of backends) {
  test(`${backend.name}: chat shows a release candidate with its platforms first and records it only on the owner's word; values and platforms the owner did not say are refused (card X09b finish)`, async () => {
    const script: Record<string, unknown[]> = {};
    let release!: ReleaseService;
    const w = await openWorld(backend, script, undefined, (storage, epoch) => { release = ReleaseService.withEpoch(storage, epoch, options); return { release }; });
    try {
      const chat = w.chat({});
      const owner = w.owner;
      const turn = async (id: string, text: string, intents: unknown[]) => { script[text] = intents; return (await chat.submit(w.ownerToken, { messageId: id, text })).outcomes as unknown as { status: string; code?: string; message?: string; preview?: string; summary?: string; proposalId?: string }[]; };
      const cmd = (args: Record<string, unknown>, text: string) => ({ kind: "command", op: "release.submit", args, evidence: text, basis: "owner" });
      const listed = async () => (await release.candidates(owner, { limit: 10 })).candidates;

      // Shown first: both platforms are on the line, and nothing is recorded yet.
      const shown = await turn("s1", words, [cmd({ manifest: manifest() }, words)]);
      assert.equal(shown[0]!.status, "proposed", JSON.stringify(shown[0]));
      const line = JSON.stringify(shown[0]);
      assert.match(line, /linux x64 and win32 x64/, "every platform is on the line");
      assert.match(line, /1 artifact hash/);
      assert.equal((await listed()).length, 0, "nothing is recorded while the proposal waits");

      // The owner agrees: exactly the platforms they named are recorded.
      const done = await turn("s2", "yes, go ahead", [{ kind: "apply_proposal", proposalId: shown[0]!.proposalId, evidence: "go ahead", basis: "owner" }]);
      assert.equal(done[0]!.status, "applied", JSON.stringify(done[0]));
      const made = await listed();
      assert.equal(made.length, 1);
      const gate = await release.gate(owner, made[0]!.candidateId);
      assert.deepEqual(gate.cells.map((c) => `${c.cell.os}/${c.cell.arch}`).sort(), ["linux/x64", "win32/x64"]);

      // A platform the owner never named (the model added the mac) is refused and says what to answer; nothing is recorded.
      const extra = await turn("s3", `Again (1). ${words}`, [cmd({ manifest: manifest({ matrix: [{ os: "linux", arch: "x64" }, { os: "win32", arch: "x64" }, { os: "darwin", arch: "arm64" }] }) }, words)]);
      assert.equal(extra[0]!.status, "refused", JSON.stringify(extra[0]));
      assert.equal(extra[0]!.code, "unsupported_value");
      assert.match(extra[0]!.message!, /darwin/);
      // A platform the owner left out cannot be dropped by the model either way: a matrix with only one of two named is shown as it is, so the owner sees what will be required (and can refuse it).
      const fewer = await turn("s4", `Again (2). ${words}`, [cmd({ manifest: manifest({ matrix: [{ os: "linux", arch: "x64" }] }) }, words)]);
      assert.equal(fewer[0]!.status, "proposed");
      assert.match(JSON.stringify(fewer[0]), /must pass on linux x64;/, "the single platform is what the owner is shown");
      assert.doesNotMatch(JSON.stringify(fewer[0]), /win32/);

      // A hash or a commit the owner did not write is refused.
      const invented = await turn("s5", `Again (3). ${words}`, [cmd({ manifest: manifest({ artifacts: { "nimblenewt.tgz": "3".repeat(64) } }) }, words)]);
      assert.equal(invented[0]!.status, "refused");
      assert.equal(invented[0]!.code, "unsupported_value");
      const commit = await turn("s6", `Again (4). ${words}`, [cmd({ manifest: manifest({ sourceCommit: "b".repeat(40) }) }, words)]);
      assert.equal(commit[0]!.code, "unsupported_value");
      assert.equal((await listed()).length, 1, "none of the refused ones were recorded");

      // The same words again are the same candidate (immutable and idempotent).
      const sevenWords = `Once more (5). ${words}`;
      const again = await turn("s7", sevenWords, [cmd({ manifest: manifest() }, sevenWords)]);
      assert.equal(again[0]!.status, "proposed", JSON.stringify(again[0]));
      const applied = await turn("s8", "yes, go ahead with that one", [{ kind: "apply_proposal", proposalId: again[0]!.proposalId, evidence: "go ahead with that one", basis: "owner" }]);
      assert.equal(applied[0]!.status, "applied", JSON.stringify(applied[0]));
      assert.equal((await listed()).length, 1, "the same manifest is the same candidate");

      // The installations it may go to and a migration plan bind what may later be staged: when the owner names them they are on the line too (card X09b finish review).
      const H3 = "3".repeat(64);
      const targeted = `Once more (6). ${words} Only for prod-eu, migration plan ${H3}.`;
      const withTargets = await turn("s9", targeted, [cmd({ manifest: manifest({ targets: ["prod-eu"], migrationPlan: H3 }) }, targeted)]);
      assert.equal(withTargets[0]!.status, "proposed", JSON.stringify(withTargets[0]));
      assert.match(JSON.stringify(withTargets[0]), /only for prod-eu; migration plan 3{64}/);
    } finally { await w.close(); }
  });
}
