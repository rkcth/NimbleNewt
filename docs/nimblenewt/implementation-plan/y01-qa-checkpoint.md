# Y01: QA checkpoint 1, the durable core

Status: **automated part passing; awaiting the owner's real-hardware run (or a recorded waiver) and the owner's acceptance.** The owner confirmed the three QA checkpoints on 2026-10-20 ([G01 record](g01-decision-record.md), decision 11). This record is evidence for the owner's decision, written by an AI session; it is not the acceptance, and no sign-off box below is ticked.

## Scope

The durable core: storage on both backends (F04 series), assignment and fencing (S02), delivery (S03), inbox (S04), effect ledger (S05), artifacts (S06), reconciliation and blockers (S07), typed waits (S08), the vertical slice with its crash harness and the Pi adapter bridge (S09), and the environment check (F04h). Y01 holds back the security and agent layers (A01 and everything that depends on it).

## Automated part

The hand-started `QA` workflow runs `scripts/qa.mjs --runs=5` from a fresh checkout in a path containing a space, on Ubuntu, macOS and Windows with Node 22.19.0 and 24.21.0. Each run is the whole root `npm test`: the package-boundary and licence checks, every package's tests, the S09 crash enumeration on four storage backends, real SIGKILL runs of the controller path, and real SIGKILL runs with the real Pi adapter.

| Run | Commit | Result |
| --- | --- | --- |
| [39499788238](https://github.com/rkcth/NimbleNewt/actions/runs/39499788238) | `6c7b5b2` | 5 of 6 cells passed all 5 repeats. **windows-latest / Node 24.21.0 failed 1 of 5** (run 4): `SQLite on a worker thread: nothing is lost or duplicated under concurrent load (smoke, hot row)`, "almost no work was done: the load did not run". |
| [39506057525](https://github.com/rkcth/NimbleNewt/actions/runs/39506057525) | `eab38e6` (includes the fix) | **All six cells passed all 5 repeats**: 1463 tests per run, no failures, on `ubuntu-latest`, `macos-latest` and `windows-latest` with each Node version. Repeat times: Ubuntu about 2 minutes, macOS 2 to 3 minutes, Windows about 7 to 8 minutes (Node 22) and 8 to 10 minutes (Node 24) per repeat. |

**The failure, explained and fixed.** The smoke workload keeps its agents running until a minimum number of transitions have happened, but counted the transitions made during the 200 ms warm-up, which the assertion afterwards (`latency.transition.count > 3`) does not count. On a slow Windows runner the minimum was reached during warm-up, the load stopped, and too few transitions were measured. It was a flaw in the test's stopping rule, not in the storage code. The minimum now counts only measured (post-warm-up) transitions (commit `a674bf5`). The fresh run above, on a commit that contains the fix, passed every repeat on every cell. This is the same family as four timing assumptions in tests found earlier: two in the workload tests (fixed in `d4d824a`) and one in the PostgreSQL shutdown test (fixed in `c2574d7`), both found by this QA workflow on Windows with Node 24, and one in an effect test (fixed in `4c26cd2`), found by the regular CI on a Windows cell. All four were tests assuming how long something takes, none was a product defect; each is explained in its commit message (they are not written up elsewhere).

### Per-cell summary (kept here because the workflow's evidence artifacts expire after 90 days)

Run 39506057525, commit `eab38e6`, every cell 5 of 5 repeats passed, 1463 tests per repeat, 0 failed:

| Cell | Repeat times (seconds) | Skipped per repeat |
| --- | --- | --- |
| ubuntu-latest, Node 22.19.0 | 139, 141, 130, 134, 135 | 0 |
| ubuntu-latest, Node 24.21.0 | 119, 120, 120, 118, 118 | 0 |
| macos-latest, Node 22.19.0 | 125, 120, 124, 120, 120 | 0 |
| macos-latest, Node 24.21.0 | 175, 183, 190, 166, 167 | 0 |
| windows-latest, Node 22.19.0 | 436, 471, 411, 434, 486 | 2 |
| windows-latest, Node 24.21.0 | 575, 526, 492, 514, 548 | 2 |

Regular CI for the same commit: [39506052276](https://github.com/rkcth/NimbleNewt/actions/runs/39506052276), all six cells green.

## A slow-runner timeout found by regular CI on the fix commit

CI run [39521800676](https://github.com/rkcth/NimbleNewt/actions/runs/39521800676) on `e318c62` failed one cell: windows-latest / Node 22.19.0, "test timed out after 300000ms" in `slice.test.js`. The S09 crash enumeration ran all of its crash points in one test file, and on a Windows runner with Node 22 (about 7 to 8 minutes for a whole repeat) that file reached the 300 s limit that Node 22 applies to a whole file. The cause is a slow runner, not a hang: the log of an earlier, passing Windows / Node 22.19.0 repeat (QA run 39506057525) shows the SQLite enumeration test alone took 143 s, with the reference-store, worker-thread and PostgreSQL enumerations on top in the same file, so the file sat just under the limit and a slightly slower run crossed it. (Probably because every commit is flushed to disk, which is slow on Windows. The owner, running the suite on their own Windows machine, said it took about 459 s, against 67 s on their Mac; they did not give the commit, and this is their statement, not a measured record. The hosted Windows runners' repeats take 411 to 486 s with Node 22 and 492 to 575 s with Node 24. In the same pre-split log the four enumeration tests together took 212 to 260 s per repeat.) A rare hang cannot be excluded for certain, so each crash run now also has a two-minute watchdog that fails naming the boundary, and each group prints a line when it finishes. It is unrelated to the self-kill change (that file crashes in-process and never kills itself). The limit is per test file on Node 22 (per test on Node 24), so the enumeration is now divided among five test files (the reference store; SQLite in two halves; worker-thread SQLite and PostgreSQL as spreads), in groups of 15 boundaries per test; every boundary of the full backends is still crashed by exactly one file, and the controller package's per-file limit was raised from 300 s to 600 s as a second margin. This is fixed in `632cb6f`; its CI run [39523877412](https://github.com/rkcth/NimbleNewt/actions/runs/39523877412) is green on all six cells, including windows-latest / Node 22.19.0.

## Real hardware so far: the owner's Mac mini (macOS)

The owner ran `node scripts/qa.mjs --runs=5` on a Mac mini (Darwin 25.5.0, Apple silicon, Node 22.23.2) with the repository on an external drive, and sent the QA summary and the output of `scripts/qa-diagnose.mjs`. These are the owner's reports of what the scripts printed; the artifacts themselves are on the owner's machine.

| Commit | Result |
| --- | --- |
| `93bf822` | **All 5 runs failed**, 1 to 3 tests each, every one of them one of the four `SQLite worker thread: a process killed before or after every statement of ... leaves either all of it or none of it` tests ("crash before statement N: expected not committed"). GitHub's macOS runners had passed these tests on every run. |
| `e318c62` (includes the fix) | **0 of 5 runs failed.** The diagnosis lists no failing test. |

**The failure, most likely explained, and fixed.** In those tests the worker thread sends `SIGKILL` to its own process at a chosen statement. The evidence points to the signal taking a moment to land: on a fast Apple-silicon machine the worker thread most likely kept running and reached later statements, even `COMMIT`, before the process died, so the crash point was not where the test said (this was inferred from the failure, not observed directly). The failure's direction ("expected not committed") and the clean 5 of 5 after the fix support it; a durability problem on the drive would have failed the other way (acknowledged work missing after a kill). It points to a flaw in the test hook, not in the storage code. Every self-kill in the test hooks and test children now stops the thread until the signal lands (commit `e318c62`). This is a failure only real hardware showed: the hosted runners did not.

What the Mac run does not tell us: the file system of the external drive (the QA record says "not detected"; `qa.mjs` now asks `df` then `mount` on macOS, and `qa-diagnose.mjs` asks `df` then `diskutil info <device>`; both macOS branches are untested here because the author has no Mac and fall back safely); whether the checkout path having no space matters (this run used a path without a space, unlike the hosted runs); and the Windows and Linux real hardware.

## Real hardware so far: the owner's Windows machine

The owner ran `node scripts/qa.mjs --runs=1` on their Windows machine (Windows_NT 10.0.26200 x64, Node v22.20.0, commit `d0c4823`, repository in a path without a space) and sent the QA lines and the output of `scripts/qa-diagnose.mjs`, reported here as the owner's reports of script output.

- **One repeat passed**: "run 1/1: pass in 365.4 s (1490 of 1492 tests)". This is one repeat, not five, so the Windows box below stays unticked; the two tests not counted are most likely the skipped ones (the blob-store symlink tests, which need privileges on Windows, as on the hosted runners; the owner did not say).
- **The slowest tests there are the PostgreSQL ones** (a migration-upgrade crash test 128 s, a connection-cut crash test 84 s, the PostgreSQL storage conformance run 79 s and 61 s), consistent with forced disk flushes and process starts being slow on Windows; this is a reading of the timings, not a profile.
- **An older log in the same folder showed a failure that is not from that run.** The diagnosis said "runs read: 5" for a 1-run result: the folder still held logs `run-2` to `run-5` from an earlier, 5-run attempt at an unknown earlier commit, and one of them showed `reconcile.test.js` failing with `EBUSY: resource busy or locked, rmdir '...\nn-test-pg-...\data'`: the test PostgreSQL server's temporary data folder could not be deleted at the end (a Windows lock after the server stopped, typically a lingering handle or the antivirus scanner). That is a cleanup failure in the test harness, not a product failure, but it failed a whole test file. Fixed in the test harness (not yet re-run on the owner's machine): cleanup retries for about ten seconds, and a folder that still cannot be removed because of a lock is reported and left for the operating system's temp cleanup instead of failing the test, but only if the server's pid file is gone (a server that is still running, or any other error, still fails). `qa.mjs` now clears the old logs, evidence and summary at the start, and `qa-diagnose.mjs` reads only the logs the evidence lists, so a reused folder cannot mix runs.
- The Windows version (10.0.26200, Windows 11 25H2) is above the environment check's Windows floor (build 26100).

## What the crash enumeration covers

See [s09-acceptance-report.md](s09-acceptance-report.md): the path from a chat-command stub to a worker result is crashed at each of 129 enumerated boundaries and must recover to the state a clean run produces (all 129 on the reference store and SQLite, a spread on worker-thread SQLite and PostgreSQL, 10 real SIGKILLs, and 18 real SIGKILLs with the real Pi adapter including with the model request in flight). The environment check refuses, and an override starts and is audited, for the operating system, Node and PostgreSQL ([F04h notes](implementation-notes.md)).

## What this does not show

- **Real hardware.** Every run above is on GitHub-hosted virtual machines. Real antivirus and filesystem behaviour on the owner's Windows machine, a real Mac, and a Linux distribution other than the runner's are not covered. This is the part that is the owner's to run, or to waive.
- **Windows skips two tests in every repeat**: the blob store's symlink-refusal tests (creating symlinks needs privileges on Windows), so the refusal of symlinked blobs is not exercised on Windows CI. On the owner's real Windows machine, run them with privileges if possible.
- Waits with deadlines, timers and delivery retries are not on the crash-enumerated path (they have their own tests, and run in the cross-platform suite).
- Power loss, disk-full and network faults are not simulated; a PostgreSQL server death in the slice path is covered only by the earlier F04c/F04d suites.
- One crash per run; no real chat API, remote worker, sandbox, tool-using model or network is in the path.
- The OS release floors used by the environment check are the lowest releases seen in CI (not yet confirmed by the owner).

## For the owner

To cover real hardware, on each of the Mac, the Windows machine and a Linux machine: clone the repository into a path with a space, `npm ci`, then `node scripts/qa.mjs --runs=5`, and send the `qa-evidence` output (or the last 80 lines of any failure). Or record a waiver for this checkpoint. Until one of those is recorded and the owner accepts, Y01 stays awaiting sign-off, and the layers it holds back (A01 and everything after it) wait with it.

## Sign-off

- [ ] macOS (real hardware): ______  (commit, Node, date). Evidence reported by the owner: Mac mini, Darwin 25.5.0 arm64, Node 22.23.2, commit `e318c62`, 0 of 5 runs failed (after one failed round caused by a test-hook race, fixed). The box is the owner's to tick.
- [ ] Windows (real hardware): ______  Evidence reported by the owner: Windows 11 (10.0.26200) x64, Node 22.20.0, commit `d0c4823`, 1 repeat passed (not yet the 5 repeats). The box is the owner's to tick.
- [ ] Linux (any distribution beyond the CI runner): ______
- [ ] Owner accepts QA checkpoint 1, or records a waiver of the real-hardware part: ______
