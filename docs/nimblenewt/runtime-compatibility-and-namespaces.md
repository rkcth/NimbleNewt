# Runtime compatibility and command namespaces

## Accepted runtime decision

The user selected **Pi Durable as NimbleNewt's reference worker runtime**, accepting its experimental API risk in exchange for its close fit to persistent conversations, tasks, and customizable agents. LangGraph/Deep Agents remains an alternative, not a second required implementation. Selection is not production qualification: macOS, Linux, Windows, isolation, recovery, and context integration still require validation.

NimbleNewt owns its public commands, stable operation identities, permissions, and lifecycle contracts. Put Pi Durable APIs behind a versioned adapter inside the isolated worker. Do not expose upstream method names as NimbleNewt's durable contract or assume regular pi CLI extensions and slash commands exist unchanged in Pi Durable.

## Command naming

Prefixing is the accepted direction. Proposed canonical naming and aliases are:

| Form | Meaning and owner |
| --- | --- |
| `/command` | Native harness command, when the integration exposes one. NimbleNewt and personal extensions do not claim unprefixed names. |
| `/nimblenewt.command` | Reserved NimbleNewt command, registered by the trusted controller. For example, `/nimblenewt.pause`. |
| `/toolbox.command` | Shared toolbox command, published by a scoped `toolbox.manage` holder. Resolve within an explicit toolbox scope to a stable tool ID and version; reject ambiguous names. |
| `/a_<durable-id>.command` | Agent-owned command with an immutable, computer-assigned agent identifier. For example, `/a_<durable-id>.run-tests`. The angle-bracket text is a placeholder, not literal syntax. |
| `/agent.command` | Optional convenience alias for a command of the explicitly selected agent. Resolve and bind to that agent's canonical command before dispatch. |
| `/custom.command` | Optional additional alias for a custom command in an explicit owner/scope. It does not create a shared unowned namespace or confer extra permissions. |

Prefer `/agent.command` as the local shortcut and the durable-ID form for cross-agent references. The UI can display a friendly label next to either. Friendly names can change or be duplicated; they never determine identity, ownership, authorization, or persisted routing. Persist computer-assigned IDs across restarts and restores, never reuse retired IDs, and allocate new IDs when cloning an agent into a distinct identity. Detect import collisions rather than merging identities silently. Use a full identifier in canonical records; an abbreviated display must not become an ambiguous dispatch key.

Reserve the NimbleNewt and alias prefixes, and allocate each agent prefix from a controller-owned registry. Proposed names use a documented lowercase ASCII grammar, with normalization and collision checks at registration. Reject duplicate canonical names and normalized/encoded collisions; no last-installed-wins resolution for NimbleNewt commands. An ambiguous alias stays unresolved until a target is supplied. Queued work records the resolved target, not a shortcut whose meaning can change when the UI switches agents.

Slash commands are a NimbleNewt interaction syntax proposal, not a verified Pi Durable parser feature. UI actions and agent tool calls should resolve to the same authorized operation through the adapter. Keep canonical operation ID, input schema version, owner ID, implementation revision, and display name separate. Model providers may impose different tool-name restrictions; use an explicit collision-free mapping to supported wire names, without assuming dots or slashes are accepted or replacing punctuation in a way that merges names.

Prefixes prevent accidental clashes; they are not a security boundary. Personal extensions cannot register NimbleNewt-owned commands, choose another agent's prefix, or use an alias to bypass authorization. Validate permissions at execution in NimbleNewt services even if worker code is modified. The controller and command UI must remain usable independently of the model.

The `toolbox` prefix is also reserved: a personal extension cannot claim it. Promotion creates a separately managed shared artifact with provenance back to the personal tool, not a mutable alias to the agent's desk. Shared-tool maintenance requires a scoped permission and does not authorize modification of NimbleNewt's protected adapter. See [shared toolbox and promotion](README.md#shared-toolbox-and-promotion).

Conversely, an authorized agent can read a published tool's source and fork it into its own namespace. Record the shared tool ID and base version, give the fork its own identity, and keep `/toolbox.command` bound to the published implementation. Sharing a patch for maintainer review does not publish the fork or retarget existing calls.

## Updating Pi Durable safely

Runtime upgrades participate in the proposed [maintenance and update protocol](maintenance-and-updates.md), using a protected updater outside NimbleNewt, exact authorized artifacts, quarantined activation, and automatic startup-failure rollback. The compatibility work below is a prerequisite to that protocol, not permission for agents to patch the live installation.

Pin the runtime, transitive dependencies, adapter, and extension artifacts. Record the full version set with each worker environment and checkpoint. Do not automatically activate unqualified upstream releases.

For an upgrade:

1. Inventory upstream API, command, event, tool, and persisted-state changes. Compare required signatures and behavior as well as names. Produce an explicit compatibility map from stable NimbleNewt operations to the new APIs; unknown or ambiguous mappings block activation rather than falling back to a similar-looking command.
2. Check the complete command/tool registry, including native commands, aliases, personal extensions, and provider wire names. An upstream claim on a reserved name must be contained by an explicit dispatcher/adapter mapping or resolved before activation. Do not silently shadow either implementation.
3. Test the candidate with fixture checkpoints from the old version, including paused/suspended agents, pending decisions, queued commands, interrupted effects, branches, and context sidecars. Test names and semantics on macOS, Linux, and Windows. Fixture recovery must use fake services and disabled live dispatch so replay cannot repeat real effects.
4. Stage the new artifacts and any schema migrations. Suspend affected workers without releasing assignments, capture consistent backups of state and artifacts, and activate the version set atomically. Keep the previous version available until recovery and compatibility checks succeed.
5. Verify restoration, command resolution, protected namespaces, routing exclusions, and lifecycle behavior before resuming ordinary work. Preserve the prior paused/suspended state until explicitly resumed. Failed activation keeps the worker unavailable or restores a verified compatible version; do not reinterpret a failed command.

Code rollback is insufficient after an incompatible data migration. Restore a compatible snapshot or use a tested reverse migration. If new external effects occurred after activation, do not rewind their records blindly: reconcile them before resuming from older state. Maintain single ownership throughout rollout and rollback.

Renames use versioned, explicit aliases where semantics remain equivalent. Changed semantics require a new schema/operation version or migration, not just a spelling replacement. Retain enough old-version metadata and executable artifacts to recover long-suspended work. Report compatibility and migration status in the UI, including affected agents and operations. No agent or supervisor may silently rewrite the protected adapter as a personal environment change.

## Acceptance cases

- Rename an agent's friendly name; canonical commands, pending work, ownership, and history still address the same agent.
- Give two agents identical friendly names and identical custom command names; durable prefixes remain distinct, and ambiguous shortcuts cannot dispatch.
- Attempt reserved-prefix registration, another agent's prefix, and provider-name encoding collisions; reject them without changing the active registry.
- Rename an upstream method and test a reviewed mapping. Change its argument/result semantics and verify that a name-only mapping fails qualification.
- Restore an old suspended checkpoint under the candidate version; retain assignments, inbox entries, command identities, and private context boundaries.
- Introduce a native command collision and a failed state migration; prevent activation and preserve a recoverable version.
- Exercise rollback both before any new external effects and after a simulated effect requiring reconciliation.

This document specifies contracts and upgrade safeguards; it does not claim an implemented command dispatcher, migration system, or rollout mechanism.
