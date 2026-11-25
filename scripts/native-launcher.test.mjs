// Card A03b slice 3: the native Windows launcher's release inputs, its Rust dependency licenses, the administrator installer script (read as text: PowerShell is not available on the Linux and macOS
// cells) and the hand-started workflow's new steps. Nothing here runs the launcher or the installer; what they DO on Windows is judged by the hosted run and, later, the owner's own machine.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  // a record without its feature list, or with a malformed one, is not "built with no feature"
  const { features: _omitted, ...noFeatures } = record;
  assert.match(checkRecord(noFeatures, bytes).join(), /does not list its cargo features/);
  assert.match(checkRecord({ ...record, features: "experiment" }, bytes).join(), /does not list its cargo features/);
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
  assert.ok(/NOT yet shown more widely/.test(rel) && rel.includes("e7ac4337c77d57a093d615a7906d37bc2452754df24ca9bb08b47ef4322cf902"), "the reproducibility claim is stated as measured once and unproven more widely");
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
  // a crate from a git repository, a lock file with Windows line endings, and fields in another order are all still checked
  const fromGit = `${LOCK}\n[[package]]\nname = "gitcrate"\nversion = "0.1.0"\nsource = "git+https://example.invalid/x#0123"\n`;
  assert.match(cargoProblems(fromGit, recorded).join(), /gitcrate@0\.1\.0: no license recorded/);
  assert.deepEqual(cargoPackages(LOCK.replace(/\n/g, "\r\n")), keys);
  assert.deepEqual(cargoPackages(`${LOCK}\n[[package]]\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nversion = "2.0.0"\nname = "reordered"\n`), [...keys, "reordered@2.0.0"].sort());
  assert.throws(() => cargoPackages(`${LOCK}\n[[package]]\nsource = "registry+x"\n`), /without a name and version/);
  // a line TOML would read but cargo never writes is refused, not skipped: it could hide a crate or make a third-party crate look local
  for (const odd of ['[[package]]\nname = "spaced"\nversion = "1.0.0"\nsource="registry+https://github.com/rust-lang/crates.io-index"', '[[ package ]]\nname = "hidden"\nversion = "1.0.0"\nsource = "registry+x"',
    '[[package]] # x\nname = "c"\nversion = "1.0.0"\nsource = "registry+x"', '[[package]]\nname = "t"\nversion = "1.0.0"\n  source = "registry+x"', '[[package]]\nname = "q"\nversion = "1.0.0"\nsource = \'registry+x\'']) {
    assert.throws(() => cargoPackages(`${LOCK}\n${odd}\n`), /not in the form cargo writes/, odd);
  }
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

test("A03b worker task: Verify only READS the worker's scheduled task (S4U, least privilege, boot trigger, worker.env), registers nothing, and a missing task is not a failure", () => {
  const verify = fn("Invoke-Verify");
  assert.match(ps, /\$WorkerTaskName = 'NimbleNewtWorker'/);
  // the root folder only (-TaskName alone also returns same-named tasks of other folders, and an array would make every check below unreliable)
  assert.ok(verify.includes("@(Invoke-Read { Get-ScheduledTask -TaskPath '\\' -TaskName $WorkerTaskName -ErrorAction SilentlyContinue } | Where-Object { $null -ne $_ })"));
  assert.ok(verify.includes("$task = $task[0]"));
  // enum or number: the text of LogonType (S4U = 2) and RunLevel (Limited = 0) is compared; the UserId is the bare name or THIS computer's, never any domain's
  for (const part of ['$logon = "$($tp.LogonType)"', '$level = "$($tp.RunLevel)"', "@('S4U', '2') -contains $logon", "@('Limited', '0') -contains $level", "MSFT_TaskBootTrigger", "--env-file=$EnvFile", "OrdinalIgnoreCase", "$tp.UserId -ieq $AccountName", '$tp.UserId -ieq "$env:COMPUTERNAME\\$AccountName"', "$acts.Count -eq 1"]) assert.ok(verify.includes(part), part);
  assert.ok(!/UserId -like/.test(verify), "no wildcard match of the account (OTHERDOMAIN\\name would pass)");
  // collections that may be empty or hold $null are filtered before a property is read (Set-StrictMode -Version 3)
  assert.ok(verify.includes("@(@($task.Triggers) | Where-Object { $null -ne $_ } | ForEach-Object { $_.CimClass.CimClassName })"));
  // the task checks are Checks (a FAIL when it exists and is wrong), and an absent task only says so
  assert.match(verify, /if \(\$task\.Count -eq 0\) \{ Say '  not registered/);
  assert.ok(!/\$task\.Count -eq 0\) \{[^}]*Check \$false/.test(verify), "a task that is not registered is not a failure");
  // nothing in the whole script registers, changes, starts or removes a task (cmdlets, schtasks, the COM object, the CIM class behind the cmdlets)
  assert.ok(!/\b(Register|Unregister|Set|New|Start|Stop|Enable|Disable)-ScheduledTask\b|\bschtasks\b|Register-ScheduledJob|\bSchedule\.Service\b|PS_ScheduledTask|MSFT_ScheduledTask\b|Invoke-CimMethod|RegisterByXml|RegisterTask/i.test(code), "the installer never registers or changes a task");
  assert.deepEqual([...code.matchAll(/\b\w+-ScheduledTask\w*/g)].map((m) => m[0]), ["Get-ScheduledTask"], "the only task cmdlet is the read");
  assert.ok(/does not register or start the worker/.test(ps));
  // the password story is unchanged: no password reaches a task from here
  assert.ok(!/-Password\b|-RunAsUser|LogonType\s+Password/i.test(code.replace(/New-LocalUser[^\n]*-Password[^\n]*/g, "")));
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
  const mutating = [/\bNew-LocalUser\b/, /\bAdd-LocalGroupMember\b/, /\bRemove-LocalUser\b/, /\[NnLsa\]::(Add|Remove|RemoveAll)\(/, /\bSet-Acl\b/, /\bCopy-Item\b/, /\bRemove-Item\b/, /\bSet-Content\b/, /\bNew-Item\b/, /\bRemove-CimInstance\b/, /\bSet-ProtectedAcl \$/, /\bRemove-TreeNoFollow \$/, /\[System\.IO\.(Directory|File)\]::(Delete|CreateDirectory|Move)\(/, /FileSystemAclExtensions\]::Create\(/];
  const lines = code.split("\n");
  // The two helpers that write are checked at their call sites (which must each sit inside a ShouldProcess question), not inside their own bodies.
  const helperLines = new Set();
  for (const helper of ["Set-ProtectedAcl", "Remove-TreeNoFollow"]) {
    const start = lines.findIndex((l) => l.startsWith(`function ${helper}(`));
    assert.ok(start >= 0, helper);
    for (let i = start; i < lines.length && !(i > start && /^}/.test(lines[i - 1])); i++) helperLines.add(i);
  }
  let seen = 0;
  lines.forEach((line, i) => {
    if (/^\s*function /.test(line) || helperLines.has(i)) return;
    for (const re of mutating) {
      if (!re.test(line)) continue;
      seen++;
      assert.ok(insideShouldProcess(lines, i), `not inside a ShouldProcess block: ${line.trim()}`);
    }
  });
  assert.ok(seen >= 14, `${seen} mutating lines found`);
  assert.ok(!/\bNew-Item\b|-Recurse\b/.test(code), "folders are made with their list in one call, and nothing is removed with a recursive delete that could follow a link");
  assert.equal(code.match(/Set-ProtectedAcl \$item\.Path/g).length, 1, "one call site");
  assert.ok(/ShouldProcess\(\$item\.Path[^\n]*\n(?:[^\n]*\n){0,3}[^\n]*Set-ProtectedAcl \$item\.Path/.test(code), "that call site is inside its ShouldProcess");
  for (const re of mutating) assert.ok(!re.test(fn("Invoke-Verify")), `Verify must not contain ${re}`);
  assert.ok(!/\bNnLsa\]::(Add|Remove)/.test(fn("Invoke-Verify")) && fn("Invoke-Verify").includes("[NnLsa]::List("));
});

test("least privilege: each access-list entry has its reason, no broad group is granted, the account never gets more than read/execute on the program and Modify on its control folder, inheritance is off", () => {
  const plan = fn("New-AclPlan");
  const entries = [...plan.matchAll(/@\{ Who = (\$\w+); Rights = '([\w, ]+)'; Scope = '(All|Folder|Below)'; Why = '([^']+)'/g)];
  assert.equal(entries.length, 10, "three folders: three entries each, and the account's two on its control folder");
  for (const e of entries) assert.ok(e[4].length > 25, `reason for ${e[1]} ${e[2]}`);
  assert.equal(plan.match(/Rights = /g).length, plan.match(/Why = /g).length, "no entry without its reason");
  const byFolder = plan.split("@{ Path = ").slice(1);
  assert.deepEqual(byFolder.map((f) => f.split("\n")[0].trim()), ["$InstallDir; Rules = @(", "$DataDir; Rules = @(", "$ControlDir; Rules = @("]);
  const account = (f) => [...f.matchAll(/Who = \$account; Rights = '([\w, ]+)'; Scope = '(\w+)'/g)].map((m) => `${m[1]} (${m[2]})`);
  // the control folder: the account may create in it and delete what is inside, but holds no Delete on the folder itself (it cannot remove or rename it)
  assert.deepEqual(byFolder.map(account), [["ReadAndExecute (All)"], ["ReadAndExecute (All)"], ["ReadAndExecute, Write (Folder)", "Modify (Below)"]]);
  assert.ok(/'Below' \{ return @\('ContainerInherit, ObjectInherit', 'InheritOnly'\) \}/.test(ps) && /'Folder' \{ return @\('None', 'None'\) \}/.test(ps), "the scopes map to the right inheritance flags");
  assert.ok(!/Who = \$(SidUsers|account); Rights = '(FullControl|Write|TakeOwnership|ChangePermissions)'/.test(plan));
  for (const broad of [/Everyone/i, /S-1-1-0/, /Authenticated Users/i, /S-1-5-11/, /BUILTIN\\Users/i, /ALL APPLICATION PACKAGES/i, /S-1-15-2/]) assert.ok(!broad.test(plan), `${broad} must not be granted`);
  const acl = fn("New-ProtectedSecurity");
  assert.ok(acl.includes("SetAccessRuleProtection($true, $false)") && acl.includes("SetOwner($SidAdmins)") && acl.includes("'Allow'") && !acl.includes("'Deny'"));
  const safe = fn("Assert-SafeItem");
  assert.ok(safe.includes("Test-Reparse") && /not by an administrator/.test(safe) && safe.includes("$TrustedOwners -notcontains"), "a pre-made folder, file or link under our names is refused");
  assert.ok(!safe.includes("ManifestPath"), "no exemption: a planted manifest file must not make a foreign folder acceptable");
  // the folder is made WITH its list (one call), then checked (a race winner's folder is refused), then the list is written
  const set = fn("Set-ProtectedAcl");
  assert.ok(set.indexOf("CreateDirectory($path, $security)") < set.indexOf("Assert-SafeItem $path $true") && set.indexOf("Assert-SafeItem $path $true") < set.indexOf("Set-Acl -LiteralPath $path"));
  const install = fn("Invoke-Install");
  assert.ok(/foreach \(\$d in @\(\$InstallDir, \$DataDir, \$ControlDir\)\) \{ Assert-SafeItem \$d \$true \}/.test(install) && /Assert-SafeItem \$f \$false/.test(install), "every name is checked before any change");
  assert.ok(install.indexOf("Assert-SafeItem $d $true") < install.indexOf("ShouldProcess("), "the checks come before the first change");
  // Verify compares rights with SYNCHRONIZE normalised on both sides, and inheritance too
  const verify = fn("Invoke-Verify");
  assert.equal(verify.match(/-bor \$SynchronizeBit/g)?.length, 2);
  assert.ok(verify.includes("[int]$_.InheritanceFlags") && verify.includes("[int]$_.PropagationFlags"));
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
  // The installer writes four. The fifth, NIMBLENEWT_WIN_MAX_RUNS (how many confined runs at once, default 1), is the operator's own and is NOT written by the installer; NIMBLENEWT_WIN_PROFILE is
  // still written and still read, but ignored (retired: every run makes its own container profile).
  const installerNames = ["NIMBLENEWT_WIN_CONTAINER", "NIMBLENEWT_WIN_CONTROL_DIR", "NIMBLENEWT_WIN_LAUNCHER", "NIMBLENEWT_WIN_PROFILE"];
  assert.deepEqual([...new Set(names)].sort(), [...installerNames, "NIMBLENEWT_WIN_MAX_RUNS"].sort());
  for (const n of installerNames) assert.ok(fn("Invoke-Install").includes(`"${n}=`), `worker.env writes ${n}`);
  assert.ok(!ps.includes("NIMBLENEWT_WIN_MAX_RUNS"), "the installer never sets the run limit: more than one run at once is an explicit, unmeasured choice");
  assert.equal(code.match(/NIMBLENEWT_[A-Z_]+=/g).length, 4, "no fifth variable");
  // the defaults the backend uses when the file is absent are the places the installer makes
  assert.ok(ts.includes('win32.join(programFiles, "NimbleNewt", "nn-launcher.exe")') && ps.includes("$ExeName = 'nn-launcher.exe'") && ps.includes("Join-Path $env:ProgramFiles 'NimbleNewt'"));
  assert.ok(ts.includes('win32.join(programData, "NimbleNewt", "native")') && ps.includes("Join-Path $DataDir 'native'") && ps.includes("Join-Path $env:ProgramData 'NimbleNewt'"));
  assert.ok(new RegExp(`DEFAULT_PROFILE_NAME = "${/\$ProfileName = '(\w+)'/.exec(ps)[1]}"`).test(plan), "the profile name default");
  assert.ok(ps.includes("[string] $Container = 'lpac'"));
});

test("uninstall removes what install made, from a manifest, and nothing it did not make", () => {
  const un = fn("Invoke-Uninstall");
  for (const part of ["$ManifestPath", "nimblenewt.native-install/1", "RemoveAll", "Remove-CimInstance", "Remove-LocalUser", "Get-Process -Name 'nn-launcher'", "$m.accountSid", "Assert-SafeItem $ManifestPath $false", "Assert-SafeItem $DataDir $true", "Test-SamePath $pair[0] $pair[1]", "Remove-TreeNoFollow $ControlDir"]) assert.ok(un.includes(part), part);
  // the manifest only confirms this run's own folders; it never supplies a path to remove
  for (const field of ["installDir", "dataDir", "controlDir", "launcher"]) assert.ok(un.includes(`@($m.${field}, `), `the manifest's ${field} is compared with this run's`);
  assert.ok(!/Remove-Item[^\n]*\$m\.|Delete\([^\n]*\$m\.|Remove-TreeNoFollow \$m\./.test(un), "nothing is removed by a path read from the manifest");
  // the control folder is closed to the account before it is walked, and the two top folders go only when empty
  assert.ok(un.indexOf("Set-Acl -LiteralPath $ControlDir") < un.indexOf("Remove-TreeNoFollow $ControlDir"));
  assert.ok(un.includes(".Count -eq 0) { [System.IO.Directory]::Delete($d, $false) }"));
  const walk = fn("Remove-TreeNoFollow");
  assert.ok(walk.indexOf("Test-Reparse $path") < walk.indexOf("Get-ChildItem") && /if \(Test-Reparse \$path\) \{\n\s+if \(\$isFolder\) \{ \[System\.IO\.Directory\]::Delete\(\$path, \$false\) \}[^\n]*\n\s+return/.test(walk), "a link is removed as the link and not descended into");
  assert.ok(/Assert-NimbleNewtPath \$InstallDir '-InstallDir'\nAssert-NimbleNewtPath \$DataDir '-DataDir'\nswitch \(\$Action\)/.test(ps), "the folder parameters are checked before any action");
  const made = fn("Invoke-Install");
  for (const part of ["New-LocalUser", "[NnLsa]::Add(", "Set-ProtectedAcl", "Copy-Item", "Set-Content -LiteralPath $EnvFile", "$manifest = [ordered]@"]) assert.ok(made.includes(part), part);
  // idempotent: the account and the launcher are checked before they are made or copied
  assert.ok(made.includes("if ($null -eq $existing)") && made.includes("-ne $hash) { Copy-Item"));
  assert.ok(fn("Invoke-Verify").includes("the entry list is exactly the expected one"));
});

test("second review: the account marker fits New-LocalUser, links are seen without being followed, a folder that inherits its parent's list is refused, and LSA code is compiled only when used", () => {
  // New-LocalUser -Description takes at most 48 characters; a longer marker would make Install fail at the account step, after its checks
  const marker = /^\$AccountMarker = '([^']*)'$/m.exec(ps)?.[1];
  assert.ok(marker !== undefined && marker.length > 10 && marker.length <= 48, `marker length ${marker?.length}`);
  // presence and link checks read the item's own attributes (a dangling link is present and a link); Test-Path and Get-Item follow links on 5.1
  assert.ok(/function Get-ItemAttributes\(\[string\] \$path\) \{\n\s+try \{ return \[System\.IO\.File\]::GetAttributes\(\$path\) \} catch \[System\.IO\.FileNotFoundException\], \[System\.IO\.DirectoryNotFoundException\] \{ return \$null \}/.test(ps), "absent only on not-found; every other failure is thrown");
  assert.match(ps, /function Test-Reparse\(\[string\] \$path\) \{ \$attrs = Get-ItemAttributes \$path;/);
  for (const name of ["Assert-SafeItem", "Set-ProtectedAcl", "Remove-TreeNoFollow", "Invoke-Uninstall"]) {
    assert.ok(!/Test-Path|Get-Item /.test(fn(name).replace(/Test-Path -LiteralPath \$ManifestPath/, "")), `${name} decides presence without following links`);
  }
  const safe = fn("Assert-SafeItem");
  assert.ok(/if \(\$folder -and -not \$acl\.AreAccessRulesProtected\) \{ throw/.test(safe), "a folder with its parent's list was not made by this script and is refused");
  assert.ok(safe.indexOf("Test-Reparse $path") < safe.indexOf("Get-Acl"), "the link check comes before the list is read");
  // Add-Type only inside Initialize-NnLsa, and each LSA call is preceded by it in the same block
  assert.equal(code.match(/\bAdd-Type\b/g).length, 1);
  assert.ok(fn("Initialize-NnLsa").includes("Add-Type -TypeDefinition"));
  const lines = code.split("\n");
  let calls = 0;
  lines.forEach((line, i) => {
    if (!/\[NnLsa\]::\w+\(/.test(line)) return;
    calls++;
    let j = i - 1;
    while (j > 0 && /\[NnLsa\]::\w+\(/.test(lines[j])) j--; // calls right after another LSA call share its Initialize-NnLsa
    assert.match(lines[j], /^\s*Initialize-NnLsa$/, `before: ${line.trim()}`);
  });
  assert.equal(calls, 4, "List, Add, Remove, RemoveAll");
  // the folder parameters: printable ASCII, and none of # ' ` = (node --env-file cuts an unquoted value at #), refused before any action
  const shape = fn("Assert-NimbleNewtPath");
  assert.ok(shape.includes("$path -notmatch '^[\\x20-\\x7E]+$'") && shape.includes(`[^:*?"<>|#''\`=]+$'`), shape);
  assert.ok(fn("Invoke-Install").includes(`'^[\\x21-\\x7E][\\x20-\\x7E]*$'`) && fn("Invoke-Install").includes(`'["=#''\`]'`), "worker.env values are checked again where they are written");
});

test("second review: the hosted installer step captures Verify's Write-Host lines, and the product build remaps the Windows form of its folders", () => {
  const wf = read(".github", "workflows", "windows-appcontainer-experiment.yml");
  assert.ok(/& \$shellExe @shellArgs -File \$f @scriptArgs \*> \$outFile/.test(wf), "Write-Host is the information stream in 5.1: 2>&1 alone captures nothing and the step would fail on a correct Verify");
  assert.ok(/function Say\(\[string\] \$text\) \{ Write-Host \$text \}/.test(ps), "the script prints with Write-Host (the reason for *>&1)");
  assert.ok(/crate_w="\$\(cygpath -w "\$PWD"\)"/.test(wf) && /--remap-path-prefix=\$crate_w=\/nn-launcher --remap-path-prefix=\$cargo_w=\/cargo -C link-arg=\/Brepro/.test(wf));
  assert.ok(!/--remap-path-prefix=\$PWD=/.test(wf), "a Git Bash path (/d/a/...) never matches the Windows paths rustc sees");
});

test("the installer's README states what is not proven, and the contribution guide accounts for the new files", () => {
  const readme = read("native", "install", "README.md");
  for (const phrase of ["NOT RUN", "Session 0", "S4U", "Windows Home", "service-units.ts", "virtual service account", "group-managed service account"]) assert.ok(readme.includes(phrase), phrase);
  const contributing = read("CONTRIBUTING.md");
  for (const file of ["native/nn-launcher/src/lib.rs", "native/nn-launcher/src/main.rs", "native/nn-launcher/src/win.rs", "native/nn-launcher/Cargo.toml", "native/install/Install-NimbleNewtLauncher.ps1", "experiments/windows-appcontainer/launcher/src/main.rs"]) assert.ok(contributing.includes(file), file);
});

/** The brackets of a PowerShell script, outside comments and strings (single-quoted with '' escapes, double-quoted with backtick escapes and $( ) inside, here-strings):
 *  the first mismatch as "line N: ...", or "" when every bracket closes in order. Not a full parser (the hosted run parses it with PowerShell's own); it catches what a Linux cell can. */
export function psBracketProblem(text) {
  const close = { ")": "(", "}": "{", "]": "[" };
  const stack = [];
  let line = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const skipTo = (end) => { const j = text.indexOf(end, i); if (j < 0) return false; line += text.slice(i, j).split("\n").length - 1; i = j + end.length - 1; return true; };
    if (c === "\n") { line++; continue; }
    if (text.startsWith("<#", i)) { if (!skipTo("#>")) return `line ${line}: unclosed block comment`; continue; }
    if ((text.startsWith("@'\n", i) || text.startsWith("@'\r\n", i))) { if (!skipTo("\n'@")) return `line ${line}: unclosed here-string`; continue; }
    if ((text.startsWith('@"\n', i) || text.startsWith('@"\r\n', i))) { if (!skipTo('\n"@')) return `line ${line}: unclosed here-string`; continue; }
    if (c === "#") { const j = text.indexOf("\n", i); i = (j < 0 ? text.length : j) - 1; continue; }
    if (c === "'") {
      let j = i + 1;
      for (;;) { if (j >= text.length) return `line ${line}: unclosed '-string`; if (text[j] === "'") { if (text[j + 1] === "'") { j += 2; continue; } break; } if (text[j] === "\n") line++; j++; }
      i = j; continue;
    }
    if (c === '"') {
      let j = i + 1; let depth = 0;
      for (;;) {
        if (j >= text.length) return `line ${line}: unclosed "-string`;
        if (text[j] === "`") { j += 2; continue; }
        if (text.startsWith("$(", j)) { depth++; j += 2; continue; }
        if (text[j] === ")" && depth > 0) { depth--; j++; continue; }
        if (text[j] === '"' && depth === 0) break;
        if (text[j] === "\n") line++;
        j++;
      }
      i = j; continue;
    }
    if (c === "(" || c === "{" || c === "[") stack.push([c, line]);
    else if (c in close) {
      const top = stack.pop();
      if (top === undefined || top[0] !== close[c]) return `line ${line}: '${c}' closes ${top === undefined ? "nothing" : `'${top[0]}' of line ${top[1]}`}`;
    }
  }
  return stack.length === 0 ? "" : `line ${stack.at(-1)[1]}: '${stack.at(-1)[0]}' is never closed`;
}

test("the installer's brackets and strings close in order (Linux cells cannot run PowerShell; the hosted run parses it with PowerShell itself)", () => {
  assert.equal(psBracketProblem(ps), "");
  // the checker itself: the slice-3 shape that closed a list before its last table, and a few others, are found
  assert.match(psBracketProblem("@(\n  @{ Why = 'a' }) })\n"), /closes '\{'|never closed|closes nothing/);
  assert.match(psBracketProblem("@{ Rules = @(\n  @{ Why = 'x') })\n)\n"), /line 2: '\)' closes '\{'/);
  assert.match(psBracketProblem("Say \"$($a\"\n"), /unclosed/);
  assert.equal(psBracketProblem("Say 'it''s (not a bracket'; Say \"x $(f ')') y\" # ) comment\n@'\n{ here\n'@\n"), "");
});

test("the installer uses Windows PowerShell 5.1 syntax only (no PowerShell 7 operators or parameters)", () => {
  const plain = code.replace(/@'\n[\s\S]*?\n'@/g, "").replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"`]|`.)*"/g, '""');
  for (const re of [/\?\?=?/, /\?\./, /&&/, /\|\|/, /\s\?\s[^\n]*\s:\s/, /-Parallel\b/, /-AsHashtable\b/, /-AsByteStream\b/, /\$PSStyle\b/, /\bclean\s*\{/, /-SkipCertificateCheck\b/]) assert.ok(!re.test(plain), `${re} is not Windows PowerShell 5.1`);
  assert.ok(ps.includes("[System.IO.Directory].GetMethod('CreateDirectory'"), "the .NET Framework call is used when it exists, the .NET one otherwise");
});

// ------------------------------------------------------------------------------------------------ -WhatIf safety (the owner's first real run on Windows PowerShell 5.1)

// Under -WhatIf, Windows PowerShell 5.1's own file-hash cmdlet printed 'What if: ... Retrieve the value for property ProviderPath' and returned nothing, and '.Hash' failed under StrictMode.
// Linux cannot run PowerShell, so these tests pin the shape of the repair: no such cmdlet, a .NET-only hash helper, and every read whose result is used goes through Invoke-Read.
const READ_CMDLETS = /\b(Get-Acl|Get-LocalUser|Get-LocalGroupMember|Get-LocalGroup|Get-AuthenticodeSignature|Get-ScheduledTask|Get-Content|Get-ChildItem|Get-Process|Get-Item|Test-Path|ConvertFrom-Json|Resolve-Path|Get-FileHash)\b/g;

test("the installer has no Get-FileHash anywhere (a PowerShell-written cmdlet honours -WhatIf inside its own steps on Windows PowerShell 5.1)", () => {
  assert.ok(!/Get-FileHash/.test(ps), "not even in a comment: the next reader must not add it back");
});

test("Get-Sha256Hex uses .NET only, disposes in finally, and is what every hash comparison calls", () => {
  const h = fn("Get-Sha256Hex");
  assert.match(ps, /\nfunction Get-Sha256Hex\(\[string\] \$Path\) \{/, "the helper exists under exactly this name");
  assert.match(ps, /\nfunction Invoke-Read\(\[scriptblock\] \$Block\) \{/, "Invoke-Read exists under exactly this name");
  assert.ok(h.includes("[System.IO.File]::OpenRead(") && h.includes("[System.Security.Cryptography.SHA256]::Create()") && h.includes(".ComputeHash("));
  const fin = h.slice(h.indexOf("finally {"));
  assert.ok(h.includes("finally {") && fin.includes("$stream.Dispose()") && fin.includes("$sha.Dispose()"), "the stream and the hash object are disposed in finally");
  assert.ok(h.includes("GetUnresolvedProviderPathFromPSPath"), "a relative path is resolved against the PowerShell location, with a .NET call");
  assert.ok(h.includes("ToString('X2')"), "upper-case hex: the manifest keeps the form Get-FileHash gave");
  // no cmdlet call of any kind in the helper except the one pipeline step that formats bytes
  const calls = [...h.replace(/ForEach-Object/g, "").matchAll(/\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/g)].map((m) => m[0]);
  assert.deepEqual(calls, [], "the helper calls no cmdlet");
  assert.ok((code.match(/Get-Sha256Hex \$/g) ?? []).length >= 4, "the source, the placed file, the re-hash and Verify all use it");
  assert.match(code, /\$hash -ne \$ExpectedSha256\.ToUpperInvariant\(\)/, "the comparison stays case-insensitive (-ne) with both sides upper-case");
});

test("Invoke-Read switches -WhatIf off inside its own scope, and every read-only cmdlet whose result is used runs inside it", () => {
  const r = fn("Invoke-Read");
  assert.match(r, /\$WhatIfPreference = \$false;\s*& \$Block/);
  const lines = code.split("\n");
  let seen = 0;
  for (const [n, line] of lines.entries()) {
    if (line.startsWith("function Invoke-Read")) continue;
    for (const m of line.matchAll(READ_CMDLETS)) {
      seen++;
      const open = line.lastIndexOf("Invoke-Read {", m.index);
      assert.ok(open >= 0, `line ${n}: ${m[0]} is not inside Invoke-Read: ${line.trim().slice(0, 120)}`);
      const between = line.slice(open + "Invoke-Read {".length, m.index);
      const depth = 1 + (between.match(/\{/g) ?? []).length - (between.match(/\}/g) ?? []).length;
      assert.ok(depth > 0, `line ${n}: ${m[0]} comes after its Invoke-Read block closed`);
    }
  }
  assert.ok(seen >= 20, `the scan saw the read calls (${seen})`);
});

test("everything that changes the machine stays inside a ShouldProcess question (so -WhatIf still changes nothing)", () => {
  const install = fn("Invoke-Install");
  for (const call of ["New-LocalUser", "Add-LocalGroupMember", "[NnLsa]::Add", "Set-ProtectedAcl", "Copy-Item", "Set-Content"]) {
    const at = install.indexOf(call);
    assert.ok(at > 0, call);
    assert.ok(install.lastIndexOf("$PSCmdlet.ShouldProcess(", at) > install.lastIndexOf("Get-Sha256Hex $LauncherPath"), `${call} follows a ShouldProcess question`);
  }
  for (const call of ["Remove-LocalUser", "[NnLsa]::RemoveAll", "Remove-TreeNoFollow", "Remove-Item"]) {
    const un = fn("Invoke-Uninstall");
    assert.ok(un.lastIndexOf("$PSCmdlet.ShouldProcess(", un.indexOf(call)) >= 0, call);
  }
});

test("the dry-run lines the hosted step requires are lines the installer really prints", () => {
  const wf = read(".github", "workflows", "windows-appcontainer-experiment.yml");
  const step = wf.slice(wf.indexOf("Installer script (parse"), wf.indexOf("G05 containment cases through the native backend"));
  const list = /\$mustSay = @\((.*)\)\n/.exec(step);
  assert.ok(list, "the list of required lines is in the step");
  const lines = [...list[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  assert.ok(lines.length >= 6);
  // the grant line is built from $RightsGranted, whose first entry is SeBatchLogonRight (pinned by the account-rights test)
  for (const l of lines) assert.ok(ps.includes(l.replace(/^What if: Performing the operation "/, "").replace("grant SeBatchLogonRight", "grant $($RightsGranted -join")), `the installer prints: ${l}`);
  assert.ok(ps.includes("$RightsGranted = @('SeBatchLogonRight')"));
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
  assert.ok(!product.replace("cargo test --locked --features experiment", "").includes("--features"), "the product build enables no feature (only the argument tests of the experiment build name one)");
  assert.ok(product.includes("cargo test --locked 2>&1") && product.indexOf("cargo build --release --locked") < product.indexOf("cargo test --locked"), "the argument tests run after the release build, so the tested release file is the built one");
  const installer = hosted.slice(at("Installer script (parse"), at("G05 containment cases through the native backend"));
  for (const part of ["Parser]::ParseFile", "'-WhatIf'", "'Verify'", "'-AllowUnsigned'", "if (Get-LocalUser -Name $account", "Test-Path (Join-Path $env:ProgramFiles 'NimbleNewt')", "Test-Path (Join-Path $env:ProgramData 'NimbleNewt')"]) assert.ok(installer.includes(part), part);
  assert.ok(!/'Uninstall'/.test(installer), "the hosted step never runs Uninstall");
  assert.match(installer, /\$common = @\('-Action', 'Install', '-ExpectedSha256', \$h, '-AllowUnsigned', '-WhatIf'\)/, "Install is only ever run with -WhatIf there");
  // the containment cases use the product binary, not the experiment's
  assert.match(hosted.slice(at("G05 containment cases through the native backend")), /NIMBLENEWT_WIN_LAUNCHER: [^\n]*native\\nn-launcher\\target\\release\\nn-launcher\.exe/);
});

test("the hosted installer step runs the owner's command under Windows PowerShell 5.1 AND PowerShell 7 with the real launcher and its hash, and fails on errors or changes", () => {
  const wf = read(".github", "workflows", "windows-appcontainer-experiment.yml");
  const hosted = wf.slice(wf.indexOf("  hosted:"), wf.indexOf("  own-runner:"));
  const from = hosted.indexOf("Installer script (parse");
  const step = hosted.slice(from, hosted.indexOf("G05 containment cases through the native backend"));
  const text = step.replace(/^\s*#.*$/gm, "");
  assert.ok(hosted.indexOf("id: build_product") < from, "after the product build, so the exe exists");
  assert.match(step, /shell: powershell\n/, "the step itself is Windows PowerShell 5.1");
  assert.match(step, /\n\s+if: always\(\)\n/);
  assert.ok(!/continue-on-error/.test(step), "a gate for this check: the step is allowed to fail the job");
  // the same file the release record names, its hash, the owner's relative path
  assert.ok(text.includes("native\\nn-launcher\\target\\release\\nn-launcher.exe") && text.includes("ComputeHash") && text.includes("ReadAllBytes"));
  assert.ok(text.includes("'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass')") && text.includes("'pwsh' @('-NoProfile', '-ExecutionPolicy', 'Bypass')"), "both shells, started as a program with -ExecutionPolicy Bypass");
  assert.ok(text.includes("-File $f @scriptArgs"), "with -File, as the owner ran it");
  assert.ok(text.includes("'-LauncherPath', '.\\nn-launcher.exe'") && text.includes("'-LauncherPath', (Join-Path $tmp 'nn-launcher.exe')"), "the real -LauncherPath: relative under 5.1, full under pwsh");
  assert.ok(text.includes("'-ExpectedSha256', $h") && text.includes("'-AllowUnsigned', '-WhatIf'"));
  assert.ok(text.includes("Assert-Dry $r51") && text.includes("Assert-Dry $r7"), "both results are checked");
  // what is checked: exit code, required lines, forbidden text, nothing made
  for (const part of ["$r.Code -ne 0", "$mustSay", "$mustNot", "PropertyNotFound", "Retrieve the value for property", "Assert-Untouched $label", "Assert-Untouched 'before the dry run'", "Assert-Untouched 'after Verify'", "$account = 'nimblenewt-worker'"]) assert.ok(text.includes(part), part);
  assert.ok(text.includes("(@('-Action', 'Verify') + $extra)") && text.includes("foreach ($extra in @(@(), @('-WhatIf')))"), "Verify runs under 5.1 plainly and with -WhatIf");
  assert.ok(text.includes("-Action', 'Install'") && !/'Uninstall'/.test(text));
  // read-only checks of what exists afterwards (no cmdlet that changes anything)
  assert.ok(!/\b(New|Set|Remove|Add|Register|Start|Stop)-[A-Z]\w+/.test(text.replace(/New-Item -ItemType Directory -Path \$tmp -Force|Set-Location|Push-Location|Pop-Location/g, "")), "the step changes nothing but its own temporary folder");
  // action pins and permissions are untouched by this step
  assert.ok(!/uses:/.test(step));
});

test("verify started through a link still checks the file (a link once made the command a silent no-op that ended 0)", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nn-nl-"));
  try {
    const link = join(dir, "native-launcher.mjs");
    // a file link needs Developer Mode or an administrator on Windows; without it there is nothing to test there
    try { symlinkSync(join(root, "scripts", "native-launcher.mjs"), link); } catch (error) { if (process.platform === "win32" && error.code === "EPERM") { t.skip("no file links here"); return; } throw error; }
    const file = join(dir, "nn-launcher.exe");
    writeFileSync(file, "MZ pretend executable");
    const record = join(dir, "record.json");
    writeFileSync(record, JSON.stringify(makeRecord({ fileName: file, bytes: Buffer.from("MZ another executable"), commit: COMMIT })));
    const bad = spawnSync(process.execPath, [link, "verify", "--file", file, "--record", record], { encoding: "utf8" });
    assert.equal(bad.status, 1, `${bad.stdout}${bad.stderr}`);
    assert.match(bad.stderr, /SHA-256/);
    const missing = spawnSync(process.execPath, [link, "verify", "--file", file, "--record", join(dir, "none.json")], { encoding: "utf8" });
    assert.equal(missing.status, 2);
    writeFileSync(record, JSON.stringify(makeRecord({ fileName: file, bytes: readFileSync(file), commit: COMMIT })));
    const good = spawnSync(process.execPath, [link, "verify", "--file", file, "--record", record], { encoding: "utf8" });
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /matches the record/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the hosted product-launcher step and the own-runner info step both require the private window station to be made (Session 0 fix)", () => {
  const wf = read(".github", "workflows", "windows-appcontainer-experiment.yml");
  const hosted = wf.slice(wf.indexOf('- name: "Product launcher (native/nn-launcher)'), wf.indexOf("node ../../scripts/native-launcher.mjs record"));
  const ownAt = wf.indexOf("- name: Product launcher info as the runner service");
  const own = wf.slice(ownAt, wf.indexOf("\n      - name:", ownAt + 10));
  for (const [name, text] of [["hosted", hosted], ["own runner", own]]) {
    assert.ok(text.length > 200, name);
    assert.ok(text.includes(`grep -q '"windowStation":"private"'`), `${name}: the product names the private station`);
    assert.ok(text.includes(`grep -q '"windowStationOk":true'`), `${name}: a private station was made and closed`);
    // the per-run profile `info` made is reported deleted and gone (README: info prints profileDeleted and profileGone)
    assert.ok(text.includes("profileDeleted") && text.includes("profileGone"), `${name}: the throw-away profile is checked deleted and gone`);
  }
  const hostedStep = wf.slice(wf.indexOf('- name: "Product launcher (native/nn-launcher)'), wf.indexOf("# Card A03b reproducibility"));
  assert.ok(hostedStep.indexOf('echo "sha256=$(sha256sum') > 0 && hostedStep.indexOf('echo "sha256=$(sha256sum') < hostedStep.indexOf('exit "$profile_bad"'), "the hosted step reports a profile miss only after the release record and hash output");
});

test("no product-launcher call in the workflow uses a fixed profile name: each takes a fresh NimbleNewtRun-<16 hex> name, its record file, and delete-profile also its SID", () => {
  const wf = read(".github", "workflows", "windows-appcontainer-experiment.yml");
  const code = wf.replace(/^\s*#.*$/gm, "");
  // the product refuses any other name (native/nn-launcher/src/args.rs), so a fixed name is a call that exits 125
  assert.ok(!/NimbleNewtProductCheck|NimbleNewtOwnRunnerG05|NimbleNewtAgent|NIMBLENEWT_WIN_PROFILE/.test(code), "no fixed product profile name is left");
  const gen = /([a-z_]+)="NimbleNewtRun-\$\(node -e "process\.stdout\.write\(require\('crypto'\)\.randomBytes\(8\)\.toString\('hex'\)\)"\)"/g;
  const generated = [...code.matchAll(gen)].map((m) => m[1]);
  assert.deepEqual(generated, ["info_name", "info_name"], "the name is generated (8 random bytes, 16 hex digits) in the hosted and in the own-runner info step");
  // every line that starts the product launcher with a profile command (the `dump` refusal check has no profile)
  const calls = code.split("\n").filter((l) => /(nn-launcher\.exe"?|"\$prod") +(run|check|revoke|info|delete-profile)\b/.test(l));
  assert.equal(calls.length, 3, calls.join("\n")); // hosted info, own-runner info, clean-up delete-profile
  for (const l of calls) {
    assert.ok(!/--name +[A-Za-z]/.test(l) && /--name "\$(info_name|pname)"/.test(l), `the name comes from a variable: ${l.trim()}`);
    const cmd = /(run|check|revoke|info|delete-profile)\b/.exec(l.slice(l.indexOf("nn-launcher.exe") >= 0 ? l.indexOf("nn-launcher.exe") : l.indexOf("$prod")))[1];
    if (["run", "info", "delete-profile"].includes(cmd)) assert.match(l, /--profile-record /, `${cmd} needs its record file`);
    if (cmd === "delete-profile") assert.match(l, /--sid "\$psid"/, "delete-profile needs the recorded SID");
    else assert.ok(!/--sid/.test(l), `${cmd} takes no --sid`);
  }
  // the launcher's own rule, read from its source: the same pattern the workflow generates
  const args = read("native", "nn-launcher", "src", "args.rs");
  assert.match(args, /--name must be \{\}<\{\} lower-case hex digits>/);
  assert.match(read("native", "nn-launcher", "src", "profile.rs"), /RUN_PREFIX: &str = "NimbleNewtRun-"[^]*RUN_HEX_LEN: usize = 16/);
  // the record folder exists before the first use (the launcher creates the file, never the folder)
  assert.equal((code.match(/mkdir -p "\$RUNNER_TEMP\/profile-records"/g) ?? []).length, 2);
});
