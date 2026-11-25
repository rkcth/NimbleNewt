// Card A03b slice 3: the native Windows launcher's release inputs, its Rust dependency licenses, the administrator installer script (read as text: PowerShell is not available on the Linux and macOS
// cells) and the hand-started workflow's new steps. Nothing here runs the launcher or the installer; what they DO on Windows is judged by the hosted run and, later, the owner's own machine.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cargoPackages, cargoProblems } from "./license-inventory.mjs";
import { RECORD_SCHEMA, checkRecord, makeRecord, pinnedToolchain } from "./native-launcher.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8").replace(/\r\n/g, "\n");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const LOCK = read("native", "nn-launcher", "Cargo.lock");

// ------------------------------------------------------------------------------------------------ the release record

test("the release record names the file, the inputs of the build, and no time, path or user", () => {
  const bytes = Buffer.from("MZ pretend executable");
  const a = makeRecord({ fileName: "C:\\build\\nn-launcher.exe", bytes, commit: COMMIT });
  assert.equal(a.schema, RECORD_SCHEMA);
  assert.equal(a.file, "nn-launcher.exe", "the file name only, never the build machine's path");
  assert.equal(a.size, bytes.length);
  assert.match(a.sha256, /^[0-9a-f]{64}$/);
  assert.match(a.cargoLockSha256, /^[0-9a-f]{64}$/);
  assert.equal(a.toolchain, pinnedToolchain());
  assert.deepEqual(a.features, []);
  assert.deepEqual(makeRecord({ fileName: "x/nn-launcher.exe", bytes, commit: COMMIT }), a, "same inputs, same record (nothing time- or place-dependent)");
  assert.ok(!/time|date|path|user|host/i.test(Object.keys(a).join(",")), Object.keys(a).join(","));
});

test("a record is refused without a full commit, and a file must match it exactly (a changed byte, a wrong size, a feature build)", () => {
  const bytes = Buffer.from("abc");
  assert.throws(() => makeRecord({ fileName: "a.exe", bytes, commit: "abc123" }), /40-character/);
  assert.throws(() => makeRecord({ fileName: "a.exe", bytes, commit: undefined }), /40-character/);
  const record = makeRecord({ fileName: "a.exe", bytes, commit: COMMIT });
  assert.deepEqual(checkRecord(record, bytes), []);
  assert.match(checkRecord(record, Buffer.from("abd")).join(), /SHA-256/);
  assert.match(checkRecord({ ...record, size: 9 }, bytes).join(), /size/);
  assert.match(checkRecord({ ...record, features: ["experiment"] }, bytes).join(), /features/);
  assert.match(checkRecord({ schema: "other" }, bytes).join(), /not a release record/);
});

test("the toolchain is pinned to an exact version, the same one the workflow installs, and the lock file belongs to the product crate", () => {
  const v = pinnedToolchain();
  assert.match(v, /^\d+\.\d+\.\d+$/);
  assert.throws(() => pinnedToolchain('[toolchain]\nchannel = "stable"\n'), /exact version/);
  const wf = read(".github", "workflows", "windows-appcontainer-experiment.yml");
  assert.ok(wf.includes(`rustup toolchain install ${v} --profile minimal`), "the workflow installs the pinned toolchain");
  assert.match(read("native", "nn-launcher", "RELEASE.md"), new RegExp(`rustup toolchain install ${v.replace(/\./g, "\\.")}`));
  assert.ok(/name = "nn-launcher"/.test(LOCK) && !/nn-appc-launcher/.test(LOCK));
  // reproducible-build inputs are all in the documented steps
  const rel = read("native", "nn-launcher", "RELEASE.md");
  for (const word of ["--locked", "--remap-path-prefix", "/Brepro", "native-launcher.mjs record", "native-launcher.mjs verify", "-AllowUnsigned", "signtool verify"]) assert.ok(rel.includes(word), word);
  assert.ok(/NOT yet shown/.test(rel), "the reproducibility claim is stated as unproven");
  assert.ok(!/password|secret key|\.pfx/i.test(rel.replace(/nothing secret|never copied/gi, "")) || /never (copied|stored)/.test(rel), "the signing text stores no secret");
});

// ------------------------------------------------------------------------------------------------ Rust dependency licenses

test("the Rust crates of Cargo.lock each have a recorded, allowed license, and a stale or missing record is a problem", () => {
  const keys = cargoPackages(LOCK);
  assert.ok(keys.includes("windows-sys@0.59.0") && keys.length >= 5, keys.join(","));
  assert.ok(!keys.some((k) => k.startsWith("nn-launcher@")), "the crate itself is not a third-party entry");
  const recorded = JSON.parse(read("native", "nn-launcher", "cargo-licenses.json"));
  assert.deepEqual(cargoProblems(LOCK, recorded), []);
  assert.match(cargoProblems(LOCK, { ...recorded, "windows-sys@0.59.0": undefined }).join(), /no license recorded/);
  assert.match(cargoProblems(LOCK, { ...recorded, "windows-sys@0.59.0": "GPL-3.0-only" }).join(), /not on the allow list/);
  assert.match(cargoProblems(LOCK, { ...recorded, "gone@1.0.0": "MIT" }).join(), /stale/);
  const added = `${LOCK}\n[[package]]\nname = "newcrate"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n`;
  assert.match(cargoProblems(added, recorded).join(), /newcrate@1\.0\.0: no license recorded/);
});

// ------------------------------------------------------------------------------------------------ the installer script, read as text

const ps = read("native", "install", "Install-NimbleNewtLauncher.ps1");
const code = ps.replace(/<#[\s\S]*?#>/, "").split("\n").filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s#\s.*$/, "")).join("\n");
const fn = (name) => { const a = ps.indexOf(`function ${name}`); assert.ok(a >= 0, name); const b = ps.indexOf("\nfunction ", a + 5); const c = ps.indexOf("\nswitch ($Action)", a); return ps.slice(a, b > 0 ? b : c); };

test("the installer is Verify by default, supports -WhatIf, and asks an administrator for Install and Uninstall only", () => {
  assert.match(ps, /\[CmdletBinding\(SupportsShouldProcess = \$true, ConfirmImpact = 'High'\)\]/);
  assert.match(ps, /\[ValidateSet\('Verify', 'Install', 'Uninstall'\)\] \[string\] \$Action = 'Verify'/);
  assert.ok(fn("Invoke-Install").includes("Assert-Admin") && fn("Invoke-Uninstall").includes("Assert-Admin"));
  assert.ok(!fn("Invoke-Verify").includes("Assert-Admin"), "Verify may run without elevation (the rights part says so)");
  assert.match(ps, /\$ExpectedSha256/);
  assert.ok(fn("Invoke-Install").includes("-ne $ExpectedSha256.ToUpperInvariant()") && fn("Invoke-Install").includes("-AllowUnsigned"));
});

/** True when the line is, or is inside a block opened by, a line that asks `$PSCmdlet.ShouldProcess(` (walks up through the enclosing braces only; an earlier, closed block does not count). */
function insideShouldProcess(lines, i) {
  const count = (l, c) => l.split(c).length - 1;
  if (lines[i].includes("$PSCmdlet.ShouldProcess(")) return true;
  let need = 0;
  for (let j = i - 1; j >= 0; j--) {
    const opens = count(lines[j], "{"); const closes = count(lines[j], "}");
    if (closes > opens) need += closes - opens;
    else if (opens > closes) {
      if (need >= opens - closes) need -= opens - closes;
      else { if (lines[j].includes("$PSCmdlet.ShouldProcess(")) return true; need = 0; }
    }
  }
  return false;
}

test("every line that changes the machine sits inside a ShouldProcess question, and Verify changes nothing", () => {
  const mutating = [/\bNew-LocalUser\b/, /\bAdd-LocalGroupMember\b/, /\bRemove-LocalUser\b/, /\[NnLsa\]::(Add|Remove|RemoveAll)\(/, /\bSet-Acl\b/, /\bCopy-Item\b/, /\bRemove-Item\b/, /\bSet-Content\b/, /\bNew-Item\b/, /\bRemove-CimInstance\b/, /\bSet-ProtectedAcl \$/];
  const lines = code.split("\n");
  let seen = 0;
  lines.forEach((line, i) => {
    if (/^\s*function /.test(line)) return;
    for (const re of mutating) {
      if (!re.test(line)) continue;
      seen++;
      if (/\bSet-Acl\b/.test(line)) { assert.ok(/function Set-ProtectedAcl/.test(ps)); continue; } // its only call site is checked below
      assert.ok(insideShouldProcess(lines, i), `not inside a ShouldProcess block: ${line.trim()}`);
    }
  });
  assert.ok(seen >= 12, `${seen} mutating lines found`);
  assert.equal(code.match(/Set-ProtectedAcl \$item\.Path/g).length, 1, "one call site");
  assert.ok(/ShouldProcess\(\$item\.Path[^\n]*\n(?:[^\n]*\n){0,3}[^\n]*Set-ProtectedAcl \$item\.Path/.test(code), "that call site is inside its ShouldProcess");
  for (const re of mutating) assert.ok(!re.test(fn("Invoke-Verify")), `Verify must not contain ${re}`);
  assert.ok(!/\bNnLsa\]::(Add|Remove)/.test(fn("Invoke-Verify")) && fn("Invoke-Verify").includes("[NnLsa]::List("));
});

test("least privilege: each access-list entry has its reason, no broad group is granted, the account never gets more than read/execute on the program and Modify on its control folder, inheritance is off", () => {
  const plan = fn("New-AclPlan");
  const entries = [...plan.matchAll(/@\{ Who = (\$\w+); Rights = '(\w+)'; Why = '([^']+)'/g)];
  assert.equal(entries.length, 9, "three folders, three entries each");
  for (const e of entries) assert.ok(e[3].length > 25, `reason for ${e[1]} ${e[2]}`);
  assert.equal(plan.match(/Rights = /g).length, plan.match(/Why = /g).length, "no entry without its reason");
  const byFolder = plan.split("@{ Path = ").slice(1);
  assert.deepEqual(byFolder.map((f) => f.split("\n")[0].trim()), ["$InstallDir; Rules = @(", "$DataDir; Rules = @(", "$ControlDir; Rules = @("]);
  const account = (f) => [...f.matchAll(/Who = \$account; Rights = '(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(byFolder.map(account), [["ReadAndExecute"], ["ReadAndExecute"], ["Modify"]]);
  assert.ok(!/Who = \$(SidUsers|account); Rights = '(FullControl|Write|TakeOwnership|ChangePermissions)'/.test(plan));
  for (const broad of [/Everyone/i, /S-1-1-0/, /Authenticated Users/i, /S-1-5-11/, /BUILTIN\\Users/i, /ALL APPLICATION PACKAGES/i, /S-1-15-2/]) assert.ok(!broad.test(plan), `${broad} must not be granted`);
  const acl = fn("Set-ProtectedAcl");
  assert.ok(acl.includes("SetAccessRuleProtection($true, $false)") && acl.includes("SetOwner($SidAdmins)") && acl.includes("'Allow'") && !acl.includes("'Deny'"));
  assert.ok(fn("Assert-SafeFolder").includes("Test-Reparse") && /not by an administrator/.test(fn("Assert-SafeFolder")), "a pre-made folder or link under our name is refused");
});

test("the account is a local standard user: in Users only, batch logon granted, interactive, remote-desktop and network logon denied, and no right outside the managed list", () => {
  assert.match(ps, /\$RightsDenied = @\('SeDenyInteractiveLogonRight', 'SeDenyRemoteInteractiveLogonRight', 'SeDenyNetworkLogonRight'\)/);
  assert.match(ps, /\$RightsGranted = @\('SeBatchLogonRight'\) \+ \$\(if \(\$ServiceLogon\) \{ @\('SeServiceLogonRight'\) \}/);
  assert.match(ps, /\$RightsAll = @\('SeBatchLogonRight', 'SeServiceLogonRight'\) \+ \$RightsDenied/);
  assert.ok(!/SeDenyServiceLogonRight|SeDenyBatchLogonRight|SeTcb|SeDebug|SeImpersonate|SeAssignPrimaryToken|SeBackup|SeRestore|SeTakeOwnership|SeLoadDriver/.test(code), "no other privilege or right is named");
  const install = fn("Invoke-Install");
  assert.ok(install.includes("Add-LocalGroupMember -SID $SidUsers"), "Users");
  assert.ok(!/Add-LocalGroupMember[^\n]*(Administrators|S-1-5-32-544|\$SidAdmins)/.test(code), "never an administrator");
  assert.ok(/\$SidUsers = 'S-1-5-32-545'/.test(ps));
  assert.ok(install.includes("-PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires"));
  assert.ok(/Description \$AccountMarker/.test(install) && fn("Invoke-Uninstall").includes("$user.Description -ne $AccountMarker"), "only the account it made is removed");
});

test("no secret is stored: the password is generated in memory, never converted from text, printed or written; there is no network and no code download", () => {
  assert.ok(/RandomNumberGenerator\]::Create\(\)/.test(fn("New-RandomSecureString")) && fn("New-RandomSecureString").includes("AppendChar") && fn("New-RandomSecureString").includes("MakeReadOnly"));
  for (const bad of [/-AsPlainText/, /ConvertTo-SecureString/, /ConvertFrom-SecureString/, /Out-File/, /Add-Content/, /Write-(Host|Output|Verbose|Debug) [^\n]*\$(secure|plain|password)/i, /\bnet user\b/i, /Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|\bcurl\b|\bwget\b|DownloadString|DownloadFile|Invoke-Expression|\biex\b|Set-ExecutionPolicy|Start-Process/i]) assert.ok(!bad.test(code), `${bad} must not appear`);
  const passwordUses = [...code.matchAll(/\$\w*(?:secure|password)\w*/gi)].map((m) => m[0]);
  assert.ok(passwordUses.every((u) => /^\$(secure|Password)$/i.test(u)), passwordUses.join(","));
  assert.ok(code.includes("-Password (New-RandomSecureString)"), "the generated value goes straight to New-LocalUser");
  // what is written to disk: worker.env and the manifest, from names and paths only
  assert.ok(/Set-Content -LiteralPath \$EnvFile -Value \$lines/.test(code) && /Set-Content -LiteralPath \$ManifestPath/.test(code));
  assert.equal(code.match(/Set-Content/g).length, 2);
});

test("worker.env carries exactly the four names and defaults the TypeScript backend reads", () => {
  const ts = read("packages", "worker", "src", "sandbox", "windows-native.ts");
  const plan = read("packages", "worker", "src", "sandbox", "windows-native-plan.ts");
  const names = [...ts.matchAll(/env\["(NIMBLENEWT_WIN_[A-Z_]+)"\]/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(names)].sort(), ["NIMBLENEWT_WIN_CONTAINER", "NIMBLENEWT_WIN_CONTROL_DIR", "NIMBLENEWT_WIN_LAUNCHER", "NIMBLENEWT_WIN_PROFILE"]);
  for (const n of new Set(names)) assert.ok(fn("Invoke-Install").includes(`"${n}=`), `worker.env writes ${n}`);
  assert.equal(code.match(/NIMBLENEWT_[A-Z_]+=/g).length, 4, "no fifth variable");
  // the defaults the backend uses when the file is absent are the places the installer makes
  assert.ok(ts.includes('win32.join(programFiles, "NimbleNewt", "nn-launcher.exe")') && ps.includes("$ExeName = 'nn-launcher.exe'") && ps.includes("Join-Path $env:ProgramFiles 'NimbleNewt'"));
  assert.ok(ts.includes('win32.join(programData, "NimbleNewt", "native")') && ps.includes("Join-Path $DataDir 'native'") && ps.includes("Join-Path $env:ProgramData 'NimbleNewt'"));
  assert.ok(new RegExp(`DEFAULT_PROFILE_NAME = "${/\$ProfileName = '(\w+)'/.exec(ps)[1]}"`).test(plan), "the profile name default");
  assert.ok(ps.includes("[string] $Container = 'lpac'"));
});

test("uninstall removes what install made, from a manifest, and nothing it did not make", () => {
  const un = fn("Invoke-Uninstall");
  for (const part of ["$ManifestPath", "nimblenewt.native-install/1", "RemoveAll", "Remove-CimInstance", "Remove-LocalUser", "Remove-Item -LiteralPath $p -Recurse -Force", "-Leaf $p) -ne 'NimbleNewt'", "Test-Reparse $p", "Get-Process -Name 'nn-launcher'", "$m.accountSid"]) assert.ok(un.includes(part), part);
  const made = fn("Invoke-Install");
  for (const part of ["New-LocalUser", "[NnLsa]::Add(", "Set-ProtectedAcl", "Copy-Item", "Set-Content -LiteralPath $EnvFile", "$manifest = [ordered]@"]) assert.ok(made.includes(part), part);
  // idempotent: the account and the launcher are checked before they are made or copied
  assert.ok(made.includes("if ($null -eq $existing)") && made.includes("-ne $hash) { Copy-Item"));
  assert.ok(fn("Invoke-Verify").includes("the entry list is exactly the expected one"));
});

test("the installer's README states what is not proven, and the contribution guide accounts for the new files", () => {
  const readme = read("native", "install", "README.md");
  for (const phrase of ["NOT RUN", "Session 0", "S4U", "Windows Home", "service-units.ts", "virtual service account", "group-managed service account"]) assert.ok(readme.includes(phrase), phrase);
  const contributing = read("CONTRIBUTING.md");
  for (const file of ["native/nn-launcher/src/lib.rs", "native/nn-launcher/src/main.rs", "native/nn-launcher/src/win.rs", "native/nn-launcher/Cargo.toml", "native/install/Install-NimbleNewtLauncher.ps1", "experiments/windows-appcontainer/launcher/src/main.rs"]) assert.ok(contributing.includes(file), file);
});

// ------------------------------------------------------------------------------------------------ the workflow steps

test("the hand-started workflow builds the product launcher --locked after the experiment build and before the containment cases, and runs the installer without changing the machine", () => {
  const wf = read(".github", "workflows", "windows-appcontainer-experiment.yml");
  assert.ok(!/^\s+(push|pull_request|schedule):/m.test(wf));
  const hosted = wf.slice(wf.indexOf("  hosted:"), wf.indexOf("  own-runner:"));
  const at = (s) => { const i = hosted.indexOf(s); assert.ok(i >= 0, s); return i; };
  assert.ok(at("Build the launcher (locked dependencies)") < at("Product launcher (native/nn-launcher)") && at("Product launcher (native/nn-launcher)") < at("Installer script (parse") && at("Installer script (parse") < at("G05 containment cases through the native backend"));
  const product = hosted.slice(at("Product launcher (native/nn-launcher)"), at("Installer script (parse"));
  for (const part of ["cargo build --release --locked", "--remap-path-prefix", "/Brepro", "nn-launcher.exe info", "grep -q '\"ok\":true'", "not in this build", 'test "$rc" -eq 125', "native-launcher.mjs record", "native-launcher.mjs verify", "if: always()"]) assert.ok(product.includes(part), part);
  assert.ok(!product.includes("--features"), "the product build enables no feature");
  const installer = hosted.slice(at("Installer script (parse"), at("G05 containment cases through the native backend"));
  for (const part of ["Parser]::ParseFile", "-WhatIf", "-Action Verify", "-AllowUnsigned", "if (Get-LocalUser -Name nn-whatif-check", "Test-Path (Join-Path $env:ProgramFiles 'NimbleNewt')"]) assert.ok(installer.includes(part), part);
  assert.ok(!/-Action (Install|Uninstall)(?![^\n]*-WhatIf)/.test(installer.replace(/-Action Verify/g, "")), "Install is only ever run with -WhatIf there");
  // the containment cases use the product binary, not the experiment's
  assert.match(hosted.slice(at("G05 containment cases through the native backend")), /NIMBLENEWT_WIN_LAUNCHER: [^\n]*native\\nn-launcher\\target\\release\\nn-launcher\.exe/);
});
