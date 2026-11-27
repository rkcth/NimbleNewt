# Y02 sign-off checklist: isolation, stop and recovery (QA checkpoint 2)

Written 2026-11-27 for Rob, to run at his desk on his own three machines. Rob decided on a real sign-off, with no waiver. Read the [README](README.md) first: it covers the rules shared by both checklists (no keys, no model switching, one commit) and how a signed checklist becomes a card flip.

| Fill in before you start | |
| --- | --- |
| Commit under test (40 characters, from the coordinator) | `________________________________________` |
| Date started | |
| Evidence folder on the Linux server | `~/nn-y02-evidence/` (all three machines' files end up here) |

## What Y02 asks for, in plain words

The card asks for a set of scenarios run on Linux, macOS and Windows with the real sandbox on each. The scenarios are: attempts to escape the sandbox are refused; pause and stop settle with no tool action left half done; a resume throws away stale evidence; a worker lost in the middle of a task is fenced off and reconciled, with no protected action done twice. On Windows the card also asks for a stop and a checked resume across a sign-out or a restart. The report must name the Windows mode (the signed-in, non-elevated user in the home-desktop mode) and record the shared clipboard as an accepted exposure. The full text is the Y02 line in `scripts/generate_task_plan.py`.

The card has two parts:

1. **An automated part.** The scenario set in `scripts/y02-scenarios.json`, run by `scripts/y02-checkpoint.mjs`, plus the containment report (card G05), the five-run QA record and green CI runs, all for one commit.
2. **A real-hardware part.** You run the same set on your own Mac, Windows PC and Linux server and sign each one off. This checklist is that part.

## What CI already proves (you do not need to repeat it)

- **Hosted Linux and macOS, Y02 scenarios.** The workflow `exhaustive.yml` has a job named "Y02 scenarios". It runs all eight scenarios with the sandbox required (bubblewrap on Linux, Seatbelt on macOS) and uploads `y02-scenarios-Linux` and `y02-scenarios-macOS`.
- **Hosted Linux and macOS, containment.** The same workflow has a job named "G05 containment". It runs the containment cases through the production launcher and uploads `containment-<platform>.json`.
- **Hosted, six cells.** The regular CI and the `qa.yml` workflow run the whole suite on Ubuntu, macOS and Windows with Node 22 and 24.
- **What CI cannot prove.** It runs on GitHub's virtual machines, not on your OS builds, disks, antivirus or permissions. It cannot sign out of Windows. And no hosted Windows cell runs the Windows sandbox scenarios with the launcher installed. Those are the reasons for the steps below.
- **This session did not check** whether the latest runs of those jobs are green, because it had no network access. The coordinator looks up the run ids for the chosen commit and puts them in `ci-runs.json` (step S3).

## Prerequisites

| Machine | What it needs |
| --- | --- |
| **Linux server** | Node.js 22.19 or newer, installed in a folder of its own (not under `/usr`), plus git and bubblewrap (`bwrap`). Unprivileged user namespaces must be allowed. The test suite already runs there, so this is normally in place. About 5 GB of free disk. |
| **Mac** | macOS 26 or newer on Apple silicon, Node.js 22.19 or newer, git. The Seatbelt sandbox (`sandbox-exec`) is part of macOS. About 5 GB free. |
| **Windows PC** | Windows 11 24H2 or newer (build 26100 or later), Node.js 22.19 or newer, Git for Windows. **Sign in as yourself, and use a normal PowerShell window, not "Run as administrator".** No service account and no password route to a worker account: you are the signed-in user, in the home-desktop mode. The shared clipboard is accepted (your decision of 2026-11-26), so you do not need to avoid using it. About 5 GB free. |
| **Any machine** | No model. No key. No network beyond GitHub (to clone and to download one workflow artifact). |

**Time.** The minutes below are estimates. The suite has grown about 2.5 times since the Y01 runs, so the Y01 timings were scaled up. They are not measurements. Record what it really takes.

---

## Part L: the Linux server (about 60 to 90 minutes elapsed, 15 minutes hands-on). No model needed.

**L1. Fresh checkout of the commit (5 minutes).**

```
git clone https://github.com/rkcth/NimbleNewt.git ~/nn-signoff
cd ~/nn-signoff
git checkout COMMIT-SHA
npm ci
git status --short
```

Replace `COMMIT-SHA` with the commit in the box above.

- **Expected:** `npm ci` ends without an error, and `git status --short` prints nothing.
- **If it differs:** if git status lists files, stop, because the evidence would be marked DIRTY and the gate refuses it. Write down what it listed. If `npm ci` fails, keep the last 30 lines.

**L2. Record the machine (1 minute).**

```
uname -a; node --version; git --version; bwrap --version; df -T .
```

- **Expected:** Node v22.19 or newer, and a bubblewrap version. The file system shown for the checkout is ext4, xfs or btrfs.
- **Record:** copy the output into the Linux row of the sign-off block.

**L3. The Y02 scenario set (20 to 40 minutes, unattended).**

```
mkdir -p ~/nn-y02-evidence
node scripts/y02-checkpoint.mjs run --out ~/nn-y02-evidence
```

- **Expected:** one line for each of the 8 scenarios, each reading `<scenario>: pass (N/M)`. The last line reads `linux commit <12 characters>: 8/8 scenarios hold -> .../y02-scenarios-linux.json`, with no `DIRTY`.
- **If it differs:** a line reading `FAIL (...)` names the problem. If the only problem is a skipped CPU-pacing test ("rerun on a quiet host"), close other work and run L3 again. Anything else: keep the whole output and record the scenario name in the sign-off block.

**L4. The containment report, card G05 (5 to 10 minutes).**

```
node scripts/containment-evidence.mjs run --out ~/nn-y02-evidence
```

- **Expected:** a line ending `N/N cases hold -> .../containment-linux.json`, with no `DIRTY`.
- **If it differs:** each case that does not hold is printed on its own line. Copy those lines.

**L5. Five full QA runs (25 to 40 minutes, unattended).**

```
node scripts/qa.mjs --runs=5 --out=$HOME/nn-qa-linux
cp ~/nn-qa-linux/qa-evidence.json ~/nn-y02-evidence/qa-evidence-linux.json
```

- **Expected:** five lines reading `run i/5: pass in ... s (P of T tests)`, then `evidence written to ...`.
- **If it differs:** run `node scripts/qa-diagnose.mjs ~/nn-qa-linux` and keep `diagnosis.txt`. Write the failing test names in the sign-off block.

**L6. Hands-on pause, resume and restart on this machine (10 minutes).** This uses the real launcher and typed orders, which work without a model. The data folder is new and only for this check.

```
node scripts/nimblenewt.mjs start --data ~/nn-y02-data
```

- **Expected:** `Secrets are kept in: ...`, a note that no model provider is set up yet, the setup list with the owner line marked `[x]`, and then the `you>` prompt.

At the `you>` prompt, type these lines one at a time:

```
/nimblenewt.lifecycle-pause {"scope": {"kind": "installation", "id": "installation"}, "reason": "Y02 sign-off pause"}
/nimblenewt.lifecycle-status {"scope": {"kind": "installation", "id": "installation"}}
```

- **Expected:** the pause is accepted without asking for a yes, because a typed order runs at once. The status says the installation is paused, by the owner, with your reason.

Now stop the launcher without a clean exit. In a **second terminal** on the server, run:

```
pkill -9 -f "scripts/nimblenewt.mjs start"
```

Then start it again in the first terminal:

```
node scripts/nimblenewt.mjs start --data ~/nn-y02-data
```

At the `you>` prompt, type:

```
/nimblenewt.lifecycle-status {"scope": {"kind": "installation", "id": "installation"}}
/nimblenewt.lifecycle-resume {"scope": {"kind": "installation", "id": "installation"}, "reason": "Y02 sign-off resume"}
/nimblenewt.lifecycle-status {"scope": {"kind": "installation", "id": "installation"}}
```

- **Expected:** the restart creates no second owner, and the first status still shows the pause from before the kill. The resume is accepted and the last status no longer shows a pause.
- **If it differs:** if the start says another controller holds the data folder, wait one minute and start again; do not delete any lock file. Record how long it took. If the pause was lost after the kill, that is a failure: record it.
- Press **Ctrl-D** to leave. Then clean up with `rm -rf ~/nn-y02-data`. One owner credential stays in this machine's secret store, under a name starting `nimblenewt-owner-token-`. It only works with the deleted folder, so it can be left there.

---

## Part M: the Mac (about 60 to 90 minutes elapsed, 15 minutes hands-on). No model needed.

**M1. Fresh checkout (5 minutes).** Use the same commands as L1, in Terminal:

```
git clone https://github.com/rkcth/NimbleNewt.git ~/nn-signoff
cd ~/nn-signoff
git checkout COMMIT-SHA
npm ci
git status --short
```

- **Expected:** the same as L1. If you clone onto the external drive, as for Y01, record that it is the external drive.

**M2. Record the machine (1 minute).**

```
sw_vers; uname -m; node --version; git --version; df -h .; diskutil info "$(df . | tail -1 | awk '{print $1}')" | grep -E "File System Personality|Owners"
```

- **Expected:** macOS 26 or newer, `arm64`, Node v22.19 or newer. The disk lines name APFS (Y01 found "ownership disabled" on the external drive).

**M3. The Y02 scenario set (20 to 40 minutes).**

```
mkdir -p ~/nn-y02-evidence
node scripts/y02-checkpoint.mjs run --out ~/nn-y02-evidence
```

- **Expected:** 8 scenario lines, each `pass`. Some show `K not applicable here`, which is fine: those are tests that only apply on Linux. The last line reads `darwin commit ...: 8/8 scenarios hold -> .../y02-scenarios-darwin.json`.
- **If it differs:** this is the first run of the scenario set on a real Mac. The macOS skip reasons were read from the test sources and have never been seen in a run. If a scenario fails only on a skip whose reason the map does not name, record the reason exactly as printed. The coordinator checks it before anything is changed.

**M4. Containment (5 to 10 minutes).**

```
node scripts/containment-evidence.mjs run --out ~/nn-y02-evidence
```

- **Expected:** `darwin (...) commit ...: N/N cases hold -> .../containment-darwin.json`.

**M5. Five QA runs (25 to 40 minutes).**

```
node scripts/qa.mjs --runs=5 --out=$HOME/nn-qa-darwin
cp ~/nn-qa-darwin/qa-evidence.json ~/nn-y02-evidence/qa-evidence-darwin.json
```

- **Expected:** five `pass` lines. If any fail, run `node scripts/qa-diagnose.mjs ~/nn-qa-darwin` and keep `diagnosis.txt`.

**M6. Hands-on pause, kill and restart (10 minutes).** Do L6 again on the Mac, with the same commands. The kill in the second Terminal window is the same `pkill -9 -f "scripts/nimblenewt.mjs start"`. The owner credential goes into your Keychain, under a name starting `nimblenewt-owner-token-`. Delete the data folder afterwards with `rm -rf ~/nn-y02-data`.

**M7. Copy the files to the server.** Copy `~/nn-y02-evidence/y02-scenarios-darwin.json`, `containment-darwin.json` and `qa-evidence-darwin.json` into `~/nn-y02-evidence/` on the Linux server, with scp or however you normally copy files. Copy the files unchanged, because the sign-off is tied to their exact bytes.

---

## Part W: the Windows PC (about 2.5 to 3.5 hours elapsed, 30 minutes hands-on). No model needed.

Do all of Part W **signed in as yourself, in a normal (not elevated) PowerShell window**.

**W1. Fresh checkout (5 to 10 minutes).**

```
git clone https://github.com/rkcth/NimbleNewt.git "$env:USERPROFILE\nn-signoff"
cd "$env:USERPROFILE\nn-signoff"
git checkout COMMIT-SHA
npm ci
git status --short
```

- **Expected:** the same as L1.

**W2. Record the machine (1 minute).**

```
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture; node --version; git --version; Get-Volume -DriveLetter ($PWD.Path.Substring(0,1)) | Select-Object FileSystemType; whoami /groups | Select-String "Mandatory Label"
```

- **Expected:** Windows 11, build 26100 or higher, NTFS. The last line shows **Medium Mandatory Level**, which means the window is not elevated. Record whether this PC runs Windows Home or Pro (card G06 asks for it).
- **If it differs:** if it shows High Mandatory Level, close the window and open a normal PowerShell window.

**W3. The Y02 scenario set (60 to 150 minutes, unattended).**

```
New-Item -ItemType Directory -Force "$env:USERPROFILE\nn-y02-evidence" | Out-Null
node scripts/y02-checkpoint.mjs run --out "$env:USERPROFILE\nn-y02-evidence"
```

- **Expected when the Windows launcher is in place:** 8 scenario lines, each `pass`, and `win32 commit ...: 8/8 scenarios hold`.
- **Expected today:** the escape scenario (`sandbox-escape-refused`) will probably **fail**. The scenario set needs the native AppContainer launcher configured for the worker (the `NIMBLENEWT_WIN_LAUNCHER` setting). The only install script today, `native/install/Install-NimbleNewtLauncher.ps1`, still sets up the retired separate-account route. There is no documented setup for the signed-in home-desktop mode yet (gap Y02-G1). Run W3 anyway and record which scenarios hold. The other seven do not depend on the launcher and should pass.
- **Alternative:** the workflow "Own hardware" (job "Windows evidence (G06, Y02)") runs the same set on this PC through the self-hosted runner, if you start the runner by hand with `run.cmd` as yourself ([own-hardware runners](../own-hardware-runners.md)). Either way gives the same file.

**W4. The ten containment cases and the sign-out check (30 to 45 minutes, about 15 hands-on).** This is the documented way to run the Windows launcher on your own PC. It runs from a bundle that CI builds, with nothing installed and no administrator.

1. Ask the coordinator to start the hand-started workflow "Windows AppContainer experiment" on the commit, with its own-runner input left off (a GitHub-hosted job builds the bundle), and send you the run link. Download its artifact `windows-g05-owner-bundle` and unzip it into a new, empty folder in Downloads.
2. In a normal PowerShell window in that folder, run:

   ```
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\run-g05.ps1 -Hold
   ```

   **Expected:** it says one confined idle task has started. It ends by itself after 30 minutes at most.
3. **Within 30 minutes, sign out of Windows** (Start, your picture, Sign out), and then sign back in.
4. Open a normal PowerShell window in the same folder again and run:

   ```
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\run-g05.ps1 -AfterSignIn
   ```

   **Expected:** it reports that the held task is gone after the sign-out, sweeps what the task left, checks again, and then runs the ten cases. A file `nn-g05-results.zip` appears on the Desktop.
5. **If it differs:** if it says the task is still running, you have not signed out since step 2, so sign out and in and repeat step 4. If it says the check does not hold, start again at step 2 and record the message. If it refuses because the window is elevated, use a normal window.
6. **Recommended second round, for the restart case:** repeat steps 2 to 4 with **Restart** instead of Sign out. Keep both result zips, and rename the first one so the second does not replace it.

**W5. Five QA runs (60 to 90 minutes, unattended).**

```
node scripts/qa.mjs --runs=5 --out="$env:USERPROFILE\nn-qa-win32"
Copy-Item "$env:USERPROFILE\nn-qa-win32\qa-evidence.json" "$env:USERPROFILE\nn-y02-evidence\qa-evidence-win32.json"
```

- **Expected:** five `pass` lines. Two tests (the symlink ones) are skipped on Windows; that is expected and allowed.

**W6. Hands-on pause, kill and restart (10 minutes).** The controller and the chat do run on Windows, even though agents do not yet. In a normal PowerShell window in the checkout:

```
node scripts/nimblenewt.mjs start --data "$env:USERPROFILE\nn-y02-data"
```

At the `you>` prompt, type the same pause and status lines as in L6. Then, in a **second** PowerShell window, end the launcher without a clean exit:

```
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*nimblenewt.mjs start*' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Start it again, then type the status, resume and status lines from L6.

- **Expected:** the same as L6. The owner credential is kept by Windows' protected storage for your account.
- **If Ctrl-D does not end the chat** in this window, press Ctrl-C and write that down.
- Clean up with `Remove-Item -Recurse -Force "$env:USERPROFILE\nn-y02-data"`.

**W7. Copy the files to the server.** Copy the following to the Linux server:

- `y02-scenarios-win32.json` and `qa-evidence-win32.json`, into `~/nn-y02-evidence/` on the server.
- The result zip(s) from W4, into a separate folder `~/nn-y02-windows-results/`. The coordinator takes `containment-win32.json` out of them.

Copy the files unchanged.

---

## Part S: bringing it together (about 20 minutes, with the coordinator). No model needed.

**S1. Check the evidence folder.** On the server, `ls ~/nn-y02-evidence` should list, for each of `linux`, `darwin` and `win32`, the files `containment-<p>.json`, `y02-scenarios-<p>.json` and `qa-evidence-<p>.json`.

**S2. The owner-load figures (gap Y02-G3).** The card also asks for "owner decisions per day" and any stall that reached unrelated work. The tool exists: `node scripts/y02-checkpoint.mjs owner-load --audit FILE --out FILE`. But it needs an exported audit log, and there is no command to export one yet. Record "not run: gap Y02-G3".

**S3. CI run ids.** The coordinator writes `ci-runs.json` (the format is in the implementation notes, Y02 section). It holds one successful `exhaustive` run and one successful `qa` run per platform, for the same commit.

**S4. The digests your sign-off quotes.** On the server, in the checkout, run:

```
cd ~/nn-signoff
node scripts/y02-checkpoint.mjs digest --dir ~/nn-y02-evidence --platform linux
node scripts/y02-checkpoint.mjs digest --dir ~/nn-y02-evidence --platform darwin
node scripts/y02-checkpoint.mjs digest --dir ~/nn-y02-evidence --platform win32
```

- **Expected:** each prints 64 hexadecimal characters. Copy each into the sign-off block. If any evidence file changes afterwards, its digest changes and your sign-off for that platform stops counting, which is intended.

**S5. A dry run of the gate.** Leave the sign-off out for now; the gate will list it as missing.

```
node scripts/y02-checkpoint.mjs gate --dir ~/nn-y02-evidence --commit COMMIT-SHA --out ~/nn-y02-verdict.json
```

- **Expected today:** `Y02 checkpoint incomplete: ...`, followed by every blocker. Read the list with the coordinator. The hardware lines go away once your sign-off is in `y02-signoff.json`. Every other blocker is a real failure or a gap, and it must be fixed or listed in your sign-off notes.

---

## When Radiance is back (optional for Y02, about 45 minutes, Linux only). Needs a model.

The Y02 gate does not read anything from this section. It is a look with your own eyes at stop and recovery while a real agent is working. Do not load or switch a model: use the one Radiance already serves. Keep to **one agent**, so that the chat plus the agent stay within the two requests at a time that the server allows.

1. Point a new data folder at the model server and a second route. NimbleNewt requires two routes on two different servers:

   ```
   node scripts/nimblenewt.mjs init --data ~/nn-y02-model --model-endpoint http://RADIANCE-ADDRESS/v1 --model THE-LOADED-MODEL --backup-endpoint http://SECOND-ADDRESS/v1 --backup-model SECOND-MODEL --backup-key-secret second-key
   node scripts/nimblenewt.mjs secret set second-key --data ~/nn-y02-model
   node scripts/nimblenewt.mjs start --data ~/nn-y02-model
   ```

   Run `secret set` only if the second route needs a key. It asks for the key without showing it.
2. Follow the first conversation in the [user guide](../user-guide.md) (project, "run the agents on this computer", one agent, one task), using a throwaway git folder as the project. Press Ctrl-D and start again, so that the worker host joins.
3. While the agent is working, type `/nimblenewt.task-list {}`, then a `/nimblenewt.lifecycle-stop` for that task (see the user guide's recovery section).
   - **Expected:** the answer says `Received`, then `Accepted`, then that the stop has taken effect. No tool action of the agent is left running.
4. Resume the task in your own words ("carry on with that task"). Then, while it works, kill the launcher as in L6 and start it again.
   - **Expected:** the task continues after a checked resume, or waits with a named blocker. Nothing is done twice. Ask "what is waiting for me?".
5. Record what you saw in the notes of the sign-off block. Delete `~/nn-y02-model` afterwards.

---

## Gaps found while writing this checklist (Y02)

| Id | Gap | Effect on the sign-off |
| --- | --- | --- |
| Y02-G1 | No setup for the Windows launcher in the signed-in, home-desktop mode for the scenario set. The only installer, `native/install/Install-NimbleNewtLauncher.ps1`, still describes the separate service account with an S4U task, which you ruled out on 2026-11-25 and 2026-11-26. | W3's escape scenario is expected to fail on Windows. A03b must provide this. |
| Y02-G2 | Cards **G05, G06 and A03b are still planned**, and Y02 depends on all three. `scripts/plan.test.mjs` refuses a Y02 flip until they are implemented. Each of them is waiting on the same Windows real-PC run (W4 helps G05 and A03b, W2 and W3 help G06). | Y02 cannot flip yet, even with a complete sign-off. |
| Y02-G3 | No command exports the audit log, so the owner-decisions-per-day and stall figures (`owner-load`) cannot be produced for a real installation. | S2 is "not run". Either the card text or a new export command must settle it. |
| Y02-G4 | The Windows "stop and checked resume across a sign-out or restart" is shown only at the launcher level (W4: `run-g05.ps1 -Hold` and `-AfterSignIn`). The product's worker host does not run on Windows (`scripts/local-host.mjs` and `scripts/remote-host.mjs` refuse anything but Linux), so the controller's checked resume of a real Windows task across a sign-out cannot be run. | Only the launcher half can be signed now. |
| Y02-G5 | The product's worker host on macOS is not composed either, for the same reason. The Mac part proves the sandbox and the scenario files, not a real agent on the Mac. | Recorded as a limit. |
| Y02-G6 | The CI run ids are typed in by hand (`ci-runs.json`), and the gate cannot check them online. | It proves the files are consistent, not that the runs happened. This is already listed under `notVerified` in every verdict. |
| Y02-G7 | The deferred clause: a failure that Y02 finds in a layer P03 uses (sandbox, stop, release, checked resume, fencing, the effect ledger) must be fixed, and P03's own tests run again, before Y03 can pass. | If anything fails above, write which layer in the notes. |

---

## Sign-off block (Y02)

The coordinator copies this block into `y02-signoff.json`, one entry per platform, with the fields `platform`, `kind` `"signed"`, `by`, `at`, `hardware` and `evidenceDigest`, and keeps it with the record of the checkpoint. A sign-off is accepted for 30 days and only for the digest it quotes.

```
Card: Y02 (QA checkpoint 2: isolation, stop and recovery). Real-hardware part, no waiver.
Signed by: Rob
Commit (40 characters): ________________________________________

LINUX   date/time (with time zone): ____________________
        machine and OS (from L2): _________________________________________________
        evidence digest (S4, 64 characters): ________________________________________________________________
        L3 scenarios: __ of 8 hold    L4 containment: __ of __ cases hold    L5 QA: __ of 5 runs pass
        L6 pause survives kill and restart: yes / no
        Result: PASS / FAIL

MAC     date/time: ____________________
        machine and OS (from M2): _________________________________________________
        evidence digest: ________________________________________________________________
        M3 scenarios: __ of 8 hold    M4 containment: __ of __    M5 QA: __ of 5    M6: yes / no
        Result: PASS / FAIL

WINDOWS date/time: ____________________
        machine, OS, build, Home or Pro (from W2): _________________________________________________
        mode: signed-in user, not elevated, home-desktop mode (Medium Mandatory Level): yes / no
        evidence digest: ________________________________________________________________
        W3 scenarios: __ of 8 hold (escape scenario expected blocked, gap Y02-G1)
        W4 ten cases: __ of 10    sign-out check holds: yes / no    restart check holds: yes / no / not run
        W5 QA: __ of 5    W6: yes / no
        Accepted exposure recorded: the shared clipboard and atom table of the home desktop (decision 2026-11-26)
        Result: PASS / FAIL

Per clause:
  escape and path tricks refused ................ Linux __  Mac __  Windows __
  pause and stop settle, no unfinished tool action Linux __  Mac __  Windows __
  resume invalidates stale evidence .............. Linux __  Mac __  Windows __
  lost worker fenced, no duplicate effect ........ Linux __  Mac __  Windows __
  Windows stop and checked resume across sign-out/restart: launcher level __ ; product level: not run (gap Y02-G4)
  Windows report names the native process-level tier as weaker than Linux: __
  owner decisions per day and stalls: not run (gap Y02-G3)

Notes (anything that differed, how long each part took, failures and the layer they hit):
_______________________________________________________________________________
_______________________________________________________________________________
```
