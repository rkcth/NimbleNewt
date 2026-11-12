import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";

/**
 * Argon2id (RFC 9106, version 0x13) for the backup key's passcode wrappers (card K01b). node:crypto offers no Argon2 before Node 24, so this is the algorithm written out, one lane, and checked in the tests against
 * OpenSSL's own Argon2id and the RFC 9106 test vector. The memory fill is plain JavaScript on 32-bit halves (about a few seconds for 64 MiB), so `argon2idAsync` runs it in a worker thread and never blocks the controller.
 */
export interface Argon2Params { readonly m: number; readonly t: number; readonly p: 1 }
/** m is in KiB: 65536 is 64 MiB, the least the card allows. */
export const DEFAULT_ARGON2: Argon2Params = { m: 65_536, t: 3, p: 1 };

// ---- Blake2b (RFC 7693), any output length 1..64; BigInt is fine here: it runs a handful of times per derivation, never in the memory fill.
const M64 = (1n << 64n) - 1n;
const IV = [0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n, 0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n];
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3], [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4], [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13], [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9], [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11], [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5], [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];
const rotr = (x: bigint, n: bigint): bigint => ((x >> n) | (x << (64n - n))) & M64;

export function blake2b(data: Uint8Array, outLength: number): Buffer {
  if (!Number.isInteger(outLength) || outLength < 1 || outLength > 64) throw new RangeError("blake2b output length is 1 to 64");
  const h = [...IV]; h[0] = h[0]! ^ 0x01010000n ^ BigInt(outLength);
  const compress = (block: Buffer, counter: bigint, last: boolean): void => {
    const m: bigint[] = []; for (let i = 0; i < 16; i++) m.push(block.readBigUInt64LE(i * 8));
    const v = [...h, ...IV]; v[12] = v[12]! ^ (counter & M64); if (last) v[14] = v[14]! ^ M64;
    const g = (a: number, b: number, c: number, d: number, x: bigint, y: bigint): void => {
      v[a] = (v[a]! + v[b]! + x) & M64; v[d] = rotr(v[d]! ^ v[a]!, 32n); v[c] = (v[c]! + v[d]!) & M64; v[b] = rotr(v[b]! ^ v[c]!, 24n);
      v[a] = (v[a]! + v[b]! + y) & M64; v[d] = rotr(v[d]! ^ v[a]!, 16n); v[c] = (v[c]! + v[d]!) & M64; v[b] = rotr(v[b]! ^ v[c]!, 63n);
    };
    for (let r = 0; r < 12; r++) {
      const s = SIGMA[r % 10]!;
      g(0, 4, 8, 12, m[s[0]!]!, m[s[1]!]!); g(1, 5, 9, 13, m[s[2]!]!, m[s[3]!]!); g(2, 6, 10, 14, m[s[4]!]!, m[s[5]!]!); g(3, 7, 11, 15, m[s[6]!]!, m[s[7]!]!);
      g(0, 5, 10, 15, m[s[8]!]!, m[s[9]!]!); g(1, 6, 11, 12, m[s[10]!]!, m[s[11]!]!); g(2, 7, 8, 13, m[s[12]!]!, m[s[13]!]!); g(3, 4, 9, 14, m[s[14]!]!, m[s[15]!]!);
    }
    for (let i = 0; i < 8; i++) h[i] = h[i]! ^ v[i]! ^ v[i + 8]!;
  };
  const buf = Buffer.from(data);
  let offset = 0;
  while (buf.length - offset > 128) { compress(buf.subarray(offset, offset + 128), BigInt(offset + 128), false); offset += 128; }
  const rest = Buffer.alloc(128); buf.copy(rest, 0, offset);
  compress(rest, BigInt(buf.length), true);
  const out = Buffer.alloc(64); for (let i = 0; i < 8; i++) out.writeBigUInt64LE(h[i]!, i * 8);
  return out.subarray(0, outLength);
}

const le32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

/** H' of RFC 9106 section 3.3: a hash of any length built from Blake2b. */
function hPrime(input: Buffer, length: number): Buffer {
  const first = Buffer.concat([le32(length), input]);
  if (length <= 64) return blake2b(first, length);
  const parts: Buffer[] = [];
  let v = blake2b(first, 64); parts.push(v.subarray(0, 32));
  let produced = 32;
  while (length - produced > 64) { v = blake2b(v, 64); parts.push(v.subarray(0, 32)); produced += 32; }
  parts.push(blake2b(v, length - produced));
  return Buffer.concat(parts);
}

// ---- The memory fill on 32-bit halves. A block is 1024 bytes: 256 Uint32 (word i is lo = [2i], hi = [2i+1]).
const BLOCK_WORDS = 256;

/** lo*lo as a 64-bit product, returned through `mulHi` and the return value (the low half). */
let mulHi = 0;
function mul32(x: number, y: number): number {
  const xl = x & 0xffff, xh = x >>> 16, yl = y & 0xffff, yh = y >>> 16;
  const ll = xl * yl, lh = xl * yh, hl = xh * yl, hh = xh * yh;
  const mid = (ll >>> 16) + (lh & 0xffff) + (hl & 0xffff);
  mulHi = (hh + (lh >>> 16) + (hl >>> 16) + (mid >>> 16)) >>> 0;
  return ((mid << 16) | (ll & 0xffff)) >>> 0;
}

/** The Blake2b round function with Argon2's multiplication, on the words a,b,c,d (indices into the 16-word state `v`, as 32-bit halves). */
function gb(v: Uint32Array, a: number, b: number, c: number, d: number): void {
  let al = v[2 * a]!, ah = v[2 * a + 1]!, bl = v[2 * b]!, bh = v[2 * b + 1]!, cl = v[2 * c]!, ch = v[2 * c + 1]!, dl = v[2 * d]!, dh = v[2 * d + 1]!;
  let lo: number, hi: number, t: number;
  // a = a + b + 2*lo(a)*lo(b)
  lo = mul32(al, bl); hi = mulHi; hi = ((hi << 1) | (lo >>> 31)) >>> 0; lo = (lo << 1) >>> 0;
  t = (al + bl) >>> 0; let c1 = t < al ? 1 : 0; let sl = t; let sh = (ah + bh + c1) >>> 0;
  t = (sl + lo) >>> 0; c1 = t < sl ? 1 : 0; al = t; ah = (sh + hi + c1) >>> 0;
  // d = rotr(d ^ a, 32)
  { const xl = dl ^ al, xh = dh ^ ah; dl = xh; dh = xl; }
  // c = c + d + 2*lo(c)*lo(d)
  lo = mul32(cl, dl); hi = mulHi; hi = ((hi << 1) | (lo >>> 31)) >>> 0; lo = (lo << 1) >>> 0;
  t = (cl + dl) >>> 0; c1 = t < cl ? 1 : 0; sl = t; sh = (ch + dh + c1) >>> 0;
  t = (sl + lo) >>> 0; c1 = t < sl ? 1 : 0; cl = t; ch = (sh + hi + c1) >>> 0;
  // b = rotr(b ^ c, 24)
  { const xl = bl ^ cl, xh = bh ^ ch; bl = ((xl >>> 24) | (xh << 8)) >>> 0; bh = ((xh >>> 24) | (xl << 8)) >>> 0; }
  // a = a + b + 2*lo(a)*lo(b)
  lo = mul32(al, bl); hi = mulHi; hi = ((hi << 1) | (lo >>> 31)) >>> 0; lo = (lo << 1) >>> 0;
  t = (al + bl) >>> 0; c1 = t < al ? 1 : 0; sl = t; sh = (ah + bh + c1) >>> 0;
  t = (sl + lo) >>> 0; c1 = t < sl ? 1 : 0; al = t; ah = (sh + hi + c1) >>> 0;
  // d = rotr(d ^ a, 16)
  { const xl = dl ^ al, xh = dh ^ ah; dl = ((xl >>> 16) | (xh << 16)) >>> 0; dh = ((xh >>> 16) | (xl << 16)) >>> 0; }
  // c = c + d + 2*lo(c)*lo(d)
  lo = mul32(cl, dl); hi = mulHi; hi = ((hi << 1) | (lo >>> 31)) >>> 0; lo = (lo << 1) >>> 0;
  t = (cl + dl) >>> 0; c1 = t < cl ? 1 : 0; sl = t; sh = (ch + dh + c1) >>> 0;
  t = (sl + lo) >>> 0; c1 = t < sl ? 1 : 0; cl = t; ch = (sh + hi + c1) >>> 0;
  // b = rotr(b ^ c, 63)
  { const xl = bl ^ cl, xh = bh ^ ch; bl = ((xl << 1) | (xh >>> 31)) >>> 0; bh = ((xh << 1) | (xl >>> 31)) >>> 0; }
  v[2 * a] = al; v[2 * a + 1] = ah; v[2 * b] = bl; v[2 * b + 1] = bh; v[2 * c] = cl; v[2 * c + 1] = ch; v[2 * d] = dl; v[2 * d + 1] = dh;
}

/** The permutation P on 16 words picked from the block by `at` (word numbers), written back in place. */
function permute(z: Uint32Array, at: readonly number[]): void {
  const v = new Uint32Array(32);
  for (let i = 0; i < 16; i++) { v[2 * i] = z[2 * at[i]!]!; v[2 * i + 1] = z[2 * at[i]! + 1]!; }
  gb(v, 0, 4, 8, 12); gb(v, 1, 5, 9, 13); gb(v, 2, 6, 10, 14); gb(v, 3, 7, 11, 15);
  gb(v, 0, 5, 10, 15); gb(v, 1, 6, 11, 12); gb(v, 2, 7, 8, 13); gb(v, 3, 4, 9, 14);
  for (let i = 0; i < 16; i++) { z[2 * at[i]!] = v[2 * i]!; z[2 * at[i]! + 1] = v[2 * i + 1]!; }
}
const ROWS: number[][] = Array.from({ length: 8 }, (_, i) => Array.from({ length: 16 }, (_, j) => 16 * i + j));
const COLS: number[][] = Array.from({ length: 8 }, (_, i) => Array.from({ length: 16 }, (_, j) => 2 * i + (j >> 1) * 16 + (j & 1)));

/** next = G(prev, ref) (xor the old next when `xor`), on the block starting at word offsets in `mem` (prev/ref may be the scratch blocks). */
function fillBlock(prev: Uint32Array, prevAt: number, ref: Uint32Array, refAt: number, next: Uint32Array, nextAt: number, xor: boolean, scratchR: Uint32Array, scratchZ: Uint32Array): void {
  for (let i = 0; i < BLOCK_WORDS; i++) { const r = ref[refAt + i]! ^ prev[prevAt + i]!; scratchR[i] = r; scratchZ[i] = r; }
  for (let i = 0; i < 8; i++) permute(scratchZ, ROWS[i]!);
  for (let i = 0; i < 8; i++) permute(scratchZ, COLS[i]!);
  if (xor) for (let i = 0; i < BLOCK_WORDS; i++) next[nextAt + i] = next[nextAt + i]! ^ scratchR[i]! ^ scratchZ[i]!;
  else for (let i = 0; i < BLOCK_WORDS; i++) next[nextAt + i] = scratchR[i]! ^ scratchZ[i]!;
}

export function checkArgon2Params(p: Argon2Params): void {
  if (p === null || typeof p !== "object" || !Number.isInteger(p.m) || !Number.isInteger(p.t) || p.p !== 1 || p.m < 8 || p.m > 4_194_304 || p.t < 1 || p.t > 64) throw new RangeError("the Argon2id settings are not valid");
}

/** Argon2id, 32 bytes out, one lane. m is in KiB. Synchronous (the memory fill takes seconds at 64 MiB): use `argon2idAsync` inside the controller. */
export function argon2idSync(password: Uint8Array, salt: Uint8Array, params: Argon2Params, tagLength = 32): Buffer {
  checkArgon2Params(params);
  const { m, t } = params;
  const blocks = 4 * Math.floor(m / 4);
  const seg = blocks / 4;
  const h0 = createHash("blake2b512").update(Buffer.concat([le32(1), le32(tagLength), le32(m), le32(t), le32(0x13), le32(2), le32(password.length), Buffer.from(password), le32(salt.length), Buffer.from(salt), le32(0), le32(0)])).digest();
  const mem = new Uint32Array(blocks * BLOCK_WORDS);
  const put = (index: number, bytes: Buffer): void => { for (let i = 0; i < BLOCK_WORDS; i++) mem[index * BLOCK_WORDS + i] = bytes.readUInt32LE(i * 4); };
  put(0, hPrime(Buffer.concat([h0, le32(0), le32(0)]), 1024));
  put(1, hPrime(Buffer.concat([h0, le32(1), le32(0)]), 1024));
  const scratchR = new Uint32Array(BLOCK_WORDS), scratchZ = new Uint32Array(BLOCK_WORDS);
  const zero = new Uint32Array(BLOCK_WORDS), input = new Uint32Array(BLOCK_WORDS), address = new Uint32Array(BLOCK_WORDS);
  for (let pass = 0; pass < t; pass++) {
    for (let slice = 0; slice < 4; slice++) {
      const independent = pass === 0 && slice < 2;
      let first = 0;
      if (independent) {
        input.fill(0); input[0] = pass; input[2] = 0; input[4] = slice; input[6] = blocks; input[8] = t; input[10] = 2;
        // word 1 (lane) is 0; words are [lo,hi] pairs: word k is at 2k.
      }
      const next = (): void => { input[12] = (input[12]! + 1) >>> 0; fillBlock(zero, 0, input, 0, address, 0, false, scratchR, scratchZ); fillBlock(zero, 0, address, 0, address, 0, false, scratchR, scratchZ); };
      if (pass === 0 && slice === 0) { first = 2; if (independent) next(); }
      for (let i = first; i < seg; i++) {
        const cur = slice * seg + i;
        const prev = cur === 0 ? blocks - 1 : cur - 1;
        let randHi: number, randLo: number;
        if (independent) { if (i % 128 === 0) next(); randLo = address[2 * (i % 128)]!; randHi = address[2 * (i % 128) + 1]!; void randHi; }
        else { randLo = mem[prev * BLOCK_WORDS]!; }
        // reference area (one lane, so always the same lane)
        let area: number;
        if (pass === 0) area = slice === 0 ? i - 1 : slice * seg + i - 1;
        else area = blocks - seg + i - 1;
        mul32(randLo, randLo); const sq = mulHi; // (x*x) >> 32
        mul32(area, sq); const rel = area - 1 - mulHi; // (area * sq) >> 32
        const start = pass === 0 ? 0 : (slice === 3 ? 0 : (slice + 1) * seg);
        const ref = (start + rel) % blocks;
        fillBlock(mem, prev * BLOCK_WORDS, mem, ref * BLOCK_WORDS, mem, cur * BLOCK_WORDS, pass !== 0, scratchR, scratchZ);
      }
    }
  }
  const last = (blocks - 1) * BLOCK_WORDS;
  const c = Buffer.alloc(1024);
  for (let i = 0; i < BLOCK_WORDS; i++) c.writeUInt32LE(mem[last + i]!, i * 4);
  return hPrime(c, tagLength);
}

/** Runs the derivation in a worker thread so the controller's event loop is never held for the seconds the memory fill takes. */
export function argon2idAsync(password: Uint8Array, salt: Uint8Array, params: Argon2Params, tagLength = 32): Promise<Buffer> {
  checkArgon2Params(params);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./argon2-worker.js", import.meta.url), { workerData: { password: Buffer.from(password), salt: Buffer.from(salt), params, tagLength }, resourceLimits: { maxOldGenerationSizeMb: 512 } });
    let done = false;
    worker.once("message", (m: { ok: true; tag: Uint8Array } | { ok: false }) => { done = true; if (m.ok) resolve(Buffer.from(m.tag)); else reject(new Error("the Argon2id derivation failed")); });
    worker.once("error", () => { if (!done) { done = true; reject(new Error("the Argon2id derivation failed")); } });
    worker.once("exit", () => { if (!done) { done = true; reject(new Error("the Argon2id derivation failed")); } });
  });
}
