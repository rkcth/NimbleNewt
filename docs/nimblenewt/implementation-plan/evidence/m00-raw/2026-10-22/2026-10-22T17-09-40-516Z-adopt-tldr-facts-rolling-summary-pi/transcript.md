# Adopt Lintwise as a required pre-merge check (eight engineers)
Variant: {"name":"tldr-facts-rolling-summary","firstRound":"open","rounds":2,"transcriptMode":"tldr","fullTail":1,"promptOrder":"shared-first","chairQuestions":2,"deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":4,"tldrStyle":"facts","summaryWords":60,"summarizeAbove":70,"chairNotes":"rolling","chairReminders":2,"chairSummary":true}
Model: openai-codex/gpt-6.1-sol

**#1 Chair** _(opening)_
Motion (version 1): The team adopts Lintwise, an automated code-quality checker, as a required pre-merge check on every repository.

**#2 Priya** _(round 1)_ [against]
I oppose making Lintwise mandatory immediately. I used it for six months on a previous team: it caught real bugs, but added about four minutes to CI. Our builds already average 11 minutes; we should measure its impact on our monorepo rather than assume the same overhead. I support a non-blocking trial, then reconsidering a required check based on the bugs it catches and the time it adds.

**#3 Marcus** _(round 1)_ [against]
I oppose making Lintwise a required pre-merge check now. Our CI builds already average 11 minutes, and we have no measurements of its runtime or effect on queue length in our monorepo. Priya’s experience supports testing it, not assuming the same overhead here. I support a non-blocking trial that measures added build time, queue impact, and useful findings before we reconsider making it mandatory.

**#4 Elena** _(round 1)_ [against]
I oppose requiring Lintwise now. From a security perspective, we have no evidence that it detects exposed secrets or risky dependencies; being a static code-quality checker does not establish those capabilities. I support a non-blocking trial to measure useful findings and CI impact on our monorepo. Before making it mandatory, we should establish what it checks, how actionable its findings are, and what security gaps remain. We should not treat adoption as proof that secrets and dependency risks are covered.

**#5 Tom** _(round 1)_ [against]
I oppose requiring Lintwise immediately. I’ve tried it on a side project, but that alone does not establish how well it fits our monorepo or what it would add to our 11-minute CI builds. Since I write most of our JavaScript, I support a non-blocking trial that checks whether its JavaScript findings are useful and actionable, alongside measuring runtime and queue impact. We should use those results to decide which checks, if any, should block merges.

**#6 Sana** _(round 1)_ [against]
I oppose making Lintwise mandatory now. I maintain our data pipelines, mostly in Python and SQL, and have not used Lintwise. We should establish whether it supports those languages and produces actionable findings on our pipeline code before requiring it. I support a non-blocking trial on the monorepo that measures useful findings and added CI time against our current 11-minute average. We can then decide which checks, if any, should block merges.

**#7 Lars** _(round 1)_ [against]
I oppose requiring Lintwise immediately. As QA lead, I want a merge gate to provide actionable signal without unnecessary noise. I have read its documentation, but that does not establish the quality of its findings on our monorepo. I support a non-blocking trial that reviews useful findings, false positives, overlap with existing checks, and added CI time. Before making any checks mandatory, we should agree which findings justify blocking a merge and how disputed findings will be handled.

**#8 Jin** _(round 1)_ [against]
I oppose the motion as written. As tech lead and merge-policy owner, I want consistent checks, but a required gate should demonstrate value before it blocks developers. We maintain one monorepo, so the immediate question is whether Lintwise merits a gate there. I support a non-blocking trial measuring actionable findings, false positives, language coverage, added CI time, and queue impact. Before requiring any checks, we should agree on blocking criteria, ownership of configuration, and a process for disputed findings or exceptions. Consistency should come from an explicit policy informed by trial results, not from making every finding mandatory.

**#9 Olga** _(round 1)_ [against]
I oppose making Lintwise mandatory now. As a newer developer, I would welcome clear, consistent guidance on code style, but I have not used Lintwise and do not know whether its recommendations match our team’s conventions. I support a non-blocking trial on our monorepo. Alongside measuring useful findings and CI impact, we should check whether its messages explain what to change and why. Before any findings block merges, we should document the agreed rules and identify someone developers can ask about confusing or disputed recommendations.

**#10 Chair** _(fact-finding question)_
To Priya: Findings and CI overhead in prior use (Priya, what bugs did Lintwise catch, how often, and how comparable was that setup to our monorepo?)

**#11 Priya** _(answer to chair)_ [against]
On my previous team, Lintwise caught three null-handling bugs in its first month. I used it for six months, but my notes do not establish a longer-term detection rate. Its default run added about four minutes to CI; enabling its result cache reduced that to about one minute. I cannot establish how comparable that setup was to our monorepo, so I still favor a non-blocking trial.

**#12 Chair** _(fact-finding question)_
To Jin: Existing merge-policy provisions (Jin, what existing merge-policy provisions cover blocking criteria, check ownership, disputes, and exceptions?)

**#13 Jin** _(answer to chair)_ [against]
Our merge policy requires a trial period and a rollback path for policy changes. My notes do not establish existing provisions for blocking criteria, check ownership, disputes, or exceptions; I need to verify those rather than claim they exist. We have reversed two policy changes after repo-wide rollouts, which reinforces my opposition to an immediate mandatory gate.

**#14 Chair** _(chair summary)_
Chair's summary of round 1:
- (repeated; Priya, Marcus, Elena, Tom, Sana, Lars, Jin, Olga) All eight speakers oppose an immediate mandatory check and support a non-blocking trial on the monorepo before reconsidering merge gates. No speaker has argued for immediate adoption.
- (repeated; Marcus, Tom, Sana, Lars, Jin) Several speakers want measurements of actionable findings, false positives, language coverage, CI runtime, and queue impact. Current builds average 11 minutes; Lintwise’s impact on this monorepo is unknown.
- (omitted; Priya) Priya reported three null-handling bugs in the first month of prior use, with CI overhead reduced from about four minutes to about one through caching. Her notes establish neither a longer-term detection rate nor comparability to this monorepo. — from the full statement: "enabling its result cache reduced that to about one minute"
- (repeated; Sana, Tom, Elena) Coverage remains uncertain: Sana raised Python and SQL support, Tom emphasized useful JavaScript findings, and Elena cautioned that code-quality checking does not establish secrets or dependency-risk detection.
- (repeated; Lars, Jin, Olga) Speakers want explicit blocking criteria, configuration ownership, and handling of disputed findings before any mandate. Jin confirmed that existing policy requires a trial and rollback path, but other policy provisions remain unverified.
- (omitted; Olga, Lars) Olga also emphasized whether recommendations fit team conventions and explain what to change and why; Lars raised overlap with existing checks. — from the full statement: "we should check whether its messages explain what to change and why."

**#15 Priya** _(round 2)_ [against]
I remain against the motion as written. Jin’s confirmation that our policy requires a trial and rollback path reinforces the case against an immediate mandate. My prior results justify testing Lintwise, not assuming it will perform similarly here: it caught three null-handling bugs in its first month, and caching reduced added CI time from about four minutes to about one. I support a non-blocking monorepo trial that measures useful findings, false positives, language coverage, and CI impact, including whether caching helps. Before any gate becomes mandatory, we should agree on blocking criteria, ownership, dispute handling, and a rollback path.

**#16 Marcus** _(round 2)_ [against]
I remain against an immediate mandatory check. My notes show peak CI queue waits are already six minutes, alongside our 11-minute average builds. I have not measured Lintwise myself. Priya’s caching results make it worth testing both cached and uncached runs, but neither her runtime figure establishes our overhead. As CI owner, I support a non-blocking monorepo trial measuring added build time and peak queue impact alongside useful findings. Jin’s confirmation that policy requires a trial and rollback path reinforces that approach. Before making any check mandatory, we should agree on acceptable CI impact and how to disable the gate if it causes problems.

**#17 Elena** _(round 2)_ [against]
I remain against an immediate mandatory check, but I need to correct my earlier uncertainty about secrets coverage. My notes confirm that Lintwise includes a secret-detection rule set that would have flagged the hard-coded test key that reached main last quarter and had to be rotated. That gives us a concrete reason to test its security value, not proof of comprehensive secrets coverage or dependency-risk detection. I support the non-blocking monorepo trial, including evaluating that rule set’s actionable findings and false positives alongside CI and queue impact. Jin’s confirmation that policy requires a trial and rollback path further supports that approach. We should consider whether particular validated rules merit blocking merges rather than treating all findings alike.
> tl;dr (what later speakers saw in summary mode): Lintwise could have caught our known test-key incident. Trial its secret rules, but do not assume comprehensive security coverage or mandate it immediately.

**#18 Tom** _(round 2)_ [against]
I remain against an immediate mandatory check. My notes add a caution: on my side project, about 30 percent of Lintwise’s default JavaScript findings were noise. I did not try tuning the rules, so that does not establish what noise we would see in our monorepo or whether configuration would improve it. Lars’s concern about actionable signal is important: our trial should compare default and tuned JavaScript rules and review overlap with existing checks. Elena’s security example supports testing specific useful rules, not making every finding a blocker. I support a non-blocking trial with CI and queue measurements, followed by agreement on which validated rules, if any, should block merges, with ownership and a rollback path.

**#19 Sana** _(round 2)_ [against]
I remain against an immediate mandatory check. My notes show that our pipeline code has no static checks today, and two outages last year came from typos in config keys. That gives us a concrete trial question: can Lintwise detect those mistakes? I have not used it and cannot assume it checks configuration keys or supports our Python and SQL adequately. Priya’s results and Tom’s noise concerns support testing useful findings rather than requiring every default rule. I support a non-blocking monorepo trial that checks pipeline coverage, tests those known failure cases, and measures false positives and CI impact. Any later gate should use validated rules, with clear ownership and the trial and rollback path Jin says our policy requires.
> tl;dr (what later speakers saw in summary mode): Test whether Lintwise catches our actual pipeline failure cases; do not assume coverage or mandate it before validation.

**#20 Lars** _(round 2)_ [against]
I remain against an immediate mandatory check. Tom’s noise concerns support comparing default and tuned rules rather than treating every finding as a blocker. Lintwise’s documentation describes a baseline mode that ignores existing findings and reports only new ones; that could keep a future gate focused, but it does not establish finding quality. In a trial I read about, a tuned rule set had about an 8 percent false-positive rate. That is not a prediction for our monorepo. I support a non-blocking trial reviewing actionable findings, false positives, overlap with existing checks, and CI impact. Sana’s known config-key failures provide concrete cases to test, without assuming Lintwise can detect them. Before requiring any validated rules, we should agree on blocking criteria, ownership, dispute handling, and a rollback path.

**#21 Jin** _(round 2)_ [against]
I remain against the motion as written. Our policy requires a trial and rollback path; we have also reversed two changes after repo-wide rollouts. Marcus’s queue concerns and Tom’s noisy findings reinforce the need to validate both developer-speed impact and finding quality here. The write-ups I reviewed recommend non-blocking warnings first, promoting rules to blocking one at a time, and publishing the false-positive rate. I support that approach on our monorepo, with language-specific cases, default versus tuned rules, and cached versus uncached CI measurements. Before promoting any rule, we should agree on blocking criteria, configuration ownership, dispute handling, acceptable CI impact, and rollback. Those provisions beyond trial and rollback remain unverified in our existing policy.
> tl;dr (what later speakers saw in summary mode): Trial first; promote only validated rules individually, with published false-positive rates and explicit ownership, safeguards, and CI limits.

**#22 Olga** _(round 2)_ [against]
I remain against making Lintwise mandatory now. Style questions take the most time in my reviews, so consistent guidance could help, but I have not used Lintwise. Tom’s noisy JavaScript findings and Lars’s baseline option reinforce that fewer findings do not necessarily mean clearer or better guidance. In a non-blocking trial, we should check whether messages explain what to change and why, and whether recommendations match our agreed conventions. I support Jin’s proposal to promote validated rules individually, after agreeing on ownership, dispute handling, acceptable CI impact, and rollback. Before any rule blocks merges, developers should have documented guidance and know whom to ask about confusing findings.

**#23 Priya** _(objection)_
The motion mandates Lintwise before validating coverage and CI impact; on my previous team, it caught real bugs but added about four minutes to CI.

**#24 Marcus** _(objection)_
The motion mandates Lintwise before validation, without defined CI time limits or evidence of its impact on build time and queue length.

**#25 Elena** _(objection)_
We have not validated Lintwise’s secret-detection rules against our known test-key incident before making it mandatory.

**#26 Tom** _(objection)_
The motion requires Lintwise before we have validated its rules, false-positive rates, and impact on our 11-minute CI builds.

**#27 Sana** _(objection)_
We have not validated whether Lintwise catches our actual pipeline failure cases, which is essential before making it mandatory.

**#28 Lars** _(objection)_
The motion requires adoption before validating rule coverage, false-positive rates, ownership, and CI impact.

**#29 Olga** _(objection)_
The motion still requires Lintwise immediately, without clarifying which validated rules would block merges or who would own them.

**#30 Chair** _(ruling)_
Amended. New wording: The team conducts a non-blocking Lintwise trial on its monorepo, measuring rule coverage, actionable findings, false positives, build time, and queue impact. Any required pre-merge rules require a later decision based on trial results, with explicit ownership, blocking criteria, CI limits, dispute handling, and a rollback path.

**#31 Chair** _(chair reminder)_
Reminder from Elena's full statement: "My notes confirm that Lintwise includes a secret-detection rule set that would have flagged the hard-coded test key that reached main last quarter and had to be rotated."

**#32 Chair** _(chair reminder)_
Reminder from Sana's full statement: "My notes show that our pipeline code has no static checks today, and two outages last year came from typos in config keys."

## Ballots (revealed together at the close)
- Priya: **yes** — The amended motion validates Lintwise’s findings and CI impact through a non-blocking trial before any later decision on required rules and safeguards.
- Marcus: **yes** — The amended motion measures build time and queue impact without blocking merges and requires a later decision with explicit CI limits and a rollback path before any rules become mandatory.
- Elena: **yes** — The non-blocking trial lets us validate secret detection against our known test-key incident without assuming broader security coverage or requiring unvalidated merge gates.
- Tom: **yes** — The non-blocking trial lets us validate JavaScript findings, false positives, and CI impact before deciding whether any rules should block merges.
- Sana: **yes** — The non-blocking trial lets us validate Python and SQL coverage against our pipeline failure cases and measure CI impact before any rules become mandatory.
- Lars: **yes** — The non-blocking trial will measure actionable signal and false positives before any merge gate requires a separate decision with explicit safeguards.
- Jin: **yes** — The amended motion supports a non-blocking trial while reserving mandatory rules for a later evidence-based decision with explicit ownership, CI limits, dispute handling, and rollback.
- Olga: **yes** — The non-blocking trial lets us assess whether Lintwise provides clear guidance consistent with our conventions before any rules become mandatory.

Result: {"yes":8,"no":0,"abstain":0,"quorum":true,"outcome":"passed"}