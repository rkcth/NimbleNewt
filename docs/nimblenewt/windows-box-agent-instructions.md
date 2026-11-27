# Instructions for the agent on the owner's Windows PC

> Note 2026-11-25: historical. Windows Sandbox is no longer the Windows plan (card A03b now builds a native AppContainer launcher; see `windows-isolation-plan.md`). Use these steps only if the owner asks for a Windows Sandbox diagnosis again.
>
> Note 2026-11-26: obsolete. The owner decided to keep the AppContainer launcher and not use Windows Sandbox; the Windows Sandbox code, the job "Windows Sandbox (real)", and the scripts these steps run (`wsb-job-context.mjs`, `wsb-launch-variants.mjs`, `wsb-list-line.mjs`, `wsb-cleanup.mjs`) were removed (implementation notes, "Windows Sandbox code removed"). Kept as a record of the diagnosis only; the steps can no longer be followed as written.

You are a helper agent on the owner's Windows PC (the machine that runs the NimbleNewt "own-hardware" GitHub runner). The people who normally work on NimbleNewt cannot run Windows. You can. Your job is to find out, with real runs, why the Windows Sandbox (`wsb`) command does not work inside the CI job, and to check the repair that is being built. You report facts. You do not guess a cause and call it proven.

## Rules (read first)

1. **Read-only first.** Everything in Parts 1 to 3 only looks. Do not install, uninstall, enable or disable anything, change the registry, change a service, change permissions, or delete files outside your own work folder. If something in Part 4 needs a change, it says so; do it only when the owner (the human at this PC) says yes to that exact step.
2. **No secrets.** Never print, copy, store or send tokens, passwords, keys, the GitHub runner registration, or the contents of any `.credentials`, `.env`, browser or SSH folder. If a command prints one by accident, say so in the report and do not paste it. Environment variable **names** are fine; values are not.
3. **No other people's data.** Work only in the folder `C:\nn-diag` (create it) and the repository checkout you are told to use. Do not open other folders of the owner.
4. **Use the repository's own checkout, not a new login.** Use the existing NimbleNewt checkout on this PC (the runner's `_work` copy, or ask the owner where it is). Do not create or use GitHub tokens. If you cannot read the repository, stop and ask the owner.
5. **Do not touch the running runner** while a CI job is running (look at `Get-Process Runner.Worker` first). Do not stop or restart the runner or the Windows Sandbox server unless the owner says so.
6. **One thing at a time, copy the exact output.** Save each command's output to a text file in `C:\nn-diag\out\` named by step number. Report exit codes, durations and the first 20 lines of any error. Say plainly what you did not do.
7. Never claim a cause. Say "observed" for what you saw and "not tested" for the rest.

## What is known (from CI run 45097817234 and earlier ones)

- The runner is started by hand with `run.cmd`, elevated, as the owner's own account (not as a service). The Windows service for the runner is stopped.
- Windows Sandbox server (`wsb`) has been running since 2026-11-19. From the owner's own elevated PowerShell, `wsb list` answers at once (empty list, exit 0), including with piped output, hidden window and detached start.
- Inside the CI job, `wsb list` times out after about 30 s with a gRPC error to `localhost:80`, in every way the job starts it: Node child process, Node detached, `cmd /c wsb list <NUL >file`, `powershell -Command wsb list`, and `cmd /c start "" /wait <file.cmd>`.
- The only variant that answered was a one-shot **scheduled task** (run in the owner's interactive session): it finished in about 1 s and its output was empty. An empty list is the correct answer when no sandbox runs, but nobody has yet checked that the exit code was 0.
- The job's Node process runs inside a Windows job object (flags 0x3c00) and may have a different token, desktop, window station or session from the owner's PowerShell.
- A separate check says the base folder `_work` of the runner "can be changed by an account other than the runner's". After the owner fixed the permissions (the folder now lists the owner, Administrators and SYSTEM) one extra entry remains: a group named `GITHUB_ActionsRunner_G17fda`. Its origin is unknown; it may be the runner's own built-in group.

## Part 1: Facts about the machine (read-only)

Save each to `C:\nn-diag\out\`.

1. `whoami /all` (redact nothing about group NAMES; do not paste SIDs of other people), `whoami /priv`, `[Environment]::OSVersion`, `winver`, the Windows edition, and whether Windows Sandbox is enabled: `Get-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM`.
2. The runner: `Get-Process Runner.Listener, Runner.Worker -ErrorAction SilentlyContinue | Format-List Id, SessionId, StartTime, Path`; the runner's folder path; `Get-Service | Where-Object Name -like 'actions.runner*'` (state only); whether the shell that started `run.cmd` is elevated (`([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)` from that shell).
3. The sandbox server: `Get-Process | Where-Object { $_.ProcessName -match 'WindowsSandbox|wsb' } | Format-List Id, SessionId, ProcessName, StartTime, Path` and `wsb --help` (the commands the installed version has).
4. Permissions of the runner's `_work` folder: `icacls <runner folder>\_work` and `icacls <runner folder>`, and the members of the group `GITHUB_ActionsRunner_G17fda`: `net localgroup GITHUB_ActionsRunner_G17fda` (names only), and its description: `Get-LocalGroup -Name GITHUB_ActionsRunner_G17fda | Format-List *`. Who created it (is it created by the runner when it was configured)? Say what you can see; do not guess.
5. Time check: `wsb list` from the owner's elevated shell, three times, with `Measure-Command`. Record exit code, output, duration.

## Part 2: Reproduce the failure from the same place the job runs

The job's shell is the runner's Bash step on this PC. Reproduce it without GitHub:

6. The job's shell is Git Bash (see the job "Windows Sandbox (real)" in `.github/workflows/own-hardware.yml`). In an **elevated** Git Bash run `timeout 45 wsb list; echo exit=$?`. Record it.
7. Run the repository's own diagnostic exactly as the job does: from the repository checkout, `node scripts/wsb-job-context.mjs` and then `node scripts/wsb-launch-variants.mjs` (these only look and try `wsb list`; they stop themselves within about 5 minutes). Save the complete output (both are already redacted by `node scripts/redact-log.mjs`: pipe through it as the workflow does). Run both scripts **twice**: once from the elevated Git Bash and once from the owner's normal elevated PowerShell, and compare. **The difference between the two outputs is the most valuable result of this whole task.** List every difference: session id, integrity level, token elevation, window station, desktop, job object flags, parent chain, environment variable NAMES that exist in one and not the other.
8. If a real CI job is available: ask the owner to dispatch the workflow "own-hardware" (the controller does this normally) and, while its "Windows Sandbox (real)" job runs, record from a second shell: `Get-Process Runner.Worker | Format-List Id, SessionId`, the process tree under it (`Get-CimInstance Win32_Process | Where-Object ParentProcessId -eq <Worker pid>`), and whether `wsb list` from your second shell answers while the job's own call is timing out.

## Part 3: Test the hypotheses without changing anything

Each test is one short command with its own output file.

9. **Scheduled task proof.** Create nothing permanent: register a one-shot task named `nn-diag-wsb-<random>` that runs `cmd /c wsb list > C:\nn-diag\out\task-list.txt 2>&1 & echo %ERRORLEVEL% > C:\nn-diag\out\task-exit.txt` as the owner's own account in the owner's logged-on session, start it, wait at most 30 s, read both files, **delete the task** and confirm it is gone (`Get-ScheduledTask nn-diag-wsb-*`). Report: exit code, output, time, and whether the task ran in the owner's interactive session. (This is the strategy the repair uses: it must work from the elevated runner shell too, so run this test from the same shell as step 6.)
10. The same test with the task registered at the highest run level, and without it; say which works. (Measured 2026-11-24: Limited answered in 1.3 s, Highest failed after about 31 s; the repository now registers its task at Limited and keeps the Highest task only as a comparison variant. See implementation-notes.md, "Run level: Limited, from a measured result".)
11. **Is it the session?** `query session` / `qwinsta` and the Session id of the owner's desktop versus `Runner.Worker`'s SessionId. Say whether they are the same.
12. **Is it the job object?** Using the repository script's output (step 7), say whether the job's Node process is inside a job object that restricts it; do not try to break out of it.

## Part 4: Check the repair (only when the owner gives you an exact commit)

A repair is in review (branch `card-wsb-repair`). It routes every `wsb` command through a one-shot scheduled task for the same user and fixes how the base-folder permission check treats the runner's own group. The owner will give you an exact commit once it is merged. Until then, do not do Part 4.

13. `git fetch`, `git checkout <the commit>` (never push or commit), `npm ci --ignore-scripts`, `npm run build`.
14. Run the real Windows Sandbox tests exactly as the workflow step "Run the real Windows Sandbox tests" does (copy its command line and non-secret environment from `.github/workflows/own-hardware.yml`). Record pass and fail counts, failing test names and the first 20 lines of each failure.
15. Run the G05 containment suite and the Y02 scenarios as the workflow steps "G05" and "Y02" do, only if the owner agrees (Y02 takes long). Record the counts.
16. Run `scripts/wsb-cleanup.mjs` (ask first if it has no report-only mode: it can stop sandboxes). Record whether it still says `G05 BASE LEFT ALONE`.
17. Quote these new lines from the output: the **`wsb list (product launcher)`** line (how each call was launched, how it ended, how long it took), the **scheduled-task verdict** in the variants record (SUCCESS, FAILED, or "NOT an answer"), and the **`G05 base access evidence:`** lines.
18. Confirm nothing is left behind: no scheduled task named `nn-*`, no sandbox you started, no files outside `C:\nn-diag` and the checkout.

## What to send back

Write one file, `C:\nn-diag\REPORT.md`, with sections **Facts (Part 1)**, **Reproduction (Part 2)**, **Hypothesis tests (Part 3)**, **Repair check (Part 4, if done)**, **Not done and why**, **Anything that looked unsafe or surprising**. Put exact outputs in an appendix, with every value that could identify a person other than an account kind removed. Ask the owner to send the file to the NimbleNewt controller agent (paste it into the chat). Do not upload it anywhere yourself.

## Stop and ask the owner if

- a step would change the machine or need a password;
- you cannot tell whether a CI job is currently running;
- anything prints a secret;
- a command hangs more than 5 minutes (stop it with Ctrl+C and record that it hung).
