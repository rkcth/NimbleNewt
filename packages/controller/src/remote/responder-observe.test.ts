import assert from "node:assert/strict";
import { test } from "node:test";
import type { RemoteWorkspaceAnswer, WorkspaceAsk } from "./protocol.js";
import { WorkspaceResponder } from "./responder.js";

// Card L04e review: what a host says back when its look at a task's files fails. The error's text may name a path on the host's disk; it stays in the host's own log and the controller hears only that the look failed.
test("a look that throws on the host is refused without the error's text, which goes to the host's own log; a look that answers sends hashes only", async () => {
  const sent: { id: string; answer: RemoteWorkspaceAnswer }[] = [];
  const logged: unknown[] = [];
  let fail = true;
  const responder = new WorkspaceResponder({
    client: { answerWorkspace: async (id: string, answer: RemoteWorkspaceAnswer) => { sent.push({ id, answer }); } }, busy: () => [], port: { run: async () => ({ ok: false, reason: "no" }) } as never,
    onError: (e) => logged.push(e),
    observe: async () => { if (fail) throw new Error("EACCES: permission denied, open '/home/host-user/work/checkout/src/a.ts'"); return { "dpm-1": { exists: true, hash: "a".repeat(64) }, "dpm-2": { exists: false } }; },
  });
  const ask = (n: number): WorkspaceAsk => ({ requestId: `wsr-${String(n).repeat(20)}`, operation: "observe", taskId: "task-1", projectId: "proj-1", reason: "look", quietAttempts: [], observe: { entries: [{ id: "dpm-1", kind: "file", key: "src/a.ts" }, { id: "dpm-2", kind: "file", key: "src/b.ts" }] } });
  responder.handle([ask(2)]);
  await responder.idle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.answer.ok, false);
  assert.equal(JSON.stringify(sent[0]!.answer).includes("/home/host-user"), false, "no host path in the answer");
  assert.equal(JSON.stringify(sent[0]!.answer).includes("EACCES"), false);
  assert.match(String(logged[0]), /host-user/, "the host's own log has the detail");
  fail = false;
  responder.handle([ask(3)]);
  await responder.idle();
  assert.deepEqual(sent[1]!.answer, { ok: true, summary: "looked", detail: { observed: { "dpm-1": { exists: true, hash: "a".repeat(64) }, "dpm-2": { exists: false } } } });
});

// Card L04e second review: what the controller keeps of a host's answer. A host that is confused, or not the program it claims to be, can say only what a file is: a well-formed hash, `exists`, or a directory's member names. Anything
// else it adds (text, a path, a hash in the wrong form, members that are not names, an answer for something not asked) is dropped and the dependency stays unknown. A host that keeps putting everything off is asked a bounded number of times.
test("the controller keeps only well-formed fields of a host's look, ignores answers for entries it did not ask about, and stops asking a host that never answers what it put off", async () => {
  const { observeOnHost } = await import("./observe.js");
  const by = { id: "service:dispatcher", kind: "service", name: "dispatcher", grants: [] } as never;
  const scope = { taskId: "task-1", projectId: "proj-1" };
  const good = "b".repeat(64);
  const replies: unknown[] = [];
  const asked: string[][] = [];
  const remote = { askObserve: async (_by: unknown, _host: string, _id: string, _scope: unknown, entries: readonly { id: string }[]) => { asked.push(entries.map((e) => e.id)); return replies.shift() as RemoteWorkspaceAnswer; } };
  const entries = [
    { id: "f-ok", kind: "file" as const, key: "a" }, { id: "f-extra", kind: "file" as const, key: "b" }, { id: "f-upper", kind: "file" as const, key: "c" }, { id: "f-short", kind: "file" as const, key: "d" },
    { id: "f-gone", kind: "file" as const, key: "e" }, { id: "d-ok", kind: "directory" as const, key: "f" }, { id: "d-bad", kind: "directory" as const, key: "g" }, { id: "d-file", kind: "directory" as const, key: "h" },
    { id: "f-dir", kind: "file" as const, key: "i" }, { id: "f-null", kind: "file" as const, key: "j" },
  ];
  replies.push({ ok: true, summary: "looked", detail: { observed: {
    "f-ok": { exists: true, hash: good },
    "f-extra": { exists: true, hash: good, content: "SECRET-TEXT", path: "/home/host-user/checkout/b" },
    "f-upper": { exists: true, hash: good.toUpperCase() },
    "f-short": { exists: true, hash: "abc" },
    "f-gone": { exists: false, content: "SECRET-TEXT" },
    "d-ok": { exists: true, members: ["z", "a"], content: "SECRET-TEXT" },
    "d-bad": { exists: true, members: ["a", 7] },
    "d-file": { exists: true, hash: good },
    "f-dir": { exists: true, members: ["a"] },
    "f-null": null,
    "not-asked": { exists: true, hash: good },
  } } });
  const got = await observeOnHost({ remote, by }, "host:far", scope, entries, undefined);
  assert.deepEqual(got, { "f-ok": { exists: true, hash: good }, "f-extra": { exists: true, hash: good }, "f-gone": { exists: false }, "d-ok": { exists: true, members: ["a", "z"] } });
  assert.equal(JSON.stringify(got).includes("SECRET"), false);
  assert.equal(JSON.stringify(got).includes("/home/host-user"), false);
  // A host that answers nothing and puts everything off, every time: asked once more at most for what is left, never in a loop, and nothing is claimed.
  replies.length = 0; asked.length = 0;
  for (let i = 0; i < 20; i++) replies.push({ ok: true, summary: "looked", detail: { observed: {}, later: ["f-ok", "f-extra"] } });
  assert.deepEqual(await observeOnHost({ remote, by }, "host:far", scope, entries.slice(0, 2), undefined), {});
  assert.ok(asked.length <= 2, `a host that never makes progress is not asked again and again: ${asked.length} asks`);
  // A host that puts off one entry at a time is still held to the bound on requests per check.
  replies.length = 0; asked.length = 0;
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `f-${String(i).padStart(2, "0")}`, kind: "file" as const, key: `k${i}` }));
  for (let i = 0; i < 40; i++) replies.push({ ok: true, summary: "looked", detail: { observed: {}, later: many.map((e) => e.id).slice(i + 1) } });
  assert.deepEqual(await observeOnHost({ remote, by }, "host:far", scope, many, undefined, { asks: 5 }), {});
  assert.equal(asked.length, 5, "at most the bound of requests");
  assert.ok(asked.every((ids) => ids.length <= 20), "each request names at most 20 entries");
});
