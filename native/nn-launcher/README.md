# nn-launcher: the native Windows launcher

Starts ONE program inside a low-privilege AppContainer and a Job Object, makes and takes back the container's folder permissions, and prints ONE JSON line. It is the program behind the native Windows sandbox backend of the worker (card A03b). It is Windows only: on Linux and macOS it prints a failing line saying so, and the worker reports the Windows backend unavailable there.

It fails closed. If the container, a required grant, the job or the attribute list cannot be made, nothing is started; it never falls back to a child that is not confined.

## What the product build does

| Command | What it does |
| --- | --- |
| `run` | Grants the container its folders (`--grant MODE:PATH`, hard: a failure stops the run; `--grant-soft`, recorded and skipped), starts `--exe` with `--cmdline` in the container and a Job Object (kill-on-close always on; `--memory-mb`, `--active-processes`, `--ui-limits`, `--timeout-ms`), with standard input read from the FILE named by `--stdin file:PATH` and standard output and error written to the FILES `--stdout` and `--stderr`, then revokes every grant and reads each folder back. |
| `check` | Read only. For each `--grant` path, how many entries for the container are still on it (`clean`). |
| `revoke` | Removes the container's entries from each `--grant` path (for a run that died). Other entries first, sealed names last, and the seals only when everything else is clean. |
| `info` | Makes or finds the container profile (`--name`) and prints its SID. |

Grant modes in the product build: `ro`, `rx`, `modify`, `modify-root` (modify without the right to delete the folder itself: the workspace) and `seal` (a protected name: read and execute only, nothing else, DACL protected). Options `--aap-policy none|optout` and repeatable `--capability NAME` choose the plain AppContainer or the LPAC form (the measured configuration: policy `optout` with only `registryRead` and `lpacCom`); there is never a network capability or a loopback exemption. `--env NAME=VALUE` is repeatable and the child gets exactly that environment.

Exit code: the child's; 124 when the time limit ended the job; 125 when the launcher itself failed. The JSON line is authoritative (`ok`, `stage`, `error`, `childStarted`, `childExitCode`, `timedOut`, `leftoverProcesses`, `allGrantsRevoked`, and one entry per grant with `applied`, `revoked`, `entriesLeft`). Its field names are pinned against the TypeScript parser by `packages/worker/src/sandbox/windows-native-contract.test.ts`. The `tool` field is the protocol identifier `nn-appc-launcher` (kept from the experiment so no recorded run changes meaning); it is not the file's name.

## What is not in it

The measuring options of the experiment are not in the product build: grants `deny-write` and `deny-strong`, `--win32k-off`, `--no-kill-on-close`, `--keep-profile`, the NUL device and pipes for standard handles, `--dump`, and the commands `grant`, `dump`, `delete-profile` and `open-test` (plus the hang diagnosis). The product build refuses each at the argument check ("not in this build"), and the code of `open-test` and the hang diagnosis is compiled out. They exist under the cargo feature `experiment`, which only `experiments/windows-appcontainer/launcher/` turns on, so the experiment keeps working from the same source.

## Build, release, install

- Build and release (locked dependencies, pinned toolchain, reproducible build, the hash record, signing): [RELEASE.md](RELEASE.md).
- The one-time administrator install (account, folders, access lists, uninstall, verify): [../install/README.md](../install/README.md).
- Dependency licenses: `cargo-licenses.json` is checked against `Cargo.lock` by `npm run licenses:check`.

## Not proven yet

Launching from the service account in Session 0 with nobody signed in (also after logout and reboot), a non-administrator account, Windows Home, the controller's channel across the container boundary, and everything on the owner's own hardware. Only a hosted interactive administrator session on Windows Server has run this program.
