# Chair's private notes (rolling)

- **Priya:** Opposes immediate requirement; supports non-blocking trial. Previous team caught three null-handling bugs in month one; reported four-minute default overhead, one minute cached. Measurement method and local impact unknown. **Follow-up:** What trial duration and measurement methods were used?

- **Marcus:** Opposes immediate gating; supports cached/uncached comparisons. Reports peak CI queue waits of six minutes alongside 11-minute average builds. Has not measured Lintwise; Priya’s figures are not local forecasts. **Follow-up:** How would check duration, build time, queue impact, and finding quality be measured separately?

- **Elena:** Supports trial before gating. Notes confirm a secret-detection rule would have flagged last quarter’s hard-coded test key, which required rotation. Broader secrets and dependency coverage unestablished; dependency checks remain necessary. **Follow-up:** What documentation or tests establish coverage, limitations, and language support?

- **Tom:** Supports default-versus-tuned trial before requirement. Side-project notes classify about 30% of default JavaScript findings as noise; no tuning attempted. Local usefulness unknown. Wants blocking criteria and dispute handling. **Follow-up:** How was noise classified? What runtime comparisons were measured?

- **Sana:** Supports non-blocking trial. Reports no static pipeline checks and two outages last year from config-key typos. Has not used Lintwise; typo detection and Python/SQL coverage unknown. **Follow-up:** What tests establish detection and language support? How would pipeline findings be assessed?

- **Lars:** Supports trial before requirement. Baseline mode reports only new findings. Read a trial reporting roughly 8% false positives with tuned rules—not a local forecast. Wants quality, overlap, CI/queue impact, blocking, disputes, and rollback assessed. **Follow-up:** What source and classification methods support that figure? Which checks overlap? What baseline exclusions are documented?

- **Jin:** Merge-policy owner; proposes non-blocking monorepo trial, then rule-by-rule blocking decisions. Says policy requires trial and rollback; two repo-wide changes were reversed. Reviewed write-ups recommend warnings first, gradual blocking, and published false-positive rates. **Follow-up:** Which policy provisions and write-ups support these claims? What procedures exist?

- **Olga:** Supports non-blocking trial and separate rule-by-rule blocking decisions. Says style questions consume most review time; has not used Lintwise. Wants clarity and educational usefulness assessed alongside actionability, false positives, and CI impact. Convention fit remains unknown. Wants documented rules, clarification/challenge procedures, and rollback. **Follow-up:** Which conventions and procedures exist? How would finding clarity and usefulness be assessed?
