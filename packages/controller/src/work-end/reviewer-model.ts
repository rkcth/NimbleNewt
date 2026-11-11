import type { ModelCall, ModelReply } from "../chat/model-interpreter.js";
import type { ResumeReviewModel } from "../continuation/resume-reviewer.js";
import { DomainError } from "../domain/errors.js";
import type { RouteRequest, Selection } from "../routing/policy.js";
import { redactText } from "../security/redact.js";
import { INTERROGATOR_LIMITS } from "./interrogator.js";

/**
 * The shipped model client of the second agent that questions an agent's done (card W10), in two parts. The resume reviewer of card L04d uses the same client (one instance, so both share its slots) on its own owner
 * setting (`resume.reviewerRoute`, `RESUME_REVIEWER_ROUTE_SETTING`):
 *
 * - `BoundedReviewerModel` wraps the host's raw client (an HTTP client over the owner's recorded provider addresses, credentials read by NAME at each call, in the launcher). Nothing reaches it that is not redacted and bounded, and
 *   nothing comes back unbounded: the system and user texts are redacted and cut, a reply longer than the verdict parser's own limit is replaced by a marker that holds no verdict (so it is read as unreadable and the report is found unsupported, fail closed: padding after a genuine-looking verdict cannot get a done through, as it would if the reply were merely cut and trimmed) and a call that returns
 *   something other than text is a failure. It has no tools, no conversation and no memory between calls. At most `concurrent` calls are in flight; a further call waits for a slot in order, at most `waitMs` (default 45 s, which with the
 *   host client's own 60 s time limit stays inside the interrogator's 120 s per call) and with at most `maxWaiting` waiting; past either it fails as a failure that may pass. Refusing at once instead would leave every done after the
 *   second of a burst unquestioned (not run) although nothing is stuck. A call holds its slot until the host's client returns or fails, and the host's client is bounded in time, so a hung call does not hold one for ever.
 * - `reviewerRoute` turns the owner's setting `report.reviewerRoute` into the routes the interrogator may use, at each questioning. Unset: it throws "no reviewer route is set", which the dispatcher records as the questioning
 *   NOT RUN (never as passed). A route that is set must be eligible under the routing table's own rules (its provider enabled, not excluded, big enough); otherwise the same: not run, with why.
 *
 * The controller puts the client behind its routed, metered client (`GuardedModelCall`) exactly as for an explicit `reportInterrogation`; nothing here counts spend or classifies failures.
 */
export const REVIEWER_LIMITS = { system: 4000, user: INTERROGATOR_LIMITS.prompt, reply: INTERROGATOR_LIMITS.answer, concurrent: 2, waitMs: 45_000, maxWaiting: 32, contextTokens: 12_000 } as const;
/** What stands in for a reply longer than the limit: no JSON, so the interrogator reads it as no verdict (unsupported). */
export const TOO_LONG = "[the reviewer's reply was longer than the limit for a verdict and was not read]";
export const REVIEWER_ROUTE_SETTING = "report.reviewerRoute";
/** The owner's setting naming the route that judges whether what changed under a paused task matters before it resumes (card L04d wiring). Separate from `report.reviewerRoute`: different data goes to it. */
export const RESUME_REVIEWER_ROUTE_SETTING = "resume.reviewerRoute";
/** What `reviewerRoute` says when it cannot give a route, for each reviewer role. */
const UNSET = {
  report: "no reviewer route is set, so no second agent questioned the report (the owner names one in chat, for example: let provider/model question the agents' reports)",
  resume: "no resume reviewer route is set, so no second agent judged what changed (the owner names one in chat; until then every change waits for the owner)",
} as const;

export class BoundedReviewerModel implements ResumeReviewModel, Pick<ModelCall, "completeDetailed"> {
  readonly #raw: ModelCall;
  readonly #waitMs: number;
  readonly #maxWaiting: number;
  readonly #waiting: (() => void)[] = [];
  #inFlight = 0;
  constructor(raw: ModelCall, options: { readonly waitMs?: number; readonly maxWaiting?: number } = {}) {
    this.#raw = raw;
    this.#waitMs = options.waitMs !== undefined && Number.isFinite(options.waitMs) && options.waitMs >= 0 ? Math.min(options.waitMs, REVIEWER_LIMITS.waitMs) : REVIEWER_LIMITS.waitMs;
    this.#maxWaiting = options.maxWaiting !== undefined && Number.isSafeInteger(options.maxWaiting) && options.maxWaiting >= 0 ? Math.min(options.maxWaiting, REVIEWER_LIMITS.maxWaiting) : REVIEWER_LIMITS.maxWaiting;
  }

  /** Takes a slot, waiting in order for one when all are in use (bounded in time and in the number waiting). */
  async #slot(): Promise<void> {
    if (this.#inFlight < REVIEWER_LIMITS.concurrent) { this.#inFlight++; return; }
    if (this.#waiting.length >= this.#maxWaiting) throw new Error("unknown: too many questions to the reviewer are waiting for an answer");
    await new Promise<void>((ok, fail) => {
      const grant = (): void => { clearTimeout(timer); ok(); };
      const timer = setTimeout(() => {
        const at = this.#waiting.indexOf(grant);
        if (at >= 0) this.#waiting.splice(at, 1);
        fail(new Error(`unknown: no reviewer slot came free within ${this.#waitMs} ms`));
      }, this.#waitMs);
      this.#waiting.push(grant);
    });
  }

  /** Hands the slot to the next waiting call, or frees it. */
  #release(): void {
    const next = this.#waiting.shift();
    if (next !== undefined) next(); else this.#inFlight--;
  }

  async complete(route: string, request: { readonly system: string; readonly user: string }): Promise<string> { return (await this.completeDetailed(route, request)).text; }

  async completeDetailed(route: string, request: { readonly system: string; readonly user: string }): Promise<ModelReply> {
    // The texts are cut to the bound, never refused: the interrogator already builds them within it, so a cut means something upstream was larger than its own limit, and the model sees "(cut to fit)" at the end.
    const cut = (text: string, max: number): string => { const clean = redactText(String(text)); return clean.length > max ? `${clean.slice(0, max - 20)}\n(cut to fit)` : clean; };
    const asked = { system: cut(request.system, REVIEWER_LIMITS.system), user: cut(request.user, REVIEWER_LIMITS.user) };
    await this.#slot();
    try {
      const reply = this.#raw.completeDetailed !== undefined ? await this.#raw.completeDetailed(route, asked) : { text: await this.#raw.complete(route, asked) };
      if (reply === null || typeof reply !== "object" || typeof (reply as { text?: unknown }).text !== "string") throw new Error("unknown: the reviewer's model returned no text");
      const raw = (reply as ModelReply).text;
      const text = raw.length > REVIEWER_LIMITS.reply ? TOO_LONG : raw;
      const usage = (reply as ModelReply).usage;
      return { text, ...(usage === undefined ? {} : { usage }) };
    } finally { this.#release(); }
  }
}

/** The routes the second agent may use, read at each questioning from the owner's setting and the routing table's own rules. Throws (not run, with why) when none may be. */
export function reviewerRoute(deps: {
  readonly setting: () => Promise<unknown>;
  readonly routing: { select(request: RouteRequest): Promise<Selection & { revision: number }> };
  /** Which reviewer the route is for, for the words of a refusal (default `report`). */
  readonly purpose?: keyof typeof UNSET;
}): () => Promise<readonly string[]> {
  const unset = UNSET[deps.purpose ?? "report"];
  return async () => {
    const value = await deps.setting();
    if (typeof value !== "string" || value === "") throw new DomainError("unavailable", unset);
    let picked: Selection;
    try {
      // The owner's choice is the route; the table judges it by its own rules. The data may go to it (the owner named it) and a paid route is allowed (the daily cap on the controller's model calls still holds).
      picked = await deps.routing.select({ role: "safety-supervisor", prefer: value, contextTokens: REVIEWER_LIMITS.contextTokens, needs: [], data: "cloud-allowed", paidAuthorized: true });
    } catch (error) {
      throw new DomainError("unavailable", `the reviewer route ${value.slice(0, 80)} could not be checked against the routing table: ${redactText(error instanceof Error ? error.message : String(error)).slice(0, 160)}`);
    }
    const candidate = picked.candidates.find((c) => c.route === value);
    if (candidate === undefined || !candidate.eligible) throw new DomainError("unavailable", `the reviewer route ${value.slice(0, 80)} cannot be used: ${candidate === undefined ? "it is not in the routing table" : candidate.reasons.join("; ").slice(0, 200) || "it is not eligible"}`);
    return [value];
  };
}
