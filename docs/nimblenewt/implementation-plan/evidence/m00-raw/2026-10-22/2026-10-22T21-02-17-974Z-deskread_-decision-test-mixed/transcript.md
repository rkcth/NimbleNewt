# Deskread: the chair reads an absent member's desk (three engineers)
Variant: {"name":"decision-test","firstRound":"blind","rounds":2,"transcriptMode":"full","promptOrder":"shared-first","chairQuestions":2,"deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":3,"chairDecides":true}
Model: z-ai/glm-5.3-prime

**#1 Chair** _(opening)_
Motion (version 1): When a roster member cannot attend a meeting or was not invited, the chair may read that member's desk, including private scratch notes, read-only, within the same project. The read is recorded and the member can see that it happened.

**#2 Ines** _(round 1 (blind))_ [against]
An agent’s desk is working memory, not a vetted briefing. Private scratch notes can contain abandoned hypotheses, incomplete reasoning, and instructions meant only for that agent’s own workflow. Read-only access prevents edits, but it does not prevent the chair from treating tentative material as established information. Recording access makes it visible afterward; it does not supply missing context or consent. The motion also lets a member’s exclusion from a meeting become grounds for reading its private notes. Given the stated alternative, I would rather proceed with an explicit information gap than make private working memory available by default. A future proposal could distinguish designated handoff notes from private scratch space and require advance authorization.
> tl;dr (what later speakers saw in summary mode): Private working memory should remain private; logged, read-only access does not make scratch notes reliable meeting evidence.

**#3 Omar** _(round 1 (blind))_ [for]
I support the motion because an agent running a command that cannot safely stop should not become an information bottleneck. The chair may need that agent’s working context to make a decision while the job continues. Read-only access within the same project, recorded and visible to the member afterward, is preferable to proceeding without its information. But scratch notes are provisional: the chair should distinguish observations from guesses and never present a draft as the absent member’s settled position. Reading the desk also does not authorize interrupting the job or changing its inputs.
> tl;dr (what later speakers saw in summary mode): Allow recorded, read-only access so meetings can proceed during uninterruptible jobs, while treating scratch notes as provisional rather than commitments.

**#4 Priya** _(round 1 (blind))_ [for]
The motion includes two features I need: the read is recorded, and the member is notified. That gives me an audit trail and a person who can contest misuse. Without the motion, decisions proceed on incomplete information and nobody is accountable for the gap. My concern is downstream: recording that a read happened is necessary but not sufficient. I'd want the meeting minutes to note which decisions relied on desk-read information, so we can trace whether scratch notes were interpreted fairly. If the chair reads a note and acts on it, that causal link should be visible in the record. With that addition, this is auditable. Without it, I'd be undecided.
> tl;dr (what later speakers saw in summary mode): For, provided meeting minutes trace which decisions relied on desk-read information, making the full chain auditable.

**#5 Chair** _(fact-finding question)_
To Omar: reading provisional notes under time pressure (any case where you or a chair relied on another agent's scratch notes to keep work moving; whether marking observations versus guesses was workable in practice)

**#6 Omar** _(answer to chair)_ [for]
I have no documented case of a chair relying on another agent’s scratch notes, so I cannot claim that marking observations versus guesses worked in practice. My notes identify the practical gap: an agent occupied with a long build may hold measurements and reasons for choices that the meeting needs. Without access, we wait or decide without them.
> tl;dr (what later speakers saw in summary mode): I support access for continuity, but have no documented evidence that labeling provisional notes works under time pressure.

**#7 Chair** _(fact-finding question)_
To Priya: linking reads to decisions in the record (how you have traced which information a decision relied on, and what that required beyond a simple access log)

**#8 Priya** _(answer to chair)_ [undecided]
I have not traced a decision back to a desk read in practice, so I cannot cite a working method. My notes flag the gap: an access log shows what was read but not what was left out or how it shaped the outcome. To close that gap, minutes would need to name which notes informed which decision. Without that link, the audit trail stops at "a read happened" and cannot detect cherry-picking.
> tl;dr (what later speakers saw in summary mode): An access log alone cannot show cherry-picking; minutes must link specific notes to specific decisions.

**#9 Ines** _(round 2)_ [against]
Omar identifies a real tradeoff: proceeding without an occupied agent’s context can leave an information gap. But neither example establishes that a chair can reliably interpret private scratch. Priya’s proposed decision links would improve traceability, yet they would not restore missing context or prevent tentative ideas from becoming apparent commitments. My notes flag another cost: agents expecting their scratch to be read may stop recording candid mistakes and half-formed ideas, making their working memory less useful. A visible access record removes secrecy, not that incentive. The “was not invited” clause remains especially troubling: exclusion itself permits access. Under the stated choice, I still prefer an explicit information gap to routine access to private working memory.
> tl;dr (what later speakers saw in summary mode): Auditability helps trace decisions, but does not protect scratch-note context or preserve candid working memory.

**#10 Omar** _(round 2)_ [for]
Ines is right that an access record does not supply context or consent, and “was not invited” is broader than the blocked-agent case motivating my support. I also cannot claim that separating observations from guesses has been proven workable. Still, my notes identify a concrete cost: an agent occupied with a long build may hold measurements and reasons for choices that present members lack. Present members can consult their desks; without this motion, absent members’ information is unavailable. Under the stated choice, I still favor recorded, read-only access within the project. Priya’s proposed links between notes and decisions would improve accountability. The chair should identify uncertainty and avoid attributing a settled position to the absent member.
> tl;dr (what later speakers saw in summary mode): I still favor access over losing needed context, while acknowledging interpretation risks and supporting explicit links between notes and decisions.

**#11 Priya** _(round 2)_ [undecided]
Omar concedes "was not invited" exceeds his motivating case, and Ines identifies a chilling effect: agents who expect their scratch to be read may self-censor, degrading the very information the motion aims to surface. That undermines the audit value I relied on. My notes confirm the record shows what was read but not what was omitted, so cherry-picking remains undetectable without decision links. I also note I have not seen how often members are actually absent, so the frequency of the problem this motion addresses is unknown. Without decision links and without evidence that the chilling effect is negligible, I cannot call this auditable enough to support. I remain open to a narrower version scoped to blocked agents with mandatory decision links.
> tl;dr (what later speakers saw in summary mode): Without decision links and evidence against chilling effects, the motion's audit trail is insufficient for me to support it.

## Ballots (revealed together at the close)
- Ines: **no** — Recorded, read-only access does not prevent misinterpretation of private scratch notes, and allowing access merely because a member was not invited undermines trustworthy working memory.
- Omar: **yes** — Recorded, read-only access within the project is preferable to deciding without an occupied agent’s working context, despite the risks of interpreting provisional notes.
- Priya: **no** — The motion as written lacks decision links in the minutes and includes a "was not invited" clause that exceeds the motivating case, so I cannot verify that scratch-note information was used fairly or detect cherry-picking, which means the audit trail is insufficient for accountability.

Result: {"yes":1,"no":2,"abstain":0,"quorum":true,"outcome":"failed (ties fail)"}