# Implementation planning status

October 17, 2026: Rob approved the implementation plan at revision `aaa9f0ddd11d92bfdedbb93fa926f7b9312870de`. See [the approval record](approval.md). Implementation execution remains held at N00. The earlier authorization to reconcile and synchronize documents and task definitions remains in effect.

The current plan uses TypeScript, Pi Durable behind an adapter, SQLite and PostgreSQL controller backends, subordinate remote workers, conversational policy, strong isolation by default and strict approval on a new installation with setup offering the derived profile (changed October 21, 2026), controlled controller promotion and coordinated snapshot backups. Tests must run against actual NimbleNewt code. Earlier probes establish feasibility only.

The 105-card DAG now separates design recording from component implementation, actual-code qualification, integrated fault testing and release acceptance. Implementation has since started on the Pi-first path (see Progress below); until a card is marked implemented in task-plan.json, it is not complete. PostgreSQL failover, combined recovery, cross-OS isolation and full-product release tests remain implementation work. Version pins and OS capabilities are qualified by the implementing cards.

See task-plan.json for canonical dependencies and paperclip-sync-status.md for external tracker status. Synchronizing this plan does not activate workers or authorize deployment.

Pi-first ordering is selected: the real adapter and cross-platform tests precede controller storage/configuration. G02/G03 gate those dependent components; G09 and G04 remain later integrated acceptance. No implementation dispatch occurred as part of this planning update.

## Progress

Updated October 19, 2026 (status is tracked per card in `task-plan.json` and in the README roadmap, generated from the table in `scripts/generate_task_plan.py`):

- **Implemented:** F01 (package boundaries), F03 (portable CI and offline fixtures), F05 (pinned Pi adapter submission contract), F06 (checkpoints and cancellation mapping, delivered in nine reviewed pieces). Each piece was reviewed and approved before commit by a separate AI review session (Claude Opus); this is not a human review, so the plan's independent-review requirement remains for the owner to judge; CI passed on all six platform/Node cells for every commit from F06a onward.
- **Implemented, awaiting sign-off:** G02 (first-milestone acceptance). Its record, [g02-acceptance.md](g02-acceptance.md), lists what is proved, the unsupported capabilities that block dependent work, and the real-hardware QA and owner acceptance still needed.
- **Execution authority:** the work above started on the owner's instruction of October 19, 2026 to begin working on the project. N00's formal scope and budget gate was not separately recorded; treat that as an open item for the owner.
