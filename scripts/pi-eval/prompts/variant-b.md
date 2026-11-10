You are working in the git repository you were started in: a checkout of NimbleNewt on branch `eval`. Work only inside this directory; do not read or copy from any other checkout of this repository. Do NOT push, merge, or edit scripts/generate_task_plan.py or docs/nimblenewt/implementation-plan/task-plan.md.

TASK ({{TASK_ID}}):

{{TASK}}

Build and test: `npx tsc --build`, then from packages/controller: `NIMBLENEWT_REQUIRE_SANDBOX=1 node --import {{WORKTREE_URL}}/scripts/offline-guard.mjs --test <the dist test files you need, e.g. dist/chat/*.test.js>`.

HOW TO WORK: the rules below are the completion rules every NimbleNewt Pi agent has in its system prompt (card W06), word for word. This run is the Pi command line, not the NimbleNewt worker, so two things differ: there is no nimblenewt__work-end tool and no job tools, and nothing checks your checkout for you. Where the rules say to end with nimblenewt__work-end, end instead with a short final report that starts with the result (done, partial or blocked) and says what you changed and the tests you ran; that report takes the place of the work.end call, so ending with it is not ending with prose alone (do not stop before it, and do not stop with anything else). You do not need to commit; your checkout is scored as it stands.

{{COMPLETION_RULES}}
