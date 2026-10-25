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
  readonly markers?: Pick<MarkerService, "resolve">;
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
