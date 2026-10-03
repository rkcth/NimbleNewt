# NimbleNewt concept draft

**NimbleNewt is a system for running a persistent team of AI agents that can work independently, collaborate, and adapt without losing their place.**

Each agent has its own identity, memory, and customizable environment. Agents can pause, switch tasks, and resume—even after a reboot—while coordinating through a hierarchy, messages, shared work records, and regular planning.

The system matches models and tools to task difficulty, manages interruptions and resources, and enforces boundaries so agents can improve their own workflows without damaging each other’s work or the underlying system.

NimbleNewt supports both finite projects and ongoing responsibilities: software development, QA, marketing, support, graphic design, research, planning, user and technical documentation, and operating systems and services. Each installation has one human owner directing a persistent team of agents. A developer can install it on their development machine and submit changes through their organization's existing review process; an operations agent can maintain a server, keep deployed code updated, and check that services are working. Coding is an important use case, not the product boundary. Coworkers need no account in that owner's NimbleNewt installation.

Conversation is the primary interface: the user can ask what is happening, request help, develop a project idea, and direct work across multiple repositories. NimbleNewt keeps its operational state outside those repositories and requires no special repository documents.

NimbleNewt is intended to become a standalone open-source project. Its core must work independently of this repository and any particular deployment. Model routes, local inference services, and environment preferences belong in configuration that users can manage through the UI. See [Standalone distribution and configuration](portability-and-configuration.md).

**macOS, Linux, and Windows are required platforms.** Installation, UI and conversational controls, agent execution, configuration, and durable recovery must be qualified on all three; platform support is a requirement, not a claim about the current prototype experiments.

Created October 3, 2026. NimbleNewt is the selected project name. This document separates accepted product requirements, proposed mechanisms, deployment-specific workflows, and measured evidence. A requirement is not an implementation claim. Numeric defaults and open decisions are tracked in the [design decision register](design-decisions.md).

## Document guide

| Document | Purpose |
| --- | --- |
| This README | Product behavior and relationships between features. |
| [Operational contracts](operational-contracts.md) | Definitions, state/ownership rules, authority, durable operations, and recovery boundaries. |
| [Organization and workers](organization-and-workers.md) | Accepted single-owner model and separately proposed local/remote worker topology. |
| [Design decisions](design-decisions.md) | Accepted choices, pending user questions, proposed defaults, and remaining engineering decisions. |
| [Portability and configuration](portability-and-configuration.md) | Standalone product boundary, required platforms, and UI-managed settings. |
| [Production and capacity](production-and-capacity.md) | Delivery/improvement scheduling, budgets, and evaluation. |
| [Runtime compatibility and namespaces](runtime-compatibility-and-namespaces.md) | Selected runtime, command identity, and version compatibility. |
| [Maintenance and updates](maintenance-and-updates.md) | Public release installation, activation checks, and rollback boundaries. |
| [NimbleNewt development workflow](development-workflow.md) | Our optional deployment-specific process for improving NimbleNewt's source and building candidates. |
| [Pitfalls and safeguards](pitfalls-and-safeguards.md) | Failure modes, required protections, and validation. |
| [Harness comparison](harness-comparison.md) | Current selection and clearly labeled historical alternatives. |
| [Harness test results](harness-test-results.md) | Exact scope and limitations of experiments; links to reproducible probes. |
| [Regular pi research](pi-integration-research.md) | Historical extension/API research; not the Pi Durable integration contract. |

## Public product and our development deployment

Public NimbleNewt helps users deliver their own projects and improve their tools, skills, and workflows. It does not ship a required team, backlog, credentials, or automatic development loop for modifying NimbleNewt itself. General feedback, PC planning, project work, and tool promotion are reusable product capabilities.

Our NimbleNewt development team uses those ordinary capabilities to work on the NimbleNewt repository, with optional build/release integrations and explicitly delegated permissions. Agent-authored candidate creation is deployment-specific. Installing an authorized official release with maintenance and recovery support is a separate public-product capability; installation does not require agents to develop NimbleNewt. See [the development workflow](development-workflow.md) for the boundary.

## Project name

The selected name is **NimbleNewt**, a three-syllable, alliterative name suggesting adaptability and responsiveness. Use `nimblenewt` for package names, paths, and reserved command prefixes such as `/nimblenewt.pause`.

Initial checks found no matching GitHub repositories, exact npm or PyPI packages, or public GitHub account at `nimblenewt`. GitHub organization-name availability must still be confirmed at creation. The `.com` domain is registered, which is not a blocker for this project. These checks are not trademark clearance.

## Requested behavior

- One human owner directs each installation. Teams, supervisors, and delegated roles are agents; multiple human accounts and shared human administration are outside the current design. This is independent of how many computers run workers.
- Multiple agents can operate through different harnesses and communicate within a hierarchy.
- Each agent owns a durable desk. Work records are readable by authorized peers within their sharing scope but writable only by the owner; a private scratch area holds temporary notes. Agents can ask the owner for interpretation or missing information.
- Each agent should have a customizable environment, including its own harness configuration, extensions, and skills, without changing other agents’ environments. Isolation, shared workspace access, safety supervision, and protection of critical files are design areas to develop.
- Agents can branch into another task, briefly respond to a message, or revisit earlier work without starting over.
- Support Pause, which allows existing background tasks to continue, and Suspend, which performs bounded preparation, persists state, and releases execution for shutdown and later recovery. Suspension may take additional time to complete.
- Pause and Suspend retain all assigned tasks with their agent. Suspend and Release explicitly prepares selected tasks for release and reassignment after safe cleanup. Rebooting the server uses Suspend without releasing ownership.
- Support immediate routing changes to configured backup models when any selected provider or local inference service must be taken offline or becomes unavailable, while recovering in-flight work explicitly.
- Parents assign task difficulty. Configurable policies map difficulty to execution settings, such as a local model for simple work, an OpenRouter route for medium work, and a powerful cloud model such as Astra for difficult work. These are illustrative user preferences, not verified integrations.
- Communication must allow collaboration without agents continually interrupting one another.
- A daily stand-up covers the preceding 24 hours, progress, blockers, requests for advice, and plans for the day.
- Agents respond to events and revise plans as priorities change.
- Chat is the primary interface for status, help, brainstorming, project drafting, and directing work. Task views and dashboards support conversation rather than being required to operate the system.
- The user's explicit choices take precedence over team proposals, votes, reviews, and prior agent decisions. Agents may explain concerns or recommend alternatives, but cannot replace the user's choice with their own consensus.
- Projects can span multiple repositories, and repositories can participate in multiple projects. Existing open source checkouts must work without adding NimbleNewt-specific documents, configuration, history, or state to them.
- NimbleNewt can be extracted into its own repository and distributed as an independent open-source application. No particular local coder, provider, host path, or existing orchestration installation is required. Users can configure their deployment, difficulty profiles, and ordered model fallbacks through the UI.
- NimbleNewt must work on macOS, Linux, and Windows with the same core lifecycle, configuration, and safety guarantees. Platform-specific implementation details belong behind tested adapters; an unavailable optional integration must not make the whole platform unusable.

## Central design proposal

NimbleNewt should own durable task state, scheduling, and communication. A harness executes bounded stretches of work and returns progress to NimbleNewt. An agent's identity and responsibilities persist independently of whichever process, harness, or model currently performs its work.

The important distinction is between preserving a task and preserving a live model computation. NimbleNewt can design for recovery of recorded conversations, tool results, artifacts, decisions, and pending work. It cannot assume that every provider exposes an unfinished generation, hidden model state, or a portable session snapshot. Exact native continuation and reconstruction from durable records must be distinct, visible capabilities.

The proposed baseline is continuation from a committed execution boundary with durable context, without blindly repeating completed effects. Arbitrary live-process restoration is not promised; individual tools may offer checkpoints or durable remote jobs. If a task requires stronger recovery, declare that requirement and qualify an adapter or report the limitation. Harnesses that cannot export enough state should be marked unsupported for durable tasks until an adequate adapter exists.

## Areas of work and collaboration

NimbleNewt supports configurable specialist roles across the work needed to develop, operate, explain, and support a product or service. These are examples of responsibilities, not mandatory departments or a fixed roster. One agent may cover several areas, or several agents may divide a larger responsibility. The same durable tasks, context, permissions, QA, and collaboration contracts apply throughout.

| Area | Example responsibilities and deliverables |
| --- | --- |
| Marketing | Audience research, positioning, campaign plans, launch copy, and analysis of campaign results. Keep factual product claims aligned with verified capabilities and release status. |
| Support | Triage requests, reproduce problems, draft or send authorized responses, maintain help content, and route defects or recurring feedback to the appropriate owner. Track unresolved cases through handoffs. |
| Graphic design | Develop visual concepts, product illustrations, diagrams, brand assets, and campaign graphics. Preserve editable source assets, briefs, revisions, and exports so later changes remain practical. |
| User documentation | Installation instructions, tutorials, feature guides, troubleshooting, and release notes that explain how to use the product. Check instructions against the applicable released version. |
| Development documentation | Architecture, component interactions, APIs, data models, design decisions, setup, and operational runbooks that explain how the system works. Keep these aligned with implementation changes. |
| Development, QA, and operations | Build and validate functionality, investigate defects, maintain services, and feed verified changes and operational findings into the other areas. |

Treat documentation maintenance as ongoing work. Relevant code, configuration, interface, and release changes should trigger a documentation-impact check and assign updates where needed. Record the documentation owner, applicable version, supporting implementation references, and validation status. Distinguish current behavior from proposed or unreleased behavior; stale or unverified instructions must remain visible rather than silently being treated as current. Documentation is a project deliverable where appropriate, distinct from NimbleNewt's private orchestration records, which stay outside target repositories.

Cross-role handoffs should carry the brief, acceptance criteria, exact source/artifact versions, outstanding questions, and intended audience. For example, support can report a recurring problem; development fixes it; QA verifies the result; documentation explains the changed behavior; design supplies illustrations; and marketing prepares an accurate announcement. Model these dependencies as linked work so a release change can flag affected documents, support guidance, and promotional assets for review.

Drafting an asset or response is distinct from publishing it, contacting a customer, or spending a campaign budget. Apply existing delegated permissions to the relevant accounts and audiences; approved routine work can proceed without repeated confirmation. Support records and other private information remain within their sharing scope when informing documentation, marketing, or agent discussion. Each area uses appropriate QA, such as checking support accuracy, testing tutorial steps, or reviewing graphic outputs against their brief.

## Ongoing operational responsibilities

An agent can own a continuing responsibility such as maintaining a server, alongside finite tasks. The responsibility persists after an individual check, update, or incident is complete. It records the managed resources, desired condition, check schedule and event sources, permitted actions, maintenance windows, escalation rules, and operational history. Each check or intervention produces a bounded task or recorded observation rather than an endless model conversation.

For example, a server-maintenance agent can inspect service health, notice an approved software update, prepare and apply that update within its delegated authority, validate the resulting service, and report the outcome. When recovery is safe and authorized it can restore the previous working version; otherwise it records the failure and escalates. Keep intended state, observed state, last successful check, and unresolved incidents distinct. “No recent observation” must not appear as “healthy.”

Use deterministic monitoring and scheduled checks where practical, calling an agent when interpretation or action is needed. Group repeated alerts into the same incident, bound retries and repair attempts, and preserve unresolved incidents through restart. Provider outages or NimbleNewt downtime must be visible as gaps in agent coverage; external monitors may continue independently. A developer's sleeping laptop cannot provide continuous agent response unless execution remains available elsewhere.

Existing lifecycle and permission rules apply. Pause may leave already-running monitors or jobs active, but their events queue without silently resuming the agent. Suspend checkpoints the responsibility and reconciles external jobs on return; it does not automatically shut down the service being maintained. Suspend and Release requires an explicit handoff of monitoring and intervention ownership. Coordinate maintenance by managed resource so two agents cannot concurrently update the same service.

Managing a remote server through an authorized API or remote-execution tool does not require hosting a NimbleNewt agent worker on that server. Multi-host workers remain a separate deployment choice. Updating a managed application is also distinct from updating NimbleNewt itself; each follows its own permissions, validation, and recovery procedure.

## Quality assurance and review scope

Every agent is responsible for checking its own work against the user's requirements and recording relevant validation before claiming completion. QA is also an assignable specialty and ongoing responsibility. An agent may check only its own work, review selected peers or a project, or cover an entire agent team. Team-wide QA within a single-owner installation remains distinct from a developer using NimbleNewt to QA their human organization's work through authorized external repositories and systems; neither requires multiple human NimbleNewt accounts.

| Scope | Responsibility |
| --- | --- |
| Own work | Validate the agent's deliverable, report defects and limitations, and attach evidence. Self-checks are identified as such. |
| Assigned review | Independently examine specified work against its acceptance criteria, reproduce relevant checks, and report findings to its owner. |
| Project or team QA | Maintain a view of quality across authorized work, identify gaps, check integration between contributions, coordinate regression checks, and track unresolved defects. |

QA applies beyond code: a server change needs service-health verification, a research result needs source and claim checks, and a document needs accuracy and completeness checks. Choose checks proportionate to the task and its consequences; a separate QA agent is not mandatory for every task. Team QA complements each contributor's own checks rather than transferring all quality responsibility to the reviewer.

Configure review scope, triggers, required checks, and whether independent review is a completion gate. Access follows the assigned scope; a QA title grants neither universal read access nor permission to edit, deploy, or approve releases. If independent review is required, self-review cannot satisfy it. A QA agent that makes a fix becomes a contributor to that version and cannot independently approve its own changes.

Bind findings and validation to the exact artifact or system version, environment, acceptance-criteria revision, and observation time. Distinguish passed, failed, blocked, and not-run checks; missing evidence is not a pass. Relevant changes invalidate affected results and trigger revalidation. Record defects, severity, evidence, responsible agent, and resolution, with bounded repair/review cycles and escalation for unresolved disagreements. The user's requirements and choices remain authoritative; an explicit override records the decision and remaining findings rather than rewriting a failed check as passed. External organizational review requirements still apply.

QA work uses normal task queues, budgets, durable context, and lifecycle controls. Reviews can be requested when a deliverable is ready, scheduled periodically, or triggered by incidents and changes without continually interrupting contributors. Required review gates stay visible when a reviewer is paused or unavailable; unrelated eligible work can continue. Conversational status should answer questions such as “What has been checked?”, “What is waiting for QA?”, and “Which team-wide risks remain?” with links to evidence.

## Objects the system should own

| Object | Purpose |
| --- | --- |
| Agent | Persistent identity, role, parent, permissions, defaults, and inbox. |
| Project | A durable goal and conversation context that may involve zero, one, or several repositories. |
| Repository binding | A managed association between a project and a repository, with checkout locations, revisions, access scope, and task workspaces. |
| Desk | Owner-written durable work records with shared reading, plus a private scratch area. |
| Environment | An agent's versioned tools, harness configuration, extensions, skills, and bounded execution resources. |
| Responsibility | Continuing objective, owner, managed resources, desired condition, schedules/events, permissions, and incident history. |
| Task | Goal, owner, acceptance criteria, priority, difficulty, dependencies, budget, and lifecycle. |
| Task branch | A separate line of work linked to its origin, with its own context and return destination. |
| Execution attempt | One bounded run using a particular harness, model, and policy version. |
| Checkpoint | Durable task state and references to the evidence and artifacts needed to continue. |
| Message or event | A persisted input with identity, delivery state, urgency, and task association. |

Keep organizational parentage separate from task dependencies: an agent may advise another team without changing its reporting relationship. Delegating a child task should not automatically fork or copy every piece of the parent's context.

## Conversation as the primary interface

The user should be able to work through conversation as they do with a collaborator: ask what is happening, discuss tradeoffs, draft a new project, request a bug fix, or change priorities. A project can begin as an idea before any repository exists. Task lists, timelines, and dashboards remain useful supporting views; operating NimbleNewt must not require managing them manually.

Propose a persistent conversational coordinator that retrieves relevant project records and asks specialist agents for help when necessary. Status answers should use observed task and tool state, identify stale or uncertain information, and distinguish completed work from plans. Routine status questions should not interrupt every worker or require a team meeting.

Conversation can branch among projects while retaining the context of each. The coordinator should resolve project and repository scope from the current conversation and ask a focused question when the target is ambiguous. Switching the conversation's focus must not silently retarget already-running tasks.

Discussing an idea is different from authorizing its execution. The coordinator can develop and save a proposal in NimbleNewt's project records while keeping implementation pending until requested. Explicit action requests can proceed within existing authorization and policy without redundant confirmation. Record substantive decisions as durable, versioned project state so they survive a conversation growing beyond the model's active context.

## Persistent conversation context

The user wants long-running conversations managed with an approach like pi's billion-context, rather than repeatedly starting fresh chats with a short handoff summary. Maintain a persistent conversation identity, original history, and a bounded active context that can recover earlier detail as needed. Keep work-task and meeting contexts separate from the main conversation while linking their records and applicable decisions.

The [billion-context documentation](https://pi.dev/packages/billion-context?name=pi-coding-agent) describes incremental hierarchical compression with summaries linked to expandable source history. The [pi adapter documentation](https://github.com/ranxianglei/billion-context-pi/blob/master/README.md) describes context-event integration and warns about overlapping compression mechanisms. These are candidate implementation references, not verified NimbleNewt integrations. The desired capability is sustained conversation over a large durable history, not a claim that a model can attend to a billion tokens in one request.

Proposed NimbleNewt requirements:

- Preserve original conversation events and source references in external NimbleNewt storage. Use layered summaries to fit active context, with tools to search and reopen original passages. Expanding a summary means retrieving the preserved source, not reconstructing deleted text from the summary.
- Keep current user decisions, permissions, pending questions, and active goals in an explicit versioned context record. Compression must not silently weaken or supersede them; retrieve original wording when interpretation matters.
- Save summary lineage, source ranges, retrieval indexes, and compression state alongside conversation checkpoints so rebooting or changing models does not reset conversational continuity.
- Budget active context for the selected model, including tools and the expected response. Rebuild the context view when falling back to a smaller model; if essential constraints cannot fit, report the limitation instead of silently dropping them.
- Assign one coordinated compression owner per context. Harness compaction and a context plugin must not independently compress the same history or invalidate each other's references.
- Apply the same access checks to retrieval and summaries as to their source records. A shared meeting context must not gain access to another agent's private conversation or scratch area through a summary.
- Preserve paused task contexts when an agent enters a discussion. On return, load applicable new decisions into the original task before its next action. The conversational supervisor retains the ongoing user conversation; specialists receive authorized relevant context with access to further history as needed.

Evaluate reuse of billion-context or its underlying approach before choosing an implementation. Version and test any integration within an agent's environment; require no configuration or transcript files in target repositories. Validate continuity across repeated compression, branches, Suspend and Resume, provider changes, and correction of old user decisions. Retrieval success and correct continuation matter more than cumulative token-count claims. Preserve full meeting discussions independently of the compressed model-facing view.

## User decision authority

The user's explicit choices are authoritative for project intent, priorities, requirements, and tradeoffs. Team agreement is advisory and cannot outvote the user. Independent review checks work against the user's current requirements; reviewers cannot substitute their preferred requirements or reject an otherwise compliant result solely because they favor another approach.

Record user decisions with their source, scope, and version. Within the same scope, a later explicit user correction supersedes an earlier conflicting decision. Distinguish an actual choice from brainstorming, a hypothetical example, or a quoted instruction. Do not repeatedly seek confirmation for a choice already made or treat a teammate's paraphrase as a new user directive.

Propose linking plans, task contracts, reviews, and pending actions to the decisions they depend on. When the user changes a decision, mark conflicting plans and conclusions superseded, notify affected agents, and revalidate their next actions before further effects. Work against an obsolete decision must not pass review merely because the team previously agreed with it. Record already-completed effects and any corrective work needed; changing a decision does not undo external actions.

Agents should state relevant factual concerns and consequences candidly, then follow the user's choice within actual capabilities and enforced permissions. A factual disagreement does not authorize an agent to silently change the requested outcome. If execution is blocked by a technical limitation or an enforced permission boundary, explain the exact blocker and the available route to resolve it. A supervisor's preference is not such a boundary, and conflicting configurable policy should be surfaced for an explicit policy change rather than used to quietly substitute a team decision.

## Multiple repositories without repository setup requirements

NimbleNewt's project registry, desks, conversations, task records, checkpoints, environment definitions, and coordination policy should live in NimbleNewt-managed storage outside target repositories. The physical storage location is undecided. Repository-local NimbleNewt manifests, instruction files, and status documents must not be prerequisites for using the system.

Keep project identity separate from repository identity and checkout path. A project may coordinate changes across an application, a library, and documentation; one repository may support several independent tasks. Repository bindings should distinguish remotes, branches, revisions, and multiple local checkouts so relocation or similar directory names do not redirect work incorrectly. Each task has an explicit repository access scope; access to one project does not imply access to all registered repositories.

NimbleNewt should read and follow applicable instructions and contribution conventions that already exist in a repository, without requiring its own conventions to be added. When the user requests project documentation or normal source changes, those are legitimate repository deliverables. Internal agent logs, scratch records, plans, and environment configuration remain outside the checkout unless explicitly requested as deliverables. This NimbleNewt design document is itself an explicitly requested deliverable, not a required setup file for future target repositories.

Proposed example: the user checks out an open source project and asks NimbleNewt to fix a bug and create a PR. NimbleNewt registers the checkout externally, examines existing contribution guidance, records the starting state, assigns a scoped workspace, implements and verifies the fix, and creates the requested PR with only intended contribution files. Task history and agent setup stay in NimbleNewt storage. The workflow must not require editing `.gitignore` or adding special documents to keep NimbleNewt's own files out of the PR.

Before producing a contribution, inspect its actual diff for unrelated changes, NimbleNewt state, or secrets. Record and preserve existing user changes rather than treating them as agent output. Coordinate cross-repository dependencies and review order explicitly: a set of PRs in different repositories is not one atomic change, and partial completion must remain visible and recoverable.

## Activity history and replay

The user wants to inspect an agent's conversation history and replay how its work unfolded: what it was asked, what information it received, what it said, which tools it called, and what happened next. Provide a chronological replay of recorded activity with linked decision explanations and evidence. This is an observable audit trail, not access to hidden model reasoning or a claim to reconstruct its internal thoughts.

Capture user and agent messages, delivered instructions, retrieved source references, model and harness selections, tool inputs and results, approval decisions, relevant artifact versions and diffs, context compression events, task branches, meeting decisions, and lifecycle or ownership changes. Preserve the actual context references and versions used at each step, including which summary was supplied, so replay does not substitute today's records for what was available then. Store sensitive payloads under appropriate access controls and show redactions or missing data explicitly.

Provide a summary-first view with a timeline and the ability to step through the full recorded discussion and actions. Filter by agent, task, project, or time; navigate branches and related agents' events without implying concurrent actions happened sequentially. Distinguish proposed actions, dispatched operations, confirmed results, and uncertain outcomes. A useful inspection question is “What evidence and instruction led to this change?” with links to the relevant messages, artifacts, and tool results.

Record short decision explanations when material choices are made, including alternatives considered, key evidence, and uncertainty where relevant. These are user-facing explanations, not private chain-of-thought. An explanation requested later must be labeled retrospective and grounded in records; it must not be presented as a contemporaneous statement or proof of an unrecorded motive. If the record cannot explain an action, say so.

Replay defaults to read-only playback and must never re-execute commands, send messages, submit jobs, or incur model calls merely by advancing the timeline. Asking for retrospective analysis is a separate explicit operation. Simulation or a rerun is also separate, uses an isolated execution scope, and is never implied by replay. Corrections append provenance rather than silently rewriting the original history. A superseded user decision remains visible as historical context while clearly marked as no longer authoritative.

Human inspection follows the owner inspection policy, whose details remain to be specified; an agent's private scratch boundary against other agents remains intact. Do not expose credentials or another project's restricted records through shared replay links, search, or summaries. Preserve original discussion separately from model-facing compressed views, and retain reference integrity under backup, archive, and deletion policies. The replay UI must indicate when a range is incomplete or intentionally unavailable.

Validate playback with a task branch, provider switch, compressed history, failed tool, and later user correction. Confirm that original versions are shown, tool effects are not repeated, missing evidence is reported, and retrospective explanations are visibly distinct from recorded decisions.

## Agent desks and shared reading

The accepted direction is an owner-written desk with shared reading of work records and a private scratch area. Plans, progress, evidence, and decisions are available to other agents as saved, versioned records. Temporary notes remain private to the agent against peer access unless deliberately published. Recovery records may be read by trusted controller services for restoration; peer agents do not gain access through that service role. Credentials belong in separately managed secret storage. This replaces the earlier proposal that all desk contents be private.

The desk belongs to the persistent agent identity, so switching its harness or model does not create a new desk. Task folders distinguish separate branches while allowing the owner to retrieve its earlier experience. Records should identify their author, task, timestamp, version, and status such as draft, accepted, or superseded. Readers consult committed snapshots rather than half-written updates.

For example, B reads A's investigation and asks why a particular approach was rejected. A consults its records in a bounded response task, answers with the relevant evidence, and returns to its work. B stores the answer with its source and version. If A lacks evidence, it should say so rather than manufacture a recollection. Corrections go to A as requests; B cannot edit A's desk. Parent status alone does not grant write access or access to private scratch records. Sharing is scoped by project/team permissions; an agent serving multiple projects cannot publish one project's restricted information into another.

While A is suspended, B can still read A's saved shared records. Questions requiring A's participation remain queued under the pause policy. A shared noticeboard can summarize current assignments, stand-up reports, and deliverables so agents know where to look. Detailed records stay on their owner's desk.

Read and write boundaries must apply to files, search indexes, artifact links, and tools. Shared reading does not grant execution authority: a skill, script, or instruction found on another agent's desk does not become active merely because an agent reads it. Human inspection and retention policies remain to be defined.

## Runtime and tool architecture

**Pi Durable is the selected reference worker runtime.** The user accepts its experimental API risk because its persistent conversation/task model closely fits NimbleNewt. LangGraph/Deep Agents remains an alternative. See [Harness comparison](harness-comparison.md) and [initial runtime experiments](harness-test-results.md) for evidence and remaining qualification gaps. Selection does not waive macOS, Linux, Windows, recovery, or isolation requirements.

Follow [Runtime compatibility and command namespaces](runtime-compatibility-and-namespaces.md): reserve `/nimblenewt.*` for NimbleNewt operations, use durable computer-assigned agent IDs for canonical agent command prefixes, and offer context-bound aliases such as `/agent.*`. Friendly names remain editable labels. Pin runtime versions, maintain an explicit adapter mapping, and test API behavior, naming conflicts, checkpoint migrations, and rollback before upgrades.

Propose a NimbleNewt controller with isolated Pi Durable workers behind a versioned adapter. NimbleNewt owns identity, task state, permissions, scheduling, meetings, context archives, provider policy, and recovery. Pi Durable supplies the model/tool execution loop and durable conversation primitives. The conversational coordinator is an agent managed by the controller, not the controller itself. Personal extensions run inside the isolated worker, not the privileged controller.

The [regular pi integration and extension assessment](pi-integration-research.md) remains reuse research, not the selected integration API. Regular pi SDK/RPC APIs, slash commands, and extensions must not be assumed compatible with Pi Durable. Port or replace the required context and tool integrations against pinned Pi Durable interfaces, and retain harness-neutral service contracts.

### Tools and scripts

NimbleNewt can implement its own tools wherever needed; existing pi extensions and third-party packages are optional reuse candidates, not requirements. Choose among a custom protected extension, an external service integration, or an agent-created script according to the operation's authority and lifecycle needs. Build purpose-specific tools when that gives a clearer contract or better recovery behavior than adapting an existing package. Evaluate reuse against maintenance cost and compatibility rather than assuming every capability needs a dependency or a new implementation.

Custom tools follow the same versioning, input validation, permission enforcement, testing, and recovery requirements as reused tools. Tools that manage the team or privileged state belong in the protected layer and use external service authorization. Agents may create their own utilities within delegated permissions; their ability to author code does not grant them authority to modify protected tools. Keep harness-facing wrappers thin where possible so the same underlying tool can serve pi and other harnesses.

Use protected Pi Durable extensions to expose the stable tools agents need for NimbleNewt operations. This is a proposed packaging boundary for controller-managed tools, separate from agent-authored scripts and optional personal extensions; regular pi extension code must be assessed for porting. Candidate tools include desk access, task updates, communication, meeting participation and ballots, job control, tool discovery and invocation, and environment-maintenance requests. Other harness adapters should expose equivalent service contracts.

Agents may call these tools within their authority but cannot edit, uninstall, disable, override, or replace their protected implementations. The worker controller selects and loads versioned extension artifacts from read-only storage outside the agent's writable home and target repositories. Agent-created code must not shadow reserved tool names or change the trusted loader configuration. A supervisor can review requests but cannot rewrite the protected base merely because it supervises a worker; changes require the designated administrator's authority and normal versioned rollout.

The protected extensions are clients of NimbleNewt's services, not the final security boundary. Those services authenticate the worker and enforce task scope, ownership, lifecycle state, and permissions for every operation. Do not place controller-wide credentials or unrestricted administrative methods inside an extension. Read-only files prevent disk edits, but customizable extensions share a process and could interfere at runtime. Treat the whole worker as untrusted, enforce consequential controls externally, and validate that reserved tools remain intact before accepting a customized environment. Stop activation if integrity checks fail.

The resulting tool layers are: protected controller-managed tools; a permission-managed shared toolbox; approved, versioned personal harness extensions; and agent-created scripts accessed through the protected bridge. Being read-only does not make a tool automatically authorized to perform every action it exposes. An agent's Suspend, release, or restart tool requests must still be checked against its delegated authority.

### Shared toolbox and promotion

The shared toolbox is an accepted feature. An agent may describe a useful personal tool at stand-up or submit it directly for promotion. A designated maintainer can publish it for a role such as all coders, a selected team/project, or all agents within their authorized scope. The lead engineer is a proposed default holder of the scoped `toolbox.manage` permission; authority attaches to the permission and durable identity, not a job title or editable name. The user can configure maintainers and audiences through the UI or conversational controls under the same authorization rules.

Only authorized maintainers can add or change shared entries, publish versions, change audiences, deprecate, revoke, or roll back them. Other agents may discover and invoke permitted tools, propose additions or patches, and maintain personal copies within their own permissions. A personal copy cannot replace the shared implementation. Toolbox management does not grant authority to alter protected NimbleNewt tools or bypass separate environment/safety approval requirements.

Agents in a tool's authorized audience have read-only access to its published source, manifest, tests, and usage instructions. They can inspect how it works, copy an exact version into their own writable environment, and adapt it for personal use. Preserve the source tool ID, base version, and content digest as provenance. The copy is independent, not a writable link to shared files, and is registered under the agent's durable namespace rather than shadowing `/toolbox.*`. Personal execution remains subject to the agent's normal permissions and activation policy; copying source does not inherit the shared tool's credentials or approvals.

An agent can submit an improvement proposal containing its base version, a patch or candidate artifact, rationale, tests, and any dependency or permission changes. Only the proposed material is shared for review, not the agent's private desk or unrelated local configuration. An authorized toolbox maintainer can accept, request changes, defer, or reject it with a recorded reason. Acceptance publishes a new immutable shared version. If the shared tool has changed since the proposal's base version, reconcile conflicts and rerun relevant checks before publishing; never overwrite the newer version blindly. Later shared updates do not silently replace a personal fork, but the agent can explicitly compare and incorporate them.

Promotion captures an immutable snapshot of code, dependencies, manifest, tests, and usage instructions, with author provenance and a stable shared tool ID. It must not point to mutable files on the author's private desk or copy private history, credentials, or installation-specific paths. Review the tool's requested access, replay/cancellation behavior, and platform requirements. A tool can declare supported platforms and backends, but the catalog must show incompatibility clearly; distributing it to all agents does not imply it runs on every platform.

Record the promotion proposal, audience, maintainer decision, and resulting version in the meeting outcome when discussed there. A vote or positive discussion does not publish a tool or grant maintainer permission. Existing user-present decision rules still apply; in the user's absence an authorized maintainer can act within delegated authority. Report unresolved review conditions and deferred proposals rather than presenting them as available tools.

Publication makes the approved version discoverable to its audience through the existing bridge without loading every description into every prompt or interrupting tasks. Availability is not execution permission: invocation still checks the caller's task scope, data access, budgets, platform compatibility, and current revocation status. Each execution records an exact version. Updates create new immutable versions; already-running jobs keep their selected version unless explicitly cancelled under policy. A revoked queued version must be blocked or explicitly replanned, not silently substituted. Harness extensions that require environment changes still use the approved Suspend/restart workflow.

Reserve `/toolbox.command` for shared commands, separate from `/nimblenewt.command` and durable agent prefixes. Canonical records also include toolbox scope and stable tool ID; shortcuts resolve within an explicit scope and reject ambiguity. Maintainers cannot overwrite a same-named entry in another scope. See [command namespaces](runtime-compatibility-and-namespaces.md).

Validate the full path from a coder's personal tool to a role-scoped shared version: unauthorized publication and edits fail, eligible coders can discover it, excluded roles cannot invoke it, edits to the original do not change it, and promotion survives the author's rename or retirement. Exercise update, revocation, rollback, and attempts to use publication as a privilege escalation.

Also verify shared-source inspection, denied writes to published artifacts, isolated personal modifications, a patch submitted against an older base version, and maintainer publication without exposing private files. Ordinary inspection and authorized personal adaptation need no toolbox-management permission; changing the shared version does.

### Tool packaging and discovery

Scripts are a suitable implementation for many agent-created utilities. A reusable tool should also have a versioned manifest describing its purpose, input and output schema, entry point, dependency versions, requested access, resource limits, and cancellation or recovery behavior. A skill describes when and how to use tools; it does not itself grant executable capabilities. Keep tools and manifests in the agent's environment outside target repositories.

Propose three supported forms: scripts executed as bounded jobs for local utilities, structured tools exposed through the harness adapter for frequent operations, and services or MCP integrations for shared capabilities. A shared NimbleNewt tool registry and execution service can present the same contract through different harness adapters. Keep context or lifecycle extensions separate from ordinary script tools because they modify the harness runtime itself.

Prefer a stable NimbleNewt bridge with tool discovery and structured invocation. Agents can create a tool, test it in their permitted environment, request review if its activation needs it, and register an immutable version. Once activated, it becomes discoverable without restarting the task; the bridge supplies its schema and invokes it through the sandbox. Do not load every tool description into every prompt. Native tool declarations can be refreshed at the next model-request boundary when the harness supports that; a request already in flight cannot retroactively see a new declaration.

Do not depend on a regular pi CLI slash command for Pi Durable integration. Load the NimbleNewt bridge when the worker starts and keep its logical operations stable: tool discovery, description, and invocation. Expose them through the reserved NimbleNewt namespace and adapter-specific wire-name mapping. New scripts are registered in NimbleNewt's external catalog rather than installed as new harness extensions. The existing bridge discovers their approved schemas and invokes exact versions through NimbleNewt's execution service, which validates arguments and permissions. Ordinary catalog-tool creation and use therefore require no worker runtime reload.

Changing a harness extension is a separate environment-maintenance operation. An agent can request it through the already-loaded bridge; the external worker controller handles checkpointing, an adapter-supported reload or worker restart, and restoration. Verify support against the pinned Pi Durable adapter version rather than assuming regular pi slash commands exist or are callable by the model. Preserve native session and conversation-compression state, settle active tool operations, and report maintenance progress. The requesting tool call should return a maintenance request identifier before its own worker is replaced, avoiding a call that waits forever for the runtime it just terminated. If safe restoration is unsupported, leave the change pending and report the limitation.

The [pi extension documentation](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/extensions.md) describes custom tools, active-tool changes, MCP registration, and runtime reload. It also states that extensions run with the pi process's operating-system permissions. This is historical regular-pi evidence, not a Pi Durable API contract. For the selected runtime, use its own pinned APIs and the measured limits in the harness report; neither extension registry is the isolation boundary.

Tool creation, registration, activation, and execution are distinct steps. Pin each invocation to an approved code and dependency version so later edits cannot replace code after review. Existing calls finish on their original version or are explicitly cancelled; subsequent calls can use a newly activated version. Revocation is checked by the execution service at invocation, independently of stale model-visible tool lists. New tools cannot shadow protected controller operations or expand their creator's authority.

Use structured arguments rather than concatenating model-supplied shell commands. Track operation IDs, exit status, bounded output, logs, and artifacts. Long-running jobs return durable handles with status, cancellation, and any supported checkpoint behavior instead of tying progress solely to a shell connection. Arbitrary shell access, when permitted, remains subject to the same sandbox, protected paths, resource limits, and external-effect controls as registered tools.

Validate creation and use of a new script tool in one conversation, denial of excessive permissions, mutation after approval, version replacement during an active call, revocation, restart recovery, and parity across harness adapters. This tool integration is a design requirement with unimplemented mechanisms; Pi Durable itself has already been selected.

## Individual agent environments

The requested direction is that each agent can arrange its own tools and working environment. A coder could add a compatible Pi Durable extension or create a skill for its own use without changing the system engineer's configuration. Full Pi Durable extension and context-integration compatibility remains unverified; this is an architectural requirement for the adapter to investigate.

Propose a common maintained base with a separate persistent home, configuration, package area, and skill library for each agent. An environment manifest records installed versions, approved capabilities, and configuration revisions. Checkpoints reference the corresponding environment revision so restoring a task does not silently substitute incompatible tools. Preserve required package artifacts or reproducible build inputs as well as the manifest; a list of versions alone is not a recovery guarantee.

Agents may draft skills freely within their own storage. Activating extensions or executable skill dependencies follows the environment policy. Skills and extensions inherit the agent's existing permissions; they cannot grant themselves broader access. Promotion of a useful skill into a shared catalog is a separate, versioned publication step, and other agents opt into an approved version rather than receiving silent global changes.

Agents can add their own extensions and request restart under standing delegated permission, or ask a supervisor to approve installation and restart. Both paths use a durable environment-maintenance request executed by NimbleNewt's external controller. Stage and verify the new revision, Suspend without releasing tasks, checkpoint, restart, and validate recovery. Roll back failed activation and preserve preexisting Pause or Suspend intent. Existing authorization must not trigger redundant approval requests.

### Isolation and shared project files

Propose an execution sandbox per agent with scoped filesystem access, credentials, network access, and CPU, memory, disk, and process limits. The host controller, policy store, other agents' writable homes, and privileged host interfaces should be outside that sandbox's authority. Containers or virtual machines are candidates to evaluate; the chosen mechanism must be tested against the required boundary rather than assumed sufficient by its name.

Desk ownership and project editing are separate permissions. An agent can own its desk while receiving write access to assigned project files. Prefer a separate checkout or worktree per coding task with controlled integration into the shared repository. A worktree is an editing arrangement, not a security boundary; the execution sandbox still needs to enforce access.

Where agents truly need to edit the same live workspace, propose a scoped file service with version checks and atomic writes, plus explicit conflict handling. All write paths must obey the policy: an unrestricted writable mount or shell would bypass restrictions implemented only in the file service. The choice between direct sandboxed editing and mediated editing remains open.

### Protected files and repository operations

The user proposed protecting critical paths such as `.git` from deletion. Extend that proposal to replacement, renaming, truncation, permission changes, moving or deleting an ancestor, and access through links or alternate paths. Protect both a worktree's `.git` entry and the actual backing repository metadata. Additional candidates include NimbleNewt's state, safety policy, and recovery records.

Propose keeping Git metadata outside agents' direct write authority and exposing authorized Git operations through a trusted repository service. Source files remain editable within task scope. The service can perform legitimate metadata updates for approved operations while denying arbitrary deletion or destructive repository changes. This reconciles repository protection with normal Git work; making all metadata immutable would also prevent legitimate updates. Hooks and configuration must not turn the service into a route for agent-controlled code to run with broader privileges.

Protection must be enforced beneath agent commands, not just by recognizing dangerous command strings. Recovery snapshots complement enforcement but do not replace it. The concrete protected-path rules and permitted Git operations remain to be designed and tested.

### Safety supervision

A safety supervisor is a proposed review role, not yet a mandatory approval for every customization. Suggested policy:

| Change | Proposed treatment |
| --- | --- |
| Write a skill draft or adjust local preferences within existing permissions | Allow and record a revision. |
| Install an extension or executable dependency | Use a preapproved catalog or request supervisor review before installation or execution. |
| Request broader file, network, secret, or resource access | Supervisor reviews a concrete, scoped capability change. |
| Change host policy, protected repository rules, or shared base environments | Require designated human or administrator authority. |

Review should identify the exact package or skill version, source, requested access, installation behavior, and rollback plan. Trial approved changes in a disposable environment before promoting the agent's environment revision. Installation scripts are executable work and must run within the approved boundary too.

The supervisor recommends or approves within a delegated policy; a separate trusted controller enforces that policy. An LLM judgment alone is not the containment mechanism. Approval cannot silently expand the supervisor's own authority, and agents cannot approve their own requests. Record approvals, denials, activations, and revocations durably. If review is unavailable, leave the proposed change pending while allowing work that uses the already-approved environment to continue.

## Pause Suspend Stop and Resume

Pause and Suspend describe different behaviors, not durations. Pause retains task ownership and permits existing background work. Suspend performs bounded preparation for durable recovery while retaining task ownership. Suspend and Release adds explicit release of selected task assignments after safe handoff preparation. Resume continues retained work after checking current state and ownership.

Stop requests termination but prefers a graceful path when the model and agent are responsive: **Pause → Preparing to suspend → Suspended → Stopped**. Block new ordinary work immediately, then allow bounded cleanup and checkpointing before terminating execution. This applies at agent, team, or system scope. Stop preserves durable records; it does not delete an agent, cancel the meaning of its assigned tasks, or automatically transfer ownership. Force Stop is the separate emergency override that skips or interrupts preparation.

| Mode | Agent behavior | Background work | Readiness guarantee |
| --- | --- | --- | --- |
| Pause | Stop new foreground task steps at a safe boundary and save current progress. | Existing background jobs may continue; capture their results without resuming foreground work. | Work is set aside, but the system is not necessarily ready to shut down. |
| Suspend | Prepare and persist recoverable state, release execution resources, and retain task ownership. | Finish, checkpoint and stop, or cancel jobs with an explicit recovery plan. | Ready for shutdown once dependencies are resolved; assignments remain reserved for the owner. |
| Suspend and Release | Prepare recoverable state and a handoff package, then explicitly release selected task assignments. | Settle operations before ending the former owner’s authority. | Released tasks become eligible for reassignment only after durable preparation and a recorded ownership change. |
| Stop | Block new ordinary work, pass through Pause and Suspend preparation when possible, then terminate execution. | Settle or checkpoint jobs during bounded cleanup; report anything unresolved. | Report graceful completion only after preparation succeeds and execution ends. |
| Force Stop | Block all agent actions and terminate execution without waiting for cleanup. | Terminate local processes and request remote cancellation where supported; report unresolved work. | Dispatch is blocked, but incomplete state and external effects require reconciliation. |

Track task status, lifecycle controls, assignment, and execution attempts separately as defined in [Operational contracts](operational-contracts.md#state-and-ownership). A task can be waiting and assigned while its agent is paused. Waiting means a dependency or response can make a task eligible only if no active lifecycle gate blocks it; an explicit pause remains in force when ordinary messages arrive. A paused agent can be asked to suspend. Persist both the requested mode and preparation progress so a controller restart does not lose the shutdown request.

Also track stopping, stopped, and recovery-required execution states separately from task completion or cancellation. Persist Stop intent and preparation progress so a restart cannot resume ordinary work or forget that termination was requested. Reuse completed preparation if the agent is already preparing to suspend or suspended. Stop does not resume task execution merely to shut it down.

Model accessibility permits an attempt at graceful cleanup but does not guarantee completion: the agent, tools, or remote jobs may still be stuck. Cleanup gets a configured deadline and resource budget, and may use an eligible backup model. If it cannot complete, report the blocker and use Force Stop only on explicit request or under a previously authorized escalation policy. An unavailable model must not prevent an administrative forced termination. The precise default deadline and escalation policy remain open decisions.

Enforce termination outside agent cooperation, revoke ongoing tool access at final termination, and reject late attempts to write. During graceful preparation, allow only scoped cleanup actions rather than ordinary work. Report progress rather than claiming all remote effects ended instantly. Recovery checks saved artifacts and uncertain operations before restarting or explicitly transferring work. Forced termination is an exception to the normal preparation-before-handoff flow, not a successful Suspend. Administrative Stop and Force Stop controls must remain usable when all model routes are unavailable; the conversational interface cannot be the only way to issue them.

The normal transition for paused work is **Paused → Preparing to suspend → Suspended**. From Suspended, resume with the retained owner. To transfer its tasks, explicitly request Suspend and Release and validate handoff readiness first. A running agent can also enter Preparing to suspend directly. Preparation is an active, bounded cleanup state; merely requesting Suspend does not make the task ready for takeover or the system ready for shutdown.

Pause preserves task ownership: the scheduler must not take an agent's assigned tasks or redistribute them because it is paused. This applies even if a task is urgent or another agent is idle. Requests and deadlines remain visible, and resuming returns the agent to its retained work. A timeout or restart must not silently convert a pause into permission to reassign tasks.

Suspend alone never makes a task eligible for reassignment. Execution state and assignment state must be separate: freeing a worker, model allocation, or process does not release task ownership. For a server reboot, suspend agents, preserve their assignments and pause intent on disk, and restore those assignments afterward. Resume follows the explicit or previously authorized resume policy; a reboot does not itself authorize scheduling paused work.

Suspend and Release is an explicit request with a recorded task scope. The agent keeps ownership while preparing selected work for handoff. Once the package is durable and outstanding operations are reconciled, commit release and invalidate the former owner's execution authority. A released task can wait in an unassigned queue or transfer to a named recipient; release does not require a replacement to be available. Persist the checkpoint reference and release outcome together so a crash cannot leave an ownerless task without recoverable state. A returning agent must not automatically reclaim released tasks.

Taking a task from a paused agent requires Suspend and Release, giving its owner a bounded cleanup opportunity before release. For an already-suspended agent, use its saved checkpoint if it is sufficient; if more agent-led preparation is needed, disclose and run that bounded preparation under the release request without restarting ordinary work. Neither an expired lease, elapsed time, deadline, nor an idle replacement implies release. Stop and Force Stop also retain assignments unless release or explicit emergency recovery is separately authorized.

The preparation package should identify completed and unfinished work, preserve drafts and uncommitted changes, save relevant results, settle or identify background operations, release or transfer locks safely, and record outstanding risks and the next recommended action. Keep the handoff within the task's permitted sharing scope; do not copy the agent's private scratch area wholesale. Report handoff readiness explicitly, then record release or transfer and invalidate the previous execution authority. Requesting reassignment is not itself proof that cleanup has finished.

If cleanup fails, exceeds its budget, or the owner is unreachable, retain the last durable state and report the blocker. A forced recovery or takeover is a separate explicit exception with any missing cleanup and uncertain effects visible; it must not masquerade as a completed graceful handoff.

A checkpoint should contain the goal, current plan and next action, accepted decisions and constraints, conversation and tool history references, work products, workspace revision and uncommitted changes, pending tool operations, branch relationships, message cursor, budget usage, routing and environment revisions, and adapter metadata. Store credentials as references to secure configuration rather than embedding secrets in portable snapshots. Paused work still needs durable progress records; allowing background jobs to continue does not guarantee those jobs survive an unexpected reboot.

Specify data-store flush guarantees explicitly, including the distinction between process crashes, orderly shutdown, and sudden host/power failure. Verify both checkpoint and artifact durability before declaring Suspend ready. Keep a durable ingress gate and inbox outside the harness: an abort command alone does not prevent the next message from restarting work. Replay-safe tool declarations and protected-name registration remain host-controlled; recovery must reconcile uncertain effects even when submission IDs are deduplicated. These requirements are reinforced by the [runtime experiments](harness-test-results.md).

Proposed suspension sequence:

1. Stop ordinary dispatch in the requested task, team, or system scope. Permit only tracked, bounded shutdown-preparation work, including agent reasoning where useful.
2. Inventory foreground operations, local processes, remote jobs, and delegated work within scope. Choose how each will finish, checkpoint, or cancel; capture completed results and uncertain outcomes.
3. Save resumable artifacts, pending messages, the environment revision, and an explicit next-action plan. Commit a consistent checkpoint and verify the required artifacts are durable.
4. Release workers and dependent local resources, then report suspended and ready for shutdown only when the readiness conditions actually hold.

Preparation has a time and spending budget, with visible progress and blockers. Some tools may not support checkpointing or cancellation. If an operation cannot be settled, report the affected work and options such as waiting, accepting a restart from an earlier boundary, or force stopping. Do not label it safely suspended merely to meet a deadline. Keeping a remote job running through a shutdown is an explicit exception with durable tracking and an agreed way to collect its result; it must be visible in the readiness report.

For a system shutdown, the controller aggregates readiness across all affected agents and jobs. Save enough shutdown state that the remaining bookkeeping does not depend on an LLM. If the last usable model fails during preparation, retain a mechanically recoverable checkpoint and report any missing agent-authored briefing rather than invent one. Forced termination remains a separate emergency operation with potentially incomplete work.

After restart, reconcile unfinished operations, check artifact availability and changed external conditions, acquire exclusive ownership, and restore the requested pause state. Resume requires an explicit user action or a previously authorized resume condition. Use an operation journal and idempotency keys where supported; uncertain external effects must be reconciled before retrying.

Preserve original records alongside compact resume briefings. A summary helps retrieval but must not become the only surviving context. A complete archive does not imply all history fits in every model's active context window; recovery tests must check actual continuation quality.

## Branching and returning

Proposed example: an agent is implementing image export when its parent asks for a quick feasibility assessment. NimbleNewt checkpoints the export task, creates a linked assessment task, supplies the relevant context, and records where to return. On completion, the assessment result goes to the parent and the agent becomes eligible to resume export.

Returning is a scheduling decision: a newer urgent task may supersede the saved return destination. Preserve the destination until it is resumed or explicitly changed. Branches share immutable source references; new decisions and workspace changes remain scoped to the branch until deliberately incorporated. Separate workspaces are one possible implementation when branches would otherwise edit the same files.

## Hierarchy and model routing

Parents should assign outcomes and acceptance criteria, then allow children to choose steps within delegated permissions and budgets. Difficulty selects an initial execution profile; priority determines when work runs. These are separate settings.

| Difficulty | Illustrative profile | Proposed behavior |
| --- | --- | --- |
| Simple | User-selected lightweight profile | Bounded tasks with clear verification. |
| Medium | User-selected general-purpose profile | Broader reasoning or tool work. |
| Difficult | User-selected demanding-task profile | Ambiguous planning or demanding analysis. |

These mappings are editable in the UI. Local models for simple tasks, OpenRouter for medium tasks, and a high-capability cloud model for difficult tasks are one installation's choices, not built-in defaults. A deployment may use only local models, only cloud models, or a mixture; difficulty does not imply a particular provider or locality.

Execution profiles should separately specify harness, provider, model, reasoning settings, context needs, tool permissions, and spending limits. Locality or price alone does not establish task suitability. Routing must also respect data access constraints, model capabilities, and availability.

A child should request escalation when blocked or repeatedly failing. Policy may permit escalation within a delegated ceiling; otherwise the request goes to its parent. Apply retry limits and total task budgets so escalation cannot become an unbounded spending loop. Persist routing decisions and reasons for later evaluation.

## Provider switching and backup models

The user wants to redirect work immediately when a provider or inference service becomes unavailable or is deliberately taken down. Examples include disabling local routes before maintenance on Strata or vLLM, or moving from OpenAI routes to configured OpenRouter routes when credits are exhausted. These examples describe desired routing behavior; specific adapter support remains to be verified.

Every model configuration must have an explicit priority-ordered fallback list. Try its highest-priority eligible entry, then move to the next when the current entry is not working or has been instructed to go offline. Apply this requirement to every model-using role, including the conversational coordinator and safety supervisor. Configure and check lists in advance so agents do not negotiate replacements during an outage.

Each list entry identifies a concrete model route, including provider account and endpoint. Eligibility also checks harness compatibility, context and tool requirements, data permissions, and budget. Skip entries affected by model, endpoint, account, provider, or local-service exclusions. A fallback must not accidentally route back to the same disabled service through another alias.

Resolve one ordered list for the task's selected model configuration and preserve its position and attempt history across retries and restarts. Do not recursively follow each fallback's own list within the same attempt; validate route identities and prevent cycles or unlimited retries. Exhausting all eligible entries puts the task into a visible waiting or blocked state with its progress saved and the reasons recorded. Resuming must recheck current availability and explicit exclusions before dispatch.

A user instruction such as “switch off local models” updates a durable routing policy centrally. Once acknowledged as applied, no new request may dispatch to the disabled routes, including queued retries and newly resumed tasks. Enforce policy at actual dispatch, using a routing revision, rather than relying on each agent eventually reading a message. A provider switch changes execution configuration and does not itself pause tasks or erase their context.

“Instant” means immediate routing exclusion and redirection of subsequent requests. It cannot promise migration of an already-running model computation or zero time to the backup's first response. Report routing applied separately from in-flight requests remaining and service safe to stop. Proposed handling modes are:

- Planned maintenance: redirect new requests now and allow existing requests a bounded drain period, then report when the affected service is no longer in use.
- Immediate cutover or provider failure: cancel or abandon affected requests, invalidate late responses, and reconstruct continuation on the backup from the last committed boundary. Track possible outstanding provider charges separately.

An interrupted generation may need to be repeated. Preserve completed tool results and reconcile already-dispatched actions; never replay tool effects merely because the model request moved providers. A response from an abandoned attempt cannot issue new tools or overwrite progress made by its replacement. Persist enough provider-neutral task context that restoration does not depend solely on a session identifier held by the unavailable provider.

Automatic failover follows the priority list for classified availability, timeout, quota, or credit failures, with bounded attempts and cooldowns. Distinguish an account-wide block from a single endpoint or model failure. A task-level tool error or an unsatisfactory answer does not by itself prove the model route is unavailable; handle those through task recovery or difficulty escalation. An explicitly disabled route stays disabled until the user re-enables it; recovery probes must not silently restore it. Returning to a recovered higher-priority route follows a separate configured policy to avoid repeated switching.

Fallback eligibility must retain task permissions, context needs, and budget controls. Switching from local to cloud must respect the task's existing data-sharing authorization; a backup with a smaller context window or missing tool support is not automatically equivalent. If no compatible authorized backup is available, persist the task and report the specific blocker. Resource-heavy local backups may need warm capacity for low latency; no latency guarantee is established yet.

## Communication without constant interruption

Propose a durable inbox for every agent. Messages carry an associated task, sender, purpose, urgency, optional response deadline, and correlation identifier. Delivery, acknowledgment, and answering are separate states.

| Class | Delivery behavior |
| --- | --- |
| Informational | Batch into the next check-in or stand-up. |
| Advice or normal request | Read at the next safe task boundary. |
| Blocking dependency | Wake an eligible waiting task and let the scheduler assign priority. |
| Urgent control request | Request a safe interruption under the sender's authority. |

Agents should have focused work periods and a bounded interruption allowance. Repeated updates can be coalesced; requests need deadlines and escalation paths. Parent authority should not make every parent message urgent. Requesting advice should usually be an asynchronous child task so the agent can continue independent work.

## Stand-ups and live meetings

Stand-ups should be live conversations the user can attend, question, and steer. Their purpose is to consolidate routine updates, resolve dependencies, and help agents plan with fewer interruptions during focused work. Support scheduled stand-ups and user-requested immediate meetings. The mechanics below are proposed behavior to refine.

### Scheduled preparation

Use a configurable time, timezone, participant group, and meeting duration. Notify agents in advance so they can reach a safe task boundary and prepare a brief from durable records: accomplishments since the previous meeting, unfinished work, blockers, advice needed, and proposed next priorities. The normal cadence is daily and covers approximately the preceding 24 hours. Schedule with actual local timezone rules and produce one catch-up report after downtime rather than replaying missed meetings.

Prepare a shared agenda before the live session. Routine progress stays in the written brief; the facilitator puts conflicts, questions, and decisions first. Agents can plan around the known meeting time without starting avoidable work that cannot yield, while long-running operations can continue if safe. Joining a meeting uses a task-scoped Pause for the interrupted assignment, retaining ownership and tracking ongoing background work. The agent can perform a bounded meeting task without advancing its paused assignment. It does not require Suspend or a handoff.

### Human participation and turn taking

Provide a persistent meeting conversation, join notification, agenda, roster, and live status. The user can ask an individual agent a question, address the team, change priorities, or end the meeting. A facilitator routes questions and grants bounded response turns so agents do not all answer at once. Targeted agents retrieve supporting records from their desks, identify stale information, and distinguish proposed actions from completed work.

User participation takes priority over the routine agenda. An agent already answering should yield at a safe response boundary; completed tool effects are not undone by interrupting a meeting turn. Agents may surface disagreements, but meeting consensus cannot override a user decision. Track unanswered questions with an owner and follow-up task instead of extending the meeting indefinitely.

Meetings proceed on schedule without the user present. The user can join late or review afterward. Show a summary by default and provide access to the full meeting discussion. Absence does not constitute approval; agents can plan and act only within existing authority.

Agents may vote on decisions when the user is absent. An adopted motion within delegated authority is actionable without waiting for the user to attend or ratify it. Examples can include choosing among permitted implementation approaches, coordinating dependencies, and adjusting plans within existing priorities and budgets. The motion's subject must actually fall within delegated scope; voting does not grant new permissions or override a prior user decision. Matters outside that scope remain recommendations for the user.

When the user is present, agents still debate and vote, but the chair presents the result and asks whether the user agrees or wants another direction before acting on it. Record the vote separately from the user's final decision. Agreement authorizes applying the outcome within its scope; a different user direction takes precedence without requiring another team vote to validate it. Silence is not agreement: keep the decision pending and continue unrelated permitted work.

Evaluate attendance when the result is presented. If the user joins before an absent-user decision has been dispatched for action, present it for their decision first. If the user leaves while a decision awaits their response, do not silently convert it into an approved absent-user vote; retain it as pending unless they explicitly delegate that decision. Report already-executed outcomes accurately when the user joins later.

Record the exact motion, eligible voters, votes, abstentions, result, reasoning, and resulting actions in the meeting record, and surface the outcome in the default summary. If the user later changes the decision, that correction takes precedence: update affected plans, stop conflicting pending actions, and report any completed effects that need corrective work rather than pretending they were undone.

Each agent's vote must include a short, user-facing reason, including for an abstention. Present a compact table of agent, vote, and reason alongside the overall result in the default summary. Reasons should state the main evidence, tradeoff, or uncertainty behind the choice, with links to shareable supporting records when useful. This is a concise decision explanation, not private model reasoning. Preserve the exact motion version associated with each ballot; a materially amended motion requires a fresh vote.

### Different perspectives and private knowledge

Agents may have different roles, personalities, models, and private histories. Each can consult its own permitted private records, authorized shared team data, and the meeting discussion when forming a view. Those differences are intended to broaden the considerations raised, without forcing agents to disagree or counting personality as evidence of expertise. Personality never changes permissions, user authority, or evidence requirements.

An agent may publish a shareable conclusion or selected evidence derived from its private records without exposing the underlying store. Retain project and audience boundaries when preparing that explanation. If supporting material cannot be shared, identify that limitation rather than implying independently verified evidence. Other participants may request an authorized check; they do not gain access to the private desk by asking for a rationale.

Propose collecting brief initial positions before agents see one another's ballots, then allowing discussion and a final vote with reasons. This can expose distinct perspectives before they converge. It does not guarantee independent judgment: agents may share the same source or make the same mistake. Track source provenance, preserve meaningful dissent, and avoid treating a larger vote count as proof of factual correctness.

### Improvement proposals and deployment-specific development

Public NimbleNewt agents can report recurring friction in their tools, skills, communication, and project workflows. Capture observations, permitted evidence, affected work, possible improvements, and an owner/disposition in a project-scoped improvement backlog. Group duplicates without discarding independent evidence, timebox stand-up discussion, and return evaluated outcomes to proposers. Accepted work enters the P/PC process with separate implementation and publication authority; no agent must invent suggestions to fill a quota.

Our own development deployment also uses that process to propose changes to NimbleNewt's source. Its agents can investigate, prepare patches, and produce candidate builds only within that project's authorization. This optional [NimbleNewt development workflow](development-workflow.md) is not a public installation default and cannot grant itself control over the live controller or updater.

Public users can install authorized released versions through the proposed [maintenance and update mechanism](maintenance-and-updates.md), including startup-failure rollback. Our connection from an agent-authored change to a candidate build is separate from that updater. Runtime compatibility, review, and release authority apply regardless of who authored the code.

### Topics raised with a supervisor

The user can discuss a topic with a supervisor during the day and ask that it be brought to a later meeting, even if the user will not attend. The supervisor saves a durable agenda item linked to the conversation, including the user's actual question, relevant context and constraints, requested outcome, urgency, and intended participants. Show the captured item in chat so the user can correct it without requiring an extra approval for an already-clear request.

Distinguish discussion requests, requests for recommendations, decisions delegated to the team, and explicit user instructions. A tentative idea must not become an instruction through the supervisor's paraphrase. Carry existing decision authority accurately: if the topic only asks for discussion, return findings rather than treating it as new execution authority. Explicit user choices are constraints on the discussion, not propositions the team can vote to overturn.

Track agenda items as queued, scheduled, discussed, deferred, or resolved, with an owner and links to meeting outcomes. The facilitator includes them in the appropriate agenda, invites relevant perspectives, and records any vote with per-agent reasons. Afterward, make the result and follow-up work available in the user's conversation and default meeting summary. Deferred topics remain visible with a reason and next step instead of disappearing when the meeting runs out of time.

### Meeting records and default view

Retain the full communicated discussion with speaker identities, timestamps, questions, motions and their revisions, amendments, procedural rulings, votes, and outcomes. This record covers what participants actually communicated, not private model reasoning or desk scratch records. Preserve corrections as linked updates rather than silently rewriting earlier statements.

The default summary shows attendance, key updates, decisions and reasons, significant dissent, unresolved questions, assigned actions, and the resulting plan. Link each summarized decision to the relevant discussion and distinguish adopted proposals from successfully applied task changes. Provide a full-discussion view and let the user ask questions such as “why did the team choose that?” with answers grounded in the record. Keep transcript and summary durable in NimbleNewt storage, with project access controls, including when a meeting is interrupted or its summarizer fails. A failed summary must not hide the available discussion.

### Parliamentary meeting procedure

The requested direction is a lightweight parliamentary procedure inspired by Robert's Rules or senate-style meetings. NimbleNewt will define its own explicit rules rather than claim strict compliance with either. The [official Robert's Rules FAQ](https://robertsrules.com/frequently-asked-questions/) and [official interpretations](https://robertsrules.com/official-interpretations/) are reference material; the procedure below is a NimbleNewt design proposal. The user's authority remains above team procedure and cannot be suspended by a vote.

Proposed sequence:

1. The chair opens the meeting, records attendance, and presents the agenda. Routine status reports need no vote.
2. Agents request the floor; the chair recognizes one speaker at a time, prioritizing user questions and relevant responses.
3. A decision proposal becomes a motion with exact wording, scope, rationale, and affected tasks. The chair states the active version before debate.
4. Participants ask questions, debate, and propose amendments within fixed time and turn limits. Resolve amendments before deciding the final motion. Agents may raise a point of order for a procedural breach; record the chair's ruling and any challenge.
5. Decide the final motion under the meeting's configured voting rules, record each eligible participant's vote or abstention with a short reason, and announce the outcome. Unresolved items can be postponed or referred to a bounded investigation with an owner.
6. When the user is present, ask for their agreement or alternative direction and wait before applying that outcome. When absent, apply adopted decisions within delegated authority without requiring later ratification. Record application results, recap actions, and adjourn. Requests beyond delegated authority remain proposals for the user.

Propose a fixed eligible roster per meeting, with quorum and voting thresholds specified before decisions begin. Agent creation, duplicate sessions, or late roster edits must not manufacture extra votes. If quorum is missing, proceed with reports and discussion but defer binding votes. A possible default is majority quorum and a simple majority of votes cast, with ties failing; exact thresholds and whether motions require a second remain open. The user is not required for agent quorum, and an absent participant has not voted in favor.

This procedure should help resolve choices, not turn every question into a vote. Team votes neither establish factual truth nor replace independent verification. No motion may override the user's decisions, expand permissions or budgets beyond delegated limits, bypass cleanup requirements, or change quorum mid-vote. The chair cannot silence the user through procedure. Preserve minority concerns in the summary even when the motion passes. Use bounded debate rather than unlimited speeches or filibusters.

### Immediate meetings

A command such as “bring everyone into a meeting now” creates the meeting conversation immediately, scopes the roster to the current project or named team, and sends a high-priority meeting request. If scope is unclear, resolve it before interrupting unrelated projects. Show each invited agent as preparing to join, present, unavailable, or blocked by an operation it cannot safely interrupt. Starting the room immediately is distinct from guaranteeing every agent is instantly available.

Running agents request a safe boundary, save their position, and join through a bounded meeting task while retaining their original assignments. Do not use Force Stop merely to make an agent attend. Start discussion with available participants and let others join later; a saved brief may supply context but must not be presented as a live answer from an absent agent. If the user explicitly requires everyone present, show missing participants and wait under a visible timeout policy rather than pretending the full team attended.

A task-level Pause does not prevent its owner from responding in a separate meeting task when authorized. An explicitly paused agent should not be awakened by a scheduled invitation; its saved report remains available. A direct user invitation to that agent can authorize bounded attendance while keeping its other work paused. A suspended or stopped agent remains so unless the user authorizes waking or recovering it; report its absence and ask only if its participation is necessary. Meeting attendance never silently resumes its ordinary work.

### Decisions and return to work

Persist the transcript and a concise decision record linked to the relevant project and task versions. Record proposed plans separately from accepted changes, along with owners, dependencies, and follow-up questions. Apply authorized changes to task state with version checks and durable notifications; producing a recap alone is not evidence that the plan changed. Show failures or conflicts in applying a decision.

At the end, agents reconcile the new decisions with existing work. Resume assignments that were paused solely for attendance under the meeting's authorized return policy; preserve pauses, suspensions, and stops that predated the meeting or were requested during it. Revise priorities without silently transferring paused tasks: reassignment still requires explicit Suspend and Release, preparation, and safe handoff. Notify affected absent agents and revalidate their next actions when they return so they cannot continue under superseded decisions.

Timebox discussion and model spending, limit active speakers and response rounds, and batch nonurgent agenda items into the next scheduled meeting. Schedule follow-up work for deep investigations. The console and conversation should expose when a meeting is waiting on a person, agent, or tool rather than concealing idle time as progress.

## Event response

Candidate events include user requests, messages, timers, task completion, file or repository changes, service failures, and model availability. Persist events before acknowledging receipt. Deduplicate delivery, record handling attempts, and support retries and an inspectable queue for failures.

Subscriptions determine which agent or task receives each event. Apply cooldowns, batching, and concurrency limits so a burst of events does not create unlimited branches or a feedback loop. Treat incoming event content as data; an event does not acquire permission to issue instructions merely by arriving through a subscribed source.

## Accepted feature goals

NimbleNewt explicitly distinguishes **P (production)** from **PC (production capacity)**. Delivering requested outcomes and improving the team's future ability to deliver both need scheduled resources. Approved PC work receives protected capacity so a continuous delivery backlog cannot starve it; PC also has limits so improvement work cannot consume all production capacity. Allocation, budgets, eligible queues, and time-limited exceptions are user-configurable. See [Production and production capacity](production-and-capacity.md) for the proposed 80/20 starting policy, evaluation criteria, and stand-up planning. The numeric allocation is a proposal, not a selected default.

The following features are accepted as part of the project vision. Their implementation details remain proposals; inclusion does not set delivery order or select an MVP.

| Feature | Intended behavior |
| --- | --- |
| Task contracts | Assign an expected result, acceptance criteria, budget, permissions, and evidence required for completion. Version changes to the contract. |
| Dependency tracking | Record prerequisites and responsible agents, detect circular waits, and expose who can unblock work. |
| Recovery checks | Before resuming, check for changed files, requirements, dependencies, permissions, and decisions; revise the plan when needed. |
| Independent verification | Route important work to another agent that inspects artifacts and performs relevant checks rather than accepting the author's account. |
| Cost and resource accounting | Attribute provider spending and local resource use to tasks, agents, and projects; support delegated budgets and requests for more resources. |
| Conversational control and supporting console | Answer status questions, help develop projects, and direct work through chat; offer supporting views of activity, costs, and blockers, with task, team, and system Pause, Suspend, Suspend and Release, Stop, and Resume controls. |
| Decision history | Preserve decisions, authors, reasons, evidence, and explicit supersession links so outdated guidance can be recognized. |
| Activity history and replay | Inspect recorded conversations, tool actions, evidence, and decision explanations through a read-only timeline, distinguishing contemporaneous records from retrospective analysis. |
| Safe experimentation | Trial tools, extensions, and approaches in disposable environments, compare results, and promote or roll back versioned changes. |
| Task handoffs | Require explicit Suspend and Release and durable handoff readiness for ordinary release or transfer. Pause and Suspend retain assignments. Share selected context and artifacts without copying the private desk or leaving two active owners. |
| Retirement and archival | Preserve searchable project and agent records while releasing active resources and revoking obsolete execution access. |
| Simulation mode | Exercise workflows using simulated tools and events, including provider failures and competing edits, before granting real write access. |
| Team learning loop | Use observed outcomes to propose improvements to skills, routing, and planning; evaluate versioned changes before adopting team defaults. |
| Improvement feedback | Collect operational friction and project/tooling proposals at stand-ups, track decisions and authorized P/PC work, and report evaluated outcomes. Our NimbleNewt-source workflow is an optional deployment-specific use. |
| Production and capacity balance | Track P and PC task outcomes separately; reserve improvement capacity, protect delivery, bound exceptions, and evaluate whether improvements actually help. |

## Pitfalls and proposed safeguards

See [Pitfalls and safeguards](pitfalls-and-safeguards.md) for failure scenarios, prevention and recovery details, and unresolved tradeoffs. The following safeguards are requirements of the design plan. Mechanisms and policy values remain to be refined; none is claimed to be implemented or verified. This plan does not select phases or an MVP.

## Safeguards in the design plan

| Pitfall | Required design response | Evidence required for validation |
| --- | --- | --- |
| Deployment assumptions leaking into the product | Keep NimbleNewt independently installable; use versioned configuration and UI-managed profiles instead of hardcoded hosts, routes, paths, or team choices. | Extract only NimbleNewt files, install in a clean environment, and configure distinct deployments without source edits or access to the original project. |
| Upstream API changes or command collisions | Pin runtime/adapter versions, reserve NimbleNewt and durable-agent namespaces, validate semantic mappings and checkpoint migrations, and retain tested rollback. | Agent renames preserve queued targets; collisions block activation; old suspended state restores without duplicated effects. |
| Shared tools spreading defects or authority | Restrict publication to scoped toolbox maintainers, promote immutable reviewed artifacts, and enforce caller permissions independently of audience. | Personal edits cannot alter shared versions; unauthorized publication fails; role visibility, invocation, revocation, and rollback remain enforced. |
| Production starving improvement, or improvement replacing delivery | Reserve PC capacity with configurable floors, ceilings, budgets, bounded waiting, and expiring overrides; track accepted P outcomes and evaluated PC benefits. | Continuous backlogs in either category cannot starve the other; relabeling/delegation cannot evade budgets, and overrides survive restart and expire correctly. |
| Platform differences breaking core behavior | Require macOS, Linux, and Windows support; adapt paths, process trees, permissions, installation, and durable storage without weakening lifecycle semantics. | Run core acceptance tests on all three OS families, including abrupt worker termination, restart, protected-path enforcement, and UI settings persistence. |
| Incorrect or stale continuation | Preserve source evidence and versioned constraints; validate current conditions and adapter capabilities before resume. | Recover a buried constraint and detect a changed requirement after restart and model replacement. |
| Duplicate external actions after failure | Journal operation intent and identity, use supported idempotency, and reconcile uncertain outcomes before retrying. | Inject failures around dispatch and result persistence without duplicating effects; expose unresolved outcomes. |
| Competing task owners or conflicting edits | Separate durable ownership from worker leases, reject stale writers, isolate task edits, and check integrated results. | Reconnect a former owner after transfer and deny its writes; detect conflicting combined changes. |
| Communication loops, starvation, and deadlocks | Bound delegation and interruptions, track event causation, deduplicate, limit queue growth, and detect dependency cycles. | Exercise event storms and circular waits while unrelated eligible work continues. |
| Review bottlenecks or weak approvals | Preapprove bounded actions, bind reviews to exact versions and user criteria, independently verify evidence, and expose review deadlines. | Changed artifacts invalidate old approval; an unavailable reviewer does not block unrelated permitted work. |
| Shared mistakes and hostile instructions | Retain provenance, distinguish claims from evidence, enforce read boundaries, and prevent retrieved text from granting authority. | Repeated copies do not count as independent evidence; malicious shared content cannot activate tools or permissions. |
| Team consensus overriding the user | Version explicit user decisions and invalidate conflicting dependent plans, reviews, and pending actions. | A user correction takes precedence across active, paused, and suspended agents, including after restart. |
| Unsafe environment customization | Isolate installations and runtime access, enforce resource limits and protected paths, version environments, and support rollback. | An extension cannot alter another environment or protected metadata; restore the previous environment after failure. |
| Parallel overspending | Reserve shared budgets atomically, account for outstanding work, and reconcile actual usage. | Concurrent children cannot independently spend the same allocation; unavoidable outstanding charges remain visible. |
| Confusing Pause with Suspend or forced stop | Retain ownership during Pause and Suspend; require explicit Suspend and Release for reassignment, bounded cleanup, and durable readiness. Persist execution and assignment states separately. | Background completion does not resume paused work; preparation failure or restart never produces a false readiness report or second owner. |
| Provider cutover losing or repeating work | Enforce ordered fallback lists and durable exclusions centrally, invalidate abandoned responses, and reconcile tool effects. | Skip failed and disabled routes, reject late primary responses, and preserve progress when all eligible backups fail. |
| Lost or unbounded storage | Commit consistent checkpoints and artifacts, verify integrity, reserve recovery capacity, apply reference-aware retention, and test migrations and backups. | Restore on a clean runtime; detect missing artifacts and handle disk exhaustion without claiming a successful checkpoint. |
| Learning that rewards the wrong behavior | Evaluate accepted outcomes against unchanged user criteria using separate evaluation cases, version improvements, and retain rollback. | Detect and roll back a skill or routing change that regresses other tasks despite improving its development examples. |
| Unclear responsibility or controller failure | Keep ownership, policy, accounting, and state transitions in a deterministic core; expose observed status and responsible owners. | Controller outage and recovery preserve decisions and prevent unauthorized new effects; status distinguishes observation from agent reports. |
| Conversation targeting the wrong project | Bind dispatched work to explicit project and repository scope, distinguish proposals from authorization, and report status freshness. | Switching chat focus does not retarget existing work or authorize a brainstormed change. |
| Contaminated contributions or partial cross-repository work | Store operational records externally, preserve initial user changes, inspect final diffs, and track each related contribution separately. | An ordinary checkout yields only intended PR files; partial completion across repositories stays visible and recoverable. |

Each relevant implementation must include its enforcement path and failure-case validation. Agent instructions or a successful simulation alone do not establish that permissions, recovery, and real adapter behavior satisfy these requirements. Unresolved policy choices remain explicit in the safeguards document rather than being silently selected during implementation.

## Validation scenarios

Meeting validation should cover unattended meetings proceeding, summary and full-discussion views preserving decisions and dissent, quorum and duplicate-vote checks, user questions taking priority, safe arrival during an urgent meeting, absent participants, preservation of preexisting pauses, authorized wake-up of suspended participants, and task updates that conflict with newer user decisions. Verify that a meeting recap matches applied task changes and that missed attendees receive those changes before continuing. These checks validate the proposed meeting mechanics once their policy is agreed.

Implementation phases and MVP selection are deferred until the failure modes and design tradeoffs have been discussed. The following scenarios capture behavior to validate without prescribing delivery order or deployment topology.

The system should demonstrate that it can:

1. Begin a task that creates a work product and records a decision.
2. Branch into a short question, answer it, and return to the original task.
3. Suspend execution, terminate the runtime, and reboot the host.
4. Restore the task with its artifact, decision, history, pending messages, and next action intact.
5. Inject a crash around an external action and demonstrate reconciliation without an unintended duplicate effect.
6. Show difficulty-based routing, a queued advice exchange, an event-triggered task, and a persisted stand-up plan.
7. Verify that B can read A's saved work records while A is suspended, but cannot edit them or access private scratch records through files, search, or artifact links. Repeat after restart and a harness change.
8. Customize one agent's environment and verify that another agent's tools and configuration remain unchanged. Restore the customized environment after a restart.
9. Verify that agents can edit authorized source files while attempts to delete, replace, or indirectly modify protected repository metadata are denied. Exercise legitimate Git operations through the proposed service.
10. Test that an extension cannot exceed granted capabilities or resource limits, that required review precedes installation, and that a failed environment change can be rolled back.
11. Draft a project through conversation before it has a repository, then coordinate scoped work across multiple repositories without losing conversational context or confusing targets.
12. Complete a requested bug fix and PR from an ordinary checkout with no NimbleNewt-specific setup files, no ignore-rule changes for NimbleNewt state, and only intended contribution files in the final diff.
13. Answer a status question from durable records without interrupting all workers, distinguishing observed progress from stale reports and plans.
14. Have the team agree on an approach, then issue a conflicting explicit user decision. Verify that affected tasks, reviews, and pending actions follow the user's decision, including after pause and restart, while completed effects are reported accurately.

Also test missing artifacts, incompatible checkpoint versions, unavailable providers, repeated events, context longer than a model's window, and stale workers attempting to resume. Success means observable continuity and correct effects, not merely a plausible claim by the agent that it remembers.

Additional validation scenarios for pause and routing:

- Pause an agent with a background job, capture the job's result, and verify that foreground work stays paused.
- Verify that a paused agent retains its tasks despite an idle replacement, urgent deadlines, elapsed time, or controller restart. Request Suspend and Release, safely transfer a task, and verify that the original agent does not resume the transferred task when it returns.
- Request reassignment while an agent is paused. Verify that it receives a cleanup opportunity, preserves unfinished artifacts and a continuation plan, and retains ownership until readiness and transfer. Exercise cleanup failure and restart during preparation without starting a second owner.
- Request Suspend without release, perform bounded preparation, shut down, and restore with the same task ownership, without losing completed work or duplicating effects. Exercise an uncooperative job and a forced stop separately.
- Disable all local routes while agents are running; verify immediate dispatch exclusion, backup continuation, stale-response rejection, and accurate service shutdown readiness.
- Simulate provider credit exhaustion and use an authorized backup route. Test failures of both primary and backup, incompatible context limits, and restart while a route remains disabled.
- Configure at least three model routes in priority order. Fail the first and explicitly disable the second, verify selection of the third, then exhaust the list and verify durable waiting without looping or using excluded aliases.
- Request Stop with a responsive model and verify Pause, bounded suspension preparation, durable checkpointing, and termination in order. Test Stop during existing preparation, loss of the model during cleanup, deadline expiry, and Force Stop. Verify that restart preserves pending Stop intent and reports whether shutdown was graceful or forced.

- Test Suspend and Release with no recipient available, interruption during the release commit, and an already-suspended owner. Verify recoverable unassigned work, no premature reassignment, and no automatic reclamation by the old owner.

## Ideas to explore next

- A task timeline with pause, branch, message, model change, and resume markers would make continuity inspectable.
- A resume preview could show the checkpoint, next intended action, changed conditions, and expected execution cost before starting a long-dormant task.
- A lightweight controller could handle timers, inbox delivery, and scheduling without using an LLM for every state transition.
- Agents could request a bounded consultation from a stronger model while retaining their own task ownership.
- Track successful resumes, duplicated or repeated work, interruption frequency, time blocked, and cost per accepted outcome to evaluate the system.

## Decisions and unresolved details

See the [design decision register](design-decisions.md) for one consolidated list of accepted decisions, proposed defaults, pending user questions, and implementation questions. Do not treat an unresolved mechanism as a reason to revisit a settled product requirement, or treat a suggested default as a user decision. Phases and MVP selection remain deferred.

NimbleNewt has a standalone local repository and uses the [MIT license](../../LICENSE), with independent dependencies, setup, tests, and documentation. Existing orchestration integrations are optional adapters. Public hosting and publication remain future work.
