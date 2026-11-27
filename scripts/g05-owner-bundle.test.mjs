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
  // Card A03b: the native-evidence flags are checked before anything runs (a bad value, a fact without --native-info, the removed Windows Sandbox flags --windows-summary and --workdir-check, a flag without its value)
  for (const extra of [["--native-info", "f", "--account-kind", "admin"], ["--native-info", "f", "--symlink-right", "maybe"], ["--account-kind", "standard"], ["--symlink-right", "no"], ["--native-info", "f", "--windows-summary", "s"], ["--windows-summary", "s"], ["--workdir-check", "w"], ["--native-info"], ["--after-sign-out", "a"], ["--native-info", "f", "--after-sign-out"]]) {
    const r = evidence(b, "run", "--prebuilt", "--out", join(b, "results"), ...extra);
    assert.equal(r.status, 2, `${extra.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^usage: run --out DIR .*--native-info FILE \[--account-kind standard\|administrator-filtered\] \[--symlink-right yes\|no\]/m);
    assert.ok(!existsSync(join(b, "results")), "nothing written");
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

test("run-g05.ps1 is plain ASCII, Windows PowerShell 5.1 compatible in the ways a text check can see, and takes only the two sign-out check switches", () => {
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(ps1), "ASCII only (Windows PowerShell 5.1 reads a file without a BOM as the ANSI code page)");
  assert.match(code, /\[CmdletBinding\(\)\]\nparam\(\[switch\] \$Hold, \[switch\] \$AfterSignIn\)\n/);
  for (const seven of ["??", "?.", "-Parallel", "ForEach-Object -Parallel", "&&", "||", "[System.IO.Path]::GetRelativePath", "Join-Path -AdditionalChildPath", "ConvertFrom-Json -AsHashtable", "Get-FileHash"]) assert.ok(!code.includes(seven), `not in Windows PowerShell 5.1 (or not wanted): ${seven}`);
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

test("run-g05.ps1 (card A03b) hands the evidence run the account kind and the link right it measured, and nothing when whoami could not be read", () => {
  const fn = code.slice(at("function Get-WhoamiText"), at("$linkRight = $null"));
  assert.ok(fn.includes("if ($LASTEXITCODE -ne 0) { $t = $null }") && fn.includes("catch { $t = $null }") && fn.includes("$t.Trim() -eq ''"), "a failed or empty whoami is $null");
  const sec = code.slice(at("$linkRight = $null"), at("$launcher = Join-Path $b 'bin\\nn-launcher.exe'"));
  // link right: yes only when the privilege is named, no when whoami answered without it, nothing when it did not answer
  assert.match(sec, /if \(\$null -eq \$privText\) \{[^}]*not recorded[^}]*\} elseif \(\$privText -match 'SeCreateSymbolicLinkPrivilege'\) \{\s*\$linkRight = 'yes'[\s\S]*?\} else \{\s*\$linkRight = 'no'/);
  // account kind: the Administrators SID (language-independent, quoted CSV column) in a token already shown not elevated = an administrator in a filtered window; absent = standard
  assert.ok(sec.includes("$groupsText = Get-WhoamiText @('/groups', '/fo', 'csv', '/nh')"));
  assert.match(sec, /if \(\$null -eq \$groupsText\) \{[^}]*not recorded[^}]*\} elseif \(\$groupsText -match '"S-1-5-32-544"'\) \{\s*\$accountKind = 'administrator-filtered'[\s\S]*?\} else \{\s*\$accountKind = 'standard'/);
  assert.ok(at("$accountKind = $null") > at("$principal.IsInRole("), "the kind is read only after the elevation refusal");
  // only measured values are passed, as the two flags containment-evidence.mjs accepts
  const run = code.slice(at("$evidenceArgs = @("), at("$evidenceCode = Invoke-Captured"));
  assert.ok(run.includes("if ($null -ne $accountKind) { $evidenceArgs += @('--account-kind', $accountKind) }") && run.includes("if ($null -ne $linkRight) { $evidenceArgs += @('--symlink-right', $linkRight) }"));
  const flags = readFileSync(join(root, "scripts", "containment-evidence.mjs"), "utf8");
  assert.ok(flags.includes('accountKind !== "standard" && accountKind !== "administrator-filtered"') && flags.includes('symlinkRight !== "yes" && symlinkRight !== "no"'), "the script's words are the ones the evidence run accepts");
  // and the evidence run turns them into the block's inputs as they are (yes = holds the right); the collection itself is tested in containment-native-gate.test.ts
  assert.ok(flags.includes('...(accountKind === undefined ? {} : { accountKind }), ...(symlinkRight === undefined ? {} : { symlinkRight: symlinkRight === "yes" })'));
  assert.ok(flags.includes('report.platform !== "win32" || report.backend !== "windows-native"') && flags.includes('infoFile: resolve(nativeInfo), launcher: env["NIMBLENEWT_WIN_LAUNCHER"], controlDir: env["NIMBLENEWT_WIN_CONTROL_DIR"], packagesDir: join(env["LOCALAPPDATA"], "Packages"), since'));
});

test("run-g05.ps1 runs the launcher's info and the ten cases exactly as the brief says, with output only in control\\raw and redacted copies in results", () => {
  assert.ok(code.includes("(& \"$env:SystemRoot\\System32\\whoami.exe\" @whoamiArgs)") && code.includes("$privText = Get-WhoamiText @('/priv')") && code.includes("SeCreateSymbolicLinkPrivilege") && /may be reported inconclusive\. That is expected and fine\./.test(code));
  assert.ok(code.includes('$env:NIMBLENEWT_WIN_LAUNCHER = "$b\\bin\\nn-launcher.exe"') && code.includes('$env:NIMBLENEWT_WIN_CONTROL_DIR = "$b\\control"'));
  assert.ok(code.includes("'NimbleNewtRun-' + (($rb | ForEach-Object { $_.ToString('x2') }) -join '')") && code.includes("New-Object byte[] 8") && code.includes("RNGCryptoServiceProvider"), "16 random lower-case hex digits");
  assert.ok(code.includes("Invoke-Captured $launcher @('info', '--name', $infoName, '--profile-record', $infoRecord)") && code.includes("$infoRecord = Join-Path $infoDir \"$infoName.sid\"") && code.includes("$infoDir = Join-Path $control 'info'"));
  assert.ok(code.includes("$evidenceArgs = @('--import', './scripts/offline-guard.mjs', 'scripts\\containment-evidence.mjs', 'run', '--prebuilt', '--out', $results, '--redact', '--native-info', (Join-Path $raw 'info.stdout.txt'))"));
  assert.ok(code.includes("$evidenceCode = Invoke-Captured $node $evidenceArgs (Join-Path $raw 'evidence.stdout.txt') (Join-Path $raw 'evidence.stderr.txt') $null 25"));
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
  assert.ok(clean.includes("& $launcherQ delete-profile --name $pname --sid $psid --profile-record $(ConvertTo-Quoted $rec)") && clean.includes("$launcherQ = ConvertTo-Quoted $launcher") && clean.includes("Get-ChildItem $env:LOCALAPPDATA\\Packages -Filter NimbleNewtRun-*"), "the printed command is pasteable for a path with an apostrophe");
  // a confined write that got through to a system folder is checked for afterwards and named, with its clean-up
  assert.ok(code.includes("$script:systemLeft = @(@((Join-Path $env:SystemRoot 'g05-x'), (Join-Path $env:SystemRoot 'System32\\g05-x'), 'C:\\g05-x', 'C:\\Program Files\\g05-x') | Where-Object { Test-Path -LiteralPath $_ })"));
  assert.ok(/if \(\$script:systemLeft\.Count -gt 0\) \{ Add-Problem/.test(code) && clean.includes("foreach ($x in $script:systemLeft)"));
  assert.ok(/if \(\$script:problems\.Count -gt 0\) \{\n\s+Show-Cleanup[\s\S]*exit 1\n\}/.test(code), "every failure ends with the clean-up text and exit 1");
  assert.ok(code.includes("Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'Packages') -Directory -Filter 'NimbleNewtRun-*'"), "the leftover-profile check runs");
});

test("run-g05.ps1 writes only into plain folders (a link or junction at control, raw, info, profiles or results is refused), deletes without following links, and clears node's environment options", () => {
  const kinds = code.slice(at("function Get-EntryKind"), at("New-Item -ItemType Directory"));
  assert.ok(kinds.includes("[System.IO.FileAttributes]::ReparsePoint) -ne 0) { return 'link' }"));
  assert.ok(kinds.includes("foreach ($d in @($control, $raw, $infoDir, (Join-Path $control 'profiles'), $holdDir, $results))") && /if \(\$kind -eq 'link' -or \$kind -eq 'file'\) \{[^}]*REFUSED[^}]*exit 2/.test(kinds));
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

// ------------------------------------------------------------------------------------------------ second review: the personal-data check against what the redaction really leaves

/** The personal-data check of run-g05.ps1 (section 8) as JavaScript, line for line: the helper lines it ports are pinned in the script below, and the fixed patterns and the placeholder
 *  pattern are read from the script itself. `env` is the Windows environment of the run; `files` maps a name inside results\ to its text. Returns "<file> contains <kind>" findings. */
const PS_HELPERS = [
  "function Add-WordPattern([string] $label, [string] $word) { if ($word -and $word.Length -ge 2) { Add-Pattern $label ('(?<![A-Za-z0-9])' + [regex]::Escape($word) + '(?![A-Za-z0-9])') } }",
  "Add-WordPattern 'your account name (USERNAME)' $env:USERNAME",
  "Add-WordPattern 'the computer name (COMPUTERNAME)' $env:COMPUTERNAME",
  "if ($env:USERDOMAIN -ne $env:COMPUTERNAME) { Add-WordPattern 'the account domain name (USERDOMAIN)' $env:USERDOMAIN }",
  "if ($leaf -ne $env:USERNAME) { Add-WordPattern 'the name of your home folder' $leaf }",
  "$text = $placeholders.Replace([System.IO.File]::ReadAllText($f), ' ')",
  "$rel = $placeholders.Replace($f.Substring($b.Length + 1), ' ')",
  "foreach ($p in $patterns) { if ($p[1].IsMatch($text) -or $p[1].IsMatch($rel)) { $found.Add(\"$rel contains $($p[0])\") } }",
];
const esc = (s) => s.replace(/[\\*+?|{[()^$.#\s]/g, (c) => (c === " " ? "\\ " : `\\${c}`));
function psFindings(env, files) {
  const pats = [];
  const add = (label, re) => pats.push([label, new RegExp(re, "i")]);
  const word = (label, w) => { if (w && w.length >= 2) add(label, `(?<![A-Za-z0-9])${esc(w)}(?![A-Za-z0-9])`); };
  const path = (p) => p.split(/[\\/]+/).filter((x) => x !== "").map(esc).join("[\\\\/]+");
  const same = (a, b) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
  word("your account name (USERNAME)", env.USERNAME);
  word("the computer name (COMPUTERNAME)", env.COMPUTERNAME);
  if (!same(env.USERDOMAIN, env.COMPUTERNAME)) word("the account domain name (USERDOMAIN)", env.USERDOMAIN);
  const dns = env.DNSNAME ?? env.COMPUTERNAME;
  if (!same(dns, env.COMPUTERNAME)) word("the network host name", dns);
  for (const [label, v] of [["your home folder (USERPROFILE)", env.USERPROFILE], ["your local AppData folder (LOCALAPPDATA)", env.LOCALAPPDATA], ["your TEMP folder", env.TEMP]]) if (v) add(label, path(v));
  if (env.USERPROFILE) { const leaf = env.USERPROFILE.replace(/\\+$/, "").split("\\").pop(); if (!same(leaf, env.USERNAME)) word("the name of your home folder", leaf); }
  for (const m of code.matchAll(/^Add-Pattern '([^']+)' '([^']+)'$/gm)) add(m[1], m[2]);
  const ph = new RegExp(/Regex\('(<\(\?:user[^']*)'/.exec(code)[1], "g");
  const found = [];
  for (const [name, raw] of Object.entries(files)) {
    const text = raw.replace(ph, " "), rel = `results\\${name}`.replace(ph, " ");
    for (const [label, re] of pats) if (re.test(text) || re.test(rel)) found.push(`${rel} contains ${label}`);
  }
  return found;
}
const redactLog = (env, text) => {
  const r = spawnSync(process.execPath, [join(root, "scripts", "redact-log.mjs")], { input: text, encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes("could not be loaded"), "the built redaction is used");
  return r.stdout;
};
/** Windows output as the launcher's info, the evidence run and node print it, for the account in `who`. */
const windowsOutput = (who) => [
  `{"ok":true,"elevated":false,"account":"${who.host}\\\\${who.user.replace(/ /g, " ")}","accountSid":"S-1-5-21-1004336348-1177238915-682003330-1001","logon":"S-1-5-5-0-412337","container":"S-1-15-2-1430448594-2639229838-973813799-439329657-1197984847-4069167804-1277922394","windowStation":"private","windowStationOk":true,"profileDeleted":true,"profileGone":true,"control":"${who.home.replace(/\\/g, "\\\\")}\\\\Downloads\\\\windows-g05-owner-bundle\\\\control"}`,
  `case deny-read-outside: confined read of ${who.temp}\\nn-g05-a1b2c3\\outside\\secret.txt refused (Access is denied.); unconfined read of it worked`,
  `    at file:///${who.home.replace(/\\/g, "/")}/Downloads/windows-g05-owner-bundle/packages/worker/dist/sandbox/containment.js:412:9`,
  `profile folder ${who.local}\\Packages\\nimblenewtrun-0123456789abcdef removed; grants read back clean on ${who.home}\\Downloads\\windows-g05-owner-bundle\\node`,
  `loopback 127.0.0.1:50123 listening; this PC's address 192.168.1.20 and fe80::1c2b:3d4e:5f60:7a8b%12 were not tried`,
  `Azure AD account S-1-12-1-3523716318-1145236127-2519836318-2263283920 seen in the token's groups`,
  `Windows 10.0.26200.1, node v22.19.0, launcher 0.1.0; robust handling of a slow start`,
].join("\n") + "\n";

test("second review: on realistic Windows output for 'robert' (plain and spaced home folder, an 8.3 TEMP), the redaction leaves nothing the zip check refuses; unredacted, every kind is found", () => {
  for (const line of PS_HELPERS) assert.ok(code.includes(line), `the port follows run-g05.ps1: ${line}`);
  const accounts = [
    { env: { USERNAME: "robert", COMPUTERNAME: "DESKTOP-7Q2M4RB", USERDOMAIN: "DESKTOP-7Q2M4RB", USERPROFILE: "C:\\Users\\robert", LOCALAPPDATA: "C:\\Users\\robert\\AppData\\Local", TEMP: "C:\\Users\\robert\\AppData\\Local\\Temp" }, user: "robert" },
    { env: { USERNAME: "Robert Smith", COMPUTERNAME: "ROBS-PC", USERDOMAIN: "ROBS-PC", USERPROFILE: "C:\\Users\\Robert Smith", LOCALAPPDATA: "C:\\Users\\Robert Smith\\AppData\\Local", TEMP: "C:\\Users\\ROBERT~1\\AppData\\Local\\Temp" }, user: "Robert Smith" },
    // a Microsoft account: the home folder's name is not the account name
    { env: { USERNAME: "rober", COMPUTERNAME: "DESKTOP-K1", USERDOMAIN: "DESKTOP-K1", USERPROFILE: "C:\\Users\\rober_000", LOCALAPPDATA: "C:\\Users\\rober_000\\AppData\\Local", TEMP: "C:\\Users\\rober_000\\AppData\\Local\\Temp" }, user: "rober" },
  ];
  for (const a of accounts) {
    const raw = windowsOutput({ user: a.user, host: a.env.COMPUTERNAME, home: a.env.USERPROFILE, temp: a.env.TEMP, local: a.env.LOCALAPPDATA });
    const before = psFindings(a.env, { "evidence.stdout.txt": raw });
    for (const kind of ["your account name (USERNAME)", "the computer name (COMPUTERNAME)", "your home folder (USERPROFILE)", "your TEMP folder", "a ...\\Users\\ path", "an account SID (S-1-5-21-...)", "an Azure AD account SID (S-1-12-1-...)", "a logon session SID (S-1-5-5-...)", "an IPv4 address", "an IPv6 address"]) {
      assert.ok(before.some((f) => f.endsWith(`contains ${kind}`)), `${a.user}: unredacted, ${kind} is found (${before.join("; ")})`);
    }
    const clean = redactLog(a.env, raw);
    assert.ok(clean.includes("S-1-15-2-1430448594") && clean.includes("127.0.0.1:50123") && clean.includes("10.0.26200.1") && clean.includes("robust"), `${a.user}: what is not personal stays readable: ${clean}`);
    assert.deepEqual(psFindings(a.env, { "evidence.stdout.txt": clean, "info.stdout.txt": clean }), [], `${a.user}: the redacted text makes a zip: ${clean}`);
  }
});

test("second review: an account named like a common word is matched as a whole word ('rob' is not in 'robust'), and one named like a placeholder ('User', 'Home') does not refuse every zip", () => {
  const env = (user, host) => ({ USERNAME: user, COMPUTERNAME: host, USERDOMAIN: host, USERPROFILE: `C:\\Users\\${user}`, LOCALAPPDATA: `C:\\Users\\${user}\\AppData\\Local`, TEMP: `C:\\Users\\${user}\\AppData\\Local\\Temp` });
  assert.deepEqual(psFindings(env("rob", "PC1"), { "a.txt": "robust, Robotics, problem, prob" }), []);
  assert.equal(psFindings(env("rob", "PC1"), { "a.txt": "signed in as Rob." }).length, 1, "the name itself is still found");
  assert.equal(psFindings(env("a", "PC1"), { "a.txt": "a b c" }).length, 0, "a one-letter name is not looked for alone (its paths still are)");
  const placeholders = "signed in: <host>\\<user>; folder <home>\\Downloads; S-1-5-21-<domain>-<account>, S-1-5-5-<session>, <ip>, <email>, <withheld: possible personal data>";
  for (const [user, host] of [["User", "PC1"], ["home", "PC1"], ["robert", "HOST"], ["Account", "DOMAIN"]]) {
    assert.deepEqual(psFindings(env(user, host), { "a.txt": placeholders }), [], `${user}@${host}: the redaction's placeholders are not the name`);
    assert.ok(psFindings(env(user, host), { "a.txt": `x ${user} y` }).length > 0, `${user}: the bare name is still found`);
  }
  // taking a placeholder out never joins two pieces into the name
  assert.ok(psFindings(env("robert", "PC1"), { "a.txt": "robe<user>rt" }).length === 0 && code.includes("$placeholders.Replace([System.IO.File]::ReadAllText($f), ' ')"));
  assert.ok(code.includes("[System.Text.RegularExpressions.RegexOptions]::IgnoreCase -bor [System.Text.RegularExpressions.RegexOptions]::CultureInvariant"), "case folding is not the PC's culture's (Turkish i)");
});

test("second review: one run at a time (a named mutex taken before anything is written), refused under OneDrive, other NimbleNewt settings cleared, every program run with a time limit", () => {
  const lock = at("New-Object System.Threading.Mutex($false, $lockName)");
  const refuse = code.indexOf("exit 2", at("if (-not $locked) {"));
  assert.ok(at("$principal.IsInRole(") < lock && refuse < at("$check = Test-Bundle") && refuse < at("New-Item -ItemType Directory"), "the lock follows the elevation check and comes before the bundle check and any write");
  assert.ok(code.includes("$locked = $script:runLock.WaitOne(0)") && code.includes("catch [System.Threading.AbandonedMutexException] { $locked = $true }"), "an earlier run that died leaves the lock free");
  assert.match(code, /if \(-not \$locked\) \{\n\s+Write-Host 'REFUSED: another run[^\n]*\n\s+exit 2\n\}/);
  const od = at("foreach ($od in @($env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial))");
  assert.ok(od < at("$check = Test-Bundle") && /StartsWith\(\$od\.TrimEnd\('\\'\) \+ '\\', \[System\.StringComparison\]::OrdinalIgnoreCase\)\) \{\n\s+Write-Host 'REFUSED: this folder is inside OneDrive[^\n]*\n\s+exit 2/.test(code));
  const fsAt = at("$fsKind = (New-Object System.IO.DriveInfo($b)).DriveFormat");
  assert.ok(fsAt < at("$check = Test-Bundle") && /if \(\$fsKind -and \$fsKind -ne 'NTFS' -and \$fsKind -ne 'ReFS'\) \{\n\s+Write-Host "REFUSED: this folder is on a \$fsKind drive[^\n]*\n\s+exit 2/.test(code), "a drive without access lists is refused before anything runs");
  assert.ok(code.includes("if ($v -like 'NIMBLENEWT_*' -and $v -ne 'NIMBLENEWT_WIN_LAUNCHER' -and $v -ne 'NIMBLENEWT_WIN_CONTROL_DIR') { [System.Environment]::SetEnvironmentVariable($v, $null, 'Process') }"));
  assert.ok(at("if ($v -like 'NIMBLENEWT_*'") < at("Invoke-Captured $launcher"));
  const inv = code.slice(at("function Invoke-Captured"), at("function Get-Field"));
  assert.ok(inv.includes("[int] $minutes)") && inv.includes("if (-not $p.WaitForExit($minutes * 60000)) {") && inv.includes("$p.Kill()") && /throw "it was still running after \$minutes minutes/.test(inv));
  const calls = [...code.matchAll(/^.*Invoke-Captured \$(launcher|node) .*$/gm)].map((m) => m[0]);
  assert.equal(calls.length, 4);
  for (const c of calls) assert.match(c, / \$(null|src) (\d+)\)?( \}| *)$/, `a time limit: ${c}`);
});

test("second review: printed clean-up commands quote every quote PowerShell ends a string at, and name only exact record files; the zip's last place is control\\ (the next bundle check would refuse it at the root)", () => {
  assert.ok(code.includes("function ConvertTo-Quoted([string] $t) { return \"'\" + ($t -replace \"['\\u2018\\u2019\\u201A\\u201B]\", '$0$0') + \"'\" }"));
  // .NET reads the class as JavaScript does: the typographic quotes are doubled too
  const quoted = (t) => `'${t.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
  assert.equal(quoted("C:\\Rob\u2019s files\\x'; calc; '"), "'C:\\Rob\u2019\u2019s files\\x''; calc; '''");
  const clean = code.slice(at("function Show-Cleanup {"), code.indexOf("\n}\n", at("function Show-Cleanup {")));
  assert.ok(clean.includes("if ([System.IO.Path]::GetFileName($rec) -cnotmatch '^NimbleNewtRun-[0-9a-f]{16}\\.sid$') { continue }") && !/-replace "'", "''"/.test(clean), "no hand-made quoting left");
  assert.ok(clean.includes("Remove-Item -LiteralPath $(ConvertTo-Quoted $x)"));
  assert.ok(code.includes("if (-not [System.IO.Directory]::Exists($dest)) { $dest = $control }") && !code.includes("$dest = $b"));
  // a path part that is empty ("a//b") is refused by the line check itself (a lone empty string is false in PowerShell, so the count is taken)
  assert.ok(code.includes("@($rel.Split('/') | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' }).Count -gt 0"));
});

// ------------------------------------------------------------------------------------------------ the sign-out / restart check (card A03b): run-g05.ps1 -Hold, a sign-out, run-g05.ps1 -AfterSignIn

test("sign-out check: the two switches are separate steps, both after every guard of the plain run, and a plain run is refused while a hold is in progress", () => {
  assert.match(code, /if \(\$Hold -and \$AfterSignIn\) \{\n\s+Write-Host 'REFUSED: [^\n]*\n\s+exit 2\n\}/);
  const hold = at("if ($Hold) {"), after = at("if ($AfterSignIn) {");
  for (const guard of ["$principal.IsInRole(", "New-Object System.Threading.Mutex($false, $lockName)", "foreach ($od in @($env:OneDrive", "$fsKind = (New-Object System.IO.DriveInfo($b)).DriveFormat", "$check = Test-Bundle",
    "foreach ($d in @($control, $raw, $infoDir, (Join-Path $control 'profiles'), $holdDir, $results))", "foreach ($v in @('NODE_OPTIONS'", "if ($v -like 'NIMBLENEWT_*'", "$env:NIMBLENEWT_WIN_LAUNCHER = "]) {
    assert.ok(at(guard) < hold && at(guard) < after, `before both phases: ${guard}`);
  }
  assert.match(code, /if \(-not \$Hold -and -not \$AfterSignIn -and \[System\.IO\.File\]::Exists\(\$holdState\)\) \{\n\s+Write-Host 'REFUSED: a sign-out check is in progress[^\n]*\n\s+exit 2\n\}/);
  assert.ok(at("if (-not $Hold -and -not $AfterSignIn -and") < at("Invoke-Captured $launcher"), "before anything runs");
  assert.ok(code.includes("$holdDir = Join-Path $control 'hold'") && code.includes("New-Item -ItemType Directory -Path $control, $raw, $infoDir, $holdDir, $results -Force"), "the hold's files stay in control\\hold (never zipped, not under SHA256SUMS)");
});

test("sign-out check, -Hold: node starts with no pipe (the detached runner could inherit one) and a time limit, logs to its own file, the logon is kept only as a hash, the owner is told to sign out, and it ends before info, cases and zip", () => {
  const h = code.slice(at("if ($Hold) {"), at("$afterSignOutArgs = @()"));
  assert.ok(h.includes("@('--import', './scripts/offline-guard.mjs', 'scripts\\containment-evidence.mjs', 'hold', '--log', $holdLog)"), "the offline guard first, the hold command, its own log");
  assert.ok(h.includes("$psi.UseShellExecute = $false") && !/Redirect/.test(h), "no redirected handle");
  assert.ok(h.includes("if (-not $hp.WaitForExit(5 * 60000)) { try { $hp.Kill() } catch { }; throw"), "a time limit");
  assert.ok(h.includes("[System.IO.File]::WriteAllText($holdLogon, $logonHash, $utf8)") && !/\$t\b/.test(h), "only the hash is written");
  assert.match(h, /Write-Host "NOW, before \$\(\$until\): sign out of Windows[^\n]*\n\s+Write-Host '  powershell\.exe -NoProfile -ExecutionPolicy Bypass -File \.\\run-g05\.ps1 -AfterSignIn'/);
  assert.ok(/ends by itself at \$until at the latest/.test(h) && /A restart instead of the sign-out works the same/.test(h));
  assert.match(h.trimEnd(), /\n\s+exit 0\n\}$/, "it exits after the hold");
  assert.ok(!/Invoke-Captured|CreateFromDirectory|Remove-Item|Set-|New-Service/.test(h), "no info, no cases, no zip, no change to the machine");
  assert.ok(/if \(\$holdCode -eq 2 -or \$null -eq \$st -or \[string\] \(Get-Field \$st 'runId'\) -eq \$prevRun\) \{[^}]*REFUSED[^}]*exit 2/.test(h) && /FAILED: the task was started but was not seen running[^\n]*\n[^\n]*-AfterSignIn \(no sign-out needed\)[^\n]*\n\s+exit 1/.test(h));
  // A refused second -Hold (or a node that stops before it writes a state) keeps the recorded hold's logon hash: it is replaced or removed only once a NEW state (another run id) is there.
  assert.ok(h.includes("$prevRun = [string] (Get-Field (Read-JsonFile $holdState) 'runId')") && h.indexOf("$prevRun = ") < h.indexOf("[System.Diagnostics.Process]::Start($psi)"));
  const refusedAt = h.indexOf("-eq $prevRun) {");
  for (const touch of ["[System.IO.File]::WriteAllText($holdLogon", "[System.IO.File]::Delete($holdLogon)", "[System.IO.File]::Delete($holdChecked)"]) {
    assert.ok(h.includes(touch) && h.indexOf(touch) > refusedAt, `only after a new state: ${touch}`);
  }
  const lh = code.slice(at("function Get-LogonHash {"), at("function Read-JsonFile"));
  assert.ok(lh.includes("Get-WhoamiText @('/logonid')") && lh.includes("-notmatch '^S-1-5-5-\\d+-\\d+$'") && lh.includes("ComputeHash($utf8.GetBytes($t.Trim()))"));
  // The CLI's side: the hold's idle task is time-limited by the launcher, and the runner is started detached with the plan's environment only.
  const cli = readFileSync(join(root, "scripts", "containment-evidence.mjs"), "utf8");
  assert.ok(cli.includes('stdio: "ignore", detached: true, windowsHide: true') && cli.includes("child.unref()") && cli.includes("env: { ...plan.env }"));
  const signout = readFileSync(join(root, "packages", "worker", "src", "sandbox", "windows-native-signout.ts"), "utf8");
  assert.ok(signout.includes("export const MAX_HOLD_MINUTES = 30;") && signout.includes("maxRunMs: limitMs"));
});

test("sign-out check, -AfterSignIn: refused without a hold; the logon compared by hash; a still-running task stops it with nothing swept; the check file goes into the evidence run whenever it exists; the held folder is removed without following links", () => {
  const a = code.slice(at("if ($AfterSignIn) {"), at("$rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider"));
  assert.match(a, /if \(-not \[System\.IO\.File\]::Exists\(\$holdState\)\) \{\n\s+Write-Host 'REFUSED: no hold is recorded[^\n]*\n\s+exit 2\n\s+\}/);
  assert.ok(a.includes("$newLogon = 'unknown'") && a.includes("if ($before -and $nowHash) { if ($before -ceq $nowHash) { $newLogon = 'no' } else { $newLogon = 'yes' } }"));
  assert.ok(a.indexOf("[System.IO.File]::Delete($holdResult)") >= 0 && a.indexOf("[System.IO.File]::Delete($holdResult)") < a.indexOf("'after-sign-in', '--new-logon', $newLogon"), "an older result never stands for this check");
  assert.match(a, /\$afterCode = Invoke-Captured \$node @\('--import', '\.\/scripts\/offline-guard\.mjs', 'scripts\\containment-evidence\.mjs', 'after-sign-in', '--new-logon', \$newLogon\) [^\n]* \$null 10\n/);
  assert.match(a, /if \(\$afterCode -eq 3\) \{\n\s+Write-Host "REFUSED: the held task is still running[^\n]*\n\s+exit 1\n\s+\}/);
  const passOn = a.indexOf("if ([System.IO.File]::Exists($holdResult)) { $afterSignOutArgs = @('--after-sign-out', $holdResult) }");
  assert.ok(passOn > 0 && passOn < a.indexOf("if ($afterCode -ne 0 -or $null -eq $as)"), "passed whenever the file exists, before (not inside) the branch that reads it");
  assert.ok(a.includes("Add-Problem 'the sign-out check does not hold"));
  // The exit code the script stops on is the one the CLI gives while a held process still runs (3), and only then.
  const cliA = readFileSync(join(root, "scripts", "containment-evidence.mjs"), "utf8");
  assert.ok(cliA.includes("process.exit(result.running ? 3 : 0);") && a.includes("if ($afterCode -eq 3) {"), "a still-running task stops -AfterSignIn before the cases");
  assert.ok(a.includes("Write-Host '  To try again: run -Hold, sign out and back in within 30 minutes, then run -AfterSignIn.'") && a.includes("[DateTime]::UtcNow -gt $untilAt"), "a check that does not hold says how to try again");
  assert.ok(a.includes("-match '^nn-g05hold-[A-Za-z0-9]+$' -and (Get-EntryKind $root) -eq 'dir'") && a.includes("[System.IO.Directory]::Delete($root, $true)"));
  assert.ok(code.includes("if ($afterSignOutArgs.Count -gt 0) { $evidenceArgs += $afterSignOutArgs }"));
  assert.ok(code.includes("foreach ($name in @('info.stdout.txt', 'info.stderr.txt', 'evidence.stdout.txt', 'evidence.stderr.txt', 'hold.log.txt', 'after-sign-in.stdout.txt', 'after-sign-in.stderr.txt')) {"), "every new output is redacted into results and checked before the zip");
  // The fields the script prints are exactly the gate's.
  const ts = readFileSync(join(root, "packages", "worker", "src", "sandbox", "containment.ts"), "utf8");
  const keys = /const AFTER_SIGNOUT_KEYS = \[([^\]]+)\] as const;/.exec(ts);
  const printed = /\$facts = @\(('held'[^)]+)\) \| ForEach-Object/.exec(a);
  assert.ok(keys && printed);
  assert.deepEqual(printed[1].split(",").map((x) => x.trim().replace(/'/g, "")), keys[1].split(",").map((x) => x.trim().replace(/"/g, "")));
});

test("sign-out check, the command line: hold and after-sign-in refuse bad arguments, and off Windows refuse to run anything", () => {
  for (const extra of [["hold", "--minutes"], ["hold", "--bogus", "1"], ["hold", "--log"], ["after-sign-in", "--new-logon"], ["after-sign-in", "--minutes", "1"]]) {
    const r = evidence(bundle, ...extra);
    assert.equal(r.status, 2, `${extra.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^usage: (hold|after-sign-in)/m);
  }
  if (process.platform !== "win32") {
    for (const extra of [["hold"], ["hold", "--minutes", "5"], ["after-sign-in", "--new-logon", "yes"]]) {
      const r = evidence(bundle, ...extra);
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, /Windows only \(the native launcher\); nothing was run/);
    }
  }
});
