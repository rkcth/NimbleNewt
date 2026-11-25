import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { FILE_CHANNEL_DEFAULTS, FILE_CHANNEL_ENV, FileChannelError, FrameDecoder, encodeFrame, nodeWorkerFileOps, openWorkerFileChannel, workerFileChannelFromEnv } from "./index.js";

const text = (b: Buffer): string => b.toString("utf8");
const m = (seq: number, json: unknown): Buffer => encodeFrame(seq, "m", JSON.stringify(json));
const decoder = (): FrameDecoder => new FrameDecoder({ kinds: ["m", "a", "e"] });

describe("A03b slice 4: the file framing", () => {
  test("a frame is a numbered, length-prefixed line and reads back in any chunking", () => {
    const frame = m(1, { t: "ready", note: "café ☃" });
    assert.match(text(frame), /^1 m \d+:\{.*\}\n$/);
    const whole = decoder().push(Buffer.concat([frame, encodeFrame(2, "a", "1"), encodeFrame(3, "e")]));
    assert.deepEqual(whole.map((f) => [f.seq, f.kind]), [[1, "m"], [2, "a"], [3, "e"]]);
    // one byte at a time: a half-written frame is never returned early
    const d = decoder();
    const bytes = Buffer.concat([frame, encodeFrame(2, "a", "1")]);
    const got: string[] = [];
    for (const byte of bytes) for (const f of d.push(Buffer.from([byte]))) got.push(`${f.seq}${f.kind}`);
    assert.deepEqual(got, ["1m", "2a"]);
    assert.equal(d.pendingBytes, 0);
    const d2 = decoder();
    assert.deepEqual(d2.push(frame.subarray(0, 10)), []);
    assert.equal(d2.pendingBytes, 10);
  });

  test("the first thing that is not a frame fails the decoder, and it stays failed", () => {
    const bad: [string, Buffer][] = [
      ["garbage", Buffer.from("hello world, this is not a frame at all\n")],
      ["leading zero", Buffer.from('01 m 2:{}\n')],
      ["a gap", Buffer.concat([m(1, {}), m(3, {})])],
      ["a repeat", Buffer.concat([m(1, {}), m(1, {})])],
      ["a length that lies (short)", Buffer.from('1 m 1:{}\n')],
      ["a length that lies (long)", Buffer.from('1 m 3:{}\nX')],
      ["no closing break", Buffer.from('1 m 2:{}x')],
      ["a kind that is not accepted here", encodeFrame(1, "h")],
      ["not JSON", encodeFrame(1, "m", "{nope")],
      ["JSON that is not an object", encodeFrame(1, "m", "[1]")],
      ["a payload on an end frame", encodeFrame(1, "e", "x")],
      ["an ack that is not a number", encodeFrame(1, "a", "x")],
      ["a frame after the end", Buffer.concat([encodeFrame(1, "e"), m(2, {})])],
      ["invalid UTF-8", Buffer.concat([Buffer.from("1 m 2:"), Buffer.from([0xff, 0xfe]), Buffer.from("\n")])],
      ["a line break inside a payload", Buffer.from('1 m 5:{"a"\n}\n')],
    ];
    for (const [name, bytes] of bad) {
      const d = decoder();
      assert.throws(() => d.push(bytes), FileChannelError, name);
      assert.throws(() => d.push(m(1, {})), FileChannelError, `${name}: stays failed`);
    }
    // Bytes that are not UTF-8 INSIDE a JSON string (where a lenient decoder would turn them into U+FFFD and the JSON would still parse): a stray byte, an encoded lone surrogate, an overlong form.
    for (const raw of [[0xff], [0xed, 0xa0, 0x80], [0xc0, 0xaf]]) {
      const payload = Buffer.concat([Buffer.from('{"s":"'), Buffer.from(raw), Buffer.from('"}')]);
      const frame = Buffer.concat([Buffer.from(`1 m ${payload.length}:`), payload, Buffer.from("\n")]);
      assert.throws(() => decoder().push(frame), /not valid text/, raw.join(","));
    }
    // Raw control bytes, framed with their true length (so only the payload rules can refuse them): a CR between JSON tokens is JSON whitespace, so only the one-line rule refuses it; a raw CR or NUL inside
    // a string is refused too. U+2028 and U+2029 raw inside a string are valid JSON and not a line break for the controller (it splits on byte 0x0A only): they pass, as one frame.
    const raw = (payload: Buffer): Buffer => Buffer.concat([Buffer.from(`1 m ${payload.length}:`), payload, Buffer.from("\n")]);
    for (const [name, payload] of [["a CR between tokens", '{\r"a":1}'], ["a CR inside a string", '{"a":"x\ry"}'], ["a NUL inside a string", '{"a":"x\u0000y"}'], ["a lone CR at the end", '{"a":1}\r']] as const) {
      assert.throws(() => decoder().push(raw(Buffer.from(payload, "utf8"))), FileChannelError, name);
    }
    const seps = decoder().push(raw(Buffer.from('{"a":"x\u2028y\u2029z"}', "utf8")));
    assert.deepEqual(seps.map((f) => (JSON.parse(f.payload) as { a: string }).a), ["x\u2028y\u2029z"]);
    // An escaped lone surrogate and a __proto__ key are valid JSON text: they pass as plain data (the controller's own message checks apply to them as on a pipe).
    const odd = decoder().push(encodeFrame(1, "m", '{"__proto__":{"x":1},"s":"\\ud800"}'));
    assert.equal(odd.length, 1);
    assert.equal(({} as Record<string, unknown>)["x"], undefined);
  });

  test("bounds: a payload over the limit fails as soon as its header is read, and so does the frame count", () => {
    const d = new FrameDecoder({ kinds: ["m"], maxPayload: 100 });
    assert.throws(() => d.push(Buffer.from("1 m 101:")), /longer than the channel allows/);
    const few = new FrameDecoder({ kinds: ["m"], maxFrames: 2 });
    assert.equal(few.push(Buffer.concat([m(1, {}), m(2, {})])).length, 2);
    assert.throws(() => few.push(m(3, {})), /more frames/);
    // a header that never ends
    assert.throws(() => decoder().push(Buffer.from("1 m 99999999999999999999999999999")), /header/);
    assert.throws(() => encodeFrame(1, "m", "a\nb"), FileChannelError);
    assert.throws(() => encodeFrame(0, "m", "{}"), FileChannelError);
  });
});

describe("A03b slice 4: the worker's end of the channel, over real files", () => {
  const files = (): { dir: string; inbox: string; outbox: string; done: () => void } => {
    const dir = mkdtempSync(join(tmpdir(), "nn-fc-"));
    const inbox = join(dir, "in"); const outbox = join(dir, "out");
    writeFileSync(inbox, ""); writeFileSync(outbox, "");
    return { dir, inbox, outbox, done: () => rmSync(dir, { recursive: true, force: true }) };
  };
  const outFrames = (outbox: string): { seq: number; kind: string; payload: string }[] => new FrameDecoder({ kinds: ["m", "a", "e"] }).push(readFileSync(outbox));
  const quick = { pollMinMs: 1, pollMaxMs: 5 };

  test("lines come in as the controller's lines, replies go out as message frames, taking a batch is acknowledged, the end frame ends the input, close writes the end", async () => {
    const f = files();
    try {
      const ch = openWorkerFileChannel({ inbox: f.inbox, outbox: f.outbox, ...quick });
      appendFileSync(f.inbox, Buffer.concat([m(1, { t: "start", n: 1 }), encodeFrame(2, "h"), m(3, { t: "go" })]));
      const it = ch.input[Symbol.asyncIterator]();
      assert.equal(text((await it.next()).value as Buffer), '{"t":"start","n":1}\n');
      assert.equal(text((await it.next()).value as Buffer), '{"t":"go"}\n');
      ch.write('{"t":"ready","v":1}\n');
      const later = it.next(); // waits on the next frame
      appendFileSync(f.inbox, Buffer.concat([m(4, { t: "more" }), encodeFrame(5, "e")]));
      assert.equal(text((await later).value as Buffer), '{"t":"more"}\n');
      assert.equal((await it.next()).done, true);
      ch.close();
      ch.close();
      const frames = outFrames(f.outbox);
      assert.deepEqual(frames.map((x) => `${x.kind}:${x.payload}`), ['m:{"t":"ready","v":1}', "a:3", "a:4", "e:"]);
      assert.deepEqual(frames.map((x) => x.seq), [1, 2, 3, 4]);
      // the acknowledgement comes after the reader has taken the batch, so the reply the worker wrote meanwhile is ahead of it
    } finally { f.done(); }
  });

  test("a damaged inbox, one cut short, and a supervisor that goes quiet each end the input with an error", async () => {
    const f = files();
    try {
      const damaged = openWorkerFileChannel({ inbox: f.inbox, outbox: f.outbox, ...quick });
      appendFileSync(f.inbox, "this is not a frame, it is far too long for a header\n");
      await assert.rejects(damaged.input[Symbol.asyncIterator]().next(), FileChannelError);
      damaged.close();
      writeFileSync(f.inbox, "");
      const cut = openWorkerFileChannel({ inbox: f.inbox, outbox: f.outbox, ...quick });
      appendFileSync(f.inbox, m(1, { t: "x" }));
      const it = cut.input[Symbol.asyncIterator]();
      await it.next();
      truncateSync(f.inbox, 3);
      await assert.rejects(it.next(), /cut short/);
      cut.close();
      writeFileSync(f.inbox, "");
      let clock = 0;
      const quiet = openWorkerFileChannel({ inbox: f.inbox, outbox: f.outbox, ...quick, stallMs: 1000, now: () => clock, sleep: async () => { clock += 600; } });
      await assert.rejects(quiet.input[Symbol.asyncIterator]().next(), /stopped writing/);
      quiet.close();
    } finally { f.done(); }
  });

  test("a message longer than the bound, and a file at its size limit, are refused to the writer", () => {
    const f = files();
    try {
      const ch = openWorkerFileChannel({ inbox: f.inbox, outbox: f.outbox, maxPayload: 50, maxBytes: 120 });
      assert.throws(() => ch.write(`{"t":"${"x".repeat(60)}"}\n`), /longer than the channel allows/);
      ch.write('{"t":"a"}\n');
      assert.throws(() => { for (let i = 0; i < 20; i++) ch.write('{"t":"a"}\n'); }, /size limit/);
      ch.close();
    } finally { f.done(); }
  });

  test("the environment asks for the files; with no names the worker keeps standard input and output; half a pair is refused", () => {
    const f = files();
    try {
      assert.equal(workerFileChannelFromEnv({}), undefined);
      assert.throws(() => workerFileChannelFromEnv({ [FILE_CHANNEL_ENV.inbox]: f.inbox }), FileChannelError);
      const ch = workerFileChannelFromEnv({ [FILE_CHANNEL_ENV.inbox]: f.inbox, [FILE_CHANNEL_ENV.outbox]: f.outbox, [FILE_CHANNEL_ENV.maxBytes]: "1000", [FILE_CHANNEL_ENV.maxPayload]: "x" })!;
      ch.write('{"t":"ok"}\n');
      ch.close();
      assert.equal(outFrames(f.outbox)[0]!.payload, '{"t":"ok"}');
      assert.ok(FILE_CHANNEL_DEFAULTS.windowBytes >= 2 * FILE_CHANNEL_DEFAULTS.maxPayload);
      assert.equal(typeof nodeWorkerFileOps.openAppend, "function");
    } finally { f.done(); }
  });
});
