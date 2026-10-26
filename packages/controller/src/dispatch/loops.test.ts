import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { activeAgents, attendanceLoops, decisionLoops, eventLoops, meetingLoops, messageLoops, projectIds, recoveryLoops, standupLoops } from "./loops.js";
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
