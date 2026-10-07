# Design decisions and remaining questions

This register distinguishes settled direction from proposals, unanswered choices, and implementation evidence. A document marked historical cannot override a later user decision. Accepted requirements describe what NimbleNewt must do; they do not claim it has been built or qualified. A proposed implementation outline is registered as an inactive Paperclip backlog; first-release/MVP selection and execution authorization remain deferred.

## Accepted direction

| Area | Decision | Main reference |
| --- | --- | --- |
| Product purpose | Persistent, hierarchical agents with conversation as the primary user interface; task switching and durable recovery. | [Overview](README.md) |
| Work scope | Finite projects and ongoing responsibilities, including coding, QA, marketing, support, graphic design, research, planning, user/development documentation, and server/service maintenance. A developer's local organizational contribution workflow is one important use case. | [Responsibilities](README.md#ongoing-operational-responsibilities) |
| Documentation maintenance | User guidance explains how to use the product; development documentation explains how it works. Relevant implementation and release changes trigger impact checks and tracked updates. | [Areas of work](README.md#areas-of-work-and-collaboration) |
| License | MIT, with no additional hosting restrictions. Contributions are welcome but not required. | [License](../../LICENSE) |
| Distribution | Independent open-source repository; configurable deployment rather than hardcoded private infrastructure. | [Portability](portability-and-configuration.md) |
| Platforms | macOS, Linux, and Windows are required; no platform is optional. Specific versions and architectures still need qualification. | [Platform contract](portability-and-configuration.md#required-operating-system-support) |
| Runtime | Pi Durable is selected, with experimental API risk accepted. LangGraph/Deep Agents is an alternative. | [Runtime decision](runtime-compatibility-and-namespaces.md) |
| Human users | One human owner per installation; teams and delegated roles belong to agents. Multi-user governance is outside the current design. | [Organization](organization-and-workers.md) |
| Authority | The authenticated owner's choices outrank agent proposals and votes. Existing authorization should not require redundant confirmation. | [Authority](operational-contracts.md#authority-and-visibility) |
| Lifecycle | Pause and Suspend retain assignments; Suspend and Release explicitly releases prepared work. Stop normally performs graceful preparation; Force Stop is a distinct exception. | [State and ownership](operational-contracts.md#state-and-ownership) |
| Context | Separate task/chat/meeting histories, expandable source-backed memory, and recorded decisions; no claim of preserving hidden model state. | [Persistent context](README.md#persistent-conversation-context) |
| Desks | Owner-written records readable by authorized peers, with private scratch and scoped retrieval. | [Agent desks](README.md#agent-desks-and-shared-reading) |
| Environments | Per-agent skills/tools/extensions and enforced isolation; code customization does not grant additional authority. | [Environments](README.md#individual-agent-environments) |
| Tools | Protected NimbleNewt operations, shared maintainer-managed toolbox, read-only shared source, personal forks, and reviewed improvement proposals. | [Shared toolbox](README.md#shared-toolbox-and-promotion) |
| Naming | Prefixed NimbleNewt and agent commands; durable agent identity separate from editable friendly names. Exact grammar/alias defaults remain proposed. | [Namespaces](runtime-compatibility-and-namespaces.md#command-naming) |
| Routing | UI-editable difficulty profiles and ordered model routes; every model-using role obeys exclusions and fallback constraints. | [Routing](README.md#provider-switching-and-backup-models) |
| Meetings | Scheduled and immediate meetings, unattended operation, summary and full transcript, votes with reasons, human-present agreement before action. | [Meetings](README.md#stand-ups-and-live-meetings) |
| Supervisor recovery | Supervisors can detect and redirect stalled or looping work, with bounded controller-enforced interruption, saved context, and explicit handoff authority. | [Recovery contract](operational-contracts.md#supervisor-intervention-and-stalled-work-recovery) |
| Quality assurance | Every agent checks its own work; additional QA responsibility can cover assigned work, projects, or entire teams. Scope and independent-review gates are explicit, with evidence tied to the reviewed version. | [QA](README.md#quality-assurance-and-review-scope) |
| Work balance | Explicit production and production-capacity work; protect improvement without starving delivery. Numeric allocations remain proposals. | [P/PC](production-and-capacity.md) |
| Replay | Read-only observable activity, source/artifact versions, and short stated rationales; no automatic tool/model reexecution. | [Replay](README.md#activity-history-and-replay) |
| Repositories | Multi-repository projects; no required NimbleNewt files in target repositories. | [Repository independence](README.md#multiple-repositories-without-repository-setup-requirements) |
| Product/development separation | Our NimbleNewt-source improvement/build/deployment loop is optional installation tooling. Public users improve their own projects; official-release installation is separate. | [Development workflow](development-workflow.md) |

## User questions from the document review

The single-owner decision is settled. Worker placement remains a separate question; choosing one human user does not require one computer.

| Question | Recommended direction | What it affects |
| --- | --- | --- |
| Worker placement | One logical controller coordinating registered local/remote workers, including mixed operating systems. Defer active-active controllers. | Worker registration, secure transport, artifacts, disconnections, and update coordination. |

See the accepted ownership model and proposed [worker topology](organization-and-workers.md). User responses should update this register and the associated contracts rather than leaving contradictory versions across files.

## Proposed defaults, not user-selected values

| Setting | Current proposal | Required behavior regardless of default |
| --- | --- | --- |
| P/PC allocation | Rolling weekly 80/20 target, PC floor 10% and ceiling 30% while both queues are eligible. | UI/chat configurable; bounded exceptions, actual accounting, and no quota-driven busywork. |
| Meetings | Daily cadence with configurable timezone, roster, duration, and budget. Exact clock time unset. | No duplicate missed meetings; preserved participation and decisions. |
| Voting | Fixed eligible roster, majority quorum, simple majority of votes cast, ties fail. Seconding rule unset. | Abstentions/missing voters do not become yes votes; no manufactured quorum or override of human authority. |
| Lifecycle limits | Preparation deadlines, cleanup budget, and force-escalation policy unset. | Show blocked preparation; never silently Force Stop or release assignments. |
| Provider cutover | Immediate exclusion for new dispatch; planned drain versus immediate cancellation is explicit. Default drain duration/failback unset. | Disabled routes remain disabled until authorized reenablement; no endless retry or duplicated effects. |
| Personal customization | Drafts within existing rights; catalog preapproval or scoped review for executable changes. | Exact artifact approval, isolated activation, bounded permissions, and rollback. |
| Commands | `/nimblenewt.*`, `/toolbox.*`, durable agent prefixes, optional `/agent.*` and `/custom.*` aliases. | Canonical IDs persist; aliases cannot change queued targets or bypass collisions/permissions. |
| Maintenance | Authorized exact releases, configured windows, isolated activation, automatic startup-failure rollback. Window/channel/automatic update defaults unset. | No unapproved candidate, lost input, double writer, or blind post-effect state rewind. |
| Task return | Reassess eligibility/priority at the return boundary; temporary interruptions can carry authorized auto-return. | Retain original assignments; preserve manual lifecycle gates. |

Validate configuration combinations: a requested PC target must fit its authorized floor/ceiling or explicitly revise them; similarly reject impossible time/resource/permission settings. Do not infer final numeric approval from illustrative examples elsewhere.

## Engineering choices to resolve before implementation commitments

- Choose the controller/worker transport and durable storage engines, artifact layout, cross-store checkpoint protocol, schema migration strategy, and tested backup/restore procedure.
- Qualify the pinned Pi Durable adapter, extension/command mappings, background jobs, and one compression owner; choose reuse versus porting for billion-context-style retrieval.
- Select per-platform sandboxing, protected Git operations, process-tree control, credential storage, and file-sharing mechanisms. Define minimum OS versions, Linux distributions, architectures, and filesystems.
- Specify the initial action/role permission catalog, permission-change audit, independent-review rules, delegated ceilings, and approval timeouts without granting authority through titles alone.
- Define owner inspection of private agent records, retention, retirement, deletion/backup treatment, recovery time/lost-progress objectives, and resource reservation for shutdown/recovery. Recovery at durable boundaries is the baseline; arbitrary live-process restoration is not promised.
- Define configuration migration, official release trust/publisher verification, updater installation, health checks, backward-compatible rollback windows, and failure recovery when both versions fail.
- Select notification delivery, presence/disconnection handling, meeting quorum details, maximum queue/wait bounds, and the semantics of blocked job reconciliation.
- Define attribution of meetings, supervision, and other shared overhead in P/PC accounting, along with measurement of occupied worker slots and background resources.
- A standalone local NimbleNewt repository has been created. The public project name is NimbleNewt. MIT is selected. Choose public hosting destination and contributor guidance before publication; the repository has not been published.

General project collaboration, coding, and ongoing operational responsibilities are all in the product vision. Which capabilities are delivered first is a later phase/MVP decision, not an unresolved statement of purpose. NimbleNewt is independent; existing orchestration integrations are optional rather than a dependency question.

## Evidence status

The [harness report](harness-test-results.md) records six recovery scenarios and a Pi runtime-control suite using real harness packages with fake models/effects, on macOS only. Those results support narrow recovery and integration claims, not isolation, real provider failover, host reboot, Linux/Windows qualification, meetings, or an implemented NimbleNewt controller. No runtime tests were rerun during this prose review.

The [regular pi document](pi-integration-research.md) is historical source research. Its slash commands, hooks, and session sidecars are not assumed to apply to Pi Durable. The earlier Deep Agents preference is retained only as historical evaluation context; Pi Durable is selected.
