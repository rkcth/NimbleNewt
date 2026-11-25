# Installing the native Windows launcher (one administrator step)

Status: DESIGNED AND WRITTEN, NOT RUN. `Install-NimbleNewtLauncher.ps1` has been read by tests on Linux and is parsed and run with `-WhatIf` and `Verify` (which change nothing) by the hand-started Windows workflow. Nobody has run `Install` or `Uninstall` on a real machine. Run `-WhatIf` first and read what it prints.

Why an administrator is needed at all: the launcher itself needs none to make a container (hosted runs did it as an administrator, but creating a profile and granting folders to its SID are ordinary calls). What needs one, once, is what makes the setup safe to run unattended: a separate non-administrator account, a launcher no one but an administrator can replace, and a control folder only that account can use.

## What it makes (and what Uninstall removes, from the manifest it writes)

| What | Where | Access list (inheritance off, owner Administrators, allow entries only) |
| --- | --- | --- |
| The launcher | `%ProgramFiles%\NimbleNewt\nn-launcher.exe` | SYSTEM full; Administrators full; the account read and execute. Nobody else. Not writable by the account, so it cannot replace its own launcher, and not by any other user. |
| Manifest and `worker.env` | `%ProgramData%\NimbleNewt\` | SYSTEM full; Administrators full; the account read and execute (it reads `worker.env`; it cannot change it). |
| The supervisor's control folder | `%ProgramData%\NimbleNewt\native\` | SYSTEM full; Administrators full; the account: on the folder itself read, list and create (no Delete, so it cannot remove or rename the folder), on everything inside it Modify (its job records; not FullControl, so it cannot change this list or take ownership). No container is ever granted this folder, and the backend refuses a recipe that overlaps it. |
| The service account | local user `nimblenewt-worker` | Member of Users only. Rights: log on as a batch job; DENIED interactive, Remote Desktop and network logon. |

Every access-list line carries its reason in the script (the `Why` text) and `Verify` prints the same table next to what is really on the folder, and checks the list is exactly the expected one. `%ProgramData%` normally lets any user create and read folders; inheritance is switched off so none of that applies. A folder that is absent is made with its protected list in the same call (no moment with the parent's default list), and the folders are made in order, so a parent is closed before its child is made. The installer refuses a folder or file that already exists under these names (the three folders, the launcher, `worker.env`, the manifest) with an owner other than SYSTEM, Administrators, TrustedInstaller or the administrator running it, or as a link or junction (also a dangling one: presence is read from the item's own attributes, which do not follow a link, where `Test-Path` would call it absent); the check is repeated right before each is written. It also refuses one of the three folders when it already exists with its parent's (inherited) access list: this script never makes such a folder, and while a folder in `%ProgramData%` carries the parent's "Users may create", any user could have put a file or a hard link under one of these names in it (a hard link is not a link to this check and has its target's owner). `-InstallDir` and `-DataDir` must be full local paths ending in `\NimbleNewt`, in printable ASCII and without `#`, `'`, `` ` `` or `=` (`worker.env` is ASCII, and `node --env-file` cuts an unquoted value at `#`); this is checked before anything is changed. A non-default `-InstallDir` or `-DataDir` must sit in a folder that only administrators can change, as `%ProgramFiles%` and `%ProgramData%` are: the script sets the list of the `NimbleNewt` folder itself, but someone allowed to delete or rename entries in a parent folder could move that folder away and put another in its place. The script does NOT check the parent folders.

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

It is idempotent: a second `Install` finds the account (by its marker description) and rewrites each access list as a whole, so a drifted list is repaired and never extended; the launcher is copied only when its hash differs, re-hashed in place, and removed again if the placed file is not the expected one.

`Uninstall` refuses without its manifest, refuses a user it did not make, and stops while `nn-launcher.exe` is running. The manifest cannot steer it: it must name the same folders as the run of `Uninstall` (`-InstallDir`/`-DataDir` or their defaults), and its file and folder must belong to an administrator. It removes the account first, then closes the control folder to the account and removes it without following any link or junction in it (the account can make a junction there, and Windows PowerShell 5.1's `Remove-Item -Recurse` would follow it), then `worker.env`, the launcher and the manifest, and removes the two folders only if nothing else is left in them.

## The worker task (registered by an administrator, not by this script)

The installer makes the account, the launcher and `worker.env`; it registers nothing. Running the worker unattended as `nimblenewt-worker` is a separate Task Scheduler task whose text the release generates (`packages/controller/src/release/worker-service-unit.ts`; print it with `node scripts/nimblenewt-service.mjs print-worker --node <node.exe> --worker-entry <...\\scripts\\remote-worker.mjs> --config <worker.json> --working-directory <dir> --windows-user <COMPUTER>\\nimblenewt-worker [--data-dir <the installer's -DataDir>] [--unit-only]`). Printing changes nothing. **An administrator registers it** (elevated PowerShell: `Register-ScheduledTask -TaskName NimbleNewtWorker -Xml $xml`, the exact steps are printed with the unit; nothing in this repository, this script or a test registers a task).

What the unit is: principal = the worker account, logon type **S4U**, run level LeastPrivilege, no password element anywhere; one **boot trigger** (1 minute delay; no logon trigger, nobody has to be signed in); no execution time limit; one instance at a time (`IgnoreNew`); start when available; not stopped on battery; restart on failure 3 times, 1 minute apart; explicit working directory; command `node --env-file=<DataDir>\worker.env <remote-worker.mjs> --config <worker.json>`. The environment reaches the worker only through `worker.env`; the host credential is the token FILE the worker's configuration names (readable by the account only), never a value in the XML. The generator refuses relative, UNC, device, non-ASCII and shell- or variable-special paths and account names that are not ordinary.

Why S4U: the account's random password is never stored, so the task cannot log on with a password. Microsoft's Principal.LogonType page: "When an S4U logon is used, no password is stored by the system and there is no access to either the network or encrypted files." So the worker process has no network credentials of the account (its connection to the controller uses its own token file) and cannot read EFS-encrypted files, and it runs in a non-interactive session (Session 0). The account must have "log on as a batch job" (the installer grants it). Restart on failure is bounded (3 tries); after that the task stays down until an administrator starts it. The controller's own task (`print --platform win32`, `service-units.ts`) is unchanged: a logon-triggered task of the signed-in user.

`-Action Verify` reads the task if it exists (account, logon type, run level, trigger, command line) and fails when it is not S4U, not limited, not the account, not boot-only, or does not name `worker.env`; a missing task is only reported.

UNPROVEN: whether an S4U task of this non-administrator account can create the AppContainer profile and run the launcher with its private window station. See "The non-administrator proof" in `docs/nimblenewt/windows-isolation-plan.md` section 12.3: what to run on Rob's own hardware after an explicit go-ahead, and what each outcome means.

## What is NOT proven (stays listed in the implementation notes)

- Nothing here has run on Windows. The script's syntax is parsed by PowerShell on the hosted runner (and its brackets and strings are checked on Linux); the LSA calls, the folder creation with its access list, `Set-Acl` on `Program Files`, `New-LocalUser`, the read-back comparison of `Verify` after a real install, the link-safe removal and the profile removal are untested on any machine.
- Whether a task for this account with logon type S4U can start `nn-launcher.exe`, create the AppContainer profile and start a container in Session 0 with nobody signed in, including after logout and reboot, is unproven. If S4U does not work the fallback needs the stored-password form (the password is then kept by Windows in the task's credential store, which this script does not do) or a service host; that is a new decision, not a quiet change.
- That the account is not an administrator is the design; a hosted run cannot show it (the hosted account is an administrator).
- Windows Home, and the controller's channel to the container.
- The worker task for this account now has a generator (S4U, boot trigger; see "The worker task"), tested as text on Linux. Nobody has registered it or run it on Windows; whether it can start the launcher in a container as this non-administrator account is the open proof.
- Removing the account's AppContainer profile uses the user's profile removal; whether that removes the profile's registry entries completely is untested.
