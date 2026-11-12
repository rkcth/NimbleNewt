import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { argon2idAsync, argon2idSync, blake2b, checkArgon2Params } from "./argon2.js";
import { ARGON2_CEIL_M, ARGON2_FLOOR_M, SealedFileBad, createKeyring, parseKeyring, unlockWithPasscode, UnlockFailed } from "./crypto.js";

// Argon2id (card K01b): the card names it, node:crypto of this version has none, so it is written out and checked against values computed by OpenSSL's own Argon2id (and Blake2b against Python's hashlib).

test("K01b Blake2b: any output length matches the reference values, and 64 bytes matches node's own", () => {
  assert.equal(blake2b(Buffer.from("abc"), 32).toString("hex"), "bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319");
  assert.equal(blake2b(Buffer.alloc(300, 0x61), 20).toString("hex"), "c9c4a2f8df7d9546fad021510f72ee0ae1b15058");
  for (const n of [0, 1, 127, 128, 129, 255, 256, 1000]) assert.equal(blake2b(Buffer.alloc(n, 7), 64).toString("hex"), createHash("blake2b512").update(Buffer.alloc(n, 7)).digest("hex"), `${n} bytes`);
});

test("K01b Argon2id: fixed vectors from OpenSSL (data-independent first half and data-dependent second half, one pass and several)", () => {
  const cases: [string, string, number, number, string][] = [
    ["password", "somesaltsomesalt", 32, 3, "825a45eb17d866fa3e66ba5a7f6d66e319212bee3f21086a036a039669929453"],
    ["a much longer passcode here", "0123456789abcdef", 1024, 2, "6297e9aecea8645fdf93303fc11d8aa64d8ef4992f510e7a77f43b3841fb4fdb"],
    ["xxxxxxxxxx", "fedcba9876543210", 64, 1, "7f61268f8aa2f5f1e3b8cd13cbb413bfc65e08d978a7cd7540ad8fdd6217a979"],
  ];
  for (const [pw, salt, m, t, want] of cases) assert.equal(argon2idSync(Buffer.from(pw), Buffer.from(salt), { m, t, p: 1 }).toString("hex"), want, `m=${m} t=${t}`);
});

test("K01b Argon2id: agrees with the host's OpenSSL at the 64 MiB the card requires (when OpenSSL has Argon2id)", { timeout: 120_000 }, async (t) => {
  let ref: string;
  try { ref = execFileSync("openssl", ["kdf", "-keylen", "32", "-kdfopt", "pass:correct horse battery", "-kdfopt", "salt:0123456789abcdef", "-kdfopt", "iter:3", "-kdfopt", "memcost:65536", "-kdfopt", "lanes:1", "-kdfopt", "threads:1", "-binary", "ARGON2ID"], { stdio: ["ignore", "pipe", "ignore"] }).toString("hex"); } catch { t.skip("this host's openssl has no Argon2id"); return; }
  // Through the worker thread, as the controller runs it.
  assert.equal((await argon2idAsync(Buffer.from("correct horse battery"), Buffer.from("0123456789abcdef"), { m: 65_536, t: 3, p: 1 })).toString("hex"), ref);
});

test("K01b Argon2id: the settings are bounded, the keyring floor is 64 MiB, and a different passcode or salt gives a different key", async () => {
  assert.throws(() => checkArgon2Params({ m: 4, t: 1, p: 1 }), RangeError);
  assert.throws(() => checkArgon2Params({ m: 65_536, t: 3, p: 2 as never }), RangeError);
  assert.notEqual(argon2idSync(Buffer.from("a"), Buffer.from("saltsaltsaltsalt"), { m: 32, t: 1, p: 1 }).toString("hex"), argon2idSync(Buffer.from("b"), Buffer.from("saltsaltsaltsalt"), { m: 32, t: 1, p: 1 }).toString("hex"));
  assert.notEqual(argon2idSync(Buffer.from("a"), Buffer.from("saltsaltsaltsalt"), { m: 32, t: 1, p: 1 }).toString("hex"), argon2idSync(Buffer.from("a"), Buffer.from("saltsaltsaltsal2"), { m: 32, t: 1, p: 1 }).toString("hex"));
  assert.equal(ARGON2_FLOOR_M, 65_536); // 64 MiB
  assert.ok(ARGON2_CEIL_M <= 262_144);
});

test("K01b a new key's passcode wrapper is Argon2id at the default settings, unlocks, and a below-floor or oversized wrapper is refused before any derivation", { timeout: 300_000 }, async () => {
  const { keyring } = await createKeyring({ passcode: "a long enough passcode" });
  const w = keyring.wrappers.find((x) => x.kind === "passcode")!;
  assert.ok(w.kind === "passcode" && w.kdf.name === "argon2id" && w.kdf.m >= 65_536 && w.kdf.t >= 2);
  assert.ok((await unlockWithPasscode(keyring, "a long enough passcode")).keyring.keyId === keyring.keyId);
  await assert.rejects(unlockWithPasscode(keyring, "another long passcode!"), UnlockFailed);
  const tamper = (kdf: unknown) => ({ ...keyring, wrappers: keyring.wrappers.map((x) => x.kind === "passcode" ? { ...x, kdf } : x) });
  for (const bad of [{ name: "argon2id", m: 1024, t: 3, p: 1 }, { name: "argon2id", m: 65_536, t: 1, p: 1 }, { name: "argon2id", m: 4_000_000, t: 3, p: 1 }, { name: "argon2id", m: 65_536, t: 3, p: 4 }, { name: "argon2id", m: 65_536, t: 999, p: 1 }, { name: "md5" }]) assert.throws(() => parseKeyring(tamper(bad)), SealedFileBad, JSON.stringify(bad));
});
