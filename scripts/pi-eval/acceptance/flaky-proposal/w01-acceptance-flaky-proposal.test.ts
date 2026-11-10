import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BlockerService } from "../domain/blockers.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ReleaseService } from "../release/index.js";
import { StatusService } from "../status/index.js";
import * as commands from "./commands.js";
import { cid, openWorld, options } from "./testing/harness.js";

// W01 acceptance for flaky-proposal: what the task text and its CONTRACT pin, derived from the card's shipped tests
// (chat/release-owner-words.test.ts and chat/release-words.test.ts).

after(stopServer);

type Reply = { ok: boolean; result?: any; error?: { code: string; message?: string } };
const h = (c: string): string => c.repeat(64);
const linux = { os: "linux", arch: "x64" } as const;

test("the keyword scan is gone: chat/commands.ts no longer exports saysAcknowledgeFlaky", () => {
  assert.equal("saysAcknowledgeFlaky" in commands, false);
  // The whole-word ID check stays.
  const id = { candidateId: "rcn-1a2b" };
  const whole = "approve rcn-1a2b now";
  const longer = "approve rcn-1a2b3 now";
  assert.equal(commands.foreignValue(id, whole, "", commands.RELEASE_ID_KEYS), undefined);
  assert.notEqual(commands.foreignValue(id, longer, "", commands.RELEASE_ID_KEYS), undefined);
});

for (const backend of backends) {
  test(`${backend.name}: a flaky release approval in ordinary words is a proposal showing the failures; only the owner's confirmation applies it`, async () => {
    const script: Record<string, unknown[]> = {};
    let status!: StatusService;
    const w = await openWorld(backend, script, undefined, (storage, epoch, built) => {
      const release = ReleaseService.withEpoch(storage, epoch, options);
      status = StatusService.withEpoch(storage, epoch, { assignments: built.assignments, waits: built.waits, blockers: BlockerService.withEpoch(storage, epoch, options), contracts: built.contracts, release }, options);
      return { release, status };
    });
    try {
      const chat = w.chat({ status });
      const turn = async (id: string, text: string, intents: unknown[]) => {
        script[text] = intents;
        const outcomes = (await chat.submit(w.ownerToken, { messageId: id, text })).outcomes;
        for (const o of outcomes) assert.equal(JSON.stringify(o).includes("acknowledgeFlaky"), false, `a user-visible outcome mentions acknowledgeFlaky: ${JSON.stringify(o)}`);
        return outcomes;
      };
      const approve = (id: string, words: string, args: Record<string, unknown>) => turn(id, words, [{ kind: "command", op: "release.approve", args, evidence: words, basis: "owner" }]);
      const confirm = (id: string, proposalId: string | undefined) => turn(id, "yes, approve it", [{ kind: "apply_proposal", proposalId, evidence: "approve it", basis: "owner" }]);
      const callAs = (token: string, op: string, args: Record<string, unknown>): Promise<Reply> => w.api.handle(token, { v: 1, op, ...(op === "release.gate" || op === "release.attempts" ? {} : { commandId: cid("x") }), args } as never) as never;
      const call = (op: string, args: Record<string, unknown>): Promise<Reply> => callAs(w.ownerToken, op, args);
      const gate = async (candidateId: string): Promise<any> => (await call("release.gate", { candidateId })).result["gate"];
      const stepArgs = async (proposalId: string | undefined): Promise<Record<string, unknown>> => JSON.parse(JSON.stringify((await chat.getProposal(w.ownerToken, proposalId!))!.steps[0]!.args)) as Record<string, unknown>;
      const submit = async (commit: string): Promise<string> => (await call("release.submit", { manifest: { sourceCommit: commit.repeat(40), suiteRevision: "suite-7", artifacts: { "nimblenewt.tgz": h("1") }, dependencyLocks: { "package-lock.json": h("2") }, matrix: [linux] } })).result!["candidateId"] as string;
      const report = (attemptId: string, commit: string, extra: Record<string, unknown> = {}) => ({
        attemptId, sourceCommit: commit.repeat(40), suiteRevision: "suite-7", artifactHashes: { "nimblenewt.tgz": h("1") }, dependencyLockHashes: { "package-lock.json": h("2") },
        environment: linux, outcome: "pass", counts: { passed: 12, failed: 0, skipped: 1 }, logDigest: h("9"), summary: "all green", ...extra,
      });
      const failed = { outcome: "fail", counts: { passed: 9, failed: 3, skipped: 0 }, summary: "three tests failed" };
      const worker = await w.agent("rigged", [{ action: "release.report", project: "*" }]);
      const hostWords = "let host:rig run release tests on linux x64";
      const hostShown = await turn("f1", hostWords, [{ kind: "command", op: "release.host", args: { hostId: "host:rig", os: "linux", arch: "x64" }, evidence: hostWords, basis: "owner" }]);
      assert.equal((await turn("f2", "yes, authorize it", [{ kind: "apply_proposal", proposalId: hostShown[0]!.proposalId, evidence: "authorize it", basis: "owner" }]))[0]!.status, "applied");
      const issue = async (candidateId: string) => {
        const r = await call("release.issue", { candidateId, cell: linux, hostId: "host:rig", workerId: worker.principal.id, timeoutSeconds: 600, memoryMb: 512 });
        assert.ok(r.ok, JSON.stringify(r));
        return r.result!["attemptId"] as string;
      };
      const reported = async (attemptId: string, commit: string, extra: Record<string, unknown> = {}) => assert.ok((await callAs(worker.token, "release.report", report(attemptId, commit, extra))).ok);
      await new Promise((r) => setTimeout(r, 1100));

      // A candidate whose linux x64 passed only after one failed attempt.
      const cand = await submit("a");
      const sick = await issue(cand);
      await reported(sick, "a", failed);
      await reported(await issue(cand), "a");
      assert.equal((await gate(cand)).needsAcknowledgement, true);

      // (a) Ordinary words, no acknowledgement from anyone: proposed, showing the failed attempt; nothing approved while it waits.
      const shipWords = `yeah ship the release candidate ${cand}, I've seen those failures are just noise`;
      const shipShown = await approve("m1", shipWords, { candidateId: cand });
      assert.equal(shipShown[0]!.status, "proposed", `an approval in ordinary words is proposed, not refused: ${JSON.stringify(shipShown[0])}`);
      assert.ok(shipShown[0]!.proposalId !== undefined);
      const shipPreview = (shipShown[0]!.preview ?? []).join(" ");
      assert.match(shipPreview, /linux x64 passed only after 1 earlier failure/, shipPreview);
      assert.match(shipPreview, new RegExp(sick), "the preview names the attempt that failed");
      assert.match(shipPreview, /gate.*(differ|chang).*confirm|confirm.*gate.*(differ|chang)/i, `the preview says a gate that moved by the confirmation is refused: ${shipPreview}`);
      assert.match(shipPreview, /refuse/i, shipPreview);
      const shipArgs = await stepArgs(shipShown[0]!.proposalId);
      assert.equal(shipArgs["candidateId"], cand, JSON.stringify(shipArgs));
      assert.equal(shipArgs["acknowledgeFlaky"], true, JSON.stringify(shipArgs));
      assert.deepEqual(shipArgs["expectedFailures"], [sick], "the approval is bound to the chat's own reading of the gate");
      assert.equal((await gate(cand)).approved, false, "nothing is approved while the proposal waits");

      // The interpreter's own flag and list are dropped: the proposal carries the gate's failures, the invented ID is shown nowhere.
      const bogus = "rat-000000000000000000000000";
      const quiet = `approve the release candidate ${cand}`;
      const quietShown = await approve("m2", quiet, { candidateId: cand, acknowledgeFlaky: true, expectedFailures: [bogus] });
      assert.equal(quietShown[0]!.status, "proposed", JSON.stringify(quietShown[0]));
      assert.equal(JSON.stringify(quietShown[0]).includes(bogus), false, "the invented attempt ID is not shown");
      assert.deepEqual((await stepArgs(quietShown[0]!.proposalId))["expectedFailures"], [sick]);
      assert.equal((await gate(cand)).approved, false, "a model-set flag approves nothing by itself");
      const discarded = await turn("m3", "no, forget that one", [{ kind: "discard_proposal", proposalId: quietShown[0]!.proposalId, evidence: "forget that one", basis: "owner" }]);
      assert.equal(discarded[0]!.status, "discarded");

      // (b) The owner's confirmation of the shown proposal is the acceptance.
      const applied = await confirm("m4", shipShown[0]!.proposalId);
      assert.equal(applied[0]!.status, "applied", JSON.stringify(applied[0]));
      assert.equal((await gate(cand)).approved, true);

      // (c) A clean gate behaves as before: proposed, bound to no earlier failure, applied on confirmation.
      const clean = await submit("b");
      await reported(await issue(clean), "b");
      assert.equal((await gate(clean)).needsAcknowledgement, false);
      const cleanShown = await approve("m5", `approve the release candidate ${clean}`, { candidateId: clean, acknowledgeFlaky: false, expectedFailures: [bogus] });
      assert.equal(cleanShown[0]!.status, "proposed", JSON.stringify(cleanShown[0]));
      assert.equal(JSON.stringify(cleanShown[0]).includes(bogus), false, "the dropped list is not shown");
      const cleanArgs = await stepArgs(cleanShown[0]!.proposalId);
      assert.deepEqual(cleanArgs["expectedFailures"], [], JSON.stringify(cleanArgs));
      assert.notEqual(cleanArgs["acknowledgeFlaky"], true, JSON.stringify(cleanArgs));
      assert.equal((await gate(clean)).approved, false);
      assert.equal((await confirm("m6", cleanShown[0]!.proposalId))[0]!.status, "applied");
      assert.equal((await gate(clean)).approved, true);

      // A gate that changes between the proposal and the confirmation: refused, nothing approved; asked again, the new failure is shown and then stands.
      const late = await submit("d");
      const lateSick = await issue(late);
      await reported(lateSick, "d", failed);
      const lateShown = await approve("m7", `approve the release candidate ${late}`, { candidateId: late });
      assert.equal(lateShown[0]!.status, "proposed", JSON.stringify(lateShown[0]));
      assert.ok(!/passed only after/.test((lateShown[0]!.preview ?? []).join(" ")), "nothing flaky was shown");
      await reported(await issue(late), "d");
      assert.equal((await gate(late)).needsAcknowledgement, true, "the gate is flaky now");
      const drifted = await confirm("m8", lateShown[0]!.proposalId);
      assert.equal(drifted[0]!.status, "refused", JSON.stringify(drifted[0]));
      assert.match(String(drifted[0]!.message), /gate|failur/i, JSON.stringify(drifted[0]));
      assert.equal((await gate(late)).approved, false, "nothing approved behind the owner's back");
      const lateShown2 = await approve("m9", `approve the release candidate ${late} please`, { candidateId: late });
      assert.equal(lateShown2[0]!.status, "proposed", JSON.stringify(lateShown2[0]));
      assert.match((lateShown2[0]!.preview ?? []).join(" "), new RegExp(lateSick));
      assert.equal((await confirm("m10", lateShown2[0]!.proposalId))[0]!.status, "applied");
      assert.equal((await gate(late)).approved, true);

      // No candidate named: refused, no proposal, nothing approved, whatever flag and list the interpreter sent.
      const third = await submit("c");
      const sick3 = await issue(third);
      await reported(sick3, "c", failed);
      await reported(await issue(third), "c");
      const vague = "go ahead and approve the release, those failures don't bother me";
      const vagueOut = await approve("m11", vague, { acknowledgeFlaky: true, expectedFailures: [sick3] });
      assert.equal(vagueOut[0]!.status, "refused", JSON.stringify(vagueOut[0]));
      assert.equal(vagueOut[0]!.proposalId, undefined);
      assert.equal((await gate(third)).approved, false);

      // A candidate ID the owner never said is still refused.
      const blind = await approve("m12", "approve the current release", { candidateId: third });
      assert.equal(blind[0]!.status, "refused", JSON.stringify(blind[0]));
      assert.equal((await gate(third)).approved, false);

      // The release status view of a flaky candidate (a chat answer the owner reads) does not name acknowledgeFlaky either (checked in turn()).
      const viewWords = `how is the release testing of ${third} going`;
      const view = await turn("m13", viewWords, [{ kind: "status", request: { kind: "release", candidateId: third }, evidence: viewWords, basis: "owner" }]);
      assert.equal(view[0]!.status, "answered", JSON.stringify(view[0]));
    } finally { await w.close(); }
  });
}
