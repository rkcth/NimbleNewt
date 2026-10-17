# Windows unattended worker and Sandbox investigation — October 16, 2026

> Historical feasibility research, October 16, 2026. Statements about future research gates are superseded by the current implementation plan. These reports do not qualify NimbleNewt production code. Raw machine-local fixtures remain in the research workspace; paths below identify historical evidence, not shipped dependencies.

## Scope and correction

The initial conclusion that a separate Windows VM might be necessary was premature. The installed Sandbox client can start a guest and execute commands from SYSTEM in session 0. Two distinct failures have now been reproduced: an output-folder access denial while an owner session exists, and a separate VM-management activation-identity failure after reboot with no interactive user. Background session-0 success alone did not establish unattended startup. See the no-login results below.

No Windows evaluation image was downloaded or installed. The owner declined that option. No additional Windows guest license was purchased or assumed. The existing Sandbox feature and Microsoft client 0.8.107.0 were used on Windows 11 Pro 10.0.26200. Full Hyper-V features were enabled during the alternative-path investigation and remain enabled; no dedicated Hyper-V VM was created. The minimum required feature set has not been isolated.

## Controlled comparisons

1. A SYSTEM scheduled task in session 0 could list environments when the packaged `wsb.exe` was launched with its package directory as the working directory. The first probe used the wrong working directory and could not find `WindowsSandboxServer.exe`; correcting that resolved this separate launcher issue.
2. The full test with an output directory restricted to SYSTEM and Administrators failed with HRESULT 0x80070005 / E_ACCESSDENIED.
3. A minimal configuration without mapped folders started successfully, executed `cmd.exe /c exit 0` as guest SYSTEM, and stopped successfully, also under host SYSTEM/session 0.
4. Repeating the original full configuration after the minimal success reproduced the access denial. Thus enabling Hyper-V/reboot alone did not fix that configuration.
5. Moving only the guest output directory to the existing owner-accessible research folder allowed all seven Node/isolation smoke assertions to pass.
6. Keeping the output directory under the protected ProgramData research root, but adding an explicit Modify grant for Robert to that individual output directory, also passed all seven assertions. The host scripts and supervisor directory remained writable only by SYSTEM/Administrators. No Everyone grant or broad host-directory permission change was made.

This establishes a mapped-output access-permission/configuration cause for the reproduced error. It does not establish precisely which internal broker token performs the denied check. Do not turn the fixture's hardcoded Robert grant into a product rule: the installer must establish and qualify explicit service/owner identities and narrow per-job mappings. A separate passwordless S4U-user probe timed out at environment listing; that path is not qualified and its cause remains undetermined.

## Independently completed boot and lease test

A bounded Node 22.20.0 fixture ran automatically as SYSTEM in session 0 following an actual laptop restart. Its metadata recorded no interactive users. It admitted synthetic local work only after the Linux primary fixture granted a lease; the primary then stopped renewing leases by returning service-unavailable responses. The supervisor stopped the child process tree 2,154.5 ms after its last successful renewal for a 2,000 ms lease, within the fixture's 3,000 ms bound. The tick file remained unchanged over a further one-second observation.

This proves that a Node host supervisor can start before desktop login and enforce the tested renewal-expiry case. It is not a complete remote-worker protocol, a true network partition test, authenticated transport, primary fencing proof, or durable task resumption. The child was a synthetic host process; it was not an agent executing arbitrary commands. The boot trigger was removed after collecting its evidence. The temporary Linux primary was bounded and terminates automatically.

Evidence: boot identity (`research-workspace/evidence/windows-unattended/boot-host.json`, historical local evidence), worker result (`research-workspace/evidence/windows-unattended/boot-worker-report.json`, historical local evidence), minimal SYSTEM Sandbox result (`research-workspace/evidence/windows-unattended/sandbox-system-minimal-report.json`, historical local evidence), original mapped-folder failure (`research-workspace/evidence/windows-unattended/sandbox-system-mapped-report.json`, historical local evidence), S4U timeout (`research-workspace/evidence/windows-unattended/sandbox-s4u-report.json`, historical local evidence).

## Design implications

- Keep Windows Sandbox as a candidate for unattended Windows jobs; a second installed Windows VM is not established as necessary.
- Separate the trusted host supervisor and its installation files from guest-writable result staging. Never execute scripts from result staging as host SYSTEM.
- Resolve and verify the installed Microsoft package and executable working directory; reject unsupported/missing versions rather than silently dropping isolation. The research fixture pins one path; the production implementation must discover and validate it.
- Provision only required input/output shares with explicit identities. Inputs remain read-only inside the guest. Results are untrusted until validated and admitted by the primary.
- Have the background supervisor own launch, bounded command execution, lease expiry and teardown. A desktop is optional for debugging, not an assumed execution dependency.
- Gate worker capacity on successful unattended preflight. Startup failure must leave capacity unavailable and yield a chat-visible diagnostic.
- Qualify crash cleanup, update/reboot recovery, missing identity/share permissions, path/reparse escapes, actual network partitions, and sandbox termination with work in flight before release. Smoke success does not close all G05/G06 requirements.

Microsoft references: [Sandbox CLI](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli) and [mapped-folder configuration](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file). The CLI provides start/exec/stop; mapped host folders must exist and writable mappings persist host changes. Neither document alone guarantees our unattended scenario; executed evidence is required.

## Actual no-login reboot result

The laptop rebooted at 19:21:24.5 local. The corrected-ACL fixture automatically started at 19:21:46.2 as SYSTEM in session 0 and explicitly observed no interactive user. Listing environments succeeded, but fresh sandbox creation failed with **0x8000401A**, “The server process could not be started because the configured identity is incorrect.” Repeating the minimal no-shares configuration without login produced the same error. Thus the mapped-folder correction does not solve the distinct no-login activation failure.

Read-only runtime registration inspection identifies `Windows.Internal.Security.Isolation.ManagedWindowsVMServer`, executable `C:\Windows\System32\ManagedWindowsVM.exe`, with `IdentityType=5`. The pinned OleViewDotNet diagnostic source maps 5 to `ActivateAsActivatingUser` (not an enum literally called InteractiveUser). This is a useful activation-identity lead, not proof of which internal call produced the error. Registry settings were not modified. Unrelated DCOM warnings are not treated as causal evidence.

A second S4U-user attempt without login timed out while a SYSTEM-owned controller from the earlier test remained. That is potentially confounded by cross-account IPC ownership; a clean-controller retry is recorded separately. No automatic sign-in, stored owner password, global COM permission change, or second Windows installation was introduced.

## Final disposition of this investigation

The clean-controller S4U retry also timed out at listing. A temporary standard account with a random locally generated credential was registered for a password-backed batch task; Task Scheduler never recorded a run (result 267011 / task not yet run), so that comparison is **inconclusive**, not a Sandbox launch failure. The account and its task were removed. The SYSTEM/S4U qualification task and earlier boot trigger were removed too; the final process check showed no Sandbox processes. No persistent automatic login or owner credential storage was configured. The temporary primary fixture exited normally.

**Conclusion:** we have a demonstrated background Sandbox path **while an owner session exists**, and a demonstrated background Node supervisor before login. We do **not** have a qualified fresh Sandbox launch before any user signs in. The latter fails with a distinct activation-identity error even without shared folders. These results do not prove that all possible no-login approaches are impossible, but do not support making one a release promise today. The current accepted fully unattended isolation requirement remains open.

Do not require purchase of another Windows license on the basis of these tests. Further work can pursue a supported service-account/activation path or a Microsoft fix with this minimal reproduction. A session-dependent deployment could reuse the existing Windows license, but requiring login after reboot changes the accepted requirement. Automatic login plus locking is also a material security/operations choice, not a default remediation; it has not been configured or tested. A separate Windows VM remains only an optional alternative requiring its own deployment/licensing review, and the owner declined evaluation media.

Reproduction evidence: corrected ACL success with owner session (`research-workspace/evidence/windows-unattended/sandbox-outputacl-report.json`, historical local evidence), owner-directory success (`research-workspace/evidence/windows-unattended/sandbox-useroutput-report.json`, historical local evidence), startup failure without login (`research-workspace/evidence/windows-unattended/sandbox-no-login-report.json`, historical local evidence), minimal no-login failure (`research-workspace/evidence/windows-unattended/sandbox-no-login-minimal-report.json`, historical local evidence), clean S4U timeout (`research-workspace/evidence/windows-unattended/sandbox-no-login-s4u-clean-report.json`, historical local evidence), runtime server registration (`research-workspace/evidence/windows-unattended/sandbox-runtime-server.txt`, historical local evidence), inconclusive batch scheduler state (`research-workspace/evidence/windows-unattended/sandbox-batch-scheduler.json`, historical local evidence).

The diagnostic enum source is [OleViewDotNet IdentityType at commit 7e9aa88](https://github.com/tyranid/oleviewdotnet/blob/7e9aa884e013b6773ef578ad391dbad9b30c11da/OleViewDotNet/Database/IdentityType.cs), preserved for research attribution only; it was not incorporated into NimbleNewt implementation. Microsoft describes the general behavior of [COM interactive identities](https://learn.microsoft.com/en-us/windows/win32/com/interactive-user), but the observed server is configured with a different runtime identity enum. Do not treat the general documentation as proof of that server's implementation.

## Owner-approved automatic-login fallback

Rob subsequently explicitly chose automatic login followed by locking for this dedicated laptop. He configured Microsoft Sysinternals Autologon locally and confirmed his work was saved. No owner password was requested, printed, read, or placed in the research scripts. The logon-lock task, temporarily disabled during sign-in troubleshooting, was restored for the authorized test.

The first full restart cycle passed: boot at 19:36:56.5, automatic Robert console session, WTS-reported locked state before work, all seven guest smoke assertions, successful sandbox stop, and locked state after work. The admission fixture refused to launch a sandbox unless the expected console user appeared and Windows reported `WTS_SESSIONSTATE_LOCK`. This demonstrates the explicitly accepted session-dependent route, not the previously requested no-login route.

The initial lock task used PowerShell to compile a tiny LockWorkStation wrapper at login. It was replaced with an administrator-protected, precompiled helper so compilation does not delay locking on each boot. A repeat cycle records request and confirmed lock timestamps, and is reported below. A logon-triggered task is not an atomic secure-logon boundary; timing is measured rather than assumed.

Public defaults remain unchanged. This is an owner-authorized installation option, with credentials managed locally by Windows and a separate exposure tradeoff. Do not silently enable it for other installations or conflate it with trusted-host command execution: the guest still uses Sandbox isolation. Future work includes locked-session health checks, account/package changes, OS update behavior, lock-helper failure handling, and primary lease expiry while guest work is running.

## Final automatic-login cycle result

**Two actual restart cycles passed**, with boot times 19:36:56.5 and 19:41:39.5 local. In each, Robert signed in automatically, the startup fixture independently verified the locked console via WTS session flags, SYSTEM launched a fresh Sandbox, all seven Node/isolation assertions passed, the sandbox stopped, and the console was still locked afterward. No manual sign-in or unlock was requested during either test. This demonstrates the owner-approved automatic-login path on this laptop without another Windows installation. It does not change the earlier no-login failure.

The second run used the precompiled locking helper. Windows recorded sign-in at 19:41:53.929305; helper entry was 19:42:12.723680, and locked state was confirmed at 19:42:13.082943. Thus sign-in to confirmed lock was **19.154 seconds**, with **0.359 seconds** from helper entry to confirmed lock. Startup scheduling/process initialization dominated the delay. These are one-run latency observations, not a maximum bound. This is **automatic locking, not a guarantee of immediate locking or zero desktop exposure**. The fixture admitted no sandbox work until lock confirmation. Continuous lock monitoring throughout arbitrary production work is not implemented by this fixture.

The temporary `NimbleNewt-Autologon-Cycle` startup task was removed; no Sandbox processes remained. The requested persistent `NimbleNewt-LockOnLogon` task stays enabled, running the protected precompiled helper. Autologon remains the owner's local configuration. No production NimbleNewt worker was installed.

Evidence: first reboot (`research-workspace/evidence/windows-autologon/autologon-cycle-first.json`, historical local evidence), second reboot (`research-workspace/evidence/windows-autologon/autologon-cycle.json`, historical local evidence), lock timing (`research-workspace/evidence/windows-autologon/lock-helper-result.json`, historical local evidence). Source: `experiments/windows_autologon_cycle.ps1` and `experiments/windows_lock_helper.cs`. WTS locked-state interpretation follows [Microsoft's WTSINFOEX_LEVEL1 documentation](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/ns-wtsapi32-wtsinfoex_level1_w).

Plan disposition: record this as Rob's explicit session-dependent qualification route, with measured startup exposure. Public defaults do not enable automatic login. Do not mark the full project or adversarial isolation gate complete: lifecycle fault injection, package updates, lease-driven guest termination and the remaining controller contracts still need their specified acceptance evidence.
