import assert from "node:assert/strict";
import { test } from "node:test";
import { findCredentialShapes } from "./credential-patterns.js";
import { REDACTED, redactText } from "./redact.js";
import { labelledSecret } from "./secret-scan.js";

// Look-alike letters (a Cyrillic `o` in `token=`, a Greek `p` in a key's prefix) are read as the Latin letter by the matching view, and ordinary text that must never be refused (lock-file hashes, SHAs,
// UUIDs, go.sum, SSH public keys, temporary paths on every platform, prose in other scripts) stays. Every key is built at run time (push protection scans each commit) from invented random characters.

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (r: () => number, s: string, n: number): string => Array.from({ length: n }, () => s[Math.floor(r() * s.length)]).join("");
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const B64 = ALNUM + "+/";
const HEX = "0123456789abcdef";
const cp = (...n: number[]): string => String.fromCodePoint(...n);
const CYR = { a: cp(0x430), e: cp(0x435), o: cp(0x43e), p: cp(0x440), c: cp(0x441), x: cp(0x445), s: cp(0x455), i: cp(0x456) };
const ZW = cp(0x200b);
const hex = (seed: number, n: number): string => { let h = pick(rng(seed), HEX, n); if (!/\d/.test(h) || !/[a-f]/.test(h)) h = `1a${h.slice(2)}`; return h; };

test("a look-alike letter in a key prefix or a parameter name does not hide the key", () => {
  const body = pick(rng(1), ALNUM, 36);
  const cases: [string, string][] = [
    [`g${"h" + CYR.p}_${body}`, "a Cyrillic er in the GitHub prefix"],
    [`${CYR.s}k-${pick(rng(2), ALNUM, 40)}`, "a Cyrillic s in sk-"],
    [`AK${CYR.i}A${pick(rng(3), "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", 16)}`, "a Cyrillic i in an AWS prefix"],
    [`gh${CYR.p}_${body.slice(0, 20).replace(/[a-z]/, CYR.a)}${body.slice(20)}`, "a look-alike in the body too"],
    [`t${CYR.o}ken=${pick(rng(4), ALNUM, 12)}`, "a Cyrillic o in a parameter name"],
    [`passw${CYR.o}rd: ${pick(rng(5), ALNUM, 10)}`, "a Cyrillic o in password"],
    [`s${CYR.e}cr${CYR.e}t=${pick(rng(6), ALNUM, 10)}`, "Cyrillic e in secret"],
    [`api_k${CYR.e}y=${pick(rng(7), ALNUM, 12)}`, "a Cyrillic e in api_key"],
    [`gh${cp(0x3c1)}_${body}`, "a Greek rho in the GitHub prefix"],
    [`n${cp(0x3c1)}m_${pick(rng(8), ALNUM, 36)}`, "a Greek rho in npm_"],
    [`Authorizati${CYR.o}n: Basic ${pick(rng(9), ALNUM, 24)}`, "a Cyrillic o in Authorization"],
  ];
  for (const [text, why] of cases) {
    const seen = findCredentialShapes(text);
    assert.ok(seen.length > 0, `${why}: refused`);
    const out = redactText(text);
    assert.ok(out.includes(REDACTED), `${why}: redacted`);
    assert.ok(!out.includes(CYR.p + "_") && !/[A-Za-z0-9]{12,}/.test(out.replace(/Authorizati.n: Basic/, "")), `${why}: nothing of the key is left (${out})`);
    assert.equal(redactText(out), out, `${why}: idempotent`);
  }
});

test("look-alike letters, zero-width characters and a line break together", () => {
  const body = pick(rng(20), ALNUM, 36);
  const key = `gh${CYR.p}_${body.slice(0, 12)}${ZW}${body.slice(12, 20)}\n${body.slice(20)}`;
  assert.ok(findCredentialShapes(key).includes("GitHub token"));
  const out = redactText(`before ${key} after`);
  assert.ok(out.startsWith("before ") && out.endsWith(" after"), "the text around keeps its characters");
  assert.ok(!out.includes(body.slice(25)), "the key's last part is gone");
});

test("a labelled secret in plain words is seen through look-alikes", () => {
  assert.equal(labelledSecret(`my passw${CYR.o}rd is ${"Tr0ub" + "4dor9"}`), true);
  assert.equal(labelledSecret(`the t${CYR.o}ken is expired`), false);
});

test("the original text outside a match is not changed by the fold", () => {
  const text = `Ghost ${CYR.p}${CYR.a}${CYR.c} ${cp(0x3b1)}${cp(0x3b2)} stays`;
  assert.equal(redactText(text), text);
  assert.deepEqual(findCredentialShapes(text), []);
});

test("ordinary text is never taken for a key: lock-file hashes, SHAs, UUIDs, go.sum, SSH keys, temporary paths, other scripts", () => {
  const r = rng(99);
  const sri = (n: number): string => pick(r, B64, n - 2) + "==";
  const corpus: string[] = [
    `"integrity": "sha512-${sri(88)}",`,
    `"integrity": "sha1-${pick(r, B64, 27)}=",`,
    `"resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",`,
    `commit ${hex(1, 40)}`,
    `Merge: ${hex(2, 7)} ${hex(3, 7)}`,
    `${hex(4, 40)} refs/heads/main`,
    `id ${[8, 4, 4, 4, 12].map((n, i) => hex(10 + i, n)).join("-")}`,
    `docker.io/library/node@sha256:${hex(5, 64)}`,
    `Image ID: sha256:${hex(6, 64)}`,
    `github.com/stretchr/testify v1.8.4 h1:${pick(r, B64, 43)}=`,
    `github.com/stretchr/testify v1.8.4/go.mod h1:${pick(r, B64, 43)}=`,
    `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${pick(r, ALNUM, 43)} rob@host`,
    `ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ${pick(r, ALNUM, 90)} rob@host`,
    `/var/folders/${pick(r, "0123456789abcdefghijklmnopqrstuvwxyz", 2)}/${pick(r, "0123456789abcdefghijklmnopqrstuvwxyz_", 30)}/T/nn-tv-${pick(r, ALNUM, 6)}`,
    `/private/var/folders/zz/${pick(r, "0123456789abcdefghijklmnopqrstuvwxyz_", 30)}/T/nn-${pick(r, ALNUM, 8)}/work`,
    `C:\\Users\\runneradmin\\AppData\\Local\\Temp\\nn-tv-${pick(r, ALNUM, 6)}\\Worker2Sandbox`,
    `C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\${pick(r, ALNUM, 10)}\\store`,
    `https://github.com/rkcth/nimblenewt/blob/${hex(7, 40)}/packages/controller/src/security/secret-scan.ts#L120-L140`,
    `https://example.org/a/b/c?page=2&sort=name&q=hello+world`,
    `/tmp/nn-slot-${pick(r, HEX, 8)}/scratchpad/impl-common2.txt`,
    "Привет, мир! Это обычное предложение на русском языке, без всяких ключей и паролей.",
    "Ελληνικό κείμενο: ένα απλό σχόλιο για τον κώδικα και τις ρυθμίσεις του συστήματος.",
    "Սա սովորական նախադասություն է՝ առանց որևէ գաղտնի բանալու։",
    "Список: ААААААААААААААААААААААААААААААААААААААААА ВВВВВВВВВВВВВВВВВВВВ",
    "ПриветМирЭтоОченьДлинноеСловоБезПробеловИЦифр2024СтрокаКонец",
  ];
  for (const text of corpus) {
    assert.deepEqual(findCredentialShapes(text), [], `refused: ${text.slice(0, 60)}`);
    assert.equal(redactText(text), text, `changed: ${text.slice(0, 60)}`);
  }
});

test("worst-case inputs take linear time: look-alike runs, many marks, long mixed-script lines", () => {
  // A quadratic matcher would take 256 times as long for 16 times the text; linear is 16 times. A wide margin keeps a loaded machine from failing the test.
  const kinds: [string, (n: number) => string][] = [
    ["look-alike letters only", (n) => (CYR.o + CYR.a + CYR.e).repeat(n / 3)],
    ["a look-alike prefix repeated", (n) => `g${"h" + CYR.p}_ `.repeat(n / 6)],
    ["a look-alike key name repeated", (n) => `t${CYR.o}ken `.repeat(n / 6)],
    ["one long mixed-script word", (n) => (CYR.o + "a1B").repeat(n / 4)],
    ["zero-width characters between look-alikes", (n) => (CYR.p + ZW).repeat(n / 2)],
    ["quotes and plus signs between look-alikes", (n) => `"${CYR.s}k-" + `.repeat(n / 10)],
    ["lines of key characters", (n) => ("ghp_" + CYR.a + "\n").repeat(n / 6)],
  ];
  const time = (text: string): number => { const t0 = performance.now(); redactText(text); findCredentialShapes(text); return performance.now() - t0; };
  for (const [name, make] of kinds) {
    time(make(1 << 12)); // warm up
    const small = Math.max(time(make(1 << 16)), 5);
    const big = time(make(1 << 20));
    assert.ok(big < 20000, `${name}: ${Math.round(big)} ms for 1 M characters`);
    assert.ok(big / small < 80, `${name}: 16 times the text took ${(big / small).toFixed(0)} times as long`);
  }
});
