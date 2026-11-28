# Chair's private notes (rolling)

**CHAIR'S PRIVATE NOTES — updated after Vera R2**

**Theo R2:** IN. 5% cap dead → Vera weekly hit-rate + per-rule kill in warning window. Hana test-dir disables IN. Noah dep gap → Jin lockfile scan, outside policy. "Write this instead" msgs in. Auto-demote reads CI dashboard. Per-vertical rule-set in single YAML. YAML by Thu. *Q:* reversals specifics; per-vertical def; warning-window duration; auto-demote YAML vs script; msg-content owner; changed-files-only config location.

**Ben R2:** IN. Day-14 vote + hard deadline. Secrets fail-closed d1; lint fail-open 3-min ceiling; auto-demote 14-min median. *Q:* reversals; co-authoring timeline; staging owner.

**Jin:** Tiered timeouts; kill-switch; 14-min median; educational msgs. Lockfile scan outside policy. *Q:* min sample; timeout values; auto-demote mechanism; lockfile owner/timeline.

**Priya:** 4-min full / 1-min cached; 3 null TPs, 0 FPs. *Q:* cold-start; disabled rules re-enabled?

**Marcus:** For; incremental+cache; 3-min fail-open; kill-switch. *Q:* staging provisioned? auto-demote mechanism?

**Elena:** Secrets fail-closed; caught leaked key. *Q:* dep-audit owner/timeline.

**Tom:** 30% noise in 2-3 JS rules; 3 test-dir disables. *Q:* post-tuning FP rate.

**Sana:** SQL/Python defaults worry; 2 outage configs testing. *Q:* SQL-dialect handling; results d7.

**Olga:** IN; wants "write this instead" one-liner. *Q:* doc links; msg-format owner.

**Ravi:** 6 mo: 3 null bugs, 0 FPs; cache confirmed. *Q:* exact rule IDs; dialect-verify owner.

**Mei:** Cached ~1 min; 4-min full breaches 14-min threshold. Auto-demote reads CI dashboard. *Q:* staging; dashboard-integration owner.

**Noah:** Leaked-key validates d1-hard secrets. Requires 3-incident replay before vote. *Q:* replay owner/timeline; who patches miss.

**Zoe R2:** 30% JS noise = tuning gap; co-tuning w/ Tom; 1-min cached removes CI-cost concern. *Q:* FP count post-tuning; tuning completion date.

**Omar R2:** IN. Changed-files-only non-negotiable. Verify Postgres/BigQuery dialects before d14. *Q:* native vs wrapper; dialect-verify owner.

**Hana R2:** IN. Permanent test-dir disables = consensus. Tuned trial ≈ 8% FP. *Q:* test-dir hit-rate report owner; native per-dir scoping.

**Ida R2:** For; mandatory "write this instead." *Request:* intern-facing weekly summary. *Q:* owner; separate artifact or Vera section?

**Kofi R2:** IN. Drops 2-min timeout (11+1=12<14). Has NOT measured Lintwise. *Unclear:* 6-min queue additive vs inside 11-min build. *Q:* staging; who measures combined median.

**Lena R2:** RN; 30% untuned JS noise triangulated. Validates tuned ruleset vs RN fixtures before d14 vote. *Q:* post-tuning FP on her fixtures; per-file-type timeout needed?

**Vera R2:** IN. Weekly per-rule hit-rate + kill authority now Theo's policy. Confirms 4-min full / 1-min cached; CI tax manageable. Agrees FPs concentrated in 2-3 rules → per-rule tuning > blanket cap. Will publish hit-rate as short team-channel note, folding in Ida's intern summary. 6-mo sample: 3 null bugs, 0 FPs; caveats "one team, one codebase." Validates co-tuned ruleset vs SQL + test-dir patterns before d14 vote. Backs Theo YAML, Ben deadline, Hana test-dir, Noah d1 secrets. *Q:* kill threshold for zero-fix rules; SQL/test-dir validation timeline; does "one codebase" caveat weaken generalizability for monorepo?

**Lars:** Demands per-rule hit-rate before vote. Baseline mode ignores pre-existing findings. *Q:* baseline flag owner?

**Follow-ups:** (1) Sana—outage results d7. (2) Kofi+Mei+Ben—staging; 6-min queue additive vs inside. (3) Ravi+Omar—dialect-verify owner. (4) Noah+Elena—3-incident replay owner/timeline. (5) Theo—auto-demote mechanism; dashboard metric source; warning-window duration. (6) Tom+Zoe+Lena—co-tuning validates Hana+Lena fixtures; completion date. (7) Lars—baseline flag owner. (8) Jin—lockfile owner+timeline. (9) Theo+Vera—"write this instead" content owner. (10) Mei—cached latency by d14. (11) Omar—changed-files-only native vs wrapper. (12) Hana+Vera—test-dir hit-rate format (Vera now publishes team-channel note; confirm format covers Hana's need). (13) Ben—reversals; per-vertical def; co-authoring schedule. (14) ~~Vera/Ida intern summary~~ → Vera folds into team-channel note; confirm. (15) Theo—Thu YAML circulate; confirm changed-files-only inclusion. (16) Vera—SQL/test-dir validation timeline; kill threshold.
