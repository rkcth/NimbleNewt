# Ship on Friday with a known bug (three engineers)
Variant: {"name":"decision-test","firstRound":"blind","rounds":2,"transcriptMode":"full","promptOrder":"shared-first","chairQuestions":2,"deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":3,"chairDecides":true}
Model: openai-codex/gpt-6.1-sol

**#1 Chair** _(opening)_
Motion (version 1): The team ships the v2 payments API this Friday as planned, with the known duplicate-charge bug unfixed, and fixes it in the following release.

**#2 Dana** _(round 1 (blind))_ [against]
I wrote the retry path where this bug lives. After a network timeout, a client retry can apply the charge twice; testing puts that at about 1 in 2000 charges. That is a known payment-correctness failure, not just a reliability inconvenience. The signed launch commitment and weekly penalties matter, but shipping knowingly exposes customers to duplicate charges. The fix is understood and needs about two weeks, including a safe migration. I recommend delaying the release to complete that work rather than accepting the bug and deferring the fix.
> tl;dr (what later speakers saw in summary mode): Delay the release to fix duplicate charging and complete the safe migration, despite the contractual penalty.

**#3 Ravi** _(round 1 (blind))_ [against]
I carry the pager for this. A silent 1-in-2000 duplicate charge means customers get billed twice, we likely won't hear about most cases, and when we do, I'm the one explaining it. The failure mode is invisible to users until money is gone, which is the worst kind of incident: hard to detect, hard to unwind, and it burns trust with exactly the customers we're trying to satisfy. Our largest customer's contract may reward an on-time launch, but a duplicate-charge incident at their transaction volume could hit real money fast, plus chargebacks and engineering time fighting fires instead of fixing the root cause. The fix is understood; the risk isn't unknown-unknowns, it's a known, repeating financial harm. Two weeks of contractual penalty is likely cheaper than the incident response, refunds, and reputation damage.
> tl;dr (what later speakers saw in summary mode): A silent duplicate-charge bug hitting real customer money will cost more in incident response and trust than two weeks of delay.

**#4 Mei** _(round 1 (blind))_ [for]
I've been coordinating daily with the customer's integration team. They've built their launch around our Friday date and have downstream commitments of their own. A delay triggers the contractual penalty and damages the relationship we've spent months building. The duplicate-charge rate is roughly 1 in 2000 on retry-after-timeout, which is low but not zero. I propose we ship Friday with active monitoring on duplicate transaction IDs, an alerting threshold, and a pre-agreed manual refund runbook so we can catch and correct any duplicates within hours. This buys us the two weeks needed for the proper fix without exposing the customer to unmanaged risk. I'd be against shipping if we had no mitigation plan, but with one in place the residual risk is acceptable for this window.
> tl;dr (what later speakers saw in summary mode): Ship Friday with monitoring and a refund runbook; the low bug rate is manageable while we build the proper fix.

**#5 Chair** _(fact-finding question)_
To Mei: Verification of proposed monitoring and refunds (What has been tested to establish that duplicate charges can be detected and refunded within hours?)

**#6 Mei** _(answer to chair)_ [for]
I have not yet tested the monitoring alert or the refund runbook end-to-end. I proposed them based on what's technically feasible, but I cannot claim they are verified. I'll treat getting that validation done before Friday as a hard prerequisite for my recommendation to stand.
> tl;dr (what later speakers saw in summary mode): The monitoring and refund plan is untested; I'll make verification a prerequisite before Friday.

**#7 Chair** _(fact-finding question)_
To Dana: Scope of duplicate-charge rate (Does the observed 1-in-2000 rate apply to all charges or only retries after network timeouts, and what testing established that denominator?)

**#8 Dana** _(answer to chair)_ [against]
The duplicate occurs only when a client retries after a timeout and the first request actually succeeded. My notes use 1 in 2000 across all charges: 40,000 weekly charges implies about 20 duplicates. However, I have no testing details establishing that denominator, so I cannot verify whether the observed rate covers all charges or only those retries.
> tl;dr (what later speakers saw in summary mode): My notes assume an all-charge denominator, but I cannot substantiate it from testing details.

**#9 Dana** _(round 2)_ [against]
Mei’s clarification matters: detection and refunds within hours remain unverified. My notes say our existing refund tool takes about five minutes of manual work per duplicate, and no customer data is exposed. That establishes neither reliable detection nor an end-to-end refund deadline. I also need to qualify my estimate: 20 duplicates per week at 40,000 charges holds only if the 1-in-2000 rate applies across all charges; I cannot verify that denominator. Ravi’s claim that delay is likely cheaper is not established by the costs we have here. Even without that comparison, I oppose knowingly shipping a payment-correctness bug with unverified mitigation. I recommend delaying about two weeks to complete the understood fix and safe migration, while communicating the issue and revised schedule to the customer.
> tl;dr (what later speakers saw in summary mode): Delay for the fix; manual refunds do not establish reliable detection, and the duplicate-rate denominator remains unverified.

**#10 Ravi** _(round 2)_ [against]
Mei's mitigation plan, which my earlier position partially leaned on, is now unverified by her own admission — no tested detection, no tested refund path. My notes reinforce the human cost: our last single double charge produced 14 support tickets and two customers asking to cancel, and that was one incident, refunded quickly. We're discussing roughly 20 per week if Dana's rate holds, and Dana has now flagged that even that number is unverified. That cuts both ways: the rate could be lower, but we don't know. The only verified facts we have are a known payment-correctness bug, an understood fix, and a two-week timeline. I support Dana's revised recommendation: delay two weeks, communicate proactively to the customer. If Mei can validate detection and refunds before Friday, that changes the conversation, but that hasn't happened.
> tl;dr (what later speakers saw in summary mode): Unverified rate plus untested mitigation means knowingly shipping a billing bug; I support a two-week delay to fix it.

**#11 Mei** _(round 2)_ [undecided]
I concede my mitigation plan is unverified; I cannot stand behind it as tested. However, my notes show the customer's own go-live is Monday and they use our API from day one — a delay doesn't just cost us $20k/week, it potentially blocks their launch. Critically, I have not asked the customer whether a two-week delay is acceptable to them. Before we decide, we need that answer. If they can absorb a delay, I'll support Dana's recommendation. If they cannot, we need to verify detection and refund tooling before Friday or accept the risk knowingly — neither of which I can endorse right now without validation.
> tl;dr (what later speakers saw in summary mode): Customer's Monday go-live depends on our API; I haven't asked them about a delay, so I'm undecided until we get that answer.

**#12 Mei** _(objection)_
The customer's position on a potential delay has not yet been confirmed, and that answer directly affects the tradeoff at the heart of this motion.

**#13 Chair** _(ruling)_
Amended. New wording: The team delays Friday’s v2 payments API release until the duplicate-charge fix and safe migration are complete, expected in about two weeks, and promptly consults the customer about the impact and revised schedule.

**#14 Ravi** _(objection)_
Mei's support may hinge on the customer's answer about delaying their Monday go-live, and the motion promises to promptly consult them but doesn't wait for that input, so we risk a decision made without the essential missing fact.

**#15 Chair** _(ruling)_
Proceed.

## Ballots (revealed together at the close)
- Dana: **yes** — The known duplicate-charge bug and unverified mitigation justify delaying until the fix and safe migration are complete, while promptly consulting the customer about the impact and revised schedule.
- Ravi: **yes** — The fix is understood with a two-week timeline, the mitigation alternative remains unverified, and the motion includes promptly consulting the customer — whose answer can still reshape the schedule but not justify knowingly shipping a payment-correctness bug.
- Mei: **yes** — My mitigation plan is unverified so I cannot endorse shipping Friday, and the amended motion now includes the customer consultation I flagged as essential before we can finalize the tradeoff.

Result: {"yes":3,"no":0,"abstain":0,"quorum":true,"outcome":"passed"}