import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanText, datum, type AnchorFacts } from "../context/anchor.js";
import { cutNote } from "../context/budget.js";
import { composeRecall, parseRecallArgs, type RecallSource } from "../context/recall.js";
import { cleanThinking } from "../context/thinking-store.js";
import { refuseCredentials } from "../chat/interpreter.js";
import { derivedId } from "../domain/ids.js";
import { quoted, shown } from "../status/explain.js";
import { cleanUntrusted } from "./clean.js";
import { findCredentialShapes } from "./credential-patterns.js";
import { redactText } from "./redact.js";
import { ENTROPY_MAX_WORDS, ENTROPY_MIN_BITS, ENTROPY_MIN_TRANSITIONS, highEntropy, labelledSecret, scanSecrets } from "./secret-scan.js";

// The credential-redaction follow-up (U09b / W13 limits): one folded matching view (NFKC, invisible characters left out, line-split prefixed tokens, orphan key END, long high-entropy runs)
// behind redactText and findCredentialShapes, and one cleaning pipeline (cleanUntrusted) behind the anchor, task.recall and the thinking store.

/** A seeded generator (mulberry32), so a failure names a seed that reproduces it. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const B64URL = `${ALNUM}-_`;
const HEX = "0123456789abcdef";
const pick = (r: () => number, s: string, n: number): string => Array.from({ length: n }, () => s[Math.floor(r() * s.length)]).join("");
const allClasses = (s: string): boolean => /[A-Z]/.test(s) && /[a-z]/.test(s) && /\d/.test(s);

interface Family { readonly name: string; readonly prefix: string; readonly body: (r: () => number) => string; readonly caseFree?: boolean; readonly joinable?: boolean }
const FAMILIES: readonly Family[] = [
  { name: "GitHub", prefix: "ghp_", body: (r) => pick(r, ALNUM, 36), caseFree: true, joinable: true },
  { name: "sk-", prefix: "sk-", body: (r) => pick(r, ALNUM, 40), caseFree: true, joinable: true },
  { name: "Anthropic", prefix: "sk-ant-api03-", body: (r) => pick(r, ALNUM, 60), caseFree: true, joinable: true },
  { name: "Slack", prefix: "xoxb-", body: (r) => `${pick(r, "0123456789", 12)}-${pick(r, ALNUM, 24)}`, caseFree: true, joinable: true },
  { name: "AWS", prefix: "AKIA", body: (r) => pick(r, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 16), caseFree: true, joinable: true },
  { name: "fine-grained", prefix: "github_pat_", body: (r) => pick(r, ALNUM, 50), caseFree: true, joinable: true },
  { name: "JWT", prefix: "eyJ", body: (r) => `${pick(r, B64URL, 20)}.eyJ${pick(r, B64URL, 30)}.${pick(r, B64URL, 43)}`, joinable: true },
  { name: "bare base64url key", prefix: "", body: (r) => { for (;;) { const k = pick(r, B64URL, 43); if (allClasses(k)) return k; } } },
  { name: "bare hex key", prefix: "", body: (r) => { for (;;) { const k = pick(r, HEX, 48); if (/\d/.test(k) && /[a-f]/.test(k)) return k; } } },
];
const INVISIBLE = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x202e, 0x2066, 0x2069, 0x061c, 0x00ad, 0xfe0f, 0xe0041, 0x180e].map((c) => String.fromCodePoint(c));
const BREAKS = ["\n", "\r\n", "\n  ", " \n\t"];
const wide = (c: string): string => (c >= "!" && c <= "~" ? String.fromCharCode(c.charCodeAt(0) + 0xfee0) : c);
const insertAt = (s: string, at: number, what: string): string => s.slice(0, at) + what + s.slice(at);

interface Disguised { readonly text: string; readonly body: string; readonly how: string }
function disguise(r: () => number, f: Family): Disguised {
  const body = f.body(r);
  let prefix = f.prefix;
  let rest = body;
  const how: string[] = [];
  if (f.caseFree === true && r() < 0.5) { prefix = Array.from(prefix, (c) => (r() < 0.5 ? c.toUpperCase() : c.toLowerCase())).join(""); how.push("case"); }
  if (r() < 0.5) { rest = Array.from(rest, (c) => (r() < 0.3 ? wide(c) : c)).join(""); prefix = Array.from(prefix, (c) => (r() < 0.3 ? wide(c) : c)).join(""); how.push("fullwidth"); }
  const invisible = r() < 0.7 ? 1 + Math.floor(r() * 3) : 0;
  for (let i = 0; i < invisible; i++) { const at = Math.floor(r() * (rest.length + 1)); rest = insertAt(rest, at - (at > 0 && /[\ud800-\udbff]/.test(rest[at - 1]!) ? 1 : 0), INVISIBLE[Math.floor(r() * INVISIBLE.length)]!); }
  if (invisible > 0) how.push(`invisible×${invisible}`);
  if (f.joinable === true && r() < 0.4) { const at = 1 + Math.floor(r() * (rest.length - 2)); if (!/[\ud800-\udfff]/.test(rest.slice(at - 1, at + 1))) { rest = insertAt(rest, at, BREAKS[Math.floor(r() * BREAKS.length)]!); how.push("split over lines"); } }
  return { text: prefix + rest, body, how: how.join(", ") || "plain" };
}

/** What a reader could still read of the output: escapes written out by status views removed, NFKC-folded, invisible characters and whitespace gone. */
const readable = (out: string): string => out.replace(/\\u[0-9a-fA-F]{4}/g, "").replace(/\\[nrt]/g, "").normalize("NFKC").replace(/[\p{Cf}\s\u0000-\u001f\u007f-\u009f]/gu, "").replace(/[\u2010-\u2015\u2212]/g, "-");
/** Whether any 12-character piece of the secret's body can still be read. */
function leaks(out: string, body: string): string | undefined {
  const seen = readable(out);
  for (let i = 0; i + 12 <= body.length; i++) if (seen.includes(body.slice(i, i + 12))) return body.slice(i, i + 12);
  return undefined;
}

const facts = (title: string): AnchorFacts => ({ taskId: "tsk-aaaaaaaaaaaaaaaaaaaa", projectId: "prj-bbbbbbbbbbbbbbbbbbbb", attemptId: "att-cccccccccccccccccccc", title, description: "Every pot.", acceptanceCriteria: ["every pot is wet"], notes: [{ kind: "did", text: title }] });
const recallSource = (text: string): RecallSource => ({ taskId: "tsk-aaaaaaaaaaaaaaaaaaaa", attemptId: "att-cccccccccccccccccccc", anchor: facts(text), attempts: [], handoffs: [], archives: [], archive: async () => undefined });

/** Every entry point the pipeline unifies, as text out (or a refusal). */
const ENTRY_POINTS: readonly { readonly name: string; readonly run: (text: string) => Promise<string | "refused"> | string | "refused" }[] = [
  { name: "redactText", run: (t) => redactText(t) },
  { name: "findCredentialShapes (notes refuse)", run: (t) => (findCredentialShapes(t).length > 0 ? "refused" : t) },
  { name: "refuseCredentials (chat)", run: (t) => { try { refuseCredentials(t, "text"); return t; } catch { return "refused"; } } },
  { name: "cleanUntrusted keep", run: (t) => cleanUntrusted(t, { lines: "keep" }).text },
  { name: "cleanUntrusted fold NFKC", run: (t) => cleanUntrusted(t, { lines: "fold", form: "NFKC" }).text },
  { name: "anchor cleanText", run: (t) => cleanText(t) },
  { name: "anchor datum", run: (t) => datum(t, 5000) },
  { name: "task.recall", run: async (t) => (await composeRecall(recallSource(t), parseRecallArgs({}))).text },
  { name: "thinking store", run: (t) => cleanThinking(t).text },
  { name: "status shown", run: (t) => shown(t, 5000) },
  { name: "status quoted", run: (t) => quoted(t, 5000) },
  { name: "note cut", run: (t) => cutNote({ head: ["Hand-off"], list: t.split(/\r?\n/) }, 6000).text },
];

test("property: a secret split by zero-width or bidi characters, written in fullwidth or mixed-case look-alikes, or split over lines, is redacted at every entry point", async () => {
  const runs = Number(process.env["NN_SECRET_PROPERTY_RUNS"] ?? 60);
  for (let seed = 1; seed <= runs; seed++) {
    const r = rng(seed);
    for (const f of FAMILIES) {
      const d = disguise(r, f);
      const text = `before ${d.text} after`;
      for (const e of ENTRY_POINTS) {
        const out = await e.run(text);
        if (out === "refused") continue;
        const leak = leaks(out, d.body);
        assert.equal(leak, undefined, `seed ${seed}, ${f.name} (${d.how}) leaked "${leak}" through ${e.name}: ${JSON.stringify(out).slice(0, 300)}`);
        if (e.name === "redactText") {
          assert.equal(redactText(out), out, `seed ${seed}, ${f.name}: redaction is idempotent`);
          assert.equal(out.split("\n").length, text.split("\n").length, `seed ${seed}, ${f.name}: redaction never joins or adds lines`);
          assert.ok(out.startsWith("before ") && out.endsWith(" after"), `seed ${seed}, ${f.name}: the words around it stay: ${JSON.stringify(out)}`);
        }
      }
    }
  }
});

test("each disguise on its own is caught (fixed cases)", () => {
  const ZW = "\u200b";
  assert.equal(redactText(`k ghp_${ZW}abcdefghijklmnopqrstuvwxyz0123456789 k`), "k [redacted] k");
  assert.equal(redactText("k ｇｈｐ＿ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴ0123 k"), "k [redacted] k", "fullwidth");
  assert.equal(redactText("k GHP_abcdefghijklmnopqrstuvwxyz0123456789 k"), "k [redacted] k", "upper-case prefix");
  assert.equal(redactText("k sk\u2011abcdefghijklmnopqrstuvwxyz k"), "k [redacted] k", "a non-breaking hyphen");
  assert.equal(redactText("k \u202eAKIA\u2066ABCDEFGHIJKLMNOP\u2069 k"), "k \u202e[redacted]\u2069 k", "bidi marks: everything from the first matched character to the last is replaced, outside marks stay");
  assert.equal(redactText("k ghp_abcdefghijklmnop\nqrstuvwxyz0123456789 k"), "k [redacted]\n[redacted] k", "split over two lines: each line's part is marked, the line break stays");
  assert.equal(redactText("eyJhbGciOiJIUzI1NiJ9.\neyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk end"), "[redacted]\n[redacted] end", "a JWT wrapped at a dot");
  assert.equal(redactText("the code is sk-live-ABCDEFGHIJKLMNOPQRSTUVWX1234\nstep 011: clear bed 11"), "the code is [redacted]\nstep 011: clear bed 11", "a whole token at a line's end does not take the next line's first word");
  assert.equal(redactText("k ghp_abcdefgh\nijklmnopqrstuvwxyz0123 k"), "k [redacted]\n[redacted] k", "a first part too short to be a token is joined with what follows");
  assert.equal(redactText("hash 7f3a9c0b5e1d2f4a6b8c0d1e2f3a4b5c6d7e8f90a1b2c3d4 end"), "hash [redacted] end", "48 hex characters (no digest shape)");
  assert.equal(redactText("use q8Zt3VvKpR0aW7yX2mN5bC9dE1fG4hJ6kL0sT3uV8wY z"), "use [redacted] z", "a 43-character base64url key with no prefix");
  assert.deepEqual(findCredentialShapes("use q8Zt3VvKpR0aW7yX2mN5bC9dE1fG4hJ6kL0sT3uV8wY z"), ["high-entropy key"]);
  assert.deepEqual(findCredentialShapes(`ghp${ZW}_abcdefghijklmnopqrstuvwxyz0123`), ["GitHub token"]);
  assert.equal(redactText("nothing\u200b here ｆｕｌｌｗｉｄｔｈ ﬁne"), "nothing\u200b here ｆｕｌｌｗｉｄｔｈ ﬁne", "text without a secret keeps every character it had");
});

test("private keys: a header hidden by invisible or fullwidth characters, and a key split over two texts (orphan END), are redacted, line by line", () => {
  const body = ["MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7", "Zm9vYmFyYmF6cXV4", "abc=="];
  const hidden = `before\n-----BEGIN PRIV\u200bATE KEY-----\n${body.join("\n")}\n-----END PRIVATE KEY-----\nafter`;
  const out = redactText(hidden);
  for (const b of body) assert.ok(!out.includes(b), out);
  assert.ok(out.startsWith("before\n") && out.endsWith("\nafter"), out);
  assert.equal(out.split("\n").length, hidden.split("\n").length, "a folded-view match keeps the lines");
  const wideDashes = `－－－－－BEGIN PRIVATE KEY－－－－－\n${body.join("\n")}\n－－－－－END PRIVATE KEY－－－－－`;
  for (const b of body) assert.ok(!redactText(wideDashes).includes(b), redactText(wideDashes));
  // The first text has the BEGIN and is cut there; the second carries the rest.
  assert.equal(redactText("-----BEGIN PRIVATE KEY-----\nMIIEvQIBADAN"), "[redacted]");
  const second = `${body.slice(1).join("\n")}\n-----END PRIVATE KEY-----\nthen run the tests`;
  assert.equal(redactText(second), "[redacted]\n[redacted]\n-----END PRIVATE KEY-----\nthen run the tests", "the body lines go; the END line (no secret) stays for readers that look for it");
  assert.deepEqual(findCredentialShapes(second), ["private key block"]);
  assert.equal(cleanThinking(second).text, "[redacted]\nthen run the tests", "the thinking store still hides everything up to an orphan END");
  const split = cleanThinking(`${body[1]}\n-----END PRIV\u200bATE KEY-----\nthen`);
  assert.ok(!split.text.includes(body[1]!) && split.text.endsWith("\nthen") && split.redacted, split.text);
  const note = cutNote({ head: ["Hand-off"], list: second.split("\n") }, 1000).text;
  for (const b of body.slice(1)) assert.ok(!note.includes(b), note);
});

test("the high-entropy threshold: hex digests of the lengths the product shows stay, other long hex goes, and base64 needs every class, entropy and mixing", () => {
  const hex = (n: number): string => createHash("sha512").update(String(n)).digest("hex").repeat(2).slice(0, n);
  for (const n of [24, 31, 32, 40, 64, 128]) assert.equal(highEntropy(hex(n)), false, `${n} hex`);
  for (const n of [33, 39, 41, 48, 63, 65, 96, 127, 129]) assert.equal(highEntropy(hex(n)), true, `${n} hex`);
  assert.equal(highEntropy("q8Zt3VvKpR0aW7yX2mN5bC9dE1fG4hJ6"), true, "32 base64 characters");
  assert.equal(highEntropy("q8Zt3VvKpR0aW7yX2mN5bC9dE1fG4hJ"), false, "31 is below the length");
  assert.equal(highEntropy("abcdefghijklmnopqrstuvwxyz0123456789ABCD"), false, "an alphabet is not mixed enough");
  assert.equal(highEntropy("qzrtvvkprmawyxmnbcdefghjklstuvwy"), false, "one letter case only");
  assert.equal(highEntropy("com/rkcth/NimbleNewt/actions/runs/39499788238"), false, "a URL path");
  assert.equal(highEntropy("backup-20261028T100000Z-scheduled-Daily2"), false, "a name made of words");
  assert.equal(highEntropy(`sha512-${"q8Zt3VvKpR0aW7yX2mN5bC9dE1fG4hJ6".repeat(3)}`), false, "an SRI digest is labelled");
  for (const id of ["ThinkingCollectionBodyRevision2UpdatedAt", "packageLockJsonIntegrityCheck2026Value", "getHTTPResponseHeaders4XXErrorHandler"]) assert.equal(highEntropy(id), false, `a code name: ${id}`);
  assert.equal(highEntropy("6Xj4AhICnnBg0HdnZYNkuSRaSigli6luBg7GJUaD_q8"), true, "a key with one underscore is not a name of two words");
  assert.ok(ENTROPY_MIN_BITS === 3.7 && ENTROPY_MIN_TRANSITIONS === 0.25 && ENTROPY_MAX_WORDS === 0.8, "the documented threshold");
});

test("no false positives over the product's own strings: SHAs, digests, UUIDs, ULIDs, derived IDs, cursors, cache keys, paths and URLs pass unchanged", () => {
  const r = rng(7);
  const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const legit: string[] = [];
  for (let i = 0; i < 200; i++) {
    const seed = `${i}-${r()}`;
    const h = (alg: string): string => createHash(alg).update(seed).digest("hex");
    const b64 = (n: number, enc: "base64" | "base64url"): string => Buffer.from(Array.from({ length: n }, () => Math.floor(r() * 256))).toString(enc);
    legit.push(
      `commit ${h("sha1")} on main`, h("sha256"), `sha256:${h("sha256")}`, `v1:sha256:${h("sha256")}`, `hmac-sha256:${h("sha256")}`, h("sha512"), h("md5"), h("sha1").toUpperCase(),
      `blob ${h("sha256")} for src/a.ts is no longer in the store`, `change ${h("md5")} pending`, `cov-${h("sha1")}`, `wend-${h("md5")}`, `rck-${h("sha1").slice(0, 24)}`, `op:${h("sha1").slice(0, 24)}`,
      randomUUID(), randomUUID().toUpperCase(), `rs-${randomUUID()}`, pick(r, crockford, 26), derivedId("task", seed), derivedId("tkr", seed), `nn-${b64(20, "base64url")}`,
      `next ~${b64(40 + Math.floor(r() * 80), "base64url")}`, `integrity sha512-${b64(64, "base64")}`, `sha384-${b64(48, "base64")}`,
      `2026-11-11T07:49:44.${Math.floor(r() * 1000)}Z`, `seed_${Math.floor(r() * 1e13)}`,
    );
  }
  legit.push(
    "/srv/code/worktrees-pi/x09b-fix3a-REPORT", "packages/controller/src/security/credential-patterns.ts", "C:\\Users\\Rob\\AppData\\Local\\Temp\\nn-abc123\\Worker2Sandbox",
    "https://github.com/rkcth/NimbleNewt/actions/runs/39499788238", "https://github.com/tyranid/oleviewdotnet/blob/7e9aa884e013b6773ef578ad391dbad9b30c11d/README.md",
    "NFS/SMB/CIFS/AFS/Ceph/9p/Lustre/GPFS/FUSE", "backup-20261028T100000Z-scheduled", "/opt/homebrew/Cellar/a/1/lib/liba", "ThinkingCollectionBodyRevision2UpdatedAt",
    "水やり、完了しました。（ＯＫ）", "مرحبا\u200f بالعالم", "e\u0301cole",
  );
  for (const s of legit) {
    assert.equal(redactText(s), s, `redactText changed ${JSON.stringify(s)}`);
    assert.deepEqual(findCredentialShapes(s), [], `a note holding ${JSON.stringify(s)} would be refused`);
    assert.doesNotThrow(() => refuseCredentials(s, "text"), `chat would refuse ${JSON.stringify(s)}`);
    if (!/[\p{Cf}\s]/u.test(s)) assert.equal(cleanText(s), s, `the anchor changed ${JSON.stringify(s)}`);
  }
});

test("no false positives over the product's own text: no non-test source file of any package and no document holds a run the high-entropy rule takes", () => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const n of readdirSync(dir)) {
      if (n === "node_modules" || n === "dist" || n.startsWith(".")) continue;
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|md|mjs)$/.test(n) && !/\.test\.ts$/.test(n)) files.push(p);
    }
  };
  walk(join(root, "packages"));
  walk(join(root, "docs"));
  assert.ok(files.length > 500, `the scan found the sources (${files.length})`);
  const hits = files.flatMap((f) => { const t = readFileSync(f, "utf8"); return scanSecrets(t).filter((s) => s.name === "high-entropy key").map((s) => `${f}: ${t.slice(s.start, s.end)}`); });
  assert.deepEqual(hits, []);
});

// Clean-context review of the scanner (card 20): misses, false positives and slow inputs found by probing with invented keys.
test("review: env-style, JSON and header secrets are redacted; the extra token shapes are caught", () => {
  const key40 = "Q7vXk2Lp9Rz4Tm8Wn3Yb6Hc1Jd5Fg0Ks+Ua/Ve7Xq";
  assert.equal(redactText(`AWS_SECRET_ACCESS_KEY=${key40}`).includes(key40), false, "an AWS secret key in an env line");
  assert.equal(redactText(`AWS_KEY_VALUE=${key40}`), "AWS_KEY_VALUE=[redacted]", "a random value after `=` is not hidden from the entropy rule by the `=`");
  assert.equal(redactText(`AccountName=a;AccountKey=${key40}${key40};x=1`).includes(key40), false, "an Azure account key after `=`");
  for (const line of ["DB_PASSWORD=CorrectHorse99", "CLIENT_SECRET=1Lai5gLopTAYRtiV", "export GITHUB_TOKEN=BOIkmxpxyMwU", "client_secret=107e8cd259969ece8161a61fa51c2da75a475bb6b46764951900e3a4a872714d", "//registry.npmjs.org/:_authToken=l9nfsjUq4JbAog", "Server=db;Uid=sa;Pwd=Sup3rS3cret!;"]) {
    assert.ok(redactText(line).includes("[redacted]"), line);
    assert.ok(findCredentialShapes(line).length > 0, line);
  }
  assert.equal(redactText(`{"password":"hunter2hunter2"}`).includes("hunter2"), false, "a JSON password field");
  assert.equal(redactText("Authorization: Basic YWRtaW46aHVudGVyMnBhc3M="), "[redacted]", "a basic auth header");
  for (const id of ["cmp-a3t55exqmtopjlcotzmj", "cmp-akia55exqmtopjlcotz", "task-asia55exqmtopjlcotz"]) assert.equal(redactText(id), id, `a derived ID ${id} is not an AWS key`);
  assert.equal(redactText("k AkIaSAHKAWQZLR57OSJK k"), "k [redacted] k", "a mixed-case AWS prefix");
  assert.equal(redactText("inputToken = count + 1; max_tokens: 4096; TOKEN_COUNT=5"), "inputToken = count + 1; max_tokens: 4096; TOKEN_COUNT=5", "names that only contain the word stay");
  for (const k of ["ASIASAHKAWQZLR57OSJK", "xapp-1-A0123BCDE-1234567890123-abcdef0123456789", "glpat-" + "WzFy0jJxuG3LjXeMHiOj", "hf_A" + "bCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh", "dckr_p" + "at_2oYsTiONjXKBNHoPGihWy5ovooZ", `dop_v1_${"ab12".repeat(16)}`, `shpat_${"9f3a".repeat(8)}`]) assert.equal(redactText(`k ${k} k`), "k [redacted] k", k);
});

test("review: a combining mark on a key's letter or a lone carriage return does not hide it; the text without a key keeps its marks", () => {
  const key = "ghp_Ooqu0fABOEpBsr8nsW4bAurCh4Zf6XxX5u1O";
  assert.equal(redactText(`k ${key.slice(0, 15)}́${key.slice(15)} k`), "k [redacted] k");
  assert.equal(redactText(`k ${[...key].map((c, i) => (i % 8 === 7 ? `${c}̀` : c)).join("")} k`), "k [redacted] k");
  assert.equal(redactText(`k ${key.slice(0, 18)}\r${key.slice(18)} k`), "k [redacted]\r[redacted] k");
  assert.equal(redactText("café and ño"), "café and ño");
});

test("review: go.sum hashes and SSH public keys are not keys", () => {
  for (const s of ["github.com/foo/bar v1.2.3 h1:Fim8MVMXHoJgOPO7rM5fN+udh9vLDKbvQn1bIYe9F1P=", "x sha256:Fim8MVMXHoJgOPO7rM5fN+udh9vLDKbvQn1bIYe9F1P=", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIQ8Zt3VvKpR0aW7yX2mN5bC9dE1fG4hJ6kL rob@host", "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC7q8Zt3VvKpR0aW7yX2mN5bC9dE1fG4hJ6kL0 rob@host"]) assert.equal(redactText(s), s, s);
  assert.equal(redactText("use q8Zt3VvKpR0aW7yX2mN5bC9dE1fG4hJ6kL0sT3uV8wY z"), "use [redacted] z", "an unlabelled key still goes");
});

test("review: inputs that took quadratic time are linear (a base64 dump with no key END, `eyJ-` repeated), and a non-string never throws", () => {
  const dump = "TWFueSBoYW5kcyBtYWtlIGxpZ2h0IHdvcmsuIFRoZSBxdWljayBicm93bg\n".repeat(8000); // ~480 KB: about 20 s before
  let t = performance.now();
  redactText(dump);
  assert.ok(performance.now() - t < 5000, `base64 dump took ${performance.now() - t} ms`);
  t = performance.now();
  redactText("eyJ-".repeat(60_000)); // 240 KB: about a minute before
  assert.ok(performance.now() - t < 5000, `eyJ- took ${performance.now() - t} ms`);
  const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
  assert.equal(redactText(`ok\n${body}\n${body}\n-----END PRIVATE KEY-----\nnext step\n-----END PRIVATE KEY-----`), "ok\n[redacted]\n[redacted]\n-----END PRIVATE KEY-----\nnext step\n-----END PRIVATE KEY-----", "orphan END lines: only the key lines just above each END");
  for (const v of [undefined, null, 5, {}]) assert.equal(typeof redactText(v as unknown as string), "string");
});

// Card U14c review: a key or password a person writes in plain words has no prefix the shapes know, so the chat refuses it by its label; the words around a secret's NAME, and ordinary sentences, pass.
test("a key or password given in plain words is refused by the chat; a secret's name and ordinary words are not (card U14c review)", () => {
  const hex = ["9f8e7d6c", "5b4a3928", "1706f5e4", "d3c2b1a0"].join("");
  const refused = [
    "my password is Tr0ub4dor&3xyz",
    "the gitea password is hunter2hunter2",
    `api key is ${hex}`,
    `the api key for openrouter is ${hex}.`,
    "here is the key: abcdEFGH1234ijklMNOP5678qrst",
    "Token = q8Zr2LmP0vX",
    "my pass​word is Tr0ub4dor&3xyz",
    "my ｐａｓｓｗｏｒｄ is Tr0ub4dor&3xyz",
    `my openrouter key is or-v1-${hex}`,
  ];
  for (const text of refused) {
    assert.equal(labelledSecret(text), true, text);
    assert.throws(() => refuseCredentials(text, "text"), /secret set NAME/, text);
  }
  const passed = ["the token is expired", "my api key is in the secret store as openrouter", "the key is named backup-key2", "my key is backup-key2", "password is in the store as gitea-pass2", "use the secret backup-key2 for the free route", "my key is 2 days old", "Garden is version 2 of the key project", "rotate the payroll signing key by 2026-12-01"];
  for (const text of passed) {
    assert.equal(labelledSecret(text), false, text);
    assert.doesNotThrow(() => refuseCredentials(text, "text"), text);
  }
});
