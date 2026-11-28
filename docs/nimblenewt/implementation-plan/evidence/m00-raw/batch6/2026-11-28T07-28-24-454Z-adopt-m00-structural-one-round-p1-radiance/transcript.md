# Adopt Lintwise as a required pre-merge check (eight engineers)
Variant: {"name":"m00-structural-one-round-p1","firstRound":"blind","rounds":1,"transcriptMode":"full","promptOrder":"shared-first","chairQuestions":2,"chairQuestionCheck":"structural","deskCheck":true,"tokenLimit":220,"objectionCheck":true,"maxObjectionReruns":2,"parallel":1,"allowTabling":true,"directQuestions":true,"deskRead":true}
Model: qwen3.8-flash-next-iq4r

**#1 Chair** _(opening)_
Motion (version 1): The team adopts Lintwise, an automated code-quality checker, as a required pre-merge check on every repository.

**#2 Priya** _(round 1 (blind))_ [for]
I used Lintwise for six months on my previous team and it genuinely caught bugs we would have shipped otherwise—null dereferences, race-condition patterns, things code review misses. That value is real. My hesitation is the CI cost: it added roughly four minutes to our pipeline. Here, builds already average eleven minutes, so we'd push toward fifteen. For an eight-person team on a single monorepo, that's an extra four minutes per pull request, every pull request. I'm still for the motion because the bugs it catches save more time than those four minutes cost, but I'd ask us to configure it to run in parallel with existing checks rather than serially, and to revisit the rule set quarterly so we don't accumulate noisy warnings that erode trust.
> tl;dr (what later speakers saw in summary mode): Lintwise caught real bugs for me; four extra CI minutes is a fair trade if we run it in parallel.

**#3 Marcus** _(round 1 (blind))_ [undecided]
Our CI builds average 11 minutes, and with eight devs pushing to one monorepo, queue pressure is already real. If Lintwise runs as a serial step before the build, even 90 seconds of added latency pushes every job past the 12-minute mark and lengthens the queue during peak hours. I need two data points before I can commit: first, what is Lintwise's wall-clock runtime on our monorepo, and second, can it run in parallel with compilation rather than gating it? If it can execute concurrently and stays under 60 seconds, I'm on board—catching style and quality issues pre-merge beats debugging a broken build at minute ten. If it's a serial gate over 90 seconds, I'd push back and ask for incremental or per-PR-directory scoping so we don't tax every contributor equally. I'm not opposed to the tool; I'm opposed to an unmeasured pipeline change.
> tl;dr (what later speakers saw in summary mode): Need Lintwise's runtime and parallel-vs-serial placement before endorsing; queue impact on an 11-minute build is my main risk.

**#4 Elena** _(round 1 (blind))_ [for]
I support making Lintwise a required pre-merge gate, but only if it ships with active secret-detection rules—hardcoded API keys, tokens, and credentials must block a merge, not merely warn. Generic code-quality checks alone won't protect us. I also want a dependency-risk rule set that flags newly added packages with known CVEs or low-maintenance signals before they enter the monorepo. My concern is CI time: we already average 11 minutes, and if Lintwise adds more than 90 seconds, developers will start ignoring or bypassing the check, which defeats the purpose. I'd also insist on a suppression policy—any security-rule bypass needs a logged justification and a second reviewer. If those conditions are met, automated enforcement is strictly better than relying on manual review to catch a leaked key at 2 a.m.
> tl;dr (what later speakers saw in summary mode): For the gate, provided secret-detection and dependency rules actually block merges and CI overhead stays under 90 seconds.

**#5 Tom** _(round 1 (blind))_ [undecided]
I ran Lintwise on a personal React project for about three weeks, so I've seen its output. It caught a few real issues—unused imports, inconsistent async patterns, one accessibility attribute I'd missed. That was useful. But my side project was one person, one framework, a few thousand lines. We're eight people in one monorepo. I worry about two things. First, false positives: Lintwise flagged things in my project that were intentional trade-offs, and in a shared repo someone will spend a sprint fighting rules that don't fit their module. Second, timing: our CI already averages eleven minutes. I don't know Lintwise's runtime on a codebase our size, and adding even two or three minutes to every PR loop matters when we're iterating on UI daily. I'm not against it. I'd want a one-week trial on a branch, measure actual added time and false-positive rate, and set up a clear override path before making it a hard gate.
> tl;dr (what later speakers saw in summary mode): Lintwise helped on my side project, but I need trial data on runtime and false positives before endorsing it as a hard merge gate.

**#6 Sana** _(round 1 (blind))_ [undecided]
I haven't run Lintwise on anything, so I can't vouch for it. My concern is specific to my work: data pipelines are heavy SQL with some Python glue. Generic static checkers often flag valid SQL patterns or miss actual pipeline bugs like schema drift. If Lintwise doesn't understand the SQL dialects we use, it becomes noise that slows merges. CI already takes 11 minutes; adding a check that produces false positives on my SQL will push people to bypass it. I'm not opposed in principle—consistent code quality helps—but I want a one-week trial on the data-pipeline directories before making it mandatory. Show me the false-positive rate on our actual SQL and Python, not a demo repo.
> tl;dr (what later speakers saw in summary mode): Undecided until I see Lintwise's false-positive rate on our real SQL and Python pipelines, not a demo.

**#7 Lars** _(round 1 (blind))_ [for]
I've read the Lintwise docs and I'm in favor, with one condition. The static checks catch class of issues—dead code, unreachable branches, type mismatches—that currently slip into our test suite and produce confusing failures. That's a signal win: fewer flaky-adjacent bugs, clearer root-cause work for QA. My concern is noise. The docs list roughly forty rules, some stylistic. If every rule is enforced at merge time, developers will start ignoring the output, and we lose the signal we're trying to protect. My condition: we enable only the correctness-oriented rules for the first quarter, review false-positive rates after two weeks of CI data, then expand. I also want a one-line "why this rule matters" in the failure message so devs fix intent, not just the flag.
> tl;dr (what later speakers saw in summary mode): Support adoption, but gate on correctness-only rules first to protect signal-to-noise.

**#8 Jin** _(round 1 (blind))_ [for]
I'm in favor, with one condition. As the person who owns our merge policy, I've watched style drift creep into the monorepo over the last two sprints. An automated gate stops that without me nagging eight people in review. That said, our CI already runs eleven minutes. If Lintwise adds more than ninety seconds to that pipeline, I will not require it on every PR—developers will simply batch changes and we lose the point. I want a one-week trial where we measure the added latency before we flip the required flag. If it stays under ninety seconds, it's a no-brainer for consistency. If it doesn't, we scope it to changed files only. I'd rather have a fast, partial check than a slow, resented one.
> tl;dr (what later speakers saw in summary mode): Support Lintwise as a required gate only if a one-week trial proves it adds under ninety seconds to our eleven-minute CI.

**#9 Olga** _(round 1 (blind))_ [for]
As someone still learning our conventions, I'd genuinely welcome Lintwise. Right now I often open a PR unsure whether my naming, formatting, or import ordering matches what the team expects, and I rely on a senior dev to catch things in review. A required automated check would give me a clear, objective answer before I even ping anyone. My one concern is the learning curve: I haven't used Lintwise yet, so I'd want a short onboarding doc and a grace period where violations are warnings rather than hard blocks, so I can learn the rules without stalling my PRs. I also hope the config stays simple enough that I can read it and understand *why* a rule exists, not just that it exists. Overall, clearer guardrails help me grow faster.
> tl;dr (what later speakers saw in summary mode): I support Lintwise because automated, explicit rules reduce my guesswork, but I'd ask for a short warning-only grace period.

**#10 Chair** _(fact-finding question)_
To Priya: False-positive rate and rule tuning over six months of Lintwise use (In your six months running Lintwise, roughly what fraction of flagged issues were genuine bugs versus stylistic or intentional-trade-off noise, and how often did you adjust or disable rules to keep the signal-to-noise ratio acceptable for the team?)

**#11 Priya** _(answer to chair)_ [for]
My notes record 3 null-handling bugs caught in the first month—genuine defects we would have shipped. I don't have a logged false-positive percentage. What I do recall: the noise came from stylistic rules flagging intentional patterns, and I recommended quarterly rule-set review specifically to prevent that noise from eroding trust. I'd suggest we start correctness-only, measure two weeks of CI data, then expand rules deliberately.
> tl;dr (what later speakers saw in summary mode): Three real bugs caught first month; noise was stylistic; start correctness-only, review quarterly.

**#12 Chair** _(fact-finding question)_
To Tom: Specific false positives and rule categories encountered in your three-week Lintwise trial (You mentioned Lintwise flagged intentional trade-offs in your React project. Can you recall which rule categories produced those false positives—stylistic, accessibility, async-pattern—and whether you could suppress them per-file or only globally?)

**#13 Tom** _(answer to chair)_ [undecided]
My notes record roughly thirty percent noise in JavaScript files under default rules, but I can't break that down cleanly by category. I recall stylistic and async-pattern flags hitting intentional choices; the one accessibility flag was actually useful. I did not try tuning rules, so I can't speak to per-file versus global suppression. That's a gap I'd want filled before making it mandatory.
> tl;dr (what later speakers saw in summary mode): Thirty percent noise in JS; I didn't tune rules, so suppression granularity is unknown to me.

**#14 Marcus** _(needs time to research)_
I need a measured Lintwise runtime on our actual monorepo and confirmation it runs as a parallel CI job rather than a serial step, because a four-minute serial addition to an eleven-minute build roughly triples queue wait for everyone behind me and that is the single variable that decides whether this gate is tolerable.

**#15 Sana** _(needs time to research)_
I need to run Lintwise against a representative slice of our actual SQL queries and Python pipeline scripts for a short trial to measure its false-positive rate on those languages, because Tom's 30 % noise figure was for JavaScript and no one has reported how Lintwise behaves on SQL or Python, which is the code I own and would be blocked by the gate.

**#16 Chair** _(tabled)_
Motion tabled to the next meeting. Research: Marcus: Measure Lintwise wall-clock runtime on our actual monorepo and confirm whether it can execute as a parallel CI job alongside compilation rather than as a serial pre-build gate. Report the added latency in seconds and whether it stays under the 60-second threshold. | Sana: Run Lintwise against a representative slice of our SQL queries and Python pipeline scripts for a short trial. Report the false-positive rate on those languages specifically, so we can determine whether the JavaScript noise figure (~30 %) generalises or whether SQL/Python need a separate, narrower rule set before the gate is made mandatory.

## Ballots (revealed together at the close)

Result: {"outcome":"tabled","research":["Marcus: Measure Lintwise wall-clock runtime on our actual monorepo and confirm whether it can execute as a parallel CI job alongside compilation rather than as a serial pre-build gate. Report the added latency in seconds and whether it stays under the 60-second threshold.","Sana: Run Lintwise against a representative slice of our SQL queries and Python pipeline scripts for a short trial. Report the false-positive rate on those languages specifically, so we can determine whether the JavaScript noise figure (~30 %) generalises or whether SQL/Python need a separate, narrower rule set before the gate is made mandatory."]}