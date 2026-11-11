import assert from "node:assert/strict";
import { test } from "node:test";
import { relayMonitor } from "./relay-monitor.js";
import type { StallEvent } from "../health/index.js";

// Card L05e: a monitor made again for the same attempt (a controller restarted while a remote attempt went on) does not replay the command IDs of the monitor before it.
type Reporter = Parameters<typeof relayMonitor>[1];
/** A reporter that does what the command runner does with a command ID it has seen: it answers the first report again and records nothing new. */
function recorder() {
  const seen = new Set<string>();
  const recorded: { commandId: string; event: StallEvent }[] = [];
  const reporter: Reporter = async (c) => { if (seen.has(c.commandId)) return { id: "x", revision: 1, replayed: true }; seen.add(c.commandId); recorded.push({ commandId: c.commandId, event: c.event }); return { id: "x", revision: 1, replayed: false }; };
  return { reporter, recorded };
}
const ATTEMPT = { attemptId: "att-aaaaaaaaaaaaaaaaaaaa", taskId: "task-aaaaaaaaaaaaaaaaaaaa", generation: 1, route: "" };
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

test("a second monitor for the same attempt reports with command IDs of its own: its first reports are recorded, not taken for replays of the first monitor's (card L05e)", async () => {
  const { reporter, recorded } = recorder();
  const before = relayMonitor(ATTEMPT, reporter);
  const call = before.started({ requestChars: 300 });
  call.firstOutput?.();
  call.finished?.({ ok: true } as never);
  await settle();
  assert.deepEqual(recorded.map((r) => r.event.type), ["request_started", "first_output", "request_finished"]);
  // The controller restarted: the remote attempt goes on and a new monitor is made for it.
  const after = relayMonitor(ATTEMPT, reporter);
  const next = after.started({ requestChars: 300 });
  next.firstOutput?.();
  next.finished?.({ ok: true } as never);
  await settle();
  assert.deepEqual(recorded.map((r) => r.event.type), ["request_started", "first_output", "request_finished", "request_started", "first_output", "request_finished"], "every report of the second monitor was recorded");
  assert.equal(new Set(recorded.map((r) => r.commandId)).size, 6, "no command ID is used twice");
  assert.equal((recorded[0]!.event as { requestId?: string }).requestId, `${ATTEMPT.attemptId}:1`, "the request ID keeps its form");
});

test("within one monitor the reports go in order, and the request names the route and host when the attempt has them (card L05e)", async () => {
  const { reporter, recorded } = recorder();
  const m = relayMonitor({ ...ATTEMPT, route: "localp/small", hostId: "host:r1" }, reporter);
  const call = m.started({ requestChars: 30 });
  call.firstOutput?.();
  call.progress?.(90);
  call.finished?.({ ok: true, inputTokens: 10, outputTokens: 5 } as never);
  await settle();
  assert.deepEqual(recorded.map((r) => r.event.type), ["request_started", "first_output", "output_progress", "request_finished"]);
  assert.match(recorded[0]!.commandId, /^relay:att-aaaaaaaaaaaaaaaaaaaa:[0-9a-f]{8}:1$/);
  assert.match(recorded[3]!.commandId, /:4$/);
  const started = recorded[0]!.event as { route?: string; hostId?: string; promptTokens?: number };
  assert.equal(started.route, "localp/small");
  assert.equal(started.hostId, "host:r1");
  assert.equal(started.promptTokens, 10);
  // A local attempt names neither host nor (here) route.
  const local = recorder();
  relayMonitor(ATTEMPT, local.reporter).started({ requestChars: 3 });
  await settle();
  const plain = local.recorded[0]!.event as { route?: string; hostId?: string };
  assert.equal("route" in plain, false);
  assert.equal("hostId" in plain, false);
});
