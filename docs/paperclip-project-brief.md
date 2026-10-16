# NimbleNewt — project goals and execution hold

**Planning only. Not authorized to start.** Rob authorized project registration, goal documentation and a task outline on October 7, 2026. No agent research, implementation, review runs, dispatch, publication or deployment is authorized by this import. Keep all issues unassigned in Backlog and outside automatic scheduling until Rob explicitly selects work. Do not remove the activation dependency automatically.

## Purpose

Build a persistent, conversational team of AI agents for one human owner. Agents coordinate across projects, keep durable context, and resume work after interruptions or restarts. Work includes development, QA, operations, research, support, marketing, graphics and user/developer documentation.

## Goals

1. Let the owner plan and direct work through conversation, with decisions taking precedence over agent votes.
2. Preserve task context, assignments and effects through Pause, Suspend, explicit release, Stop and restart; never silently duplicate external actions.
3. Coordinate agents through scoped messages, supervisors, events and scheduled or urgent meetings, with summaries, full transcripts and reasoned votes.
4. Provide configurable difficulty-based models and ordered fallback routes, respecting provider exclusions, budgets and data permissions.
5. Give agents independent desks and environments, protected system tools and a reviewed shared toolbox, with enforced access boundaries.
6. Detect stalled or looping work and enable bounded supervisor recovery without losing context or bypassing human holds.
7. Work across existing repositories and services without polluting target repositories; support macOS, Linux and Windows.
8. Make work inspectable and independently reviewable; balance delivery with capacity improvement. Ship under MIT with portable public defaults and controlled updates.

## Current evidence and open decisions

The repository contains design documentation, mascot assets and limited offline harness experiments. Pi Durable is the selected initial runtime direction; it is not yet qualified for the full product. Existing recovery experiments were run on macOS and do not establish Linux/Windows, reboot, isolation or provider-failover behavior.

Worker topology, storage/transport, OS support details, numerical budgets and the first useful release remain decisions to make. The sequence below is a proposed implementation outline, not an approved MVP or execution schedule. Optional self-development of NimbleNewt is separate from normal product use.

## Sources

- Repository: https://github.com/rkcth/NimbleNewt
- Current local source: `/Volumes/RobsExternalDrive/Programming/AIImageMaker/NimbleNewt`
- Design: `docs/nimblenewt/README.md`, `design-decisions.md`, `operational-contracts.md`, `pitfalls-and-safeguards.md`, and supporting documents.
- The planning issue holds a versioned snapshot of the design documents. The October 16 synchronization publishes the current planning changes to GitHub and creates a server reference checkout at `/srv/code/repos/nimblenewt`. This is a reference copy, not an activated execution workspace; N00 remains closed.

## Activation

Rob must explicitly authorize scope before N00 is completed. The team can then select eligible tasks, assign owners and register only authorized work with the scheduler. No agent is assigned during onboarding. Project status alone is not an execution lock; unassigned backlog state, the human gate and exclusion from scheduler authorization enforce the current hold.

## Paperclip registration

- [Project](http://192.168.2.10:3100/AII/projects/nimblenewt) — Backlog, no lead agent.
- [Planning documents and human activation gate](http://192.168.2.10:3100/AII/issues/AII-250).
- Work outline: AII-251 through AII-269, all unassigned Backlog and outside scheduler authorization.
- Registered October 7, 2026; no execution workspace provisioned and no implementation started by onboarding.

## Approval and learning requirements — October 15, 2026

Public installations start with tight approvals and offer easy scoped relaxation through authenticated chat and UI. Separate direct owner authorization, derived authority, standing grants, independent technical review and execution admission. Rob’s private installation carries his existing grants; public installations inherit none of them. Users may choose stricter or more autonomous policies per project, environment, action, budget or maintenance window.

Support independent agent review before any configured command, using immediate bounded inquiries that preserve both agents’ assignments and context rather than transferring a task to a supervisor. Preserve mandatory human review such as reviewing the exact code before commit, with developer/agent/reviewer attribution. Measure review latency; do not claim it is already faster. Corporate integration does not silently expand the single-human-owner installation model.

Implement an event-driven learning lifecycle: observation, candidate, triage, bounded experiment, evaluation, scoped adoption, monitoring and retention/revision/withdrawal. Version lessons and skill usage with source evidence, applicability, dependencies, contradictions and supersession. Deduplicate evidence, preserve paused-task compatibility subject to revocation, and account for reflection and monitoring within existing P/PC limits. Learning cannot weaken its own criteria or approval rules.

The complete contracts are `docs/nimblenewt/authorization-and-delegation.md` and `docs/nimblenewt/learning-and-improvement.md`. These planning updates do not authorize implementation or clear N00.

Paperclip synchronization verified October 15, 2026: project and goal descriptions updated; current design snapshot, implementation outline, project goals, authorization contract and learning contract saved on AII-250. Learning lifecycle is AII-615; existing affected tasks were amended without changing assignments or activating work.

## Conversational policy authoring and task management

Accepted owner clarification, October 15, 2026: freeform conversation with agents is the primary way to configure decisions and direct work. Presets, forms and policy fields are optional conveniences, not the limits of what the owner can express. The owner should not need to create tickets, edit dependencies, assign agents or move task statuses to obtain an authorized outcome. Direct task management remains available to the owner and authorized API clients.

An authorized agent can receive a policy instruction in ordinary language, resolve its intended scope using the conversation and current project context, and record the original wording alongside a versioned operational interpretation. Support contextual conditions, exceptions, combinations and later amendments, not just a fixed list of approval modes. For example: “Handle development deployments yourselves; have another agent check commands touching customer data; let me review code before any commit in this repository.” A later “Allow commits for this prototype only until Friday” changes that scope without dropping unrelated restrictions. Resolve dates/timezones and project references from known context; clarify only material uncertainty.

Apply clear authorized edits through the common configuration service and report the resulting scope and effective behavior in plain language. Do not require a form, special syntax, a task ID or redundant confirmation of a clear owner instruction. If intent conflicts with a retained owner restriction, is materially ambiguous, or cannot be enforced with available capabilities, explain the specific issue and seek only the missing decision. Do not silently discard a condition or claim an unsupported rule is active. Preserve natural-language intent and provenance, distinguish proposed/accepted/applied states, and surface the actual interpretation for correction. Context-dependent judgment may use an authorized agent review at execution; deterministic services still enforce grants, mandatory gates and version checks. A freeform policy is not merely prompt text that a worker can ignore or rewrite.

Agents handle decomposition, task creation, dependencies, assignment proposals or authorized assignment changes, progress, recovery and completion evidence within the user's granted scope. Existing grants permit routine task administration without repeated approval; a strict policy may still require approval of the substantive action. Do not turn every internal task transition into a separate human decision. The owner can discuss outcomes, change priorities, interrupt, ask status and correct direction without managing a board. Agents must persist these changes in authoritative records rather than only promise them in conversation. Explicit planning-only instructions and implementation holds remain binding.

UI, conversation, API and external adapters use the same versioned records and permission checks. Direct owner/API edits appear in subsequent agent context; concurrent edits reject stale writes and are reconciled before execution. Record the authenticated origin separately from a forwarding agent; an arbitrary message is not an owner instruction. Any appropriately authorized agent can handle or route the conversation through a bounded inquiry, without requiring a particular CTO or transferring the original task. Preserve privacy and lifecycle holds.

Qualification: complete an authorized project scenario entirely through conversation, including policy creation, a scoped exception, task decomposition/coordination, a changed priority and delivery, with no required task-board interaction. Verify unsupported/ambiguous policy handling, scoped amendments, direct UI/API edits racing conversational edits, revocation, restart and retained provenance. Assert that relaxing one condition preserves the mandatory human code-review gate elsewhere and that a planning request never activates implementation.
