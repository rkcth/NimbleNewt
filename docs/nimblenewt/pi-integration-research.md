# Regular pi integration research (historical alternative)

Research recorded October 3, 2026. This is a documentation and source-example assessment, not an installation, security audit, or runtime compatibility test. Online main branches and gallery releases can differ. Pin exact runtime and extension artifacts before validating the proposal. No extensions were installed during this review.

## Scope and historical recommendation

This is the pi-specific assessment within the broader [harness comparison](harness-comparison.md). The user subsequently selected Pi Durable, which is distinct from regular pi. This document remains regular-pi reuse research; its SDK/RPC APIs, slash commands, and extensions are not assumed compatible with Pi Durable. See the [selected runtime and compatibility plan](runtime-compatibility-and-namespaces.md).

If a regular pi adapter is added later, use it inside an isolated NimbleNewt worker controlled from outside. The recommendations below apply to that alternative, not the selected Pi Durable API. Keep the preloaded NimbleNewt bridge for dynamic script tools, communication, and maintenance requests. NimbleNewt owns task assignments, lifecycle intent, approval records, job tracking, and routing policy. Pi supplies execution and session primitives. The documented APIs make this plausible, but no stock extension establishes all of NimbleNewt's guarantees.

Package stable NimbleNewt tools as protected, controller-managed pi extensions. Load them from read-only versioned artifacts with loader configuration outside the agent's write authority. Agents may invoke desk, task, meeting, messaging, job, and maintenance tools but cannot modify or remove their implementations. Keep agent-authored scripts and approved personal extensions in separate writable or staged locations. Equivalent adapters for other harnesses should call the same NimbleNewt services.

Protection must include reserved names, configuration, package paths, and runtime activation checks. Since personal extensions execute in the same worker process, an immutable extension file does not make its runtime invulnerable. Enforce authorization and lifecycle invariants in external services with scoped worker credentials, and reject environment revisions that replace or disable required bridge tools. Avoid exposing a generic privileged controller command through the extension. Protected-base changes use administrator-controlled rollout, not ordinary agent self-service installation.

Pi Durable has since been selected. Existing pi CLI extensions are not assumed compatible with it; this shortlist provides porting ideas and historical source evidence only.

## Extension shortlist

This shortlist evaluates reuse, not mandatory dependencies. NimbleNewt may build any needed tool or extension itself. Prefer custom implementations where package behavior conflicts with NimbleNewt's lifecycle, ownership, or permission requirements; retain equivalent tests and versioned contracts. Shared service implementations with small harness-specific wrappers help keep custom tools portable.

| Component reviewed | Recommendation for NimbleNewt | Reason and integration condition |
| --- | --- | --- |
| NimbleNewt bridge, to build | Required for every pi worker | Stable discovery, description, invocation, registration, messaging, and maintenance-request tools. External services enforce permissions and lifecycle state. |
| [billion-context-pi](https://github.com/ranxianglei/billion-context-pi) or the appropriate [billion-context integration](https://github.com/ranxianglei/billion-context) | Preferred context-management candidate; select exactly one supported path | Required capability is long-lived retrievable conversation. Verify the chosen adapter against the pinned pi version; preserve compression state alongside history and avoid overlapping compaction owners. Disable or replace any independent delegation path with NimbleNewt-controlled delegation. |
| Pi built-in tool search, codemode, and MCP integration | Evaluate reuse before adding another package | The [SDK documentation](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/sdk.md) identifies these as CLI built-ins that SDK sessions need to load explicitly. They are optional ways to expose services; the stable NimbleNewt bridge remains sufficient for ordinary script tools. |
| [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) | Optional compatibility candidate | Offers MCP access. Compare with the selected pi version's native MCP support; avoid installing two competing MCP integration layers by default. Use only when a concrete integration requires it. |
| [ismailsaleekh/pi-background-tasks](https://github.com/ismailsaleekh/pi-background-tasks) | Evaluate process-only functionality, not a baseline dependency | Documents durable job records, notifications, optional same-process reload survival, and additional delegation/Fusion features. Automatic follow-up wakes conflict with Pause unless controlled. Its feature flags can narrow the surface. Do not infer reboot-resumable processes from durable records or reload survival. |
| [Jawfish/pi-background-tasks](https://github.com/Jawfish/pi-background-tasks) | Not a durable job foundation | Its documentation explicitly scopes jobs to the session and says task state is not stored for a later pi process. Similar package names must not be treated as the same implementation. |
| [pi-subagents](https://github.com/nicobailon/pi-subagents) | Not required in the baseline | It supplies delegation, but NimbleNewt must own hierarchy, budgets, ownership, and recovery. Consider only behind NimbleNewt's dispatch controls, not as a second independent team scheduler. |
| [Pi sandbox example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts), [pi-permission-modes](https://github.com/wynainfo/pi-permission-modes), and [pi-sandbox](https://github.com/jasonish/pi-extensions/blob/main/pi-sandbox/README.md) | Reference or defense-in-depth candidates | Review their exact coverage before adopting one. Isolate the whole worker externally; intercepting selected tools is insufficient to contain arbitrary installed extension code. Do not give an agent authority to disable the outer boundary. |
| [Official reload-runtime example](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/examples/extensions/reload-runtime.ts) | Reuse the pattern only behind NimbleNewt maintenance policy | Demonstrates a model-callable tool queuing an extension command that invokes `ctx.reload()`. This corrects the blanket assumption that an agent can never request reload: the ordinary tool context cannot call it directly, but an installed bridge can request it indirectly. |
| Browser, search, language-specific, or service tools | Role-specific additions | Add only for a concrete agent responsibility. Prefer catalog scripts or approved service integrations when no harness hook is needed. No universal third-party package set is justified yet. |

The background-task findings above come from the [package's own published README](https://pi.dev/packages/pi-background-tasks). Its broad default feature set makes a focused evaluation necessary. A NimbleNewt-owned external job service remains the preferred design because background jobs must be observable independently of the pi worker that started them.

Pi's [security documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md) distinguishes isolating the entire process from sandboxing only tools. NimbleNewt should use the former as its actual boundary, regardless of optional in-process permission extensions.

## Documented pi primitives

The [RPC command reference](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/rpc-commands.md) documents `steer`, `clear_queue`, `abort`, `abort_retry`, model selection, session switching, and session-entry inspection. Crucially, `abort` can continue queued messages; clear them first. Session switching can be cancelled by an extension, so check the returned result. `get_entries` includes pre-compaction history and branches, unlike a current-message projection.

The [RPC protocol documentation](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/rpc.md) distinguishes accepted commands from completed work and identifies `agent_settled` as the completion boundary after automatic continuations. Closing stdin requests orderly shutdown. Neither a successful command receipt nor one `agent_end` event proves NimbleNewt suspension is complete.

These are building blocks, not a documented native implementation of NimbleNewt's Pause or Suspend semantics. Do not ship an adapter that equates `abort` with a durable checkpoint or safe tool cancellation.

## Proposed lifecycle adapter

| NimbleNewt operation | Proposed use of pi | What NimbleNewt must add |
| --- | --- | --- |
| Pause | Cooperatively yield at a safe boundary; use cancellation only when necessary. Hold the worker idle or switch to a separate authorized discussion session. | Persist pause intent and retained ownership, gate new work, park queues, and prevent completion notifications from waking the task. Keep background jobs in the external job service. |
| Suspend | Permit a bounded cleanup turn, settle execution, then shut down the worker after checkpoint verification. | Save history, active branch, context sidecars, environment revision, artifacts, pending events, and job dispositions. Retain ownership; do not report readiness until persistence completes. |
| Suspend and Release | Same worker preparation as Suspend. | Commit durable handoff and explicit assignment release separately from freeing process resources. Reject stale writes. Pi session operations do not assign NimbleNewt tasks. |
| Resume | Start the pinned environment and reopen the exact persisted session or switch to it after checking the result. | Reconcile effects, ownership, current user decisions, and provider eligibility before permitting new work. Rebind bridge and context integration. |
| Stop | Prefer the suspension preparation path, then terminate. | Persist termination intent, deadlines, and any explicitly authorized forced escalation. Maintain task assignments. |
| Force Stop | Attempt bounded cancellation, then terminate the worker through the process supervisor if it will not exit. | Revoke access outside pi, track remote cancellation and uncertain effects, and require recovery reconciliation. |
| Provider switch | Apply a supported model change at a controlled boundary or restart on the replacement profile. | Enforce exclusions centrally, handle in-flight generation and late results, preserve tool effects, and select the next eligible route. |

Before interruption, NimbleNewt closes ordinary ingress for that task and durably parks pending inputs. Drain pi queues under that gate, accounting for messages racing with the request and any extension that can enqueue more. Stop automatic retry and continuation paths under controller policy. If RPC queue snapshots omit metadata needed for restoration, the original structured input must already be present in NimbleNewt's journal. Do not lose messages by clearing an in-memory queue before durable capture.

A cooperative yield needs a bridge handshake at a turn or tool boundary; a prose request to stop is not enforcement. Foreground tool cancellation may leave uncertain effects. Long-lived jobs must return external durable handles so interrupting pi does not inadvertently terminate the work Pause is meant to retain. Verify extension hooks, nested model requests, automatic notifications, and retry paths all obey the gate.

## Agent extension installation and restart

Support both requested paths: an agent can add an extension and request restart under standing delegated permission, or submit the change to its supervisor and have it installed and restarted after approval. The executor is the environment controller in both cases. This avoids needing the requesting agent to remain alive to complete its own restart.

1. Capture the package or agent-authored extension, immutable revision, dependency artifacts, purpose, requested capabilities, and affected agent. Return a durable maintenance request ID.
2. Apply existing policy. Preapproved changes proceed without another question. Other changes go to the supervisor, which may approve only within its own authority. Approval covers the concrete revision, installation code, permissions, and restart scope.
3. Build a candidate environment in isolation and run extension-load and bridge compatibility checks. Do not run unreviewed installers against the active environment. Keep the prior environment intact.
4. Suspend the affected worker without release, giving it the cleanup opportunity. If already paused or suspended, preserve that intent. If cleanup is blocked, leave the update staged rather than force a restart implicitly.
5. Save a consistent session and sidecar snapshot, switch the active environment revision, and restart under the external controller. Validate bridge availability, model routing, context references, and pending operations.
6. On success, resume only if authorized by the maintenance request and prior lifecycle state. On failure, restore the prior environment and compatible checkpoint. Report the exact result to agent and supervisor; do not loop through repeated installation attempts.

Record request, review, preparation, activation, restart, verification, and rollback durably. If the host crashes during an update, the controller must determine which revision is active and permit only one worker owner. A successful package install alone is not a successful environment update.

Use an agent-specific external configuration directory. Pi documents [`PI_CODING_AGENT_DIR` and SDK `agentDir`](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/configuration.md), supporting per-agent configuration outside repositories. Its [package documentation](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/packages.md) supports pinned npm and git sources and local packages. Avoid project-local install flags; isolate package-manager caches and writable dependencies too. Copy agent-authored local extensions into immutable approved artifacts instead of executing a mutable source path after review.

Prefer a controlled process restart for approved environment changes initially; hot reload is an optional optimization after its state transitions are tested. No restart is required for adding ordinary scripts to the existing NimbleNewt tool catalog.

## Pi Durable: subsequently selected

The official [Pi Durable overview](https://earendil.com/posts/pi-durable/) describes checkpointed tasks, persistent concurrent conversations, and a distinction between foreground and background task cancellation. It also describes replay of interrupted model requests and handling of interrupted tools. This is unusually close to NimbleNewt's recovery needs and warrants a separate compatibility evaluation.

Do not assume its extension API accepts pi CLI packages, that billion-context can be dropped in, or that its task ownership matches NimbleNewt's assignment ownership. Its documented background compaction is not evidence of billion-context-style expandable summaries. Qualify conversation continuity and lifecycle behavior against the selected Pi Durable release before claiming support. Deduplicated submission identifiers do not guarantee exactly-once external effects.

## Required feasibility checks before claiming support

- Pin a pi build and context plugin; record artifacts and versions. Restore a session containing tool history and compressed ranges after a process restart and a host reboot.
- Pause with queued inputs, a pending retry, and a completing background job. Verify zero unintended foreground continuation and no lost events.
- Interrupt a tool, lose its response, and verify that resume reports or reconciles the uncertainty instead of blindly repeating the action.
- Run Suspend, Suspend and Release, Stop, and Force Stop independently. Check ownership and readiness, including failed cleanup.
- Switch task to meeting and back without replacing task history; confirm new user decisions are applied on return.
- Add a script through the bridge and invoke it in the same session without reload.
- Attempt to edit, remove, disable, or shadow a protected tool from an agent extension or script. Deny filesystem/configuration changes, reject invalid activation, and verify that direct service calls cannot exceed the worker's authority even if its runtime is tampered with.
- Exercise self-service installation, supervisor approval and denial, failed startup rollback, and host failure midway through an update. Confirm other agents and repositories are unchanged.
- Change provider during streaming; test stale responses, unavailable backups, and smaller context limits.
- For selected Pi Durable, use its own adapter for equivalent behavioral checks and separately qualify the context-management integration. Do not apply the regular pi RPC command names above.

This historical review supports regular pi as a possible later adapter, not the selected baseline. End-to-end lifecycle support remains unproven until these tests pass; phases and MVP selection remain separate decisions.
