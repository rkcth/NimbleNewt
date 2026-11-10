import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { GrantService, PrincipalService } from "../security/index.js";
import { grantLapseLoops, lapseNotice } from "./index.js";

after(stopServer);

// Card A07h: the owner's one plain notice that a standing grant lapsed from non-use.
const T0 = Date.parse("2026-11-10T10:00:00.000Z");
const DAY = 86_400_000;

test("the notice names the right, who held it, where and when it was last used, each name quoted once, within the notice limit", () => {
  const text = lapseNotice({ grantId: "grt-aaaaaaaaaaaaaaaaaaaa", grantee: "agent:ann", granteeName: "Ann \"the builder\"\u202e", action: "approve.class.push", project: "proj-aaaaaaaaaaaaaaaaaaaa", projectName: "Garden", idleDays: 30, lastUsedAt: "2026-10-01T08:00:00.000Z", lapsedAt: "2026-10-31T08:00:00.000Z" });
  assert.equal(text, "\"Ann \\\"the builder\\\"\\u202e\" no longer holds approve.class.push in \"Garden\": unused for 30 days (last used 2026-10-01). Grant it again if the work needs it.");
  const long = lapseNotice({ grantId: "grt-aaaaaaaaaaaaaaaaaaaa", grantee: "agent:ann", granteeName: "x".repeat(500), action: "approve.tool.a-very-long-tool-name-that-goes-on", project: "proj-aaaaaaaaaaaaaaaaaaaa", projectName: "y".repeat(500), idleDays: 1, lapsedAt: "2026-10-31T08:00:00.000Z" });
  assert.ok(long.length <= 200, String(long.length));
  assert.match(long, /unused for 1 day \(it was never used\)/);
  assert.equal(lapseNotice({ grantId: "grt-aaaaaaaaaaaaaaaaaaaa", grantee: "agent:bob", action: "task.read", project: "*", idleDays: 7, lastUsedAt: "2026-10-01T08:00:00.000Z", lapsedAt: "2026-10-08T08:00:00.000Z" }), "agent:bob no longer holds task.read in every project: unused for 7 days (last used 2026-10-01). Grant it again if the work needs it.");
});

for (const backend of backends) {
  test(`${backend.name}: the loop tells the owner once per lapsed grant and looks no more often than its interval`, async () => {
    let now = T0;
    const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const grants = GrantService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      await principals.enroll(owner, { commandId: "e1", kind: "agent", name: "ann", grants: [] });
      const a = (await projects.createProject({ commandId: "pa", actor: "owner:rob", name: "Garden" })).id;
      const g = await grants.grant(owner, { commandId: "g1", grantee: "agent:ann", action: "approve.class.push", project: a, source: "standing", basis: "pushes", idleDays: 30 });
      const told: { key: string; grantId: string; projectId?: string; text: string }[] = [];
      const [loop] = grantLapseLoops(grants, async (n) => { told.push({ ...n }); }, 600_000, () => now);
      const by = { id: "service:dispatcher", kind: "service", name: "dispatcher", grants: [] } as never;
      await loop!.run(by);
      assert.equal(told.length, 0);
      now = T0 + 31 * DAY;
      await loop!.run(by);
      assert.equal(told.length, 1);
      assert.deepEqual(told[0], { key: `grant-lapsed:${g.id}`, grantId: g.id, projectId: a, text: "\"ann\" no longer holds approve.class.push in \"Garden\": unused for 30 days (last used 2026-11-10). Grant it again if the work needs it." });
      now += 700_000;
      await loop!.run(by);
      assert.equal(told.length, 1, "told once");
    } finally { await world.close(); }
  });
}
