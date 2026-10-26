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

## R04 (provider drain, cutover and failback)
- **Failback defaults** (an AI session's choice, to confirm): automatic after 3 good probes over at least 120 s with a 900 s hold-down, plus one half-open trial after the 300 s outage cooldown; manual mode never restores by probes. A drain has no default duration; the owner gives `drainSeconds` and an expired drain becomes a cutover by itself (applied lazily or by `tick`).
- **A routing list needs two distinct endpoints, and two distinct accounts** unless every entry is a local engine or the owner acknowledges the weak list. The setting `routing.fallbackProfile.*` (profile-to-profile fallback) stays and is superseded by lists in a later configuration card.
- **Nothing in production aborts the real request on a cutover yet:** the dispatcher must bind the cancel listener (runtime abort and L05 `interrupt`); `CutoverService` and `FallbackService` are not constructed by `api/start.ts`.

## H05b (reviewer pause and hold)
- **A pause of one task of a reviewer does not hold the reviewer** (L01's rule); an agent, team or installation pause does. A held reviewer's review waits for the original deadline (it is not extended on resume) and then moves on under the project policy, never by approval; the hold takes precedence over a revoked host. An option to move a long-held review on at once is a possible later owner setting.
- **Nothing applies these rules in production until the composer wires `pauses.availability` and a reviewer-to-host lookup** (H03 and H12).

## U03 (owner chat command interpretation)
- **Explicit orders apply directly in the derived and autonomous profiles; in strict they are proposals.** An irreversible or final move (done, cancelled, archive, retire, dependency remove, release, transfer, assign) applies directly only when one sentence of the owner's own non-quoted text has a verb from that move's own fixed list (MOVE_VERBS in `chat/commands.ts`) and the target's name as a whole word; a question never counts as an order; with any quoted material in the message every command except plain edits becomes a proposal.
- **Anything that grants authority is a proposal in every profile:** contract permissions, budget and work class; agent roles and supervisor; project repositories; a task's repository; role definitions. Drafts and new projects are proposals. A repository change on an assigned or running task is refused.
- **A coordinator holding `assignment.manage` makes assignment-only plans under its own credential** (reasons recorded); plans with anything else wait for the owner's apply. A dispatched task needs a repository (the repository ID stands in for the checkout): one repository is set automatically, none or several ask the owner.
- **The composer must wire** the coordinator credential into the chat dependencies and the policy service (absent means strict); no real model and no transport yet.

## P01 (repository-independent projects and responsibilities)
- **A read-only repository bind of a location you typed yourself applies directly in the derived and autonomous profiles;** write access, a location not in your words, participants set by raw principal IDs and responsibility creation are proposals. A bind with no location asks you (it cannot be determined) unless the records know exactly one unbound candidate.
- **A responsibility always belongs to a project** (installation-level responsibilities are a later card). Unbinding is refused while an unfinished task is pinned to the binding. Maintenance windows are UTC weekdays and times only. A bind or move that overlaps another project's binding needs `acknowledgeOverlap` (and `resource.scope.write`).
- **The overlap check compares spelling only,** so it cannot see symlinks, bind mounts, subst drives or a UNC share versus its local path; it is a guard against mistakes, not a security boundary. The tool and sandbox cards (T06/A04) must resolve the real path before calling `authorizeUse`.

## U05 (chat status and blocker explanations)
- **A blocker gets an optional stated `basis`** (technical, enforced permission, policy conflict, owner hold, preference); nothing derives it, and a supervisor's or team's preference on an owner-decided outcome is shown as advice, never as a blocker. "Owner-decided" means the latest assignment was made by the owner, or with no assignment the task was created by the owner.
- **A reader who may see a task but not its tool activity** sees outside-action blockers, resolutions and delivery errors masked, plus an "an action's outcome is not known" line on a finished task; a dependency on a prerequisite the reader cannot see shows as "waiting on something you cannot see".
- **Status is answered from records, not through the coordinator,** so it works when the coordinator is down; "what changed" is derived from current records and update times, not a log; the newest shared accepted progress record stands in for a stand-up report. The Notice / Needs you / Urgent levels (U11b) are not built.

## M01 (durable meeting scheduling and agendas)
- **A schedule edit that moves the time on a date that already has an occurrence makes no second meeting;** `tick` reports it as skipped with a reason. **After an outage one catch-up is created already settled (reported)** and takes no agenda and sends no invitations.
- **Only the owner may invite a paused agent;** marking a meeting held stays owner/host/service until M05 gives the chair that right (M05 and M06 wait for your acceptance of the M00 findings). Caps: 200 waiting meetings per project and 1000 in total, 25 agenda items per meeting, 50 roster members, 60-minute grace before a meeting is missed, 400-day look-back. The availability hook is required and fails closed.
- **Nothing calls `tick` on a clock yet and no invitation sink exists** (H12/the composer); recurrence is once, daily or weekly in an IANA zone with DST rules (a time in the spring gap happens just after it, a repeated time at its first pass).

## G04 (supporting durable engine proof)
- **No defect was found in the production code and nothing counts against the selected architecture.** The proof validates a subset of section 3 of the design proposal and hands the rest to named cards (changed plans, state migrations, revoked grants, exhausted budgets, real deadlocks, per-task ordering, conversation suspend/resume) in a row-by-row table in `g04-evidence.md`.
- **Normal CI runs a sampled set** (38 of 127 kill boundaries, 19 of 41 fault points, 50 of 218 connection cuts); the exhaustive sweep, the worker-thread kills and the separate-process kills run in the hand-started QA workflow (job `g04`). The exhaustive numbers (127/126/41/218) come from this Linux machine only; macOS and Windows are unproven until that job has run. A SIGKILL lands between storage calls, never inside a commit (that case is covered by injected faults and PostgreSQL connection cuts).

## Review with the owner, 2026-10-25 (decisions after H12, H12c, H12e, H12h, H02, T06 and T06b part 1)

The session that built H12 to T06 ended before the open questions from those cards (recorded in their sections of implementation-notes.md) were shown to the owner; four were put to the owner in conversation on 2026-10-25. Decided by the owner:
- **A03b Windows Sandbox:** a one-time administrator step registers a SYSTEM scheduled task that runs a fixed, signed-off launcher script; the self-hosted runner can only trigger it, and stays unprivileged. (Running the runner as the owner was rejected for the always-on case.) A03b's real tests and G05 for Windows follow once the step is done.
- **Script runs on a host that cannot fully enforce a tool's limits:** refused by default (A08b, fail closed). An owner may switch a host to "run and record" once; every launch record says how each limit was applied.
- **Reviews escalated later or created by the commit gate raise no notification of their own:** U11b's Needs-you view lists every owner-decision review (already in U11b's deliverable).
- **H12b worker design:** the sandboxed worker has no network and talks to the controller over one channel. A narrow relay, built as its own replaceable component (allowed model endpoints only, provider keys added by the relay, never in the sandbox), makes the model calls. The owner chose this after asking how research and QA agents would work with a sandbox that has no network.
- **Follow-up by management, not a separate owner decision:** new card **H12i** gives a task specific, approved network destinations through the same relay (internet research through a controller-side web tool, QA against a named server or local port) and is how those agents will work. D03 (release readiness) and X02 (adversarial campaign) depend on H12i, which makes it a release gate; the owner may remove that. H12b's card now states the relay and its tests.

Defaults chosen in those cards that were shown to the owner as a list but not confirmed one by one; they stand until the owner changes them: a call beyond a task's permission ceiling, or an exact-operation review inside an approved ceiling, goes to the owner; an empty permission list means the credential carries the agent's own grants cut to the project and task; a lost attempt is re-admitted up to 3 times and a failed one is not restarted by itself; a decision-context change blocks calls until acknowledged; the dispatcher runs as `service:dispatcher` with an in-memory credential and stops for good if the owner disables it; there is no default model route; remote relocation defaults to the same platform, an empty `credentialHosts` means any enrolled host, `local-only` data never moves unless `dataHosts` lists the target, a pinned attempt whose host is gone raises a blocker after 5 ticks, and effect-class tools are refused from remote workers until H12a; a pause blocks every bridge write while reads continue; the first call of each exact catalogue tool operation is parked for review until T02 classifies released tools; scripts get no process-count or disk limit because manifests carry none.

## Defaults chosen in the 2026-10-25 run (H12b, T06b, H12f, H12d, H12g); for the owner to confirm
- **The own-namespace tool grant is derived for every agent in every project** (T06b): an agent may always run tools it made itself; the tool gate still judges each call in its project. It is not stored and does not count as a grant on a project.
- **`isLocalHost` is required by the tool execution service** and `tool.invoke` from a non-local host is refused; a composer with only local workers passes `() => true`. Remote (H02) attempts are therefore refused for the protected bridge until a composer says otherwise.
- **Call-ID reuse tracking is in memory** (T06b): a repeated provider call ID gets a digest suffix, and a reuse for a different request is refused; the map is not kept across a controller restart. The tool-list the agent sees per turn stays in the conversation history (not removed after the turn).
- **Context checks (H12f) use estimates:** characters divided by three for the stored conversation and first call, and 8000 characters assumed for Pi's own system prompt until measured; the stored-conversation resume decision depends on a size the process reports at each checkpoint. A first call over budget ends the attempt failed with a `context_overflow` blocker; the real process cannot yet compact, so no second try is made.
- **A message to a running agent is delivered by the controller (H12f)**, fenced with the sender's authenticated name and a note whether it is the owner's; interrupts at once, advice only when no tool call is running; nothing to a paused attempt or after the turn. A failing context or message check never blocks the attempt, except the first-call admission, which fails closed.
- **Quiescing (H12d):** an operation on an agent's work waits up to 10 seconds for calls told to stop; a call that does not stop blocks the operation with a `runtime_hold` blocker for the owner. Gaps: attempts started during the operation are not held, freezes are not per holder, and the blocker is not cleared by a later success. No quarantine operation exists yet; the coordinator is ready for it.
- **Remote MCP connections (H12g):** every connection re-checks the server (revoked means no connection), resolves the name, requires every address to be public, connects to the checked address, and looks the name up a second time to refuse one that turned private. A rotating public name is accepted. There is no MCP transport in the product yet, and a revocation does not cut a connection already open.
- **H12b gaps left open:** reaping the worker process on pause/stop/loss is not tested; "a missed pin marker is recorded as lost" and "no provider key in files, environment or output" checks are missing; no cross-OS launcher CI cells. These keep H12b from being marked implemented unless the owner accepts them as follow-ups.

## Owner answers, 2026-10-26 (review of the 2026-10-25 run)
- **Card statuses:** CI run 40257790711 (commit 0a1d237) was green on all six cells, but T06b, H12f, H12d and H12g cannot be marked implemented while the cards they depend on are planned (H12, H12c, H12e, H12h, H02, T06, C07b, C06b, L01, U12). The owner chose to audit that chain against each card's acceptance text, starting with H12, and flip what is truly met in one batch on an exhaustive CI run. No status was changed.
- **H12b gaps:** new card **H12j** (reap the worker on pause/stop/loss, pin marker recorded as lost, no provider key in files/environment/output, cross-OS process tests). H12b stays planned until it is done.
- **Own-namespace tool grant:** kept for every agent in every project; the tool gate still judges each call. It is not a grant on a project.
- **Context check:** the estimate (characters/3, 8000 for Pi's system prompt) and the fail-closed first call stand; real token counts and compaction come later with the C07b follow-ups.
- **Wiring:** new card **H12k** composes the local worker host in the controller (relay, guards, context checks, quiesce coordinator, remote MCP connector and its transport) with an end-to-end test.
- **Testing time:** CI runs only every fifth to tenth completed task. New card **X11** splits the suite into a typical tier (changed packages and their dependents, Linux, Node 22, reference store and SQLite, about 10 minutes) and an exhaustive tier (six cells, every backend, sharded, at most 30 minutes per cell) kept for milestones and releases. The per-job CI limit was raised from 50 to 80 minutes meanwhile (Windows node 22 took about 48 minutes in the controller package alone).

## 2026-10-26: code-navigation aids are measured after the release

Asked whether something like graphify should be first-class, the owner decided to measure instead: after the first release, try different real coding tasks and keep the aids that measurably help. Recorded as card D04b (optional, after the first release, feeds D05). Candidates: better ripgrep paging, an on-demand language-neutral code map and references tool built inside the sandbox, neighbour-file suggestions, a reviewer "what calls the changed exports" view. Not candidates: graphify itself, model-extracted relationships, visualisation, a startup architecture summary (breaks prompt-cache reuse), controller-side shared indexes. A second opinion (Opus) agreed with this scoping; the base must be language-neutral (Tree-sitter or ctags), with the TypeScript compiler API only as a precision layer.

Follow-up (owner, 2026-10-26): nothing language-specific unless the same is done for the ten most used languages, so the TypeScript compiler API is dropped as a precision layer; the base is language-neutral (Tree-sitter or ctags). If JavaScript or TypeScript is covered, the frameworks have to be: Angular templates and decorators, Vue and Svelte single-file components, React JSX. An aid that cannot handle a language or framework says so instead of returning an empty or partial result. D04b's text carries this.

## Cards split or reworded to close C07b, C06 and L05 (2026-10-26)

- **C06 wording:** "recorded responses" now says "simulated from the backend's documentation or source"; the capture from running servers is part of G10. Say if you want C06 to wait for real captures instead.
- **C07d (new, before release):** route change to a smaller window and window-scaled MCP result limits, moved out of C07b.
- **L05b (new, before release):** feeding the model stream into revision-bound generation, moved out of L05.

## Stall detection needs a right the dispatcher does not hold (2026-10-26) — decided

**Decided by the owner (2026-10-26):** a new, narrower stall-scan right, not `recovery.read` on everything. `StallService.scan` runs only as the owner or a service holding `recovery.read` on everything, and `service:dispatcher` holds no grants; card L01b adds a dedicated right that permits only the scan (it only writes concern records) and gives it to the dispatcher.

**Owner direction, same day:** stall detection must account for the model's prompt reading speed. A 120,000-token prompt read at 100 tokens a second takes 20 minutes before the model does anything, and V01 judges an open request against a fixed time per difficulty (10 minutes for a medium task), so it would report a stuck request that is only reading. For local models the actual speed counts. Card V01b scales the allowed request time to the prompt size and the measured speed of the route, shortened by the cached share, and ends the allowance at the first output.
