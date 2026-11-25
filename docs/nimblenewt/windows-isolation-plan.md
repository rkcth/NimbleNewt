# Windows isolation without Windows Sandbox: options and a plan

Status: PLAN ONLY (2026-11-24, Claude agent). No code was written or run. No card is flipped. Nothing here changes the implementation plan's statuses.

**Update 2026-11-25: the seven decisions in section 14 are decided by delegation (ASSUMPTION; the owner can overrule any of them), the native route is the Windows plan, and the cards were rewritten to match (A03b, G05, G06, H12r, H12i, A08c, Y02; see `implementation-notes.md`, "Native Windows plan revision"). Still a plan: no product code changed and no card flipped.**

Why this exists. The owner decided on 2026-11-24 that the Windows Sandbox (`wsb`) route is not enough: it needs a signed-in interactive console session, `wsb start` was refused (access denied, 0x80070005) even in the owner's own elevated console session on Windows 11 Pro, its unattended and UAC story is unproven, and it exists only on Pro, Enterprise and Education, not Home. The owner wants a plan for Windows isolation that works **unattended** (a service; nobody signed in or at the keyboard; no UAC prompt at run time; at most one admin approval at install) and, if possible, on **Windows Home** too.

## 1. How to read the evidence labels

| Label | Meaning |
| --- | --- |
| verified in repo | I read it in this repository at origin/main `7c9d6c75`; file named. |
| cited from URL | A public page I fetched or searched on 2026-11-24; the URL is in section 15. |
| community | A forum or blog statement, not Microsoft or the project itself. Treat as a lead. |
| unverified | I could not check it. It is a guess or a design idea, and it is listed as an experiment where it matters. |

## 2. What the product needs from a backend (verified in repo)

- A backend implements `SandboxBackend` (`packages/worker/src/sandbox/backend.ts`): `health()` must prove confinement by really starting a confined probe; `plan()` says how to start one confined process; `guestView()` says which paths the agent sees; optional `descendants`, `startTimes`, `release`, `auditDetails`; and `privateNetwork`.
- `privateNetwork` is true only for bubblewrap. A backend without it refuses any recipe that has a network route (`launcher.ts` line 245; card H12i). Seatbelt on macOS is in that group today.
- The launcher already supports a clearly labelled **trusted-host** mode: it runs unconfined, is refused unless the owner configured an authority, is written into the audit record, and is exercised by the containment suite as "the exception" (`launcher.ts` lines 236-239, `containment.ts`).
- Resource limits: on Windows today no per-agent limit is enforced; the limits code says the Sandbox guest's processes cannot be seen from the host and that a host-side Job Object does not bound a virtual machine (`limits.ts` lines 142-150). Card A08c is the card that closes this.
- Windows today: the only Windows backend is Windows Sandbox (`windows*.ts`; card A03b). It reports `sessionDependent: true`, has an opt-in autologon-and-lock mode, and records "VM fallback not qualified and not implemented" (`windows-plan.ts` line 38-39). The owner's earlier research (`implementation-plan/windows-unattended-findings.md`) found a fresh Sandbox launch before any user signs in fails with 0x8000401A, and that only an owner session or automatic login plus lock worked.
- The security guide already says tasks on macOS and Windows wait for a host that can confine them (`security-guide.md` line 36). `portability-and-configuration.md` line 21 says containers, VMs, WSL and remote workers may be execution backends "with disclosed prerequisites" but are not substitutes for qualifying the Windows product itself.

### The ten containment cases (verified in repo: `containment.ts`, run by `scripts/containment-evidence.mjs`)

| # | Case | What it tries |
| --- | --- | --- |
| 1 | control-write-own-directories | The agent can write its own work, home and scratch folders. |
| 2 | control-read-own-decoy | The agent can read a file in its own checkout. |
| 3 | deny-write-system | Create files in system folders (Windows, System32, `C:\`, Program Files). |
| 4 | deny-write-host-path | Overwrite or create files in host folders outside the workspace, the controller's folder and the service home `.ssh`. |
| 5 | deny-symlink-read | Read the controller database and a key through file links, a junction and a relative link in the checkout. |
| 6 | deny-symlink-write | Write a host file and a host folder through a link and a junction. |
| 7 | deny-credential-read | Read a planted key under the service home, list `.ssh`, print the environment. |
| 8 | deny-controller-data-read | Read and list the controller's data folder. |
| 9 | deny-network-loopback | Connect to a host service on `127.0.0.1`; on Windows it also lists network adapters and fails if one is up. |
| 10 | deny-write-protected-name | Change, add to and delete inside `.git` in the checkout. |

Every denial is first run without the sandbox and must succeed there, so a typo cannot pass as a denial. The gate (`assessRelease`) needs all ten on Linux, macOS and Windows for the same commit.

Two honest notes on the suite itself, both verified in repo:
- Case 9 on Windows judges the confined program's **network adapter list** (written for a VM guest that has none). A native confinement leaves the host's adapters visible, so that case needs a native variant that relies on the refused connection, as the macOS case does. This is a small change to the test, not to what it protects, and it must be reviewed as such.
- Case 10 uses a bind mount on Linux. On Windows it would be file permissions (section 5), which have a known gap (rename or replace of `.git` itself).

## 3. The options in one table

| | A. WSL2 hosting the Linux backend | B. Native Windows, Chromium and Firefox style | C. Containers: C1 whole product in an image, C2 per-task worker containers (Docker, Podman) | D. Trusted-host (no isolation) |
| --- | --- | --- | --- | --- |
| Mechanism | bubblewrap inside a dedicated WSL2 distro | Restricted token, low or untrusted integrity, Job Object, alternate desktop, optional AppContainer, file permissions, no network capability | Container runtime: namespaces, cgroups, dropped capabilities, seccomp, read-only root, no network, workspace-only mount | Run as the service account, no confinement |
| Windows Home | Yes (WSL2 is on Home; cited) | Yes (no optional feature needed; unverified that nothing is edition-gated, see E1) | Docker Desktop: its current page lists Pro, Enterprise, Education, not Home (cited; conflicts with older material). Docker Engine or Podman inside WSL2: yes if WSL2 works. Windows containers: Pro or Enterprise only (cited). A container removes no WSL2 or Hyper-V requirement | Yes |
| Unattended | Unproven; the owning account must start the VM | Likely, unproven from a service (E6) | Linux: yes (system service, or rootless with linger; cited). macOS and Windows desktop products: unproven | Yes |
| Admin at install | Yes: enable two features, restart; plus a service account | One-time only if we want a dedicated account, a service, or a firewall rule; none for AppContainer alone | Linux: root once. Windows: WSL2 enable needs admin once (cited) | None |
| UAC at run time | Should be none (unproven) | None expected | None expected (unproven on Windows) | None |
| Strength vs Linux | Same as Linux if bubblewrap runs there; the VM is an extra wall | Weaker: shared kernel, no private view of the filesystem, same family as Seatbelt | C2: about the same as bubblewrap on a Linux host; a VM wall extra on macOS and Windows; adds a root-equivalent daemon. C1 alone: no agent isolation | None |
| Cases it can pass (of 10) | All 10 plausibly (E8) | 10 with one test variant for case 9; case 10 partial | C2: all 10 plausibly; C1 alone: fails 5 to 8 | 2 controls only; 8 denials fail by design |
| Resource limits (A08c) | Inside the Linux distro: kernel groups available | Job Object: real limits, including kill-on-close | cgroups through the runtime | None |
| Network route (H12i) | Yes (private network as on Linux) | No at first (loopback is not private); a pipe relay is a design idea | Design needed (internal network with a relay container; unverified) | Not applicable |
| Effort (cards, rough) | 6 to 9 | 5 to 7 | C1 4 to 6; C2 5 to 8 plus 1 to 2 for safe daemon access | 1 to 2 |
| Removes a Windows requirement? | No (it is the requirement) | Yes: no VM, no feature, no restart | **No**: still needs WSL2 or Hyper-V | Yes (but no isolation) |

## 4. Option A: WSL2 hosting the existing Linux backend

What it is: a dedicated, locked-down Linux distro in WSL2 that runs the existing bubblewrap backend. The Windows service starts a command inside it.

Facts:
- WSL2 is available on Windows Home and Pro. It needs two optional features (Virtual Machine Platform and Windows Subsystem for Linux), hardware virtualization turned on, and a restart; installing them needs administrator rights once (cited: WSL FAQ, manual install).
- A distro can be imported from a tarball without the Microsoft Store (`wsl --import`, cited FAQ), so no Store account is needed.
- The distro belongs to the Windows user who registered it. Distro registration is per user (community). So a service must start `wsl.exe` as that same user.
- Whether a Windows service or a "run whether the user is logged on or not" task can start WSL for a service account is **not documented by Microsoft**. The GitHub discussion on exactly this has no maintainer answer (cited). Community reports say a startup scheduled task under the owning user works, others say session 0 causes trouble, and one Microsoft Q&A thread reports the task only worked for an administrator (all community). **This is the key unknown for option A.** It is unverified.
- WSL is built for inner-loop development, and Microsoft says so: the utility VM starts and stops itself, shuts down when nothing holds it, gives file access to Windows files, appends Windows paths, and can run Windows programs (cited FAQ). Each of these is turned off or tamed by settings: automount off, interop off, `appendWindowsPath` off (cited wsl-config), `vmIdleTimeout` and `instanceIdleTimeout` (cited), a long-running process inside to hold the VM. The same page says the user has full access to the distro and can change those settings, so the service account, not the agent, must own them.
- Microsoft recommends the new **WSL container API / `wslc.exe`** for production apps that need Linux runtimes (cited FAQ; it needs WSL 2.9.3 or later, cited). Its settings are per user (`%LOCALAPPDATA%\wslc\settings.yaml`, cited). Whether a service can create a session, and what isolation a session gives, I could not confirm: unverified. It is worth one experiment (E7) because it is the supported programmatic route.
- Files: host workspace to Linux. Mounted Windows drives (DrvFs) are slow for many small files and have different permission and case semantics (cited FAQ describes the differences; the speed claim is common knowledge, unverified here). Practical design: the checkout lives inside the distro's own disk and moves in and out with git, never a live shared folder. That fits NimbleNewt (the agent works on a checkout and submits a result).
- Network: default NAT; the distro can be made network-less (`networkingMode=none`, Windows 11 only, cited). Inside bubblewrap the agent already has a private network. Reaching Windows host services from the distro depends on mirrored/NAT settings and the Windows firewall (`firewall=true`, cited); the case 9 test would prove it.
- Credentials: the Windows user's secrets are not visible inside the distro if automount and interop are off. The Linux side gets only what we copy in. Unverified until E8 shows it.
- Cost: needs virtualization (not every PC, not nested hosted runners), reboot at install, a Linux image to ship and patch, WSL itself updated by Microsoft (cited FAQ), memory taken from the machine (50 percent by default, cited), and the VM idle shutdown to manage.

Strength: highest of the unattended candidates, if it works, because case results should be identical to Linux and the VM is an extra wall. Risk: the unattended start of the VM.

## 5. Option B: native Windows containment (the Chromium and Firefox family)

This is the option the owner pointed at: Chrome and Firefox run isolated child processes on Windows Home, unattended, with no UAC at run time.

### 5.1 What the browsers actually use (cited)

Chromium's Windows sandbox is a user-mode library with a privileged **broker** and sandboxed **targets** (design document, `docs/design/sandbox.md`; library in `sandbox/win`). Its layers:

| Layer | What Chromium does | Notes |
| --- | --- | --- |
| Restricted token | Keeps few groups, denies the rest, removes privileges, adds an Untrusted integrity label | Chromium says it is "near impossible to find an existing resource that the OS will grant access with such a token" |
| Job Object | One job per target; blocks system settings changes, desktop switching, clipboard, global hooks, atoms, child process creation | CPU, memory and I/O limits are possible but the doc says not yet used |
| Alternate desktop | Target runs on a hidden desktop, so it cannot send window messages to real windows | About 4 MB |
| Integrity level | Untrusted | The doc calls this defence in depth, not a strict boundary |
| Process mitigations | Win32k lockdown, no extension points, control-flow guard, code-integrity guard, child-process policy | Win32k lockdown cuts the kernel graphics attack surface |
| AppContainer / LPAC | Low box token with no capabilities; network refused for lack of the network capability; LPAC (Windows 10 RS2 and later) only grants what is explicitly marked | The doc says file and registry ACLs must be set up for LPAC to work |
| Broker | The privileged process performs file, registry and pipe access on behalf of the target by policy | Compatibility and policy, not extra security |

Firefox uses the same family on Windows for its content processes: a restricted access token (`USER_RESTRICTED` shipped in release 134), an untrusted integrity level (in progress), a locked-down job, an alternate desktop and window station (all cited through Bugzilla and the Mozilla wiki; I could not load Mozilla's sandbox documentation page, it returned 404, and I did not verify that Firefox shares Chromium's library, though the level names match). Honest escape history (cited): Project Zero's CVE-2020-12388 (a restricted-SID rule that did not hold) and Bugzilla 1618911 (a default process DACL let one content process open its sibling content processes). Chromium also lists its known limits: unlabelled objects such as anonymous shared memory can be reached, any bug in an OS service call can escape, injected third-party DLLs weaken it, and leaked handles are an escape.

Do they run with no UAC and no one signed in? Browsers run in the user's own session as the user, so they do not show this. Nothing in these documents says a **service in session 0** can launch such a child; one Microsoft Q&A thread describes a LocalSystem service in session 0 that could not start an AppContainer process through `CreateProcessAsUser` while the same call with a logged-in user's token worked (cited). Its accepted answer, from the asker themself, says the cause was user32.dll failing to initialise and that granting the AppContainer read access to the session 0 desktop and window station made it work; it is a single community report, not a Microsoft statement, and it also says cmd.exe worked while powershell and java did not. Our own-hardware run 45634597880 (section 12.1) shows the same split. That is the second key unknown (E6).

### 5.2 What carries over to a coding agent, and what does not

A browser renderer is a narrow program. It needs almost nothing from the OS; a broker does the rest. A coding agent runs arbitrary toolchains: `git`, `node`, `npm`, package managers, compilers, test runners, shells, other child processes. That changes the answer.

| Chromium feature | Carries over? | Why |
| --- | --- | --- |
| Restricted token | Yes | Core of the file-access denial. Restricting SIDs must include the workspace SID and groups that Program Files and Windows allow, so tools can run |
| Low or untrusted integrity | Low: yes; Untrusted: probably not | Untrusted breaks many ordinary tools (cannot write normal temp, reads limited). Use Low or the AppContainer's Low |
| Job Object | Yes, but different policy | Do not block child processes (git and npm need them). Use active-process limit, memory, CPU rate, kill-on-close. This is also exactly A08c |
| Alternate desktop | Yes | Cheap; agents need no GUI. Console programs need a console host; unverified (E3) |
| Win32k lockdown | Probably not for general tools | Console and shell tools may need the console host; unverified (E3). Not a core need for our agent |
| AppContainer (no capabilities) | Yes for the network cut; partial for toolchains | Cuts network and most file access by default. Many tools expect registry keys, COM, or per-user profile folders that an AppContainer cannot read; LPAC is stricter still. Toolchain compatibility is the big risk (E4) |
| Broker policy for files | Not practical | The browser has a narrow, known set of calls. An agent's tools open arbitrary paths. So file access is controlled by ACLs on the real files rather than by a broker |
| Mitigation flags | Mixed | Child-process and code-integrity policies would break node, npm and compilers. Use the ones that do not |

Bottom line: the browser design is a strong **model for the layers**, but an agent sandbox built from it will be a **permissive** version of it, closer to Seatbelt's "deny by default, allow the workspace and the toolchain" than to a renderer. Its strength is access control on files and the network cut, plus a kill-and-limit job. It is not a private view of the filesystem and not a separate kernel.

### 5.3 Design sketch (all unverified until experiments run)

Who launches. The NimbleNewt Windows service runs as a **dedicated low-privilege account** (a virtual service account or a local user created at install), not LocalSystem. Agent tokens are made from that account's own token, so the service identity is never SYSTEM. This also gives a clean owner of the controller data, which the cases check (case 8). A service started as SYSTEM that derives restricted tokens would carry the SYSTEM user SID, which is the wrong base.

How a confined agent is started (per run):
1. Create (or reuse by name) a per-run AppContainer profile: `CreateAppContainerProfile`, no admin needed (cited: Microsoft "Launch an AppContainer"). The package SID is derived from a moniker we choose, such as `nn-<runId>`; AppContainers have separate identities, so two agents cannot read each other (cited: "unique Package SID ensures their own resources are protected from other applications").
2. Grant that SID file permissions only where the recipe says (see 5.4).
3. Start the process with `CreateProcess` and the `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` attribute, no capabilities (cited). Optionally an LPAC (an additional attribute, cited).
4. Put it in a Job Object with limits and kill-on-close (cited: Job Objects page), and on an alternate desktop.
5. On the way out: remove the grants and the profile (`DeleteAppContainerProfile`). A leftover sweep (as `windows-cleanup.ts` does for Sandbox) removes crashed runs' grants.

Variants to compare in the first experiments:
- **B1 AppContainer** (Low box, no capabilities). Network cut and file default-deny come from the token itself.
- **B2 restricted token plus Low integrity plus job plus alternate desktop** (the Chromium token without AppContainer). Needs a separate way to cut the network.
- **B3 dedicated local account** (a standard user created at install, agents started with its token). Files under the controller and service-home folders are denied because those ACLs do not include it. Needs admin once to create the account. Network still needs a cut.

### 5.4 ACL grants for the AppContainer SID

For a run with recipe (workdir, home, scratch, tmp, read-only inputs, protected names):

| Place | Grant to the AppContainer SID | Reason |
| --- | --- | --- |
| workdir, home, scratch, tmp | Modify, inherited to children | The agent's own folders (cases 1, 2) |
| Read-only inputs (Node install, tool folders) | Read and execute, inherited | Tools it may run |
| `.git` and other protected names under workdir | Explicit deny of write, delete and add on the name | Case 10; deny must also stop rename or replacement of the name itself, which needs delete denied on the name and the parent's delete-child right not granted: this conflicts with agents deleting files in the checkout root, so it needs a design and a test (E2) |
| Parent folders of the above | Traverse only, if the system does not already allow it | Unverified whether an AppContainer needs it; part of E2 |
| Everything else (user profile, controller folder, other drives, `.ssh`) | Nothing (this is the denial) | Cases 3 to 8. Legacy ACLs deny AppContainers unless a SID is in the list (cited: Microsoft, "all legacy, unmodified ACL objects block access requests from AppContainer processes by default") |
| Program Files, Windows | Already readable by the "All application packages" group (cited, community for the exact folders) | Tools and system DLLs; the LPAC variant opts out of this and needs explicit grants |

Honest limits: the permitted access is the intersection of what the user and the AppContainer SIDs are granted (cited). Anything the group "All application packages" or "Everyone" can read stays readable (for example parts of `C:\Users\Public` and `C:\ProgramData`, the registry hives that allow it, readable system files); a deny ACE can narrow that for places we know. File systems without ACLs (FAT, exFAT, network mounts) are not protected (cited, Chromium doc). Workspaces must be on NTFS.

### 5.5 How the network is cut

- **AppContainer without the network capabilities**: no network access, "without the network capability an AppContainer cannot access the network" (cited). Loopback is blocked by default for AppContainers and only lifted by an exemption (cited, `CheckNetIsolation LoopbackExempt`); we never add one, so case 9 should hold. The exemption would be machine configuration needing admin and would open **all** host loopback listeners to that container, so it must not be used to reach a relay.
- **Restricted token or dedicated account without AppContainer**: there is no built-in network cut. It needs Windows Firewall or Windows Filtering Platform filters keyed on the account's SID or the AppContainer, created by an administrator at install (once). Whether a per-user outbound block works on Home with the built-in firewall is unverified (E5).
- **Job Objects**: no network control at all (cited: job limits are about CPU, memory, processes, UI).
- Consequence for H12i: with AppContainer and no loopback exemption there is no private route to the worker's relay, so the backend would keep `privateNetwork` false and refuse routes, like Seatbelt. A named-pipe relay (a pipe whose ACL names the AppContainer SID, plus a tiny in-sandbox shim that turns pipe traffic into the HTTP the agent expects) is a design idea only; unverified.

### 5.6 Known escape classes, honestly (cited unless marked)

| Class | Effect | Mitigation here |
| --- | --- | --- |
| Windows kernel or service bugs reachable from the confined process | Full escape; no sandbox on a shared kernel prevents it (Chromium: "no practical way to prevent code in the sandbox from calling a system service") | Accepted, as for Seatbelt; keep Windows updated; say so in the product |
| Leaked or inherited handles | Escape | Start with explicit handle lists (no inheritance) |
| Objects with no or weak security descriptors (anonymous shared memory, named objects, some pipes) | Read or change what other processes share | AppContainer's private object namespace helps; test (E3) |
| Third-party code injected into the process (some security software) | Backdoor around the sandbox | Disclose; detect by a health probe |
| Default DACL on the confined processes (Firefox 1618911) | One confined process opens another | Per-run AppContainer SID; set a tight default DACL |
| Registry reads | A restricted token or AppContainer still reads much of `HKLM` | Accept; no secrets belong there |
| Named pipes labelled low integrity | Reachable from low integrity | Review pipes the service exposes; use a per-run pipe name and ACL |
| Spawning a process as a different, more powerful identity via a service the user can reach (scheduler, COM) | Escape | Low-box tokens limit this; test that the Task Scheduler and service control managers refuse (E3) |
| Other users' data on a shared PC | Denied only where ACLs deny | Use per-user install; do not claim multi-user safety |

## 6. Option C: containers (Docker and Podman), and Hyper-V

The owner also likes releasing NimbleNewt to run in Docker, which is the usual form on Linux. Repo fact (verified in repo): the plan has no Docker, Podman or container-image card today; searches of `docs/nimblenewt/*.md` and `task-plan.md` found none (the word "compose" in card titles means wiring code, not Docker Compose). So everything below is new scope.

There are two different things people mean by "run it in Docker". They have different isolation and different costs, so they are kept apart.

- **C1. The whole product in a container image** (controller, UI and the local worker host in one or two images, started by Compose or a service manager). This is a **packaging and deployment** choice. It does not by itself confine an agent's tools from the rest of the container.
- **C2. Per-task worker containers created by the controller**: each agent run gets its own short-lived container, the container runtime does what bubblewrap does today. This is an **isolation backend** (a new `SandboxBackend`), and it is the one that competes with options A and B.

### 6.1 Which container runtime, on which system

| System | Runtime | Facts | Admin, edition, licence, unattended |
| --- | --- | --- | --- |
| Linux | Docker Engine (daemon as root) | Namespaces, cgroups, a restricted default capability set (cited: Docker security page). The daemon needs root unless rootless; "only trusted users should be allowed to control your Docker daemon"; a container started with a bind mount "can alter your host filesystem without any restriction" (cited). Reading that, socket or `docker` group access is root-equivalent (my reading of the cited text; Docker's page does not use those words). | Install needs root once. A system service starts at boot: unattended yes (unverified on this repo's CI; ordinary behaviour) |
| Linux | Docker rootless | Daemon and containers run as a normal user in a user namespace; needs `newuidmap`, `newgidmap` and at least 65,536 subordinate ids (cited). Starts at boot without login with `loginctl enable-linger` (cited). Its limits (ports, cgroups, network, storage drivers) are in the full page, which I did not retrieve: unverified | One-time root for packages and subuid; then no root; unattended with linger |
| Linux | Podman | Daemonless, rootless by default (community knowledge; the pages I fetched do not cover rootless): unverified | No daemon socket to guard; a different CLI (mostly compatible) |
| macOS | Docker Desktop | Runs Linux containers inside a VM (general knowledge; I did not retrieve the macOS page): unverified. The VM is a second wall between the agent and macOS, but the product's workers would be inside it, away from macOS files unless mounted | Licence as below; a per-user desktop app: unattended unverified |
| macOS | Podman machine | Also a VM (cited by analogy from Red Hat and the Podman blog: "Podman on Windows works similar to macOS, running Linux containers inside a virtual machine") | unverified |
| Windows | Docker Desktop, WSL 2 backend | Needs WSL 2.1.5 or later; Windows 10 22H2 or Windows 11 23H2 or later; the page lists **Enterprise, Pro or Education** and does **not list Home**; 64-bit SLAT processor, 8 GB RAM, virtualization on (cited: Docker install page). Older Docker material said the WSL 2 backend works on Home; the current page's table does not list it, so **Home support is in conflict and unverified**: E10 settles it on a real Home PC if one is available, otherwise treat as unsupported | Per-user install needs no admin; the first WSL 2 enable needs admin once per machine; it does not start automatically after installation and the page does not say whether it starts at sign-in (all cited). **Unattended with nobody signed in is not documented**: unverified. `--always-run-service` starts `com.docker.service` automatically (cited) but Docker Desktop's UI/VM start in a user session is not shown to follow |
| Windows | Docker Desktop, Hyper-V backend | Same editions plus Hyper-V and Containers features on; admin; Windows containers need Pro or Enterprise, Home and Education run Linux containers only (cited) | All-users install needs admin (cited) |
| Windows | Docker Engine installed **inside a WSL 2 distro** (no Docker Desktop) | This is option A with a Docker daemon in the distro. WSL 2 prerequisites and unattended-start unknowns of section 4 all still apply. Docker Engine itself is free software (general knowledge: unverified here); the Docker Desktop licence below does not apply to it | Same as option A: unproven service start |
| Windows | Podman (machine on WSL 2 or Hyper-V) | WSL 2 is the default provider and the only one on Home; Hyper-V needs the feature and an administrator; 6 GB RAM minimum for the machine (cited: Red Hat and Podman blog) | Per user; unattended unverified |

**Docker Desktop licence (cited: Docker's licence page).** Free for personal use, education, non-commercial open source and small businesses: "fewer than 250 employees AND less than $10 million in annual revenue". Larger organizations and government entities need a paid subscription (Pro, Team or Business). I did not retrieve the exact legal wording; owners who are above the thresholds must check it. Docker Engine on Linux, and Podman, are separate products: their terms were not checked (unverified).

### 6.2 What a container gives compared with bubblewrap and Seatbelt

| Aspect | Container (Docker or Podman) | bubblewrap (Linux backend, verified in repo `linux.ts`) | Seatbelt (macOS, verified in repo `seatbelt.ts`) |
| --- | --- | --- | --- |
| Kernel | Shared with the host on Linux; shared with the runtime's VM on macOS and Windows (the VM kernel, not the OS's) | Shared | Shared |
| View of the filesystem | Private root from the image; only chosen mounts | Private root; only chosen binds | None; deny-by-default profile |
| Network | Private by default network stack (cited); `--network none` removes it (general knowledge: unverified here) | `--unshare-all` private network; privateNetwork true | Deny; shares host loopback |
| Capabilities | Restricted default set (cited); can drop all | `--cap-drop ALL` | Not applicable |
| Syscall filter | Default seccomp profile (cited by the Docker Labs lab found in search; I did not fetch the profile) | The launcher's own flags; no extra filter in the code I read | Profile |
| Read-only root | `--read-only` (general knowledge: unverified here) | `--remount-ro /` | Profile |
| User | Root in the container by default; rootless or `--user` possible | Unprivileged, `--unshare-user --disable-userns` | Normal user |
| Resource limits | cgroups through the runtime (cited: "fair share of memory, CPU, disk I/O"; cgroups do not isolate data) | Linux groups (card A08b, implemented) | Sampling monitor |
| Attack surface added | A **daemon** (Docker Engine) with root or a socket that is root-equivalent; rootless and Podman reduce it | None beyond the kernel | None |
| Startup cost | About a second or more per container; image to pull and keep patched | Milliseconds | Milliseconds |

Honest summary: with the right flags a container is **about as strong as bubblewrap** on a Linux host (both are namespaces, cgroups and capability drops on a shared kernel) and gets a **second wall on macOS and Windows** only because the container engine lives in a VM. It is not a stronger boundary than bubblewrap on Linux. Its extra weight is the daemon: whoever can talk to the daemon can mount the whole host (cited), so the controller must hold that power and never pass it on.

### 6.3 C1: the whole product in a container

- What it is: an image (or two: controller and UI/worker host), a Compose file, persistent volumes for the data folder (database files, durable storage) and the workspace checkouts, and the secrets passed as runtime secrets, not baked into the image.
- It helps deployment: one command, a pinned Node version and tools, the same everywhere, updates by image. It fits Linux servers, NAS and the owner's remote hosts (card family H02 subordinate remote workers, K02 release staging).
- It does **not** by itself isolate an agent from the controller: if the agent's tools run as processes in the same container as the controller, they see the controller's data and secrets (case 8 fails). The controller and the agent tools must be in **different containers**, or the agent must be confined inside the container (next point).
- **Nested sandbox problem.** If the worker host runs bubblewrap inside a container, bubblewrap needs to create new user and mount namespaces. Docker's default seccomp profile blocks `unshare`-style namespace creation, so `bwrap` fails with "creating new namespace failed: Operation not permitted" unless the container is started with a relaxed seccomp profile, a custom profile that allows those syscalls, or `--privileged`; AppArmor on the host can also block it (cited: Docker Labs seccomp lab, Flathub forum, Launchpad apparmor bug, all found by search; I did not verify the exact blocked syscalls). Relaxing the seccomp profile removes one of the container's own protections, so the net result is not obviously better than bubblewrap on the host. This product's Linux health check already refuses capacity when unprivileged user namespaces are unavailable (verified in repo, A03 text); in a container it would simply report unhealthy unless the operator opted in. Practical choices: (a) run the whole product on the host with bubblewrap and no container (today); (b) run the controller in a container and workers as **sibling** containers (C2); (c) allow bubblewrap in the container with a documented custom seccomp profile and call it the "nested" tier, unproven.
- Credentials and mounts: mount only the data volume and the checkouts; the model provider keys stay in the controller container (the repo's own design keeps the worker free of provider keys: H12b, verified in repo); never mount the host's home, `.ssh`, or the container runtime's socket into any container that runs an agent.
- Unattended: Compose with `restart: unless-stopped` (general knowledge) under a Linux service manager starts at boot with no login. On macOS and Windows it depends on the desktop product starting at boot (unverified, above).

### 6.4 C2: per-task worker containers created by the controller

- The controller (or a small root-owned helper) asks the runtime for a container per run with: no capabilities, a read-only root, `--network none`, the workspace as the only writable bind mount, `.git` mounted read-only over it, a non-root user, a memory/CPU/process limit, and kill-on-stop. That maps one to one onto the existing recipe fields (workdir, home, scratch, readOnly, network none, protectedSubpaths); `guestView` and `plan` would translate them into runtime options (design, unverified).
- **The socket is the whole security question.** Anything that reaches the Docker daemon can start a container with the host's root mounted, so (a) the daemon must never be reachable from an agent container (no socket mount, no TCP), (b) the controller process that holds it becomes a high-value target, so it should be rootless Docker or Podman, or a small separate launcher process that accepts only the recipe's fields and nothing else, as the current launcher already does with its own fixed arguments for bubblewrap. A bug in that translation is a host escape. Compared with bubblewrap, which needs no daemon, this is a **larger trusted component**.
- Health check: the backend must really start a confined probe container and see the writes, the network and the `.git` protections hold, as the present backends do (verified in repo, backend interface), and refuse capacity if the runtime is missing or broken.
- Image supply: a base image with Node, git and the supported toolchains, pinned by digest, built reproducibly (the repo already rejects unpinned inputs in other places: F03 install-scripts rule, verified in repo `.npmrc`); an image pull on first use needs the network. Offline guard rules for tests apply (verified in repo, `offline-guard.mjs`).
- Windows: a container on Windows **still needs WSL 2 or Hyper-V underneath**. It removes no Windows requirement; it adds the same prerequisites as option A (virtualization, features, a restart, admin once) and then a container engine on top. It also adds Docker Desktop's edition limits and licence if Docker Desktop is the runtime. It does not make the unattended question easier: the unattended start of the VM is still the unknown (E9, E10).

### 6.5 The ten containment cases for containers

Predictions only; none was run (unverified). "Per-task" means C2 with the flags above. "Whole product" means C1 with the agent tools in the same container as the controller.

| Case | C2 per-task container (Linux host, rootless or Podman) | C2 on macOS or Windows (VM-backed) | C1 whole product, tools in the controller's container |
| --- | --- | --- | --- |
| 1 and 2 controls | pass | pass | pass |
| 3 deny write system | pass (read-only root; non-root) | pass | pass | pass only with a read-only root and non-root user |
| 4 deny write host path | pass: only the workspace is mounted | pass | pass | partial: the volumes the controller uses are writable by the tools unless split |
| 5 and 6 symlinks | pass: the link target is not in the container | pass | no: targets inside the same container are reachable |
| 7 credentials | pass if no host home is mounted and the environment is built by the controller | pass | no if secrets are in the container's environment or files |
| 8 controller data | pass: not mounted | pass | **no**: same filesystem |
| 9 network | pass with `--network none`; the "adapters" check as written for Windows would need the same variant as B | pass | no unless the container itself has no network, which the controller needs |
| 10 protected name | pass with a read-only bind of `.git` over the workspace | pass | partial |

So C2 can pass all ten on Linux, where it is the same class as bubblewrap, and C1 alone cannot pass the isolation cases at all; it needs an inner confinement (bubblewrap, nested) or sibling containers.

### 6.6 What it would take, and which cards change

Rough size, in cards (my estimate, unverified):

| Piece | Cards | Notes |
| --- | --- | --- |
| C1 image, Compose file, volumes, secrets, health, update path, docs (Linux and macOS first) | 4 to 6 | New cards under installation and release (D01, K02, X05 are the nearest existing ones, none covers images) |
| C2 container backend (launcher plan, probe, limits, image, cleanup, containment dialect) | 5 to 8 | Replaces nothing on Linux or macOS (bubblewrap and Seatbelt stay); for Windows it replaces A03b only if the owner accepts WSL 2 as a requirement |
| Safe daemon access design (rootless or Podman, helper) | 1 to 2 | The security-critical card |
| Real-hardware evidence (G05, G06, Y02 on Windows with WSL-backed runtime) | Same as option A | No saving over A |

Cards that change if C is adopted: **A03b** (an alternative to the Windows launcher, not a replacement unless WSL 2 is accepted); **A03** (a third backend family); **G05, G06, Y02, H12r, X06** (the containment suite and the worker proofs would need the container backend as a platform variant; a Windows PC would need WSL 2 or Hyper-V proof as in option A); **H12i** (a container network `none` gives a private network only if the route proxy is another container on an internal network: design, unverified); **A08c** (cgroup limits through the runtime, so the Windows Job Object part is not needed for containers); **D01, K02, X04, X05, X06** (packaging and fresh-install qualification, which the plan does not cover for images); **H02 family** (remote workers could be images). **P02, P03, Q01 and Y01 do not change** apart from waiting on Y02.

### 6.7 Does Docker change the Windows story?

Plainly: **no, it removes no Windows requirement.** Docker Desktop and Podman on Windows run Linux containers inside WSL 2 or a Hyper-V VM (cited), so a PC without virtualization, a PC where the unattended VM start fails, and a Home PC where Docker Desktop's edition list excludes Home all remain outside it. Docker Engine inside WSL 2 is option A plus a daemon. Docker adds no way to satisfy the owner's "unattended, no one signed in, no UAC, Home" requirement that option B (native) or option A do not already face; if anything it adds the Docker Desktop licence and edition limits. For Windows it is a heavier route to the same VM as option A. Windows containers (native Windows images) need Pro or Enterprise (cited) and are not recommended here (section 6.8).

For Linux and macOS, Docker is useful on its own terms: a one-command **deployment** of the product (C1), and an optional **isolation backend** (C2) for hosts where bubblewrap is not usable (for example where user namespaces are restricted but a container runtime is allowed). It is a good packaging card family; it does not replace bubblewrap or Seatbelt as the primary confinement.

### 6.8 Other container-adjacent options

- **Windows containers** (native Windows images): Pro or Enterprise only, Home and Education run Linux containers (cited). Hyper-V isolation on client editions and unattended behaviour were not verified here. Not recommended.
- **Own Hyper-V VM with a second Windows**: needs Pro or higher and a second Windows licence or evaluation media; the owner declined evaluation media (verified in repo, `windows-unattended-findings.md`). Strong and unattended-capable but heavy and excludes Home. Parked.
- **The WSL container API** (`wslc`, `Microsoft.WSL.Containers`): a supported programmatic way to run Linux containers on Windows without Docker Desktop, WSL 2.9.3 or later (cited). It needs WSL 2, so it removes no Windows requirement either. Treated as part of A (E7).

## 7. Option D: trusted-host mode as a last resort (no isolation)

What exists (verified in repo): trusted-host is refused unless the owner configured an authority; the launch record says the mode; the containment report records "refused without authority" and "reaches host files" as the shown exception; the launcher health notes can carry a standing warning. The Windows backend already says plainly that it depends on the session.

What the product must show if this is the only mode on a PC:
1. A persistent, unmissable banner in the owner's chat and the status pages: "Agents run with this PC's full user rights. They can read and change everything this account can, including files and saved credentials. Use a dedicated Windows account on a machine with nothing you cannot lose."
2. The mode in every task's audit record, in the plan card, and in the owner's task view.
3. Explicit configuration by the owner by name; never an automatic fallback when a stronger backend fails.
4. Recommended dedicated Windows user with a restricted profile; no browser sign-ins, no stored keys.
5. No claim anywhere that Windows is "isolated" or "qualified" for it; the release gate keeps treating it as an exception, not a pass.

It passes only the two controls; it fails the eight denial cases by definition.

## 8. Combinations

| Combination | What it gives | Cost |
| --- | --- | --- |
| Combo 1: Native (B) as the baseline everywhere; WSL2 (A) as an optional stronger tier when the PC supports it | Every Windows PC, Home included, gets real file and network confinement; owners who accept a virtualization and reboot step get Linux-level isolation | Two backends to maintain and qualify; the product must show which tier is active |
| Combo 2: B plus Windows Sandbox kept as an optional Pro tier | Reuses the work already built (A03b) for the owners who have Pro and an owner session | Third backend; the session-dependent warning stays; probably not worth more investment |
| Combo 3: A only | One mechanism, same as Linux | If the unattended start fails, there is no Windows isolation at all; excludes PCs without virtualization |
| Combo 4: B only | Smallest, works everywhere | Weaker than Linux; toolchain compatibility risk; no private network for routes |

## 9. Case-by-case: which of the 10 each option could pass

Legend: pass (expected), partial, no. All entries are predictions; none were run (unverified). "E#" names the experiment in section 11 that settles it.

| Case | A WSL2 | B1 AppContainer | B2 restricted token | B3 dedicated account | C2 per-task container | D trusted-host |
| --- | --- | --- | --- | --- | --- | --- |
| 1 control write own dirs | pass | pass if grants work (E2) | pass | pass | pass | pass |
| 2 control read own file | pass | pass (E2) | pass | pass | pass | pass |
| 3 deny write system | pass | pass | pass (not admin; low IL) | pass | pass | no |
| 4 deny write host path | pass | pass (no grant) | pass if the restricting SIDs exclude the owner SID | pass | pass | no |
| 5 deny symlink read | pass | pass: the target's ACL decides (E2) | pass: same | pass | pass | no |
| 6 deny symlink write | pass | pass | pass | pass | pass | no |
| 7 deny credential read | pass | pass for files; the environment is ours to clear | pass for files | pass for files | pass | no |
| 8 deny controller data read | pass | pass (no grant) | pass | pass | pass | no |
| 9 deny network loopback | pass (test judges adapters in a private network) | pass for connections; test variant needed (adapters still visible) | no without a firewall or WFP rule (E5) | no without a rule (E5) | pass with network none (test variant as B) | no |
| 10 deny write protected name | pass (bind mount) | partial: deny ACE plus rename/replace gap (E2) | partial: same | partial: same | pass (read-only bind of .git) | no |

C2 assumes the flags in section 6.4 on a Linux host and that the daemon is not reachable from the container; on macOS and Windows the same results hold inside the runtime's VM. C1 alone (agent tools in the controller's container) fails cases 5 to 8 and is not shown. Linux and macOS today pass all ten (verified in repo as the plan's claim; I did not re-run them here).

## 10. What each card would change (verified in repo: `task-plan.json`)

| Card | Today | If A (WSL2) | If B (native) |
| --- | --- | --- | --- |
| A03b Windows Sandbox launcher (planned; depends on A03; **rewritten 2026-11-25 to the native launcher, the "If B" column**) | The Windows backend; session-dependent | Replaced by a "WSL distro" launcher that reuses the Linux plan; scope shrinks to a service-account WSL start plus health | Replaced by a native launcher (token, AppContainer, ACLs, job, cleanup, health probe). The Sandbox launcher code stays as an optional Pro tier or is retired by owner decision |
| G05 isolation evidence per OS (planned) | Needs unattended service identity after logout and reboot | Same wording; WSL start must be shown after logout and reboot | Same wording; the native launcher is easier to run in hosted CI. Case 9 gets a native variant |
| G06 qualify actual Windows (planned) | Real Windows host | Unchanged; WSL adds "reboot with nobody signed in" evidence | Unchanged; path cases (Unicode, junctions, 260 chars) matter more because the agent works on real NTFS |
| Y02 QA checkpoint 2 (planned; blocks P02 and P03) | Needs Windows launcher on real Windows | Needs WSL path on real Windows | Needs the native launcher on real Windows and hosted CI |
| A08c per-agent limits on macOS and Windows (planned; needs A03b) | Windows: none enforced; Job Object does not bound a VM | Limits come from Linux groups inside the distro plus WSL memory and processor settings | The Job Object becomes the real mechanism: card scope gets simpler |
| H12r worker under Seatbelt and Windows Sandbox (planned) | Windows Sandbox | Worker inside the distro; Node installed there | Worker under the native launcher; Node install read-only |
| H12i controlled network routes (planned; needs A03b) | Sandbox networking "not proven private" | Works (private network) | No at first: `privateNetwork` false means routes refused on Windows; pipe relay is a later card |
| P02 isolated coding workspaces, P03 non-code adapters, Q01 deliverables (planned) | Wait on Y02 | Wait on Y02 | Wait on Y02 |
| Y01 QA checkpoint 1 (implemented) | No isolation dependency | No change | No change |
| Docker (C1, C2) | No card exists (verified in repo) | A WSL2-based container route has the same costs as A | Docker does not replace B; see section 6.6 for the cards that change (A03, A03b, A08c, G05, G06, Y02, H12r, H12i, D01, K02, X04 to X06) |
| X02, X06, K07, D03, D05 (planned) | Depend on G05, G06 or H12r | Windows release candidate must include the chosen backend | Same |

Rough effort, in cards of roughly one coder session each (my estimate, unverified):

| Option | Rough size | Adds |
| --- | --- | --- |
| B first slice (launcher, ACL grant and cleanup, job limits, health probe, case 9 variant) | 5 to 7 cards | N1 native launcher, N2 ACL manager and leftover sweep, N3 job limits (replaces the Windows half of A08c), N4 containment dialect, N5 installer and service account, N6 docs, N7 CI cell; replaces A03b |
| A (WSL tier) | 6 to 9 cards | W1 installer and distro image, W2 service-account start and keep-alive, W3 workspace move in and out, W4 lockdown settings, W5 backend plus health, W6 evidence, plus the unknown unattended start; replaces A03b |
| E1 (B then A) | B's cards, then A's, in that order | A decision point after B's first slice |
| D (warning mode only) | 1 to 2 cards | Banner, status, config, tests; no replacement |

## 11. What can be proven where

| Question | Owner's PC, with Pi (no UAC) | Needs one approval or a real service/boot | Hosted CI only |
| --- | --- | --- | --- |
| Create an AppContainer profile and start a child as non-admin | Yes | | Yes, probably (unverified) |
| ACL grants and the ten cases as a normal user | Yes | | Yes, probably |
| Job Object limits and kill-on-close | Yes | | Yes |
| AppContainer from a service in session 0, nobody signed in | | Yes: register a test service or startup task once, restart | Partly (a hosted runner is not a real boot) |
| Per-user firewall or WFP filter | | Yes: admin at install | Probably |
| WSL present, virtualization on, `wsl --status` | Yes (reading only) | | No (nested virtualization generally missing on hosted runners; unverified) |
| WSL start from a service and after reboot with nobody signed in | | Yes | No |
| Docker Desktop, Docker Engine or Podman already installed on the owner's PC; `docker info`; Home edition support | Yes (reading only; installing is a change and needs approval) | Install, if absent | No |
| Container backend cases (C2) on Linux and macOS, nested bubblewrap in a container | Not Windows | | Linux CI cell for Docker, yes; macOS runner has no Docker by default (unverified) |
| bubblewrap runs in the WSL kernel; the ten cases | Only after WSL is installed | Yes if WSL is not installed (admin, restart) | No |

The Windows-box agent instructions already tell the agent to be read-only and ask before any change (`windows-box-agent-instructions.md`), so the experiments below follow that: each says whether it changes anything.

## 12. Recommendation

> Note 2026-11-25: superseded in part by decision 5 (section 14): Windows Sandbox is not kept as a documented Pro option; no card builds or extends it. The recommendation below is kept as written on 2026-11-24.

**Choose combination 1, built in this order: B (native, Chromium-style) first, A (WSL2) later as an optional stronger tier.** Do not invest further in Windows Sandbox beyond keeping it as a documented Pro option.

Reasons:
1. B is the only candidate whose pieces are all documented to work for ordinary, non-admin, session-less code paths: AppContainer profiles need no admin, tokens and jobs are standard process APIs, and browsers ship this on Home (cited). The unattended-from-a-service question (E6) is the one gap, and it is cheap to test.
2. B needs no virtualization, no restart, no Linux image, and works on Home; the owner's requirement ("ideally Home") is met by B and met by A only on PCs with virtualization and a restart.
3. B gives a real Windows Job Object, which also finishes the Windows half of the resource-limits card honestly, something Windows Sandbox cannot do (verified in repo).
4. B's weakness is stated honestly: a shared kernel and ACL-based, not view-based, file control, in the same class as the macOS Seatbelt backend, which the product already ships with disclosed differences (verified in repo).
5. A keeps the strongest result but its unattended start is undocumented (cited gap), so it should be proven separately, not made the foundation.
6. **Docker does not change this choice for Windows** (section 6.7): a container on Windows still needs WSL 2 or Hyper-V underneath, so it removes no Windows requirement, adds Docker Desktop's edition list and licence if that is the runtime, and leaves the unattended-VM unknown in place. Docker Desktop's current page does not list Home.

**Docker, as a separate recommendation for Linux and macOS.** Package the product as a container image with Compose (C1) as a deployment option, as its own card family after the first release or alongside the Linux release candidate (X05). Keep bubblewrap and Seatbelt as the primary confinement. Treat per-task worker containers (C2) as an optional extra backend for hosts where bubblewrap is unusable, built only with rootless Docker or Podman or a minimal launcher helper, and never with a socket reachable from an agent. Do not run bubblewrap inside the same container as an agent unless the operator accepts a relaxed seccomp profile (nested tier, unproven).

Decision gate. After experiments E1 to E6, if B1 or B2 passes cases 1 to 9 with case 10 handled, build B. If B fails on toolchain compatibility (E4) or cannot be started from a service (E6), the fallback order is A (if E7 or E8 shows an unattended start), then D with the warnings in section 7.

### Smallest first slice: the experiment list for the Windows-box agent

Run order matters; each one is small. "Changes" says what the agent touches. None needs a UAC prompt except E6 and E9 (and an install in E10 if the owner wants one), which need one explicit owner approval each and are marked. Use PowerShell with `Add-Type` P/Invoke (the repo's Windows helpers already do this; verified in repo, `windows.ts`) so no compiler or addon is needed. Work only under `C:\nn-diag`, and never run as administrator.

| # | Experiment | Changes | Question it answers |
| --- | --- | --- | --- |
| E1 | Read facts: Windows edition and build, `wsl --status`, whether Virtual Machine Platform and WSL features are on, CPU virtualization, whether Pi runs at medium integrity, the user's own ACL on `C:\Users\<user>` and its parents | Nothing | What the PC already has; whether A is even possible without an install |
| E2 | As a normal user: `CreateAppContainerProfile` with no capabilities; make a scratch folder you own; grant the profile SID Modify on `work`, `home`, `scratch`; run `cmd /c` as the AppContainer in that work folder; try a read of a file outside, a write outside, a junction out, `.git` deny ACE with write, add, delete and rename attempts; then remove grants and the profile | Creates and removes one profile and folders under `C:\nn-diag` | Does B1 pass cases 1 to 8 and 10 (partial) with an ordinary process? Does the profile need traverse rights on parents? |
| E3 | The same as E2 for B2 (restricted token plus Low integrity) with a job, kill-on-close and an alternate desktop; plus: can the confined `cmd` or PowerShell see other processes' objects, open the Task Scheduler or Service Control Manager, and start a process as another identity? | Same | B2's case results and the "escape" probes in section 5.6; does a console program work on an alternate desktop |
| E4 | Toolchain check inside B1 and B2: run `node --version`, `git --version` and `git status` on a prepared checkout, `npm ci --ignore-scripts` and the repository's own tests with a recipe-style grant list; list every access-denied found | Writes inside the test folders only | How permissive the grants must be for real tools: the main compatibility risk |
| E5 | Network: confirm case 9 from B1 (connect refused to a local test listener; adapters still listed); show that B2 can connect (expected); check whether a per-account outbound block can be created without admin (expected: no); record exactly what admin would be needed | Nothing permanent | The network cut for B1, and the install-time cost for B2 and B3 |
| E6 (one approval) | Real service: owner approves one test Windows service or startup task that runs a small program as a dedicated low-privilege account (or LocalSystem for comparison); the program runs the E2 launch and writes a result file; restart the PC and sign in nothing; later read the file. Remove the service afterwards | Registers and removes one service or task; needs one admin approval, once | Can a service in session 0 launch B1 or B2 unattended? Which token works (the Q&A thread's failure case)? |
| E7 | If WSL is present (E1): in the owner's own user, `wsl --import` a tiny distro into `C:\nn-diag`, check `bwrap`, user namespaces and the ten cases' key ones; set automount, interop and path settings in its `wsl.conf`; test `wslc` if version 2.9.3 or later | Registers and unregisters one distro | Does A work as a user, and is `wslc` usable |
| E8 | If E7 passed: run the repository's containment suite pieces against the distro | Same | Case results for A |
| E10 | Read-only container facts on the owner's PC: is Docker Desktop, Docker Engine in WSL, or Podman installed; `docker info` or `podman info` output (names and versions only); the edition; is virtualization on. If a Windows Home PC is available, check whether Docker Desktop's WSL 2 backend installs there (installing needs owner approval and is a change) | Nothing unless the owner approves an install | Settles the Docker Desktop Home conflict; shows whether a container route would add anything on this PC |
| E11 (any Linux host, not the Windows box) | On the Linux dev server or a CI cell: run a container with the default seccomp profile and try `bwrap` inside it; then with a relaxed profile and rootless Docker or Podman; run the ten cases against a per-task container with the flags of section 6.4 | Starts and removes test containers | Proves the nested-sandbox failure, and whether C2 passes all ten on Linux |
| E9 (one approval, only if E7 and E8 passed) | Real service start of `wsl.exe` as a dedicated account after a restart with nobody signed in | Same as E6 | The unattended start for A: the key unknown for A |

Report format: for each, "observed" or "not tested", exit codes, durations, the first 20 lines of any error, and the exact access-denied paths. Never print tokens or secrets.

### 12.1 The service context: what the first own-hardware run showed, the ranked explanations, and what each round 5 outcome would mean (2026-11-25)

**Measured (own-hardware run 45634597880, the owner's Windows PC, build 26200, runner installed as a service).** The launcher's context: session id 0, elevated. The downloaded programs matched the hashes the hosted job built. The product launcher's `info` worked (a container profile is made: profile creation does work in session 0).
Every program started INSIDE the container then ended in about 30 ms with exit -1073741502 (0xC0000142, STATUS_DLL_INIT_FAILED): all fifteen experiment cells inconclusive, node as the first child, node run by cmd.exe, and the ten G05 cases 0/10 `not_run`. cmd.exe did start (it printed "Access is denied." when asked to run hostname.exe), so process creation itself and the container token work; programs that load user32 or need the desktop heap do not. The same programs pass on the hosted runner (interactive session 2, build 26100). Two things differ at once: the service context and the OS build.

**What the sources say (cited; what each states, no more).**
- Microsoft's archived Windows SDK blog on this error (https://learn.microsoft.com/en-us/archive/blogs/winsdk/what-is-up-with-the-application-failed-to-initialize-properly-0xc0000142-error) says the error comes from three actions (many applications, a different user, a different desktop), that CreateProcess succeeds and the exit code of the child shows it, that the cause is window stations and desktops (desktop heap exhaustion or desktop security), that services have smaller desktop heaps than the interactive desktop, and that the author no longer recommends editing the permissions of system window objects directly. It does not mention AppContainer.
- Microsoft KB 184802 (https://support.microsoft.com/kb/184802) (found by search; only its summary was read): user32.dll or kernel32.dll fails to initialise when the process lacks access to its window station and desktop, or when desktop heap runs out. Same reservation: not about AppContainer.
- Microsoft Q&A, "starting a process in an appcontainer from a service" (https://learn.microsoft.com/en-us/answers/questions/556403/starting-a-process-in-an-appcontainer-from-a-servi): a LocalSystem or LocalService service in session 0 could not start AppContainer children (cmd.exe worked; powershell.exe and java.exe ended with 0xC0000142); a token from WTSQueryUserToken or a logged-in user worked; Process Monitor showed user32.dll failing to initialise; enlarging the non-interactive desktop heap did not help; granting the AppContainer read access to the session 0 desktop and window station did. Community, one asker, the cause is stated as presumed. This is the closest match to our measurement.
- Microsoft's STARTUPINFO page (https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/ns-processthreadsapi-startupinfow) says lpDesktop is the name of the desktop, or of window station and desktop with a backslash; the older CreateProcessWithLogonW and CreateProcessAsUser pages (found by search, summary only) say NULL or an empty string means the child inherits the parent's window station and desktop. A service without the interactive flag runs on a non-interactive station named `Service-0x0-<logon id>$` (Microsoft's window station documentation, found by search; `Service-0x0-3e7$\Default` for LocalSystem). Explicit `WinSta0\Default` points at the interactive station, which a session 0 service cannot use. (An inference from these, not a quote: a NULL lpDesktop gives the child the service's non-interactive station, whose ACL does not name the container.)
- Microsoft's window station access rights page (https://learn.microsoft.com/en-us/windows/win32/winstation/window-station-security-and-access-rights) lists WINSTA_* rights and the generic mappings for interactive and non-interactive stations; GetSecurityInfo and SetSecurityInfo are the documented way to change the security descriptor of a window station. It says nothing about AppContainer.
- Chromium's sandbox design (https://chromium.googlesource.com/chromium/src/+/main/docs/design/sandbox.md) says the sandbox creates a third, never visible desktop for all target processes. It does not say how an AppContainer SID gets access to it; the page was not shown to cover it, so nothing is claimed about Chromium's AppContainer path here.
- Searches found no Microsoft statement tying 24H2 or 25H2 (builds 26100 and 26200) to AppContainer children, conhost or CREATE_NO_WINDOW. Unrelated reports of 0xC0000142 (a missing conhost.exe, SetConsoleActiveScreenBuffer, an OpenAI Codex sandbox-setup helper that ends with it; https://github.com/openai/codex/issues/34928, unresolved, no AppContainer or service detail) exist and are NOT used as evidence here. Windows build 26200 as a cause is therefore an open question, not a finding.

**Ranked explanations (by fit with the measurement; all unproven until the next own-hardware run).**
1. **H1, most likely: the container's SID has no access to the service's non-interactive window station and desktop**, so user32 cannot initialise. Fits: the 0xC0000142 code; cmd.exe starting while node, powershell and java do not (the Q&A's own split; the import tables in the next report say which programs load user32); the hosted interactive run passing (its window station is the interactive one, whose default ACL is not checked here; the report records both DACLs). Against it: nothing measured yet; the "Access is denied." that cmd printed for hostname.exe is not explained by it (it may be an ordinary access check on the image, see H4).
2. **H2: which desktop the child is attached to matters beyond the access** (NULL, empty and explicit names differ in what the loader connects to). Lower: the documented NULL and empty semantics are the same.
3. **H5: security software or code integrity** stops something in the child (an injected DLL that cannot initialise in a container, Smart App Control, AppLocker). Fits an owner's PC more than a hosted VM; would not depend on the desktop at all. The next report lists security products, the Smart App Control state and code-integrity and AppLocker events in the run's time window.
4. **H4: access control of the program's own folder** (node's install folder or system DLLs). Lower: a missing read right normally gives an access-denied status, not DLL_INIT_FAILED, and the grants read back correctly; but hostname.exe's "Access is denied." keeps it alive. Tested by a copy of node.exe and cmd.exe inside a granted folder and node with no grant.
5. **H3: the console flag** (CREATE_NO_WINDOW and the console host). Low: cmd.exe is a console program and started.
6. **H6: something specific to build 26200.** Cannot be tested from here; it is what remains if nothing else changes any step.
Desktop heap exhaustion is not a separate step: the Q&A reports that enlarging it did not help, and a fresh service session has plenty.

**What round 5 measures and what each outcome would mean** (`--mode session0`, 78 steps, experiments/windows-appcontainer/README.md "Round 5"; the same text is printed in every report):
| Outcome of the run | Meaning | Next slice |
| --- | --- | --- |
| node, powershell and the GUI program fail with `inherit`, work with `grant-full` (and with `new-desktop` or `new-station`); cmd.exe works either way | H1 supported (by this one machine and build) | The product launcher makes a window station and desktop of its own for each run (as Chromium does for its targets), gives only the container's SID access, passes them in lpDesktop and closes them afterwards: no change to the service's own objects, nothing persistent. Which level (read or full; station only, desktop only) is read from the `grant-read`, `grant-station` and `grant-desktop` steps. |
| works with `new-station` but not `new-desktop` | The window station is the part that matters | A dedicated station per run. |
| `grant-*` work, `new-*` do not (or fail to set up) | The launcher's own objects work but creating objects is refused in this context | Grant the minimum on the launcher's own station and desktop for the run and revoke it (this round's `grant-*` path), with its leftover risk if the launcher is killed. |
| works with `empty` or `winsta0` and no entry | H2: the attachment decides | Pass that lpDesktop value. |
| works only with another creation flag | H3 | Change the flag. |
| the copy of node.exe in the granted folder works, the installed one does not (or `node-nogrant` differs) | H4 | Grant the program folder as the product already does, check its inheritance; compare the DACLs. |
| nothing changes any step; code-integrity or AppLocker events or a security product are listed | H5 | An owner-side exclusion or a different PC; no product change helps. |
| nothing changes any step and no events or products explain it | H6 (build) or an unmeasured cause | Run the same launcher on a build 26200 machine in an interactive session to split service from build; or the E6 token variants (WTSQueryUserToken). |
| everything works, including `inherit` | Not reproduced | Compare the context with run 45634597880 (user, session, window station). |
A product fix is a SEPARATE slice after this measurement; the product launcher keeps its restrictions (no network capability, LPAC capabilities as before, kill on close, job limits) and, this round, no new options.

### 12.2 The Session 0 fix: a private window station and desktop for every run (2026-11-25)

**Measured (own-hardware run 45650543163, the owner's PC, build 26200, runner installed as a service, Session 0, elevated; 78 steps).** An AppContainer child started by the launcher with the service's default window station and desktop ended with 0xC0000142. It worked when the container had access to a window station AND a desktop: a read entry on the service's own two objects (the smallest change, 5 of 6 programs), a full entry on both, and, the cleanest, objects MADE FOR THE RUN (`new-station`: a window station and a desktop created per run with an access list for the container; node, cmd running node, powershell and hostname ran in about 50 ms and the service's own window objects were not changed). An entry on the station alone or on the desktop alone failed. An empty or inherited `lpDesktop` failed; `winsta0` worked but names the interactive station, which the product must never touch. The GUI program (wscript) hung in every working mode, which does not matter for node, npm and git. Clean-up was complete (profile deleted, no entry left). So H1 of 12.1 holds on that machine and build: the container had no access to the service's window station and desktop.

**Chosen fix (product launcher, `native/nn-launcher/src/privdesk.rs` and `winobj.rs`).** Every `run` makes a window station (`nn-ws-<64 random bits>`) and a desktop (`nn-d`) of its own, gives the container's SID one explicit allow entry on each with the measured masks (131967 and 131583), makes the station with CWF_CREATE_ONLY (an existing name is never opened), checks the access list it reads back against an allow list (exactly one flag-free entry for the container with the measured mask; otherwise only SYSTEM, Administrators, OWNER RIGHTS and the launcher's own token user and owner; no logon-session SID, no NULL list), passes `station\desktop` as `lpDesktop`, and closes the desktop and then the station when the run ends. The objects are CREATED with their final access list (second review, 2026-11-25): the launcher's token user and SYSTEM with every right of the type, plus the container's entry; nothing is written afterwards. The experiment instead created its station with the default list and then added the container's entry. The change was made because Microsoft documents the default two different ways (the CreateWindowStation page: "grants GENERIC_ALL access to all users"; the window-station security page: from the creator's token), and because any default leaves a moment between creation and the write. The container's entry and masks are the measured ones; the account's entry covers them, which an AppContainer access check needs (it grants only what both the user and groups and the package SID are granted). This exact list has not run on hardware yet. The launcher switches its own process window station for the one CreateDesktopW call (the call makes the desktop in the caller's station) and puts it back at once, checked, with a guard for every other path. Nothing of the service's own window objects is opened, named or written, and WinSta0 is never touched, so the experiment's grant modes are not in the product. Failure is typed and closed: stage `grant`, message starting `window objects:`, nothing started. `info` makes and closes one private station and reports `windowStation: "private"` and `windowStationOk`, and fails with the same stage when it cannot, so the backend's health check names the reason instead of the confinement probe failing with an exit code. The same code runs in an interactive session. The hosted workflow's product steps check that `info` reports it.

**Residual risks (stated, not hidden).** (1) The container sees only its private station: no shared clipboard or atom table with the user, and no visible window; a program that needs one is unsupported (node, npm and git do not). (2) The masks are the full window-station and desktop rights the experiment measured; they were not reduced because nothing smaller was measured. The objects exist only for one run and only the container and the launcher's own account can reach them. (3) A launcher killed between making and closing the objects leaves them until their last handle closes (the child is ended by the job's kill-on-close, the launcher's own handles go with its process): there is no entry on a shared object to remove. (4) Desktop heap: each private desktop takes a little non-interactive desktop heap for the run; many parallel runs on one machine were not measured. (5) The product's own code path was only type-checked from Linux; the first real run of it is the own-runner G05 step after this change. (6) OPEN, design level: Microsoft's CreateWindowStation page says "Only members of the Administrators group are allowed to specify a name". The design and the installer run the worker as the non-administrator account `nimblenewt-worker`, and the measurement ran elevated. If the statement holds, the product's named station cannot be made under that account and every confined run fails closed with stage `grant` (message: access denied, "only members of Administrators may name a window station"; `info` and the health check say so). A NULL or empty name is not a way round it: Microsoft documents that the system then names the station after the caller's logon session, which for a service is the station it already has, and CWF_CREATE_ONLY would refuse it (without the flag it would OPEN the service's own station, which the product must never change). No other documented API was found. Unmeasured: the own-hardware non-administrator proof must show what happens; if it fails, the options are a station made by an administrator-held component for the worker, or another approach, and that is a decision, not a launcher tweak. (7) The read-back has not run on hardware yet. The DACL is the launcher's own creation list, so a principal it does not expect would mean Windows added one; that stops the run with the SID named. Mask normalisation is not expected: the masks hold no generic bits, so nothing is mapped when the descriptor is stored, but the exact-mask read-back is first proven by the own-runner run.

### 12.3 The worker as the non-administrator account: the unit, what it cannot promise, and the proof to run (2026-11-25)

**The unit (built, text only).** `packages/controller/src/release/worker-service-unit.ts` generates a Task Scheduler task for the worker (`scripts/remote-worker.mjs`, which builds the sandbox launcher from the four `NIMBLENEWT_WIN_*` names): principal = the installer's account `nimblenewt-worker`, logon type S4U, LeastPrivilege, no password element; a boot trigger with a 1 minute delay (no logon trigger); no execution time limit; one instance; start when available; 3 restarts 1 minute apart; explicit working directory; `node --env-file=<DataDir>\worker.env <entry> --config <worker.json>`; no value in the XML but paths. The element order and limits were checked against Microsoft's Task Scheduler XSD (https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-schema: the task, settings and principal are `xs:all`; a trigger is a sequence, Enabled first and Delay last; Command and WorkingDirectory at most 260 characters). An administrator registers it; no code here registers anything. The controller's own Windows unit is unchanged.

**What S4U is, and what it is not (cited).** Microsoft's Principal.LogonType page (https://learn.microsoft.com/en-us/windows/win32/taskschd/principal-logontype): "When an S4U logon is used, no password is stored by the system and there is no access to either the network or encrypted files." That is the whole statement read; it does not say whether the user's profile is loaded, which window station the process gets, or whether an AppContainer can be created. The account needs the batch logon right (the installer grants it and denies the interactive, Remote Desktop and network rights, so S4U is the only way it logs on). What is therefore NOT promised by the unit: network credentials of the account; EFS files; any visible window; and, below, the two unproven items.

**Two unproven items, one probe.** (a) Whether the S4U token of a non-administrator can create the AppContainer profile (`info` of the product launcher; measured only elevated, in Session 0, as the runner's service account). (b) Whether the same token can make the named private window station (risk 6 above: Microsoft's CreateWindowStation page says only Administrators may specify a name). Nothing measured so far answers either, because every measured run was elevated. (c) OPEN, registration: Microsoft's "Security Contexts for Tasks" page (https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks, "Security for Registering Tasks") lists registering a task "under the security context of a different user's account" with the S4U logon type among the cases where an administrator must specify a password. The unit and its steps assume none is needed (the account's password is not kept). Whether `Register-ScheduledTask -Xml` with this S4U principal and no user or password option is accepted is not documented either way beyond that sentence; step 2 below (the probe registration) answers it first. If it is refused, fallback 4 (a virtual service account, or the stored-password form) or the others are a decision, not a quiet change.

**The proof procedure (own-hardware workflow DESIGN; not added, not run; the installer run needs Rob's explicit go-ahead).** A hand-started own-runner job, written like the existing one, would do, in this order, each step reporting to a redacted file and each ending with clean-up under `if: always()`:
1. `Install-NimbleNewtLauncher.ps1 -Action Verify` (nothing installed yet), then `-Action Install` with the built launcher and its recorded hash (real, elevated; this creates the account and folders), then `-Action Verify` again (account, rights, access lists).
2. Register a PROBE task, not the worker: the same generated XML with the boot trigger removed and the action replaced by a small node script, same S4U principal and account. The probe writes into the control folder (the only place the account may write): the token facts (`whoami /groups /priv`, elevation, integrity level, session id, window station name), then `nn-launcher.exe info` and `check` (profile creation, private station), then the ten G05 cases through the native backend (the same runner the hosted job uses). `Start-ScheduledTask`, wait on the task's state (not a fixed pause), read the file back as the runner, unregister the probe.
3. Register the real worker task from the generator's text with a probe configuration, reboot the machine (or restart the runner's host service so that no one is signed in; a real reboot is the honest test), and read the heartbeat or launcher `info` the worker wrote after the boot trigger fired. This is the "nobody signed in, after reboot" item.
4. Uninstall (the script's own removal), `Verify` again to show nothing is left, and unregister the tasks.

**What each outcome means.**
| Outcome of step 2 | Meaning | Next |
| --- | --- | --- |
| `info` ok with the private station and the ten cases pass | Risk 6 does not bite for an S4U non-administrator (on that machine and build), and profile creation works | The unit is the design; register the worker task; record the build |
| `info` fails with stage `grant`, "access denied", naming the window station | Microsoft's statement holds: a non-administrator cannot name a station | A design decision, options below |
| `info` fails earlier, creating the profile (access denied or file not found) | The S4U token has no usable profile or registry hive for the account | Load the profile first (needs privileges the account lacks) or a different logon type, see options |
| registering the probe is refused (a password is asked for, or access denied) | (c) holds: an administrator cannot register an S4U task for this account without its password | A design decision: fallbacks below (4 in particular); never store the password quietly |
| the task never starts, or ends before writing | Batch logon right, a deny right or a task-settings problem; the Task Scheduler's last result code says which | Fix the right or the unit; not a design change |
| profile and station work, but containers end with 0xC0000142 again | A different cause than the station (12.1 H2 to H6) | Repeat round 5's measurements as this account |
| step 2 passes but step 3 fails (no start after boot) | The boot trigger, the delay or StartWhenAvailable, or the batch right at boot | Fix the unit; read the Task Scheduler operational log |

**Fallback designs if the station cannot be named by the account (described, not implemented; each is a decision for the owner, none is a quick change).**
1. *An elevated component makes the stations.* A small, separately installed helper that runs with administrator rights (a Windows service, or a scheduled task that runs as an administrator or SYSTEM) creates the window station and desktop for each run with the final access list (the container, the launcher's account, SYSTEM) and keeps them open while the run lasts; the unprivileged launcher passes their names in `lpDesktop`. The helper is a new privileged process and so a new attack surface (it must accept requests only from the worker account and name nothing the caller chooses); it can never be part of the sandbox's trust. Whether the account's CreateProcess may open a station an administrator made is unmeasured.
2. *The launcher runs elevated only for that step.* A launcher the worker starts through a one-shot elevated task for station creation, then handing the names to the unprivileged process. Same attack-surface point, smaller helper.
3. *Grant on the account's own objects.* The `grant-*` modes of the experiment (an entry for the container on the service context's own station and desktop, revoked after the run) worked elevated. A non-administrator can change the list of an object it owns; unmeasured here. Its cost is the one the plan already names: an entry stays on a shared object if the launcher is killed.
4. *A different logon.* A real Windows service with a virtual service account (`NT SERVICE\NimbleNewtWorker`, no password, the installer's `-ServiceLogon`) or the stored-password task form (Windows keeps the password in the task's credential store, which breaks "never stored"). Neither is known to change the window-station rule.
5. *Do not run the worker unattended as a non-administrator.* The measured elevated configuration (all ten cases pass) with its weaker account separation, or the other options of section 3 (WSL2, containers).

### 12.4 One container profile per run, and how many runs at once (2026-11-25)

**What changed.** Until now every run used ONE profile name (`NimbleNewtAgent`), so every run had one container SID: the file entries, the private window station's entry and the program's token all carried the same SID. That is why the backend took one exclusive run lock and ran one confined program at a time: a second run would have shared the first run's SID, so its program could have reached the first run's folders, and one run's revoke would have removed the other's entries. Now each run makes its OWN profile, `NimbleNewtRun-<64 random bits as 16 lower-case hex digits>` (30 characters; CreateAppContainerProfile allows 64 and the pattern `[-_. A-Za-z0-9]+`, both cited from Microsoft's page), derives its SID from that name, grants and revokes entries for THAT SID only, makes the private window station with THAT SID's entry (the measured masks are unchanged), starts the program, revokes and reads back, deletes the profile and checks that it is gone. The backend chooses the name; the launcher only validates it.

**The product launcher's surface after the change (tightened, nothing loosened).** The only name the product accepts is `NimbleNewtRun-` and exactly sixteen lower-case hex digits, for every command; there is no default name any more (`--name` is required), and `NimbleNewtAgent`, the experiment's name and every near miss are refused at the argument check. `run`, `info` and `delete-profile` need `--profile-record PATH`, a file in the supervisor's control folder (no container can write there). `check` and `revoke` only DERIVE the SID from the name (they never make a profile, and the profile may already be gone: the entries for its SID are still there to remove) and may carry `--sid` as a cross-check that must equal the derived SID. One command is new in the product, `delete-profile --name N --sid S --profile-record P`, and it deletes only with proof: the name has the per-run form, the record file holds that name and the SID that DeriveAppContainerSidFromAppContainerName gives for it now, and the `--sid` is the same. The record is written by the launcher itself, create-new, BEFORE it makes the profile (the SID is derived first, so the record already holds it), so a crash between the two leaves a record with no profile (harmless: Microsoft documents that deleting a profile that does not exist succeeds), never a profile without a record. A profile that already exists is never adopted. Nothing scans the machine's profile list or the registry.

**Order of one run, every path out.** Backend: pick the name; take a run slot; claim the task folders; sweep earlier leftovers; write the backend's record (`profiles\<name>.json`: name, run id, job folder, process, time, the grants and the folders); launcher `run` (record, profile, window station, grants, job, program; then revoke, close the objects and the job, and delete and check the profile ONLY when every grant is revoked and read back); backend: read the grants back by the run's own SID (`check --name N --sid S`), delete the profile itself with `delete-profile` when the launcher's line does not show it deleted AND gone, remove both records only then. A delete or a "gone" check that cannot be shown is a typed failure, `nn-native-failure: profile`, the records and the job folder stay, and the next run (or the health check) sweeps first and does not start while the leftover cannot be cleaned.

**The sweep.** Keyed by the backend's own records, per SID: for each job folder whose runner is gone, and each `profiles\<name>.json` whose writer is gone, the entries of THAT run's SID are revoked and read back (seals last, as before), the profile is deleted and checked, the records are removed. Without the launcher's record nothing was ever made (nothing to revoke or delete: the backend's record is dropped); a launcher record without the backend's record, a name that is not a per-run name, a record whose own name is another's and a record in the wrong format are left exactly as found and reported, and the launcher is not called at all.

**Can the run lock be relaxed? Reasoned from the code.** Every shared resource, one by one:
- The container SID, the file entries for it, the private window station's entry and name, the job object, the profile: per run now (random names, unnamed job).
- The job folder, the in/out/err files, the channel files in the task's scratch: per run id.
- The runner's own temporary folder (`<control>\tmp`): shared, but only node's own random temporary names; not a SID or ACL matter.
- The task's workspace, home and scratch: the workspace holds the `modify-root` entry and the SEALED protected names (a PROTECTED DACL on `.git`, made and lifted per run). Two runs in the SAME workspace would race on the seal and the workspace entry: one run's revoke lifts its seal (the folder inherits again) under the other's running program. So the same workspace, or one inside or around another, is refused as busy: every run writes a claim file for its three task folders first, then reads the others' claims; of two contenders at least one sees the other (both backing off is allowed), a claim whose writer is gone is not counted (the sweep deals with it). Different workspaces do not touch each other.
- The program folders (the Node installation) and read-only inputs: SHARED by design. Every run adds, then removes, its own SID's entry in the SAME folder's DACL by reading the DACL, changing a copy and writing it back (`SetNamedSecurityInfo`). Two launchers doing that at once can lose an entry (a soft read grant, which only fails that run) or, worse, write back a stale list that brings a removed entry for a DELETED profile's SID back, leaving a litter entry the read-back of the other run never sees. This is not per run. It is made safe, on paper, by one machine-wide named mutex (`NimbleNewtAclWrite`, no `Global\` prefix) taken around every DACL read-modify-write the launcher makes (`change_ace`); a launcher that cannot take it in two minutes fails that grant or revoke. UNMEASURED: nothing has run two launchers at once, and the mutex's scope (per logon session) and default security are only reasoned.
- The desktop heap and the cost of a profile make and delete: unmeasured.

**Decision: `maxConcurrentRuns`, default 1.** The limit is `NIMBLENEWT_WIN_MAX_RUNS` (the operator's own setting, not written by the installer) or the `maxConcurrentRuns` option, a whole number from 1 to 4. The default stays ONE, and with one the behaviour is the old one: one slot (`locks`), one run, a second run busy. Above 1 the backend keeps one slot folder per run (`locks`, `locks-1`, ...) and the per-workspace claims; the health note and the audit say "UNMEASURED on real Windows". The plan's two pipelines per project can therefore be enabled only by someone who sets the variable on purpose, after the measurements below.

**What only real Windows can show (nothing here has run on Windows).**
1. `CreateAppContainerProfile` and `DeleteAppContainerProfile` per run: time, and any leftover in the registry or the profile folder (Microsoft: close file handles in the profile's folders before deleting, or the storage may not be completely removed; if the delete fails the status is undetermined, call again, which the launcher does once).
2. The "gone" check: after the delete the launcher calls `GetAppContainerFolderPath` on the SID; the documentation lists only S_OK and E_INVALIDARG, so the reading that a deleted profile makes the call fail is NOT documented. If it succeeds for a deleted profile, every run will report "not gone" and fail with the typed `profile` reason (fail closed, unusable): that is the first thing to look at on hardware.
3. Whether a per-run SID with no profile (after the delete) still takes `SetNamedSecurityInfo` and `GetNamedSecurityInfo` without a name lookup problem (the revoke after the profile is deleted relies on it; the launcher deletes the profile only after its own revoke, and the backend's read-back runs after that).
4. Two launchers at once: the ACL mutex, two private window stations, desktop heap use with N containers, the cost of N profiles, and whether both programs run to completion.
5. Whether a non-administrator S4U account (12.3) may create and delete profiles at all (the same question as 12.3 (a), now asked twice per run).

**What remains unchanged and still open:** 12.1 to 12.3.

## 13. What we would tell users

> Note 2026-11-25: draft wording from 2026-11-24, not user documentation. The Home statement is not yet true: no run on a Home edition exists (the hosted runs were a Server edition), so user text may say it only after A03b's Home run. The Pro paragraph's mention of Windows Sandbox is superseded by decision 5.

On **Windows Home**: "NimbleNewt isolates agents on Home with Windows's built-in app sandbox features (a restricted account and file permissions). It is weaker than the Linux isolation, because Windows has no separate private view of your files, so agents can only be kept out of places Windows permissions protect. The Windows Sandbox feature is not available on Home. If you want Linux-level isolation, turn on WSL 2 (needs virtualization and a restart). Until a confined start works on this PC, agents will not run unless you choose the clearly labelled no-isolation mode, which runs them with this account's full rights."

On **Windows Pro, Enterprise, Education**: the same default as Home. Windows Sandbox is available there but needs an owner session or automatic login and is not recommended as the main route; WSL 2 gives the stronger tier. Pro and above also allow Hyper-V virtual machines if the owner wants to supply their own Windows guest, but NimbleNewt does not require one.

On **Linux and macOS with Docker**: "You can run NimbleNewt from a container image. The agents' tools are still confined by bubblewrap (Linux) or Seatbelt (macOS), or by a separate per-task container, not by the image itself. On macOS, Docker Desktop runs containers in a virtual machine and its licence terms apply to larger organizations. A container does not make Windows isolation unnecessary: on Windows it needs WSL 2 or Hyper-V underneath."

The statement of what is and is not protected (both editions): files outside the agent's folders, the controller's data, saved credentials and the network are protected as tested by the ten containment cases for the commit in use; a Windows bug could still escape a native sandbox, because the PC's kernel is shared; the report names the tier in use.

## 14. Decisions the owner must make

**Status 2026-11-25: all seven decided by delegation. ASSUMPTION 2026-11-25: the owner delegated these (nothing waits on him) and each takes the recommended answer, "yes", with the scope noted. The owner can overrule any of them at any time; an overruling changes the cards named in the notes entry "Native Windows plan revision", not the experiment.** The experiment (`experiments/windows-appcontainer/`, rounds 3b and 4 in `implementation-notes.md`) showed the native route is viable without Windows Sandbox, so decision 5 is taken on evidence, not only on the recommendation.

| # | Decision | Decided 2026-11-25 (by delegation) | Cards it changes |
| --- | --- | --- | --- |
| 1 | A weaker-than-Linux native baseline is the Windows default, labelled as such | Yes. The native launcher is process-level and weaker than Linux's (the kernel is shared); the first release accepts that, and every launch record, the audit log and the docs say so plainly | A03b, G05, Y02 |
| 2 | One administrator approval at install | Yes, once: the service account, the service registration and the folder rights. Nothing at run time, no UAC prompt | A03b |
| 3 | No network route for Windows agents at first release | Yes. The container has no network capability, loopback is never exempted, and a recipe with a route is refused on Windows with a message saying so | H12i, A03b |
| 4 | Trusted-host (no isolation) mode on Windows | Off by default; never automatic; shown as in section 7 | A03b (unchanged elsewhere) |
| 5 | Retire Windows Sandbox as the main plan and stop the autologon work | Yes. A03b no longer implements the Sandbox launcher or an autologon/lock mode; the existing Sandbox code is not extended | A03b, H12r, A08c |
| 6 | A Docker image on Linux and macOS | After the first release, as a deployment option; no per-task container backend in this plan; none for Windows isolation | none now (no card created) |
| 7 | Docker naming in the docs | Name Docker Engine and Podman; mention Docker Desktop only as the user's own choice | docs only |

The text below is the original question and recommendation for each, kept for the record.

Only true product and security tradeoffs; everything else is my call (ASSUMPTION lines follow).

1. **Is a weaker-than-Linux native baseline acceptable as the default on Windows**, labelled as such, with WSL 2 as the optional stronger tier? (Recommended: yes.) If no, Windows needs a VM and Home is excluded.
2. **Is one administrator approval at install acceptable** for a dedicated service account, service registration and a firewall rule? (Recommended: yes, once; AppContainer alone needs none.)
3. **Is no network route for Windows agents acceptable at first release**, so tasks that need web or local-server access wait for a Linux or macOS host until a pipe relay is built? (Recommended: yes for first release.)
4. **May the no-isolation trusted-host mode be offered on Windows**, on the condition that it is never automatic and is shown as in section 7? (Recommended: yes, off by default.)
5. **Retire the Windows Sandbox route as the main plan** (keep it as an optional Pro tier, stop the autologon work)? (Recommended: yes.)
6. **Release a Docker image (C1) as a supported deployment on Linux and macOS, after the first release, and is a per-task container backend (C2) wanted at all?** Product scope and security tradeoff: C2 adds a root-equivalent daemon. (Recommended: C1 yes, as a deployment option; C2 only as an optional backend later; neither for Windows isolation.)
7. **Docker Desktop licence**: the owner's own use is below Docker's thresholds only if the organization has fewer than 250 employees and under 10 million USD revenue (cited). Is a Docker Desktop dependency acceptable for users who may be above them, or should the docs name Docker Engine, rootless Docker and Podman only? (Recommended: name Engine and Podman; mention Desktop only as the user's own choice.)

ASSUMPTION: for a Docker release I took the smallest reversible scope: image-based deployment first, no per-task container backend and no daemon socket exposure to any agent container. I did not need an owner answer for the rest of these, and took the smallest reversible choice. The native option runs under a dedicated low-privilege service account, not LocalSystem. Workspaces on Windows must be on NTFS. No loopback exemption is ever added. WSL work is deferred until the native slice results are in. The containment suite's case 9 gets a native variant only through a reviewed card, not as part of this plan.

## 15. Sources

Cited on 2026-11-24 (Microsoft Learn unless noted):
- Windows Sandbox overview and editions: https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/
- WSL FAQ (Home support, production caveats, import/export, WSL container API recommendation): https://learn.microsoft.com/en-us/windows/wsl/faq
- WSL manual install (features, virtualization, restart, admin): https://learn.microsoft.com/en-us/windows/wsl/install-manual
- WSL configuration (`wsl.conf`, `.wslconfig`: automount, interop, boot, networkingMode, idle timeouts, memory): https://learn.microsoft.com/en-us/windows/wsl/wsl-config
- WSL container (`wslc`, API, WSL 2.9.3): https://learn.microsoft.com/en-us/windows/wsl/wsl-container and settings https://learn.microsoft.com/en-us/windows/wsl/wsl-container-settings
- WSL in production on Windows Server 2025, unanswered discussion: https://github.com/microsoft/WSL/discussions/14261
- Unable to start WSL from a Scheduled Task (Microsoft Q&A, community): https://learn.microsoft.com/en-us/answers/questions/1184579/unable-to-start-wsl-from-a-scheduled-task
- AppContainer isolation: https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation
- AppContainer for legacy apps: https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-for-legacy-applications-
- Launch an AppContainer (profiles, capabilities, LPAC): https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer
- Starting an AppContainer process from a service (Microsoft Q&A, community; the asker's own accepted answer: user32 failed to initialise, fixed by granting the AppContainer read access to the session 0 desktop and window station; not confirmed by Microsoft): https://learn.microsoft.com/en-us/answers/questions/556403/starting-a-process-in-an-appcontainer-from-a-servi
- Loopback and network isolation: https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/troubleshooting-uwp-firewall
- Job Objects: https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
- Chromium Windows sandbox design: https://chromium.googlesource.com/chromium/src/+/main/docs/design/sandbox.md (library: `sandbox/win`)
- Firefox: Mozilla sandbox architecture https://wiki.mozilla.org/Security/Sandbox/Architecture; USER_RESTRICTED, Bugzilla 1403931 https://bugzilla.mozilla.org/show_bug.cgi?id=1403931; untrusted integrity, Bugzilla 1831036 https://bugzilla.mozilla.org/show_bug.cgi?id=1831036; default DACL escape, Bugzilla 1618911 https://bugzilla.mozilla.org/show_bug.cgi?id=1618911; Project Zero on CVE-2020-12388 https://projectzero.google/2020/06/ff-sandbox-escape-cve-2020-12388.html
- Docker Desktop on Windows (editions listed, WSL 2.1.5, admin, per-user install, no automatic start, `--always-run-service`): https://docs.docker.com/desktop/setup/install/windows-install/
- Docker Desktop licence (250 employees and 10 million USD thresholds): https://docs.docker.com/subscription/desktop-license/
- Docker rootless mode (subordinate ids, systemd user service, linger): https://docs.docker.com/engine/security/rootless/
- Docker Engine security (namespaces, cgroups, default capabilities, daemon attack surface): https://docs.docker.com/engine/security/
- bubblewrap inside containers (community and bug reports): https://discourse.flathub.org/t/error-running-flatpack-in-dockerfile/1636, https://bugs.launchpad.net/ubuntu/+source/apparmor/+bug/2069526, https://github.com/docker/labs/blob/master/security/seccomp/README.md
- Podman on Windows (WSL 2 or Hyper-V machine; WSL 2 only on Home): https://podman-desktop.io/docs/installation/windows-install and https://blog.podman.io/2024/06/the-new-hyper-v-option-in-podman-windows-installer/

Not retrieved and therefore not claimed: Docker's full licence wording, Docker rootless known-limits section, Docker Desktop on macOS pages, Podman rootless pages, Docker's default seccomp profile contents, Hyper-V isolation of Windows containers on client editions, Mozilla's own sandbox documentation page (404), the speed of DrvFs shares, and anything about the current behaviour of `wsl.exe` under a service account.
