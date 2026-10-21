import { OPERATIONS, PAGE } from "./operations.js";
import { API_VERSION } from "./state-api.js";

/** The text of `docs/nimblenewt/api-v1.md`. Generated from the operation table; a test fails if the file differs, so the documentation cannot drift. */
export function renderApiDocs(): string {
  const lines: string[] = [
    "# NimbleNewt state API, version 1",
    "",
    "<!-- Generated from packages/controller/src/api/operations.ts by renderApiDocs(); do not edit by hand. Regenerate with `npm run api:docs:write`. -->",
    "",
    "One door to the controller's state for chat, command-line and HTTP clients. A client presents a credential and a request; the API authenticates, scopes every fact to what that principal may see, checks every write, and answers in one envelope. A chat client and an API client holding the same credential see the same facts, because there is no other path.",
    "",
    "## Request",
    "",
    "```json",
    '{ "v": 1, "op": "task.transition", "commandId": "move-7f3a", "args": { "taskId": "task-...", "expectedRevision": 3, "to": "ready" } }',
    "```",
    "",
    `- \`v\` must be ${API_VERSION}. Any other value is refused with \`invalid_command\`.`,
    "- `op` is one of the operations below. `args` holds only that operation's arguments; an unknown one is refused, never ignored. `commandId` and `actor` do not go inside `args`: the caller is the authenticated principal.",
    "- A **query** takes no `commandId`. A **command** requires one.",
    "",
    "## Response",
    "",
    "```json",
    '{ "v": 1, "op": "task.transition", "ok": true, "result": { "id": "task-...", "revision": 4, "replayed": false }, "accepted": true, "completed": true }',
    '{ "v": 1, "op": "task.transition", "ok": false, "error": { "code": "stale_revision", "message": "...", "currentRevision": 5 } }',
    "```",
    "",
    "- **Idempotent writes.** Send the same command again (same `commandId`, same content) and you get the first result with `replayed: true`. Reuse a `commandId` for a different command and you get `command_conflict`.",
    "- **Revisions.** A write names the revision it read. A stale one is `stale_revision` with `currentRevision`: read again and decide again.",
    "- **Accepted is not completed.** `accepted: true` means the command is durably recorded. `completed: true` means its effect is finished (the recorded change is the effect). `completed: false` means someone else must act first; `awaits` says what, and the queries named there show when it has happened. A client must not tell a user that work is done because a command was accepted.",
    `- **Pagination.** A list takes \`limit\` (1 to ${PAGE.max}, default ${PAGE.default}) and \`after\`, and returns \`items\` and, when more may follow, \`next\`: pass it as \`after\` for the next page. A page can hold fewer than \`limit\` items while \`next\` is present.`,
    "- **Errors.** `code` is one of `invalid_command`, `command_conflict`, `stale_revision`, `not_found`, `invalid_transition`, `forbidden`, `unauthenticated`, `unavailable`, and others the operation may name. `field` points at the argument at fault. Something that is not part of this contract is reported as `unavailable` with no detail.",
    "- **Scope.** A principal sees and changes only what its grants allow. A thing it may not read reads exactly like a thing that does not exist.",
    "",
    "## Operations",
    "",
  ];
  for (const kind of ["query", "command"] as const) {
    lines.push(`### ${kind === "query" ? "Queries" : "Commands"}`, "");
    for (const op of OPERATIONS.filter((o) => o.kind === kind)) {
      lines.push(`#### \`${op.name}\``, "", op.summary, "");
      lines.push("Arguments:", "");
      const args = Object.entries(op.args);
      lines.push(...(args.length === 0 ? ["- none"] : args.map(([name, text]) => `- \`${name.replace(/\?$/, "")}\`${name.endsWith("?") ? " (optional)" : ""}: ${text}`)), "");
      lines.push(`Result: ${op.result}`);
      if (op.completion !== undefined) lines.push("", op.completion.kind === "completed" ? "Completion: finished when accepted (`completed: true`)." : `Completion: **deferred** (\`completed: false\`); awaits ${op.completion.awaits}.`);
      lines.push("");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
