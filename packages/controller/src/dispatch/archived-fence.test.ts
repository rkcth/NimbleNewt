import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { decisionLoops, improvementOutcomeLoops, liveProjectIds, projectIds, recordLoops, responsibilityLoops, responsibilityRunLoops, leaseExpiryLoops, reviewLoops, standupLoops, untoldImprovementLoops } from "./loops.js";
import { buildWorld } from "./testing/world.js";

after(stopServer);

const by = { id: "service:dispatcher", kind: "service" } as never;

/** Card P06 (reviews fence): the loops that start new work for an agent or tell people skip an archived project, read fresh each tick, and carry on after the restore with nothing lost. */
for (const backend of backends) {
  test(`${backend.name}: an archived project's waiting work is held by every loop that starts work or tells people, record settling keeps running, and after the restore the held work is done`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const second = (await w.projects.createProject({ commandId: "p2", actor: w.owner.id, name: "Second" })).id;
      const flip = async (projectId: string, state: "archived" | "active"): Promise<void> => {
        const cur = (await w.projects.getProject(projectId))!;
        await w.projects.updateProject({ commandId: `st-${state}-${projectId}-${cur.revision}`, actor: w.owner.id, projectId, expectedRevision: cur.revision, state } as never);
      };
      const live = (): Promise<string[]> => liveProjectIds(w.projects);
      const all = (): Promise<string[]> => projectIds(w.projects);
      // Work that waits in each project; a call to the service for a project serves what waits there (the service is the thing that starts the work).
      const waiting = new Map<string, number>([[w.project, 1], [second, 1]]);
      const served: string[] = [];
      const serve = (name: string) => async (_by: unknown, c: string | { projectId: string }): Promise<unknown> => {
        const id = typeof c === "string" ? c : c.projectId;
        if ((waiting.get(id) ?? 0) > 0) { waiting.set(id, 0); served.push(`${name}:${id === w.project ? "first" : "second"}`); }
        return { more: false, failures: [], done: 0, pending: 0 };
      };
      const reset = (): void => { waiting.set(w.project, 1); waiting.set(second, 1); served.length = 0; };
      const noOccurrences = { planned: (async () => ({ items: [] })) as never };
      const loops = [
        ...reviewLoops({ sweep: serve("reviews") as never }, live),
        ...decisionLoops({ resume: serve("decisions") as never }, live),
        ...improvementOutcomeLoops({ deliverOutcomes: serve("improvements") }, live),
        ...untoldImprovementLoops({ untold: async (_by, id) => { await serve("untold")(by, id); return []; } }, live, async () => undefined),
        ...standupLoops({ prepare: (async () => undefined) as never, deliverOutcomes: serve("standups") as never }, noOccurrences, all, live).filter((l) => l.name === "standups.deliverOutcomes"),
        ...responsibilityLoops({ generate: async (_by, id) => serve("checks")(by, id) }, { escalate: async () => undefined, untold: async () => [], markNotified: async () => undefined }, live),
        ...responsibilityRunLoops({ runner: { run: async (_by, id) => serve("runner")(by, id) } }, live),
        ...leaseExpiryLoops({ expiredUntold: async (_by, id) => { await serve("lease")(by, id); return []; }, markExpiryTold: async () => undefined }, live, async () => undefined),
      ];
      const settled: string[] = [];
      const settle = recordLoops({ sweep: async (_by, c) => { settled.push(c.projectId === w.project ? "first" : "second"); return {} as never; } }, all);
      const runAll = async (): Promise<void> => { for (const l of [...loops, ...settle]) await l.run(by); };
      const names = ["reviews", "decisions", "improvements", "untold", "standups", "checks", "runner", "lease"];

      // Active: both projects are served by every loop.
      await runAll();
      assert.deepEqual(waiting.get(w.project), 0, "an active project's waiting work is served");
      // Each loop alone, so which loop skipped which project is visible.
      for (const l of loops) { reset(); await l.run(by); }

      // Archive the first project: nothing is served for it by any of the eight loops, the other project still is, and the record sweep still settles it.
      await flip(w.project, "archived");
      assert.deepEqual(await live(), [second], "the live list leaves the archived project out, and reads it fresh");
      assert.ok((await all()).includes(w.project), "the full list keeps it");
      let heldOnly = 0;
      for (const [index, l] of loops.entries()) {
        reset(); settled.length = 0;
        await l.run(by);
        assert.deepEqual(served.filter((s) => s.endsWith(":first")), [], `${l.name} (${names[index]}) did nothing for the archived project`);
        assert.equal(waiting.get(w.project), 1, `${l.name} left the archived project's waiting work as it was`);
        heldOnly++;
      }
      assert.equal(heldOnly, loops.length);
      settled.length = 0;
      for (const l of settle) await l.run(by);
      assert.deepEqual(settled.sort(), ["first", "second"], "record settling still reaches the archived project");

      // A restore by another controller counts at the very next pass, and the held work is done then.
      await flip(w.project, "active");
      for (const l of loops) { reset(); await l.run(by); assert.ok(served.some((s) => s.endsWith(":first")), `${l.name} carries on for the restored project`); }
      // Archive again with the work still waiting, restore, and everything is served exactly once, none lost.
      reset();
      await flip(w.project, "archived");
      for (const l of loops) await l.run(by);
      assert.equal(waiting.get(w.project), 1, "nothing was served while archived");
      await flip(w.project, "active");
      for (const l of loops) await l.run(by);
      assert.equal(waiting.get(w.project), 0, "the held work was done after the restore");
      assert.equal(served.filter((s) => s.endsWith(":first")).length, 1, "and it was done once");
    } finally { await store.close(); }
  });

  test(`${backend.name}: the live list pages through every project and leaves out only the archived ones`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const ids = [w.project];
      for (let n = 0; n < 3; n++) ids.push((await w.projects.createProject({ commandId: `pp${n}`, actor: w.owner.id, name: `P${n}` })).id);
      const cur = (await w.projects.getProject(ids[2]!))!;
      await w.projects.updateProject({ commandId: "arch2", actor: w.owner.id, projectId: ids[2]!, expectedRevision: cur.revision, state: "archived" } as never);
      assert.deepEqual((await liveProjectIds(w.projects)).sort(), ids.filter((id) => id !== ids[2]).sort());
      assert.deepEqual((await projectIds(w.projects)).sort(), [...ids].sort());
    } finally { await store.close(); }
  });

  test(`${backend.name}: the live list reads past a full page whose last project is archived`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      // 101 projects in all (a page is 100): the 100th and the 101st by ID are archived, so the first page ends on an archived project and the second holds only one.
      for (let n = 0; n < 100; n++) await w.projects.createProject({ commandId: `pg${n}`, actor: w.owner.id, name: `P${n}` });
      const ids = (await projectIds(w.projects)).sort();
      assert.equal(ids.length, 101);
      for (const id of [ids[99]!, ids[100]!]) {
        const cur = (await w.projects.getProject(id))!;
        await w.projects.updateProject({ commandId: `pga-${id}`, actor: w.owner.id, projectId: id, expectedRevision: cur.revision, state: "archived" } as never);
      }
      assert.deepEqual((await liveProjectIds(w.projects)).sort(), ids.slice(0, 99), "every live project, none twice, the archived ones left out");
    } finally { await store.close(); }
  });
}

/** Card P06 (reviews fence) review: the live list is never cut short or repeated by paging, whatever the archived projects at the page ends (a loop handed a partial list would serve nobody in the rest, for ever). */
test("the live list pages correctly for every size around the page and every archived position at the page ends", async () => {
  for (const size of [0, 1, 99, 100, 101, 199, 200, 201, 350]) {
    for (const archivedAt of [[], [99], [100], [99, 100], [199, 200], "all", "first-page"] as const) {
      const rows = Array.from({ length: size }, (_, n) => ({ id: `p${String(n).padStart(4, "0")}`, state: "active" as string }));
      if (archivedAt === "all") for (const r of rows) r.state = "archived";
      else if (archivedAt === "first-page") for (const r of rows.slice(0, 100)) r.state = "archived";
      else for (const at of archivedAt) if (rows[at] !== undefined) rows[at]!.state = "archived";
      let reads = 0;
      const port = {
        listProjects: async (page: { afterId?: string; limit: number }) => {
          reads++;
          assert.ok(reads <= Math.floor(size / 100) + 1, "no more reads than pages");
          const from = page.afterId === undefined ? 0 : rows.findIndex((r) => r.id === page.afterId) + 1;
          assert.ok(page.afterId === undefined || from > 0, "the cursor is a project that was read");
          return rows.slice(from, from + page.limit) as never;
        },
      };
      const want = rows.filter((r) => r.state !== "archived").map((r) => r.id);
      assert.deepEqual(await liveProjectIds(port), want, `${size} projects, archived ${JSON.stringify(archivedAt)}`);
      assert.equal(reads, Math.floor(size / 100) + 1, "one read per page and one that finds the end");
    }
  }
});
