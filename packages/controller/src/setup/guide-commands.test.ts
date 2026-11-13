import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { OPERATION_BY_NAME } from "../api/operations.js";
import { CHAT_OPS } from "../chat/commands.js";
import { ACTIONS } from "../security/access.js";
import { SETUP_GUIDE, SetupReadinessService } from "./index.js";

// Card U14d: "docs/nimblenewt/getting-started.md is updated so every step uses a built command". The guide may name an operation only if the controller has it, and the first-run steps must be
// reachable in chat.
const guide = readFileSync(fileURLToPath(new URL("../../../../docs/nimblenewt/getting-started.md", import.meta.url)), "utf8");
// A grant names an action (`task.read`, `attempt.work`): those are checked against the controller's own list of actions, not taken on trust.
const actions: ReadonlySet<string> = new Set(ACTIONS);
// Dotted names in backticks that are neither operations nor grant actions: configuration keys, files and the configuration service's internal command names (the guide says they have no API
// operation). Each is named here so that a new one has to be looked at. Review: a real operation must never be listed here (it would hide its removal), and the check no longer skips a name whose
// first part is no operation's (a made-up `firstrun.begin` was not looked at before).
const NOT_OPERATIONS: ReadonlySet<string> = new Set(["models.providers", "dispatch.local.build", "controller.storage", "approvals.preset", "public.example.json", "private.example.json", "dispatch.cache.endpoints", "dispatch.local.window", "dispatch.remote.hosts", "first-run.mjs", "config.stage", "config.apply"]);
const known = (name: string): boolean => OPERATION_BY_NAME.has(name) || actions.has(name) || NOT_OPERATIONS.has(name);

test("the list of names that are not operations holds no operation and no grant action", () => {
  for (const name of NOT_OPERATIONS) assert.ok(!OPERATION_BY_NAME.has(name) && !actions.has(name), `${name} is real; check it as such instead of listing it`);
});

test("every command the getting-started guide names in backticks is a built operation (or a listed configuration key)", () => {
  const named = new Set<string>();
  for (const m of guide.matchAll(/`([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+)`/g)) named.add(m[1]!);
  assert.ok(named.size > 20, "the guide's command names were read");
  const missing = [...named].filter((name) => !known(name));
  assert.deepEqual(missing, [], "the guide names a command the controller does not have");
  for (const must of ["setup.readiness", "project.create", "routing.provider.add", "host.local.set", "credential.issue", "notifications.configure", "model-budget.set", "agent.create", "task.create", "grant.create"]) assert.ok(named.has(must), `${must} is part of the first run and the guide should name it`);
});

test("the first-run steps are all reachable by chat, with a plain guide, and each readiness step names only operations that exist", async () => {
  // The chat can do each answer: an operation that is not a chat command cannot be reached by free-form words.
  for (const op of ["project.create", "project.update", "routing.provider.add", "host.local.set", "credential.issue", "notifications.configure", "agent.create", "grant.create", "task.create", "task.assign", "model-budget.set", "budget.open"]) {
    assert.ok(OPERATION_BY_NAME.has(op), `${op} is an operation`);
    assert.ok(CHAT_OPS[op] !== undefined, `${op} is a chat command`);
  }
  // The `how` text of every step: any operation-shaped name in it must be built (read from a fresh view, so a new step is checked too).
  const { MemoryStorage } = await import("../storage/memory.js");
  const { ProjectService } = await import("../domain/service.js");
  const { PrincipalService } = await import("../security/index.js");
  const storage = new MemoryStorage();
  try {
    const projects = await ProjectService.open(storage, { holder: "c1" });
    const principals = PrincipalService.withEpoch(storage, projects.epoch);
    const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
    const view = await SetupReadinessService.withEpoch(storage, projects.epoch).check(owner);
    assert.deepEqual(view.items.map((i) => i.id).sort(), Object.keys(SETUP_GUIDE).sort());
    for (const i of view.items) for (const m of i.how.matchAll(/\b([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+)\b/g)) {
      const name = m[1]!;
      assert.ok(known(name), `${i.id}: "${name}" is not an operation`);
    }
  } finally { await storage.close(); }
});
