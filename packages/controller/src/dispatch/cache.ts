import { DomainError } from "../domain/errors.js";
import { CacheEndpoints, deriveKey, piCachePolicy, profileFor, type CacheContext, type EndpointConfig, type MarkerService, type PiCachePolicy } from "../inference-cache/index.js";
import type { Principal } from "../security/principals.js";

/** The endpoint a route is served by: the owner's configuration kept next to the R01 route (card C06 decision 5). */
export interface RouteEndpoint { readonly url: string; readonly config: EndpointConfig }

export interface CachePolicyDeps {
  /** The installation secret the keys are derived under (at least 16 characters). Never sent anywhere; a cloud provider sees only the derived keys. */
  readonly secret: string;
  /** The owner's endpoint configuration by route (`provider/model`). A route with none is treated as a generic backend: nothing is sent. */
  readonly endpoints: Readonly<Record<string, RouteEndpoint>>;
  /** One registry for the whole controller: every adapter and every policy of one server shares its slot holders, affinity and turns. */
  readonly state: CacheEndpoints;
  /** The dispatcher's service principal, to resolve markers. */
  readonly principal: Principal;
  readonly markers?: Pick<MarkerService, "resolve">;
  /** Whether a project requires that its prompts share no cache with other projects. */
  readonly isolationRequired?: (projectId: string) => boolean | Promise<boolean>;
}

export interface AttemptCache {
  readonly policy: PiCachePolicy;
  /** The slot this attempt's project holds on a slotted server, if it got one. A project never gets another project's slot: a refusal says why. */
  readonly slot?: number;
  readonly refused?: string;
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
    if (endpoint !== undefined && profile.slotted && endpoint.config.options?.slots !== undefined) {
      const state = d.state.state(endpoint.url);
      const got = state.affinity(endpoint.config.options.slots).assign(scopeKey, shareKey);
      if ("refused" in got) refused = got.refused; else slot = got.slot;
    }
    let pinAuthorized = false;
    if (options.pinMarker !== undefined && d.markers !== undefined) {
      const resolved = await d.markers.resolve(d.principal, { projectId: attempt.projectId, markerId: options.pinMarker, route: attempt.route });
      pinAuthorized = resolved.state === "active";
    }
    const context: CacheContext = {
      scopeKey, shareKey, ...(slot === undefined ? {} : { slot }), ...(options.retention === undefined ? {} : { retention: options.retention }),
      ...(options.pinMessages === undefined ? {} : { pinMessages: options.pinMessages }), pinAuthorized, ...(await d.isolationRequired?.(attempt.projectId) === true ? { isolationRequired: true } : {}),
    };
    return { policy: piCachePolicy(profile, context, { splitSystem: options.splitSystem === true }), ...(slot === undefined ? {} : { slot }), ...(refused === undefined ? {} : { refused }) };
  }
}
