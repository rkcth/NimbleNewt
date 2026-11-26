import type { Change } from "../storage/types.js";
import { DomainError } from "./errors.js";

/**
 * Merges change lists that were built by independent guards (a fence, a pause gate, a generation gate). Storage refuses an operation that names one record twice, so several guards
 * that check the same record (the assignment, for one) must be reduced to one entry: a check repeated with the same revision is kept once, a check next to a write of the same
 * record at the same revision is dropped (the write already guards it), and two checks that expect different revisions of one record cannot both hold, so it is `stale_revision`
 * (the caller reads again and decides again). A check beside a create of the same record cannot hold either (one guard read the record absent, another read it after someone
 * created it, so the reads straddle a commit): that is `stale_revision` too, not a list storage would refuse as naming the record twice. Writes keep their order; two writes to one
 * record are not merged and still fail in storage.
 */
export function mergeChanges(...lists: readonly (readonly Change[])[]): Change[] {
  const all = lists.flat();
  const key = (c: Change): string => `${c.ref.kind}\0${c.ref.id}`;
  const expected = new Map<string, number>();
  const created = new Set<string>();
  for (const c of all) { if (c.type === "update") expected.set(key(c), c.expectedRevision); if (c.type === "create") created.add(key(c)); }
  const seen = new Map<string, number>();
  const out: Change[] = [];
  for (const c of all) {
    if (c.type !== "check") { out.push(c); continue; }
    const k = key(c);
    if (created.has(k)) throw new DomainError("stale_revision", `${c.ref.kind} ${c.ref.id} is both created and checked at revision ${c.expectedRevision}: the guards read it before and after another commit; read it again`);
    const prior = seen.get(k) ?? expected.get(k);
    if (prior !== undefined) {
      if (prior !== c.expectedRevision) throw new DomainError("stale_revision", `${c.ref.kind} ${c.ref.id} is guarded at two different revisions (${prior} and ${c.expectedRevision}); read it again`);
      continue;
    }
    seen.set(k, c.expectedRevision);
    out.push(c);
  }
  return out;
}
