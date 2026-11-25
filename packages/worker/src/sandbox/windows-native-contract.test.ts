import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LPAC_CAPABILITIES, RUN_PROFILE_PREFIX, isRunProfileName, parseLauncherLine } from "./windows-native-plan.js";

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
    windowStation: "private", windowStationOk: false, windowStationError: "window objects: the private window station could not be made (error 5)",
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
  assert.deepEqual(productCommands, ["check", "delete-profile", "info", "revoke", "run"]);
  const commandsSent = sorted([...here("windows-native-job.js").matchAll(/"(check|revoke|run|info|delete-profile)"/g)].map((m) => m[1]!).concat([...here("windows-native.js").matchAll(/\["(info|run|check|revoke|delete-profile)",/g)].map((m) => m[1]!), ["run"]));
  assert.ok(commandsSent.includes("delete-profile") && commandsSent.includes("info"), "the per-run profile commands are sent");
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
  // The feature only switches on these extra windows-sys modules that the experiment build's code calls (round 5): no dependency (`dep:`, another crate's feature), no other module, no default.
  // Any change to this list is a change to this test. (The window station and Gdi modules are the product's own since the private window station fix: see the next test.)
  assert.match(cargo, /^experiment = \["windows-sys\/Win32_System_SystemInformation", "windows-sys\/Wdk_System_SystemServices"\]$/m);
  assert.equal(cargo.match(/^experiment\s*=/gm)?.length, 1, "one definition of the feature");
  // The product's dependency table is exactly windows-sys: the feature cannot reach an optional dependency because there is none.
  const deps = /^\[dependencies\]\n([^[]*)/m.exec(cargo)?.[1] ?? "";
  assert.deepEqual(deps.split("\n").filter((l) => /^[A-Za-z0-9_-]+\s*=/.test(l)).map((l) => l.split("=")[0]!.trim()), ["windows-sys"]);
  assert.ok(!/optional\s*=\s*true/.test(cargo), "no optional dependency");
  // Round 5's window-object grant code (desk.rs) and its rules (deskrules.rs) are compiled only into the experiment build (deskrules also into the unit tests), never into the product binary.
  // The private window station code (privdesk.rs, winobj.rs) is the product's own and is compiled into both.
  assert.match(crate("src/lib.rs"), /#\[cfg\(any\(test, feature = "experiment"\)\)\]\nmod deskrules;/);
  assert.match(crate("src/lib.rs"), /\nmod winobj;/);
  assert.match(win, /\n#\[path = "privdesk\.rs"\]\nmod privdesk;/);
  assert.ok(!/#\[cfg\(feature = "experiment"\)\]\s*#\[path = "privdesk\.rs"\]/.test(win), "privdesk.rs is not behind the experiment feature");
  assert.match(win, /#\[cfg\(feature = "experiment"\)\]\n#\[path = "desk\.rs"\]\nmod desk;/);
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

// ---------------------------------------------------------------------------------------------------------------- the private window station (Session 0 fix)

const productFeatures = (): string[] => {
  const cargo = crate("Cargo.toml");
  const block = /^windows-sys = \{ version = "0\.59", features = \[([^\]]*)\] \}$/m.exec(cargo)?.[1] ?? "";
  return [...block.matchAll(/"([A-Za-z0-9_]+)"/g)].map((m) => m[1]!);
};
const code = (text: string): string => text.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

test("the product's windows-sys feature list is exactly this, in this order (the window station modules are there on purpose; any other change is a change to this test)", () => {
  assert.deepEqual(productFeatures(), [
    "Win32_Foundation", "Win32_Graphics_Gdi", "Win32_Security", "Win32_Security_Authorization", "Win32_Security_Isolation", "Win32_Storage_FileSystem", "Win32_System_Diagnostics_ToolHelp",
    "Win32_System_IO", "Win32_System_JobObjects", "Win32_System_Pipes", "Win32_System_RemoteDesktop", "Win32_System_StationsAndDesktops", "Win32_System_Threading",
  ]);
  assert.ok(crate("Cargo.toml").includes("CreateDesktopW takes a DEVMODEW"), "the reason the Gdi module is there is written in the manifest");
});

test("every run of the PRODUCT build is given a private window station and desktop, made before any grant, and a failure to make it is a typed failure that starts nothing", () => {
  const priv = code(crate("src/privdesk.rs"));
  const wincode = code(win);
  assert.match(wincode, /fn private_wanted\(a: &Args\) -> bool \{\n\s*#\[cfg\(feature = "experiment"\)\]\n\s*\{ a\.desktop == crate::args::DesktopMode::Private \}\n\s*#\[cfg\(not\(feature = "experiment"\)\)\]\n\s*\{ let _ = a; true \}/, "the product always wants it");
  const run = between(wincode, "fn run_core(a: &Args, j: Json, sid: &Sid) -> (Outcome, bool) {", "#[allow(clippy::too_many_arguments)]");
  assert.ok(run.indexOf("privdesk::PrivateDesktop::create(sid.0)") > 0, "created in run");
  assert.ok(run.indexOf("privdesk::PrivateDesktop::create(sid.0)") < run.indexOf("GrantSet { sid: sid.0"), "made before any grant");
  assert.match(run, /Err\(e\) => return \(fail\(j, "grant", &e\), true\)/, "the stage is the existing `grant` (STAGE_KIND maps it); the message starts with 'window objects:'");
  assert.ok(priv.match(/format!\("window objects:/g)!.length >= 3 && /fn trouble\(what: &str, code: u32\) -> String \{ format!\("window objects: /.test(priv), "every message starts with 'window objects:'");
  const inner = between(wincode, "fn run_inner(", "for spec in &a.grants {");
  assert.match(inner, /if private_wanted\(a\) && private_desktop\.is_none\(\) \{ return Err\(\("grant", "window objects: /, "no private desktop, no start");
  assert.match(wincode, /let mut lp_desktop: Vec<u16> = private_desktop\.unwrap_or_default\(\);/);
  assert.match(wincode, /si\.StartupInfo\.lpDesktop = lp_desktop\.as_mut_ptr\(\);/);
  assert.ok(wincode.indexOf("p.close(); j.raw(\"windowObjects\", p.json())") > wincode.indexOf("grants.revoke_all();"), "closed after the run, with the report");
  assert.ok(parseLauncherLine(JSON.stringify({ tool: "nn-appc-launcher", ok: false, stage: "grant", error: "window objects: x" }))?.stage === "grant");
});

test("the private window station code never touches an object of the launcher's own session: no WinSta0, no opening of a station or desktop by name, no write to an existing DACL, no broad entry", () => {
  const priv = code(crate("src/privdesk.rs"));
  const pure = code(crate("src/winobj.rs").split("#[cfg(test)]")[0]!);
  for (const text of [priv, pure]) {
    assert.ok(!/winsta0/i.test(text), "never the interactive station");
    assert.ok(!/OpenWindowStationW|OpenDesktopW|GetThreadDesktop|SetThreadDesktop|SwitchDesktop|SetEntriesInAclW|SetKernelObjectSecurity|SetUserObjectSecurity/.test(text), "no open by name, no entry builder that rebuilds the list");
  }
  // The product writes NO DACL: both objects are CREATED with their final one (winobj::private_dacl in the SECURITY_ATTRIBUTES of the creating call). The DACL writers of the experiment
  // (write_dacl, add_entry) are compiled into the experiment build only, and the one SetSecurityDescriptorDacl is on the launcher's own new descriptor, inside CreationSd::new.
  const raw = crate("src/privdesk.rs");
  for (const f of ["pub(crate) fn write_dacl(", "pub(crate) fn add_entry(", "pub(crate) const WRITE_DAC_BIT"]) {
    const at = raw.indexOf(f);
    assert.ok(at > 0 && /#\[cfg\(feature = "experiment"\)\][^\n]*\n$/.test(raw.slice(0, at)), `${f} is behind the experiment feature`);
  }
  assert.equal(priv.match(/\bwrite_dacl\(/g)!.length, 2, "its definition and its one call, in add_entry (experiment)");
  assert.equal(priv.match(/\badd_entry\(/g)!.length, 1, "its definition only: the product's create does not call it (desk.rs does, in the experiment build)");
  assert.equal(priv.match(/SetSecurityInfo\(/g)!.length, 1, "the one in write_dacl");
  assert.equal(priv.match(/SetSecurityDescriptorDacl\(/g)!.length, 1);
  assert.ok(between(priv, "impl CreationSd {", "fn creation_sd(").includes("SetSecurityDescriptorDacl(psd, 1, p, 0)"), "on the launcher's own new descriptor only");
  assert.match(priv, /SetSecurityDescriptorControl\(psd, SE_DACL_PROTECTED, SE_DACL_PROTECTED\)/, "nothing is inherited into it");
  const create = between(priv, "pub(crate) fn create(sid: PSID)", "fn check(");
  assert.ok(!/add_entry|write_dacl|WRITE_DAC/.test(create), "the product's create neither writes a DACL nor asks for WRITE_DAC");
  assert.match(create, /CreateWindowStationW\(wstation\.as_ptr\(\), winobj::STATION_CREATE_ONLY, STATION_RIGHTS, &sa\)/, "made with its final DACL and CWF_CREATE_ONLY (an existing station of that name is never opened)");
  assert.match(pure, /pub\(crate\) const STATION_CREATE_ONLY: u32 = 0x0000_0001;/, "CWF_CREATE_ONLY is 1 (winuser.h)");
  assert.match(create, /CreateDesktopW\(wdesktop\.as_ptr\(\), null\(\), null\(\), 0, DESKTOP_RIGHTS, &sa\)/);
  assert.match(create, /creation_sd\(&own\[0\], &sid_b, STATION_RIGHTS, winobj::STATION_FULL, "window station"\)\?/);
  assert.match(create, /creation_sd\(&own\[0\], &sid_b, DESKTOP_RIGHTS, winobj::DESKTOP_FULL, "desktop"\)\?/);
  assert.ok(create.indexOf("let sa = desktop_sd.attributes();") > create.indexOf("StationSwitch::to("), "the desktop's descriptor is the one built for it");
  assert.match(pure, /fn private_dacl\(user: &\[u8\], container: &\[u8\], mask: u32, full: u32\)/);
  assert.match(priv, /bInheritHandle: 0 \}/, "the handles are not inheritable");
  // the masks are the measured ones (the container's), and the account's cover them; the DACL read back must pass the check; the process station is put back and that is checked
  assert.match(pure, /STATION_RIGHTS: u32 = 0x0002_037F;/);
  assert.match(pure, /DESKTOP_RIGHTS: u32 = 0x0002_01FF;/);
  assert.match(pure, /STATION_FULL: u32 = 0x000F_037F;/);
  assert.match(pure, /DESKTOP_FULL: u32 = 0x000F_01FF;/);
  assert.match(priv, /winobj::private_acl_ok\(c\.bytes\(\), sid_b, mask, &self\.own\)/, "the read-back is checked against the launcher's own token user and owner");
  assert.match(priv, /for class in \[TokenUser, TokenOwner\]/, "the user first: own[0] is the account the objects are made for");
  assert.equal(priv.match(/\bcheck\(h[sd], &sid_b, (STATION|DESKTOP)_RIGHTS, /g)!.length, 2, "both objects read back and checked");
  assert.ok(create.indexOf("let own = own_principals()") > 0 && create.indexOf("let own = own_principals()") < create.indexOf("CreateWindowStationW("), "the own principals are read before anything is made");
  // the check is an allow list: anything that is not the container, a fixed trusted principal or the launcher's own is refused (no logon-session wildcard)
  assert.match(pure, /const ALWAYS_TRUSTED: \[&str; 3\] = \["S-1-5-18", "S-1-5-32-544", "S-1-3-4"\];/);
  assert.ok(!/is_logon_sid|S-1-5-5-/.test(pure), "no logon-session SID is accepted");
  assert.match(pure, /if e\[1\] != 0 \|\| u32::from_le_bytes/, "the container's entry carries no flags at all");
  assert.match(pure, /return Err\(format!\("\{text\} holds an allow entry \(only the container/);
  assert.match(priv, /impl Drop for StationSwitch \{ fn drop\(&mut self\) \{ self\.restore\(\); \} \}/);
  assert.match(priv, /if !restored \{ return Err\(trouble\("launcher could not switch back/);
  assert.ok(priv.indexOf("let restored = back.restore();") < priv.indexOf("p.check(hd, &sid_b"), "back on its own station before anything else is done");
  // objects are closed desktop first, then the station
  assert.ok(priv.indexOf("CloseDesktop(self.desktop") < priv.indexOf("CloseWindowStation(self.station"));
  // only an AppContainer profile's SID is ever given an entry
  assert.match(priv, /if !winobj::is_profile_sid\(&text\)/);
});

test("`info` and `check` report whether a private window station can be made (info fails with stage grant when it cannot); the fields are the ones the parser reads", () => {
  const w = code(win);
  const info = between(w, '"info" => {', '"run" => run(&a, j)');
  assert.match(info, /if private_wanted\(&a\) \{ if let Err\(e\) = report_private_station\(&mut j, sid\.0\)/, "the shared-name path (experiment build) is as it was");
  assert.match(info, /finish_main\(fail\(j, "grant", &e\)\)/);
  assert.match(info, /let station = if private_wanted\(&a\) \{ report_private_station\(&mut j, sid\.0\) \} else \{ Ok\(\(\)\) \};\s*life\.finish\(&mut j, true\);\s*match station \{ Err\(e\) => fail\(j, "grant", &e\)/, "the per-run info asks, deletes its profile either way, then fails with stage grant when it could not");
  const check = between(w, '"check" => {', "other => fail(j");
  assert.match(check, /if private_wanted\(&a\) && !profile::is_run_name\(&a\.name\) \{ let _ = report_private_station\(&mut j, sid\.0\); \}/, "check reports it (for the experiment's shared name only: a per-run check derives a SID and makes nothing) and does not fail on it");
  const report = between(w, "fn report_private_station", "fn run(");
  assert.match(report, /if p\.close\(\) \{ j\.b\("windowStationOk", true\); return Ok\(\(\)\); \}/, "ok only when the objects were also closed");
  for (const k of ["windowStationOk", "windowStationError"]) assert.ok(report.includes(`"${k}"`), k);
  assert.ok(/j\.s\("windowStation", "private"\)/.test(w), "the product names the mode");
  const ok = parseLauncherLine(JSON.stringify({ tool: "nn-appc-launcher", ok: true, windowStation: "private", windowStationOk: true }));
  assert.deepEqual([ok?.windowStation, ok?.windowStationOk, ok?.windowStationError], ["private", true, undefined]);
  const bad = parseLauncherLine(JSON.stringify({ tool: "nn-appc-launcher", ok: false, stage: "grant", windowStation: "private", windowStationOk: false, windowStationError: "window objects: x (error 5)" }));
  assert.deepEqual([bad?.windowStationOk, bad?.windowStationError], [false, "window objects: x (error 5)"]);
  // an older launcher line (no such fields) and wrong types are tolerated, not errors
  const old = parseLauncherLine(JSON.stringify({ tool: "nn-appc-launcher", ok: true }));
  assert.deepEqual([old?.windowStation, old?.windowStationOk, old?.windowStationError], [undefined, undefined, undefined]);
  const odd = parseLauncherLine(JSON.stringify({ tool: "nn-appc-launcher", ok: true, windowStation: 1, windowStationOk: "yes", windowStationError: false }));
  assert.deepEqual([odd?.windowStation, odd?.windowStationOk, odd?.windowStationError], [undefined, undefined, undefined]);
});

// ---------------------------------------------------------------------------------------------------------------- per-run container profiles

const profileRs = crate("src/profile.rs");

test("per-run profiles: the name the backend makes is exactly the name the product launcher accepts, and the record the launcher writes is the one the backend reads", () => {
  const plan = here("windows-native-plan.js");
  assert.match(profileRs, /pub\(crate\) const RUN_PREFIX: &str = "NimbleNewtRun-";/);
  assert.match(profileRs, /pub\(crate\) const RUN_HEX_LEN: usize = 16;/);
  assert.match(plan, /export const RUN_PROFILE_PREFIX = "NimbleNewtRun-";/);
  assert.match(plan, /export const RUN_PROFILE_PATTERN = \/\^NimbleNewtRun-\[0-9a-f\]\{16\}\$\/;/);
  assert.match(profileRs, /const RECORD_TAG: &str = "nn-run-profile v1";/);
  assert.ok(here("windows-native-job.js").includes("nn-run-profile v1"), "the backend reads the same tag");
  // the names the crate's own unit tests accept are accepted by the backend's check, and the near misses are refused by both
  assert.equal(isRunProfileName("NimbleNewtRun-0123456789abcdef"), true);
  for (const bad of ["NimbleNewtAgent", "NimbleNewtRun-0123456789ABCDEF", "NimbleNewtRun-0123456789abcde", "NimbleNewtRun-0123456789abcdef0", "NimbleNewtRun-0123456789abcdef\n", ""]) assert.equal(isRunProfileName(bad), false, bad);
  assert.equal(RUN_PROFILE_PREFIX.length + 16 <= 64, true, "inside CreateAppContainerProfile's 64 characters");
  // the product refuses every other name, and has no default name
  assert.match(args, /if !EXPERIMENT && !profile::is_run_name\(&a\.name\) \{ return Err\(/);
  assert.match(args, /name: if EXPERIMENT \{ "NimbleNewtExperiment"\.into\(\) \} else \{ String::new\(\) \}/);
});

test("per-run profiles: the launcher writes its record BEFORE it makes the profile, never adopts an existing one, deletes only with proof, and check and revoke make nothing", () => {
  const w = code(win);
  const begin = between(w, "fn begin(name: &str, record: &str)", "fn finish(&self");
  const rec = "profile::create_whole(record, &profile::format_record(name, &text))?;";
  assert.ok(begin.indexOf(rec) > 0 && begin.indexOf(rec) < begin.indexOf("CreateAppContainerProfile("), "record first (whole, create-new), then the profile");
  assert.ok(begin.indexOf("derived_sid(name)") < begin.indexOf(rec), "the SID is derived (and so written into the record) before the profile exists");
  assert.ok(!begin.includes("write_all("), "no plain write of the record: a launcher killed mid-write would leave a half-written record that stops every run");
  // the record is made whole: a temporary file of its own (create-new, flushed), hard-linked to the name (fails when the name exists), the temporary name removed on every path
  const whole = between(profileRs, "pub(crate) fn create_whole(", "pub(crate) fn parse_record(");
  assert.ok(whole.indexOf("create_new(true)") > 0 && whole.indexOf("sync_all()") > whole.indexOf("create_new(true)") && whole.indexOf("std::fs::hard_link(&temp, path)") > whole.indexOf("sync_all()"), "temporary file, flushed, then linked");
  assert.ok(whole.indexOf("let _ = std::fs::remove_file(&temp);") > whole.indexOf("hard_link"), "the temporary name goes on every path");
  assert.match(begin, /HR_ALREADY_EXISTS \{ "a profile with this name already exists: it is not adopted"/);
  assert.equal(w.match(/CreateAppContainerProfile\(/g)!.length, 2, "only the shared-name container_sid (experiment) and the per-run begin make a profile");
  // the delete call is in one place for the product, behind the proof; the experiment's own arm is the only other
  const arm = between(w, '"delete-profile" => {', 'other => fail(j, "arguments"');
  assert.ok(arm.indexOf("profile::may_delete(") > 0 && arm.indexOf("profile::may_delete(") < arm.indexOf("delete_profile_verified("), "the proof comes first");
  assert.match(arm, /Err\(e\) => fail\(j, "profile", &e\)/, "an unproven profile is refused with the stage `profile`");
  assert.equal(w.match(/DeleteAppContainerProfile\(/g)!.length, 3, "two calls in delete_profile_verified, one in the experiment's arm, none anywhere else");
  assert.ok(between(w, "fn delete_profile_verified(", "fn report_ended").match(/DeleteAppContainerProfile\(/g)!.length === 2, "the call and its one repeat");
  // run and info delete only through the guard that knows it made the profile, and run only when every grant is revoked
  assert.match(w, /fn finish\(&self, j: &mut Json, grants_gone: bool\) \{\n\s*if grants_gone \{ report_ended\(j, &delete_profile_verified\(&self\.name, &self\.sid_text\)\); \}/);
  assert.match(w, /life\.finish\(&mut outcome\.j, grants_gone\);/);
  assert.match(w, /let all = grants\.items\.iter\(\)\.all\(\|g\| !g\.applied \|\| g\.revoked\);/);
  // check and revoke derive the SID and never create a profile
  const sidFor = between(w, "fn sid_for_entries(", "struct Ended {");
  assert.ok(sidFor.includes("derived_sid(&a.name)") && !sidFor.includes("CreateAppContainerProfile"), "derive only for a per-run name");
  for (const [from, to] of [['"revoke" => {', '"grant" => {'], ['"check" => {', '"dump" => {']] as const) {
    const part = between(w, from, to);
    assert.ok(part.includes("sid_for_entries(&a)") && !part.includes("container_sid("), `${from} derives the SID`);
  }
  // the wording of the typed stage the backend maps
  assert.match(here("windows-native-plan.js"), /profile: "profile" \}/);
});

test("per-run profiles: every DACL write the launcher makes is under one machine-wide lock, and the lock is released on every path", () => {
  const w = code(win);
  const change = between(w, "fn change_ace(path: &str", "struct GrantRecord");
  assert.ok(/^fn change_ace\(path: &str, sid: PSID, mode: Mode, revoke: bool\) -> Result<\(\), u32> \{\n\s*let _lock = AclLock::take\(\)\?;/.test(change), "taken first, held (a guard) until the function returns");
  assert.match(w, /impl Drop for AclLock \{ fn drop\(&mut self\) \{ unsafe \{ ReleaseMutex\(self\.0\); CloseHandle\(self\.0\); \} \} \}/);
  assert.match(w, /CreateMutexW\(null\(\), 0, wide\(ACL_LOCK_NAME\)\.as_ptr\(\)\)/, "one fixed name");
  // Without a prefix the name would be per Terminal Services session (a signed-in launcher and the worker's session-0 launcher would hold two different locks): the global namespace, explicitly.
  assert.ok(w.includes('pub(crate) const ACL_LOCK_NAME: &str = "Global\\\\NimbleNewtAclWrite";'), "the Global\\ prefix");
  assert.equal(w.match(/CreateMutexW\(/g)!.length, 1, "one named mutex, the lock");
  // every path of the take: no handle (nothing to close), taken (also when ABANDONED: each DACL write is one SetNamedSecurityInfo call, nothing is left half done), or a timeout or failure that
  // closes the handle before it reports; the wait is bounded (two minutes, then the grant or revoke fails closed)
  const take = between(w, "fn take() -> Result<AclLock, u32> {", "impl Drop for AclLock");
  assert.match(take, /if h\.is_null\(\) \{ return Err\(GetLastError\(\)\); \}/);
  assert.match(take, /match WaitForSingleObject\(h, 120_000\) \{/);
  assert.match(take, /WAIT_OBJECT_0 \| WAIT_ABANDONED => Ok\(AclLock\(h\)\),/, "an abandoned lock is taken (WAIT_ABANDONED means this thread now owns it)");
  assert.match(take, /other => \{ let e = if other == WAIT_TIMEOUT \{ WAIT_TIMEOUT \} else \{ GetLastError\(\) \}; CloseHandle\(h\); Err\(e\) \}/, "the handle is closed on the paths that do not take the lock");
  assert.equal(w.match(/SetNamedSecurityInfoW\(/g)!.length, 3, "the three DACL writers are all inside change_ace's callees (remove_explicit, layered_acl, the grant itself)");
});
