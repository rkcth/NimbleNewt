import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { Migration } from "../storage/migrations.js";
import type { ControllerStorage } from "../storage/types.js";
import { GATE_FILE, MigrationGuardService, POLICY_DEFAULTS, confirmedContract, readContractGate, type EffectivePolicy, type GuardOptions } from "./guard.js";
import { additiveBetween, contractRefusals, journalView, judgeRollback, type TestedPair, type UpgradeRecord } from "./rules.js";

after(stopServer);
const mig = (version: number, name: string, kind?: "additive" | "destructive"): Migration => ({ version, name, statements: ["x"], ...(kind === undefined ? {} : { kind }) });
const LIST = [mig(1, "initial"), mig(2, "add_a"), mig(3, "drop_b", "destructive"), mig(4, "add_c"), mig(5, "add_d")];
const day = (n: number): string => new Date(Date.UTC(2026, 10, 1 + n)).toISOString();
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};

test("the rollback rule: a tested pair, additive migrations since, and an open period (pure)", () => {
  const pair = (release: string, schema: number, at = day(0)): TestedPair => ({ release, schema, at });
  const up = (from: number, to: number, at: string): UpgradeRecord => ({ from, to, at, additiveOnly: additiveBetween(LIST, from, to) });
  const base = { migrations: LIST, periodDays: 14, now: day(5) };
  // the very data it was tested on
  assert.equal(judgeRollback({ ...base, release: "rcn-a", dbSchema: 2, pairs: [pair("rcn-a", 2)], upgrades: [] }).ok, true);
  // never started here: no pair
  const never = judgeRollback({ ...base, release: "rcn-z", dbSchema: 2, pairs: [pair("rcn-a", 2)], upgrades: [up(1, 2, day(1))] });
  assert.equal(never.ok, false); assert.match(never.reasons[0]!, /never started healthy/);
  // additive since, period open
  const ok = judgeRollback({ ...base, release: "rcn-a", dbSchema: 2, pairs: [pair("rcn-a", 1)], upgrades: [up(1, 2, day(1))] });
  assert.equal(ok.ok, true, ok.reasons.join("; ")); assert.equal(ok.until, day(15));
  // period over
  const late = judgeRollback({ ...base, now: day(16), release: "rcn-a", dbSchema: 2, pairs: [pair("rcn-a", 1)], upgrades: [up(1, 2, day(1))] });
  assert.equal(late.ok, false); assert.match(late.reasons.join(), /rollback period.*ended/);
  // a destructive migration since: refused even inside the period, and the reason names it
  const destructive = judgeRollback({ ...base, release: "rcn-a", dbSchema: 4, pairs: [pair("rcn-a", 2)], upgrades: [up(2, 4, day(1))] });
  assert.equal(destructive.ok, false); assert.match(destructive.reasons.join(), /migration 3 reshaped the data destructively/);
  // a pair on newer data than the database holds is not a tested pair for it
  assert.match(judgeRollback({ ...base, release: "rcn-a", dbSchema: 1, pairs: [pair("rcn-a", 2)], upgrades: [] }).reasons[0]!, /newer data/);
  // no upgrade on record: the period cannot be shown open
  assert.match(judgeRollback({ ...base, release: "rcn-a", dbSchema: 2, pairs: [pair("rcn-a", 1)], upgrades: [] }).reasons.join(), /no upgrade past schema 1/);
  // the highest tested pair counts
  assert.equal(judgeRollback({ ...base, release: "rcn-a", dbSchema: 4, pairs: [pair("rcn-a", 1), pair("rcn-a", 3)], upgrades: [up(1, 3, day(1)), up(3, 4, day(2))] }).pair?.schema, 3);
});

test("destructive migrations may be allowed only for a destructive one that waits, once the rollback period is over (pure)", () => {
  const ups: UpgradeRecord[] = [{ from: 1, to: 2, at: day(0), additiveOnly: true }];
  const input = { through: 3, applied: 2, migrations: LIST, upgrades: ups, periodDays: 14 };
  assert.match(contractRefusals({ ...input, now: day(3) }).join(), /still open until/);
  assert.deepEqual(contractRefusals({ ...input, now: day(15) }), []);
  assert.match(contractRefusals({ ...input, through: 2, now: day(15) }).join(), /already applied/);
  assert.match(contractRefusals({ ...input, through: 9, now: day(15) }).join(), /no migration 9/);
  assert.match(contractRefusals({ ...input, applied: 3, through: 5, now: day(15) }).join(), /no destructive one waiting/);
  assert.deepEqual(journalView(LIST, 2, 0).map((m) => m.state), ["applied", "applied", "deferred", "deferred", "deferred"]);
  assert.deepEqual(journalView(LIST, 2, 3).map((m) => m.state), ["applied", "applied", "pending", "pending", "pending"]);
  assert.deepEqual(journalView(LIST, 1, 0).map((m) => m.state), ["applied", "pending", "deferred", "deferred", "deferred"]);
});

interface C { storage: ControllerStorage; make: (o?: Partial<GuardOptions>) => MigrationGuardService; owner: Principal; agent: Principal; dir: string; schema: { v: number }; clock: { t: string }; policies: EffectivePolicy[] }
for (const backend of backends) {
  const suite = (name: string, body: (c: C) => Promise<void>): void => {
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      const dir = mkdtempSync(join(tmpdir(), "nn-k03-"));
      try {
        const clock = { t: day(0) };
        const o = { clock: () => clock.t, pause: async () => undefined };
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...o });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, o);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        await principals.enroll(owner, { commandId: "e1", kind: "agent", name: "plain", grants: [{ action: "*", project: "*" }] });
        const agent = await principals.authenticate((await principals.issueCredential(owner, "agent:plain")).token);
        const schema = { v: 1 };
        const policies: EffectivePolicy[] = [];
        const make = (extra: Partial<GuardOptions> = {}): MigrationGuardService => MigrationGuardService.withEpoch(world.storage, projects.epoch, { migrations: LIST, schemaVersion: async () => schema.v, gateFile: join(dir, GATE_FILE), snapshots: true, now: () => clock.t, onPolicy: async (p) => { policies.push(p); }, runner: o, ...extra });
        await body({ storage: world.storage, make, owner, agent, dir, schema, clock, policies });
      } finally { await world.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
    });
  };

  suite("upgrades and tested pairs are recorded, and the rollback verdict follows the rule and the owner's period", async (c) => {
    const g = c.make();
    assert.equal((await g.noteStart()).upgrade, undefined, "the first start is only a baseline");
    await g.notePair("rcn-old");
    assert.equal((await g.rollbackVerdict("rcn-old")).ok, true, "its own data");
    c.clock.t = day(1); c.schema.v = 2;
    const n = await g.noteStart();
    assert.deepEqual([n.upgrade?.from, n.upgrade?.to, n.upgrade?.additiveOnly], [1, 2, true]);
    assert.equal((await g.noteStart()).upgrade, undefined, "a repeat records nothing");
    c.clock.t = day(5);
    const back = await g.rollbackVerdict("rcn-old");
    assert.equal(back.ok, true, back.reasons.join()); assert.equal(back.until, day(15));
    assert.equal((await g.rollbackVerdict("rcn-never")).ok, false);
    assert.deepEqual(await g.safeBack(), { backTo: 1, until: day(15) });
    // the owner shortens the period: it is over
    assert.equal((await g.setPolicy(c.owner, { commandId: "p1", rollbackPeriodDays: 2 })).values.rollbackPeriodDays, 2);
    const over = await g.rollbackVerdict("rcn-old");
    assert.equal(over.ok, false); assert.match(over.reasons.join(), /rollback period.*ended/);
    assert.equal(await g.safeBack(), undefined);
    await g.setPolicy(c.owner, { commandId: "p2", rollbackPeriodDays: null });
    assert.equal((await g.rollbackVerdict("rcn-old")).ok, true, "back to the default 14 days");
    // a destructive migration (3) ran: that release can no longer come back, the new release's own pair is fine
    c.schema.v = 3; c.clock.t = day(6);
    await g.noteStart();
    const gone = await g.rollbackVerdict("rcn-old");
    assert.equal(gone.ok, false); assert.match(gone.reasons.join(), /migration 3 reshaped the data destructively/);
    assert.equal(await g.safeBack(), undefined, "nothing is safe-back after a destructive upgrade");
    await g.notePair("rcn-new");
    assert.equal((await g.rollbackVerdict("rcn-new")).ok, true);
    assert.equal(await g.notePair("rcn-new"), false, "the same pair is recorded once");
    const status = await g.status(c.owner);
    assert.deepEqual([status.schemaVersion, status.latestKnown, status.testedPairs.length, status.upgrades.length], [3, 5, 2, 2]);
    assert.deepEqual(status.migrations.map((m) => m.state), ["applied", "applied", "applied", "pending", "pending"]);
  });

  suite("the policy is the owner's, bounded, replay-safe and handed to the launcher's copy", async (c) => {
    const g = c.make();
    assert.deepEqual((await g.policy(c.owner)).values, POLICY_DEFAULTS);
    await refuses("forbidden", () => g.setPolicy(c.agent, { commandId: "a1", probationMinutes: 5 }));
    await refuses("forbidden", () => g.policy(c.agent));
    for (const bad of [{ rollbackPeriodDays: 0 }, { rollbackPeriodDays: 366 }, { probationMinutes: 1.5 }, { probationMinutes: -1 }, { maxReleaseFailures: 0 }, { hostRetries: 51 }, { hostRetries: "many" }, {}]) await refuses("invalid_command", () => g.setPolicy(c.owner, { commandId: `b-${JSON.stringify(bad)}`, ...bad }));
    await refuses("invalid_command", () => g.setPolicy(c.owner, { commandId: "u", color: 1 } as never));
    const r = await g.setPolicy(c.owner, { commandId: "ok", probationMinutes: 0, maxReleaseFailures: 2 });
    assert.deepEqual([r.values.probationMinutes, r.values.maxReleaseFailures, r.values.hostRetries], [0, 2, 5]);
    assert.deepEqual(c.policies.at(-1), r.values, "the launcher's copy was told");
    assert.equal((await g.setPolicy(c.owner, { commandId: "ok", probationMinutes: 0, maxReleaseFailures: 2 })).revision, r.revision, "the same command is a repeat");
    await refuses("stale_revision", () => g.setPolicy(c.owner, { commandId: "stale", hostRetries: 9, expectedRevision: 0 }));
    assert.equal((await g.setPolicy(c.owner, { commandId: "back", probationMinutes: null })).values.probationMinutes, 30, "null puts the default back and keeps the rest");
  });

  suite("an approval for destructive migrations needs the owner, a closed rollback period and a snapshot; the next start reads it and applying it clears it", async (c) => {
    const g = c.make();
    await g.noteStart();
    c.schema.v = 2; c.clock.t = day(1);
    await g.noteStart();
    await refuses("forbidden", () => g.approveContract(c.agent, { commandId: "x1", through: 3 }));
    await refuses("invalid_transition", () => g.approveContract(c.owner, { commandId: "x2", through: 3 }), /still open until/);
    assert.equal(existsSync(join(c.dir, GATE_FILE)), false, "a refusal writes nothing");
    c.clock.t = day(20);
    await refuses("invalid_transition", () => c.make({ snapshots: false }).approveContract(c.owner, { commandId: "x3", through: 3 }), /no pre-upgrade snapshot/);
    await refuses("invalid_transition", () => g.approveContract(c.owner, { commandId: "x4", through: 2 }), /already applied/);
    await refuses("invalid_command", () => g.approveContract(c.owner, { commandId: "x5", through: "3" as never }));
    let st = await g.status(c.owner);
    assert.deepEqual(st.deferred, [3, 4, 5]); assert.equal(st.contract.waiting, true); assert.deepEqual(st.contract.refusals, []);
    const done = await g.approveContract(c.owner, { commandId: "x6", through: 3 });
    assert.deepEqual([done.through, done.appliesAt], [3, "next start"]);
    assert.equal(await readContractGate(join(c.dir, GATE_FILE)), 3);
    assert.ok(JSON.parse(readFileSync(join(c.dir, GATE_FILE), "utf8")).approvedBy.length > 0);
    st = await g.status(c.owner);
    assert.equal(st.contract.approvedThrough, 3); assert.deepEqual(st.migrations.map((m) => m.state), ["applied", "applied", "pending", "pending", "pending"]);
    // withdrawing removes the file; approving again, then the start applies it
    assert.equal((await g.withdrawContract(c.owner, { commandId: "w1" })).withdrawn, true);
    assert.equal(await readContractGate(join(c.dir, GATE_FILE)), 0);
    assert.equal((await g.withdrawContract(c.owner, { commandId: "w2" })).withdrawn, false);
    await g.approveContract(c.owner, { commandId: "x7", through: 3 });
    c.schema.v = 5; c.clock.t = day(21);
    const n = await g.noteStart();
    assert.equal(n.upgrade?.additiveOnly, false, "a destructive migration was among them");
    assert.equal(existsSync(join(c.dir, GATE_FILE)), false, "applied: the gate file is removed");
    st = await g.status(c.owner);
    assert.equal(st.contract.approvedThrough, null); assert.ok(st.contract.appliedAt !== undefined);
  });

  suite("a damaged gate file allows nothing, and a guard that cannot read the schema does not break the start", async (c) => {
    for (const text of ["", "not json", '{"v":2,"through":3}', '{"v":1,"through":0}', '{"v":1,"through":"3"}', '{"v":1,"through":2.5}']) { writeFileSync(join(c.dir, GATE_FILE), text); assert.equal(await readContractGate(join(c.dir, GATE_FILE)), 0, text); }
    assert.equal(await readContractGate(join(c.dir, "missing.json")), 0);
    const g = c.make({ schemaVersion: async () => { throw new Error("database gone"); } });
    assert.deepEqual(await g.noteStart(), { schema: -1 });
    assert.equal(await g.notePair("rcn-x"), false);
  });
  suite("the gate file counts only when it agrees with the approval the database holds: a written, edited, copied or withdrawn file allows nothing", async (c) => {
    const file = join(c.dir, GATE_FILE);
    const g = c.make();
    await g.noteStart();
    c.schema.v = 2; c.clock.t = day(1);
    await g.noteStart();
    // a file nobody approved (for example written by an agent) allows nothing, and the status does not show its migrations as allowed
    writeFileSync(file, JSON.stringify({ v: 1, through: 3, approvedBy: c.owner.id, approvedAt: day(1) }));
    assert.equal(await readContractGate(file), 3, "the file alone claims 3");
    const forged = await confirmedContract(c.storage, file);
    assert.equal(forged.through, 0); assert.match(forged.note ?? "", /does not match the approval recorded by the owner/);
    assert.deepEqual((await g.status(c.owner)).deferred, [3, 4, 5]);
    // the owner's approval: the file and the record agree
    c.clock.t = day(20);
    await g.approveContract(c.owner, { commandId: "ok", through: 3 });
    assert.deepEqual(await confirmedContract(c.storage, file), { through: 3 });
    const original = readFileSync(file, "utf8");
    // repeating the same command keeps the recorded time, so the file still agrees
    c.clock.t = day(21);
    await g.approveContract(c.owner, { commandId: "ok", through: 3 });
    assert.equal(readFileSync(file, "utf8"), original);
    assert.deepEqual(await confirmedContract(c.storage, file), { through: 3 });
    // edited: a higher number, another time or another approver
    const rec = JSON.parse(original) as Record<string, unknown>;
    for (const edit of [{ through: 5 }, { approvedAt: day(22) }, { approvedBy: "agent:plain" }]) {
      writeFileSync(file, JSON.stringify({ ...rec, ...edit }));
      assert.equal((await confirmedContract(c.storage, file)).through, 0, JSON.stringify(edit));
      assert.deepEqual((await g.summary()).deferred, [3, 4, 5], JSON.stringify(edit));
    }
    // withdrawn, then the old file put back: nothing
    writeFileSync(file, original);
    await g.withdrawContract(c.owner, { commandId: "w" });
    writeFileSync(file, original);
    assert.equal((await confirmedContract(c.storage, file)).through, 0);
    // applied: an old copy of the file allows nothing more
    await g.approveContract(c.owner, { commandId: "again", through: 3 });
    const again = readFileSync(file, "utf8");
    c.schema.v = 3;
    await g.noteStart();
    writeFileSync(file, again);
    assert.equal((await confirmedContract(c.storage, file)).through, 0);
    // no file, a damaged file, a database that cannot be read
    rmSync(file, { force: true });
    assert.deepEqual(await confirmedContract(c.storage, file), { through: 0 });
    writeFileSync(file, again);
    assert.equal((await confirmedContract({ getAggregate: async () => { throw new Error("gone"); } }, file)).through, 0);
  });
}
