import assert from "node:assert/strict";
import { test } from "node:test";
import { findInlineSecrets } from "./config.js";

// findInlineSecrets uses the shared credential scanner (a generated copy, see scripts/copy-credential-scan.mjs). Every key is built at run time: a GitHub push-protection scan reads every commit.
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const body = (n: number, shift: number): string => Array.from({ length: n }, (_, i) => ALNUM[(i * 7 + shift * 13 + (i % 3) * 5) % ALNUM.length]).join("");
const gh = "gh" + "p_" + body(36, 1);
const sk = "s" + "k-" + body(40, 2);
const paths = (v: unknown): string[] => findInlineSecrets(v).map((e) => e.path);

test("keys the old short list missed are found in a value: any letter case, fullwidth, split by an invisible character, line or quotes", () => {
  assert.deepEqual(paths({ a: gh.toUpperCase() }), ["a"], "upper case prefix");
  assert.deepEqual(paths({ a: gh.replace("gh", "Gh") }), ["a"]);
  assert.deepEqual(paths({ a: sk.replace("sk-", "ＳＫ－") }), ["a"], "fullwidth");
  assert.deepEqual(paths({ a: `${sk.slice(0, 10)}​${sk.slice(10)}` }), ["a"], "zero-width character");
  assert.deepEqual(paths({ a: `${sk.slice(0, 10)}\n${sk.slice(10)}` }), ["a"], "line break");
  assert.deepEqual(paths({ a: `"${sk.slice(0, 5)}" + "${sk.slice(5)}"` }), ["a"], "quotes and a plus");
  assert.deepEqual(paths({ a: "A" + "SIA" + "ABCDEFGHIJKLMNOP" }), ["a"], "AWS session key");
  assert.deepEqual(paths({ a: "gl" + "pat-" + body(24, 3) }), ["a"], "service token");
  assert.deepEqual(paths({ nested: [{ b: `Authorization: Basic ${body(24, 4)}` }] }), ["nested[0].b"], "basic auth");
  assert.deepEqual(paths({ a: `db password: ${body(14, 5)}` }), ["a"], "a named assignment");
  assert.deepEqual(paths({ a: body(44, 6) }), ["a"], "a long unlabelled high-entropy value");
});

test("a key used as a NAME is withheld in the path, and the message never holds the value", () => {
  const found = findInlineSecrets({ [gh]: 1, ok: { [sk.toUpperCase()]: true } });
  assert.deepEqual(found.map((e) => e.path), ["<key withheld>", "ok.<key withheld>"]);
  assert.ok(!JSON.stringify(found).includes(gh.slice(8)));
  assert.ok(found.every((e) => /^the name looks like an? /.test(e.message)), found[0]!.message);
});

test("ordinary configuration values are not credentials", () => {
  const sha = "0123456789abcdef".repeat(4);
  assert.deepEqual(findInlineSecrets({ name: "Rob's home", url: "https://host.invalid/v1", sha, tokens: 5, inputToken: "count", model: "fake/scripted", path: "/srv/code/worktrees-pi/secrets2/packages/config", secret: { secret: "name" }, text: "keep it short and sweet" }), []);
});
