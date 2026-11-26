import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeChanges } from "./changes.js";
import { DomainError } from "./errors.js";
import type { Change } from "../storage/types.js";

const a = { kind: "assignment", id: "asg-1" };
const check = (ref: { kind: string; id: string }, expectedRevision: number): Change => ({ type: "check", ref, expectedRevision });

test("mergeChanges keeps one check per record and refuses two different revisions of it", () => {
  const create: Change = { type: "create", ref: { kind: "run", id: "r" }, body: {} };
  assert.deepEqual(mergeChanges([create, check(a, 3)], [check(a, 3), check({ kind: "gate", id: "g" }, 1)]), [create, check(a, 3), check({ kind: "gate", id: "g" }, 1)]);
  assert.throws(() => mergeChanges([check(a, 3)], [check(a, 4)]), (e: unknown) => e instanceof DomainError && e.code === "stale_revision");
  // A check beside a write of the same record is covered by the write, if it expects the same revision.
  const update: Change = { type: "update", ref: a, expectedRevision: 3, body: {} };
  assert.deepEqual(mergeChanges([check(a, 3), update]), [update]);
  assert.throws(() => mergeChanges([update], [check(a, 2)]), (e: unknown) => e instanceof DomainError && e.code === "stale_revision");
});

test("mergeChanges refuses a check beside a create of the same record as stale (the guards read it before and after another commit), so the caller reads again instead of storage refusing the list", () => {
  const gate = { kind: "pause-gate", id: "pgt-1" };
  const create: Change = { type: "create", ref: gate, body: {} };
  const stale = (e: unknown) => e instanceof DomainError && e.code === "stale_revision";
  assert.throws(() => mergeChanges([create], [check(gate, 1)]), stale);
  assert.throws(() => mergeChanges([check(gate, 1)], [create]), stale, "in either order");
  // A create of one record beside checks of others is unchanged.
  assert.deepEqual(mergeChanges([create], [check(a, 1)]), [create, check(a, 1)]);
  const other = check({ kind: "pause-gate", id: "pgt-2" }, 1);
  assert.deepEqual(mergeChanges([create], [other]), [create, other], "another gate of the same kind is another record");
});
