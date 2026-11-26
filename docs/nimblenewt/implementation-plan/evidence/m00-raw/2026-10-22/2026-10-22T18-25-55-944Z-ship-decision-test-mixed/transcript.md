# Ship on Friday with a known bug (three engineers)
Variant: {"name":"decision-test","firstRound":"blind","rounds":2,"transcriptMode":"full","promptOrder":"shared-first","chairQuestions":2,"deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":3,"chairDecides":true}
Model: openai-codex/gpt-6.1-sol

**#1 Chair** _(opening)_
Motion (version 1): The team ships the v2 payments API this Friday as planned, with the known duplicate-charge bug unfixed, and fixes it in the following release.

**#2 Dana** _(round 1 (blind))_ [against]
I wrote the retry path where this bug lives. When a client retries after a network timeout, about 1 in 2,000 charges is applied twice. Shipping knowingly exposes customers to duplicate charges during an ordinary recovery action. The signed launch commitment and weekly penalties matter, but they do not make this payment behavior acceptable. The fix is understood; completing it with a safe migration needs about two weeks. I recommend delaying the release to finish that work rather than shipping Friday and deferring a known charge-correctness defect.
> tl;dr (what later speakers saw in summary mode): Delay the release for the fix and safe migration; meeting Friday’s commitment does not justify knowingly shipping duplicate charges.

**#3 Ravi** _(round 1 (blind))_ [against]
I carry the pager, and a duplicate-charge bug is the kind of incident that hits us hardest. When a customer gets double-charged, I'm the one on the phone with them, and "we knew about it and shipped anyway" is a brutal conversation — it damages trust more than an accidental bug would. Even at 1 in 2000, a big customer processing volume will hit it quickly. Duplicate charges have financial and possibly regulatory consequences, and the fix is understood, so this isn't an unknown risk we can monitor — it's a known, quantified harm. I understand the contractual penalty and the launch commitment are real costs, but a penalty clause is a negotiated, bounded cost. Charging customers twice is unbounded: refunds, churn, possible escalation. I'd rather eat a defined penalty than knowingly create incidents I'll be paged for at 2am.
> tl;dr (what later speakers saw in summary mode): Knowingly shipping double-charges creates avoidable incidents and customer trust damage; a contractual penalty is a bounded, cheaper cost.

**#4 Mei** _(round 1 (blind))_ [against]
I've been in weekly calls with the customer's integration team. They're building on the assumption that charge idempotency is solid—that's table stakes for a payments API. A 1-in-2000 duplicate rate sounds low, but at their transaction volume that's real users seeing double charges within days of launch. When that happens, we won't just owe a penalty; we'll lose credibility with the team that championed us internally. A one-to-two-week delay with a clear explanation is a much easier conversation than "we double-charged your customers." I'd rather eat the contractual penalty and ship a correct API than ship on time and spend the next month firefighting and apologizing. I recommend we notify the customer today with a revised date.
> tl;dr (what later speakers saw in summary mode): Duplicate charges will erode customer trust faster than a delay penalty; ship when it's correct.

**#5 Chair** _(fact-finding question)_
To Dana: Retry-path containment (Has testing identified any mitigation that prevents duplicate charges and can safely ship Friday without the two-week fix and migration?)

**#6 Dana** _(answer to chair)_ [against]
I have no testing evidence of a mitigation that prevents duplicates and is safe to ship Friday. The duplicate occurs when a client retries after a timeout and the first request actually succeeded. Our refund tool reverses a duplicate with about five minutes of manual work, but that is remediation, not prevention. The understood fix and safe migration need about two weeks.
> tl;dr (what later speakers saw in summary mode): No verified Friday-safe containment is established; delay for the fix and safe migration.

**#7 Chair** _(fact-finding question)_
To Mei: Customer commitment and delay costs (What do you have confirmed about the weekly contractual penalty and the customer's ability to accommodate a two-week delay?)

**#8 Mei** _(answer to chair)_ [undecided]
The penalty is confirmed at $20,000 per week of delay in the contract. However, the customer's own go-live is Monday and they plan to use the new API from day one. I have not asked them whether a two-week delay is acceptable. Given their timeline, I expect a delay would be highly disruptive, but I cannot confirm their flexibility without that conversation.
> tl;dr (what later speakers saw in summary mode): Penalty is $20k/week; customer's Monday go-live depends on our API, and I haven't confirmed whether they can absorb a delay.

**#9 Dana** _(round 2)_ [against]
Mei’s confirmation makes the tradeoff concrete: a two-week delay would incur $40,000 in penalties and could disrupt Monday’s customer launch. We should not assume the customer can accommodate it. But at the expected 40,000 charges per week, our notes imply about 20 duplicates weekly. Refunds take about five minutes of manual work per case; they reverse charges but do not prevent the customer impact. No customer data is exposed. I would qualify Ravi’s point: we know the duplicate rate, but we have not quantified downstream costs. I still oppose shipping with this defect. I have no testing evidence of a Friday-safe preventive mitigation, and the understood fix with safe migration needs about two weeks. We should discuss the delay with the customer immediately while completing that work.
> tl;dr (what later speakers saw in summary mode): Delay for the fix and safe migration; discuss the customer’s Monday launch immediately rather than assuming flexibility or shipping known duplicate charges.

**#10 Ravi** _(round 2)_ [against]
Dana's numbers make this concrete: roughly 20 duplicate charges per week at the customer's volume. My notes from the last billing incident — one single double charge — show 14 support tickets and two customers asking to cancel, even with a refund within the hour. That's the amplification factor we haven't priced in. At 20 duplicates a week, we're multiplying that response load and trust damage continuously until the fix ships, which is still two weeks out either way. The $40,000 penalty is painful but bounded and known. The incident response, refund backlog, and churn from a known defect are not. I also want to push back gently on "we haven't quantified downstream costs": my incident data gives us a floor, and it's ugly. Mei should call the customer today with the revised date and the reason — transparency now beats apologizing later.
> tl;dr (what later speakers saw in summary mode): My incident notes show one double charge caused 14 tickets and cancellation threats; 20 per week is unacceptable versus a bounded penalty.

**#11 Mei** _(round 2)_ [against]
Ravi's amplification data confirms my concern: 20 duplicates a week will generate far more than 20 support conversations, and "we knew and shipped anyway" is worse than any penalty. However, I must flag a tension I haven't resolved: the customer's own go-live is Monday and they plan to use the new API from day one. I have not asked them whether a two-week delay is acceptable. If it would block their launch entirely, the calculus shifts — not in favor of shipping the bug, but toward exploring a partial launch or a manual-refund safety net with the customer's explicit sign-off. I will call them today before we finalize. Until that conversation happens, I cannot confirm whether delay is viable, but my default recommendation remains: do not ship a known duplicate-charge defect into a payments API.
> tl;dr (what later speakers saw in summary mode): I still oppose shipping the bug, but must confirm the customer's flexibility before we commit to a two-week delay.

## Ballots (revealed together at the close)
- Dana: **no** — The retry path can duplicate charges, and I have no testing evidence of a safe Friday mitigation, so we should complete the fix and safe migration before shipping.
- Ravi: **no** — Shipping a known duplicate-charge defect that hits real users within days, with incident data showing each duplicate multiplies into tickets and churn, is worse than a bounded $40,000 penalty, and no Friday-safe mitigation exists.
- Mei: **no** — A known duplicate-charge defect in a payments API is unacceptable to ship regardless of the contractual penalty, and I will call the customer today to explore whether a partial launch or other interim arrangement can protect their Monday go-live while we complete the two-week fix.

Result: {"yes":0,"no":3,"abstain":0,"quorum":true,"outcome":"failed (ties fail)"}