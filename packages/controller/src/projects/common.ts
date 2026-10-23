import { DomainError } from "../domain/errors.js";
import type { CommandRunner } from "../domain/runner.js";
import { allows } from "../security/access.js";
import type { Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { Aggregate } from "../storage/types.js";

/** Bounds shared by the project work records (card P01). */
export const PROJECT_WORK_LIMITS = {
  label: 80, locator: 500, path: 200, paths: 50, workstreams: 20, milestones: 50, participants: 50, role: 80, description: 1000, name: 120,
  responsibilityText: 2000, eventSources: 20, eventSource: 120, permittedActions: 100, windows: 14, managed: 50, summary: 1000, note: 500,
  /** Records of one kind that a check reads before it refuses (a scan never truncates silently). */
  scan: 5000,
} as const;

export const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

/** An ID chosen by the caller inside a record (a workstream, a milestone, a repository handle). */
export const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const slug = (value: unknown, field: string): string => (typeof value === "string" && SLUG.test(value) ? value : invalid(field, "must be 1 to 40 lower-case letters, digits or hyphens, starting with a letter or digit"));

/** Text that would be redacted as a credential is refused, never stored: a locator, note or summary is not a place for a secret. */
export function noCredential(value: string, field: string): string {
  if (redactText(value) !== value) invalid(field, "looks like it contains a credential; give a reference to where it is kept instead");
  return value;
}

/** A forbidden answer that reads the same whether the record is missing or the caller may not see it (and names no project). */
export const hidden = (by: Principal, what: string): DomainError => new DomainError("forbidden", `${by.id} may not ${what}`);

/** Every record of a kind that satisfies `keep`, or `unavailable` when there are more than `limit` records of the kind (never a silent cut). */
export async function scanAll(runner: CommandRunner, kind: string, limit: number, keep: (a: Aggregate) => boolean): Promise<Aggregate[]> {
  const out: Aggregate[] = [];
  const size = Math.min(500, limit + 1);
  let after: string | undefined;
  let seen = 0;
  for (;;) {
    const page = await runner.list(kind, { ...(after === undefined ? {} : { afterId: after }), limit: size });
    seen += page.length;
    for (const r of page) if (keep(r)) out.push(r);
    if (page.length < size) return out;
    if (seen > limit) throw new DomainError("unavailable", `there are more than ${limit} ${kind} records, too many to check safely`);
    after = page[page.length - 1]!.id;
  }
}

/** Whether `by` may take the action in the project (a task credential only in its own project). */
export const may = (by: Principal, action: string, projectId: string, resource?: { kind: string; id: string }): boolean =>
  allows(by, action, projectId, resource === undefined ? {} : { resource });

// ---- dates --------------------------------------------------------------------------------------------------------------------

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const STAMP = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/;

/** A due date: `YYYY-MM-DD` (due at the end of that UTC day) or a full UTC timestamp. Impossible dates are refused. */
export function dueDate(value: unknown, field: string): string {
  if (typeof value !== "string") return invalid(field, "must be a date (YYYY-MM-DD) or a UTC timestamp");
  const m = DATE.exec(value) ?? STAMP.exec(value);
  if (m === null) return invalid(field, "must be a date (YYYY-MM-DD) or a UTC timestamp such as 2026-12-31T17:00:00Z");
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return invalid(field, "is not a real date");
  return value;
}

/** The moment a due date falls due, in milliseconds. A day-only date falls due at the very end of that day. */
export const dueAt = (value: string): number => (DATE.test(value) ? Date.parse(`${value}T23:59:59.999Z`) : Date.parse(value));
