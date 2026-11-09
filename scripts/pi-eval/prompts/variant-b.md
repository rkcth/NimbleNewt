You are working in the git repository you were started in: a checkout of NimbleNewt on branch `eval`. Work only inside this directory; do not read or copy from any other checkout of this repository. Do NOT push, merge, or edit scripts/generate_task_plan.py or docs/nimblenewt/implementation-plan/task-plan.md.

TASK ({{TASK_ID}}):

{{TASK}}

Build and test: `npx tsc --build`, then from packages/controller: `NIMBLENEWT_REQUIRE_SANDBOX=1 node --import {{WORKTREE_URL}}/scripts/offline-guard.mjs --test <the dist test files you need, e.g. dist/chat/*.test.js>`.

HOW TO WORK:
1. Before changing any code, write PLAN.md at the repository root: one Markdown checkbox line (`- [ ] ...`) per small step, in order. Keep each step small (one change and its tests). The last step is the full build and test run. Commit PLAN.md.
2. Work the steps in order. After each step, tick its box (`- [x] ...`) and commit the code and PLAN.md together, one commit per step.
3. Do not stop while a box is unchecked. If a step cannot be done, write why under it, tick it, and go on to the next one.
4. When every box is ticked, end with a short report of what you changed and the tests you ran.
