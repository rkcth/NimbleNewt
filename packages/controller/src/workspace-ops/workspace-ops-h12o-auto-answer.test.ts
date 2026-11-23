import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ProjectService } from "../domain/service.js";
import { PrincipalService } from "../security/index.js";
import { QuiesceRefused } from "../dispatch/index.js";
import { WorkspaceOpService, type WorkspaceCall, type WorkspaceDeps } from "./index.js";

after(stopServer);

// Card H12o (seventh slice): `automaticRelease` tells what became of the release that a reviewer's approval asked for, from the request the release recorded (found by the IDs it derived; no index). Read-only, no caller.
const options = { clock: () => "2026-11-22T10:00:00.000Z", pause: async () => undefined };
const BASE = "b".repeat(40), TREE = "e".repeat(40), COMMIT = "c".repeat(40);
const S1 = "sbm-aaaaaaaaaaaaaaaaaaaa", S2 = "sbm-bbbbbbbbbbbbbbbbbbbb", S3 = "sbm-cccccccccccccccccccc";

for (const backend of backends) {
  test(`${backend.name}: the recorded automatic release is told as refused, failed or done; nothing recorded, another submission, a bad ID and a read all answer nothing or create nothing (card H12o, seventh slice)`, async () => {
    const store = await backend.open();
    try {
      const projects = await ProjectService.open(store.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(store.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: "p", actor: owner.id, name: "P" })).id;
      const task = (await projects.createTask({ commandId: "t", actor: owner.id, projectId: project, title: "T" })).id;
      const approved = { taskId: task, base: BASE, tree: TREE, approved: true, approvedBy: "agent:rev", submittedBy: "agent:ann" };
      const approvals = new Map([[S1, approved], [S2, approved], [S3, approved]]);
      // `unapprove`: the approval is taken back after the first showing (the third read: releaseApproved, the first showing, the re-check before the host is asked).
      const reads = { n: 0, unapprove: false };
      const mode = { is: "refuse" as "refuse" | "throw" | "commit" | "quiet" | "nohost" };
      const calls: WorkspaceCall[] = [];
      const deps: WorkspaceDeps = {
        quiesce: { around: async (_s, _o, run) => { if (mode.is === "quiet") throw new QuiesceRefused("release", "att-1", undefined, "ENOENT: no such file or directory, open '/srv/host/runs/att-1/state'"); return run({ attempts: [] } as never); } },
        portOf: async () => mode.is === "nohost" ? undefined : ({ run: async (call) => {
          calls.push(call);
          if (mode.is === "throw") throw new Error("the host is down");
          if (mode.is === "refuse") return { ok: false as const, reason: "the checkout holds files that were not approved" };
          return { ok: true as const, summary: "committed", detail: { committed: true, commit: COMMIT, parent: call.submission!.base, tree: call.submission!.tree, files: 1, submission: call.submission!.id, recovered: false, changed: true, permitted: true } };
        } }),
        approvalOf: async (id) => { if (reads.unapprove && ++reads.n >= 3) throw new Error("SQLITE_IOERR: disk I/O error at /var/lib/nn/db"); return approvals.get(id); },
        attempts: { live: async () => [], frozenReason: async () => undefined, release: async () => undefined },
      };
      const service = WorkspaceOpService.withEpoch(store.storage, projects.epoch, deps, options);
      // Nothing asked yet: nothing recorded.
      assert.equal(await service.automaticRelease(S1, "rev-1"), undefined);
      const before = JSON.stringify(await store.storage.listAggregates("workspace-request", { limit: 100 }));
      assert.equal(await service.automaticRelease(S1, "rev-1"), undefined);
      assert.equal(JSON.stringify(await store.storage.listAggregates("workspace-request", { limit: 100 })), before, "reading creates nothing");
      // Refused by the host: the recorded answer, with what the host said.
      await service.releaseApproved(S1, "rev-1");
      const refused = await service.automaticRelease(S1, "rev-1");
      assert.equal(refused?.state, "refused");
      assert.match(refused?.summary ?? "", /files that were not approved/);
      assert.equal(refused?.hostAnswer, true, "the host's own refusal is marked as its answer");
      // It is this submission's: the same review ID asked about another submission is nothing, and so are a made-up review, a bad review ID and a bad submission ID.
      assert.equal(await service.automaticRelease(S2, "rev-1"), undefined);
      assert.equal(await service.automaticRelease(S1, "rev-2"), undefined);
      assert.equal(await service.automaticRelease(S1, "has a space"), undefined);
      assert.equal(await service.automaticRelease("not-a-submission", "rev-1"), undefined);
      assert.equal(await service.automaticRelease(S1, ""), undefined);
      // A host that fails: failed. A later approval is another request, told by its own review.
      mode.is = "throw";
      await service.releaseApproved(S1, "rev-2");
      const failed = await service.automaticRelease(S1, "rev-2");
      assert.equal(failed?.state, "failed");
      assert.equal(failed?.hostAnswer, undefined, "a failure is never marked as the host's answer");
      assert.equal((await service.automaticRelease(S1, "rev-1"))?.state, "refused", "the earlier approval keeps its own answer");
      // Refusals built on the controller's side from a thrown error are refused but not the host's answer: an attempt that could not be made quiet, and an approval re-check that threw. No host at all is a fixed text.
      mode.is = "quiet";
      await service.releaseApproved(S2, "rev-q");
      const quiet = await service.automaticRelease(S2, "rev-q");
      assert.equal(quiet?.state, "refused");
      assert.match(quiet?.summary ?? "", /could not be made quiet/);
      assert.equal(quiet?.hostAnswer, undefined);
      mode.is = "refuse";
      reads.unapprove = true;
      await service.releaseApproved(S3, "rev-u");
      reads.unapprove = false;
      const unapproved = await service.automaticRelease(S3, "rev-u");
      assert.equal(unapproved?.state, "refused");
      assert.match(unapproved?.summary ?? "", /no longer approved/);
      assert.equal(unapproved?.hostAnswer, undefined);
      mode.is = "nohost";
      await service.releaseApproved(S2, "rev-n");
      const nohost = await service.automaticRelease(S2, "rev-n");
      assert.equal(nohost?.state, "refused");
      assert.equal(nohost?.hostAnswer, true);
      mode.is = "commit";
      await service.releaseApproved(S1, "rev-3");
      const done = await service.automaticRelease(S1, "rev-3");
      assert.equal(done?.state, "done");
      assert.equal(done?.hostAnswer, undefined);
      assert.equal((await service.submissionCommit(S1))?.commitId, COMMIT);
      assert.equal(calls.length, 3);
    } finally { await store.close(); }
  });
}
