import assert from "node:assert/strict";
import { test } from "node:test";
import { StorageError } from "./errors.js";
import { assertValidMigrations, migrationChecksum, planMigrations, runnableThrough, type JournalEntry, type Migration } from "./migrations.js";

const m = (version: number, name: string, statements: readonly string[] = [`step ${version}`], transactional?: boolean): Migration => ({ version, name, statements, ...(transactional === undefined ? {} : { transactional }) });
const registry = [m(1, "initial"), m(2, "add_things"), m(3, "add_more", ["a second step"], false)];
const entry = (migration: Migration, state: "running" | "done" = "done"): JournalEntry => ({ version: migration.version, name: migration.name, checksum: migrationChecksum(migration), state });
const refusal = (journal: JournalEntry[], reg = registry): string => {
  try { planMigrations(reg, journal); } catch (e) { assert.ok(e instanceof StorageError && e.kind === "unavailable"); return e.message; }
  return assert.fail("expected a refusal");
};

test("a new database needs everything; a current one needs nothing; a partly migrated one needs the rest", () => {
  assert.deepEqual(planMigrations(registry, []), { applied: 0, resume: undefined, pending: registry });
  assert.deepEqual(planMigrations(registry, registry.map((x) => entry(x))), { applied: 3, resume: undefined, pending: [] });
  assert.deepEqual(planMigrations(registry, [entry(registry[0]!)]), { applied: 1, resume: undefined, pending: [registry[1], registry[2]] });
});

test("an interrupted non-transactional migration is resumed first, then the rest follow", () => {
  const plan = planMigrations(registry, [entry(registry[0]!), entry(registry[1]!), entry(registry[2]!, "running")]);
  assert.equal(plan.resume, registry[2]);
  assert.deepEqual([plan.applied, plan.pending], [2, []]);
  const earlier = planMigrations(registry, [entry(registry[0]!), entry(registry[1]!, "running")]);
  assert.deepEqual([earlier.resume, earlier.applied, earlier.pending], [registry[1], 1, [registry[2]]]);
});

test("a database from a newer version is refused untouched, naming the newer migration (no downgrades)", () => {
  assert.match(refusal([...registry.map((x) => entry(x)), { version: 4, name: "from_the_future", checksum: "abc", state: "done" }]), /migration 4 \(from_the_future\), newer than the latest this version of NimbleNewt knows \(3\).*Nothing was changed/);
  assert.match(refusal([entry(registry[0]!), entry(registry[1]!)], [registry[0]!]), /migration 2 \(add_things\), newer than the latest.*\(1\)/);
});

test("a migration edited after it was applied is refused, whether its content or its name changed", () => {
  const edited = [m(1, "initial", ["step 1, changed"]), registry[1]!, registry[2]!];
  assert.match(refusal([entry(registry[0]!)], edited), /migration 1 \(initial\) was changed after it was applied.*never edited/);
  const renamed = [m(1, "first", registry[0]!.statements), registry[1]!, registry[2]!];
  assert.match(refusal([entry(registry[0]!)], renamed), /was changed after it was applied/);
  const flipped = [m(1, "initial", registry[0]!.statements, false), registry[1]!, registry[2]!];
  assert.match(refusal([entry(registry[0]!)], flipped), /was changed after it was applied/);
});

test("a journal with a gap, or a running migration followed by later ones, is refused", () => {
  assert.match(refusal([entry(registry[1]!)]), /missing migration 1/);
  assert.match(refusal([entry(registry[0]!), entry(registry[2]!)]), /missing migration 2/);
  assert.match(refusal([entry(registry[0]!, "running"), entry(registry[1]!)]), /migration 1 still running although later migrations were recorded/);
});

test("the checksum covers number, name, statements and whether the migration is transactional, and ignores nothing else", () => {
  const base = migrationChecksum(registry[0]!);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(migrationChecksum(m(1, "initial")), base);
  for (const different of [m(2, "initial"), m(1, "other"), m(1, "initial", ["step 1, other"]), m(1, "initial", ["step 1", "step 1b"]), m(1, "initial", ["step 1"], false)]) {
    assert.notEqual(migrationChecksum(different), base);
  }
  assert.equal(migrationChecksum(m(1, "initial", ["step 1"], true)), base, "transactional by default");
});

test("programmer mistakes in a list of migrations are rejected loudly", () => {
  assert.throws(() => assertValidMigrations([]), /at least one/);
  assert.throws(() => assertValidMigrations([m(2, "second")]), /numbered 1, 2, 3/);
  assert.throws(() => assertValidMigrations([m(1, "a"), m(3, "c")]), /without gaps/);
  assert.throws(() => assertValidMigrations([m(1, "Bad Name")]), /lower-case words/);
  assert.throws(() => assertValidMigrations([m(1, "a"), m(2, "a")]), /used twice/);
  assert.throws(() => assertValidMigrations([m(1, "a", [])]), /empty statement/);
  assert.throws(() => assertValidMigrations([m(1, "a", ["  "])]), /empty statement/);
});

test("a destructive migration is deferred unless the opener allows it, and everything after it waits (card K03)", () => {
  const d = (version: number, name: string): Migration => ({ ...m(version, name), kind: "destructive" });
  const reg = [m(1, "initial"), m(2, "add_things"), d(3, "drop_things"), m(4, "after_the_drop")];
  const done = (n: number) => reg.slice(0, n).map((x) => entry(x));
  const plan = planMigrations(reg, done(2));
  assert.deepEqual([plan.applied, plan.pending, plan.deferred?.map((x) => x.version)], [2, [], [3, 4]]);
  assert.deepEqual(planMigrations(reg, done(2), { contractThrough: 2 }).deferred?.map((x) => x.version), [3, 4], "below the destructive number is not enough");
  const allowed = planMigrations(reg, done(2), { contractThrough: 3 });
  assert.deepEqual([allowed.pending.map((x) => x.version), allowed.deferred], [[3, 4], undefined]);
  assert.equal(planMigrations(reg, []).pending.length, 2, "a new database gets the additive ones and waits at the first destructive one");
  assert.equal(runnableThrough(reg, 2), 2);
  assert.equal(runnableThrough(reg, 1), 2);
  assert.equal(runnableThrough(reg, 2, { contractThrough: 3 }), 4);
  // an interrupted destructive migration is finished whatever is allowed (it was begun)
  const running = planMigrations(reg, [...done(2), entry(reg[2]!, "running")]);
  assert.equal(running.resume?.version, 3);
  assert.deepEqual(running.deferred === undefined ? [] : running.deferred.map((x) => x.version), [], "nothing waits behind a running one that is resumed first, then the rest follow");
});

test("the checksum of a destructive migration differs from the same migration marked additive, and an additive one is unchanged by the new field (card K03)", () => {
  assert.notEqual(migrationChecksum({ ...m(1, "initial"), kind: "destructive" }), migrationChecksum(m(1, "initial")));
  assert.equal(migrationChecksum({ ...m(1, "initial"), kind: "additive" }), migrationChecksum(m(1, "initial")));
  assert.throws(() => assertValidMigrations([{ ...m(1, "initial"), kind: "sideways" as never }]), /additive or destructive/);
});
