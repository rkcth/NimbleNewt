import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EventService } from "../events/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { defaultEventSources, DEFAULT_SOURCE_LIMITS } from "./default-sources.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("the built-in source records what is already closed without reporting it, then reports each later closing once, keeps a bounded memory and loses nothing past its limit (card H13e)", async () => {
  const day = 86_400_000;
  let now = Date.parse("2026-10-29T12:00:00.000Z");
  const P = "prj-aaaaaaaaaaaaaaaaaaaa";
  const rows = new Map<string, { id: string; state: string; projectId: string; updatedAt: string }>();
  const put = (id: string, state: string, ageDays = 0) => rows.set(id, { id, state, projectId: P, updatedAt: new Date(now - ageDays * day).toISOString() });
  // Two tasks to a page, so reading goes across pages.
  const listTasks = async (q: { afterId?: string; limit: number }) => {
    const all = [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
    const from = q.afterId === undefined ? 0 : all.findIndex((r) => r.id === q.afterId) + 1;
    const items = all.slice(from, from + 2);
    return { items: items as never, ...(from + 2 < all.length ? { next: items[items.length - 1]!.id } : {}) };
  };
  const [source] = defaultEventSources({ listTasks } as never, () => now);
  const poll = (state: unknown, limit = 10) => source!.poll({ state: state as never, now: new Date(now).toISOString(), limit });
  put("task-1", "done", 1); put("task-2", "in_progress"); put("task-3", "cancelled", 8); put("task-4", "done", 2);
  const first = await poll(undefined);
  assert.deepEqual(first.signals, [], "the first pass only records");
  assert.deepEqual(Object.keys((first.state as { seen: object }).seen).sort(), ["task-1", "task-4"], "an older closing is not remembered at all");
  // Later closings are reported once, on their project's stream.
  put("task-2", "done");
  const second = await poll(first.state);
  assert.deepEqual(second.signals.map((s) => [s.kind, s.ref.id, s.stream]), [["task.completed", "task-2", `project:${P}`]]);
  assert.deepEqual((await poll(second.state)).signals, [], "each is reported once");
  // More than the limit: the rest is found by the next poll, not skipped.
  put("task-5", "done"); put("task-6", "cancelled"); put("task-7", "done");
  const burst = await poll(second.state, 1);
  assert.equal(burst.signals.length, 1);
  assert.equal(burst.more, true);
  const rest: string[] = [burst.signals[0]!.ref.id];
  let state = burst.state;
  for (let i = 0; i < 5 && rest.length < 3; i++) { const r = await poll(state, 1); rest.push(...r.signals.map((x) => x.ref.id)); state = r.state; }
  assert.deepEqual(rest.sort(), ["task-5", "task-6", "task-7"]);
  // A week on, what it remembers shrinks to nothing.
  now += 8 * day;
  const later = await poll(state);
  assert.deepEqual(later.signals, []);
  assert.deepEqual(Object.keys((later.state as { seen: object }).seen), [], "nothing older than a week is kept");
  assert.ok(DEFAULT_SOURCE_LIMITS.scan >= 1000);
  // The state record is size-limited, so what it remembers is capped (the most recently closed are kept); the dedup key carries the closing time, so a task closed again is a new event.
  rows.clear();
  for (let i = 0; i < DEFAULT_SOURCE_LIMITS.remembered + 100; i++) put(`task-${String(i).padStart(5, "0")}`, "done");
  const big = await poll(undefined);
  assert.equal(Object.keys((big.state as { seen: object }).seen).length, DEFAULT_SOURCE_LIMITS.remembered);
  put("task-x", "in_progress"); const open = await poll(big.state); void open;
  put("task-x", "done");
  const closed = await poll(big.state, 1000);
  assert.match(closed.signals.find((x) => x.ref.id === "task-x")!.dedup, /^task-x:done@\d+$/);
});

test("a controller with no sources given polls the built-in one: a task marked done appears once on its project's stream, and an empty list turns it off (card H13e)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-src-"));
  try {
    for (const off of [false, true]) {
      const c = await startController({ storage: { kind: "sqlite", path: join(d, off ? "off.sqlite" : "on.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], ...(off ? { eventSources: [] } : {}), dispatch: { timer: new ManualTimer(), intervalMs: 1000 } });
      try {
        const s = c.services;
        const rob = await s.principals.authenticate((await s.principals.bootstrapOwner({ name: "rob" })).token);
        const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
        const task = (await s.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Dig" })).id;
        // The first pass only records what is already closed; the closing after it is reported.
        await c.dispatch!.dispatcher.tick();
        for (const [i, to] of (["ready", "in_progress", "done"] as const).entries()) await s.projects.transitionTask({ commandId: `tr${i}`, actor: rob.id, taskId: task, expectedRevision: i + 1, to });
        for (let i = 0; i < 3; i++) await c.dispatch!.dispatcher.tick();
        const trace = await EventService.withEpoch(c.storage, c.epoch).trace(rob, `project:${project}`);
        assert.deepEqual(trace.map((e) => [e.kind, e.ref.id]), off ? [] : [["task.completed", task]]);
      } finally { await c.close(); }
    }
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
