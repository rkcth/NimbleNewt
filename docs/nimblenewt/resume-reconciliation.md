# Resume reconciliation and dependency tracking

Accepted planning direction: preserve task context, detect changed inputs and reconcile relevant updates before continuing. This is a controller/adapter contract to implement, not a claim of perfect semantic relevance, live model snapshots or a qualified implementation. The product explanation remains in the [overview](README.md).

## Dependency record and change log

Track dependencies during execution, not only when suspension is requested. Each checkpoint refers to a durable manifest with task/attempt identity, ownership generation, context/artifact versions and an event cursor per authoritative stream. Record each dependency's stable resource identity and scope, observed hash/revision, access type (read, write or read/write), source reference and observation time. Record proposed write targets and their expected base versions. Reads through tools and shell commands need instrumentation or a declared conservative scope; unobserved reads cannot be described as complete coverage.

Dependencies include files and repository revisions, uncommitted content, shared records, decisions, tool/environment versions and external resources. Directory listings, glob results and searches also carry dependency scope: additions, deletions and renames can change their results even if no previously opened file changed. Record query parameters, searched namespace and result/version fingerprint; re-evaluate bounded queries or conservatively invalidate their scope when necessary. A negative lookup is a dependency too.

Controlled mutations append durable change events with stable IDs, resource revisions, provenance and causation links. Preserve cursors through restart, deduplicate delivery and expose retention gaps. Watchers are hints for unmanaged edits; durable events alone are insufficient. Compare current authoritative revisions/content hashes with the manifest on return. Git is one source of identity and history, not the only source of change truth.

For external dependencies use supported revisions, ETags, conditional reads or authoritative queries. If no trustworthy version exists, refresh the observation under the task's permissions or report explicit freshness uncertainty. Cached timestamps and an unchanged local checkout do not establish external freshness. Missing/revoked dependencies remain blockers or scoped uncertainties, not evidence of no change.

## Resume lifecycle

1. **Remain gated.** Accept authorized resume intent durably; retain manual/parent gates and assignment. Verify ownership, policy, budgets and exclusive execution authority. Fence the previous attempt; this does not release the task.
2. **Load a committed checkpoint.** Validate referenced context, dependency manifest and artifact versions. Resolve in-flight/unknown effect outcomes required for continuation. Missing or incomplete checkpoint data prevents a ready claim.
3. **Collect candidate changes.** Replay events after saved cursors within the allowed scope, deduplicate and batch. A missing cursor, retention gap or uninstrumented interval triggers direct reconciliation rather than silent success.
4. **Verify current dependencies.** Compare actual file hashes/resource revisions, including uncommitted/non-Git changes, deletions, renames, directory/query results and external observations. For a task worktree, also examine relevant changes in the integration target; an unchanged isolated worktree does not prove the shared project is unchanged.
5. **Prepare a permission-filtered delta packet.** Include permitted resource identity, old/new versions, source-backed diffs or refreshes, relevant events and affected assumptions/evidence. Preserve the original task history and checkpoint. Filter metadata, summaries and content under current permissions; never expose revoked/private records through a delta. Record unavailable evidence as an authorized scoped blocker without leaking restricted details.
6. **Review relevance and invalidate evidence.** The agent determines semantic impact from the packet and sources; the controller identifies dependency/version changes. Mark affected assumptions, derived artifacts, tests and approvals stale/pending review. Propagate through recorded dependency edges. Preserve historical evidence with its versions; revalidate, revise or rerun before relying on it. Unknown dependency coverage requires conservative review, not a claim of exact relevance.
7. **Commit checked continuation.** Record reviewed versions, decisions, invalidations, unresolved uncertainty, next step and new cursors. Verify the reconciled versions have not changed again before admitting dependent execution. A changed dependency returns the task to reconciliation; bounded retries expose ongoing churn as a blocker. Unrelated eligible work need not be stopped globally.
8. **Guard each consequential write.** Compare the target and required input versions against those reviewed, with atomic conditional mutation or protected integration. New attempts carry current fencing tokens. A check followed by an unrestricted write is not race-safe. External effects need their existing intent/idempotency/reconciliation contract; APIs lacking conditional updates require a service-specific lock/version route or an explicit bounded uncertainty policy, not an invented atomic guarantee.

Resume statuses distinguish collecting, verifying, reviewing, ready, blocked and executing; readiness identifies its verified revision set. A subscription event does not itself lift a lifecycle gate.

## Workspaces and integration

Prefer isolated checkouts/worktrees per coding task and controlled integration of changes. Preserve dirty user work and record base revisions. Concurrent source changes are reviewed through diffs, merge/conflict checks and tests against the resulting combined version before integration. Worktrees are editing arrangements, not security boundaries.

For genuinely shared live files, enforce version-checked atomic writes and conflict handling through every authorized write path. Direct shell writes or writable mounts must not bypass the guard. Reject stale writers and preserve their pending changes for review instead of overwriting another agent's work. Task fencing protects ownership; resource version checks separately protect cross-task conflicts.

## Acceptance tests and failure cases

- A reads a file at version 12, suspends, B changes it to 13: A receives the permitted diff, reviews affected assumptions, invalidates dependent tests/approval and writes only against a reviewed current version. An unchanged dependency avoids unnecessary rebuilding.
- Detect uncommitted and non-Git edits, deletion/rename, new matching directory/search results and a formerly missing file becoming present. Report or conservatively review uninstrumented tool reads.
- Change a shared integration target while A's isolated worktree stays unchanged: preserve A's work, detect conflicts and validate the combined result before integration.
- Drop/duplicate/reorder watcher delivery, restart controller/worker and expire the event cursor: direct version reconciliation still detects changed dependencies; no duplicate effects or silent missed-event success.
- Revoke access while suspended: no private content or metadata leaks through delta packets, summaries or retrieval; dependent continuation is blocked or explicitly scoped to permitted evidence.
- Change a decision, shared record, tool version or external ETag; test an unavailable service and an unversioned response. Refresh or surface uncertainty and invalidate affected conclusions without claiming complete external knowledge.
- Change inputs after packet review and change a write target between check and commit: checked admission/conditional writes reject stale continuation; re-reconcile under bounded retries. Reconnect the old attempt and deny its writes.
- Inject missing checkpoint artifacts, incomplete manifests, unknown command outcomes, manual/parent holds and continuous change churn: readiness remains honest, ownership stays unique and blocked state survives restart.
- Re-review a change judged irrelevant: preserve the evidence and rationale; do not erase history or indiscriminately rerun every task. Test a missed indirect dependency conservatively; version change detection is not perfect semantic relevance detection.

Qualify these cases on macOS, Linux and Windows with reproducible fixtures and authoritative versions. Storage schema, hash policy, watcher backend, instrumentation coverage and remote-resource adapter selection remain engineering choices. Planning approval does not activate implementation; BickelsSurplus remains first and N00 remains the implementation gate.
