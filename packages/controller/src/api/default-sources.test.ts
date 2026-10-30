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

test("the built-in source reports tasks closed in the last week, once each on their project's stream, and nothing older or still open (card H13e)", async () => {
  const day = 86_400_000;
  const now = Date.parse("2026-10-29T12:00:00.000Z");
  const row = (id: string, state: string, ageDays: number) => ({ id, state, projectId: "prj-aaaaaaaaaaaaaaaaaaaa", updatedAt: new Date(now - ageDays * day).toISOString() });
  const tasks = [row("task-1", "done", 1), row("task-2", "cancelled", 6), row("task-3", "done", 8), row("task-4", "in_progress", 0)];
  const [source] = defaultEventSources({ listTasks: async (q: { afterId?: string; limit: number }) => ({ items: q.afterId === undefined ? tasks.slice(0, 2) as never : tasks.slice(2) as never, ...(q.afterId === undefined ? { next: "task-2" } : {}) }) } as never, () => now);
  assert.equal(source!.id, "tasks");
  const first = await source!.poll({ state: undefined, now: new Date(now).toISOString(), limit: 10 });
  assert.deepEqual(first.signals.map((s) => [s.kind, s.ref.id, s.stream]), [["task.completed", "task-1", "project:prj-aaaaaaaaaaaaaaaaaaaa"], ["task.cancelled", "task-2", "project:prj-aaaaaaaaaaaaaaaaaaaa"]]);
  const again = await source!.poll({ state: first.state, now: new Date(now).toISOString(), limit: 10 });
  assert.deepEqual(again.signals, [], "each is reported once");
  assert.ok(DEFAULT_SOURCE_LIMITS.scan >= 1000);
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
        for (const [i, to] of (["ready", "in_progress", "done"] as const).entries()) await s.projects.transitionTask({ commandId: `tr${i}`, actor: rob.id, taskId: task, expectedRevision: i + 1, to });
        for (let i = 0; i < 3; i++) await c.dispatch!.dispatcher.tick();
        const trace = await EventService.withEpoch(c.storage, c.epoch).trace(rob, `project:${project}`);
        assert.deepEqual(trace.map((e) => [e.kind, e.ref.id]), off ? [] : [["task.completed", task]]);
      } finally { await c.close(); }
    }
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
