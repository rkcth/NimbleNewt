import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import { runnableThrough, type Migration } from "../storage/migrations.js";
import { DEFAULT_ROLLBACK_PERIOD_DAYS, POLICY_LIMITS, ROLLBACK_PERIOD_BOUNDS, additiveBetween, contractRefusals, journalView, judgeRollback, type RollbackVerdict, type TestedPair, type UpgradeRecord } from "./rules.js";

/**
 * The migration guard (card K03): the controller's record of how the database schema moved, and the rules built on it. It records every upgrade (when, from which schema to which, whether every migration was
 * additive), every pair of release and schema that really started healthy (the "tested pairs"), the owner's policy (the rollback period, the health thresholds and probation of a rollout) and the owner's approval
 * for destructive migrations. It decides, through the pure rules in `rules.ts`, whether an earlier release may run again on the data as it now is, and whether a waiting destructive migration may be allowed.
 *
 * The approval for destructive migrations has to be known BEFORE the database is opened (the opener decides what runs), so it is kept in a small file in the data directory (`migration-gate.json`, replaced
 * atomically) as well as recorded here; `readContractGate` reads it at the start. After the migration ran the file is removed and the approval recorded as applied.
 */
const STATE = { kind: "migration-guard", id: "main" } as const;
const POLICY = { kind: "migration-policy", id: "main" } as const;
export const GATE_FILE = "migration-gate.json";

export const POLICY_DEFAULTS = { rollbackPeriodDays: DEFAULT_ROLLBACK_PERIOD_DAYS, probationMinutes: 30, maxReleaseFailures: 3, hostRetries: 5 } as const;
export const POLICY_BOUNDS = {
  rollbackPeriodDays: ROLLBACK_PERIOD_BOUNDS,
  /** 0 switches probation off. */
  probationMinutes: { min: 0, max: 1440 },
  maxReleaseFailures: { min: 1, max: 20 },
  hostRetries: { min: 1, max: 50 },
} as const;
export type PolicyKey = keyof typeof POLICY_DEFAULTS;
export interface EffectivePolicy { readonly rollbackPeriodDays: number; readonly probationMinutes: number; readonly maxReleaseFailures: number; readonly hostRetries: number }
interface PolicyBody extends Partial<EffectivePolicy> { readonly updatedBy: string; readonly updatedAt: string }

interface ContractRecord { readonly through: number; readonly approvedBy: string; readonly approvedAt: string; readonly appliedAt?: string }
interface GuardBody { readonly highWater: number; readonly upgrades: readonly UpgradeRecord[]; readonly pairs: readonly TestedPair[]; readonly contract?: ContractRecord; readonly updatedAt: string }

const bad = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const strictOwner = (by: Principal, what: string): void => { if (by.kind !== "owner" || by.taskScope !== undefined) throw new DomainError("forbidden", `${by.id} may not ${what}; only the owner does`); };
const known = (command: object, fields: readonly string[]): void => { const u = Object.keys(command).filter((k) => !fields.includes(k)); if (u.length > 0) bad(u[0]!, "is not a field of this command"); };

export interface GuardOptions {
  /** This build's migration list (names and kinds). */
  readonly migrations: readonly Migration[];
  /** The schema version of the open database. */
  readonly schemaVersion: () => Promise<number>;
  /** The data directory's gate file for destructive migrations; without it the approval is recorded but only a start option can allow them. */
  readonly gateFile?: string;
  /** The release this process was started from (the launcher's), for tested pairs. */
  readonly runningRelease?: string;
  /** Whether pre-upgrade snapshots are made (backups are configured); an approval for destructive migrations is refused without one. */
  readonly snapshots?: boolean;
  /** Told the effective policy at every start and after a change (the controller copies it into the launcher's file). */
  readonly onPolicy?: (policy: EffectivePolicy) => Promise<void>;
  readonly now?: () => string;
}

/** Reads the approval before the database is opened: the highest destructive migration the file allows, or 0. A damaged or foreign file allows nothing. On its own it is only a claim: see `confirmedContract`. */
export async function readContractGate(file: string): Promise<number> {
  return (await readGateRecord(file))?.through ?? 0;
}

interface GateRecord { readonly through: number; readonly approvedBy: string; readonly approvedAt: string }
async function readGateRecord(file: string): Promise<GateRecord | undefined> {
  try {
    const v = JSON.parse(await readFile(file, "utf8")) as { v?: unknown; through?: unknown; approvedBy?: unknown; approvedAt?: unknown };
    if (v.v !== 1 || typeof v.through !== "number" || !Number.isSafeInteger(v.through) || v.through < 1) return undefined;
    return { through: v.through, approvedBy: typeof v.approvedBy === "string" ? v.approvedBy : "", approvedAt: typeof v.approvedAt === "string" ? v.approvedAt : "" };
  } catch { return undefined; }
}

/** The file's approval counts only when the database holds the same, not yet applied, approval (the owner's `migration.contract.approve` writes both): a file written or edited by anything else allows nothing. */
const gateAgrees = (gate: GateRecord | undefined, contract: ContractRecord | undefined): number =>
  gate !== undefined && contract !== undefined && contract.appliedAt === undefined && contract.through === gate.through && contract.approvedAt === gate.approvedAt && contract.approvedBy === gate.approvedBy ? gate.through : 0;

/**
 * The approval for destructive migrations that may be acted on (card K03): the gate file's, confirmed against the approval recorded in the database (read from the database as it is, before any destructive
 * migration ran). 0 when there is no file, the file is damaged, or it does not match the owner's recorded approval (then `note` says so, without the file's content). Never throws.
 */
export async function confirmedContract(storage: Pick<ControllerStorage, "getAggregate">, file: string): Promise<{ through: number; note?: string }> {
  const gate = await readGateRecord(file);
  if (gate === undefined) return { through: 0 };
  let contract: ContractRecord | undefined;
  try { contract = ((await storage.getAggregate(STATE))?.body as unknown as GuardBody | undefined)?.contract; } catch { return { through: 0, note: `${GATE_FILE}: the owner's recorded approval could not be read, so destructive migrations stay deferred` }; }
  const through = gateAgrees(gate, contract);
  return through > 0 ? { through } : { through: 0, note: `${GATE_FILE} does not match the approval recorded by the owner (migration.contract.approve), so destructive migrations stay deferred` };
}

/**
 * The start's second step for destructive migrations (card K03). The database was opened with every destructive migration deferred; when the gate file claims an approval that would let more run and the
 * database's own record confirms it, the store is closed and `reopen` opens it again allowing exactly the confirmed number (that open takes the pre-upgrade snapshot). Otherwise the store is returned as it is.
 */
export async function openApprovedContract<S extends Pick<ControllerStorage, "getAggregate" | "snapshot" | "close">>(input: { readonly storage: S; readonly gateFile: string | undefined; readonly migrations: readonly Migration[]; readonly reopen: (contractThrough: number) => Promise<S>; readonly print: (line: string) => void }): Promise<S> {
  if (input.gateFile === undefined) return input.storage;
  const claim = await readContractGate(input.gateFile);
  if (claim === 0) return input.storage;
  const snap = await input.storage.snapshot();
  let at: number;
  try { at = snap.schemaVersion; } finally { await snap.close(); }
  if (runnableThrough(input.migrations, at, { contractThrough: claim }) <= at) return input.storage;
  const confirmed = await confirmedContract(input.storage, input.gateFile);
  if (confirmed.note !== undefined) input.print(confirmed.note);
  if (confirmed.through === 0) return input.storage;
  await input.storage.close();
  return input.reopen(confirmed.through);
}

async function writeGate(file: string, body: object): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${GATE_FILE}.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  try { await rename(tmp, file); } catch (error) { await rm(tmp, { force: true }).catch(() => undefined); throw error; }
}

export class MigrationGuardService {
  readonly #runner: CommandRunner;
  readonly #o: GuardOptions;
  #chain: Promise<unknown> = Promise.resolve();
  private constructor(runner: CommandRunner, o: GuardOptions) { this.#runner = runner; this.#o = o; }

  static withEpoch(storage: ControllerStorage, epoch: number, options: GuardOptions & { readonly runner?: RunnerOptions }): MigrationGuardService {
    return new MigrationGuardService(new CommandRunner(storage, epoch, options.runner ?? {}), options);
  }

  #now(): string { return (this.#o.now ?? (() => new Date().toISOString()))(); }
  #serial<T>(run: () => Promise<T>): Promise<T> { const next = this.#chain.then(run, run); this.#chain = next.catch(() => undefined); return next; }

  async #state(): Promise<{ revision: number; body: GuardBody | undefined }> {
    const found = await this.#runner.get(STATE.kind, STATE.id);
    return { revision: found?.revision ?? 0, body: found === undefined ? undefined : (found.body as unknown as GuardBody) };
  }
  async #write(op: string, commandId: string, actor: string, payload: JsonObject, mutate: (body: GuardBody | undefined) => GuardBody, detail: JsonObject): Promise<void> {
    await this.#runner.command(op, { commandId, actor }, async () => ({
      payload,
      build: async () => {
        const current = await this.#runner.get(STATE.kind, STATE.id);
        const next = mutate(current === undefined ? undefined : (current.body as unknown as GuardBody));
        const change = current === undefined ? { type: "create" as const, ref: STATE, body: next as unknown as JsonObject } : { type: "update" as const, ref: STATE, expectedRevision: current.revision, body: next as unknown as JsonObject };
        return { ref: STATE, creates: current === undefined, changes: [change], detail };
      },
    }));
  }

  // ---- policy ---------------------------------------------------------------------------------------------------------------------------------------------------------

  async #policyBody(): Promise<{ revision: number; body: PolicyBody | undefined }> {
    const found = await this.#runner.get(POLICY.kind, POLICY.id);
    return { revision: found?.revision ?? 0, body: found === undefined ? undefined : (found.body as unknown as PolicyBody) };
  }
  /** The values in force: the owner's, else the defaults. A damaged field falls back to its default. */
  async effective(): Promise<EffectivePolicy> {
    let body: PolicyBody | undefined;
    try { body = (await this.#policyBody()).body; } catch { body = undefined; }
    const pick = (k: PolicyKey): number => { const v = body?.[k]; const b = POLICY_BOUNDS[k]; return typeof v === "number" && Number.isSafeInteger(v) && v >= b.min && v <= b.max ? v : POLICY_DEFAULTS[k]; };
    return { rollbackPeriodDays: pick("rollbackPeriodDays"), probationMinutes: pick("probationMinutes"), maxReleaseFailures: pick("maxReleaseFailures"), hostRetries: pick("hostRetries") };
  }

  async policy(by: Principal): Promise<{ revision: number; values: EffectivePolicy; defaults: EffectivePolicy; bounds: typeof POLICY_BOUNDS; chosen: Partial<EffectivePolicy> }> {
    strictOwner(by, "read the migration and rollout policy");
    const { revision, body } = await this.#policyBody();
    const chosen: Partial<Record<PolicyKey, number>> = {};
    for (const k of Object.keys(POLICY_DEFAULTS) as PolicyKey[]) if (typeof body?.[k] === "number") chosen[k] = body[k]!;
    return { revision, values: await this.effective(), defaults: POLICY_DEFAULTS, bounds: POLICY_BOUNDS, chosen };
  }

  /**
   * Owner only. `rollbackPeriodDays` (how long an earlier release may come back over additive migrations), `probationMinutes` (how long a newly activated release is watched, 0 = not watched),
   * `maxReleaseFailures` (failures attributed to the release itself that end its probation as failed) and `hostRetries` (consecutive starts that failed for host or provider reasons before the owner is told
   * the installation, not the release, needs attention). A field left out keeps its value; null puts the default back.
   */
  async setPolicy(owner: Principal, command: NoActor & { rollbackPeriodDays?: unknown; probationMinutes?: unknown; maxReleaseFailures?: unknown; hostRetries?: unknown; expectedRevision?: number }): Promise<{ revision: number; values: EffectivePolicy }> {
    strictOwner(owner, "change the migration and rollout policy");
    const keys = Object.keys(POLICY_DEFAULTS) as PolicyKey[];
    known(command, ["commandId", ...keys, "expectedRevision"]);
    if (keys.every((k) => command[k] === undefined)) bad("rollbackPeriodDays", `give at least one of ${keys.join(", ")}`);
    for (const k of keys) {
      const v = command[k];
      if (v === undefined || v === null) continue;
      const b = POLICY_BOUNDS[k];
      if (!(typeof v === "number" && Number.isSafeInteger(v) && v >= b.min && v <= b.max)) bad(k, `must be a whole number from ${b.min} to ${b.max}, or null for the default (${POLICY_DEFAULTS[k]})`);
    }
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) bad("expectedRevision", "must be a whole number");
    const r = await this.#runner.command("migration.policy.set", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { ...Object.fromEntries(keys.map((k) => [k, command[k] === undefined ? "keep" : (command[k] as number | null)])) } as JsonObject,
      build: async () => {
        const current = await this.#runner.get(POLICY.kind, POLICY.id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the policy is at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const before = current?.body as unknown as PolicyBody | undefined;
        const next: Record<string, unknown> = {};
        for (const k of keys) { const v = command[k] === undefined ? before?.[k] : command[k] === null ? undefined : command[k]; if (v !== undefined) next[k] = v; }
        const body = { ...next, updatedBy: owner.id, updatedAt: this.#now() } as unknown as JsonObject;
        const change = current === undefined ? { type: "create" as const, ref: POLICY, body } : { type: "update" as const, ref: POLICY, expectedRevision: current.revision, body };
        return { ref: POLICY, creates: current === undefined, changes: [change], detail: { ...next } as JsonObject };
      },
    }));
    const values = await this.effective();
    await this.#o.onPolicy?.(values).catch(() => undefined);
    return { revision: r.revision, values };
  }

  // ---- what the start tells the guard --------------------------------------------------------------------------------------------------------------------------------

  /**
   * Called once the database is open, at every start. Records an upgrade when the schema is higher than ever recorded (an installation with no record yet only gets a baseline: how it got there is not known),
   * clears an approval for destructive migrations that has now been applied, and hands the policy to the launcher's copy. Never throws: the next start tries again.
   */
  async noteStart(): Promise<{ schema: number; upgrade?: UpgradeRecord }> {
    return this.#serial(async () => {
      const schema = await this.#o.schemaVersion();
      const { body } = await this.#state();
      let upgrade: UpgradeRecord | undefined;
      const now = this.#now();
      if (body === undefined || schema > body.highWater) {
        if (body !== undefined) upgrade = { from: body.highWater, to: schema, at: now, additiveOnly: additiveBetween(this.#o.migrations, body.highWater, schema), ...(this.#o.runningRelease === undefined ? {} : { by: this.#o.runningRelease }) };
        const contractDone = body?.contract !== undefined && body.contract.appliedAt === undefined && schema >= body.contract.through;
        await this.#write("migration.noted", `migration-noted-${body?.highWater ?? 0}-${schema}`, "controller", { from: body?.highWater ?? 0, to: schema }, (b) => ({
          highWater: schema,
          upgrades: upgrade === undefined ? (b?.upgrades ?? []) : [...(b?.upgrades ?? []), upgrade].slice(-POLICY_LIMITS.upgrades),
          pairs: b?.pairs ?? [],
          ...(b?.contract === undefined ? {} : { contract: contractDone ? { ...b.contract, appliedAt: now } : b.contract }),
          updatedAt: now,
        }), { from: body?.highWater ?? 0, to: schema, additiveOnly: upgrade?.additiveOnly ?? null });
        if (contractDone && this.#o.gateFile !== undefined) await rm(this.#o.gateFile, { force: true }).catch(() => undefined);
      }
      await this.#o.onPolicy?.(await this.effective()).catch(() => undefined);
      return { schema, ...(upgrade === undefined ? {} : { upgrade }) };
    }).catch(() => ({ schema: -1 }));
  }

  /** The release this process runs started healthy on the schema the database is at now: a tested pair. Idempotent. */
  async notePair(release: string): Promise<boolean> {
    return this.#serial(async () => {
      const schema = await this.#o.schemaVersion();
      const { body } = await this.#state();
      if (body?.pairs.some((p) => p.release === release && p.schema === schema)) return false;
      const now = this.#now();
      await this.#write("migration.pair", `migration-pair-${release}-${schema}`, "controller", { release, schema }, (b) => ({
        highWater: Math.max(b?.highWater ?? 0, schema), upgrades: b?.upgrades ?? [],
        pairs: [...(b?.pairs ?? []), { release, schema, at: now }].slice(-POLICY_LIMITS.pairs),
        ...(b?.contract === undefined ? {} : { contract: b.contract }), updatedAt: now,
      }), { release, schema });
      return true;
    }).catch(() => false);
  }

  // ---- questions ---------------------------------------------------------------------------------------------------------------------------------------------------------

  /** May `release` run again on the database as it is now? Used before a rollback and by the launcher's copy. */
  async rollbackVerdict(release: string): Promise<RollbackVerdict> {
    const { body } = await this.#state();
    const policy = await this.effective();
    return judgeRollback({ release, dbSchema: await this.#o.schemaVersion(), pairs: body?.pairs ?? [], upgrades: body?.upgrades ?? [], migrations: this.#o.migrations, periodDays: policy.rollbackPeriodDays, now: this.#now() });
  }

  /**
   * The safe-back line for the launcher's fall-back: the lowest schema a release can have been tested on and still run on the database as it is (every migration above it additive and the rollback period open),
   * and when that ends. Undefined when nothing is safe (a destructive migration is the latest, or no upgrade is on record).
   */
  async safeBack(): Promise<{ backTo: number; until: string } | undefined> {
    const { body } = await this.#state();
    if (body === undefined) return undefined;
    const policy = await this.effective();
    const db = await this.#o.schemaVersion();
    const first = [...body.upgrades].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).find((u) => u.to > 0 && additiveBetween(this.#o.migrations, u.from, db));
    if (first === undefined) return undefined;
    const until = new Date(Date.parse(first.at) + policy.rollbackPeriodDays * 86_400_000).toISOString();
    return Date.parse(this.#now()) > Date.parse(until) ? undefined : { backTo: first.from, until };
  }

  async status(by: Principal): Promise<{
    schemaVersion: number; latestKnown: number; migrations: ReturnType<typeof journalView>; deferred: number[]; upgrades: readonly UpgradeRecord[]; testedPairs: readonly TestedPair[];
    rollbackPeriod: { days: number; open: boolean; since?: string; until?: string }; contract: { approvedThrough: number | null; appliedAt?: string; approvedBy?: string; waiting: boolean; refusals: string[] };
    policy: EffectivePolicy; recovery: string;
  }> {
    strictOwner(by, "read the migration status");
    const { body } = await this.#state();
    const policy = await this.effective();
    const schema = await this.#o.schemaVersion();
    const allowed = this.#o.gateFile === undefined ? 0 : gateAgrees(await readGateRecord(this.#o.gateFile), body?.contract);
    const view = journalView(this.#o.migrations, schema, allowed);
    const deferred = view.filter((m) => m.state === "deferred").map((m) => m.version);
    const latest = [...(body?.upgrades ?? [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    const until = latest === undefined ? undefined : new Date(Date.parse(latest.at) + policy.rollbackPeriodDays * 86_400_000).toISOString();
    const through = this.#o.migrations.reduce((n, m) => (m.kind === "destructive" && m.version > schema ? Math.max(n, m.version) : n), 0);
    return {
      schemaVersion: schema, latestKnown: this.#o.migrations.length, migrations: view, deferred, upgrades: body?.upgrades ?? [], testedPairs: body?.pairs ?? [],
      rollbackPeriod: { days: policy.rollbackPeriodDays, open: until !== undefined && Date.parse(this.#now()) <= Date.parse(until), ...(latest === undefined ? {} : { since: latest.at }), ...(until === undefined ? {} : { until }) },
      contract: { approvedThrough: body?.contract?.appliedAt === undefined ? (body?.contract?.through ?? null) : null, ...(body?.contract?.appliedAt === undefined ? {} : { appliedAt: body.contract.appliedAt }), ...(body?.contract === undefined ? {} : { approvedBy: body.contract.approvedBy }), waiting: deferred.length > 0,
        refusals: through === 0 ? [] : contractRefusals({ through, applied: schema, migrations: this.#o.migrations, upgrades: body?.upgrades ?? [], periodDays: policy.rollbackPeriodDays, now: this.#now() }) },
      policy,
      recovery: "docs/nimblenewt/migration-recovery.md",
    };
  }

  /** A short view for the release status (no principal check: the caller is the status view, which is the owner's). */
  async summary(): Promise<{ schemaVersion: number; deferred: readonly number[]; rollbackOpen: boolean; rollbackUntil?: string; approvedThrough: number | null; policy: EffectivePolicy }> {
    const { body } = await this.#state();
    const policy = await this.effective();
    const schema = await this.#o.schemaVersion();
    const gate = this.#o.gateFile === undefined ? 0 : gateAgrees(await readGateRecord(this.#o.gateFile), body?.contract);
    const deferred = journalView(this.#o.migrations, schema, gate).filter((m) => m.state === "deferred").map((m) => m.version);
    const latest = [...(body?.upgrades ?? [])].sort((x, y) => Date.parse(y.at) - Date.parse(x.at))[0];
    const until = latest === undefined ? undefined : new Date(Date.parse(latest.at) + policy.rollbackPeriodDays * 86_400_000).toISOString();
    return { schemaVersion: schema, deferred, rollbackOpen: until !== undefined && Date.parse(this.#now()) <= Date.parse(until) && latest!.additiveOnly, ...(until === undefined ? {} : { rollbackUntil: until }), approvedThrough: body?.contract?.appliedAt === undefined ? (body?.contract?.through ?? null) : null, policy };
  }

  /**
   * Owner only: allows the destructive migrations up to `through` to run at the NEXT start (the opener decides what runs, so the approval is written where the start reads it before the database is opened).
   * Refused while the rollback period after the latest upgrade is open, when no pre-upgrade snapshot would be made, or when nothing destructive waits up to that number.
   */
  async approveContract(owner: Principal, command: NoActor & { through: unknown; expectedRevision?: number }): Promise<{ revision: number; through: number; appliesAt: "next start" }> {
    strictOwner(owner, "allow destructive migrations");
    known(command, ["commandId", "through", "expectedRevision"]);
    const through = command.through;
    if (typeof through !== "number" || !Number.isSafeInteger(through) || through < 1) bad("through", "must be the number of the destructive migration to allow (a whole number, at least 1)");
    const { revision, body } = await this.#state();
    if (command.expectedRevision !== undefined && command.expectedRevision !== revision) throw new DomainError("stale_revision", `the migration record is at revision ${revision}, not ${command.expectedRevision}`, { currentRevision: revision });
    const schema = await this.#o.schemaVersion();
    const policy = await this.effective();
    const refusals = contractRefusals({ through: through as number, applied: schema, migrations: this.#o.migrations, upgrades: body?.upgrades ?? [], periodDays: policy.rollbackPeriodDays, now: this.#now() });
    if (this.#o.snapshots !== true) refusals.push("no pre-upgrade snapshot would be made (backups are not set up), and a destructive migration cannot be undone without one");
    if (this.#o.gateFile === undefined) refusals.push("this installation has no data directory to keep the approval in, so only a start option can allow it");
    if (refusals.length > 0) throw new DomainError("invalid_transition", refusals.join("; "));
    const now = this.#now();
    await this.#serial(async () => {
      await this.#write("migration.contract.approve", scopedCommandId(owner.id, command.commandId), owner.id, { through: through as number }, (b) => ({
        highWater: b?.highWater ?? schema, upgrades: b?.upgrades ?? [], pairs: b?.pairs ?? [], contract: { through: through as number, approvedBy: owner.id, approvedAt: now }, updatedAt: now,
      }), { through: through as number });
      // The file copies the approval as recorded (a repeated command keeps its first time), so the start can confirm it against the database.
      const recorded = (await this.#state()).body?.contract;
      if (recorded === undefined || recorded.appliedAt !== undefined) throw new DomainError("invalid_transition", "the approval was not recorded");
      await writeGate(this.#o.gateFile!, { v: 1, through: recorded.through, approvedBy: recorded.approvedBy, approvedAt: recorded.approvedAt });
    });
    return { revision: (await this.#state()).revision, through: through as number, appliesAt: "next start" };
  }

  /** Owner only: withdraws an approval that has not been applied yet. */
  async withdrawContract(owner: Principal, command: NoActor & { expectedRevision?: number }): Promise<{ withdrawn: boolean }> {
    strictOwner(owner, "withdraw the approval for destructive migrations");
    known(command, ["commandId", "expectedRevision"]);
    const { body } = await this.#state();
    if (body?.contract === undefined || body.contract.appliedAt !== undefined) return { withdrawn: false };
    const now = this.#now();
    await this.#serial(async () => {
      await this.#write("migration.contract.withdraw", scopedCommandId(owner.id, command.commandId), owner.id, {}, (b) => { const { contract: _c, ...rest } = b!; void _c; return { ...rest, updatedAt: now }; }, {});
      if (this.#o.gateFile !== undefined) await rm(this.#o.gateFile, { force: true });
    });
    return { withdrawn: true };
  }
}
