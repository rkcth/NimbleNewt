# Decisions made while building, for the owner to review

Written during the long coding session of 2026-10-22. By the guiding principle the building session decides what it can and does not interrupt the owner; every decision below was made by an AI session on the evidence in the card and the code, is recorded here, and is open to change. Each item names the card, the choice made and the alternative.

## C01b (shared working notes)
- **Project member means holding `desk.read` in the project.** Principals with a `*` grant (supervisors, services) therefore read every shared note. Alternative: a dedicated notes grant.
- **The chair read uses the stand-in action `notes.chair.read`.** M05b is to grant it to the meeting chair (or replace it); it is not meant to stay a permanent separate action unless M05b keeps it.
- **Promotion records the request only** (against the revision and digest, with an optional `reviewId` that must be the same agent's review in the same project). Nothing yet links a decided review back to the promotion, and nothing writes the file; the card that wires the promotion workflow (T08 and P02) closes that loop.
- **Private notes are closed to `desk.scratch.read` holders** (only the agent and the owner read them), unlike private desk scratch.
- **A deleted note vanishes for everyone but the owner**, who sees an empty marker.
- **No limit on the number of notes per agent** for now.
- **Redaction now also catches Google API keys, Stripe keys and npm tokens**, and the named-assignment pattern still refuses prose such as `token: refreshed`.

## H06b (idle event subscriptions)
- **The owner's idle setting is a ceiling.** A subscriber may ask for a shorter idle time, never a longer one; there is no per-subscription owner override.
- **Expiry of a critical (host or service) subscription always files a Notice**, even with nothing pending (a host disappeared); a non-critical one files a Notice only when events were waiting for it.
- **Any publish that sees an idle critical watcher expires it**, so a producer's call writes the record about someone else's subscription; the Notice is left to the sweep so slow channels never slow producers.
- **Only the owner and service principals may run the sweep** (`expireIdle`), not hosts or agents. Nothing calls it on a schedule yet; the dispatcher or an S08 timer must.

## F04i and F04j (filesystem and prerequisite checks)
- **A SQLite data directory on a network filesystem can be started with the override** (the owner said "error, and allow an override"), even though sharing a SQLite file over a network can corrupt it; the refusal says so.
- **A supported start writes the host and distribution once as an `environment.host` audit record** and prints nothing.
- **A missing systemd user session stays overridable** (weaker limit fallbacks exist and the launch record reports them); missing git, sandbox tools and database libraries cannot be overridden.
- **Sandbox and limits tools are required at start only when the start options name those features.**
- **A network or unsupported filesystem under a workspace root is refused too**, not only under the data directory.
- **The git floor is 2.38.1**, derived from the `protocol.file.allow` flag the workspace bridge sets.

## C05 (context branches)
- **Only the branch owner and the installation owner can view or command a branch.** A branch's return destination and a delegated child must be a task of the same project. `resume` ends a branch (no discard operation). Other writers are not blocked while a branch is suspended; restore reports what they wrote.

## V01 (stall detection)
- **Provisional thresholds** (minutes request/silence, repeat counts for actions and errors): trivial 2/5, 4, 3; easy 5/10, 5, 4; medium 10/20, 6, 5; hard 20/40, 8, 6; expert 45/90, 10, 8. A dismissal silences a concern for 6 hours. All are settings.
- **A task's own owner never decides its own concern**, even with `assignment.manage`; concerns go to the agent's active supervisor, else the owner.
- **A stale timestamp never permits a takeover**; a takeover may be proposed only when the worker is silent and its host is revoked or stale.

## V01 (stall detection), after review
- **Confirmed concerns are archived** (state cleared, reason archived) when the task is done or cancelled or its generation changes; a scan may reopen one if a done task is reopened under the same generation.
- **A takeover may be proposed only on silence plus a revoked host identity**; a stale host heartbeat is never enough (a partition makes host and worker quiet together). Only the owner or a service with an exact `recovery.read` grant may run a scan.
- **Only progress counts as liveness** (a step, an error, new evidence, a request start or finish, a change of job status); a repeated `job: running` or a spend report does not. A wrapper that alternates job status still counts as progress.

## R05 (cost and resource attribution, delegated budgets)
- **Allowance is an explicit act** (`open`), not derived from the S10 contract `budget.maxCost`. The intended default is a project-level allowance opened by the owner with a supervisor as holder, who delegates, so only new money and raises reach the owner. Three caps exist that nothing connects yet (S10 `maxCost`, R02's per-task cap, R05 allowances); H12 must reconcile them (reserve, call the fallback service, settle).
- **Owner approval creates new money along the whole ancestor path;** requests never expire yet; a limit can be lowered only by `reclaim` from a child.
- **A child's overrun passes up to its ancestors;** overrun counts only spent plus handed-on beyond the limit, never amounts that are only held.
- **Requests for more budget are found with `pending(by)`;** U11 or the dispatcher must call it (no notification outbox here).

## T05 (MCP durable conversation adapter)
- **Agents converse under their own credential;** task credentials (`tcr-`) are not accepted by this door (same limit as U02b), and the owner's credential is accepted. No session ID is issued; a later transport card may not add one that carries state.

## C07b (context budgets at dispatch, bounded compaction)
- **The extractive (no-model) summary is the default last-resort fallback;** it is marked as extractive, visible to the owner and does not count as an overflow. Defaults: 2 consecutive overflows then a blocker, at most 12 pinned owner decisions, 45 s per route and 100 s in total (under the adapter's 150 s ceiling).
- **Only an owner, host or service may call the dispatcher-side operations;** an attempt's own hand-off arriving after the controller's is kept beside it and preferred as the head; a remembered decline after one summariser timeout is acceptable; one open `context_overflow` blocker per task.

## R03 (difficulty profiles and escalation)
- **"Parent" is whoever delegated the task** (with `task.difficulty.write`), not the H11 supervisor; only the owner can reassign the parent. The per-task ceiling chosen by the parent is accepted; delegation chains are not limited by the parent's own ceiling yet. A task with no difficulty uses the mapping key `unrated` (no entry means no dispatch choice).
- **"Failing" means admitted attempts since the last escalation that changed difficulty;** a blocker can be used for one escalation only; defaults: retry budget 2 and total budget 5 per round; a parent's decision on a stopped request or a redelegation starts a new round.

## A03b (Windows Sandbox launcher)
- **The uploaded `sandbox-windows` artifact carries only a summary** (pass/fail per test, counts, OS build, Node version, mode names), because the repository is public; detailed findings stay on the Windows machine in a local folder.
- **The first qualifying run checks the supervisor-folder ACLs in report-only mode;** the strict check must run before release (G05). One sandbox at a time: a second job is refused as busy, not queued. The real run uses the owner's own account as the share account, so it cannot prove that the narrow per-job grants are what make access work.
- **Auto-login and lock mode exists only with an authority string and the exact acknowledgement sentence from the owner;** the host interface has no operation that writes the registry, creates an account or stores a credential.

## L05 (generation interruption and late results)
- **The per-task hold lives in this card's own `generation-gate` until L01 adopts it** (L01 must reconcile it with the existing `manual_hold` blocker). Both interrupt modes set a hold and a release by someone with `assignment.manage` is required before a new generation: a pause is explicit.
- **Only effects admitted and started through the generation service are gated;** H12 and any dispatcher must wire `guardFor(taskId)` into every effect run for a task (the slice pipeline starts effects ungated today). One agent cannot supersede another agent's running generation unless it is the owner, holds `assignment.manage`, or presents a valid fence.

## H13 (event source adapters and watchers)
- **Event wake-ups only wake an existing active attempt** (starting an attempt belongs to H12); a handling has a 900 s lease (extendable up to 4 times and 24 h in total) after which it fails visibly as `lease`; at most 2 open handlings per owner; per-run source cap 200 (max 1000); only the owner or a service sets up watches; only the owner releases a held loop.
- **A race in the shared command runner was fixed:** a concurrent duplicate of the same command now gets the recorded result instead of `command_conflict` (a different command with the same ID is still a conflict).

## G09 (retained-context inquiry and mid-generation interruption proof)
- **`restoredBy` on a resume stays optional;** the label (native restore, reconstruction or restart) is the host's word until H12 owns resume. `useModel` is an explicit adapter method with no audit event yet (the controller starting to change providers must audit it, a limit for H12/R04).
- **The proof shows the production C05, L05, H04 and C04 services working with the real Pi adapter,** but no production code yet carries a branch resume result into the adapter conversation (the test joins them), and the partial-tool-call relay to L05 is a stand-in.

## A03b: what the first real Windows runs showed (2026-10-23) — needs the owner
- **The runner account cannot see Windows Sandbox.** On the owner's Windows 11 Pro machine (build 10.0.26200) the job runs as the dedicated account `NimbleNewtRunner`; for that account the package `MicrosoftWindows.WindowsSandbox` is not found, so six of the eight real tests fail at the first step ("Windows Sandbox is not installed"). The earlier research (context-and-windows-results.md, October 16) found the Sandbox client installs for the signed-in owner after Sandbox is opened once, that `wsb.exe` answered "Access is denied" over SSH, and that it worked from a scheduled task using the owner's existing interactive logon or from a SYSTEM task in session 0 launched from the package directory. So the real tests need `wsb.exe` to be driven by the owner's interactive session or by a SYSTEM scheduled task, not by a standard runner account.
- **What I need decided (once, when the owner is back):** either (a) a one-time administrator step that registers a SYSTEM scheduled task which runs a fixed, signed-off launcher script the runner can only trigger (my recommendation: it matches "launch under the actual unattended service identity" in G05 and keeps the public-repository runner unprivileged), or (b) running the runner under the owner's own interactive account for the qualifying runs only (rejected for the always-on case: it would run public-repository workflows as the owner). Until then A03b is built and proven by simulation only, and G05 stays unstarted for Windows.

## L01 (Pause and background settlement)
- **Three holds stay separate** (L05's generation hold, the L01 pause gate and the `manual_hold` blocker) because each mismatch fails safe: resuming one while another holds leaves work blocked. A lifecycle pause reaches a safe boundary and does not cut the streaming response (the caller adds `interrupt(cancel)` if wanted); a pause is weaker than `manual_hold` for effects that already started. Anyone with the scope's authority may resume; agent and team scopes ride on `agent.manage` with project `*`; `background: deny` stays.
- **Nothing in production honours a pause until the composer wires it:** `api/start.ts` to `pauses.availability`, the stall service's `isPaused`, and the reconciler's `pauses` (an H12 follow-up).
