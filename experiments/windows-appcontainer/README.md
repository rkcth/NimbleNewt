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
| `launcher/` | A small Rust program (`nn-appc-launcher`, one dependency: `windows-sys`) that creates or reuses the container profile, grants and later revokes ACL entries, starts one program in the container and the job, and prints one JSON line. |
| `probe.mjs` | The script that runs **inside** the container (Node's own modules only). It attempts the ten containment cases and the tool and network checks. |
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

```
nn-appc-launcher run --exe PATH --cmdline "TEXT" --cwd PATH --stdout FILE --stderr FILE
    [--name PROFILE] [--grant MODE:PATH]... [--grant-soft MODE:PATH]... [--env NAME=VALUE]...
    [--aap-policy none|optout|optin] [--win32k-off] [--no-kill-on-close]
    [--memory-mb N] [--active-processes N] [--ui-limits] [--timeout-ms N]
nn-appc-launcher info | revoke --grant MODE:PATH... | delete-profile      (all take --name)
```

Modes: `ro`, `rx`, `modify`, `deny-write`. A `--grant` that fails stops the run before anything starts; a `--grant-soft` (program install
folders, which may need rights the account does not have) is recorded and the run goes on. The child gets **only** the `--env` values (nothing is
inherited), its standard input from `NUL`, and its standard output and error written straight to the two files (the launcher does not copy
them after the fact, and has no cap on their size; the job's memory limit does not bound disk output). All grants are revoked
on every path out (a drop guard also covers a panic); `revoke` repeats it for a launcher that died. Exit code: the child's, 124 when the
timeout killed the job, 125 when the launcher itself failed; the JSON line is authoritative (`ok`, `childStarted`, `stage`, `error`).

It fails closed: no container, no run. There is no other process-creation call in the source and the unit tests check that.

### Every Win32 call, and why

| Call | Why |
| --- | --- |
| `CreateAppContainerProfile` | Create the container profile with the fixed name and no capabilities (so no network). |
| `DeriveAppContainerSidFromAppContainerName` | The profile already exists (an earlier run): get its SID. |
| `DeleteAppContainerProfile` | `delete-profile`, at the end of the harness. |
| `ConvertSidToStringSidW` | Print the container SID in the JSON line. |
| `GetNamedSecurityInfoW` | Read a folder's current DACL before changing it. |
| `SetEntriesInAclW` | Merge one explicit entry (grant, deny, or revoke) for the container SID into that DACL. |
| `SetNamedSecurityInfoW` | Write the new DACL back (inheritable to children). |
| `CreateJobObjectW`, `SetInformationJobObject` | The job: kill on close, memory limit, active-process limit, UI limits. |
| `QueryInformationJobObject` | Count processes still in the job when the program ended. |
| `TerminateJobObject` | The timeout, and stragglers. |
| `CreateFileW` | Open the output files and `NUL` as inheritable handles. |
| `InitializeProcThreadAttributeList`, `UpdateProcThreadAttribute`, `DeleteProcThreadAttributeList` | Build the attribute list: security capabilities (the container), all-application-packages policy (LPAC), mitigation policy (Win32k disable), job list (born inside the job), handle list. |
| `CreateProcessW` | Start the child with `EXTENDED_STARTUPINFO_PRESENT`, `CREATE_NO_WINDOW`, an explicit environment, the workspace as the working directory. The only process-creation call. |
| `WaitForSingleObject`, `GetExitCodeProcess` | Wait up to the timeout; read the exit code. |
| `OpenProcessToken`, `GetTokenInformation` | Whether the launcher itself is elevated (reported, never required). |
| `ProcessIdToSessionId` (with `GetCurrentProcessId`) | The session (0 = services session), reported. |
| `CloseHandle`, `FreeSid`, `LocalFree` | Release what was acquired. |

Attribute numbers used: security capabilities 0x20009, all-application-packages policy 0x2000F (value 1 = opt out, 0 = opt in), mitigation policy 0x20007
(Win32k disable = bit 28), job list 0x2000D, handle list 0x20002.

## Building and checking here

The launcher type-checks for Windows from Linux with `cargo check --target x86_64-pc-windows-gnu` (needs `rustup target add`). It cannot be linked or run
there. CI builds it with `cargo build --release --locked` on `windows-latest`. The launcher has no unit tests of its own: its behaviour is judged by the Windows run.

## What only a Windows run shows

See "Windows AppContainer experiment" in `docs/nimblenewt/implementation-plan/implementation-notes.md`: whether git, node and npm start under LPAC with
the grants given, whether each case holds, junction behaviour, Win32k, and what needed administrator rights or a signed-in session.
