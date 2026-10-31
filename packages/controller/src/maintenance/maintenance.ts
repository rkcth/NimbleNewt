import { createHash, randomUUID } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, text } from "../domain/model.js";
import { CommandRunner, type Built, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import { canonicalJson } from "../storage/json.js";
import type { Aggregate, AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";

/**
 * Reviewed environment changes and maintenance requests (card A09). An agent asks for a change to its own environment (a package or extension, a mount, a network site, a skill draft, or a protected
 * thing); the request is recorded at once with a maintenance ID, reviewed by whoever the installation profile names, applied by the controller through an applier port with a recorded effect, revocable,
 * and logged (every command writes an audit entry). Nothing here installs anything itself: the `MaintenanceApplier` port does, and the default applier leaves every approved change pending.
 */
export type MaintenanceKind = "skill" | "package" | "extension" | "mount" | "network" | "host-policy" | "base";
export type MaintenanceClass = "skill-draft" | "dependency" | "access" | "protected";
export type MaintenanceStatus = "pending" | "approved" | "applying" | "applied" | "rejected" | "withdrawn" | "failed" | "revoking" | "revoked" | "apply-uncertain";
export type SiteRule = "allow" | "deny";

export const MAINTENANCE_LIMITS = { reason: 500, plan: 500, note: 300, pendingPerAgent: 20, sites: 200, catalogue: 200, listDefault: 50, listMax: 200, scan: 1000, driveBatch: 50, leaseMs: 1_800_000, attempts: 5, effectBytes: 4096, pendingReason: 300, requestsPerDay: 200, windowMs: 86_400_000, indexScan: 5000, staleKept: 5, leaseMinMs: 60_000, leaseMaxMs: 86_400_000 } as const;

const CLASS_OF: Readonly<Record<MaintenanceKind, MaintenanceClass>> = { skill: "skill-draft", package: "dependency", extension: "dependency", mount: "access", network: "access", "host-policy": "protected", base: "protected" };
const KINDS = Object.keys(CLASS_OF) as MaintenanceKind[];
/** A name has no '/', no '..', no leading '.' and no '@'. Only a package may carry the npm scope form `@scope/name`. */
const NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const PKG_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,60}\/)?[a-z0-9][a-z0-9._-]{0,99}$/;
/** Exact versions only: three numbers, optionally a pre-release and build part. No `latest`, no tag, no range. */
const VERSION = /^(?:0|[1-9]\d{0,9})\.(?:0|[1-9]\d{0,9})\.(?:0|[1-9]\d{0,9})(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,30})?(?:\+[0-9A-Za-z.-]{1,30})?$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SITE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** A site rule key: `host` (every port for a deny, port 443 for an allow), `host:port`, or for an allow `*.host` (subdomains) with an optional port. */
const SITE_KEY = /^(?:\*\.)?((?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})(?::([0-9]{1,5}))?$/;
const RESOURCE = /^[a-z][a-z0-9._-]{0,79}$/;
const MOUNT = /^\/[A-Za-z0-9._\/-]{0,198}$/;
const AGENT = /^agent:[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const REQ = "maintenance", SETTINGS: AggregateRef = { kind: "maintenance-settings", id: "main" }, OPEN = "maintenance-open", LIVE = "maintenance-live", RATE = "maintenance-rate";
const WIDENING: readonly MaintenanceKind[] = ["network", "mount", "package", "extension", "host-policy", "base"];
/** Kinds the owner may hand to supervisors (per kind, off by default). The protected kinds are never handed over. */
const BOSS_KINDS: readonly MaintenanceKind[] = ["package", "extension", "mount", "network"];
/** A source is an https URL without credentials. The message never repeats it (it may carry a secret). */
export function checkSource(v: unknown, field: string): string {
  const s = lone(v, field, 200);
  let u: URL;
  try { u = new URL(s); } catch { return bad(field, "must be an https URL"); }
  if (u.protocol !== "https:" || /[\s"'<>\\]/.test(s) || u.hostname === "") return bad(field, "must be an https URL without spaces");
  if (u.username !== "" || u.password !== "" || /^https:\/\/[^/?#]*@/i.test(s)) return bad(field, "must not carry a user name or password");
  return s;
}
/** The rule that counts for a site and port: a deny on a host (or on a parent domain) wins over an allow, a deny without a port covers every port, an allow is for the exact host (or its `*.` rule) and port 443 unless a port is named. */
export function siteRule(sites: Readonly<Record<string, SiteRule>> | undefined, host: string, port: number): SiteRule | undefined {
  if (sites === undefined) return undefined;
  let allow = false;
  for (const [key, rule] of Object.entries(sites)) {
    const m = SITE_KEY.exec(key); if (m === null) continue;
    const wild = key.startsWith("*."), base = m[1]!, kp = m[2] === undefined ? undefined : Number(m[2]);
    const hostHit = rule === "deny" ? host === base || host.endsWith(`.${base}`) : wild ? host.endsWith(`.${base}`) : host === base;
    if (!hostHit) continue;
    if (rule === "deny") { if (kp === undefined || kp === port) return "deny"; }
    else if ((kp ?? 443) === port) allow = true;
  }
  return allow ? "allow" : undefined;
}
const bad = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const sha = (v: unknown): string => `sha256:${createHash("sha256").update(canonicalJson(v as never)).digest("hex")}`;
const lone = (v: unknown, field: string, max: number, re?: RegExp): string => { const s = text(v, field, { min: 1, max }); return re !== undefined && !re.test(s) ? bad(field, "has a form that is not accepted") : s; };

/** What a request asks for, after checking: only these fields, in these forms. No host path, no free-form command and no capability grant can be carried by a spec. */
export type MaintenanceSpec = JsonObject;
const name = (v: unknown, field: string, re: RegExp): string => { const s = lone(v, field, 100, re); return s.includes("..") ? bad(field, "must not contain ..") : s; };
export function checkSpec(kind: MaintenanceKind, value: unknown): MaintenanceSpec {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return bad("spec", "must be an object");
  const s = value as Record<string, unknown>;
  switch (kind) {
    case "skill": onlyKnown(s, ["name", "digest"]); return { name: name(s["name"], "spec.name", NAME), digest: lone(s["digest"], "spec.digest", 80, DIGEST) };
    case "package": case "extension": {
      onlyKnown(s, ["name", "version", "digest", "source", "installScripts"]);
      if (typeof s["installScripts"] !== "boolean") bad("spec.installScripts", "say whether the package runs install scripts (true or false)");
      return { name: name(s["name"], "spec.name", kind === "package" ? PKG_NAME : NAME), version: lone(s["version"], "spec.version", 40, VERSION), digest: lone(s["digest"], "spec.digest", 80, DIGEST), source: checkSource(s["source"], "spec.source"), installScripts: s["installScripts"] as boolean };
    }
    case "mount": {
      onlyKnown(s, ["mountPath", "resource", "mode"]);
      const mountPath = lone(s["mountPath"], "spec.mountPath", 200, MOUNT);
      if (mountPath.split("/").some((p) => p === "..")) bad("spec.mountPath", "must not contain ..");
      if (s["mode"] !== "read" && s["mode"] !== "write") bad("spec.mode", "must be read or write");
      return { mountPath, resource: lone(s["resource"], "spec.resource", 80, RESOURCE), mode: s["mode"] as string };
    }
    case "network": {
      onlyKnown(s, ["site", "port"]);
      const port = s["port"] === undefined ? 443 : s["port"];
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) bad("spec.port", "must be a port from 1 to 65535");
      return { site: lone(typeof s["site"] === "string" ? s["site"].toLowerCase() : s["site"], "spec.site", 253, SITE), port: port as number };
    }
    case "host-policy": onlyKnown(s, ["setting", "change"]); return { setting: name(s["setting"], "spec.setting", NAME), change: redactText(lone(s["change"], "spec.change", 300)) };
    case "base": onlyKnown(s, ["change", "digest"]); return { change: redactText(lone(s["change"], "spec.change", 300)), ...(s["digest"] === undefined ? {} : { digest: lone(s["digest"], "spec.digest", 80, DIGEST) }) };
  }
}

export interface MaintenanceDecision { readonly by: string; readonly verdict: "approve" | "reject"; readonly via: "owner" | "supervisor" | "rule"; readonly rule?: string; readonly specDigest: string; readonly at: string; readonly note?: string }
export interface MaintenanceBody {
  readonly agentId: string; readonly kind: MaintenanceKind; readonly class: MaintenanceClass; readonly spec: MaintenanceSpec; readonly specDigest: string;
  readonly reason: string; readonly rollbackPlan?: string; readonly status: MaintenanceStatus; readonly requestedBy: string; readonly requestedAt: string;
  readonly decision?: MaintenanceDecision;
  /** The claim: only the holder of `token` may complete the application. `renewedAt` is the last heartbeat. */
  readonly applying?: { readonly epoch: number; readonly since: string; readonly renewedAt?: string; readonly attempts: number; readonly token: string };
  /** An application may have started and its outcome is not known (or the effect is not recorded yet): a revert or verify pass must run before the request moves on, and a revocation always calls revert. */
  readonly maybeApplied?: boolean;
  readonly uncertain?: { readonly reason: string; readonly at: string };
  /** Applications started and not finished cleanly (a throw or an expired claim): the request fails after a few. */
  readonly tries?: number;
  /** Results that arrived from a claim that no longer held (kept: the five most recent). */
  readonly stale?: readonly { readonly at: string; readonly outcome: string; readonly reconciled: string; readonly note: string }[];
  readonly effect?: JsonObject; readonly appliedAt?: string;
  readonly failure?: { readonly reason: string; readonly at: string; readonly rollback?: JsonObject };
  readonly pendingReason?: string;
  readonly revoke?: { readonly by: string; readonly at: string; readonly reason: string };
  readonly revertEffect?: JsonObject; readonly revokedAt?: string;
}
interface SettingsBody { readonly requests?: boolean; readonly bosses?: boolean; readonly rules?: boolean; readonly bossKinds?: readonly MaintenanceKind[]; readonly leaseMinutes?: number; readonly requestsPerDay?: number; readonly sites?: Readonly<Record<string, SiteRule>>; readonly catalogue?: readonly CatalogueEntry[]; readonly updatedBy: string; readonly updatedAt: string }
export interface CatalogueEntry { readonly name: string; readonly version: string; readonly digest: string; readonly source: string; readonly installScripts?: boolean }
export interface MaintenanceEffective { readonly requests: boolean; readonly bosses: boolean; readonly rules: boolean; readonly bossKinds: readonly MaintenanceKind[]; readonly leaseMs: number; readonly requestsPerDay: number }

/** What the applier is shown: the checked request, never the free text. */
export interface MaintenanceView { readonly id: string; readonly agentId: string; readonly kind: MaintenanceKind; readonly class: MaintenanceClass; readonly spec: MaintenanceSpec; readonly specDigest: string; readonly rollbackPlan?: string }
export type ApplyOutcome = { readonly outcome: "applied"; readonly effect: JsonObject } | { readonly outcome: "unsupported"; readonly reason: string } | { readonly outcome: "failed"; readonly reason: string; readonly rollback?: JsonObject };
export type RevertOutcome = { readonly outcome: "reverted"; readonly effect?: JsonObject } | { readonly outcome: "unsupported" | "failed"; readonly reason: string };
/**
 * Applies an approved change to the agent's environment: stage, trial in a disposable environment, suspend without release, checkpoint, restart, validate and restore, roll back on failure. Called only for an approved,
 * unchanged request and keyed by `view.id`: it MUST be safe to call again for the same ID (a restart or an expired claim may repeat it, idempotently); the controller prevents concurrent applications of one request
 * with a claim token, a heartbeat and a lease, but a lost claim cannot stop an application already running, so a stale result is discarded and reconciled by `revert`. Install scripts run inside the boundary and only here, after the approval.
 *
 * Package and extension requests: the applier MUST fetch only `spec.source` and MUST verify the fetched artifact against `spec.digest` (sha256 of the content the controller was told to expect) before anything is installed
 * or any install script runs, and MUST answer `failed` on a mismatch. The controller does not see the artifact; an applier that does not verify is not a valid applier.
 *
 * `unsupported` means nothing was changed and leaves the change pending (safe restoration is not possible now); `failed` means it rolled back; a throw means the state is UNKNOWN: the request becomes `apply-uncertain`
 * and `revert` is called (as a verify-and-restore pass) before the request moves on.
 */
export interface MaintenanceApplier {
  apply(view: MaintenanceView): Promise<ApplyOutcome>;
  revert(view: MaintenanceView, effect: JsonObject): Promise<RevertOutcome>;
}
/** The applier used when none is wired: nothing can be applied safely, so approved changes wait. */
export const noApplier: MaintenanceApplier = { apply: async () => ({ outcome: "unsupported", reason: "no environment applier is wired into this controller" }), revert: async () => ({ outcome: "unsupported", reason: "no environment applier is wired into this controller" }) };

export interface MaintenanceNotice { readonly maintenanceId: string; readonly agentId: string; readonly kind: MaintenanceKind; readonly class: MaintenanceClass; readonly to: "owner" | "supervisor"; readonly supervisorId?: string }

export interface MaintenanceOptions {
  readonly applier?: MaintenanceApplier; readonly notify?: (n: MaintenanceNotice) => Promise<void>;
  /** The claim heartbeat in milliseconds (default a third of the lease; 0 switches it off, for tests). */
  readonly heartbeatMs?: number;
  /** Whether the controller that holds a claim is known to be dead. Default: an older storage epoch is fenced out of storage, so it is dead. */
  readonly claimantDead?: (epoch: number, currentEpoch: number) => boolean;
}

const inputAgent = (v: unknown, field: string): string => { const s = typeof v === "string" ? v.trim() : ""; const id = s.startsWith("agent:") ? s : `agent:${s}`; return AGENT.test(id) ? id : bad(field, "must be an agent's principal ID such as agent:agt-..."); };
const openKey = (agentId: string): string => agentId.slice("agent:".length);

export class MaintenanceService {
  readonly #runner: CommandRunner;
  readonly #applier: MaintenanceApplier;
  readonly #notify: ((n: MaintenanceNotice) => Promise<void>) | undefined;
  readonly #inflight = new Set<Promise<unknown>>();
  readonly #options: MaintenanceOptions;
  /** Set when a setting narrowed something: the next `tick` re-judges what is already waiting or applied (settings writes never drive the applier themselves). */
  #dirty = false;

  private constructor(runner: CommandRunner, options: MaintenanceOptions) { this.#runner = runner; this.#applier = options.applier ?? noApplier; this.#notify = options.notify; this.#options = options; }
  static withEpoch(storage: ControllerStorage, epoch: number, options: MaintenanceOptions = {}, runnerOptions: RunnerOptions = {}): MaintenanceService { return new MaintenanceService(new CommandRunner(storage, epoch, runnerOptions), options); }

  /** An application started by a request that a rule approved runs after the maintenance ID is returned; this settles when those have finished (tests, shutdown). */
  async idle(): Promise<void> { while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]); }
  /** Runs work after the caller has its answer; `idle` waits for it. */
  background(p: Promise<unknown>): void { const q = p.catch(() => undefined).finally(() => this.#inflight.delete(q)); this.#inflight.add(q); }

  // ---- reading -------------------------------------------------------------------------------------------------------------------

  async #profile(): Promise<string> {
    try { return ((await this.#runner.get("approval-policy", "installation"))?.body as unknown as { profile?: string } | undefined)?.profile ?? "strict"; } catch { return "strict"; }
  }
  /** Settings as they count now. A record that cannot be read leaves only the owner (no supervisor, no rule), and the owner's own site denials are not known either, so requests wait for the owner. */
  async #settings(): Promise<{ readonly found: Aggregate | undefined; readonly body: SettingsBody | undefined; readonly eff: MaintenanceEffective; readonly readable: boolean }> {
    const profile = await this.#profile();
    try {
      const found = await this.#runner.get(SETTINGS.kind, SETTINGS.id);
      const body = found?.body as unknown as SettingsBody | undefined;
      return { found, body, readable: true, eff: { requests: body?.requests ?? true, bosses: body?.bosses ?? profile !== "strict", rules: body?.rules ?? true, bossKinds: body?.bossKinds ?? [], leaseMs: (body?.leaseMinutes ?? MAINTENANCE_LIMITS.leaseMs / 60_000) * 60_000, requestsPerDay: body?.requestsPerDay ?? MAINTENANCE_LIMITS.requestsPerDay } };
    } catch { return { found: undefined, body: undefined, readable: false, eff: { requests: true, bosses: false, rules: false, bossKinds: [], leaseMs: MAINTENANCE_LIMITS.leaseMs, requestsPerDay: MAINTENANCE_LIMITS.requestsPerDay } }; }
  }
  async #agent(id: string): Promise<{ state?: string; supervisorId?: string; createdBy?: string; supervisorSetBy?: string } | undefined> { return (await this.#runner.get("agent", id.slice("agent:".length)))?.body as unknown as { state?: string; supervisorId?: string; createdBy?: string; supervisorSetBy?: string } | undefined; }
  async #isSupervisorOf(by: Principal, agentId: string): Promise<boolean> {
    if (by.kind !== "agent" || !by.id.startsWith("agent:") || by.id === agentId) return false;
    const me = await this.#agent(by.id);
    const target = await this.#agent(agentId);
    return me?.state === "active" && target?.supervisorId === by.id.slice("agent:".length);
  }
  /**
   * Whether `by` may stand in for the owner as the requester's boss for this request: it is the requester's active supervisor, it did not create the requester or choose its supervisor (a manager cannot make puppets to approve for
   * itself), the owner has handed this kind to supervisors (`bossKinds`, off by default: every kind that widens the sandbox is the owner's otherwise), and a mount is for the requester's own resource (`<agent key>.name`) or a
   * shared one (`shared.name`) read-only: another agent's, the owner's and write access to a shared one are the owner's.
   */
  async #bossFor(by: Principal, b: MaintenanceBody, eff: MaintenanceEffective): Promise<boolean> {
    if (b.class === "protected" || by.taskScope !== undefined || !eff.bosses || !eff.bossKinds.includes(b.kind)) return false;
    if (!(await this.#isSupervisorOf(by, b.agentId))) return false;
    const target = await this.#agent(b.agentId);
    if (target?.createdBy === by.id || target?.supervisorSetBy === by.id) return false;
    if (b.kind === "mount") {
      const resource = String(b.spec["resource"]);
      const own = resource.startsWith(`${openKey(b.agentId)}.`), shared = resource.startsWith("shared.");
      if (!own && !(shared && b.spec["mode"] === "read")) return false;
    }
    return true;
  }
  #owner(by: Principal, what: string): void { if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not ${what}`); }

  async settings(owner: Principal): Promise<{ revision: number; set: Omit<SettingsBody, "updatedBy" | "updatedAt">; effective: MaintenanceEffective; profile: string }> {
    this.#owner(owner, "read the maintenance settings");
    const s = await this.#settings();
    if (!s.readable) throw new DomainError("integrity", "the maintenance settings record cannot be read");
    const { updatedBy: _a, updatedAt: _b, ...set } = s.body ?? ({} as SettingsBody);
    return { revision: s.found?.revision ?? 0, set, effective: s.eff, profile: await this.#profile() };
  }

  #view(id: string, b: MaintenanceBody): MaintenanceView { return { id, agentId: b.agentId, kind: b.kind, class: b.class, spec: b.spec, specDigest: b.specDigest, ...(b.rollbackPlan === undefined ? {} : { rollbackPlan: b.rollbackPlan }) }; }
  async #mayRead(by: Principal, b: MaintenanceBody): Promise<boolean> { return by.kind === "owner" || by.id === b.agentId || by.id === b.requestedBy || await this.#isSupervisorOf(by, b.agentId); }
  #shown(id: string, a: Aggregate): JsonObject { return { id, revision: a.revision, ...(a.body as unknown as JsonObject) }; }

  /** One request, in full: exactly what a reviewer needs (package version, source, access, install behaviour, rollback plan). The requester, its supervisor and the owner may read it; anyone else sees nothing. */
  async get(by: Principal, maintenanceId: string): Promise<JsonObject> {
    const a = await this.#runner.get(REQ, lone(maintenanceId, "maintenanceId", 80));
    if (a === undefined || !(await this.#mayRead(by, a.body as unknown as MaintenanceBody))) throw new DomainError("not_found", "no such maintenance request");
    return this.#shown(a.id, a);
  }

  async list(by: Principal, q: { status?: string; agentId?: string; afterId?: string; limit?: number } = {}): Promise<{ items: JsonObject[]; next?: string; scanLimited?: boolean }> {
    onlyKnown(q, ["status", "agentId", "afterId", "limit"]);
    const limit = q.limit === undefined ? MAINTENANCE_LIMITS.listDefault : Number.isInteger(q.limit) && q.limit >= 1 && q.limit <= MAINTENANCE_LIMITS.listMax ? q.limit : bad("limit", `must be a whole number from 1 to ${MAINTENANCE_LIMITS.listMax}`);
    if (q.status !== undefined && !["pending", "approved", "applying", "applied", "rejected", "withdrawn", "failed", "revoking", "revoked"].includes(q.status)) bad("status", "is not a status");
    const agent = q.agentId === undefined ? undefined : inputAgent(q.agentId, "agentId");
    const items: JsonObject[] = [];
    let after = q.afterId, scanned = 0, next: string | undefined;
    const cache = new Map<string, boolean>();
    while (items.length < limit && scanned < MAINTENANCE_LIMITS.scan) {
      const rows = await this.#runner.list(REQ, { ...(after === undefined ? {} : { afterId: after }), limit: Math.min(200, MAINTENANCE_LIMITS.scan - scanned) });
      if (rows.length === 0) { next = undefined; break; }
      for (const r of rows) {
        scanned++; after = r.id; next = r.id;
        const b = r.body as unknown as MaintenanceBody;
        if ((q.status !== undefined && b.status !== q.status) || (agent !== undefined && b.agentId !== agent)) continue;
        let seen = by.kind === "owner" || by.id === b.agentId || by.id === b.requestedBy;
        if (!seen) { if (!cache.has(b.agentId)) cache.set(b.agentId, await this.#isSupervisorOf(by, b.agentId)); seen = cache.get(b.agentId)!; }
        if (!seen) continue;
        items.push(this.#shown(r.id, r));
        if (items.length >= limit) break;
      }
      if (rows.length < 200) { if (items.length < limit) next = undefined; break; }
    }
    return { items, ...(next === undefined ? {} : { next }), ...(next !== undefined && scanned >= MAINTENANCE_LIMITS.scan && items.length < limit ? { scanLimited: true } : {}) };
  }

  // ---- requesting ----------------------------------------------------------------------------------------------------------------

  /**
   * An agent asks for a change to its own environment (the owner may ask for any agent's). The answer is the maintenance ID, at once, before anything is decided or applied. Whether it is approved by a rule (a skill draft,
   * a preapproved catalogue entry, a site the owner allowed), rejected by one (a site the owner denied) or waits for a decider depends on the installation profile and the owner's settings. At most
   * `pendingPerAgent` requests of one agent wait at the same time.
   */
  async request(by: Principal, command: NoActor & { agentId?: string; kind: string; spec: unknown; reason: string; rollbackPlan?: string }): Promise<{ maintenanceId: string; status: MaintenanceStatus; revision: number; replayed: boolean }> {
    onlyKnown(command, ["commandId", "agentId", "kind", "spec", "reason", "rollbackPlan"]);
    if (by.kind !== "owner" && by.kind !== "agent") throw new DomainError("forbidden", `${by.id} may not ask for an environment change`);
    const agentId = command.agentId === undefined ? (by.kind === "agent" ? by.id : bad("agentId", "name the agent whose environment changes")) : inputAgent(command.agentId, "agentId");
    if (by.kind === "agent" && agentId !== by.id) throw new DomainError("forbidden", `${by.id} may ask for changes to its own environment only`);
    if (!(KINDS as string[]).includes(command.kind)) bad("kind", `must be one of ${KINDS.join(", ")}`);
    const kind = command.kind as MaintenanceKind;
    const spec = checkSpec(kind, command.spec);
    const reason = redactText(text(command.reason, "reason", { min: 1, max: MAINTENANCE_LIMITS.reason }));
    const cls = CLASS_OF[kind];
    if (cls !== "skill-draft" && command.rollbackPlan === undefined) bad("rollbackPlan", "say how the change is undone");
    const rollbackPlan = command.rollbackPlan === undefined ? undefined : redactText(text(command.rollbackPlan, "rollbackPlan", { min: 1, max: MAINTENANCE_LIMITS.plan }));
    const specDigest = sha({ agentId, kind, spec, rollbackPlan: rollbackPlan ?? null });
    const commandId = scopedCommandId(by.id, command.commandId);
    const id = derivedId("mnt", commandId);
    const ref: AggregateRef = { kind: REQ, id };
    let notice: MaintenanceNotice | undefined;
    const result = await this.#runner.command("maintenance.request", { commandId, actor: by.id }, async () => ({
      payload: { agentId, kind, spec, reason, rollbackPlan: rollbackPlan ?? null },
      build: async (): Promise<Built> => {
        const agent = await this.#agent(agentId);
        if (agent === undefined || agent.state !== "active") throw new DomainError("not_found", "no such active agent");
        const s = await this.#settings();
        if (by.kind === "agent" && !s.eff.requests) throw new DomainError("forbidden", "maintenance requests are switched off by the owner");
        const now = this.#runner.now();
        const auto = this.#autoDecision(kind, cls, spec, s);
        const base = { agentId, kind, class: cls, spec, specDigest, reason, ...(rollbackPlan === undefined ? {} : { rollbackPlan }), requestedBy: by.id, requestedAt: now } as const;
        const changes: Change[] = [];
        if (by.kind === "agent") changes.push(await this.#rateChange(agentId, now, s.eff.requestsPerDay));
        let body: MaintenanceBody;
        if (auto !== undefined) body = { ...base, status: auto.verdict === "approve" ? ("approved" as const) : ("rejected" as const), decision: { by: "controller", verdict: auto.verdict, via: "rule", rule: auto.rule, specDigest, at: now } };
        else {
          const idx = await this.#runner.get(OPEN, openKey(agentId));
          const open = (idx?.body as unknown as { open?: number } | undefined)?.open ?? 0;
          if (open >= MAINTENANCE_LIMITS.pendingPerAgent) throw new DomainError("invalid_command", `${agentId} already has ${open} requests waiting for a decision; wait for them to be decided or withdraw some`, { field: "agentId" });
          changes.push(idx === undefined ? { type: "create", ref: { kind: OPEN, id: openKey(agentId) }, body: { open: open + 1 } } : { type: "update", ref: { kind: OPEN, id: openKey(agentId) }, expectedRevision: idx.revision, body: { open: open + 1 } });
          body = { ...base, status: "pending" };
          const toBoss = cls !== "protected" && s.eff.bosses && s.eff.bossKinds.includes(kind) && agent.supervisorId !== undefined;
          notice = { maintenanceId: id, agentId, kind, class: cls, to: toBoss ? "supervisor" : "owner", ...(toBoss ? { supervisorId: `agent:${agent.supervisorId}` } : {}) };
        }
        changes.unshift({ type: "create", ref, body: body as unknown as JsonObject });
        changes.push(...(await this.#indexChanges(id, body)));
        return { ref, creates: true, changes, detail: { agentId, kind, class: cls, status: body.status, specDigest, ...(auto === undefined ? {} : { rule: auto.rule }) }, contention: async () => new DomainError("stale_revision", "another request of this agent was made at the same moment; ask again") };
      },
    }));
    if (!result.replayed && notice !== undefined && this.#notify !== undefined) await this.#notify(notice).catch(() => undefined);
    const a = await this.#runner.get(REQ, id);
    const status = (a?.body as unknown as MaintenanceBody | undefined)?.status ?? "pending";
    if (!result.replayed && status === "approved") this.background(this.drive(id));
    return { maintenanceId: id, status, revision: result.revision, replayed: result.replayed };
  }

  /** The owner's standing rules, applied at request time: a skill draft is allowed (and recorded); a preapproved catalogue entry (exact name, version and digest) and an allowed site are approved; a denied site is rejected. */
  #autoDecision(kind: MaintenanceKind, cls: MaintenanceClass, spec: MaintenanceSpec, s: { readonly body: SettingsBody | undefined; readonly eff: MaintenanceEffective; readonly readable: boolean }): { verdict: "approve" | "reject"; rule: string } | undefined {
    if (!s.readable) return undefined;
    if (cls === "skill-draft") return { verdict: "approve", rule: "skill-draft" };
    if (kind === "network") {
      const rule = siteRule(s.body?.sites, spec["site"] as string, spec["port"] as number);
      if (rule === "deny") return { verdict: "reject", rule: "site-deny" };
      if (rule === "allow" && s.eff.rules) return { verdict: "approve", rule: "site-allow" };
    }
    if ((kind === "package" || kind === "extension") && s.eff.rules && (s.body?.catalogue ?? []).some((e) => e.name === spec["name"] && e.version === spec["version"] && e.digest === spec["digest"] && e.source === spec["source"] && (spec["installScripts"] !== true || e.installScripts === true))) return { verdict: "approve", rule: "catalogue" };
    return undefined;
  }

  // ---- deciding ------------------------------------------------------------------------------------------------------------------

  async #decider(by: Principal, b: MaintenanceBody, eff: MaintenanceEffective): Promise<"owner" | "supervisor"> {
    if (by.kind === "owner") return "owner";
    // A supervisor role alone never reaches the protected base or host policy, nor any kind the owner has not handed over; a task credential never decides; nobody decides their own request.
    if (by.id === b.agentId || by.id === b.requestedBy || !(await this.#bossFor(by, b, eff))) throw new DomainError("forbidden", `${by.id} may not decide this maintenance request`);
    return "supervisor";
  }

  /**
   * The decider approves or rejects a request that waits. The verdict is bound to the exact request: `specDigest` must be the digest the reviewer saw (package version, source, access, install behaviour, rollback plan).
   * Strict profile: the owner; otherwise (owner's switch `bosses`) also the requester's supervisor, except for host policy and the shared base, which are the owner's. Approval starts the application.
   */
  async decide(by: Principal, command: NoActor & { maintenanceId: string; verdict: string; specDigest: string; note?: string; expectedRevision?: number }): Promise<{ revision: number; status: MaintenanceStatus }> {
    onlyKnown(command, ["commandId", "maintenanceId", "verdict", "specDigest", "note", "expectedRevision"]);
    const verdict: "approve" | "reject" = command.verdict === "approve" || command.verdict === "reject" ? command.verdict : bad("verdict", "must be approve or reject");
    const id = lone(command.maintenanceId, "maintenanceId", 80), digest = lone(command.specDigest, "specDigest", 80, DIGEST);
    const note = command.note === undefined ? undefined : redactText(text(command.note, "note", { min: 1, max: MAINTENANCE_LIMITS.note }));
    this.#expected(command.expectedRevision);
    const ref: AggregateRef = { kind: REQ, id };
    const result = await this.#runner.command("maintenance.decide", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { maintenanceId: id, verdict, specDigest: digest, note: note ?? null, expectedRevision: command.expectedRevision ?? null },
      build: async (): Promise<Built> => {
        const found = await this.#runner.get(REQ, id);
        if (found === undefined || !(await this.#mayRead(by, found.body as unknown as MaintenanceBody))) throw new DomainError("not_found", "no such maintenance request");
        const b = found.body as unknown as MaintenanceBody;
        if (command.expectedRevision !== undefined && found.revision !== command.expectedRevision) throw new DomainError("stale_revision", `the request is at revision ${found.revision}, not ${command.expectedRevision}`, { currentRevision: found.revision });
        const s = await this.#settings();
        const via = await this.#decider(by, b, s.eff);
        if (b.status !== "pending") throw new DomainError("invalid_transition", `the request is ${b.status}, not waiting for a decision`);
        if (digest !== b.specDigest) bad("specDigest", "is not the digest of this request as recorded: read the request again before deciding");
        if (verdict === "approve" && b.kind === "network" && s.readable && siteRule(s.body?.sites, b.spec["site"] as string, b.spec["port"] as number) === "deny") throw new DomainError("forbidden", "the owner denied this site; clear the site's rule first");
        const now = this.#runner.now();
        const next: MaintenanceBody = { ...b, status: verdict === "approve" ? "approved" : "rejected", decision: { by: by.id, verdict, via, specDigest: digest, at: now, ...(note === undefined ? {} : { note }) } };
        const idx = await this.#indexChanges(id, next);
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }, ...(await this.#closePending(b.agentId)), ...idx], audit: this.#removed(idx), detail: { verdict, via, agentId: b.agentId, kind: b.kind, specDigest: digest } };
      },
    }));
    const status = ((await this.#runner.get(REQ, id))?.body as unknown as MaintenanceBody).status;
    if (!result.replayed && verdict === "approve") await this.drive(id).catch(() => undefined);
    return { revision: result.revision, status: ((await this.#runner.get(REQ, id))?.body as unknown as MaintenanceBody | undefined)?.status ?? status };
  }

  async #closePending(agentId: string): Promise<Change[]> {
    const idx = await this.#runner.get(OPEN, openKey(agentId));
    const open = (idx?.body as unknown as { open?: number } | undefined)?.open ?? 0;
    return idx === undefined ? [] : [{ type: "update", ref: { kind: OPEN, id: openKey(agentId) }, expectedRevision: idx.revision, body: { open: Math.max(0, open - 1) } }];
  }
  /** Keeps the index of requests that still need the controller (to be driven, or applied network changes a denial can revoke) in step with the record; the scans read this index, never the hash-ordered request list. */
  async #indexChanges(id: string, after: MaintenanceBody): Promise<Change[]> {
    const cur = await this.#runner.get(LIVE, id);
    const want = (["approved", "applying", "revoking", "apply-uncertain"] as string[]).includes(after.status) || (after.kind === "network" && after.status === "applied");
    if (want && cur === undefined) return [{ type: "create", ref: { kind: LIVE, id }, body: { agentId: after.agentId } }];
    if (!want && cur !== undefined) return [{ type: "delete", ref: { kind: LIVE, id }, expectedRevision: cur.revision }];
    return [];
  }
  /** A removal of an index entry carries an audit entry for its subject. */
  #removed(changes: readonly Change[]): NonNullable<Built["audit"]> { return changes.filter((c) => c.type === "delete").map((c) => ({ type: "maintenance.live-removed", subject: c.ref, detail: {} })); }
  /** One agent's requests in a window, whatever their kind and however they were decided (the owner is exempt). */
  async #rateChange(agentId: string, now: string, limit: number): Promise<Change> {
    const cur = await this.#runner.get(RATE, openKey(agentId));
    const b = cur?.body as unknown as { since?: string; count?: number } | undefined;
    const fresh = b?.since === undefined || Date.parse(now) - Date.parse(b.since) >= MAINTENANCE_LIMITS.windowMs;
    const count = fresh ? 0 : b?.count ?? 0;
    if (count >= limit) throw new DomainError("forbidden", `${agentId} has made ${count} environment requests in this day; the limit is ${limit} (the owner can raise it)`, { field: "agentId" });
    const body = { since: fresh ? now : b!.since!, count: count + 1 };
    return cur === undefined ? { type: "create", ref: { kind: RATE, id: openKey(agentId) }, body } : { type: "update", ref: { kind: RATE, id: openKey(agentId) }, expectedRevision: cur.revision, body };
  }
  #expected(v: unknown): void { if (v !== undefined && (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)) bad("expectedRevision", "must be a whole number"); }

  // ---- revoking ------------------------------------------------------------------------------------------------------------------

  /**
   * Takes a change back. A waiting or approved request is ended (the requester may withdraw its own); an applied one is reverted by the applier and recorded. The owner may revoke any; the requester's supervisor may
   * revoke what a supervisor may decide. A request being applied right now is reverted as soon as the application ends.
   */
  async revoke(by: Principal, command: NoActor & { maintenanceId: string; reason: string; expectedRevision?: number }): Promise<{ revision: number; status: MaintenanceStatus }> {
    onlyKnown(command, ["commandId", "maintenanceId", "reason", "expectedRevision"]);
    const id = lone(command.maintenanceId, "maintenanceId", 80);
    const reason = redactText(text(command.reason, "reason", { min: 1, max: MAINTENANCE_LIMITS.note }));
    this.#expected(command.expectedRevision);
    const ref: AggregateRef = { kind: REQ, id };
    const result = await this.#runner.command("maintenance.revoke", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { maintenanceId: id, reason, expectedRevision: command.expectedRevision ?? null },
      build: async (): Promise<Built> => {
        const found = await this.#runner.get(REQ, id);
        if (found === undefined || !(await this.#mayRead(by, found.body as unknown as MaintenanceBody))) throw new DomainError("not_found", "no such maintenance request");
        const b = found.body as unknown as MaintenanceBody;
        if (command.expectedRevision !== undefined && found.revision !== command.expectedRevision) throw new DomainError("stale_revision", `the request is at revision ${found.revision}, not ${command.expectedRevision}`, { currentRevision: found.revision });
        const now = this.#runner.now();
        const requesterWithdraws = (by.id === b.agentId || by.id === b.requestedBy) && by.kind !== "owner" && (b.status === "pending" || b.status === "approved");
        if (!requesterWithdraws) { const s = await this.#settings(); await this.#decider(by, b, s.eff); }
        const revoke = { by: by.id, at: now, reason };
        let next: MaintenanceBody;
        const extra: Change[] = [];
        switch (b.status) {
          case "pending": next = b.maybeApplied === true ? { ...b, status: "revoking", revoke } : { ...b, status: "withdrawn", revoke }; extra.push(...(await this.#closePending(b.agentId))); break;
          // An application may have started (an earlier try that ended unclearly): revert is always called then.
          case "approved": next = b.maybeApplied === true ? { ...b, status: "revoking", revoke } : { ...b, status: "revoked", revoke, revokedAt: now }; break;
          case "applying": if (b.revoke !== undefined) throw new DomainError("invalid_transition", "a revocation is already waiting for the application to end"); next = { ...b, revoke }; break;
          case "applied": case "apply-uncertain": next = { ...b, status: "revoking", revoke }; break;
          default: throw new DomainError("invalid_transition", `the request is already ${b.status}`);
        }
        const idx = await this.#indexChanges(id, next);
        extra.push(...idx);
        return { ref, creates: false, audit: this.#removed(idx), changes: [{ type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }, ...extra], detail: { agentId: b.agentId, kind: b.kind, from: b.status, by: by.id } };
      },
    }));
    await this.drive(id).catch(() => undefined);
    const b = (await this.#runner.get(REQ, id))?.body as unknown as MaintenanceBody;
    return { revision: result.revision, status: b.status };
  }

  // ---- applying ------------------------------------------------------------------------------------------------------------------

  async #move(found: Aggregate, type: string, next: MaintenanceBody, detail: JsonObject = {}, extra: Change[] = []): Promise<Aggregate | undefined> {
    const ref: AggregateRef = { kind: REQ, id: found.id };
    try {
      await this.#runner.command(type, { commandId: `${type}:${found.id}:${found.revision}:${randomUUID()}`, actor: "maintenance" }, async () => ({
        payload: { id: found.id, from: found.revision },
        build: async (): Promise<Built> => { const idx = await this.#indexChanges(found.id, next); return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }, ...extra, ...idx], audit: this.#removed(idx), detail: { agentId: next.agentId, kind: next.kind, status: next.status, ...detail } }; },
      }));
    } catch (e) { if (e instanceof DomainError && (e.code === "stale_revision" || e.code === "command_conflict")) return undefined; throw e; }
    return this.#runner.get(REQ, found.id);
  }

  /** Whether an approval still stands: a rule approval needs its rule, a supervisor approval needs the supervisor's standing, and a site the owner has denied since is refused. */
  async #standing(b: MaintenanceBody, s: { readonly body: SettingsBody | undefined; readonly eff: MaintenanceEffective; readonly readable: boolean }): Promise<"ok" | "lapsed" | "denied" | "gone"> {
    const agent = await this.#agent(b.agentId);
    if (agent?.state !== "active") return "gone";
    if (b.kind === "network" && s.readable && siteRule(s.body?.sites, b.spec["site"] as string, b.spec["port"] as number) === "deny") return "denied";
    const d = b.decision;
    if (d === undefined || d.verdict !== "approve" || d.specDigest !== b.specDigest || sha({ agentId: b.agentId, kind: b.kind, spec: b.spec, rollbackPlan: b.rollbackPlan ?? null }) !== b.specDigest) return "lapsed";
    if (d.via === "supervisor") return await this.#bossFor({ id: d.by, kind: "agent" } as Principal, b, s.eff) ? "ok" : "lapsed";
    if (d.via === "rule") { const again = this.#autoDecision(b.kind, b.class, b.spec, s); return again?.verdict === "approve" && again.rule === d.rule ? "ok" : "lapsed"; }
    return "ok";
  }

  /** Whether the claim in `b` still holds: its lease (renewed by the heartbeat) has not run out, or its holder is known dead only when the lease has not run out and the controller that held it is gone. */
  #claimHeld(b: MaintenanceBody, now: string, leaseMs: number): boolean {
    const c = b.applying;
    if (b.status !== "applying" || c === undefined) return false;
    if (Date.parse(now) - Date.parse(c.renewedAt ?? c.since) >= leaseMs) return false;
    if (c.epoch === this.#runner.epoch) return true;
    return !(this.#options.claimantDead ?? ((old, current) => old < current))(c.epoch, this.#runner.epoch);
  }

  /**
   * Drives one request as far as it can go now: an approved request is applied (claimed first with a token, so two drivers cannot both complete), a request being reverted is reverted, an uncertain one is
   * verified/reverted first. Safe to call at any time and any number of times; a request another driver holds (a live lease) is left alone, and one that cannot be applied now stays pending with the reason.
   */
  async drive(id: string): Promise<MaintenanceStatus | undefined> {
    for (let round = 0; round < 6; round++) {
      const found = await this.#runner.get(REQ, id);
      if (found === undefined) return undefined;
      const b = found.body as unknown as MaintenanceBody;
      const now = this.#runner.now();
      if (b.status === "revoking") {
        if (b.effect === undefined && b.maybeApplied !== true) { await this.#move(found, "maintenance.revoked", { ...b, status: "revoked", revokedAt: now }); continue; }
        let out: RevertOutcome;
        try { out = await this.#applier.revert(this.#view(id, b), b.effect ?? { uncertain: true }); } catch (e) { out = { outcome: "unsupported", reason: `the applier is not available: ${redactText(String((e as Error).message ?? e)).slice(0, 150)}` }; }
        const { pendingReason: _p, maybeApplied: _m, ...rest } = b;
        const moved = out.outcome === "reverted" ? await this.#move(found, "maintenance.revoked", { ...rest, status: "revoked", revokedAt: now, ...(out.effect === undefined ? {} : { revertEffect: this.#effect(out.effect) }) }) : await this.#move(found, "maintenance.revert-pending", { ...b, pendingReason: redactText(out.reason).slice(0, MAINTENANCE_LIMITS.pendingReason) });
        return (moved?.body as unknown as MaintenanceBody | undefined)?.status ?? b.status;
      }
      if (b.status === "apply-uncertain") {
        // The state after a throw is unknown: nothing moves on until a revert (verify and restore) pass has run.
        let out: RevertOutcome;
        try { out = await this.#applier.revert(this.#view(id, b), b.effect ?? { uncertain: true }); } catch (e) { out = { outcome: "unsupported", reason: `the applier is not available: ${redactText(String((e as Error).message ?? e)).slice(0, 150)}` }; }
        const { pendingReason: _p, maybeApplied: _m, uncertain: _u, applying: _a, ...rest } = b; // `tries` stays: a request that keeps ending unclearly fails after a few tries
        if (out.outcome === "reverted") await this.#move(found, "maintenance.reconciled", b.revoke === undefined ? { ...rest, status: "approved", pendingReason: "an earlier application ended unclearly; the environment was restored, so it is tried again" } : { ...rest, status: "revoked", revokedAt: now, ...(out.effect === undefined ? {} : { revertEffect: this.#effect(out.effect) }) });
        else { await this.#move(found, "maintenance.uncertain-pending", { ...b, pendingReason: redactText(out.reason).slice(0, MAINTENANCE_LIMITS.pendingReason) }); return "apply-uncertain"; }
        return b.revoke === undefined ? "approved" : "revoked";
      }
      if (b.status !== "approved" && b.status !== "applying") return b.status;
      const s = await this.#settings();
      if (this.#claimHeld(b, now, s.eff.leaseMs)) return b.status;
      const standing = await this.#standing(b, s);
      if (standing !== "ok") {
        // An application that may have started (an expired claim, an earlier try) is reverted before anything is decided about the request; it is not just sent back.
        const maybe = b.maybeApplied === true || b.applying !== undefined;
        const { applying: _x, ...r } = b;
        const next: MaintenanceBody = maybe ? { ...r, maybeApplied: true, status: "revoking", revoke: { by: "controller", at: now, reason: standing === "lapsed" ? "the approval no longer stands" : standing === "denied" ? "the site was denied after the approval" : "the agent is no longer active" }, pendingReason: standing === "lapsed" ? "the approval no longer stands; an application may have started, so it is being reverted" : "a denied or gone request had an application that may have started; it is being reverted" }
          : standing === "lapsed" ? { ...r, status: "pending" as const, pendingReason: "the approval no longer stands; it needs a new decision" }
          : { ...r, status: "rejected" as const, pendingReason: standing === "denied" ? "the site was denied after the approval" : "the agent is no longer active" };
        await this.#move(found, "maintenance.lapsed", next, { standing }, standing === "lapsed" && !maybe ? await this.#reopen(b.agentId) : []);
        continue;
      }
      const attempts = (b.applying?.attempts ?? b.tries ?? 0) + 1;
      if (attempts > MAINTENANCE_LIMITS.attempts) { const { applying: _x, ...r } = b; await this.#move(found, "maintenance.failed", { ...r, status: "failed", failure: { reason: "the application did not finish after several tries; its effect is unknown", at: now } }); return "failed"; }
      // The claim write also checks the settings revision seen by the standing check: a denial written in between makes the claim fail and the loop judge again.
      const guard: Change[] = s.found === undefined ? [] : [{ type: "check", ref: SETTINGS, expectedRevision: s.found.revision }];
      const claimed = await this.#move(found, "maintenance.claim", { ...b, status: "applying", maybeApplied: true, tries: attempts, applying: { epoch: this.#runner.epoch, since: now, renewedAt: now, attempts, token: randomUUID() } }, {}, guard);
      if (claimed === undefined) continue;
      return this.#applyClaimed(claimed, s.eff.leaseMs);
    }
    return undefined;
  }
  async #reopen(agentId: string): Promise<Change[]> {
    const idx = await this.#runner.get(OPEN, openKey(agentId));
    const open = (idx?.body as unknown as { open?: number } | undefined)?.open ?? 0;
    return [idx === undefined ? { type: "create", ref: { kind: OPEN, id: openKey(agentId) }, body: { open: open + 1 } } : { type: "update", ref: { kind: OPEN, id: openKey(agentId) }, expectedRevision: idx.revision, body: { open: open + 1 } }];
  }
  #effect(v: JsonObject): JsonObject {
    const t = canonicalJson(v as never);
    if (t.length > MAINTENANCE_LIMITS.effectBytes) return { truncated: true, bytes: t.length };
    return JSON.parse(redactText(t)) as JsonObject;
  }

  /** Renews the lease of the claim `token` holds (the heartbeat while the applier runs). A claim that no longer holds is left alone. */
  async #renew(id: string, token: string): Promise<void> {
    for (let i = 0; i < 4; i++) {
      const found = await this.#runner.get(REQ, id);
      const b = found?.body as unknown as MaintenanceBody | undefined;
      if (found === undefined || b === undefined || b.status !== "applying" || b.applying?.token !== token) return;
      if (await this.#move(found, "maintenance.renew", { ...b, applying: { ...b.applying, renewedAt: this.#runner.now() } }) !== undefined) return;
    }
  }

  async #applyClaimed(claimed: Aggregate, leaseMs: number): Promise<MaintenanceStatus> {
    const b = claimed.body as unknown as MaintenanceBody;
    const token = b.applying!.token;
    type Out = ApplyOutcome | { readonly outcome: "uncertain"; readonly reason: string };
    let out: Out;
    const beat = this.#options.heartbeatMs ?? Math.max(1000, Math.floor(leaseMs / 3));
    const timer = beat > 0 ? setInterval(() => { void this.#renew(claimed.id, token).catch(() => undefined); }, beat) : undefined;
    timer?.unref();
    try { out = await this.#applier.apply(this.#view(claimed.id, b)); } catch (e) { out = { outcome: "uncertain", reason: `the applier threw; the state is unknown: ${redactText(String((e as Error).message ?? e)).slice(0, 150)}` }; } finally { if (timer !== undefined) clearInterval(timer); }
    for (let i = 0; i < 6; i++) {
      const found = await this.#runner.get(REQ, claimed.id);
      const cur = found?.body as unknown as MaintenanceBody | undefined;
      if (found === undefined || cur === undefined) return "failed";
      // Only the holder of the claim completes it. A result from a claim that was lost (the lease ran out, the request moved on) is discarded, recorded, and reconciled.
      if (cur.status !== "applying" || cur.applying?.token !== token) return this.#stale(claimed.id, out);
      const now = this.#runner.now();
      const { applying: _x, pendingReason: _p, maybeApplied: _m, tries: _t, ...rest } = cur;
      let next: MaintenanceBody;
      if (out.outcome === "applied") next = { ...rest, status: cur.revoke === undefined ? "applied" : "revoking", effect: this.#effect(out.effect), appliedAt: now };
      else if (out.outcome === "failed") next = { ...rest, status: "failed", failure: { reason: redactText(out.reason).slice(0, MAINTENANCE_LIMITS.pendingReason), at: now, ...(out.rollback === undefined ? {} : { rollback: this.#effect(out.rollback) }) } };
      else if (out.outcome === "uncertain") next = { ...rest, maybeApplied: true, ...(cur.tries === undefined ? {} : { tries: cur.tries }), status: "apply-uncertain", uncertain: { reason: redactText(out.reason).slice(0, MAINTENANCE_LIMITS.pendingReason), at: now }, pendingReason: redactText(out.reason).slice(0, MAINTENANCE_LIMITS.pendingReason) };
      else next = cur.revoke === undefined ? { ...rest, status: "approved", pendingReason: redactText(out.reason).slice(0, MAINTENANCE_LIMITS.pendingReason) } : { ...rest, status: "revoked", revokedAt: now };
      const moved = await this.#move(found, "maintenance.finish", next, { outcome: out.outcome });
      if (moved !== undefined) {
        const st = (moved.body as unknown as MaintenanceBody).status;
        if (st === "revoking" || st === "apply-uncertain") await this.drive(claimed.id).catch(() => undefined);
        else if (st === "applied") await this.#recheckSite(claimed.id);
        return ((await this.#runner.get(REQ, claimed.id))?.body as unknown as MaintenanceBody | undefined)?.status ?? st;
      }
    }
    return "applying";
  }

  /** The applier answered for a claim that no longer holds. The result never overwrites the record; it is recorded as a stale apply result and the effect is reconciled: where the request is not live any more, `revert` is called for it. */
  async #stale(id: string, out: ApplyOutcome | { readonly outcome: "uncertain"; readonly reason: string }): Promise<MaintenanceStatus> {
    for (let i = 0; i < 6; i++) {
      const found = await this.#runner.get(REQ, id);
      const cur = found?.body as unknown as MaintenanceBody | undefined;
      if (found === undefined || cur === undefined) return "failed";
      const live = cur.status === "applying" || cur.status === "applied" || cur.status === "revoking" || cur.status === "apply-uncertain";
      const effectful = out.outcome === "applied" || out.outcome === "uncertain";
      let reconciled = live ? "left to the current claim" : "nothing to undo";
      if (!live && effectful) {
        let r: RevertOutcome;
        try { r = await this.#applier.revert(this.#view(id, cur), out.outcome === "applied" ? out.effect : { uncertain: true }); } catch (e) { r = { outcome: "unsupported", reason: String((e as Error).message ?? e) }; }
        reconciled = r.outcome === "reverted" ? "reverted" : "revert pending";
      }
      const note = { at: this.#runner.now(), outcome: out.outcome, reconciled, note: "stale apply result" };
      const stale = [...(cur.stale ?? []), note].slice(-MAINTENANCE_LIMITS.staleKept);
      const next: MaintenanceBody = { ...cur, stale, ...(reconciled === "revert pending" ? { maybeApplied: true } : {}) };
      if ((await this.#move(found, "maintenance.stale-result", next, { reconciled })) !== undefined) return cur.status;
    }
    return "applying";
  }

  /** After an application: a denial written while it ran counts at once. */
  async #recheckSite(id: string): Promise<void> {
    const found = await this.#runner.get(REQ, id);
    const b = found?.body as unknown as MaintenanceBody | undefined;
    if (found === undefined || b === undefined || b.kind !== "network" || b.status !== "applied") return;
    const s = await this.#settings();
    if (!s.readable || siteRule(s.body?.sites, b.spec["site"] as string, b.spec["port"] as number) !== "deny") return;
    const moved = await this.#move(found, "maintenance.revoke-by-rule", { ...b, status: "revoking", revoke: { by: "controller", at: this.#runner.now(), reason: "the owner denied this site" } });
    if (moved !== undefined) await this.drive(id).catch(() => undefined);
  }

  /** Applies one approved request now (the owner's retry of a change that waited because the applier could not take it). */
  async apply(owner: Principal, command: NoActor & { maintenanceId: string }): Promise<{ status: MaintenanceStatus }> {
    this.#owner(owner, "apply a maintenance request");
    onlyKnown(command, ["commandId", "maintenanceId"]);
    const id = lone(command.maintenanceId, "maintenanceId", 80);
    if ((await this.#runner.get(REQ, id)) === undefined) throw new DomainError("not_found", "no such maintenance request");
    return { status: (await this.drive(id)) ?? "failed" };
  }

  /** The requests that need the controller, read from the index (never from the hash-ordered request list), in pages. */
  async #live(visit: (id: string, b: MaintenanceBody, row: Aggregate) => Promise<boolean>): Promise<void> {
    let after: string | undefined, scanned = 0;
    while (scanned < MAINTENANCE_LIMITS.indexScan) {
      const rows = await this.#runner.list(LIVE, { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      if (rows.length === 0) return;
      for (const r of rows) {
        scanned++; after = r.id;
        const found = await this.#runner.get(REQ, r.id);
        if (found === undefined) continue;
        if (!(await visit(r.id, found.body as unknown as MaintenanceBody, found))) return;
      }
      if (rows.length < 200) return;
    }
  }

  /** Picks up what a restart or a lost applier left: approved requests that wait, applications whose claim ended, uncertain ones and reverts in progress. Bounded per call; safe to call often. */
  async resume(): Promise<{ driven: number }> {
    let driven = 0;
    await this.#live(async (id, b, row) => {
      if (b.status === "approved" || b.status === "applying" || b.status === "revoking" || b.status === "apply-uncertain") {
        if (b.status === "applying" && this.#claimHeld(b, this.#runner.now(), (await this.#settings()).eff.leaseMs)) return true;
        driven++; await this.drive(row.id).catch(() => undefined);
      }
      void id;
      return driven < MAINTENANCE_LIMITS.driveBatch;
    });
    return { driven };
  }

  /** One round of the controller's maintenance loop: re-judges what a narrowed setting no longer allows (when a setting changed), then drives what waits. Bounded; settings writes only mark the work, they never drive the applier. */
  async tick(): Promise<{ touched: number; driven: number }> {
    const dirty = this.#dirty; this.#dirty = false;
    const e = dirty ? await this.enforce() : { touched: 0 };
    return { touched: e.touched, ...(await this.resume()) };
  }

  // ---- settings ------------------------------------------------------------------------------------------------------------------

  async #write(op: string, owner: Principal, commandId: string, expectedRevision: number | undefined, payload: JsonObject, mutate: (before: SettingsBody | undefined) => Omit<SettingsBody, "updatedBy" | "updatedAt">): Promise<{ revision: number }> {
    this.#owner(owner, "change the maintenance settings");
    this.#expected(expectedRevision);
    const result = await this.#runner.command(op, { commandId: scopedCommandId(owner.id, commandId), actor: owner.id }, async () => ({
      payload: { ...payload, expectedRevision: expectedRevision ?? null },
      build: async (): Promise<Built> => {
        const current = await this.#runner.get(SETTINGS.kind, SETTINGS.id);
        if (expectedRevision !== undefined && (current?.revision ?? 0) !== expectedRevision) throw new DomainError("stale_revision", `the maintenance settings are at revision ${current?.revision ?? 0}, not ${expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const next = { ...mutate(current?.body as unknown as SettingsBody | undefined), updatedBy: owner.id, updatedAt: this.#runner.now() } as unknown as JsonObject;
        const change: Change = current === undefined ? { type: "create", ref: SETTINGS, body: next } : { type: "update", ref: SETTINGS, expectedRevision: current.revision, body: next };
        return { ref: SETTINGS, creates: current === undefined, changes: [change], detail: { ...payload } , contention: async () => new DomainError("stale_revision", "the maintenance settings changed at the same moment; ask again") };
      },
    }));
    // A narrowing counts for what is already waiting or approved: the write only marks the work and the dispatcher loop's tick (or a background tick started now, after the answer) looks at it again, bounded per tick.
    this.#dirty = true;
    this.background(this.tick());
    return { revision: result.revision };
  }

  /** Full form: `requests`, `bosses`, `rules` (true, false, or null for the profile's default), `sites` ({ site: "allow" | "deny" | null }), `catalogueAdd` and `catalogueRemove`. */
  async change(owner: Principal, command: NoActor & { requests?: boolean | null; bosses?: boolean | null; rules?: boolean | null; bossKinds?: unknown; leaseMinutes?: number | null; requestsPerDay?: number | null; sites?: unknown; catalogueAdd?: unknown; catalogueRemove?: unknown; expectedRevision?: number }): Promise<{ revision: number }> {
    this.#owner(owner, "change the maintenance settings");
    onlyKnown(command, ["commandId", "requests", "bosses", "rules", "bossKinds", "leaseMinutes", "requestsPerDay", "sites", "catalogueAdd", "catalogueRemove", "expectedRevision"]);
    const flag = (v: unknown, f: string): boolean | null | undefined => (v === undefined || v === null || typeof v === "boolean" ? (v as never) : bad(f, "must be true, false or null"));
    const flags = { requests: flag(command.requests, "requests"), bosses: flag(command.bosses, "bosses"), rules: flag(command.rules, "rules") };
    const sites = command.sites === undefined ? undefined : this.#sites(command.sites);
    const add = command.catalogueAdd === undefined ? undefined : this.#entries(command.catalogueAdd, "catalogueAdd");
    const remove = command.catalogueRemove === undefined ? undefined : this.#entries(command.catalogueRemove, "catalogueRemove");
    const num = (v: unknown, f: string, lo: number, hi: number): number | null | undefined => (v === undefined || v === null ? (v as never) : typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : bad(f, `must be a whole number from ${lo} to ${hi}, or null for the default`));
    const lease = num(command.leaseMinutes, "leaseMinutes", MAINTENANCE_LIMITS.leaseMinMs / 60_000, MAINTENANCE_LIMITS.leaseMaxMs / 60_000), perDay = num(command.requestsPerDay, "requestsPerDay", 1, 10_000);
    const kinds = command.bossKinds === undefined || command.bossKinds === null ? (command.bossKinds as null | undefined) : Array.isArray(command.bossKinds) && command.bossKinds.every((k) => (BOSS_KINDS as readonly unknown[]).includes(k)) && new Set(command.bossKinds).size === command.bossKinds.length ? (command.bossKinds as MaintenanceKind[]) : bad("bossKinds", `must be a list of kinds from ${BOSS_KINDS.join(", ")} (host-policy and base are never handed to supervisors), or null`);
    if (Object.values(flags).every((v) => v === undefined) && lease === undefined && perDay === undefined && kinds === undefined && sites === undefined && add === undefined && remove === undefined) bad("requests", "name at least one setting to change");
    return this.#write("maintenance.settings.set", owner, command.commandId, command.expectedRevision, { flags: Object.fromEntries(Object.entries(flags).filter(([, v]) => v !== undefined)) as unknown as JsonObject, lease: lease ?? null, perDay: perDay ?? null, kinds: (kinds ?? null) as unknown as JsonObject, sites: (sites ?? null) as unknown as JsonObject, add: (add ?? null) as unknown as JsonObject, remove: (remove ?? null) as unknown as JsonObject }, (before) => this.#merge(before, flags, sites, add, remove, { lease, perDay, kinds }));
  }

  /** Turns one switch (or all) on or off: `requests` (agents may ask), `bosses` (supervisors may decide what is not protected), `rules` (preapproved catalogue and allowed sites approve by themselves). */
  async toggle(owner: Principal, command: NoActor & { what: string; enabled: boolean; expectedRevision?: number }): Promise<{ revision: number }> {
    this.#owner(owner, "change the maintenance settings");
    onlyKnown(command, ["commandId", "what", "enabled", "expectedRevision"]);
    if (!["requests", "bosses", "rules", "all"].includes(command.what)) bad("what", "must be requests, bosses, rules or all");
    if (typeof command.enabled !== "boolean") bad("enabled", "must be true or false");
    const names = command.what === "all" ? ["requests", "bosses", "rules"] : [command.what];
    const flags = Object.fromEntries(names.map((n) => [n, command.enabled]));
    return this.#write(command.enabled ? "maintenance.settings.enable" : "maintenance.settings.disable", owner, command.commandId, command.expectedRevision, { what: command.what, enabled: command.enabled }, (before) => this.#merge(before, flags as never, undefined, undefined, undefined));
  }

  /** One site's rule: `allow` (requests for it are approved by themselves), `deny` (they are rejected, and an applied one is reverted), or `clear` (back to the installation profile). */
  async site(owner: Principal, command: NoActor & { site: string; rule: string; expectedRevision?: number }): Promise<{ revision: number }> {
    this.#owner(owner, "change the maintenance settings");
    onlyKnown(command, ["commandId", "site", "rule", "expectedRevision"]);
    if (!["allow", "deny", "clear"].includes(command.rule)) bad("rule", "must be allow, deny or clear");
    const sites = this.#sites({ [command.site]: command.rule === "clear" ? null : command.rule });
    return this.#write("maintenance.site.set", owner, command.commandId, command.expectedRevision, { sites: sites as unknown as JsonObject }, (before) => this.#merge(before, {}, sites, undefined, undefined));
  }

  /** Adds or removes a preapproved package. Removing an entry stops future automatic approvals only: a package already applied stays applied until the request is revoked (the same holds for switching `rules` off). */
  async catalogue(owner: Principal, command: NoActor & { add: boolean; name: string; version: string; digest: string; source: string; installScripts?: boolean; expectedRevision?: number }): Promise<{ revision: number }> {
    this.#owner(owner, "change the maintenance settings");
    onlyKnown(command, ["commandId", "add", "name", "version", "digest", "source", "installScripts", "expectedRevision"]);
    const entries = this.#entries([{ name: command.name, version: command.version, digest: command.digest, source: command.source, ...(command.installScripts === undefined ? {} : { installScripts: command.installScripts }) }], "entry");
    return this.#write(command.add ? "maintenance.catalogue.add" : "maintenance.catalogue.remove", owner, command.commandId, command.expectedRevision, { entries: entries as unknown as JsonObject, add: command.add }, (before) => this.#merge(before, {}, undefined, command.add ? entries : undefined, command.add ? undefined : entries));
  }

  #sites(v: unknown): Record<string, SiteRule | null> {
    if (v === null || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length === 0 || Object.keys(v).length > 20) return bad("sites", "must map 1 to 20 sites to allow, deny or null");
    const out: Record<string, SiteRule | null> = {};
    for (const [site, rule] of Object.entries(v)) {
      const m = SITE_KEY.exec(site.toLowerCase());
      if (m === null || (m[2] !== undefined && (Number(m[2]) < 1 || Number(m[2]) > 65535))) bad("sites", `${site.slice(0, 60)} is not a site name (a host name such as pypi.org, optionally with :port; an allow may be *.host)`);
      if (site.startsWith("*.") && rule === "deny") bad("sites", "a deny on a host already covers its subdomains; name the host");
      if (rule !== "allow" && rule !== "deny" && rule !== null) bad("sites", "a site's rule is allow, deny or null");
      out[site.toLowerCase()] = rule;
    }
    return out;
  }
  #entries(v: unknown, field: string): CatalogueEntry[] {
    if (!Array.isArray(v) || v.length === 0 || v.length > 20) return bad(field, "must be a list of 1 to 20 packages");
    return v.map((e, i) => {
      if (e === null || typeof e !== "object" || Array.isArray(e)) return bad(`${field}[${i}]`, "must be an object");
      onlyKnown(e, ["name", "version", "digest", "source", "installScripts"]);
      const x = e as Record<string, unknown>;
      if (x["installScripts"] !== undefined && typeof x["installScripts"] !== "boolean") bad(`${field}[${i}].installScripts`, "must be true or false");
      return { name: name(x["name"], `${field}[${i}].name`, PKG_NAME), version: lone(x["version"], `${field}[${i}].version`, 40, VERSION), digest: lone(x["digest"], `${field}[${i}].digest`, 80, DIGEST), source: checkSource(x["source"], `${field}[${i}].source`), ...(x["installScripts"] === true ? { installScripts: true } : {}) };
    });
  }
  #merge(before: SettingsBody | undefined, flags: { requests?: boolean | null | undefined; bosses?: boolean | null | undefined; rules?: boolean | null | undefined }, sites: Record<string, SiteRule | null> | undefined, add: CatalogueEntry[] | undefined, remove: CatalogueEntry[] | undefined, more: { lease?: number | null | undefined; perDay?: number | null | undefined; kinds?: MaintenanceKind[] | null | undefined } = {}): Omit<SettingsBody, "updatedBy" | "updatedAt"> {
    const out: { requests?: boolean; bosses?: boolean; rules?: boolean; bossKinds?: MaintenanceKind[]; leaseMinutes?: number; requestsPerDay?: number; sites?: Record<string, SiteRule>; catalogue?: CatalogueEntry[] } = {};
    for (const k of ["requests", "bosses", "rules"] as const) { const v = flags[k] === undefined ? before?.[k] : flags[k]; if (typeof v === "boolean") out[k] = v; }
    const kinds = more.kinds === undefined ? before?.bossKinds : more.kinds ?? undefined; if (kinds !== undefined && kinds.length > 0) out.bossKinds = [...kinds];
    const lease = more.lease === undefined ? before?.leaseMinutes : more.lease ?? undefined; if (lease !== undefined) out.leaseMinutes = lease;
    const perDay = more.perDay === undefined ? before?.requestsPerDay : more.perDay ?? undefined; if (perDay !== undefined) out.requestsPerDay = perDay;
    const s: Record<string, SiteRule> = { ...(before?.sites ?? {}) };
    for (const [site, rule] of Object.entries(sites ?? {})) { if (rule === null) delete s[site]; else s[site] = rule; }
    if (Object.keys(s).length > MAINTENANCE_LIMITS.sites) bad("sites", `at most ${MAINTENANCE_LIMITS.sites} sites can carry a rule`);
    if (Object.keys(s).length > 0) out.sites = s;
    const key = (e: CatalogueEntry): string => `${e.name}\0${e.version}\0${e.digest}`;
    const cat = new Map((before?.catalogue ?? []).map((e) => [key(e), e]));
    for (const e of remove ?? []) cat.delete(key(e));
    for (const e of add ?? []) cat.set(key(e), e);
    if (cat.size > MAINTENANCE_LIMITS.catalogue) bad("catalogueAdd", `the catalogue holds at most ${MAINTENANCE_LIMITS.catalogue} entries`);
    if (cat.size > 0) out.catalogue = [...cat.values()].sort((a, b) => key(a).localeCompare(key(b)));
    return out;
  }

  /**
   * Makes a narrowing count for requests already made: an approved or applied one that a denied site, a withdrawn rule or a lost supervisor no longer allows is looked at again (approved ones are re-judged when they
   * are next driven; an applied network change for a denied site is revoked). Reads the index of live requests; bounded per call (what is left is done by the next tick); returns how many it touched.
   */
  async enforce(): Promise<{ touched: number }> {
    let touched = 0;
    const s = await this.#settings();
    if (!s.readable) return { touched };
    await this.#live(async (id, b, row) => {
      if (b.kind === "network" && b.status === "applied" && siteRule(s.body?.sites, b.spec["site"] as string, b.spec["port"] as number) === "deny") {
        const moved = await this.#move(row, "maintenance.revoke-by-rule", { ...b, status: "revoking", revoke: { by: "controller", at: this.#runner.now(), reason: "the owner denied this site" } });
        if (moved !== undefined) { touched++; await this.drive(id).catch(() => undefined); }
      } else if (b.status === "approved") { touched++; await this.drive(id).catch(() => undefined); }
      if (touched >= MAINTENANCE_LIMITS.driveBatch) { this.#dirty = true; return false; }
      return true;
    });
    return { touched };
  }
}
