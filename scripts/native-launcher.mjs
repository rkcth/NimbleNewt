// The hash-recording step of the native Windows launcher's release (native/nn-launcher/RELEASE.md).
//   node scripts/native-launcher.mjs record --file nn-launcher.exe --commit <git sha> [--out record.json]   print (and write) the release record
//   node scripts/native-launcher.mjs verify --file nn-launcher.exe --record record.json                      fail unless the file is the one recorded
// The record holds no timestamp, no path and no user name, so two builds of the same inputs give the same record (that is the point of a reproducible build). It names the inputs
// that decide the output: the toolchain pin, the lock file's hash and the source commit.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const RECORD_SCHEMA = "nimblenewt.native-launcher-record/1";
const crateDir = join(dirname(fileURLToPath(import.meta.url)), "..", "native", "nn-launcher");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The toolchain the crate pins (rust-toolchain.toml), e.g. "1.99.1". */
export function pinnedToolchain(text = readFileSync(join(crateDir, "rust-toolchain.toml"), "utf8")) {
  const m = /^channel\s*=\s*"(\d+\.\d+\.\d+)"/m.exec(text);
  if (m === null) throw new Error("rust-toolchain.toml does not pin an exact version");
  return m[1];
}

/** The release record for a built file. `lock` is the bytes of native/nn-launcher/Cargo.lock. */
export function makeRecord({ fileName, bytes, commit, lock = readFileSync(join(crateDir, "Cargo.lock")), toolchain = pinnedToolchain() }) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("--commit must be the full 40-character git commit the build was made from");
  return { schema: RECORD_SCHEMA, file: String(fileName).split(/[\\/]/).pop(), size: bytes.length, sha256: sha256(bytes), sourceCommit: commit, toolchain, cargoLockSha256: sha256(lock), features: [] };
}

/** Problems with a file against a record (empty: it is the recorded file). */
export function checkRecord(record, bytes) {
  const problems = [];
  if (record?.schema !== RECORD_SCHEMA) problems.push("not a release record");
  if (record?.sha256 !== sha256(bytes)) problems.push(`the file's SHA-256 is ${sha256(bytes)}, the record says ${record?.sha256}`);
  if (record?.size !== bytes.length) problems.push(`the file's size is ${bytes.length}, the record says ${record?.size}`);
  if (Array.isArray(record?.features) && record.features.length > 0) problems.push(`the record names cargo features (${record.features.join(", ")}): a release is built with none`);
  return problems;
}

function arg(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, ...rest] = process.argv.slice(2);
  const file = arg(rest, "--file");
  try {
    if (command === "record" && file) {
      const record = makeRecord({ fileName: file, bytes: readFileSync(file), commit: arg(rest, "--commit") });
      const text = `${JSON.stringify(record, null, 2)}\n`;
      const out = arg(rest, "--out");
      if (out) writeFileSync(out, text);
      process.stdout.write(text);
    } else if (command === "verify" && file && arg(rest, "--record")) {
      const problems = checkRecord(JSON.parse(readFileSync(arg(rest, "--record"), "utf8")), readFileSync(file));
      if (problems.length > 0) { for (const p of problems) console.error(p); process.exit(1); }
      console.log("matches the record");
    } else { console.error("usage: native-launcher.mjs record --file F --commit SHA [--out FILE] | verify --file F --record FILE"); process.exit(2); }
  } catch (error) { console.error(error.message); process.exit(2); }
}
