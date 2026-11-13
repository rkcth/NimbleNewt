import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import { findCredentialShapes } from "../security/credential-patterns.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import type { ProtectedBranchService } from "../policy/protected-branches.js";

/**
 * Optional work-in-progress branch backup (card P02b). OFF unless the owner turns it on for a project, in words, by chatting with the supervisor. Turning it on records ONE standing owner approval, scoped to exactly one
 * remote and that project's own work-in-progress namespace (`refs/heads/nn-wip/<project>/`), kept with the owner's wording, revocable at any time (`enabled: false`). The scheduled pushes need no per-push approval because
 * of it; a push to any other remote or branch is not covered by it, is not made by this service, and takes the normal approval path (`authorize` says so in words).
 *
 * What the service never does: it never forces a push, never pushes to a protected or target branch (the namespace cannot name one, and a branch the owner protects under it is refused as well), never treats a backup commit
 * as reviewed work (the host's commit says `NimbleNewt-WIP: unreviewed` and has no review trailer), and never counts a push that failed as a backup (`lastSuccess` moves only when the host confirms the remote shows the commit).
 * The host that holds the checkout scans every file before the push (card A06's identity trailers, the credential shapes and the secret values in use) and leaves a blocked file out; the blocked files are kept here and reported.
 */
export const WIP_NAMESPACE = "refs/heads/nn-wip/";
export const WIP_LIMITS = { remote: 500, basis: 500, minMinutes: 5, maxMinutes: 1440, defaultMinutes: 15, blockedKept: 50, history: 10, tasksPerSweep: 100, projectsPerSweep: 200 } as const;

const SETTING = "wip-backup-setting";
const STATE = "wip-backup-state";
const PROJECT_ID = /^proj-[a-z2-7]{20}$/;
const NAME = /^[A-Za-z0-9._-]{1,120}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

/** The one standing approval the owner's turning the backup on records. */
export interface WipApproval {
  /** Exactly what it covers: this remote, this project, branches under this namespace. */
  readonly scope: { readonly remote: string; readonly projectId: string; readonly namespace: string };
  /** The owner's own wording (or a plain statement that the owner turned it on), kept as given. */
  readonly basis: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly revokedAt?: string;
  readonly revokedBy?: string;
}

export interface WipSettingBody {
  readonly enabled: boolean;
  readonly remote: string;
  readonly everyMinutes: number;
  /** The approval now in force (absent when the backup was never on); `revokedAt` is set when it was turned off. */
  readonly approval: WipApproval;
  /** Earlier approvals, newest first (a changed remote ends the old approval and records a new one). */
  readonly history: readonly WipApproval[];
  readonly updatedBy: string;
  readonly updatedAt: string;
}

export interface WipSuccess { readonly commitId: string; readonly tree: string; readonly at: string; readonly files: number; readonly unchanged: boolean }
export interface WipBlocked { readonly path: string; readonly reason: string }
export interface WipStateBody {
  readonly projectId: string;
  readonly remote: string;
  readonly ref: string;
  /** The last push the host confirmed (the remote showed the commit). A failed push never changes it, so a restore of the branch matches it. */
  readonly lastSuccess?: WipSuccess;
  readonly lastFailure?: { readonly at: string; readonly reason: string };
  readonly consecutiveFailures: number;
  readonly lastAttemptAt: string;
  /** The files the latest successful backup left out (credential shapes, secret values, links, files that changed while read), newest backup only. */
  readonly blocked: readonly WipBlocked[];
  readonly blockedDigest: string;
}

/** What the controller asks a host that holds the checkout to do. The worker's `HostWipBackupCall` and `HostWipBackupOutcome` fit these structurally. */
export interface WipBackupCall { readonly projectId: string; readonly taskId: string; readonly remote: string; readonly ref: string; readonly developer: string; readonly executor: string }
export type WipBackupOutcome =
  | { readonly ok: true; readonly summary: string; readonly detail: { readonly commitId?: unknown; readonly tree?: unknown; readonly files?: unknown; readonly unchanged?: unknown; readonly blocked?: unknown } }
  | { readonly ok: false; readonly reason: string };
export interface WipBackupPort { backup(call: WipBackupCall): Promise<WipBackupOutcome> }

export interface WipTaskRef { readonly taskId: string; readonly developer: string; readonly executor: string }
export interface WipReport { readonly projectId: string; readonly taskId: string; readonly kind: "failed" | "blocked"; readonly text: string }

export interface WipSweepOptions {
  readonly port: WipBackupPort;
  /** The tasks of a project whose work is in progress on a host (the agent as `developer`, the host as `executor`). */
  readonly tasks: (projectId: string) => Promise<readonly WipTaskRef[]> | readonly WipTaskRef[];
  /** Told once when a task's backup starts failing and when the set of left-out files changes. A throw is dropped: reporting must not change what was recorded. */
  readonly report?: (report: WipReport) => Promise<unknown> | unknown;
}

/** The branch a task's work in progress goes to. */
export const wipRefOf = (projectId: string, taskId: string): string => `${WIP_NAMESPACE}${projectId}/${taskId}`;

/** Why a remote is refused as a backup target, or undefined when it is one address or folder. Never lets a credential into a record: a secret in an address is the owner's to keep in a credential helper. */
export function remoteProblem(remote: unknown): string | undefined {
  if (typeof remote !== "string" || remote.length === 0) return "name the remote (a git address or a folder) the backup goes to";
  if (remote.length > WIP_LIMITS.remote) return `is longer than ${WIP_LIMITS.remote} characters`;
  if (remote.startsWith("-") || /[\s\u0000-\u001f\u007f]/.test(remote) || remote.includes("::") || /^ext:/i.test(remote)) return "must be one address or folder, with no option, space, line break or helper syntax";
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/@]*:[^/@]*@/i.test(remote) || /^[a-z][a-z0-9+.-]*:\/\/[^/@]*@[^/]*\?/i.test(remote) || redactText(remote) !== remote || findCredentialShapes(remote).length > 0) return "carries a password or key; keep the credential in the host's own credential helper or SSH key, never in the address";
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(remote)?.[1]?.toLowerCase();
  if (scheme !== undefined && !["https", "ssh", "file"].includes(scheme)) return `a ${scheme}:// address is not allowed (https, ssh and local folders are)`;
  return undefined;
}

const digestOf = (blocked: readonly WipBlocked[]): string => createHash("sha256").update(JSON.stringify(blocked.map((b) => [b.path, b.reason]).sort())).digest("hex").slice(0, 16);
const plainText = (value: unknown, max: number): string => redactText(String(value ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")).slice(0, max);

export class WipBackupService {
  readonly #runner: CommandRunner;
  readonly #branches: Pick<ProtectedBranchService, "isProtected"> | undefined;
  #running: Promise<unknown> | undefined;

  private constructor(runner: CommandRunner, branches: Pick<ProtectedBranchService, "isProtected"> | undefined) { this.#runner = runner; this.#branches = branches; }

  /** `branches` is the controller's protected-branch rule (card A07f): a work-in-progress branch the owner protects is not pushed to. */
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions & { branches?: Pick<ProtectedBranchService, "isProtected"> } = {}): WipBackupService {
    const { branches, ...runner } = options;
    return new WipBackupService(new CommandRunner(storage, epoch, runner), branches);
  }

  /** The owner's view of one project: whether the backup is on, what the standing approval covers, and each task's last successful backup and last failure. */
  async get(by: Principal, projectId: string): Promise<{ revision: number; enabled: boolean; remote?: string; everyMinutes?: number; approval?: WipApproval; history: readonly WipApproval[]; tasks: readonly (WipStateBody & { taskId: string })[] }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read a project's backup settings`);
    const id = this.#project(projectId);
    const found = await this.#runner.get(SETTING, id);
    const body = found?.body as unknown as WipSettingBody | undefined;
    const tasks: (WipStateBody & { taskId: string })[] = [];
    let after: string | undefined;
    for (let page = 0; page < 50 && tasks.length < WIP_LIMITS.tasksPerSweep; page++) {
      const chunk = await this.#runner.list(STATE, { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of chunk) { after = a.id; const s = a.body as unknown as WipStateBody; if (s.projectId === id && tasks.length < WIP_LIMITS.tasksPerSweep) tasks.push({ ...s, taskId: a.id }); }
      if (chunk.length < 200) break;
    }
    return { revision: found?.revision ?? 0, enabled: body?.enabled === true && body.approval.revokedAt === undefined, ...(body === undefined ? {} : { remote: body.remote, everyMinutes: body.everyMinutes, approval: body.approval }), history: body?.history ?? [], tasks };
  }

  /**
   * The owner turns the backup on or off for a project, or changes the remote or the interval. Turning it on needs the remote (the owner names it) and records the one standing approval for it; a changed remote ends the old
   * approval and records a new one; `enabled: false` revokes it (nothing more is pushed; what is already on the remote stays there, for the owner to delete). Off is the default: a project with no record is off.
   */
  async set(owner: Principal, command: NoActor & { projectId: string; enabled?: boolean; remote?: string; everyMinutes?: number; basis?: string; expectedRevision?: number }): Promise<{ revision: number; enabled: boolean }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change a project's backup settings`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "projectId", "enabled", "remote", "everyMinutes", "basis", "expectedRevision"].includes(k));
    if (unknown.length > 0) invalid(unknown[0]!, "is not a field of this command");
    const projectId = this.#project(command.projectId);
    if (command.enabled !== undefined && typeof command.enabled !== "boolean") invalid("enabled", "must be true or false");
    if (command.remote !== undefined) { const why = remoteProblem(command.remote); if (why !== undefined) invalid("remote", why); }
    if (command.everyMinutes !== undefined && (!Number.isSafeInteger(command.everyMinutes) || command.everyMinutes < WIP_LIMITS.minMinutes || command.everyMinutes > WIP_LIMITS.maxMinutes)) invalid("everyMinutes", `must be a whole number of minutes from ${WIP_LIMITS.minMinutes} to ${WIP_LIMITS.maxMinutes}`);
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) invalid("expectedRevision", "must be a whole number");
    if (command.basis !== undefined && (typeof command.basis !== "string" || command.basis.length === 0 || command.basis.length > WIP_LIMITS.basis || redactText(command.basis) !== command.basis)) invalid("basis", `must be 1 to ${WIP_LIMITS.basis} characters with no credential in them`);
    if (command.enabled === undefined && command.remote === undefined && command.everyMinutes === undefined) invalid("enabled", "say whether the backup is on, or change its remote or interval");
    // Off is the default: turning off what was never on records nothing.
    if (command.enabled === false && (await this.#runner.get(SETTING, projectId)) === undefined) return { revision: 0, enabled: false };
    const result = await this.#runner.command("wip-backup.set", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { projectId, enabled: command.enabled ?? null, remote: command.remote ?? null, everyMinutes: command.everyMinutes ?? null, basis: command.basis ?? null, expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const ref = { kind: SETTING, id: projectId };
        const current = await this.#runner.get(SETTING, projectId);
        const before = current?.body as unknown as WipSettingBody | undefined;
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the backup settings are at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`);
        const now = this.#runner.now();
        const wasOn = before !== undefined && before.enabled && before.approval.revokedAt === undefined;
        const turnOn = command.enabled === true || (command.enabled === undefined && wasOn);
        if (!turnOn && command.enabled !== false) throw new DomainError("invalid_command", "enabled: the backup is off; say that it is on, with the remote, to change it", { field: "enabled" });
        let next: WipSettingBody;
        if (command.enabled === false) {
          if (before === undefined) throw new DomainError("stale_revision", "the backup settings changed meanwhile");
          const approval = before.approval.revokedAt === undefined ? { ...before.approval, revokedAt: now, revokedBy: owner.id } : before.approval;
          next = { ...before, enabled: false, approval, updatedBy: owner.id, updatedAt: now };
        } else {
          const remote = command.remote ?? before?.remote;
          if (remote === undefined) throw new DomainError("invalid_command", "remote: name the remote (a git address or a folder) the backup goes to", { field: "remote" });
          const sameRemote = wasOn && before!.remote === remote;
          const approval: WipApproval = sameRemote ? before!.approval : { scope: { remote, projectId, namespace: `${WIP_NAMESPACE}${projectId}/` }, basis: command.basis ?? "the owner turned the backup on", approvedBy: owner.id, approvedAt: now };
          const history = before === undefined ? [] : sameRemote ? before.history : [{ ...before.approval, ...(before.approval.revokedAt === undefined ? { revokedAt: now, revokedBy: owner.id } : {}) }, ...before.history].slice(0, WIP_LIMITS.history);
          next = { enabled: true, remote, everyMinutes: command.everyMinutes ?? before?.everyMinutes ?? WIP_LIMITS.defaultMinutes, approval, history, updatedBy: owner.id, updatedAt: now };
        }
        const change = current === undefined ? { type: "create" as const, ref, body: next as unknown as JsonObject } : { type: "update" as const, ref, expectedRevision: current.revision, body: next as unknown as JsonObject };
        return { ref, creates: current === undefined, changes: [change], detail: { projectId, enabled: next.enabled, everyMinutes: next.everyMinutes } };
      },
    }));
    const now = await this.#runner.get(SETTING, projectId);
    return { revision: result.revision, enabled: (now?.body as unknown as WipSettingBody | undefined)?.enabled === true };
  }

  /**
   * Whether a push of this branch to this remote is covered by the owner's standing approval for this project: yes only for the remote the approval names and a branch in the project's own work-in-progress namespace
   * (two plain names deep), while the approval stands. Anything else is not covered and takes the normal approval path; this says so in words and pushes nothing.
   */
  async authorize(projectId: string, remote: string, ref: string): Promise<{ allowed: true } | { allowed: false; reason: string }> {
    const body = (await this.#runner.get(SETTING, this.#project(projectId)))?.body as unknown as WipSettingBody | undefined;
    const normal = "it needs the normal approval for a push";
    if (body === undefined || !body.enabled || body.approval.revokedAt !== undefined) return { allowed: false, reason: `the work-in-progress backup is not on for this project, so ${normal}` };
    if (body.approval.scope.remote !== remote || body.remote !== remote) return { allowed: false, reason: `the standing approval covers only the remote the owner named, not this one, so ${normal}` };
    const rest = ref.startsWith(body.approval.scope.namespace) ? ref.slice(body.approval.scope.namespace.length) : undefined;
    if (rest === undefined || !NAME.test(rest) || rest.includes("..") || rest.endsWith(".lock") || rest.startsWith(".") || rest.endsWith(".")) return { allowed: false, reason: `the standing approval covers only branches under ${body.approval.scope.namespace}, so ${normal}` };
    if (this.#branches !== undefined && await this.#branches.isProtected(projectId, `nn-wip/${projectId}/${rest}`)) return { allowed: false, reason: `the owner protects this branch, so ${normal}` };
    return { allowed: true };
  }

  /** Every enabled project's tasks are backed up when their interval has passed. One sweep runs at a time (a second ask gets the running one). Returns what was done, in counts. */
  sweep(by: Principal, options: WipSweepOptions): Promise<{ attempted: number; succeeded: number; failed: number; skipped: number }> {
    if (by.kind === "agent" || by.kind === "client") return Promise.reject(new DomainError("forbidden", `${by.id} may not run backups`));
    if (this.#running !== undefined) return this.#running as Promise<{ attempted: number; succeeded: number; failed: number; skipped: number }>;
    const run = this.#sweep(options).finally(() => { this.#running = undefined; });
    this.#running = run;
    return run;
  }

  async #sweep(options: WipSweepOptions): Promise<{ attempted: number; succeeded: number; failed: number; skipped: number }> {
    const total = { attempted: 0, succeeded: 0, failed: 0, skipped: 0 };
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const chunk = await this.#runner.list(SETTING, { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of chunk) {
        after = a.id;
        const setting = a.body as unknown as WipSettingBody;
        if (!setting.enabled || setting.approval.revokedAt !== undefined) continue;
        for (const task of (await options.tasks(a.id)).slice(0, WIP_LIMITS.tasksPerSweep)) {
          const r = await this.#backUp(a.id, setting, task, options);
          if (r === "skipped") total.skipped += 1;
          else { total.attempted += 1; if (r === "ok") total.succeeded += 1; else total.failed += 1; }
        }
      }
      if (chunk.length < 200) break;
    }
    return total;
  }

  async #backUp(projectId: string, setting: WipSettingBody, task: WipTaskRef, options: WipSweepOptions): Promise<"ok" | "failed" | "skipped"> {
    if (!NAME.test(task.taskId) || !NAME.test(task.developer.replace(/[:@]/g, "-")) || !NAME.test(task.executor.replace(/[:@]/g, "-"))) return "skipped";
    const ref = wipRefOf(projectId, task.taskId);
    const state = await this.#runner.get(STATE, task.taskId);
    const before = state?.body as unknown as WipStateBody | undefined;
    const now = this.#runner.now();
    if (before !== undefined && before.remote === setting.remote && Date.parse(now) - Date.parse(before.lastAttemptAt) < setting.everyMinutes * 60_000) return "skipped";
    const covered = await this.authorize(projectId, setting.remote, ref);
    let outcome: WipBackupOutcome;
    if (!covered.allowed) outcome = { ok: false, reason: covered.reason };
    else {
      try { outcome = await options.port.backup({ projectId, taskId: task.taskId, remote: setting.remote, ref, developer: task.developer, executor: task.executor }); } catch (error) { outcome = { ok: false, reason: `the host could not make the backup: ${plainText((error as Error)?.message, 160)}` }; }
    }
    const sameTarget = before !== undefined && before.remote === setting.remote;
    let body: WipStateBody;
    let report: WipReport | undefined;
    if (outcome.ok) {
      const d = outcome.detail;
      const blocked = (Array.isArray(d.blocked) ? d.blocked : []).slice(0, WIP_LIMITS.blockedKept).flatMap((b: unknown) => (b !== null && typeof b === "object" && typeof (b as WipBlocked).path === "string" && typeof (b as WipBlocked).reason === "string" ? [{ path: plainText((b as WipBlocked).path, 200), reason: plainText((b as WipBlocked).reason, 200) }] : []));
      const commit = typeof d.commitId === "string" && /^[0-9a-f]{40}$/.test(d.commitId) ? d.commitId : undefined;
      if (commit === undefined) { outcome = { ok: false, reason: "the host did not name the commit it pushed, so it is not counted as a backup" }; body = this.#failed(projectId, setting, ref, before, sameTarget, now, outcome.reason); }
      else {
        const digest = digestOf(blocked);
        body = { projectId, remote: setting.remote, ref, lastSuccess: { commitId: commit, tree: typeof d.tree === "string" ? d.tree.slice(0, 64) : "", at: now, files: typeof d.files === "number" ? d.files : 0, unchanged: d.unchanged === true }, consecutiveFailures: 0, lastAttemptAt: now, blocked, blockedDigest: digest, ...(before?.lastFailure === undefined || !sameTarget ? {} : { lastFailure: before.lastFailure }) };
        if (blocked.length > 0 && (before === undefined || before.blockedDigest !== digest)) report = { projectId, taskId: task.taskId, kind: "blocked", text: `The backup of task ${task.taskId} left out ${blocked.length} file(s) that looked like secrets or could not be carried: ${blocked.slice(0, 5).map((b) => `${b.path} (${b.reason})`).join("; ")}. They are not on the remote.` };
      }
    } else body = this.#failed(projectId, setting, ref, before, sameTarget, now, plainText(outcome.reason, 300));
    if (!outcome.ok && (before === undefined || before.consecutiveFailures === 0 || !sameTarget)) report = { projectId, taskId: task.taskId, kind: "failed", text: `The work-in-progress backup of task ${task.taskId} failed: ${plainText(outcome.reason, 300)}. It is not counted as a backup; the last good one is ${body.lastSuccess === undefined ? "none" : body.lastSuccess.commitId.slice(0, 12)}.` };
    await this.#runner.command("wip-backup.record", { commandId: `wip-${task.taskId}-${(state?.revision ?? 0) + 1}`, actor: "service:wip-backup" }, async () => ({
      payload: { taskId: task.taskId, at: now, ok: outcome.ok },
      build: async () => {
        const ref2 = { kind: STATE, id: task.taskId };
        const change = state === undefined ? { type: "create" as const, ref: ref2, body: body as unknown as JsonObject } : { type: "update" as const, ref: ref2, expectedRevision: state.revision, body: body as unknown as JsonObject };
        return { ref: ref2, creates: state === undefined, changes: [change], detail: { projectId, ok: outcome.ok, blocked: body.blocked.length } };
      },
    }));
    if (report !== undefined) { try { await options.report?.(report); } catch { /* reporting never changes what was recorded */ } }
    return outcome.ok ? "ok" : "failed";
  }

  #failed(projectId: string, setting: WipSettingBody, ref: string, before: WipStateBody | undefined, sameTarget: boolean, now: string, reason: string): WipStateBody {
    // lastSuccess is kept exactly as it was: a failed push is never a backup. It is dropped only when the remote changed (it was a backup to the old remote, which this approval no longer covers).
    return { projectId, remote: setting.remote, ref, ...(before?.lastSuccess === undefined || !sameTarget ? {} : { lastSuccess: before.lastSuccess }), lastFailure: { at: now, reason }, consecutiveFailures: sameTarget ? (before?.consecutiveFailures ?? 0) + 1 : 1, lastAttemptAt: now, blocked: sameTarget ? before?.blocked ?? [] : [], blockedDigest: sameTarget ? before?.blockedDigest ?? digestOf([]) : digestOf([]) };
  }

  #project(projectId: unknown): string {
    if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) throw new DomainError("invalid_command", "projectId: is not a project ID", { field: "projectId" });
    return projectId;
  }
}
