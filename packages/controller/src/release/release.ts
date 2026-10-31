import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { onlyKnown, text } from "../domain/model.js";
import { CommandRunner, type Built, type RunnerOptions } from "../domain/runner.js";
import { allows } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import { canonicalJson } from "../storage/json.js";
import type { Aggregate, AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";

/** One platform the release must pass on. */
export interface Cell { readonly os: "linux" | "darwin" | "win32"; readonly arch: "x64" | "arm64"; readonly osVersion?: string }
/** What is being released, fixed when it is submitted. Its ID is a digest of exactly this, so the same candidate cannot be two different things. */
export interface Manifest {
  readonly sourceCommit: string;
  readonly suiteRevision: string;
  /** Built artifact name -> sha256. */
  readonly artifacts: Readonly<Record<string, string>>;
  /** Dependency lock name -> sha256. */
  readonly dependencyLocks: Readonly<Record<string, string>>;
  readonly matrix: readonly Cell[];
}
export interface CandidateBody { readonly manifest: Manifest; readonly submittedBy: string; readonly submittedAt: string }
export interface HostAuthBody { readonly hostId: string; readonly os: Cell["os"]; readonly arch: Cell["arch"]; readonly active: boolean; readonly by: string; readonly at: string }
export type AttemptState = "issued" | "passed" | "failed" | "interrupted" | "timed_out";
export interface ResultBody {
  readonly outcome: "pass" | "fail";
  readonly counts: { readonly passed: number; readonly failed: number; readonly skipped: number };
  readonly environment: Cell;
  readonly logDigest: string;
  readonly summary: string;
}
export interface AttemptBody {
  readonly candidateId: string;
  readonly cell: Cell;
  readonly n: number;
  readonly hostId: string;
  /** The only principal whose result is taken. */
  readonly workerId: string;
  readonly payloadDigest: string;
  readonly limits: { readonly timeoutSeconds: number; readonly memoryMb: number };
  readonly state: AttemptState;
  readonly issuedAt: string;
  /** Who started it (the owner, a QA agent or a QA agent's boss) and, when it was cancelled, who cancelled it. */
  readonly issuedBy?: string;
  /** When the host fetched and acknowledged the job (the host path only). */
  readonly pickedUpAt?: string;
  readonly endedBy?: string;
  readonly endedAt?: string;
  readonly result?: ResultBody;
  readonly reason?: string;
}
export interface ApprovalBody { readonly candidateId: string; readonly by: string; readonly at: string; /** The earlier failed attempts the owner acknowledged when approving a release that passed only on a retry. */ readonly acknowledged?: readonly string[] }
/** Index of the attempts of one platform of one candidate (so no list of all attempts is ever scanned). */
export interface CellIndexBody { readonly candidateId: string; readonly cell: string; readonly attempts: readonly { readonly id: string; readonly n: number; readonly by: string }[] }
/** Index of one host: the attempts still open on it and the recently ended ones it must stop. */
export interface HostIndexBody { readonly hostId: string; readonly open: readonly string[]; readonly cancel: readonly { readonly id: string; readonly at: string }[] }
/** When one non-owner issuer started or cancelled tests (epoch ms, newest last, only the last hour). */
export interface IssuerIndexBody { readonly by: string; readonly events: readonly number[] }
/** The job a worker is given: everything it needs and nothing it chooses. The same candidate, platform and attempt give the same payload byte for byte. */
export interface JobPayload {
  readonly capability: "release-test";
  readonly candidateId: string;
  readonly attemptId: string;
  readonly sourceCommit: string;
  readonly suiteRevision: string;
  readonly artifacts: Readonly<Record<string, string>>;
  readonly dependencyLocks: Readonly<Record<string, string>>;
  readonly cell: Cell;
  readonly limits: { readonly timeoutSeconds: number; readonly memoryMb: number };
}
export type CellState = "passed" | "failed" | "interrupted" | "timed_out" | "running" | "missing";
/** An attempt that failed before the platform's passing one: kept in view beside the pass, never hidden by it. */
export interface EarlierFailure { readonly id: string; readonly n: number; readonly issuedBy?: string; readonly summary?: string; readonly endedAt?: string }
export interface GateCell { readonly cell: Cell; readonly state: CellState; readonly attempts: number; readonly latest?: string; /** True when the platform passed only after earlier failures (a retry until green). */ readonly flaky: boolean; readonly earlierFailures: readonly EarlierFailure[] }
/** `ready`: every platform's latest attempt passed. `needsAcknowledgement`: some platform passed only after failing; the owner approves such a release only by saying so (`acknowledgeFlaky`). */
export interface Gate { readonly candidateId: string; readonly ready: boolean; readonly needsAcknowledgement: boolean; readonly approved: boolean; readonly cells: readonly GateCell[] }

/** Who besides the owner may start and cancel release tests. A setting not set takes the installation profile's default (strict: owner only; derived and autonomous: both on). */
export interface IssuerSettingsBody { readonly qaAgents?: boolean; readonly bosses?: boolean; readonly qaRole?: string; readonly qaAgentIds?: readonly string[]; readonly startsPerHour?: number; readonly updatedBy: string; readonly updatedAt: string }
/**
 * `qaAgentIds`: when the owner names agents here, exactly those are the QA agents and the role name is ignored (a role is editable by everyone who holds `agent.manage`; this list is the owner's alone).
 * `startsPerHour`: how many starts plus cancels one agent (never the owner) may make in an hour; 0 is no limit.
 */
export interface IssuerPolicy { readonly qaAgents: boolean; readonly bosses: boolean; readonly qaRole: string; readonly startsPerHour: number; readonly qaAgentIds?: readonly string[] }
/** What a host fetches: its open jobs and the attempts it already picked up that were ended without a result (cancelled, timed out, authorization withdrawn) and must stop. */
export interface HostJobs { readonly jobs: HostJob[]; readonly cancel: string[] }
/** A job as a host sees it: the payload and whether it has been acknowledged. */
export interface HostJob { readonly attemptId: string; readonly payload: JobPayload; readonly pickedUpAt?: string }

/** `attemptsPerCell`: attempts one agent may make per platform of a candidate. `cellEntries`: all attempts of a platform (the owner's included); agents stop at `agentEntries`, which leaves the owner room. */
export const RELEASE_LIMITS = { jobs: 32, attemptsPerCell: 20, cellEntries: 500, agentEntries: 200, openPerHost: 200, cancelKeep: 32, cancelMs: 24 * 3600_000, graceSeconds: 600, defaultStartsPerHour: 12, startsPerHourMax: 100_000, qaAgentIds: 100, defaultTimeoutSeconds: 3600, defaultMemoryMb: 4096, cells: 20, artifacts: 100, locks: 100, summary: 500, timeoutSeconds: 24 * 3600, memoryMb: 1_000_000 } as const;
const OS = ["linux", "darwin", "win32"] as const;
const ARCH = ["x64", "arm64"] as const;
const SHA = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._@/+-]{0,127}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const CANDIDATE = "release-candidate";
const ATTEMPT = "release-attempt";
const HOST = "release-host";
const APPROVAL = "release-approval";
const CELLIDX = "release-cell";
const HOSTIDX = "release-hostjobs";
const ISSUERIDX = "release-issuer";
const SETTINGS: AggregateRef = { kind: "release-settings", id: "main" };
const ROLE = /^[a-z][a-z0-9-]{0,39}$/;

/** The issuer settings with the profile's default under any field not set. Pure. */
export function resolveIssuers(profile: string, body: Pick<IssuerSettingsBody, "qaAgents" | "bosses" | "qaRole" | "qaAgentIds" | "startsPerHour"> | undefined): IssuerPolicy {
  const open = profile === "derived" || profile === "autonomous";
  return { qaAgents: body?.qaAgents ?? open, bosses: body?.bosses ?? open, qaRole: body?.qaRole ?? "qa", startsPerHour: body?.startsPerHour ?? RELEASE_LIMITS.defaultStartsPerHour, ...(body?.qaAgentIds !== undefined && body.qaAgentIds.length > 0 ? { qaAgentIds: body.qaAgentIds } : {}) };
}
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const bad = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const cellKey = (c: Cell): string => `${c.os}/${c.arch}`;
const cellIdxId = (candidateId: string, c: Cell): string => `rcl-${sha(`${candidateId}|${cellKey(c)}`).slice(0, 24)}`;
const hostIdxId = (hostId: string): string => `rhj-${sha(hostId).slice(0, 24)}`;
const issuerIdxId = (by: string): string => `ris-${sha(by).slice(0, 24)}`;
const hashMap = (value: unknown, field: string, max: number): Record<string, string> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return bad(field, "must be an object of name to sha256");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > max) return bad(field, `needs 1 to ${max} entries`);
  const out: Record<string, string> = {};
  for (const [k, v] of entries.sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!NAME.test(k)) bad(field, `${k.slice(0, 40)} is not a valid name`);
    if (typeof v !== "string" || !SHA.test(v)) bad(field, `${k} needs a lower-case sha256`);
    out[k] = v as string;
  }
  return out;
};
const checkCell = (value: unknown, field: string): Cell => {
  const c = value as Partial<Cell> | null;
  if (c === null || typeof c !== "object") return bad(field, "must be an object with os and arch");
  onlyKnown(c as Record<string, unknown>, ["os", "arch", "osVersion"]);
  if (!OS.includes(c.os as never)) bad(`${field}.os`, `must be one of ${OS.join(", ")}`);
  if (!ARCH.includes(c.arch as never)) bad(`${field}.arch`, `must be one of ${ARCH.join(", ")}`);
  if (c.osVersion !== undefined && (typeof c.osVersion !== "string" || !/^[A-Za-z0-9._-]{1,40}$/.test(c.osVersion))) bad(`${field}.osVersion`, "is not a version");
  return { os: c.os!, arch: c.arch!, ...(c.osVersion === undefined ? {} : { osVersion: c.osVersion }) };
};

/** Checks and orders a manifest; the digest of the result is the candidate's identity. */
export function checkManifest(value: unknown): Manifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return bad("manifest", "must be an object");
  const m = value as Record<string, unknown>;
  onlyKnown(m, ["sourceCommit", "suiteRevision", "artifacts", "dependencyLocks", "matrix"]);
  if (typeof m["sourceCommit"] !== "string" || !COMMIT.test(m["sourceCommit"])) bad("sourceCommit", "must be a full 40-character commit hash");
  if (typeof m["suiteRevision"] !== "string" || !REVISION.test(m["suiteRevision"])) bad("suiteRevision", "must name the test suite revision");
  const rows = m["matrix"];
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > RELEASE_LIMITS.cells) return bad("matrix", `needs 1 to ${RELEASE_LIMITS.cells} platforms`);
  const cells = rows.map((r, i) => checkCell(r, `matrix[${i}]`));
  if (new Set(cells.map(cellKey)).size !== cells.length) bad("matrix", "lists a platform twice");
  return {
    sourceCommit: m["sourceCommit"] as string, suiteRevision: m["suiteRevision"] as string,
    artifacts: hashMap(m["artifacts"], "artifacts", RELEASE_LIMITS.artifacts), dependencyLocks: hashMap(m["dependencyLocks"], "dependencyLocks", RELEASE_LIMITS.locks),
    matrix: cells.sort((a, b) => (cellKey(a) < cellKey(b) ? -1 : 1)),
  };
}

export const candidateIdOf = (manifest: Manifest): string => `rcn-${sha(canonicalJson(manifest as unknown as JsonObject)).slice(0, 24)}`;
const attemptIdOf = (candidateId: string, cell: Cell, n: number): string => `rat-${sha(`${candidateId}|${cellKey(cell)}|${n}`).slice(0, 24)}`;

/** The payload a worker is handed for one attempt (pure: no clock, no randomness). */
export function jobPayload(candidateId: string, manifest: Manifest, cell: Cell, attemptId: string, limits: JobPayload["limits"]): JobPayload {
  return { capability: "release-test", candidateId, attemptId, sourceCommit: manifest.sourceCommit, suiteRevision: manifest.suiteRevision, artifacts: manifest.artifacts, dependencyLocks: manifest.dependencyLocks, cell, limits };
}

/**
 * External release testing (card X09). The owner submits an immutable candidate (source commit, built artifact hashes, dependency locks, test-suite revision, platform matrix); each platform is tested by an
 * attempt issued to a host the owner has authorized for destructive release tests on that platform, and run by a restricted worker that holds only `release.report`. Nothing here uses a model.
 *
 * - **A worker returns evidence, not a verdict on the release.** A result is taken only from the worker the attempt was issued to, only for the attempt still open, and only if the source commit, suite revision,
 *   artifact hashes and platform it reports are exactly the candidate's; anything else is refused and counts for nothing. A pass with failing tests is refused.
 * - **A lost worker is never a pass.** An attempt that ends without a result is marked interrupted. A retry is a new attempt with a new ID; earlier attempts and their evidence stay.
 * - **Only the owner approves, and only when every platform's latest attempt passed.** A platform with no attempt blocks the gate.
 */
export class ReleaseService {
  readonly #runner: CommandRunner;
  private constructor(runner: CommandRunner) { this.#runner = runner; }
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): ReleaseService { return new ReleaseService(new CommandRunner(storage, epoch, options)); }

  async submit(owner: Principal, command: NoActor & { manifest: unknown }): Promise<{ candidateId: string; replayed: boolean }> {
    this.#owner(owner, "submit a release candidate");
    onlyKnown(command, ["commandId", "manifest"]);
    const manifest = checkManifest(command.manifest);
    const candidateId = candidateIdOf(manifest);
    const ref: AggregateRef = { kind: CANDIDATE, id: candidateId };
    const done = await this.#runner.command("release.submit", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { candidateId },
      build: async (): Promise<Built> => {
        const existing = await this.#runner.get(CANDIDATE, candidateId);
        // The same manifest again is the same candidate.
        if (existing !== undefined) return { ref, creates: false, changes: [{ type: "check", ref, expectedRevision: existing.revision }], detail: { candidateId, existing: true } };
        const body: CandidateBody = { manifest, submittedBy: owner.id, submittedAt: this.#runner.now() };
        return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { candidateId, platforms: manifest.matrix.length } };
      },
    }));
    return { candidateId, replayed: done.replayed };
  }

  /** The owner allows a host to run destructive release tests for one platform. A machine used for production work is not authorized by that. Withdrawing the authorization (or moving it to another platform) ends what is open on the host at once. */
  async authorizeHost(owner: Principal, command: NoActor & { hostId: string; os: Cell["os"]; arch: Cell["arch"]; active?: boolean }): Promise<void> {
    this.#owner(owner, "authorize a host for release tests");
    onlyKnown(command, ["commandId", "hostId", "os", "arch", "active"]);
    const hostId = text(command.hostId, "hostId", { min: 1, max: 80 });
    const cell = checkCell({ os: command.os, arch: command.arch }, "platform");
    const active = command.active !== false;
    const ref: AggregateRef = { kind: HOST, id: `rhs-${sha(hostId).slice(0, 24)}` };
    await this.#runner.command("release.host", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { hostId, platform: cellKey(cell), active },
      build: async (): Promise<Built> => {
        const existing = await this.#runner.get(HOST, ref.id);
        const body: HostAuthBody = { hostId, os: cell.os, arch: cell.arch, active, by: owner.id, at: this.#runner.now() };
        const changes: Change[] = [existing === undefined ? { type: "create", ref, body: body as unknown as JsonObject } : { type: "update", ref, expectedRevision: existing.revision, body: body as unknown as JsonObject }];
        // What the host was running under the authorization that ends is ended with it, so the destructive test stops (a host picked-up job is told to stop in its next fetch).
        const idx = (await this.#runner.get(HOSTIDX, hostIdxId(hostId)))?.body as unknown as HostIndexBody | undefined;
        const ending: { found: Aggregate; attempt: AttemptBody }[] = [];
        for (const id of idx?.open ?? []) {
          const found = await this.#runner.get(ATTEMPT, id);
          const attempt = found?.body as unknown as AttemptBody | undefined;
          if (found !== undefined && attempt !== undefined && attempt.state === "issued" && (!active || attempt.cell.os !== cell.os || attempt.cell.arch !== cell.arch)) ending.push({ found, attempt });
        }
        if (ending.length > 0) changes.push(...(await this.#endChanges(hostId, ending, "interrupted", owner.id, "the host's authorization was withdrawn")));
        return { ref, creates: existing === undefined, changes, detail: { hostId, active, ended: ending.length } };
      },
    }));
  }

  /** Issues the next attempt for one platform to an authorized host and the worker that will report. Returns the job payload. */
  async issue(owner: Principal, command: NoActor & { candidateId: string; cell: Cell; hostId: string; workerId: string; timeoutSeconds: number; memoryMb: number }): Promise<{ attemptId: string; payload: JobPayload }> {
    this.#owner(owner, "issue a release test");
    return this.#issue("release.issue", owner, command);
  }

  async #issue(op: string, by: Principal, command: NoActor & { candidateId: string; cell: Cell; hostId: string; workerId: string; timeoutSeconds: number; memoryMb: number }, authorize?: () => Promise<IssuerPolicy | undefined>): Promise<{ attemptId: string; payload: JobPayload }> {
    onlyKnown(command, ["commandId", "candidateId", "cell", "hostId", "workerId", "timeoutSeconds", "memoryMb"]);
    const cell = checkCell(command.cell, "cell");
    const hostId = text(command.hostId, "hostId", { min: 1, max: 80 });
    const workerId = text(command.workerId, "workerId", { min: 1, max: 80 });
    if (!Number.isInteger(command.timeoutSeconds) || command.timeoutSeconds < 1 || command.timeoutSeconds > RELEASE_LIMITS.timeoutSeconds) bad("timeoutSeconds", `must be a whole number of seconds up to ${RELEASE_LIMITS.timeoutSeconds}`);
    if (!Number.isInteger(command.memoryMb) || command.memoryMb < 1 || command.memoryMb > RELEASE_LIMITS.memoryMb) bad("memoryMb", "must be a whole number of megabytes");
    const limits = { timeoutSeconds: command.timeoutSeconds, memoryMb: command.memoryMb };
    let issued: { attemptId: string; payload: JobPayload } | undefined;
    const done = await this.#runner.command(op, { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { candidateId: command.candidateId, cell: cellKey(cell), hostId, workerId, timeoutSeconds: limits.timeoutSeconds, memoryMb: limits.memoryMb },
      build: async (): Promise<Built> => {
        // The right to start is checked here, in the same transaction as the attempt it creates, so a setting narrowed a moment ago is never raced.
        const policy = authorize === undefined ? undefined : await authorize();
        const candidate = await this.#runner.get(CANDIDATE, String(command.candidateId));
        if (candidate === undefined) throw new DomainError("not_found", "no such release candidate");
        const manifest = (candidate.body as unknown as CandidateBody).manifest;
        if (!manifest.matrix.some((c) => cellKey(c) === cellKey(cell))) throw new DomainError("invalid_command", `${cellKey(cell)} is not in this candidate's matrix`, { field: "cell" });
        // A version the candidate names is the version tested: an issue that names another is refused, and one that names none takes the candidate's.
        const named = manifest.matrix.find((c) => cellKey(c) === cellKey(cell))!;
        if (named.osVersion !== undefined && cell.osVersion !== undefined && cell.osVersion !== named.osVersion) throw new DomainError("invalid_command", `this platform is ${named.osVersion} in the candidate's matrix, not ${cell.osVersion}`, { field: "cell" });
        const tested: Cell = named.osVersion !== undefined ? { ...cell, osVersion: named.osVersion } : cell;
        const host = (await this.#runner.get(HOST, `rhs-${sha(hostId).slice(0, 24)}`))?.body as unknown as HostAuthBody | undefined;
        if (host === undefined || !host.active) throw new DomainError("forbidden", `${hostId} is not authorized for release tests`);
        if (host.os !== cell.os || host.arch !== cell.arch) throw new DomainError("forbidden", `${hostId} is authorized for ${host.os}/${host.arch}, not ${cellKey(cell)}`);
        // The attempts of this platform come from its own index: nothing scans all attempts, so a large installation is never "unavailable".
        const cellIdx = await this.#runner.get(CELLIDX, cellIdxId(command.candidateId, cell));
        const entries = (cellIdx?.body as unknown as CellIndexBody | undefined)?.attempts ?? [];
        const lastEntry = entries.at(-1);
        const latest = lastEntry === undefined ? undefined : (await this.#runner.get(ATTEMPT, lastEntry.id))?.body as unknown as AttemptBody | undefined;
        if (latest?.state === "issued") throw new DomainError("invalid_command", "an attempt for this platform is still open; interrupt it first", { field: "cell" });
        if (latest?.state === "passed") throw new DomainError("invalid_command", "this platform already passed", { field: "cell" });
        // The cap is per issuer: one agent's start/cancel loop uses up its own attempts and never the owner's or another issuer's.
        if (by.kind === "owner") {
          if (entries.length >= RELEASE_LIMITS.cellEntries) throw new DomainError("invalid_command", `this platform has had ${RELEASE_LIMITS.cellEntries} attempts; submit a new candidate`, { field: "cell" });
        } else {
          const mine = entries.filter((e) => e.by === by.id).length;
          if (mine >= RELEASE_LIMITS.attemptsPerCell) throw new DomainError("invalid_command", `${by.id} has had ${RELEASE_LIMITS.attemptsPerCell} attempts on this platform; ask the owner to start the next one`, { field: "cell" });
          if (entries.length >= RELEASE_LIMITS.agentEntries) throw new DomainError("invalid_command", "this platform has had many attempts already; ask the owner to start the next one", { field: "cell" });
        }
        const hostIdx = await this.#runner.get(HOSTIDX, hostIdxId(hostId));
        const hostBody: HostIndexBody = (hostIdx?.body as unknown as HostIndexBody | undefined) ?? { hostId, open: [], cancel: [] };
        if (hostBody.open.length >= RELEASE_LIMITS.openPerHost) throw new DomainError("invalid_command", `${hostId} already has ${RELEASE_LIMITS.openPerHost} open release tests`, { field: "hostId" });
        const rate = policy === undefined ? undefined : await this.#rate(by, policy);
        const n = (latest?.n ?? lastEntry?.n ?? 0) + 1;
        const attemptId = attemptIdOf(command.candidateId, cell, n);
        const payload = jobPayload(command.candidateId, manifest, tested, attemptId, limits);
        const ref: AggregateRef = { kind: ATTEMPT, id: attemptId };
        const body: AttemptBody = { candidateId: command.candidateId, cell: tested, n, hostId, workerId, payloadDigest: sha(canonicalJson(payload as unknown as JsonObject)), limits, state: "issued", issuedAt: this.#runner.now(), issuedBy: by.id };
        issued = { attemptId, payload };
        const cellBody: CellIndexBody = { candidateId: command.candidateId, cell: cellKey(cell), attempts: [...entries, { id: attemptId, n, by: by.id }] };
        const changes: Change[] = [
          { type: "create", ref, body: body as unknown as JsonObject },
          this.#put(CELLIDX, cellIdxId(command.candidateId, cell), cellIdx, cellBody),
          this.#put(HOSTIDX, hostIdxId(hostId), hostIdx, { ...hostBody, open: [...hostBody.open, attemptId] }),
          ...(rate === undefined ? [] : [rate]),
        ];
        return { ref, creates: true, changes, detail: { candidateId: command.candidateId, platform: cellKey(cell), attempt: n } };
      },
    }));
    if (issued === undefined) {
      // A repeat of the same command: the attempt it created, with the limits it was issued under.
      const found = await this.#runner.get(ATTEMPT, done.id);
      const candidate = (await this.#runner.get(CANDIDATE, command.candidateId))?.body as unknown as CandidateBody | undefined;
      const attempt = found?.body as unknown as AttemptBody | undefined;
      if (attempt === undefined || candidate === undefined) throw new DomainError("not_found", "that attempt is not recorded");
      issued = { attemptId: done.id, payload: jobPayload(command.candidateId, candidate.manifest, attempt.cell, done.id, attempt.limits) };
    }
    return issued;
  }

  /** The change that writes an index record: created when it did not exist, else updated against the revision read. */
  #put(kind: string, id: string, found: Aggregate | undefined, body: object): Change {
    const ref: AggregateRef = { kind, id };
    return found === undefined ? { type: "create", ref, body: body as JsonObject } : { type: "update", ref, expectedRevision: found.revision, body: body as JsonObject };
  }

  /** The rate limit on starts and cancels of one non-owner issuer: refused when it already made `startsPerHour` in the last hour (0 is no limit). The owner is never limited, and never by an agent's use. */
  async #rate(by: Principal, policy: IssuerPolicy): Promise<Change | undefined> {
    if (policy.startsPerHour <= 0) return undefined;
    const found = await this.#runner.get(ISSUERIDX, issuerIdxId(by.id));
    const now = Date.parse(this.#runner.now());
    const recent = ((found?.body as unknown as IssuerIndexBody | undefined)?.events ?? []).filter((t) => now - t < 3600_000);
    if (recent.length >= policy.startsPerHour) throw new DomainError("forbidden", `${by.id} has made ${policy.startsPerHour} release starts and cancels in the last hour; try again later (the owner can change startsPerHour in release.settings.set)`);
    return this.#put(ISSUERIDX, issuerIdxId(by.id), found, { by: by.id, events: [...recent, now].slice(-policy.startsPerHour) });
  }

  /** The changes that end open attempts of one host without a result: each attempt, and the host's index (no longer open; those it had picked up are listed for it to stop). */
  async #endChanges(hostId: string, ended: readonly { found: Aggregate; attempt: AttemptBody }[], state: "interrupted" | "timed_out", endedBy: string | undefined, reason: string): Promise<Change[]> {
    const now = this.#runner.now();
    const idx = await this.#runner.get(HOSTIDX, hostIdxId(hostId));
    const before: HostIndexBody = (idx?.body as unknown as HostIndexBody | undefined) ?? { hostId, open: [], cancel: [] };
    const ids = new Set(ended.map((e) => e.found.id));
    const stop = ended.filter((e) => e.attempt.pickedUpAt !== undefined).map((e) => ({ id: e.found.id, at: now }));
    const next: HostIndexBody = { hostId, open: before.open.filter((i) => !ids.has(i)), cancel: [...before.cancel.filter((c) => !ids.has(c.id)), ...stop].slice(-RELEASE_LIMITS.cancelKeep) };
    const changes: Change[] = ended.map((e) => ({ type: "update", ref: { kind: ATTEMPT, id: e.found.id }, expectedRevision: e.found.revision, body: { ...e.attempt, state, endedAt: now, ...(endedBy === undefined ? {} : { endedBy }), reason } as unknown as JsonObject }));
    changes.push(this.#put(HOSTIDX, hostIdxId(hostId), idx, next));
    return changes;
  }

  /**
   * The worker's result. Refused (and recorded as nothing) if it is not from the worker the attempt was issued to, the attempt is no longer open, or what it reports differs in any way from the candidate.
   * The worker says what happened on its platform; whether the release goes ahead is not its to say.
   */
  async report(by: Principal, command: NoActor & { attemptId: string; sourceCommit: string; suiteRevision: string; artifactHashes: unknown; dependencyLockHashes: unknown; environment: unknown; outcome: "pass" | "fail"; counts: { passed: number; failed: number; skipped: number }; logDigest: string; summary: string }): Promise<void> {
    if (by.kind === "owner" || !allows(by, "release.report", undefined)) throw new DomainError("forbidden", `${by.id} may not report release test results`);
    return this.#report("release.report", by, command, async () => undefined);
  }

  /**
   * The result path of a host that was handed the job (card X09b): the host principal reports for an attempt issued to it as both host and worker, after it picked the job up, and only while the owner still authorizes
   * it for that platform. Everything the worker path checks is checked the same way.
   */
  async reportFromHost(host: Principal, command: Parameters<ReleaseService["report"]>[1]): Promise<void> {
    this.#hostOnly(host);
    return this.#report("release.report-host", host, command, async (attempt) => {
      if (attempt.hostId !== host.id) throw new DomainError("not_found", "no such attempt for you to report");
      if (attempt.pickedUpAt === undefined) throw new DomainError("invalid_command", "pick the job up before reporting its result", { field: "attemptId" });
      await this.#hostStillAuthorized(host.id, attempt.cell);
    });
  }

  async #report(op: string, by: Principal, command: Parameters<ReleaseService["report"]>[1], extra: (attempt: AttemptBody) => Promise<void>): Promise<void> {
    onlyKnown(command, ["commandId", "attemptId", "sourceCommit", "suiteRevision", "artifactHashes", "dependencyLockHashes", "environment", "outcome", "counts", "logDigest", "summary"]);
    if (command.outcome !== "pass" && command.outcome !== "fail") bad("outcome", "must be pass or fail");
    if (typeof command.logDigest !== "string" || !SHA.test(command.logDigest)) bad("logDigest", "needs a lower-case sha256 of the log");
    const k = command.counts as Partial<Record<"passed" | "failed" | "skipped", unknown>> | undefined;
    for (const f of ["passed", "failed", "skipped"] as const) if (!Number.isInteger(k?.[f]) || (k![f] as number) < 0) bad(`counts.${f}`, "must be a whole number");
    if (command.outcome === "pass" && (command.counts.failed > 0 || command.counts.passed === 0)) bad("outcome", "a pass needs passing tests and none failing");
    const environment = checkCell(command.environment, "environment");
    const summary = redactText(text(command.summary, "summary", { min: 1, max: RELEASE_LIMITS.summary }));
    const artifactHashes = hashMap(command.artifactHashes, "artifactHashes", RELEASE_LIMITS.artifacts);
    const lockHashes = hashMap(command.dependencyLockHashes, "dependencyLockHashes", RELEASE_LIMITS.locks);
    const ref: AggregateRef = { kind: ATTEMPT, id: String(command.attemptId) };
    await this.#runner.command(op, { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { attemptId: command.attemptId, outcome: command.outcome },
      build: async (): Promise<Built> => {
        const found = await this.#runner.get(ATTEMPT, ref.id);
        // Another worker's attempt reads like a missing one.
        const attempt = found?.body as unknown as AttemptBody | undefined;
        if (found === undefined || attempt === undefined || attempt.workerId !== by.id) throw new DomainError("not_found", "no such attempt for you to report");
        await extra(attempt);
        if (attempt.state !== "issued") throw new DomainError("invalid_command", `that attempt is already ${attempt.state}`, { field: "attemptId" });
        const manifest = ((await this.#runner.get(CANDIDATE, attempt.candidateId))!.body as unknown as CandidateBody).manifest;
        if (command.sourceCommit !== manifest.sourceCommit) throw new DomainError("invalid_command", "the source commit is not the candidate's", { field: "sourceCommit" });
        if (command.suiteRevision !== manifest.suiteRevision) throw new DomainError("invalid_command", "the test-suite revision is not the candidate's", { field: "suiteRevision" });
        if (canonicalJson(artifactHashes as unknown as JsonObject) !== canonicalJson(manifest.artifacts as unknown as JsonObject)) throw new DomainError("invalid_command", "the artifact hashes are not the candidate's", { field: "artifactHashes" });
        if (attempt.cell.osVersion !== undefined && environment.osVersion !== attempt.cell.osVersion) throw new DomainError("invalid_command", `the result is from OS version ${environment.osVersion ?? "unstated"}, not ${attempt.cell.osVersion}`, { field: "environment" });
        if (canonicalJson(lockHashes as unknown as JsonObject) !== canonicalJson(manifest.dependencyLocks as unknown as JsonObject)) throw new DomainError("invalid_command", "the dependency locks are not the candidate's", { field: "dependencyLockHashes" });
        if (environment.os !== attempt.cell.os || environment.arch !== attempt.cell.arch) throw new DomainError("invalid_command", `the result is from ${cellKey(environment)}, not ${cellKey(attempt.cell)}`, { field: "environment" });
        const result: ResultBody = { outcome: command.outcome, counts: { passed: command.counts.passed, failed: command.counts.failed, skipped: command.counts.skipped }, environment, logDigest: command.logDigest, summary };
        const next: AttemptBody = { ...attempt, state: command.outcome === "pass" ? "passed" : "failed", endedAt: this.#runner.now(), result };
        const hostIdx = await this.#runner.get(HOSTIDX, hostIdxId(attempt.hostId));
        const hostBody = hostIdx?.body as unknown as HostIndexBody | undefined;
        const closeJob: Change[] = hostIdx === undefined || hostBody === undefined ? [] : [this.#put(HOSTIDX, hostIdx.id, hostIdx, { ...hostBody, open: hostBody.open.filter((i) => i !== ref.id) })];
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }, ...closeJob], detail: { attemptId: ref.id, state: next.state }, contention: async () => new DomainError("stale_revision", "the attempt changed at the same moment; report again") };
      },
    }));
  }

  /** Ends an open attempt without a result (the worker was lost, timed out or was stopped). It is never a pass. */
  async interrupt(owner: Principal, command: NoActor & { attemptId: string; reason: string }): Promise<void> {
    this.#owner(owner, "interrupt a release test");
    return this.#interrupt("release.interrupt", owner, command);
  }

  async #interrupt(op: string, by: Principal, command: NoActor & { attemptId: string; reason: string }, authorize?: () => Promise<IssuerPolicy | undefined>): Promise<void> {
    onlyKnown(command, ["commandId", "attemptId", "reason"]);
    const reason = redactText(text(command.reason, "reason", { min: 1, max: RELEASE_LIMITS.summary }));
    const ref: AggregateRef = { kind: ATTEMPT, id: String(command.attemptId) };
    await this.#runner.command(op, { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { attemptId: command.attemptId, reason },
      build: async (): Promise<Built> => {
        const policy = authorize === undefined ? undefined : await authorize();
        const found = await this.#runner.get(ATTEMPT, ref.id);
        const attempt = found?.body as unknown as AttemptBody | undefined;
        if (found === undefined || attempt === undefined) throw new DomainError("not_found", "no such attempt");
        if (by.kind !== "owner") await this.#mayCancel(by, attempt);
        if (attempt.state !== "issued") throw new DomainError("invalid_command", `that attempt is already ${attempt.state}`, { field: "attemptId" });
        const rate = policy === undefined ? undefined : await this.#rate(by, policy);
        const changes = [...(await this.#endChanges(attempt.hostId, [{ found, attempt }], "interrupted", by.id, reason)), ...(rate === undefined ? [] : [rate])];
        return { ref, creates: false, changes, detail: { attemptId: ref.id }, contention: async () => new DomainError("stale_revision", "the attempt changed at the same moment; ask again") };
      },
    }));
  }

  /** An agent cancels only a test it started, or one started by an agent that reports directly to it. The owner's tests (and any other agent's) are the owner's to cancel. */
  async #mayCancel(by: Principal, attempt: AttemptBody): Promise<void> {
    if (attempt.issuedBy === by.id) return;
    if (attempt.issuedBy?.startsWith("agent:") === true && by.id.startsWith("agent:")) {
      const issuer = (await this.#runner.get("agent", attempt.issuedBy.slice("agent:".length)))?.body as unknown as { supervisorId?: string } | undefined;
      if (issuer?.supervisorId === by.id.slice("agent:".length)) return;
    }
    throw new DomainError("forbidden", `${by.id} may cancel only release tests that it or an agent reporting directly to it started`);
  }

  // ---- starting and cancelling a campaign by whoever the owner allows (card X09b) --------------------------------------------------

  /**
   * Starts the release test of one platform on a host: the owner, or (as the owner's setting allows) a QA agent or the boss of one. Same checks as `issue` (the host must be authorized by the owner for the platform,
   * no attempt open, the platform not already passed). The host reports as the worker unless another worker is named; the timeout and memory are optional and default to provisional figures. The attempt records who started it.
   * The right is checked inside the transaction that creates the attempt. An agent's attempts are counted per issuer and per platform, and its starts and cancels are rate limited; the owner is neither.
   */
  async start(by: Principal, command: NoActor & { candidateId: string; cell: Cell; hostId: string; workerId?: string; timeoutSeconds?: number; memoryMb?: number }): Promise<{ attemptId: string; payload: JobPayload }> {
    onlyKnown(command, ["commandId", "candidateId", "cell", "hostId", "workerId", "timeoutSeconds", "memoryMb"]);
    const hostId = text(command.hostId, "hostId", { min: 1, max: 80 });
    // An agent who starts a test cannot name who reports it: the host that runs it does. Otherwise a QA agent could name itself and certify its own pass.
    if (by.kind !== "owner" && command.workerId !== undefined && command.workerId !== hostId) throw new DomainError("forbidden", `${by.id} may not name the worker; the host reports its own test`);
    return this.#issue("release.start", by, { ...command, hostId, workerId: command.workerId ?? hostId, timeoutSeconds: command.timeoutSeconds ?? RELEASE_LIMITS.defaultTimeoutSeconds, memoryMb: command.memoryMb ?? RELEASE_LIMITS.defaultMemoryMb }, () => this.#driver(by, "start a release test"));
  }

  /** Ends an open attempt without a result, for whoever may start one (an agent only its own or its direct reports' tests). Never a pass. */
  async cancel(by: Principal, command: NoActor & { attemptId: string; reason: string }): Promise<void> {
    return this.#interrupt("release.cancel", by, command, () => this.#driver(by, "cancel a release test"));
  }

  /** Who may start and cancel release tests besides the owner, as set and as it counts now. Owner only. */
  async settings(owner: Principal): Promise<{ revision: number; set: { qaAgents?: boolean; bosses?: boolean; qaRole?: string; qaAgentIds?: readonly string[]; startsPerHour?: number }; effective: IssuerPolicy; profile: string }> {
    this.#owner(owner, "read who may start release tests");
    const found = await this.#runner.get(SETTINGS.kind, SETTINGS.id);
    const body = found?.body as unknown as IssuerSettingsBody | undefined;
    const profile = await this.#profile();
    const { updatedBy: _by, updatedAt: _at, ...set } = body ?? ({} as IssuerSettingsBody);
    return { revision: found?.revision ?? 0, set, effective: resolveIssuers(profile, body), profile };
  }

  /**
   * The owner sets who besides them may start and cancel release tests: `qaAgents` (agents holding the QA role), `bosses` (their supervisors), the role's name, `qaAgentIds` and `startsPerHour`. `null` returns a field to the profile's default.
   * The role name is a string anyone holding `agent.manage` can give to any agent, so those switches reach every agent that holds it; `qaAgentIds` (agent IDs the owner names) replaces the role check when it is set and is the owner's alone.
   * `startsPerHour` limits one agent's starts plus cancels per hour (default 12, 0 is no limit); the owner is never limited.
   */
  async setSettings(owner: Principal, command: NoActor & { qaAgents?: boolean | null; bosses?: boolean | null; qaRole?: string | null; qaAgentIds?: readonly string[] | null; startsPerHour?: number | null; expectedRevision?: number }): Promise<{ revision: number }> {
    this.#owner(owner, "change who may start release tests");
    onlyKnown(command, ["commandId", "qaAgents", "bosses", "qaRole", "qaAgentIds", "startsPerHour", "expectedRevision"]);
    const flag = (v: unknown, f: string): boolean | null | undefined => { if (v === undefined || v === null || typeof v === "boolean") return v as never; return bad(f, "must be true, false or null"); };
    const qaAgents = flag(command.qaAgents, "qaAgents"), bosses = flag(command.bosses, "bosses");
    const qaRole = command.qaRole === undefined || command.qaRole === null ? command.qaRole : typeof command.qaRole === "string" && ROLE.test(command.qaRole) ? command.qaRole : bad("qaRole", "must be a role name: lower-case letters, digits and hyphens, starting with a letter");
    const startsPerHour = command.startsPerHour === undefined || command.startsPerHour === null ? command.startsPerHour : Number.isInteger(command.startsPerHour) && command.startsPerHour >= 0 && command.startsPerHour <= RELEASE_LIMITS.startsPerHourMax ? command.startsPerHour : bad("startsPerHour", `must be a whole number from 0 (no limit) to ${RELEASE_LIMITS.startsPerHourMax}`);
    let qaAgentIds: string[] | null | undefined = command.qaAgentIds === null ? null : undefined;
    if (command.qaAgentIds !== undefined && command.qaAgentIds !== null) {
      if (!Array.isArray(command.qaAgentIds) || command.qaAgentIds.length > RELEASE_LIMITS.qaAgentIds) bad("qaAgentIds", `must be a list of at most ${RELEASE_LIMITS.qaAgentIds} agent IDs`);
      const ids = [...new Set(command.qaAgentIds.map((v, i) => text(v, `qaAgentIds[${i}]`, { min: 1, max: 80 }).replace(/^agent:/, "")))].sort();
      for (const id of ids) if ((await this.#runner.get("agent", id)) === undefined) bad("qaAgentIds", `${id.slice(0, 40)} is not an agent`);
      qaAgentIds = ids;
    }
    if (qaAgents === undefined && bosses === undefined && qaRole === undefined && qaAgentIds === undefined && startsPerHour === undefined) bad("qaAgents", "name at least one of qaAgents, bosses, qaRole, qaAgentIds or startsPerHour");
    return this.#writeSettings("release.settings.set", owner, command.commandId, { qaAgents, bosses, qaRole, qaAgentIds, startsPerHour }, command.expectedRevision);
  }

  /** Turns who may start release tests on or off, one group at a time (what the chat words "enable" and "disable" mean). `who` is `qa-agents`, `bosses` or `all`. */
  async changeIssuers(owner: Principal, command: NoActor & { who: string; enabled: boolean; expectedRevision?: number }): Promise<{ revision: number }> {
    this.#owner(owner, "change who may start release tests");
    onlyKnown(command, ["commandId", "who", "enabled", "expectedRevision"]);
    if (!["qa-agents", "bosses", "all"].includes(command.who)) bad("who", "must be qa-agents, bosses or all");
    if (typeof command.enabled !== "boolean") bad("enabled", "must be true or false");
    return this.#writeSettings(command.enabled ? "release.issuers.enable" : "release.issuers.disable", owner, command.commandId, { ...(command.who !== "bosses" ? { qaAgents: command.enabled } : {}), ...(command.who !== "qa-agents" ? { bosses: command.enabled } : {}) }, command.expectedRevision);
  }

  async #writeSettings(op: string, owner: Principal, commandId: string, change: { qaAgents?: boolean | null | undefined; bosses?: boolean | null | undefined; qaRole?: string | null | undefined; qaAgentIds?: string[] | null | undefined; startsPerHour?: number | null | undefined }, expectedRevision: number | undefined): Promise<{ revision: number }> {
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) bad("expectedRevision", "must be a whole number");
    const result = await this.#runner.command(op, { commandId: scopedCommandId(owner.id, commandId), actor: owner.id }, async () => ({
      payload: { qaAgents: change.qaAgents ?? "keep", bosses: change.bosses ?? "keep", qaRole: change.qaRole ?? "keep", qaAgentIds: change.qaAgentIds ?? "keep", startsPerHour: change.startsPerHour ?? "keep", clear: [change.qaAgents, change.bosses, change.qaRole, change.qaAgentIds, change.startsPerHour].map((v) => v === null), expectedRevision: expectedRevision ?? null },
      build: async (): Promise<Built> => {
        const current = await this.#runner.get(SETTINGS.kind, SETTINGS.id);
        // A change made at the same moment by another owner session is never lost: a stated revision must match, and the write itself is checked against the revision read here.
        if (expectedRevision !== undefined && (current?.revision ?? 0) !== expectedRevision) throw new DomainError("stale_revision", `the setting is at revision ${current?.revision ?? 0}, not ${expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const before = (current?.body as unknown as IssuerSettingsBody | undefined) ?? ({} as Partial<IssuerSettingsBody>);
        const pick = <K extends "qaAgents" | "bosses" | "qaRole" | "qaAgentIds" | "startsPerHour">(key: K): Partial<Pick<IssuerSettingsBody, K>> => { const v = change[key]; return v === null ? {} : v !== undefined ? { [key]: v } as never : before[key] === undefined ? {} : { [key]: before[key] } as never; };
        const next: IssuerSettingsBody = { ...pick("qaAgents"), ...pick("bosses"), ...pick("qaRole"), ...pick("qaAgentIds"), ...pick("startsPerHour"), updatedBy: owner.id, updatedAt: this.#runner.now() };
        const body = next as unknown as JsonObject;
        return { ref: SETTINGS, creates: current === undefined, changes: [current === undefined ? { type: "create", ref: SETTINGS, body } : { type: "update", ref: SETTINGS, expectedRevision: current.revision, body }], detail: { qaAgents: next.qaAgents ?? null, bosses: next.bosses ?? null }, contention: async () => new DomainError("stale_revision", "the setting changed at the same moment; ask again") };
      },
    }));
    return { revision: result.revision };
  }

  /**
   * Whether the issuer settings, as they count now, let this principal start or cancel a release test; returns the policy it was judged by (nothing for the owner). Called inside the transaction that acts.
   * The read fails closed: a setting that cannot be read leaves only the owner. Which agents are QA agents is the owner's list when set, else whoever holds the role (see `setSettings`).
   */
  async #driver(by: Principal, what: string): Promise<IssuerPolicy | undefined> {
    if (by.kind === "owner") return undefined;
    const deny = (): never => { throw new DomainError("forbidden", `${by.id} may not ${what}`); };
    if (by.kind !== "agent" || !by.id.startsWith("agent:")) return deny();
    let policy: IssuerPolicy;
    try { policy = await this.#policy(); } catch { return deny(); }
    if (!policy.qaAgents && !policy.bosses) return deny();
    const myId = by.id.slice("agent:".length);
    const mine = (await this.#runner.get("agent", myId))?.body as unknown as { state?: string; roles?: readonly string[]; principalId?: string } | undefined;
    if (mine === undefined || mine.state !== "active" || mine.principalId !== by.id) return deny();
    const isQa = (id: string, roles: readonly string[] | undefined): boolean => policy.qaAgentIds !== undefined ? policy.qaAgentIds.includes(id) : (roles ?? []).includes(policy.qaRole);
    if (policy.qaAgents && isQa(myId, mine.roles)) return policy;
    if (policy.bosses && (await this.#hasQaReport(myId, isQa))) return policy;
    return deny();
  }

  /** Whether an active agent that is a QA agent reports to this one. Pages through the agents and stops at the first; it never fails for a large installation. */
  async #hasQaReport(myId: string, isQa: (id: string, roles: readonly string[] | undefined) => boolean): Promise<boolean> {
    const matches = (a: Aggregate): boolean => { const b = a.body as unknown as { state?: string; roles?: readonly string[]; supervisorId?: string }; return b.state === "active" && b.supervisorId === myId && isQa(a.id, b.roles); };
    const named = (await this.#policy()).qaAgentIds;
    if (named !== undefined) {
      for (const id of named) { const a = await this.#runner.get("agent", id); if (a !== undefined && matches(a)) return true; }
      return false;
    }
    let after: string | undefined;
    for (;;) {
      const page = await this.#runner.list("agent", { ...(after === undefined ? {} : { afterId: after }), limit: 500 });
      if (page.some(matches)) return true;
      if (page.length < 500) return false;
      after = page[page.length - 1]!.id;
    }
  }

  async #policy(): Promise<IssuerPolicy> {
    return resolveIssuers(await this.#profile(), (await this.#runner.get(SETTINGS.kind, SETTINGS.id))?.body as unknown as IssuerSettingsBody | undefined);
  }

  async #profile(): Promise<string> {
    try { return ((await this.#runner.get("approval-policy", "installation"))?.body as unknown as { profile?: string } | undefined)?.profile ?? "strict"; } catch { return "strict"; }
  }

  // ---- delivery to a host ---------------------------------------------------------------------------------------------------------

  /**
   * What a host fetches: the open attempts issued to it with their job payloads (only while the owner still authorizes it for the platform; at most `RELEASE_LIMITS.jobs`, oldest first), and `cancel`, the attempts it
   * already picked up that were ended without a result (cancelled, timed out, authorization withdrawn) so the test stops. A cancel instruction is repeated for a day (at most `RELEASE_LIMITS.cancelKeep`); stopping is idempotent.
   * Attempts past their timeout are ended first.
   */
  async jobsFor(host: Principal): Promise<HostJobs> {
    this.#hostOnly(host);
    try { await this.#expireHost(host.id); } catch (e) { if (!(e instanceof DomainError)) throw e; }
    const idx = (await this.#runner.get(HOSTIDX, hostIdxId(host.id)))?.body as unknown as HostIndexBody | undefined;
    if (idx === undefined) return { jobs: [], cancel: [] };
    const mine: (AttemptBody & { id: string })[] = [];
    for (const id of idx.open) { const b = (await this.#runner.get(ATTEMPT, id))?.body as unknown as AttemptBody | undefined; if (b !== undefined && b.state === "issued" && b.hostId === host.id && b.workerId === host.id) mine.push({ id, ...b }); }
    mine.sort((a, b) => (a.issuedAt < b.issuedAt ? -1 : a.issuedAt > b.issuedAt ? 1 : a.id < b.id ? -1 : 1));
    const jobs: HostJob[] = [];
    for (const attempt of mine) {
      if (jobs.length >= RELEASE_LIMITS.jobs) break;
      try { await this.#hostStillAuthorized(host.id, attempt.cell); } catch { continue; }
      const candidate = (await this.#runner.get(CANDIDATE, attempt.candidateId))?.body as unknown as CandidateBody | undefined;
      if (candidate === undefined) continue;
      jobs.push({ attemptId: attempt.id, payload: jobPayload(attempt.candidateId, candidate.manifest, attempt.cell, attempt.id, attempt.limits), ...(attempt.pickedUpAt === undefined ? {} : { pickedUpAt: attempt.pickedUpAt }) });
    }
    const now = Date.parse(this.#runner.now());
    return { jobs, cancel: idx.cancel.filter((c) => now - Date.parse(c.at) < RELEASE_LIMITS.cancelMs).map((c) => c.id).slice(-RELEASE_LIMITS.cancelKeep) };
  }

  /**
   * Ends every open attempt that has run past its timeout plus a grace (the controller's own clock: a host that withdrew, crashed or ignores the limit never leaves a platform "issued" for ever). The attempt becomes
   * `timed_out`, which is never a pass and frees the platform for a retry. The controller's loop calls this; a host's fetch also does for its own jobs.
   */
  async expire(): Promise<{ expired: number }> {
    let expired = 0;
    let after: string | undefined;
    for (;;) {
      const page = await this.#runner.list(HOST, { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const h of page) { try { expired += await this.#expireHost((h.body as unknown as HostAuthBody).hostId); } catch (e) { if (!(e instanceof DomainError)) throw e; } }
      if (page.length < 200) return { expired };
      after = page[page.length - 1]!.id;
    }
  }

  async #expireHost(hostId: string): Promise<number> {
    const idx = (await this.#runner.get(HOSTIDX, hostIdxId(hostId)))?.body as unknown as HostIndexBody | undefined;
    if (idx === undefined || idx.open.length === 0) return 0;
    let ended = 0;
    for (const id of idx.open) {
      const before = (await this.#runner.get(ATTEMPT, id))?.body as unknown as AttemptBody | undefined;
      if (before === undefined || before.state !== "issued" || !this.#overdue(before)) continue;
      const ref: AggregateRef = { kind: ATTEMPT, id };
      await this.#runner.command("release.expire", { commandId: `release-expire-${id}`, actor: "controller" }, async () => ({
        payload: { attemptId: id },
        build: async (): Promise<Built> => {
          const found = await this.#runner.get(ATTEMPT, id);
          const attempt = found?.body as unknown as AttemptBody | undefined;
          if (found === undefined || attempt === undefined) throw new DomainError("not_found", "no such attempt");
          if (attempt.state !== "issued" || !this.#overdue(attempt)) return { ref, creates: false, changes: [{ type: "check", ref, expectedRevision: found.revision }], detail: { attemptId: id, kept: true } };
          const reason = `no result within ${attempt.limits.timeoutSeconds}s plus ${RELEASE_LIMITS.graceSeconds}s grace; treated as not run`;
          return { ref, creates: false, changes: await this.#endChanges(attempt.hostId, [{ found, attempt }], "timed_out", undefined, reason), detail: { attemptId: id, timedOut: true }, contention: async () => new DomainError("stale_revision", "the attempt changed at the same moment") };
        },
      }));
      ended++;
    }
    return ended;
  }

  #overdue(attempt: AttemptBody): boolean {
    const started = Date.parse(attempt.pickedUpAt ?? attempt.issuedAt);
    return Date.parse(this.#runner.now()) > started + (attempt.limits.timeoutSeconds + RELEASE_LIMITS.graceSeconds) * 1000;
  }

  /** The host says it has the job and is starting it. A repeat changes nothing. Refused for an attempt that is not this host's, is no longer open, or whose host the owner no longer authorizes. */
  async pickUp(host: Principal, command: NoActor & { attemptId: string }): Promise<{ pickedUpAt: string }> {
    // Two pick-ups at the same moment are one: the one that finds the revision moved looks again and sees the acknowledgement.
    for (let tries = 0; ; tries++) {
      try { return await this.#pickUp(host, command); } catch (e) { if (!(e instanceof DomainError) || e.code !== "stale_revision" || tries >= 3) throw e; }
    }
  }

  async #pickUp(host: Principal, command: NoActor & { attemptId: string }): Promise<{ pickedUpAt: string }> {
    this.#hostOnly(host);
    onlyKnown(command, ["commandId", "attemptId"]);
    const ref: AggregateRef = { kind: ATTEMPT, id: text(command.attemptId, "attemptId", { min: 1, max: 80 }) };
    let at: string | undefined;
    await this.#runner.command("release.pickup", { commandId: scopedCommandId(host.id, command.commandId), actor: host.id }, async () => ({
      payload: { attemptId: ref.id },
      build: async (): Promise<Built> => {
        const found = await this.#runner.get(ATTEMPT, ref.id);
        const attempt = found?.body as unknown as AttemptBody | undefined;
        // Another host's attempt reads like a missing one.
        if (found === undefined || attempt === undefined || attempt.hostId !== host.id || attempt.workerId !== host.id) throw new DomainError("not_found", "no such job for you");
        if (attempt.state !== "issued") throw new DomainError("invalid_command", `that attempt is already ${attempt.state}`, { field: "attemptId" });
        await this.#hostStillAuthorized(host.id, attempt.cell);
        if (attempt.pickedUpAt !== undefined) { at = attempt.pickedUpAt; return { ref, creates: false, changes: [{ type: "check", ref, expectedRevision: found.revision }], detail: { attemptId: ref.id, again: true } }; }
        const next: AttemptBody = { ...attempt, pickedUpAt: this.#runner.now() };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }], detail: { attemptId: ref.id }, contention: async () => new DomainError("stale_revision", "the attempt changed at the same moment; ask again") };
      },
    }));
    const found = (await this.#runner.get(ATTEMPT, ref.id))?.body as unknown as AttemptBody | undefined;
    return { pickedUpAt: at ?? found?.pickedUpAt ?? "" };
  }

  #hostOnly(host: Principal): void { if (host.kind !== "host") throw new DomainError("forbidden", `${host.id} is not a worker host`); }

  /** The owner's authorization of this host for this platform is still in force. */
  async #hostStillAuthorized(hostId: string, cell: Cell): Promise<void> {
    const auth = (await this.#runner.get(HOST, `rhs-${sha(hostId).slice(0, 24)}`))?.body as unknown as HostAuthBody | undefined;
    if (auth === undefined || !auth.active || auth.os !== cell.os || auth.arch !== cell.arch) throw new DomainError("forbidden", `${hostId} is no longer authorized for release tests on ${cellKey(cell)}`);
  }

  /**
   * Where each platform stands, from ALL of its attempts. Ready only when every platform's latest attempt passed. A platform that passed only after a failure is `flaky`: the earlier failures are listed beside the pass
   * and the release needs the owner's acknowledgement to be approved. Owner only.
   */
  async gate(owner: Principal, candidateId: string): Promise<Gate> {
    this.#owner(owner, "read the release gate");
    const candidate = (await this.#runner.get(CANDIDATE, String(candidateId)))?.body as unknown as CandidateBody | undefined;
    if (candidate === undefined) throw new DomainError("not_found", "no such release candidate");
    const attempts = await this.#attempts(candidateId, candidate.manifest.matrix);
    const cells: GateCell[] = candidate.manifest.matrix.map((cell) => {
      const mine = attempts.filter((a) => cellKey(a.cell) === cellKey(cell)).sort((a, b) => a.n - b.n);
      const latest = mine.at(-1);
      const state: CellState = latest === undefined ? "missing" : latest.state === "issued" ? "running" : latest.state;
      const earlier: EarlierFailure[] = state !== "passed" ? [] : mine.filter((a) => a.state === "failed").map((a) => ({ id: a.id, n: a.n, ...(a.issuedBy === undefined ? {} : { issuedBy: a.issuedBy }), ...(a.result === undefined ? {} : { summary: a.result.summary }), ...(a.endedAt === undefined ? {} : { endedAt: a.endedAt }) }));
      return { cell, state, attempts: mine.length, ...(latest === undefined ? {} : { latest: latest.id }), flaky: earlier.length > 0, earlierFailures: earlier };
    });
    const approved = (await this.#runner.get(APPROVAL, candidateId)) !== undefined;
    return { candidateId, ready: cells.every((c) => c.state === "passed"), needsAcknowledgement: cells.some((c) => c.flaky), approved, cells };
  }

  /** The owner's decision to release. A worker cannot make it, and nothing missing, failing, running or lost can pass it. A platform that passed only after failing needs `acknowledgeFlaky: true`. */
  async approve(owner: Principal, command: NoActor & { candidateId: string; acknowledgeFlaky?: boolean }): Promise<void> {
    this.#owner(owner, "approve a release");
    onlyKnown(command, ["commandId", "candidateId", "acknowledgeFlaky"]);
    if (command.acknowledgeFlaky !== undefined && typeof command.acknowledgeFlaky !== "boolean") bad("acknowledgeFlaky", "must be true or false");
    const ref: AggregateRef = { kind: APPROVAL, id: String(command.candidateId) };
    await this.#runner.command("release.approve", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { candidateId: command.candidateId, acknowledgeFlaky: command.acknowledgeFlaky === true },
      build: async (): Promise<Built> => {
        const gate = await this.gate(owner, command.candidateId);
        if (!gate.ready) throw new DomainError("invalid_command", `the release is not ready: ${gate.cells.filter((c) => c.state !== "passed").map((c) => `${cellKey(c.cell)} ${c.state}`).join(", ")}`, { field: "candidateId" });
        const flaky = gate.cells.filter((c) => c.flaky);
        if (flaky.length > 0 && command.acknowledgeFlaky !== true) throw new DomainError("invalid_command", `passed only after failing: ${flaky.map((c) => `${cellKey(c.cell)} (${c.earlierFailures.length} earlier failure${c.earlierFailures.length === 1 ? "" : "s"}: ${c.earlierFailures.map((f) => f.id).join(", ")})`).join("; ")}. Read release.gate, then approve with acknowledgeFlaky true.`.slice(0, 500), { field: "acknowledgeFlaky" });
        if ((await this.#runner.get(APPROVAL, ref.id)) !== undefined) throw new DomainError("invalid_command", "that candidate is already approved", { field: "candidateId" });
        const body: ApprovalBody = { candidateId: command.candidateId, by: owner.id, at: this.#runner.now(), ...(flaky.length === 0 ? {} : { acknowledged: flaky.flatMap((c) => c.earlierFailures.map((f) => f.id)) }) };
        return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { candidateId: command.candidateId, acknowledged: flaky.length } };
      },
    }));
  }

  /** The attempts of one candidate with their evidence, oldest first. Owner only. */
  async attempts(owner: Principal, candidateId: string): Promise<(AttemptBody & { id: string })[]> {
    this.#owner(owner, "read release attempts");
    const candidate = (await this.#runner.get(CANDIDATE, String(candidateId)))?.body as unknown as CandidateBody | undefined;
    if (candidate === undefined) return [];
    return (await this.#attempts(candidateId, candidate.manifest.matrix)).sort((a, b) => (a.n - b.n) || (a.id < b.id ? -1 : 1));
  }

  /** Every attempt of a candidate, read through each platform's own index (no scan of all attempts). */
  async #attempts(candidateId: string, matrix: readonly Cell[]): Promise<(AttemptBody & { id: string })[]> {
    const out: (AttemptBody & { id: string })[] = [];
    for (const cell of matrix) {
      const idx = (await this.#runner.get(CELLIDX, cellIdxId(candidateId, cell)))?.body as unknown as CellIndexBody | undefined;
      for (const e of idx?.attempts ?? []) { const b = (await this.#runner.get(ATTEMPT, e.id))?.body as unknown as AttemptBody | undefined; if (b !== undefined) out.push({ id: e.id, ...b }); }
    }
    return out;
  }

  #owner(by: Principal, what: string): void { if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not ${what}; only the owner does`); }
}
