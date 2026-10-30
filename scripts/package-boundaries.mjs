// F01 package-boundary rules. Pure function so it can be tested against fixtures.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, normalize, relative, sep } from "node:path";

/** Runtime dependencies each package may declare and import. Anything else is a violation. */
export const ALLOWED = {
  contracts: [],
  config: [],
  registry: [],
  "pi-adapter": ["@nimblenewt/contracts", "@nimblenewt/registry", "@earendil-works/chord", "@earendil-works/pi-ai", "@earendil-works/pi-durable"],
  controller: ["pg", "@types/pg", "embedded-postgres", "@nimblenewt/registry"],
  api: [],
  // The worker host speaks the controller channel defined in contracts (card H12b); it depends on nothing else of the product.
  worker: ["@nimblenewt/contracts"],
  ui: [],
  // Tests that run the controller, the Pi adapter and the worker's sandbox together (cards S09, T06b). It holds no product code and nothing depends on it, which is why
  // it alone may depend on both.
  integration: ["@nimblenewt/contracts", "@nimblenewt/controller", "@nimblenewt/pi-adapter", "@nimblenewt/worker", "@earendil-works/chord", "@earendil-works/pi-ai", "@earendil-works/pi-durable"],
};

/**
 * Only these folders may talk to a database. Everything else (domain services, API, workers) uses the typed storage
 * contract, so no SQL, driver or connection can leak into domain code (card F04a).
 */
export const DATABASE_FOLDERS = [
  "controller/src/storage/sqlite/",
  "controller/src/storage/postgres/",
  // Qualification tooling (synthetic migrations, layout fixtures, workload reports) must speak to both databases to test them. It is
  // test support that no domain service imports.
  "controller/src/storage/qualification/",
];
const DATABASE_DRIVERS = new Set(["node:sqlite", "sqlite3", "better-sqlite3", "pg", "pg-pool", "postgres", "mysql", "mysql2", "@electric-sql/pglite", "embedded-postgres", "knex", "kysely", "drizzle-orm", "typeorm", "sequelize", "@prisma/client"]);
/** A tripwire for SQL written in source: statement forms in upper case anywhere in a file. */
const SQL_TEXT = /\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+\S+\s+SET|MERGE\s+INTO|ON\s+CONFLICT|CREATE\s+(?:TABLE|INDEX|UNIQUE\s+INDEX)|ALTER\s+TABLE|DROP\s+TABLE|SELECT\s[^;'"`\n]{1,200}\sFROM)\b/;
/** The same forms in any letter case, but only inside string and template literals (comments and prose are skipped). */
const SQL_LITERAL = /\b(?:insert\s+into|delete\s+from|update\s+\S+\s+set|merge\s+into|on\s+conflict|create\s+(?:table|index|unique\s+index)|alter\s+table|drop\s+table|select\s[^;'"`\n]{1,200}\sfrom)\b/i;
const LITERALS = /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g;
const hasSql = (text) => SQL_TEXT.test(text) || (text.match(LITERALS) ?? []).some((literal) => SQL_LITERAL.test(literal));

// `(?<![-\w.$])` keeps command-line flags such as "--import" from being read as import statements.
/** Files that only tests load: they may import devDependencies. */
const TEST_ONLY = /(?:^|\/)testing\/|\.test\.ts$/;
// `from` must not follow an identifier character, quote, backtick or dot, so the string array ["a", "from", "b"] is not an import;
// a module specifier has no whitespace or commas.
const SPECIFIER = /(?:(?<![\w$.'"\x60])from\s*|(?<![-\w.$])import\s*\(?\s*|\brequire\s*\(\s*)["']([^"'\s,]+)["']/g;
/** Drops whole-line comments only (// lines, and /* ... *\/ blocks that begin a line), so import-like prose is not scanned. Comment markers inside strings are never touched. */
const stripComments = (text) => text.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "").replace(/^[ \t]*\/\/.*$/gm, "");
/** An exact version, optionally with a pre-release tag (some packages ship their stable builds under one). Ranges never match. */
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;

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
    const declaredDev = new Set(Object.keys(manifest.devDependencies ?? {}));
    const srcDir = join(pkgPath, "src");
    if (existsSync(srcDir)) {
      for (const file of sourceFiles(srcDir)) {
        const raw = readFileSync(file, "utf8");
        const text = stripComments(raw);
        const where = relative(packagesDir, file).split(sep).join("/");
        if (!DATABASE_FOLDERS.some((folder) => where.startsWith(folder))) {
          if (hasSql(raw)) errors.push(`${dir}: ${where} contains SQL; only ${DATABASE_FOLDERS.join(" and ")} may`);
          for (const [, specifier] of text.matchAll(SPECIFIER)) if (DATABASE_DRIVERS.has(specifier) || DATABASE_DRIVERS.has(packageName(specifier))) errors.push(`${dir}: ${where} imports the database driver ${specifier}; only ${DATABASE_FOLDERS.join(" and ")} may`);
        }
        for (const [, specifier] of text.matchAll(SPECIFIER)) {
          // qualification/ may hold SQL (see DATABASE_FOLDERS), so only test files and qualification/ itself may import from it.
          if (specifier.startsWith(".") && /(?:^|\/)qualification\//.test(specifier) && !where.startsWith("controller/src/storage/qualification/") && !TEST_ONLY.test(where)) {
            errors.push(`${dir}: ${where} imports ${specifier}; qualification/ is test support, and only test files and qualification/ itself may import from it`);
          }
          if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
          const name = packageName(specifier);
          if (!permitted.includes(name)) errors.push(`${dir}: ${relative(packagesDir, file)} imports ${name}, which is not allowed`);
          else if (!declared.has(name) && !(TEST_ONLY.test(where) && declaredDev.has(name))) errors.push(`${dir}: ${relative(packagesDir, file)} imports ${name}, which is not a declared dependency${declaredDev.has(name) ? " (a devDependency may only be imported by test files and testing/ folders)" : ""}`);
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
