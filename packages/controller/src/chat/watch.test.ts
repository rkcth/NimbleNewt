import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { Outcome } from "./index.js";
import { cid, openWorld } from "./testing/harness.js";

after(stopServer);

const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });

for (const backend of backends) {
  test(`${backend.name}: the owner sets up a watch in chat by task titles; the stream defaults to the task's own, another task is named by its title and an unclear title asks (card H13f)`, async () => {
    const script: Record<string, unknown> = {};
    const made: Record<string, unknown>[] = [];
    const cancelled: string[] = [];
    let described: { id: string; stream: string; taskId: string; projectId: string }[] = [];
    const stub = { create: async (_p: unknown, c: Record<string, unknown>) => { made.push(c); return { id: `watch-${made.length}`, replayed: false }; }, cancel: async (_p: unknown, c: Record<string, unknown>) => { cancelled.push(String(c["watchId"])); }, list: async () => [], describe: async () => described };
    const w = await openWorld(backend, script, undefined, { watchControl: stub as never });
    try {
      const a = await w.project("A");
      const build = await w.task(a, "Build the login");
      const deploy = await w.task(a, "Deploy the site");
      await w.task(a, "Test");
      await w.task(a, "Test");
      await w.task(a, "Quiet chore");
      const chat = w.chat();
      await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
      w.profile.value = "autonomous";
      const say = async (text: string): Promise<Outcome> => { const o = (await chat.submit(w.ownerToken, { messageId: cid("m"), text })).outcomes; assert.equal(o.length, 1); return o[0]!; };
      script["Watch the Build the login task."] = [cmd("watch.create", { taskTitle: "Build the login" }, "Watch the Build the login task")];
      assert.equal((await say("Watch the Build the login task.")).status, "applied");
      assert.deepEqual([made[0]!["stream"], made[0]!["taskId"]], [`task:${build}`, build]);
      script["Tell the Deploy the site owner when the Build the login task changes."] = [cmd("watch.create", { taskTitle: "Deploy the site", watchedTaskTitle: "Build the login" }, "Tell the Deploy the site owner when the Build the login task changes")];
      assert.equal((await say("Tell the Deploy the site owner when the Build the login task changes.")).status, "applied");
      assert.deepEqual([made[1]!["stream"], made[1]!["taskId"]], [`task:${build}`, deploy]);
      script["Tell the Deploy the site owner when Test changes."] = [cmd("watch.create", { taskTitle: "Deploy the site", watchedTaskTitle: "Test" }, "Tell the Deploy the site owner when Test changes")];
      const asked = await say("Tell the Deploy the site owner when Test changes.");
      assert.equal(asked.status, "asked");
      assert.equal(asked.options!.length, 2);
      script["Watch nothing in particular."] = [cmd("watch.create", {}, "Watch nothing")];
      assert.equal((await say("Watch nothing in particular.")).status, "refused");
      assert.equal(made.length, 2);
      // Ending a watch: found as the one that tells the named task's owner.
      described = [{ id: "watch-1", stream: `task:${build}`, taskId: build, projectId: a }, { id: "watch-2", stream: `task:${deploy}`, taskId: deploy, projectId: a }];
      script["Stop watching for Build the login."] = [cmd("watch.cancel", { taskTitle: "Build the login" }, "Stop watching for Build the login")];
      assert.equal((await say("Stop watching for Build the login.")).status, "applied");
      assert.deepEqual(cancelled, ["watch-1"]);
      script["Stop watching for Quiet chore."] = [cmd("watch.cancel", { taskTitle: "Quiet chore" }, "Stop watching for Quiet chore")];
      assert.equal((await say("Stop watching for Quiet chore.")).status, "refused", "no watch tells that task's owner");
      described.push({ id: "watch-3", stream: `task:${build}`, taskId: build, projectId: a });
      script["Stop watching for Build the login now."] = [cmd("watch.cancel", { taskTitle: "Build the login" }, "Stop watching for Build the login")];
      const two = await say("Stop watching for Build the login now.");
      assert.equal(two.status, "asked");
      assert.deepEqual(two.options!.map((o) => o.split(" ")[0]), ["watch-1", "watch-3"]);
      script["Stop watching, watch-9."] = [cmd("watch.cancel", { watchId: "watch-9" }, "watch-9")];
      assert.equal((await say("Stop watching, watch-9.")).status, "refused", "an ID that is not an active watch");
      // A watch given by ID is shown first (it came from the model, not from the owner's words), and one in another project is not found.
      script["Stop watching, watch-1."] = [cmd("watch.cancel", { watchId: "watch-1" }, "Stop watching, watch-1")];
      const one = await say("Stop watching, watch-1."); assert.equal(one.status, "proposed", JSON.stringify(one).slice(0, 300));
      described.push({ id: "watch-8", stream: "task:x", taskId: deploy, projectId: "prj-other" });
      script["Stop watching, watch-8."] = [cmd("watch.cancel", { watchId: "watch-8" }, "Stop watching, watch-8")];
      assert.equal((await say("Stop watching, watch-8.")).status, "refused");
      assert.equal(cancelled.length, 1);
    } finally { await w.close(); }
  });
}
