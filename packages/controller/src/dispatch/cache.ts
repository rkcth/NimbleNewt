import { randomBytes } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { CacheUsage } from "../budgets/budgets.js";
import { CacheEndpoints, deriveKey, ledgerCache, piCachePolicy, profileFor, type CacheContext, type EndpointConfig, type EndpointState, type MarkerService, type PiCachePolicy } from "../inference-cache/index.js";
import { piFetch } from "./pi-fetch.js";
import { redactText } from "../security/redact.js";
import type { Principal } from "../security/principals.js";

/** The endpoint a route is served by: the owner's configuration kept next to the R01 route (card C06 decision 5). */
export interface RouteEndpoint { readonly url: string; readonly config: EndpointConfig }

export interface CachePolicyDeps {
  /** The installation secret the keys are derived under (at least 16 characters). Never sent anywhere; a cloud provider sees only the derived keys. */
  readonly secret: string;
  /** The owner's endpoint configuration by route (`provider/model`). A route with none is treated as a generic backend: nothing is sent. */
  readonly endpoints: Readonly<Record<string, RouteEndpoint>>;
  /**
   * One registry for the whole controller: every adapter and every policy of one server shares its slot holders, affinity and turns. Without it (or when it cannot track another endpoint) Pi's calls cannot go through
   * the adapter, so a slotted server runs with reuse off and the policy says why (`degraded`).
   */
  readonly state?: CacheEndpoints;
  /** The dispatcher's service principal, to resolve markers. */
  readonly principal: Principal;
  /** `recordOutcome` is given by the composer so that a missed pin marks the marker lost; without it the outcomes are not recorded. */
  readonly markers?: Pick<MarkerService, "resolve"> & Partial<Pick<MarkerService, "recordOutcome">>;
  /** Whether a project requires that its prompts share no cache with other projects. */
  readonly isolationRequired?: (projectId: string) => boolean | Promise<boolean>;
  /** Told when the bookkeeping around a model call fails after Pi already has its answer (a stream that broke after it had begun, the usage hook). Default: logged, redacted. */
  readonly onError?: (error: unknown) => void;
}

export interface AttemptCache {
  readonly policy: PiCachePolicy;
  /** The slot this attempt's project holds on a slotted server, if it got one. A project never gets another project's slot: a refusal says why. */
  readonly slot?: number;
  readonly refused?: string;
  /** True when Pi's HTTP calls for this route go through the endpoint's cache state (slot turns, holder checks, markers and pins); false when they are only observed or, for a slotted server, run with reuse off. */
  readonly routed: boolean;
  /** The cache figures the backend reported for this route's calls since the last take, summed, as the usage ledger (R05) records them; undefined when no call reported any. Waits for the calls still being judged (the last call of a turn ends a moment after Pi has its answer). Put it into the turn's `usage.cache`. */
  takeUsage(): Promise<CacheUsage | undefined>;
}

/**
 * The cache policy of an attempt, per route (card H12; the dispatcher requirements recorded by C06 and C06b). It reads the owner's endpoint configuration for the attempt's route, derives the scope
 * key (the project) and the share key (the project's common prefix) under the installation secret, takes a slot from the server's shared affinity (partitioned by project), resolves the pin marker the
 * project holds (a pin is sent only when one is active), carries the project's isolation requirement, and hands the Pi adapter's `cache.policy` what C06b's `piCachePolicy` makes of them.
 */
export class CachePolicies {
  readonly #deps: CachePolicyDeps;

  constructor(deps: CachePolicyDeps) {
    if (typeof deps.secret !== "string" || deps.secret.length < 16) throw new DomainError("invalid_command", "secret: must be at least 16 characters", { field: "secret" });
    this.#deps = deps;
  }

  async forAttempt(attempt: { readonly projectId: string; readonly route: string }, options: { readonly splitSystem?: boolean; readonly pinMarker?: string; readonly retention?: "short" | "long"; readonly pinMessages?: number } = {}): Promise<AttemptCache> {
    const d = this.#deps;
    const endpoint = Object.hasOwn(d.endpoints, attempt.route) ? d.endpoints[attempt.route] : undefined;
    const profile = profileFor(endpoint === undefined ? { model: attempt.route.slice(attempt.route.indexOf("/") + 1) } : endpoint.config);
    const scopeKey = deriveKey(d.secret, "scope", attempt.projectId);
    const shareKey = deriveKey(d.secret, "share", attempt.projectId, "common");
    let slot: number | undefined;
    let refused: string | undefined;
    let state: EndpointState | undefined;
    if (endpoint !== undefined && profile.slotted && endpoint.config.options?.slots !== undefined) {
      try { state = d.state?.state(endpoint.url); } catch { state = undefined; }
      if (state !== undefined) {
        const got = state.affinity(endpoint.config.options.slots).assign(scopeKey, shareKey);
        if ("refused" in got) refused = got.refused; else slot = got.slot;
      }
    }
    let pinAuthorized = false;
    let expected = 0;
    if (options.pinMarker !== undefined && d.markers !== undefined) {
      const resolved = await d.markers.resolve(d.principal, { projectId: attempt.projectId, markerId: options.pinMarker, route: attempt.route });
      pinAuthorized = resolved.state === "active";
      if (resolved.state === "active") expected = resolved.expectedCachedTokens;
    }
    // What each call found of the pinned prefix is told to the marker service: a hit counts, and a miss (the endpoint no longer holds what the marker says it does) marks the marker lost, so later calls stop expecting it (card H12j).
    const pin = pinAuthorized && options.pinMarker !== undefined ? options.pinMarker : undefined;
    const nonce = randomBytes(6).toString("hex");
    let outcomes = 0;
    let markerLost = false;
    const report = d.onError ?? ((error: unknown): void => { console.error(`pin marker bookkeeping for ${attempt.route} failed: ${redactText(error instanceof Error ? error.message : String(error)).slice(0, 300)}`); });
    const context: CacheContext = {
      scopeKey, shareKey, ...(slot === undefined ? {} : { slot }), ...(options.retention === undefined ? {} : { retention: options.retention }),
      ...(options.pinMessages === undefined ? {} : { pinMessages: options.pinMessages }), pinAuthorized, ...(await d.isolationRequired?.(attempt.projectId) === true ? { isolationRequired: true } : {}),
    };
    // A slotted server goes through the adapter only with the endpoint's shared state; any other configured endpoint is observed, so its hit figures reach accounting too. A route with no endpoint, or a generic profile, is left to Pi.
    const routed = state !== undefined;
    let total = { cachedTokens: 0, computedTokens: 0, writtenTokens: 0 };
    let reported = false;
    const pending = new Set<Promise<void>>();
    const fetch = endpoint === undefined || profile.kind === "generic" ? undefined : piFetch({
      profile, context: () => context, ...(state === undefined ? {} : { state }), ...(expected > 0 ? { expectedCachedTokens: () => expected } : {}),
      track: (done) => { pending.add(done); void done.then(() => pending.delete(done)); },
      onCall: (call) => {
        const outcome = call.result?.outcome;
        if (pin !== undefined && !markerLost && d.markers?.recordOutcome !== undefined && (outcome === "hit" || outcome === "partial" || outcome === "miss")) {
          const n = ++outcomes;
          // After a miss the marker is lost: later calls of this attempt are not told to it again.
          if (outcome === "miss") markerLost = true;
          try {
            // Not awaited by the answer: the bookkeeping is tracked, and a failure is reported without touching Pi's reply or the accounting of this call. The command ID carries a part that is new for every attempt object,
            // so a turn run again after a restart is counted again (its calls are different calls).
            const told: Promise<void> = Promise.resolve(d.markers.recordOutcome.call(d.markers, d.principal, { commandId: `pin-outcome:${nonce}:${n}`, projectId: attempt.projectId, markerId: pin, outcome, ...(outcome === "miss" ? { reason: "the endpoint served none of the pinned prefix" } : {}) })).then(() => undefined, report);
            pending.add(told);
            void told.then(() => pending.delete(told));
          } catch (error) { report(error); }
        }
        const figures = ledgerCache(call.hit, profile.kind, attempt.route);
        if (figures === undefined) return;
        reported = true;
        total = { cachedTokens: total.cachedTokens + figures.cachedTokens, computedTokens: total.computedTokens + figures.computedTokens, writtenTokens: total.writtenTokens + figures.writtenTokens };
      },
      onError: d.onError ?? ((error) => { console.error(`cache bookkeeping for ${attempt.route} failed after the answer: ${redactText(error instanceof Error ? error.message : String(error)).slice(0, 300)}`); }),
    });
    const policy = piCachePolicy(profile, context, { splitSystem: options.splitSystem === true, routed });
    return {
      policy: fetch === undefined ? policy : { ...policy, fetch }, routed, ...(slot === undefined ? {} : { slot }), ...(refused === undefined ? {} : { refused }),
      takeUsage: async () => {
        await Promise.all([...pending]);
        if (!reported) return undefined;
        const out = { backend: profile.kind, route: attempt.route, ...total };
        total = { cachedTokens: 0, computedTokens: 0, writtenTokens: 0 }; reported = false;
        return out;
      },
    };
  }
}
