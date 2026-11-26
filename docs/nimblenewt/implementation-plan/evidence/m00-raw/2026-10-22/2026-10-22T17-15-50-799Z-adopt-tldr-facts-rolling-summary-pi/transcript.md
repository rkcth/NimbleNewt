# Adopt Lintwise as a required pre-merge check (eight engineers)
Variant: {"name":"tldr-facts-rolling-summary","firstRound":"open","rounds":2,"transcriptMode":"tldr","fullTail":1,"promptOrder":"shared-first","chairQuestions":2,"deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":4,"tldrStyle":"facts","summaryWords":60,"summarizeAbove":70,"chairNotes":"rolling","chairReminders":2,"chairSummary":true}
Model: openai-codex/gpt-6.1-sol

**#1 Chair** _(opening)_
Motion (version 1): The team adopts Lintwise, an automated code-quality checker, as a required pre-merge check on every repository.

**#2 Priya** _(round 1)_ [against]
I oppose the motion as written. I used Lintwise for six months on a previous team: it caught real bugs, but added about four minutes to CI. Our builds already average 11 minutes; we should measure its impact here rather than assume the same overhead or benefit. I support a non-blocking trial in our monorepo before making it a required pre-merge check.

**#3 Marcus** _(round 1)_ [against]
I oppose requiring Lintwise before we have measurements from our monorepo. Our CI builds already average 11 minutes, and I don’t yet know what Lintwise would add to runtime or queue length here. I support a non-blocking trial, measuring check duration, overall build time, queue impact, and whether findings are actionable. We can then decide whether its benefits justify making it a merge gate. The motion should also refer to our monorepo rather than “every repository.”

**#4 Elena** _(round 1)_ [against]
I oppose the motion as written and support a non-blocking trial in our monorepo. From a security perspective, we have not established whether Lintwise detects exposed secrets or dependency risks; being a static code-quality checker does not establish that coverage. The trial should measure actionable findings and CI impact, and clarify which security risks it does and does not address. We should not treat adoption as a substitute for secrets or dependency checks.

**#5 Tom** _(round 1)_ [against]
I oppose making Lintwise a required merge gate now. I’ve tried it on a side project, but that alone does not establish how useful it would be for our monorepo. As the person writing most of our JavaScript, I support a non-blocking trial that checks whether its JavaScript findings are actionable and measures its effect on our current 11-minute CI builds. We should review those results before requiring it, and amend the motion to refer to our monorepo.

**#6 Sana** _(round 1)_ [against]
I oppose making Lintwise a required pre-merge check now. I maintain our data pipelines, mostly Python and SQL, and have not used Lintwise. We have not established whether it supports those languages well or produces actionable findings for our pipelines. I support a non-blocking trial in our monorepo to assess that coverage and measure its impact on our current 11-minute CI builds before deciding whether to make it required.

**#7 Lars** _(round 1)_ [against]
I oppose requiring Lintwise now and support a non-blocking trial in our monorepo. As QA lead, I want evidence that its findings provide useful signal without excessive noise. Reading its documentation does not establish how well it will perform on our code. The trial should assess actionable findings, false positives, overlap with existing checks, and CI impact. Before making it a merge gate, we should agree which findings warrant blocking and how disputed findings will be handled.

**#8 Jin** _(round 1)_ [against]
I oppose the motion as written. As tech lead and merge-policy owner, I want consistent checks without imposing an unmeasured cost on developer speed. Our CI already averages 11 minutes. I support amending the motion to authorize a non-blocking trial in our monorepo, followed by a decision based on actionable findings, language coverage, false positives, and CI impact. Before making any findings blocking, we should agree on blocking rules and a process for disputed findings and exceptions. Consistency is valuable, but it does not require making an unproven check mandatory.

**#9 Olga** _(round 1)_ [against]
I oppose requiring Lintwise before we try it in our monorepo. I have not used it. As a newer developer, I would welcome clear, consistent guidance on code style, but we have not established whether its findings match our team’s conventions. I support a non-blocking trial to assess that fit, actionable findings, and CI impact. Before making it mandatory, we should document which rules apply and how to ask for clarification or challenge a finding.

**#10 Chair** _(fact-finding question)_
To Priya: Previously observed bugs and CI overhead (Which real bugs did Lintwise catch on your previous team, and how was the roughly four-minute CI increase measured?)

**#11 Priya** _(answer to chair)_ [against]
On my previous team, Lintwise caught three null-handling bugs in its first month. My notes record about four minutes added to CI with the default run, dropping to about one minute with its result cache enabled. I don’t have the measurement method in my notes, so I can’t explain how that increase was measured. I still support a non-blocking trial here before requiring it.

**#12 Chair** _(fact-finding question)_
To Jin: Existing merge-policy procedures (What existing procedures govern blocking checks, disputed findings, and exceptions in our monorepo?)

**#13 Jin** _(answer to chair)_ [against]
Our merge policy requires a trial period and a rollback path for changes to blocking checks. We have reversed two policy changes because they were rolled out repo-wide at once. My notes do not establish existing procedures for disputed findings or exceptions, so I cannot confirm those. We should clarify them before making Lintwise blocking.

**#14 Chair** _(chair summary)_
Chair's summary of round 1:
- (repeated; Priya, Marcus, Elena, Tom, Sana, Lars, Jin, Olga) All eight speakers oppose requiring Lintwise now and support a non-blocking trial in the monorepo. No speaker defended immediate mandatory adoption.
- (repeated; Priya, Marcus, Tom, Sana, Lars, Jin) Several speakers want local evidence on actionable findings and CI impact before deciding on a merge gate. Marcus also identified queue impact; Lars identified false positives and overlap with existing checks.
- (repeated; Priya) Priya reported three null-handling bugs caught on her previous team and about four added CI minutes by default, reduced to about one with caching. The measurement method is unavailable, and the impact here remains unknown.
- (repeated; Tom, Sana, Olga) Coverage and fit remain unestablished: speakers raised JavaScript usefulness, Python and SQL support, and alignment with team conventions.
- (omitted; Elena) Elena cautioned that static code-quality checking does not establish secrets or dependency-risk coverage, and adoption should not substitute for those checks. — from the full statement: "We should not treat adoption as a substitute for secrets or dependency checks."
- (repeated; Jin, Lars, Olga) Jin confirmed that blocking-check changes require a trial and rollback path, citing two reversed repo-wide policy changes. Several speakers want blocking rules and clarification, dispute, or exception procedures established; existing dispute and exception procedures remain unconfirmed.

**#15 Priya** _(round 2)_ [against]
I remain against the motion as written. Jin’s confirmation that blocking-check changes require a trial and rollback path reinforces the case for a non-blocking trial in our monorepo. My previous team’s results suggest potential value: three null-handling bugs caught in the first month. But the reported CI overhead—about four minutes by default, about one with caching—does not predict our results, and my notes lack the measurement method. We should measure local runtime with and without caching, actionable findings, and false positives, then review the results before deciding on blocking rules and a rollback path.

**#16 Marcus** _(round 2)_ [against]
I remain against immediate mandatory adoption. My notes add that CI queue wait already reaches six minutes at peak, alongside our 11-minute average builds. A trial should measure queue wait as well as check duration and overall build time. I have not measured Lintwise myself; Priya’s reported overhead, including the improvement with caching, is not a forecast for our pipeline. I support a non-blocking trial in our monorepo, comparing runs with and without caching and reviewing actionable findings and false positives. Jin’s confirmed requirement for a trial and rollback path should govern any later proposal to make it blocking.

**#17 Elena** _(round 2)_ [against]
I remain against immediate mandatory adoption, but I can now clarify my earlier uncertainty about secrets coverage. My notes confirm that Lintwise includes a secret-detection rule set that would have flagged the hard-coded test key that reached main last quarter and had to be rotated. That gives us a concrete reason to evaluate it, not proof of comprehensive secrets coverage. Dependency-risk coverage remains unestablished. I support a non-blocking trial in our monorepo that evaluates secret findings and false positives alongside language coverage, runtime, and queue impact. Any later blocking proposal should follow our required trial and rollback path and clarify blocking rules and exceptions. Lintwise should not be treated as a substitute for dependency checks.
> tl;dr (what later speakers saw in summary mode): Lintwise would have flagged our previous test-key incident, but that supports a trial—not immediate mandatory adoption or assumptions about broader security coverage.

**#18 Tom** _(round 2)_ [against]
I remain against requiring Lintwise now. My side-project notes add a caution: with default rules, about 30 percent of its JavaScript findings were noise. I did not try tuning the rules, so that does not establish how useful it would be with our configuration or in our monorepo. Elena’s secret-detection example gives us another concrete reason to trial it, but does not resolve JavaScript signal quality. I support a non-blocking trial comparing default and tuned rules, assessing actionable findings and false positives, and measuring runtime and queue impact. Any later merge gate should follow our required trial and rollback path, with clear blocking rules and a way to dispute findings.
> tl;dr (what later speakers saw in summary mode): Trial first: my side project had about 30 percent noise under default JavaScript rules; tuning and monorepo performance remain untested.

**#19 Sana** _(round 2)_ [against]
I remain against requiring Lintwise now and support a non-blocking trial in our monorepo. My notes say our data pipelines have no static checks today, and two outages last year came from typos in config keys. That identifies a gap worth investigating, but I have not used Lintwise and do not know whether it could detect those errors. The trial should test that explicitly, alongside Python and SQL coverage and actionable findings. Tom’s JavaScript experience reinforces the need to assess noise separately for our pipeline code rather than generalize across languages. We should also measure runtime and queue impact, then follow our required trial and rollback process before making any check blocking.

**#20 Lars** _(round 2)_ [against]
I remain against immediate mandatory adoption and support a non-blocking trial in our monorepo. Tom’s reported JavaScript noise reinforces the need to measure signal separately across our code. My notes say Lintwise has a baseline mode that ignores existing findings and reports only new ones. That could help focus the trial, but would leave existing findings outside that assessment. A trial I read about reported roughly 8 percent false positives with tuned rules; that is not a prediction for our monorepo. We should assess actionable findings, false positives, overlap with existing checks, and CI and queue impact. Before making it blocking, we should define blocking rules, disputed-finding procedures, and a rollback path.
> tl;dr (what later speakers saw in summary mode): Trial first; baseline mode and tuned rules may help, but their usefulness and noise levels need local measurement.

**#21 Jin** _(round 2)_ [against]
I remain against the motion as written. The reported benefits justify a trial, but the language-specific noise and unknown CI and queue costs argue against immediate blocking. Our merge policy requires a trial and rollback path; two previous repo-wide policy changes were reversed. The write-ups I reviewed recommend non-blocking warnings first, promoting rules to blocking one at a time, and publishing false-positive rates. I support amending the motion to authorize a non-blocking trial in our monorepo. We should review actionable findings, coverage, noise, and CI impact, then separately decide which rules merit blocking. Before that promotion, we should document dispute and exception procedures and a rollback path. Baseline mode may help isolate new findings, but we should clearly report what it excludes.
> tl;dr (what later speakers saw in summary mode): Trial first; consider blocking rules individually only after reviewing local evidence and documenting safeguards.

**#22 Olga** _(round 2)_ [against]
I remain against requiring Lintwise now and support a non-blocking trial in our monorepo. Style questions take the most time in my reviews, so consistent guidance could help me, but I have not used Lintwise. Tom’s reported noise makes clear messages and agreement on our conventions especially important. The trial should assess whether findings explain the issue clearly and help developers understand the applicable rule, alongside actionable findings, false positives, and CI impact. I support Jin’s proposal to decide separately which rules merit blocking. Before that, we should document the rules, how to ask for clarification or challenge a finding, and the rollback path required by our merge policy.

**#23 Chair** _(chair reminder)_
Reminder from Lars's full statement: "My notes say Lintwise has a baseline mode that ignores existing findings and reports only new ones."

**#24 Chair** _(chair reminder)_
Reminder from Elena's full statement: "My notes confirm that Lintwise includes a secret-detection rule set that would have flagged the hard-coded test key that reached main last quarter and had to be rotated."

## Ballots (revealed together at the close)
- Priya: **no** — Requiring Lintwise now would bypass our required trial; I support a non-blocking monorepo trial to measure actionable findings and CI impact first.
- Marcus: **no** — The motion still requires immediate adoption without the trial our merge policy requires or local measurements of build-time and queue impact.
- Elena: **no** — Its secret-detection rules support a non-blocking trial in our monorepo, not immediate mandatory adoption without local measurements and the required rollback path.
- Tom: **no** — My side-project JavaScript findings had about 30 percent noise under default rules, so I support a non-blocking monorepo trial before requiring Lintwise.
- Sana: **no** — We should first run a non-blocking trial in our monorepo to establish Python and SQL coverage, actionable findings, and CI impact before requiring Lintwise.
- Lars: **no** — I support a non-blocking trial in our monorepo to measure actionable findings, false positives, and CI impact before requiring Lintwise as a merge gate.
- Jin: **no** — The motion requires immediate blocking adoption without the trial and rollback path our merge policy requires.
- Olga: **no** — I support a non-blocking trial in our monorepo to assess clarity, fit with our code-style conventions, and CI impact before requiring Lintwise.

Result: {"yes":0,"no":8,"abstain":0,"quorum":true,"outcome":"failed (ties fail)"}