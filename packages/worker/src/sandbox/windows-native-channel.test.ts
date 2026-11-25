import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, test } from "node:test";
import { FILE_CHANNEL_DEFAULTS, FrameDecoder, LineDecoder, encodeFrame, type Frame } from "@nimblenewt/contracts";
import { ChannelRelay, type ChannelFile, type ChannelPorts } from "./windows-native-channel.js";

// The relay's rules on every OS, with in-memory files: ordering, the bounds, what a damaged outbox does, backpressure, the heartbeat, the end. The worker's own end (contracts) and the whole path through
// runNativeJob with real files are in windows-native.test.ts and the contracts tests.

class MemFile implements ChannelFile {
  bytes: Buffer = Buffer.alloc(0);
  named = true;
  closed = false;
  size(): number { return this.bytes.length; }
  read(offset: number, max: number): Buffer { return Buffer.from(this.bytes.subarray(offset, offset + max)); }
  append(data: Buffer): void { this.bytes = Buffer.concat([this.bytes, data]); }
  stillNamed(): boolean { return this.named; }
  close(): void { this.closed = true; }
  frames(kinds: ("m" | "a" | "h" | "e")[] = ["m", "a", "h", "e"]): Frame[] { return new FrameDecoder({ kinds }).push(this.bytes); }
}
const until = async (condition: () => boolean, what: string, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!condition()) { if (Date.now() > end) assert.fail(`waited for: ${what}`); await new Promise((r) => setTimeout(r, 2)); }
};
type Limits = { -readonly [K in keyof typeof FILE_CHANNEL_DEFAULTS]?: number };
const msg = (seq: number, json: unknown): Buffer => encodeFrame(seq, "m", JSON.stringify(json));

interface Rig { inbox: MemFile; outbox: MemFile; input: PassThrough; lines: string[]; faults: string[]; relay: ChannelRelay; ports: ChannelPorts; failWrites: { on: boolean } }
const rig = (limits: Limits = {}): Rig => {
  const inbox = new MemFile(); const outbox = new MemFile(); const input = new PassThrough();
  const lines: string[] = []; const faults: string[] = []; const failWrites = { on: false };
  const ports: ChannelPorts = { input, output: { write: async (t) => { if (failWrites.on) throw new Error("EPIPE"); lines.push(t); } } };
  const merged = { ...FILE_CHANNEL_DEFAULTS, ...limits };
  const relay = new ChannelRelay({ inbox, outbox, ports, limits: merged, onFault: (r) => { faults.push(r); }, pollMinMs: 1, pollMaxMs: 3 });
  return { inbox, outbox, input, lines, faults, relay, ports, failWrites };
};

describe("A03b slice 4: the supervisor's relay between the controller's pipes and the two files", () => {
  test("the controller's lines go to the inbox as numbered frames in order, the worker's frames come out as lines in order, the end of input is an end frame", async () => {
    const r = rig();
    r.relay.start();
    r.input.write('{"t":"a"}\n{"t":"b"}\n{"t":"c"');
    r.input.write('}\n');
    await until(() => r.inbox.frames().length === 3, "three inbox frames");
    assert.deepEqual(r.inbox.frames().map((f) => `${f.seq}${f.kind}${f.payload}`), ['1m{"t":"a"}', '2m{"t":"b"}', '3m{"t":"c"}']);
    r.outbox.append(Buffer.concat([msg(1, { t: "ready", n: 1 }), msg(2, { t: "result", n: 2 })]));
    await until(() => r.lines.length === 2, "two relayed lines");
    assert.deepEqual(r.lines, ['{"t":"ready","n":1}\n', '{"t":"result","n":2}\n']);
    r.input.end();
    await until(() => r.inbox.frames().some((f) => f.kind === "e"), "the end frame");
    r.outbox.append(encodeFrame(3, "e"));
    const end = await r.relay.finish(true);
    assert.equal(end.fault, undefined);
    assert.equal(end.note, undefined);
    assert.deepEqual([end.stats.framesToWorker, end.stats.framesFromWorker, end.stats.workerEnded], [4, 3, true]);
    assert.deepEqual(r.faults, []);
  });

  test("a frame the worker has only half written is not forwarded until it is whole", async () => {
    const r = rig();
    r.relay.start();
    const whole = msg(1, { t: "x", pad: "y".repeat(100) });
    r.outbox.append(whole.subarray(0, 40));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(r.lines, []);
    r.outbox.append(whole.subarray(40));
    await until(() => r.lines.length === 1, "the whole frame");
    await r.relay.finish(false);
  });

  test("a frame that is not well formed ends the run as a typed fault, and nothing from the damaged read is passed on", async () => {
    const r = rig();
    r.relay.start();
    r.outbox.append(Buffer.concat([msg(1, { t: "ok" }), Buffer.from("2 m 3:xyz\n"), msg(3, { t: "late" })]));
    await until(() => r.faults.length === 1, "the fault");
    assert.match(r.faults[0]!, /the worker broke the channel/);
    const end = await r.relay.finish(false);
    assert.match(end.fault!, /broke the channel/);
    assert.deepEqual(r.lines, [], "the read that held the damage is dropped whole");
    assert.equal(r.faults.length, 1, "told once");
  });

  test("each kind of damage is a fault: a gap, a kind only the supervisor writes, a payload over the bound, more frames than allowed, too many bytes, a file cut short", async () => {
    const cases: [string, (r: Rig) => void, Limits, RegExp][] = [
      ["a gap", (r) => r.outbox.append(Buffer.concat([msg(1, {}), msg(3, {})])), {}, /expected/],
      ["a heartbeat from the worker", (r) => r.outbox.append(encodeFrame(1, "h")), {}, /not accepted/],
      ["a payload over the bound", (r) => r.outbox.append(msg(1, { pad: "z".repeat(200) })), { maxPayload: 100 }, /longer than the channel allows/],
      ["too many frames", (r) => r.outbox.append(Buffer.concat([msg(1, {}), msg(2, {}), msg(3, {})])), { maxFrames: 2 }, /more frames/],
      ["too many bytes", (r) => r.outbox.append(Buffer.concat(Array.from({ length: 20 }, (_, i) => msg(i + 1, { n: i })))), { maxBytes: 100 }, /larger than the channel allows/],
      ["an acknowledgement for nothing", (r) => r.outbox.append(encodeFrame(1, "a", "7")), {}, /not waiting/],
      ["a file replaced under its name", (r) => { r.outbox.named = false; }, {}, /replaced or removed/],
    ];
    for (const [name, act, limits, pattern] of cases) {
      const r = rig(limits);
      r.relay.start();
      act(r);
      await until(() => r.faults.length === 1, name);
      assert.match(r.faults[0]!, pattern, name);
      await r.relay.finish(false);
    }
    const cut = rig();
    cut.relay.start();
    cut.outbox.append(msg(1, { t: "x" }));
    await until(() => cut.lines.length === 1, "first line");
    cut.outbox.bytes = cut.outbox.bytes.subarray(0, 5);
    await until(() => cut.faults.length === 1, "cut short");
    assert.match(cut.faults[0]!, /cut short/);
    await cut.relay.finish(false);
  });

  test("the controller cannot overfill the channel either: a line over the bound, or more bytes than the file may hold, is a fault", async () => {
    const long = rig({ maxPayload: 50 });
    long.relay.start();
    long.input.write(`{"pad":"${"p".repeat(80)}"}\n`);
    await until(() => long.faults.length === 1, "a long line");
    assert.match(long.faults[0]!, /longer than the channel allows/);
    await long.relay.finish(false);
    const partial = rig({ maxPayload: 50 });
    partial.relay.start();
    partial.input.write("p".repeat(80));
    await until(() => partial.faults.length === 1, "a line that never ends");
    await partial.relay.finish(false);
    const full = rig({ maxBytes: 100, windowBytes: 1_000_000 });
    full.relay.start();
    for (let i = 0; i < 10; i++) full.input.write(`{"n":${i}}\n`);
    await until(() => full.faults.length === 1, "the file is full");
    assert.match(full.faults[0]!, /more than the channel's file may hold/);
    await full.relay.finish(false);
  });

  test("backpressure: the controller's input is paused while the worker has left a window of bytes unread, and resumes on its acknowledgement; a repeated acknowledgement is a fault", async () => {
    const r = rig({ windowBytes: 60 });
    r.relay.start();
    r.input.write('{"n":1,"pad":"aaaaaaaaaaaaaaaaaaaaaaaa"}\n{"n":2,"pad":"bbbbbbbbbbbbbbbbbbbbbbbb"}\n');
    await until(() => r.input.isPaused(), "paused at the window");
    assert.equal(r.inbox.frames().length, 2);
    r.outbox.append(encodeFrame(1, "a", "2"));
    await until(() => !r.input.isPaused(), "resumed on the acknowledgement");
    r.outbox.append(encodeFrame(2, "a", "2"));
    await until(() => r.faults.length === 1, "a repeated acknowledgement");
    await r.relay.finish(false);
  });

  test("a heartbeat goes into the inbox while nothing else does, and stops after the end", async () => {
    const r = rig({ heartbeatMs: 20 });
    r.relay.start();
    await until(() => r.inbox.frames().filter((f) => f.kind === "h").length >= 2, "two heartbeats");
    r.input.end();
    await until(() => r.inbox.frames().some((f) => f.kind === "e"), "the end");
    const count = r.inbox.frames().length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(r.inbox.frames().length, count);
    await r.relay.finish(false);
  });

  test("the end: output is read to its last frame after the program has gone; a half frame is a fault after an orderly exit and a dropped note after a kill; no closing frame is a note", async () => {
    const tail = rig();
    tail.relay.start();
    tail.outbox.append(Buffer.concat([msg(1, { t: "last" }), msg(2, { t: "partial" }).subarray(0, 12)]));
    const orderly = await tail.relay.finish(true);
    assert.match(orderly.fault!, /ends inside a frame/);
    assert.deepEqual(tail.lines, ['{"t":"last"}\n'], "what was whole is passed on first");
    const killed = rig();
    killed.relay.start();
    killed.outbox.append(Buffer.concat([msg(1, { t: "last" }), msg(2, { t: "partial" }).subarray(0, 12)]));
    const k = await killed.relay.finish(false);
    assert.equal(k.fault, undefined);
    assert.match(k.note!, /dropped/);
    const quiet = rig();
    quiet.relay.start();
    quiet.outbox.append(msg(1, { t: "x" }));
    const q = await quiet.relay.finish(true);
    assert.equal(q.fault, undefined);
    assert.match(q.note!, /without a closing frame/);
    assert.equal(q.stats.workerEnded, false);
  });

  test("a controller pipe that is gone ends the relay with a fault", async () => {
    const r = rig();
    r.failWrites.on = true;
    r.relay.start();
    r.outbox.append(msg(1, { t: "x" }));
    await until(() => r.faults.length === 1, "the fault");
    assert.match(r.faults[0]!, /could not be relayed: EPIPE/);
    await r.relay.finish(false);
  });

  test("a controller that stops taking lines: the outbox bound and its name are still checked while a relayed line waits, and the wait ends on the fault", async () => {
    for (const kind of ["grows", "swapped"] as const) {
      const inbox = new MemFile(); const outbox = new MemFile(); const input = new PassThrough();
      const faults: string[] = []; let writes = 0;
      const ports: ChannelPorts = { input, output: { write: () => { writes++; return new Promise<void>(() => undefined); } } };
      const relay = new ChannelRelay({ inbox, outbox, ports, limits: { ...FILE_CHANNEL_DEFAULTS, maxBytes: 4096 }, onFault: (r) => { faults.push(r); }, pollMinMs: 1, pollMaxMs: 3, guardMs: 5 });
      relay.start();
      outbox.append(msg(1, { t: "first" }));
      await until(() => writes === 1, "the first line is waiting on the controller");
      // A sparse-like jump: the size alone is over the bound, whatever has been read.
      if (kind === "grows") outbox.append(Buffer.alloc(1 << 20)); else outbox.named = false;
      await until(() => faults.length === 1, kind);
      assert.match(faults[0]!, kind === "grows" ? /larger than the channel allows/ : /replaced or removed/, kind);
      const end = await relay.finish(false);
      assert.ok(end.fault !== undefined, kind);
    }
  });

  test("a controller that keeps its pipe open but stops reading cannot hold the end back: finish gives up with a fault after the drain bound", async () => {
    const inbox = new MemFile(); const outbox = new MemFile(); const input = new PassThrough();
    const faults: string[] = [];
    const ports: ChannelPorts = { input, output: { write: () => new Promise<void>(() => undefined) } };
    const relay = new ChannelRelay({ inbox, outbox, ports, limits: FILE_CHANNEL_DEFAULTS, onFault: (r) => { faults.push(r); }, pollMinMs: 1, pollMaxMs: 3, drainMs: 50 });
    relay.start();
    outbox.append(Buffer.concat([msg(1, { t: "a" }), msg(2, { t: "b" })]));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const end = await Promise.race([relay.finish(true), new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error("finish did not end")); }, 5000); })]);
    clearTimeout(timer);
    assert.match(end.fault!, /did not take the worker's remaining output in time/);
    assert.equal(faults.length, 1);
  });

  test("second review: a payload with U+2028, U+2029 and multibyte text right at a read boundary reaches the controller as exactly one line, byte for byte; a raw CR does not reach it at all", async () => {
    const r = rig();
    r.relay.start();
    const value = { t: "x", s: "a\u2028b\u2029c é ☃ 😀" };
    const frame = msg(1, value);
    // written in two parts that split a four-byte character
    const cut = frame.indexOf(Buffer.from("😀")) + 2;
    r.outbox.append(frame.subarray(0, cut));
    await new Promise((resolve) => setTimeout(resolve, 10));
    r.outbox.append(frame.subarray(cut));
    await until(() => r.lines.length === 1, "the line");
    assert.deepEqual(Buffer.from(r.lines[0]!, "utf8"), Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
    const got = new LineDecoder().push(r.lines.join(""));
    assert.deepEqual(got, [value], "the controller's own line reader sees one message");
    await r.relay.finish(false);
    const cr = rig();
    cr.relay.start();
    const payload = Buffer.from('{\r"t":"x"}', "utf8");
    cr.outbox.append(Buffer.concat([Buffer.from(`1 m ${payload.length}:`), payload, Buffer.from("\n")]));
    await until(() => cr.faults.length === 1, "the fault");
    assert.match(cr.faults[0]!, /spans lines/);
    assert.deepEqual(cr.lines, []);
    await cr.relay.finish(false);
  });

  test("second review: a flood of acknowledgements cannot unpause the controller's input early or be repeated; one past what was sent is a fault", async () => {
    const r = rig({ windowBytes: 60 });
    r.relay.start();
    r.input.write('{"n":1,"pad":"aaaaaaaaaaaaaaaaaaaaaaaa"}\n{"n":2,"pad":"bbbbbbbbbbbbbbbbbbbbbbbb"}\n');
    await until(() => r.input.isPaused(), "paused");
    // acknowledging only the first leaves the second (about 42 bytes) waiting: below the window, so it resumes; then an ack for a frame never sent
    r.outbox.append(encodeFrame(1, "a", "1"));
    await until(() => !r.input.isPaused(), "resumed");
    r.outbox.append(encodeFrame(2, "a", "9"));
    await until(() => r.faults.length === 1, "an ack for a frame never sent");
    assert.match(r.faults[0]!, /not waiting/);
    await r.relay.finish(false);
  });

  test("second review: after finish, no timer of the relay is left (heartbeat, guard, drain, poll), so nothing fires after the grants are revoked and nothing keeps the process alive", async () => {
    for (const how of ["clean", "faulted", "stalled"] as const) {
      const timersBefore = process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;
      // Every interval the relay makes is tracked, referenced or not (an unreferenced one does not show among the active resources).
      const realSet = globalThis.setInterval; const realClear = globalThis.clearInterval;
      const live = new Set<unknown>();
      globalThis.setInterval = ((fn: () => void, ms?: number) => { const h = realSet(fn, ms); live.add(h); return h; }) as typeof setInterval;
      globalThis.clearInterval = ((h?: Parameters<typeof clearInterval>[0]) => { live.delete(h); realClear(h); }) as typeof clearInterval;
      try {
      const inbox = new MemFile(); const outbox = new MemFile(); const input = new PassThrough();
      const faults: string[] = [];
      const ports: ChannelPorts = { input, output: { write: how === "stalled" ? () => new Promise<void>(() => undefined) : async () => undefined } };
      const relay = new ChannelRelay({ inbox, outbox, ports, limits: { ...FILE_CHANNEL_DEFAULTS, heartbeatMs: 10 }, onFault: (x) => { faults.push(x); }, pollMinMs: 1, pollMaxMs: 3, guardMs: 2, drainMs: 30 });
      relay.start();
      outbox.append(msg(1, { t: "a" }));
      if (how === "faulted") outbox.named = false;
      if (how === "faulted") await until(() => faults.length === 1, "fault");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await relay.finish(false);
      const heartbeats = inbox.frames().length;
      const outboxChecks = faults.length;
      outbox.named = false; // a guard still running would now fault
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(inbox.frames().length, heartbeats, `${how}: no heartbeat after finish`);
      assert.equal(faults.length, outboxChecks, `${how}: no guard after finish`);
      assert.equal(process.getActiveResourcesInfo().filter((x) => x === "Timeout").length, timersBefore, `${how}: every timer the relay made is gone`);
      assert.equal(live.size, 0, `${how}: every interval the relay made was cleared`);
      } finally { globalThis.setInterval = realSet; globalThis.clearInterval = realClear; }
    }
  });

  test("what a frame names is only text: paths, handles and commands in a payload are passed on as they are and nothing is opened or run", async () => {
    const r = rig();
    r.relay.start();
    const payload = { t: "result", file: "C:\\Windows\\System32\\config\\SAM", handle: 4, cmd: "calc.exe", link: "\\\\?\\GLOBALROOT\\x" };
    r.outbox.append(msg(1, payload));
    await until(() => r.lines.length === 1, "the line");
    assert.deepEqual(JSON.parse(r.lines[0]!), payload);
    assert.equal(r.outbox.closed, false);
    await r.relay.finish(false);
  });
});
