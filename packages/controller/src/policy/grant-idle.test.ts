import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { GrantService, PrincipalService } from "../security/index.js";
import { PolicyService } from "./index.js";

after(stopServer);

// Card A07h in the approval policy: an approval grant with an idle window is renewed when it decides an action, and an action that asks again because the grant lapsed says which grant lapsed.
const T0 = Date.parse("2026-11-10T12:00:00.000Z");
const DAY = 86_400_000;
let now = T0;
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

for (const backend of backends) {
  test(`${backend.name}: an approval grant with an idle window renews when used and, once it lapses, the decision names it`, async () => {
    now = T0;
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const grants = GrantService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [] });
      const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
      const policy = PolicyService.withEpoch(world.storage, projects.epoch, grants, options);
      const ask = () => policy.evaluate({ principalId: "agent:ann", projectId: a, tool: "publish-post", audience: "blog" });
      const g = await grants.grant(owner, { commandId: cid("g"), grantee: "agent:ann", action: "approve.tool.publish-post", project: a, source: "standing", basis: "the blog is ann's", idleDays: 7, terms: { audiences: ["blog"], environments: ["development", "testing"] } });
      // Used every five days for two months: still allowed, and written once per day of use.
      for (let d = 5; d <= 60; d += 5) {
        now = T0 + d * DAY;
        assert.equal((await ask()).via, "grant", `day ${d}`);
        assert.equal((await ask()).grantId, g.id);
      }
      const used = (await grants.getGrant(g.id))!;
      assert.equal(used.lastUsedAt, new Date(T0 + 60 * DAY).toISOString());
      assert.equal(used.revision, 1 + 12, "one write per day of use");
      // Left unused for more than seven days: the action asks again and says why.
      now = T0 + 68 * DAY;
      const d = await ask();
      assert.equal(d.mode, "owner");
      assert.equal(d.reasons.at(-1), `approval grant ${g.id} (approve.tool.publish-post) would have covered it, but it lapsed after 7 days unused, last used 2027-01-09`);
    } finally { await world.close(); }
  });
}
