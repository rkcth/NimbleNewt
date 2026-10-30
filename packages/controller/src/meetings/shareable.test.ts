import assert from "node:assert/strict";
import { test } from "node:test";
import { isShareableKind, shareableCite } from "./shareable.js";

test("only project-visible kinds are shareable; desk, scratch, chair notes, conversations and unknown kinds are not", () => {
  for (const k of ["task", "artifact", "review", "blocker", "decision", "plan", "meeting-record", "meeting-summary"]) assert.equal(isShareableKind(k), true, k);
  for (const k of ["desk-record", "desk-scratch", "scratch", "chair-notes", "note", "chat-turn", "history-entry", "principal", "credential", "", "whatever"]) assert.equal(isShareableKind(k), false, k);
});

test("a cite is shareable only when its record exists; a storage failure is not shareable", async () => {
  const have = new Set(["artifact:a1", "desk-record:d1"]);
  const storage = { getAggregate: async (r: { kind: string; id: string }) => (have.has(`${r.kind}:${r.id}`) ? ({} as never) : undefined) };
  const ok = shareableCite(storage);
  assert.equal(await ok({ kind: "artifact", id: "a1" }), true);
  assert.equal(await ok({ kind: "artifact", id: "nope" }), false);
  assert.equal(await ok({ kind: "desk-record", id: "d1" }), false, "an existing private record is still private");
  assert.equal(await ok({ kind: "artifact", id: "" }), false);
  assert.equal(await shareableCite({ getAggregate: async () => { throw new Error("down"); } })({ kind: "artifact", id: "a1" }), false);
});
