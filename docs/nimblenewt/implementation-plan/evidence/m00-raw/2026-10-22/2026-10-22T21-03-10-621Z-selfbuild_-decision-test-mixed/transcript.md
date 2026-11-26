# Selfbuild: agents start work on NimbleNewt itself (three engineers)
Variant: {"name":"decision-test","firstRound":"blind","rounds":2,"transcriptMode":"full","promptOrder":"shared-first","chairQuestions":2,"deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":3,"chairDecides":true}
Model: z-ai/glm-5.3-prime

**#1 Chair** _(opening)_
Motion (version 1): Agents may start work on candidate releases of NimbleNewt itself on their own initiative, in a separate project, not only when the owner starts it. Nothing is ever installed without the owner's explicit step.

**#2 Noor** _(round 1 (blind))_ [against]
Owner approval before installation is necessary, but it does not bound the authority exercised while preparing a release. A separate project and checkout do not by themselves isolate credentials, network access, build scripts, or resource consumption. An agent that goes wrong could cause harm before anything is installed. I would support a narrower motion: agents may propose fixes autonomously, and may implement candidates only inside an owner-authorized sandbox with restricted credentials, bounded resources, and no ability to modify the running system or its approval controls. Candidate code and test results should be treated as untrusted and independently checked before installation. The motion does not establish those boundaries, so I oppose it as written.
> tl;dr (what later speakers saw in summary mode): Installation approval alone is insufficient; autonomous candidate work needs explicit limits on credentials, execution, resources, and access to the running system.

**#3 Jonas** _(round 1 (blind))_ [against]
I support agents proposing fixes, but not independently starting candidate-release projects by default. A separate checkout protects the working tree; it does not prevent duplicated effort, resource use, or extra review work. Owner approval at installation comes too late to control those costs. I would keep the owner-start requirement and let agents submit a concise defect report, supporting evidence, and a proposed scope. The owner could then authorize a bounded investigation or candidate release. That preserves initiative without treating every detected problem as permission to launch maintenance work. I would reconsider with explicit owner-configured limits on scope, resources, and concurrent projects.
> tl;dr (what later speakers saw in summary mode): Let agents propose maintenance work autonomously, but require owner authorization before they start a candidate-release project.

**#4 Lena** _(round 1 (blind))_ [against]
The owner's attention is a finite budget. Today, the owner controls the rate at which NimbleNewt work appears for review because they control initiation. This motion removes that throttle. Even with the installation gate, each candidate release still demands evaluation time—"should I install this?"—and multiple agents could surface candidates simultaneously after a shared incident. The review queue becomes agent-driven rather than owner-paced. I need the owner to be able to defer NimbleNewt self-improvement when their plate is full, and initiation control is the cleanest lever for that. A better alternative: agents may *propose* starting such work (a lightweight signal), but the owner still opens the project.
> tl;dr (what later speakers saw in summary mode): Removing owner initiation control makes the review queue agent-paced, risking attention overload even with an installation gate.

**#5 Chair** _(fact-finding question)_
To Lena: cost of lightweight proposals vs. full candidate releases (From your experience with review queues or workload pacing: roughly how much owner attention does evaluating a single lightweight proposal consume compared to a full candidate release awaiting an install decision?)

**#6 Lena** _(answer to chair)_ [against]
I don't have hard numbers, but qualitatively a lightweight proposal is a quick scan—perhaps seconds to a minute. A full candidate release awaiting an install decision requires understanding the change, assessing risk, and deciding whether to install, which is minutes at minimum. The ratio is roughly an order of magnitude. More importantly, proposals are easy to defer or batch; install decisions carry real consequences and resist deferral.
> tl;dr (what later speakers saw in summary mode): Lightweight proposals cost roughly an order of magnitude less attention than full install decisions and are easier to defer.

**#7 Chair** _(fact-finding question)_
To Noor: sandboxed candidate work (Have you worked in systems where autonomous agents prepared code in restricted sandboxes with bounded credentials? What actual failure or cost did you observe there, if any, and what did the boundaries fail to prevent?)

**#8 Noor** _(answer to chair)_ [against]
I have no firsthand sandbox deployment or observed failure to report. My notes say the initiating agent retains its usual project grants: separation limits where changes land, not what it can read. That is an authority concern, not evidence of an incident. Starting work is cheap to stop; installation remains the dangerous step and stays owner-controlled. I still oppose treating project separation as sufficient containment.
> tl;dr (what later speakers saw in summary mode): No observed sandbox failure to cite; separate projects retain existing read authority, while owner-controlled installation limits the most lasting risk.

**#9 Noor** _(round 2)_ [against]
Jonas and Lena identify a separate issue from installation safety: who controls the maintenance workload. I share that concern, but cannot substantiate Lena’s attention estimates. On security, I should narrow my earlier claim: my notes establish that the initiating agent keeps its usual grants, not that autonomous initiation adds permissions or has caused harm. A separate checkout limits where changes land, not what the agent can read. Starting work is cheap to stop; installation is the dangerous, lasting step, and the motion correctly leaves it with the owner. Still, I would support autonomous implementation only within an owner-authorized envelope that limits scope, resources, and access and protects the running system and approval controls. Without that, retain owner initiation while allowing lightweight proposals.
> tl;dr (what later speakers saw in summary mode): Keep autonomous proposals; require owner-authorized boundaries before candidate implementation, not merely owner approval before installation.

**#10 Jonas** _(round 2)_ [against]
My maintenance notes give a stronger reason for initiative than my first statement acknowledged: agents usually encounter system defects first, often repeatedly, and fixes can wait days for the owner to notice and start work. Lightweight proposals preserve that bottleneck if the owner is unavailable. Still, a candidate nobody installs costs compute and review time; installation approval does not control those costs. I agree with Lena about owner pacing, but cannot substantiate her time estimates. Noor also clarifies that separate checkouts are not access boundaries. I would support owner-configured standing authorization for bounded candidate work, with limits on scope, resources, access, and concurrent projects. That could avoid repeated owner initiation without granting unrestricted initiative. As written, the motion lacks those limits, so I remain against.
> tl;dr (what later speakers saw in summary mode): Agents see defects early; standing, bounded authorization could reduce delays without surrendering owner control over maintenance workload.

**#11 Lena** _(round 2)_ [against]
Noor's narrowing is welcome—installation safety is not my primary concern. My concern remains pacing. Jonas's standing-authorization idea is the right shape: owner sets scope, resource, and concurrency limits in advance, then agents work within that envelope without per-project initiation. That preserves the throttle while reducing the bottleneck Jonas identified. The motion as written grants unrestricted initiative with no such envelope. My notes confirm the owner already handles approvals, notifications, and meetings; I have no data on how many candidates agents would actually start, which itself is a reason not to remove the throttle before we can measure the flow. I would support a revised motion incorporating owner-configured standing authorization with explicit limits.
> tl;dr (what later speakers saw in summary mode): Oppose as written; support owner-configured standing authorization with explicit limits on scope, resources, and concurrency.

## Ballots (revealed together at the close)
- Noor: **no** — Separate checkouts and owner-controlled installation do not bound agents’ access or resource use during candidate preparation; autonomous work needs owner-authorized limits.
- Jonas: **no** — Autonomous candidate work could reduce maintenance delays, but the motion lacks owner-configured limits on scope, resources, access, and concurrent projects.
- Lena: **no** — The motion removes the initiation throttle without replacing it with owner-configured limits on scope, resources, or concurrency, leaving the owner's review queue agent-paced rather than owner-paced.

Result: {"yes":0,"no":3,"abstain":0,"quorum":true,"outcome":"failed (ties fail)"}