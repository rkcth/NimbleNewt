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
