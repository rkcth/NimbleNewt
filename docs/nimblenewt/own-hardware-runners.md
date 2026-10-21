# Running checks on the owner's own machines

Some checks only mean something on real hardware: the OS sandbox and containment checks (cards A03, A04, G05), the real-OS parts of the QA checkpoints and the final qualification (D04). GitHub's hosted runners are virtual machines without the owner's OS builds, permission settings or sandbox features. This page describes the way the project can run checks on the owner's Mac and Windows machines: **self-hosted GitHub Actions runners**, started by hand. Status: **not set up yet.** The runner workflow ([own-hardware.yml](../../.github/workflows/own-hardware.yml)) is a probe; it does not contain sandbox checks yet. The other route, used for the earlier Windows research, is SSH with a dedicated key the owner names for the purpose.

## The risk, stated plainly

The repository is public, and a runner executes whatever a workflow tells it to, on a personal machine. GitHub advises against self-hosted runners on public repositories for this reason.

- **The guards in `own-hardware.yml` (manual start, `main` only, this repository only) protect only that file.** A pull request from a fork can edit *any* workflow file, such as `ci.yml`, to say `runs-on: [self-hosted, nimblenewt-mac]`, and the run uses the edited file. If that run is approved or not blocked, the fork's code runs on the owner's machine with the runner account's access.
- Therefore: in the repository settings (Settings, Actions, General, "Fork pull request workflows from outside collaborators") choose **Require approval for all outside collaborators**, and **never approve a run from a fork pull request without reading its diff, especially anything under `.github/workflows/`**. Where a pull request is not needed, consider turning fork pull request workflows off altogether.
- **Keep the runner offline unless a run is wanted.** Do not install it as an always-on service. Start it by hand (`./run.sh` on the Mac, `run.cmd` on Windows) for an "Own hardware" run and stop it afterwards, or register it with `--ephemeral` so that it accepts one job and then unregisters itself.
- **Whoever can push to `main` can run code on the runner.** Protect `main` (Settings, Branches): require a pull request or restrict who can push, and keep pushes to the reviewed-commit path (the project pushes with a single dedicated deploy key, only after an AI review approves the change).
- A **dedicated, non-administrator account** for the runner is the stronger setup, because then the code can read nothing of the owner's (SSH keys, browser profiles, documents). It is a recommendation, not a requirement: if the owner prefers to run it under their own account, the controls above are what stand between a mistake and their files, so they matter more, and the runner folder should still sit outside the profile folders that hold personal data.
- The runner registration token is a secret that lasts one hour. Do not paste it anywhere, including into a chat with an AI session.

## Setting up a runner (each machine)

1. Install Node 22 and Git on the machine, as for a normal checkout. On Windows, Git for Windows must be installed with its `bash` on the PATH of the runner's account (the probe uses `shell: bash`).
2. Decide on the account (see above) and the work folder, which the account owns.
3. In GitHub: the repository, Settings, Actions, Runners, **New self-hosted runner**. Choose the machine's operating system and architecture. GitHub shows the download commands and a `config` command that contains the one-hour token.
4. Run the download commands in that folder. Run `config` as shown, adding the label for the machine: `--labels nimblenewt-mac` (or `nimblenewt-windows`, `nimblenewt-linux`) and, if wanted, `--ephemeral`. Accept the other defaults.
5. Start it by hand (`./run.sh` or `run.cmd`). In Settings, Actions, Runners, it should show as **Idle**. A sandbox check that needs a signed-in desktop (Windows Sandbox did, in the earlier research) needs the runner started in an interactive session with the owner present, which is what a hand start gives; this page will say so when such a job exists.

## Using it

With the runner idle: Actions tab, **Own hardware**, **Run workflow**, branch `main`. The probe checks out the repository, installs from the lockfile, records the machine (OS, architecture, Node) and runs the test suite once. The result is in the job summary and in the `own-hardware-*` artifact. Then stop the runner.

## Taking a runner away

Settings, Actions, Runners, the runner, **Remove** (or `./config.sh remove` with a removal token). Then delete its folder, and the account if one was made for it.
