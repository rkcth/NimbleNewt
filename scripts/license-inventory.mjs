// Builds a license inventory of locked third-party packages from package-lock.json.
//   node scripts/license-inventory.mjs --write   regenerate the inventory document
//   node scripts/license-inventory.mjs --check   fail if the document is stale or a license is not allowed
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOWED_LICENSES = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "Unlicense"];

const SCOPE_RANK = { runtime: 0, optional: 1, "dev-optional": 2, dev: 3 };
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // locale-independent on purpose

function scopeOf(meta) {
  if (meta.dev) return "dev";
  if (meta.devOptional) return "dev-optional";
  if (meta.optional) return "optional";
  return "runtime";
}

/** Returns the third-party entries of a lockfile, de-duplicated and sorted by name then version. */
export function inventory(lock) {
  const byKey = new Map();
  for (const [path, meta] of Object.entries(lock.packages)) {
    if (path === "" || meta.link || path.startsWith("packages/") || /^node_modules\/@nimblenewt\//.test(path)) continue;
    const entry = {
      name: meta.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length),
      version: meta.version,
      license: meta.license ?? "UNKNOWN",
      scope: scopeOf(meta),
      installScript: meta.hasInstallScript === true,
    };
    const key = `${entry.name}\0${entry.version}`;
    const seen = byKey.get(key);
    if (!seen) byKey.set(key, entry);
    else {
      if (SCOPE_RANK[entry.scope] < SCOPE_RANK[seen.scope]) seen.scope = entry.scope;
      seen.installScript ||= entry.installScript;
    }
  }
  return [...byKey.values()].sort((a, b) => compare(a.name, b.name) || compare(a.version, b.version));
}

/** True when an SPDX expression is satisfied by the allow list: OR needs one branch, AND needs all. */
export function licenseAllowed(expression) {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  function parseOr() { let ok = parseAnd(); while (tokens[i] === "OR") { i++; const rhs = parseAnd(); ok = ok || rhs; } return ok; }
  function parseAnd() { let ok = parseAtom(); while (tokens[i] === "AND") { i++; const rhs = parseAtom(); ok = ok && rhs; } return ok; }
  function parseAtom() {
    const token = tokens[i++];
    if (token === "(") { const ok = parseOr(); if (tokens[i++] !== ")") throw new SyntaxError("unbalanced parentheses"); return ok; }
    if (token === undefined || token === ")" || token === "AND" || token === "OR") throw new SyntaxError("malformed expression");
    return ALLOWED_LICENSES.includes(token);
  }
  try { const ok = parseOr(); return i === tokens.length && ok; } catch { return false; }
}

export function violations(entries) {
  return entries.filter((e) => !licenseAllowed(e.license)).map((e) => `${e.name}@${e.version}: license ${e.license} is not on the allow list`);
}

export function render(entries) {
  const lines = [
    "# Third-party license inventory",
    "",
    "Generated from `package-lock.json` by `npm run licenses:write`; `npm run licenses:check` fails when this file is stale or a license is not allowed. Do not edit by hand.",
    "",
    `Allowed licenses: ${ALLOWED_LICENSES.join(", ")} (SPDX OR expressions need one allowed branch, AND expressions need all). Scope shows whether a package is needed at runtime or only for development/optional platform builds.`,
    "",
    "Install scripts are disabled repository-wide (`.npmrc` `ignore-scripts=true`). Packages that declare one are marked; enabling any requires a deliberate, reviewed change.",
    "",
    "| Package | Version | License | Scope | Install script |",
    "| --- | --- | --- | --- | --- |",
    ...entries.map((e) => `| ${e.name} | ${e.version} | ${e.license} | ${e.scope} | ${e.installScript ? "yes (not run)" : "no"} |`),
    "",
  ];
  return lines.join("\n");
}

// The Rust launcher's dependencies (native/nn-launcher/Cargo.lock). A lock file carries no license, so the crates' licenses are recorded in cargo-licenses.json (name@version -> SPDX expression, copied
// from each crate's own Cargo.toml by `--write` when the crate sources are in the local cargo registry). The check: the recorded set equals the lock file's third-party set and every license is allowed.
const CARGO_LOCK = fileURLToPath(new URL("../native/nn-launcher/Cargo.lock", import.meta.url));
const CARGO_LICENSES = fileURLToPath(new URL("../native/nn-launcher/cargo-licenses.json", import.meta.url));

/** The third-party crates of a Cargo.lock (every package with a `source`: a registry, a git repository or anything else; only the local path crates have none), as sorted
 *  `name@version` keys. Each `[[package]]` block is read on its own, whatever the order of its lines or its line endings, so a crate cannot drop out of the check by its layout.
 *  A block without a name and a version is an error (the check then fails rather than skip it). */
export function cargoPackages(lockText) {
  const keys = [];
  for (const block of lockText.replace(/\r\n?/g, "\n").split(/^\[\[package\]\]$/m).slice(1)) {
    const body = block.split(/^\[/m)[0];
    const field = (name) => new RegExp(`^${name} = "([^"]*)"$`, "m").exec(body)?.[1];
    const [name, version, source] = [field("name"), field("version"), field("source")];
    if (!name || !version) throw new Error(`Cargo.lock has a [[package]] entry without a name and version: ${body.trim().split("\n")[0] ?? ""}`);
    if (source !== undefined) keys.push(`${name}@${version}`);
  }
  return keys.sort(compare);
}

/** Problems between a Cargo.lock's crates and the recorded licenses (empty: consistent and allowed). */
export function cargoProblems(lockText, recorded) {
  const problems = [];
  const keys = cargoPackages(lockText);
  for (const key of keys) {
    if (typeof recorded[key] !== "string") problems.push(`${key}: no license recorded in cargo-licenses.json (run npm run licenses:write)`);
    else if (!licenseAllowed(recorded[key])) problems.push(`${key}: license ${recorded[key]} is not on the allow list`);
  }
  for (const key of Object.keys(recorded)) if (!keys.includes(key)) problems.push(`${key}: recorded in cargo-licenses.json but not in Cargo.lock (stale)`);
  return problems;
}

/** The license of each crate from the local cargo registry's sources (undefined where a crate is not there). */
function readCargoLicenses(keys) {
  const base = join(process.env.CARGO_HOME ?? join(homedir(), ".cargo"), "registry", "src");
  const out = {};
  if (!existsSync(base)) return undefined;
  for (const index of readdirSync(base)) {
    for (const key of keys) {
      const file = join(base, index, key.replace("@", "-"), "Cargo.toml");
      if (existsSync(file)) { const m = /^license = "([^"]+)"/m.exec(readFileSync(file, "utf8")); if (m !== null) out[key] = m[1]; }
    }
  }
  return keys.every((k) => out[k] !== undefined) ? out : undefined;
}

const DOC = fileURLToPath(new URL("../docs/nimblenewt/implementation-plan/license-inventory.md", import.meta.url));
const LOCK = fileURLToPath(new URL("../package-lock.json", import.meta.url));

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mode = process.argv[2];
  const entries = inventory(JSON.parse(readFileSync(LOCK, "utf8")));
  const problems = violations(entries);
  const lockText = readFileSync(CARGO_LOCK, "utf8");
  if (mode === "--write") {
    writeFileSync(DOC, render(entries));
    const found = readCargoLicenses(cargoPackages(lockText));
    if (found !== undefined) writeFileSync(CARGO_LICENSES, `${JSON.stringify(Object.fromEntries(Object.entries(found).sort(([a], [b]) => compare(a, b))), null, 2)}\n`);
    else console.error("note: the crate sources are not in the local cargo registry; cargo-licenses.json was left as it is");
  }
  else if (mode === "--check") {
    let current = "";
    try { current = readFileSync(DOC, "utf8"); } catch { /* missing counts as stale */ }
    if (current !== render(entries)) problems.push("license-inventory.md is stale; run npm run licenses:write");
    problems.push(...cargoProblems(lockText, JSON.parse(readFileSync(CARGO_LICENSES, "utf8"))));
  } else { console.error("usage: license-inventory.mjs --write|--check"); process.exit(2); }
  if (problems.length > 0) { for (const p of problems) console.error(p); process.exit(1); }
  console.log(`license inventory ok (${entries.length} packages, ${cargoPackages(readFileSync(CARGO_LOCK, "utf8")).length} Rust crates)`);
}
