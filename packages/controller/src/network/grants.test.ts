import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import { NETWORK_LIMITS, NetworkGrantService, type GrantView, type NetworkJudge } from "./index.js";

after(stopServer);

// Built at run time so that no key-shaped literal sits in the source.
const keyShaped = ["s", "k", "-"].join("") + "abcd1234".repeat(5);
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, (error as Error).message); check?.(error); return true; });
};

for (const backend of backends) {
  interface Ctx { grants: NetworkGrantService; owner: Principal; ann: Principal; ben: Principal; cat: Principal; a: string; b: string; ta: string; tb: string; end: (taskId: string) => Promise<void>; judged: { mode: string; via: string; grantId?: string; reasons: string[] }; seen: unknown[]; make: (judge?: NetworkJudge) => NetworkGrantService }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1" });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, {});
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const b = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
        const ta = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: a, title: "T" })).id;
        const tb = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: b, title: "T" })).id;
        const agent = async (nm: string, g: Grant[]) => { await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: g }); return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token); };
        const work = (p: string): Grant[] => [{ action: "attempt.work", project: p }];
        const ann = await agent("ann", work(a));
        const ben = await agent("ben", work(b));
        const cat = await agent("cat", []);
        const judged = { mode: "owner", via: "must-decide", reasons: ["access changes stay the owner's decision"] } as Ctx["judged"];
        const seen: unknown[] = [];
        const judge: NetworkJudge = { evaluate: async (input) => { seen.push(input); return judged; } };
        const make = (j?: NetworkJudge): NetworkGrantService => NetworkGrantService.withEpoch(world.storage, projects.epoch, j === undefined ? {} : { judge: j });
        const end = async (taskId: string): Promise<void> => {
          const t = await projects.getTask(taskId);
          await projects.transitionTask({ commandId: cid("end"), actor: "owner:rob", taskId, expectedRevision: t!.revision, to: "cancelled" });
        };
        await body({ grants: make(judge), owner, ann, ben, cat, a, b, ta, tb, end, judged, seen, make });
      } finally { await world.close(); }
    });
  const grant = (c: Ctx, by: Principal, extra: Record<string, unknown> = {}) => c.grants.grant(by, { commandId: cid("g"), taskId: c.ta, host: "research.example.com", port: 443, ...extra } as never);

  suite("the default is none: a task with no grant is refused, and the owner's grant names the task, the destination and the approver", async (c) => {
    const none = await c.grants.check(c.ta, "research.example.com", 443);
    assert.equal(none.live, false);
    assert.deepEqual(await c.grants.forTask(c.owner, c.ta), []);
    const made = await grant(c, c.owner, { reason: "read the vendor's documentation" });
    assert.equal(made.state, "granted");
    const [g] = await c.grants.forTask(c.owner, c.ta);
    assert.ok(g !== undefined);
    assert.equal(g.taskId, c.ta); assert.equal(g.host, "research.example.com"); assert.equal(g.port, 443);
    assert.equal(g.approvedBy, c.owner.id); assert.equal(g.via, "owner"); assert.equal(g.allowPrivate, false);
    const live = await c.grants.check(c.ta, "research.example.com", 443);
    assert.equal(live.live, true);
    // Exactly that destination: another port, another host, another task.
    assert.equal((await c.grants.check(c.ta, "research.example.com", 80)).live, false);
    assert.equal((await c.grants.check(c.ta, "other.example.com", 443)).live, false);
    assert.equal((await c.grants.check(c.tb, "research.example.com", 443)).live, false);
  });

  suite("a worker's request waits for the owner; the owner approves or refuses it; another task's worker and a stranger may not ask", async (c) => {
    const asked = await grant(c, c.ann);
    assert.equal(asked.state, "requested");
    assert.equal((await c.grants.check(c.ta, "research.example.com", 443)).live, false, "a request grants nothing");
    // The policy was asked, as a request to open new outside access.
    assert.deepEqual(c.seen[0], { principalId: c.ann.id, projectId: c.a, tool: "open-network", taskId: c.ta });
    // Asking again is the same request.
    assert.equal((await grant(c, c.ann)).id, asked.id);
    await refuses("forbidden", () => c.grants.decide(c.ann, { commandId: cid("d"), grantId: asked.id, verdict: "approve" }));
    await refuses("forbidden", () => grant(c, c.ben));
    await refuses("forbidden", () => grant(c, c.cat));
    const decided = await c.grants.decide(c.owner, { commandId: cid("d"), grantId: asked.id, verdict: "approve" });
    assert.equal(decided.state, "granted");
    assert.equal((await c.grants.check(c.ta, "research.example.com", 443)).live, true);
    const [g] = await c.grants.forTask(c.owner, c.ta);
    assert.equal(g!.requestedBy, c.ann.id); assert.equal(g!.approvedBy, c.owner.id); assert.equal(g!.via, "owner");
    await refuses("invalid_transition", () => c.grants.decide(c.owner, { commandId: cid("d"), grantId: asked.id, verdict: "deny" }));
    // A refused request is refused; asking again opens a new one.
    const other = await grant(c, c.ann, { port: 8080 });
    assert.equal((await c.grants.decide(c.owner, { commandId: cid("d"), taskId: c.ta, host: "research.example.com", port: 8080, verdict: "deny" })).state, "denied");
    assert.equal((await c.grants.check(c.ta, "research.example.com", 8080)).live, false);
    assert.equal((await grant(c, c.ann, { port: 8080 })).state, "requested");
    void other;
  });

  suite("the approval policy allows a worker's request only through a standing approval grant; a denial refuses; a private destination is never allowed by the policy", async (c) => {
    c.judged.mode = "allow"; c.judged.via = "profile";
    assert.equal((await grant(c, c.ann)).state, "requested", "allowed by the profile alone is not a standing approval grant");
    c.judged.via = "grant"; c.judged.grantId = "grt-standing";
    const allowed = await grant(c, c.ann, { host: "docs.example.org" });
    assert.equal(allowed.state, "granted");
    const g = (await c.grants.forTask(c.owner, c.ta)).find((x) => x.host === "docs.example.org")!;
    assert.equal(g.via, "policy"); assert.equal(g.approvedBy, "policy:grt-standing");
    const priv = await grant(c, c.ann, { host: "127.0.0.1", port: 3000, allowPrivate: true });
    assert.equal(priv.state, "requested", "a private destination waits for the owner whatever the policy says");
    c.judged.mode = "deny"; c.judged.reasons = ["a restriction forbids it"];
    await refuses("forbidden", () => grant(c, c.ann, { host: "denied.example.com" }), (e) => assert.match(e.message, /denied by policy/));
    // Without a policy every request waits for the owner.
    const bare = c.make();
    assert.equal((await bare.grant(c.ann, { commandId: cid("g"), taskId: c.ta, host: "bare.example.com", port: 443 })).state, "requested");
  });

  suite("hostile destinations are refused: forms that are not a plain host, odd spellings of an address, wildcards, and the addresses no grant can reach", async (c) => {
    const invalidHosts = ["", " ", "*.example.com", "*", "example.com/path", "https://example.com", "user@example.com", "example.com:443", "exa mple.com", "example.com\n", "exa\u0000mple.com", "ex‮ample.com", "-bad.example.com", "bad-.example.com", "a..b", ".example.com", "2130706433", "0x7f.0.0.1", "127.1", "017700000001", "1.2.3.4.5", "10.0.0.1.", "example.0x1", "x".repeat(254), "é.example.com", "localhost\\evil", "[::1", "::1]x", "1.2.3"];
    for (const host of invalidHosts) await refuses("invalid_command", () => grant(c, c.owner, { host }), (e) => assert.equal(e.field, "host", `host ${JSON.stringify(host)}`));
    for (const port of [0, 65536, -1, 1.5, "443", null, NaN, Infinity]) await refuses("invalid_command", () => grant(c, c.owner, { port }), (e) => assert.equal(e.field, "port"));
    const never = ["0.0.0.0", "0.1.2.3", "169.254.169.254", "169.254.0.1", "224.0.0.1", "239.255.255.255", "255.255.255.255", "240.0.0.1", "100.100.100.200", "::", "fe80::1", "fe80::abcd", "ff02::1", "fd00:ec2::254", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "::FFFF:0.0.0.0", "[fe80::1]"];
    for (const host of never) await refuses("forbidden", () => grant(c, c.owner, { host, allowPrivate: true }), (e) => assert.match(e.message, /no grant can reach/));
    // Private and loopback destinations are allowed only when the grant says so, and only the owner says so for them (the policy never does): they are not refused here as a form.
    assert.equal((await grant(c, c.owner, { host: "127.0.0.1", port: 3000, allowPrivate: true })).state, "granted");
    assert.equal((await grant(c, c.owner, { host: "LocalHost", port: 3001, allowPrivate: true })).state, "granted");
    assert.equal((await c.grants.check(c.ta, "localhost", 3001)).live, true, "the host is kept in its canonical form");
    assert.equal((await grant(c, c.owner, { host: "[::1]", port: 3002, allowPrivate: true })).state, "granted");
    assert.equal((await c.grants.check(c.ta, "::1", 3002)).live, true);
    assert.equal((await grant(c, c.owner, { host: "Example.COM.", port: 443 })).state, "granted");
    assert.equal((await c.grants.check(c.ta, "example.com", 443)).live, true);
    await refuses("invalid_command", () => grant(c, c.owner, { allowPrivate: "yes" }));
    await refuses("invalid_command", () => grant(c, c.owner, { reason: "x".repeat(NETWORK_LIMITS.reason + 1) }));
    await refuses("invalid_command", () => c.grants.grant(c.owner, { commandId: cid("g"), taskId: c.ta, host: "x.example.com", port: 443, extra: 1 } as never));
  });

  suite("a credential is stated by the owner only, names a header that does not route or frame, and is the NAME of a secret", async (c) => {
    await refuses("forbidden", () => grant(c, c.ann, { credential: { header: "authorization", ref: "docs-token" } }));
    for (const header of ["host", "Content-Length", "transfer-encoding", "connection", "upgrade", "proxy-authorization", "bad header", "", "x".repeat(70)]) await refuses("invalid_command", () => grant(c, c.owner, { host: "api.example.com", credential: { header, ref: "docs-token" } }), (e) => assert.equal(e.field, "credential.header"));
    for (const ref of ["", "has space", "a__b", "x".repeat(70), keyShaped]) await refuses("invalid_command", () => grant(c, c.owner, { host: "api.example.com", credential: { header: "authorization", ref } }), (e) => assert.equal(e.field, "credential.ref"));
    assert.equal((await grant(c, c.owner, { host: "api.example.com", credential: { header: "Authorization", ref: "docs-token" } })).state, "granted");
    const g = (await c.grants.forTask(c.owner, c.ta))[0]!;
    assert.deepEqual(g.credential, { header: "authorization", ref: "docs-token" });
  });

  suite("a grant ends with its task, and none is made for a task that has ended", async (c) => {
    await grant(c, c.owner);
    assert.equal((await c.grants.check(c.ta, "research.example.com", 443)).live, true);
    await c.end(c.ta);
    const after = await c.grants.check(c.ta, "research.example.com", 443);
    assert.equal(after.live, false);
    assert.match(after.why ?? "", /task has ended/);
    await refuses("invalid_transition", () => grant(c, c.owner, { host: "later.example.com" }));
    const asked = await c.grants.grant(c.ben, { commandId: cid("g"), taskId: c.tb, host: "pending.example.com", port: 443 });
    await c.end(c.tb);
    await refuses("invalid_transition", () => c.grants.decide(c.owner, { commandId: cid("d"), grantId: asked.id, verdict: "approve" }));
  });

  suite("a revoked grant stops at the next check; only the owner revokes; by ID, by destination or every grant of a task; the listener is told; revoking twice changes nothing", async (c) => {
    const one = await grant(c, c.owner);
    await grant(c, c.owner, { host: "two.example.com" });
    await grant(c, c.owner, { host: "three.example.com" });
    const told: GrantView[] = [];
    c.grants.onRevoked((g) => { told.push(g); });
    await refuses("forbidden", () => c.grants.revoke(c.ann, { commandId: cid("r"), taskId: c.ta }));
    await refuses("invalid_command", () => c.grants.revoke(c.owner, { commandId: cid("r") }));
    await refuses("invalid_command", () => c.grants.revoke(c.owner, { commandId: cid("r"), grantId: one.id, taskId: c.ta, host: "x.example.com", port: 1 }));
    await refuses("stale_revision", () => c.grants.revoke(c.owner, { commandId: cid("r"), grantId: one.id, expectedRevision: 99 }));
    assert.deepEqual(await c.grants.revoke(c.owner, { commandId: cid("r"), grantId: one.id }), { revoked: 1 });
    assert.equal(told.length, 1); assert.equal(told[0]!.id, one.id); assert.equal(told[0]!.state, "revoked");
    const gone = await c.grants.check(c.ta, "research.example.com", 443);
    assert.equal(gone.live, false); assert.match(gone.why ?? "", /revoked/);
    assert.deepEqual(await c.grants.revoke(c.owner, { commandId: cid("r"), grantId: one.id }), { revoked: 0 }, "already over");
    assert.deepEqual(await c.grants.revoke(c.owner, { commandId: cid("r"), taskId: c.ta, host: "two.example.com", port: 443 }), { revoked: 1 });
    assert.equal((await c.grants.check(c.ta, "three.example.com", 443)).live, true, "only the named destination ended");
    assert.deepEqual(await c.grants.revoke(c.owner, { commandId: cid("r"), taskId: c.ta }), { revoked: 1 });
    assert.equal((await c.grants.check(c.ta, "three.example.com", 443)).live, false);
    // A revoked destination can be granted again (a new decision of the owner).
    assert.equal((await grant(c, c.owner)).state, "granted");
    assert.equal((await c.grants.check(c.ta, "research.example.com", 443)).live, true);
  });

  suite("the same command ID answers the same, and a different command with it is refused", async (c) => {
    const first = await c.grants.grant(c.owner, { commandId: "same-1", taskId: c.ta, host: "x.example.com", port: 443 });
    const again = await c.grants.grant(c.owner, { commandId: "same-1", taskId: c.ta, host: "x.example.com", port: 443 });
    assert.deepEqual(again, first);
    await refuses("command_conflict", () => c.grants.grant(c.owner, { commandId: "same-1", taskId: c.ta, host: "y.example.com", port: 443 }));
  });

  suite("the connection log keeps task, attempt, destination, outcome and bytes, and is read only by the owner (not the task's worker, nor anyone else)", async (c) => {
    const id = await c.grants.logOpen({ taskId: c.ta, projectId: c.a, attemptId: "att-1", host: "research.example.com", port: 443, address: "93.184.216.34", grantId: "ngr-x", via: "relay", outcome: "open" });
    await c.grants.logOpen({ taskId: c.ta, projectId: c.a, attemptId: "att-1", host: "evil.example.net", port: 25, via: "relay", outcome: "refused", reason: "the task holds no grant for that destination" });
    await c.grants.logOpen({ taskId: c.ta, projectId: c.a, attemptId: "att-2", host: "x.example.com", port: 80, via: "web-tool", outcome: "refused", reason: `key ${keyShaped} leaked` });
    assert.equal(await c.grants.loggedFor(c.ta, "att-1"), 2);
    assert.equal(await c.grants.loggedFor(c.ta, "att-2"), 1);
    assert.equal(await c.grants.loggedFor(c.tb, "att-1"), 0);
    await c.grants.logClose(c.ta, id, { outcome: "closed", endedBy: "target", bytesToTarget: 120, bytesFromTarget: 4096 });
    // A second close changes nothing.
    await c.grants.logClose(c.ta, id, { outcome: "failed", endedBy: "error", bytesToTarget: 0, bytesFromTarget: 0 });
    const list = await c.grants.connections(c.owner, c.ta);
    assert.equal(list.length, 3);
    const done = list.find((x) => x.id === id)!;
    assert.equal(done.outcome, "closed"); assert.equal(done.bytesToTarget, 120); assert.equal(done.bytesFromTarget, 4096); assert.equal(done.endedBy, "target"); assert.equal(done.attemptId, "att-1"); assert.equal(done.address, "93.184.216.34");
    const refused = list.filter((x) => x.outcome === "refused");
    assert.equal(refused.length, 2);
    assert.ok(refused.every((x) => x.endedAt !== undefined));
    assert.equal(JSON.stringify(list).includes(keyShaped), false, "a key-shaped text is redacted before it is kept");
    for (const who of [c.ann, c.ben, c.cat]) {
      await assert.rejects(() => c.grants.connections(who, c.ta), (e: unknown) => e instanceof DomainError && e.code === "forbidden", `${who.id} does not read the log`);
      await assert.rejects(() => c.grants.forTask(who, c.ta), (e: unknown) => e instanceof DomainError && e.code === "forbidden", `${who.id} does not list the grants`);
    }
    assert.equal((await c.grants.connections(c.owner, c.ta, { limit: 2 })).length, 2);
  });
}

test("a task may hold only a bounded number of grants", async () => {
  const backend = backends[0]!;
  const world = await backend.open();
  try {
    const projects = await ProjectService.open(world.storage, { holder: "c1" });
    const principals = PrincipalService.withEpoch(world.storage, projects.epoch, {});
    const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
    const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
    const t = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: a, title: "T" })).id;
    const grants = NetworkGrantService.withEpoch(world.storage, projects.epoch);
    for (let i = 0; i < NETWORK_LIMITS.grantsPerTask; i++) await grants.grant(owner, { commandId: cid("g"), taskId: t, host: `h${i}.example.com`, port: 443 });
    await refuses("invalid_command", () => grants.grant(owner, { commandId: cid("g"), taskId: t, host: "one-too-many.example.com", port: 443 }));
  } finally { await world.close(); }
});
