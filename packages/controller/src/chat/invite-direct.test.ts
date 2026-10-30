import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { Outcome } from "./index.js";
import { cid, openWorld } from "./testing/harness.js";

after(stopServer);

const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });

for (const backend of backends) {
  test(`${backend.name}: the owner asks in chat for a named agent to attend a named meeting; names are resolved from the records and anything unclear asks or is refused (card M04f)`, async () => {
    const script: Record<string, unknown> = {};
    const w = await openWorld(backend, script);
    try {
      const a = await w.project("A");
      const ann = await w.agents.create(w.owner, { commandId: cid("ag"), friendlyName: "Ann" });
      const principal = (await w.agents.get(w.owner, ann.id))!.principalId as string;
      const chat = w.chat();
      await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
      w.profile.value = "autonomous";
      const only = (o: readonly Outcome[]): Outcome => { assert.equal(o.length, 1); return o[0]!; };
      const say = async (text: string) => only((await chat.submit(w.ownerToken, { messageId: cid("m"), text })).outcomes);
      const made = await w.meetings.callUrgent(w.owner, { commandId: cid("ug"), projectId: a, title: "Build is red", reason: "Nobody can merge until it is green.", roster: [principal] });
      script["Let Ann attend the build meeting even though she is stopped."] = [cmd("meeting.invite-direct", { meetingTopic: "build", agentName: "Ann" }, "Let Ann attend the build meeting")];
      const done = await say("Let Ann attend the build meeting even though she is stopped.");
      assert.equal(done.op, "meeting.invite-direct");
      assert.equal(done.status, "applied", JSON.stringify(done));
      // Unknown agent or meeting: refused, nothing guessed.
      script["Let Zed attend the build meeting."] = [cmd("meeting.invite-direct", { meetingTopic: "build", agentName: "Zed" }, "Let Zed attend the build meeting")];
      assert.equal((await say("Let Zed attend the build meeting.")).status, "refused");
      script["Let Ann attend the budget meeting."] = [cmd("meeting.invite-direct", { meetingTopic: "budget", agentName: "Ann" }, "Let Ann attend the budget meeting")];
      assert.equal((await say("Let Ann attend the budget meeting.")).status, "refused");
      // No agent named: refused.
      script["Let someone attend the build meeting."] = [cmd("meeting.invite-direct", { meetingTopic: "build" }, "Let someone attend the build meeting")];
      assert.equal((await say("Let someone attend the build meeting.")).status, "refused");
      // The strict profile shows it first instead of doing it.
      w.profile.value = "strict";
      script["Please let Ann attend the build meeting."] = [cmd("meeting.invite-direct", { meetingTopic: "build", agentName: "Ann" }, "let Ann attend the build meeting")];
      const proposed = await say("Please let Ann attend the build meeting.");
      assert.equal(proposed.status, "proposed");
      assert.match(JSON.stringify(proposed), /this meeting only, then the agent is back as it was/);
      void made;
    } finally { await w.close(); }
  });
}
