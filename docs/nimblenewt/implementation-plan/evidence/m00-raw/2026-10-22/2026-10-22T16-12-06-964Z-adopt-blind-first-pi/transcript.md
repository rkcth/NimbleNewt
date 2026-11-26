# Adopt Lintwise as a required pre-merge check (eight engineers)
Variant: {"name":"blind-first","firstRound":"blind","rounds":2,"transcriptMode":"full","promptOrder":"shared-first","chairQuestions":2,"deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":4}
Model: openai-codex/gpt-6.1-sol

**#1 Chair** _(opening)_
Motion (version 1): The team adopts Lintwise, an automated code-quality checker, as a required pre-merge check on every repository.

**#2 Priya** _(round 1 (blind))_ [against]
I used Lintwise for six months on a previous team. It caught real bugs, but it also added about four minutes to CI. With our builds already averaging 11 minutes, I would not make it a required pre-merge check without measuring its impact here. That previous overhead may not carry over to our monorepo. I support trying it first, then deciding whether the bugs it catches justify the added wait.

**#3 Marcus** _(round 1 (blind))_ [undecided]
Our CI builds already average 11 minutes. I do not have measurements showing how much time Lintwise adds or how it affects the queue, so I cannot support making it a required pre-merge check yet. We maintain one monorepo; I would first run Lintwise there as a non-blocking check and measure its runtime and effect on total CI time and queue length. Those results would let us decide whether a blocking check is practical. My concern is not static checking itself, but making an unmeasured addition mandatory.

**#4 Elena** _(round 1 (blind))_ [undecided]
I cannot support making Lintwise mandatory without knowing whether it detects exposed secrets or risky dependencies. Being a static code-quality checker does not establish either capability. We also lack evidence about false positives and its effect on our current 11-minute CI builds. I propose a nonblocking trial in our monorepo, using controlled test cases rather than real secrets. Before requiring it, we should assess security coverage, actionable findings, runtime, and how exceptions would be reviewed. Lintwise should not be treated as a replacement for secrets or dependency checks unless its capabilities justify that.

**#5 Tom** _(round 1 (blind))_ [against]
I’ve tried Lintwise on a side project, but that alone doesn’t establish that it should block merges in our monorepo. I write most of our JavaScript and want useful quality checks, but our CI already averages 11 minutes. We haven’t established Lintwise’s added runtime, how actionable its findings are here, or which rules should block a merge. I’d support a non-blocking trial, followed by a decision on a small set of blocking rules based on the results. I’m against making it required now.

**#6 Sana** _(round 1 (blind))_ [undecided]
I maintain our Python and SQL data pipelines, and I have not used Lintwise. I need evidence that it checks both languages usefully before supporting a required pre-merge gate. Our CI already averages 11 minutes, so added runtime matters. I propose a non-blocking trial in our monorepo to measure runtime, actionable findings, and false positives. We should also check whether existing code would require cleanup and agree on how exceptions work. If the trial shows useful coverage with acceptable overhead, I would support making it required.

**#7 Lars** _(round 1 (blind))_ [undecided]
I support automated quality checks when their results are actionable and low-noise, but I cannot yet support making Lintwise mandatory. The information available here does not establish its false-positive rate, runtime overhead, or suitability for our monorepo. Our CI already averages 11 minutes; we should measure the added delay rather than assume it is negligible. I propose running Lintwise without blocking merges first, reviewing findings for usefulness, and agreeing on which rules warrant blocking. We should also define how developers handle disputed findings. A required check should provide a trustworthy signal, not merely another hurdle.

**#8 Jin** _(round 1 (blind))_ [against]
I support consistent code-quality checks, but not a mandatory merge gate before we understand its impact. Our eight-person team maintains one monorepo, and CI already averages 11 minutes. We have no evidence here about Lintwise’s added runtime, finding quality, or fit with our codebase. I propose running it without blocking merges first, reviewing its findings, and measuring the additional CI time. We can then define which findings should block merges, how existing violations are handled, and who can approve exceptions. I would support a revised motion requiring agreed checks in our monorepo once that evaluation shows useful results at an acceptable cost to developer speed.

**#9 Olga** _(round 1 (blind))_ [undecided]
As someone newer to the team, I would welcome clear, consistent code-style guidance. But I have not used Lintwise, so I cannot yet support making it a required pre-merge check. Our CI already averages 11 minutes, and I do not know how much time this would add or whether its findings would be useful. I suggest trying it in our monorepo without blocking merges first. We should review its feedback, agree on rules, and document how to fix or handle findings before making it mandatory.

**#10 Chair** _(fact-finding question)_
To Priya: Prior Lintwise findings and CI overhead (What kinds of real bugs did Lintwise catch on your previous team, and how was the approximately four-minute CI increase measured?)

**#11 Priya** _(answer to chair)_ [against]
On my previous team, Lintwise caught three null-handling bugs in its first month. My notes record about four minutes of added CI time with the default run, dropping to about one minute with its result cache enabled. They do not record how that overhead was measured, so I cannot describe the measurement method. I still favor a non-blocking trial here before making it mandatory.

**#12 Chair** _(fact-finding question)_
To Tom: Side-project findings and configuration (On your side project, which languages and rules did you use with Lintwise, and what useful or false-positive findings did you observe?)

**#13 Tom** _(answer to chair)_ [against]
On my side project, I used Lintwise’s default rules on JavaScript files. My notes record about 30 percent noise in the findings. I did not try tuning the rules, and I have no specific useful findings or false-positive examples documented to share. That experience does not establish how it would perform in our monorepo.

**#14 Priya** _(round 2)_ [against]
I remain against the motion as written. Marcus’s concern about unmeasured CI impact and Tom’s report of noisy findings reinforce the case for a non-blocking trial in our monorepo. My previous team’s results show potential value: Lintwise caught three null-handling bugs in its first month. My notes also show about four minutes of added CI time by default, dropping to about one minute with caching, but they do not document the measurement method. Neither result establishes what will happen here. We should compare cached and uncached runs, review actionable findings and false positives across our languages, and agree on blocking rules and exceptions before requiring it.

**#15 Marcus** _(round 2)_ [against]
I remain against making Lintwise mandatory now. My notes show peak CI queue waits are already six minutes, alongside our 11-minute average builds. I have not measured Lintwise myself. Priya’s reported improvement with caching is worth testing, but her previous team’s timings do not establish our overhead. Tom’s reported noise also supports evaluating findings before they block merges. I support a non-blocking trial in our monorepo, comparing cached and uncached runs and measuring added runtime, total CI time, and peak queue wait. Before adopting a gate, we should review finding quality across our languages and agree on blocking rules, acceptable CI impact, and exception handling.

**#16 Elena** _(round 2)_ [against]
I can now resolve one uncertainty from my earlier statement: my notes confirm that Lintwise includes secret-detection rules that would have flagged the hard-coded test key that reached main last quarter and required rotation. That is concrete evidence of relevant security value, but it does not establish dependency-risk coverage or justify requiring every check. Priya’s caching results and Tom’s reported noise reinforce the need to test configuration here. I support a non-blocking monorepo trial using controlled secret test cases, reviewing false positives and measuring cached and uncached CI impact, including queue waits. We should consider validated secret-detection rules separately from broader code-quality rules and define exception review before making either mandatory.

**#17 Tom** _(round 2)_ [against]
I remain against the motion as written. Elena’s notes give us a reason to test secret-detection rules separately, not to make all Lintwise checks mandatory. My side-project notes record about 30 percent noise with default JavaScript rules; I did not tune them, so that is not evidence that tuned rules would be equally noisy here. I support a non-blocking trial in our monorepo, reviewing JavaScript findings alongside coverage for our other languages. Priya’s caching results are worth testing, while Marcus’s queue concerns mean we should measure more than checker runtime. Before requiring a gate, we should agree on useful blocking rules, acceptable CI impact, and how disputed findings are handled.

**#18 Sana** _(round 2)_ [against]
I remain against the motion as written. My notes show that our data pipelines have no static checks today, and two outages last year came from typos in config keys. That gives us a concrete failure mode to test, not evidence that Lintwise would catch it. I have not used Lintwise and still need to establish its usefulness for Python and SQL. Elena’s security findings support evaluating specific rules separately; Tom’s noise report cautions against requiring defaults wholesale. I support a non-blocking monorepo trial with controlled config-key errors, review of actionable findings and false positives, and cached versus uncached CI measurements, including queue waits. Before making checks mandatory, we should agree on blocking rules, acceptable overhead, and exception handling.

**#19 Lars** _(round 2)_ [against]
I remain against the motion as written. Tom’s reported noise makes rule tuning important, but it does not establish how tuned checks would perform here. A trial I read about reported about 8 percent false positives with a tuned rule set; that is encouraging, not a prediction for our monorepo. Lintwise’s documentation also describes baseline mode, which ignores existing findings and reports only new ones. That could address Jin’s and Sana’s concerns about existing violations, though it would leave those findings unresolved. I support a non-blocking trial that reviews finding quality across our languages, tests the specific security and config failures raised, and measures cached and uncached CI impact, including queue waits. Before requiring any rules, we should agree on acceptable noise, blocking criteria, and disputed-finding review.

**#20 Jin** _(round 2)_ [against]
I remain against the motion as written. Our merge policy changes require a trial period and a rollback path. My notes also record two policy changes reversed because they were rolled out repo-wide at once. That argues against making Lintwise mandatory everywhere now. Elena’s security evidence and Sana’s config failures give us specific cases to evaluate; neither establishes that all rules should block merges. Lars’s baseline-mode point could help avoid an immediate cleanup burden, but existing findings would remain. I support a non-blocking monorepo trial measuring finding quality, language coverage, cached and uncached runtime, and queue impact. Before introducing selected blocking rules, we should agree on acceptance criteria, exception authority, and a rollback procedure. Any later expansion should depend on evidence from the initial gate.

**#21 Olga** _(round 2)_ [against]
I remain against the motion as written and support a non-blocking trial. My notes say style questions take the most time in my reviews, so consistent guidance could help me as someone newer to the team. But I have not used Lintwise, and Tom’s noise report makes me cautious about treating every finding as authoritative. Alongside the runtime and coverage measurements others proposed, we should assess whether findings clearly explain the problem and how to fix it. Lars’s baseline-mode point could reduce the initial cleanup burden, but we would still need documented rules and a way to question confusing findings. I support Jin’s requirement for acceptance criteria and a rollback path before selected checks become mandatory.

**#22 Priya** _(objection)_
The motion still mandates Lintwise immediately, while our discussion favors a non-blocking trial to measure its value, noise, and CI impact first.

**#23 Jin** _(objection)_
The motion still mandates Lintwise immediately rather than reflecting our proposed non-blocking trial followed by gradually requiring validated rules.

**#24 Chair** _(ruling)_
Amended. New wording: The team runs a non-blocking Lintwise trial in its monorepo to assess language coverage, finding quality, and cached and uncached CI impact, including queue waits; selected rules may become required only after review and agreement on acceptance criteria, exception authority, and a rollback procedure.

## Ballots (revealed together at the close)
- Priya: **yes** — The amended motion measures Lintwise’s value and CI impact here without blocking merges and requires agreed safeguards before selected rules become mandatory.
- Marcus: **yes** — The amended motion measures cached and uncached CI impact, including queue waits, without blocking merges and requires agreed criteria and a rollback procedure before selected rules become mandatory.
- Elena: **yes** — The non-blocking trial lets us validate secret-detection rules without assuming dependency-risk coverage, while requiring agreed criteria, exception authority, and rollback before any rules become mandatory.
- Tom: **yes** — The non-blocking trial lets us evaluate JavaScript finding quality and CI impact before requiring selected rules under agreed criteria, exception authority, and a rollback procedure.
- Sana: **yes** — The non-blocking trial will assess usefulness for our Python and SQL pipelines and CI impact before any rules become required under agreed safeguards.
- Lars: **yes** — The amended motion tests finding quality and CI impact without blocking merges, and requires agreed acceptance criteria, exception authority, and rollback before selected rules become mandatory.
- Jin: **yes** — The amended motion measures value and developer impact before requiring selected rules, with agreed acceptance criteria, exception authority, and a rollback procedure.
- Olga: **yes** — The non-blocking trial lets us assess whether findings provide clear, useful guidance before requiring selected rules under agreed criteria, exception authority, and a rollback procedure.

Result: {"yes":8,"no":0,"abstain":0,"quorum":true,"outcome":"passed"}