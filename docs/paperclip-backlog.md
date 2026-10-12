# NimbleNewt — inactive planning backlog

All tasks are unassigned Backlog. Only planning is authorized; implementation must wait for Rob. BickelsSurplus remains first; approval of these planning changes does not clear N00.

Resume-reconciliation scope below was synchronized and read back in the existing Paperclip tasks AII-254, AII-255, AII-256, AII-257, AII-260, AII-265 and AII-268 on 2026-10-11. N05 also depends on N06 and N07, while the N00 implementation gate remains. No duplicate tasks were created. See [resume reconciliation](nimblenewt/resume-reconciliation.md).

Project-and-delivery additions below were synchronized and read back in the existing Paperclip tasks AII-254, AII-519, AII-259, AII-263, AII-264, AII-265 and AII-268 on 2026-10-11. N09 depends on N07a; N07a has its documented N00, N01, N04, N06 and N07 blockers. The N00 implementation gate remains closed.

MCP integration additions below were synchronized and read back in the existing Paperclip tasks AII-251, AII-254, AII-256, AII-519, AII-259, AII-520, AII-263 and AII-268 on 2026-10-11. N10a has its documented N00, N01, N04, N06, N07, N10 and N07a native blockers; the N00 implementation gate remains closed.

The TypeScript-first implementation decision was synchronized and read back in existing Paperclip tasks AII-251, AII-252, AII-253 and AII-268 on 2026-10-12. They remain unassigned Backlog items under the N00 planning hold.

## Proposed task sequence

### [AII-250](http://192.168.2.10:3100/AII/issues/AII-250) · N00 — Human decision: authorize NimbleNewt work

Depends on: Rob’s explicit authorization.

Record Rob’s explicit authorization, selected scope and priorities before starting any implementation or research tasks. Creating this project is planning-only authorization.

Completion criteria: Only Rob may clear this gate. Record the exact authorized outcome and budget; choose which tasks may become actionable. Do not treat this backlog, an available coder slot, or completion of another project as permission.

### [AII-251](http://192.168.2.10:3100/AII/issues/AII-251) · N01 — Agree on architecture and first useful release

Depends on: N00.

Review the design with Rob and any collaborator. Resolve initial worker placement, storage/transport, UI approach, supported OS versions, lifecycle budgets and first-release scope. Separate accepted requirements from proposed defaults.

Accepted language decision: TypeScript is the default for the controller, Pi Durable worker adapter, API, workers and UI. Keep a single primary language and direct Pi Durable integration. Rust requires a bounded, demonstrated need and a maintained interface; do not assume a Rust port of Pi Durable is faster.

Choose the first transport for the durable state and two-way conversation APIs. Compare HTTP send/reply with cursor-based long-polling or server-sent events, optional WebSockets for live updates, and an MCP adapter for compatible harnesses. Keep persisted threads independent of transport sessions; record version and migration behavior.

Completion criteria: Approved architecture decisions and a demonstrable first-release scenario; unresolved choices remain explicit. Record the TypeScript-first package boundaries and any evidence-backed language exception. Do not silently commit to multi-host workers or multi-human administration.

MCP scope: Select and pin compatible MCP client/server protocol revisions, transports and adapter versions; define external-server registration, capability refresh, authorization, effect recovery and migration without making MCP sessions authoritative task state.

Additional MCP completion criteria: Document a portable client/server compatibility matrix and an end-to-end scenario; unknown or unsupported revisions fail clearly, and no transport choice silently broadens permissions.

### [AII-252](http://192.168.2.10:3100/AII/issues/AII-252) · N02 — Establish the portable project foundation

Depends on: N01.

Create controller, worker adapter and UI package boundaries, versioned configuration, credential references, MIT notices, contributor/security guidance and CI for macOS, Linux and Windows. Keep private installation settings outside source.

Use TypeScript for the controller, worker adapter, API, workers and UI. Separate privileged controller operations from customizable agent code through package/process and authorization boundaries, not language choice alone. Do not add a Rust toolchain without a reviewed, narrowly scoped need.

Completion criteria: Clean setup and an offline smoke check on each OS; no required changes in target repos or hardcoded providers; dependency licenses and notices recorded. Verify the TypeScript package boundaries and cross-platform build without an unnecessary Rust dependency.

### [AII-253](http://192.168.2.10:3100/AII/issues/AII-253) · N03 — Qualify the Pi Durable adapter

Depends on: N02.

Pin the runtime, map public task IDs and commands to harness operations, reserve nimblenewt namespaces, and qualify cancellation, storage, extension replacement and restart semantics. Extend existing offline probes across platforms.

Implement the adapter in TypeScript against a pinned Pi Durable package. Keep the adapter versioned and narrow so upstream API changes are remapped and tested explicitly. A future Rust port requires evidence that the TypeScript runtime is the limiting factor and must reproduce required behavior and compatibility tests.

Completion criteria: Repeatable evidence on all three OSes; queued input survives cancellation; API/command collisions fail safely; version upgrade checks preserve saved state. Document unsupported behavior and measured performance before proposing a language change.

### [AII-254](http://192.168.2.10:3100/AII/issues/AII-254) · N04 — Implement durable tasks and effect records

Depends on: N02, N03.

Implement stable task/agent identities, assignments, inboxes, attempt records, checkpoints, event ordering, idempotency and exclusive writer enforcement. Record external effect outcomes separately from model replies.

Completion criteria: Fault-injected crash/restart preserves acknowledged work, rejects stale writers, deduplicates delivery and reconciles uncertain effects without blindly replaying actions.


Accepted resume-reconciliation scope: Store checkpoint read/write dependency manifests, stable resource identities and hashes/revisions, directory/search scopes, durable mutation events and per-stream cursors. Track incomplete coverage and preserve event-gap information.

Additional completion criteria: Crash/restart preserves manifest/cursors; controlled writes journal versions; missing/deleted/non-Git inputs and expired cursors are detectable; stale attempt writes remain fenced.

Project-delivery scope: Define first-class project identities and task-to-project links, versioned assignment history, distinct observed execution, and stable deliverable records. Preserve ownership and output history across restart without putting operational records in target repositories.

Additional project-delivery completion criteria: A paused, suspended, blocked or unreachable task retains its correct assignee while activity reports become stale or unknown; deliverable links and versions survive restart; a tool call alone never completes a task.

MCP scope: Represent external MCP calls as durable task-linked operations/effects and MCP resource reads as versioned or explicitly uncertain dependencies. Persist server/tool identity, observed catalog version, outcome and recovery handle without equating a protocol task with a NimbleNewt task.

Additional MCP completion criteria: Crash, timeout and restart preserve confirmed versus uncertain MCP effects; retries do not blindly duplicate effectful calls and stale resource observations trigger resume review.

### [AII-255](http://192.168.2.10:3100/AII/issues/AII-255) · N05 — Implement Pause, Suspend, release and Stop

Depends on: N04, N06, N07.

Permission and retained-context prerequisites are required for checked resume.

Implement scoped lifecycle gates, bounded cleanup, background-job settlement/checkpointing, suspend-to-disk, prepared handoff and graceful Stop. Force Stop is an explicit or preauthorized exception.

Completion criteria: Pause and Suspend retain ownership; release is explicit; reboot recovery preserves context and manual holds. Verify interruption during cleanup and unresolved remote work without duplicate execution.


Accepted resume-reconciliation scope: Implement gated collect/verify/review/commit resume using the dependency manifest, event replay plus current-version verification, permission-filtered deltas and explicit external freshness. Reconcile uncertain effects before ready.

Additional completion criteria: Task A resumes only after reviewing relevant changes; manual/parent holds survive; post-review changes trigger re-reconciliation; missing artifacts, churn and uncertain effects remain visible blockers.

### [AII-256](http://192.168.2.10:3100/AII/issues/AII-256) · N06 — Enforce permissions and agent environment isolation

Depends on: N02, N04.

Implement capability checks, per-agent environments, secret boundaries, shared workspace policies and protected repository metadata including .git. Select appropriate containment per OS.

Completion criteria: Unauthorized tool, filesystem, symlink and credential access denied through every exposed route; ordinary agent customization cannot expand authority. Publish tested isolation limits.


Accepted resume-reconciliation scope: Enforce permission-filtered dependency retrieval/deltas, isolated task workspaces and conditional shared-file writes through every authorized path. Protect revoked/private metadata and reject conflicting writes.

Additional completion criteria: Revocation does not leak delta content/metadata; shared-file target changes fail atomically; shell/mount paths cannot bypass version checks; worktree integration preserves dirty work.

MCP scope: Apply task/project capability checks to MCP server registration, discovery, resource reads, prompt use and tool invocation. Sandbox local server processes; protect remote credentials and endpoints; treat server content as untrusted and redact restricted payloads.

Additional MCP completion criteria: Unapproved or revoked capabilities, cross-project resources, credential leaks, prompt injection and alternate direct paths are denied; local and remote transports receive equivalent scope checks.

### [AII-257](http://192.168.2.10:3100/AII/issues/AII-257) · N07 — Build agent desks and retrievable context

Depends on: N04, N06.

Separate task, chat and meeting histories; store owner-written peer-readable work records, private scratch and source-backed retrieval. Support summaries with links to full records, export and retention.

Completion criteria: Switch away and return with decisions and next steps intact; retrieval respects scopes and provenance; memory growth remains bounded; no claims of recovering hidden model reasoning.


Accepted resume-reconciliation scope: Capture source-backed read dependencies and targeted delta packets in the retained task history. Link assumptions and derived evidence to exact inputs; preserve original checkpoints and relevance-review decisions.

Additional completion criteria: Directory/search additions and indirect/unknown coverage receive conservative review; relevant updates enter retained task context without merging incidental chat; permission boundaries and provenance hold.

### AII-519 · N07a — Expose a durable state API

Depends on: N00, N01, N04, N06, N07.

Expose permission-checked, versioned operations for authorized clients to create, read, edit, and query agent and task state, including checkpoints, assignments, shared desk records, and evidence references. Keep private scratch private and peer desk writes forbidden. Require stable identities, expected revisions, idempotency, audit history, bounded retrieval, and clear accepted-versus-completed results. Use the same controller authority as the UI and harness tools.

Completion criteria: State survives restart on macOS, Linux, and Windows; concurrent edits reject stale writers, retries apply once, and direct API calls cannot cross project, privacy, lifecycle, or ownership boundaries. Document and test the contract. See [Agent APIs](nimblenewt/agent-apis.md).

Project-delivery scope: Expose permission-filtered, revisioned project/task/deliverable queries and writes from the authoritative controller. Include current owner, assignment history, last observed execution and freshness, blockers, exact output versions, review state and attributable tool activity; use bounded filters and pagination.

Additional project-delivery completion criteria: Chat, UI and API report the same scoped project facts; stale or unreachable work is not shown as active, restricted tool payloads and cross-project outputs do not leak, and competing assignment or deliverable edits reject stale revisions.

MCP scope: Expose permitted state operations and resources through a controller-backed MCP adapter with the same revisions, permissions, lifecycle gates, idempotency and audit trail as native API clients. Keep remote exposure opt-in.

Additional MCP completion criteria: A compatible MCP client reads and edits scoped state through the same authority as UI/API; private scratch, stale writes and manual holds remain protected, and protocol reconnect does not create a second state owner.

### [AII-258](http://192.168.2.10:3100/AII/issues/AII-258) · N08 — Implement configurable model routing and fallback

Depends on: N03, N04, N06.

Provide difficulty profiles, ordered backup routes, budget limits and provider exclusions. Apply policy to every role, including supervisors and meetings; define drain versus cancellation behavior.

Completion criteria: New dispatch avoids disabled providers immediately; fallback respects capabilities, data-sharing rules and limits; no eligible model yields a visible blocker. Fake-provider failure tests do not repeat effects.

### [AII-259](http://192.168.2.10:3100/AII/issues/AII-259) · N09 — Build the conversational interface and inspection views

Depends on: N05, N07, N08, N07a.

Let the owner discuss projects, assign authorized work, ask status, change priorities and invoke lifecycle/model settings. Provide activity, transcript and evidence views alongside chat.

Use the same controller operations as the state API (N07a) and conversation API (N10a); the UI must not bypass their permissions or show a queued request as completed work.

Completion criteria: A user can plan a task, interrupt it with a question and return; UI distinguishes accepted requests from completed actions and observed state. History replay never reexecutes tools.

Project-delivery scope: Make chat the primary interface for project status and planning, backed by a project overview showing goals, tasks, current assignees versus observed active attempts, blockers, deliverables, reviews, recent tool activity and freshness. Link every answer to authoritative task and evidence records, with optional workstreams/milestones.

Additional project-delivery completion criteria: Answer who owns and is presently working on work, what is blocked, which tools were used, and what was delivered. Chat and overview agree through pause, worker disconnect, pending review and uncertain tool outcomes; proposed work is not shown as applied or completed.

MCP scope: Show configured MCP connection status and task-linked tool/resource activity in chat and project views, distinguishing approved capability, current availability, observed version, completed result and uncertain effect.

Additional MCP completion criteria: The owner can ask which MCP server/tool was used and what happened; UI status agrees with the authoritative operation record and never shows an unavailable server or uncertain call as completed work.

### [AII-260](http://192.168.2.10:3100/AII/issues/AII-260) · N10 — Implement team hierarchy and event-driven coordination

Depends on: N04, N06, N07.

Implement supervisor assignments, scoped inter-agent messages, dependencies, external event ingestion, batching, backpressure and bounded delegation. Keep human authority above team decisions.

Provide the inbox, identity and delivery rules used by the two-way API in N10a; external agents do not gain worker or supervisor authority by sending a message.

Completion criteria: Multiple specialists coordinate without duplicate ownership or message storms; deduplicate events, detect circular waits, preserve priority changes and respect manual lifecycle gates.


Accepted resume-reconciliation scope: Provide durable scoped change ingestion, per-stream cursor replay, batching/deduplication and gap detection. Watchers are hints; actual hashes/revisions remain authoritative.

Additional completion criteria: Missed/duplicate events and restart do not lose detection; expired retention invokes direct reconciliation; incoming events never lift manual holds.

### AII-520 · N10a — Expose an inter-agent conversation API

Depends on: N00, N01, N04, N06, N07, N07a, N10.

Let NimbleNewt agents and authorized agents on other harnesses each initiate a durable thread and carry on multiple back-and-forth turns. Support replies, follow-up questions, recipient discovery, correlated messages, queued/delivered/answered states, cursor-based recovery, and bounded interruptions. Compare HTTP polling or streaming, optional WebSockets, and an MCP adapter without making any connection the source of conversation state.

Completion criteria: Both sides can initiate and resume a multi-turn conversation after disconnect or restart; retries do not duplicate turns or wakeups; privacy, hierarchy, project scope, Pause/Suspend, and human authority hold through direct API access. Document and test the contract. See [Agent APIs](nimblenewt/agent-apis.md).

MCP scope: Offer durable two-way conversation operations to compatible external agents through the controller-backed MCP adapter, using the same participant authorization, message IDs, cursors and lifecycle policy as native transport.

Additional MCP completion criteria: Both sides continue a multi-turn conversation after disconnect/restart through MCP without duplicate turns, private-data leakage or dependence on a live MCP transport session.

### [AII-261](http://192.168.2.10:3100/AII/issues/AII-261) · N11 — Add supervisor recovery for stalled agents

Depends on: N05, N08, N10.

Detect repetitive failures and lack of useful progress from observable evidence. Allow scoped correction, stuck-request interruption, eligible model/context changes and prepared takeover. Monitor supervisors too.

Completion criteria: Recover a looping agent without losing history or replaying effects; distinguish long legitimate work and waits; enforce cumulative retry/time/cost limits; escalate persistent blockers to the owner.

### [AII-262](http://192.168.2.10:3100/AII/issues/AII-262) · N12 — Implement stand-ups and urgent meetings

Depends on: N09, N10.

Support scheduled and immediate meetings with agenda items, orderly discussion, votes and short reasons, owner participation, unattended delegated decisions, summaries and full transcripts.

Completion criteria: No duplicate catch-up meetings or automatic override of holds; present owner agreement is required before acting; absent-owner actions stay delegated; recorded dissent and deferred agenda items survive restarts.

### [AII-263](http://192.168.2.10:3100/AII/issues/AII-263) · N13 — Build personal extensions and the shared toolbox

Depends on: N03, N06, N07, N10.

Separate protected system tools, maintainer-managed shared tools and personal forks. Support source-readable shared tools, exact-version review, promotion, extension installation and controlled restart.

Completion criteria: Agents can propose improvements without editing shared releases; permissions apply before install hooks; namespace collisions and revoked tools fail safely; activation preserves tasks and supports rollback.

Project-delivery scope: Attribute each protected, shared and personal tool invocation to the project, task, agent, attempt and immutable tool version. Record dispatch, result or uncertain outcome, bounded logs and available time/resource use while enforcing audience and payload restrictions.

Additional project-delivery completion criteria: Project summaries show useful tool activity and exact versions without exposing secrets or raw private data. A running call, failed call or call with an uncertain result cannot be mistaken for a delivered outcome.

MCP scope: Implement NimbleNewt as an MCP client for approved local/remote servers. Register connections and scoped credentials, discover/version tools/resources/prompts, refresh catalogs, invoke through the protected bridge, and surface connection configuration in the UI.

Additional MCP completion criteria: An agent discovers and uses an approved MCP capability in its task without worker restart; changed catalogs or revoked grants are rechecked; effectful failures remain uncertain until reconciled; exact server/tool identity appears in activity records.

### [AII-264](http://192.168.2.10:3100/AII/issues/AII-264) · N14 — Support multi-repository and ongoing operational work

Depends on: N05, N06, N09, N10, N13.

Add generic project/responsibility registration and adapters for isolated coding workspaces, QA, documentation and sandbox server operations. Extend role templates to research, support, marketing and design.

Completion criteria: Demonstrate work spanning two repos and a simulated ongoing service without adding NimbleNewt metadata to repos. Preserve dirty work, organizational review rules and scoped operational authorization.

Project-delivery scope: Register durable projects before any repository binding, support multiple repositories and non-code deliverables, and link tasks, responsibilities, outputs and optional workstreams across them. Keep NimbleNewt metadata outside target checkouts.

Additional project-delivery completion criteria: A project begins in chat without a repository, later spans two repositories plus an operational responsibility, and its task ownership and deliverables remain coherent without adding internal files to either repository.

### [AII-265](http://192.168.2.10:3100/AII/issues/AII-265) · N15 — Implement QA evidence and independent review gates

Depends on: N06, N10, N14.

Require self-checks, scoped independent QA where configured, artifact-version-bound acceptance evidence and documentation impact tracking. Support both personal and team-wide QA roles.

Completion criteria: Review uses actual artifacts and tests; stale approvals are invalidated; role titles do not confer permissions. Demonstrate user/developer documentation updates tied to changes.


Accepted resume-reconciliation scope: Invalidate assumptions, artifacts, tests and approvals when their recorded dependencies change; preserve historical evidence and require revalidation against the combined current version.

Additional completion criteria: Input changes flag dependent evidence; semantic irrelevance is recorded by review; stale approvals cannot authorize changed artifacts; integration conflicts require updated checks.

Project-delivery scope: Treat deliverables as versioned task outputs or verified operational results with responsible agent, exact artifact/system version, intended audience and review state. Attach self-checks and independent approval to that exact version and mark affected evidence stale after change.

Additional project-delivery completion criteria: Submission is distinct from acceptance and task completion; missing or changed outputs and stale reviews cannot appear as delivered. A rejected or superseded version keeps its history while the project overview shows the current review state.

### [AII-266](http://192.168.2.10:3100/AII/issues/AII-266) · N16 — Balance delivery and capacity improvement

Depends on: N10, N13, N15.

Track production and production-capacity tasks, configurable budgets and protected improvement opportunities. Route tooling and NimbleNewt improvement proposals through stand-ups and authorized review.

Completion criteria: Measure useful outcomes and actual spending without quota busywork or unbounded catch-up debt. Defaults remain configurable; improving NimbleNewt itself is an optional deployment workflow.

### [AII-267](http://192.168.2.10:3100/AII/issues/AII-267) · N17 — Implement backup, recovery and controlled updates

Depends on: N05, N06, N13.

Build consistent backup/export/restore and a deterministic updater outside model control. Stage approved exact releases, migrate versioned data and activate in maintenance windows with startup checks.

Completion criteria: Failed activation returns to a compatible known-good release; restore and rollback do not replay external effects or silently rewind incompatible data. Test interrupted migrations and recovery without a model.

### [AII-268](http://192.168.2.10:3100/AII/issues/AII-268) · N18 — Qualify complete workflows on all required platforms

Depends on: N11, N12, N15, N16, N17.

Run real integration and fault tests on macOS, Linux and Windows across lifecycle, routing, meetings, isolation, workload recovery and updates. Include non-coding workflows and resource limits.

Measure controller and worker overhead separately from model/provider latency and tool execution before claiming a language-level performance bottleneck. If a Rust component is proposed, compare it against the TypeScript path under the same workload and verify equivalent recovery, permissions, packaging and behavior on all three operating systems.

Completion criteria: Publish reproducible evidence tied to versions; demonstrate reboot/suspend, blocked supervisor, provider loss, safe handoff, meeting decisions and update failure. No silent platform skips or historical probe results presented as qualification.


Accepted resume-reconciliation scope: Qualify the resume contract with fixtures across all platforms, including non-Git/uncommitted edits, directory/query changes, revoked permissions, external ETags/unversioned freshness and races.

Additional completion criteria: Pass the resume contract acceptance matrix: cursor expiry, missing artifacts, unknown outcomes, continuous churn, stale attempts and changes between review/commit; publish evidence with versions.

Project-delivery scope: Qualify an end-to-end project flow from assignment and tool use through pause or worker loss, handoff, deliverable submission, review and completion. Compare chat, overview and state API at each transition on macOS, Linux and Windows.

Additional project-delivery completion criteria: All three surfaces agree on owner, active or stale execution, blockers, tool outcome, deliverable version and acceptance evidence. Cross-project access is filtered; an uncertain effect, stale review or unavailable artifact never becomes a false completion.

MCP scope: Qualify MCP client and server-side paths on macOS, Linux and Windows, including connection setup, approved tool/resource use, permission revocation, changed catalogs, prompt injection, server outage, resume freshness and multi-turn adapter recovery.

Additional MCP completion criteria: End-to-end tests show correct task/project attribution, no unsafe retry or data leak, matching chat/UI/API outcomes, and durable work state independent of MCP connections. Publish supported-version and unsupported-feature evidence.

### [AII-269](http://192.168.2.10:3100/AII/issues/AII-269) · N19 — Prepare documentation and release readiness

Depends on: N18.

Finish installation, configuration, user/developer guides, examples, diagnostics, contribution and security reporting, MIT/dependency notices and release checklist. Keep public defaults environment-neutral.

Completion criteria: A fresh installation follows the guides on each supported OS. Record known limitations and independent review. Publishing packages, deploying services or announcing a release needs separate explicit authorization.

