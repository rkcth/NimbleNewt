import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobState } from "../jobs/index.js";
import { safeLongRunningOf } from "./safe-long-running.js";

type J = { state: JobState; background: boolean; attemptId?: string };
const jobs = (list: J[] | Error) => ({ unfinishedOf: async (_t: string) => { if (list instanceof Error) throw list; return list; } });
const A = "att-a";

test("a running attempt is safe only when all its own unfinished jobs are background jobs placed on a host and moving (card M04g)", async () => {
  const safe = (list: J[] | Error, enabled?: () => Promise<boolean>) => safeLongRunningOf(jobs(list), enabled === undefined ? {} : { enabled })("tsk-x", A);
  assert.equal(await safe([{ state: "running", background: true, attemptId: A }]), true);
  assert.equal(await safe([{ state: "dispatched", background: true, attemptId: A }, { state: "running", background: true, attemptId: A }]), true);
  assert.equal(await safe([{ state: "admitted", background: true, attemptId: A }]), false, "admitted but never placed on a host is not moving");
  assert.equal(await safe([]), false, "no job: the work is the agent's own");
  assert.equal(await safe([{ state: "running", background: true, attemptId: "att-b" }]), false, "another attempt's job is not this attempt's work");
  assert.equal(await safe([{ state: "running", background: true }]), false, "a job with no attempt is not attributed");
  assert.equal(await safe([{ state: "running", background: true, attemptId: A }, { state: "running", background: true, attemptId: "att-b" }]), true, "others' jobs are ignored");
  assert.equal(await safe([{ state: "running", background: true, attemptId: A }, { state: "running", background: false, attemptId: A }]), false, "one foreground job");
  assert.equal(await safe([{ state: "running", background: true, attemptId: A }, { state: "cancellation_requested", background: true, attemptId: A }]), false);
  assert.equal(await safe([{ state: "outcome_unknown", background: true, attemptId: A }]), false);
  assert.equal(await safe(new Error("store down")), false, "fails closed");
  assert.equal(await safe([{ state: "running", background: true, attemptId: A }], async () => false), false, "setting off");
  assert.equal(await safe([{ state: "running", background: true, attemptId: A }], async () => { throw new Error("x"); }), false, "unreadable setting");
  assert.equal(await safe(undefined as never), false, "malformed answer");
});
