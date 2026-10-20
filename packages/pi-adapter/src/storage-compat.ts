import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defineDoc, type Harness, type Storage } from "@earendil-works/pi-durable";
import type { StorageInfo } from "@nimblenewt/contracts";
import { HISTORY_FORMAT, SUPPORTED_HISTORY_FORMATS } from "./checkpoints.js";
import { IncompatibleStorageError, UnmarkedStorageError } from "./errors.js";
import { PINNED_PI_DURABLE_VERSION } from "./runtime.js";

export const STORAGE_MARKER_FORMAT = 1;

interface MarkerState {
  markerFormat?: number;
  runtimeVersion?: string;
  historyFormat?: string;
  adoptedUnmarked?: boolean;
}

/** Session-wide record of who wrote this storage. Absent until the adapter first accepts the storage. */
const StorageMarker = defineDoc<MarkerState & Record<string, never>>({
  kind: "nimblenewt.storage",
  version: 1,
  scope: "session",
  initial: () => ({}) as unknown as MarkerState & Record<string, never>,
});

/**
 * Migrations from storage written by another Pi Durable version to this adapter's. None are defined: only the pinned
 * version is understood, so every other version is refused and left untouched. A migration added here must be atomic
 * (one commit) so a failure leaves the original storage exactly as it was.
 */
export const STORAGE_MIGRATIONS: readonly { readonly from: string; readonly to: string }[] = [];

const KNOWN_PI_ENTRY_KINDS: ReadonlySet<string> = new Set(["pi.user", "pi.assistant", "pi.system", "pi.tool-result", "pi.compaction", "pi.reset"]);
const MAX_FINDINGS = 20;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";

/**
 * Read-only check that every entry of every conversation has the shape this adapter relies on. It cannot prove a storage
 * compatible, but it catches storage written by a different layout or a newer runtime. Returns what it found wrong.
 */
export async function scanStorage(storage: Storage): Promise<{ readonly conversations: number; readonly entries: number; readonly findings: string[] }> {
  const findings: string[] = [];
  let conversations = 0;
  let entries = 0;
  let conversationCursor;
  for (;;) {
    const page = await storage.scanConversations({}, 100, conversationCursor, context);
    for (const conversation of page.items) {
      conversations += 1;
      let entryCursor;
      for (;;) {
        const batch = await storage.scanEntries({ conversationId: conversation.id, order: "ascending" }, 200, entryCursor, context);
        for (const entry of batch.items) {
          entries += 1;
          const where = `conversation ${conversation.id} entry ${entry.id}`;
          const message = Array.isArray(entry.model) ? (entry.model[0] as unknown) : undefined;
          if (entry.kind.startsWith("pi.") && !KNOWN_PI_ENTRY_KINDS.has(entry.kind)) findings.push(`${where}: unknown entry kind ${entry.kind}`);
          else if (entry.kind === "pi.tool-result" && !(isRecord(message) && message.role === "toolResult" && Array.isArray(message.content))) findings.push(`${where}: tool result without content`);
          else if ((entry.kind === "pi.user" || entry.kind === "pi.assistant") && !isRecord(message)) findings.push(`${where}: ${entry.kind} without a model message`);
        }
        if (batch.next === undefined || findings.length >= MAX_FINDINGS) break;
        entryCursor = batch.next;
      }
    }
    if (page.next === undefined || findings.length >= MAX_FINDINGS) break;
    conversationCursor = page.next;
  }
  return { conversations, entries, findings };
}

export async function readStorageInfo(harness: Harness): Promise<StorageInfo | undefined> {
  const marker = (await harness.snapshot(StorageMarker, context)) as MarkerState | undefined;
  if (marker?.markerFormat === undefined) return undefined;
  return { markerFormat: marker.markerFormat, runtimeVersion: marker.runtimeVersion ?? "", historyFormat: marker.historyFormat ?? "", adoptedUnmarked: marker.adoptedUnmarked === true };
}

async function writeMarker(harness: Harness, adoptedUnmarked: boolean): Promise<void> {
  await harness.commit(async (tx) => {
    const marker = (await tx.doc(StorageMarker)) as unknown as MarkerState;
    marker.markerFormat = STORAGE_MARKER_FORMAT;
    marker.runtimeVersion = PINNED_PI_DURABLE_VERSION;
    marker.historyFormat = HISTORY_FORMAT;
    marker.adoptedUnmarked = adoptedUnmarked;
  }, context);
}

/**
 * Decides whether this adapter may use an opened storage, and records its marker when it first accepts it. Everything
 * before the marker write is read-only, so a refusal leaves the storage exactly as it was.
 *  - marker for the pinned runtime and a known layout: accept.
 *  - marker for another runtime version or layout: refuse (no migrations exist).
 *  - no marker, nothing stored: accept and write the marker.
 *  - no marker, data stored: refuse unless the controller asks to adopt it; adopt only if the scan finds nothing wrong.
 */
export async function ensureStorageCompatible(harness: Harness, storage: Storage, options: { readonly adoptUnmarkedStorage: boolean }): Promise<void> {
  const info = await readStorageInfo(harness);
  if (info !== undefined) {
    if (info.markerFormat > STORAGE_MARKER_FORMAT) throw new IncompatibleStorageError(`its marker format ${info.markerFormat} is newer than this adapter understands (${STORAGE_MARKER_FORMAT})`);
    if (!SUPPORTED_HISTORY_FORMATS.includes(info.historyFormat)) throw new IncompatibleStorageError(`its history layout "${info.historyFormat}" is not one this adapter reads (${SUPPORTED_HISTORY_FORMATS.join(", ")})`);
    if (info.runtimeVersion !== PINNED_PI_DURABLE_VERSION && !STORAGE_MIGRATIONS.some((m) => m.from === info.runtimeVersion && m.to === PINNED_PI_DURABLE_VERSION)) {
      throw new IncompatibleStorageError(`it was written by Pi Durable ${info.runtimeVersion}; this adapter supports ${PINNED_PI_DURABLE_VERSION} only and has no migration`);
    }
    return;
  }
  const scan = await scanStorage(storage);
  if (scan.conversations === 0) {
    await writeMarker(harness, false);
    return;
  }
  if (!options.adoptUnmarkedStorage) throw new UnmarkedStorageError(scan.conversations);
  if (scan.findings.length > 0) throw new IncompatibleStorageError("the scan of the unmarked storage found problems", scan.findings);
  await writeMarker(harness, true);
}
