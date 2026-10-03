# Organization and worker topology

**Accepted baseline: one human owner per Relay installation.** The owner directs teams of agents across projects and repositories. Multiple human accounts, shared human administration, and human role hierarchies are outside the current design. Worker placement is a separate decision, with the multi-host proposal below still awaiting confirmation.

## One owner, teams of agents

Give the human owner a durable authenticated identity distinct from agent and service identities. The owner configures the installation, sets priorities, delegates permissions, and resolves decisions. Authentication still matters with one user: repository content, agent messages, remote events, and tool output cannot impersonate the owner.

Agent teams retain their hierarchy and scoped capabilities. A lead engineer or safety supervisor is an agent role with explicit permissions, not another human account. Tool publication, environment approval, merge/deployment, and release management remain separately scoped capabilities. Sharing one human owner does not give every agent access to every project, secret, tool, or private desk.

The owner's explicit choices outrank agent consensus. When the owner attends a meeting, agents can vote with short reasons and ask whether the owner agrees or chooses another direction. In the owner's absence, agents can decide and act only within previously delegated authority. Pending owner agreement remains pending unless explicitly delegated; leaving a meeting is not approval.

The owner may use multiple conversations or devices. Record which instruction revises which decision, and check the current decision version before acting. A clear revision supersedes the earlier instruction; ambiguous or conflicting instructions require clarification from the owner, not an agent vote or silent arrival-order resolution.

Agent-private scratch is private from peer agents, including supervisors unless explicitly granted. Human inspection and retention details remain to be specified; single-owner operation removes the need for separate project-lead, observer, and administrator access rules. Secrets remain protected from accidental disclosure in replay and exports. Conversations with the owner do not become shared agent context automatically: publish the relevant authorized decisions or selected context. Retrieval, summaries, and personal memory must respect each agent's project access.

## Work beyond software development

The owner can assign marketing, support, graphic design, research, planning, user documentation, development documentation, and ongoing operations as well as coding. These can be individual assignments or continuing specialist responsibilities; see [areas of work and collaboration](README.md#areas-of-work-and-collaboration). Server maintenance is an explicit use case: an agent owns service health and approved updates over time, creating bounded checks and interventions under a continuing responsibility. See [ongoing operational responsibilities](README.md#ongoing-operational-responsibilities) for lifecycle, monitoring, and recovery requirements. Projects may have no repository at all.

QA can be limited to an agent's own work or assigned across a project or team. A developer may also use their installation to review their human team's work through authorized organizational systems. Broad review scope does not add human accounts or grant extra mutation permissions. See [quality assurance and review scope](README.md#quality-assurance-and-review-scope).

## Developer workflow within an organization

One important deployment is Relay installed on an individual developer's development machine. The developer directs their own agents across the projects they work on and submits resulting code changes within their organization. Other developers can use separate installations; shared organizational work flows through existing repositories, issues, branches, pull requests or merge requests, reviews, and CI. Direct coordination between separate Relay installations is not required by this workflow.

Relay should support the full local contribution loop: understand the request, inspect an existing checkout, prepare an isolated task workspace where needed, implement changes, run relevant checks, present the diff and validation results, and help submit or revise a contribution when authorized. Preserve the developer's existing uncommitted work. Keep agent transcripts, desks, configuration, and orchestration state outside the target repository; submitted changes contain the intended project work, not Relay's internal records.

The developer controls their Relay agents, while repository permissions and organizational review requirements continue to govern submission and merge. Owner approval inside Relay does not bypass branch protections, required reviews, or CI. Use explicitly configured credentials and accurate commit/submission attribution; do not assume that permission to edit locally also authorizes pushing, opening a review, merging, or deploying. Existing delegation can authorize these actions without repeated confirmation.

Model and tool configuration must accommodate the developer's permitted services and project data restrictions. A local installation may use approved remote models; local installation alone does not mean source code stays on the machine. Fallback routes must preserve those restrictions. Integrations should be optional and provider-independent so the same contribution workflow can fit different organizations and open-source projects.

## One controller, multiple worker hosts

**Separate proposal awaiting confirmation.** Single-owner operation does not decide how many computers may run workers. The recommendation below supports local and remote workers, but multi-host execution is not yet an accepted requirement.

Keep one logical controller authoritative for assignments, decisions, gates, and resource/accounting records. Workers register a durable host identity and capabilities such as OS/architecture, installed harness versions, isolation backend, tools, and workspace bindings. Local execution uses the same contract with a simpler transport. A GPU model server can be just a model route; it need not host an agent worker.

Authenticate and authorize worker enrollment, protect transport, and scope credentials to the assigned work. A friendly hostname is not proof of identity. Workers must not mount the controller's writable state or concurrently open the same Pi Durable database as a coordination mechanism. Each native harness store has an exclusive owner; movement of a task uses explicit checkpoint/artifact transfer and compatible environment restoration.

Schedule work only where its platform, tools, data-location policy, repository access, and resource requirements are satisfied. Transfer exact artifact versions with integrity checks rather than assume a path exists identically on every computer. Keep private source and credentials on authorized hosts. Moving an execution location for the same agent is distinct from transferring assignment to another agent; both require stopping/fencing the prior attempt before enabling a replacement writer.

Controller connectivity is part of execution authority. Under a partition, do not start new privileged effects with stale authority. Already-started local/remote jobs may continue physically; journal observations, report uncertainty, and reconcile before takeover. An unreachable worker is not evidence that it stopped. Returning workers must revalidate their attempt/ownership generation and cannot commit late writes. Offline autonomous execution would require a separately specified bounded authority model; it is not assumed by this proposal.

Scope maintenance to a host, agent group, or installation. A host outage must not automatically release agent assignments. The controller can coordinate readiness, but an unreachable host cannot be reported safely suspended without evidence. Staged releases need compatible controller/worker protocol versions, and rollback must preserve that compatibility.

One logical controller can later gain a tested failover mechanism, but this proposal does not include several independent active schedulers or continued write authority during uncertain controller leadership. Backups and recovery come before any such extension.

## Simple setup and future scope

The baseline setup has one owner and a local worker, with projects and agent teams created as needed. It requires no human membership management, enterprise identity service, or network cluster. Whether remote workers belong in the initial design remains open.

An individual using Relay for business work can direct agents across business projects, repositories, and managed services within their own authorization. This does not imply shared access for coworkers. Supporting several human users would require a separate design decision covering membership, privacy, conflicting authority, approvals, and meeting rights; it is not a promised upgrade path. Keep human, agent, and service identities distinct without implementing speculative enterprise governance.

## Qualification scenarios

- The owner directs several agent teams while project-restricted agents cannot retrieve other projects' files, messages, secrets, or memory through tools, replay, or summaries.
- An agent vote cannot override the owner, grant new permissions, or satisfy a pending owner approval.
- Conflicting instructions from the owner's concurrent conversations are surfaced before the disputed action proceeds.
- Repository content and agent messages cannot authenticate as the owner or change installation permissions.
- A one-person local installation works without external identity services or a network cluster.
- A developer completes an authorized contribution from an existing checkout through review submission, without adding Relay metadata, overwriting unrelated local work, bypassing repository checks, or disclosing project data to a prohibited fallback provider.

- A server-maintenance responsibility survives completion of individual checks and host restart, records stale observations accurately, and reconciles an interrupted update before another attempt.
- Pausing or suspending a maintenance agent preserves queued alerts and responsibility ownership without silently stopping the managed service or allowing competing maintenance writers.

If the multi-host proposal is accepted, also qualify:

- A Mac controller schedules suitable Linux and Windows work; loss of one worker neither duplicates effects nor releases assignments.
- A worker rejoins with stale authority; its writes are denied until reconciliation and a current attempt grant.
- Task migration preserves artifacts and context while rejecting unavailable paths, credentials, platforms, or model-data permissions.
