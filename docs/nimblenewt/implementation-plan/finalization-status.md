# Implementation planning status

October 16, 2026: Rob authorized reconciliation and synchronization of documents and task definitions. Implementation execution remains held at N00.

The current plan uses TypeScript, Pi Durable behind an adapter, SQLite and PostgreSQL controller backends, subordinate remote workers, conversational policy, tight public isolation/approval defaults, controlled controller promotion and coordinated snapshot backups. Tests must run against actual NimbleNewt code. Earlier probes establish feasibility only.

The 105-card DAG now separates design recording from component implementation, actual-code qualification, integrated fault testing and release acceptance. No implementation feature is marked complete. PostgreSQL failover, combined recovery, cross-OS isolation and full-product release tests remain implementation work. Version pins and OS capabilities are qualified by the implementing cards.

See task-plan.json for canonical dependencies and paperclip-sync-status.md for external tracker status. Synchronizing this plan does not activate workers or authorize deployment.
