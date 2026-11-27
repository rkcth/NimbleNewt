import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REPLY_ROOM_FILE, ReplyRoom, cutWithoutText, loadReplyRoom, saveReplyRoom } from "./reply-room.js";
import { withReplyFloor } from "./relay-fetch.js";

// W09 fixes, item 3: a reply cut at the reply limit with no visible text is retryable with a larger limit.

test("each cut doubles the limit up to the ceiling and counts; a ceiling at the limit never grows; the record is absent until a cut", () => {
  const r = new ReplyRoom(4096, 25_000);
  assert.equal(r.record(), undefined);
  assert.deepEqual([r.cut(), r.limit, r.cut(), r.limit, r.cut(), r.limit, r.cut(), r.limit], [true, 8192, true, 16_384, true, 25_000, false, 25_000]);
  assert.deepEqual(r.record(), { cuts: 4, limit: 25_000, ceiling: 25_000 });
  assert.equal(r.raised, true);
  const fixed = new ReplyRoom(16_384, 16_384);
  assert.deepEqual([fixed.cut(), fixed.limit, fixed.raised], [false, 16_384, false]);
  // A kept limit is held within the base and the ceiling (a route whose limit changed since).
  assert.equal(new ReplyRoom(4096, 8192, { limit: 30_000, cuts: 2 }).limit, 8192);
  assert.equal(new ReplyRoom(4096, 8192, { limit: 10, cuts: 2 }).limit, 4096);
});

test("a cut without text is a length stop with nothing visible; any visible text, or another stop, is not", () => {
  assert.equal(cutWithoutText("length", ""), true);
  assert.equal(cutWithoutText("length", "  \n "), true);
  assert.equal(cutWithoutText("length", "step one is"), false);
  assert.equal(cutWithoutText("stop", ""), false);
  assert.equal(cutWithoutText(undefined, ""), false);
});

test("the room is kept in the store folder and read back; a missing, damaged or out-of-range file gives the host's limit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-room-"));
  try {
    assert.equal((await loadReplyRoom(dir, 4096, 25_000)).limit, 4096);
    const r = new ReplyRoom(4096, 25_000); r.cut(); r.cut();
    await saveReplyRoom(dir, r);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, REPLY_ROOM_FILE), "utf8")), { v: 1, limit: 16_384, cuts: 2 });
    const back = await loadReplyRoom(dir, 4096, 25_000);
    assert.deepEqual([back.limit, back.cuts], [16_384, 2]);
    for (const bad of ["not json", JSON.stringify({ v: 2, limit: 8192, cuts: 1 }), JSON.stringify({ v: 1, limit: -1, cuts: 1 }), JSON.stringify({ v: 1, limit: 8192, cuts: 1.5 }), JSON.stringify({ v: 1, limit: 2_000_000, cuts: 1 })]) {
      writeFileSync(join(dir, REPLY_ROOM_FILE), bad);
      const l = await loadReplyRoom(dir, 4096, 25_000);
      assert.deepEqual([l.limit, l.cuts], [4096, 0], bad);
    }
    // Saving into a folder that is not there fails, and the caller ignores it (only the raise is lost).
    await assert.rejects(saveReplyRoom(join(dir, "missing", "deeper"), r));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the relay raises a request's reply limit in the field it uses, never lowers it, never past the window, and leaves other bodies alone", () => {
  const raise = (o: unknown, floor: number, window?: number): unknown => JSON.parse(withReplyFloor(Buffer.from(JSON.stringify(o)), floor, window).toString("utf8"));
  assert.deepEqual(raise({ model: "m", max_tokens: 4096, messages: [] }, 8192), { model: "m", max_tokens: 8192, messages: [] });
  assert.deepEqual(raise({ max_completion_tokens: 4096 }, 8192), { max_completion_tokens: 8192 });
  assert.deepEqual(raise({ max_tokens: 20_000 }, 8192), { max_tokens: 20_000 }, "never lowered");
  assert.deepEqual(raise({ messages: [] }, 8192), { messages: [] }, "a body naming no limit is not given one");
  // The window: the request's bytes count as a token per 3, and Pi's 4,096 margin is kept.
  const big = { max_tokens: 4096, messages: [{ role: "user", content: "x".repeat(30_000) }] };
  const bytes = Buffer.byteLength(JSON.stringify(big));
  assert.deepEqual((raise(big, 64_000, 32_768) as { max_tokens: number }).max_tokens, 32_768 - Math.ceil(bytes / 3) - 4096);
  assert.deepEqual((raise(big, 64_000, 16_000) as { max_tokens: number }).max_tokens, 4096, "no room: left as Pi sized it");
  const text = Buffer.from("not json");
  assert.equal(withReplyFloor(text, 8192), text);
  const list = Buffer.from("[1,2]");
  assert.equal(withReplyFloor(list, 8192), list);
});
