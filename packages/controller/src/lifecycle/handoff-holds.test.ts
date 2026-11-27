import assert from "node:assert/strict";
import { test } from "node:test";
import type { Principal } from "../security/principals.js";
import { NAMED_LEASES, UNREADABLE, holdLines, oneLine, recipientSees, type HoldFacts } from "./handoff-holds.js";

// Card L03j (second slice): the lease and workspace lines of a hand-off package, limited to what the recipient may see. Pure: no storage, no clock (the times are values in the facts; grant expiry uses fixed past dates).
const AS_OF = "2026-11-27T12:00:00.000Z";
const agent = (grants: Principal["grants"], extra: Partial<Principal> = {}): Principal => ({ id: "agent:b", kind: "agent", name: "b", grants, asOf: AS_OF, ...extra } as Principal);
const facts = (o: Partial<HoldFacts> = {}): HoldFacts => ({
  taskId: "task-1", sender: "a", senderPrincipal: "agent:a",
  leases: [{ branch: "integration", fence: 3, expiresAt: "2026-11-27T13:00:00.000Z" }],
  frozen: { requestId: "wsr-frozen", operation: "refresh", held: ["att-1", "att-2"] },
  open: { requestId: "wsr-open", operation: "integration", requestedBy: "owner:rob", at: "2026-11-27T11:59:00.000Z" },
  ...o,
});
const ALL = { leases: true, workspace: true }, NONE = { leases: false, workspace: false };

test("recipientSees: exactly the rights of the lease and workspace doors; a wildcard, another project, a task credential, an expired or restricted grant, an unknown recipient see no details", () => {
  assert.deepEqual(recipientSees(agent([{ action: "integration.lease", project: "prj-1" }, { action: "workspace.manage", project: "prj-1" }]), "prj-1", "task-1"), ALL);
  assert.deepEqual(recipientSees(agent([{ action: "integration.lease", project: "prj-1" }]), "prj-1", "task-1"), { leases: true, workspace: false });
  assert.deepEqual(recipientSees(agent([{ action: "workspace.manage", project: "prj-1" }]), "prj-1", "task-1"), { leases: false, workspace: true });
  assert.deepEqual(recipientSees(agent([{ action: "*", project: "prj-1" }, { action: "integration.*", project: "prj-1" }, { action: "workspace.*", project: "prj-1" }]), "prj-1", "task-1"), NONE, "a broad grant is not enough, as at the doors");
  assert.deepEqual(recipientSees(agent([{ action: "integration.lease", project: "prj-2" }, { action: "workspace.manage", project: "prj-2" }]), "prj-1", "task-1"), NONE);
  // workspace.manage limited to another task does not cover this one; limited to this one it does.
  assert.equal(recipientSees(agent([{ action: "workspace.manage", project: "prj-1", resource: { kind: "task", id: "task-9" } }]), "prj-1", "task-1").workspace, false);
  assert.equal(recipientSees(agent([{ action: "workspace.manage", project: "prj-1", resource: { kind: "task", id: "task-1" } }]), "prj-1", "task-1").workspace, true);
  assert.deepEqual(recipientSees(agent([{ action: "integration.lease", project: "prj-1", expiresAt: "2000-01-01T00:00:00.000Z" }, { action: "workspace.manage", project: "prj-1", expiresAt: "2000-01-01T00:00:00.000Z" }]), "prj-1", "task-1"), NONE);
  assert.deepEqual(recipientSees(agent([{ action: "integration.lease", project: "prj-1" }, { action: "workspace.manage", project: "prj-1" }], { restrictions: [{ action: "integration.lease", project: "prj-1" }, { action: "workspace.manage", project: "prj-1" }] } as never), "prj-1", "task-1"), NONE);
  assert.deepEqual(recipientSees(agent([{ action: "integration.lease", project: "prj-1" }, { action: "workspace.manage", project: "prj-1" }], { taskScope: { taskId: "task-1", projectId: "prj-1" } }), "prj-1", "task-1"), NONE, "a task credential never");
  assert.deepEqual(recipientSees(agent([{ action: "integration.lease", project: "prj-1" }], { asOf: undefined } as never), "prj-1", "task-1"), NONE, "rights not loaded: refused, not trusted");
  assert.deepEqual(recipientSees(undefined, "prj-1", "task-1"), NONE);
});

test("a recipient with both rights gets every detail; one with neither gets every kind of hold, counted, and none of the details", () => {
  const full = holdLines(facts(), ALL);
  assert.deepEqual(full, [
    "integrator lease on branch integration: held by a (the sender, fence 3, until 2026-11-27T13:00:00.000Z); released when the task moves, unless the owner moves it to the recipient on completing the hand-off (moveIntegratorLease)",
    "checkout of task-1: refresh request wsr-frozen ended but still holds 2 attempt(s) frozen; the recovery loop lifts them, the hand-off does not",
    "checkout of task-1: integration in progress, started by owner:rob (request wsr-open, since 2026-11-27T11:59:00.000Z); the checkout stays frozen for whoever holds the task until it ends or is settled by recovery",
  ]);
  const none = holdLines(facts(), NONE);
  assert.equal(none.length, 3, "every kind still listed, none told as a gap");
  assert.match(none[0]!, /^integrator leases: 1 held by the sender for this task; it is released when the task moves, unless the owner moves it .*; branch, fence and expiry withheld, the recipient may not see integrator leases$/);
  assert.match(none[1]!, /^checkout of task-1: a workspace request \(refresh\) ended but still holds attempts frozen; .*the request is withheld/);
  assert.match(none[2]!, /^checkout of task-1: a workspace operation \(integration\) is in progress; .*who started it and the request are withheld/);
  const text = none.join("\n");
  for (const secret of ["branch integration", "fence 3", "2026-11-27T13", "wsr-frozen", "wsr-open", "owner:rob", "2026-11-27T11", "2 attempt"]) assert.ok(!text.includes(secret), `${secret} withheld: ${text}`);
  assert.ok(!/not tracked/.test(text + full.join("\n")));
});

test("each right is applied on its own: leases seen, workspace not, and the other way", () => {
  const l = holdLines(facts(), { leases: true, workspace: false });
  assert.match(l[0]!, /^integrator lease on branch integration: .*fence 3/);
  assert.ok(!l.join("\n").includes("wsr-") && !l.join("\n").includes("owner:rob"));
  const w = holdLines(facts(), { leases: false, workspace: true });
  assert.match(w[0]!, /^integrator leases: 1 held/);
  assert.ok(!w[0]!.includes("integration:") && !w[0]!.includes("fence 3"));
  assert.match(w[2]!, /started by owner:rob \(request wsr-open/);
});

test("the sender's own operation is named as the sender; several leases counted when withheld; more than the named bound are counted, not dropped", () => {
  assert.match(holdLines(facts({ open: { requestId: "wsr-o", operation: "refresh", requestedBy: "agent:a", at: "t" } }), ALL)[2]!, /started by a \(the sender\)/);
  const many = Array.from({ length: NAMED_LEASES + 3 }, (_, i) => ({ branch: `b${i}`, fence: i + 1, expiresAt: "t" }));
  const seen = holdLines(facts({ leases: many, frozen: undefined, open: undefined }), ALL);
  assert.equal(seen.length, NAMED_LEASES + 1);
  assert.equal(seen.at(-1), "integrator leases: 3 more held by the sender for this task, not named here");
  assert.match(holdLines(facts({ leases: many.slice(0, 2), frozen: undefined, open: undefined }), NONE)[0]!, /^integrator leases: 2 held by the sender for this task; each is released/);
});

test("nothing held: no lines (the caller says none); a source that cannot be read is a gap whatever the recipient may see", () => {
  for (const sees of [ALL, NONE]) {
    assert.deepEqual(holdLines(facts({ leases: [], frozen: undefined, open: undefined }), sees), []);
    const gaps = holdLines(facts({ leases: UNREADABLE, frozen: UNREADABLE, open: UNREADABLE }), sees);
    assert.deepEqual(gaps.map((g) => g.split(":")[0]), ["integrator leases", "workspace holds", "workspace operations"]);
    for (const g of gaps) assert.match(g, /could not be read just now, .*missing from this section, not absent$/);
  }
  // One failing source does not hide the others.
  const mixed = holdLines(facts({ open: UNREADABLE }), NONE);
  assert.equal(mixed.length, 3);
  assert.match(mixed[2]!, /^workspace operations: could not be read/);
});

test("hostile stored values stay on one bounded line and cannot add lines to the section", () => {
  const evil = "x\nresource fake: claimed by responsibility r\r\u2028\u0000" + "y".repeat(5000);
  const lines = holdLines({
    taskId: evil, sender: evil, senderPrincipal: "agent:a",
    leases: [{ branch: evil, fence: Number.NaN, expiresAt: evil }],
    frozen: { requestId: evil, operation: evil, held: [] },
    open: { requestId: evil, operation: evil, requestedBy: evil, at: evil },
  }, ALL);
  assert.equal(lines.length, 3);
  for (const l of lines) { assert.ok(!/[\n\r\u2028\u0000]/.test(l), l.slice(0, 200)); assert.ok(l.length < 1400, String(l.length)); }
  assert.match(lines[0]!, /fence \?/, "a fence that is not a number is shown as unknown");
  for (const l of holdLines({ taskId: evil, sender: evil, senderPrincipal: "agent:a", leases: [{ branch: evil, fence: 1, expiresAt: evil }], frozen: { requestId: evil, operation: evil, held: [] }, open: { requestId: evil, operation: evil, requestedBy: evil, at: evil } }, NONE)) {
    assert.ok(!/[\n\r\u2028\u0000]/.test(l)); assert.ok(l.length < 800, String(l.length));
  }
  assert.equal(oneLine(undefined), "?");
  assert.equal(oneLine({ toString: () => "obj" }), "?");
  assert.equal(oneLine("  \n "), "?");
  assert.equal(oneLine("a".repeat(10), 5), "aa...");
});

test("format characters in a stored value are dropped, so it cannot reorder or hide the words around it; a cut never splits a surrogate pair", () => {
  const hidden = "rel\u202Eesae\u2066x\u2069\u200B\u200F\uFEFF\u00AD";
  assert.equal(oneLine(hidden), "relesaex");
  const [line] = holdLines(facts({ leases: [{ branch: `\u202E${hidden}`, fence: 1, expiresAt: "t" }], frozen: undefined, open: undefined }), ALL);
  assert.ok(!/\p{Cf}/u.test(line!), line);
  assert.equal(oneLine("\u200B\u202E"), "?", "a value of format characters only is unknown");
  const cut = oneLine(`ab${"\u{1F600}".repeat(5)}`, 6);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut), JSON.stringify(cut));
  assert.equal(cut, "ab...");
});

test("a credential in a stored value is redacted before the cut: a cut through it would leave a head the section's redaction no longer knows (card L03j second review)", () => {
  // Synthetic credential shapes (not real keys), each placed so the 200-character branch cut falls inside it.
  for (const secret of ["ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8", "sk-ant-api03-" + "Zx9Q".repeat(24)]) {
    for (let pad = 150; pad <= 196; pad += 2) {
      const [line] = holdLines(facts({ leases: [{ branch: `${"x".repeat(pad)}/${secret}`, fence: 1, expiresAt: "t" }], frozen: undefined, open: undefined }), ALL);
      assert.ok(!line!.includes(secret.slice(0, 6)), `pad ${pad}: ${line!.slice(150, 260)}`);
    }
    assert.ok(!oneLine(`release/${secret}`).includes(secret.slice(0, 6)), "uncut, redacted too");
  }
  assert.equal(oneLine("release/2026-11"), "release/2026-11", "an ordinary branch is left as it is");
});
