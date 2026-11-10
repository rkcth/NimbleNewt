import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld, workGrants, type DispatchWorld } from "./testing/world.js";

after(stopServer);

// Card A07h at placement: the dispatcher's grant check renews a standing grant with an idle window (at most once a day), and a task that stalls because such a grant lapsed says so in its blocker.
const DAY = 86_400_000;

for (const backend of backends) {
  const suite = (name: string, body: (c: DispatchWorld & { run(): Promise<Awaited<ReturnType<DispatchWorld["dispatcher"]["tick"]>>> }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const store = await backend.open();
      try {
        const w = await buildWorld(store.storage);
        const c = Object.assign(w, { run: async () => { const r = await c.dispatcher.tick(); await c.dispatcher.idle(); return r; } });
        await body(c);
      } finally { await store.close(); }
    });
  const blockers = async (c: DispatchWorld) => (await c.storage.listAggregates("blocker", { limit: 100 })).map((a) => a.body as unknown as { type: string; summary: string; state: string });
  /** The agent's enrolment grants without the two rights an attempt cannot run without; those come from one standing grant with a 30-day idle window. */
  const withIdleGrant = async (c: DispatchWorld) => {
    const ann = await c.agent("ann", workGrants(c.project).filter((g) => g.action !== "attempt.work" && g.action !== "task.read"));
    const g = await c.grants.grant(c.owner, { commandId: `idle-${c.project}`, grantee: "agent:ann", action: "*", project: c.project, source: "standing", basis: "keep the garden going", idleDays: 30 });
    return { ann, grantId: g.id };
  };

  suite("placing a task renews the grant it needs, written at most once a day", async (c) => {
    const { ann, grantId } = await withIdleGrant(c);
    c.clock.advance(20 * DAY); await c.heartbeatHost();
    const before = (await c.grants.getGrant(grantId))!.revision;
    await c.task("first", ann);
    assert.equal((await c.run()).started.length, 1);
    const renewed = (await c.grants.getGrant(grantId))!;
    assert.equal(renewed.lastUsedAt, c.clock.now(), "the window starts again");
    assert.equal(renewed.revision, before + 1);
    // More placements the same day write nothing more.
    for (let i = 0; i < 3; i++) { await c.task(`more ${i}`, ann); await c.run(); }
    assert.equal((await c.grants.getGrant(grantId))!.revision, before + 1);
    // Twenty-five days later (45 after it was made) it still holds, because it was used.
    c.clock.advance(25 * DAY); await c.heartbeatHost();
    await c.task("later", ann);
    assert.equal((await c.run()).started.length, 1);
    assert.ok((await blockers(c)).every((b) => b.type !== "grant_needed"));
  });

  suite("a task that waits for a host is not placed, so it does not renew the grant", async (c) => {
    const { ann, grantId } = await withIdleGrant(c);
    const made = (await c.grants.getGrant(grantId))!;
    // No host has been heard from for twenty days: the task passes the grant check and then waits.
    c.clock.advance(20 * DAY);
    await c.task("waits", ann);
    for (let i = 0; i < 3; i++) { assert.equal((await c.run()).started.length, 0); c.clock.advance(DAY); }
    const after = (await c.grants.getGrant(grantId))!;
    assert.deepEqual([after.lastUsedAt, after.revision], [made.lastUsedAt, made.revision], "waiting is not use");
    await c.heartbeatHost();
    assert.equal((await c.run()).started.length, 1);
    assert.equal((await c.grants.getGrant(grantId))!.lastUsedAt, c.clock.now(), "placing it is");
  });

  suite("a task that stalls because its grant lapsed from non-use names the lapsed right in its blocker", async (c) => {
    const { ann, grantId } = await withIdleGrant(c);
    c.clock.advance(31 * DAY); await c.heartbeatHost();
    await c.task("after the lapse", ann);
    const r = await c.run();
    assert.equal(r.started.length, 0);
    assert.equal(r.blocked[0]?.check, "grant");
    const [b] = (await blockers(c)).filter((x) => x.type === "grant_needed");
    assert.match(b!.summary, /no longer holds/);
    assert.match(b!.summary, new RegExp(`attempt\\.work: grant ${grantId} lapsed on \\d{4}-\\d{2}-\\d{2} after 30 days unused, last used 2026-10-23`));
    assert.match(b!.summary, /grant it again/);
  });

  suite("a right never given keeps the old blocker wording", async (c) => {
    const bob = await c.agent("bob", []);
    await c.task("t", bob);
    await c.run();
    const [b] = (await blockers(c)).filter((x) => x.type === "grant_needed");
    assert.match(b!.summary, /no one has given them to agent:bob$/);
  });
}
