# Current implementation plan

This is the consolidated October 16 planning baseline, approved by Rob on October 17, 2026. Rob authorized document/task reconciliation and Mac/server/GitHub synchronization. N00 remains the separate implementation execution gate.

- [Approval record](approval.md)
- [Design and contracts](design-proposal.md)
- [Executable task cards](task-plan.md) and [machine-readable DAG](task-plan.json)
- [Status and evidence boundary](finalization-status.md)
- [Paperclip synchronization status](paperclip-sync-status.md)

The four research reports in this directory are historical feasibility evidence, not actual-code qualification. Current design and task ordering supersede older proposals in those reports.

First implementation milestone: build the actual Pi adapter and portable tests (F01/F03/F05/F06), qualify context/cancellation/recovery/compatibility (G02/G03), then build controller storage and orchestration around that verified boundary.
