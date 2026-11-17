import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { rig, sandbox } from "./w03-rig-support.js";

// Card L04g, end to end with a REAL Pi worker process (bubblewrap, offline, a scripted model): the agent records what its work relied on with its own bridge tool (nimblenewt__dependency-record), naming only the kind and
// the path; the controller looks at the file in the checkout the worker works in and records its hash; when the file changes, the next run is held by the checked resume with that file changed (not unknown, not missing).
// Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI).
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

test("a real Pi agent records the file its work relied on with its own tool; the controller fills in the hash from the worker's checkout; a later change holds the resume (card L04g)", async (t) => {
  const launcher = await sandbox(t);
  if (launcher === undefined) return;
  const first = [
    { call: { name: "nimblenewt__dependency-record", args: { dependencies: [{ kind: "file", key: "src/a.ts" }] } } },
    { text: "First I read the parser." }, { text: "Still reading." }, { text: "Still reading." }, { text: "Still reading." },
  ];
  const x = await rig(launcher, [...first, { call: { name: "nimblenewt__work-end", args: { report: "Done as the task asked.", result: "done", note: "parser fixed" } } }, { text: "Ended." }], {
    start: { resumeCheckout: async ({ taskId, projectId }) => ws().locate({ taskId, projectId })?.checkout },
  });
  const ws = (): typeof x.ws => x.ws;
  const call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await x.c.api.handle(x.ownerToken, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
  try {
    await x.run();
    // The tool's answer reached the model: the controller looked at the file itself.
    assert.match(x.answer.seen[1]!, /\\"checkedBy\\":\\"controller\\"/, x.answer.seen[1]!.slice(-800));
    const manifest = (await call("resume.dependencies.get", { taskId: x.taskId })).result.item;
    assert.deepEqual(manifest.entries.map((e: { kind: string; key: string; hash?: string }) => [e.kind, e.key, e.hash]), [["file", "src/a.ts", sha("export const a = 1;\n")]], "recorded with the controller's own hash of the worker's checkout");

    const where = x.ws.locate({ taskId: x.taskId, projectId: x.project })!;
    writeFileSync(join(where.checkout, "src", "a.ts"), "export const a = 2;\n");
    await x.run();
    assert.equal((await x.get()).state, "waiting", "held for the owner's decision, not started");
    const check = (await call("resume.for-task", { taskId: x.taskId })).result.item;
    assert.deepEqual(check.delta.changed.map((c: { key: string; status: string }) => [c.key, c.status]), [["src/a.ts", "changed"]]);
    assert.equal((await call("resume.approve", { taskId: x.taskId }, "ok")).result.item.phase, "done");
    await x.run();
    assert.equal((await x.get()).outcome?.status, "succeeded");
  } finally { await x.close(); }
});
