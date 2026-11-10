import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { rig, sandbox } from "./w03-rig-support.js";

// Card W05, end to end: the composed controller with the real local worker (bubblewrap, the worker process running Pi), the real checkout layout and a scripted model. The task's contract has a check command. The agent's first
// work.end done comes before it changed anything: the controller refuses it with the list (no change against the base, and the check, which the host ran in the sandbox, failed with its output), and the model reads that list as the
// tool's answer in the same turn. The agent then does the work (written into the checkout here, as its write tool would; it cannot commit, its checkout has no .git) and ends again without submit: the host runs the check again, it
// passes, and the attempt succeeds. The agent's model never ran the check; nothing the agent says marks it passed.
test("a done before the work is written is refused with what failed, in the same turn; the done after it, uncommitted as the real worker leaves it, passes the host's check and succeeds (card W05)", async (t) => {
  const launcher = await sandbox(t);
  if (launcher === undefined) return;
  const holder: { write?: () => void } = {};
  const x = await rig(launcher, [
    { call: { name: "nimblenewt__work-end", args: { report: "Done as the task asked.", result: "done", note: "parser fixed" } } },
    { before: async () => holder.write!(), call: { name: "nimblenewt__work-end", args: { report: "Done as the task asked.", result: "done", note: "parser fixed, b added", evidence: [{ item: "the new module", path: "src/b.ts" }] } } },
    { text: "Ended: the parser is fixed." },
  ]);
  try {
    await x.c.services.contracts.setContract(x.owner, { commandId: "ct", taskId: x.taskId, expectedVersion: 0, requiredEvidence: ["the new module"], checks: [{ name: "has b", run: ["/bin/sh", "-c", "pwd; test -f src/b.ts || { echo 'missing src/b.ts' >&2; exit 3; }"], timeoutSeconds: 60 }] } as never);
    holder.write = () => {
      const where = x.ws.locate({ taskId: x.taskId, projectId: x.project })!;
      writeFileSync(join(where.checkout, "src", "b.ts"), "export const b = 2;\n");
    };
    await x.run();
    const d = await x.get();
    assert.equal(d.state, "finished", JSON.stringify(d.outcome));
    assert.equal(d.outcome?.status, "succeeded", d.outcome?.summary);
    assert.deepEqual(d.verifications?.map((v) => [v.state, v.counted]), [["failed", true], ["passed", false]]);
    assert.deepEqual(d.verifications?.map((v) => v.checks.map((c) => [c.name, c.state, c.exitCode])), [[["has b", "failed", 3]], [["has b", "passed", 0]]]);
    // The agent was told at the start what a done is checked against, and read the refusal as the answer of its first work.end, in the same conversation.
    assert.equal(x.answer.seen.length, 3);
    assert.match(x.answer.seen[0]!, /When you end with work\.end done, the controller checks your work before it is taken: your checkout must hold your change against the task's base \(you do not commit it[^"]*\\"the new module\\"[^"]*\\"has b\\"/);
    assert.match(x.answer.seen[1]!, /refused \(invalid_command\): work\.end done was not accepted: the controller checked your work against the task contract and 3 item\(s\) did not pass\./);
    assert.match(x.answer.seen[1]!, /Your checkout holds no change against the task's base/);
    const refusal = /work\.end done was not accepted:[\s\S]*?say why in the note\./.exec(x.answer.seen[1]!)?.[0] ?? "";
    assert.notEqual(refusal, "");
    assert.doesNotMatch(refusal, /[Cc]ommit/, "the agent cannot commit (its checkout has no .git), so the refusal never tells it to");
    assert.match(x.answer.seen[1]!, /If you cannot finish, end with work\.end result blocked or partial and say why in the note\./, "the whole list and what to do reach the model");
    assert.match(x.answer.seen[1]!, /Check \\"has b\\" failed: it exited with code 3\. The end of its output \(quoted\): \\"\/work missing src\/b\.ts\\"/, "the check ran in the sandbox (its working directory is the checkout at /work) and its output is quoted");
  } finally { await x.close(); }
});
