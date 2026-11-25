// Compares two builds of a Windows program (PE file) and says WHERE they differ: native/nn-launcher/RELEASE.md, "Is the build reproducible". Used by the hosted Windows job, which builds the product
// launcher twice from two folders with different names and compares the two files; a difference is a report, not a gate, so this program explains it instead of only saying "different".
//   node scripts/pe-diff.mjs A.exe B.exe [--json report.json] [--commit <40 hex>] [--needle label=text]... [--max-ranges N]
// Exit 0: the two files are byte-identical. Exit 1: they differ (the report says where). Exit 2: usage error or a file that cannot be read.
// The PE reader is bounded and never throws on a bad file: every read checks the buffer, at most 96 sections, 16 data directories and 16 debug entries are looked at, a path string is read for at most
// 520 bytes. A file that is not a PE file (or is cut off) is still compared byte by byte; the problems found are listed in the report. Nothing is executed and nothing is loaded.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const REPORT_SCHEMA = "nimblenewt.pe-diff/1";
export const MAX_SECTIONS = 96; // the PE format's own limit
export const MAX_DIRECTORIES = 16;
export const MAX_DEBUG_ENTRIES = 16;
export const MAX_PATH_BYTES = 520;
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_RANGES = 64;
const MAX_NEEDLE_HITS = 1000;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hex = (bytes) => Buffer.from(bytes).toString("hex");

/** Little-endian reads that return null instead of reading outside the buffer. */
function u16(buf, off) { return Number.isSafeInteger(off) && off >= 0 && off + 2 <= buf.length ? buf.readUInt16LE(off) : null; }
function u32(buf, off) { return Number.isSafeInteger(off) && off >= 0 && off + 4 <= buf.length ? buf.readUInt32LE(off) : null; }

function guidText(bytes) {
  const b = Buffer.from(bytes);
  const h = (x) => x.toString("hex");
  return `${h(b.subarray(0, 4).reverse())}-${h(b.subarray(4, 6).reverse())}-${h(b.subarray(6, 8).reverse())}-${h(b.subarray(8, 10))}-${h(b.subarray(10, 16))}`;
}

/**
 * Reads the headers of a PE file. Never throws. Returns { isPe, problems, coff, optional, sections, debug, regions } where `regions` are the named byte ranges used to say where a difference is.
 */
export function parsePe(buf) {
  const problems = [];
  const regions = []; // { name, start, end } half-open, in file offsets
  const out = { isPe: false, problems, coff: null, optional: null, sections: [], debug: [], regions };
  const region = (name, start, length) => {
    if (Number.isSafeInteger(start) && Number.isSafeInteger(length) && start >= 0 && length > 0 && start < buf.length) regions.push({ name, start, end: Math.min(buf.length, start + length) });
  };
  if (buf.length < 0x40 || buf[0] !== 0x4d || buf[1] !== 0x5a) { problems.push("no MZ header"); return out; }
  region("dos header", 0, 0x40);
  const peOff = u32(buf, 0x3c);
  if (peOff === null || peOff < 0x40 || peOff + 24 > buf.length) { problems.push("the PE header offset is outside the file"); return out; }
  if (buf.readUInt32LE(peOff) !== 0x00004550) { problems.push("no PE signature at the stated offset"); return out; }
  out.isPe = true;
  const nSections = u16(buf, peOff + 6);
  const optSize = u16(buf, peOff + 20);
  out.coff = { machine: u16(buf, peOff + 4), numberOfSections: nSections, timeDateStamp: u32(buf, peOff + 8), sizeOfOptionalHeader: optSize, characteristics: u16(buf, peOff + 22), offset: peOff };
  region("pe signature and coff header", peOff, 24);
  region("coff TimeDateStamp", peOff + 8, 4);
  const opt = peOff + 24;
  const magic = u16(buf, opt);
  if (magic !== 0x10b && magic !== 0x20b) problems.push(`optional header magic ${magic === null ? "missing" : `0x${magic.toString(16)}`} is neither PE32 nor PE32+`);
  if (optSize === null || optSize < 64 + 4 || opt + optSize > buf.length) problems.push("the optional header is cut off or its size is wrong");
  const optLen = optSize !== null ? Math.min(optSize, Math.max(0, buf.length - opt)) : 0;
  region("optional header", opt, optLen);
  let dirBase = null, nDirs = 0;
  if (magic === 0x10b || magic === 0x20b) {
    const plus = magic === 0x20b;
    out.optional = { magic, checkSum: u32(buf, opt + 64), sizeOfImage: u32(buf, opt + 56), sizeOfHeaders: u32(buf, opt + 60), numberOfRvaAndSizes: u32(buf, opt + (plus ? 108 : 92)) };
    region("optional CheckSum", opt + 64, 4);
    dirBase = opt + (plus ? 112 : 96);
    nDirs = Math.min(out.optional.numberOfRvaAndSizes ?? 0, MAX_DIRECTORIES);
    if ((out.optional.numberOfRvaAndSizes ?? 0) > MAX_DIRECTORIES) problems.push(`${out.optional.numberOfRvaAndSizes} data directories stated; only the first ${MAX_DIRECTORIES} are read`);
    if (dirBase + nDirs * 8 > opt + optLen) { nDirs = Math.max(0, Math.floor((opt + optLen - dirBase) / 8)); problems.push("the data directories run past the optional header"); }
  }
  // section table
  let count = nSections ?? 0;
  if (count > MAX_SECTIONS) { problems.push(`${count} sections stated; the format allows ${MAX_SECTIONS}: none are read`); count = 0; }
  const table = opt + (optSize ?? 0);
  for (let i = 0; i < count; i++) {
    const o = table + i * 40;
    if (o + 40 > buf.length) { problems.push(`the section table is cut off after ${i} of ${count} entries`); break; }
    const name = buf.subarray(o, o + 8).toString("latin1").replace(/\0.*$/s, "").replace(/[^\x20-\x7e]/g, "?");
    const s = { name, virtualSize: buf.readUInt32LE(o + 8), virtualAddress: buf.readUInt32LE(o + 12), rawSize: buf.readUInt32LE(o + 16), rawOffset: buf.readUInt32LE(o + 20) };
    if (s.rawSize > 0 && (s.rawOffset >= buf.length || s.rawOffset + s.rawSize > buf.length)) problems.push(`section ${name}: its raw data (offset ${s.rawOffset}, size ${s.rawSize}) is outside the file; the part inside is used`);
    out.sections.push(s);
  }
  if (count > 0) region("section table", table, Math.min(count, out.sections.length + 1) * 40);
  for (const s of out.sections) if (s.rawSize > 0) region(`section ${s.name}`, s.rawOffset, s.rawSize);
  // the debug directory (data directory 6) and the CodeView (RSDS) record it points to
  const rvaToOffset = (rva) => {
    for (const s of out.sections) {
      const span = Math.max(s.virtualSize, s.rawSize);
      if (rva >= s.virtualAddress && rva - s.virtualAddress < span) { const off = s.rawOffset + (rva - s.virtualAddress); return off < buf.length ? off : null; }
    }
    return rva < buf.length && out.optional?.sizeOfHeaders !== null && rva < (out.optional?.sizeOfHeaders ?? 0) ? rva : null;
  };
  if (nDirs > 6 && dirBase !== null) {
    const dirRva = u32(buf, dirBase + 6 * 8), dirSize = u32(buf, dirBase + 6 * 8 + 4);
    if (dirRva && dirSize) {
      const dirOff = rvaToOffset(dirRva);
      if (dirOff === null) problems.push("the debug directory is outside the file");
      else {
        const n = Math.min(Math.floor(dirSize / 28), MAX_DEBUG_ENTRIES);
        if (Math.floor(dirSize / 28) > MAX_DEBUG_ENTRIES) problems.push(`${Math.floor(dirSize / 28)} debug entries stated; only the first ${MAX_DEBUG_ENTRIES} are read`);
        for (let i = 0; i < n; i++) {
          const e = dirOff + i * 28;
          if (e + 28 > buf.length) { problems.push("the debug directory is cut off"); break; }
          const entry = { index: i, timeDateStamp: buf.readUInt32LE(e + 4), type: buf.readUInt32LE(e + 12), sizeOfData: buf.readUInt32LE(e + 16), pointerToRawData: buf.readUInt32LE(e + 24), rsds: null };
          region(`debug entry ${i}`, e, 28);
          region(`debug entry ${i} TimeDateStamp`, e + 4, 4);
          const p = entry.pointerToRawData;
          if (entry.type === 2 && entry.sizeOfData >= 24 && p + 24 <= buf.length && buf.readUInt32LE(p) === 0x53445352) {
            const room = Math.min(entry.sizeOfData - 24, MAX_PATH_BYTES, buf.length - (p + 24));
            let end = p + 24; while (end < p + 24 + room && buf[end] !== 0) end++;
            entry.rsds = { guid: guidText(buf.subarray(p + 4, p + 20)), age: buf.readUInt32LE(p + 20), path: buf.subarray(p + 24, end).toString("latin1").replace(/[^\x20-\x7e]/g, "?") };
            region(`debug entry ${i} RSDS GUID and age`, p + 4, 20);
            region(`debug entry ${i} RSDS PDB path`, p + 24, Math.max(1, end - (p + 24)));
          } else if (entry.sizeOfData > 0 && p < buf.length) region(`debug entry ${i} data`, p, entry.sizeOfData);
          out.debug.push(entry);
        }
      }
    }
  }
  return out;
}

/** Disjoint labelled segments from overlapping regions: the smallest region containing a byte names it; headers and unclaimed bytes get a generic label. */
function buildSegments(regions, length, sectionsEnd) {
  const cuts = new Set([0, length]);
  for (const r of regions) { cuts.add(r.start); cuts.add(Math.min(r.end, length)); }
  const points = [...cuts].filter((p) => p >= 0 && p <= length).sort((x, y) => x - y);
  const segments = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const start = points[i], end = points[i + 1];
    let best = null;
    for (const r of regions) if (r.start <= start && r.end >= end && (best === null || r.end - r.start < best.end - best.start)) best = r;
    const name = best ? best.name : (start >= sectionsEnd && sectionsEnd > 0 ? "after the last section (certificate, overlay or padding)" : "gap between headers and sections or between sections");
    const last = segments[segments.length - 1];
    if (last && last.name === name && last.end === start) last.end = end; else segments.push({ start, end, name });
  }
  return segments;
}

/** Compare two buffers byte by byte. Memory is bounded: ranges are accounted for as they close and only the first `maxRanges` are kept. */
export function diffBuffers(a, b, { maxRanges = DEFAULT_MAX_RANGES } = {}) {
  const pa = parsePe(a), pb = parsePe(b);
  const sectionsEnd = pa.sections.reduce((m, s) => Math.max(m, Math.min(a.length, s.rawOffset + s.rawSize)), 0);
  const segments = buildSegments(pa.regions, Math.max(a.length, b.length), sectionsEnd);
  const byRegion = new Map();
  const ranges = [];
  let total = 0, rangeCount = 0;
  let segIndex = 0;
  const account = (start, end) => {
    rangeCount++; total += end - start;
    // split at the segment boundaries (segments are sorted; the pointer only moves forward)
    while (segIndex > 0 && segments[segIndex].start > start) segIndex--;
    let pos = start;
    while (pos < end) {
      while (segIndex < segments.length - 1 && segments[segIndex].end <= pos) segIndex++;
      const seg = segments[segIndex] ?? { name: "beyond the first file", end: Infinity };
      const to = Math.min(end, seg.end);
      const r = byRegion.get(seg.name) ?? { region: seg.name, bytes: 0, ranges: 0 };
      r.bytes += to - pos; r.ranges++; byRegion.set(seg.name, r);
      if (ranges.length < maxRanges) {
        const n = Math.min(16, to - pos);
        ranges.push({ start: pos, end: to, region: seg.name, aHex: pos < a.length ? hex(a.subarray(pos, Math.min(a.length, pos + n))) : "", bHex: pos < b.length ? hex(b.subarray(pos, Math.min(b.length, pos + n))) : "" });
      }
      pos = to;
    }
  };
  const common = Math.min(a.length, b.length);
  let runStart = -1;
  for (let i = 0; i < common; i++) {
    if (a[i] !== b[i]) { if (runStart < 0) runStart = i; } else if (runStart >= 0) { account(runStart, i); runStart = -1; }
  }
  if (runStart >= 0) account(runStart, common);
  if (a.length !== b.length) {
    const r = { region: `length differs (the longer file has ${Math.abs(a.length - b.length)} more bytes at the end)`, bytes: Math.abs(a.length - b.length), ranges: 1 };
    byRegion.set(r.region, r); total += r.bytes; rangeCount++;
    if (ranges.length < maxRanges) ranges.push({ start: common, end: Math.max(a.length, b.length), region: r.region, aHex: "", bHex: "" });
  }
  const fields = fieldDifferences(pa, pb);
  const layoutDiffers = JSON.stringify(pa.sections.map((s) => [s.name, s.virtualAddress, s.virtualSize, s.rawOffset, s.rawSize])) !== JSON.stringify(pb.sections.map((s) => [s.name, s.virtualAddress, s.virtualSize, s.rawOffset, s.rawSize]));
  const regions = [...byRegion.values()].sort((x, y) => y.bytes - x.bytes);
  return { identical: total === 0, sizeA: a.length, sizeB: b.length, differingBytes: total, differingRanges: rangeCount, regions, ranges, rangesTruncated: rangeCount > ranges.length, layoutDiffers, fields, problemsA: pa.problems, problemsB: pb.problems, parsedA: summarize(pa), parsedB: summarize(pb), explanation: explain({ total, regions, fields, layoutDiffers, pa, pb }) };
}

function summarize(p) {
  return {
    isPe: p.isPe, coffTimeDateStamp: p.coff?.timeDateStamp ?? null, coffTimeDateStampIso: p.coff?.timeDateStamp ? new Date(p.coff.timeDateStamp * 1000).toISOString() : null,
    checkSum: p.optional?.checkSum ?? null, sizeOfImage: p.optional?.sizeOfImage ?? null,
    sections: p.sections.map((s) => ({ name: s.name, virtualSize: s.virtualSize, rawSize: s.rawSize })),
    debug: p.debug.map((d) => ({ index: d.index, type: d.type, timeDateStamp: d.timeDateStamp, rsds: d.rsds })),
  };
}

function fieldDifferences(pa, pb) {
  const out = [];
  const add = (name, x, y) => { if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ name, a: x ?? null, b: y ?? null }); };
  add("coff TimeDateStamp", pa.coff?.timeDateStamp, pb.coff?.timeDateStamp);
  add("optional CheckSum", pa.optional?.checkSum, pb.optional?.checkSum);
  add("optional SizeOfImage", pa.optional?.sizeOfImage, pb.optional?.sizeOfImage);
  const n = Math.max(pa.debug.length, pb.debug.length);
  for (let i = 0; i < n; i++) {
    const x = pa.debug[i], y = pb.debug[i];
    add(`debug entry ${i} TimeDateStamp`, x?.timeDateStamp, y?.timeDateStamp);
    add(`debug entry ${i} RSDS GUID`, x?.rsds?.guid, y?.rsds?.guid);
    add(`debug entry ${i} RSDS age`, x?.rsds?.age, y?.rsds?.age);
    add(`debug entry ${i} RSDS PDB path`, x?.rsds?.path, y?.rsds?.path);
  }
  const names = (p) => p.sections.map((s) => `${s.name}:${s.rawSize}`);
  add("section names and raw sizes", names(pa), names(pb));
  return out;
}

function explain({ total, regions, fields, layoutDiffers, pa, pb }) {
  if (total === 0) return ["the two files are byte-identical"];
  const lines = [];
  const named = (re) => regions.some((r) => re.test(r.region));
  const onlyHeaderFields = regions.every((r) => /TimeDateStamp|CheckSum|debug entry/.test(r.region));
  if (onlyHeaderFields) lines.push("only header bookkeeping differs (time stamp, checksum or debug directory entries); the program bytes are the same. With /Brepro the linker writes a hash of the content as the time stamp, so a changed stamp alone means something small changed in the content.");
  if (named(/coff TimeDateStamp/)) lines.push("the COFF TimeDateStamp differs: with /Brepro it is a content hash, not a time, so this follows from any other difference (and, if it is the only one, from the debug directory).");
  if (fields.some((f) => /RSDS PDB path/.test(f.name))) lines.push("the PDB path in the debug directory differs: a build folder name is embedded (check --remap-path-prefix and the linker's /PDBALTPATH).");
  if (fields.some((f) => /RSDS GUID/.test(f.name))) lines.push("the debug GUID differs: with /Brepro the GUID is a hash of the content, so it follows from other differences.");
  if (named(/optional CheckSum/)) lines.push("the optional header CheckSum differs: it is computed from the whole file, so it follows from any other difference.");
  if (layoutDiffers) lines.push("the section layout (names, sizes) differs: code or data differs in size, not only in a few bytes.");
  for (const r of regions) if (/^section \.text/.test(r.region)) lines.push(`${r.bytes} byte(s) of code (${r.region}) differ: the compiler or linker produced different code (inputs such as a path or crate hash, the toolchain, or the flags differ).`);
  for (const r of regions) if (/^section \.(rdata|data)/.test(r.region)) lines.push(`${r.bytes} byte(s) in ${r.region} differ: constants or strings differ (an embedded path or a hash).`);
  for (const r of regions) if (/^section \.rsrc/.test(r.region)) lines.push(`${r.bytes} byte(s) in ${r.region} differ: the resources (version information, manifest) differ.`);
  for (const r of regions) if (/^after the last section/.test(r.region)) lines.push(`${r.bytes} byte(s) after the last section differ (a certificate or appended data).`);
  if (!pa.isPe || !pb.isPe) lines.push("at least one file is not read as a PE file; only the byte comparison is meaningful");
  return lines;
}

/** Counts how often `text` appears in the file as ASCII/UTF-8 and as UTF-16 little-endian (at most MAX_NEEDLE_HITS each). */
export function countNeedle(buf, text) {
  const count = (needle) => {
    if (needle.length === 0) return 0;
    let n = 0, from = 0;
    while (n < MAX_NEEDLE_HITS) { const at = buf.indexOf(needle, from); if (at < 0) break; n++; from = at + 1; }
    return n;
  };
  return { ascii: count(Buffer.from(text, "utf8")), utf16le: count(Buffer.from(text, "utf16le")) };
}

/** Does the file hold the commit (as text, either encoding) or a build time? */
export function embedded(buf, { commit, needles = [], now = Date.now() } = {}) {
  const pe = parsePe(buf);
  const stamp = pe.coff?.timeDateStamp ?? null;
  const week = 7 * 24 * 3600 * 1000;
  const looksLikeBuildTime = stamp !== null && stamp * 1000 >= now - week && stamp * 1000 <= now + 24 * 3600 * 1000;
  const result = {
    commit: commit ? { ...countNeedle(buf, commit.toLowerCase()), ...(countNeedle(buf, commit.toUpperCase()).ascii ? { upperCaseAscii: countNeedle(buf, commit.toUpperCase()).ascii } : {}) } : null,
    timeDateStamp: stamp === null ? null : { value: stamp, iso: stamp ? new Date(stamp * 1000).toISOString() : null, zero: stamp === 0, withinAWeekOfNow: looksLikeBuildTime },
    needles: {},
  };
  for (const { label, text } of needles) result.needles[label] = countNeedle(buf, text);
  result.embedsCommit = result.commit !== null && (result.commit.ascii > 0 || result.commit.utf16le > 0);
  result.embedsBuildTime = looksLikeBuildTime;
  return result;
}

export function compareFiles(pathA, pathB, { maxRanges = DEFAULT_MAX_RANGES, commit, needles = [], now } = {}) {
  for (const p of [pathA, pathB]) if (statSync(p).size > MAX_FILE_BYTES) throw new Error("a file is larger than 64 MiB: not compared");
  const a = readFileSync(pathA), b = readFileSync(pathB);
  const d = diffBuffers(a, b, { maxRanges });
  const hashA = sha256(a), hashB = sha256(b);
  return {
    schema: REPORT_SCHEMA, identical: hashA === hashB && d.identical, sha256A: hashA, sha256B: hashB, ...d,
    embeddedA: embedded(a, { commit, needles, now }), embeddedB: embedded(b, { commit, needles, now }),
  };
}

/** The one line the job prints and the owner reads. */
export function headline(report) {
  return `reproducibility: A sha256=${report.sha256A} B sha256=${report.sha256B} ${report.identical ? "identical" : "DIFFERENT"}`;
}

export function renderText(report) {
  const lines = [headline(report), `sizes: A ${report.sizeA} bytes, B ${report.sizeB} bytes`];
  if (!report.identical) {
    lines.push(`${report.differingBytes} differing byte(s) in ${report.differingRanges} range(s); layout ${report.layoutDiffers ? "DIFFERS" : "the same"}`);
    for (const r of report.regions.slice(0, 24)) lines.push(`  ${r.region}: ${r.bytes} byte(s) in ${r.ranges} range(s)`);
    if (report.regions.length > 24) lines.push(`  ... ${report.regions.length - 24} more region(s)`);
    for (const f of report.fields.slice(0, 24)) lines.push(`  field ${f.name}: A=${JSON.stringify(f.a)} B=${JSON.stringify(f.b)}`);
    for (const e of report.explanation) lines.push(`why: ${e}`);
  }
  for (const side of ["A", "B"]) {
    const e = report[`embedded${side}`];
    lines.push(`${side}: PE time stamp ${e.timeDateStamp ? `${e.timeDateStamp.value} (${e.timeDateStamp.iso ?? "zero"}), within a week of now: ${e.timeDateStamp.withinAWeekOfNow}` : "not read"}; embeds the commit: ${e.commit ? e.embedsCommit : "not asked"}`);
    for (const [label, c] of Object.entries(e.needles)) lines.push(`${side}: names ${label}: ${c.ascii + c.utf16le > 0 ? `YES (${c.ascii} as text, ${c.utf16le} as UTF-16)` : "no"}`);
  }
  for (const p of [...report.problemsA.map((x) => `A: ${x}`), ...report.problemsB.map((x) => `B: ${x}`)].slice(0, 20)) lines.push(`problem: ${p}`);
  return lines.join("\n");
}

function startedAsProgram() {
  if (!process.argv[1]) return false;
  try {
    const a = realpathSync(process.argv[1]), b = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch { return false; }
}

export function parseArgs(argv) {
  const files = [], needles = [];
  let json, commit, maxRanges = DEFAULT_MAX_RANGES;
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--json") json = argv[++i];
    else if (x === "--commit") commit = argv[++i];
    else if (x === "--max-ranges") maxRanges = Number(argv[++i]);
    else if (x === "--needle") { const v = argv[++i] ?? ""; const k = v.indexOf("="); if (k <= 0 || k === v.length - 1) throw new Error("--needle takes label=text"); needles.push({ label: v.slice(0, k), text: v.slice(k + 1) }); }
    else if (x.startsWith("--")) throw new Error(`unknown option ${x}`);
    else files.push(x);
  }
  if (files.length !== 2) throw new Error("usage: pe-diff.mjs A.exe B.exe [--json FILE] [--commit SHA] [--needle label=text]... [--max-ranges N]");
  if (!Number.isInteger(maxRanges) || maxRanges < 1 || maxRanges > 10000) throw new Error("--max-ranges is a whole number from 1 to 10000");
  if (commit !== undefined && !/^[0-9a-fA-F]{40}$/.test(commit)) throw new Error("--commit must be 40 hex characters");
  if (json !== undefined && json === "") throw new Error("--json needs a file name");
  return { files, json, commit, maxRanges, needles };
}

if (startedAsProgram()) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(2); }
  try {
    const report = compareFiles(opts.files[0], opts.files[1], opts);
    if (opts.json) writeFileSync(opts.json, `${JSON.stringify(report, null, 2)}\n`);
    console.log(renderText(report));
    process.exit(report.identical ? 0 : 1);
  } catch (error) { console.error(error.message); process.exit(2); }
}
