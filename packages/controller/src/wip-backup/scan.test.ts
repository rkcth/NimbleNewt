import assert from "node:assert/strict";
import { test } from "node:test";
import { createWipScanner } from "./index.js";

// Card P02b: the scan every file passes before a work-in-progress push. Every credential here is built at run time from pieces, so no source line holds one.
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const run = (n: number, seed: number): string => Array.from({ length: n }, (_, i) => ALNUM[(i * 7 + seed * 13 + (i % 5) * 11) % ALNUM.length]).join("");
const file = (text: string | Buffer, path = "f.txt") => ({ path, bytes: Buffer.isBuffer(text) ? text : Buffer.from(text, "utf8") });

test("a file with a credential in any of the shapes the controller knows is named, and the reason never repeats what was found", async () => {
  const scan = createWipScanner();
  const samples: Record<string, string> = {
    github: ["gh", "p_", run(36, 1)].join(""),
    "sk key": ["s", "k-", run(40, 2)].join(""),
    aws: ["AK", "IA", "ABCDEFGHIJKLMNOP"].join(""),
    "private key": ["-----BEGIN ", "RSA PRIVATE KEY-----\n", run(64, 3), "\n", run(64, 4), "\n-----END ", "RSA PRIVATE KEY-----\n"].join(""),
    "split over lines": ["gh", "p_", run(18, 5), "\n", run(18, 6)].join(""),
    "split over strings": `const k = "${["gh", "p_"].join("")}" + "${run(36, 7)}";`,
  };
  for (const [name, secret] of Object.entries(samples)) {
    const reason = await scan(file(`# settings\nvalue = ${secret}\n`, "settings.env"));
    assert.ok(reason !== undefined && /credential/.test(reason), `${name}: ${String(reason)}`);
    const probe = secret.replace(/[\n"+ ]/g, "");
    for (const piece of [probe.slice(8, 30), probe.slice(-12)]) assert.ok(!reason!.includes(piece), `${name}: the reason repeats the secret`);
  }
});

test("an ordinary source file, a note and a binary file pass", async () => {
  const scan = createWipScanner({ secrets: () => [{ name: "deploy-token", value: run(30, 8) }] });
  assert.equal(await scan(file("export function add(a: number, b: number): number {\n  return a + b; // adds two numbers\n}\n", "src/add.ts")), undefined);
  assert.equal(await scan(file("Remember to water the beans on Monday and check the token counter on the meter.\n", "notes.md")), undefined);
  assert.equal(await scan(file(Buffer.from([0, 1, 2, 3, 255, 254, 0, 0, 10, 13, 200, 100]), "x.bin")), undefined);
  assert.equal(await scan(file("", "empty")), undefined);
});

test("a secret value the installation uses is found as the exact bytes in any file, text or binary, and named by the secret's name, never its value", async () => {
  const value = run(30, 9);
  const scan = createWipScanner({ secrets: () => [{ name: "deploy-token", value }, { name: "short", value: "abc" }] });
  const text = await scan(file(`the deploy password is ${value}, do not share\n`));
  assert.equal(text, "holds the value of the secret deploy-token");
  const binary = await scan(file(Buffer.concat([Buffer.from([0, 255, 1, 2]), Buffer.from(value, "utf8"), Buffer.from([255, 0])]), "blob.dat"));
  assert.equal(binary, "holds the value of the secret deploy-token");
  assert.equal(await scan(file("abc is a short word that is also the value of a very short secret\n")), undefined, "a value under six bytes would match ordinary text and is not searched for");
  // The value is read at each scan: one added later counts at once.
  const secrets = [{ name: "first", value: run(20, 10) }];
  const live = createWipScanner({ secrets: () => secrets });
  const later = run(20, 11);
  assert.equal(await live(file(later)), undefined);
  secrets.push({ name: "second", value: later });
  assert.equal(await live(file(later)), "holds the value of the secret second");
});

test("a secret store that cannot be read makes the scan fail, so the host leaves the file out", async () => {
  const scan = createWipScanner({ secrets: () => { throw new Error("the store is locked"); } });
  await assert.rejects(scan(file("plain text\n")), /locked/);
});

test("a secret value stored as UTF-16, hexadecimal or base64 inside a file is found too, at any byte alignment (P02b review)", async () => {
  // Short enough that the generic high-entropy check does not fire on the encoded forms: only the value search can find them.
  const value = run(10, 12);
  const scan = createWipScanner({ secrets: () => [{ name: "deploy-token", value }] });
  assert.equal(await createWipScanner()(file(`blob = ${Buffer.from(value).toString("hex")} ${Buffer.from(value).toString("base64")}\n`)), undefined, "the shape scan alone does not find these");
  const named = "holds the value of the secret deploy-token";
  const wrap = (inner: Buffer): Buffer => Buffer.concat([Buffer.from([0, 7, 255, 1]), inner, Buffer.from([9, 0, 200])]);
  assert.equal(await scan(file(wrap(Buffer.from(value, "utf16le")), "res.bin")), named, "UTF-16 little endian");
  assert.equal(await scan(file(wrap(Buffer.from(value, "utf16le").swap16()), "res.bin")), named, "UTF-16 big endian");
  assert.equal(await scan(file(`blob = ${Buffer.from(value).toString("hex").toUpperCase()}\n`)), named, "hexadecimal, upper case");
  for (let prefix = 0; prefix < 3; prefix++) {
    const encoded = Buffer.concat([Buffer.from("xyz".slice(0, prefix)), Buffer.from(value), Buffer.from("!?")]).toString("base64");
    assert.equal(await scan(file(`config: ${encoded}\n`)), named, `base64 after ${prefix} other byte(s)`);
    assert.equal(await scan(file(`config: ${encoded.replace(/\+/g, "-").replace(/\//g, "_")}\n`)), named, `URL-safe base64 after ${prefix} other byte(s)`);
  }
  assert.equal(await scan(file("the hex digits 0123456789abcdef and a base64 alphabet ABCDEFGHIJKLMNOP are ordinary\n")), undefined);
});
