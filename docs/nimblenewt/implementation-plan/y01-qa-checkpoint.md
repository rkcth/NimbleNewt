# Y01: QA checkpoint 1, the durable core

Status: **automated part passing; awaiting the owner's real-hardware run (or a recorded waiver) and the owner's acceptance.** The owner confirmed the three QA checkpoints on 2026-10-20 ([G01 record](g01-decision-record.md), decision 11). This record is evidence for the owner's decision, written by an AI session; it is not the acceptance, and no sign-off box below is ticked.

## Scope

The durable core: storage on both backends (F04 series), assignment and fencing (S02), delivery (S03), inbox (S04), effect ledger (S05), artifacts (S06), reconciliation and blockers (S07), typed waits (S08), the vertical slice with its crash harness and the Pi adapter bridge (S09), and the environment check (F04h). Y01 holds back the security and agent layers (A01 and everything that depends on it).

## Automated part

The hand-started `QA` workflow runs `scripts/qa.mjs --runs=5` from a fresh checkout in a path containing a space, on Ubuntu, macOS and Windows with Node 22.19.0 and 24.21.0. Each run is the whole root `npm test`: the package-boundary and licence checks, every package's tests, the S09 crash enumeration on four storage backends, real SIGKILL runs of the controller path, and real SIGKILL runs with the real Pi adapter.

| Run | Commit | Result |
| --- | --- | --- |
| [39499788238](https://github.com/rkcth/NimbleNewt/actions/runs/39499788238) | `6c7b5b2` | 5 of 6 cells passed all 5 repeats. **windows-latest / Node 24.21.0 failed 1 of 5** (run 4): `SQLite on a worker thread: nothing is lost or duplicated under concurrent load (smoke, hot row)`, "almost no work was done: the load did not run". |
| [39506057525](https://github.com/rkcth/NimbleNewt/actions/runs/39506057525) | `eab38e6` (includes the fix) | **All six cells passed all 5 repeats**: 1463 tests per run, no failures, on `ubuntu-latest`, `macos-latest` and `windows-latest` with each Node version. Repeat times: Ubuntu about 2 minutes, macOS 2 to 3 minutes, Windows 7 to 10 minutes per repeat. |

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

- [ ] macOS (real hardware): ______  (commit, Node, date)
- [ ] Windows (real hardware): ______
- [ ] Linux (any distribution beyond the CI runner): ______
- [ ] Owner accepts QA checkpoint 1, or records a waiver of the real-hardware part: ______
