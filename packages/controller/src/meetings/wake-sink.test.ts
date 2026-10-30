import assert from "node:assert/strict";
import test from "node:test";
import { meetingWakeSink, type HostWakeRequest } from "./wake-sink.js";

const req = { key: "mto-aaa:agent:agt-bbb:1", agent: "agent:agt-bbb", occurrenceId: "mto-aaa", projectId: "prj-1" };

test("the host gets exactly the four fields, once per call", async () => {
  const seen: HostWakeRequest[] = [];
  await meetingWakeSink({ recover: async (r) => { seen.push(r); } }).wake({ ...req, extra: "x" } as typeof req);
  assert.deepEqual(seen, [req]);
});

test("a malformed request never reaches the host", async () => {
  let called = 0;
  const sink = meetingWakeSink({ recover: async () => { called++; } });
  await assert.rejects(sink.wake({ ...req, key: "other" }), /malformed/);
  await assert.rejects(sink.wake({ ...req, key: "mto-aaa:agent:agt-bbb" }), /malformed/);
  await assert.rejects(sink.wake({ ...req, key: "mto-aaa:agent:agt-bbb:0" }), /malformed/);
  await assert.rejects(sink.wake({ ...req, key: "mto-aaa:agent:agt-bbb:2:3" }), /malformed/);
  await assert.rejects(sink.wake({ ...req, agent: "user:x", key: "mto-aaa:user:x:1" }), /malformed/);
  await assert.rejects(sink.wake({ ...req, projectId: "" }), /malformed/);
  assert.equal(called, 0);
});

test("a host failure is reported without the host's own text", async () => {
  const sink = meetingWakeSink({ recover: async () => { throw new Error("ssh root@10.0.0.7 /secret/path refused"); } });
  await assert.rejects(sink.wake(req), (e: Error) => { assert.match(e.message, /did not wake agent:agt-bbb/); assert.doesNotMatch(e.message, /10\.0\.0\.7|secret/); return true; });
  const sync = meetingWakeSink({ recover: () => { throw new Error("boom /etc"); } });
  await assert.rejects(sync.wake(req), (e: Error) => !/etc/.test(e.message));
});

test("a host that does not answer in time is a failure", async () => {
  const sink = meetingWakeSink({ recover: () => new Promise(() => undefined) }, { timeoutMs: 20 });
  await assert.rejects(sink.wake(req), /did not answer in time/);
});

test("the timeout bound is checked when the sink is built", () => {
  assert.throws(() => meetingWakeSink({ recover: async () => undefined }, { timeoutMs: 0 }), RangeError);
  assert.throws(() => meetingWakeSink({ recover: async () => undefined }, { timeoutMs: 700_000 }), RangeError);
});

test("a host error that says 'timed out' is not mislabeled as a timeout, and the failure is a domain error the API passes on", async () => {
  const sink = meetingWakeSink({ recover: async () => { throw new Error("timed out"); } }, { timeoutMs: 5000 });
  await assert.rejects(sink.wake(req), (e: Error & { code?: string }) => { assert.equal(e.code, "unavailable"); assert.doesNotMatch(e.message, /in time/); return true; });
});
