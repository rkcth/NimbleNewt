# Installing the native Windows launcher (one administrator step)

Status: DESIGNED AND WRITTEN, NOT RUN. `Install-NimbleNewtLauncher.ps1` has been read by tests on Linux and is parsed and run with `-WhatIf` and `Verify` (which change nothing) by the hand-started Windows workflow. Nobody has run `Install` or `Uninstall` on a real machine. Run `-WhatIf` first and read what it prints.

Why an administrator is needed at all: the launcher itself needs none to make a container (hosted runs did it as an administrator, but creating a profile and granting folders to its SID are ordinary calls). What needs one, once, is what makes the setup safe to run unattended: a separate non-administrator account, a launcher no one but an administrator can replace, and a control folder only that account can use.

## What it makes (and what Uninstall removes, from the manifest it writes)

| What | Where | Access list (inheritance off, owner Administrators, allow entries only) |
| --- | --- | --- |
| The launcher | `%ProgramFiles%\NimbleNewt\nn-launcher.exe` | SYSTEM full; Administrators full; the account read and execute. Nobody else. Not writable by the account, so it cannot replace its own launcher, and not by any other user. |
| Manifest and `worker.env` | `%ProgramData%\NimbleNewt\` | SYSTEM full; Administrators full; the account read and execute (it reads `worker.env`; it cannot change it). |
| The supervisor's control folder | `%ProgramData%\NimbleNewt\native\` | SYSTEM full; Administrators full; the account Modify (job records; not FullControl, so it cannot change this list or take ownership). No container is ever granted this folder, and the backend refuses a recipe that overlaps it. |
| The service account | local user `nimblenewt-worker` | Member of Users only. Rights: log on as a batch job; DENIED interactive, Remote Desktop and network logon. |

Every access-list line carries its reason in the script (the `Why` text) and `Verify` prints the same table next to what is really on the folder, and checks the list is exactly the expected one. `%ProgramData%` normally lets any user create and read folders; inheritance is switched off so none of that applies, and the installer refuses a folder that already exists under these names with a different owner, or as a link or junction.

What it does not do: register or start the worker (the release's service unit), touch a task, workspace or data folder of the product, change a firewall, or change any account right other than the five named above.

## The account and its password

A virtual service account (`NT SERVICE\NimbleNewtWorker`) would be preferred: Windows manages it and there is no password. It exists only for a real Windows service, and the product has no service host yet (the release launcher is a Task Scheduler entry; see "Not decided"). A group-managed service account needs a domain and is not on Windows Home. So the account is a local standard user:

- The password is 48 random bytes (base64 plus one character of each class), made in memory from the system's random generator, passed once to `New-LocalUser` as a `SecureString` and dropped. It is never printed, logged or written to a file; the script has no variable that could hold a secret on disk. Windows stores only its hash.
- Nothing needs the password at run time: the worker is started by a task with the logon type S4U ("run whether the user is logged on or not", no stored password), or later by a service. Interactive, Remote Desktop and network logon with this account are denied by rights, so a guessed or leaked password could not be used to sign in.
- If a service host is ever added and needs the right to log on as a service, rerun with `-ServiceLogon`.

## How the four settings reach the worker

The worker reads `NIMBLENEWT_WIN_LAUNCHER`, `NIMBLENEWT_WIN_CONTROL_DIR`, `NIMBLENEWT_WIN_CONTAINER` (`lpac` or `appcontainer`) and `NIMBLENEWT_WIN_PROFILE` (`packages/worker/src/sandbox/windows-native.ts`, `windowsDefaultBackend`). The installer writes exactly those four lines to `%ProgramData%\NimbleNewt\worker.env` (no secret in it) and prints them. The service unit starts the worker with `node --env-file=<that file> ...` (the release's service unit already supports an environment file). It does not set machine-wide environment variables: those would reach every process on the computer. With the default folders and names the worker finds the same values without the file; the file exists so a non-default `-InstallDir`, `-DataDir`, `-Container` or `-ProfileName` reaches it.

## Use

```
# read only; also the way to see what is installed
powershell -ExecutionPolicy Bypass -File native\install\Install-NimbleNewtLauncher.ps1 -Action Verify

# what an install would do (changes nothing)
powershell -File native\install\Install-NimbleNewtLauncher.ps1 -Action Install -LauncherPath .\nn-launcher.exe -ExpectedSha256 <hash from the release record> -WhatIf

# the install, from an elevated PowerShell (asks before each change); -AllowUnsigned only for a build of your own
powershell -File native\install\Install-NimbleNewtLauncher.ps1 -Action Install -LauncherPath .\nn-launcher.exe -ExpectedSha256 <hash>

# the removal: the files, the folders, the account's rights, its profile and the account
powershell -File native\install\Install-NimbleNewtLauncher.ps1 -Action Uninstall
```

It is idempotent: a second `Install` finds the account (by its marker description) and rewrites each access list as a whole, so a drifted list is repaired and never extended; the launcher is copied only when its hash differs. `Uninstall` refuses without its manifest, refuses a user it did not make, and stops while `nn-launcher.exe` is running.

## What is NOT proven (stays listed in the implementation notes)

- Nothing here has run on Windows. The script's syntax is parsed by PowerShell on the hosted runner; the LSA calls, `Set-Acl` on `Program Files`, `New-LocalUser` and the profile removal are untested on any machine.
- Whether a task for this account with logon type S4U can start `nn-launcher.exe`, create the AppContainer profile and start a container in Session 0 with nobody signed in, including after logout and reboot, is unproven. If S4U does not work the fallback needs the stored-password form (the password is then kept by Windows in the task's credential store, which this script does not do) or a service host; that is a new decision, not a quiet change.
- That the account is not an administrator is the design; a hosted run cannot show it (the hosted account is an administrator).
- Windows Home, and the controller's channel to the container.
- The release's service unit for this account (it generates a logon-triggered task today; running unattended as this account needs an S4U or boot-triggered one): a change to `packages/controller/src/release/service-units.ts` that is not part of this slice.
- Removing the account's AppContainer profile uses the user's profile removal; whether that removes the profile's registry entries completely is untested.
