# G06 evidence: the Windows implementation on the supplied Windows host (TEMPLATE, not yet filled)

> Note 2026-11-25: this template was written for the Windows Sandbox launcher. Card G06 now qualifies the native AppContainer launcher (A03b, see `../windows-isolation-plan.md`); the job and artifact names below are historical and will be replaced when A03b provides the native job.

Card G06 asks for the crash, output, migration and containment cases to be repeated on the supplied Windows host, with its OS, runtime and filesystem documented, no Mac or Linux substitute, the production implementation invoked (not a test-only state machine), the implementation commit and reproducible evidence attached, and path cases covering Unicode, case-insensitive collisions, drive roots, paths over 260 characters and junctions.

**Status: no evidence is recorded in this file yet.** Every value below that reads `TO FILL` must come from one own-hardware run on the owner's Windows runner (`nimblenewt-windows`). Do not fill it from a hosted runner, a Mac or Linux, or from memory. Nothing in this file is a sign-off.

## How the run is made

1. On `main`, dispatch **Own hardware** (`.github/workflows/own-hardware.yml`). Its `Windows Sandbox (real)` job, on the same commit, does all of the following and lists each outcome in its job summary:
   - `Record the filesystem (G06)`: artifact `g06-host-windows`, file `g06-host.json` (filesystem type of the checkout's and the temporary folder's volumes, cluster size, `LongPathsEnabled`, 8.3 short names, case sensitivity of the checkout, OS caption, version and build, Node). No volume label, serial number or account name is recorded.
   - `G06 long paths on this machine`: `packages/worker/dist/workspace/long-paths.test.js`, whose Windows-only test makes a real tree deeper than 260 characters. Counts in `g06-host-windows/long-paths-counts.txt`.
   - `G05 containment, redacted`: artifact `containment-windows-own-hardware` (the containment cases through the production launcher with the real Windows Sandbox).
   - `Y02 scenarios with the real Windows Sandbox`: artifact `y02-scenarios-windows-own-hardware`.
   - The `Probe nimblenewt-windows` job of the same run is one run of the whole suite on that machine (artifact `own-hardware-nimblenewt-windows`): that is where the crash, output and migration cases are repeated.
2. Download the artifacts of that run and fill the sections below from them, quoting the run id.

## Run

| Item | Value |
|---|---|
| Own-hardware run id | TO FILL |
| Commit (40 hex) | TO FILL (must equal the run's `GITHUB_SHA` and `g06-host.json`'s `commit`) |
| Date (UTC) | TO FILL |
| Runner label | `nimblenewt-windows` |

## Host (from `g06-host.json`)

| Item | Value |
|---|---|
| OS caption, version, build | TO FILL |
| Architecture | TO FILL |
| Node.js | TO FILL |
| Checkout volume filesystem / cluster size / drive type | TO FILL |
| Temporary folder on the same volume | TO FILL |
| `LongPathsEnabled` | TO FILL (the workspace keeps every full path at or under 240 characters whatever this says) |
| 8.3 short names on the checkout's volume | TO FILL |
| Case sensitivity of the checkout folder | TO FILL |

## Cases

| Case | Where it runs | Result | Evidence |
|---|---|---|---|
| Crash, output and migration (the whole suite once) | Probe job, `qa.mjs --runs=1` | TO FILL (pass/fail counts) | `own-hardware-nimblenewt-windows` |
| Containment (G05 cases through the production launcher) | `G05 containment, redacted` | TO FILL (cases holding, of 10) | `containment-windows-own-hardware` |
| Unicode names and case-insensitive collisions | `workspace.test.ts` in the probe run | TO FILL | probe run |
| Drive roots, device names and junctions | `workspace.test.ts` (Windows-only test) in the probe run | TO FILL | probe run |
| Paths over 260 characters | `long-paths.test.ts` (Windows-only test) | TO FILL (tests / pass / fail / skipped) | `g06-host-windows/long-paths-counts.txt` |
| Y02 scenario set with the real Windows Sandbox | `Y02 scenarios with the real Windows Sandbox` | TO FILL (scenarios holding, of 8) | `y02-scenarios-windows-own-hardware` |

## What this record cannot show

- The containment report's `windows` block keeps logout and reboot under the service identity false: no automation proves them, and the release gate (`containment-evidence.mjs gate`) keeps blocking on them.
- The supervisor-ACL check runs report-only on the runner (the checkout is writable by the runner's account), so the strict check stays open (A03b, G05).
- The controller working-directory check uses the real launcher and a real release layout with a stand-in controller entry (`packaged: false`).
- G06 is blocked by G05 in the plan; this record is G06's evidence, not a change of either card's status.
