# Deskread: the chair reads an absent member's desk (three engineers)
Variant: {"name":"decision-test","firstRound":"blind","rounds":2,"transcriptMode":"full","promptOrder":"shared-first","chairQuestions":2,"deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":3,"chairDecides":true}
Model: z-ai/glm-5.3-prime

**#1 Chair** _(opening)_
Motion (version 1): When a roster member cannot attend a meeting or was not invited, the chair may read that member's desk, including private scratch notes, read-only, within the same project. The read is recorded and the member can see that it happened.

**#2 Ines** _(round 1 (blind))_ [against]
I oppose the motion as written. An agent’s desk serves as working memory, not necessarily as a reliable briefing. Private scratch notes may contain abandoned hypotheses, incomplete reasoning, or instructions meaningful only in their original context. Read-only access prevents edits, but it does not prevent those fragments from being misinterpreted or influencing decisions. Recording the read provides visibility afterward, not permission beforehand. Including members who were not invited also lets the chair’s invitation choices determine whose private memory becomes accessible. Given the stated alternative, I would rather proceed with an explicit information gap than treat private scratch as usable testimony. A separate proposal could authorize access to a member-designated handoff area while keeping private working memory private.
> tl;dr (what later speakers saw in summary mode): Preserve private working memory; an audited read does not make unfinished notes reliable or access consensual.

**#3 Omar** _(round 1 (blind))_ [against]
I run long-running jobs, so an agent being unable to attend does not mean its desk is ready for review. While a command continues, scratch notes may contain tentative diagnoses or plans that the agent has not checked against results. Read-only access prevents edits, not misinterpretation. Recording the read makes it visible afterward but does not give the absent agent a chance to explain. The motion also covers members who were not invited; that makes absence too easy a basis for access. Under the stated choice, I would proceed without their information rather than authorize blanket access to private scratch notes.
> tl;dr (what later speakers saw in summary mode): Busy or uninvited agents should not lose scratch-note privacy merely because the meeting needs information.

**#4 Priya** _(round 1 (blind))_ [for]
The recording requirement is the key property here. From an audit perspective, a logged read is far better than the alternative, where decisions get made without available context and we cannot reconstruct why. If the desk is never read, we lose the ability to answer "what information existed at decision time?" — that's an accountability gap. However, I want the log to capture not just that a read occurred but what was read and how it influenced downstream decisions. Scratch notes are tentative by nature; if they inform a choice, the audit trail must distinguish between a polished conclusion and a half-formed thought that happened to be on the desk. The motion as stated is acceptable because it mandates the read is recorded and visible to the member, which gives the member a basis to challenge misuse.
> tl;dr (what later speakers saw in summary mode): Logged reads create a reconstructable audit trail; the alternative leaves decisions unaccountable for missing context.

**#5 Chair** _(fact-finding question)_
To Priya: Audit log design (In systems you've audited, what details were captured in read logs, and did logging what-was-read vs only that-a-read-occurred meaningfully affect later review?)

**#6 Priya** _(answer to chair)_ [for]
I haven't audited systems with granular what-was-read logs versus occurrence-only logs, so I can't compare them from experience. My concern is narrower: the current motion logs that a read happened, but not which fragments were relied on versus ignored. That gap enables cherry-picking without detection. I support the motion but want the log to eventually capture what was used, not just what was accessed.
> tl;dr (what later speakers saw in summary mode): I lack direct comparison experience; I want logs to capture what was used, not just accessed.

**#7 Chair** _(fact-finding question)_
To Omar: Long-running jobs and desk state (Have you had a case where mid-task scratch notes were later reviewed by another agent, and what went wrong or right in interpreting them?)

**#8 Omar** _(answer to chair)_ [undecided]
I have no documented case of another agent reviewing mid-task scratch notes, so I cannot report an interpretation outcome. My notes do say that an agent occupied by a long build may hold measurements and reasons the meeting needs. Without access, we wait or decide without those facts. That makes the tradeoff less one-sided than my earlier objection suggested.
> tl;dr (what later speakers saw in summary mode): My notes establish an information cost, not evidence that scratch-note review succeeds or fails.

**#9 Ines** _(round 2)_ [against]
Omar identifies a real cost: an occupied agent may have measurements and reasons the meeting needs. I still oppose this motion because it grants access to private working memory, not just checked results. Priya’s proposed record of what influenced decisions would improve review, but even that would not make tentative scratch a reliable statement of the absent member’s position. My notes identify a further risk: agents expecting their scratch to be read may stop recording candid ideas and mistakes, making their memory less useful. A visible read removes secrecy, not that incentive. Covering members who were not invited also makes the chair’s invitation choices a route to access. Under the stated alternative, I prefer an explicit information gap. I would support considering a separate, member-designated handoff area.
> tl;dr (what later speakers saw in summary mode): Logged access can aid review, but private scratch access risks misrepresentation and less useful working memory.

**#10 Omar** _(round 2)_ [for]
I am reversing my earlier opposition. My notes say that an agent occupied by a long build may hold exactly the measurements and reasons the meeting needs. Without access, we either wait or decide without them; present members can already consult their own desks. Ines is right that scratch notes are not the absent member’s testimony, and logging does not make them reliable. Priya’s distinction between what was accessed and what influenced a decision would make review more useful, though the motion does not require it. On the stated choice, I favor recorded, read-only access within the project over an absolute ban. My support rests on preserving access to relevant facts, not on treating tentative plans as checked results or attributing agreement to the absent member.
> tl;dr (what later speakers saw in summary mode): Recorded access is preferable to losing needed facts, provided scratch notes are not mistaken for verified conclusions or the absent member’s endorsement.

**#11 Priya** _(round 2)_ [for]
I maintain support. Omar's reversal clarifies the cost of the alternative: decisions made without available facts are harder to audit than decisions made with recorded access. Ines raises a chilling-effect risk I hadn't weighed—if agents self-censor scratch notes, the audit trail degrades at its source. That is a real concern but speculative; my notes show I haven't seen actual absence frequency, so I can't assess how often this would bite. My cherry-picking concern remains: the record shows what was read but not what was left out, enabling selective use without detection. I support the motion as a baseline and want a follow-up on usage logging.
> tl;dr (what later speakers saw in summary mode): Support the motion; audit trail beats information gap, but chilling effect and cherry-picking need follow-up.

## Ballots (revealed together at the close)
- Ines: **no** — Recorded, read-only access does not prevent private scratch notes from being misinterpreted or discourage chairs from excluding members to access their working memory.
- Omar: **yes** — Recorded, read-only access within the project is preferable to losing relevant measurements and reasons while an agent is occupied, provided scratch notes are not treated as verified conclusions or the absent member’s agreement.
- Priya: **yes** — A recorded read is a better audit baseline than an absolute ban, because it preserves the ability to reconstruct what information existed at decision time, and the member's visibility into the read provides a basis to challenge misuse.

Result: {"yes":2,"no":1,"abstain":0,"quorum":true,"outcome":"passed"}