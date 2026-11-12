import assert from "node:assert/strict";
import { test } from "node:test";
import type { Principal } from "../security/index.js";
import { createMeetingGate, type GateAttendance } from "./meeting-gate.js";

const AGENT = "agent:agt-abcdefghijklmnopqrst";
const p = (kind: string, id: string): Principal => ({ kind, id } as unknown as Principal);
const by = p("service", "service:dispatcher");

function gateWith(over: { meetingOfTask?: GateAttendance["meetingOfTask"]; admission?: GateAttendance["admission"]; ownerOf?: (t: string) => Promise<string | undefined>; noAttendance?: boolean } = {}) {
  const asked: string[] = [];
  const service: GateAttendance = {
    meetingOfTask: over.meetingOfTask ?? (async (t, a) => { asked.push(`in:${t}:${a}`); return undefined; }),
    admission: over.admission ?? (async (_b, q) => { asked.push(`near:${q.agent}`); return {}; }),
  };
  const gate = createMeetingGate({ attendance: () => (over.noAttendance === true ? undefined : { service, by }), ownerOf: over.ownerOf ?? (async () => AGENT) });
  return { gate, asked };
}
const near = { meeting: { occurrenceId: "occ-1", startsAt: "s", endsAt: "e" } };

test("an agent is held to its own meetings; the owner is never held (follow-up to T07)", async () => {
  const w = gateWith({ admission: async () => near });
  assert.match((await w.gate(p("agent", AGENT), "tsk-1")) ?? "", /long-running work is not started/);
  assert.equal(await w.gate(p("owner", "owner:rob"), "tsk-1"), undefined);
  const free = gateWith();
  assert.equal(await free.gate(p("agent", AGENT), "tsk-1"), undefined);
});

test("a host or service credential is held to the meetings of the task's owner agent (it used to skip the gate)", async () => {
  for (const kind of ["service", "host"]) {
    const principal = p(kind, `${kind}:x`);
    const inRoom = gateWith({ meetingOfTask: async (t, a) => (a === AGENT && t === "tsk-1" ? { occurrenceId: "occ-9", endsAt: "e" } : undefined) });
    assert.match((await inRoom.gate(principal, "tsk-1")) ?? "", new RegExp(`${AGENT} is in meeting occ-9`), kind);
    const nearBy = gateWith({ admission: async (_b, q) => (q.agent === AGENT ? near : {}) });
    assert.match((await nearBy.gate(principal, "tsk-1")) ?? "", /attends meeting occ-1/, kind);
    // The task's owner decides whose meeting it is, and a task with no agent owner has none.
    const nobody = gateWith({ ownerOf: async () => undefined, admission: async () => near });
    assert.equal(await nobody.gate(principal, "tsk-1"), undefined, kind);
    assert.deepEqual(nobody.asked, [], "no owner agent: attendance is not even asked");
  }
});

test("a host or service credential fails closed when the task's owner cannot be read, and an agent when the meeting check fails", async () => {
  const unreadable = gateWith({ ownerOf: async () => { throw new Error("store down"); }, admission: async () => near });
  assert.match((await unreadable.gate(p("service", "service:dispatcher"), "tsk-1")) ?? "", /could not be checked/);
  const broken = gateWith({ admission: async () => { throw new Error("store down"); } });
  assert.match((await broken.gate(p("service", "service:dispatcher"), "tsk-1")) ?? "", /could not be checked/);
  assert.match((await broken.gate(p("agent", AGENT), "tsk-1")) ?? "", /could not be checked/);
});

test("no attendance service (no dispatcher) refuses nothing; an owner that is not a controller-made agent is never near a meeting", async () => {
  assert.equal(await gateWith({ noAttendance: true }).gate(p("agent", AGENT), "tsk-1"), undefined);
  const odd = gateWith({ ownerOf: async () => "agent:worker", admission: async () => near });
  assert.equal(await odd.gate(p("service", "service:dispatcher"), "tsk-1"), undefined);
  assert.deepEqual(odd.asked.filter((x) => x.startsWith("near")), []);
});

test("a failed in-meeting check refuses in words that say to try again, for an agent and for a host credential (T07 follow-up review: it escaped as an internal error)", async () => {
  const broken = gateWith({ meetingOfTask: async () => { throw new Error("store down at /var/secret/path"); } });
  for (const who of [p("agent", AGENT), p("host", "host:w1")]) {
    const said = (await broken.gate(who, "tsk-1")) ?? "";
    assert.match(said, /could not be checked.*try again/);
    assert.doesNotMatch(said, /store down|secret/);
  }
});
