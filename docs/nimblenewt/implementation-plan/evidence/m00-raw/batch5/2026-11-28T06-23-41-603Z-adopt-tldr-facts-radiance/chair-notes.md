# Chair's private notes after round 1

**Chair's private notes:**

| Speaker | Key claims / evidence | Gaps / unclear |
|---|---|---|
| Priya | 6 mo Lintwise use; real bugs caught; +4 min CI; recommends changed-files + severity gate | None major |
| Marcus | Queue math: 6-7 stacked builds at 15 min; needs parallel exec + 60s kill-switch | Owns integration; no SQL/TS experience cited |
| Elena | Security severity override needed; timeout-skip must trigger follow-up scan | Who builds the follow-up scan? Separate tool or Lintwise re-run? |
| Tom | 3 mo side-project use; JS ruleset solid; wants generated-file suppression | None major |
| Sana | No Lintwise experience; SQL/Python fit unverified; wants 2-wk trial + per-language override | No one has confirmed SQL ruleset behavior |
| Lars | QA: severity gating + suppression audit with justification line | None major |
| Jin | Policy owner: one gate, one config, no per-dir carve-outs; trial OK, overrides go global | Tension with Sana/Omar's per-language ask—resolved as "global config" but mechanism unclear |
| Olga | New dev; wants readable error messages + rule links + cheat-sheet | None major |
| Ravi | 6 mo Lintwise; 3 real bugs month one; no false-positive blocks seen | Python/Go experience; no SQL/TS |
| Mei | Queue owner: 36% throughput hit if serial; wants parallel, timeout, SRE kill-switch, dashboard wk 1 | Measurement method for queue data unspecified |
| Noah | Security rules un-suppressible AND run even on timeout; separate security dashboard wk 1 | Conflicts with Marcus's "skip on timeout"—who reconciles? |
| Zoe | React side-project; 40+ JSX nits; wants TS/React-hooks trial | No one confirmed TS ruleset handles generics/discriminated unions |
| Omar | SQL/Python fear: DDL formatting, SELECT * false positives; wants trial | No SQL experience with Lintwise at all |
| Hana | Test-dir patterns (duplicated setup, magic numbers) will false-flag; wants trial | None major |
| Ben | Policy owner: consolidated pilot, one config, ratify/revise after | Pilot mechanics (branch? staging? blocking during pilot?) unstated |
| Ida | Newest dev; wants "what to do instead" hint in error messages | None major |
| Kofi | Queue owner: ~90 s marginal cost with parallel+changed-files; ratifies after pilot data | None major |
| Lena | React Native side project; RN pattern false-positive risk | No one confirmed RN ruleset |
| Theo | Release mgr: adopts after consolidated pilot; ratify/revise with queue data | Final authority stated |
| Vera | 6 mo Lintwise; suppression drift in 3 mo if un-audited | None major |

**Open factual questions for the room:**

1. **Timeout vs. security scan conflict.** Marcus's kill-switch says "skip Lintwise on timeout." Noah says security rules must still block on timeout. Is the security scan a *separate* tool/job that runs independently of Lintwise's 60-second budget, or is it a Lintwise sub-scan? Elena's "follow-up secret-scan job before deploy"—is that the same mechanism or a third one? Marcus, Elena, Noah: can you confirm the operational design in one sentence?

2. **SQL and TS/RN ruleset verification.** Sana, Omar, Zoe, Lena all flagged untested language fit. Has anyone in this room actually run Lintwise on `.sql` migration files, TypeScript generics/discriminated unions, or React Native components? If not, the pilot's tuning window is the *first* real test—do we accept that risk, or does someone have a spare afternoon to run a 50-file sample before the pilot starts?

3. **Pilot mechanics.** Ben and Theo describe a consolidated two-week pilot. Concretely: does the pilot run on a feature branch that does *not* block merges, logging findings for review? Or does it gate a subset of PRs in production? Who triggers it, and what's the feedback loop—daily standup notes, a shared doc, a dashboard?

4. **Queue-data methodology.** Mei and Kofi both want queue data to ratify. What exactly do we measure: per-PR wall-clock delta (Lintwise-on vs. Lintwise-off), queue-depth at peak, or both? And over what window—full two weeks, or the last three business days to avoid ramp-up noise?

Let's keep answers to one or two sentences each. Marcus, Elena, Noah—question one first, since it's the one operational conflict still on the table.
