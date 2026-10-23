import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import type { CacheOutcome } from "./adapter.js";
import { profileFor } from "./profiles.js";
import { redactText } from "../security/redact.js";
import { CACHE_LIMITS, type BackendKind, type EndpointConfig } from "./profile.js";

export type MarkerKind = "prefix" | "slot-file" | "pin";
export type MarkerState = "active" | "released" | "lost";

/**
 * What the controller remembers about a cached prefix. It is opaque: an ID, the route it was made on, a digest of the prefix bytes (never the text), a token count, and for a slot file or pin the
 * handle the backend needs (a file name the controller generated). It lets the dispatcher say "I expect about N tokens to be cached" and judge the answer; it is never a promise that the backend still holds them.
 */
export interface MarkerBody {
  readonly id: string;
  readonly projectId: string;
  readonly route: string;
  readonly backend: BackendKind;
  readonly kind: MarkerKind;
  /** SHA-256 of the exact prefix bytes sent, as 64 hex characters. */
  readonly digest: string;
  readonly tokens: number;
  /** A slot file name, for `slot-file` markers. Generated here, never chosen by a caller. */
  readonly handle?: string;
  state: MarkerState;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly by: string;
  hits: number;
  lastHitAt?: string;
  lostAt?: string;
  lostReason?: string;
}
interface ScopeBody { readonly projectId: string; markers: Record<string, MarkerBody> }

export type Resolution =
  | { readonly state: "active"; readonly marker: MarkerBody; readonly expectedCachedTokens: number }
  /** Missing, another project's, another route's, expired, released or lost: the reason is the same for the first three, so a marker of another project reads like a missing one. */
  | { readonly state: "unavailable"; readonly reason: "missing" | "expired" | "released" | "lost" };

/** The bounded retention policy: how many markers, how many tokens, and how long a controller keeps an expectation. */
export const MARKER_LIMITS = { perProject: 200, records: 400, tokensPerProject: 50_000_000, tokens: CACHE_LIMITS.tokens, defaultTtlMs: 3_600_000, maxTtlMs: 7 * 86_400_000, reason: 300 } as const;
const SCOPE = "cache-markers";
const PIN = "cache-pin";
/** A route has one pin (Strata keeps one pinned prefix per engine): the holder is recorded durably, per route, and checked in the same guarded write that adds the pin marker. */
interface PinBody { readonly route: string; projectId: string | null; markerId: string; expiresAt: string }
const pinRef = (route: string): AggregateRef => ({ kind: PIN, id: `pin-${createHash("sha256").update(route).digest("hex").slice(0, 32)}` });
const PROJECT = /^proj-[a-z2-7]{20}$/;
const MARKER = /^cmk-[a-z2-7]{20}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ROUTE = /^[A-Za-z][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const whole = (v: unknown, field: string, max: number): number => (Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max ? (v as number) : invalid(field, `must be a whole number from 0 to ${max}`));

/**
 * Opaque cache markers with a bounded retention policy and per-project quota (card C06). Only the dispatcher (owner, host or service) uses them; agents never see a marker, a digest or a slot file name.
 *
 * Each project's markers are one record, so the quota is checked and the marker added in one guarded write: ten registrations racing for the last five places give exactly five. Expired, released and
 * lost markers are swept out on registration, and what remains is refused beyond 200 markers or 50 million tokens (the dispatcher releases something first; nothing is evicted silently). A marker can be
 * made only for a kind of retention the endpoint's profile advertises (a slot file where slot save is configured, a pin where the backend has one), so a request the backend cannot honour never gets a marker.
 */
export class MarkerService {
  readonly #runner: CommandRunner;
  readonly #pause: (attempt: number) => Promise<void>;

  private constructor(runner: CommandRunner, pause: (attempt: number) => Promise<void>) { this.#runner = runner; this.#pause = pause; }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): MarkerService {
    return new MarkerService(new CommandRunner(storage, epoch, options), options.pause ?? ((attempt) => new Promise((resolve) => setTimeout(resolve, Math.random() * Math.min(25, attempt * 2)))));
  }

  /** Records that a prefix of `tokens` tokens was sent to `route` with the profile's cache settings and is expected to be cached for a while. */
  async register(by: Principal, command: NoActor & { projectId: string; route: string; endpoint: EndpointConfig; kind: MarkerKind; digest: string; tokens: number; ttlMs?: number }): Promise<{ id: string; replayed: boolean }> {
    this.#dispatcher(by);
    onlyKnown(command, ["commandId", "projectId", "route", "endpoint", "kind", "digest", "tokens", "ttlMs"]);
    const projectId = typeof command.projectId === "string" && PROJECT.test(command.projectId) ? command.projectId : invalid("projectId", "is not a project ID");
    if ((await this.#runner.get("project", projectId)) === undefined) throw new DomainError("not_found", "no such project");
    const route = typeof command.route === "string" && ROUTE.test(command.route) ? command.route : invalid("route", "must be provider/model");
    const kind: MarkerKind = command.kind === "prefix" || command.kind === "slot-file" || command.kind === "pin" ? command.kind : invalid("kind", "must be prefix, slot-file or pin");
    const digest = typeof command.digest === "string" && DIGEST.test(command.digest) ? command.digest : invalid("digest", "must be the SHA-256 of the prefix as 64 lower-case hex characters");
    const tokens = whole(command.tokens, "tokens", MARKER_LIMITS.tokens);
    if (tokens < 1) invalid("tokens", "must be at least 1");
    const profile = profileFor(command.endpoint);
    const c = profile.capabilities;
    // The endpoint config lives with the dispatcher next to the route; when it names its route, a marker for a different route is a mix-up and is refused.
    if (command.endpoint.route !== undefined && command.endpoint.route !== route) invalid("route", `the endpoint is configured for route ${command.endpoint.route}, not ${route}`);
    // A marker is only made for something the backend advertises.
    if (kind === "prefix" && c.prefixReuse === "none") invalid("kind", `${profile.label} has no prefix reuse to keep a marker for`);
    if (kind === "slot-file" && c.slotSaveRestore.level === "unsupported") invalid("kind", `${profile.label} cannot save slot files: ${c.slotSaveRestore.via}`);
    if (kind === "pin" && c.pin.level === "unsupported") invalid("kind", `${profile.label} cannot pin a prefix: ${c.pin.via}`);
    // The expectation never outlives what the backend can keep: a request-controlled lifetime caps it, and so does the policy maximum.
    const cap = Math.min(MARKER_LIMITS.maxTtlMs, kind === "prefix" && c.retention.maxMs !== undefined ? c.retention.maxMs : MARKER_LIMITS.maxTtlMs);
    const ttlMs = command.ttlMs === undefined ? Math.min(profile.defaultLifetimeMs ?? MARKER_LIMITS.defaultTtlMs, cap) : whole(command.ttlMs, "ttlMs", cap);
    if (ttlMs < 1) invalid("ttlMs", "must be at least 1");
    const id = derivedId("cmk", scopedCommandId(by.id, command.commandId));
    const ref: AggregateRef = { kind: SCOPE, id: projectId };
    const result = await this.#retrying(() => this.#runner.command("cache.marker.register", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { projectId, route, backend: profile.kind, kind, digest, tokens, ttlMs },
      build: async () => {
        const found = await this.#runner.get(SCOPE, projectId);
        const scope: ScopeBody = found === undefined ? { projectId, markers: {} } : structuredClone(found.body as unknown as ScopeBody);
        const now = this.#runner.now();
        // Released markers and stale prefix or pin markers are dropped. A stale slot-file marker (expired or lost) stays until released: it is the only record of the file name the controller made on the server.
        for (const [k, m] of Object.entries(scope.markers)) if (m.state === "released" || (m.kind !== "slot-file" && (m.state !== "active" || m.expiresAt <= now))) delete scope.markers[k];
        const live = Object.values(scope.markers).filter((m) => m.state === "active" && m.expiresAt > now);
        if (Object.keys(scope.markers).length >= MARKER_LIMITS.records) invalid("projectId", `cache: this project has ${MARKER_LIMITS.records} markers including stale slot files; erase and release the ones listed by pendingErase`);
        if (live.length >= MARKER_LIMITS.perProject) invalid("projectId", `cache: this project already has ${MARKER_LIMITS.perProject} markers; release some`);
        if (live.reduce((n, m) => n + m.tokens, 0) + tokens > MARKER_LIMITS.tokensPerProject) invalid("tokens", `cache: this project's markers would hold more than ${MARKER_LIMITS.tokensPerProject} tokens; release some`);
        const marker: MarkerBody = {
          id, projectId, route, backend: profile.kind, kind, digest, tokens, ...(kind === "slot-file" ? { handle: `nn-${id.slice(4)}.bin` } : {}),
          state: "active", createdAt: now, expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(), by: by.id, hits: 0,
        };
        scope.markers[id] = marker;
        const change: Change = found === undefined ? { type: "create", ref, body: scope as unknown as JsonObject } : { type: "update", ref, expectedRevision: found.revision, body: scope as unknown as JsonObject };
        const changes: Change[] = [change];
        if (kind === "pin") {
          // The route's single pin: another project's live pin blocks this one; the same project's replaces its own; an unknown holder cannot arise because the record is durable.
          const pr = pinRef(route);
          const held = await this.#runner.get(PIN, pr.id);
          const holder = held === undefined ? undefined : (held.body as unknown as PinBody);
          if (holder !== undefined && holder.projectId !== null && holder.projectId !== projectId && holder.expiresAt > now) invalid("kind", `route ${route} has one pin and another project holds it`);
          const body: PinBody = { route, projectId, markerId: id, expiresAt: marker.expiresAt };
          changes.push(held === undefined ? { type: "create", ref: pr, body: body as unknown as JsonObject } : { type: "update", ref: pr, expectedRevision: held.revision, body: body as unknown as JsonObject });
        }
        return { ref, creates: found === undefined, changes, detail: { id, route, kind, tokens }, contention: async () => new DomainError("stale_revision", "the project's markers changed meanwhile") };
      },
    })));
    return { id, replayed: result.replayed };
  }

  /** Whether a marker may still be expected to be cached. A marker of another project, or a different route, reads like a missing one. */
  async resolve(by: Principal, query: { projectId: string; markerId: string; route: string }): Promise<Resolution> {
    this.#dispatcher(by);
    onlyKnown(query, ["projectId", "markerId", "route"]);
    const projectId = typeof query.projectId === "string" && PROJECT.test(query.projectId) ? query.projectId : invalid("projectId", "is not a project ID");
    const markerId = typeof query.markerId === "string" && MARKER.test(query.markerId) ? query.markerId : invalid("markerId", "is not a marker ID");
    const found = await this.#runner.get(SCOPE, projectId);
    const m = found === undefined ? undefined : (found.body as unknown as ScopeBody).markers[markerId];
    if (m === undefined || m.route !== query.route) return { state: "unavailable", reason: "missing" };
    if (m.state === "released") return { state: "unavailable", reason: "released" };
    if (m.state === "lost") return { state: "unavailable", reason: "lost" };
    if (m.expiresAt <= this.#runner.now()) return { state: "unavailable", reason: "expired" };
    return { state: "active", marker: m, expectedCachedTokens: m.tokens };
  }

  /**
   * Slot files the controller made that are no longer expected to be useful (expired or lost) and have not been released. llama.cpp and Strata have **no API to delete a slot file** (the slot
   * `erase` action only clears a slot's in-memory KV cache), so deleting is a host-side job: the host service removes each listed `nn-*.bin` by exact name from the server's `--slot-save-path`
   * (Strata: its session-file directory), and then releases the marker.
   */
  async pendingErase(by: Principal, projectId: string): Promise<readonly { id: string; handle: string; route: string; state: MarkerState; expiresAt: string }[]> {
    this.#dispatcher(by);
    if (typeof projectId !== "string" || !PROJECT.test(projectId)) invalid("projectId", "is not a project ID");
    const found = await this.#runner.get(SCOPE, projectId);
    if (found === undefined) return [];
    const now = this.#runner.now();
    return Object.values((found.body as unknown as ScopeBody).markers)
      .filter((m) => m.kind === "slot-file" && m.handle !== undefined && m.state !== "released" && (m.state === "lost" || m.expiresAt <= now))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((m) => ({ id: m.id, handle: m.handle!, route: m.route, state: m.state, expiresAt: m.expiresAt }));
  }

  /** Active markers of a project (expired ones are left out). */
  async list(by: Principal, projectId: string): Promise<readonly MarkerBody[]> {
    this.#dispatcher(by);
    if (typeof projectId !== "string" || !PROJECT.test(projectId)) invalid("projectId", "is not a project ID");
    const found = await this.#runner.get(SCOPE, projectId);
    if (found === undefined) return [];
    const now = this.#runner.now();
    return Object.values((found.body as unknown as ScopeBody).markers).filter((m) => m.state === "active" && m.expiresAt > now).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  /** Records what a call found. A hit refreshes nothing but the count; a miss marks the marker lost, so later calls stop expecting tokens the backend no longer holds. */
  async recordOutcome(by: Principal, command: NoActor & { projectId: string; markerId: string; outcome: CacheOutcome; reason?: string }): Promise<{ replayed: boolean }> {
    this.#dispatcher(by);
    onlyKnown(command, ["commandId", "projectId", "markerId", "outcome", "reason"]);
    const projectId = typeof command.projectId === "string" && PROJECT.test(command.projectId) ? command.projectId : invalid("projectId", "is not a project ID");
    const markerId = typeof command.markerId === "string" && MARKER.test(command.markerId) ? command.markerId : invalid("markerId", "is not a marker ID");
    if (!["hit", "partial", "miss", "cold", "unknown"].includes(command.outcome)) invalid("outcome", "is not an outcome");
    const reason = command.reason === undefined ? undefined : (typeof command.reason === "string" && command.reason.length <= MARKER_LIMITS.reason ? command.reason : invalid("reason", `must be text of at most ${MARKER_LIMITS.reason} characters`));
    if (reason !== undefined && redactText(reason) !== reason) invalid("reason", "looks like a credential or key; those are not recorded");
    return this.#change(by, "cache.marker.outcome", command.commandId, projectId, markerId, { outcome: command.outcome, reason: reason ?? null }, (m, now) => {
      if (command.outcome === "hit" || command.outcome === "partial") { m.hits += 1; m.lastHitAt = now; }
      if (command.outcome === "miss" && m.state === "active") { m.state = "lost"; m.lostAt = now; m.lostReason = reason ?? "a hit was expected and none was served"; }
    });
  }

  /** The dispatcher is done with a marker (and has erased its slot file, if it had one). */
  async release(by: Principal, command: NoActor & { projectId: string; markerId: string }): Promise<{ replayed: boolean }> {
    this.#dispatcher(by);
    onlyKnown(command, ["commandId", "projectId", "markerId"]);
    const projectId = typeof command.projectId === "string" && PROJECT.test(command.projectId) ? command.projectId : invalid("projectId", "is not a project ID");
    const markerId = typeof command.markerId === "string" && MARKER.test(command.markerId) ? command.markerId : invalid("markerId", "is not a marker ID");
    return await this.#change(by, "cache.marker.release", command.commandId, projectId, markerId, {}, (m) => { if (m.state === "active") m.state = "released"; });
  }

  async #change(by: Principal, type: string, commandId: string, projectId: string, markerId: string, payload: JsonObject, apply: (m: MarkerBody, now: string) => void): Promise<{ replayed: boolean }> {
    const ref: AggregateRef = { kind: SCOPE, id: projectId };
    const result = await this.#retrying(() => this.#runner.command(type, { commandId: scopedCommandId(by.id, commandId), actor: by.id }, async () => ({
      payload: { projectId, markerId, ...payload },
      build: async () => {
        const found = await this.#runner.get(SCOPE, projectId);
        const scope = found === undefined ? undefined : structuredClone(found.body as unknown as ScopeBody);
        const marker = scope?.markers[markerId];
        if (found === undefined || scope === undefined || marker === undefined) throw new DomainError("not_found", "no such marker");
        apply(marker, this.#runner.now());
        const changes: Change[] = [{ type: "update", ref, expectedRevision: found.revision, body: scope as unknown as JsonObject }];
        if (marker.kind === "pin" && marker.state !== "active") {
          // A released or lost pin frees the route's single pin, if this marker is the one holding it.
          const pr = pinRef(marker.route);
          const held = await this.#runner.get(PIN, pr.id);
          const holder = held === undefined ? undefined : (held.body as unknown as PinBody);
          if (held !== undefined && holder !== undefined && holder.markerId === marker.id && holder.projectId !== null) changes.push({ type: "update", ref: pr, expectedRevision: held.revision, body: { ...holder, projectId: null } as unknown as JsonObject });
        }
        return { ref, creates: false, changes, detail: { markerId }, contention: async () => new DomainError("stale_revision", "the project's markers changed meanwhile") };
      },
    })));
    return { replayed: result.replayed };
  }

  #dispatcher(by: Principal): void { if (!(by.kind === "owner" || by.kind === "host" || by.kind === "service")) throw new DomainError("forbidden", `${by.id} is not the dispatcher; cache markers are the controller's and its hosts'`); }

  async #retrying<T>(run: () => Promise<T>): Promise<T> {
    let conflicts = 0;
    for (let attempt = 1; ; attempt++) {
      try { return await run(); } catch (error) {
        const race = error instanceof DomainError && error.code === "stale_revision";
        const first = error instanceof DomainError && error.code === "command_conflict" && ++conflicts <= 3;
        if (!(race || first) || attempt >= 80) throw error;
        await this.#pause(attempt);
      }
    }
  }
}
