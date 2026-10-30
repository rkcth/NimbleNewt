import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { onlyKnown, text } from "../domain/model.js";
import { CommandRunner, type Built, type RunnerOptions } from "../domain/runner.js";
import { allows } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import { canonicalJson } from "../storage/json.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import { scanAll } from "../projects/common.js";

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
export type AttemptState = "issued" | "passed" | "failed" | "interrupted";
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
  readonly state: AttemptState;
  readonly issuedAt: string;
  readonly endedAt?: string;
  readonly result?: ResultBody;
  readonly reason?: string;
}
export interface ApprovalBody { readonly candidateId: string; readonly by: string; readonly at: string }
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
export type CellState = "passed" | "failed" | "interrupted" | "running" | "missing";
export interface Gate { readonly candidateId: string; readonly ready: boolean; readonly approved: boolean; readonly cells: readonly { cell: Cell; state: CellState; attempts: number; latest?: string }[] }

export const RELEASE_LIMITS = { cells: 20, artifacts: 100, locks: 100, summary: 500, scan: 5000, timeoutSeconds: 24 * 3600, memoryMb: 1_000_000 } as const;
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

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const bad = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const cellKey = (c: Cell): string => `${c.os}/${c.arch}`;
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

  /** The owner allows a host to run destructive release tests for one platform. A machine used for production work is not authorized by that. */
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
        return existing === undefined
          ? { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { hostId, active } }
          : { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: existing.revision, body: body as unknown as JsonObject }], detail: { hostId, active } };
      },
    }));
  }

  /** Issues the next attempt for one platform to an authorized host and the worker that will report. Returns the job payload. */
  async issue(owner: Principal, command: NoActor & { candidateId: string; cell: Cell; hostId: string; workerId: string; timeoutSeconds: number; memoryMb: number }): Promise<{ attemptId: string; payload: JobPayload }> {
    this.#owner(owner, "issue a release test");
    onlyKnown(command, ["commandId", "candidateId", "cell", "hostId", "workerId", "timeoutSeconds", "memoryMb"]);
    const cell = checkCell(command.cell, "cell");
    const hostId = text(command.hostId, "hostId", { min: 1, max: 80 });
    const workerId = text(command.workerId, "workerId", { min: 1, max: 80 });
    if (!Number.isInteger(command.timeoutSeconds) || command.timeoutSeconds < 1 || command.timeoutSeconds > RELEASE_LIMITS.timeoutSeconds) bad("timeoutSeconds", `must be a whole number of seconds up to ${RELEASE_LIMITS.timeoutSeconds}`);
    if (!Number.isInteger(command.memoryMb) || command.memoryMb < 1 || command.memoryMb > RELEASE_LIMITS.memoryMb) bad("memoryMb", "must be a whole number of megabytes");
    const limits = { timeoutSeconds: command.timeoutSeconds, memoryMb: command.memoryMb };
    let issued: { attemptId: string; payload: JobPayload } | undefined;
    await this.#runner.command("release.issue", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { candidateId: command.candidateId, cell: cellKey(cell), hostId, workerId },
      build: async (): Promise<Built> => {
        const candidate = await this.#runner.get(CANDIDATE, String(command.candidateId));
        if (candidate === undefined) throw new DomainError("not_found", "no such release candidate");
        const manifest = (candidate.body as unknown as CandidateBody).manifest;
        if (!manifest.matrix.some((c) => cellKey(c) === cellKey(cell))) throw new DomainError("invalid_command", `${cellKey(cell)} is not in this candidate's matrix`, { field: "cell" });
        const host = (await this.#runner.get(HOST, `rhs-${sha(hostId).slice(0, 24)}`))?.body as unknown as HostAuthBody | undefined;
        if (host === undefined || !host.active) throw new DomainError("forbidden", `${hostId} is not authorized for release tests`);
        if (host.os !== cell.os || host.arch !== cell.arch) throw new DomainError("forbidden", `${hostId} is authorized for ${host.os}/${host.arch}, not ${cellKey(cell)}`);
        const prior = (await this.#attempts(command.candidateId)).filter((a) => cellKey((a.body as unknown as AttemptBody).cell) === cellKey(cell));
        const latest = prior.map((a) => a.body as unknown as AttemptBody).sort((a, b) => a.n - b.n).at(-1);
        if (latest?.state === "issued") throw new DomainError("invalid_command", "an attempt for this platform is still open; interrupt it first", { field: "cell" });
        if (latest?.state === "passed") throw new DomainError("invalid_command", "this platform already passed", { field: "cell" });
        const n = (latest?.n ?? 0) + 1;
        const attemptId = attemptIdOf(command.candidateId, cell, n);
        const payload = jobPayload(command.candidateId, manifest, cell, attemptId, limits);
        const ref: AggregateRef = { kind: ATTEMPT, id: attemptId };
        const body: AttemptBody = { candidateId: command.candidateId, cell, n, hostId, workerId, payloadDigest: sha(canonicalJson(payload as unknown as JsonObject)), state: "issued", issuedAt: this.#runner.now() };
        issued = { attemptId, payload };
        return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { candidateId: command.candidateId, platform: cellKey(cell), attempt: n } };
      },
    }));
    if (issued === undefined) {
      // A repeat of the same command: rebuild what was issued.
      const found = (await this.#attempts(command.candidateId)).map((a) => ({ id: a.id, body: a.body as unknown as AttemptBody })).filter((a) => cellKey(a.body.cell) === cellKey(cell) && a.body.workerId === workerId && a.body.hostId === hostId).sort((a, b) => a.body.n - b.body.n).at(-1);
      const candidate = (await this.#runner.get(CANDIDATE, command.candidateId))!.body as unknown as CandidateBody;
      if (found === undefined) throw new DomainError("not_found", "that attempt is not recorded");
      issued = { attemptId: found.id, payload: jobPayload(command.candidateId, candidate.manifest, cell, found.id, limits) };
    }
    return issued;
  }

  /**
   * The worker's result. Refused (and recorded as nothing) if it is not from the worker the attempt was issued to, the attempt is no longer open, or what it reports differs in any way from the candidate.
   * The worker says what happened on its platform; whether the release goes ahead is not its to say.
   */
  async report(by: Principal, command: NoActor & { attemptId: string; sourceCommit: string; suiteRevision: string; artifactHashes: unknown; environment: unknown; outcome: "pass" | "fail"; counts: { passed: number; failed: number; skipped: number }; logDigest: string; summary: string }): Promise<void> {
    if (by.kind === "owner" || !allows(by, "release.report", undefined)) throw new DomainError("forbidden", `${by.id} may not report release test results`);
    onlyKnown(command, ["commandId", "attemptId", "sourceCommit", "suiteRevision", "artifactHashes", "environment", "outcome", "counts", "logDigest", "summary"]);
    if (command.outcome !== "pass" && command.outcome !== "fail") bad("outcome", "must be pass or fail");
    if (typeof command.logDigest !== "string" || !SHA.test(command.logDigest)) bad("logDigest", "needs a lower-case sha256 of the log");
    const k = command.counts as Partial<Record<"passed" | "failed" | "skipped", unknown>> | undefined;
    for (const f of ["passed", "failed", "skipped"] as const) if (!Number.isInteger(k?.[f]) || (k![f] as number) < 0) bad(`counts.${f}`, "must be a whole number");
    if (command.outcome === "pass" && (command.counts.failed > 0 || command.counts.passed === 0)) bad("outcome", "a pass needs passing tests and none failing");
    const environment = checkCell(command.environment, "environment");
    const summary = redactText(text(command.summary, "summary", { min: 1, max: RELEASE_LIMITS.summary }));
    const artifactHashes = hashMap(command.artifactHashes, "artifactHashes", RELEASE_LIMITS.artifacts);
    const ref: AggregateRef = { kind: ATTEMPT, id: String(command.attemptId) };
    await this.#runner.command("release.report", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { attemptId: command.attemptId, outcome: command.outcome },
      build: async (): Promise<Built> => {
        const found = await this.#runner.get(ATTEMPT, ref.id);
        // Another worker's attempt reads like a missing one.
        const attempt = found?.body as unknown as AttemptBody | undefined;
        if (found === undefined || attempt === undefined || attempt.workerId !== by.id) throw new DomainError("not_found", "no such attempt for you to report");
        if (attempt.state !== "issued") throw new DomainError("invalid_command", `that attempt is already ${attempt.state}`, { field: "attemptId" });
        const manifest = ((await this.#runner.get(CANDIDATE, attempt.candidateId))!.body as unknown as CandidateBody).manifest;
        if (command.sourceCommit !== manifest.sourceCommit) throw new DomainError("invalid_command", "the source commit is not the candidate's", { field: "sourceCommit" });
        if (command.suiteRevision !== manifest.suiteRevision) throw new DomainError("invalid_command", "the test-suite revision is not the candidate's", { field: "suiteRevision" });
        if (canonicalJson(artifactHashes as unknown as JsonObject) !== canonicalJson(manifest.artifacts as unknown as JsonObject)) throw new DomainError("invalid_command", "the artifact hashes are not the candidate's", { field: "artifactHashes" });
        if (environment.os !== attempt.cell.os || environment.arch !== attempt.cell.arch) throw new DomainError("invalid_command", `the result is from ${cellKey(environment)}, not ${cellKey(attempt.cell)}`, { field: "environment" });
        const result: ResultBody = { outcome: command.outcome, counts: command.counts, environment, logDigest: command.logDigest, summary };
        const next: AttemptBody = { ...attempt, state: command.outcome === "pass" ? "passed" : "failed", endedAt: this.#runner.now(), result };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }], detail: { attemptId: ref.id, state: next.state }, contention: async () => new DomainError("stale_revision", "the attempt changed at the same moment; report again") };
      },
    }));
  }

  /** Ends an open attempt without a result (the worker was lost, timed out or was stopped). It is never a pass. */
  async interrupt(owner: Principal, command: NoActor & { attemptId: string; reason: string }): Promise<void> {
    this.#owner(owner, "interrupt a release test");
    onlyKnown(command, ["commandId", "attemptId", "reason"]);
    const reason = redactText(text(command.reason, "reason", { min: 1, max: RELEASE_LIMITS.summary }));
    const ref: AggregateRef = { kind: ATTEMPT, id: String(command.attemptId) };
    await this.#runner.command("release.interrupt", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { attemptId: command.attemptId, reason },
      build: async (): Promise<Built> => {
        const found = await this.#runner.get(ATTEMPT, ref.id);
        const attempt = found?.body as unknown as AttemptBody | undefined;
        if (found === undefined || attempt === undefined) throw new DomainError("not_found", "no such attempt");
        if (attempt.state !== "issued") throw new DomainError("invalid_command", `that attempt is already ${attempt.state}`, { field: "attemptId" });
        const next: AttemptBody = { ...attempt, state: "interrupted", endedAt: this.#runner.now(), reason };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }], detail: { attemptId: ref.id }, contention: async () => new DomainError("stale_revision", "the attempt changed at the same moment; ask again") };
      },
    }));
  }

  /** Where each platform stands. Ready only when every platform's latest attempt passed. Owner only. */
  async gate(owner: Principal, candidateId: string): Promise<Gate> {
    this.#owner(owner, "read the release gate");
    const candidate = (await this.#runner.get(CANDIDATE, String(candidateId)))?.body as unknown as CandidateBody | undefined;
    if (candidate === undefined) throw new DomainError("not_found", "no such release candidate");
    const attempts = (await this.#attempts(candidateId)).map((a) => ({ id: a.id, ...(a.body as unknown as AttemptBody) }));
    const cells = candidate.manifest.matrix.map((cell) => {
      const mine = attempts.filter((a) => cellKey(a.cell) === cellKey(cell)).sort((a, b) => a.n - b.n);
      const latest = mine.at(-1);
      const state: CellState = latest === undefined ? "missing" : latest.state === "issued" ? "running" : latest.state;
      return { cell, state, attempts: mine.length, ...(latest === undefined ? {} : { latest: latest.id }) };
    });
    const approved = (await this.#runner.get(APPROVAL, candidateId)) !== undefined;
    return { candidateId, ready: cells.every((c) => c.state === "passed"), approved, cells };
  }

  /** The owner's decision to release. A worker cannot make it, and nothing missing, failing, running or lost can pass it. */
  async approve(owner: Principal, command: NoActor & { candidateId: string }): Promise<void> {
    this.#owner(owner, "approve a release");
    onlyKnown(command, ["commandId", "candidateId"]);
    const ref: AggregateRef = { kind: APPROVAL, id: String(command.candidateId) };
    await this.#runner.command("release.approve", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { candidateId: command.candidateId },
      build: async (): Promise<Built> => {
        const gate = await this.gate(owner, command.candidateId);
        if (!gate.ready) throw new DomainError("invalid_command", `the release is not ready: ${gate.cells.filter((c) => c.state !== "passed").map((c) => `${cellKey(c.cell)} ${c.state}`).join(", ")}`, { field: "candidateId" });
        if ((await this.#runner.get(APPROVAL, ref.id)) !== undefined) throw new DomainError("invalid_command", "that candidate is already approved", { field: "candidateId" });
        const body: ApprovalBody = { candidateId: command.candidateId, by: owner.id, at: this.#runner.now() };
        return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { candidateId: command.candidateId } };
      },
    }));
  }

  /** The attempts of one candidate with their evidence, oldest first. Owner only. */
  async attempts(owner: Principal, candidateId: string): Promise<(AttemptBody & { id: string })[]> {
    this.#owner(owner, "read release attempts");
    return (await this.#attempts(candidateId)).map((a) => ({ id: a.id, ...(a.body as unknown as AttemptBody) })).sort((a, b) => (a.n - b.n) || (a.id < b.id ? -1 : 1));
  }

  async #attempts(candidateId: string) {
    return scanAll(this.#runner, ATTEMPT, RELEASE_LIMITS.scan, (a) => (a.body as unknown as AttemptBody).candidateId === candidateId);
  }

  #owner(by: Principal, what: string): void { if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not ${what}; only the owner does`); }
}
