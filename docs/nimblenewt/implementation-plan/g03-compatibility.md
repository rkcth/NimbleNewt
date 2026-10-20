# G03: forward migration and compatibility rejection

Status: **implemented; reviewed by a separate AI session (not a human review).** Evidence for card G03. It qualifies the compatibility *gate* of the Pi adapter and finds, with real fixtures, what actually differs between Pi Durable versions on disk. It does **not** deliver a Pi-to-Pi storage migration, because none was needed for the versions tested; see [what is not covered](#what-is-not-covered).

## What the fixtures showed

`packages/pi-adapter/test-fixtures/` holds storage written by Pi Durable **1.0.1**, **1.2.0** and **1.3.0** directly (no adapter), plus storage and checkpoints written by the adapter before the compatibility marker existed. Each Pi fixture has an extension tool call and a compaction. Provenance and how to regenerate them are in the fixtures README. Compared record by record:

- All three versions write storage record format 1 and document version 1, with the same entry kinds.
- Pi 1.0.1 has no per-conversation `pi.provider` document and its tool-result messages have no `durationMs`. Pi 1.3.0 handles both (it creates the provider identity on first use).
- The stored tool-result message uses `content` in every version. The historic `content` / `output` trap is in the tool-definition API (what a tool returns), not in stored data; the adapter's tool wrapper always uses the `output` form.
- **Nothing in a storage records which Pi version wrote it.** That is why the adapter needs its own marker.

## What the adapter now guarantees (all tested against the fixtures)

1. **Marker.** On first use of an empty storage the adapter writes a session-wide marker document (`nimblenewt.storage`: marker format, Pi Durable version, history layout `pi-durable:1`, whether it was adopted).
2. **Marked storage.** Accepted only if the marker's Pi Durable version equals the pin and its history layout and marker format are ones the adapter reads. Anything else is refused with `IncompatibleStorageError`. No migration is defined (`STORAGE_MIGRATIONS` is empty), so none is attempted.
3. **Unmarked storage with data** (written by an earlier build of this adapter, or by Pi directly): refused with `UnmarkedStorageError` unless the controller passes `adoptUnmarkedStorage: true`. Adoption first runs a read-only scan of every conversation's entries (known Pi entry kinds, tool results carry content, user and assistant entries carry messages). Findings refuse the adoption with `IncompatibleStorageError`; a clean scan writes the marker with `adoptedUnmarked: true`.
4. **The adapter's refusals write nothing.** Every refusal path (unmarked, scan findings, foreign marker version, layout or marker format) is tested to leave the storage directory byte for byte unchanged by the adapter, and a Pi storage format number Pi itself does not know is refused by Pi before the adapter sees it, also unchanged. **One caveat the adapter cannot remove:** the controller opens the storage backend before the adapter sees it, and the backend's own crash recovery runs then. Pi's JSONL storage truncates an incomplete trailing record when it opens; a test pins this (a refused open of a storage with a torn tail leaves exactly the pristine fixture, i.e. Pi dropped the torn record and the adapter wrote nothing). Usually that is Pi discarding an unconfirmed record, but if a newer runtime kept the same record format and wrote a tail that 1.3.0 considers incomplete, merely opening that storage with this adapter's Pi would cut it off. **Controllers should open storage written by an older, newer or unknown runtime from a copy or a read-only snapshot**, and only adopt the copy. SQLite's crash recovery may behave differently and was not tested.
5. **Failed adoption preserves the original.** A commit failure while writing the marker (injected disk-full) leaves the storage byte for byte as it was, for Pi 1.0.1 and for the earlier adapter's storage, and a later adoption still works. The same holds for a failed marker write on an empty storage.
6. **Adopted conversations continue.** After adopting each of the four fixtures: the old extension's tool call reads back as a semantic result with its output; the compaction is present, a checkpoint can be taken at it and verifies, the model context for a new request contains the compaction summary, and a branch starts from the compaction. A tool of the old extension that the adapter does not provide fails explicitly (`unknown_tool`).
7. **Checkpoint format 2, with format 1 upgraded.** The checkpoint now records `runtime: { name, version }` and `historyFormat`. Real format-1 checkpoints produced by the earlier adapter (committed as fixtures) verify and restore on the current adapter: they are upgraded in memory by a pure function; the stored original is never modified; and a checkpoint taken now for the same boundary equals the upgraded old one. Unknown or malformed formats are `unsupported_format`; a changed history is `history_changed`; another runtime or history layout is `incompatible_runtime`; none of these writes anything.

All of this runs through the production `PiAdapter` code, not a parallel state machine. Controller schema migrations are separate (F04).

## Upgrading existing development storages

Every storage created by the adapter before this change (F05 through G02) has no marker. Open each once with `adoptUnmarkedStorage: true`, preferably from a copy; the scan runs, the marker is written, and later opens need no flag. The fixtures `adapter-pre-marker/` are exactly such a storage and are used to test this path.

## What is not covered

- **No Pi-to-Pi storage migration exists.** The only versions with fixtures (1.0.1, 1.2.0, 1.3.0) are layout-identical, so they are adopted, not migrated. A future Pi release that changes the layout needs a real migration: it must run in one commit so a failure leaves the original intact (the adoption path already has that property), and it needs its own fixtures from the real older and newer versions. The synthetic variants used here (an unknown entry kind, a tool result without content, a marker naming another version) are edits of real fixtures, labelled synthetic in the tests, because no newer Pi exists to produce the real thing.
- **Adoption trusts the controller's assertion** that an unmarked storage is compatible; the scan catches structural problems, not semantic ones (for example a tool that behaved differently in an older version).
- **No signature** on checkpoints or the marker; they detect accident and mismatch, not tampering.
- Behaviour of other Pi storage backends (SQLite) was not tested; only JSONL and memory.
- **The migration hook cannot migrate yet (for K03):** a `STORAGE_MIGRATIONS` entry is only `{ from, to }`, so it would merely accept marked storage of another version without transforming it or rewriting the marker. Before K03, an entry needs a `migrate(tx)` function applied together with the marker rewrite in one commit; the adoption path already has that atomicity and a failure-injection test to reuse. Marked storage and checkpoints also still require the exact pinned Pi version even when the history layout is identical, so a layout-compatible Pi patch release will need either a migration entry or a version range decided on `historyFormat` (K03).
- The `restore_checkpoint` audit event carries the upgraded (format 2) checkpoint, not the stored one; a `migrated` flag and the stored form would show exactly what the controller passed in.

## Reproducing

```
git clone https://github.com/rkcth/NimbleNewt.git && cd NimbleNewt
npm ci && npm test        # compat.test.ts is the G03 suite
```

To regenerate a Pi fixture: install the version in an empty scratch directory (`npm install --ignore-scripts @earendil-works/pi-durable@<version>`), copy `packages/pi-adapter/test-fixtures/generate-pi-fixture.mjs` there and run `node generate-pi-fixture.mjs <outDir> content` (1.0.1) or `output` (later versions).
