import { DomainError } from "../domain/errors.js";
import { ACTION_CLASSES, ENVIRONMENTS, type ActionClass, type Environment } from "../policy/catalog.js";
import { CELL_KEYS, MODES, PROFILES, type Mode, type Profile } from "../policy/engine.js";

/**
 * What an interpreter may say about a policy instruction (card U04). It is a closed vocabulary: each change is one operation on one of the controller's own services (the approval policy of A07,
 * the review policy of A05, approval grants of A02, the configuration layers of U10), and nothing outside it can be expressed. The service checks every field again against records and policy; this
 * file only checks the shape. A wish the vocabulary cannot say is the interpreter's `conditions` (text), which the service reports as not applied.
 */
export type PolicyScope = "installation" | "project";
export interface PolicyWhere { readonly projectName?: string; readonly projectId?: string }
export type LayerName = "installation" | "team" | "agent" | "task";

export type PolicyEditChange =
  | { readonly type: "profile"; readonly to: Profile }
  | ({ readonly type: "cell"; readonly class: ActionClass; readonly environment: Environment; readonly mode: Mode | "default"; readonly scope: PolicyScope } & PolicyWhere)
  | ({ readonly type: "gate"; readonly on: boolean; readonly scope: PolicyScope } & PolicyWhere)
  | ({ readonly type: "environment"; readonly environment: Environment } & PolicyWhere)
  | { readonly type: "lock" | "unlock"; readonly cells: readonly string[] }
  | ({ readonly type: "reserve" | "unreserve"; readonly tool: string } & PolicyWhere)
  | ({ readonly type: "grant"; readonly grantee: string; readonly approve: Approve; readonly environments?: readonly Environment[]; /** null: the grant has no end. */ readonly lengthDays?: number | null; readonly until?: string; /** null: the owner says there is no spending limit. */ readonly spendLimit?: number | null; readonly audiences?: readonly string[] } & PolicyWhere)
  | ({ readonly type: "revoke"; readonly grantee: string; readonly approve: Approve } & PolicyWhere)
  | { readonly type: "setting"; readonly layer: LayerName; readonly scopeId?: string; readonly key: string; readonly value?: unknown; readonly remove?: true };

/** An approval grant names a class of action or one tool, never both and never a wildcard. */
export interface Approve { readonly class?: ActionClass; readonly tool?: string }

export const POLICY_INTENT_LIMITS = { conditions: 5, condition: 300, name: 200, cells: 30, audiences: 20, value: 2000 } as const;
const TOOL = /^[a-z][a-z0-9._-]{0,79}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const known = (o: Record<string, unknown>, keys: readonly string[], field: string): void => { for (const k of Object.keys(o)) if (!keys.includes(k)) invalid(`${field}.${k}`, "is not a field of this change"); };
const oneOf = <T extends string>(v: unknown, set: readonly T[], field: string): T => (typeof v === "string" && (set as readonly string[]).includes(v) ? (v as T) : invalid(field, `must be one of ${set.join(", ")}`));
const name = (v: unknown, field: string): string => (typeof v === "string" && v.trim().length >= 1 && v.length <= POLICY_INTENT_LIMITS.name ? v : invalid(field, `must be text of 1 to ${POLICY_INTENT_LIMITS.name} characters`));

function where(e: Record<string, unknown>, field: string): PolicyWhere {
  if (e["projectName"] !== undefined && e["projectId"] !== undefined) invalid(field, "give either projectName or projectId, not both");
  return { ...(e["projectName"] === undefined ? {} : { projectName: name(e["projectName"], `${field}.projectName`) }), ...(e["projectId"] === undefined ? {} : { projectId: name(e["projectId"], `${field}.projectId`) }) };
}
function approve(v: unknown, field: string): Approve {
  if (!isObject(v)) return invalid(field, "must be an object with a class or a tool");
  known(v, ["class", "tool"], field);
  if ((v["class"] === undefined) === (v["tool"] === undefined)) return invalid(field, "needs exactly one of class and tool");
  return v["class"] !== undefined ? { class: oneOf(v["class"], ACTION_CLASSES, `${field}.class`) } : { tool: typeof v["tool"] === "string" && TOOL.test(v["tool"]) ? v["tool"] : invalid(`${field}.tool`, "must be a tool name in lower case") };
}

/** Strictly checks the shape of one policy change. */
export function checkPolicyChange(raw: unknown, field: string): PolicyEditChange {
  if (!isObject(raw)) return invalid(field, "must be an object");
  const W = ["projectName", "projectId"];
  switch (raw["type"]) {
    case "profile": known(raw, ["type", "to"], field); return { type: "profile", to: oneOf(raw["to"], PROFILES, `${field}.to`) };
    case "cell": {
      known(raw, ["type", "class", "environment", "mode", "scope", ...W], field);
      return { type: "cell", class: oneOf(raw["class"], ACTION_CLASSES, `${field}.class`), environment: oneOf(raw["environment"], ENVIRONMENTS, `${field}.environment`), mode: oneOf(raw["mode"], [...MODES, "default"] as const, `${field}.mode`), scope: oneOf(raw["scope"], ["installation", "project"] as const, `${field}.scope`), ...where(raw, field) };
    }
    case "gate": {
      known(raw, ["type", "on", "scope", ...W], field);
      return { type: "gate", on: typeof raw["on"] === "boolean" ? raw["on"] : invalid(`${field}.on`, "must be true or false"), scope: oneOf(raw["scope"], ["installation", "project"] as const, `${field}.scope`), ...where(raw, field) };
    }
    case "environment": known(raw, ["type", "environment", ...W], field); return { type: "environment", environment: oneOf(raw["environment"], ENVIRONMENTS, `${field}.environment`), ...where(raw, field) };
    case "lock": case "unlock": {
      known(raw, ["type", "cells"], field);
      const cells = raw["cells"];
      if (!Array.isArray(cells) || cells.length < 1 || cells.length > POLICY_INTENT_LIMITS.cells) return invalid(`${field}.cells`, `must be 1 to ${POLICY_INTENT_LIMITS.cells} cells such as commit.free, or gate`);
      return { type: raw["type"], cells: [...new Set(cells.map((c, i) => (typeof c === "string" && (c === "gate" || (CELL_KEYS as readonly string[]).includes(c)) ? c : invalid(`${field}.cells[${i}]`, "is not a cell (a class and a tier, such as commit.free) or gate"))))] };
    }
    case "reserve": case "unreserve": {
      known(raw, ["type", "tool", ...W], field);
      return { type: raw["type"], tool: typeof raw["tool"] === "string" && TOOL.test(raw["tool"]) ? raw["tool"] : invalid(`${field}.tool`, "must be a tool name in lower case"), ...where(raw, field) };
    }
    case "grant": {
      known(raw, ["type", "grantee", "approve", "environments", "lengthDays", "until", "spendLimit", "audiences", ...W], field);
      const environments = raw["environments"];
      if (environments !== undefined && (!Array.isArray(environments) || environments.length < 1 || environments.length > ENVIRONMENTS.length)) invalid(`${field}.environments`, "must be a list of environments");
      const audiences = raw["audiences"];
      if (audiences !== undefined && (!Array.isArray(audiences) || audiences.length < 1 || audiences.length > POLICY_INTENT_LIMITS.audiences)) invalid(`${field}.audiences`, `must be 1 to ${POLICY_INTENT_LIMITS.audiences} account or audience names`);
      if (raw["lengthDays"] !== undefined && raw["until"] !== undefined) invalid(field, "give either lengthDays or until, not both");
      return {
        type: "grant", grantee: name(raw["grantee"], `${field}.grantee`), approve: approve(raw["approve"], `${field}.approve`),
        ...(environments === undefined ? {} : { environments: [...new Set((environments as unknown[]).map((x, i) => oneOf(x, ENVIRONMENTS, `${field}.environments[${i}]`)))] }),
        ...(raw["lengthDays"] === undefined ? {} : { lengthDays: raw["lengthDays"] === null ? null : typeof raw["lengthDays"] === "number" && Number.isSafeInteger(raw["lengthDays"]) && raw["lengthDays"] >= 1 ? raw["lengthDays"] : invalid(`${field}.lengthDays`, "must be a whole number of days, 1 or more") }),
        ...(raw["until"] === undefined ? {} : { until: typeof raw["until"] === "string" && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z)?$/.test(raw["until"]) && !Number.isNaN(Date.parse(raw["until"])) ? raw["until"] : invalid(`${field}.until`, "must be a date such as 2026-10-30 or a UTC time such as 2026-10-30T17:00:00Z") }),
        ...(raw["spendLimit"] === undefined ? {} : { spendLimit: raw["spendLimit"] === null ? null : typeof raw["spendLimit"] === "number" && Number.isFinite(raw["spendLimit"]) && raw["spendLimit"] >= 0 ? raw["spendLimit"] : invalid(`${field}.spendLimit`, "must be a number, 0 or more") }),
        ...(audiences === undefined ? {} : { audiences: [...new Set((audiences as unknown[]).map((x, i) => name(x, `${field}.audiences[${i}]`)))] }),
        ...where(raw, field),
      };
    }
    case "revoke": known(raw, ["type", "grantee", "approve", ...W], field); return { type: "revoke", grantee: name(raw["grantee"], `${field}.grantee`), approve: approve(raw["approve"], `${field}.approve`), ...where(raw, field) };
    case "setting": {
      known(raw, ["type", "layer", "scopeId", "key", "value", "remove"], field);
      if ((raw["value"] === undefined) === (raw["remove"] === undefined)) return invalid(field, "needs exactly one of value and remove");
      if (raw["remove"] !== undefined && raw["remove"] !== true) invalid(`${field}.remove`, "must be true");
      if (raw["value"] !== undefined && JSON.stringify(raw["value"]).length > POLICY_INTENT_LIMITS.value) invalid(`${field}.value`, "is too long");
      return { type: "setting", layer: oneOf(raw["layer"], ["installation", "team", "agent", "task"] as const, `${field}.layer`), ...(raw["scopeId"] === undefined ? {} : { scopeId: name(raw["scopeId"], `${field}.scopeId`) }), key: name(raw["key"], `${field}.key`), ...(raw["value"] === undefined ? {} : { value: raw["value"] }), ...(raw["remove"] === undefined ? {} : { remove: true as const }) };
    }
    default: return invalid(`${field}.type`, "is not a kind of policy change this system supports");
  }
}

export function checkConditions(raw: unknown, field: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > POLICY_INTENT_LIMITS.conditions) return invalid(field, `must be a list of at most ${POLICY_INTENT_LIMITS.conditions} texts`);
  return raw.map((c, i) => (typeof c === "string" && c.trim().length >= 1 && c.length <= POLICY_INTENT_LIMITS.condition ? c : invalid(`${field}[${i}]`, `must be text of 1 to ${POLICY_INTENT_LIMITS.condition} characters`)));
}
