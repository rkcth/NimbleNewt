# Pi completion bench (card W01)

Measures how often a Pi agent finishes its work. Each run replays a merged card: a fresh repository at the card's base
commit, the card's own tests held back, Pi given the task, and only after Pi has ended are the held-back tests copied in
and run: first the task's **acceptance suite** (the score), then the card's **shipped test files** (for information).
The run's ending is then classified from Pi's JSON log.

## What changed on 2026-11-10, and why (the first baseline is invalid)

The first baseline (43 of 54 runs, batches of 2026-11-09/10) scored no finish at all, and an audit of every run found
that it measured the gap between the prompts and the hidden tests rather than Pi: in 38 of the 43 runs a hidden test
demanded exact wording, a field name or a signature the prompt never stated (whole sentences later review rounds settled
on; a callback type for c07n; the overview shape for m03h-1); 25 runs had a genuine defect too (all but the 5 quote-lines
runs together with such mismatches); and 9 `stopped-early` labels were classifier misses (reports opening "All boxes
ticked; tree clean. Report:" or ending with a scoped "Remaining risk / not done:" note). Its data is kept, unchanged
except for the re-labelling below, in `eval-results/baseline-1-invalid/` (see its README); do not read rates from it.

What changed:

1. **Classifier.** A final report given with every PLAN.md box ticked, a clean tree and a green last self-test (the
   agent's own last `--test` run that printed counts) is a done claim whatever its words; "All boxes ticked", "all ten
   steps are committed", "tree clean" are done words; a scoped caveat note at the end ("Remaining risk / not done:",
   "Out of scope and left alone:", "Known limitations:") makes it `done-with-caveats`, still a done claim (records carry
   `doneClaim`). A new outcome **interface-mismatch**: the agent said it was done and the build failed only in the
   held-back files, i.e. the tests do not type-check against its code; it is a non-finish but not a false done.
   `rescore.mjs` re-labelled the saved runs of the first baseline (43 runs, smoke runs aside):

   | outcome | before | after |
   |---|---|---|
   | stopped-early | 9 | 0 |
   | wrong | 32 | 28 |
   | interface-mismatch | 0 | 13 |
   | timeout | 2 | 2 |
   | verified-finish | 0 | 0 |
2. **Task design.** Each task's prompt ends with a **CONTRACT** block naming every exported name, type field, signature,
   operation and message meaning the scored tests use, without the solution's code; contradictions were fixed
   (grant-proposals' `only in "<name>"`, c07n's "positive finite" is now "positive integer"). The score is an
   **acceptance suite** per task (`acceptance/<id>/`): bench-owned tests derived from the card's shipped tests, written
   into the checkout at fresh `w01-acceptance-*` paths (calibration checks they exist at neither the base nor the
   solution, so they never collide with an agent's own tests), that assert behaviour and meaning (`/main by itself/`,
   `/no human step/`, `/gate.*(differ|chang).*confirm/i`) rather than whole sentences. The shipped test files, which also
   carry later review wording no prompt states, still run after it and are reported as **matches shipped wording**
   (informational: not part of finish, false done or the gates).
3. **Spec fit** in `--calibrate` (`lib/specfit.mjs`): every string literal (and fixed template part), regex, property
   name (`.x` and object keys) inside an acceptance assertion (its message argument aside), and every name imported from
   a relative module, must appear in the prompt, in the base commit's source and docs, or in the test's own fixtures.
   Anything else is listed, and calibration fails until the task's `acceptance.json` `allow` gives it a reason.
4. **Control runs** (`--agent`, `--label`, `compare.mjs`, below).
5. **Leftover processes.** Every command of a run carries `PI_EVAL_RUN_DIR=<checkout>`; after the agent, after each
   suite and at the end, any process working in the checkout, carrying that mark, or descending from one is killed.
   An embedded PostgreSQL works in its own `/tmp` data directory, so the working-directory test alone missed it (checked
   by hand on a real embedded server: postmaster and its five helpers stopped; tested with stand-ins in `runner.test.mjs`).

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

Check that the tasks are sound (no agent, no GPU; about 1 to 4 minutes per task, 21 minutes for all nine on 2026-11-10): the acceptance tests must fail at the
base and pass at the solution, the spec fit must find nothing unexplained, and the shipped suites are run at the
solution for the record (`--no-shipped` skips that part).

```sh
node scripts/pi-eval/run.mjs --calibrate [--tasks id,id]
```

## A control run (another agent on the same tasks)

To tell a hard task from a weak agent, run one repeat per task with another agent and compare. Any program works that
takes `<checkout> <prompt-file> <log-file>`, works in the checkout and writes a Pi-style JSON event log (`session`,
`agent_start`, `message_end` with the assistant's reply, tool events, `agent_end`; see `stub-agent.mjs`, which is the
smallest one). For a Claude control, a wrapper that runs Claude Code non-interactively in the checkout and converts its
stream to these events is enough: that is `agents/claude-agent.mjs`.

`agents/claude-agent.mjs` runs `claude -p --output-format stream-json --verbose --permission-mode acceptEdits
--allowedTools Bash,Read,Edit,Write,Glob,Grep --disallowedTools WebFetch,WebSearch --strict-mcp-config` in the checkout
with the prompt on stdin, and converts each stream line to the Pi events above (a stream that ends without Claude's
`result` has no `agent_end`, so it is not a finish; a `result` that is an error, such as the turn limit, ends on an
`error` reply). `CLAUDE_AGENT_BIN` picks the CLI (default `claude` on PATH), `CLAUDE_AGENT_MODEL` adds `--model`.
Claude's stderr goes to `claude-stderr.log` beside the log. It uses the Claude Code login of the user who runs it (no
credential is read or passed) and the account's quota; it does not use Radiance. `claude-agent.test.mjs` tests it
against a fake CLI (`agents/fake-claude.mjs`) only; it has never been run against the real CLI, so check the first
run's `agent.jsonl` by hand. One control repeat per task, then the comparison:

```sh
node scripts/pi-eval/run.mjs --agent scripts/pi-eval/agents/claude-agent.mjs --label claude-control --repeats 1 --variants A
node scripts/pi-eval/compare.mjs --results /srv/code/worktrees-pi/eval-results
```

Run it from the repository root (the agent path is resolved from the current directory). The Claude run is not
isolated any better than Pi's (see "Not done yet"): it runs as the same user, and Claude Code also loads that user's
settings and memory, so read its log for paths outside the checkout before trusting a finish. Bash is allowed without
a restriction (only Edit and Write are limited to the checkout by `acceptEdits`), so a Bash command can read and write
anything that user can, including the reference checkouts and other worktrees; run it only when nothing else is working
in them. A full control pass (9 tasks, one repeat) is up to 9 runs of 60 to 180 minutes on the account's quota.

`compare.mjs` groups records by their agent label (`--label`, else the agent's path) and shows per task and variant
each agent's finishes and outcomes, then per agent: finishes, false done, interface mismatches, other endings and the
shipped-wording score. `runner.test.mjs` runs exactly this with two stand-in agents.

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
- `runs/<runId>/`: the prompt given, Pi's whole JSON log (`agent.jsonl`, stdout only), Pi's stderr (`pi-stderr.log`), the
  setup, the acceptance run (`hidden-setup.log`, `hidden-tests.log`), the shipped suites (`shipped-setup.log`,
  `shipped-tests.log`), the diff stat. The record's `hidden` is the acceptance result (with `interfaceMismatch` and
  `typeErrorFiles`), `shipped` the informational one, `doneClaim` and `selfTest` what the classifier read.
- `<batchId>-report.md`: the report for that batch. `calibration.jsonl` and `calibration/<task>/`: calibration runs
  (with the spec-fit result).
- `baseline-1-invalid/`: the first baseline, kept as data only (see above).

Throwaway checkouts are `/srv/code/worktrees-pi/eval-work/eval-<runId>` (`--work-root` / `PI_EVAL_WORK_ROOT`), in a
directory of their own so the agent's parent directory is not the one holding the merged worktrees. Each is removed after
its run, and on Ctrl-C (`--keep` keeps them; calibration checkouts are `eval-calibrate-<task>-<pid>`). On Linux, any
process left over when the agent ends, after each suite, when the run ends or when Ctrl-C arrives (Pi starts its bash
tools in their own process groups, so a hung test or a background server survives the group stop) is killed first: one
working inside the checkout, one carrying the run's `PI_EVAL_RUN_DIR` mark, or a descendant of either (never the bench
itself or its parents). A process that both left the checkout and dropped or replaced its environment, and does not
descend from one that is seen, is missed; on other systems only the agent's own process group is stopped.

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
4. PLAN.md progress and the diff are read; the acceptance suite is written in (its bench files, and any `support` files
   from the solution), the repository is built again and the acceptance tests are run (`node --test`, offline guard,
   `NIMBLENEWT_REQUIRE_SANDBOX=1`). Then the solution's version of every shipped test file is written in, built and run
   for the informational score. (A task without an acceptance suite is scored on its shipped files, as before.)
5. The ending is classified (`lib/classify.mjs`), in this order:
   - **timeout**: stopped at the wall-clock limit.
   - **error**: no Pi session, a reply that ended in `error`/`aborted`, a non-zero exit before the run ended, or a bench
     error (a failed checkout, a leak).
   - **verified-finish**: the repository builds (`tsc --build` exits 0 with the acceptance files in) and the acceptance
     tests pass on a worktree the agent changed. tsc emits despite type errors, so a passing test run on a failed build is not a
     finish. (Passing on an unchanged worktree is an error: the task is not calibrated.)
   - **length**: the last reply stopped on `length`.
   - **empty**: no visible text, and either no work at all (no tool call) or "No response requested".
   - **stopped-early**: the agent stopped while working: unchecked PLAN.md steps, a thinking-only reply after tool calls,
     an announced next step, a reply that does not claim to be done, or a log that ends without `agent_end`.
   - **interface-mismatch**: the last reply says it is done (see `wrong`) and the build failed only in the acceptance
     files: they do not type-check against the agent's code. It counts in the false-done gate: the CONTRACT pins every name
     and signature, so a mismatch means the agent ignored it (decision of the lead, 2026-11-10).
   - **wrong** (false done): the last reply says it is done and the acceptance tests fail. A report given with every
     PLAN.md box ticked, a clean tree and a green last self-test is a done claim whatever its words; a closing caveat
     note ("Remaining risk / not done: ...") keeps it one (`doneClaim: done-with-caveats`). A report that says what is not
     done ("could not complete", "still fails", "remaining work", "incomplete") is not a done claim ("no remaining
     failures", "nothing left to do" do not count as saying so). A report that describes the old state with a negation
     ("the tests were not passing before") also reads as not done, so `wrong` can undercount; a closing "Let me
     know ..." is a sign-off, not an announced step. Only the first and last 600 characters of the report (before any
     closing caveat note) are read for these words.
   - **unclassified**: anything the rules above do not cover; the gate requires none.

## Variants

- **A** the plain prompt (task, rules, build and test commands, "end with a short report").
- **B** A plus: write PLAN.md with a checkbox per small step, tick and commit after each step, do not stop with a box
  unchecked.
- **C** B plus the bounded continuation of W04, and **D** C plus a relaunch that reuses the stored session
  (`PI_EVAL_SESSION_ID` makes `pi-agent.mjs` pass `--session-id`). Both are refused with "needs W04" until W04 lands.

## The release gates

Per variant: verified finish at least **90 %** of S runs, **85 %** of M runs, **70 %** of L runs; false done (`wrong`) at
most **5 %** of all runs; **zero** unclassified runs (every non-finish is named). Interface mismatches count as
non-finishes only. The shipped-wording score is printed per variant and gates nothing. The report shows each rate with its
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
process steps (the variant supplies those), plus an "acceptance details" part, and since 2026-11-10 a CONTRACT block that
pins everything the acceptance suite checks. `hiddenFiles`/`testFiles` in `taskset.json` are the shipped test files (the
informational score); the scored suite of each task is `acceptance/<id>/acceptance.json` (`files`: checkout path to
bench file; `support`: helper files taken from the solution; `testFiles`; optional `testNamePatterns`; `allow`: the
spec-fit allowlist, item to reason).

## Tests

```sh
node --test "scripts/pi-eval/*.test.mjs"
```

The classifier on logs trimmed from real Pi runs (`fixtures/`: the smoke run's report-then-failing-test = wrong, c07p ended thinking-only mid-work = stopped-early,
x09b-fix3 = length, capacity-view-pi "No response requested" = empty, flaky-confirm = a report, finish or false done
depending on the hidden tests), the aggregation and gates, and the runner end to end on a tiny repository with
`stub-agent.mjs`: the deliberately broken agent that stops after its first turn is scored **stopped-early, never
finished**; a thinking-only stop, a false done, a crash, a hang (timeout) and an honest solver (verified finish) are scored
as such; the agent's checkout holds no hidden file and cannot reach the solution commit; calibration passes. Since
2026-11-10 also: the baseline's misread endings (fixtures `c07n-all-steps-committed`, `flaky-report-no-done-word`,
`phrase-hints-done-with-caveats`), done-with-caveats and interface mismatch; an acceptance suite scored with the shipped
tests beside it; calibration's spec fit flagging an unstated regex until it is allowlisted or stated; leftover processes
outside the checkout (a marked server in /tmp and its unmarked helper) stopped; a control run with two stand-in agents
recorded and compared (`specfit.test.mjs` tests the extraction itself); the Claude control wrapper against a fake CLI
(`claude-agent.test.mjs`). These are not part of `npm test` (which runs
`scripts/*.test.mjs` only).

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

- **The baseline.** W01's acceptance asks for a recorded baseline of variants A and B over the whole set. The first one
  (2026-11-09/10) is invalid (see the top); a new one on the acceptance suites has not been run. Run
  `node scripts/pi-eval/run.mjs` at a quiet time and record the batch (its commit, route, model and per-run results are in
  `results.jsonl`) in the implementation notes.
- **A control run** (one repeat per task by Claude, `--agent scripts/pi-eval/agents/claude-agent.mjs --label
  claude-control`) is supported and its wrapper is tested against a fake CLI, but it has not been run.
- **Variants C and D** wait for W04 (and D for a session the runner can relaunch).
- **Spec fit is lexical.** It sees literals, regexes, property names and imports inside assertions; it does not see a
  demand built at run time (a helper that compares against a computed string), the order or count of outputs, or the
  types an acceptance file relies on beyond its imports. A literal kept in a constant outside the assertions
  (`const MARK = "..."; ... assert.ok(x.includes(MARK))`) is read as the test's own fixture, so it is never flagged:
  check such constants by hand (on 2026-11-10 a search found each one to be a fixture input, a negative check, or text in the prompt or the base source). The CONTRACT blocks were written by reading each acceptance file;
  an interface mismatch in a new run still points at a gap there.
- **Isolation is of the checkout, not the machine.** The agent's repository cannot reach the solution, but Pi runs as the
  same user and can read any file that user can: the other worktrees under `/srv/code/worktrees-pi` (several hold these
  very cards' merged solutions), the reference checkout, `~/.claude` transcripts, earlier runs' artifacts, and a
  concurrent run's checkout after its hidden tests were copied in. A bubblewrap sandbox would close this, but the
  agent's own test runs need bubblewrap and AppArmor here refuses nested user namespaces, so the controller's
  sandboxed tests could not run inside one; a separate Unix user would need root. What exists is detection: a run is
  flagged `contaminated` (and `foreignPaths` lists up to 20) when a tool call's arguments name an absolute path under
  the reference checkout, any directory holding a checkout, the results, or the home directory (except Pi's install),
  or the solution's short SHA. It does not see a relative walk (`cat ../c07m/...`), a path built at run time, or a
  search from `/`. Read flagged runs, and spot-check some unflagged finishes, before trusting a rate.
- **Nudges and the W02 end kinds** come from the worker once W02/W04 exist; the bench reads the CLI log only, so
  `nudges` is 0 and `endKind` is the bench's own reading.
- **Windows.** The runner and classifier are plain Node (no shell, `node:path`, `child.kill` where there are no process
  groups), but it has only been run on Linux, and the default Pi location is `~/.local/pi-cli`.
