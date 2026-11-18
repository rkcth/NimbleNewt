import assert from "node:assert/strict";
import { test } from "node:test";
import { boundContextUpdates, contextUpdatesProblem } from "./context-updates.js";
import { CONTEXT_UPDATE_LIMITS } from "./ports.js";

const upd = (n: number, chars: number) => ({ requestId: `upd:${n}`, text: String(n % 10).repeat(chars), origin: `side line cbr-${n}, desk record dsk-${n}, update 1` });
const total = (list: readonly { text: string }[]) => list.reduce((s, u) => s + u.text.length, 0);

test("G09: selected updates within the total are given as they are, oldest first", () => {
  const list = [upd(1, 100), upd(2, 16_000), upd(3, 20_000)];
  assert.deepEqual(boundContextUpdates(list), list);
  assert.deepEqual(boundContextUpdates([]), []);
});

test("G09: past the total the oldest whole updates are left out and one note first names where each came from; the same set gives the same note", () => {
  const list = Array.from({ length: CONTEXT_UPDATE_LIMITS.items }, (_, i) => upd(i + 1, 16_000));
  const bounded = boundContextUpdates(list);
  const kept = Math.floor(CONTEXT_UPDATE_LIMITS.total / 16_000);
  assert.equal(bounded.length, kept + 1);
  assert.ok(bounded.length <= CONTEXT_UPDATE_LIMITS.items);
  // The newest are kept whole and unchanged, in order.
  assert.deepEqual(bounded.slice(1), list.slice(-kept));
  assert.ok(total(bounded.slice(1)) <= CONTEXT_UPDATE_LIMITS.total);
  const note = bounded[0]!;
  assert.match(note.requestId, /^upd-left:[0-9a-f]{32}$/);
  assert.match(note.text, new RegExp(`^${list.length - kept} earlier updates`));
  for (const u of list.slice(0, -kept)) assert.ok(note.text.includes(u.origin), u.origin);
  for (const u of list.slice(-kept)) assert.ok(!note.text.includes(u.origin), u.origin);
  assert.ok(note.origin.length <= CONTEXT_UPDATE_LIMITS.origin && note.text.length <= CONTEXT_UPDATE_LIMITS.text);
  assert.deepEqual(boundContextUpdates(list), bounded, "the same updates give the same answer");
  // A newer update arrives: one more is left out, so the note is a new one (a new request ID); the kept ones keep theirs.
  const more = boundContextUpdates([...list.slice(1), upd(99, 16_000)]);
  assert.notEqual(more[0]!.requestId, note.requestId);
  assert.equal(more.at(-1)!.requestId, "upd:99");
});

test("G09: one update left out is named in the singular; a text over the item bound is cut before the total is counted", () => {
  const list = [upd(1, 30_000), upd(2, 20_000), upd(3, 20_000), upd(4, 20_000)];
  const bounded = boundContextUpdates(list);
  assert.deepEqual(bounded.map((u) => u.requestId).slice(1), ["upd:2", "upd:3", "upd:4"]);
  assert.match(bounded[0]!.text, /^1 earlier update selected .* was not placed/);
  // Only the newest 20 are considered at all.
  const many = Array.from({ length: 25 }, (_, i) => upd(i + 1, 10));
  assert.deepEqual(boundContextUpdates(many).map((u) => u.requestId), many.slice(-20).map((u) => u.requestId));
});

test("G09 remote path: what boundContextUpdates gives passes the shape check; anything else is named", () => {
  assert.equal(contextUpdatesProblem(undefined), undefined);
  assert.equal(contextUpdatesProblem([]), undefined);
  assert.equal(contextUpdatesProblem(boundContextUpdates(Array.from({ length: CONTEXT_UPDATE_LIMITS.items + 5 }, (_, i) => upd(i + 1, 20_000)))), undefined);
  assert.equal(contextUpdatesProblem(boundContextUpdates([upd(1, 10), upd(2, 20)])), undefined);
  // The kept texts fill the total exactly and the note on the one left out comes on top: still the dispatcher's own output, so it passes (a check bounded at the total alone would refuse it and fail every remote start).
  const full = boundContextUpdates([upd(1, 1), upd(2, 20_000), upd(3, 20_000), upd(4, 20_000), upd(5, CONTEXT_UPDATE_LIMITS.total - 60_000)]);
  assert.equal(full.slice(1).reduce((n, u) => n + u.text.length, 0), CONTEXT_UPDATE_LIMITS.total);
  assert.equal(contextUpdatesProblem(full), undefined);
  const one = upd(1, 10);
  for (const bad of ["x", {}, null, [null], ["text"], [[]], Array.from({ length: CONTEXT_UPDATE_LIMITS.items + 1 }, (_, i) => upd(i, 1)), [{ ...one, requestId: "" }], [{ ...one, requestId: "r".repeat(201) }], [{ ...one, requestId: 7 }],
    [{ ...one, text: "x".repeat(CONTEXT_UPDATE_LIMITS.text + 1) }], [{ ...one, text: undefined }], [{ ...one, origin: 7 }], [{ ...one, origin: "o".repeat(CONTEXT_UPDATE_LIMITS.origin + 1) }], [{ ...one, extra: 1 }],
    Array.from({ length: 5 }, (_, i) => upd(i, 20_000))]) {
    assert.equal(typeof contextUpdatesProblem(bad), "string", JSON.stringify(bad).slice(0, 80));
  }
});
