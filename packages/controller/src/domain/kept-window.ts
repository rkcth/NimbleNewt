/**
 * The listed window of a per-project index (cards B04 and B05, retention slice). A project lists at most `cap` records, oldest first. A new record that would make the list longer first moves the oldest
 * ENDED records out of it (an open one is never moved), so ended records stop taking room in the list and only open records can fill it. A record moved out is archived: it is kept unchanged in storage and
 * stays readable by its ID with the same rights; only its place in the listing is given up, and the index counts how many were moved out. When every listed record is open there is no room, and the caller
 * refuses (fail closed) rather than dropping an open record.
 */
export function keptWindow(ids: readonly string[], isOpen: (id: string) => boolean, cap: number, add: string): { ids: string[]; archived: string[] } | undefined {
  const kept = [...ids];
  const archived: string[] = [];
  while (kept.length >= cap) {
    const at = kept.findIndex((id) => !isOpen(id));
    if (at < 0) return undefined;
    archived.push(kept[at]!);
    kept.splice(at, 1);
  }
  kept.push(add);
  return { ids: kept, archived };
}

/** How many of `waiting` (record ID to its asker) belong to `by`. */
export const waitingOf = (waiting: Readonly<Record<string, string>>, by: string): number => Object.values(waiting).filter((v) => v === by).length;
