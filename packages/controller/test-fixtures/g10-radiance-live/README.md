# Radiance responses captured by G10's second run

Captured on 2026-11-25 from the owner's running Radiance server (version 2.2.0, model qwen3.8-flash-next-iq4r, a hybrid model on two
R9700 cards) by `packages/integration/src/g10-radiance-live-bench.ts` (library: `g10-radiance-live.ts`); figures and findings are in
`docs/nimblenewt/implementation-plan/g10-evidence.md` (section "Second run") and `evidence/g10-radiance-run2.json` / `run3.json`.
The prompts are synthetic ledger rules (about 10,000 tokens for the retained and refusal runs, about 6,700 for the concurrency run);
nothing private is in them. The server was shared with other clients while these were taken.

Each file is `{ "status": N, "body": ... }`. A 200 body keeps only what the profile reads (`usage`, `timings`) and the short answer
(no response id); a 400 keeps only the server's `error` object. Never edit these files; capture new ones with the bench.

- `retained-cold`, `retained-native`: a new head, then the same request at once (8,192 of 10,073 tokens reused).
- `retained-hit-after-0s` (run 2), `retained-hit-after-15s`, `retained-hit-after-30s` (run 3): the same head after an unrelated
  conversation and an idle gap, with a marker expecting 8,192 tokens: all served.
- `retained-hit-switch-back` (run 4): the first conversation again after another one, served; `retained-miss-changed-head`: one word put in front of the head, nothing served, marker lost.
- `retained-miss-after-60s`: the same after 60 s idle: nothing served (run 2; run 3 did the same), the answer still right.
- `refusal-warm-cold`, `refusal-warm-native`: the production profile's own calls before the refusal.
- `refusal-logit_bias`: the server's real 400 for a setting it does not implement (`unsupported_parameter`), used as the refused
  cache setting; `refusal-fallback-served`, `refusal-fallback-second-question`: the retried call, served from cache.
- `refusal-other-400`: a real 400 that names no cache setting (`temperature` mistyped).
- `concurrency-8-cold`, `concurrency-8-repeat`: one of eight conversations sent at once, cold and repeated; `concurrency-after-load-miss`:
  the first conversation of the run sent again after the heavier levels (nothing served).
