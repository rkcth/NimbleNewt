import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LPAC_CAPABILITIES, parseLauncherLine } from "./windows-native-plan.js";

// Card A03b slice 3: the contract between the TypeScript side (windows-native-plan.ts, windows-native-job.ts) and the Rust launcher crate (native/nn-launcher). The crate cannot run here
// (Windows only), so these tests read its source and the compiled TypeScript and pin the NAMES that cross the boundary: the `tool` identifier, the JSON field names the parser reads, the
// command line options and commands the backend sends, and the grant modes. A rename on either side fails a test on every operating system. What they do not prove is behaviour: that is
// the hosted Windows run (the ten containment cases through the product binary) and, later, the owner's own hardware.

function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "native", "nn-launcher", "src", "win.rs"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("native/nn-launcher/src/win.rs was not found above the test");
}
const root = findRepoRoot();
const crate = (name: string): string => readFileSync(join(root, "native", "nn-launcher", name), "utf8").replace(/\r\n/g, "\n");
const win = crate("src/win.rs");
/** The command line (Args, Mode, parse_args): platform-neutral, with its own Rust unit tests for both builds (cargo test, cargo test --features experiment). */
const args = crate("src/args.rs");
const here = (file: string): string => readFileSync(join(dirname(fileURLToPath(import.meta.url)), file), "utf8");

const sorted = (s: Iterable<string>): string[] => [...new Set(s)].sort();
const keysIn = (text: string): string[] => sorted([...text.matchAll(/\b[a-z]\.(?:s|b|n|raw)\("([A-Za-z]+)"/g)].map((m) => m[1]!));
const between = (text: string, from: string, to: string): string => { const a = text.indexOf(from); const b = text.indexOf(to, a + from.length); assert.ok(a >= 0 && b > a, `${from} .. ${to}`); return text.slice(a, b); };

/** The crate's JSON keys: those of one grant's entry (GrantSet::json) and every other key (the top-level line). */
const grantRegion = between(win, "    fn json(&self) -> String {", "impl Drop for GrantSet");
const grantKeys = keysIn(grantRegion);
const topKeys = keysIn(win.replace(grantRegion, ""));

/** What parseLauncherLine reads, taken from the compiled function itself. */
const parserText = (() => { const t = here("windows-native-plan.js"); return between(t, "export function parseLauncherLine", "const STAGE_KIND"); })();
const parserTop = sorted([...parserText.matchAll(/\b(?:str|num|bool)\("([A-Za-z]+)"\)/g)].map((m) => m[1]!).concat([...parserText.matchAll(/\br\["([A-Za-z]+)"\]/g)].map((m) => m[1]!)));
const parserGrant = sorted([...parserText.matchAll(/\bg\["([A-Za-z]+)"\]/g)].map((m) => m[1]!));

test("the tool identifier the parser matches is the one the crate prints (a rename on either side breaks this)", () => {
  const tool = /const TOOL: &str = "([^"]+)";/.exec(win)?.[1];
  assert.ok(tool !== undefined);
  assert.equal(win.match(/j\.s\("tool", TOOL\)/g)?.length, 2, "the line is written in main and in the experiment-only open-test, both from the constant");
  assert.equal(win.split(`"${tool}"`).length - 1, 1, "the identifier is written once (the constant), never as a second literal");
  assert.ok(crate("src/lib.rs").includes(`"tool\\":\\"${tool}\\"`), "the non-Windows line carries the same identifier");
  assert.ok(parserText.includes(`"${tool}"`), `parseLauncherLine matches ${tool}`);
  assert.notEqual(parseLauncherLine(JSON.stringify({ tool, ok: true })), undefined);
  assert.equal(parseLauncherLine(JSON.stringify({ tool: `${tool}-x`, ok: true })), undefined);
  assert.equal(parseLauncherLine(JSON.stringify({ ok: true })), undefined);
});

test("every top-level field the parser reads is a field the crate writes", () => {
  assert.ok(parserTop.length >= 10, `the parser's fields were found: ${parserTop.join(",")}`);
  for (const key of parserTop) assert.ok(topKeys.includes(key), `the crate never writes "${key}" (it writes: ${topKeys.join(", ")})`);
});

test("every per-grant field the parser reads is a field the crate writes into each grant entry", () => {
  assert.deepEqual(parserGrant, ["applied", "entriesLeft", "errorCode", "mode", "path", "revoked", "soft"]);
  for (const key of parserGrant) assert.ok(grantKeys.includes(key), `the crate never writes "${key}" into a grant entry (it writes: ${grantKeys.join(", ")})`);
});

test("a line made of the crate's own field names, with their types, is read back in full", () => {
  const line = {
    tool: "nn-appc-launcher", ok: false, stage: "grant", error: "x", childStarted: true, childExitCode: 3, timedOut: true, leftoverProcesses: 2, allGrantsRevoked: false, clean: true,
    grants: [{ path: "C:\\a", mode: "seal", soft: true, applied: true, revoked: false, errorCode: 5, entriesLeft: 1 }],
  };
  assert.deepEqual(parseLauncherLine(JSON.stringify(line)), { ...Object.fromEntries(Object.entries(line).filter(([k]) => k !== "tool")) });
});

test("the failure stages the crate reports are all stages the backend maps to a typed reason (an unknown stage would be a plain launcher failure)", () => {
  const stages = sorted([...win.matchAll(/(?:fail\(j, "|Err\(\("|\("(?=[a-z-]+", e\)))([a-z-]+)"/g)].map((m) => m[1]!));
  const mapped = sorted([...between(here("windows-native-plan.js"), "const STAGE_KIND", "/** The typed reason").matchAll(/(?:^|[ {,])"?([a-z-]+)"?:\s*"/g)].map((m) => m[1]!));
  assert.ok(stages.length >= 8, stages.join(","));
  // `arguments` and `wait` are the launcher's own refusals, not a task-folder, container or start failure: they are deliberately the generic launcher failure.
  for (const stage of stages) if (!["arguments", "wait", "platform"].includes(stage)) assert.ok(mapped.includes(stage), `stage "${stage}" has no typed reason in STAGE_KIND`);
});

test("every option and command the backend sends is accepted by the PRODUCT build (not an experiment-only option)", () => {
  const flagsSent = sorted([...between(here("windows-native-plan.js"), "export function launcherArgs", "/** The grants as the launcher").matchAll(/"(--[a-z0-9-]+)"/g)].map((m) => m[1]!).concat([...between(here("windows-native-plan.js"), "export function grantArgs", "export function parseLauncherLine").matchAll(/"(--[a-z0-9-]+)"/g)].map((m) => m[1]!)));
  assert.ok(flagsSent.includes("--grant") && flagsSent.includes("--stdin") && flagsSent.includes("--cmdline"), flagsSent.join(","));
  assert.ok(!win.includes("fn parse_args"), "the arguments are parsed in one place only (args.rs)");
  const parse = between(args, "fn parse_args", "// ---- end of parse_args");
  const accepted = sorted([...parse.matchAll(/"(--[a-z0-9-]+)"/g)].map((m) => m[1]!));
  const experimentOnly = sorted([...(/"--win32k-off" \|([^=]+)=> return Err/.exec(parse)?.[0] ?? "").matchAll(/"(--[a-z0-9-]+)"/g)].map((m) => m[1]!));
  assert.ok(experimentOnly.length >= 7, experimentOnly.join(","));
  for (const f of flagsSent) {
    assert.ok(accepted.includes(f), `the crate does not parse ${f}`);
    assert.ok(!experimentOnly.includes(f), `${f} is an experiment-only option: the product build refuses it`);
  }
  const productCommands = sorted([...(/matches!\(a\.command\.as_str\(\), ([^)]+)\)/.exec(parse)?.[1] ?? "").matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!));
  assert.deepEqual(productCommands, ["check", "info", "revoke", "run"]);
  const commandsSent = sorted([...here("windows-native-job.js").matchAll(/"(check|revoke|run|info)"/g)].map((m) => m[1]!).concat([...here("windows-native.js").matchAll(/\["(info|run|check|revoke)",/g)].map((m) => m[1]!), ["run"]));
  for (const c of commandsSent) assert.ok(productCommands.includes(c), `command ${c}`);
});

test("the grant modes the backend sends are the ones the product build accepts; deny modes are refused there", () => {
  const sent = sorted([...here("windows-native-plan.js").matchAll(/mode: "([a-z-]+)"/g)].map((m) => m[1]!));
  assert.deepEqual(sent, ["modify", "modify-root", "rx", "seal"]);
  const parsed = sorted([...between(args, "fn parse(s: &str)", "fn name(self)").matchAll(/"([a-z-]+)" =>/g)].map((m) => m[1]!));
  for (const m of sent) assert.ok(parsed.includes(m), `mode ${m}`);
  assert.ok(/if !EXPERIMENT && matches!\(mode, Mode::DenyWrite \| Mode::DenyStrong\)/.test(args), "deny-write and deny-strong are refused unless the experiment feature is on");
});

test("the capabilities the backend sends are exactly the ones the PRODUCT build accepts, and the product refuses limits that would switch a job limit off", () => {
  const listed = /pub\(crate\) const PRODUCT_CAPABILITIES: \[&str; \d+\] = \[([^\]]*)\];/.exec(args)?.[1];
  assert.ok(listed !== undefined, "PRODUCT_CAPABILITIES is declared in args.rs");
  assert.deepEqual(sorted([...listed.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)), sorted(LPAC_CAPABILITIES), "the backend's LPAC_CAPABILITIES and the crate's PRODUCT_CAPABILITIES are the same list");
  const parse = between(args, "fn parse_args", "// ---- end of parse_args");
  assert.ok(/if !EXPERIMENT && !PRODUCT_CAPABILITIES\.contains\(&c\.as_str\(\)\)/.test(parse), "any other capability (a network one, a SID) is refused by the product build");
  assert.ok(/"optin" if EXPERIMENT =>/.test(parse), "the optin policy is experiment-only");
  assert.ok(/a\.memory_mb == 0 \|\| a\.active_processes == 0 \|\| a\.timeout_ms == 0 \|\| a\.timeout_ms == u32::MAX/.test(parse), "a product run always keeps its job limits and a finite timeout");
});

test("the product build is the default: the feature is off, the binary is named nn-launcher, and the experiment crate is the only one that turns the feature on", () => {
  const cargo = crate("Cargo.toml");
  assert.match(cargo, /^\[\[bin\]\]\nname = "nn-launcher"/m);
  // The feature only switches on extra windows-sys modules that the experiment build's code calls (round 5); it adds no dependency and no default.
  assert.match(cargo, /^experiment = \[(?:"windows-sys\/[A-Za-z0-9_]+"(?:, )?)*\]$/m);
  assert.ok(!/^default\s*=/m.test(cargo), "no default features");
  assert.ok(args.includes('pub(crate) const EXPERIMENT: bool = cfg!(feature = "experiment");'));
  assert.ok(/#\[cfg\(not\(feature = "experiment"\)\)\]\s*#\[test\]\s*fn the_product_build_refuses_every_experiment_option/.test(args), "the product build's refusals have a Rust unit test of their own");
  assert.ok(readFileSync(join(root, "experiments", "windows-appcontainer", "launcher", "Cargo.toml"), "utf8").includes('features = ["experiment"]'));
  // The experiment-only code is compiled out of the product binary, not just refused.
  for (const item of ["fn open_test()", "fn hang_report(", "fn cpu_ms(", 'extern "C" {']) {
    const at = win.indexOf(item);
    assert.ok(at > 0, item);
    assert.ok(/#\[cfg\(feature = "experiment"\)\]\s*(?:\/\/\/[^\n]*\n\s*)*$/.test(win.slice(Math.max(0, at - 400), at)), `${item} is behind the experiment feature`);
  }
});

test("the program folder, the toolchain pin and the lock file are the reproducible-build inputs", () => {
  assert.match(crate("rust-toolchain.toml"), /channel = "\d+\.\d+\.\d+"/);
  assert.match(crate(".cargo/config.toml"), /\/Brepro/);
  assert.match(crate("Cargo.lock"), /name = "nn-launcher"/);
  assert.ok(!/name = "nn-appc-launcher"/.test(crate("Cargo.lock")));
});
