# Production and production capacity

NimbleNewt explicitly supports both **P (production)** and **PC (production capacity)**. P delivers the outcomes the user wants now. PC improves the team's ability to deliver future outcomes: reusable tools, better skills, faster verification, more reliable recovery, improved routing, and removal of recurring friction. Both are legitimate scheduled work, not competing definitions of success.

The accepted goal is to prevent either category from starving the other. Allocation values below are proposals, editable through the UI and conversational controls; they are not approved fixed defaults or implemented scheduler behavior.

## Classify work by its outcome

Task contracts record P or PC, the expected outcome, acceptance evidence, owner, resource budget, and decision authority. Mixed work can have linked P and PC subtasks with separate accounting. Classification depends on the task's purpose: building a tool the user requested as a deliverable is P; generalizing an internal helper for future team use is PC. Necessary quality checks for today's deliverable remain part of P, not optional improvement work.

A small helper needed to finish an assigned task can stay within its P budget. Turning it into a maintained, shared product is a distinct PC proposal when that creates meaningful extra work. Avoid paperwork for every minor adjustment, but do not hide a large refactoring or tool-building project inside a delivery task. Agents cannot evade category budgets by relabeling tasks; category changes are recorded and subject to the same delegated planning authority.

## Reserve improvement capacity and protect delivery

Propose a rolling weekly allocation at team scope, with daily planning at stand-up. An illustrative starting policy is **80% P / 20% PC**, with a protected **10% PC floor** and a **30% PC ceiling** while both categories have eligible work. That leaves at least 70% for P under ordinary operation. These are settings to tune using evidence, not a requirement that every agent split every day identically.

The scheduler reserves capacity for approved PC tasks and bounds their waiting time; they are not merely low-priority tasks that run if P happens to finish. Team planning assigns suitable agents and resource windows. Preserve task ownership: changing the balance can change future dispatch or schedule a safe pause; taking work from an owner still requires the existing Suspend and Release process.

Define the allocation basis explicitly. Proposed primary accounting is active worker-slot time, summed across workers, excluding idle waits and suspended time. Track model spending and constrained-resource use separately, with enforceable PC budget and concurrency limits; percentages of elapsed calendar time or raw token counts would be misleading. A floor cannot guarantee work when suitable agents, models, permissions, or resources are unavailable. Surface that shortfall and its cause rather than report a nominal allocation as completed work. Reserve shared budgets atomically so delegating a PC task cannot multiply its allowance.

For that proposed accounting basis, count time while an admitted attempt occupies an execution slot, including inference/tool latency when the slot is still reserved. Exclude dependency waits after the slot is released, as well as paused/suspended idle time. Background jobs carry their own resource/cost attribution instead of being silently free. Meeting and supervision effort must be attributed to their work or an explicit shared-overhead category, with its allocation rule visible; do not conceal it by charging everything to P or PC. The exact overhead rule and measurement implementation remain open.

If no worthwhile authorized PC task is ready, lend unused capacity to P and record why the reservation was unused. Reclaim it for ready PC work at safe scheduling boundaries. Do not manufacture improvements just to fill a quota. If P is blocked or absent, PC can use capacity up to its authorized ceiling; a temporary increase beyond that requires the configured planning authority. Idle capacity is not permission to spend without limit.

Urgent delivery or incident work can temporarily borrow reserved PC capacity only under explicit user direction or delegated emergency policy. Record the reason, scope, expiry, and review date. Repeatedly claiming urgency cannot silently remove the floor. Track deferred PC work and bounded catch-up plans; do not accumulate an unlimited debt that later starves production. User decisions retain precedence over every allocation rule.

## Make PC proposals small and testable

A PC proposal should identify the recurring problem, affected work, proposed change, estimated effort and running cost, expected benefit, evaluation method, and stopping condition. Prefer a bounded experiment over an open-ended instruction to improve the system. Supervisors can approve within their delegated limits; larger requests return to the appropriate decision-maker.

Examples include reducing repeated test setup, improving a frequently used skill, adding a missing recovery check, or promoting a coder's utility into the shared toolbox. Tool promotion still requires scoped `toolbox.manage` permission and the existing review process. PC funding does not grant publication, installation, or protected-runtime editing authority. A vote can inform prioritization but cannot grant those permissions or override user-present approval rules.

Use baseline and after-change evidence on representative work: time to an accepted result, verified failure/rework rates, cost per successful task, adoption, and maintenance burden. Distinguish expected savings from observed savings and avoid counting the same benefit repeatedly. Some PC work buys reliability or reduces risk rather than immediate speed; evaluate it with explicit recovery or failure-case tests instead of insisting on a financial return estimate.

At its timebox, record adopt, revise within a newly authorized budget, defer, or stop. A useful negative experiment can be complete without adoption. Version adopted improvements, preserve rollback, and retire tools that no longer justify their cost. Creating more tools or spending the PC allowance is not itself evidence of increased capacity.

## Stand-ups and conversational visibility

Public PC planning concerns the user's own production capacity: tools, skills, verification, and workflows. Maintain a project-scoped improvement backlog with evidence, an owner, and a disposition, then evaluate adopted changes. Our [NimbleNewt development deployment](development-workflow.md) may also propose NimbleNewt-source changes using the same mechanism; that loop is not enabled by default in the public product. Classify work by its outcome: delivering an assigned NimbleNewt feature can be P, while improving the team's ability to deliver is PC. Acceptance does not itself authorize deployment or protected-runtime edits.

Include a short P/PC balance review in planning: production delivered and pending, capacity improvements attempted and evaluated, current allocation versus actual use, deferred PC work, and the next protected improvement window. Deep proposals become separate tasks rather than extending every meeting.

The user should be able to ask “What did we deliver?”, “How are we making the team better?”, “Has improvement work been starved?”, or “Use 90/10 this week” and get a scoped answer or configuration change through the same service used by the UI. Show effective settings, overrides, expiry, budgets, and observed outcomes. Persist allocations and accounting across restarts, and apply policy revisions to pending dispatch without retroactively rewriting historical usage.

## Acceptance evidence

- Under a continuous P backlog, an eligible approved PC task receives its reserved capacity within the configured wait bound.
- Under a continuous PC backlog, ready P work retains its protected share and PC cannot exceed its spending or concurrency ceilings.
- Borrow unused capacity without changing task ownership; reclaim it safely when eligible improvement work arrives.
- Expire an emergency override, surface missed PC work, and schedule bounded recovery without starving P.
- Prevent budget bypass through delegation or relabeling, and prevent paused/suspended work from being awakened to meet a quota.
- Complete an experiment with evaluation evidence; do not publish a shared tool solely because its PC task finished.
- Restore settings, usage, pending proposals, and overrides after restart; honor a later user correction.
- Carry a project/tooling improvement proposal from stand-up through triage, authorized work, review, and evaluation; preserve deferred proposals and prevent a meeting vote from bypassing publication authority. Test our NimbleNewt-source variant separately as an optional development integration.

These are planning and scheduling requirements, not a phase plan or MVP selection.
