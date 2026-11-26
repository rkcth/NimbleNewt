{{TASK}}

Work in your checkout ({{WORKTREE}}). Do not edit scripts/generate_task_plan.py or docs/nimblenewt/implementation-plan/task-plan.md. Node.js is /opt/node/bin/node (not on PATH). Build: `/opt/node/bin/node node_modules/typescript/bin/tsc --build`; test from packages/controller: `/opt/node/bin/node --import {{WORKTREE_URL}}/scripts/offline-guard.mjs --test <dist test files>`. When finished, end with a short report of what you changed and the tests you ran.
