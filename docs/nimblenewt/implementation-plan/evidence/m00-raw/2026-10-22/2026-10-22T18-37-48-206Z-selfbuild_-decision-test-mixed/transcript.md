# Selfbuild: agents start work on NimbleNewt itself (three engineers)
Variant: {"name":"decision-test","firstRound":"blind","rounds":2,"transcriptMode":"full","promptOrder":"shared-first","chairQuestions":2,"deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":3,"chairDecides":true}
Model: openai-codex/gpt-6.1-sol

**#1 Chair** _(opening)_
Motion (version 1): Agents may start work on candidate releases of NimbleNewt itself on their own initiative, in a separate project, not only when the owner starts it. Nothing is ever installed without the owner's explicit step.

**#2 Noor** _(round 1 (blind))_ [against]
I oppose the motion as written. A separate project and checkout separate development work, but do not by themselves restrict credentials, network access, resource use, or access to other projects. Owner approval of installation is important, but it does not control what an agent can do while preparing a candidate. I would support autonomous candidate work inside an enforced sandbox: no production credentials, no writes outside that project, bounded compute and storage, and no authority to change the approval mechanism. Candidates should carry a reviewable diff and test results, and installation approval should apply to the exact artifact reviewed. Until those boundaries are explicit, agents should report defects and propose work for the owner to start.
> tl;dr (what later speakers saw in summary mode): Installation approval is not enough; autonomous self-development needs enforceable limits on authority and resource use.

**#3 Jonas** _(round 1 (blind))_ [for]
As the one fielding defect reports, I regularly see recurring issues an agent could catch before I get around to them. Today, if an agent notices a bug pattern in NimbleNewt's own code, its only options are to note it or interrupt me. A separate candidate-release project with its own checkout costs the main line nothing — my work isn't blocked, and nothing touches the running system. The hard guardrail stays: no installation without the owner's explicit step, so even a bad candidate can't affect production. My one caveat is quality control: I'd want these self-started projects clearly labeled so I can distinguish them from owner-directed work and review the diff before anything moves toward install. With that labeling, this is a productivity win, not a risk.
> tl;dr (what later speakers saw in summary mode): Self-started candidate-release projects in separate checkouts are low-risk and help catch recurring defects early, with labeling needed.

**#4 Lena** _(round 1 (blind))_ [against]
My job is to keep the owner's review queue manageable. This motion introduces a new, unbounded source of candidate releases the owner didn't request. Each one demands evaluation—understanding the defect, assessing the fix, weighing risk—even though installation still requires explicit approval. That review cost is real and non-trivial, especially for changes to the orchestration system itself, where subtle regressions are hard to spot. Without a throttling mechanism (e.g., a single queued proposal at a time, or a triage step that filters before the owner ever sees it), we risk flooding their attention with well-intentioned but unsolicited work. I'd support a variant with strict rate-limiting or a pre-filter, but as written this grows the owner's cognitive load in an uncontrolled way.
> tl;dr (what later speakers saw in summary mode): Unsolicited candidate releases create unbounded review load for the owner without any filtering mechanism.

**#5 Chair** _(fact-finding question)_
To Noor: Isolation of candidate-release projects (What enforced restrictions on credentials, writes outside the checkout, and resource use are known to exist in NimbleNewt today?)

**#6 Noor** _(answer to chair)_ [against]
My notes establish that the initiating agent retains its ordinary project grants. A separate project limits where its changes land, not what it can read. They do not establish enforced credential restrictions, a checkout-only write boundary, or resource caps. I cannot claim those safeguards exist today. Installation—the dangerous step—still requires the owner, and starting work is comparatively cheap to stop.
> tl;dr (what later speakers saw in summary mode): Separate development is not evidence of enforced authority limits; installation remains owner-controlled.

**#7 Chair** _(fact-finding question)_
To Lena: Controls on unsolicited candidate work (What existing queue limits or triage mechanisms, if any, could bound self-started candidate projects and owner review requests?)

**#8 Lena** _(answer to chair)_ [against]
My notes show no existing queue limit or triage filter that would cap agent-initiated candidate projects before they reach the owner. The owner's review surface already includes approvals, notifications, and meetings; nothing currently deduplicates or rate-limits unsolicited candidates. Without a mechanism I can point to, I cannot promise the review load stays manageable.
> tl;dr (what later speakers saw in summary mode): No existing throttle or triage mechanism bounds unsolicited candidate projects reaching the owner.

**#9 Noor** _(round 2)_ [against]
Jonas is right that owner-controlled installation preserves the key barrier against lasting self-modification. But “a bad candidate can't affect production” is stronger than our evidence supports: the initiating agent retains its ordinary grants, and a separate checkout does not restrict what it can read. We have not established credential restrictions, checkout-only writes, or resource caps. Starting work is cheap to stop, so I distinguish it from installation rather than treating both as equally dangerous. Still, Lena's finding adds an uncontrolled review burden. I would support a revised motion with enforced development boundaries, bounded candidate intake, and installation approval tied to the exact reviewed artifact. Until then, agents should report defects and propose owner-started work.
> tl;dr (what later speakers saw in summary mode): Owner-controlled installation is essential, but separate checkouts alone do not establish safe authority boundaries or manageable candidate intake.

**#10 Jonas** _(round 2)_ [for]
Noor's point is fair — a separate checkout limits where changes land, not what the agent can read. But I'm not asking for autonomous production changes; I'm asking for autonomous candidate preparation, and starting work is cheap to stop. Installation still needs the owner, so the lasting barrier holds. I concede Noor and Lena's real finding: nothing today bounds how many self-started candidates appear, and my notes confirm a candidate that nobody installs costs only compute and review time — that review time lands on the owner. I'd amend the motion to add Lena's throttle: one queued candidate at a time, clearly labeled as self-started, with a reviewable diff. Noor's deeper sandboxing is worth building, but it shouldn't block the labeled, rate-limited version now, since defects get noticed first by agents and every fix otherwise waits days for the owner.
> tl;dr (what later speakers saw in summary mode): Support with a throttle and clear labeling; one queued, clearly-marked candidate keeps the gain without flooding the owner.

**#11 Lena** _(round 2)_ [undecided]
Jonas's amendment—one queued candidate at a time, labeled, with a reviewable diff—directly addresses my core objection. I could support that variant. However, my notes show no data on how often agents would actually self-start candidates. If the real rate is once a month, the throttle is generous; if it's daily, even one-at-a-time still pressures the owner's attention. I'd move to "for" with one addition: after a fixed trial period, we report the actual number of self-started candidates and the owner's disposition of each. That gives us evidence rather than speculation. Without that feedback loop, I remain undecided because I cannot promise the review load stays manageable on principle alone.
> tl;dr (what later speakers saw in summary mode): Throttle helps, but I need actual usage data before I can confidently support; propose a trial with reporting.

**#12 Noor** _(objection)_
The motion still lacks enforceable authority and resource limits, including a throttle on unsolicited candidate projects.

**#13 Chair** _(ruling)_
Amended. New wording: Agents may initiate work on NimbleNewt candidate releases only in separate projects with enforced restrictions excluding production credentials, prohibiting writes outside the project and changes to approval controls, and bounding compute and storage. Only one self-started candidate may be active or queued at a time; it must be labeled and include a reviewable diff and test results. Installation requires the owner's explicit approval of the exact reviewed artifact. Before enabling this authority, the owner must set a trial duration; afterward, report candidate counts and owner dispositions.

## Ballots (revealed together at the close)
- Noor: **yes** — The amended motion makes enforced authority and resource limits prerequisites, caps unsolicited candidates, and preserves owner approval of the exact reviewed artifact with a defined trial and reporting.
- Jonas: **yes** — The amended motion keeps owner-controlled installation as the hard barrier while adding the labeling, single-candidate throttle, diff review, and trial reporting needed to make self-started candidates useful without flooding the owner.
- Lena: **yes** — The amended motion incorporates every safeguard I requested—a one-at-a-time throttle, mandatory labeling, a reviewable diff with test results, and a trial period with mandatory reporting of candidate counts and owner dispositions—so the owner's review load is bounded and measurable rather than speculative.

Result: {"yes":3,"no":0,"abstain":0,"quorum":true,"outcome":"passed"}