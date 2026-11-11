import assert from "node:assert/strict";
import { test } from "node:test";
import { DETECT_LIMITS, SecurityDetectors } from "./security-detect.js";

const make = (o: { fail?: () => boolean; on?: () => boolean; hold?: Promise<void> } = {}) => {
  const reported: { by: string; kind: string; key: string; projectId?: string }[] = [];
  let live = 0, peak = 0;
  const d = new SecurityDetectors({
    report: async (by, e) => { live += 1; peak = Math.max(peak, live); try { if (o.hold !== undefined) await o.hold; if (o.fail?.() === true) throw new Error("down"); reported.push({ by: by.id, ...e }); } finally { live -= 1; } },
    enabled: async () => o.on?.() ?? true, now: () => 1_000_000, onError: () => undefined,
  });
  return { d, reported, peak: () => peak };
};

test("U11d: a signal is reported once as a service of its own source; the same signal again is dropped before any work, another source or project is another event", async () => {
  const { d, reported } = make();
  d.signal("credential", { kind: "credential-misused", key: "task:a>b" });
  d.signal("credential", { kind: "credential-misused", key: "task:a>b" });
  d.signal("credential", { kind: "credential-misused", key: "task:a>b", projectId: "proj-aaaaaaaaaaaaaaaaaaaa" });
  d.signal("host-channel", { kind: "credential-misused", key: "task:a>b" });
  await d.settled();
  assert.deepEqual(reported.map((r) => r.by).sort(), ["service:detect-credential", "service:detect-credential", "service:detect-host-channel"]);
  assert.equal(reported.length, 3);
});

test("U11d: a detector never throws or waits, whatever it is given; a bad source name, an empty key and a very long key (hashed to fit) are handled", async () => {
  const { d, reported } = make();
  assert.doesNotThrow(() => { d.signal("Bad Source!", { kind: "credential-misused", key: "x" }); d.signal("ok", { kind: "credential-misused", key: "" }); d.signal("ok", null as never); d.signal("ok", { kind: "credential-misused", key: "k".repeat(5000) }); });
  await d.settled();
  assert.equal(reported.length, 1);
  assert.ok(reported[0]!.key.length <= DETECT_LIMITS.keyChars, "the key fits the report's limit");
});

test("U11d: the owner's switch is read at each report: off drops signals (and forgets nothing wrongly), on again reports a new one", async () => {
  let on = false;
  const { d, reported } = make({ on: () => on });
  d.signal("credential", { kind: "credential-misused", key: "one" });
  await d.settled();
  assert.equal(reported.length, 0);
  on = true;
  d.signal("credential", { kind: "credential-misused", key: "two" });
  d.signal("credential", { kind: "credential-misused", key: "one" });
  await d.settled();
  assert.deepEqual(reported.map((r) => r.key).sort(), ["one", "two"], "a sign dropped while off is reported if it happens again once on");
});

test("U11d: a failed report is forgotten so the same sign can be tried again; a failing settings read counts as on", async () => {
  let fail = true;
  const { d, reported } = make({ fail: () => fail });
  d.signal("credential", { kind: "credential-misused", key: "k" });
  await d.settled();
  assert.equal(reported.length, 0);
  fail = false;
  d.signal("credential", { kind: "credential-misused", key: "k" });
  await d.settled();
  assert.equal(reported.length, 1);
  const seen: unknown[] = [];
  const b2 = new SecurityDetectors({ report: async (_by, e) => { seen.push(e); }, enabled: async () => { throw new Error("no settings"); } });
  b2.signal("credential", { kind: "credential-misused", key: "k" }); await b2.settled();
  assert.equal(seen.length, 1);
});

test("U11d: a flood of different signals is bounded: at most four reports at once, the queue holds 200, and what was dropped comes out as ONE overflow event for the source", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  const { d, reported, peak } = make({ hold });
  for (let i = 0; i < 1000; i++) d.signal("credential", { kind: "credential-misused", key: `task:a>${i}` });
  release();
  await d.settled();
  assert.ok(peak() <= DETECT_LIMITS.parallel, `peak ${peak()}`);
  const overflow = reported.filter((r) => r.key.startsWith("overflow:"));
  assert.equal(overflow.length, 1, "one overflow event");
  assert.ok(reported.length - 1 <= DETECT_LIMITS.queued + DETECT_LIMITS.parallel, `reported ${reported.length}`);
  assert.match(overflow[0]!.key, /^overflow:\d+$/);
});

test("U11d review: a second flood in the same hour adds no second overflow event (one per source and hour)", async () => {
  let release!: () => void;
  let hold = new Promise<void>((r) => { release = r; });
  const reported: { by: string; key: string }[] = [];
  const d = new SecurityDetectors({ report: async (by, e) => { await hold; reported.push({ by: by.id, key: e.key }); }, enabled: async () => true, now: () => 1_000_000 });
  for (let i = 0; i < 500; i++) d.signal("credential", { kind: "credential-misused", key: `a${i}` });
  release(); await d.settled();
  hold = new Promise<void>((r) => { release = r; });
  for (let i = 0; i < 500; i++) d.signal("credential", { kind: "credential-misused", key: `b${i}` });
  release(); await d.settled();
  assert.equal(reported.filter((r) => r.key.startsWith("overflow:")).length, 1, JSON.stringify(reported.filter((r) => r.key.startsWith("overflow:"))));
});

test("U11d review: a flood from one source cannot crowd another source's sign out of the queue", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  const { d, reported } = make({ hold });
  for (let i = 0; i < 1000; i++) d.signal("credential", { kind: "credential-misused", key: `task:a>${i}` });
  d.signal("artifact-store", { kind: "integrity-check-failed", key: "artifact:art-real" });
  release();
  await d.settled();
  assert.ok(reported.some((r) => r.by === "service:detect-artifact-store" && r.key === "artifact:art-real"), "the other source's own sign is reported as itself, not folded into an overflow");
  assert.ok(reported.filter((r) => r.by === "service:detect-credential").length <= DETECT_LIMITS.perSource + DETECT_LIMITS.parallel + 1);
});

test("U11d review: one subject naming target after target raises a few events and then ONE more, so it cannot use up the detector's allowance; another subject is not affected", async () => {
  const { d, reported } = make();
  for (let i = 0; i < 50; i++) d.signal("credential", { kind: "credential-misused", key: `task:evil>task-${i}`, subject: "task:evil" });
  d.signal("credential", { kind: "credential-misused", key: "task:other>task-x", subject: "task:other" });
  await d.settled();
  const evil = reported.filter((r) => r.key.startsWith("task:evil>") || r.key.startsWith("many:"));
  assert.equal(evil.length, DETECT_LIMITS.perSubjectPerHour + 1, JSON.stringify(evil));
  assert.equal(evil.filter((r) => r.key.startsWith("many:")).length, 1);
  assert.doesNotMatch(JSON.stringify(reported), /many:[^"]*evil/, "the collapsed key holds a digest of the subject, not its text");
  assert.ok(reported.some((r) => r.key === "task:other>task-x"));
  // A repeat of a pair already told does not count against the subject.
  const two = make();
  for (let i = 0; i < 10; i++) two.d.signal("credential", { kind: "credential-misused", key: "task:a>task-b", subject: "task:a" });
  two.d.signal("credential", { kind: "credential-misused", key: "task:a>task-c", subject: "task:a" });
  await two.d.settled();
  assert.deepEqual(two.reported.map((r) => r.key), ["task:a>task-b", "task:a>task-c"]);
});

test("U11d: the keys remembered are bounded: the oldest is forgotten first (the watch still tells one event once)", async () => {
  const { d, reported } = make();
  for (let i = 0; i < DETECT_LIMITS.recentKeys + 10; i++) { d.signal("credential", { kind: "credential-misused", key: `k${i}` }); if (i % 40 === 0) await d.settled(); }
  await d.settled();
  const before = reported.length;
  d.signal("credential", { kind: "credential-misused", key: "k0" });
  await d.settled();
  assert.equal(reported.length, before + 1, "k0 was forgotten and is offered again");
  d.signal("credential", { kind: "credential-misused", key: `k${DETECT_LIMITS.recentKeys + 9}` });
  await d.settled();
  assert.equal(reported.length, before + 1, "the newest is still remembered");
});
