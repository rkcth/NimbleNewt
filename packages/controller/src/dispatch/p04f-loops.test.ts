import assert from "node:assert/strict";
import { test } from "node:test";
import { coverageGapLoops, responsibilityRunLoops, sourceLoops } from "./loops.js";

const by = { id: "service:dispatcher", kind: "service" } as never;

test("each tick wakes responsibilities from events and then takes the owed checks, project by project; one project's failure does not skip the others (card P04f)", async () => {
  const seen: string[] = [];
  const [loop] = responsibilityRunLoops({
    events: { sweep: async (_b, p) => { seen.push(`events:${p}`); if (p === "a") throw new Error("events a failed"); } },
    runner: { run: async (_b, p) => { seen.push(`run:${p}`); } },
  }, async () => ["a", "b"]);
  assert.equal(loop!.name, "responsibilities.run");
  await assert.rejects(loop!.run(by), /events a failed/);
  assert.deepEqual(seen, ["events:a", "run:a", "events:b", "run:b"], "the checks are still taken for a project whose events could not be read, and the next project is not skipped");
});

test("the gap loop keeps the controller's heartbeat, treats the first run as a start, and opens and closes a provider-outage gap from the route health (card P04f)", async () => {
  const log: string[] = [];
  let health: { scope: string; name: string; state: "down" | "healthy"; since: string; lastClass: string; restoredAt?: string }[] = [{ scope: "model", name: "m1", state: "down", since: "2026-11-12T09:00:00.000Z", lastClass: "outage" }, { scope: "model", name: "m2", state: "healthy", since: "2026-11-12T08:00:00.000Z", lastClass: "rate-limit", restoredAt: "2026-11-12T08:30:00.000Z" }];
  const [loop] = coverageGapLoops({
    heartbeat: async (_b, o) => { log.push(o?.startup === true ? "start" : "beat"); },
    open: async (_b, c) => { log.push(`open:${c.key}:${c.start}`); },
    close: async (_b, c) => { log.push(`close:${c.key}:${c.end}`); },
  }, async () => ({ items: health }), () => "2026-11-12T12:00:00.000Z");
  assert.equal(loop!.name, "responsibilities.gaps");
  await loop!.run(by);
  assert.deepEqual(log, ["start", "open:provider:model:m1:2026-11-12T09:00:00.000Z", "close:provider:model:m2:2026-11-12T08:30:00.000Z"]);
  log.length = 0;
  health = [{ ...health[0]!, state: "healthy", restoredAt: "2026-11-12T10:15:00.000Z" }];
  await loop!.run(by);
  assert.deepEqual(log, ["beat", "close:provider:model:m1:2026-11-12T10:15:00.000Z"], "only the first run is a start; a route that came back closes its gap at the time it was restored");
});

test("a failing heartbeat or health read is reported after the rest of the tick ran (card P04f)", async () => {
  const log: string[] = [];
  const [loop] = coverageGapLoops({ heartbeat: async () => { throw new Error("storage busy"); }, open: async () => undefined, close: async () => undefined }, async () => { log.push("health"); return { items: [] }; });
  await assert.rejects(loop!.run(by), /storage busy/);
  assert.deepEqual(log, ["health"]);
  const [again] = coverageGapLoops({ heartbeat: async () => undefined, open: async () => undefined, close: async () => undefined }, async () => { throw new Error("health unreadable"); });
  await assert.rejects(again!.run(by), /health unreadable/);
});

test("the event-source loop tells the gap hook what each source did, even when a source failed, and a failing hook never stops the tick (card P04f)", async () => {
  const told: string[] = [];
  const logged: string[] = [];
  const runs = [{ source: "files", polled: 0, published: 0, duplicates: 0, suppressed: 0, rejected: [], more: false, error: "unreadable" }, { source: "git", polled: 1, published: 1, duplicates: 0, suppressed: 0, rejected: [], more: false }];
  const sources = { run: async () => runs } as never;
  const [loop] = sourceLoops(sources, [{ id: "files" }, { id: "git" }] as never, undefined, { ran: async (r) => { told.push(r.map((x) => `${x.source}:${x.error ?? "ok"}`).join(",")); throw new Error("hook broke"); }, log: (m) => logged.push(m) });
  await assert.rejects(loop!.run(by), /1 event source\(s\) could not be polled/);
  assert.deepEqual(told, ["files:unreadable,git:ok"]);
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /hook broke/);
});
