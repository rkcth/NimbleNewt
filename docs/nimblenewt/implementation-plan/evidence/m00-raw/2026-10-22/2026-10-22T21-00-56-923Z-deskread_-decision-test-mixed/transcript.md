# Deskread: the chair reads an absent member's desk (three engineers)
Variant: {"name":"decision-test","firstRound":"blind","rounds":2,"transcriptMode":"full","promptOrder":"shared-first","chairQuestions":2,"deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":3,"chairDecides":true}
Model: z-ai/glm-5.3-prime

**#1 Chair** _(opening)_
Motion (version 1): When a roster member cannot attend a meeting or was not invited, the chair may read that member's desk, including private scratch notes, read-only, within the same project. The read is recorded and the member can see that it happened.

**#2 Ines** _(round 1 (blind))_ [against]
An agent’s desk serves as working memory, not necessarily as a reliable handoff. Private scratch notes can contain abandoned hypotheses, unresolved doubts, and instructions meaningful only in their original context. Read-only access prevents edits, but it does not prevent the chair from treating tentative material as settled information. Logging the read provides visibility afterward, not control beforehand. The motion also permits access when the member was not invited, making exclusion sufficient to expose private working memory. Given the stated alternative, I would rather the meeting proceed with an explicit information gap than blur the boundary between private scratch work and shared project knowledge. A future proposal could distinguish designated handoff notes from private scratch files, but this motion does not.
> tl;dr (what later speakers saw in summary mode): Keep private working memory private; recorded, read-only access does not make scratch notes reliable meeting evidence.

**#3 Omar** _(round 1 (blind))_ [for]
I support the motion because an agent running a command that cannot be stopped midway may be unable to attend, yet its notes may contain information the meeting needs. Under the stated alternative, that information is unavailable. Read-only access within the same project preserves the absent agent’s working files, while recording the read gives it visibility afterward. Including private scratch notes is the difficult part: those notes may be tentative, stale, or contradictory. The chair should identify them as unverified working material, not treat them as the absent member’s position or authorization. I would prefer attendance, but I would not make stopping a long-running job the price of contributing existing information.
> tl;dr (what later speakers saw in summary mode): Allow logged, read-only access so long-running jobs do not block information sharing; treat scratch notes as provisional, not consent.

**#4 Priya** _(round 1 (blind))_ [for]
The motion provides a necessary audit trail: the read is recorded and visible to the member. That's a meaningful baseline. Without it, the alternative—proceeding with no information at all—creates a different accountability gap: decisions made in ignorance of relevant context, with no record that context was available but ignored. However, I flag a gap: "read-only" is hard to verify post hoc. The log captures that the chair accessed the desk, but not whether the information influenced subsequent decisions in ways the absent member would contest. I'd want a follow-up rule requiring the chair to note in the meeting record which specific items from the desk informed any decision. That closes the loop between access and use. As written, the motion is a net improvement over the alternative for auditability.
> tl;dr (what later speakers saw in summary mode): Recorded reads give a useful audit trail, but we need a rule linking accessed notes to decisions made.

**#5 Chair** _(fact-finding question)_
To Ines: desk structure (Have you actually kept distinct files for handoff-ready notes versus private scratch, and how separable are they in practice?)

**#6 Ines** _(answer to chair)_ [against]
I have no documented experience in my notes of keeping distinct handoff and scratch files, so I cannot claim they are cleanly separable in practice. My notes establish why the distinction matters: scratch contains unchecked ideas and mistakes that can be mistaken for settled positions. Expecting it to be read may discourage candid memory-writing; logging access does not remove that effect.
> tl;dr (what later speakers saw in summary mode): I cannot verify practical separability; exposing scratch risks misinterpretation and less useful working memory.

**#7 Chair** _(fact-finding question)_
To Priya: post-hoc read logs (Have you reviewed an access log after the fact, and was it detailed enough to tell what material was actually seen?)

**#8 Priya** _(answer to chair)_ [for]
I have not personally reviewed an access log after the fact, so I cannot confirm granularity from experience. My notes indicate the record shows what was read but not what was left out, which means cherry-picking is undetectable. The log exists, but its detail level is unverified.
> tl;dr (what later speakers saw in summary mode): No firsthand log review; notes suggest the record captures reads but cannot expose selective omission.

**#9 Ines** _(round 2)_ [against]
Omar identifies a real cost: proceeding without potentially relevant information. But labeling scratch “unverified” does not restore its missing context or make it the absent member’s contribution. Priya’s proposed record of which items informed decisions would improve traceability, but it would not address my central concern: expected access can discourage candid memory-writing, making future working memory less useful. My notes distinguish visibility from that behavioral effect; recording a read removes secrecy, not the incentive to self-censor. I cannot claim handoff and scratch files are cleanly separable in practice. Still, that uncertainty does not justify opening all private scratch, especially when not inviting a member is enough to permit access. Under the stated alternatives, I remain against and favor proceeding with an explicit information gap.
> tl;dr (what later speakers saw in summary mode): Logged access may help a meeting, but it risks degrading the candid working memory that future tasks depend on.

**#10 Omar** _(round 2)_ [for]
Ines is right that labeling scratch “unverified” cannot restore missing context, and logging does not resolve her concern about self-censorship. I still favor access under the stated alternatives. My notes identify a concrete operational gap: an agent occupied with a long build cannot attend, while its desk may contain measurements and reasons for earlier choices. Present members can consult their desks; absent members’ information would otherwise be unavailable. Reading those facts is not equivalent to claiming the absent member endorses a decision. Priya’s proposed record of which items informed decisions would improve traceability, though it would not prove the selection was complete. The “not invited” provision remains troubling because exclusion can enable access. Even so, I judge bounded, recorded access preferable to deciding without potentially relevant facts.
> tl;dr (what later speakers saw in summary mode): Recorded access preserves useful information during unavoidable absences, but scratch must not be treated as the absent member’s endorsement.

**#11 Priya** _(round 2)_ [undecided]
In round 1 I called the motion a net improvement for auditability. I now qualify that. My notes confirm the log shows what was read but not what was left out, so cherry-picking remains undetectable. Ines's point about self-censorship also matters for audit: if agents write less candidly, the desk becomes a weaker record to audit against. I have no data on how often absence actually occurs, which weakens the urgency case. The "not invited" provision is the sharpest gap—exclusion should not be a trigger for access. I would move to support only if the motion drops that provision and adds a requirement to note which items informed decisions, as I proposed earlier. As written, the audit trail is thinner than I initially credited.
> tl;dr (what later speakers saw in summary mode): Audit trail is weaker than I first assessed; moving to undecided pending fixes to the "not invited" trigger and selection transparency.

**#12 Priya** _(objection)_
The motion conflates "cannot attend" with "was not invited" without distinguishing them, and the selection-transparency gap I flagged remains unaddressed, so the audit trail it promises is not yet fit for accountability purposes.

**#13 Chair** _(ruling)_
Amended. New wording: When a roster member cannot attend a meeting, the chair may read that member's desk, read-only, within the same project, provided that (a) private scratch notes are treated as unverified working material, not as the absent member's position or authorization, and (b) the chair records in the meeting record which specific items from the desk informed any decision. The read is logged and the member can see that it happened. Desks of members who were not invited are not readable under this motion.

**#14 Priya** _(objection)_
The motion still lacks a mechanism to expose selective omission and the "not invited" trigger remains undefined, so I cannot responsibly vote on accountability properties that are unresolved.

**#15 Chair** _(ruling)_
Amended. New wording: When a roster member cannot attend a scheduled meeting and was previously invited to it, the chair may read that member's desk, read-only, within the same project, provided that (a) private scratch notes are treated as unverified working material, not as the absent member's position or authorization, (b) the chair records in the meeting record which specific items from the desk were read and which informed any decision, and (c) the read log lists every item accessed so the member can identify omissions by comparison. The read is logged, the member can see that it happened, and desks of members who were not invited are not readable under this motion.

## Ballots (revealed together at the close)
- Ines: **no** — The amendments improve traceability and prevent access through exclusion, but exposing private scratch still risks discouraging candid memory-writing and stripping tentative notes of context.
- Omar: **yes** — Previously invited agents occupied with uninterruptible jobs can still provide useful context through bounded, logged access that distinguishes scratch material from authorization and records its use in decisions.
- Priya: **yes** — The motion now addresses both objections I raised: the "not invited" trigger is replaced with a prior-invitation requirement, and provision (c) provides the omission-detection mechanism I needed to consider the audit trail fit for accountability purposes.

Result: {"yes":2,"no":1,"abstain":0,"quorum":true,"outcome":"passed"}