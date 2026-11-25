// Tests for scripts/pe-diff.mjs on small synthetic PE files built here (no binary is committed). They run on every operating system.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compareFiles, countNeedle, diffBuffers, embedded, headline, parseArgs, parsePe, renderText, MAX_SECTIONS, MAX_DEBUG_ENTRIES } from "./pe-diff.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "pe-diff.mjs");
const commit = "0123456789abcdef0123456789abcdef01234567";

/** A small valid PE32+ file: headers (0x200), .text (0x200), .rdata (0x200: debug directory, RSDS record, a string), .rsrc (0x200). */
function makePe({ stamp = 0x5f5e1000, checkSum = 0x1234, text = 0x41, pdb = "C:\\build\\a\\nn-launcher.pdb", guid = "00112233445566778899aabbccddeeff", age = 1, rdata = "hello", rsrc = 0x52, debugStamp = 0, extra = 0, sections = 3 } = {}) {
  const buf = Buffer.alloc(0x800 + extra);
  buf.write("MZ", 0); buf.writeUInt32LE(0x80, 0x3c);
  buf.writeUInt32LE(0x00004550, 0x80);
  buf.writeUInt16LE(0x8664, 0x84); buf.writeUInt16LE(sections, 0x86); buf.writeUInt32LE(stamp, 0x88); buf.writeUInt16LE(240, 0x94);
  const opt = 0x98;
  buf.writeUInt16LE(0x20b, opt); buf.writeUInt32LE(0x800, opt + 56); buf.writeUInt32LE(0x200, opt + 60); buf.writeUInt32LE(checkSum, opt + 64);
  buf.writeUInt32LE(16, opt + 108);
  const dirs = opt + 112;
  buf.writeUInt32LE(0x2000, dirs + 6 * 8); buf.writeUInt32LE(28, dirs + 6 * 8 + 4); // debug directory at RVA 0x2000 (.rdata)
  const table = opt + 240;
  const sec = (i, name, va, vs, raw, rs) => { const o = table + i * 40; buf.write(name, o, "latin1"); buf.writeUInt32LE(vs, o + 8); buf.writeUInt32LE(va, o + 12); buf.writeUInt32LE(rs, o + 16); buf.writeUInt32LE(raw, o + 20); };
  sec(0, ".text", 0x1000, 0x200, 0x200, 0x200); sec(1, ".rdata", 0x2000, 0x200, 0x400, 0x200); sec(2, ".rsrc", 0x3000, 0x200, 0x600, 0x200);
  buf.fill(text, 0x200, 0x400);
  // .rdata at file offset 0x400: the debug entry (28 bytes), then the RSDS record at 0x440, then a string at 0x500
  buf.writeUInt32LE(debugStamp, 0x404); buf.writeUInt32LE(2, 0x40c); buf.writeUInt32LE(24 + pdb.length + 1, 0x410); buf.writeUInt32LE(0x2040, 0x414); buf.writeUInt32LE(0x440, 0x418);
  buf.writeUInt32LE(0x53445352, 0x440); Buffer.from(guid, "hex").copy(buf, 0x444); buf.writeUInt32LE(age, 0x454); buf.write(pdb, 0x458, "latin1");
  buf.write(rdata, 0x500, "latin1");
  buf.fill(rsrc, 0x600, 0x800);
  return buf;
}
const regionsOf = (d) => d.regions.map((r) => r.region);

test("parsePe reads the header fields, sections, the debug directory and the PDB record", () => {
  const p = parsePe(makePe());
  assert.equal(p.isPe, true); assert.deepEqual(p.problems, []);
  assert.equal(p.coff.timeDateStamp, 0x5f5e1000); assert.equal(p.optional.checkSum, 0x1234);
  assert.deepEqual(p.sections.map((s) => s.name), [".text", ".rdata", ".rsrc"]);
  assert.equal(p.debug.length, 1);
  assert.equal(p.debug[0].rsds.guid, "33221100-5544-7766-8899-aabbccddeeff");
  assert.equal(p.debug[0].rsds.age, 1); assert.equal(p.debug[0].rsds.path, "C:\\build\\a\\nn-launcher.pdb");
});

test("identical files: no difference, the headline says identical, exit code 0 from the program", () => {
  const d = diffBuffers(makePe(), makePe());
  assert.equal(d.identical, true); assert.equal(d.differingBytes, 0); assert.deepEqual(d.regions, []); assert.deepEqual(d.ranges, []);
  const dir = mkdtempSync(join(os.tmpdir(), "pd-"));
  try {
    writeFileSync(join(dir, "a.exe"), makePe()); writeFileSync(join(dir, "b.exe"), makePe());
    const r = spawnSync(process.execPath, [script, join(dir, "a.exe"), join(dir, "b.exe"), "--json", join(dir, "r.json"), "--commit", commit, "--needle", "folder=C:\\build\\a", "--needle", "other=QWERTY-no-such-text"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /reproducibility: A sha256=[0-9a-f]{64} B sha256=[0-9a-f]{64} identical/);
    const j = JSON.parse(readFileSync(join(dir, "r.json"), "utf8"));
    assert.equal(j.schema, "nimblenewt.pe-diff/1"); assert.equal(j.identical, true); assert.equal(j.sha256A, j.sha256B);
    assert.equal(j.embeddedA.needles.folder.ascii, 1, "the PDB path text is found");
    assert.equal(j.embeddedA.needles.other.ascii, 0); assert.ok(!JSON.stringify(j).includes("QWERTY"), "the needle text itself is not copied into the report (only its label)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a differing time stamp is named as the COFF TimeDateStamp (4 bytes) and explained", () => {
  const d = diffBuffers(makePe(), makePe({ stamp: 0x5f5e1001 }));
  assert.equal(d.identical, false); assert.deepEqual(regionsOf(d), ["coff TimeDateStamp"]);
  assert.equal(d.differingBytes, 1); assert.equal(d.ranges[0].start, 0x88);
  assert.deepEqual(d.fields.map((f) => f.name), ["coff TimeDateStamp"]);
  assert.ok(d.explanation.some((x) => /only header bookkeeping/.test(x)));
});

test("a differing checksum, a differing debug stamp and a differing GUID are each located", () => {
  assert.deepEqual(regionsOf(diffBuffers(makePe(), makePe({ checkSum: 9 }))), ["optional CheckSum"]);
  assert.deepEqual(regionsOf(diffBuffers(makePe(), makePe({ debugStamp: 7 }))), ["debug entry 0 TimeDateStamp"]);
  const g = diffBuffers(makePe(), makePe({ guid: "ffeeddccbbaa99887766554433221100" }));
  assert.deepEqual(regionsOf(g), ["debug entry 0 RSDS GUID and age"]);
  assert.ok(g.fields.some((f) => f.name === "debug entry 0 RSDS GUID"));
});

test("a differing PDB path is located in the RSDS path and explained as an embedded folder name", () => {
  const d = diffBuffers(makePe(), makePe({ pdb: "D:\\other\\place\\nn-launcher.pdb" }));
  assert.ok(regionsOf(d).includes("debug entry 0 RSDS PDB path"), regionsOf(d).join());
  const f = d.fields.find((x) => x.name === "debug entry 0 RSDS PDB path");
  assert.equal(f.a, "C:\\build\\a\\nn-launcher.pdb"); assert.equal(f.b, "D:\\other\\place\\nn-launcher.pdb");
  assert.ok(d.explanation.some((x) => /PDB path .* differs/.test(x)));
  assert.match(d.ranges[0].aHex, /^[0-9a-f]+$/);
});

test("differences in sections are attributed to the section by name; a longer file is reported by length", () => {
  const t = diffBuffers(makePe(), makePe({ text: 0x42 }));
  assert.deepEqual(regionsOf(t), ["section .text"]); assert.equal(t.differingBytes, 0x200);
  assert.ok(t.explanation.some((x) => /code \(section \.text\) differ/.test(x)));
  const rd = diffBuffers(makePe(), makePe({ rdata: "hellp" }));
  assert.deepEqual(regionsOf(rd), ["section .rdata"]);
  assert.ok(rd.explanation.some((x) => /constants or strings/.test(x)));
  const rs = diffBuffers(makePe(), makePe({ rsrc: 0x53 }));
  assert.deepEqual(regionsOf(rs), ["section .rsrc"]);
  const longer = diffBuffers(makePe(), makePe({ extra: 64 }));
  assert.ok(regionsOf(longer).some((r) => /^length differs/.test(r)), regionsOf(longer).join());
  assert.ok(longer.explanation.length >= 0);
});

test("output is bounded: a file that differs everywhere reports at most maxRanges ranges but counts every byte", () => {
  const a = makePe(), b = Buffer.from(a);
  for (let i = 0x200; i < 0x400; i += 2) b[i] ^= 0xff; // 256 separate ranges in .text
  const d = diffBuffers(a, b, { maxRanges: 8 });
  assert.equal(d.ranges.length, 8); assert.equal(d.rangesTruncated, true); assert.equal(d.differingRanges, 256); assert.equal(d.differingBytes, 256);
  assert.ok(renderText({ schema: "x", identical: false, sha256A: "a", sha256B: "b", embeddedA: embedded(a), embeddedB: embedded(b), ...d }).split("\n").length < 60);
});

test("malformed inputs never throw and never read outside the buffer", () => {
  const good = makePe();
  const cases = [
    Buffer.alloc(0), Buffer.from("MZ"), Buffer.alloc(0x3f, 0x4d), good.subarray(0, 0x50), good.subarray(0, 0x84), good.subarray(0, 0x100), good.subarray(0, 0x300), good.subarray(0, 0x450),
    (() => { const b = Buffer.from(good); b.writeUInt32LE(0xfffffff0, 0x3c); return b; })(),   // PE offset far outside
    (() => { const b = Buffer.from(good); b.writeUInt32LE(0x7ffffff0, 0x3c); return b; })(),
    (() => { const b = Buffer.from(good); b.writeUInt16LE(0xffff, 0x86); return b; })(),      // 65535 sections
    (() => { const b = Buffer.from(good); b.writeUInt16LE(96, 0x86); return b; })(),          // table runs past the file
    (() => { const b = Buffer.from(good); b.writeUInt16LE(0xffff, 0x94); return b; })(),      // optional header size huge
    (() => { const b = Buffer.from(good); b.writeUInt32LE(0xffffffff, 0x98 + 108); return b; })(),   // directory count huge
    (() => { const b = Buffer.from(good); b.writeUInt32LE(0xffffffff, 0x98 + 112 + 6 * 8 + 4); return b; })(), // debug size huge
    (() => { const b = Buffer.from(good); b.writeUInt32LE(0xffffff00, 0x98 + 112 + 6 * 8); return b; })(),     // debug RVA outside
    (() => { const b = Buffer.from(good); b.writeUInt32LE(0xfffffff0, 0x400 + 24); return b; })(),            // raw data pointer outside
    (() => { const b = Buffer.from(good); b.writeUInt32LE(0xffffffff, 0x400 + 16); return b; })(),            // size of data huge
    (() => { const b = Buffer.from(good); const t = 0x98 + 240; b.writeUInt32LE(0xfffffff0, t + 20); b.writeUInt32LE(0xffffffff, t + 16); return b; })(), // section raw data outside
    (() => { const b = Buffer.from(good); b.fill(0x41, 0x458, 0x600); return b; })(),                           // PDB path with no end
    Buffer.alloc(4096, 0xff), Buffer.alloc(4096, 0),
  ];
  for (const [i, c] of cases.entries()) {
    const p = parsePe(c);
    assert.ok(Array.isArray(p.problems), String(i));
    assert.ok(p.sections.length <= MAX_SECTIONS && p.debug.length <= MAX_DEBUG_ENTRIES, String(i));
    for (const r of p.regions) assert.ok(r.start >= 0 && r.end <= c.length && r.start < r.end, `${i}: ${JSON.stringify(r)}`);
    const d = diffBuffers(c, good);
    assert.ok(d.ranges.length <= 64, String(i));
    for (const r of d.ranges) assert.ok(r.aHex.length <= 32 && r.bHex.length <= 32);
    diffBuffers(good, c); diffBuffers(c, c);
  }
  assert.ok(parsePe(Buffer.alloc(0)).problems[0].includes("MZ"));
  assert.ok(parsePe(cases[10]).problems.some((x) => /65535 sections/.test(x)));
  assert.ok(parsePe(cases[11]).problems.some((x) => /cut off/.test(x)));
  assert.ok(parsePe(cases[19]).debug[0].rsds === null || parsePe(cases[19]).debug[0].rsds.path.length <= 520);
  assert.equal(diffBuffers(cases[0], cases[0]).identical, true);
  assert.equal(diffBuffers(cases[0], good).identical, false);
});

test("a PDB path with no end and a huge stated size is read for at most 520 bytes", () => {
  const b = makePe(); b.fill(0x41, 0x458, 0x800); b.writeUInt32LE(0x400, 0x410);
  const p = parsePe(b);
  assert.equal(p.debug[0].rsds.path.length, 520);
});

test("embedded: finds the commit as text in either encoding, a build-time stamp, and named folders; counts are bounded", () => {
  const withCommit = Buffer.concat([makePe(), Buffer.from(commit), Buffer.from(commit, "utf16le")]);
  const e = embedded(withCommit, { commit, now: 0x5f5e1000 * 1000 + 1000 });
  assert.equal(e.embedsCommit, true); assert.deepEqual([e.commit.ascii, e.commit.utf16le], [1, 1]);
  assert.equal(e.embedsBuildTime, true); assert.equal(e.timeDateStamp.withinAWeekOfNow, true);
  const none = embedded(makePe(), { commit, now: Date.now() });
  assert.equal(none.embedsCommit, false); assert.equal(none.embedsBuildTime, false);
  assert.equal(embedded(makePe({ stamp: 0 }), { commit }).timeDateStamp.zero, true);
  assert.equal(embedded(makePe(), {}).commit, null);
  const many = Buffer.alloc(10000, 0x41);
  assert.equal(countNeedle(many, "A").ascii, 1000);
  assert.deepEqual(countNeedle(many, ""), { ascii: 0, utf16le: 0 });
  assert.equal(countNeedle(Buffer.from("C:\\x\\y", "utf16le"), "C:\\x").utf16le, 1);
});

test("headline and the program: DIFFERENT gives exit code 1 and a JSON report; bad usage and unreadable files give 2", () => {
  const dir = mkdtempSync(join(os.tmpdir(), "pd-"));
  try {
    writeFileSync(join(dir, "a.exe"), makePe()); writeFileSync(join(dir, "b.exe"), makePe({ pdb: "D:\\o\\x.pdb", text: 0x43 }));
    const r = spawnSync(process.execPath, [script, join(dir, "a.exe"), join(dir, "b.exe"), "--json", join(dir, "r.json"), "--max-ranges", "5"], { encoding: "utf8" });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /reproducibility: A sha256=[0-9a-f]{64} B sha256=[0-9a-f]{64} DIFFERENT/);
    assert.match(r.stdout, /section \.text: 512 byte/); assert.match(r.stdout, /why: /);
    const j = JSON.parse(readFileSync(join(dir, "r.json"), "utf8"));
    assert.equal(j.identical, false); assert.ok(j.ranges.length <= 5); assert.match(headline(j), /DIFFERENT$/);
    assert.equal(spawnSync(process.execPath, [script, join(dir, "a.exe")], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [script, join(dir, "a.exe"), join(dir, "missing.exe")], { encoding: "utf8" }).status, 2);
    assert.equal(spawnSync(process.execPath, [script, join(dir, "a.exe"), join(dir, "b.exe"), "--bogus"], { encoding: "utf8" }).status, 2);
    assert.equal(compareFiles(join(dir, "a.exe"), join(dir, "a.exe")).identical, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  for (const bad of [["a", "b", "--max-ranges", "0"], ["a", "b", "--max-ranges", "x"], ["a", "b", "--commit", "abc"], ["a", "b", "--needle", "nolabel"], ["a", "b", "--needle", "x="], ["a", "b", "c"], ["a", "b", "--json", ""]]) assert.throws(() => parseArgs(bad), bad.join(" "));
  assert.equal(parseArgs(["a", "b", "--needle", "f=C:\\x=y"]).needles[0].text, "C:\\x=y");
});
