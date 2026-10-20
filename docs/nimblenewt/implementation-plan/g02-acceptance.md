# G02: Pi adapter first-milestone acceptance record

Status: **implemented and passing in CI; awaiting independent QA on real macOS and Windows machines and the owner's sign-off.** This record is the evidence for card G02 ("Accept the Pi adapter first milestone"). It does not accept dependent features: see [unsupported capabilities](#unsupported-capabilities).

## What was tested, and on what

- **Code under test:** the actual NimbleNewt adapter (`packages/pi-adapter`, `PiAdapter` implementing the contract's `RuntimePort`/`ConversationPort`). No parallel probe: the acceptance suite (`packages/pi-adapter/src/acceptance.test.ts`) opens `PiAdapter` on Pi's JSONL storage and checks everything through the controller-facing contract types.
- **Runtime:** Pi Durable **1.3.0**, exact pin in `packages/pi-adapter` and `package-lock.json` (a test checks they agree and prints the platform/Node version). Any other Pi Durable version is refused explicitly (`UnsupportedRuntimeError`, `incompatible_runtime`).
- **Provider:** deterministic scripted provider (pi-ai's faux provider); the whole suite also runs under an offline guard that blocks non-loopback network use. Nothing in the suite needs credentials or a network.
- **Process death:** real `SIGKILL` of a child process (on Windows, the child is killed by the same call and a non-zero exit is asserted).
- **Platforms:** CI matrix of ubuntu, macOS and Windows runners × Node 22.19.0 and 24.21.0 on every push, plus a Linux rerun inside a network namespace. All six cells passed for every commit from F06a up to `12d1db7` (run 39351488611). The run for the commit that adds this record, `fe494f9`, is **39356097952**: all six cells (ubuntu, macOS, Windows × Node 22.19.0, 24.21.0) passed. Any later commit that changes the adapter needs its own run recorded before sign-off.
- **Type check and lockfile:** `npm run build` (strict TypeScript) is part of `npm test`; `package-lock.json` is committed, installs use `npm ci` with install scripts disabled, and a license inventory is checked.

## G02 acceptance items and where they are proved

| G02 item | Test(s) |
| --- | --- |
| Semantic tool output reaches the next model step | acceptance: milestone (sentinel seen by the next step); adapter.test.ts |
| Exact inquiry fork leaves the parent unchanged | acceptance: milestone (transcript identical before/after); branches.test.ts |
| Unchanged and selective-update resumes | acceptance: milestone (resume without update; update applied once, then updated resume) |
| Task A/B context separation | acceptance: milestone (after restart too); tasks.test.ts (interleaved runs, final model requests inspected) |
| Abort during streaming and partial tool arguments | acceptance: streaming abort (aborted entry carries the partial call; tool executed 0 times); cancel.test.ts |
| No unfinished tool action | same; the partial call never reaches later model requests (cancel.test.ts) |
| Queued input retained | acceptance: streaming abort (withdrawn, retained, readmitted once); cancel.test.ts, restore.test.ts |
| Real process kill and fresh-process restoration | acceptance: three kill scenarios (unsafe tool not re-run; replay-safe tool re-runs once; two conversations, one abandoned); restore.test.ts, hold.test.ts |
| Same request ID deduplicated | acceptance: milestone (before and after a restart; model not called); adapter.test.ts |
| Compaction preserves historical branch recovery | acceptance: milestone (older checkpoint restores uncompacted history; branch after compaction starts from the compaction); branches.test.ts, checkpoint.test.ts |
| Compatibility rejection | acceptance: milestone (changed history, other runtime, unknown entry are refused); checkpoint.test.ts. Forward migration is **not** supported (G03) |
| Typecheck and lockfile retained | CI; acceptance: environment test |
| Actual adapter code, not a parallel probe | the acceptance suite imports only `PiAdapter.open` and the contract port types |

## Unsupported capabilities

Recorded in code as `UNSUPPORTED_CAPABILITIES` (`packages/pi-adapter/src/capabilities.ts`); a test checks that every card named below exists in the task plan and that the controller port still lacks these methods, so adding one forces this list to be updated. **A feature whose acceptance needs one of these is blocked until it exists.**

| Capability id | Missing because | Blocks |
| --- | --- | --- |
| `portable-history-export` | A checkpoint is a reference; restoring needs the same storage or a faithful copy. | H02, K01, G08 |
| `cross-process-fencing` | JSONL storage has no lock; the interrupted-work hold is per adapter instance. | H01, H02, H08, G08, K05 |
| `per-conversation-resume` | Pi's scheduler is harness-wide; the only per-conversation choice is to abandon. | L01, L02, U06 |
| `wait-by-request-id` | Not on the port; `lookup` polls, resubmitting the same payload returns the original. | S09, H06 |
| `cancel-single-request` | `abort()` is whole-conversation. | L01, U03 |
| `transcript-paging` | `transcript()` returns the full history. | U05, U07 |
| `progress-events` | No event stream yet. | H06, V01, U05, U07 |
| `forward-migration` | No migration is defined: old Pi storage in the tested fixtures has the same layout and is adopted, a marker naming another version is refused (see [g03-compatibility.md](g03-compatibility.md)). A Pi release that changes the layout needs a real, atomic migration. | K03 |
| `in-flight-state` | Branches and checkpoints start at completed-turn boundaries. | G09, L01 |
| `usage-accounting` | Pi records spend per conversation but the port does not expose it. | R02, B01, X07 |
| `per-task-model-and-tools` | One model and tool set for the whole adapter. | R01, T01 |
| `workspace-checkpoints` | Outside the adapter; the controller pairs a checkpoint with an artifact manifest. | P02, S06, K01 |
| `history-retention` | Everything is kept; the results document and discarded branches grow. | K01, X08 |

Known limits that are not capabilities: the digest in a checkpoint detects accidental change, not tampering by someone who can rewrite both the history and the checkpoint; events delivered to the audit sink are at-least-once; Pi commits partial model output and tool output at most every 100 ms by default (`settings.progress`), so a crash loses at most that window.

## Decisions taken that the owner may override

- Aborted inputs are framed for the model by default (`abortedInputs: "keep"` restores Pi's behaviour).
- An update runs immediately by default; `run: false` only places it.
- Inquiry branches, restored checkpoints and tasks are each limited per conversation (defaults 8, 8, 16).
- A storage with interrupted work is held (`holdInterrupted`, default true) until `recover()` is called.

## QA checklist for the Mac, Windows and Paperclip runs

A **Paperclip run** is the same checklist carried out by a Paperclip agent on a machine it controls, with its results posted as a comment on the Paperclip issue for this card (G02 is a child of N03, **AII-253**) and any failure raised as a typed blocker on that issue. Paperclip imported the task plan as unassigned Backlog under N00 (AII-250), which stays closed until the owner opens it; a Paperclip QA run therefore needs the owner to assign it explicitly.

Goal: confirm the suite on real machines and report anything CI cannot show. CI already runs the same commands on hosted runners, so the value here is real hardware, real antivirus/filesystem behaviour and a fresh checkout.

1. **Prerequisites:** Node 22.19.0 or newer (24.x also tested), git. No network is needed after install; no credentials.
2. **Fresh checkout:** `git clone https://github.com/rkcth/NimbleNewt.git` into a path that contains a space (for example `C:\Users\Test User\nn check` or `~/nn check`), then `cd` into it and `git log -1 --oneline` to record the commit.
3. **Install and run:** `npm ci` then `npm test`. Expected: `package boundaries ok`, `license inventory ok`, and test totals of 23 (scripts), 2 (contracts) and at least 120 (adapter) with 0 failures. Record the totals and the platform/Node line printed by the "G02 environment" test (look for `G02 environment:` in the `npm test` output). To rerun only the acceptance file after a build: `npm run build` then `node --import ./scripts/offline-guard.mjs --test packages/pi-adapter/dist/acceptance.test.js` from the repo root (the import keeps the offline guard on).
4. **Repeat to catch flakiness:** run `npm test` five times in a row (the real-kill and timing-sensitive tests are in `restore`, `hold` and `acceptance`). All five must pass.
5. **Antivirus/filesystem check (Windows especially):** run once with real-time protection on. Failures in `rmSync`/`EBUSY` on temporary directories are worth reporting even if a retry passes.
6. **Report:** for any failure, paste the last 80 lines of output (CI posts them as an annotation on failure; locally use `npm test 2>&1 | tail -80`), the commit hash, OS version, Node version (`node -v`), and whether it reproduces. Report failures as typed blockers: *what failed, on which platform, whether it reproduces, who must resolve it.*
7. **Do not** change the lockfile, enable install scripts, or point the suite at a real model provider during QA.

## Sign-off

- [ ] macOS (real hardware): ______  (commit, Node, date)
- [ ] Windows (real hardware): ______
- [ ] Linux (any distribution beyond the CI runner): ______
- [ ] Owner accepts the G02 milestone and the decisions above.

Until these are checked, dependent features may build on the adapter for development, but none may be marked accepted on the strength of this record.
