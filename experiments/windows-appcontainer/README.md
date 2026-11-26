# Windows AppContainer experiment

This is an experiment, not product code. Nothing in the product uses it. It asks one question cheaply: can a plain, native Windows
confinement work as a baseline for running an agent's tools, with no virtual machine, no UAC prompt at run time, on every Windows edition,
and without anyone signed in?

The confinement under test is a **low-privilege AppContainer (LPAC)** with no network capability, started inside a **Job Object**
(kill when the job closes, a memory limit, an active-process limit), with **explicit ACL entries for the container's SID only** on a
temporary workspace. The Windows Sandbox backend was dropped because it needs an interactive session, `wsb start` is refused from a
service, it needs UAC and it is Pro-only.

## What is here

| File | What it is |
| --- | --- |
| `round4.mjs` | Round 4: the child-program ladder (`--mode spawn`) and the step script that runs inside the container. |
| `npm.mjs` | Round 3b: why `npm ci --offline` fails in the container and which variant makes it pass (`--mode npm`). |
| `round3.mjs` | Round 3: the git ladder, the junction/ACL-propagation check and the timing measurement (and the reader of the NUL device's security descriptor). |
| `launcher/` | A thin crate (`nn-appc-launcher`) that builds the PRODUCT launcher's source (`native/nn-launcher/`, A03b slice 3) with the cargo feature `experiment`, which adds the measuring options below (the product build refuses them). It creates or reuses the container profile, grants and later revokes ACL entries, starts one program in the container and the job, and prints one JSON line. |
| `probe.mjs` | The script that runs **inside** the container (Node's own modules only). It attempts the ten containment cases and the tool and network checks. |
| `ladder.mjs` | Round 2: the smoke ladder (variants of the container and the programs tried in each) and the firewall mini-experiment. Tested on Linux with fakes. |
| `lib.mjs` | The harness's pure logic (argument building, fixtures, verdicts, report schema, markdown). Tested on Linux. |
| `run-experiment.mjs` | The harness: builds fixtures, runs the launcher once per matrix cell, judges the results, cleans up. |
| `../../scripts/windows-appcontainer-experiment.test.mjs` | Unit tests (run on Linux in CI with a fake launcher). |
| `../../.github/workflows/windows-appcontainer-experiment.yml` | Manual workflow: hosted Windows, plus an opt-in job for the owner's service runner. |

## Running it

On Windows (a hosted runner, your own machine, or a service):

```
cd experiments/windows-appcontainer/launcher
cargo build --release --locked
cd ..\..\..
node experiments/windows-appcontainer/run-experiment.mjs --out out
```

Options: `--cells all|id,id` (cell ids are in the table of `results.md`), `--launcher PATH`, `--profile NAME`,
`--timeout-ms N`, `--dry-run` (builds fixtures and arguments, starts nothing). The results are `out/results.md` and `out/results.json`,
with the temporary folder, home, account and machine names and SIDs replaced.

It needs no prompt, window or UAC. To test "nobody signed in", run it from the owner's self-hosted runner (a service) through the
workflow's `own_runner` input. The results record the session id (0 is the services session) and whether the run was elevated.

## The matrix

LPAC on/off x Win32k system calls disabled on/off x "ALL APPLICATION PACKAGES opt-out" on/off, plus one extra cell.

* LPAC off: no policy attribute at all (a plain AppContainer). The opt-out flag then has nothing to act on; the two cells are the same
  configuration and the table says so (they also show run-to-run noise).
* LPAC on, opt-out on: the policy attribute with the opt-out value (the real LPAC).
* LPAC on, opt-out off: the attribute present with the default opt-in value (should behave like a plain container).
* `baseline-no-protect`: the real LPAC without the deny entry on the workspace's `.git`, to show what the protected-name case does without it.

## What the probe attempts (inside the container)

The ten case ids come from `packages/worker/src/sandbox/containment.ts`: `control-write-own-directories`, `control-read-own-decoy`,
`deny-write-system`, `deny-write-host-path`, `deny-symlink-read`, `deny-symlink-write`, `deny-credential-read`,
`deny-controller-data-read`, `deny-network-loopback`, `deny-write-protected-name`. Extra probes: an outbound connect (to a listener on the
machine's own non-loopback address when there is one), a listing of the real owner profile folder, a write to the system `Temp` folder.
Tools: `node --version`, `git --version`, `git init` + add + commit, `npm --version`, and an offline `npm ci` of a tiny
fixture package (a local tarball named by a lockfile with its integrity hash). The probe also records every "access denied" line a
tool prints at start-up.

Each probe has an expected result (allowed or denied), the attempts, and what actually happened. The harness also checks the **host
side**: a file that must not change, a file that must not exist, a connection a listener must not have counted. A denial counts as
`pass` only when every attempt got an access-denied code; a refusal for any other reason (path missing, connection refused, timeout) is
`weak`. If the control cases fail, every denial is only `weak` (a container that refuses everything proves nothing).

Link fixtures: directory links are junctions (no privilege); file links need the right to create symbolic links. If the account lacks it,
the link is recorded as not planted and its attempts are skipped, so the case is `inc`, never `pass`.

## The launcher

The source is the product's (`native/nn-launcher/src/win.rs`, moved there in A03b slice 3); this folder's crate depends on it with the cargo feature `experiment`. Everything below that the product refuses (`deny-write`/`deny-strong`, pipes, NUL, `dump`, `grant`, `delete-profile`, `open-test`, the hang diagnosis) exists only in this build.

```
nn-appc-launcher run --exe PATH --cmdline "TEXT" --cwd PATH --stdout FILE --stderr FILE
    [--name PROFILE] [--grant MODE:PATH]... [--grant-soft MODE:PATH]... [--env NAME=VALUE]...
    [--aap-policy none|optout|optin] [--capability SID-or-NAME]... [--win32k-off] [--no-kill-on-close]
    [--memory-mb N] [--active-processes N] [--ui-limits] [--timeout-ms N]
    [--stdin nul|nul-rw|file:PATH|pipe|pipe-open] [--stdout-pipe] [--stderr-pipe] [--stdout-nul-rw] [--stderr-nul-rw] [--dump PATH]...
nn-appc-launcher dump --dump PATH...    (read-only: the DACL of each path as SDDL)
nn-appc-launcher open-test      (meant to run AS THE CHILD inside the container; prints the NUL device open results)
nn-appc-launcher info | revoke --grant MODE:PATH... | check --grant MODE:PATH... | grant --grant MODE:PATH... | delete-profile      (all take --name)
```

Modes: `ro`, `rx`, `modify`, `deny-write`, and (round 4) `deny-strong`, `seal`, `modify-root`. A `--grant` that fails stops the run before anything starts; a `--grant-soft` (program install
folders, which may need rights the account does not have) is recorded and the run goes on. The child gets **only** the `--env` values (nothing is
inherited), its standard input from `NUL`, and its standard output and error written straight to the two files (the launcher does not copy
them after the fact, and has no cap on their size; the job's memory limit does not bound disk output). All grants are revoked
on every path out (a drop guard also covers a panic); `revoke` repeats it for a launcher that died. Exit code: the child's, 124 when the
timeout killed the job, 125 when the launcher itself failed; the JSON line is authoritative (`ok`, `childStarted`, `stage`, `error`).

The attribute-list buffer is pointer-aligned, and a key set twice in the JSON line keeps one value (a wait that fails after the child started still says `childStarted: true`).

It fails closed: no container, no run. There is no other process-creation call in the source and the unit tests check that.

### Every Win32 call, and why

| Call | Why |
| --- | --- |
| `CreateAppContainerProfile` | Create the container profile with the fixed name and no capabilities (so no network). |
| `DeriveAppContainerSidFromAppContainerName` | The profile already exists (an earlier run): get its SID. |
| `DeleteAppContainerProfile` | `delete-profile`, at the end of the harness. |
| `ConvertSidToStringSidW` | Print the container SID in the JSON line. |
| `GetNamedSecurityInfoW` | Read a folder's current DACL before changing it. |
| `SetEntriesInAclW` | Merge one explicit entry (grant or deny) for the container SID into that DACL. |
| `DeleteAce` | A revoke: remove every explicit entry that names the container from a copy of the DACL (round 1 used `SetEntriesInAclW` with `REVOKE_ACCESS`, which left the deny entry on `.git`). |
| `SetNamedSecurityInfoW` | Write the new DACL back (inheritable to children). |
| `GetAce`, `EqualSid` | Count the container's explicit (non-inherited) entries: a revoke with none to remove writes nothing (no rights needed, idempotent), and a revoke that wrote is read back; an entry still there is reported as an error (code 0x20000001), never as revoked. |
| `ConvertStringSidToSidW` | A `--capability` given as a SID string, and the three well-known network capabilities (internetClient S-1-15-3-1, internetClientServer S-1-15-3-2, privateNetworkClientServer S-1-15-3-3). |
| `DeriveCapabilitySidsFromName` | Any other `--capability` NAME (for example `registryRead`, `lpacCom`): the capability's SID. |
| `CreateToolhelp32Snapshot`, `Thread32First`, `Thread32Next`, `OpenThread`, `GetThreadTimes`, `GetProcessTimes` | The diagnosis of a program that hung (read before the job is ended): CPU time of the process and of each thread, over two samples one second apart. |
| `CreateJobObjectW`, `SetInformationJobObject` | The job: kill on close, memory limit, active-process limit, UI limits. |
| `QueryInformationJobObject` | Count processes still in the job when the program ended. |
| `TerminateJobObject` | The timeout, and stragglers. |
| `CreateFileW` | Open the output files, `NUL` (read-only, or read-write for `--stdin nul-rw`) and an input file as inheritable handles. |
| `InitializeProcThreadAttributeList`, `UpdateProcThreadAttribute`, `DeleteProcThreadAttributeList` | Build the attribute list: security capabilities (the container), all-application-packages policy (LPAC), mitigation policy (Win32k disable), job list (born inside the job), handle list. |
| `CreateProcessW` | Start the child with `EXTENDED_STARTUPINFO_PRESENT`, `CREATE_NO_WINDOW`, an explicit environment, the workspace as the working directory. The only process-creation call. |
| `WaitForSingleObject`, `GetExitCodeProcess` | Wait up to the timeout; read the exit code. |
| `OpenProcessToken`, `GetTokenInformation` | Whether the launcher itself is elevated (reported, never required). |
| `ProcessIdToSessionId` (with `GetCurrentProcessId`) | The session (0 = services session), reported. |
| `CreatePipe`, `SetHandleInformation` | Round 3: an anonymous pipe for the child's standard input (`--stdin pipe`, `pipe-open`) or output (`--stdout-pipe`, `--stderr-pipe`); the end the launcher keeps is made non-inheritable. |
| `ReadFile` | Round 3: a launcher thread copies a child's output pipe into its output file until every write end is closed. |
| `CreateFileW` (again), `_wopen`, `_close`, `_errno` | Round 3b, `open-test` only: open the NUL device with each flag combination git's start-up could use (read/write access, `FILE_SHARE_READ`/`FILE_SHARE_WRITE` with and without `FILE_SHARE_DELETE`, query-only access, `NUL` and `\\.\NUL`, an inheritable handle) and with the C runtime's `_wopen` as git's `mingw_open` does (`O_RDWR`, with and without `O_BINARY`, read-only, write-only); the result of each (system error, or the C runtime's errno) is printed. The three C runtime functions are declared by hand (no new crate). |
| `InitializeAcl`, `AddAccessDeniedAceEx`, `AddAccessAllowedAceEx`, `AddAce`, `GetLengthSid` | Round 4: build a DACL by hand in a fixed order (the `seal` and `modify-root` modes, see "Round 4"): the container's new entries, the old entries that stay (copied as they were, or as explicit ones when the DACL is about to be protected), none of the container's old ones. `SetEntriesInAcl` is still used for the older modes. |
| `ConvertSecurityDescriptorToStringSecurityDescriptorW` | Round 4: print a path's DACL as SDDL (`--dump PATH`, and the `dump` command), so the run shows what the grants really wrote. |
| `GetProcessWindowStation`, `GetThreadDesktop`, `GetUserObjectInformationW`, `OpenWindowStationW`, `OpenDesktopW`, `GetSecurityInfo`, `SetSecurityInfo`, `CreateWindowStationW`, `CreateDesktopW`, `SetProcessWindowStation`, `CloseWindowStation`, `CloseDesktop` | Round 5, experiment build only (`desk.rs`): which window station and desktop the child gets; an entry for the container on the launcher's own objects (removed and read back) or on objects made for the run; the `context` and `desktop-revoke` commands. See "Round 5". |
| `RtlGetVersion`, `GetTokenInformation` (`TokenIntegrityLevel`), `GetSidSubAuthority`, `GetSidSubAuthorityCount` | Round 5, `context` only: the OS build and the integrity level of the launcher itself. |
| `CloseHandle`, `FreeSid`, `LocalFree` | Release what was acquired. |

Capabilities go into the security-capabilities attribute (`SE_GROUP_ENABLED` each, in the order given). A name that cannot be resolved stops the run before anything starts (stage `capability`).

`check` is read-only: it reads the DACL of each `--grant` path and reports `entriesLeft` (explicit entries for the container, 0 when clean, -1 when the DACL cannot be read). Every run and every revoke reports the same `entriesLeft` per grant after its own revoke.

When a run times out, its JSON line carries `hang` (alive or not, processes in the job, CPU of the process and of each thread, how many threads used CPU during one second). It cannot name what a thread waits on; no CPU over a second means waiting.

Attribute numbers used: security capabilities 0x20009, all-application-packages policy 0x2000F (value 1 = opt out, 0 = opt in), mitigation policy 0x20007
(Win32k disable = bit 28), job list 0x2000D, handle list 0x20002.

## Building and checking here

The launcher type-checks for Windows from Linux with `cargo check --target x86_64-pc-windows-gnu` (needs `rustup target add`). It cannot be linked or run
there. CI builds it with `cargo build --release --locked` on `windows-latest`. The launcher has no unit tests of its own: its behaviour is judged by the Windows run.

## Starting Node inside the container

The probe is started as `node --preserve-symlinks --preserve-symlinks-main probe.mjs config.json`. Without these options Node canonicalizes the entry
file's path at start-up by calling `lstat` on every ancestor folder, and a sandbox granted only its own folders is refused on those ancestors (EPERM on the
account's profile folder). That is a community report for a different Windows sandbox (https://github.com/openai/codex/issues/34872), unverified for
AppContainer. The probe imports only `node:` modules, so nothing else changes. Tools the probe starts (`npm`) do NOT get the options: whether they start is
part of the result. When the probe's report is missing, the first lines of the child's error output are kept (`stderrHead`, scrubbed with the rest).

## What only a Windows run shows

See "Windows AppContainer experiment" in `docs/nimblenewt/implementation-plan/implementation-notes.md`: whether git, node and npm start under LPAC with
the grants given, whether each case holds, junction behaviour, Win32k, and what needed administrator rights or a signed-in session.

## Round 2: the smoke ladder and the firewall mini-experiment

Round 1 on a hosted runner (run 45499098682): the launcher built, created the profile and started the child, so the profile, the attribute list, the job and the ACL grants work there. Node never produced a
report: with LPAC it ended in 40 ms with exit 0x80000003 and `WSAStartup: (10107) A system call has failed.`; with a plain AppContainer it did not end within 300 s; with Win32k disabled it ended with 0xC0000142 (DLL
initialisation failed) in every cell, so Win32k lockdown cannot be used with Node. Eight cells also left the deny entry on `.git` (error 0x20000001); round 2 fixes that (see `DeleteAce` above) and reports a read-back per cell.

```
node experiments/windows-appcontainer/run-experiment.mjs --mode ladder   --out out [--variants id,id] [--timeout-ms 45000]
node experiments/windows-appcontainer/run-experiment.mjs --mode firewall --out out [--variants ac-inet-private]
```

**Ladder.** For each variant the harness starts, one launcher run per step (a fresh timeout of 45 s each; after two timeouts the rest of that variant is skipped): `cmd.exe /c echo hi`, `hostname.exe`, `node.exe -e "0"`,
`node.exe --version`, `node -e "require('net')"`, `node -e "process.stdout.write('x')"`, `node -e` writing a file in the workspace, `git.exe --version`. Each is recorded with its exit code (hex), time, the first lines of its output and
error output, and, for a timeout, the hang diagnosis. Variants (`ladderVariants()` in `ladder.mjs`): a plain AppContainer with no capability (round 1's) and its variations (program folders not granted; TEMP and the working directory in the workspace;
no job limits; `node --jitless`; NODE_OPTIONS set; node.exe and git.exe copied into the workspace); plus internetClient; plus internetClient and privateNetworkClientServer; the LPAC (policy attribute optout) with no capability,
with registryRead, with registryRead and lpacCom, with the wide set (registryRead, lpacCom, lpacIdentityServices, lpacPnpNotifications, lpacCryptoServices, lpacAppExperience), the policy attribute with the opt-in value, LPAC with internetClient,
and an LPAC with the tools copied into the workspace. The three network capability SIDs are the documented well-known ones; the named ones are derived with `DeriveCapabilitySidsFromName`. After each variant the launcher reads the container's
entries back from every granted path (`check`); entries found are revoked and read again, and both results are reported. `NODE_OPTIONS` is never inherited; it is set only by the `ac-nocap-nodeopts` variant.

**What the ladder answers.** Which smallest container lets a console program start (cmd, hostname), whether node starts and which step first fails (start-up, `require('net')` for Winsock, stdout, file write), whether git starts, and what the
hang is (CPU in the stuck process, or waiting).

**Firewall.** A capability that allows outbound networking (default variant `ac-inet-private`: internetClient and privateNetworkClientServer) is given, then an outbound BLOCK rule scoped to the container's package SID is added. The exact commands (PowerShell,
administrator, the rule name `nn-appc-block-<8 hex>` and the container's package SID are validated before they are used):

```
New-NetFirewallRule -DisplayName 'nn-appc-block-xxxxxxxx' -Direction Outbound -Action Block -Package 'S-1-15-2-...' -Protocol Any -Profile Any -Enabled True
Get-NetFirewallRule -DisplayName 'nn-appc-block-xxxxxxxx'                (read back: the rule exists / is gone)
Remove-NetFirewallRule -DisplayName 'nn-appc-block-xxxxxxxx'
```

Phases (a client inside the container tries a loopback listener and a listener on the machine's own non-loopback address; the host's listeners count what arrived, so a client's own words are never the evidence): control outside the container without the rule,
inside without the rule, the rule is added and read back, inside with the rule, control outside with the rule, the rule is removed, inside again. Clients: `curl.exe` from System32 and node (when it starts). The verdict is `pass` only when the container reached
the outbound listener before the rule, nothing reached either listener with it, and the control outside the container still reached both. Without administrator rights, or when the capability alone did not allow the connection, it is `inconclusive` and says why.
The rule is removed in a finally path and its absence is read back.

## Round 3: the probe that always ends, git, configurations, junctions, timing

Round 2 (hosted run 45504495155) showed: a plain AppContainer with no capability starts and runs `cmd`, `hostname`, `node -e 0`, `node --version`, `require('net')`, stdout and a file write in the granted workspace, also with `internetClient`; an LPAC with no capability fails (`WSAStartup`), an LPAC with `registryRead` (opt-out or opt-in policy) runs Node; `git.exe --version` fails everywhere (`could not open '/dev/null' for reading and writing: Permission denied`, exit 0x80); the firewall mini-experiment was inconclusive because it ran with NO capability (the command line's default `all` was passed on and the first variant was taken: fixed, and the verdict is now inconclusive when the launcher reports fewer capabilities than the variant names) and because a plain container reaches neither loopback nor the machine's own address even without a rule; round 1's matrix cells were `inc` because the probe's report never arrived.

```
node experiments/windows-appcontainer/run-experiment.mjs --mode cases  --out out [--cells id,id] [--timeout-ms 90000]
node experiments/windows-appcontainer/run-experiment.mjs --mode git    --out out [--variants id,id]
node experiments/windows-appcontainer/run-experiment.mjs --mode links  --out out
node experiments/windows-appcontainer/run-experiment.mjs --mode timing --out out
```

**The probe always finishes (`probe.mjs`).** Every network attempt has a 3 s limit of its own (the socket's idle timeout plus a hard timer, and `destroy` on every path); the tools run with their output in files in the scratch folder (not pipes) and a limit each (node/git 15-20 s, npm 25 s, `npm ci` 40 s) that is cut down to what is left of a 52 s budget (a tool that finds none is `skipped: budget`); a watchdog timer prints the partial report (`partial: true`, with the step it was in) and ends the process after 60 s; the harness's hard limit per cell is 90 s (round 1 spent 300 s). A progress file in the scratch folder gets one line before and one after every step, and the harness keeps its last lines when the report is not complete (`Last probe steps before it stopped`). The launcher's own hang diagnosis (CPU per thread) is kept for a cell the launcher had to end. What the round-1 hang was is not known until the run: the likeliest cause is that the probe started its tools with Node's default pipes (a container may be unable to use them) and each had a limit of two or three minutes, so a few slow tools exceeded the 300 s without any one of them "hanging". `diag-spawn-modes` starts `node -e 0` from inside the container with files, with pipes and with ignored standard handles, each limited to 8 s, to show which of these works.

**Git (`--mode git`).** The cause, from the sources of git for Windows (main): `common-init.c` `init_git()` calls `sanitize_stdfds()` on every start ("Always open file descriptors 0/1/2 ..."); `setup.c` implements it as `xopen("/dev/null", O_RDWR)`; `wrapper.c` `xopen` dies with "could not open '%s' for reading and writing" when that fails; `compat/mingw.c` `mingw_open` replaces the name "/dev/null" with `L"nul"` and calls `_wopen`. So git opens the NUL device for reading AND writing itself, whatever its standard handles are, and round 2's launcher (which gave the child a read-only NUL as standard input) never tested that. The ladder runs `git --version` in these variants (each in a fresh folder; `init`, `add`, `commit` only after `--version` passes): standard input as the launcher's read-only NUL, NUL read-write, a real file, an empty pipe, an open pipe; output as pipes; all three as pipes; `Git\mingw64\bin\git.exe` directly; `MSYS=winsymlinks:nativestrict` and `MSYS2_ARG_CONV_EXCL=*`; none of the `GIT_*` variables; `HOME`, `USERPROFILE` and `GIT_CONFIG_GLOBAL` inside the workspace; `cmd /c git --version`; `git -c core.fsmonitor=false --version`; copies of the two git.exe files in the workspace; and an LPAC (registryRead + lpacCom) with the base, NUL read-write and mingw64 variants. Every variant also runs a node script that opens `NUL` and `\\.\NUL` in modes `r`, `w`, `r+` from inside the container, and the harness reads the NUL device's DACL and mandatory label with a fixed PowerShell script (`NUL_ACL_SCRIPT`: `CreateFileW` for READ_CONTROL, `GetSecurityInfo`, `ConvertSecurityDescriptorToStringSecurityDescriptorW`) and reports whether ALL APPLICATION PACKAGES (S-1-15-2-1) and ALL RESTRICTED APPLICATION PACKAGES (S-1-15-2-2, what an LPAC keeps) are on it. Granting the container rights on the device is NOT tried (it is a system object; see the notes).

**Configurations (`--mode cases`).** The ten cases, the extra probes, the diagnostics and the tools run in: `ac-nocap`; `ac-nocap-noprotect` (the same without the deny entry on `.git`: the contrast that shows what the protection stops); `ac-inet-private` (internetClient + privateNetworkClientServer); `ac-inet-private-fwblock` (with an outbound BLOCK rule scoped to the package SID); `ac-inet-private-loopback` (with a loopback exemption: `CheckNetIsolation.exe LoopbackExempt -a -p=<package SID>`); `ac-inet-private-loopback-fwblock` (exemption and rule); `lpac-optout-reg`; `lpac-optout-reg-com`. A rule or exemption is read back before the cell starts (a cell whose network conditions are not confirmed is NOT run: `stage: network-setup`) and removed and read back in a finally path. The result has the per-cell table, a table with one row per case and one column per configuration, and a table of the time each probe step took. New probes: `extra-junction-self-made` (the container makes junctions in the workspace to the controller's folder, an outside folder and the protected `.git` folder, then reads and writes through them), `extra-hardlink-read`, and, run last because they change the workspace's structure and each success is undone at once: `extra-protect-rename-dir`, `extra-protect-delete-dir`, `extra-protect-replace-junction` (move the folder away, plant a junction under its name), `extra-protect-rename-parent` (rename the workspace folder itself). The `.git` deny entry covers writes, delete and delete-child on the folder; a rename or replace of the folder needs DELETE on it or FILE_DELETE_CHILD on its parent, and the harness's witness (is the folder still there, still a folder, config unchanged) decides, not the container's report.

**Junctions (`--mode links`).** The launcher's new `grant` command applies the three container grants and leaves them; `check` then reports, for each path, the container's explicit and inherited entries (a file and a folder inside the workspace are controls: the grant must have propagated there), for the targets of the four link fixtures, the outside and credentials folders and the fixture root; `revoke` removes them and the read-back repeats. Whether the container follows a junction to a protected folder is measured by the probe (`deny-symlink-read`, `deny-symlink-write`, `extra-junction-self-made`).

**Timing (`--mode timing`).** Five launcher calls around `cmd /c exit 0` (wall time of the call against the time the child ran, and the same program started directly), three `node -e 0`, writing 100 files, `git init` + `add -A` + `commit` of those 100 files (inside only where `git --version` works there; the same commands are timed outside as the baseline), and an offline `npm ci` of 40 local packages (inside and outside), in `ac-nocap` and `lpac-optout-reg-com`.

The launcher's new options: `--stdin nul|nul-rw|file:PATH|pipe|pipe-open` (`nul` is the read-only NUL of rounds 1 and 2), `--stdout-pipe` and `--stderr-pipe` (an anonymous pipe copied into the `--stdout`/`--stderr` file by a launcher thread), the `grant` command, and `inheritedEntries` next to `entriesLeft` in every per-grant read-back. The Cargo features `Win32_System_Pipes` and `Win32_System_IO` were added (the dependency and its lock file are unchanged).

## Round 3b: results that survive a hang, npm, git and the NUL device, the firewall's assumptions

Round 3 (hosted run 45510001368): the cases mode gave no verdicts. All eight configurations ended `timed out` and every case was `inc`: the probe had run through every step up to `end diag-nul-open`
and hung at `start diag-spawn-modes` (a synchronous `spawnSync` of `node -e 0` from inside the container); a blocked main thread stops every timer, so the watchdog never fired, and the report is printed
only at the very end, so the verdicts already computed were lost. Round 3b changes only what is needed to answer that and the open questions below.

```
node experiments/windows-appcontainer/run-experiment.mjs --mode npm      --out out [--variants id,id]
node experiments/windows-appcontainer/run-experiment.mjs --mode git      --out out      (now also: open-test, all-NUL variants)
node experiments/windows-appcontainer/run-experiment.mjs --mode firewall --out out      (now also: the loopback exemption by name, the three assumptions)
```

**Results survive a hang.** The probe appends, to its progress file and the moment it has it, one line per step result (`<ms> ms RESULT {json}`, the same object the final report carries, with the
step's start-up denial lines) and one line per attempt of a step that starts programs (`ATTEMPT {json}`). When the final report is missing or partial, the harness rebuilds the report from those lines
(`rebuildFromProgress` in `probe.mjs`, `chooseProbeReport` in `lib.mjs`): the cell is then labelled `partial: rebuilt from progress` (in the table's `started` column and in the cell's notes), the steps
that finished keep their verdicts, the step that was running and the steps never reached are `inc` (a diagnostic is shown as information with its attempts so far plus `step did not finish: HUNG`).
A late hang therefore loses nothing that was already known.

**Nothing starts a program synchronously any more.** `diag-spawn-modes` moved to the very end; each of its three modes (output to files, pipes, ignored) is an asynchronous `spawn` with a 5 s kill timer
(`spawnLimited`), and its result line is written before the next mode starts. The tools (`node --version`, `git`, `npm`) use the same asynchronous call with their own limit. The four protected-name
operations (rename, delete, replace by a junction, rename the parent) now run BEFORE the tools: the tools start programs from inside the container, which is what hung, and those four verdicts matter most.

**A watchdog that works while the main thread is blocked.** A worker thread (`startWorkerWatchdog`, source passed as text so the container needs only `probe.mjs`) has its own event loop. At the
probe's watchdog time plus 2 s it appends `WATCHDOG <step>` to the progress file, writes the rebuilt partial report to standard output with a direct `writeSync` (the main thread's stream would be
stuck), and ends the whole process by killing its own process id (`process.exit` inside a worker would only end the worker). If a worker cannot run under the container, the harness's own 90 s limit on the
launcher call is the backstop, and the same rebuild applies. Whether a worker thread starts inside an AppContainer is itself something this run shows (the progress file then carries a `WATCHDOG` line).

**npm (`--mode npm`, `npm.mjs`).** Round 3: `node npm-cli.js ci --offline` ends at once in both containers with `EPERM: operation not permitted, lstat 'C:\'` raised at node:fs line 2744, which is the JavaScript
`realpathSync` (it lstats every prefix of a path from the drive root). The `lstat-repro` step runs that call alone (every prefix of npm's script path, the working directory and node.exe, then the JavaScript and the
native realpath, and stat/access/readdir of the drive root) so the refused prefix is named. Then each variant changes one thing and runs `npm ci --offline --ignore-scripts` of 40 local packages:
NODE_OPTIONS or command-line `--preserve-symlinks --preserve-symlinks-main`; `npm.cmd` through `cmd /c` (with and without the options); npm cache, prefix, logs, user and global configuration, HOME, USERPROFILE,
APPDATA and LOCALAPPDATA all in the granted home folder; the project inside the granted workspace; a `--require` preload that swaps `fs.realpathSync` for the native one; combinations; and the combinations in the
LPAC container. A variant passes only when the exit code is 0 and the harness (outside the container) finds every package on disk.

**Git (`--mode git`).** New launcher flags `--stdout-nul-rw` and `--stderr-nul-rw` make the standard output and error the NUL device opened by the launcher for reading and writing (with the existing
`--stdin nul-rw` and inheritable handles): variants `all-nul-rw` and `lpac-all-nul-rw` (nothing is captured, so only the exit code counts). The launcher's new `open-test` command is run AS THE CHILD inside the
container (a copy in the granted workspace, for `base` and `lpac-base`) and prints, for each flag combination git's start-up could use, whether `CreateFileW` or `_wopen` on `NUL` worked and with which error: the table in
`git.md` then names the combination the container refuses. Whether git has to run in the container at all is argued in the implementation notes (the product keeps `.git` outside the sandbox).

**Firewall.** The report now judges its three assumptions one by one and says which fails: (1) the capabilities `internetClient` and `privateNetworkClientServer` open the network for the container; (2) a block rule scoped to
the package SID stops that connection; (3) the rule affects only that container. With `--mode firewall` one more phase runs before the rule: `CheckNetIsolation LoopbackExempt -a -n=<profile name>` (the package family name of
a profile made with `CreateAppContainerProfile` is its name), read back by the package SID from `LoopbackExempt -s`, the same clients, then removed (also in the finally path). The cases mode has the cell
`ac-inet-private-loopback-byname` for the same exemption. A control from a Low-integrity process was NOT built: starting a process with a modified token needs `CreateProcessAsUser` or `CreateProcessWithTokenW`, which the
launcher's source test forbids on purpose (one process-creation call, always with the container attributes); the harness's own connect from outside any container remains the control.

## Round 4: the protected-name layouts and child programs

Round 3b (hosted run 45517848440) gave the first verdicts: every case held except `deny-write-protected-name` (and the four `extra-protect-*` operations), which FAILED in all nine cells, also in the cells with the deny entry on `.git`
(and the contrast cell without it was identical, so the deny entry did nothing); and every `tool-*` probe failed with `spawn error EPERM`. Round 4 is about those two things only.

```
node experiments/windows-appcontainer/run-experiment.mjs --mode spawn --out out [--variants id,id] [--timeout-ms 15000]
node experiments/windows-appcontainer/run-experiment.mjs --mode cases --out out [--cells id,id]      (fifteen cells: the six new ones are at the end)
```

**Protected names (A).** What the launcher can write, by mode (the `--grant MODE:PATH` forms):
* `deny-write` (rounds 1-3b): a DENY entry (write, append, attributes, delete, delete-child) for the container, inheritable, merged by `SetEntriesInAcl` into the folder's DACL. Did nothing in 3b.
* `deny-strong`: the same entry with every right except read and execute (adds change-DACL and take-ownership), same merge.
* `seal`: the DACL is built by hand and PROTECTED (it inherits nothing from the workspace, so the workspace grant's write rights never reach it): one inheritable DENY entry (everything but read and execute) first, then the other accounts' entries
  (copied as explicit ones), then one inheritable ALLOW entry (read and execute). The protection does not rely on a deny entry being honoured: the container simply holds no write, delete or delete-child right on the folder or anything in it.
  A revoke removes the container's entries and lets the folder inherit again.
* `modify-root` (on the workspace folder itself): one entry for the folder alone (modify WITHOUT delete) and one inherit-only entry for everything inside (modify). The container can then change everything in the workspace but cannot delete, rename or move the workspace folder itself
  (a rename needs DELETE on the folder or delete-child on its parent, which the container never had on the parent).
Windows allows a delete or rename when the object's own DELETE right OR the parent's delete-child right is held, so protecting a folder from rename and delete needs both: no DELETE on the folder (seal) and no delete-child on its parent (`modify` never granted it).
The cells: `ac-nocap` (deny-write, as before), `ac-nocap-deny-strong`, `ac-nocap-sealed`, `ac-nocap-sealed-root` (seal + modify-root), `ac-nocap-sealed-root-nolimits` (the same with no job limits), `ac-inet-private-sealed-root` and `lpac-optout-reg-com-sealed-root`.
Every cell's launcher call now takes `--dump` for the workspace, `.git` and `.git\config`: the DACL (SDDL text, the container's SID named `<container>`) is recorded after the grants were applied and again after the program ended, so the next run shows whether the entry was written and in which order, and whether anything changed it.
The probe's protected-name case also tries to rename the config file (undone at once).

**Child programs (B).** The probe now sets `NODE_OPTIONS=--preserve-symlinks --preserve-symlinks-main` for the programs it starts (the harness's child environment carries it, as the product's launcher would). Its tools take their standard input from an
empty FILE and write to files, and every start is made from a worker thread with a limit of its own (`spawnIsolated`): a process creation that never returns costs that step 5.5 s as a `HUNG` result and does not stop the probe, the diagnostic or the other tools. After a hung start the remaining tools are skipped (`spawn-hung`).
`diag-spawn-modes` has four modes (files with a stdin file, inherit, pipes, ignore), each at most 5.5 s, and runs before the tools. If a worker is stuck the probe ends the process with a kill after writing its report (a stuck thread cannot be joined).
`--mode spawn` (`round4.mjs`) is the ladder: each step is a launcher run of its own (15 s) in which a node script starts ONE grandchild (async `child_process.spawn`) and writes progress lines before the call, right after it returns and at the end; a marker file written by a node grandchild says whether it ever ran.
Dimensions: stdio (pipe, inherit, files = stdin from a file plus output files, ignore), job limits (all, none, and each of UI, active-process and memory alone), program (node.exe copied into the workspace, node.exe in the granted install folder, cmd.exe, hostname.exe),
libuv's `detached` and `windowsHide`, the container (plain and LPAC), plus native steps (cmd.exe starts node or hostname with the system's own process creation, no libuv) and a named-pipe diagnostic. Outcomes: works, EPERM or another code, hang-in-spawn, hang-child, ran-no-marker, exit-N, no-result.
The suspects: libuv opens the NUL device for "ignore" and for a missing standard input (the container cannot open NUL: error 5), libuv creates named pipes for "pipe", and libuv assigns every non-detached child to a job of its own (nested inside the launcher's job).

## Round 5: the session 0 diagnostic (the service context)

Own-hardware run 45634597880 (the owner's Windows PC, build 26200, runner as a SERVICE: session id 0, elevated) gave the first service-context measurement. The hash check passed, the product launcher's `info` worked (the container profile is made), but every program
started inside the container ended at once with `-1073741502` (0xC0000142, STATUS_DLL_INIT_FAILED): all fifteen cases inconclusive, all child-program steps `no-result`, and cmd.exe (which did start: it printed "Access is denied." when asked to run hostname.exe) returned the same code for node.
The same launchers pass ten cases on the hosted runner (interactive session 2, build 26100). Round 5 does not guess: it varies one thing at a time. Nothing here is a fix; the product launcher is not changed by this round.

```
node experiments/windows-appcontainer/run-experiment.mjs --mode session0 --out out [--steps id,id] [--timeout-ms 15000]
```

Seventy-eight steps (`session0Steps()` in `round5.mjs`), each one launcher run with a 15 s limit, an `ATTEMPT` line before and a `RESULT` line after it (console and `session0.progress`), and `session0.partial.json` rewritten after every step, so a hang or a kill keeps everything before it:
* **A. the program** (desktop `inherit`, creation `no-window`): cmd.exe, hostname.exe, whoami.exe, a GUI-subsystem program (wscript.exe, `WScript.Quit(0)`), powershell.exe, node.exe in its install folder, a COPY of node.exe and of cmd.exe in the granted workspace (separates "the ACL of the program's folder" from "which program"),
  cmd.exe running node and running hostname.
* **B. the window station and desktop** (the launcher's new `--desktop` option, experiment build only), with node, cmd-runs-node, powershell, wscript, hostname and the node copy: `inherit` (lpDesktop NULL, the product), `empty` (an empty string), `winsta0` (`WinSta0\Default`), `grant-read` / `grant-full` (one explicit allow entry for the container on the launcher's
  own window station and desktop; read = the documented GENERIC_READ mapping of a non-interactive window station and desktop, full = every WINSTA_/DESKTOP_ right), `grant-station` / `grant-desktop` (only one of the two), `new-desktop` (a desktop made for the run in the current station, station entry too), `new-station` (a window station and desktop made for the run, both with an entry for the container).
* **C. the creation flag** (`--creation`, experiment build only): `no-window` (CREATE_NO_WINDOW, the product), `detached` (DETACHED_PROCESS), `none`, `new-console` (CREATE_NEW_CONSOLE), each with node, cmd-runs-node and hostname, with the baseline desktop and with `grant-full`.
* **D. the folder entry**: node.exe with no grant on its install folder, with the baseline desktop and with `grant-full`.
* **Context** (read by the launcher itself, outside the container, `context` command): window station and desktop names, whether the station is the visible interactive one, both DACLs as SDDL, session, integrity level, elevation, OS version from `RtlGetVersion`; the import tables of node, cmd, hostname, whoami, wscript and powershell (which load user32?); security products and the Smart App Control state
  (read-only PowerShell); code-integrity and AppLocker events since the start (read-only).

What is changed and how it is undone: a `grant-*` run adds ONE explicit entry for the container's SID to the DACL of the launcher's current window station and/or desktop (opened by name with READ_CONTROL and WRITE_DAC), removes it again on every path out (Drop) and reads the DACL back; the count left is in the launcher's JSON (`desktop.objects[].entriesLeft`) and the harness runs `desktop-revoke` at the
start and at the end and reports the counts. These objects belong to the runner's logon session (a `Service-0x0-<logon id>$` station is shared by every non-interactive service process of the same logon session, for example all LocalSystem services for `Service-0x0-3e7$`): a launcher killed between grant and revoke leaves an entry for the experiment container's SID (it names no real account and takes no one's access away) until that session ends or `desktop-revoke` runs. The made desktops and window stations are closed when the run ends (an object with no handle is destroyed). Nothing touches the registry, a service or any persistent setting (the facts script only reads one registry value).

Safeguards added by the review: the launcher adds an entry only when its window station is non-interactive (not `WinSta0`, `WSF_VISIBLE` clear, flags readable), so the `grant-*` and `new-desktop` steps report `desktop-setup-failed` on an interactive runner such as the hosted one, and the signed-in session's objects are never changed; only the SID of one AppContainer profile (`S-1-15-2-` and seven sub-authorities) gets or loses an entry; a NULL DACL is refused (merging into it would leave only the container's entry); the DACL is copied before the grant and compared entry by entry after the revoke (`matchesOriginal`; `orderDiffers` when only the order changed); the copy is never written back, a difference is reported only. Second review: the entry is no longer merged with `SetEntriesInAclW` (which rebuilds the list and may merge or re-sort entries, so a `desktop-revoke` after a killed launcher could not restore the order); the launcher inserts one allow entry by hand where `SetEntriesInAclW` documents it puts one (before the first existing allow entry), keeps every other entry byte for byte and in order, refuses when an explicit entry for the SID is already there, checks the result with `IsValidAcl` and writes it once (`SetSecurityInfo`, DACL_SECURITY_INFORMATION alone); the removal takes out only explicit entries for exactly that SID, so whoever removes the entry gets back the same list. The harness runs `desktop-revoke` straight after any step that wrote a DACL and did not report everything reverted (a killed launcher); it starts no step that could end, with that revoke, after 15 minutes, so its whole clean-up (10 minutes at its own limits) fits before the workflow step's 25-minute limit; the own-runner job's clean-up step runs `desktop-revoke` once more. `desktop-revoke` derives the SID from the name (no profile is made), writes nothing when there is nothing to remove, and on an interactive or unreadable window station only counts the entries (the same rule as the grant). Event texts and security product names in the report are bounded and lose the folder name under any user profile.

Every Win32 call added for this round (all in `desk.rs`, experiment build only; the product build does not contain the file): `GetProcessWindowStation` and `GetThreadDesktop` (the launcher's current objects), `GetUserObjectInformationW` (their names and flags), `OpenWindowStationW` and `OpenDesktopW` (open them by name for READ_CONTROL and WRITE_DAC),
`GetSecurityInfo` and `SetSecurityInfo` (read and write the DACL of a window object, object type SE_WINDOW_OBJECT), `IsValidSid`, `GetLengthSid` and `IsValidAcl` (the SID's bytes and the check of the rebuilt DACL before it is written), `CreateWindowStationW` and `CreateDesktopW` (the objects made for the run), `SetProcessWindowStation` (switched to the new station for the one `CreateDesktopW` call, then back),
`CloseWindowStation` and `CloseDesktop`, `RtlGetVersion` (the OS build, read in `context`), and `GetTokenInformation` with `TokenIntegrityLevel` plus `GetSidSubAuthority` (the integrity RID). In `win.rs`: `STARTUPINFO.lpDesktop` (set only in the experiment build) and the creation flag (`DETACHED_PROCESS`, `CREATE_NEW_CONSOLE` or none instead of `CREATE_NO_WINDOW`).

What the outcomes would mean (also printed in every report): see the notes, "Windows AppContainer experiment, round 5", and `docs/nimblenewt/windows-isolation-plan.md`. In short: H1 (most likely) the container's SID has no access to the service's non-interactive window station and desktop (user32 cannot initialise); H2 the attachment (lpDesktop) matters beyond the access;
H3 the console flag; H4 the access control of the program's folder; H5 security software or code integrity; H6 something specific to this Windows build.

Checked on Linux only: the harness logic, arguments, the report writer, the PE import reader and the interpretation with a fake launcher (`scripts/windows-appcontainer-experiment.test.mjs`); the launcher type-checks for `x86_64-pc-windows-gnu` (`cargo check --target x86_64-pc-windows-gnu --locked --offline`). It was NOT run: what the entries and made objects do to a real child is exactly what the Windows run measures.

## The home case: one account, not elevated (written 2026-11-25; nothing here has run on Windows yet)

**Why.** Most home PCs have ONE user account, usually an administrator running with UAC, so the worker must work for the signed-in user in the normal desktop session: not elevated (medium integrity), no second account, no service, no password. The owner's own measurement (build 26200, PowerShell 5.1) showed that the PRODUCT launcher, run that way, makes and deletes a per-run profile (profile gone: true) but cannot make the named private window station (error 5: only Administrators may name a window station), so it fails closed. Everything measured before this was elevated. This round measures, for a non-elevated user, the alternatives to a private window station. The reasoning, the ranking and what is documented versus measured are in `docs/nimblenewt/windows-isolation-plan.md` section 12.5; the product launcher is NOT changed by this round (a product change waits for the owner's measurement).

**What the tool does** (experiment build only: `native/nn-launcher/src/home.rs`, rules in `homerules.rs`; the options `--desktop home-desktop|home-desktop-station-read|home-desktop-station-full`, `--steps`, `--force-station-entry`; the commands `home-probe`, `ui-test`, `home-revoke`, `deelevate`). `home-probe` prints ONE JSON line per step, an `ATTEMPT` line on standard error before each, and a `summary` line:

| Step | What it does | Changes anything? |
| --- | --- | --- |
| `context` | elevated, elevation type, whether the Administrators group is `enabled` or `deny-only`, integrity level, session, OS build, the launcher's window station (name and flags) and desktop | no |
| `station-access` | for WinSta0 and the user's desktop: the access list with redacted SIDs and right names; what ALL APPLICATION PACKAGES (S-1-15-2-1) holds; the owner; whether an OPEN with WRITE_DAC is granted to this token (only an open: nothing is written); whether an open with WINSTA_CREATEDESKTOP is granted | no |
| `profile` | a throw-away per-run profile (the product's own name form and record file): made, deleted, shown gone | a profile that is deleted again |
| `inherit-*` | programs in the container with `lpDesktop` NULL: the user's own desktop (what a normal AppContainer launch does) | no |
| `desktop-*` | the same programs on a private DESKTOP made on the launcher's own window station (WinSta0) with its final access list (the launcher's account, SYSTEM, the container) and NO entry written to the station | a desktop that is closed again |
| `station-read-*`, `station-full-*` | the same, after ONE temporary allow entry for the container on WinSta0 (read level 0x20103, or the full level 0x2037F measured for the private station) | the entry, removed in the same step, read back |

Per group the programs are `ui-test` (this very executable, copied into the work folder: it loads user32, so it shows the 0xC0000142 failure, and reports what a confined program sees: windows seen and visible, whether a foreground window exists, whether the cursor position is readable, whether the clipboard can be OPENED (never read), whether a clipboard sequence number is readable, whether one screen pixel is readable (the value is not printed), how many keys are down (a count), whether a low-level keyboard hook can be installed (it is removed at once and no message loop runs, so its procedure never runs; a key pressed in that instant waits at most the system's LowLevelHooksTimeout before Windows passes it on, as Microsoft documents for a hook that does not answer), whether a global atom can be added), `cmd.exe /c echo`, `hostname.exe`, and `node.exe` when it is on PATH; each without and with the job's UI limits (`-limits`: all eight `JOB_OBJECT_UILIMIT_*` flags, as the product sets them). `works` is true when the launcher's line is `ok`, the program exited 0 and did not time out. The verdict of a group rests on `ui-test` and `node` without limits (the programs that load user32; cmd and hostname are console programs). The container is the product's LPAC with `registryRead` and `lpacCom` when `--aap-policy optout` is given, a plain AppContainer when `--aap-policy none` is given (run both: a LPAC does not carry ALL APPLICATION PACKAGES, a plain container does). One grant only (the work folder, modify) plus a soft read grant on node's folder; a 1024 MB and 16-process job limit; 30 s per step at most. The work folder is always a NEW folder `nn-home-<8 hex>` made inside `--cwd` (or the temp folder when `--cwd` is not given); only that new folder is removed at the end, never the folder `--cwd` names.

**When the station entry is written.** The `station-read-*` group runs only when the `desktop-*` group FAILED (the entry is then "required to test"), the `station-full-*` group only when the read group failed; `--force-station-entry` runs both anyway; naming steps with `--steps` runs exactly those. Each skipped step prints why. An entry is written only to a window station named WinSta0 whose WSF_VISIBLE flag is set, only for the SID of one throw-away profile, and only after the DACL was copied; the entry is taken out again in the same step (a Drop guard covers a panic), read back and compared with the copy, and the result is in the line (`desktop.objects[].entriesLeft`, `allReverted`). **Residual risk:** a launcher KILLED (Ctrl+C, closing the window) between the write and the removal leaves one allow entry on WinSta0 for the throw-away container SID (it names no account and takes no one's access away) until sign-out (a restart or power cut ends the session, and WinSta0 with it). It ALSO leaves that step's per-run profile (the profile is deleted only at the end of each run, so a launcher killed during ANY run step leaves one) and the work folder in the temp folder with the profile's record. The private desktop itself is not left (Windows closes the launcher's handles when it ends) and the confined program is ended by the job (kill on close). Before the entry is written the `ATTEMPT` line on standard error prints the profile name, the container SID and the two clean-up commands, each with the record file this launcher wrote as its proof (the same proof `delete-profile` needs; without the record nothing is written): `home-revoke --name NimbleNewtRun-<16 hex> --profile-record <work folder>\rec\<name>.sid` removes the explicit entries for that SID from WinSta0 and reads back (`entriesLeft` must be 0), and `delete-profile --name ... --sid ... --profile-record ...` deletes the profile and checks it is gone. When a run ends normally but the entry could not be removed, the summary line says so (`stationEntryLeftBehind`) and the work folder is KEPT (`workFolderKept`) so the record is still there. NOT measured: whether a non-elevated user's `home-revoke` can write WinSta0's list at all (the `station-access` step reads whether an open with WRITE_DAC is granted; if it is not, no entry is ever written either, because the same open is needed to add it). Do not press Ctrl+C while a `station-*` step runs.

**What it never does.** It opens no window (a GUI program hangs in every mode: only console programs are used). It sends no input and no window message. It does not read the clipboard, the screen, window titles or key identities. It changes no registry value, service, task, firewall rule or machine setting. It does not write a password anywhere and creates no account.

### The exact commands for the owner (a NORMAL PowerShell, not "Run as administrator")

Get `nn-appc-launcher.exe` from the hosted run of this commit (artifact `windows-appcontainer-launchers`, with its `SHA256SUMS`; check the hash with `Get-FileHash -Algorithm SHA256 .\nn-appc-launcher.exe` against the line in `SHA256SUMS`). In PowerShell 5.1 `>` writes UTF-16, so write the file with `Out-File -Encoding utf8` (standard error, the `ATTEMPT` lines, stays on the screen):

```
cd <the folder holding nn-appc-launcher.exe>

# 1. read-only first: who am I, what may this token do to WinSta0, can a profile be made and deleted (no station is written)
.\nn-appc-launcher.exe home-probe --steps context,station-access,profile | Out-File -Encoding utf8 home-readonly.jsonl
Get-Content .\home-readonly.jsonl

# 2. the whole probe in the product's LPAC form, then as a plain AppContainer (usually a minute or two; at most about 10 minutes each,
#    because every one of up to 28 program steps stops at its 20 s timeout; no window opens)
.\nn-appc-launcher.exe home-probe --aap-policy optout --timeout-ms 20000 | Out-File -Encoding utf8 home-lpac.jsonl
.\nn-appc-launcher.exe home-probe --aap-policy none   --timeout-ms 20000 | Out-File -Encoding utf8 home-plain.jsonl

# 3. a readable summary (needs Node, which the project needs anyway), then send the three .jsonl files back
node <repo>\experiments\windows-appcontainer\home.mjs summarize home-lpac.jsonl --label lpac
node <repo>\experiments\windows-appcontainer\home.mjs summarize home-plain.jsonl --label plain

# only if a run was killed: copy the two commands the last ATTEMPT line printed (name, SID and record path filled in), for example
.\nn-appc-launcher.exe home-revoke --name NimbleNewtRun-<16 hex from the ATTEMPT line> --profile-record <the record path it printed>
.\nn-appc-launcher.exe delete-profile --name NimbleNewtRun-<16 hex> --sid <the SID it printed> --profile-record <the record path it printed>
```

Check first that the `context` line says `"elevated":false`, `"integrity":"medium"` and (on an administrator account) `"adminGroup":"deny-only"`; if it says `elevated:true` the window was elevated and the run does not answer the question. The lines hold no password, token, file content or window text; SIDs of accounts are replaced (`S-1-5-21-<machine>-<RID>`, `S-1-5-5-<logon session>`), the throw-away container's own SID and the well-known ones are printed.

### The hosted run (what it will show, and what it cannot)

The hosted job has a step "Home case: one account, not elevated" (a report, not a gate): the same `home-probe` (a) as the runner is (an elevated administrator), (b) as a DE-ELEVATED child (`deelevate home-probe ...`), (c) the same de-elevated as a plain AppContainer, and a cross-check: the PRODUCT launcher's `info` run de-elevated (`deelevate --exe nn-launcher.exe info ...`), which should reproduce the owner's measurement (`windowStationOk:false`, error 5). `deelevate` builds the child's token with `CreateRestrictedToken` (DISABLE_MAX_PRIVILEGE, the Administrators and operator groups deny-only) and sets its integrity to medium, then `CreateProcessAsUserW` (documented: no extra privilege is needed for a restricted version of the caller's own primary token). That is what access checks see in a UAC-filtered token; it is NOT the same token (UAC's linked filtered token is not used), and whether the hosted image has UAC split tokens at all is read from the `context` line (`elevationType`). It was chosen over `runas /trustlevel` (it goes through the Secondary Logon service and the Safer levels, and what an elevated token with UAC off becomes there could not be confirmed offline) and over a scheduled task with RunLevel LeastPrivilege (UNVERIFIED: on a runner without a UAC split token the task may get no lesser token and silently stay elevated); the restricted token is one the launcher builds itself, so what it got is READ from the child's own `context` line (`adminGroup`, `integrity`) instead of assumed. The job's summary shows, per run, the facts, the per-group verdict and the strongest option that worked. It will NOT show: anything about the owner's machine or build, a real UAC-filtered token, a signed-in desktop with a real user's windows (the hosted desktop is nearly empty, so `windowsSeen` there says little about what is exposed on a busy desktop), or the behaviour of the clipboard, keyboard and screen with real content. If the cross-check does not reproduce error 5, the de-elevated runs do not behave like the owner's token and say nothing about it.

Every Win32 call added by this round (all in `home.rs` and `desk.rs`, experiment build only): `OpenProcessToken`, `GetTokenInformation` (`TokenGroups`, `TokenUser`, `TokenElevationType`), `CreateRestrictedToken` and `SetTokenInformation` (`TokenIntegrityLevel`) and `CreateProcessAsUserW` (the de-elevated child), `GetSecurityInfo` (the owner and the access list of WinSta0), `OpenWindowStationW` and `OpenDesktopW` (opens only), `CreateDesktopW` (the home desktop, with its final access list), `EnumWindows`, `IsWindowVisible`, `GetForegroundWindow`, `GetCursorPos`, `OpenClipboard`, `CloseClipboard`, `GetClipboardSequenceNumber`, `GetDC`, `GetPixel`, `ReleaseDC`, `GetAsyncKeyState`, `SetWindowsHookExW`, `CallNextHookEx` and `UnhookWindowsHookEx`, `GetModuleHandleW`, `GlobalAddAtomW` and `GlobalDeleteAtom` (the child-side `ui-test`).

Checked on Linux only: the plan of the steps, the selection, the rule for when a station entry is written, the access-list summary and redaction, the argument parsing, the quoting, the summary program `home.mjs`, and the source and document claims (`scripts/windows-appcontainer-experiment.test.mjs`, `cargo test --features experiment`); the launcher type-checks for `x86_64-pc-windows-gnu`. NOT run: every Win32 call above.
