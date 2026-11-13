import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanUntrusted } from "./clean.js";
import { findCredentialShapes } from "./credential-patterns.js";
import { REDACTED, redactError, redactedSink, redactText } from "./redact.js";
import { afterPrivateKeyEnd, keyContextHex, privateKeyOpen } from "./secret-scan.js";

// The credential-redaction coverage follow-up: keys written as source code split over string literals, an unlabelled hex run in key-like context, the stream helpers (a private key open across pieces)
// and redactError. Every key here is built at run time (a GitHub push-protection scan reads every commit), from invented random characters.

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (r: () => number, s: string, n: number): string => Array.from({ length: n }, () => s[Math.floor(r() * s.length)]).join("");
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const HEX = "0123456789abcdef";
const hexOf = (seed: number, n: number): string => { let h = ""; const r = rng(seed); while (h.length < n) h += pick(r, HEX, 8); h = h.slice(0, n); return /\d/.test(h) && /[a-f]/.test(h) ? h : `1a${h.slice(2)}`; };
const ghKey = (seed: number): string => "gh" + "p_" + pick(rng(seed), ALNUM, 36);
const skKey = (seed: number): string => "s" + "k-" + pick(rng(seed), ALNUM, 40);

test("a key split over string literals is found: plus, dot, ampersand, plain adjacency, line breaks, three pieces", () => {
  for (const [i, make] of [ghKey, skKey].entries()) {
    const key = make(11 + i);
    for (const cut of [4, 5, 9, 20]) {
      const a = key.slice(0, cut), b = key.slice(cut);
      for (const text of [`x = "${a}" + "${b}"`, `x = '${a}' '${b}'`, `x = "${a}"."${b}"`, `x = "${a}" & "${b}"`, `x = "${a}"\n   "${b}"`, `x = \`${a}\` + \`${b}\``, `x = "${a}"+"${b}"`]) {
        const out = redactText(text);
        assert.ok(!out.includes(b), `${text.replace(b, "<rest>")} -> ${out.replace(b, "<rest>")}`);
        assert.ok(findCredentialShapes(text).length > 0, "refusal sees it too");
        assert.equal(redactText(out), out, "idempotent");
      }
    }
    const third = ["x = ", `"${key.slice(0, 6)}"`, " + ", `"${key.slice(6, 20)}"`, " + ", `"${key.slice(20)}"`].join("");
    assert.ok(!redactText(third).includes(key.slice(20)), "three pieces");
    // The marks stay where the quotes were.
    assert.equal(redactText(`x = "${key.slice(0, 4)}" + "${key.slice(4)}";`), 'x = "[redacted]";');
  }
});

test("quote joins do not turn ordinary text into a key", () => {
  for (const s of ['say "hello" + "world"', 'list = ["alpha", "beta", "gamma"]', "it's a 'quoted' 'word'", 'path "a/b" and "c/d"', 'print("sk-" + name)', 'prefix = "gh" + "p_" + suffix', 'a "ghp_" and "b"', 'echo "ssh-ed25519" "AAAA"', `"one" + "two" + "three" + "four"`]) assert.equal(redactText(s), s, s);
  const long = `"${"abcdefgh".repeat(30)}" + "${"ijklmnop".repeat(30)}"`;
  assert.equal(redactText(long), long, "two long words are not a key");
});

test("quote joins stay linear on hostile input", () => {
  const t = performance.now();
  redactText(`a"${" ".repeat(20000)}`.repeat(20) + "\"'".repeat(50000) + "a \" \" ".repeat(20000));
  assert.ok(performance.now() - t < 5000, `took ${performance.now() - t} ms`);
});

test("an unlabelled hex run of a digest length is a key when the words before it say so; a digest or an ID stays", () => {
  for (const n of [32, 40, 64, 128]) {
    const h = hexOf(n, n);
    for (const before of ["the api key is ", "API key: ", "secret key = ", '"key": "', "private key is ", "authorization: ", "encryption key is ", "session key=", "access-key: ", "the credential is ", "signing key => "]) {
      const text = `see ${before}${h} ok`;
      assert.ok(!redactText(text).includes(h), `${before}${n}`);
      assert.ok(findCredentialShapes(text).length > 0, `refusal ${before}${n}`);
    }
    for (const before of ["sha256: ", "commit ", "digest ", "checksum ", "hash ", "md5 ", "cache key sha256 ", "key id ", "request ", "change ", "etag ", "the key was derived from ", "monkey is "]) {
      const text = `see ${before}${h} ok`;
      assert.equal(redactText(text), text, `${before}${n}`);
    }
    assert.equal(redactText(h), h, `${n} bare`);
  }
  assert.equal(keyContextHex("api key is ", 11, "0".repeat(32)), false, "all digits is not a hex key");
  assert.equal(keyContextHex("api key is ", 11, hexOf(3, 33)), false, "an odd length is left to the entropy rule");
  const h = hexOf(5, 40);
  assert.equal(redactText(`first\napi key is\n${h}`), `first\napi key is\n${h}`, "the context is on the same line");
});

test("a private key open across pieces is seen through hidden and fullwidth characters", () => {
  const begin = "-----BEGIN RSA PRIVATE KEY-----";
  const end = "-----END RSA PRIVATE KEY-----";
  assert.equal(privateKeyOpen(`log\n${begin}\nMIIE`), true);
  assert.equal(privateKeyOpen(`${begin}\nMIIE\n${end}\n`), false);
  assert.equal(privateKeyOpen("no key"), false);
  assert.equal(privateKeyOpen(`${begin.slice(0, 8)}​${begin.slice(8)}\nMIIE`), true, "a zero-width character inside BEGIN");
  assert.equal(privateKeyOpen(`${begin.replace("BEGIN", "ＢＥＧＩＮ")}\nMIIE`), true, "fullwidth letters");
  assert.equal(privateKeyOpen(`${begin}\nA\n${end}\n${begin}\nB`), true, "a second block open");
  assert.equal(privateKeyOpen(`${begin}\nA\n${end.slice(0, 9)}­${end.slice(9)}`), false, "an END with a soft hyphen closes it");
  assert.equal(afterPrivateKeyEnd(`AAA\n${end}\ntail`), `AAA\n${end}`.length);
  assert.equal(afterPrivateKeyEnd("none"), undefined);
  const hidden = `AAA\n${end.slice(0, 9)}​${end.slice(9)}\ntail`;
  assert.equal(hidden.slice(afterPrivateKeyEnd(hidden)), "\ntail", "offset in the original text");
});

test("`continues` takes everything up to an END no BEGIN belongs to", () => {
  const begin = "-----BEGIN PRIVATE KEY-----";
  const end = "-----END PRIVATE KEY-----";
  const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
  assert.equal(redactText(`some notes here\n${body}\n${end}\nnext`, { continues: true }), `${REDACTED}\nnext`);
  assert.equal(redactText(`some notes here\n${body}\n${end}\nnext`), `some notes here\n${REDACTED}\n${end}\nnext`, "without it only the base64 lines above the END go");
  assert.equal(redactText(`${begin}\n${body}\n${end}\nnext`, { continues: true }), `${REDACTED}\nnext`, "a whole block is one mark");
  assert.equal(redactText(`${begin}\n${body}\n${end}\nmid\n${body}\n${end}\nnext`, { continues: true }), `${REDACTED}\nnext`, "the last orphan END ends the cut");
  assert.equal(redactText("plain words only", { continues: true }), "plain words only");
  const hiddenEnd = `words\n${end.slice(0, 7)}​${end.slice(7)}\nrest`;
  assert.equal(cleanUntrusted(hiddenEnd, { lines: "keep", continues: true }).text, `${REDACTED}\nrest`, "an END hidden by an invisible character");
  assert.equal(cleanUntrusted(hiddenEnd, { lines: "keep", continues: true }).redacted, true);
});

test("redactError: the same error back when clean, a copy with the message, stack and cause cleaned when not", () => {
  const plain = new Error("disk full");
  assert.equal(redactError(plain), plain);
  const key = ghKey(21);
  const e = Object.assign(new TypeError(`request failed with ${key}`, { cause: new Error(`inner ${key}`) }), { code: "E_FAIL" });
  const out = redactError(e) as Error & { code?: string };
  assert.ok(out instanceof Error && out !== e);
  assert.equal(out.message, `request failed with ${REDACTED}`);
  assert.equal(out.name, "TypeError");
  assert.equal(out.code, "E_FAIL");
  assert.ok(!String(out.stack).includes(key));
  assert.equal(((out.cause as Error)).message, `inner ${REDACTED}`);
  assert.equal(redactError(`oops ${key}`), `oops ${REDACTED}`);
  assert.deepEqual(redactError({ message: key, n: 1 }), { message: REDACTED, n: 1 });
  assert.equal(redactError(undefined), undefined);
  assert.equal(redactError(7), 7);
  const loop: Error & { cause?: unknown } = new Error(`x ${key}`);
  loop.cause = loop;
  assert.doesNotThrow(() => redactError(loop));
  const seen: unknown[] = [];
  redactedSink((x) => seen.push(x))(new Error(`quoted ${key}`));
  redactedSink((x) => seen.push(x))(plain);
  assert.equal((seen[0] as Error).message, `quoted ${REDACTED}`);
  assert.equal(seen[1], plain, "a clean error reaches the sink as it was");
});

test("second review: hex runs on one long line stay linear (the key-context look-back was quadratic: 1 MB took over 4 s)", () => {
  const h64 = hexOf(41, 64);
  // Measured as this process's own processor time (not the wall clock, which a busy machine stretches by preempting the longer run more often), the fastest of three runs. Quadratic work is about 16 times
  // slower for 4 times the text, linear about 4; the ceiling only catches something far off on any machine.
  const time = (unit: string, n: number): number => { const text = unit.repeat(Math.ceil(n / unit.length)).slice(0, n); let best = Infinity; for (let i = 0; i < 3; i++) { const t0 = process.cpuUsage(); redactText(text); const d = process.cpuUsage(t0); best = Math.min(best, (d.user + d.system) / 1000); } return best; };
  for (const unit of [`${h64} `, `key:${h64.slice(0, 40)},`, `{"sha":"${h64}"},`]) {
    time(unit, 1 << 14);
    const small = time(unit, 1 << 18);
    const big = time(unit, 1 << 20);
    assert.ok(big < 3000, `${unit.slice(0, 8)}: 1 MB on one line took ${big.toFixed(0)} ms`);
    assert.ok(big < Math.max(small, 20) * 10, `${unit.slice(0, 8)}: linear (${small.toFixed(0)} ms for 256 KB, ${big.toFixed(0)} ms for 1 MB)`);
  }
});

test("second review: the key-context hex rule leaves IDs, digests and public values named with a key word alone", () => {
  const h = hexOf(43, 64), g = hexOf(44, 40), m = hexOf(45, 32);
  for (const text of [`public key: ${h}`, `primary key: ${m}`, `cache key: ${h}`, `idempotency key: ${m}`, `ssh host key ${h}`, `tokenizer: ${h}`, `"secretaryId": "${m}"`, `const API_KEY_HASH = "${h}"`,
    `{"authorization_code_hash":"${h}"}`, `secret_key_id = ${g}`, `token_count: ${m}`, `password_fingerprint: ${g}`]) assert.equal(redactText(text), text, text.slice(0, 30));
  for (const text of [`api key: ${h}`, `auth key ${h}`, `access key ${g}`, `secret ${h}`, `"key": "${m}"`, `the key is ${g}`, `password = ${m}`, `client_secret: ${h}`, `SECRET_KEY=${h}`, `"apiKey": "${g}"`, `signing key: ${h}`])
    assert.ok(!redactText(text).includes(h.slice(0, 32)) && !redactText(text).includes(g) && !redactText(text).includes(m), text.slice(0, 30));
});

test("second review: redactError never throws, stays bounded, and leaves nothing of a key reachable in what the sink gets", () => {
  const key = ghKey(47);
  // Everything reachable from a value, read the way a logger does (own fields, cause, errors), and whether the key is in any of it.
  const leaks = (v: unknown, seen = new Set<unknown>()): boolean => {
    if (typeof v === "string") return v.includes(key.slice(4));
    if (v === null || typeof v !== "object" || seen.has(v)) return false;
    seen.add(v);
    const e = v as Record<string, unknown>;
    const parts: unknown[] = [...Object.values(e)];
    if (v instanceof Error) parts.push(e["message"], e["stack"], e["cause"], e["errors"]);
    return parts.some((p) => leaks(p, seen));
  };
  const throwing = new Proxy({}, { getPrototypeOf() { throw new Error("trap"); } });
  assert.doesNotThrow(() => redactError(throwing));
  assert.doesNotThrow(() => redactedSink(() => {})(throwing));
  assert.doesNotThrow(() => redactError(new Proxy(new Error("x"), { get() { throw new Error("trap"); } })));
  // A plain object with cycles and shared references: once walked exponentially (four self references never finished; a 20-level diamond took 8 s).
  const cyclic: Record<string, unknown> = { note: `quoted ${key}` };
  for (let i = 0; i < 4; i++) cyclic[`k${i}`] = cyclic;
  let diamond: Record<string, unknown> = { leaf: `x ${key}` };
  for (let i = 0; i < 40; i++) diamond = { a: diamond, b: diamond };
  for (const v of [cyclic, diamond]) {
    const t0 = performance.now();
    const out = redactError(v);
    assert.ok(performance.now() - t0 < 500, "bounded");
    assert.equal(leaks(out), false);
  }
  // A cause chain longer than the old limit of four, and a cause that is the error itself: the copy once kept the ORIGINAL fifth cause.
  let chain: Error = new Error(`deep ${key}`);
  for (let i = 0; i < 9; i++) chain = new Error(`level ${i} ${key}`, { cause: chain });
  assert.equal(leaks(redactError(chain)), false, "a long cause chain");
  const loop: Error & { cause?: unknown } = new Error(`x ${key}`);
  loop.cause = loop;
  assert.equal(leaks(redactError(loop)), false, "a cause that is the error");
  // Fields a clean message does not show: a child process's output, a request's headers, an AggregateError's errors. Once passed on as the same raw object.
  const child = Object.assign(new Error("Command failed: git status"), { stdout: `token ${key}`, code: 128 });
  const outChild = redactError(child) as Error & { stdout?: string; code?: number };
  assert.notEqual(outChild, child);
  assert.equal(outChild.code, 128);
  assert.equal(outChild.message, "Command failed: git status");
  assert.equal(leaks(outChild), false);
  const request = Object.assign(new Error("request failed"), { config: { headers: { Authorization: `Bearer ${key}` }, url: "https://host.invalid/x" } });
  const outRequest = redactError(request) as Error & { config?: { url?: string } };
  assert.equal(leaks(outRequest), false);
  assert.equal(outRequest.config?.url, "https://host.invalid/x");
  const aggregate = new AggregateError([new Error("fine"), new Error(`inner ${key}`)], "all failed");
  const outAggregate = redactError(aggregate) as AggregateError;
  assert.equal(leaks(outAggregate), false);
  assert.equal((outAggregate.errors as Error[])[0]!.message, "fine");
  // Still the same object when nothing is secret, own fields and all.
  const cleanChild = Object.assign(new Error("Command failed: ls"), { stdout: "a.txt", code: 2 });
  assert.equal(redactError(cleanChild), cleanChild);
  const cleanAggregate = new AggregateError([new Error("a")], "b");
  assert.equal(redactError(cleanAggregate), cleanAggregate);
});
