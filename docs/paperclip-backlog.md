# NimbleNewt — inactive planning backlog

All tasks are unassigned Backlog. Only planning is authorized; implementation must wait for Rob.

## Proposed task sequence

### [AII-250](http://192.168.2.10:3100/AII/issues/AII-250) · N00 — Human decision: authorize NimbleNewt work

Depends on: Rob’s explicit authorization.

Record Rob’s explicit authorization, selected scope and priorities before starting any implementation or research tasks. Creating this project is planning-only authorization.

Completion criteria: Only Rob may clear this gate. Record the exact authorized outcome and budget; choose which tasks may become actionable. Do not treat this backlog, an available coder slot, or completion of another project as permission.

### [AII-251](http://192.168.2.10:3100/AII/issues/AII-251) · N01 — Agree on architecture and first useful release

Depends on: N00.

Review the design with Rob and any collaborator. Resolve initial worker placement, storage/transport, UI approach, supported OS versions, lifecycle budgets and first-release scope. Separate accepted requirements from proposed defaults.

Completion criteria: Approved architecture decisions and a demonstrable first-release scenario; unresolved choices remain explicit. Do not silently commit to multi-host workers or multi-human administration.

### [AII-252](http://192.168.2.10:3100/AII/issues/AII-252) · N02 — Establish the portable project foundation

Depends on: N01.

Create controller, worker adapter and UI package boundaries, versioned configuration, credential references, MIT notices, contributor/security guidance and CI for macOS, Linux and Windows. Keep private installation settings outside source.

Completion criteria: Clean setup and an offline smoke check on each OS; no required changes in target repos or hardcoded providers; dependency licenses and notices recorded.

### [AII-253](http://192.168.2.10:3100/AII/issues/AII-253) · N03 — Qualify the Pi Durable adapter

Depends on: N02.

Pin the runtime, map public task IDs and commands to harness operations, reserve nimblenewt namespaces, and qualify cancellation, storage, extension replacement and restart semantics. Extend existing offline probes across platforms.

Completion criteria: Repeatable evidence on all three OSes; queued input survives cancellation; API/command collisions fail safely; version upgrade checks preserve saved state. Document unsupported behavior.

### [AII-254](http://192.168.2.10:3100/AII/issues/AII-254) · N04 — Implement durable tasks and effect records

Depends on: N02, N03.

Implement stable task/agent identities, assignments, inboxes, attempt records, checkpoints, event ordering, idempotency and exclusive writer enforcement. Record external effect outcomes separately from model replies.

Completion criteria: Fault-injected crash/restart preserves acknowledged work, rejects stale writers, deduplicates delivery and reconciles uncertain effects without blindly replaying actions.

### [AII-255](http://192.168.2.10:3100/AII/issues/AII-255) · N05 — Implement Pause, Suspend, release and Stop

Depends on: N04.

Implement scoped lifecycle gates, bounded cleanup, background-job settlement/checkpointing, suspend-to-disk, prepared handoff and graceful Stop. Force Stop is an explicit or preauthorized exception.

Completion criteria: Pause and Suspend retain ownership; release is explicit; reboot recovery preserves context and manual holds. Verify interruption during cleanup and unresolved remote work without duplicate execution.

### [AII-256](http://192.168.2.10:3100/AII/issues/AII-256) · N06 — Enforce permissions and agent environment isolation

Depends on: N02, N04.

Implement capability checks, per-agent environments, secret boundaries, shared workspace policies and protected repository metadata including .git. Select appropriate containment per OS.

Completion criteria: Unauthorized tool, filesystem, symlink and credential access denied through every exposed route; ordinary agent customization cannot expand authority. Publish tested isolation limits.

### [AII-257](http://192.168.2.10:3100/AII/issues/AII-257) · N07 — Build agent desks and retrievable context

Depends on: N04, N06.

Separate task, chat and meeting histories; store owner-written peer-readable work records, private scratch and source-backed retrieval. Support summaries with links to full records, export and retention.

Completion criteria: Switch away and return with decisions and next steps intact; retrieval respects scopes and provenance; memory growth remains bounded; no claims of recovering hidden model reasoning.

### [AII-258](http://192.168.2.10:3100/AII/issues/AII-258) · N08 — Implement configurable model routing and fallback

Depends on: N03, N04, N06.

Provide difficulty profiles, ordered backup routes, budget limits and provider exclusions. Apply policy to every role, including supervisors and meetings; define drain versus cancellation behavior.

Completion criteria: New dispatch avoids disabled providers immediately; fallback respects capabilities, data-sharing rules and limits; no eligible model yields a visible blocker. Fake-provider failure tests do not repeat effects.

### [AII-259](http://192.168.2.10:3100/AII/issues/AII-259) · N09 — Build the conversational interface and inspection views

Depends on: N05, N07, N08.

Let the owner discuss projects, assign authorized work, ask status, change priorities and invoke lifecycle/model settings. Provide activity, transcript and evidence views alongside chat.

Completion criteria: A user can plan a task, interrupt it with a question and return; UI distinguishes accepted requests from completed actions and observed state. History replay never reexecutes tools.

### [AII-260](http://192.168.2.10:3100/AII/issues/AII-260) · N10 — Implement team hierarchy and event-driven coordination

Depends on: N04, N06, N07.

Implement supervisor assignments, scoped inter-agent messages, dependencies, external event ingestion, batching, backpressure and bounded delegation. Keep human authority above team decisions.

Completion criteria: Multiple specialists coordinate without duplicate ownership or message storms; deduplicate events, detect circular waits, preserve priority changes and respect manual lifecycle gates.

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

### [AII-264](http://192.168.2.10:3100/AII/issues/AII-264) · N14 — Support multi-repository and ongoing operational work

Depends on: N05, N06, N09, N10, N13.

Add generic project/responsibility registration and adapters for isolated coding workspaces, QA, documentation and sandbox server operations. Extend role templates to research, support, marketing and design.

Completion criteria: Demonstrate work spanning two repos and a simulated ongoing service without adding NimbleNewt metadata to repos. Preserve dirty work, organizational review rules and scoped operational authorization.

### [AII-265](http://192.168.2.10:3100/AII/issues/AII-265) · N15 — Implement QA evidence and independent review gates

Depends on: N06, N10, N14.

Require self-checks, scoped independent QA where configured, artifact-version-bound acceptance evidence and documentation impact tracking. Support both personal and team-wide QA roles.

Completion criteria: Review uses actual artifacts and tests; stale approvals are invalidated; role titles do not confer permissions. Demonstrate user/developer documentation updates tied to changes.

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

Completion criteria: Publish reproducible evidence tied to versions; demonstrate reboot/suspend, blocked supervisor, provider loss, safe handoff, meeting decisions and update failure. No silent platform skips or historical probe results presented as qualification.

### [AII-269](http://192.168.2.10:3100/AII/issues/AII-269) · N19 — Prepare documentation and release readiness

Depends on: N18.

Finish installation, configuration, user/developer guides, examples, diagnostics, contribution and security reporting, MIT/dependency notices and release checklist. Keep public defaults environment-neutral.

Completion criteria: A fresh installation follows the guides on each supported OS. Record known limitations and independent review. Publishing packages, deploying services or announcing a release needs separate explicit authorization.

