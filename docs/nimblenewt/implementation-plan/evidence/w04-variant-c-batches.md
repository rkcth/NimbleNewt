# W04 bench variant C: the two recorded batches

Copied from the bench's batch reports (`batch-20261124T153731-report.md`, `batch-20261125T050221-report.md`) and re-derived from its `results.jsonl`. No transcripts.

- Route: Radiance, model `qwen3.8-flash-next-iq4r`, thinking medium. Bench commit `f4330e14` (branch `card-w04-variant-c-run`); `scripts/pi-eval`, `packages/pi-adapter/src/continuation.ts` and `packages/pi-adapter/src/worker/nudge.ts` equal main's at `a66b1bb4`.
- Continuation installed in all 30 runs; 0 to 3 nudges per run. Radiance idle gate off, concurrency 3.
- The three 502 runs of the first batch (`m03h-1`, server outage) were rerun as the second batch.

## batch-20261124T153731 (27 runs, 6 contaminated and left out; kind: another checkout)

Contaminated: flaky-proposal r2, landing-proposal r1 and r3, c07n r1, l02e-2 r2, c07m r1. Three of them are otherwise a verified finish.

| variant | size | tasks | runs | verified | 95% CI | wrong | timeout | error | median wall |
|---|---|---|---|---|---|---|---|---|---|
| C | S | 3 | 8 | 6 (75.0%) | 40.9%-92.9% | 1 | 1 | 0 | 36.1 min |
| C | M | 3 | 6 | 2 (33.3%) | 9.7%-70.0% | 1 | 3 | 0 | 114.3 min |
| C | L | 3 | 7 | 4 (57.1%) | 25.0%-84.2% | 0 | 0 | 3 (502 outage) | 77.3 min |

Other columns (stopped-early, length, empty, interface-mismatch, server-rejected-history, unclassified) are 0.

- Gates: S 75.0% (needs 90.0%) FAIL; M 33.3% (85.0%) FAIL; L 57.1% (70.0%) FAIL; false done 2/21 = 9.5% [2.7%-28.9%] (at most 5.0%) FAIL; unclassified non-finishes 0 ok.
- Shipped test files pass in 3/21 runs (informational). Timeouts whose acceptance tests pass at the limit: 3 of 4 (informational). 138 refused calls inside project tests, not counted (2 runs).
- RESULT: FAIL (C fail). 24147025 input+output tokens.

## batch-20261125T050221 (3 runs, 1 contaminated and left out; kind: another checkout)

| variant | size | tasks | runs | verified | 95% CI | wrong | median wall |
|---|---|---|---|---|---|---|---|
| C | L | 1 | 2 | 1 (50.0%) | 9.5%-90.5% | 1 | 103.1 min |

- Gates: L 50.0% FAIL; false done 1/2 = 50.0% FAIL; S and M not measured. Shipped test files pass in 0/2 runs.
- RESULT: FAIL (C fail). 4352217 input+output tokens.

## Combined reading

- Contaminated and left out: 7 runs (6 + 1).
- False done: 2 in the first batch plus 1 in the rerun = 3 runs.
- L with the rerun in place of the outage runs: 5/6 verified.
- This is an input to W09, not a pass of the W01 gates; W09 must not count it as its own variant C. Repeats of one task are not independent samples.
