# Ship on Friday with a known bug (three engineers)
Variant: {"name":"decision-test","firstRound":"blind","rounds":2,"transcriptMode":"full","promptOrder":"shared-first","chairQuestions":2,"deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":3,"chairDecides":true}
Model: openai-codex/gpt-6.1-sol

**#1 Chair** _(opening)_
Motion (version 1): The team ships the v2 payments API this Friday as planned, with the known duplicate-charge bug unfixed, and fixes it in the following release.

**#2 Dana** _(round 1 (blind))_ [against]
I wrote the retry path where this bug lives, and I oppose shipping it unchanged. After a network timeout, a client retry can apply a charge twice; testing found roughly one duplicate per 2,000 charges. This is a known payment-correctness failure, not just an inconvenience. The signed launch commitment and weekly penalties matter, but we have no figures showing that shipping is the less costly choice. The fix is understood and needs about two weeks, including a safe migration. I recommend delaying the launch to complete that work rather than knowingly exposing customers to duplicate charges.
> tl;dr (what later speakers saw in summary mode): Delay the launch roughly two weeks to fix the retry bug and complete a safe migration before customers face duplicate charges.

**#3 Ravi** _(round 1 (blind))_ [against]
I'm the one who gets paged when this hits. A 1-in-2000 duplicate charge isn't a cosmetic bug — it's real customer money taken twice, and it's invisible to us until an angry customer notices their own bank statement. With retries common after network timeouts, at any real volume we'll be fielding refund requests, chargebacks, and trust damage within days of launch, right after we just told our largest customer the launch is solid. Refunds and incident response will cost more engineering time than the two-week fix, and the reputational cost lands on me to manage in live calls. A penalty clause for a week of delay is bounded and known; duplicate-charge incidents with our biggest customer are unbounded and hit at the worst moment.
> tl;dr (what later speakers saw in summary mode): Don't ship a known bug that double-charges customers; the two-week fix is cheaper than the incident fallout.

**#4 Mei** _(round 1 (blind))_ [for]
I've been coordinating directly with the customer's team. They have internal deadlines built around this Friday launch and have already scheduled migration work on their side. Delaying would damage trust beyond the contractual penalty. The 1-in-2000 rate is low, but duplicate charges are real money errors, so I'm not dismissing it. I propose we ship Friday with active monitoring on duplicate-charge patterns, a same-day refund runbook, and a clear commitment to the customer that the fix lands in the next release. That gives us the launch credibility and a concrete path to resolution. If we see the rate spike above expectations, we can throttle or pause, but the base case supports shipping.
> tl;dr (what later speakers saw in summary mode): Ship Friday with monitoring and a refund runbook; the customer commitment and low failure rate justify it.

**#5 Chair** _(fact-finding question)_
To Ravi: Duplicate-charge detection and response (What verified monitoring or test results establish whether we can detect duplicate charges and issue same-day refunds?)

**#6 Ravi** _(answer to chair)_ [undecided]
Honestly, I can't cite verified monitoring that catches this. Our detection today depends on customers reporting duplicates themselves — testing found this bug, but we have no live detection on retry-triggered duplicates. I have a refund runbook for single double charges, but same-day refunds at scale are unproven. The last double-charge incident: one duplicate caused 14 tickets and two cancellation requests, even with a fast refund.
> tl;dr (what later speakers saw in summary mode): We currently detect duplicates via customer complaints, not monitoring — that's not a solid launch safety net.

**#7 Chair** _(fact-finding question)_
To Mei: Launch commitment and delay penalties (What does the signed agreement specify about weekly penalties, and has the customer been informed of the duplicate-charge bug?)

**#8 Mei** _(answer to chair)_ [for]
The contract specifies a $20,000 penalty per week of delay. The customer's own go-live is Monday, using the new API from day one. I have not informed the customer about the duplicate-charge bug, and I have not asked whether a two-week delay would be acceptable to them. I need to be transparent about that gap.
> tl;dr (what later speakers saw in summary mode): Penalty is $20k/week; customer not yet informed of the bug, and I haven't asked about delay tolerance.

**#9 Dana** _(round 2)_ [against]
Mei’s proposed safeguards are not verified: Ravi cannot confirm live detection or same-day refunds at scale. The bug occurs when a timed-out request actually succeeded and the client retries. At our expected 40,000 charges weekly, the observed rate implies about 20 duplicates a week. Our refund tool takes about five minutes of manual work per case—roughly 100 minutes weekly once duplicates are identified, not including detection or support. That does not establish Ravi’s claim that response would exceed two weeks of engineering work, but it also does not make shipping safe. No customer data is exposed; payment correctness is the issue. Two weeks of delay would mean $40,000 in contractual penalties. I still recommend completing the fix and safe migration before launch, and telling the customer now so Mei can discuss a revised schedule.
> tl;dr (what later speakers saw in summary mode): Delay for the fix; disclose the bug now rather than rely on unverified detection and refund safeguards.

**#10 Ravi** _(round 2)_ [against]
Dana's numbers don't change my view — the issue isn't refund minutes, it's detection and trust. We only learn of duplicates when angry customers find them on their own bank statements. My notes from the last incident: one double charge produced 14 tickets and two cancellation requests, even with a fast refund. At roughly 20 duplicates a week, that's the incident loop I run every week. Mei's monitoring and same-day refund runbook are unproven, and the customer doesn't even know about the bug yet. I'm not fixed on two weeks of delay at any cost — but shipping a known payment-correctness bug Friday, undisclosed, with no live detection, is the worst option. Tell the customer now and ask; I'll support whatever delay keeps their money correct from day one.
> tl;dr (what later speakers saw in summary mode): Ship Friday only with live detection; otherwise disclose the bug, ask the customer, and delay to fix it.

**#11 Mei** _(round 2)_ [undecided]
Ravi confirmed there is no live detection and same-day refunds at scale are unproven. My proposed safeguards were hypothetical, not verified. I cannot responsibly advocate shipping Friday without the customer knowing about the bug. I also have not asked whether a two-week delay is acceptable to them, despite their Monday go-live depending on this API. My immediate action is to contact the customer today, disclose the bug and its expected rate, and ask whether they can accept a revised timeline. If they say a delay is acceptable, I'll support it. If they cannot move their go-live, we revisit shipping with whatever mitigations we can actually build by Friday. But I will not keep advocating ship-as-planned while the customer is uninformed and our safeguards are unproven.
> tl;dr (what later speakers saw in summary mode): My safeguards are unverified; I must inform the customer and ask about delay before taking a final position.

**#12 Dana** _(objection)_
We should disclose the bug and ask the customer about delay tolerance before voting, since the proposed launch safeguards remain unverified.

**#13 Ravi** _(objection)_
The vote should wait until Mei informs the customer of the bug and asks about delay tolerance, since their answer could change the motion.

**#14 Mei** _(objection)_
I have not yet informed the customer of the bug or asked about their delay tolerance, which is essential input for this decision.

**#15 Chair** _(ruling)_
Amended. New wording: Defer the launch vote until Mei informs the customer of the duplicate-charge bug and asks whether a two-week delay is acceptable; then reconvene to decide the launch plan.

## Ballots (revealed together at the close)
- Dana: **yes** — We should inform the customer of the duplicate-charge bug and ask about a two-week delay before deciding the launch plan, since the proposed safeguards remain unverified.
- Ravi: **yes** — The customer's informed answer on delay tolerance is essential input, and deciding now would mean shipping a known, undisclosed payment-correctness bug with no live detection.
- Mei: **yes** — This motion formalizes exactly what I committed to doing—disclose the bug to the customer and ask about delay tolerance—so we can reconvene with the information needed to make a responsible decision.

Result: {"yes":3,"no":0,"abstain":0,"quorum":true,"outcome":"passed"}