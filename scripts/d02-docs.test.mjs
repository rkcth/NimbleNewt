// Card D02: the developer, API, security and license guidance says only what the repository can back up. The worked API and listener
// examples are run by packages/controller/src/api/d02-guidance.test.ts and packages/controller/src/transport/d02-protocol.test.ts; this file
// checks everything else a reader could act on: links, file paths, commands, flags, environment variables, operation and setting names, error
// codes, and the facts the guides repeat from the code (supported environments, flush settings).
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, ...file.split("/")), "utf8").replace(/\r\n/g, "\n");

export const GUIDES = [
  "SECURITY.md", "CONTRIBUTING.md",
  "docs/nimblenewt/api-guide.md", "docs/nimblenewt/architecture.md", "docs/nimblenewt/compatibility-and-support.md",
  "docs/nimblenewt/conversation-and-mcp-protocol.md", "docs/nimblenewt/durability-and-flush.md", "docs/nimblenewt/notices.md",
  "docs/nimblenewt/security-guide.md", "docs/nimblenewt/troubleshooting.md",
];

function walk(dir, keep, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, keep, out);
    else if (keep(entry.name)) out.push(full);
  }
  return out;
}
// Everything a name could legitimately come from: the source of the packages and the scripts (tests included, for helpers), the workflows.
const sourceText = [
  ...walk(join(root, "packages"), (n) => n.endsWith(".ts")),
  ...walk(join(root, "scripts"), (n) => n.endsWith(".mjs") && n !== "d02-docs.test.mjs"),
].map((f) => readFileSync(f, "utf8")).join("\n");
const apiReference = read("docs/nimblenewt/api-v1.md");
const operations = new Set([...apiReference.matchAll(/^#### `([a-z0-9.-]+)`/gm)].map((m) => m[1]));
const packageJson = JSON.parse(read("package.json"));

const slug = (heading) => heading.toLowerCase().replace(/`/g, "").replace(/[^a-z0-9 _-]/g, "").trim().replace(/ /g, "-");
const anchorsOf = (file) => new Set([...read(file).matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1])));
const inCode = (text) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
/** Text outside fenced blocks, which carry their own checks. */
const prose = (text) => text.replace(/```[\s\S]*?```/g, "");

for (const guide of GUIDES) {
  test(`${guide}: every relative link goes to a file, and to a heading that exists (card D02)`, () => {
    const text = prose(read(guide));
    const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((l) => !/^(https?:|mailto:)/.test(l));
    assert.ok(links.length > 0 || guide === "SECURITY.md", `${guide} links to nothing`);
    for (const link of links) {
      const [path, anchor] = link.split("#");
      const target = path === "" ? guide : relative(root, resolve(root, dirname(guide), path)).split(sep).join("/");
      assert.ok(existsSync(join(root, ...target.split("/"))), `${guide}: ${link} does not exist`);
      if (anchor !== undefined && target.endsWith(".md")) assert.ok(anchorsOf(target).has(anchor), `${guide}: ${link}: no heading "${anchor}" in ${target}`);
    }
  });

  test(`${guide}: the paths, commands, flags, variables, operations and codes it names exist (card D02)`, () => {
    const tokens = [...new Set(inCode(prose(read(guide))))];
    const bad = [];
    for (const raw of tokens) {
      const token = raw.trim();
      // A path in the repository.
      if (/^(packages|scripts|docs|\.github|benchmarks)\/[\w./-]+$/.test(token) && !token.includes("...")) {
        const path = token.replace(/\/$/, "");
        if (!existsSync(join(root, ...path.split("/")))) bad.push(`path ${token}`);
        continue;
      }
      // npm run NAME
      const run = /^npm run ([\w:-]+)/.exec(token);
      if (run !== null && packageJson.scripts[run[1]] === undefined) bad.push(`npm script ${run[1]}`);
      // node scripts/FILE
      const prog = /^node (?:--[\w-]+ )*(\.?\/?scripts\/[\w.-]+)/.exec(token);
      if (prog !== null && !existsSync(join(root, ...prog[1].replace(/^\.\//, "").split("/")))) bad.push(`program ${prog[1]}`);
      // --flag
      for (const flag of token.match(/(?<![\w-])--[a-z][a-z-]+/g) ?? []) if (!sourceText.includes(flag) && !["--import", "--test", "--no-warnings", "--test-timeout"].includes(flag)) bad.push(`flag ${flag}`);
      // NIMBLENEWT_VARIABLE
      for (const variable of token.match(/\bNIMBLENEWT_[A-Z_]+[A-Z]\b/g) ?? []) if (!sourceText.includes(variable) && !sourceText.includes(variable.replace(/_NAME$/, "_"))) bad.push(`variable ${variable}`);
      // an operation or setting name: a dotted word whose first part is the first part of a real operation
      if (/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(token) && !/\.(json|md|mjs|ts|js|yml|sqlite|lock|jsonc?)$/.test(token)) {
        const family = new Set([...operations].map((o) => o.split(".")[0]));
        if (family.has(token.split(".")[0]) && !operations.has(token) && !sourceText.includes(`"${token}"`) && !sourceText.includes(`'${token}'`)) bad.push(`operation or setting ${token}`);
      }
      // a snake_case error code, route error or tool name
      if (/^[a-z]+(_[a-z]+)+$/.test(token) && !sourceText.includes(token)) bad.push(`code or tool ${token}`);
    }
    assert.deepEqual(bad, []);
  });
}

test("the guides repeat the supported environments exactly as the code lists them (card D02)", () => {
  const supported = readFileSync(join(root, "packages", "controller", "src", "environment", "supported.ts"), "utf8");
  const doc = read("docs/nimblenewt/compatibility-and-support.md");
  assert.ok(doc.includes(`| Node.js | ${/node: \{ minimum: "([\d.]+)"/.exec(supported)[1]} or newer |`), "the Node.js minimum");
  assert.ok(doc.includes(`PostgreSQL (optional) | ${/minimumMajor: (\d+)/.exec(supported)[1]} and`), "the PostgreSQL minimum");
  for (const build of supported.match(/minimumRelease: \d+/g)) assert.ok(doc.includes(build.split(": ")[1]), build);
  for (const names of [...supported.matchAll(/names: \[([^\]]+)\]/g)]) for (const name of names[1].match(/"([^"]+)"/g)) assert.ok(doc.toLowerCase().includes(name.replace(/"/g, "")), `file system ${name}`);
  assert.ok(doc.includes(/id: "git"[^}]*minimum: "([\d.]+)"/.exec(supported)[1]), "the git minimum");
  assert.ok(doc.includes(/OVERRIDE_FLAG = "([^"]+)"/.exec(supported)[1]) && doc.includes(/OVERRIDE_ENV = "([^"]+)"/.exec(supported)[1]), "the override switches");
  const mcp = readFileSync(join(root, "packages", "controller", "src", "mcp", "mcp.ts"), "utf8");
  for (const revision of /revisions: \[([^\]]+)\]/.exec(mcp)[1].match(/\d{4}-\d\d-\d\d/g)) {
    assert.ok(doc.includes(revision) && read("docs/nimblenewt/conversation-and-mcp-protocol.md").includes(revision), `MCP revision ${revision}`);
  }
  assert.ok(doc.includes(/PINNED_PI_DURABLE_VERSION = "([\d.]+)"/.exec(readFileSync(join(root, "packages", "pi-adapter", "src", "runtime.ts"), "utf8"))[1]), "the pinned Pi Durable release");
});

test("the durability guide matches the settings the storage code enforces (card D02)", () => {
  const sqlite = readFileSync(join(root, "packages", "controller", "src", "storage", "sqlite", "storage.ts"), "utf8");
  const postgres = readFileSync(join(root, "packages", "controller", "src", "storage", "postgres", "storage.ts"), "utf8");
  const doc = read("docs/nimblenewt/durability-and-flush.md");
  assert.ok(sqlite.includes('PRAGMA synchronous = FULL') && sqlite.includes('PRAGMA journal_mode = WAL'));
  assert.ok(/`synchronous = FULL`/.test(doc) && /write-ahead-log/.test(doc));
  assert.ok(postgres.includes("synchronous_commit=on") && postgres.includes("s.fsync !== \"on\"") && postgres.includes("fullPageWrites"));
  for (const setting of ["fsync", "full_page_writes", "synchronous_commit"]) assert.ok(doc.includes(`\`${setting}\``), setting);
  // every event the card names is answered, store by store
  const section = (from, to) => doc.slice(doc.indexOf(from), doc.indexOf(to));
  const sqliteRows = section("### SQLite", "### PostgreSQL");
  const postgresRows = section("### PostgreSQL", "### Moving between them");
  for (const row of ["| Process crash |", "| Orderly shutdown |", "| Power loss |"]) assert.ok(sqliteRows.includes(row), `SQLite: ${row}`);
  for (const row of ["| Controller process crash |", "| Orderly shutdown |", "| Power loss of the controller machine |", "| Power loss of the **server** machine |"]) assert.ok(postgresRows.includes(row), `PostgreSQL: ${row}`);
  const outside = section("## What NimbleNewt does not own", "## How a developer");
  for (const event of ["process crash", "orderly shutdown", "power loss"]) assert.ok(outside.includes(event), `agent history: ${event}`);
  for (const call of ["file.sync()", "directory.sync()"]) assert.ok(readFileSync(join(root, "packages", "controller", "src", "artifacts", "blobs.ts"), "utf8").includes(call), `blobs.ts no longer calls ${call}`);
  // The agent process opens Pi Durable's JSONL store with its default options, under which nothing is flushed (the guide says so).
  assert.ok(/JSONL/.test(outside) && /nothing is flushed to disk/.test(outside) && /`fsync`/.test(outside), "the agent history section says the JSONL store is not flushed");
  const worker = readFileSync(join(root, "packages", "pi-adapter", "src", "worker", "process.ts"), "utf8");
  assert.match(worker, /openNodeJsonlStorage\(dir, BACKGROUND_CONTEXT\)/, "the agent process no longer opens the JSONL store with default options: update the guide");
  const jsonl = join(root, "node_modules", "@earendil-works", "pi-durable", "dist", "storage", "jsonl", "storage.js");
  assert.ok(existsSync(jsonl), "Pi Durable's JSONL storage moved: check whether it flushes by default and update the guide");
  assert.match(readFileSync(jsonl, "utf8"), /this\.fsync = options\.fsync \?\? false/, "Pi Durable's JSONL store no longer defaults to no flush: update the guide");
  // ... and no adapter source turns flushing on or opens another store kind.
  const adapterSources = walk(join(root, "packages", "pi-adapter", "src"), (n) => n.endsWith(".ts") && !n.endsWith(".test.ts")).filter((f) => !relative(root, f).split(sep).includes("testing"));
  assert.ok(adapterSources.length > 0, "no adapter sources found");
  const others = adapterSources.filter((f) => /fsync\s*:\s*true|openNodeSqlite|storage\/sqlite/.test(readFileSync(f, "utf8")));
  assert.deepEqual(others, [], "the adapter now opens Pi's store differently: update the guide");
});

test("SECURITY.md says how to report, what to expect, which versions are supported and what is in and out of scope (card D02)", () => {
  const text = read("SECURITY.md");
  for (const heading of ["Reporting a vulnerability", "What to expect", "Which versions are supported", "What is in scope", "What is out of scope"]) assert.ok(new RegExp(`^## ${heading}`, "m").test(text), heading);
  assert.ok(/private vulnerability reporting/i.test(text) && /do not open a public issue/i.test(text));
  assert.ok(/\*\*7 days\*\*/.test(text) && /\*\*30 days\*\*/.test(text));
  assert.ok(/\.github/.test(text) === false || existsSync(join(root, ".github")));
});

test("CONTRIBUTING.md records the three things a non-TypeScript component needs, and the commands a contributor runs (card D02)", () => {
  const text = read("CONTRIBUTING.md");
  const section = text.slice(text.indexOf("## A component that is not TypeScript"), text.indexOf("## Documentation"));
  for (const word of ["Justification", "A bounded interface", "A maintenance plan"]) assert.ok(section.includes(word), word);
  assert.ok(/Linux, macOS \*\*and\*\* Windows/.test(section));
  for (const script of ["clean", "check:deps", "licenses:check", "licenses:write", "api:docs:write", "roadmap:check", "test:changed", "test:fast", "test:shard", "test"]) assert.ok(packageJson.scripts[script] !== undefined, `package.json has no ${script}`);
  // the non-TypeScript files the guide names are the ones that exist
  const others = walk(root, (n) => /\.(py|rs|go|c|cc|cpp|java|rb|sh)$/.test(n)).map((f) => relative(root, f).split(sep).join("/"));
  for (const file of others) assert.ok(text.includes(file.startsWith("benchmarks/") ? "benchmarks/nimblenewt-harness/" : file), `${file} exists but CONTRIBUTING.md does not account for it`);
  assert.ok(existsSync(join(root, "LICENSE")) && /MIT License/.test(read("LICENSE")) && text.includes("MIT"));
});

test("the license guide and the inventory agree with the allow-list and with each other (card D02)", async () => {
  const { ALLOWED_LICENSES } = await import(new URL("./license-inventory.mjs", import.meta.url));
  const notices = read("docs/nimblenewt/notices.md");
  const contributing = read("CONTRIBUTING.md");
  for (const license of ALLOWED_LICENSES) { assert.ok(notices.includes(license), `notices.md omits ${license}`); assert.ok(contributing.includes(license), `CONTRIBUTING.md omits ${license}`); }
  assert.ok(existsSync(join(root, "docs", "nimblenewt", "implementation-plan", "license-inventory.md")));
  assert.ok(read(".npmrc").includes("ignore-scripts=true"));
});
