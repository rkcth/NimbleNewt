import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANGE_VIEW_LIMITS, RecentTexts, boundedDiff, changeViews, type DependencyEntry, type ManifestBody } from "./index.js";

// Card L04g: the reviewer's view of a change is a bounded line diff of the text kept when the dependency was recorded and the text read at the check.

test("a bounded diff: changed lines with two lines of context, the line number, long lines and long diffs cut and said so", () => {
  assert.equal(boundedDiff("same\n", "same\n"), "");
  assert.equal(boundedDiff("a\nb\nc\nd\ne\nf\n", "a\nb\nc\nD\ne\nf\n"), "@@ line 4 @@\n b\n c\n-d\n+D\n e\n f");
  assert.equal(boundedDiff("one\ntwo\n", "one\ntwo\nthree\n"), "@@ line 3 @@\n one\n two\n+three\n ");
  assert.equal(boundedDiff("x\n", ""), "@@ line 1 @@\n-x\n ");
  // Lines kept in the middle of a change are aligned, not shown as removed and added again.
  assert.equal(boundedDiff("h\n1\nkeep\n2\nt", "h\nA\nkeep\nB\nt"), "@@ line 2 @@\n h\n-1\n+A\n keep\n-2\n+B\n t");
  const long = boundedDiff("a\n", `${"z".repeat(2000)}\n`);
  assert.match(long, /\+z{399}… \(line cut\)/);
  const many = boundedDiff(Array.from({ length: 900 }, (_, i) => `old ${i}`).join("\n"), Array.from({ length: 900 }, (_, i) => `new ${i}`).join("\n"));
  assert.ok(many.length <= CHANGE_VIEW_LIMITS.chars, String(many.length));
  assert.match(many, /… \(\d+ more lines, \d+ characters, not shown\)$/);
  assert.match(many, /^@@ line 1 @@\n-old 0\n-old 1/, "past the alignment bound the removed lines come first, then the added");
});

test("the view of a change: the kept text against the text read now; why not, when either is missing; only for text kinds", async () => {
  const entry = (id: string, kind: DependencyEntry["kind"], hash = "a".repeat(64)): DependencyEntry => ({ id, kind, key: id, hash, observedAt: "" });
  const manifest: ManifestBody = { taskId: "t", projectId: "p", entries: [entry("f1", "file"), entry("f2", "file"), entry("x1", "external"), entry("d1", "directory"), entry("f3", "file")] };
  let now = 0;
  const recent = new RecentTexts(() => now);
  recent.set("t", "f1", "a\nb\n", "b".repeat(64));
  recent.set("t", "x1", "new page", "c".repeat(64));
  recent.set("t", "f3", "same", "d".repeat(64));
  const kept: Record<string, string> = { f1: "a\nc\n", x1: "old page", f3: "same" };
  const view = changeViews({ manifest: async () => manifest, textOf: async (_t, e) => kept[e.id], recent });
  assert.deepEqual(await view("t", { id: "f1", kind: "file", status: "changed" }), { diff: "@@ line 2 @@\n a\n-c\n+b\n " });
  assert.deepEqual(await view("t", { id: "x1", kind: "external", status: "changed" }), { diff: "@@ line 1 @@\n-old page\n+new page" });
  assert.deepEqual(await view("t", { id: "f1", kind: "file", status: "deleted" }), { diff: "@@ line 1 @@\n-a\n-c\n " });
  assert.match(("none" in (await view("t", { id: "f2", kind: "file", status: "changed" })) ? (await view("t", { id: "f2", kind: "file", status: "changed" }) as { none: string }).none : ""), /was not kept/);
  assert.match((await view("t", { id: "d1", kind: "directory", status: "new-members" }) as { none: string }).none, /has no text/);
  assert.match((await view("t", { id: "f3", kind: "file", status: "changed" }) as { none: string }).none, /visible text is the same/);
  assert.match((await view("t", { id: "gone", kind: "file", status: "changed" }) as { none: string }).none, /no longer recorded/);
  // A text read too long ago is not used; nor is one read at another hash.
  kept["f2"] = "x";
  now = CHANGE_VIEW_LIMITS.ms + 1;
  assert.match((await view("t", { id: "f1", kind: "file", status: "changed" }) as { none: string }).none, /could not be read here/);
  recent.set("t", "f1", "fresh", "e".repeat(64));
  assert.equal(recent.at("t", "f1", "e".repeat(64)), "fresh");
  assert.equal(recent.at("t", "f1", "f".repeat(64)), undefined);
  // A read that found no text forgets the older one.
  recent.set("t", "f1", undefined);
  assert.equal(recent.get("t", "f1"), undefined);
  // A failing store is a reason, not a throw.
  const broken = changeViews({ manifest: async () => { throw new Error("db down"); }, textOf: async () => undefined, recent });
  assert.deepEqual(await broken("t", { id: "f1", kind: "file", status: "changed" }), { none: "the change could not be put together" });
});
