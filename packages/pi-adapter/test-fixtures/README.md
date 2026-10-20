# Compatibility fixtures (G03)

Never modified by tests: tests copy a fixture to a temporary directory first.

| Directory | Written by | Contents |
| --- | --- | --- |
| `pi-1.0.1/` | Pi Durable **1.0.1** directly (no NimbleNewt adapter) | root conversation: an extension tool call (`echo`, legacy `content` tool API), a second request, a compaction |
| `pi-1.2.0/` | Pi Durable **1.2.0** directly | same flow, `output` tool API |
| `pi-1.3.0/` | Pi Durable **1.3.0** directly | same flow |
| `adapter-pre-marker/storage/` | the NimbleNewt adapter as of commit `fe494f9` (before the storage compatibility marker existed) | same flow through `PiAdapter` |
| `adapter-pre-marker/checkpoints-v1.json` | the same run, production `checkpoint()` at format 1 | `beforeSecond`, `beforeCompaction`, `afterCompaction` |

The three Pi fixtures were produced by `generate-pi-fixture.mjs` run against each Pi version installed in an empty scratch directory (`npm install --ignore-scripts @earendil-works/pi-durable@<version>`, copy the script there, `node generate-pi-fixture.mjs <outDir> <toolResultField>` with `content` for 1.0.1 and `output` otherwise). What they show about on-disk compatibility (compared record by record): all three write storage record format 1 and document version 1 with the same entry kinds; 1.0.1 has no per-conversation `pi.provider` document and its tool-result messages have no `durationMs`. The tool-result message is stored with `content` in every version: the `content`/`output` difference is in the tool-definition API (what a tool returns), not in stored data.

Synthetic variants (a different storage format number, an unknown entry kind, a marker naming another Pi version) are derived from these inside the tests by editing a temporary copy, and are labelled synthetic where used: no newer or differently-versioned Pi exists to produce them for real.

Open a fixture's storage only from a temporary copy (the tests do). Pi's storage backends run crash recovery when they open a storage (the JSONL backend truncates an incomplete trailing record), before any NimbleNewt check can refuse it, so even a refused open can change a storage; the same applies to real storages written by an older, newer or unknown runtime.
