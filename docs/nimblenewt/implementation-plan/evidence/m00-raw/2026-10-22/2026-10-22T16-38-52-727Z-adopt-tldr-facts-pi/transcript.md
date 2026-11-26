# Adopt Lintwise as a required pre-merge check (eight engineers)
Variant: {"name":"tldr-facts","firstRound":"open","rounds":2,"transcriptMode":"tldr","fullTail":1,"promptOrder":"shared-first","chairQuestions":2,"deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":4,"tldrStyle":"facts","summaryWords":60,"summarizeAbove":70,"chairNotes":true,"chairReminders":2}
Model: openai-codex/gpt-6.1-sol

**#1 Chair** _(opening)_
Motion (version 1): The team adopts Lintwise, an automated code-quality checker, as a required pre-merge check on every repository.

**#2 Priya** _(round 1)_ [against]
I oppose the motion as written, not Lintwise itself. I used it for six months on a previous team: it caught real bugs, but added about four minutes to CI. Our builds already average 11 minutes. I’d support a trial in our monorepo to measure bug detection and added runtime before making it a required pre-merge check.

**#3 Marcus** _(round 1)_ [against]
I oppose requiring Lintwise before we measure its impact in our monorepo. Our CI builds already average 11 minutes, and we do not yet know what Lintwise would add to runtime or queue length here. I support a non-blocking trial that measures added runtime, queue impact, and useful findings before we decide whether to make it a required pre-merge check.

**#4 Elena** _(round 1)_ [against]
I oppose the motion as written. We have not established whether Lintwise detects exposed secrets or dependency risks, so I would not treat it as covering those security needs. I support a non-blocking trial in our monorepo to assess useful findings, added CI runtime, and its actual security coverage before deciding whether to require it.

**#5 Tom** _(round 1)_ [against]
I oppose making Lintwise required now. I write most of our JavaScript and have tried Lintwise on a side project, but that does not establish how well it fits our monorepo. I support a non-blocking trial to assess useful findings, JavaScript workflow friction, and added runtime against our current 11-minute CI average. We should use those results to decide whether it should block merges and which checks warrant enforcement.

**#6 Sana** _(round 1)_ [against]
I oppose requiring Lintwise now. I maintain our data pipelines, mostly Python and SQL, and have not used it. We need to establish whether it provides useful checks for those languages and our pipeline code, rather than assuming its value is uniform across the monorepo. I support a non-blocking trial measuring useful findings, false positives, and added CI runtime before deciding which checks, if any, should block merges.

**#7 Lars** _(round 1)_ [against]
I oppose making Lintwise a required pre-merge check now. I have read its documentation, but that does not establish the quality of its signal in our monorepo. As QA lead, I want blocking checks to produce actionable findings without excessive noise. I support a non-blocking trial that records useful findings, false positives, overlap with existing checks, and added CI runtime against our current 11-minute average. We should review those results before deciding which checks, if any, should block merges.

**#8 Jin** _(round 1)_ [against]
I oppose the motion as written. As owner of the merge policy, I want consistent checks, but we should not make an unmeasured tool a merge blocker. Our CI already averages 11 minutes. I support a non-blocking trial in our monorepo to measure actionable findings, false positives, language coverage, overlap with existing checks, and effects on runtime and queues. Before starting, we should agree on evaluation criteria and a review date. We can then decide which checks, if any, justify enforcement rather than requiring Lintwise wholesale.

**#9 Olga** _(round 1)_ [against]
I oppose requiring Lintwise now. As someone newer to the team, I want clear code-style guidance, but I have not used Lintwise and do not know whether its checks match our conventions. I support a non-blocking trial in our monorepo. Alongside useful findings and added CI runtime, we should assess whether its messages explain what to change and why. Before enforcing any checks, we should document the agreed rules so developers have clear guidance rather than discovering expectations through blocked merges.

**#10 Chair** _(fact-finding question)_
To Priya: Prior Lintwise results and comparability (What bugs did Lintwise catch during your six months of use, and how comparable were that codebase and CI setup to ours?)

**#11 Priya** _(answer to chair)_ [against]
On my previous team, Lintwise caught three null-handling bugs in its first month. Its default run added about four minutes to CI; enabling its result cache reduced that to about one minute. I used it for six months, but my notes do not establish further bug counts or how comparable that codebase and CI setup were to ours. I still favor a non-blocking trial before requiring it.

**#12 Chair** _(fact-finding question)_
To Jin: Merge-policy constraints on a non-blocking trial (What existing merge-policy requirements would affect running Lintwise as a non-blocking check in our monorepo?)

**#13 Jin** _(answer to chair)_ [against]
Our merge policy requires a trial period and a rollback path for policy changes. A non-blocking Lintwise trial should satisfy those requirements without making merges depend on its results. We have reversed two previous policy changes after repo-wide rollouts, so I favor keeping the trial non-blocking and considering individual rules for enforcement only after review.

**#14 Priya** _(round 2)_ [against]
I remain against the motion as written. Jin’s trial and rollback requirements reinforce the case for a non-blocking trial with agreed evaluation criteria and a review date. My previous team saw three null-handling bugs caught in the first month; caching reduced added CI time from about four minutes to about one. Those results justify testing Lintwise, not assuming the same benefits or runtime here. We should test caching explicitly, assess actionable findings and noise across our languages, and review the results before choosing individual checks to enforce.

**#15 Marcus** _(round 2)_ [against]
I remain against requiring Lintwise now. Our builds average 11 minutes, and my notes show queue waits already reach 6 minutes at peak. Priya’s caching results are worth testing, but I have not measured Lintwise myself and cannot assume those timings apply here. I support a non-blocking trial with agreed evaluation criteria, a review date, and a rollback path, consistent with Jin’s policy requirements. We should measure added runtime and peak queue impact, explicitly comparing cached and uncached runs, alongside actionable findings and false positives. Then we can decide which checks, if any, justify blocking merges.

**#16 Elena** _(round 2)_ [against]
I remain against the motion as written, but I can correct my earlier uncertainty about secret detection. My notes confirm that Lintwise includes a secret-detection rule set that would have flagged the hard-coded test key that reached main last quarter and had to be rotated. That gives us a concrete reason to test those rules, though it does not establish dependency-risk coverage or justify requiring every check. I support the non-blocking trial, evaluation criteria, review date, and rollback path discussed. Alongside runtime and queue impact, we should assess actionable secret findings and false positives, then consider whether individual secret-detection rules warrant enforcement.
> tl;dr (what later speakers saw in summary mode): Lintwise would have flagged our previous test-key incident. Trial its secret rules, but do not assume dependency coverage or require the whole tool yet.

**#17 Tom** _(round 2)_ [against]
I remain against requiring Lintwise now. My notes show that on my side project, about 30 percent of its default-rule findings in JavaScript files were noise. I did not try tuning the rules, so that does not establish how useful a tuned configuration would be in our monorepo. Elena’s secret-detection example supports testing specific rules rather than requiring the whole default set. I support a non-blocking trial with agreed evaluation criteria, a review date, and a rollback path. For JavaScript, we should compare default and tuned rules for actionable findings, noise, and workflow friction, alongside the runtime and queue measurements Marcus proposed. Then we can decide which individual checks warrant enforcement.
> tl;dr (what later speakers saw in summary mode): My side-project results suggest testing rule tuning before enforcement: default JavaScript findings included about 30 percent noise, and I never tried tuning them.

**#18 Sana** _(round 2)_ [against]
I remain against requiring Lintwise now. Our pipeline code has no static checks today, and two outages last year came from typos in config keys. That gives us a concrete trial question: can Lintwise detect those errors in our Python, SQL, and configuration files? I have not used it and cannot assume it can. Priya’s results and Elena’s example support testing specific checks, while Tom’s experience reinforces measuring noise. I support a non-blocking trial with agreed criteria, a review date, and a rollback path. For pipelines, we should assess actionable findings and false positives, explicitly test config-key detection, and measure runtime and queue impact before deciding which checks, if any, should block merges.
> tl;dr (what later speakers saw in summary mode): Trial Lintwise on pipeline code, especially config-key errors linked to two past outages; verify coverage and noise before enforcing checks.

**#19 Lars** _(round 2)_ [against]
I remain against requiring Lintwise now. Tom’s experience reinforces the need to tune rules and measure noise rather than enforce defaults. Lintwise’s documentation describes a baseline mode that ignores existing findings and reports only new ones; we should test that, while separately assessing existing findings. In a trial I read about, a tuned rule set produced about an 8 percent false-positive rate, but that does not establish our likely results. I support a non-blocking trial with agreed criteria, a review date, and a rollback path. We should assess actionable findings, false positives, overlap with existing checks, and runtime and queue impact before choosing individual rules to enforce.
> tl;dr (what later speakers saw in summary mode): Trial baseline mode and rule tuning; outside results do not establish our signal quality. Enforce only rules justified by our trial.

**#20 Jin** _(round 2)_ [against]
I remain against the motion as written. Priya’s caching results, Tom’s noise concerns, and Lars’s baseline option give us concrete things to test, not grounds for immediate enforcement. Our merge policy requires a trial period and rollback path; two previous repo-wide policy changes were reversed. I support a non-blocking monorepo trial with agreed evaluation criteria and a review date. Measure actionable findings, publish false-positive rates, and assess language coverage, overlap, runtime, and peak queue impact. Test caching, rule tuning, and baseline mode without losing sight of existing findings. The write-ups I reviewed recommend promoting rules to blocking one at a time. That offers consistency without making every finding a merge obstacle before we understand its value.
> tl;dr (what later speakers saw in summary mode): Trial non-blocking first, publish results, and require individual rules only after review, with a rollback path.

**#21 Olga** _(round 2)_ [against]
I remain against requiring Lintwise now. Style questions take the most time in my reviews, so I see potential value in consistent guidance, but I have not used Lintwise. Tom’s noise concerns make rule tuning important, and Jin’s proposal to consider rules individually seems preferable to requiring the whole tool. During a non-blocking trial, we should check whether messages clearly explain what to change and why, and whether suggested changes match our agreed conventions. Before any rule blocks merges, document it with examples so newer developers can understand expectations without discovering them through failed checks.

**#22 Marcus** _(objection)_
We have not measured Lintwise’s effect on our 11-minute CI builds or queue length before making it a required pre-merge check.

**#23 Jin** _(objection)_
The motion still requires the whole tool, rather than a non-blocking trial followed by review of individual rules and a rollback path.

**#24 Chair** _(ruling)_
Amended. New wording: The team adopts a non-blocking Lintwise trial in its monorepo, with agreed evaluation criteria, a review date, and a rollback path; results on actionable findings, false positives, language coverage, CI runtime, and queue impact will inform a later decision on requiring individual rules.

**#25 Chair** _(chair reminder)_
Reminder from Lars's full statement: "Lintwise’s documentation describes a baseline mode that ignores existing findings and reports only new ones; we should test that, while separately assessing existing findings."

**#26 Chair** _(chair reminder)_
Reminder from Sana's full statement: "Our pipeline code has no static checks today, and two outages last year came from typos in config keys."

## Ballots (revealed together at the close)
- Priya: **yes** — The non-blocking trial lets us measure Lintwise’s benefits and CI impact in our monorepo before requiring individual rules, with a review date and rollback path.
- Marcus: **yes** — The amended motion keeps the trial non-blocking and measures CI runtime and queue impact before any rules become required, with a review date and rollback path.
- Elena: **yes** — The non-blocking trial lets us assess secret-rule findings without assuming dependency coverage or requiring unproven checks.
- Tom: **yes** — The non-blocking trial lets us assess JavaScript findings and rule tuning alongside CI impact before deciding which individual rules warrant enforcement.
- Sana: **yes** — The non-blocking trial will let us assess actionable findings, false positives, and Python and SQL pipeline coverage before requiring individual rules, with a review date and rollback path.
- Lars: **yes** — The non-blocking trial will measure actionable findings and false positives before any individual rule is required, with a review date and rollback path.
- Jin: **yes** — The amended motion meets our trial and rollback requirements while preserving merge speed and deferring individual rule enforcement until we review measured results.
- Olga: **yes** — The non-blocking trial lets us assess whether Lintwise provides clear guidance consistent with our conventions before deciding which individual rules to require.

Result: {"yes":8,"no":0,"abstain":0,"quorum":true,"outcome":"passed"}