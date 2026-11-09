# Pi completion bench (card W01)

Measures how often a Pi agent finishes its work. Each run replays a merged card: a fresh repository at the card's base
commit, the card's own tests held back, Pi given the task, and only after Pi has ended are the held-back ("hidden")
tests copied in and run. The run's ending is then classified from Pi's JSON log.

## The one command

```sh
node scripts/pi-eval/run.mjs
```

runs every task in `taskset.json`, variants A and B, the task set's repeats (3), one run at a time, and prints the
report. Narrow it with `--tasks quote-lines,c07n`, `--variants A`, `--repeats 1`, `--concurrency 2` (at most 3).
`--dry-run` prints what would run. `node scripts/pi-eval/run.mjs --help` lists every option.

The report alone, over everything recorded so far or one batch:

```sh
node scripts/pi-eval/report.mjs [--batch batch-20261109T201108] [--variants A,B] [--strict]
```

Check that the tasks are sound (no agent, no GPU; about 5 minutes per task): the hidden tests must fail at the base and
pass at the solution.

```sh
node scripts/pi-eval/run.mjs --calibrate
```

## When to run it

Radiance is shared with the Paperclip coders, and Pi runs at most 3 agents at once there. A full baseline is
9 tasks x 2 variants x 3 repeats = 54 runs, at 30 to 180 minutes each: roughly 20 GPU hours at concurrency 1. Run it at
a quiet time (overnight), with `--concurrency 2` or `3` only when nothing else is using Radiance, and in the background
(`nohup node scripts/pi-eval/run.mjs > /srv/code/worktrees-pi/eval-results/nohup.log 2>&1 &`).
Each run also builds the repository twice and runs the hidden test files (a few minutes of CPU).

## Where results go

Not in the repository. By default `/srv/code/worktrees-pi/eval-results/` (or `--results DIR` / `PI_EVAL_RESULTS`):

- `results.jsonl`: one line per run: task, size, variant, repeat, base and solution commits, the bench's own commit, route
  (provider, model, thinking), start and end time, wall time, exit code, timeout, **outcome** and the reason, the end kind,
  the last stop reason and visible characters, turns, tool calls, tokens, nudges (0 until W04), PLAN.md progress, commits
  ahead of the base, the diff stat, the hidden test counts, and whether a tool call named another checkout (contaminated).
- `runs/<runId>/`: the prompt given, Pi's whole JSON log (`agent.jsonl`), the setup and hidden-test output, the diff stat.
- `<batchId>-report.md`: the report for that batch. `calibration.jsonl` and `calibration/<task>/`: calibration runs.

Throwaway checkouts are `/srv/code/worktrees-pi/eval-<runId>` and are removed after each run (`--keep` keeps them).

## What a run does

1. `git init` a new directory and fetch **only the base commit** from this repository, so neither the solution commit nor
   any later commit is in its object store (`git log --all`, `git show <solution>` cannot reach it). The run refuses to
   start if the solution is reachable or a hidden file already holds the solution's content. `node_modules` (root and
   per package) are copied from this checkout, and the repository is built (`tsc --build --force`).
2. The prompt is the variant's template (`prompts/variant-a.md`, `prompts/variant-b.md`) with the task text
   (`tasks/<id>.md`) put in; it is saved beside the log, outside the checkout.
3. The agent (`pi-agent.mjs`: `pi -p --no-session --no-approve --provider radiance --model qwen3.8-flash-next-iq4r
   --thinking medium --mode json`, the same flags as `~/.local/pi-cli/runcard.sh`) runs in the checkout under the task's
   wall-clock limit (S 60, M 120, L 180 minutes); at the limit its process group is stopped.
4. PLAN.md progress and the diff are read; the solution's version of every hidden file is written in; the repository is
   built again and the hidden test files are run (`node --test`, offline guard, `NIMBLENEWT_REQUIRE_SANDBOX=1`).
5. The ending is classified (`lib/classify.mjs`), in this order:
   - **timeout**: stopped at the wall-clock limit.
   - **error**: no Pi session, a reply that ended in `error`/`aborted`, a non-zero exit before the run ended, or a bench
     error (a failed checkout, a leak).
   - **verified-finish**: the hidden tests pass on a worktree the agent changed. (Passing on an unchanged worktree is an
     error: the task is not calibrated.)
   - **length**: the last reply stopped on `length`.
   - **empty**: no visible text, and either no work at all (no tool call) or "No response requested".
   - **stopped-early**: the agent stopped while working: unchecked PLAN.md steps, a thinking-only reply after tool calls,
     an announced next step, a reply that does not claim to be done, or a log that ends without `agent_end`.
   - **wrong** (false done): the last reply says it is done and the hidden tests fail.
   - **unclassified**: anything the rules above do not cover; the gate requires none.

## Variants

- **A** the plain prompt (task, rules, build and test commands, "end with a short report").
- **B** A plus: write PLAN.md with a checkbox per small step, tick and commit after each step, do not stop with a box
  unchecked.
- **C** B plus the bounded continuation of W04, and **D** C plus a relaunch that reuses the stored session
  (`PI_EVAL_SESSION_ID` makes `pi-agent.mjs` pass `--session-id`). Both are refused with "needs W04" until W04 lands.

## The release gates

Per variant: verified finish at least **90 %** of S runs, **85 %** of M runs, **70 %** of L runs; false done (`wrong`) at
most **5 %** of all runs; **zero** unclassified runs (every non-finish is named). The report shows each rate with its
Wilson 95 % interval and says when a rate that meets its gate still has an interval reaching below it (too few runs to be
sure), then a PASS/FAIL line per variant and one RESULT line.

## The task set (`taskset.json`)

Nine merged cards, base = the merge's first parent, solution = the merge commit, hidden files = the test files the merge
added or changed (plus test suites they use). Sizes by non-test source lines changed (S under 100, M 100 to 250, L over
250 or several subsystems):

| id | size | merge | what |
|---|---|---|---|
| quote-lines | S | 081248b7 | proposal lines quote every borrowed name |
| flaky-proposal | S | 212db814 | a flaky release approval is a shown proposal |
| grant-proposals | S | eac67f71 | grants with no limit or no end are shown proposals |
| landing-proposal | M | 0e84a1b9 | landing on main is a confirmed proposal |
| c07n | M | b3851601 | a route of unknown window is checked or refused |
| phrase-hints | M | 9bb923b4 | dated rights, host moves as proposals, refusals that ask |
| m03h-1 | L | e78581b6 | stand-ups status view and chat reach |
| l02e-2 | L | 1c8816fe | wider Stops walk swarm children; sweep not starved; stop view |
| c07m | L | eb19ba95 | the first call names the hand-off, the note and the blockers |

The task texts are the prompts Pi was actually given for these cards (`~/.local/pi-cli/runs/*.prompt`), without their
process steps (the variant supplies those), plus an "acceptance details" part naming what the later review rounds added
and the exported names the hidden tests import, since a hidden test can only pass on the names it calls. c07m holds back
`dispatch/handoff-brief.test.ts` (a unit test of the new module's internal shapes); its other hidden tests run.

## Tests

```sh
node --test "scripts/pi-eval/*.test.mjs"
```

The classifier on logs trimmed from real Pi runs (`fixtures/`: the smoke run's report-then-failing-test = wrong, c07p ended thinking-only mid-work = stopped-early,
x09b-fix3 = length, capacity-view-pi "No response requested" = empty, flaky-confirm = a report, finish or false done
depending on the hidden tests), the aggregation and gates, and the runner end to end on a tiny repository with
`stub-agent.mjs`: the deliberately broken agent that stops after its first turn is scored **stopped-early, never
finished**; a thinking-only stop, a false done, a crash, a hang (timeout) and an honest solver (verified finish) are scored
as such; the agent's checkout holds no hidden file and cannot reach the solution commit; calibration passes. These are not
part of `npm test` (which runs `scripts/*.test.mjs` only).

## Smoke run (2026-11-09)

One run of variant A on `quote-lines` (S), bench commit 4abd2e0d, route radiance / qwen3.8-flash-next-iq4r / thinking
medium, `node scripts/pi-eval/run.mjs --tasks quote-lines --variants A --repeats 1`:

- First attempt (batch-20261109T201108): **error**. Radiance answered the first request with "the engine stopped on an
  error and is not serving (device error)" and the run ended after 4 s. The bench scored it as an error with that reason.
  Nothing was restarted; Radiance was answering again 10 minutes later.
- Second attempt (batch-20261109T202130): Pi worked 30.5 minutes (100 turns, 110 tool calls, about 0.57M input + 8.4M
  cached tokens, 72k output), made 1 commit (6 files, +222 -10), and ended on a 3332-character report that opens with
  "Done.". Hidden tests: **153 of 154 pass**. The one failure is `a long name is cut between whole characters and whole
  escapes, at its own bound and at the line's` (`chat/commands-one-line.test.ts`). Outcome: **wrong** (a false done).
  The first score was stopped-early, because the classifier read only the last 600 characters for a done claim. That was
  fixed (it now reads both ends of the report; fixture `quote-lines-smoke-false-done.jsonl`), and `rescore.mjs --write`
  re-scored the record.

The pipeline works end to end: a fresh checkout without the solution, Pi pinned to Radiance, the time limit, PLAN/diff
capture, hidden tests copied in and run, classification and the report. One run says nothing about rates.

`node scripts/pi-eval/rescore.mjs [--write]` re-scores recorded runs from their saved logs after a classifier change.

## Not done yet

- **The baseline.** W01's acceptance asks for a recorded baseline of variants A and B over the whole set; only the one
  smoke run above has been made. Run `node scripts/pi-eval/run.mjs` at a quiet time and record the batch (its commit,
  route, model and per-run results are in `results.jsonl`) in the implementation notes.
- **Variants C and D** wait for W04 (and D for a session the runner can relaunch).
- **Spec fit of the larger tasks.** Hidden tests pin exact wording and names. The task texts state the names and wording
  found by reading the hidden tests' imports and the review commits, but only `quote-lines` was read test by test; a run
  that fails one hidden assertion on wording it could not have known counts as a non-finish. Read the hidden tests of the
  M and L tasks against their task texts before trusting their rates.
- **Isolation is of the checkout, not the machine.** The agent's repository cannot reach the solution, but Pi can read
  any file the user can, including other checkouts of this repository. Such a run is flagged `contaminated` when a tool
  call names one (the reference checkout path, the solution's short SHA or the results directory); it is still scored.
- **Nudges and the W02 end kinds** come from the worker once W02/W04 exist; the bench reads the CLI log only, so
  `nudges` is 0 and `endKind` is the bench's own reading.
- **Windows.** The runner and classifier are plain Node (no shell, `node:path`, `child.kill` where there are no process
  groups), but it has only been run on Linux, and the default Pi location is `~/.local/pi-cli`.
