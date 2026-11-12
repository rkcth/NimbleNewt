import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanUntrusted, findCredentialShapes, redactError, redactText, safeTail, safeText } from "./index.js";

// The key is built at run time: a push-protection scan reads every commit.
const key = "gh" + "p_" + "aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3kM5";

test("safeText cleans before it cuts, so a cut never leaves half a key", () => {
  const text = `x ${key} y`;
  for (let max = 1; max < text.length; max++) assert.ok(!safeText(text, max).includes(key.slice(8)), `max ${max}`);
  assert.equal(safeText(new Error(`boom ${key}`), 100), "boom [redacted]");
  assert.equal(safeText(undefined, 100), "undefined");
  assert.equal(safeText("a\u001b[31mred​\ud800", 100), "a[31mred");
  assert.equal(safeTail(`${"z".repeat(50)} ${key}`, 20).length <= 20, true);
  assert.ok(!safeTail(`${"z".repeat(50)} ${key}`, 20).includes(key.slice(8)));
});

test("the exported scanner redacts through every view (fullwidth letters, a split key, quotes) and redactError keeps a clean error", () => {
  assert.equal(redactText(`k ${key.replace("ghp_", "ｇｈｐ＿")} k`), "k [redacted] k");
  assert.equal(redactText(`k "${key.slice(0, 6)}" + "${key.slice(6)}" k`), 'k "[redacted]" k');
  assert.ok(findCredentialShapes(`${key.slice(0, 9)}\n${key.slice(9)}`).length > 0);
  assert.equal(cleanUntrusted(`a\tb‮c ${key}`, { lines: "fold" }).text, "a bc [redacted]");
  const plain = new Error("fine");
  assert.equal(redactError(plain), plain);
});

test("second review: a long output is cleaned in a bounded window, and a key at the window's edge is still never kept", async () => {
  const { SAFE_MARGIN } = await import("./safe-text.js");
  const line = "ok 1234 - a test passed (12 ms) commit 3ef91ff7c6000ec47ddf7e88562ad32dd4bb7610\n";
  const big = line.repeat(Math.ceil((16 << 20) / line.length));
  let t0 = performance.now();
  const kept = safeTail(big, 8000);
  assert.ok(performance.now() - t0 < 1500, `16 MB tailed in ${(performance.now() - t0).toFixed(0)} ms (cleaning all of it took about 30 s and 2 GB)`);
  assert.equal(kept, big.slice(big.length - 8000), "plain text is kept as it was");
  t0 = performance.now();
  assert.equal(safeText(big, 300), big.slice(0, 300));
  assert.ok(performance.now() - t0 < 1500, "the head too");
  const filler = "w ".repeat(SAFE_MARGIN + 4000);
  for (const max of [10, 100, 2000]) {
    for (let shift = -40; shift <= 40; shift += 3) {
      // The key around the start of the tail window, and around the end of the head window.
      const atTail = `${filler}${key} ${"v".repeat(Math.max(0, max + SAFE_MARGIN - key.length + shift))}`;
      assert.ok(!safeTail(atTail, max).includes(key.slice(8, 20)), `tail max ${max} shift ${shift}`);
      const atHead = `${"v".repeat(Math.max(0, max + SAFE_MARGIN - key.length + shift))} ${key}${filler}`;
      assert.ok(!safeText(atHead, max + SAFE_MARGIN).includes(key.slice(8, 20)), `head max ${max} shift ${shift}`);
    }
  }
  // A private key whose BEGIN is before the tail window: everything up to its END is that key.
  const pemBody = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7".repeat(2);
  const pem = `-----BEGIN PRIVATE KEY-----\n${(pemBody + "\n").repeat(Math.ceil(SAFE_MARGIN / pemBody.length) + 50)}-----END PRIVATE KEY-----\nafter`;
  const tailed = safeTail(`${filler}${pem}`, 4000);
  assert.ok(!tailed.includes(pemBody.slice(0, 24)), "no line of the key is kept");
  assert.ok(tailed.endsWith("after"));
});
