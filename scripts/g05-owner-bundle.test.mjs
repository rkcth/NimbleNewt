// Card A03b, the G05 owner bundle: the layout script (g05-owner-bundle.mjs), `containment-evidence.mjs run --prebuilt` run from a real bundle outside any git checkout, and the safety lines of
// experiments/windows-appcontainer/owner/run-g05.ps1 (read as text here; Windows PowerShell 5.1 parses it in the experiment workflow), so a later edit cannot silently drop a guard or add a change to the machine.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { BUNDLE_SCRIPTS, listFiles, makeBundle } from "./g05-owner-bundle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ps1Path = join(root, "experiments", "windows-appcontainer", "owner", "run-g05.ps1");
const ps1 = readFileSync(ps1Path, "utf8");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const COMMIT = "c".repeat(40);
const work = mkdtempSync(join(tmpdir(), "nn-g05b-"));
const inputs = join(work, "in");
mkdirSync(inputs);
writeFileSync(join(inputs, "nn-launcher.exe"), "a launcher stand-in");
writeFileSync(join(inputs, "nn-launcher.record.json"), "{}\n");
const nodeHash = sha(readFileSync(process.execPath));
const args = (out, extra = {}) => ({ out, launcher: join(inputs, "nn-launcher.exe"), record: join(inputs, "nn-launcher.record.json"), node: process.execPath, nodeSha256: nodeHash, commit: COMMIT, ...extra });
let bundle;
before(() => { bundle = join(work, "bundle"); makeBundle(args(bundle)); });
after(() => rmSync(work, { recursive: true, force: true }));

// ------------------------------------------------------------------------------------------------ the layout

test("the bundle holds exactly the documented layout, with no test files, no build info, a real contracts copy and no link", () => {
  const files = listFiles(bundle);
  for (const f of ["bin/nn-launcher.exe", "bin/nn-launcher.record.json", "node/node.exe", "packages/worker/package.json", "packages/worker/dist/index.js", "packages/contracts/package.json", "packages/contracts/dist/index.js",
    "node_modules/@nimblenewt/contracts/package.json", "node_modules/@nimblenewt/contracts/dist/index.js", "scripts/containment-evidence.mjs", "scripts/offline-guard.mjs", "scripts/redact-log.mjs", "COMMIT", "run-g05.ps1", "SHA256SUMS"]) assert.ok(files.includes(f), f);
  const top = new Set(files.map((f) => f.split("/")[0]));
  assert.deepEqual([...top].sort(), ["COMMIT", "SHA256SUMS", "bin", "node", "node_modules", "packages", "run-g05.ps1", "scripts"]);
  assert.deepEqual(readdirSync(join(bundle, "scripts")).sort(), [...BUNDLE_SCRIPTS].sort());
  assert.ok(!files.some((f) => /\.test\.|tsbuildinfo/.test(f)), "no test file or build info");
  assert.ok(!lstatSync(join(bundle, "node_modules", "@nimblenewt", "contracts")).isSymbolicLink(), "a real copy, not a link");
  assert.equal(readFileSync(join(bundle, "COMMIT"), "latin1"), COMMIT);
  assert.equal(readFileSync(join(bundle, "run-g05.ps1"), "utf8"), ps1);
  assert.equal(sha(readFileSync(join(bundle, "node", "node.exe"))), nodeHash);
});

test("SHA256SUMS lists every other file once with its hash, in the exact line form run-g05.ps1 accepts", () => {
  const lineRule = /\$line -cnotmatch '([^']+)'/.exec(ps1);
  assert.ok(lineRule, "run-g05.ps1 has its line rule");
  const rule = new RegExp(lineRule[1]);
  const text = readFileSync(join(bundle, "SHA256SUMS"), "utf8");
  assert.ok(text.endsWith("\n") && !text.includes("\r"));
  const lines = text.trimEnd().split("\n");
  const listed = lines.map((l) => { const m = rule.exec(l); assert.ok(m, l); assert.equal(sha(readFileSync(join(bundle, ...m[2].split("/")))), m[1], m[2]); return m[2]; });
  assert.deepEqual(listed, listFiles(bundle).filter((f) => f !== "SHA256SUMS"), "every file but SHA256SUMS, once, sorted");
  assert.equal(new Set(listed.map((f) => f.toLowerCase())).size, listed.length, "no two names differ only in case (Windows)");
});

test("make refuses a wrong or missing node hash, a malformed commit, an existing folder and a link in what it copies; a refused bundle leaves nothing", () => {
  const out = join(work, "refused");
  assert.throws(() => makeBundle(args(out, { nodeSha256: "0".repeat(64) })), /not the official/);
  assert.ok(!existsSync(out));
  for (const nodeSha256 of [undefined, "", "PLACEHOLDER", nodeHash.toUpperCase(), nodeHash.slice(1)]) assert.throws(() => makeBundle(args(out, { nodeSha256 })), /--node-sha256/, String(nodeSha256));
  for (const commit of [undefined, "HEAD", COMMIT.toUpperCase(), `${COMMIT}0`]) assert.throws(() => makeBundle(args(out, { commit })), /--commit/, String(commit));
  assert.ok(!existsSync(out));
  mkdirSync(out); writeFileSync(join(out, "keep"), "x");
  assert.throws(() => makeBundle(args(out)), /EEXIST/);
  assert.deepEqual(readdirSync(out), ["keep"], "an existing folder is not touched");
  // a fake repository whose worker dist holds a link
  const repo = join(work, "repo");
  for (const p of ["worker", "contracts"]) { mkdirSync(join(repo, "packages", p, "dist"), { recursive: true }); writeFileSync(join(repo, "packages", p, "package.json"), "{}"); writeFileSync(join(repo, "packages", p, "dist", "index.js"), ""); }
  mkdirSync(join(repo, "scripts")); for (const s of BUNDLE_SCRIPTS) writeFileSync(join(repo, "scripts", s), "");
  symlinkSync(join(inputs, "nn-launcher.exe"), join(repo, "packages", "worker", "dist", "linked.js"));
  const out2 = join(work, "refused-link");
  assert.throws(() => makeBundle({ ...args(out2), repo, script: ps1Path }), /a link/);
  assert.ok(!existsSync(out2), "removed again");
  rmSync(join(repo, "packages", "worker", "dist", "linked.js"));
  assert.equal(makeBundle({ ...args(out2), repo, script: ps1Path }).files > 5, true, "the same fake repository without the link is accepted");
  // the shipped copy of node.exe is hashed again after the copy (a file changed between the first check and the copy is never bundled)
  const src = readFileSync(join(root, "scripts", "g05-owner-bundle.mjs"), "utf8");
  assert.ok(/copyFile\(node, join\(out, "node", "node\.exe"\)\);\n[^\n]*\n\s+const copied = sha256\(join\(out, "node", "node\.exe"\)\);\n\s+if \(copied !== nodeSha256\) throw/.test(src));
});

test("the command line: usage errors exit 2, a failure exits 1 with no bundle, success prints the SHA-256 of SHA256SUMS", () => {
  const cli = join(root, "scripts", "g05-owner-bundle.mjs");
  const run = (...a) => spawnSync(process.execPath, [cli, ...a], { encoding: "utf8" });
  assert.equal(run().status, 2);
  assert.equal(run("make", "--out", join(work, "x")).status, 2);
  const flags = (out, h) => ["make", "--out", out, "--launcher", join(inputs, "nn-launcher.exe"), "--record", join(inputs, "nn-launcher.record.json"), "--node", process.execPath, "--node-sha256", h, "--commit", COMMIT];
  const bad = run(...flags(join(work, "cli-bad"), "1".repeat(64)));
  assert.equal(bad.status, 1); assert.match(bad.stderr, /no bundle: node\.exe has SHA-256/); assert.ok(!existsSync(join(work, "cli-bad")));
  const good = run(...flags(join(work, "cli-good"), nodeHash));
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, new RegExp(`sums_sha256=${sha(readFileSync(join(work, "cli-good", "SHA256SUMS")))}`));
});

// ------------------------------------------------------------------------------------------------ containment-evidence.mjs run --prebuilt

const evidence = (dir, ...a) => spawnSync(process.execPath, ["--import", join(root, "scripts", "offline-guard.mjs").replace(/^/, "file://"), join(dir, "scripts", "containment-evidence.mjs"), ...a], { encoding: "utf8", cwd: dir, timeout: 600_000 });

test("--prebuilt: a missing or malformed COMMIT exits 2 before anything runs; without --prebuilt the bundle would try to build (so --prebuilt is what skips tsc)", () => {
  const b = join(work, "commit-checks");
  makeBundle(args(b));
  const commitFile = join(b, "COMMIT");
  for (const text of [undefined, "", "HEAD", COMMIT.toUpperCase(), COMMIT.slice(1), `${COMMIT}0`, ` ${COMMIT}`, `${COMMIT}\n\n`, `${COMMIT} `]) {
    if (text === undefined) rmSync(commitFile, { force: true }); else writeFileSync(commitFile, text);
    const r = evidence(b, "run", "--prebuilt", "--out", join(b, "results"));
    assert.equal(r.status, 2, JSON.stringify(text) + r.stderr);
    assert.match(r.stderr, /--prebuilt: the COMMIT file/);
    assert.ok(!/build failed/.test(r.stderr + r.stdout), "no build attempted");
    assert.ok(!existsSync(join(b, "results")), "nothing written");
  }
  // one trailing line break is allowed (an editor or another tool may add it)
  for (const text of [`${COMMIT}\n`, `${COMMIT}\r\n`]) {
    writeFileSync(commitFile, text);
    const r = evidence(b, "run", "--prebuilt");
    assert.equal(r.status, 2); assert.match(r.stderr, /^usage: run --out DIR \[--prebuilt\]/m, "past the COMMIT check: the missing --out is what stops it");
  }
  // the same bundle without --prebuilt: tsc is not in the bundle, so the build step fails (exit 1): the flag is what skips it
  const plain = evidence(b, "run", "--out", join(b, "results"));
  assert.equal(plain.status, 1);
  assert.match(plain.stderr, /the build failed/);
});

test("--prebuilt from a real bundle outside any git checkout: the report carries the COMMIT file's commit and dirty false (git is never run)", { timeout: 600_000 }, (t) => {
  const b = join(work, "full");
  makeBundle(args(b));
  assert.equal(spawnSync("git", ["-C", b, "rev-parse", "HEAD"], { encoding: "utf8" }).status === 0, false, "the bundle is not inside a git checkout");
  const out = join(b, "results");
  const r = evidence(b, "run", "--prebuilt", "--out", out, "--redact");
  const file = join(out, `containment-${process.platform}.json`);
  if (!existsSync(file)) return assert.fail(`no report: exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  const report = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(report.implementationCommit, COMMIT);
  assert.equal(report.dirty, false);
  assert.match(r.stdout, new RegExp(`commit ${COMMIT.slice(0, 12)}:`));
  assert.ok(!r.stdout.includes("DIRTY"));
  if (process.platform === "linux" && process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1") assert.equal(r.status, 0, r.stdout + r.stderr);
  else if (r.status !== 0) t.diagnostic(`exit ${r.status} here (no sandbox capacity is a result, not this test's question)`);
});

// ------------------------------------------------------------------------------------------------ run-g05.ps1 safety lines

const code = ps1.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join("\n");
const at = (needle) => { const i = code.indexOf(needle); assert.ok(i >= 0, needle); return i; };

test("run-g05.ps1 is plain ASCII, Windows PowerShell 5.1 compatible in the ways a text check can see, and has no -Hold or -AfterSignIn yet", () => {
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(ps1), "ASCII only (Windows PowerShell 5.1 reads a file without a BOM as the ANSI code page)");
  assert.match(code, /\[CmdletBinding\(\)\]\nparam\(\)/);
  for (const seven of ["??", "?.", "-Parallel", "ForEach-Object -Parallel", "&&", "||", "[System.IO.Path]::GetRelativePath", "Join-Path -AdditionalChildPath", "ConvertFrom-Json -AsHashtable", "Get-FileHash"]) assert.ok(!code.includes(seven), `not in Windows PowerShell 5.1 (or not wanted): ${seven}`);
  assert.ok(!/-Hold\b|-AfterSignIn\b|\$Hold\b|\$AfterSignIn\b/.test(code), "the hold and sign-out step is a later slice");
});

test("run-g05.ps1 refuses to run elevated, first, by the Administrators role", () => {
  const role = at("$principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)");
  // the exit is inside the role check's own block, not some later check's
  const block = /if \(\$principal\.IsInRole\(\[System\.Security\.Principal\.WindowsBuiltInRole\]::Administrator\)\) \{([^{}]*)\}/.exec(code);
  assert.ok(block && /Write-Host 'REFUSED: [^']*elevated/.test(block[1]) && /\n\s*exit 2\s*$/.test(block[1]), "the role check refuses and exits 2 in its own block");
  const refuse = block.index + block[0].length;
  assert.ok(block.index === role - 4, "the block is the role check found above");
  for (const later of ["Test-Bundle\n", "whoami.exe", "Invoke-Captured $launcher", "Invoke-Captured $node", "New-Item"]) assert.ok(at(later) > refuse, `${later} comes after the elevation refusal`);
});

test("run-g05.ps1 checks every line of SHA256SUMS and every file of the folder before it runs anything, and fails closed", () => {
  const fn = code.slice(at("function Test-Bundle {"), at("$check = Test-Bundle"));
  for (const piece of ["SHA256SUMS is missing", "[System.IO.File]::ReadAllLines($sums)", "missing: $rel", "changed (SHA-256 differs): $rel", "extra file not in SHA256SUMS: $rel", "a link or junction: $rel", "names $rel twice", "Get-Sha256Hex $full) -cne $hash", "SHA256SUMS lists no file", "ReparsePoint"]) assert.ok(fn.includes(piece), piece);
  assert.ok(fn.includes("'..'") && fn.includes("^(control|results)/"), "no path outside the folder, nothing in the folders the script writes");
  const check = at("$check = Test-Bundle");
  const stop = code.slice(check, at("bundle check: every file matches"));
  assert.match(stop, /if \(\$check\.Count -gt 0\) \{[\s\S]*REFUSED[\s\S]*exit 2\s*\}/);
  for (const later of ["whoami.exe", "Invoke-Captured $launcher", "Invoke-Captured $node", "$env:NIMBLENEWT_WIN_LAUNCHER ="]) assert.ok(at(later) > check, `${later} only after the check`);
  assert.match(code, /System\.Security\.Cryptography\.SHA256\]::Create\(\)/);
});

test("run-g05.ps1 runs the launcher's info and the ten cases exactly as the brief says, with output only in control\\raw and redacted copies in results", () => {
  assert.ok(code.includes("whoami.exe\" /priv") && code.includes("SeCreateSymbolicLinkPrivilege") && /may be reported inconclusive\. That is expected and fine\./.test(code));
  assert.ok(code.includes('$env:NIMBLENEWT_WIN_LAUNCHER = "$b\\bin\\nn-launcher.exe"') && code.includes('$env:NIMBLENEWT_WIN_CONTROL_DIR = "$b\\control"'));
  assert.ok(code.includes("'NimbleNewtRun-' + (($rb | ForEach-Object { $_.ToString('x2') }) -join '')") && code.includes("New-Object byte[] 8") && code.includes("RNGCryptoServiceProvider"), "16 random lower-case hex digits");
  assert.ok(code.includes("Invoke-Captured $launcher @('info', '--name', $infoName, '--profile-record', $infoRecord)") && code.includes("$infoRecord = Join-Path $infoDir \"$infoName.sid\"") && code.includes("$infoDir = Join-Path $control 'info'"));
  assert.ok(code.includes("Invoke-Captured $node @('--import', './scripts/offline-guard.mjs', 'scripts\\containment-evidence.mjs', 'run', '--prebuilt', '--out', $results, '--redact')"));
  assert.ok(code.includes("$raw = Join-Path $control 'raw'"));
  assert.ok(/Invoke-Captured \$node @\('scripts\\redact-log\.mjs'\) \(Join-Path \$results \$name\) \(Join-Path \$raw "redact-\$name"\) \$src/.test(code), "results get the redacted copy");
  // the captured output never reaches the console
  const inv = code.slice(at("function Invoke-Captured"), at("function Get-Field"));
  assert.ok(inv.includes("RedirectStandardOutput = $true") && inv.includes("RedirectStandardError = $true") && !/Write-(Host|Output)/.test(inv));
  assert.ok(!/Write-Host[^\n]*\$(text|o\.Result|e\.Result)\b/.test(code), "never prints raw text");
});

test("run-g05.ps1 refuses to zip when results hold a personal name, path, SID or address, naming the kind of text only", () => {
  const scan = code.slice(at("$patterns = New-Object"), at("$found = New-Object"));
  for (const piece of ["$env:USERNAME", "$env:COMPUTERNAME", "$env:USERDOMAIN", "GetHostName()", "$env:USERPROFILE", "$env:LOCALAPPDATA", "$env:TEMP", "'an IPv4 address'", "'an IPv6 address'", "'a MAC address'"]) assert.ok(scan.includes(piece), piece);
  const decide = code.slice(at("$found = New-Object"), at("CreateFromDirectory"));
  assert.match(decide, /if \(\$found\.Count -gt 0\) \{[\s\S]*REFUSED to make the zip[\s\S]*\} elseif \(\$zipBlocked\) \{[\s\S]*\} else \{/);
  assert.ok(code.indexOf("CreateFromDirectory") > code.indexOf("} else {", at("$found = New-Object")), "the zip only on the clean branch");
  assert.ok(/\$found\.Add\("\$rel contains \$\(\$p\[0\]\)"\)/.test(code), "the label, never the matched text");
  assert.ok(code.includes("if ($p[1].IsMatch($text) -or $p[1].IsMatch($rel))"), "a file's name inside the zip is checked as well as its text");
  assert.ok(!/\.Match\(|\$Matches\[0\]/.test(code.slice(at("$found = New-Object"), at("CreateFromDirectory"))), "the matching text is not taken out");
  // the patterns, as .NET reads them (IgnoreCase), tried on what the redaction leaves and on what it should have replaced
  const pat = (label) => { const m = new RegExp(`Add-Pattern '${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}' '([^']+)'`).exec(code); assert.ok(m, label); return new RegExp(m[1], "i"); };
  const users = pat("a ...\\Users\\ path");
  for (const t of ["C:\\Users\\rob\\x", "C:/Users/rob", "\"C:\\\\Users\\\\rob\"", "d:\\users\\x"]) assert.ok(users.test(t), t);
  assert.ok(!users.test("<home>\\AppData") && !users.test("ABC:\\Users\\"));
  const sid = pat("an account SID (S-1-5-21-...)");
  assert.ok(sid.test("S-1-5-21-1004336348-1177238915-682003330-1001") && !sid.test("S-1-5-21-<domain>-<account>") && !sid.test("S-1-5-21-<domain>-500"), "an unredacted account SID only, not the redaction's placeholder form");
  const aad = pat("an Azure AD account SID (S-1-12-1-...)");
  assert.ok(aad.test("S-1-12-1-111-222-333-444") && !aad.test("S-1-12-1-<account>"));
  assert.ok(!scan.includes("'S-1-15-2-'"), "per-run container SIDs (from the random profile name) are kept by the redaction on purpose and do not block the zip");
  const v6 = pat("an IPv6 address");
  for (const t of ["fe80::1c2b:3d4e:5f60:7a8b", "2001:db8:0:0:0:0:2:1", "2001:db8::2:1"]) assert.ok(v6.test(t), t);
  for (const t of ["2026-11-26T10:20:30.123Z", "[::1]:8080", "<ip>", "sha 3fb3cefad590cd3f4b32", "12:34:56"]) assert.ok(!v6.test(t), t);
  // the path patterns accept any run of separators (the JSON form of a path doubles each backslash)
  assert.ok(code.includes("function ConvertTo-PathPattern([string] $p) { return ((@($p -split '[\\\\/]+') | Where-Object { $_ -ne '' } | ForEach-Object { [regex]::Escape($_) }) -join '[\\\\/]+') }"));
  // the IPv4 pattern is the redaction's own (windows-redact.ts), so what redaction replaced is not refused again, and what it missed is
  const redact = readFileSync(join(root, "packages", "worker", "src", "sandbox", "windows-redact.ts"), "utf8");
  const ip = /Add-Pattern 'an IPv4 address' '([^']+)'/.exec(code)[1];
  assert.ok(redact.includes(`out.replace(/${ip}/g, "<ip>")`), "the same IPv4 shape as the redaction");
  const re = new RegExp(ip, "i");
  assert.ok(re.test("addr 192.168.1.20 x") && !re.test("node 10.0.26200.1 v22.19.0 127.0.0.1"));
  const mac = new RegExp(/Add-Pattern 'a MAC address' '([^']+)'/.exec(code)[1], "i");
  assert.ok(mac.test("00-1A-2b-3C-4d-5E") && mac.test("00:1a:2b:3c:4d:5e") && !mac.test("00-1a:2b-3c-4d-5e") && !mac.test("sha 3fb3cefad590cd3f4b32"));
});

test("run-g05.ps1 writes the zip with ZipFile to the Desktop (Downloads when there is none) and prints the tally; a failure prints the clean-up commands", () => {
  assert.ok(code.includes("Add-Type -AssemblyName System.IO.Compression.FileSystem") && code.includes("[System.IO.Compression.ZipFile]::CreateFromDirectory($results, $zip)"));
  assert.ok(code.includes("$dest = [System.Environment]::GetFolderPath('Desktop')") && code.includes("$dest = Join-Path $env:USERPROFILE 'Downloads'") && code.includes("Join-Path $dest 'nn-g05-results.zip'"), "the Desktop Explorer shows (a OneDrive-moved one too), else Downloads");
  // an older zip is removed BEFORE the personal-data check, so a refused run never leaves an older zip that looks like its own
  assert.ok(at("[System.IO.File]::Delete($zip)") < at("$found = New-Object") && at("[System.IO.File]::Delete($zip)") > at("$zip = Join-Path $dest 'nn-g05-results.zip'"));
  assert.ok(code.includes('Write-Host "$hold/$total cases hold, $inconclusive inconclusive"'));
  assert.ok(code.includes("(Get-Field $_ 'verdict') -eq 'pass'") && code.includes("(Get-Field $_ 'verdict') -eq 'inconclusive'"));
  const clean = code.slice(at("function Show-Cleanup {"), code.indexOf("\n}\n", at("function Show-Cleanup {")));
  assert.ok(clean.includes("& '$launcherQ' delete-profile --name $pname --sid $psid --profile-record '$($rec -replace \"'\", \"''\")'") && clean.includes("$launcherQ = $launcher -replace \"'\", \"''\"") && clean.includes("Get-ChildItem $env:LOCALAPPDATA\\Packages -Filter NimbleNewtRun-*"), "the printed command is pasteable for a path with an apostrophe");
  // a confined write that got through to a system folder is checked for afterwards and named, with its clean-up
  assert.ok(code.includes("$script:systemLeft = @(@((Join-Path $env:SystemRoot 'g05-x'), (Join-Path $env:SystemRoot 'System32\\g05-x'), 'C:\\g05-x', 'C:\\Program Files\\g05-x') | Where-Object { Test-Path -LiteralPath $_ })"));
  assert.ok(/if \(\$script:systemLeft\.Count -gt 0\) \{ Add-Problem/.test(code) && clean.includes("foreach ($x in $script:systemLeft)"));
  assert.ok(/if \(\$script:problems\.Count -gt 0\) \{\n\s+Show-Cleanup[\s\S]*exit 1\n\}/.test(code), "every failure ends with the clean-up text and exit 1");
  assert.ok(code.includes("Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'Packages') -Directory -Filter 'NimbleNewtRun-*'"), "the leftover-profile check runs");
});

test("run-g05.ps1 writes only into plain folders (a link or junction at control, raw, info, profiles or results is refused), deletes without following links, and clears node's environment options", () => {
  const kinds = code.slice(at("function Get-EntryKind"), at("New-Item -ItemType Directory"));
  assert.ok(kinds.includes("[System.IO.FileAttributes]::ReparsePoint) -ne 0) { return 'link' }"));
  assert.ok(kinds.includes("foreach ($d in @($control, $raw, $infoDir, (Join-Path $control 'profiles'), $results))") && /if \(\$kind -eq 'link' -or \$kind -eq 'file'\) \{[^}]*REFUSED[^}]*exit 2/.test(kinds));
  assert.ok(kinds.includes("[System.IO.Directory]::Delete($d, $true)"));
  assert.ok(!/Remove-Item[^\n]*-Recurse/.test(code), "no Remove-Item -Recurse (Windows PowerShell 5.1 may follow a directory link)");
  assert.ok(at("foreach ($v in @('NODE_OPTIONS', 'NODE_PATH', 'NODE_PRESERVE_SYMLINKS', 'NODE_REPL_EXTERNAL_MODULE')) { [System.Environment]::SetEnvironmentVariable($v, $null, 'Process') }") < at("Invoke-Captured $launcher"));
  assert.ok(at("check = Test-Bundle") < at("function Get-EntryKind"), "after the bundle check");
});

test("run-g05.ps1 changes nothing on the machine: no Defender, policy, registry, firewall, service, task, account or download command", () => {
  const banned = [
    /Set-MpPreference/i, /Add-MpPreference/i, /Remove-MpPreference/i, /Set-ExecutionPolicy/i, /Unblock-File/i,
    /HKLM:|HKCU:|HKEY_|Registry::|\breg(\.exe)?\s+(add|delete|import)|New-ItemProperty|Set-ItemProperty|Remove-ItemProperty/i,
    /New-NetFirewallRule|Set-NetFirewall|netsh|CheckNetIsolation/i,
    /New-Service|Set-Service|Start-Service|Stop-Service|Restart-Service|\bsc(\.exe)?\s+(create|config|start|stop|delete)/i,
    /Register-ScheduledTask|schtasks/i, /New-LocalUser|Add-LocalGroupMember|net(\.exe)?\s+(user|localgroup)/i,
    /Invoke-WebRequest|\biwr\b|Invoke-RestMethod|\birm\b|\bcurl\b|\bwget\b|Start-BitsTransfer|Net\.WebClient|DownloadFile|DownloadString|HttpClient|bitsadmin/i,
    /Start-Process[^\n]*-Verb\s+RunAs/i, /Invoke-Expression|\biex\b/i, /Set-Acl|icacls|takeown/i,
  ];
  for (const b of banned) assert.ok(!b.test(code), `run-g05.ps1 must not contain ${b}`);
  // the only programs it starts: whoami, the bundle's launcher and the bundle's node
  const started = [...code.matchAll(/Invoke-Captured (\$\w+)/g)].map((m) => m[1]);
  assert.ok(started.length >= 3 && started.every((s) => s === "$launcher" || s === "$node"), started.join());
  assert.equal([...code.matchAll(/^\s*& /gm)].length + [...code.matchAll(/\(& /g)].length, 1, "one call operator: whoami");
  assert.ok(code.includes("$launcher = Join-Path $b 'bin\\nn-launcher.exe'") && code.includes("$node = Join-Path $b 'node\\node.exe'"));
});
