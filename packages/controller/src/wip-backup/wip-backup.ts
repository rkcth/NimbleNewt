import { createHash, randomBytes } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import { findCredentialShapes } from "../security/credential-patterns.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import type { ProtectedBranchService } from "../policy/protected-branches.js";
import type { GrantService } from "../security/grants.js";

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
export const WIP_LIMITS = { remote: 250, basis: 500, minMinutes: 5, maxMinutes: 1440, defaultMinutes: 15, blockedKept: 50, history: 10, tasksPerSweep: 100, projectsPerSweep: 200 } as const;

const SETTING = "wip-backup-setting";
const STATE = "wip-backup-state";
const RESTORE = "wip-backup-restore";
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
  /** The standing grant (card A07) this approval IS: a record in the owner's list of standing rules, revocable there like any other. Absent only on a setting made before the grant existed (it then covers nothing until turned on again). */
  readonly grantId?: string;
}

/** The standing approval is an ordinary A07 grant held by the controller's own dispatcher service: `recovery.wip-backup` on one resource (the project's work-in-progress namespace), with the remote in its conditions. */
export const WIP_GRANTEE = "service:dispatcher";
export const WIP_GRANT_ACTION = "recovery.wip-backup";
export const WIP_GRANT_RESOURCE_KIND = "wip-backup";

export interface WipSettingBody {
  readonly enabled: boolean;
  readonly remote: string;
  readonly everyMinutes: number;
  /** The NAME of the secret (in the host's secret store) the owner chose for pushing to an https remote. Only the name is kept here; the value is resolved by the host at the moment of a push or restore and is never in a record, a message or a file. */
  readonly credential?: string;
  /** The approval now in force (absent when the backup was never on); `revokedAt` is set when it was turned off. */
  readonly approval: WipApproval;
  /** Earlier approvals, newest first (a changed remote ends the old approval and records a new one). */
  readonly history: readonly WipApproval[];
  readonly updatedBy: string;
  readonly updatedAt: string;
}

/** The answer to one restore command, kept so the same command ID never restores twice. */
export interface WipRestoreRecord { readonly projectId: string; readonly taskId: string; readonly ok: boolean; readonly at: string; /** Set while the host is being asked: the command was claimed and its outcome is not known yet (or the controller stopped before it was). */ readonly pending?: boolean; readonly reason?: string; readonly summary?: string; readonly where?: string; readonly commitId?: string; readonly files?: number; readonly baseFound?: boolean }
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
export interface WipBackupCall { readonly projectId: string; readonly taskId: string; readonly remote: string; readonly ref: string; readonly developer: string; readonly executor: string; readonly credential?: string }
export type WipBackupOutcome =
  | { readonly ok: true; readonly summary: string; readonly detail: { readonly commitId?: unknown; readonly tree?: unknown; readonly files?: unknown; readonly unchanged?: unknown; readonly blocked?: unknown } }
  | { readonly ok: false; readonly reason: string };
export interface WipBackupPort { backup(call: WipBackupCall): Promise<WipBackupOutcome>; restore?(call: WipRestoreCall): Promise<WipRestoreOutcome> }
/** What the controller asks a host to restore: the task's last CONFIRMED backup (the host refuses a branch that is any other commit). */
export interface WipRestoreCall { readonly projectId: string; readonly taskId: string; readonly remote: string; readonly ref: string; readonly expectCommit: string; readonly credential?: string }
export type WipRestoreOutcome = { readonly ok: true; readonly summary: string; readonly detail: { readonly [key: string]: unknown } } | { readonly ok: false; readonly reason: string };

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
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/@]*:[^/@]*@/i.test(remote) || /^[a-z][a-z0-9+.-]*:\/\/[^/@]*@[^/]*\?/i.test(remote) || (!remote.includes("://") && /^[^/@:\\]+:[^/@\\]*@/.test(remote)) || redactText(remote) !== remote || findCredentialShapes(remote).length > 0) return "carries a password or key; keep the credential in the host's own credential helper or SSH key, never in the address";
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(remote)?.[1]?.toLowerCase();
  if (scheme !== undefined && !["https", "ssh", "file"].includes(scheme)) return `a ${scheme}:// address is not allowed (https, ssh and local folders are)`;
  return undefined;
}

const digestOf = (blocked: readonly WipBlocked[]): string => createHash("sha256").update(JSON.stringify(blocked.map((b) => [b.path, b.reason]).sort())).digest("hex").slice(0, 16);
const plainText = (value: unknown, max: number): string => redactText(String(value ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")).slice(0, max);

/** What the state API asks of the backup: the service, with a restore already tied to the host that can carry it out. */
export interface WipBackupApi {
  get(by: Principal, projectId: string): ReturnType<WipBackupService["get"]>;
  set(by: Principal, command: Parameters<WipBackupService["set"]>[1]): ReturnType<WipBackupService["set"]>;
  restore(by: Principal, command: Parameters<WipBackupService["restore"]>[1]): ReturnType<WipBackupService["restore"]>;
}
/** The part of the grant service the backup uses. */
export type WipGrants = Pick<GrantService, "grant" | "revoke" | "getGrant">;
const SECRET_NAME_OF = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const isHttps = (remote: string): boolean => /^https:\/\//i.test(remote);

export class WipBackupService {
  readonly #runner: CommandRunner;
  readonly #branches: Pick<ProtectedBranchService, "isProtected"> | undefined;
  readonly #grants: WipGrants | undefined;
  readonly #ensureGrantee: (() => Promise<unknown>) | undefined;
  #running: Promise<unknown> | undefined;

  private constructor(runner: CommandRunner, branches: Pick<ProtectedBranchService, "isProtected"> | undefined, grants: WipGrants | undefined, ensureGrantee: (() => Promise<unknown>) | undefined) { this.#runner = runner; this.#branches = branches; this.#grants = grants; this.#ensureGrantee = ensureGrantee; }

  /**
   * `branches` is the controller's protected-branch rule (card A07f): a work-in-progress branch the owner protects is not pushed to. `grants` is the controller's grant service: with it, turning the backup on makes the standing approval
   * a real A07 grant (listed with the other standing rules, revoked the same way, and a push is covered only while that grant is active); `ensureGrantee` makes sure the principal that holds it exists. Without `grants` (unit tests of the schedule) the setting alone is the approval.
   */
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions & { branches?: Pick<ProtectedBranchService, "isProtected">; grants?: WipGrants; ensureGrantee?: () => Promise<unknown> } = {}): WipBackupService {
    const { branches, grants, ensureGrantee, ...runner } = options;
    return new WipBackupService(new CommandRunner(storage, epoch, runner), branches, grants, ensureGrantee);
  }

  /** The owner's view of one project: whether the backup is on, what the standing approval covers, and each task's last successful backup and last failure. */
  async get(by: Principal, projectId: string): Promise<{ revision: number; enabled: boolean; remote?: string; everyMinutes?: number; credential?: string; approval?: WipApproval; /** Whether the standing grant behind the approval is still active (it can be revoked in the list of standing rules, which ends the backup). */ approvalHeld?: boolean; history: readonly WipApproval[]; tasks: readonly (WipStateBody & { taskId: string })[] }> {
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
    const on = body?.enabled === true && body.approval.revokedAt === undefined;
    const held = body === undefined || !on ? undefined : (await this.#approvalProblem(id, body.remote, body)) === undefined;
    return { revision: found?.revision ?? 0, enabled: on && held !== false, ...(body === undefined ? {} : { remote: body.remote, everyMinutes: body.everyMinutes, ...(body.credential === undefined ? {} : { credential: body.credential }), approval: body.approval }), ...(held === undefined ? {} : { approvalHeld: held }), history: body?.history ?? [], tasks };
  }

  /**
   * The owner turns the backup on or off for a project, or changes the remote or the interval. Turning it on needs the remote (the owner names it) and records the one standing approval for it; a changed remote ends the old
   * approval and records a new one; `enabled: false` revokes it (nothing more is pushed; what is already on the remote stays there, for the owner to delete). Off is the default: a project with no record is off.
   */
  async set(owner: Principal, command: NoActor & { projectId: string; enabled?: boolean; remote?: string; everyMinutes?: number; credential?: string | null; basis?: string; expectedRevision?: number }): Promise<{ revision: number; enabled: boolean }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change a project's backup settings`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "projectId", "enabled", "remote", "everyMinutes", "credential", "basis", "expectedRevision"].includes(k));
    if (unknown.length > 0) invalid(unknown[0]!, "is not a field of this command");
    const projectId = this.#project(command.projectId);
    if (command.enabled !== undefined && typeof command.enabled !== "boolean") invalid("enabled", "must be true or false");
    if (command.remote !== undefined) { const why = remoteProblem(command.remote); if (why !== undefined) invalid("remote", why); }
    if (command.everyMinutes !== undefined && (!Number.isSafeInteger(command.everyMinutes) || command.everyMinutes < WIP_LIMITS.minMinutes || command.everyMinutes > WIP_LIMITS.maxMinutes)) invalid("everyMinutes", `must be a whole number of minutes from ${WIP_LIMITS.minMinutes} to ${WIP_LIMITS.maxMinutes}`);
    if (command.credential !== undefined && command.credential !== null && (typeof command.credential !== "string" || !SECRET_NAME_OF.test(command.credential) || command.credential.includes("__") || redactText(command.credential) !== command.credential || findCredentialShapes(command.credential).length > 0)) invalid("credential", "must be the NAME of a secret in the host's secret store (letters, digits, dot, underscore or hyphen), never the secret itself");
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) invalid("expectedRevision", "must be a whole number");
    if (command.basis !== undefined && (typeof command.basis !== "string" || command.basis.length === 0 || command.basis.length > WIP_LIMITS.basis || redactText(command.basis) !== command.basis)) invalid("basis", `must be 1 to ${WIP_LIMITS.basis} characters with no credential in them`);
    if (command.enabled === undefined && command.remote === undefined && command.everyMinutes === undefined && command.credential === undefined) invalid("enabled", "say whether the backup is on, or change its remote, interval or the secret it uses");
    // Off is the default: turning off what was never on records nothing.
    if (command.enabled === false && (await this.#runner.get(SETTING, projectId)) === undefined) return { revision: 0, enabled: false };
    const commandId = scopedCommandId(owner.id, command.commandId);
    let created: string | undefined;
    let result: { id: string; revision: number };
    try {
      result = await this.#runner.command("wip-backup.set", { commandId, actor: owner.id }, async () => ({
        payload: { projectId, enabled: command.enabled ?? null, remote: command.remote ?? null, everyMinutes: command.everyMinutes ?? null, credential: command.credential ?? null, clearCredential: command.credential === null, basis: command.basis ?? null, expectedRevision: command.expectedRevision ?? null },
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
            // The standing grant is revoked FIRST: from then on no push is covered, whatever happens to the record below.
            await this.#revokeGrant(owner, before.approval, commandId, "the owner turned the work-in-progress backup off");
            const approval = before.approval.revokedAt === undefined ? { ...before.approval, revokedAt: now, revokedBy: owner.id } : before.approval;
            next = { ...before, enabled: false, approval, updatedBy: owner.id, updatedAt: now };
          } else {
            const remote = command.remote ?? before?.remote;
            if (remote === undefined) throw new DomainError("invalid_command", "remote: name the remote (a git address or a folder) the backup goes to", { field: "remote" });
            const credential = command.credential === null ? undefined : command.credential ?? before?.credential;
            if (credential !== undefined && !isHttps(remote)) throw new DomainError("invalid_command", "credential: a named secret is used only for an https remote (an ssh remote uses the host's ssh agent, a folder needs none)", { field: "credential" });
            // The approval stands while it is for this remote and (with grants) its grant is still active; otherwise a new one is recorded.
            const sameRemote = wasOn && before!.remote === remote && (await this.#approvalProblem(projectId, remote, before!)) === undefined;
            let approval: WipApproval;
            let history: readonly WipApproval[];
            if (sameRemote) { approval = before!.approval; history = before!.history; }
            else {
              if (before !== undefined) await this.#revokeGrant(owner, before.approval, commandId, "the owner moved the work-in-progress backup to another remote");
              const scope = { remote, projectId, namespace: `${WIP_NAMESPACE}${projectId}/` };
              const basis = command.basis ?? "the owner turned the backup on";
              const grantId = this.#grants === undefined ? undefined : (created = await this.#makeGrant(owner, scope, basis, commandId));
              approval = { scope, basis, approvedBy: owner.id, approvedAt: now, ...(grantId === undefined ? {} : { grantId }) };
              history = before === undefined ? [] : [{ ...before.approval, ...(before.approval.revokedAt === undefined ? { revokedAt: now, revokedBy: owner.id } : {}) }, ...before.history].slice(0, WIP_LIMITS.history);
            }
            next = { enabled: true, remote, everyMinutes: command.everyMinutes ?? before?.everyMinutes ?? WIP_LIMITS.defaultMinutes, ...(credential === undefined ? {} : { credential }), approval, history, updatedBy: owner.id, updatedAt: now };
          }
          const change = current === undefined ? { type: "create" as const, ref, body: next as unknown as JsonObject } : { type: "update" as const, ref, expectedRevision: current.revision, body: next as unknown as JsonObject };
          return { ref, creates: current === undefined, changes: [change], detail: { projectId, enabled: next.enabled, everyMinutes: next.everyMinutes, credentialNamed: next.credential !== undefined, ...(next.approval.grantId === undefined ? {} : { grantId: next.approval.grantId }) } };
        },
      }));
    } catch (error) {
      // A grant made for a setting that was then refused is revoked at once, so no standing approval is left that nothing refers to.
      if (created !== undefined) await this.#grants?.getGrant(created).then((g) => (g === undefined || g.state !== "active" ? undefined : this.#grants!.revoke(owner, { commandId: `${command.commandId}:wip-undo`, grantId: created!, expectedRevision: g.revision, reason: "the backup setting it was made for was refused" }))).catch(() => undefined);
      throw error;
    }
    const now = await this.#runner.get(SETTING, projectId);
    return { revision: result.revision, enabled: (now?.body as unknown as WipSettingBody | undefined)?.enabled === true };
  }

  /** Makes the standing grant (card A07) for one remote and one project's namespace; replaying the same command returns the same grant. */
  async #makeGrant(owner: Principal, scope: WipApproval["scope"], basis: string, commandId: string): Promise<string> {
    await this.#ensureGrantee?.();
    const made = await this.#grants!.grant(owner, {
      commandId: `wip-${createHash("sha256").update(commandId).digest("hex").slice(0, 40)}`, grantee: WIP_GRANTEE, action: WIP_GRANT_ACTION, project: scope.projectId, resource: { kind: WIP_GRANT_RESOURCE_KIND, id: scope.namespace }, source: "standing",
      basis: `Work-in-progress backup: ${basis}`.slice(0, 1000), terms: { conditions: [`remote: ${scope.remote}`, `branches: ${scope.namespace}`, "never forced, never a protected or target branch, files that look like secrets are left out"] },
    } as never);
    return made.id;
  }

  /** Revokes the grant behind an approval when it is still active (an already revoked or missing one is left as it is). */
  async #revokeGrant(owner: Principal, approval: WipApproval, commandId: string, reason: string): Promise<void> {
    if (this.#grants === undefined || approval.grantId === undefined) return;
    const g = await this.#grants.getGrant(approval.grantId);
    if (g === undefined || g.state !== "active") return;
    await this.#grants.revoke(owner, { commandId: `wip-revoke-${createHash("sha256").update(`${commandId}:${approval.grantId}`).digest("hex").slice(0, 40)}`, grantId: approval.grantId, expectedRevision: g.revision, reason });
  }

  /** Why the approval of this setting does not cover a push to `remote`, or undefined when it does (with a grant service: the grant must be active, the owner's, and name this remote and namespace). */
  async #approvalProblem(projectId: string, remote: string, body: WipSettingBody): Promise<string | undefined> {
    if (this.#grants === undefined) return undefined;
    if (body.approval.grantId === undefined) return "this approval was recorded before the standing grant existed and covers nothing; turn the backup on again";
    const g = await this.#grants.getGrant(body.approval.grantId);
    if (g === undefined || g.state !== "active") return "the standing grant behind the backup was revoked (in the list of standing rules or by turning the backup off), so pushes are not covered";
    const conditions = g.terms?.conditions ?? [];
    if (g.grantee !== WIP_GRANTEE || g.action !== WIP_GRANT_ACTION || g.project !== projectId || g.resource?.kind !== WIP_GRANT_RESOURCE_KIND || g.resource.id !== body.approval.scope.namespace || !conditions.includes(`remote: ${remote}`)) return "the standing grant does not name this remote and project, so pushes are not covered";
    return undefined;
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
    const held = await this.#approvalProblem(projectId, remote, body);
    if (held !== undefined) return { allowed: false, reason: `${held}, so ${normal}` };
    const rest = ref.startsWith(body.approval.scope.namespace) ? ref.slice(body.approval.scope.namespace.length) : undefined;
    if (rest === undefined || !NAME.test(rest) || rest.includes("..") || rest.endsWith(".lock") || rest.startsWith(".") || rest.endsWith(".")) return { allowed: false, reason: `the standing approval covers only branches under ${body.approval.scope.namespace}, so ${normal}` };
    if (this.#branches !== undefined && await this.#branches.isProtected(projectId, `nn-wip/${projectId}/${rest}`)) return { allowed: false, reason: `the owner protects this branch, so ${normal}` };
    return { allowed: true };
  }

  /**
   * The owner asks for a task's workspace to be put back from its backup branch. It restores exactly the last backup the remote CONFIRMED to this controller (a branch that is any other commit is refused by the host),
   * to the host that holds the task, into a place that never overwrites a live checkout (the host says where, in `where`). Works whether or not the backup is still on: reading back what is already on the owner's own
   * remote needs no standing approval for pushes. One record per command ID; asking again with the same ID returns the same answer without touching the host a second time.
   */
  async restore(owner: Principal, command: NoActor & { projectId: string; taskId: string }, port: Pick<WipBackupPort, "restore"> | undefined): Promise<{ restored: true; summary: string; where: string; commitId: string; files: number; baseFound: boolean; replayed: boolean }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not restore a project's work in progress`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "projectId", "taskId"].includes(k));
    if (unknown.length > 0) invalid(unknown[0]!, "is not a field of this command");
    const projectId = this.#project(command.projectId);
    if (typeof command.taskId !== "string" || !NAME.test(command.taskId)) invalid("taskId", "is not a task ID");
    const recordId = `wrs-${createHash("sha256").update(scopedCommandId(owner.id, command.commandId)).digest("hex").slice(0, 32)}`;
    const answerEarlier = (earlier: WipRestoreRecord): { restored: true; summary: string; where: string; commitId: string; files: number; baseFound: boolean; replayed: boolean } => {
      if (earlier.projectId !== projectId || earlier.taskId !== command.taskId) throw new DomainError("command_conflict", "this command ID was already used for another restore");
      // A claimed restore whose outcome is not recorded is never started again under the same command: it is still running, or the controller stopped while the host was restoring (whatever it made is on the host).
      if (earlier.pending === true) throw new DomainError("unavailable", "a restore under this command is already under way, or was interrupted by a restart before it reported back; it is not started a second time (ask again to try once more)");
      if (!earlier.ok) throw new DomainError("unavailable", earlier.reason ?? "the restore did not succeed");
      return { restored: true, summary: earlier.summary ?? "", where: earlier.where ?? "", commitId: earlier.commitId ?? "", files: earlier.files ?? 0, baseFound: earlier.baseFound === true, replayed: true };
    };
    const recorded = async (): Promise<WipRestoreRecord | undefined> => (await this.#runner.get(RESTORE, recordId))?.body as unknown as WipRestoreRecord | undefined;
    const earlier = await recorded();
    if (earlier !== undefined) return answerEarlier(earlier);
    const setting = (await this.#runner.get(SETTING, projectId))?.body as unknown as WipSettingBody | undefined;
    const state = (await this.#runner.get(STATE, command.taskId))?.body as unknown as WipStateBody | undefined;
    const fail = async (reason: string, code: "not_found" | "unavailable" = "unavailable"): Promise<never> => {
      await this.#recordRestore(recordId, owner, { projectId, taskId: command.taskId, ok: false, reason: plainText(reason, 300), at: this.#runner.now() }, command.taskId);
      throw new DomainError(code, plainText(reason, 300));
    };
    if (setting === undefined || state === undefined || state.projectId !== projectId || state.lastSuccess === undefined) return fail("there is no confirmed work-in-progress backup of this task to restore (a push that failed is never a backup)", "not_found");
    if (port?.restore === undefined) return fail("no host is set up to restore a backup here");
    // The command is claimed BEFORE the host is asked: the record is created once, so a second ask with the same ID (at the same moment, from another controller, or after a restart) finds it and never restores again.
    try { await this.#claimRestore(recordId, owner, { projectId, taskId: command.taskId, ok: false, pending: true, at: this.#runner.now() }); }
    catch (error) { const now = await recorded(); if (now !== undefined) return answerEarlier(now); throw error; }
    let outcome: WipRestoreOutcome;
    try { outcome = await port.restore({ projectId, taskId: command.taskId, remote: state.remote, ref: state.ref, expectCommit: state.lastSuccess.commitId, ...(setting.credential === undefined ? {} : { credential: setting.credential }) }); } catch (error) { outcome = { ok: false, reason: `the host could not restore: ${plainText((error as Error)?.message, 160)}` }; }
    if (!outcome.ok) return fail(outcome.reason);
    const d = outcome.detail;
    const body: WipRestoreRecord = { projectId, taskId: command.taskId, ok: true, at: this.#runner.now(), summary: plainText(outcome.summary, 300), where: plainText(d["where"], 300), commitId: typeof d["commitId"] === "string" && /^[0-9a-f]{40}$/.test(d["commitId"]) ? d["commitId"] : state.lastSuccess.commitId, files: typeof d["files"] === "number" ? d["files"] : 0, baseFound: d["baseFound"] === true };
    await this.#recordRestore(recordId, owner, body, command.taskId);
    return { restored: true, summary: body.summary!, where: body.where!, commitId: body.commitId!, files: body.files!, baseFound: body.baseFound === true, replayed: false };
  }

  /** Creates the restore record of a command; fails when one exists (another ask with the same command ID claimed it first). The command ID of this write is unique per ask, so a duplicate is never answered as if it were this one. */
  async #claimRestore(id: string, owner: Principal, body: WipRestoreRecord): Promise<void> {
    await this.#runner.command("wip-backup.restore-claim", { commandId: `wip-restore-claim-${id}-${randomBytes(8).toString("hex")}`, actor: owner.id }, async () => ({
      payload: { id, taskId: body.taskId },
      build: async () => {
        const ref = { kind: RESTORE, id };
        if ((await this.#runner.get(RESTORE, id)) !== undefined) throw new DomainError("command_conflict", "this restore command was already claimed");
        return { ref, creates: true, changes: [{ type: "create" as const, ref, body: body as unknown as JsonObject }], detail: { projectId: body.projectId, taskId: body.taskId, claimed: true } };
      },
    }));
  }

  async #recordRestore(id: string, owner: Principal, body: WipRestoreRecord, taskId: string): Promise<void> {
    await this.#runner.command("wip-backup.restore", { commandId: `wip-restore-${id}`, actor: owner.id }, async () => ({
      payload: { id, taskId },
      build: async () => {
        const ref = { kind: RESTORE, id };
        const found = await this.#runner.get(RESTORE, id);
        const change = found === undefined ? { type: "create" as const, ref, body: body as unknown as JsonObject } : { type: "update" as const, ref, expectedRevision: found.revision, body: body as unknown as JsonObject };
        return { ref, creates: found === undefined, changes: [change], detail: { projectId: body.projectId, taskId, ok: body.ok } };
      },
    }));
  }

  /** The names (never values) of the secrets the owners chose for pushing, so the host's scan can look for their values in files. */
  async credentialNames(): Promise<string[]> {
    const names = new Set<string>();
    let after: string | undefined;
    for (let page = 0; page < 50; page++) {
      const chunk = await this.#runner.list(SETTING, { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of chunk) { after = a.id; const c = (a.body as unknown as WipSettingBody).credential; if (typeof c === "string") names.add(c); }
      if (chunk.length < 200) break;
    }
    return [...names].sort();
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
        // An approval whose standing grant was revoked elsewhere pushes nothing and says nothing (the owner ended it); `get` shows it as off.
        if ((await this.#approvalProblem(a.id, setting.remote, setting)) !== undefined) continue;
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
      try { outcome = await options.port.backup({ projectId, taskId: task.taskId, remote: setting.remote, ref, developer: task.developer, executor: task.executor, ...(setting.credential === undefined ? {} : { credential: setting.credential }) }); } catch (error) { outcome = { ok: false, reason: `the host could not make the backup: ${plainText((error as Error)?.message, 160)}` }; }
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
