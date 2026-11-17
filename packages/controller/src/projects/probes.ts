import http from "node:http";
import https from "node:https";
import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import type { CheckProbe, CheckProbeResult } from "./check-runner.js";
import { invalid, noCredential } from "./common.js";
import type { ResponsibilityBody } from "./responsibilities.js";

/**
 * A deterministic HTTP check of a responsibility (card P04, "P04i"): the owner names a health address; when a check of that responsibility comes due the controller asks the address once and records what it answered, with no
 * agent and no model. A responsibility with no probe set is unchanged: its due checks go to the answerable agent as bounded tasks.
 *
 * Only the owner sets, changes or reads a probe: the setting makes NimbleNewt itself reach an address, so it is the owner's approval of that reach, and an agent (even one that may change the responsibility) cannot point it anywhere.
 */
export const PROBE_LIMITS = { url: 500, timeoutSeconds: { min: 1, max: 30, default: 10 }, expectStatus: 10, maxInFlight: 8, keepMinutes: 10, entries: 500, shownUrl: 120 } as const;

export interface ProbeSetting {
  readonly url: string;
  /** HTTP statuses that count as healthy; empty means any 2xx. */
  readonly expectStatus: readonly number[];
  readonly timeoutSeconds: number;
}
interface ProbeBody { readonly responsibilityId: string; readonly projectId: string; readonly url?: string; readonly expectStatus?: readonly number[]; readonly timeoutSeconds?: number; readonly setBy: string; readonly setAt: string }

const PROBE = "responsibility-probe";
const RESPONSIBILITY_ID = /^rsp-[a-z2-7]{20}$/;

/** The address as shown in history and answers: scheme, host, port and path only (never a query or anything after it). */
export const shownUrl = (url: string): string => {
  try { const u = new URL(url); return `${u.protocol}//${u.host}${u.pathname}`.slice(0, PROBE_LIMITS.shownUrl); } catch { return "(unreadable address)"; }
};

/** An address the controller may ask: http or https, a host, no user name or password, no `#` part, no text that looks like a credential, at most 500 characters. */
export function probeUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > PROBE_LIMITS.url) return invalid("url", `must be an http or https address of at most ${PROBE_LIMITS.url} characters`);
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return invalid("url", "must not contain spaces or control characters");
  let u: URL;
  try { u = new URL(value); } catch { return invalid("url", "is not an address (for example https://web.example.com/health)"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") return invalid("url", "must start with http:// or https://");
  if (u.hostname === "") return invalid("url", "must name a host");
  if (u.username !== "" || u.password !== "") return invalid("url", "must not carry a user name or password; a health address that needs a credential cannot be probed");
  if (u.hash !== "") return invalid("url", "must not have a # part");
  noCredential(value, "url");
  // The path is shown in history, so text written with %-escapes is checked as it reads once decoded, as the query is.
  for (const part of [u.pathname, u.search]) {
    let decoded = part;
    try { decoded = decodeURIComponent(part); } catch { /* not decodable: checked as written */ }
    noCredential(decoded, "url");
  }
  return value;
}

const statuses = (value: unknown): number[] => {
  if (!Array.isArray(value) || value.length === 0 || value.length > PROBE_LIMITS.expectStatus) return invalid("expectStatus", `must be a list of 1 to ${PROBE_LIMITS.expectStatus} HTTP statuses`);
  return [...new Set(value.map((s, i) => (typeof s === "number" && Number.isSafeInteger(s) && s >= 100 && s <= 599 ? s : invalid(`expectStatus[${i}]`, "must be an HTTP status from 100 to 599"))))].sort((a, b) => a - b);
};
const seconds = (value: unknown): number => {
  const t = PROBE_LIMITS.timeoutSeconds;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= t.min && value <= t.max ? value : invalid("timeoutSeconds", `must be a whole number of seconds from ${t.min} to ${t.max}`);
};

function parse(body: unknown): ProbeSetting | undefined | "damaged" {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "damaged";
  const b = body as Record<string, unknown>;
  if (b["url"] === undefined) return undefined;
  try {
    const url = probeUrl(b["url"]);
    const expectStatus = b["expectStatus"] === undefined ? [] : statuses(b["expectStatus"]);
    const timeoutSeconds = b["timeoutSeconds"] === undefined ? PROBE_LIMITS.timeoutSeconds.default : seconds(b["timeoutSeconds"]);
    return { url, expectStatus, timeoutSeconds };
  } catch { return "damaged"; }
}

export interface ProbeView { readonly responsibilityId: string; readonly revision: number; readonly probe?: ProbeSetting & { readonly setBy: string; readonly setAt: string } }

export class ResponsibilityProbeService {
  readonly #runner: CommandRunner;
  readonly #duty: (id: string) => Promise<ResponsibilityBody | undefined>;
  private constructor(runner: CommandRunner) {
    this.#runner = runner;
    this.#duty = async (id) => (await this.#runner.get("responsibility", id))?.body as unknown as ResponsibilityBody | undefined;
  }
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): ResponsibilityProbeService { return new ResponsibilityProbeService(new CommandRunner(storage, epoch, options)); }

  /** Owner only. A responsibility with no probe has `revision` 0 (or the revision of a cleared one) and no `probe`. */
  async get(by: Principal, responsibilityId: unknown): Promise<ProbeView> {
    if (by.kind !== "owner" || by.taskScope !== undefined) throw new DomainError("forbidden", `${by.id} may not read responsibility probes`);
    const id = typeof responsibilityId === "string" && RESPONSIBILITY_ID.test(responsibilityId) ? responsibilityId : invalid("responsibilityId", "is not a responsibility ID");
    if ((await this.#duty(id)) === undefined) throw new DomainError("not_found", "no such responsibility");
    const found = await this.#runner.get(PROBE, id);
    if (found === undefined) return { responsibilityId: id, revision: 0 };
    const p = parse(found.body);
    if (p === "damaged") throw new DomainError("unavailable", "the stored probe of this responsibility is damaged; set it again (responsibility.probe.set)");
    const b = found.body as unknown as ProbeBody;
    return { responsibilityId: id, revision: found.revision, ...(p === undefined ? {} : { probe: { ...p, setBy: b.setBy, setAt: b.setAt } }) };
  }

  /**
   * Owner only. `url` sets the address (null clears the probe: the responsibility's checks go to its agent again); `expectStatus` the statuses that count as healthy (null or absent: any 2xx), `timeoutSeconds` how long to wait (1 to 30,
   * default 10). Setting replaces the whole probe. Refused on a retired responsibility (clearing is always allowed).
   */
  async set(owner: Principal, command: NoActor & { responsibilityId?: unknown; url?: unknown; expectStatus?: unknown; timeoutSeconds?: unknown; expectedRevision?: unknown }): Promise<{ revision: number; shown?: string }> {
    if (owner.kind !== "owner" || owner.taskScope !== undefined) throw new DomainError("forbidden", `${owner.id} may not set responsibility probes`);
    const bad = Object.keys(command).filter((k) => !["commandId", "responsibilityId", "url", "expectStatus", "timeoutSeconds", "expectedRevision"].includes(k));
    if (bad.length > 0) invalid(bad[0]!, "is not a field of this command");
    const id = typeof command.responsibilityId === "string" && RESPONSIBILITY_ID.test(command.responsibilityId) ? command.responsibilityId : invalid("responsibilityId", "is not a responsibility ID");
    if (command.url === undefined) invalid("url", "give the address to ask, or null to clear the probe");
    const clearing = command.url === null;
    if (clearing && (command.expectStatus !== undefined || command.timeoutSeconds !== undefined)) invalid("url", "a probe being cleared takes no expectStatus or timeoutSeconds");
    const url = clearing ? undefined : probeUrl(command.url);
    const expectStatus = command.expectStatus === undefined || command.expectStatus === null ? undefined : statuses(command.expectStatus);
    const timeoutSeconds = command.timeoutSeconds === undefined || command.timeoutSeconds === null ? undefined : seconds(command.timeoutSeconds);
    if (command.expectedRevision !== undefined && !(typeof command.expectedRevision === "number" && Number.isSafeInteger(command.expectedRevision) && command.expectedRevision >= 0)) invalid("expectedRevision", "must be a whole number");
    const result = await this.#runner.command("responsibility.probe.set", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { responsibilityId: id, url: url ?? null, expectStatus: expectStatus ?? null, timeoutSeconds: timeoutSeconds ?? null, expectedRevision: (command.expectedRevision as number | undefined) ?? null },
      build: async () => {
        const duty = await this.#duty(id);
        if (duty === undefined) throw new DomainError("not_found", "no such responsibility");
        if (!clearing && duty.state === "retired") throw new DomainError("invalid_command", "responsibilityId: the responsibility is retired; its checks are no longer taken", { field: "responsibilityId" });
        const ref = { kind: PROBE, id };
        const current = await this.#runner.get(PROBE, id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the probe is at revision ${current?.revision ?? 0}, not ${command.expectedRevision as number}`, { currentRevision: current?.revision ?? 0 });
        const body: ProbeBody = { responsibilityId: id, projectId: duty.projectId, ...(url === undefined ? {} : { url }), ...(expectStatus === undefined ? {} : { expectStatus }), ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }), setBy: owner.id, setAt: this.#runner.now() };
        return {
          ref, creates: current === undefined,
          changes: [current === undefined ? { type: "create" as const, ref, body: body as unknown as JsonObject } : { type: "update" as const, ref, expectedRevision: current.revision, body: body as unknown as JsonObject }],
          detail: { responsibilityId: id, projectId: duty.projectId, probe: url === undefined ? null : shownUrl(url) },
        };
      },
    }));
    return { revision: result.revision, ...(url === undefined ? {} : { shown: shownUrl(url) }) };
  }

  /** For the controller's check runner only (no principal): the probe of a responsibility, `undefined` when none is set, `"damaged"` when the stored record cannot be read. */
  async setting(responsibilityId: string): Promise<ProbeSetting | undefined | "damaged"> {
    const found = await this.#runner.get(PROBE, responsibilityId);
    return found === undefined ? undefined : parse(found.body);
  }
}

// ---- asking the address ---------------------------------------------------------------------------------------------------------

/** What one request found: the status of the answer, or why there was none (a short code, never the server's text). */
export type ProbeAnswer = { readonly status: number; readonly ms: number } | { readonly error: string; readonly ms: number };
export type ProbeRequest = (url: string, timeoutMs: number, signal?: AbortSignal) => Promise<ProbeAnswer>;

const CODE = /^[A-Z][A-Z0-9_]{1,39}$/;

/**
 * One GET with Node's own client: no redirect is followed (a redirect is an answer like any other), no body is read (the socket is closed as soon as the status is in), no keep-alive, the platform's certificate checks. It never throws.
 * `signal` ends it at once (the controller closing): the answer is then `ABORTED` and the connection is closed.
 */
export const nodeProbeRequest: ProbeRequest = (url, timeoutMs, signal) => new Promise((resolve) => {
  const started = Date.now();
  let done = false;
  let request: http.ClientRequest | undefined;
  const onAbort = (): void => finish({ error: "ABORTED" });
  const finish = (answer: { status: number } | { error: string }): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    request?.destroy();
    resolve({ ...answer, ms: Date.now() - started });
  };
  const timer = setTimeout(() => finish({ error: `TIMEOUT` }), timeoutMs);
  timer.unref?.();
  if (signal?.aborted === true) { finish({ error: "ABORTED" }); return; }
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    // The scheme as the address parser reads it (`HTTPS://` is https), never a prefix of the text.
    const client = new URL(url).protocol === "https:" ? https : http;
    request = client.request(url, { method: "GET", agent: false, headers: { "user-agent": "NimbleNewt-check/1", accept: "*/*" } }, (response) => {
      const status = response.statusCode ?? 0;
      response.destroy();
      finish({ status });
    });
    request.on("error", (error: NodeJS.ErrnoException) => finish({ error: typeof error.code === "string" && CODE.test(error.code) ? error.code : "REQUEST_FAILED" }));
    request.end();
  } catch { finish({ error: "REQUEST_FAILED" }); }
});

const PLAIN: Readonly<Record<string, string>> = { TIMEOUT: "no answer in time", ECONNREFUSED: "the connection was refused", ENOTFOUND: "the host name was not found", EAI_AGAIN: "the host name could not be looked up", ECONNRESET: "the connection was cut", EHOSTUNREACH: "the host could not be reached", ENETUNREACH: "the network could not be reached" };

/** The probe's finding as a check result: an expected status is `ok`, anything else `failed`. */
export function probeResult(setting: ProbeSetting, answer: ProbeAnswer, inWindow: boolean): CheckProbeResult {
  const where = shownUrl(setting.url);
  const window = inWindow ? " A maintenance window was on." : "";
  if ("error" in answer) {
    const why = answer.error === "TIMEOUT" ? `no answer within ${setting.timeoutSeconds} s` : `${PLAIN[answer.error] ?? "the request failed"} (${answer.error})`;
    return { outcome: "failed", summary: `HTTP check of ${where}: ${why}.${window}` };
  }
  const expected = setting.expectStatus.length === 0 ? answer.status >= 200 && answer.status <= 299 : setting.expectStatus.includes(answer.status);
  const wanted = setting.expectStatus.length === 0 ? "200-299" : setting.expectStatus.join(", ");
  return { outcome: expected ? "ok" : "failed", summary: `HTTP check of ${where} answered ${answer.status} in ${answer.ms} ms${expected ? "" : ` (expected ${wanted})`}.${window}` };
}

interface Asked { readonly asked: string; readonly started: number; settled?: number; result?: CheckProbeResult }
/** What a result was asked under: an answer for another address, other healthy statuses or another wait is not this probe's answer. */
const askedAs = (s: ProbeSetting): string => JSON.stringify([s.url, s.expectStatus, s.timeoutSeconds]);

/**
 * The check runner's probe from the owner's HTTP probes. The request is never waited for inside the runner's pass (a slow or silent host must not hold up the controller's loop): the first pass that meets the due check starts it and
 * answers `"later"` (the check stays owed), and a later pass takes the result. At most `maxInFlight` requests at once; a result not taken within `keepMinutes` is dropped (the check is asked again). Kept in memory only: after a restart
 * the check, still owed, is simply asked again. A responsibility with no probe gives `undefined` (its agent takes the check); a damaged probe record gives `attention`, never a healthy result.
 *
 * One request per responsibility, not per owed check: a `check` entry finishes every owed check of its responsibility, so several owed checks share the answer. `primary` (when given) is asked before each new request, so a
 * controller that is no longer the primary one sends nothing; `signal` ends the requests out and starts no more (the controller closing).
 */
export function httpCheckProbe(deps: { readonly setting: (responsibilityId: string) => Promise<ProbeSetting | undefined | "damaged">; readonly request?: ProbeRequest; readonly now?: () => number; readonly maxInFlight?: number; readonly primary?: () => Promise<boolean>; readonly signal?: AbortSignal }): CheckProbe {
  const asked = new Map<string, Asked>();
  const request = deps.request ?? nodeProbeRequest;
  const now = deps.now ?? (() => Date.now());
  const max = deps.maxInFlight ?? PROBE_LIMITS.maxInFlight;
  return async ({ responsibility, check }) => {
    const at = now();
    for (const [k, a] of asked) if (a.settled !== undefined && at - a.settled > PROBE_LIMITS.keepMinutes * 60_000) asked.delete(k);
    const key = responsibility.id;
    const setting = await deps.setting(key);
    if (setting === undefined) { asked.delete(key); return undefined; }
    if (setting === "damaged") return { outcome: "attention", summary: "The probe set for this responsibility is damaged, so this check was not taken; set it again (responsibility.probe.set)." };
    const earlier = asked.get(key);
    if (earlier !== undefined) {
      if (earlier.result === undefined) return "later";
      asked.delete(key);
      // A result for an address (or healthy statuses, or wait) the owner has since changed is not this probe's answer: ask again.
      if (earlier.asked === askedAs(setting)) return earlier.result;
    }
    const full = (): boolean => {
      let inFlight = 0;
      for (const a of asked.values()) if (a.result === undefined) inFlight++;
      return inFlight >= max || asked.size >= PROBE_LIMITS.entries;
    };
    const stopped = (): boolean => deps.signal?.aborted === true;
    if (stopped() || full()) return "later";
    if (deps.primary !== undefined && !(await deps.primary())) return "later";
    // Another pass may have started this one while the primary check was read.
    if (stopped() || asked.has(key) || full()) return "later";
    const entry: Asked = { asked: askedAs(setting), started: at };
    asked.set(key, entry);
    void request(setting.url, setting.timeoutSeconds * 1000, deps.signal)
      .catch((): ProbeAnswer => ({ error: "REQUEST_FAILED", ms: 0 }))
      .then((answer) => {
        // Ended because the controller is closing: not an answer from the address, so nothing is kept (after a restart the check, still owed, is asked again).
        if ("error" in answer && answer.error === "ABORTED") { if (asked.get(key) === entry) asked.delete(key); return; }
        entry.result = probeResult(setting, answer, check.inMaintenanceWindow === true); entry.settled = now();
      });
    return "later";
  };
}
