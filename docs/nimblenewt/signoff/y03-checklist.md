# Y03 sign-off checklist: the first complete workflow driven from chat (QA checkpoint 3)

Written 2026-11-27 for Rob, to run at his desk on his own three machines. Rob decided on a real sign-off, with no waiver. Read the [README](README.md) first for the shared rules (no keys, no model switching, one commit) and for how a signed checklist becomes a card flip. Do the [Y02 checklist](y02-checklist.md) first: Y02 is a direct blocker of Y03.

| Fill in before you start | |
| --- | --- |
| Commit under test (40 characters, from the coordinator; the same commit on every machine) | `________________________________________` |
| Date started | |

## What Y03 asks for, in plain words

Starting from a fresh install on Linux, macOS and Windows, and using the web chat over a private network, the card asks for:

- a project that is created and finished from chat (tasks, a meeting decision, coding and non-code work, and independent QA);
- restarts, and a worker lost part-way through, that lose nothing;
- a backup that restores, and a migration that rolls back as documented;
- a chat that stays responsive under load;
- evidence recorded for each platform.

Like Y02, it has an automated part and a real-hardware part. The full text is the Y03 line in `scripts/generate_task_plan.py`.

## Read this first: how much of Y03 can run today

Today, only part of this card can be run on real hardware. The honest state:

- **Most of the card needs a model.** The chat understands your words by asking a model, and agents need one to work. Radiance is offline, so Part A below is everything that can be done now without a model. Part B waits for Radiance.
- **Several pieces the card names cannot be started from a terminal yet.** They are listed under "Gaps" at the end, with what each one blocks. The biggest: the web chat has no command to start it, agents cannot run on macOS or Windows, there is no command to back up and restore from the chat launcher, no release exists to roll a migration back to, and there is no automated Y03 scenario set or gate.
- **Y03 cannot flip before Y02 and P02 are implemented.** `scripts/plan.test.mjs` refuses it.

So this checklist gives you a real result for the parts that exist, and a clear list of what has to be built before the rest can be signed.

## What CI already proves (you do not need to repeat it)

These run in CI on every change, with a scripted stand-in in place of the model. They prove that the steps exist and work once the words are understood. They do not prove that a real model understands your wording.

- **The user guide's first conversation:** project, approval profile, host, agent, rights, task. `packages/integration/src/d01-user-guide.test.ts` runs every line of it against the real chat, and also runs the typed recovery orders with the model servers switched off.
- **The phone web chat** (card U07): sessions, revocation, resume without duplicate commands, and the views. `web/web.test.ts`, `web/browser.test.ts` (headless Chrome) and the UI tests run these.
- **Migration recovery and rollback limits** (card K03), backup and restore previews (card K01), and meetings and decisions (card M02) are each tested on the four storage backends.
- **The whole suite** runs on hosted Ubuntu, macOS and Windows with Node 22 and 24.
- **Not checked here:** whether the latest runs are green (this session had no network access). The coordinator finds the run ids for the chosen commit.

## Prerequisites

| Machine | What it needs |
| --- | --- |
| **Linux server** | Node.js 22.19 or newer in a folder of its own (not `/usr`), git, bubblewrap. This is the only machine where agents can work today. |
| **Mac** | macOS 26 or newer on Apple silicon, Node.js 22.19 or newer, git. It can host the controller and the chat, but not agents. |
| **Windows PC** | Windows 11 build 26100 or newer, Node.js 22.19 or newer, Git for Windows. Sign in as yourself and use a normal (not elevated) PowerShell window. It can host the controller and the chat, but not agents. |
| **Part B only** | Radiance back up with the model it already serves (do not load or switch one), plus a second route on another server, because NimbleNewt requires two. If the second route needs a key, store it with `node scripts/nimblenewt.mjs secret set NAME`. Never type a key into the chat. |

---

## Part A: what can be done now (no model needed)

Do Part A on each machine. On the Mac use Terminal, and on Windows a normal PowerShell window. Each machine takes about 25 to 40 minutes, about 2 hours in all.

**A1. Fresh install (10 to 15 minutes).** This is the install from the [user guide](../user-guide.md), on the agreed commit.

Linux and Mac:

```
git clone https://github.com/rkcth/NimbleNewt.git ~/nn-y03
cd ~/nn-y03
git checkout COMMIT-SHA
npm ci
npx tsc --build
node scripts/check-package-boundaries.mjs
```

Windows:

```
git clone https://github.com/rkcth/NimbleNewt.git "$env:USERPROFILE\nn-y03"
cd "$env:USERPROFILE\nn-y03"
git checkout COMMIT-SHA
npm ci
npx tsc --build
node scripts/check-package-boundaries.mjs
```

- **Expected:** the last command prints `package boundaries ok`.
- **Record:** how many minutes the install took, and anything it printed in red.

**A2. The environment check and the setup list (2 minutes).**

Linux and Mac:

```
node scripts/nimblenewt.mjs status --data ~/nn-y03-data
```

Windows:

```
node scripts/nimblenewt.mjs status --data "$env:USERPROFILE\nn-y03-data"
```

- **Expected:** a line saying no configuration was found, so a starter one was written. Then `Secrets are kept in: ...`, which names the Keychain on the Mac, Windows' protected storage on Windows, and the Secret Service or owner-only files on Linux. Then the setup list, with the owner `[x]` and the project, model route, host and agent `[ ]`. The program then stops.
- **If it differs:** if it refuses the environment, copy the message exactly. It names what it found and what is supported. **Do not** add the override; a refusal on a supported machine is a finding.

**A3. Start the chat, and what it says when no model is reachable (5 minutes).**

```
node scripts/nimblenewt.mjs start --data ~/nn-y03-data
```

On Windows, use the same `--data "$env:USERPROFILE\nn-y03-data"` form as in A2.

At the `you>` prompt, type:

```
help me get started
```

- **Expected:** `The assistant that reads free-form messages is unavailable right now. Nothing was done`. Nothing changes.

Then type:

```
/nimblenewt.task-list {}
/nimblenewt.agent-list {}
/nimblenewt.lifecycle-status {"scope": {"kind": "installation", "id": "installation"}}
```

- **Expected:** empty task and agent lists, and an installation that is not paused. These typed orders work without a model.

**A4. A restart loses nothing (5 minutes).** At the prompt, type:

```
/nimblenewt.lifecycle-pause {"scope": {"kind": "installation", "id": "installation"}, "reason": "Y03 restart check"}
```

End the launcher without a clean exit, from a second window:

- Linux and Mac: `pkill -9 -f "scripts/nimblenewt.mjs start"`
- Windows: `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*nimblenewt.mjs start*' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`

Start it again with the A3 command and type:

```
/nimblenewt.lifecycle-status {"scope": {"kind": "installation", "id": "installation"}}
/nimblenewt.lifecycle-resume {"scope": {"kind": "installation", "id": "installation"}, "reason": "carry on"}
```

- **Expected:** no new owner is made, the pause from before the kill is still there, and the resume lifts it.
- **If it differs:** if it says another controller holds the data folder, wait one minute and start again; do not delete lock files. Record how long it took.

**A5. A clean stop (1 minute).** Press **Ctrl-D**.

- **Expected:** the launcher ends and you are back at the shell prompt.
- **If it differs:** on Windows, if Ctrl-D does nothing, press Ctrl-C and write that down.
- **Clean up:** `rm -rf ~/nn-y03-data`, or on Windows `Remove-Item -Recurse -Force "$env:USERPROFILE\nn-y03-data"`.

---

## Part B: when Radiance is back (needs a model; Linux only today; about 2 to 3 hours)

Use the model Radiance already serves; never load or switch one. Radiance allows **two requests at a time** across all its users. Keep **one agent working at a time**: have only one task ready at a time, and ask in the chat to limit local agents to one if it offers that. Record every place where more than one agent would have had to work at once.

**B1. Fresh data folder with two model routes (5 minutes).**

```
cd ~/nn-y03
node scripts/nimblenewt.mjs init --data ~/nn-y03-model --model-endpoint http://RADIANCE-ADDRESS/v1 --model THE-LOADED-MODEL --backup-endpoint http://SECOND-ADDRESS/v1 --backup-model SECOND-MODEL --backup-key-secret second-key
node scripts/nimblenewt.mjs secret set second-key --data ~/nn-y03-model
node scripts/nimblenewt.mjs start --data ~/nn-y03-model
```

Run the `secret set` line only if the second route needs a key. It asks for the key without showing it.

- **Expected:** the setup list shows the model routes done.

**B2. A project created from chat (20 minutes).** Make a throwaway git folder first:

```
mkdir -p ~/nn-y03-garden && git -C ~/nn-y03-garden init
```

Then hold the first conversation in the user guide, in your own words. It covers: stay on strict; the project, pointing at `~/nn-y03-garden`; run the agents on this computer; an author agent; let it work on the project; one task. Press Ctrl-D and start again so the worker host joins.

- **Expected:** every consequential step answers "Proposed, nothing has happened yet" and waits for your yes. After the restart the host shows as done, and the agent starts the task by itself.
- **Record:** any line the model got wrong, and what you said instead.

**B3. A meeting decision (15 minutes).** Add a second agent (for example a reviewer). Then say, for example, "call Ann and Bob into a meeting now, we need to decide how to word the greeting".

- **Expected:** the meeting proposal names who is called and for how long. After it, "what meetings are scheduled?" and the meeting summary show the decision.

**B4. Non-code work (15 minutes).** Give the author a task that produces a short document (for example "write a one-page note on how to water the garden").

- **Expected:** the agent publishes the document as a deliverable of its task. Another agent or you review it. The author cannot accept its own work.

**B5. Coding work and independent QA (30 to 45 minutes).** The greeting task from B2 changes code.

- **Expected:** the submission waits for review. The reviewer is not the author, and accepting it takes an independent decision. Then "commit the approved greeting change" in your own words lands it through the strict profile's human step.
- **Note:** this depends on card **P02** (isolated coding workspaces), which is built in slices but not yet flipped. Record whatever stops the flow.

**B6. A restart in the middle of work (10 minutes).** While an agent is working, kill the launcher from a second terminal with `pkill -9 -f "scripts/nimblenewt.mjs start"`, then start it again.

- **Expected:** the task continues after a checked resume, or waits with a named blocker. Nothing is done twice, and "what is waiting for me?" tells you what needs you.

**B7. Finish the project (15 minutes).** Ask how the project is going. When every task is accepted, ask NimbleNewt to close or finish the project.

- **Expected:** the project ends with every task accepted, or the chat says plainly what is still open.

**B8. Responsiveness (during B2 to B7).** Note any reply that took more than about 10 seconds, and what was happening at the time. There is no load tool for this (gap Y03-G7), so this is only your observation.

**B9. Clean up.** Press Ctrl-D, then:

```
rm -rf ~/nn-y03-model ~/nn-y03-garden
```

---

## Gaps found while writing this checklist (Y03)

| Id | Gap | What it blocks |
| --- | --- | --- |
| Y03-G1 | **No automated Y03 part.** No scenario set or gate exists for Y03 (nothing like `scripts/y02-checkpoint.mjs`). The card requires "an integration scenario set run by the QA workflow ... that must pass". | The automated half of the card. |
| Y03-G2 | **The web chat cannot be started by the owner.** The phone web chat is built and tested (U07), but neither `scripts/nimblenewt.mjs` nor `scripts/nimblenewt-controller.mjs` passes the `webChat` start option. Its pairing code is made only from code. The guide [private-web-chat](../private-web-chat.md) describes the wiring as a script. | "Using the web chat over a private network" on every platform. Part B uses the terminal chat instead. |
| Y03-G3 | **Agents run on Linux only.** The worker host (`scripts/local-host.mjs`) and the remote worker (`scripts/remote-host.mjs`) refuse macOS and Windows. The Windows launcher (A03b) is unfinished. | "A project is created and finished from chat" on macOS and Windows. |
| Y03-G4 | **A remote worker cannot be connected from the launcher.** Neither launcher sets the controller's remote-worker option, so a worker on a second machine cannot join from the command line. | "A worker loss mid-way". On one machine the worker host runs inside the launcher's process, so killing it is the same as B6's restart, not a separate worker loss. |
| Y03-G5 | **Backup and restore are not reachable from the chat launcher.** `scripts/nimblenewt.mjs start` starts no backup service. `scripts/nimblenewt-controller.mjs` has backups on by default but no chat, and the two cannot share a data folder. Restore exists only as API operations. The user guide's backup section describes chat questions that the launcher's installation cannot answer yet. | "Backup restores as documented". |
| Y03-G6 | **Migration rollback cannot be exercised.** Rollback needs an earlier release that has started healthy on this schema, and there is no release builder yet (see [maintenance and updates](../maintenance-and-updates.md)). | "A migration rolls back as documented". |
| Y03-G7 | **No load tool** for "responsive chat under load". With Radiance limited to two requests at a time, a real load test would also go against the shared-server rule. | That clause. B8 records only your observation. |
| Y03-G8 | **Blockers not flipped.** Y02 (see its checklist) and P02 are planned. | The flip itself. |
| Y03-G9 | **No sign-off file format or gate.** Unlike Y02's `y02-signoff.json`, nothing machine-checks a Y03 sign-off. | The record is this signed checklist, copied in as the checkpoint's record, like Y01's. |

---

## Sign-off block (Y03)

The coordinator copies this block into the checkpoint's record (a new file, y03-qa-checkpoint.md in the implementation-plan folder, made like the Y01 record). The flip entry's note quotes it. A clause marked "not run: gap" is not a pass. The card flips only when every clause is PASS, on the same commit, for every platform the clause names.

```
Card: Y03 (QA checkpoint 3: first complete chat-driven workflow). Real-hardware part, no waiver.
Signed by: Rob
Commit (40 characters): ________________________________________

Per machine (date/time with time zone, OS and version, Node version):
  LINUX   ___________________________________________________________
  MAC     ___________________________________________________________
  WINDOWS ___________________________________________________________ (signed-in, not elevated: yes / no)

Part A (no model)                              Linux   Mac     Windows
  A1 fresh install, boundaries ok ............  ____    ____    ____
  A2 environment check passes, setup list ....  ____    ____    ____
  A3 model-down answer, typed orders work ....  ____    ____    ____
  A4 pause survives a kill and restart .......  ____    ____    ____
  A5 clean stop with Ctrl-D ..................  ____    ____    ____

Part B (needs a model)                         Linux   Mac             Windows
  project created and finished from chat .....  ____    not run: Y03-G3 not run: Y03-G3
  meeting decision ...........................  ____    not run: Y03-G3 not run: Y03-G3
  coding work with independent QA ............  ____    not run: Y03-G3 not run: Y03-G3
  non-code work accepted by another ..........  ____    not run: Y03-G3 not run: Y03-G3
  restart mid-work loses nothing .............  ____    not run: Y03-G3 not run: Y03-G3
  worker lost mid-way loses nothing ..........  not run: Y03-G4 (all platforms)
  backup restores as documented ..............  not run: Y03-G5 (all platforms)
  migration rolls back as documented .........  not run: Y03-G6 (all platforms)
  web chat over a private network ............  not run: Y03-G2 (all platforms)
  responsive chat under load .................  observation only (Y03-G7): ______________________

Automated part: not built (Y03-G1)

Notes (what differed, how long each part took, model misreadings, anything that felt slow):
_______________________________________________________________________________
_______________________________________________________________________________
```
