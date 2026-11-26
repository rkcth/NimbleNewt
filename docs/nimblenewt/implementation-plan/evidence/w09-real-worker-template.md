# W09: the completion gates on the real worker and the Radiance route (evidence template)

Fill this in from a REAL run of `scripts/pi-eval/worker-run.mjs` on Radiance. Copy figures from the batch report (`<results>/worker/<batch>-report.md`), the records (`<results>/worker/worker-results.jsonl`) and, when a gate fails, the release-blocker record (`<results>/worker/release-blockers/w09-<batch>.json`). No transcripts, no keys. Nothing here was filled in offline: every field below is still open.

## Before the run

- Radiance is free for a bench (the owner said so; record the date and words): ...
- The server's model is the pinned one and nothing else is loaded or switched: `GET /v1/models` lists ...
- Bench commit (`git rev-parse HEAD`, clean): ...
- The route's context window given with `--context-tokens` (from Pi's models.json or the server's own figure): ...
- Reply limit and reasoning cap given (`--max-tokens`, `--reasoning-tokens`), if any: ...
- Known blocker to check first: the agent on the worker is offered only the `nimblenewt__*` bridge tools (no read, write, edit or command tool), so a coding task cannot be finished there until it gets file tools (see the W09 notes, 2026-11-26). Each record's `worker.fileTools` and `worker.agentTools` say what the agent was offered on this run: ...

## Commands

```sh
# one real task end to end first (the shipped variant):
node scripts/pi-eval/worker-run.mjs --tasks quote-lines --variants D --repeats 1 --context-tokens <window> --test-slot /tmp/nn-slot.sh
# then the variants on the whole set:
node scripts/pi-eval/worker-run.mjs --variants A,B,C,D --repeats 1 --context-tokens <window> --test-slot /tmp/nn-slot.sh
```

## The real task end to end (card: "from admission to a verified work.end and an accepted report")

| field | value |
|---|---|
| batch, run ID | |
| task, size, variant | |
| attempt ID | |
| state, status, report result | |
| the done's checks (`worker.verifications`, `worker.lastChecks`) | |
| second agent (`worker.questioning`, questions asked) | |
| requests: agent, second agent, refused (`worker.requests`) | |
| nudges, early stops, readmits | |
| acceptance suite (tests, pass, fail) | |
| outcome and reason | |
| wall time | |

## Variants A to D on the real worker

| variant | size | tasks | runs | verified | 95% CI | wrong | interface-mismatch | stopped-early | timeout | error | unclassified |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | S | | | | | | | | | | |
| ... | | | | | | | | | | | |

- Gates of the shipped variant (D): S >= 90%, M >= 85%, L >= 70%, false done <= 5%, no unclassified non-finish: ...
- RESULT: ...
- Release blocker written (path), when a gate failed: ...

## What the run must also record

- Whether Radiance honoured `thinking_token_budget` (card W07): the reasoning length of the replies against `--reasoning-tokens`, or the relay's note that the server refused the field.
- How often the controller refused a done (W05 checks) and how often the second agent questioned or refused a report (W10), per run.
- Whether the second agent's reply fitted its 1,500-token reply limit on this model (an empty or cut reply counts as no verdict, and the run is then not a finish).
- Whether the build check fitted the attempt's memory and time limits (`worker.lastChecks`; a `not-run` or `failed` with a limit named).
- Server counters before and after each run (`server.before`, `server.after` of each record), and that no other request of the bench overlapped (one at a time).
