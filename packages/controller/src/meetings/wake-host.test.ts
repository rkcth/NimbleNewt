import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { CommandRunner } from "../domain/runner.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { Principal } from "../security/principals.js";
import type { JsonObject } from "../storage/types.js";
import { MeetingWakeHost, WAKE_LIMITS, type WakeAttender, type WakeHostLifecycle } from "./wake-host.js";

after(stopServer);

// Card M04h: the controller's own meeting wake host, alone, on every storage backend: what it brings in, how many at a time, when it gives up, what it does when a pass is cut off, and how a stop or the end of a meeting is made final.
const by = { id: "service:dispatcher", kind: "service" } as unknown as Principal;
const agentOf = (n: number): string => `agent:agt-${"abcdefghijklmnopqrstuvwxyz234567"[n]!.repeat(20)}`;
const occurrenceOf = (n: number): string => `mto-${"abcdefghijklmnopqrstuvwxyz234567"[n]!.repeat(20)}`;
const idOf = (agent: string): string => agent.slice("agent:".length);

async function world(backend: (typeof backends)[number]) {
  const w = await backend.open();
  const { epoch } = await w.storage.acquireEpoch({ holder: "wake-host-test", at: new Date().toISOString() });
  const runner = new CommandRunner(w.storage, epoch, {});
  let n = 0;
  const put = async (kind: string, id: string, body: JsonObject): Promise<void> => {
    const found = await runner.get(kind, id);
    await runner.command("test.put", { commandId: `put-${++n}`, actor: "test" }, async () => ({ payload: { kind, id, n }, build: async () => {
      const ref = { kind, id };
      return { ref, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref, body } : { type: "update" as const, ref, expectedRevision: found.revision, body }], detail: { kind, id } };
    } }));
  };
  const room = (occ: number, roster: readonly string[], state = "open") => put("meeting-room", derivedId("mrm", occurrenceOf(occ)), { state, roster: [...roster] } as unknown as JsonObject);
  const resting = new Map<string, { state: "stopped" | "suspended"; intentId: string }>();
  const life: WakeHostLifecycle = {
    rest: async (id) => { const r = resting.get(id); return r === undefined ? undefined : { ...r, scope: { kind: "agent", id } }; },
    holds: async (id) => (resting.has(id) ? [{ scope: { kind: "agent", id } }] : []),
  };
  const host = MeetingWakeHost.withEpoch(w.storage, epoch, life);
  const stopAgent = (agent: string, intentId = "stp-1") => { resting.set(idOf(agent), { state: "stopped", intentId }); };
  const wake = async (agent: string, occ: number, key = `${occurrenceOf(occ)}:${agent}:1`) => host.recover({ key, agent, occurrenceId: occurrenceOf(occ), projectId: "proj-aaaaaaaaaaaaaaaaaaaa" });
  return { w, host, room, stopAgent, wake, resting, close: () => w.close() };
}

/** An attendance service that remembers what it was asked; `fail` makes a step refuse once or always. */
function attender() {
  const calls: string[] = [];
  const seats = new Map<string, { state: string; meetingTaskId?: string; left?: boolean }>();
  const fail: Record<string, number | "always" | undefined> = {};
  const gate = (step: string): void => {
    const f = fail[step];
    if (f === "always") throw new DomainError("invalid_command", `${step} refused`);
    if (typeof f === "number" && f > 0) { fail[step] = f - 1; throw new DomainError("invalid_command", `${step} refused once`); }
  };
  const a: WakeAttender = {
    seat: async (_by, occ, agent) => seats.get(`${occ}|${agent}`),
    prepare: async (_by, c) => { calls.push(`prepare ${c.agent}`); gate("prepare"); return {}; },
    join: async (_by, c) => { calls.push(`join ${c.agent}`); gate("join"); const taskId = `task-${idOf(c.agent).slice(4, 24)}`; seats.set(`${c.occurrenceId}|${c.agent}`, { state: "present", meetingTaskId: taskId }); return { joined: true, state: "present", meetingTaskId: taskId }; },
    admit: async (_by, c) => { calls.push(`admit ${c.agent}`); gate("admit"); },
    endWake: async (_by, _occ, agent) => { calls.push(`endWake ${agent}`); gate("endWake"); },
    endAttempt: async (_by, taskId) => { calls.push(`endAttempt ${taskId}`); gate("endAttempt"); },
  };
  return { a, calls, seats, fail, count: (prefix: string) => calls.filter((c) => c.startsWith(prefix)).length };
}

for (const backend of backends) {
  test(`${backend.name}: a woken agent is brought in, at most three a pass and five at a time; the rest wait for a place (card M04h)`, async () => {
    const t = await world(backend);
    try {
      const agents = [0, 1, 2, 3, 4, 5].map(agentOf);
      for (const [i, a] of agents.entries()) { t.stopAgent(a); await t.room(i, [a]); await t.wake(a, i); }
      assert.deepEqual((await t.host.list()).map((w) => w.state), Array(6).fill("waiting"));
      const at = attender();
      assert.deepEqual(await t.host.attend(by, at.a), { attended: 3, waiting: 3, gaveUp: 0, settled: 0 }, "three in the first pass");
      assert.deepEqual(await t.host.attend(by, at.a), { attended: 2, waiting: 1, gaveUp: 0, settled: 0 }, "five attend at once; the sixth waits for a place");
      assert.deepEqual((await t.host.list()).map((w) => w.state).sort(), ["attending", "attending", "attending", "attending", "attending", "waiting"]);
      assert.equal(WAKE_LIMITS.active, 5);
      assert.equal(at.count("admit"), 5, "one attempt asked for per agent, none for the waiting one");
      assert.deepEqual(await t.host.attend(by, at.a), { attended: 0, waiting: 1, gaveUp: 0, settled: 0 }, "nothing is started twice and the sixth still waits");
      // One leaves the room: its attempt is ended, its place goes to the sixth.
      const leaver = (await t.host.list()).find((w) => w.state === "attending")!;
      at.seats.set(`${leaver.occurrenceId}|${leaver.agent}`, { state: "unavailable", meetingTaskId: leaver.meetingTaskId!, left: true });
      const next = await t.host.attend(by, at.a);
      assert.deepEqual(next, { attended: 1, waiting: 0, gaveUp: 0, settled: 1 }, "a leaver is settled in the pass that finds it and its place goes to the one waiting");
      assert.equal(at.count("endAttempt"), 1);
      assert.deepEqual(await t.host.attend(by, at.a), { attended: 0, waiting: 0, gaveUp: 0, settled: 0 });
      assert.equal(at.count("endAttempt"), 1, "settled once");
    } finally { await t.close(); }
  });

  test(`${backend.name}: a wake that cannot be brought in is given up after three passes with the reason, the agent is at rest again and nothing is retried (card M04h)`, async () => {
    const t = await world(backend);
    try {
      const a = agentOf(0), b = agentOf(1);
      t.stopAgent(a); t.stopAgent(b);
      await t.room(0, [a, b]);
      await t.wake(a, 0); await t.wake(b, 0);
      const at = attender();
      at.fail["prepare"] = "always";
      assert.equal(await t.host.availability(a), "available");
      for (let i = 1; i <= WAKE_LIMITS.tries; i++) {
        const r = await t.host.attend(by, at.a);
        assert.equal(r.gaveUp, i === WAKE_LIMITS.tries ? 2 : 0);
      }
      const view = await t.host.list();
      assert.deepEqual(view.map((w) => [w.state, w.tries]), [["gave-up", 3], ["gave-up", 3]]);
      assert.match(view[0]!.reason!, /prepare refused/);
      assert.equal(await t.host.availability(a), "stopped", "given up: the agent reports at rest again");
      const calls = at.calls.length;
      await t.host.attend(by, at.a);
      assert.equal(at.calls.length, calls, "nothing is tried again");
      // A failure that is not the controller's own refusal is said in fixed words, not passed on.
      const c = agentOf(2);
      t.stopAgent(c); await t.room(1, [c]); await t.wake(c, 1);
      const odd = attender();
      odd.a.prepare = async () => { throw new Error("EACCES /home/rob/secret/path"); };
      await t.host.attend(by, odd.a);
      const shown = (await t.host.list()).find((w) => w.agent === c)!;
      assert.equal(shown.reason, "the attendance could not be started");
      // The owner can wake it again: a fresh wake starts from nothing.
      await t.wake(c, 1, `${occurrenceOf(1)}:${c}:2`);
      const again = (await t.host.list()).find((w) => w.agent === c)!;
      assert.deepEqual([again.state, again.tries], ["waiting", 0]);
    } finally { await t.close(); }
  });

  test(`${backend.name}: a pass cut off at any step is finished by the next one: no agent is prepared or joined twice and its attempt is asked for again until it is (card M04h)`, async () => {
    const t = await world(backend);
    try {
      const a = agentOf(0);
      t.stopAgent(a); await t.room(0, [a]); await t.wake(a, 0);
      const at = attender();
      at.fail["admit"] = 1;
      await t.host.attend(by, at.a);
      assert.equal((await t.host.list())[0]!.state, "waiting", "cut off after the join: not yet attending");
      await t.host.attend(by, at.a);
      assert.equal((await t.host.list())[0]!.state, "attending");
      assert.equal(at.count("prepare"), 1);
      assert.equal(at.count("join"), 1, "the seat was already taken, so it is not joined again");
      assert.equal(at.count("admit"), 2);
      // A stop whose settling is cut off at each step is finished too, and only once it has fully succeeded.
      at.fail["endWake"] = 1; at.fail["endAttempt"] = 1;
      await t.host.stop({ occurrenceId: occurrenceOf(0), agent: a, by: "owner:rob" });
      assert.equal(await t.host.availability(a), "stopped", "at rest the moment the stop is recorded");
      assert.deepEqual(await t.host.attend(by, at.a), { attended: 0, waiting: 0, gaveUp: 0, settled: 0 }, "endWake refused");
      assert.deepEqual(await t.host.attend(by, at.a), { attended: 0, waiting: 0, gaveUp: 0, settled: 0 }, "endAttempt refused");
      assert.deepEqual(await t.host.attend(by, at.a), { attended: 0, waiting: 0, gaveUp: 0, settled: 1 });
      assert.deepEqual(await t.host.attend(by, at.a), { attended: 0, waiting: 0, gaveUp: 0, settled: 0 }, "settled once");
      assert.equal((await t.host.list())[0]!.state, "stopped");
      // Stopping again is the same stop; asking for a wake that is not there says so.
      assert.deepEqual(await t.host.stop({ occurrenceId: occurrenceOf(0), agent: a, by: "owner:rob" }), { found: true, attended: true });
      assert.deepEqual(await t.host.stop({ occurrenceId: occurrenceOf(3), agent: a, by: "owner:rob" }), { found: false, attended: false });
    } finally { await t.close(); }
  });

  test(`${backend.name}: a wake counts only for the stop it woke the agent from, only while the room is open, and the end of the meeting ends the attempt (card M04h)`, async () => {
    const t = await world(backend);
    try {
      const a = agentOf(0), b = agentOf(1);
      t.stopAgent(a, "stp-1"); t.stopAgent(b, "stp-1");
      await t.room(0, [a, b]);
      await t.wake(a, 0); await t.wake(b, 0);
      const at = attender();
      await t.host.attend(by, at.a);
      assert.deepEqual((await t.host.list()).map((w) => w.state), ["attending", "attending"]);
      // The owner resumed b and stopped it again: the old wake does not lift the new stop, and nothing more is started for it.
      t.stopAgent(b, "stp-2");
      assert.equal(await t.host.availability(b), "stopped");
      assert.equal(await t.host.availability(a), "available");
      // The meeting ends: both entries are settled (their attempts ended) and the agents are at rest.
      await t.room(0, [a, b], "ended");
      assert.deepEqual(await t.host.list(), []);
      const r = await t.host.attend(by, at.a);
      assert.equal(r.settled, 2);
      assert.equal(at.count("endAttempt"), 2);
      assert.equal(await t.host.availability(a), "stopped");
      // A wake for a room that is already over is refused by the host itself.
      await assert.rejects(() => t.wake(a, 0, `${occurrenceOf(0)}:${a}:2`), /not open/);
    } finally { await t.close(); }
  });

  test(`${backend.name}: a wake whose stop was lifted or replaced is left waiting, and nothing is started for an agent that is not at rest (card M04h)`, async () => {
    const t = await world(backend);
    try {
      const a = agentOf(0);
      t.stopAgent(a, "stp-1"); await t.room(0, [a]); await t.wake(a, 0);
      t.resting.delete(idOf(a));
      const at = attender();
      assert.deepEqual(await t.host.attend(by, at.a), { attended: 0, waiting: 1, gaveUp: 0, settled: 0 });
      assert.deepEqual(at.calls, []);
      assert.equal(await t.host.availability(a), undefined);
    } finally { await t.close(); }
  });
}
