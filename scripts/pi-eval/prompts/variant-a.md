You are working in the git repository you were started in: a checkout of NimbleNewt on branch `eval`. Work only inside this directory; do not read or copy from any other checkout of this repository. Do NOT push, merge, or edit scripts/generate_task_plan.py or docs/nimblenewt/implementation-plan/task-plan.md. Commit your work with git.

TASK ({{TASK_ID}}):

{{TASK}}

Build and test: `npx tsc --build`, then from packages/controller: `NIMBLENEWT_REQUIRE_SANDBOX=1 node --import {{WORKTREE_URL}}/scripts/offline-guard.mjs --test <the dist test files you need, e.g. dist/chat/*.test.js>`.

When you are finished, end with a short report of what you changed and the tests you ran.
