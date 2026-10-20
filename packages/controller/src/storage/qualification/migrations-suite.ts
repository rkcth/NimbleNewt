import assert from "node:assert/strict";
import { StorageError } from "../errors.js";
import type { ControllerStorage } from "../types.js";
import { ACTIONS, seedWorld, snapshotWorld, type CrashPoint } from "./boundaries.js";
import type { RegistryName } from "./migration-registry.js";

/**
 * Qualification of the schema migration runners (card F04), shared by the SQLite and PostgreSQL rigs:
 * - upgrades preserve the state of a populated database, and the adapter keeps working on the upgraded layout;
 * - an upgrade interrupted at every statement boundary (killed before or after each) leaves the database in a state the next start
 *   can recover from, never half a transactional migration, and recovery ends in the state of an uninterrupted upgrade;
 * - a database from a newer version, or one whose applied migration was edited, is refused and left untouched;
 * - two openers at once apply each migration exactly once;
 * - an interrupted non-transactional migration is journaled as running and finished by the next start.
 */
export interface MigrationOutcome { readonly crashed: boolean; readonly statements: number; readonly error?: StorageError }

export interface MigrationWorld {
  /** Opens the database with the named migrations (migrating it), then closes it; optionally killed at `point`. */
  attempt(migrations: RegistryName, point?: CrashPoint): Promise<MigrationOutcome>;
  /** Opens the database with the named migrations, runs `fn`, closes it. */
  withStorage<T>(migrations: RegistryName, fn: (storage: ControllerStorage) => Promise<T>): Promise<T>;
  /** The raw schema, journal and probe rows, without migrating anything and without timestamps. */
  describe(): Promise<Description>;
  /** Runs raw SQL against the database (setup and tampering). */
  sql(statement: string): Promise<void>;
  /** Starts two openers of the same database at the same moment and resolves with each one's outcome. */
  attemptTwice(migrations: RegistryName): Promise<MigrationOutcome[]>;
  close(): Promise<void>;
}

export interface Description {
  readonly structure: unknown;
  readonly journal: readonly { version: number; name: string; state: string }[];
  readonly probe: readonly number[];
}

export interface MigrationRig {
  readonly name: string;
  readonly dialect: "sqlite" | "postgres";
  open(): Promise<MigrationWorld>;
}

const journalVersions = (d: Description, state: string): number[] => d.journal.filter((j) => j.state === state).map((j) => j.version);

/** A database populated by the production layout: the seeded world plus the complex operation. */
async function populated(world: MigrationWorld): Promise<unknown> {
  await world.withStorage("v1", async (s) => { await seedWorld(s); await ACTIONS.operation.run(s); });
  return world.withStorage("v1", (s) => snapshotWorld(s));
}

export async function upgradePreservesState(rig: MigrationRig): Promise<void> {
  const world = await rig.open();
  try {
    const before = await populated(world);
    const old = await world.describe();
    assert.deepEqual(journalVersions(old, "done"), [1]);
    assert.deepEqual(old.probe, [], "the probe table does not exist yet");

    await world.withStorage("v123", async (s) => {
      assert.deepEqual(await snapshotWorld(s), before, `${rig.name}: the upgrade changed what the storage reports`);
      // The adapter still works on the upgraded layout, and old rows are readable next to new ones.
      await s.applyOperation({ operationId: "after-upgrade", epoch: 1, actor: "a", correlationId: "c", at: "2026-10-19T13:00:00.000Z", changes: [{ type: "create", ref: { kind: "item", id: "new" }, body: { fresh: true } }], audit: [{ type: "post.upgrade", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
      assert.equal((await s.getAggregate({ kind: "item", id: "t1" }))?.revision, 2);
      assert.equal((await s.getAggregate({ kind: "item", id: "new" }))?.revision, 1);
    });
    const upgraded = await world.describe();
    assert.deepEqual(journalVersions(upgraded, "done"), [1, 2, 3]);
    assert.deepEqual(journalVersions(upgraded, "running"), []);
    assert.deepEqual(upgraded.probe, [2, 3], "each migration's statements ran exactly once");
    assert.notDeepEqual(upgraded.structure, old.structure);

    // Opening again with the same migrations changes nothing.
    const again = await world.describe();
    await world.withStorage("v123", async () => undefined);
    assert.deepEqual(await world.describe(), again);
  } finally { await world.close(); }
}

export async function refusals(rig: MigrationRig): Promise<void> {
  const world = await rig.open();
  try {
    await populated(world);
    await world.withStorage("v123", async () => undefined);
    const upgraded = await world.describe();

    // A database written by a newer version (this build knows only v1 and v2) is refused and left exactly as it was.
    const downgrade = await world.attempt("v12");
    assert.equal(downgrade.error?.kind, "unavailable");
    assert.match(downgrade.error?.message ?? "", /migration 3 \(audit_type_index_and_notes\), newer than the latest this version of NimbleNewt knows \(2\).*Nothing was changed/);
    assert.deepEqual(await world.describe(), upgraded, `${rig.name}: a refused downgrade changed the database`);

    // A migration that differs from what was applied is refused untouched.
    const edited = await world.attempt("v123-with-v2-edited");
    assert.equal(edited.error?.kind, "unavailable");
    assert.match(edited.error?.message ?? "", /migration 2 \(add_note_and_probe\) was changed after it was applied.*never edited.*Nothing was changed/);
    assert.deepEqual(await world.describe(), upgraded);

    // A journal with a missing entry is refused.
    await world.sql("DELETE FROM schema_migrations WHERE version = 2");
    const gap = await world.attempt("v123");
    assert.equal(gap.error?.kind, "unavailable");
    assert.match(gap.error?.message ?? "", /missing migration 2/);
  } finally { await world.close(); }
}

export async function resumesRunningMigrations(rig: MigrationRig): Promise<void> {
  const world = await rig.open();
  try {
    await populated(world);
    await world.withStorage("v123", async () => undefined);
    const finished = await world.describe();
    assert.deepEqual(journalVersions(finished, "done"), [1, 2, 3]);

    // The state an interrupted non-transactional migration leaves: journaled as running. The next start runs its (idempotent)
    // statements again and marks it done, and nothing else changes.
    await world.sql("UPDATE schema_migrations SET state = 'running', finished_at = NULL WHERE version = 3");
    assert.deepEqual(journalVersions(await world.describe(), "running"), [3]);
    const resumed = await world.attempt("v123");
    assert.equal(resumed.error, undefined, `${rig.name}: resuming failed: ${resumed.error?.message}`);
    assert.deepEqual(await world.describe(), finished, `${rig.name}: resuming a running migration did not end in the finished state`);

    // A running entry whose recorded content differs from this build's is refused, not resumed blindly.
    await world.sql("UPDATE schema_migrations SET state = 'running', checksum = 'something-else' WHERE version = 3");
    const refused = await world.attempt("v123");
    assert.equal(refused.error?.kind, "unavailable");
    assert.match(refused.error?.message ?? "", /migration 3 \(audit_type_index_and_notes\) was changed after it was applied/);
    assert.equal(journalVersions(await world.describe(), "running")[0], 3, "a refused start must leave the journal as it was");
  } finally { await world.close(); }
}

export async function upgradeCrashMatrix(rig: MigrationRig): Promise<{ statements: number; points: number }> {
  // The uninterrupted upgrade, for comparison, and how many numbered statements it runs.
  const clean = await rig.open();
  let before: unknown;
  let finalState: Description;
  let finalData: unknown;
  let statements: number;
  try {
    before = await populated(clean);
    const outcome = await clean.attempt("v123");
    assert.equal(outcome.crashed, false);
    assert.equal(outcome.error, undefined);
    statements = outcome.statements;
    finalState = await clean.describe();
    finalData = await clean.withStorage("v123", (s) => snapshotWorld(s));
  } finally { await clean.close(); }
  assert.deepEqual(finalData, before);
  assert.ok(statements >= 15, `the upgrade is expected to run many statements, saw ${statements}`);

  let points = 0;
  for (let ordinal = 1; ordinal <= statements; ordinal++) {
    for (const when of ["before", "after"] as const) {
      const label = `${rig.name}: upgrade killed ${when} statement ${ordinal} of ${statements}`;
      const world = await rig.open();
      try {
        await populated(world);
        const end = await world.attempt("v123", { when, ordinal });
        assert.equal(end.crashed, true, `${label}: the crash point was not reached`);
        points += 1;
        // What the crash left must be a state the runner can recover from, and never half a transactional migration.
        const left = await world.describe();
        const done = journalVersions(left, "done");
        assert.deepEqual(done, [1, 2, 3].slice(0, done.length), `${label}: the journal is not a prefix of the migrations: ${JSON.stringify(left.journal)}`);
        const running = journalVersions(left, "running");
        assert.ok(running.length === 0 || (running.length === 1 && running[0] === done.length + 1), `${label}: unexpected running entries ${JSON.stringify(left.journal)}`);
        const v2Objects = left.probe.includes(2);
        assert.equal(v2Objects, done.length >= 2, `${label}: migration 2 is ${done.length >= 2 ? "recorded done but its effects are missing" : "partly or fully applied without being recorded"} (probe ${JSON.stringify(left.probe)}, journal ${JSON.stringify(left.journal)})`);
        if (running.length === 1) assert.equal(running[0], 3, `${label}: only the non-transactional migration may be journaled as running`);
        // A non-transactional migration leaves a trace in the journal before its first statement and is never "done" before its last.
        const v3Started = JSON.stringify(left.structure).includes("audit_type");
        assert.ok(!v3Started || done.includes(3) || running.includes(3), `${label}: migration 3 changed the database without being journaled as running or done: ${JSON.stringify(left.journal)}`);
        assert.ok(!done.includes(3) || left.probe.includes(3), `${label}: migration 3 is recorded done but its last statement did not run`);

        // Recovery: the next start finishes the job, with every migration's statements effectively once.
        const recovered = await world.attempt("v123");
        assert.equal(recovered.error, undefined, `${label}: recovery failed: ${recovered.error?.message}`);
        assert.deepEqual(await world.describe(), finalState, `${label}: recovery did not reach the state of an uninterrupted upgrade`);
        assert.deepEqual(await world.withStorage("v123", (s) => snapshotWorld(s)), finalData, `${label}: data changed`);
      } finally { await world.close(); }
    }
  }
  return { statements, points };
}

export async function concurrentOpensApplyOnce(rig: MigrationRig): Promise<void> {
  for (let round = 0; round < 3; round++) {
    const world = await rig.open();
    try {
      await populated(world);
      const outcomes = await world.attemptTwice("v123");
      for (const outcome of outcomes) assert.equal(outcome.error, undefined, `${rig.name}: a concurrent opener failed: ${outcome.error?.message}`);
      const state = await world.describe();
      assert.deepEqual(state.journal.map((j) => [j.version, j.state]), [[1, "done"], [2, "done"], [3, "done"]]);
      assert.deepEqual(state.probe, [2, 3], `${rig.name}: a migration ran more than once`);
    } finally { await world.close(); }
  }
}

export async function cannotLoopForever(rig: MigrationRig): Promise<void> {
  const world = await rig.open();
  try {
    await populated(world);
    const started = Date.now();
    const outcome = await world.attempt("v12-with-erasing-v3");
    assert.ok(Date.now() - started < 60_000, `${rig.name}: the runner did not give up on a migration that cannot be journaled`);
    assert.equal(outcome.error?.kind, "unavailable");
    assert.match(outcome.error?.message ?? "", /not making progress/);
  } finally { await world.close(); }
}
