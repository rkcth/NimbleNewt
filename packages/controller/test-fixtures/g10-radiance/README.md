# Radiance responses captured by G10

Captured on 2026-11-16 from the owner's running Radiance 2.1.0 server (`system_fingerprint` radiance-2.1.0, model
qwen3.8-flash-next-iq4r, a hybrid model on two R9700 cards) by `packages/integration/src/g10-radiance-bench.ts`, repeat 1 of
the run recorded in `docs/nimblenewt/implementation-plan/g10-evidence.md`. The prompt was about 13,470 tokens of synthetic
ledger rules; nothing private is in them.

- `cold.sse`, `repeat.sse`, `changed-head.sse`: the last two server-sent events of a streamed answer exactly as the server
  sent them (the finish event with `timings`, then the usage event with `usage` and `timings`), each JSON object parsed and
  written back compactly; the content events before them are left out. Steps: a new head (cold), the same request again
  (repeat), the same head with one word put in front (changed head).
- `repeat.json`: the whole non-streamed answer of the repeat step.

Read by `src/inference-cache/g10-captured.test.ts`. Never edit these files; capture new ones with the bench instead.
