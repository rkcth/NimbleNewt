import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseHost, type HostVerdict } from "./candidates.js";

const hosts = (...ids: string[]) => ids.map((hostId) => ({ hostId }));
const judgeFrom = (table: Record<string, HostVerdict>, asked: string[] = []) => async (h: { hostId: string }): Promise<HostVerdict> => { asked.push(h.hostId); return table[h.hostId] ?? { kind: "take" }; };
const refuse = (reason: string, lasting = true, revoked = false): HostVerdict => ({ kind: "refuse", reason, lasting, ...(revoked ? { revoked } : {}) });

test("the first candidate that takes the attempt is chosen and later ones are not asked", async () => {
  const asked: string[] = [];
  const r = await chooseHost(hosts("a", "b", "c"), judgeFrom({}, asked));
  assert.equal(r.kind, "chosen");
  assert.deepEqual(asked, ["a"]);
  if (r.kind === "chosen") { assert.equal(r.candidate.hostId, "a"); assert.deepEqual(r.refusals, []); }
});

test("a refusal falls back to the next candidate and every refusal keeps its reason, in order", async () => {
  const asked: string[] = [];
  const r = await chooseHost(hosts("a", "b", "c"), judgeFrom({ a: refuse("a is draining", false), b: refuse("b has no gpu capability") }, asked));
  assert.deepEqual(asked, ["a", "b", "c"]);
  assert.equal(r.kind, "chosen");
  if (r.kind === "chosen") {
    assert.equal(r.candidate.hostId, "c");
    assert.deepEqual(r.refusals.map((x) => [x.hostId, x.reason, x.lasting]), [["a", "a is draining", false], ["b", "b has no gpu capability", true]]);
  }
});

test("the order of the candidates decides: the same hosts reversed choose the other one", async () => {
  const r1 = await chooseHost(hosts("a", "b"), judgeFrom({}));
  const r2 = await chooseHost(hosts("b", "a"), judgeFrom({}));
  assert.equal(r1.kind === "chosen" && r1.candidate.hostId, "a");
  assert.equal(r2.kind === "chosen" && r2.candidate.hostId, "b");
});

test("when all refuse there is one wait with every reason and a lasting refusal", async () => {
  const r = await chooseHost(hosts("a", "b"), judgeFrom({ a: refuse("a is at capacity"), b: refuse("policy excludes b") }));
  assert.equal(r.kind, "wait");
  if (r.kind === "wait") {
    assert.equal(r.reason, "a is at capacity; policy excludes b");
    assert.equal(r.lastingRefusal, true);
    assert.equal(r.blocked, false);
    assert.equal(r.refusals.length, 2);
  }
});

test("passing reasons only wait: a host merely not connected never counts as a lasting refusal", async () => {
  const r = await chooseHost(hosts("a", "b"), judgeFrom({ a: refuse("a is unreachable", false), b: refuse("policy excludes b") }));
  assert.equal(r.kind === "wait" && r.lastingRefusal, false);
});

test("all revoked is blocked, not a lasting refusal; revoked beside a lasting refusal still counts as lasting", async () => {
  const gone = await chooseHost(hosts("a", "b"), judgeFrom({ a: refuse("a is revoked", true, true), b: refuse("b is revoked", true, true) }));
  assert.equal(gone.kind === "wait" && gone.blocked, true);
  assert.equal(gone.kind === "wait" && gone.lastingRefusal, false);
  const mix = await chooseHost(hosts("a", "b"), judgeFrom({ a: refuse("a is revoked", true, true), b: refuse("policy excludes b") }));
  assert.equal(mix.kind === "wait" && mix.blocked, false);
  assert.equal(mix.kind === "wait" && mix.lastingRefusal, true);
});

test("no candidates is a blocked wait with a plain reason", async () => {
  const r = await chooseHost([], judgeFrom({}));
  assert.equal(r.kind, "wait");
  if (r.kind === "wait") { assert.equal(r.blocked, true); assert.equal(r.reason, "no worker host is configured"); }
});
