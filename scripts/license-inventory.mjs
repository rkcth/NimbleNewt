// Builds a license inventory of locked third-party packages from package-lock.json.
//   node scripts/license-inventory.mjs --write   regenerate the inventory document
//   node scripts/license-inventory.mjs --check   fail if the document is stale or a license is not allowed
import { readFileSync, writeFileSync } from "node:fs";
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

const DOC = fileURLToPath(new URL("../docs/nimblenewt/implementation-plan/license-inventory.md", import.meta.url));
const LOCK = fileURLToPath(new URL("../package-lock.json", import.meta.url));

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mode = process.argv[2];
  const entries = inventory(JSON.parse(readFileSync(LOCK, "utf8")));
  const problems = violations(entries);
  if (mode === "--write") writeFileSync(DOC, render(entries));
  else if (mode === "--check") {
    let current = "";
    try { current = readFileSync(DOC, "utf8"); } catch { /* missing counts as stale */ }
    if (current !== render(entries)) problems.push("license-inventory.md is stale; run npm run licenses:write");
  } else { console.error("usage: license-inventory.mjs --write|--check"); process.exit(2); }
  if (problems.length > 0) { for (const p of problems) console.error(p); process.exit(1); }
  console.log(`license inventory ok (${entries.length} packages)`);
}
