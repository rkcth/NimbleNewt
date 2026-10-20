// F01 package-boundary rules. Pure function so it can be tested against fixtures.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, normalize, relative } from "node:path";

/** Runtime dependencies each package may declare and import. Anything else is a violation. */
export const ALLOWED = {
  contracts: [],
  config: [],
  "pi-adapter": ["@nimblenewt/contracts", "@earendil-works/chord", "@earendil-works/pi-ai", "@earendil-works/pi-durable"],
  controller: [],
  api: [],
  worker: [],
  ui: [],
};

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
const EXACT = /^\d+\.\d+\.\d+$/;

function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|mts|cts)$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Returns a list of human-readable violations; empty means the boundaries hold. */
export function checkBoundaries(packagesDir, allowed = ALLOWED) {
  const errors = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = entry.name;
    const pkgPath = join(packagesDir, dir);
    const manifestPath = join(pkgPath, "package.json");
    if (!existsSync(manifestPath)) { errors.push(`${dir}: missing package.json`); continue; }
    const permitted = allowed[dir];
    if (!permitted) { errors.push(`${dir}: unregistered package`); continue; }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    for (const field of ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"]) {
      for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
        if (!permitted.includes(dep)) errors.push(`${dir}: ${field} entry ${dep} is not allowed`);
        if (!dep.startsWith("@nimblenewt/") && !EXACT.test(range)) errors.push(`${dir}: ${dep} must be pinned to an exact version, found ${range}`);
      }
    }

    const declared = new Set(Object.keys(manifest.dependencies ?? {}));
    const srcDir = join(pkgPath, "src");
    if (existsSync(srcDir)) {
      for (const file of sourceFiles(srcDir)) {
        for (const [, specifier] of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
          if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
          const name = packageName(specifier);
          if (!permitted.includes(name)) errors.push(`${dir}: ${relative(packagesDir, file)} imports ${name}, which is not allowed`);
          else if (!declared.has(name)) errors.push(`${dir}: ${relative(packagesDir, file)} imports ${name}, which is not a declared dependency`);
        }
      }
    }

    const tsconfigPath = join(pkgPath, "tsconfig.json");
    if (!existsSync(tsconfigPath)) { errors.push(`${dir}: missing tsconfig.json`); continue; }
    let tsconfig;
    try { tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8")); }
    catch { errors.push(`${dir}: tsconfig.json must be plain JSON (no comments or trailing commas)`); continue; }
    const refs = new Set((tsconfig.references ?? []).map((r) => `@nimblenewt/${basename(normalize(r.path))}`));
    const workspaceDeps = new Set([...declared].filter((d) => d.startsWith("@nimblenewt/")));
    for (const dep of workspaceDeps) if (!refs.has(dep)) errors.push(`${dir}: tsconfig references do not include dependency ${dep}`);
    for (const ref of refs) if (!workspaceDeps.has(ref)) errors.push(`${dir}: tsconfig references ${ref}, which is not a declared dependency`);
  }
  return errors;
}
