# Windows and retained-context experiments — October 16, 2026

> Historical feasibility research, October 16, 2026. Statements about future research gates are superseded by the current implementation plan. These reports do not qualify NimbleNewt production code. Raw machine-local fixtures remain in the research workspace; paths below identify historical evidence, not shipped dependencies.

## Outcome

The experiments establish a viable retained-context path using Pi Durable's native history fork. On macOS, Linux and Windows, an inquiry inherited the original task's committed message/tool context, answered separately, and left the parent's context unchanged. Explicit updates and task switching preserved the expected facts. A separate process reopened the exact saved message context. Cancelling a partially streamed tool call executed zero tools in the fixture.

A real llama.cpp CPU inference experiment also demonstrated the proposed prefill savings: returning from an inquiry evaluated 9 tokens instead of 1,206; restoring saved state after unrelated work evaluated 10. Three repeated continuations matched the cold baseline. This is actual inference-cache reuse, not a scripted model's simulated cache accounting.

These results support the architecture. They do not prove exact mid-generation decoder freeze/resume, full NimbleNewt controller behavior, or the performance of the production Strata model.

## Windows environment and scope

Host supplied by Rob: Windows 11 Pro, build 10.0.26200, x64; Node 22.20.0, Python 3.13.7, SQLite 3.50.4. Research workspace: `C:\Users\Robert\NimbleNewt-review-20261016`. Access used the dedicated SSH key and verified the owner-supplied host fingerprint. Dependencies were installed from the existing locks with npm lifecycle scripts disabled. No global runtime upgrade was performed. A later, explicitly authorized reboot completed Windows Sandbox feature activation; see the setup follow-up below.

Windows Sandbox was initially disabled. With explicit owner authorization, the feature was enabled and the laptop restarted successfully. The initial SSH launch produced no guest results. After the owner completed the client update, two disposable sandbox smoke runs passed through a temporary task in the signed-in desktop session. Full adversarial isolation and unattended service operation remain **unqualified**; see the follow-ups below.

| Test group | Result | Important limit |
| --- | --- | --- |
| Pi 1.0.1 native crash/recovery | 9 expected-result scenarios and controls passed | Three repeats of unsafe, deliberately misclassified safe, and idempotent tool behavior. “Safe” deliberately duplicates an unprotected effect; that is the hazard being demonstrated. |
| Pi 1.3.0 native crash/recovery | 9 expected-result scenarios and controls passed | Uses corrected `output` tool-result contract. |
| Forward migration 1.0.1 → 1.3.0 | 3 scenarios passed | Simple interrupted fixtures; not full compaction/extension/downgrade compatibility. |
| Tool-result sentinel | `output` visible; legacy `content` absent | Confirms the semantic upgrade trap on Windows too. |
| SQLite protocol spike | 12 cases passed | Process-crash transaction/admission/fencing/artifact checks. Windows directory fsync was omitted; **no power-loss durability claim**. |
| Context switching | 12 assertions passed | Scripted provider with actual Pi persistence/fork/streaming. |
| Process death during streaming | Passed | Original request deduplicated, input retained, incomplete answer regenerated. Exact decoder state was not resumed. |

The Windows recovery runner adapts process-exit expectations and environment variables, not product assertions. The protocol spike uses Windows process termination. A quoting error in the first migration runner invocation was corrected before its successful run; no engine defect was inferred from that script error.

Evidence: 1.0.1 (`research-workspace/evidence/windows-pi-1.0.1/report.json`, historical local evidence), 1.3.0 (`research-workspace/evidence/windows-pi-1.3.0/report.json`, historical local evidence), migration (`research-workspace/evidence/pi-migration-windows/report.json`, historical local evidence), protocol (`research-workspace/evidence/protocol-windows/report.json`, historical local evidence), output (`research-workspace/evidence/output-windows-130-output/result.json`, historical local evidence), legacy content (`research-workspace/evidence/output-windows-130-content/result.json`, historical local evidence).

## Context-switch test details

The fixture uses Pi Durable 1.3.0 and its real `Conversation.fork(at, …)` API. It does not manually summarize or copy a task into an unrelated conversation. Task A records a source-tool fact, a task-specific fact, and a decision. Assertions then verify:

1. Forked model messages equal the original messages exactly.
2. The inquiry's provider receives the task fact, source result and decision.
3. Its answer does not change the original parent's messages.
4. Unchanged resume retains source facts and excludes the inquiry-only content.
5. A selected owner update enters A without importing incidental chat.
6. Performing task B leaves A's context unchanged.
7. A partial response is observed in Pi's live state while A generates.
8. A forked inquiry during that stream can see the original committed context without changing it.
9. Cancelling the response preserves prior context.
10. Cancelling during a partial tool-call stream executes zero effects; subsequent resume retains the owner update.
11. After closing the harness and launching a fresh process, saved messages match exactly.
12. The new request receives retained facts without B's or the inquiries' private additions.

The inquiry uses the last committed transcript boundary. The incomplete response is observable separately but is not automatically treated as a completed message or silently included in the branch. A product policy for optionally supplying clearly marked partial observations is still needed. The scripted assertions establish data flow, not real-model comprehension or response quality.

Passed on all three environments:

- Mac, Node 22.23.2 (`research-workspace/evidence/context-switch-mac/report.json`, historical local evidence).
- Linux, Node 24.21.0 (`research-workspace/evidence/context-switch-linux/report.json`, historical local evidence).
- Windows, Node 22.20.0 (`research-workspace/evidence/context-switch-windows/report.json`, historical local evidence).

The companion crash fixture terminates the actual process after observing persisted partial streaming output. Reopening preserves the original input and submission identity and regenerates the unfinished answer. The final context does not present the interrupted partial marker as a completed answer. Reports: Mac (`research-workspace/evidence/stream-crash-mac/report.json`, historical local evidence), Linux (`research-workspace/evidence/stream-crash-linux/report.json`, historical local evidence), Windows (`research-workspace/evidence/stream-crash-windows/report.json`, historical local evidence).

Source: `experiments/pi-1.3.0/context_switch.mjs` and `stream_crash.mjs`. Scripts are JavaScript research probes against the Node runtime; the typed production adapter and its compile-time compatibility checks remain implementation work.

## Actual inference-cache experiment

A separate, temporary llama.cpp container ran on Linux CPU with two CPU cores and a 2 GiB memory cap. It had no GPU device, no production model mount, a read-only root, dropped capabilities, and a localhost-only published port. It was stopped and removed after evidence collection. This demonstrates an isolated experimental deployment, not all-platform worker sandbox qualification.

- Binary: llama.cpp `0.4.1-dev`, build 11064, commit `a894dae93`, from existing `aim-llama-vulkan:latest`; exact image digest saved in the evidence directory. This is a different build from the earlier vendored source inspection.
- Model: [ggml-org/SmolLM2-135M-GGUF](https://huggingface.co/ggml-org/SmolLM2-135M-GGUF), Q8_0, revision `44686446221a479a9227d7a895cf92930f86de8a`.
- GGUF SHA-256: `813966e2b5e5aba261f6f198849a13b815db3c77bf4e389e72aa1e0f35a0d455`.
- One slot, 8,192-token context, 12-token greedy continuations, three repetitions.
- The fixture uses plain completions with stable prefixes, avoiding chat-template ambiguity. It is not an integrated Pi-to-inference test or a model-quality benchmark.

| Return path | Prompt tokens evaluated in each repeat | Median prompt evaluation | Median request wall time |
| --- | --- | --- | --- |
| Cold target | 1,206 / 1,206 / 1,206 | 2,236.6 ms | 2,392.4 ms |
| Native prefix reuse after inquiry | 9 / 9 / 9 | 52.4 ms | 195.7 ms |
| Restore saved slot after unrelated work | 10 / 10 / 10 | 57.2 ms | 229.7 ms |

Slot restoration itself took approximately 8.0–8.5 ms, separate from the request wall time in the table. Both cached paths produced the same 12-token continuation as the cold target in all three repeats. That output equality is a fixture result, not a promise of bitwise equivalence for every model/backend/batch size. Prompt-time reductions are not whole-system or large-model speedup claims.

The first cache-save attempt failed because the capability-restricted container could not write its scratch mount. Only that synthetic directory's write permission was adjusted, then the complete three-repeat run passed. No production permission or service was changed.

Full cache report (`research-workspace/evidence/llama-cache-cpu-rerun/report.json`, historical local evidence), with individual responses, save/restore measurements, server log, and image ID in the same evidence directory. Source: `experiments/cache_probe.py`.

## Production backend observations and remaining limits

Read-only Strata metrics identified version 0.1.43, two slots, existing slot caching, and `conversation_cache_mib: 0`. The server's GPU had almost all VRAM allocated. Consequently, no separate Strata/vLLM GPU instance was launched, no production setting was changed, and no synthetic inference request was submitted to the production model. Existing metrics are availability/configuration observations, not experimental cache results.

The optional RAM conversation-parking feature is therefore not yet benchmarked on the deployed Strata configuration. vLLM remains source-audited, not runtime-qualified for the proposed marker API. Both can be tested in a dedicated capacity/maintenance window or on additional suitable hardware. They do not block the backend-neutral context-preservation contract, but must not be advertised as qualified optimized adapters yet.

No paid-model calls were made; this batch used **$0 of the $25 research budget**.

## Changes to the plan

- Treat Pi history forks plus immutable task context as the demonstrated basis for inquiries; keep explicit parent/context revisions and selective update admission.
- Preserve the distinction between committed context and in-flight partial state. Stream cancellation/restart is qualified for the fixture; exact frozen-decoder resume remains optional and unqualified.
- Keep native prefix reuse and idle-slot save/restore as the first optimized adapter baseline. The experiment supplies a real benefit before any engine fork is needed.
- Require fresh-process and partial-tool tests in all-platform adapter CI; extend them to compaction, real providers, updates and the actual controller during implementation.
- Separate Windows process-crash consistency from power-loss durability; implement and qualify native publication/flush semantics before promising durable artifacts through host power loss.
- Retain strong isolation as a release requirement. Windows Sandbox smoke checks now pass after an authorized restart and client update; unattended service operation and adversarial qualification remain outstanding.
- Do not mark G07 architecture freeze complete: scheduling selection, integrated admission/recovery behavior, remote watchdog/fencing and isolation qualification still require resolution/evidence. These results remove substantial uncertainty but do not make those separate gates disappear.

## Sandbox setup follow-up — October 16

The owner authorized enabling Sandbox and restarting with work saved. Feature activation succeeded and requested a restart. The laptop returned over the pinned SSH connection with boot time 18:43:53 local. The legacy `WindowsSandbox.exe` launcher is present, but `wsb.exe` was not on PATH. No user was signed into the desktop (`quser` reported none).

The synthetic fixture configured networking, clipboard, audio/video, printers and vGPU off, with a read-only input folder containing Node and a guest script, and a separate writable result folder. The launcher remained in SSH session 0 and produced no guest report. Its specific process was stopped. This is a setup/automation limitation, **not a failed containment test**: the guest assertions have not run.

The owner has been asked to sign in and open Sandbox once, allowing its Microsoft client update. Microsoft documents the [new client upgrade on first launch](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-versions) and the [remote CLI](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-cli). First-run setup was pending at this point and was subsequently completed; see the successful follow-up below. No credentials or automatic desktop login were configured.

Plan requirement: a Windows worker must demonstrate sandbox launch, execution, result collection and teardown under its actual unattended service identity, including after host restart, before advertising execution capacity. Feature-enabled status alone is insufficient. If the supported Sandbox client requires interactive setup or a session that cannot survive unattended recovery, qualify a managed Hyper-V VM worker path instead; never silently fall back to trusted-host execution. This launcher decision remains an evidence gate.

Evidence: setup status (`research-workspace/evidence/windows-sandbox/setup-status.json`, historical local evidence). Prepared sources: `experiments/windows_sandbox_host.ps1` and `experiments/windows_sandbox_guest.ps1`. The guest checks Node execution, denied writes to read-only inputs, absence of an unshared host canary, no IPv4 default route, and local guest writes. These are smoke checks, not proof against all sandbox escapes or network paths.

## Successful Sandbox follow-up — October 16

After the owner signed in and opened Sandbox, MicrosoftWindows.WindowsSandbox 0.8.107.0 and `wsb.exe` became available. Direct `wsb list --raw` over SSH returned **Access is denied**. A temporary scheduled task using Robert's existing interactive logon successfully controlled it; no password or automatic login was configured. The setup sandbox was stopped, then two restricted test sandboxes were started, exercised and stopped.

The first run passed five checks: Node 22.20.0 executed inside the guest, input-folder writes were denied, the unshared host canary was absent, there was no IPv4 default route, and guest-local writes worked. The second run repeated these and additionally verified no IPv6 default route and absence of the prior guest's local canary after recreation. Its guest command returned exit code 0. Host-side checks confirmed the forbidden input file was absent and the host canary unchanged.

Both test sandboxes were stopped. The temporary `NimbleNewt-Sandbox-Probe` scheduled task was removed, and no Sandbox processes remained in the cleanup check. The enabled Windows feature/client and synthetic research files are retained for future qualification.

Evidence: first run (`research-workspace/evidence/windows-sandbox/guest-first.json`, historical local evidence), second run (`research-workspace/evidence/windows-sandbox/guest-results.json`, historical local evidence), second-run transcript (`research-workspace/evidence/windows-sandbox/sandbox-run.txt`, historical local evidence), configuration (`research-workspace/evidence/windows-sandbox/qualification.wsb`, historical local evidence), and updated setup status (`research-workspace/evidence/windows-sandbox/setup-status.json`, historical local evidence). Runner source: `experiments/windows_sandbox_interactive.ps1`; the first run also stopped the specific setup sandbox, while the retained runner is the second-run version.

**Interpretation:** TypeScript-compiled JavaScript/Node has a demonstrated Windows VM-isolated execution path. This is narrow positive evidence, not full sandbox qualification. Default-route absence is not an exhaustive network-denial test; path traversal, symlink/reparse escape, credentials, process-tree cleanup and adversarial workloads remain to be tested. Neither running with a signed-in user nor successful SSH after reboot proves unattended sandbox launch after logout/restart. The G05 and A03 cards now explicitly require this lifecycle qualification and prohibit automatic fallback to trusted-host execution.

## Unattended investigation update

The subsequent investigation reproduced the initial failure as a mapped-output permissions problem and demonstrated SYSTEM/session-0 Sandbox execution. The [unattended investigation](windows-unattended-findings.md) records the corrected permissions and a separate no-login activation failure after reboot. Background execution with an owner session passed; fresh launch with nobody signed in remains unqualified. A separate Windows VM has not been shown necessary.

The owner-approved auto-login/automatic-lock fallback subsequently passed **two full restart cycles** with fresh sandbox execution and cleanup. A timed run observed approximately 19 seconds from sign-in to lock; the test admitted work only after verified locking. This qualifies the tested session-dependent path for this laptop, not a no-login public default. See the [complete unattended findings](windows-unattended-findings.md).
