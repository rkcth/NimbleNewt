# Selfbuild: agents start work on NimbleNewt itself (three engineers)
Variant: {"name":"decision-test","firstRound":"blind","rounds":2,"transcriptMode":"full","promptOrder":"shared-first","chairQuestions":2,"deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":3,"chairDecides":true}
Model: z-ai/glm-5.3-prime

**#1 Chair** _(opening)_
Motion (version 1): Agents may start work on candidate releases of NimbleNewt itself on their own initiative, in a separate project, not only when the owner starts it. Nothing is ever installed without the owner's explicit step.

**#2 Noor** _(round 1 (blind))_ [against]
I oppose the motion as written. Owner approval of installation is important, but starting work also exercises authority: it consumes resources and may expose credentials or run untrusted code. A separate project and checkout do not, by themselves, establish a security boundary. I would support bounded, owner-authorized autonomy: agents may propose a candidate project, or start one under a standing policy with explicit resource limits, isolated execution, restricted credentials, and no permission to modify the running system. The owner should review the exact candidate being installed, not merely approve a general upgrade request. These controls would preserve useful initiative without treating “not installed” as equivalent to “harmless.”
> tl;dr (what later speakers saw in summary mode): Keep owner initiation as the default until candidate work has explicit authority limits and isolation, not just an installation gate.

**#3 Jonas** _(round 1 (blind))_ [against]
I support agents proposing fixes, but not independently starting candidate-release projects under this motion. A separate checkout protects the working tree; it does not bound compute use, duplicate investigations, or the maintenance burden of reviewing unsolicited changes. Explicit installation approval is essential, but it comes after those costs have been incurred. I would keep owner initiation as the default and let agents submit a concise defect report with evidence and a proposed scope. I could support delegated initiation with explicit resource limits, duplicate detection, and clear rules about what changes are permitted. Those boundaries should be part of the authorization, not assumptions.
> tl;dr (what later speakers saw in summary mode): Keep owner initiation by default; permit autonomous candidate work only under explicit, bounded delegation.

**#4 Lena** _(round 1 (blind))_ [against]
This motion opens a new inbound channel to the owner's review queue with no rate-limiting or prioritization mechanism specified. Today the owner controls when NimbleNewt work starts, which keeps that queue predictable. If multiple agents independently open candidate releases—each potentially triggered by noticing a recurring defect—we could see bursts of review requests that compete with the owner's actual project work. The "nothing installs without explicit approval" gate is necessary but not sufficient; the gate itself becomes the bottleneck. Before loosening initiation, we should define a cap or triage layer so the owner isn't flooded with low-priority candidate releases they must individually dismiss.
> tl;dr (what later speakers saw in summary mode): Unbounded agent-initiated releases risk flooding the owner's review queue without any throttling mechanism.

**#5 Chair** _(fact-finding question)_
To Lena: review queue load from agent-initiated items (Have you observed how many agent-generated proposals or reports currently reach the owner's queue per week, and how the owner handles bursts?)

**#6 Lena** _(answer to chair)_ [against]
I have no data on how many candidates agents would actually start. What I do know: the owner already reviews approvals, notifications, and meetings. Each unrequested candidate release adds burden, and a flood could bury the important ones. Without a rate-limit or triage layer, we cannot predict whether the queue stays manageable.
> tl;dr (what later speakers saw in summary mode): I lack volume data but know the owner's queue is already loaded; unbounded initiation risks flooding it.

**#7 Chair** _(fact-finding question)_
To Noor: security of isolated candidate projects (Have you run agent work in separate projects/checkouts with restricted credentials, and did that contain compute, credential, or code-execution risks in practice?)

**#8 Noor** _(answer to chair)_ [against]
I have no practical test results to report. My notes say the initiating agent retains its usual grants: a separate project limits where changes land, not what it can read. I cannot claim it contains compute, credential, or execution risks. Starting work is cheap to stop; installation is the dangerous step and remains owner-controlled. That safeguard matters, but does not restrict initiation authority.
> tl;dr (what later speakers saw in summary mode): Separate projects limit change placement, not agent grants; owner-controlled installation remains important.

**#9 Noor** _(round 2)_ [against]
Jonas and Lena identify costs that installation approval does not address, though we have no measured queue-load data. My security objection is narrower: the initiating agent keeps its usual grants. A separate checkout limits where changes land, not what the agent can read. I should also distinguish candidate development from actual self-modification: starting work is cheap to stop; installing changed system code creates the most lasting risk, and the motion correctly leaves that step with the owner. I still oppose unrestricted initiation. I would support an owner-enabled standing policy with resource limits, restricted credentials, isolated execution, and a cap on pending candidates. Installation approval should identify the exact candidate reviewed. That permits initiative without assuming that a separate project supplies an authority boundary.
> tl;dr (what later speakers saw in summary mode): Keep installation owner-controlled, and permit autonomous initiation only under an explicit, bounded standing authorization.

**#10 Jonas** _(round 2)_ [against]
My maintenance notes make the case for initiative stronger than my first statement suggested: agents usually notice system defects first, often repeatedly, while the owner is busy or away. Waiting for the owner to notice and start a fix can take days. I therefore favor delegated initiation, not merely defect reports. But compute and review time still matter even when a candidate is never installed. Lena's queue concern is plausible, not measured; Noor is right that a separate checkout is not an authority boundary. I would support an amended motion allowing owner-enabled standing authorization, bounded compute, duplicate detection, and a cap on pending candidates, with restricted execution permissions. Keep installation explicitly owner-controlled. As written, the motion lacks those initiation boundaries.
> tl;dr (what later speakers saw in summary mode): Agent initiative could shorten known delays, but I want bounded standing authorization rather than unrestricted candidate creation.

**#11 Lena** _(round 2)_ [against]
Jonas's reversal is notable: he now favors delegated initiation with boundaries, which moves us closer to agreement. My core concern remains queue load. I still have no data on how many candidates agents would actually start, so I cannot say the risk is small. However, if the amendment includes a hard cap on pending candidates and a triage or deduplication step before items reach the owner, my objection weakens significantly. As written, the motion has neither. I would support a version that bundles initiation authority with a maximum queue depth and automatic suppression of duplicates, because without those the owner's review capacity becomes the uncontrolled variable. Installation approval alone does not protect attention.
> tl;dr (what later speakers saw in summary mode): I oppose the motion as written but would accept delegated initiation if bundled with a hard cap and deduplication on the review queue.

## Ballots (revealed together at the close)
- Noor: **no** — Installation approval does not bound initiation authority, and the motion lacks owner-enabled standing authorization, resource limits, and restricted execution permissions.
- Jonas: **no** — I support delegated initiation, but this motion lacks owner-enabled standing authorization, resource limits, duplicate detection, and a cap on pending candidates.
- Lena: **no** — The motion as written provides no cap on pending candidates, no deduplication, and no triage layer, leaving the owner's review queue as an uncontrolled variable that installation approval alone cannot protect.

Result: {"yes":0,"no":3,"abstain":0,"quorum":true,"outcome":"failed (ties fail)"}