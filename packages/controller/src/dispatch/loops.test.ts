import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { activeAgents, attendanceLoops, budgetNoticeLoops, decisionLoops, eventLoops, meetingLoops, messageLoops, projectIds, recordLoops, responsibilityLoops, untoldImprovementLoops, attemptWaker, wakeLoops, recoveryLoops, standupLoops, sourceLoops } from "./loops.js";
import { buildWorld, workGrants } from "./testing/world.js";

after(stopServer);

for (const backend of backends) {
  test(`${backend.name}: a tick runs the loops of the services that said "the controller's loop must call this", as the dispatcher's service principal, and a loop that fails does not stop the others`, async () => {
    const store = await backend.open();
    try {
      const calls: string[] = [];
      const seenBy = new Set<string>();
      const note = (name: string) => async (by: { id: string }, ..._rest: unknown[]) => { calls.push(name); seenBy.add(by.id); };
      let expireRounds = 0;
      const w = await buildWorld(store.storage);
      await w.agent("ann", workGrants(w.project, []));
      const second = (await w.projects.createProject({ commandId: "p2", actor: w.owner.id, name: "Second" })).id;
      const loops = [
        ...messageLoops({ settleDue: note("settleDue") as never, release: (async (by: { id: string }, c: { recipient: string }) => { calls.push(`release ${c.recipient}`); seenBy.add(by.id); }) as never }, () => activeAgents(store.storage)),
        ...attendanceLoops({ sweepReturns: note("sweepReturns") as never }),
        ...standupLoops(
          { prepare: (async (by: { id: string }, occurrence: string) => { calls.push(`prepare ${occurrence}`); seenBy.add(by.id); }) as never, deliverOutcomes: (async (_by: unknown, projectId: string) => { calls.push(`outcomes ${projectId === w.project ? "first" : "second"}`); }) as never },
          { planned: (async (_by: unknown, projectId: string, page: { afterId?: string }) => (projectId === w.project && page.afterId === undefined ? { items: [{ id: "occ-1" }, { id: "occ-2" }], next: "occ-2" } : projectId === w.project ? { items: [{ id: "occ-3" }] } : { items: [] })) as never },
          () => projectIds(w.projects),
        ),
        ...eventLoops({ expireIdle: (async () => { expireRounds++; return { expired: [], noticed: 0, noticeFailed: 0, more: expireRounds < 3 }; }) as never }),
        { name: "broken", run: async () => { throw new Error("storage hiccup"); } },
        ...decisionLoops({ resume: (async (_by: unknown, c: { projectId: string }) => { calls.push(`resume ${c.projectId === w.project ? "first" : "second"}`); return { done: 0, pending: 0, more: false, failures: [] }; }) as never }, () => projectIds(w.projects)),
      ];
      const d = w.restart({ loops });
      const report = await d.tick();
      assert.deepEqual(report.loops.map((l) => [l.name, l.ok]), [["messages.settleDue", true], ["messages.release", true], ["attendance.sweepReturns", true], ["standups.prepare", true], ["standups.deliverOutcomes", true], ["events.expireIdle", true], ["broken", false], ["decisions.resume", true]]);
      assert.match(report.loops.find((l) => l.name === "broken")!.error ?? "", /storage hiccup/);
      assert.deepEqual(calls.filter((c) => c.startsWith("prepare")), ["prepare occ-1", "prepare occ-2", "prepare occ-3"], "every planned occurrence of every project, paged without cutting any off");
      assert.ok(calls.includes("release agent:ann") && calls.includes("settleDue") && calls.includes("sweepReturns"));
      assert.deepEqual(calls.filter((c) => c.startsWith("outcomes")).sort(), ["outcomes first", "outcomes second"]);
      assert.deepEqual(calls.filter((c) => c.startsWith("resume")).length, 2);
      assert.equal(expireRounds, 3, "a loop that reports more is repeated within the tick");
      assert.deepEqual([...seenBy], ["service:dispatcher"], "the loops run as the dispatcher's service principal, never an agent or the owner");
      assert.ok((await projectIds(w.projects)).includes(second));
    } finally { await store.close(); }
  });
}

test("the meeting clock loop ticks every page of schedules and sends the invitations of every planned occurrence of every project, as the dispatcher", async () => {
  const calls: string[] = [];
  const seenBy = new Set<string>();
  const pages: Record<string, { created: never[]; missed: never[]; blocked: never[]; skipped: never[]; next?: string }> = { "": { created: [], missed: [], blocked: [], skipped: [], next: "s-2" }, "s-2": { created: [], missed: [], blocked: [], skipped: [] } };
  const loops = meetingLoops({
    tick: (async (by: { id: string }, page: { afterId?: string }) => { calls.push(`tick ${page.afterId ?? "first"}`); seenBy.add(by.id); return pages[page.afterId ?? ""]!; }) as never,
    planned: (async (_by: unknown, projectId: string, page: { afterId?: string }) => (projectId === "p-1" && page.afterId === undefined ? { items: [{ id: "occ-1" }], next: "occ-1" } : projectId === "p-1" ? { items: [{ id: "occ-2" }] } : { items: [{ id: "occ-3" }] })) as never,
    dispatchInvitations: (async (by: { id: string }, occurrence: string) => { calls.push(`invite ${occurrence}`); seenBy.add(by.id); return { invited: [], withheld: [] }; }) as never,
  }, async () => ["p-1", "p-2"]);
  assert.deepEqual(loops.map((l) => l.name), ["meetings.tick", "meetings.invite"]);
  const by = { id: "service:dispatcher" } as never;
  for (const l of loops) await l.run(by);
  assert.deepEqual(calls, ["tick first", "tick s-2", "invite occ-1", "invite occ-2", "invite occ-3"]);
  assert.deepEqual([...seenBy], ["service:dispatcher"]);
});

test("recovery loops: the pass runs; the scan continues from where it stopped and wraps; the principal is read again each tick so a right granted or revoked later takes effect; a missing right is reported once, and a notice that failed is tried again", async () => {
  const seen: (string | undefined)[] = [];
  let allowed = false; let pages = 0; let passes = 0; let notices = 0; let noticeFails = 1;
  const stall = { scan: (async (by: { id: string }, page: { afterId?: string }) => {
    if (!allowed) throw new DomainError("forbidden", `${by.id} may not run stall detection`);
    seen.push(page.afterId); pages++;
    return { checked: 1, opened: 0, reopened: 0, cleared: 0, contended: 0, ...(pages % 12 === 0 ? {} : { next: `a${pages}` }) };
  }) as never };
  let renewals = 0;
  const loops = recoveryLoops(stall, { runPass: async () => { passes++; } }, async () => { if (noticeFails-- > 0) throw new Error("storage hiccup"); notices++; }, async () => { renewals++; return { id: "service:dispatcher" } as never; });
  const [reconcile, scan] = loops;
  await reconcile!.run({ id: "x" } as never);
  assert.equal(passes, 1);
  await assert.rejects(() => scan!.run({ id: "x" } as never), /storage hiccup/);
  await scan!.run({ id: "x" } as never); await scan!.run({ id: "x" } as never);
  assert.equal(notices, 1, "the failed notice was tried again, then said once");
  allowed = true; // granted while running
  await scan!.run({ id: "x" } as never);
  assert.equal(seen.length, 10, "a tick scans at most ten pages");
  await scan!.run({ id: "x" } as never);
  assert.equal(seen[10], "a10", "the next tick continues from the cursor");
  await scan!.run({ id: "x" } as never);
  assert.equal(seen[12], undefined, "after the last page the scan wraps to the start");
  assert.ok(renewals >= 5);
});

test("the budget notice loop tells every holder again until the notice is filed, skips a holder who cannot be told, and lets a real fault out (card R05e)", async () => {
  const owed = [1, 2, 3].map((n) => ({ requestId: `r${n}`, taskId: `t${n}`, to: `agent:h${n}`, requestedBy: "agent:x", costMicros: 1, computeMs: 0 }));
  const told: string[] = [];
  let full = true;
  const [loop] = budgetNoticeLoops({ openForHolders: async () => owed }, async (n) => {
    if (n.requestId === "r1" && full) throw new DomainError("unavailable", "the inbox is full");
    if (n.requestId === "r2") throw new DomainError("forbidden", "cannot be told");
    told.push(n.requestId);
  });
  await loop!.run({ id: "x" } as never);
  assert.deepEqual(told, ["r3"], "a full inbox and a holder who cannot be told do not stop the others");
  full = false;
  await loop!.run({ id: "x" } as never);
  assert.deepEqual(told, ["r3", "r1", "r3"], "the notice that could not be filed is tried again on the next tick");
  const [broken] = budgetNoticeLoops({ openForHolders: async () => owed }, async () => { throw new Error("storage hiccup"); });
  await assert.rejects(() => broken!.run({ id: "x" } as never), /storage hiccup/);
});

test("a request that cannot be told does not hold back the ones after it, and its fault still surfaces (card R05e)", async () => {
  const owed = [1, 2, 3].map((n) => ({ requestId: `r${n}`, taskId: `t${n}`, to: `agent:h${n}`, requestedBy: "agent:x", costMicros: 1, computeMs: 0 }));
  const told: string[] = [];
  const [loop] = budgetNoticeLoops({ openForHolders: async () => owed }, async (n) => { if (n.requestId === "r1") throw new DomainError("invalid_command", "bad request"); told.push(n.requestId); });
  await assert.rejects(() => loop!.run({ id: "x" } as never), /bad request/);
  assert.deepEqual(told, ["r2", "r3"], "the holders after the bad request were still told");
});

test("the meeting record sweep runs for every project, as the tick's principal (card M02c)", async () => {
  const seen: string[] = [];
  const [loop] = recordLoops({ sweep: async (by, c) => { seen.push(`${by.id}:${c.projectId}`); return { closed: [], tied: [], failedTies: [], interrupted: [] }; } }, async () => ["proj-a", "proj-b"]);
  assert.equal(loop!.name, "meeting-records.sweep");
  await loop!.run({ id: "service:dispatcher", kind: "service" } as never);
  assert.deepEqual(seen, ["service:dispatcher:proj-a", "service:dispatcher:proj-b"]);
});

test("each tick records the checks that came due and escalates incidents, for every project, as the tick's principal (card P04)", async () => {
  const seen: string[] = [];
  const [loop] = responsibilityLoops({ generate: async (by, p) => { seen.push(`check:${by.id}:${p}`); return []; } }, { escalate: async (by, p) => { seen.push(`escalate:${by.id}:${p}`); return []; } }, async () => ["proj-a", "proj-b"]);
  assert.equal(loop!.name, "responsibilities.checks");
  await loop!.run({ id: "service:dispatcher", kind: "service" } as never);
  assert.deepEqual(seen, ["check:service:dispatcher:proj-a", "escalate:service:dispatcher:proj-a", "check:service:dispatcher:proj-b", "escalate:service:dispatcher:proj-b"]);
});

test("a watched event wakes the agent only when its attempt will read the inbox, and the wake loop asks every tick (card H13c)", async () => {
  const states = new Map<string, string>([["att-run", "running"], ["att-wait", "waiting"], ["att-park", "parked"], ["att-done", "finished"]]);
  const waker = attemptWaker(() => ({ get: async (_by, id) => (states.has(id) ? { state: states.get(id)! } : undefined) }), { id: "service:dispatcher", kind: "service" } as never);
  const ask = async (attemptId: string) => waker.wake({ agent: "agt-a", taskId: "task-1", attemptId, handlingId: "h", round: 0, messageId: "m", reconcile: false, events: 1 });
  assert.deepEqual(await Promise.all(["att-run", "att-wait", "att-park", "att-done", "att-none"].map(ask)), ["woken", "woken", "deferred", "deferred", "deferred"]);
  assert.equal(attemptWaker(() => undefined, { id: "x", kind: "service" } as never).wake.length, 1);
  let asked = 0;
  const [loop] = wakeLoops({ consumeWakes: async () => { asked++; return { woken: 0, deferred: 0, scanLimited: false }; } }, waker);
  assert.equal(loop!.name, "events.wakes");
  await loop!.run({ id: "service:dispatcher", kind: "service" } as never); await loop!.run({ id: "service:dispatcher", kind: "service" } as never);
  assert.equal(asked, 2);
});

test("the source loop polls the given sources once per tick as the dispatcher, does nothing without any, and reports a failed source after the rest (card H13d)", async () => {
  assert.deepEqual(sourceLoops({ run: async () => [] }, []), [], "no sources, no loop");
  const seen: string[] = [];
  let runs: { source: string; polled: number; published: number; duplicates: number; suppressed: number; rejected: string[]; more: boolean; error?: string }[] = [{ source: "a", polled: 2, published: 2, duplicates: 0, suppressed: 0, rejected: [], more: false }];
  const sources = [{ id: "a", poll: async () => ({ signals: [] }) }, { id: "b", poll: async () => ({ signals: [] }) }];
  const [loop] = sourceLoops({ run: async (by, list) => { seen.push(`${by.id}:${list.map((x) => x.id).join(",")}`); return runs; } }, sources as never);
  await loop!.run({ id: "service:dispatcher", kind: "service" } as never);
  assert.deepEqual(seen, ["service:dispatcher:a,b"]);
  runs = [{ source: "a", polled: 0, published: 0, duplicates: 0, suppressed: 0, rejected: [], more: false }, { source: "b", polled: 0, published: 0, duplicates: 0, suppressed: 0, rejected: [], more: false, error: "the server did not answer" }];
  await assert.rejects(loop!.run({ id: "service:dispatcher", kind: "service" } as never), /1 event source\(s\) could not be polled: b: the server did not answer/);
});

test("the owner is told of a decision that has gone untold, once per decision and project by project, and a project that fails is named after the rest (card M03e)", async () => {
  const told: string[] = [];
  const asked: string[] = [];
  const [loop] = untoldImprovementLoops(
    { untold: async (_by, projectId, olderThanMs) => { asked.push(`${projectId}:${olderThanMs}`); if (projectId === "bad") throw new Error("storage hiccup"); return [{ id: "imp-1", revision: 3, title: "Retry builds", disposition: "adopted", decidedAt: "2026-10-01T00:00:00.000Z" }]; } },
    async () => ["p1", "bad", "p2"],
    async (n) => { told.push(`${n.key}|${n.projectId}|${n.itemId}`); },
  );
  await assert.rejects(loop!.run({ id: "service:dispatcher", kind: "service" } as never), /1 project\(s\): bad: storage hiccup/);
  assert.deepEqual(asked, ["p1:604800000", "bad:604800000", "p2:604800000"]);
  assert.deepEqual(told, ["imu:imp-1:3|p1|imp-1", "imu:imp-1:3|p2|imp-1"]);
  assert.throws(() => untoldImprovementLoops({ untold: async () => [] }, async () => [], async () => undefined, 0));
  // The owner's notification keeps detail text to 200 characters, so a long title is cut.
  const long: string[] = [];
  const [cut] = untoldImprovementLoops({ untold: async () => [{ id: "imp-2", revision: 1, title: "t".repeat(200), disposition: "investigating", decidedAt: "2026-10-01T00:00:00.000Z" }] }, async () => ["p1"], async (n) => { long.push(n.text); });
  await cut!.run({ id: "service:dispatcher", kind: "service" } as never);
  assert.ok(long[0]!.length <= 200, String(long[0]!.length));
});
