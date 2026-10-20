import assert from "node:assert/strict";
import { test } from "node:test";
import { StorageError, canonicalJson, compareCodePoints, operationHash, sha256, validateOperation, type OperationInput } from "./index.js";

const base: OperationInput = {
  operationId: "op1", epoch: 1, actor: "a", correlationId: "c", at: "2026-10-19T12:00:00.000Z",
  changes: [{ type: "create", ref: { kind: "task", id: "t1" }, body: { b: 1, a: [1, { y: 2, x: 1 }] } }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [],
  completeDeliveries: [], completeTimers: [], settleEffects: [],
};

test("canonical JSON sorts keys by code point at every depth and is whitespace-free", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonicalJson({ "😀": 1, "～": 2 }), '{"～":2,"😀":1}');
  assert.ok(compareCodePoints("～", "😀") < 0, "UTF-16 order would say the opposite");
});

test("canonical JSON refuses what JSON cannot carry, naming the path", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const cases: [unknown, RegExp][] = [
    [{ a: { b: undefined } }, /body\.a\.b: undefined is not a value/], [{ a: [Number.NaN] }, /body\.a\[0\]: numbers must be finite/], [{ a: -0 }, /negative zero/],
    [{ a: 2 ** 60 }, /safe integers/], [cyclic, /contains a cycle/], [{ a: Symbol("x") }, /symbol is not allowed/], [{ a: new Date() }, /only plain objects/],
  ];
  for (const [value, message] of cases) assert.throws(() => canonicalJson(value), (e) => e instanceof StorageError && e.kind === "invalid_input" && message.test(e.message));
  const shared = { n: 1 };
  assert.equal(canonicalJson({ a: shared, b: shared }), '{"a":{"n":1},"b":{"n":1}}', "a value used twice is not a cycle");
});

test("the request hash covers what defines the command and ignores what may differ between attempts", () => {
  const h = operationHash(base);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(operationHash({ ...base, operationId: "other", epoch: 7, at: "2030-01-01T00:00:00.000Z" }), h);
  assert.equal(operationHash({ ...base, changes: [{ type: "create", ref: { kind: "task", id: "t1" }, body: { a: [1, { x: 1, y: 2 }], b: 1 } }] }), h);
  for (const changed of [{ actor: "b" }, { correlationId: "d" }, { audit: [{ type: "x", detail: {} }] }, { cancelTimers: ["t"] }, { changes: [] },
    { completeDeliveries: [{ deliveryId: "d", claimToken: "t", receipt: {} }] }, { completeTimers: [{ timerId: "t", claimToken: "k" }] }, { settleEffects: [{ effectId: "e", outcome: "confirmed" as const }] }]) {
    assert.notEqual(operationHash({ ...base, ...changed }), h, JSON.stringify(changed));
  }
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("validation reports the path of the first problem and rejects unknown fields", () => {
  assert.doesNotThrow(() => validateOperation(base));
  const path = (input: unknown): string | undefined => { try { validateOperation(input as OperationInput); } catch (e) { return (e as StorageError).path; } return undefined; };
  assert.equal(path({ ...base, operationId: "bad id" }), "operationId");
  assert.equal(path({ ...base, changes: [{ type: "update", ref: { kind: "task", id: "t1" }, expectedRevision: 0, body: {} }] }), "changes[0].expectedRevision");
  assert.equal(path({ ...base, timers: [{ timerId: "t", dueAt: "x", payload: {} }] }), "timers[0].dueAt");
  assert.equal(path({ ...base, extra: 1 }), "operation.extra");
  assert.equal(path({ ...base, changes: [{ ...base.changes[0], extra: 1 }] }), "changes[0].extra");
  assert.equal(path(null), "operation");
});
