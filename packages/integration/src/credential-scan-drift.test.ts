import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanUntrusted as controllerClean, findCredentialShapes as controllerShapes, redactText as controllerRedact } from "@nimblenewt/controller";
import { cleanUntrusted as contractsClean, findCredentialShapes as contractsShapes, redactError as contractsRedactError, redactText as contractsRedact } from "@nimblenewt/contracts";
import { findInlineSecrets } from "@nimblenewt/config";

// The credential scanner exists as the controller's own files and as generated one-file copies in contracts (used by the worker and the Pi adapter) and config (which may import nothing). scripts/copy-credential-scan.test.mjs
// proves the copies are current; this test proves it by BEHAVIOUR over one shared corpus, so a copy that is regenerated from edited code, or a package that wires the wrong function, still shows. Every key is built at run time
// (a GitHub push-protection scan reads every commit).

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = (r: () => number, s: string, n: number): string => Array.from({ length: n }, () => s[Math.floor(r() * s.length)]).join("");
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const r = rng(2026);
const gh = "gh" + "p_" + pick(r, ALNUM, 36);
const sk = "s" + "k-" + pick(r, ALNUM, 40);
const aws = "AK" + "IA" + pick(r, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 16);
const hex64 = "9f2c1ab07d3e45688b1c0a9e7d6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f";
const pem: readonly [string, string, string] = ["-----BEGIN RSA PRIVATE KEY-----", "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7", "-----END RSA PRIVATE KEY-----"];
const CORPUS: readonly string[] = [
  "", "plain words", "disk full", `token ${gh} used`, `${sk}`, `x ${aws} y`, gh.toUpperCase(), gh.replace("ghp_", "ｇｈｐ＿"), `${gh.slice(0, 9)}​${gh.slice(9)}`, `${gh.slice(0, 9)}\n${gh.slice(9)}`,
  `"${gh.slice(0, 4)}" + "${gh.slice(4)}"`, `'${sk.slice(0, 3)}' '${sk.slice(3)}'`, `the api key is ${hex64}`, `sha256: ${hex64}`, `commit ${hex64.slice(0, 40)}`, `"key": "${hex64.slice(0, 32)}"`,
  `Authorization: Basic ${pick(r, ALNUM, 24)}`, "Bearer " + pick(r, ALNUM, 30), "https://user:hunter2pass@host.invalid/x", "https://host.invalid/x", "password: hunter2pass", "max_tokens: 4096",
  pem.join("\n"), `notes\n${pem[1]}\n${pem[2]}\nnext`, `${pem[0]}\n${pem[1]}`, `a\n${pem[2].slice(0, 9)}​${pem[2].slice(9)}\nb`, "say \"hello\" + \"world\"", "list = [\"a\", \"b\"]",
  pick(r, ALNUM, 44), "backup-20261028T100000Z-scheduled", "ThinkingCollectionBodyRevision2UpdatedAt", "é café ñ", "ghp_ only a prefix", "\ud800 lone",
];

test("the controller's scanner and its copies in contracts and config agree over one corpus", () => {
  for (const text of CORPUS) {
    const label = JSON.stringify(text).slice(0, 60);
    assert.equal(contractsRedact(text), controllerRedact(text), `redactText ${label}`);
    assert.deepEqual(contractsShapes(text), controllerShapes(text), `findCredentialShapes ${label}`);
    for (const lines of ["keep", "fold"] as const) {
      assert.deepEqual(contractsClean(text, { lines }), controllerClean(text, { lines }), `cleanUntrusted ${lines} ${label}`);
      assert.deepEqual(contractsClean(text, { lines, form: "NFC", continues: true }), controllerClean(text, { lines, form: "NFC", continues: true }), `continues ${lines} ${label}`);
    }
    // The config copy answers through findInlineSecrets: it reports exactly when the scanner finds a shape (as a value and as a name).
    const expected = controllerShapes(text).length > 0;
    assert.equal(findInlineSecrets({ v: text }).some((e) => e.path === "v"), expected, `config value ${label}`);
    if (text !== "") assert.equal(findInlineSecrets({ [text]: 1 }).length > 0, expected, `config name ${label}`);
  }
  const e = new Error(`boom ${gh}`);
  assert.equal((contractsRedactError(e) as Error).message, "boom [redacted]");
});

test("the corpus catches what it should (a guard against a corpus that tests nothing)", () => {
  const hits = CORPUS.filter((t) => controllerShapes(t).length > 0).length;
  assert.ok(hits >= 15 && hits < CORPUS.length - 8, `${hits} of ${CORPUS.length}`);
});
