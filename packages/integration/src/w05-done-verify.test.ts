import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { rig, sandbox } from "./w03-rig-support.js";

// Card W05, end to end: the composed controller with the real local worker (bubblewrap, the worker process running Pi), the real checkout layout and a scripted model. The task's contract has a check command. The agent's first
// work.end done comes before its work is committed: the controller refuses it with the list (no commit ahead of the base, and the check, which the host ran in the sandbox, failed with its output), and the model reads that list as the
// tool's answer in the same turn. The agent then does the work (written and committed here, as a commit after review would be) and ends again: the host runs the check again, it passes, and the attempt succeeds. The agent's model
// never ran the check; nothing the agent says marks it passed.
test("a done before the work is committed is refused with what failed, in the same turn; the done after it passes the host's check and succeeds (card W05)", async (t) => {
  const launcher = await sandbox(t);
  if (launcher === undefined) return;
  const holder: { commit?: () => void } = {};
  const x = await rig(launcher, [
    { call: { name: "nimblenewt__work-end", args: { result: "done", note: "parser fixed" } } },
    { before: async () => holder.commit!(), call: { name: "nimblenewt__work-end", args: { result: "done", note: "parser fixed, b added" } } },
    { text: "Ended: the parser is fixed." },
  ]);
  try {
    await x.c.services.contracts.setContract(x.owner, { commandId: "ct", taskId: x.taskId, expectedVersion: 0, checks: [{ name: "has b", run: ["/bin/sh", "-c", "pwd; test -f src/b.ts || { echo 'missing src/b.ts' >&2; exit 3; }"], timeoutSeconds: 60 }] } as never);
    holder.commit = () => {
      const where = x.ws.locate({ taskId: x.taskId, projectId: x.project })!;
      writeFileSync(join(where.checkout, "src", "b.ts"), "export const b = 2;\n");
      const g = (...args: string[]) => execFileSync("git", ["--git-dir", where.gitDir, "--work-tree", where.checkout, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/nonexistent-hooks", "-c", "commit.gpgsign=false", ...args]);
      g("add", "-A"); g("commit", "-q", "-m", "add b");
    };
    await x.run();
    const d = await x.get();
    assert.equal(d.state, "finished", JSON.stringify(d.outcome));
    assert.equal(d.outcome?.status, "succeeded", d.outcome?.summary);
    assert.deepEqual(d.verifications?.map((v) => [v.state, v.counted]), [["failed", true], ["passed", false]]);
    assert.deepEqual(d.verifications?.map((v) => v.checks.map((c) => [c.name, c.state, c.exitCode])), [[["has b", "failed", 3]], [["has b", "passed", 0]]]);
    // The agent was told at the start what a done is checked against, and read the refusal as the answer of its first work.end, in the same conversation.
    assert.equal(x.answer.seen.length, 3);
    assert.match(x.answer.seen[0]!, /When you end with work\.end done, the controller checks your work before it is taken[^"]*\\"has b\\"/);
    assert.match(x.answer.seen[1]!, /refused \(invalid_command\): work\.end done was not accepted: the controller checked your work against the task contract and 2 item\(s\) did not pass\./);
    assert.match(x.answer.seen[1]!, /There is no commit ahead of the task's base/);
    assert.match(x.answer.seen[1]!, /If you cannot finish, end with work\.end result blocked or partial and say why in the note\./, "the whole list and what to do reach the model");
    assert.match(x.answer.seen[1]!, /Check \\"has b\\" failed: it exited with code 3\. The end of its output \(quoted\): \\"\/work missing src\/b\.ts\\"/, "the check ran in the sandbox (its working directory is the checkout at /work) and its output is quoted");
  } finally { await x.close(); }
});
