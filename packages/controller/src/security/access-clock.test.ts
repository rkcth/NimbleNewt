import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { expiryTime, judgedBy } from "./access.js";
import { allows, allowsExactly, GrantService, PrincipalService, requireAction, type Principal } from "./index.js";

after(stopServer);

// An access check given no time judges a grant's expiry at the controller's clock at the moment of the check (the clock of the loader that took the principal's snapshot, so a rig's fake
// clock is respected), never earlier than the snapshot's `asOf`. A principal kept for long (the dispatcher's own, taken at start) must lose a grant when it ends, not keep it until a restart.
// Every date below lies long before any real run of this test, so the machine's clock is always after the expiry: only the registered clock can make the grant hold.
const AS_OF = "2026-01-10T12:00:00.000Z";
const EXPIRES = "2026-02-01T00:00:00.000Z";
const AFTER_EXPIRY = "2026-02-02T00:00:00.000Z";
const agent = (asOf: string | undefined): Principal => ({
  id: "agent:a", kind: "agent", name: "a", asOf, restrictions: [],
  grants: [{ action: "task.read", project: "p1", source: "direct", expiresAt: EXPIRES }],
} as unknown as Principal);

test("a grant holds while the loader's clock is before its end, whatever the machine's clock says", () => {
  const p = judgedBy(agent(AS_OF), () => AS_OF);
  assert.equal(allows(p, "task.read", "p1"), true);
  assert.equal(allowsExactly(p, "task.read", "p1"), true);
  assert.doesNotThrow(() => requireAction(p, "task.read", "p1"));
});

test("a principal kept after its grant ended loses it at the next check: the clock is read at the check, not at load", () => {
  let clock = AS_OF;
  const p = judgedBy(agent(AS_OF), () => clock);
  assert.equal(allows(p, "task.read", "p1"), true, "holds when loaded");
  clock = AFTER_EXPIRY;
  assert.equal(allows(p, "task.read", "p1"), false, "the same object, judged after the end");
  assert.equal(allowsExactly(p, "task.read", "p1"), false);
  assert.throws(() => requireAction(p, "task.read", "p1"), /may not task\.read/);
});

test("the check is never judged earlier than the snapshot's own as-of time, and an explicit time still wins", () => {
  // A clock that reads behind the snapshot (set back in a rig) does not bring back a grant that had ended when the snapshot was taken.
  assert.equal(allows(judgedBy(agent(AFTER_EXPIRY), () => AS_OF), "task.read", "p1"), false);
  assert.equal(expiryTime(judgedBy(agent(AFTER_EXPIRY), () => AS_OF)), AFTER_EXPIRY);
  assert.equal(allows(judgedBy(agent(AS_OF), () => AS_OF), "task.read", "p1", { now: AFTER_EXPIRY }), false);
  assert.equal(allows(judgedBy(agent(AFTER_EXPIRY), () => AFTER_EXPIRY), "task.read", "p1", { now: AS_OF }), true);
});

test("a principal with no loader clock (built by hand, or a spread copy) is judged at the later of its as-of time and the machine's clock", () => {
  assert.equal(allows(agent(AS_OF), "task.read", "p1"), false, "the machine's clock is past the end");
  const copy = { ...judgedBy(agent(AS_OF), () => AS_OF) };
  assert.equal(allows(copy, "task.read", "p1"), false, "a copy does not carry the clock");
  const future = "2999-01-01T00:00:00.000Z";
  assert.equal(expiryTime(agent(future)), future, "an as-of time after the machine's clock wins");
});

test("a principal whose rights were never loaded is refused rather than trusted", () => {
  assert.equal(allows(judgedBy(agent(undefined), () => AS_OF), "task.read", "p1"), false);
  assert.equal(allows(agent(undefined), "task.read", "p1"), false);
});

let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
for (const backend of backends) {
  test(`${backend.name}: an authenticated principal kept past its grant record's end is refused, and the rig's fake clock (not the machine's) decides`, async () => {
    const world = await backend.open();
    try {
      let clock = AS_OF;
      const options = { clock: () => clock, pause: async () => undefined };
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const grants = GrantService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      await principals.enroll(owner, { commandId: cid("enroll"), kind: "agent", name: "ann", grants: [] });
      const token = (await principals.issueCredential(owner, "agent:ann")).token;
      const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "Garden" })).id;
      await grants.grant(owner, { commandId: cid("g"), grantee: "agent:ann", action: "task.read", project: a, source: "direct", basis: "until February", expiresAt: EXPIRES });
      // Loaded once and kept, as the dispatcher keeps its own principal for the life of the controller.
      const kept = await principals.authenticate(token);
      assert.equal(kept.asOf, AS_OF);
      assert.equal(allows(kept, "task.read", a), true, "the rig's clock is before the end (the machine's is long after it)");
      clock = AFTER_EXPIRY;
      assert.equal(allows(kept, "task.read", a), false, "the kept object no longer holds the ended grant");
      assert.equal(allows(await principals.authenticate(token), "task.read", a), false, "nor does a new one");
      assert.equal(allows((await principals.current("agent:ann"))!, "task.read", a), false);
    } finally { await world.close(); }
  });
}
