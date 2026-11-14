import assert from "node:assert/strict";
import { test } from "node:test";
import { coverageGapLoops, responsibilityRunLoops, sourceGapHook, sourceLoops } from "./loops.js";

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

test("review: the source gap hook opens an outage for a failed poll, closes it on a good one, records lost events once as a closed gap, and one failing source does not skip the others (card P04f)", async () => {
  const log: string[] = [];
  let failOpen = true;
  const hook = sourceGapHook({
    open: async (_b, c) => { log.push(`open:${c.key}:${c.reason}`); if (failOpen) { failOpen = false; throw new Error("storage busy"); } },
    close: async (_b, c) => { log.push(`close:${c.key}:${c.end}`); },
    record: async (_b, c) => { log.push(`record:${c.key}:${c.reason}:${c.start}:${c.end}`); },
  }, () => by, () => "2026-11-12T12:00:00.000Z");
  const run = (source: string, extra: Record<string, unknown> = {}) => ({ source, polled: 0, published: 0, duplicates: 0, suppressed: 0, rejected: [], more: false, ...extra });
  await assert.rejects(hook([run("files", { error: "unreadable" }), run("git", { gap: { from: "2026-11-01T00:00:00.000Z", to: "2026-11-12T12:00:00.000Z" } }), run("bad", { gap: { from: "later", to: "x" } })] as never), /storage busy/);
  assert.deepEqual(log, ["open:source:files:event-source-outage", "record:source:git:events-missed:2026-11-01T00:00:00.000Z:2026-11-12T12:00:00.000Z", "close:source:git:2026-11-12T12:00:00.000Z", "close:source:bad:2026-11-12T12:00:00.000Z"], "an unreadable gap time is not recorded");
});

import { leaseExpiryLoops } from "./loops.js";
import { DomainError } from "../domain/errors.js";

test("the lease loop tells each ran-out lease once, marks it only after the notice, counts an already-sent notice as sent, and one failure does not skip the rest (cards P04g, P04h)", async () => {
  const mk = (resourceId: string, generation: number, projectId = "p") => ({ leaseId: `l-${resourceId}`, resourceId, projectId, responsibilityId: "r", holderId: "agent:a", expiredAt: "2026-11-14T10:00:00.000Z", generation, blockedCount: 0 });
  const log: string[] = [];
  const expired = [mk("a", 1), mk("b", 2), mk("c", 1), mk("d", 1, "q")];
  const [loop] = leaseExpiryLoops(
    { untold: async () => ({ expired, waiting: [] }), markExpiryTold: async (_b, r, g) => { log.push(`mark:${r}:${g}`); }, markWaitTold: async () => undefined },
    { expired: async (l) => { log.push(`tell:${l.resourceId}`); if (l.resourceId === "a") throw new Error("notices busy"); if (l.resourceId === "b") throw new DomainError("command_conflict", "already sent"); }, waiting: async () => undefined },
  );
  assert.equal(loop!.name, "responsibilities.lease-expiry");
  await assert.rejects(loop!.run(by), /notices busy/);
  assert.deepEqual(log, ["tell:a", "tell:b", "mark:b:2", "tell:c", "mark:c:1", "tell:d", "mark:d:1"], "a failed notice is not marked (it is offered again next tick); the others go on");
});

test("the lease loop tells a long wait once per holding, and closes a notice only by where its lease stands, never by the told mark (card P04h)", async () => {
  const log: string[] = [];
  const wait = { leaseId: "l-w", resourceId: "w", projectId: "p", responsibilityId: "r", holderId: "agent:a", expiresAt: "2026-11-14T12:00:00.000Z", generation: 4, blockedCount: 2, waitingSince: "2026-11-14T10:00:00.000Z", rivals: ["agent:b"] };
  const standing: Record<string, { projectId: string; status: "held" | "expired" | "free" }> = { "l-exp-open": { projectId: "p", status: "expired" }, "l-exp-moved": { projectId: "p", status: "held" }, "l-exp-freed": { projectId: "q", status: "free" }, "l-wait-live": { projectId: "p", status: "held" }, "l-wait-done": { projectId: "p", status: "free" }, "l-wait-expired": { projectId: "p", status: "expired" } };
  const [loop] = leaseExpiryLoops(
    { untold: async () => ({ expired: [], waiting: [wait] }), markExpiryTold: async () => undefined, markWaitTold: async (_b, r, g) => { log.push(`wmark:${r}:${g}`); }, standing: async (_b, id) => { if (id === "l-broken") throw new Error("read failed"); return standing[id]; } },
    { expired: async () => undefined, waiting: async (l) => { log.push(`wtell:${l.resourceId}`); } },
    { open: async () => ({ expiry: ["l-exp-open", "l-exp-moved", "l-broken", "l-exp-freed", "l-unknown"], waiting: ["l-wait-live", "l-wait-done", "l-wait-expired"] }), close: async (which, id, project) => { log.push(`close:${which}:${id}:${project}`); } },
  );
  await assert.rejects(loop!.run(by), /read failed/);
  assert.deepEqual(log, ["close:expiry:l-exp-moved:p", "close:expiry:l-exp-freed:q", "close:waiting:l-wait-done:p", "close:waiting:l-wait-expired:p", "wtell:w", "wmark:w:4"], "an open expiry notice stays while the lease is expired; a waiting notice stays while it is held; one unreadable lease does not stop the rest");
});
