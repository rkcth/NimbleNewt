// Card A03b: the standard-account probe (native/install/Probe-NimbleNewtWorker.ps1, plan 12.3). Linux cells cannot run PowerShell, so these tests read the script as text and pin its shape:
// what it refuses, that it registers and removes exactly one task by its exact name, that its task text is an S4U, least-privilege, password-free, trigger-free Task Scheduler document in the
// schema's order, that every read cmdlet runs inside Invoke-Read (the owner's first real run on Windows PowerShell 5.1 showed -WhatIf silencing a read), that the launcher calls use flags the
// launcher's own argument parser accepts, and that the hosted workflow parses the script and runs its -WhatIf path with a made-up manifest. What the script DOES on Windows is judged only by a real run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { psBracketProblem } from "./ps-brackets.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8").replace(/\r\n/g, "\n");
const ps = read("native", "install", "Probe-NimbleNewtWorker.ps1");
const installer = read("native", "install", "Install-NimbleNewtLauncher.ps1");

// the program the task runs (a here-string inside Get-InnerScriptText) and the rest of the file
const innerStart = ps.indexOf("return @'\n", ps.indexOf("function Get-InnerScriptText")) + "return @'\n".length;
const innerEnd = ps.indexOf("\n'@", innerStart);
const inner = ps.slice(innerStart, innerEnd);
const outerWhole = ps.slice(0, innerStart) + ps.slice(innerEnd);
const stripComments = (t) => t.replace(/<#[\s\S]*?#>/, "").split("\n").filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s#\s.*$/, "")).join("\n");
const outer = stripComments(outerWhole);
const fnText = (name) => { const a = ps.indexOf(`function ${name}`); assert.ok(a >= 0, name); const ends = [ps.indexOf("\nfunction ", a + 5), ps.indexOf("\n# ----", a + 5), ps.indexOf("\n$script:", a + 5)].filter((x) => x > 0); return ps.slice(a, Math.min(...ends)); };

// ------------------------------------------------------------------------------------------------ shape

test("the script exists, is plain ASCII, and its inner program is separate and ASCII too", () => {
  assert.ok(ps.length > 5000 && inner.length > 2000);
  assert.ok(!/[^\x00-\x7f]/.test(ps), "ASCII only (the inner program is written with the ASCII encoding)");
  assert.ok(!inner.split("\n").some((l) => l === "'@"), "the inner program cannot end its own here-string");
  assert.match(ps, /\[CmdletBinding\(SupportsShouldProcess = \$true, ConfirmImpact = 'High'\)\]/, "-WhatIf and one question");
  assert.ok(ps.includes("Set-StrictMode -Version 3") && inner.includes("Set-StrictMode -Version 3"));
  assert.match(ps, /\$TaskName = 'NimbleNewtProbe'/);
});

test("brackets and strings close in order, in the script and in the inner program", () => {
  assert.equal(psBracketProblem(ps), "");
  assert.equal(psBracketProblem(inner + "\n"), "");
});

test("Windows PowerShell 5.1 syntax only", () => {
  for (const [name, text] of [["script", outer], ["inner", stripComments(inner)]]) {
    const plain = text.replace(/@'\n[\s\S]*?\n'@/g, "").replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"`]|`.)*"/g, '""');
    for (const re of [/\?\?=?/, /\?\./, /&&/, /\|\|/, /\s\?\s[^\n]*\s:\s/, /-Parallel\b/, /-AsHashtable\b/, /-AsByteStream\b/, /-AsPlainText\b/, /\$PSStyle\b/, /\bclean\s*\{/, /-SkipCertificateCheck\b/]) assert.ok(!re.test(plain), `${name}: ${re} is not Windows PowerShell 5.1`);
  }
});

test("no variable is assigned under the name of an automatic variable (a PowerShell trap: $profile, $switch, $args, $input, $matches, $error, $host)", () => {
  for (const text of [outer.replace(/@'\n[\s\S]*?\n'@/g, ""), stripComments(inner)]) assert.ok(!/\$(profile|switch|args|input|matches|error|host|event|pid|home|foreach|this|true|false|null)\s*=[^=]/i.test(text));
});

test("no '$name:' followed by a non-name character in any PowerShell text here (PowerShell reads it as a drive-qualified variable and the WHOLE script fails to parse)", () => {
  // e.g. "(stage $stage: $err)" is a parse error ("Variable reference is not valid. ':' was not followed by a valid variable name character"); write $($stage): instead
  const bad = /\$[A-Za-z_][A-Za-z0-9_]*:(?![A-Za-z0-9_{])/;
  for (const [name, text] of [["probe", ps], ["installer", installer]]) {
    const lines = text.split("\n").filter((l) => !/^\s*#/.test(l) && bad.test(l.replace(/'(?:[^']|'')*'/g, "''")));
    assert.deepEqual(lines, [], name);
  }
  assert.ok(bad.test('"(stage $stage: $err)"') && !bad.test('"(stage $($stage): $err)"') && !bad.test("$env:COMPUTERNAME") && !bad.test("$script:Exit"));
});

// ------------------------------------------------------------------------------------------------ no password, no work-around

test("no password is asked for, stored or passed: no password parameter, no secure string, no credential, no schtasks", () => {
  for (const [name, text] of [["script", ps], ["inner", inner]]) {
    for (const re of [/-Password\b/i, /ConvertTo-SecureString/i, /SecureString/i, /Credential/i, /schtasks/i, /\/RU\b/, /\/RP\b/, /-User\b/, /-LogonType\b/, /-RunLevel\b/, /Get-Credential/i, /-AsPlainText/i, /runas\b/i, /\bnet user\b/i, /cmdkey/i]) assert.ok(!re.test(text), `${name}: ${re}`);
  }
  assert.ok(!/<Password|<GroupId|<RequiredPrivileges|InteractiveToken|HighestAvailable|<Triggers|Trigger>/.test(ps.slice(ps.indexOf("function New-ProbeTaskXml"), ps.indexOf("function Get-InnerScriptText"))), "the task text has none of these");
  assert.ok(!/Get-FileHash/.test(ps), "no file-hash cmdlet anywhere (a PowerShell-written cmdlet honours -WhatIf in its own steps on Windows PowerShell 5.1)");
  assert.match(fnText("Get-Sha256HexOfBytes"), /SHA256\]::Create\(\)[\s\S]*ComputeHash\(\$Bytes\)[\s\S]*finally \{ \$sha\.Dispose\(\)/);
});

test("a refused registration is reported as outcome (c), with the message, and never retried or worked around", () => {
  const reg = outer.match(/Register-ScheduledTask[^\n]*/g) ?? [];
  assert.equal(reg.length, 1, "one registration call");
  assert.match(reg[0], /Register-ScheduledTask -TaskName \$TaskName -TaskPath '\\' -Xml \$xml -Force:\$false/);
  assert.match(outer, /catch \{ \$registerError = \$_\.Exception\.Message \}/);
  assert.match(fnText("Get-Verdict"), /\(c\) registration refused[\s\S]*No password was supplied or stored/);
  assert.ok(!/Register-ScheduledTask[^\n]*\|\s*Out-Null[^\n]*catch[^\n]*Register-ScheduledTask/.test(outer));
});

test("exactly one task is touched, by its exact name: no wildcard, no other scheduled-task cmdlet, and the COM calls name the same constant", () => {
  const verbs = new Set([...outer.matchAll(/\b([A-Z][a-z]+)-ScheduledTask(Info)?\b/g)].map((m) => m[0]));
  assert.deepEqual([...verbs].sort(), ["Get-ScheduledTask", "Register-ScheduledTask", "Start-ScheduledTask"]);
  for (const m of outer.matchAll(/\$taskFolder\.(GetTask|DeleteTask|RegisterTask\w*|GetTasks|DeleteFolder)\(([^)]*)\)/g)) {
    assert.ok(["GetTask", "DeleteTask"].includes(m[1]), `only GetTask and DeleteTask on the folder: ${m[0]}`);
    assert.ok(m[2] === "$TaskName" || m[2] === "$TaskName, 0", `by the constant: ${m[0]}`);
  }
  assert.equal((outer.match(/\$taskFolder\.DeleteTask\(/g) ?? []).length, 1, "one removal call");
  assert.match(outer, /\$taskFolder = \$service\.GetFolder\('\\'\)/, "the root folder, where the task is registered");
  for (const line of outer.split("\n")) {
    if (!/-ScheduledTask\b|-ScheduledTaskInfo\b/.test(line)) continue;
    assert.ok(line.includes("-TaskName $TaskName"), `names the task by the constant: ${line.trim().slice(0, 100)}`);
    assert.ok(!/[*?]/.test(line.replace(/'(?:[^']|'')*'/g, "''")), `no wildcard: ${line.trim().slice(0, 100)}`);
  }
  assert.ok(!/\$TaskName\s*=[^=]/.test(outer.replace(/\$TaskName = 'NimbleNewtProbe'/, "")), "the name is assigned once, as a constant");
});

// the clean-up block (the finally of the try that does the work)
const finallyBody = () => {
  const stopped = outer.indexOf("Stopped by an error");
  const fin = outer.indexOf("} finally {", stopped);
  assert.ok(stopped > 0 && fin > stopped && fin - stopped < 300, "the finally right after the work's catch");
  let depth = 1; let i = fin + "} finally {".length;
  for (; i < outer.length && depth > 0; i++) { if (outer[i] === "{") depth++; else if (outer[i] === "}") depth--; }
  return outer.slice(fin + "} finally {".length, i - 1);
};

test("the task is removed in a finally block, only when this run tried to register it and the task's text names this run; an existing task of that name is refused, not touched", () => {
  const f = finallyBody();
  assert.ok(f.includes("$taskFolder.DeleteTask($TaskName, 0)"));
  assert.match(f, /if \(\$registerAttempted -and \$null -ne \$taskFolder\)/, "only a task this run tried to register");
  assert.match(f, /elseif \(-not \(\[string\]\$own\.Xml\)\.Contains\(\$runName\)\)[^\n]*\n[^\n]*left alone/, "a task whose text does not carry this run's random name is left alone");
  assert.ok(f.indexOf(".Contains($runName)") < f.indexOf("DeleteTask"), "the ownership check comes before the removal");
  assert.match(f, /if \(\[int\]\$own\.State -eq 4\) \{ \$own\.Stop\(0\) \}/, "a running task is stopped first");
  assert.match(f, /\$unregistered = \(\$null -eq \$own\) -and \(\$lookup -eq ''\)/, "removed means: read back and not found");
  assert.match(f, /GetBaseException\(\)\.HResult -ne \$HrFileNotFound/, "only 'not found' counts as gone; another failure is reported");
  assert.match(ps, /\$HrFileNotFound = -2147024894/);
  assert.equal(0x80070002 - 2 ** 32, -2147024894);
  // the flag is set BEFORE the registration call (a stop right after the call still removes the task)
  const reg = outer.indexOf("Register-ScheduledTask -TaskName");
  const flag = outer.indexOf("$registerAttempted = $true");
  assert.ok(flag > 0 && flag < reg && reg - flag < 200, "registerAttempted is set just before Register-ScheduledTask");
  const ctx = fnText("Get-Context");
  assert.match(ctx, /Get-ScheduledTask -TaskPath '\\' -TaskName \$TaskName[\s\S]*A task named \$TaskName already exists\. It is not touched/);
  // the files: only by exact name; the result file is kept
  for (const v of ["$innerPath", "$tmpPath", "$recordPath", "$profilesPath"]) assert.ok(f.includes(v), v);
  assert.ok(!/Remove-Item|-Recurse|Directory\]::Delete\([^)]*\$true/.test(outer), "no recursive or wildcard removal");
  assert.ok(!f.includes("$resultPath"), "probe-result.json is kept");
  assert.match(f, /if \(-not \$profilesExisted\) \{/, "the profiles folder (the backend's too) is removed only if this run made it");
  assert.ok(outer.indexOf("$profilesExisted = Test-Present $profilesPath") < outer.indexOf("if ($PSCmdlet.ShouldProcess("), "read before anything is made");
  assert.match(f, /if \(-not \$finished\) \{ \[Console\]::WriteLine\(/, "a stopped run still says what the clean-up did, without the pipeline");
});

test("the clean-up survives Ctrl+C: no cmdlet, no call of the script's own functions and no pipeline inside the finally block (PowerShell stops the pipeline; output there can end the block)", () => {
  const f = finallyBody();
  const code = f.split("\n").map((l) => l.replace(/^\s*#.*$/, "")).join("\n").replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"`]|`.)*"/g, '""');
  assert.ok(!/\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/.test(code), `no cmdlet: ${code.match(/\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/)?.[0]}`);
  const own = [...ps.matchAll(/^function ([A-Za-z-]+)/gm)].map((m) => m[1]);
  assert.ok(own.length > 10);
  for (const name of own) assert.ok(!new RegExp(`(^|[\\s(;{])${name}\\b`).test(code), `no call of the script's own function ${name}`);
  assert.ok(!/\|(?!\|)/.test(code.replace(/-join/g, "")), "no pipeline");
  assert.ok(!/@\(/.test(code), "no array subexpression (its contents run as a pipeline)");
  // and every step has its own try, so one failure does not skip the next
  for (const step of ["$own.Stop(0)", "$taskFolder.DeleteTask(", "[System.IO.File]::Delete($innerPath)", "[System.IO.File]::Delete($tmpPath)", "[System.IO.File]::Delete($recordPath)", "[System.IO.Directory]::Delete($profilesPath, $false)"]) {
    const at = code.indexOf(step); assert.ok(at > 0, step);
    assert.ok(code.lastIndexOf("try {", at) > code.lastIndexOf("}", at - 1) - 40 && at - code.lastIndexOf("try {", at) < 60, `${step} is inside its own try`);
  }
});

test("the clean-up has no loop statement: every loop turn checks for Ctrl+C, so a loop in the finally would end the block at its first turn after Ctrl+C", () => {
  const f = finallyBody();
  const code = f.split("\n").map((l) => l.replace(/^\s*#.*$/, "")).join("\n").replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"`]|`.)*"/g, '""');
  const loop = /(^|[\s;{}])(foreach|for|while|do)\s*[({]/i;
  assert.ok(!loop.test(code), `no loop: ${code.match(loop)?.[0]}`);
  assert.ok(!/\.ForEach\(|\.Where\(|%\s*\{/.test(code), "no ForEach()/Where() method or % alias");
  for (const v of ["$innerPath", "$tmpPath", "$recordPath"]) assert.ok(code.includes(`[System.IO.File]::Delete(${v})`), v);
  assert.equal((code.match(/GetAttributes\(\$recordPath\)/g) ?? []).length, 2, "the record is read back after its removal, and before it is named as kept");
  const keptAt = f.indexOf("(kept: the profile");
  assert.ok(keptAt > 0 && f.lastIndexOf("if (-not $gone)", keptAt) > f.lastIndexOf("} else {", keptAt), "the record is named as kept only when it is there");
});

test("every variable the clean-up reads is given a value before the work starts, or inside the clean-up before it is read (StrictMode 3 and Ctrl+C at any point)", () => {
  const f = finallyBody();
  const code = f.split("\n").map((l) => l.replace(/^\s*#.*$/, "")).join("\n");
  const q = outer.indexOf("if ($PSCmdlet.ShouldProcess(");
  const work = outer.indexOf("\n  try {", q);
  assert.ok(q > 0 && work > q && work - q < 600);
  const before = outer.slice(0, work);
  const automatic = new Set(["_", "null", "true", "false"]);
  // braces counted with string contents blanked (same length, so positions agree)
  const blank = code.replace(/'(?:[^']|'')*'|"(?:[^"`]|`.)*"/g, (s) => s[0] + " ".repeat(s.length - 2) + s[0]);
  const block = (at) => { // the innermost { ... } around position `at` (the whole block when none)
    let depth = 0; let start = -1;
    for (let i = at - 1; i >= 0; i--) { if (blank[i] === "}") depth++; else if (blank[i] === "{") { if (depth === 0) { start = i; break; } depth--; } }
    if (start < 0) return [0, blank.length];
    depth = 0;
    for (let i = start; i < blank.length; i++) { if (blank[i] === "{") depth++; else if (blank[i] === "}" && --depth === 0) return [start, i]; }
    return [start, blank.length];
  };
  const used = new Set([...code.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)(?!:)/g)].map((m) => m[1]));
  assert.ok(used.size > 10, [...used].join(","));
  for (const v of used) {
    if (automatic.has(v.toLowerCase())) continue;
    if (new RegExp(`(^|\\n)\\$${v}\\s*=[^=]`).test(before)) continue;
    // otherwise every read must follow an assignment in the clean-up whose own block also holds the read (an assignment on one branch does not cover a read on another)
    const assigns = [...blank.matchAll(new RegExp(`\\$${v}\\s*=(?!=)`, "g"))].map((m) => m.index);
    for (const u of [...blank.matchAll(new RegExp(`\\$${v}\\b(?!\\s*=[^=])`, "g"))].map((m) => m.index)) {
      const covered = assigns.some((a) => { if (a >= u) return false; const [s, e] = block(a); return u > s && u < e; });
      assert.ok(covered, `$${v} is read in the clean-up (at ${JSON.stringify(code.slice(u, u + 60))}) without a value given before the work starts or on the same path`);
    }
  }
});

test("every change to the machine is after the ShouldProcess question, so -WhatIf and a declined question change nothing", () => {
  const scan = outer.replace(/function Remove-OwnFile[\s\S]*?\n\}\n/, "");
  const q = scan.indexOf("if ($PSCmdlet.ShouldProcess(");
  assert.ok(q > 0);
  for (const call of ["Register-ScheduledTask", "Start-ScheduledTask", "Stop-ScheduledTask", "Unregister-ScheduledTask", "[System.IO.File]::Open(", "Remove-OwnFile", "[System.IO.Directory]::Delete(", "[System.IO.FileMode]::CreateNew", "[System.IO.File]::Delete("]) {
    const at = scan.indexOf(call);
    assert.ok(at > q || at < 0, `${call} at ${at} comes after the question at ${q}`);
  }
  assert.ok(scan.indexOf("Remove-OwnFile") > q, "the helper is only called after the question");
  assert.match(outer, /if \(-not \$ran\) \{[\s\S]*Nothing was registered or written[\s\S]*exit 0/);
  assert.match(outer, /if \(\$WhatIfPreference\) \{ Say 'The task text that would be registered/, "-WhatIf prints the task text");
});

// ------------------------------------------------------------------------------------------------ refusals

test("it refuses unless elevated, the manifest is the installer's, the account is the installer's and NOT in Administrators, the launcher matches its hash, and the control folder exists", () => {
  const ctx = fnText("Get-Context");
  for (const part of ["Test-Admin", "The manifest is not one the installer wrote", "does not have the hash the manifest recorded", "does not exist", "$AccountMarker", "-ne $ManifestSchema"]) assert.ok(ctx.includes(part), part);
  assert.match(ps, /\$SidAdmins = 'S-1-5-32-544'/);
  assert.match(ctx, /Invoke-Read \{ Get-LocalGroupMember -SID \$SidAdmins \}[\s\S]*is a member of Administrators: this probe is only meaningful for a standard account/);
  // the orphaned-SID fault of Get-LocalGroupMember on 5.1: a second, independent reading of the account's own groups; either naming Administrators refuses; both unreadable refuses
  assert.match(ctx, /\$sids = Get-AccountGroupSids \$account[\s\S]*if \(\$sids -contains \$SidAdmins\) \{ throw "The account '\$account' is a member of Administrators/);
  assert.match(ctx, /if \(\$readings -eq 0\) \{ throw "Could not read the Administrators group or the account's groups/, "unreadable fails closed");
  assert.equal((ctx.match(/\$readings\+\+/g) ?? []).length, 2);
  for (const c of ctx.match(/\} catch \{ if \(\$_\.Exception\.Message -like '\*is a member of Administrators\*'\) \{ throw \}/g) ?? []) assert.ok(c);
  assert.equal((ctx.match(/\} catch \{ if \(\$_\.Exception\.Message -like '\*is a member of Administrators\*'\) \{ throw \}/g) ?? []).length, 2, "a membership found is re-thrown, never swallowed as an unreadable group");
  assert.ok(ctx.indexOf("$readings++", ctx.indexOf("Get-LocalGroupMember")) < ctx.indexOf("foreach ($a in $admins)"), "a reading counts only after the call returned");
  const g = fnText("Get-AccountGroupSids");
  assert.match(g, /\[ADSI\]\('WinNT:\/\/' \+ \$env:COMPUTERNAME \+ '\/' \+ \$Account \+ ',user'\)/);
  assert.match(g, /psbase\.Invoke\('Groups'\)[\s\S]*InvokeMember\('objectSid', 'GetProperty'[\s\S]*SecurityIdentifier\]::new\(\$bytes, 0\)\.Value/);
  assert.match(ctx, /if \(-not \$testMode -and \$PSVersionTable\.PSEdition -ne 'Desktop'\) \{ throw 'Run this probe from Windows PowerShell 5\.1/, "the .NET Framework file call needs Windows PowerShell");
  assert.match(ctx, /Test-Reparse \$ManifestPath[\s\S]*Test-Reparse \$control[\s\S]*Test-Reparse \$launcher/, "links are refused");
  assert.ok(ctx.indexOf("is a member of Administrators") < ctx.indexOf("A task named"), "the account checks come before the task check");
  assert.match(outer, /try \{ \$ctx = Get-Context \} catch \{[^\n]*REFUSED:[^\n]*exit 2 \}/, "a refusal says nothing was changed and exits 2");
  // the manifest keys the probe reads are the ones the installer writes
  const written = installer.slice(installer.indexOf("$manifest = [ordered]@{"), installer.indexOf("$manifest | ConvertTo-Json"));
  for (const key of ["schema", "account", "accountSid", "installDir", "dataDir", "controlDir", "launcher", "launcherSha256"]) { assert.ok(written.includes(`${key} =`), `installer writes ${key}`); assert.ok(ctx.includes(`'${key}'`), `probe reads ${key}`); }
  assert.ok(installer.includes("$ManifestSchema") || installer.includes("'nimblenewt.native-install/1'"));
  assert.ok(ps.includes("$ManifestSchema = 'nimblenewt.native-install/1'") && ps.includes("$AccountMarker = 'NimbleNewt launcher account (installer-made)'") && installer.includes("$AccountMarker = 'NimbleNewt launcher account (installer-made)'"));
  assert.match(ctx, /\$script:ControlBound[\s\S]*ordinary full local path/);
});

test("the two overrides (-ManifestPath, -ControlDir) are refused without -WhatIf and switch the account checks off only with it", () => {
  const ctx = fnText("Get-Context");
  assert.match(ctx, /if \(\$script:OverrideUsed\) \{ if \(-not \$WhatIfPreference\) \{ throw '-ManifestPath and -ControlDir are test options and are only accepted together with -WhatIf\.' \}; \$testMode = \$true \}/);
  assert.match(ctx, /if \(-not \$testMode -and -not \(Test-Admin\)\)/);
  assert.match(ctx, /if \(\$testMode\) \{ Say[^\n]*not checked\)' \}\s*else \{/);
  assert.match(ps, /\$script:OverrideUsed = \$PSBoundParameters\.ContainsKey\('ManifestPath'\) -or \$script:ControlBound/);
  assert.ok(ps.indexOf("$script:OverrideUsed =") < ps.indexOf("$ctx = Get-Context"));
});

// ------------------------------------------------------------------------------------------------ the task text

const SAMPLE = { "@@DESCRIPTION@@": "probe & co", "@@USER@@": "BOX\\nimblenewt-worker", "@@COMMAND@@": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "@@ARGUMENTS@@": '-NoProfile -File "C:\\ProgramData\\NimbleNewt\\native\\probe-inner.ps1" -RunName NimbleNewtRun-0123456789abcdef' };
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
function template() {
  const f = fnText("New-ProbeTaskXml");
  const a = f.indexOf("$t = @'\n") + "$t = @'\n".length;
  return f.slice(a, f.indexOf("\n'@", a));
}
const task = () => { let t = template(); for (const [k, v] of Object.entries(SAMPLE)) t = t.replace(k, esc(v)); return t + "\n"; };

function parseXml(xml) {
  const stack = []; let rootEl; let i = 0;
  const decl = /^<\?xml version="1\.0" encoding="UTF-16"\?>\n/.exec(xml);
  assert.ok(decl, "an XML declaration first");
  i = decl[0].length;
  while (i < xml.length) {
    if (xml[i] === "<") {
      const e = xml.indexOf(">", i); assert.ok(e > 0, "tag closed");
      const tag = xml.slice(i + 1, e);
      if (tag.startsWith("/")) { const top = stack.pop(); assert.ok(top !== undefined && top.name === tag.slice(1), `closing ${tag} does not match ${top?.name}`); }
      else {
        const m = /^([A-Za-z][A-Za-z0-9]*)((?:\s+[A-Za-z:]+="[^"<]*")*)\s*\/?$/.exec(tag); assert.ok(m, `bad tag <${tag}>`);
        const attrs = {}; for (const a of (m[2] ?? "").matchAll(/\s+([A-Za-z:]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
        const el = { name: m[1], attrs, children: [], text: "" };
        const parent = stack.at(-1);
        if (parent === undefined) { assert.equal(rootEl, undefined, "one root"); rootEl = el; } else parent.children.push(el);
        if (!tag.endsWith("/")) stack.push(el);
      }
      i = e + 1;
    } else {
      const e = xml.indexOf("<", i); const t = xml.slice(i, e < 0 ? undefined : e);
      assert.ok(!/>/.test(t.replace(/&gt;/g, "")) && !/&(?!(amp|lt|gt|quot|apos);)/.test(t), `unescaped text ${JSON.stringify(t)}`);
      const top = stack.at(-1);
      if (top !== undefined) top.text += t.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"); else assert.ok(t.trim() === "", "no text outside the root");
      i = e < 0 ? xml.length : e;
    }
  }
  assert.equal(stack.length, 0, "every element closed");
  return rootEl;
}
const child = (e, name) => { const c = e.children.filter((x) => x.name === name); assert.equal(c.length, 1, `${e.name} has exactly one ${name}`); return c[0]; };
const names = (e) => e.children.map((c) => c.name);
const XSD = {
  task: ["RegistrationInfo", "Triggers", "Settings", "Data", "Principals", "Actions"],
  principal: ["UserId", "LogonType", "GroupId", "DisplayName", "RunLevel", "ProcessTokenSidType", "RequiredPrivileges"],
  settings: ["AllowStartOnDemand", "RestartOnFailure", "MultipleInstancesPolicy", "DisallowStartIfOnBatteries", "StopIfGoingOnBatteries", "AllowHardTerminate", "StartWhenAvailable", "NetworkProfileName", "RunOnlyIfNetworkAvailable", "WakeToRun", "Enabled", "Hidden", "DeleteExpiredTaskAfter", "IdleSettings", "ExecutionTimeLimit", "Priority"],
  exec: ["Command", "Arguments", "WorkingDirectory"],
};
const inOrder = (actual, declared, what) => { let at = -1; for (const n of actual) { const k = declared.indexOf(n); assert.ok(k >= 0, `${what}: ${n} is not in the schema`); assert.ok(k > at, `${what}: ${n} out of order`); at = k; } assert.equal(new Set(actual).size, actual.length, `${what}: repeated`); };

test("the task text is well formed, in the schema's order, an S4U least-privilege task with no password element, no trigger and a 10 minute limit", () => {
  const t = parseXml(task());
  assert.equal(t.name, "Task");
  assert.equal(t.attrs.xmlns, "http://schemas.microsoft.com/windows/2004/02/mit/task");
  inOrder(names(t), XSD.task, "Task");
  assert.ok(!names(t).includes("Triggers"), "no trigger: it runs on demand only");
  const principal = child(child(t, "Principals"), "Principal");
  inOrder(names(principal), XSD.principal, "Principal");
  assert.equal(child(principal, "LogonType").text, "S4U");
  assert.equal(child(principal, "RunLevel").text, "LeastPrivilege");
  assert.equal(child(principal, "UserId").text, SAMPLE["@@USER@@"]);
  for (const forbidden of ["Password", "GroupId", "RequiredPrivileges", "ProcessTokenSidType"]) assert.ok(!names(principal).includes(forbidden), forbidden);
  const settings = child(t, "Settings");
  inOrder(names(settings), XSD.settings, "Settings");
  assert.equal(child(settings, "ExecutionTimeLimit").text, "PT10M");
  assert.equal(child(settings, "MultipleInstancesPolicy").text, "IgnoreNew");
  assert.equal(child(settings, "Enabled").text, "true");
  const actions = child(t, "Actions");
  assert.equal(actions.attrs.Context, principal.attrs.id, "the actions' context names the principal");
  assert.equal(actions.children.length, 1);
  const exec = child(actions, "Exec");
  inOrder(names(exec), XSD.exec, "Exec");
  assert.ok(child(exec, "Command").text.length <= 260);
  assert.equal(child(t, "RegistrationInfo").children[0].text, "probe & co", "a value with & survives the escaping");
  assert.ok(!/<Password|Trigger/.test(task()));
});

test("every value that enters the task text is XML-escaped with .NET, and each token appears once", () => {
  const f = fnText("New-ProbeTaskXml");
  for (const token of Object.keys(SAMPLE)) assert.equal(template().split(token).length - 1, 1, token);
  assert.match(f, /\.Replace\('@@DESCRIPTION@@', \(ConvertTo-XmlText '/);
  assert.match(f, /\.Replace\('@@USER@@', \(ConvertTo-XmlText \$UserId\)\)\.Replace\('@@COMMAND@@', \(ConvertTo-XmlText \$Command\)\)\.Replace\('@@ARGUMENTS@@', \(ConvertTo-XmlText \$Arguments\)\)/);
  assert.match(fnText("ConvertTo-XmlText"), /\[System\.Security\.SecurityElement\]::Escape\(\$Text\)/);
});

test("the command line is Windows-quoted: the full path of Windows PowerShell, -File with a quoted path, no shell and no value that could carry a quote or a trailing backslash", () => {
  assert.match(ps, /\$psExe = Join-Path \(\[System\.Environment\]::GetFolderPath\('System'\)\) 'WindowsPowerShell\\v1\.0\\powershell\.exe'/);
  assert.match(ps, /\$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' \+ \$innerPath \+ '" -Launcher "' \+ \$ctx\.Launcher \+ '" -InstallDir "' \+ \$ctx\.InstallDir \+ '" -ControlDir "' \+ \$ctx\.Control \+ '" -RunName ' \+ \$runName/);
  // the characters a path may have: letters, digits, space, dot, underscore, dash, backslash; never a quote and never a final backslash (a final backslash before a closing quote would escape it)
  assert.match(ps, /\$SafePath = '\^\[A-Za-z\]:\\\\\[A-Za-z0-9 \._\\\\-\]\*\[A-Za-z0-9\._-\]\$'/);
  const re = /^[A-Za-z]:\\[A-Za-z0-9 ._\\-]*[A-Za-z0-9._-]$/;
  for (const ok of ["C:\\Program Files\\NimbleNewt\\nn-launcher.exe", "C:\\ProgramData\\NimbleNewt\\native"]) assert.ok(re.test(ok), ok);
  for (const bad of ["C:\\a\\", 'C:\\a"b', "C:\\a&b", "C:\\a;b", "C:\\a$b", "C:\\a`b", "\\\\host\\share", "C:\\a%b%", "C:\\Programme (x86)\\x", "C:\\a\u00e9"]) assert.ok(!re.test(bad), bad);
  assert.match(fnText("Get-Context"), /\$p -ne \[System\.IO\.Path\]::GetFullPath\(\$p\)\.TrimEnd\('\\'\)/);
});

// ------------------------------------------------------------------------------------------------ -WhatIf safety

const READ_CMDLETS = /\b(Get-Acl|Get-LocalUser|Get-LocalGroupMember|Get-LocalGroup|Get-AuthenticodeSignature|Get-ScheduledTaskInfo|Get-ScheduledTask|Get-Content|Get-ChildItem|Get-Process|Get-Item|Test-Path|ConvertFrom-Json|Resolve-Path|Get-FileHash|Get-CimInstance|Get-WmiObject|Get-ItemProperty|Get-Service)\b/g;

test("Invoke-Read switches -WhatIf off inside its own scope, and every read cmdlet whose result is used runs inside it (the owner's first real run found this on Windows PowerShell 5.1)", () => {
  assert.match(ps, /\nfunction Invoke-Read\(\[scriptblock\] \$Block\) \{ \$WhatIfPreference = \$false; & \$Block \}/);
  let seen = 0;
  for (const [n, line] of outer.split("\n").entries()) {
    if (line.startsWith("function Invoke-Read")) continue;
    for (const m of line.matchAll(READ_CMDLETS)) {
      seen++;
      const open = line.lastIndexOf("Invoke-Read {", m.index);
      assert.ok(open >= 0, `line ${n}: ${m[0]} is not inside Invoke-Read: ${line.trim().slice(0, 120)}`);
      const between = line.slice(open + "Invoke-Read {".length, m.index);
      assert.ok(1 + (between.match(/\{/g) ?? []).length - (between.match(/\}/g) ?? []).length > 0, `line ${n}: ${m[0]} comes after its Invoke-Read block closed`);
    }
  }
  assert.ok(seen >= 6, `the scan saw the read calls (${seen})`);
  // the inner program runs as the account, never under -WhatIf, and calls none of them
  // (ConvertFrom-Json there only turns the launcher's own output line into an object; it reads no machine setting)
  assert.equal([...stripComments(inner).matchAll(READ_CMDLETS)].filter((m) => m[0] !== "ConvertFrom-Json").length, 0, "the inner program uses no read cmdlet (.NET only)");
});

// ------------------------------------------------------------------------------------------------ waiting, results, verdict

test("the wait is bounded and conditional (task state and result file, a deadline), never one fixed pause", () => {
  assert.match(outer, /\$deadline = \[DateTime\]::UtcNow\.AddSeconds\(\$TimeoutSeconds\)/);
  assert.match(outer, /if \(\[DateTime\]::UtcNow -gt \$deadline\)/);
  assert.match(outer, /Get-Prop \$result 'complete'\) -eq \$true\) \{\n/, "a complete result ends the wait (after the grace below)");
  assert.match(outer, /\(\$taskState -eq 'Ready'\) -and \(\$last -ne 267011\) -and \(\$last -ne 267009\)/);
  // the state is the COM interface's number, named by the documented TASK_STATE values
  assert.match(ps, /\$TaskStateNames = @\{ 0 = 'Unknown'; 1 = 'Disabled'; 2 = 'Queued'; 3 = 'Ready'; 4 = 'Running' \}/);
  assert.match(outer, /\$taskState = \[string\]\$TaskStateNames\[\[int\]\$own\.State\]\n\s*\$last = \[int64\]\$own\.LastTaskResult/);
  assert.match(outer, /\$result = Read-Result \$resultPath \$runName/);
  const sleeps = [...outer.matchAll(/Start-Sleep[^\n]*/g)].map((m) => m[0]);
  assert.equal(sleeps.length, 2);
  assert.match(sleeps[1], /-Milliseconds 500$/, "a short poll inside the bounded loop");
  // after the result says complete: a bounded grace for powershell.exe to end (so the paste block does not show 'still running' and the clean-up need not stop it)
  assert.match(outer, /'complete'\) -eq \$true\) \{\n(\s*#[^\n]*\n)?\s*\$grace = \[DateTime\]::UtcNow\.AddSeconds\(20\)\n\s*while \(\(\[int\]\$taskFolder\.GetTask\(\$TaskName\)\.State -eq 4\) -and \(\[DateTime\]::UtcNow -lt \$grace\)\) \{ Start-Sleep -Milliseconds 250 \}\n\s*break\n/);
  assert.match(ps, /\[ValidateRange\(480, 900\)\] \[int\] \$TimeoutSeconds = 540/);
  // the shortest allowed wait outlasts the task's own worst case (each launcher and whoami call bounded, plus 5 s for each pipe and kill), and the task's limit outlasts the default
  const bounds = [...inner.matchAll(/Invoke-Native [^\n]*? (\d{4,6})\n/g)].map((m) => Number(m[1]));
  assert.deepEqual(bounds.sort((x, y) => x - y), [30000, 60000, 60000, 120000], "whoami (in a loop of 3), check, delete-profile, info");
  const worst = (3 * 30000 + 60000 + 60000 + 120000) / 1000 + 6 * 15;
  assert.ok(480 >= worst, `480 s covers the inner worst case ${worst} s`);
  assert.ok(600 > 540, "PT10M outlasts the default wait");
  assert.ok(outer.indexOf("$hashBefore -ne $innerSha") > 0 && outer.indexOf("$hashBefore -ne $innerSha") < outer.indexOf("Start-ScheduledTask"), "the program is re-hashed before the task starts");
});

test("what the account wrote is read as data: size-bounded, never through a link, printed with control characters replaced", () => {
  const r = fnText("Read-Result");
  assert.match(r, /Test-Reparse \$Path/);
  assert.match(r, /\$MaxResultBytes/);
  assert.match(ps, /\$MaxResultBytes = 1048576/);
  assert.match(fnText("Clean"), /\[regex\]::Replace\(\[string\]\$Value, '\[\^\\x20-\\x7E\]', '\?'\)/);
  assert.match(fnText("Clean"), /\$Max\)/);
  // the program is created new (never over a file or a link that is already there)
  assert.match(outer, /\[System\.IO\.FileStream\]::new\(\$innerPath, \[System\.IO\.FileMode\]::CreateNew, \[System\.Security\.AccessControl\.FileSystemRights\]::Write, \[System\.IO\.FileShare\]::None, 4096, \[System\.IO\.FileOptions\]::None, \$security\)/);
  // only this run's result counts (schema and the random run name), and the size is read inside the try (the file can change while it is read)
  assert.match(r, /\[string\]\(Get-Prop \$r 'runName'\) -cne \$RunName/);
  assert.ok(r.indexOf("try {") < r.indexOf("Length -gt $MaxResultBytes"));
  assert.match(r, /Get-Content -LiteralPath \$Path -Raw -Encoding Ascii/, "read with the encoding it was written in");
  assert.match(inner, /WriteAllText\(\$Tmp, \(\$Result \| ConvertTo-Json -Depth 8\), \[System\.Text\.Encoding\]::ASCII\)/);
});

test("the verdict covers every row of plan 12.3's outcome table and the invalid case", () => {
  const v = fnText("Get-Verdict");
  for (const label of ["(c) registration refused", "task text refused (a fault in this script)", "(d) task did not start", "(d) task never ran or ended before writing", "invalid probe", "(e) launcher did not answer", "OK: profile and private window station work", "(b) private window station refused", "(a) profile creation failed", "(e) info failed elsewhere"]) assert.ok(v.includes(label), label);
  assert.match(v, /on this machine and build only/);
  assert.match(v, /Not shown: the ten G05 cases/, "OK does not claim the ten cases");
  assert.ok(!/Risk 6 does not bite/.test(v), "no general claim from one run");
  // a task text Windows cannot read is told apart from plan 12.3 (c)
  assert.ok(v.indexOf("task text refused") < v.indexOf("(c) registration refused"));
  // a run the script stopped itself (a refused access list, a changed program) is not blamed on Windows as (d)
  assert.ok(v.indexOf("(c) registration refused") < v.indexOf("no verdict: the script stopped before the task started") && v.indexOf("no verdict:") < v.indexOf("(d) task did not start"));
  assert.match(v, /if \(-not \$Started -and \$StartError -eq ''\)/);
  assert.match(ps, /\$verdict = Get-Verdict \$result \$registerError \$startError \$last \$ctx\.AccountSid \$started\n/);
  assert.match(v, /\$RegisterError -match '\\\(\\d\+,\\d\+\\\)'/);
  // what makes the run invalid
  for (const part of ["administratorRole", "isSystem", "not the account $AccountSid", "administratorsListed", "integrityRid') -ge 12288", "'elevated') -eq $true"]) assert.ok(v.includes(part), part);
  assert.match(v, /stage -eq 'grant' -and \$err -like 'window objects:\*'/);
  assert.match(v, /\$stage -eq 'container' -or \$stage -eq 'profile'/);
  assert.ok(v.indexOf("(c) registration") < v.indexOf("(d) task did not start") && v.indexOf("(d) task did not start") < v.indexOf("(d) task never ran") && v.indexOf("invalid probe") < v.indexOf("OK:"), "registration first, then no result, then the token, then the launcher");
  const plan = read("docs", "nimblenewt", "windows-isolation-plan.md");
  for (const row of ["`info` ok with the private station", "stage `grant`", "registering the probe is refused", "the task never starts"]) assert.ok(plan.includes(row), row);
  // the codes it names are the documented ones
  for (const code of ["0x00041303", "0x00041301", "0x80070569", "0x8007052E", "0x80070005"]) assert.ok(fnText("Get-ResultMeaning").includes(code), code);
  assert.match(fnText("Format-Hresult"), /4294967296/, "a negative value is shown as the unsigned code");
});

test("the program the task runs is created with its own protected access list (the account reads and runs it, never changes, replaces or deletes it), read back before the task is registered", () => {
  assert.match(outer, /SetSecurityDescriptorSddlForm\('D:P\(A;;FA;;;SY\)\(A;;FA;;;BA\)\(A;;0x1200a9;;;' \+ \$ctx\.AccountSid \+ '\)'\)/, "protected; SYSTEM and Administrators full; the account FILE_GENERIC_READ and FILE_GENERIC_EXECUTE");
  assert.equal(0x120089 | 0x1200a0, 0x1200a9, "FILE_GENERIC_READ | FILE_GENERIC_EXECUTE");
  assert.equal(0x1200a9 & 0x500d0156, 0, "and none of the rights that change the file");
  assert.match(outer, /if \(\$ctx\.AccountSid -notmatch '\^S-1-5-21\(-\[0-9\]\+\)\{4\}\$'\)/, "a real local account SID goes into the SDDL");
  const order = ["SetSecurityDescriptorSddlForm(", "[System.IO.FileStream]::new($innerPath", "$innerAcl = Test-ProgramAcl $innerPath $ctx.Control $ctx.AccountSid", "if ($innerAcl -ne '') { throw", "$registerAttempted = $true", "Register-ScheduledTask -TaskName", "$hashBefore = Get-Sha256Hex $innerPath", "Start-ScheduledTask"];
  let at = -1; for (const o of order) { const k = outer.indexOf(o); assert.ok(k > at, `${o} in order`); at = k; }
  const t = fnText("Test-ProgramAcl");
  assert.match(t, /\$changeRights = \[int64\]0x500D0156/);
  assert.equal(0x2 + 0x4 + 0x10 + 0x40 + 0x100 + 0x10000 + 0x40000 + 0x80000 + 0x10000000 + 0x40000000, 0x500D0156, "WriteData, AppendData, WriteEA, DeleteChild, WriteAttributes, Delete, WRITE_DAC, WRITE_OWNER, GENERIC_ALL, GENERIC_WRITE");
  assert.match(t, /if \(-not \$acl\.AreAccessRulesProtected\) \{ return/);
  assert.match(t, /if \(\$rule\.IsInherited\) \{ return/);
  assert.match(t, /if \(\$who -ne \$AccountSid\) \{ return "it has an entry for/, "no entry for anyone else");
  assert.match(t, /\[System\.IO\.Directory\]::GetAccessControl\(\$Folder\)[\s\S]*0x10000040/, "and no one but SYSTEM and Administrators may delete children of the control folder");
  assert.match(t, /PropagationFlags\]::InheritOnly/, "the account's inherit-only Modify (for files below) is not the folder's own right");
  // the installer's control folder grants match: the account's own folder right has no DeleteSubdirectoriesAndFiles
  assert.match(installer, /@\{ Who = \$account; Rights = 'ReadAndExecute, Write'; Scope = 'Folder'/);
});

test("the inner program reads the integrity level and Administrators membership from whoami by SID, and the verdict uses them", () => {
  assert.match(inner, /\$groupsText = \[string\]\$Result\.whoami\['groups'\]\.stdout/);
  assert.match(inner, /\[regex\]::Match\(\$groupsText, 'S-1-16-\(\[0-9\]\+\)'\)/);
  assert.match(inner, /administratorsListed = \[regex\]::IsMatch\(\$groupsText, 'S-1-5-32-544\(\?!\[0-9\]\)'\)/);
  assert.ok(inner.indexOf("$Result.whoamiFacts =") > inner.indexOf("foreach ($flag in @('/user', '/groups', '/priv'))"), "after whoami ran");
  assert.ok(/whoamiFacts = \$null/.test(inner), "declared with the other fields");
  assert.ok(new RegExp("S-1-5-32-544(?![0-9])").test("BUILTIN\\Administrators Alias S-1-5-32-544 Group used for deny only"));
  assert.ok(!new RegExp("S-1-5-32-544(?![0-9])").test("BUILTIN\\Users Alias S-1-5-32-545 Mandatory group"));
  assert.match(ps, /whoami \/groups read by SID: \$\(Show-Json \(Get-Prop \$result 'whoamiFacts'\)/);
});

// ------------------------------------------------------------------------------------------------ the launcher calls

const argsRs = read("native", "nn-launcher", "src", "args.rs");
const winRs = read("native", "nn-launcher", "src", "win.rs");

test("the launcher calls use only commands and flags the launcher's own parser accepts, with its rules for --profile-record and --sid; no run", () => {
  const calls = [...inner.matchAll(/'(info|check|delete-profile|run|revoke) --name '[^\n]*/g)].map((m) => m[0]);
  assert.equal(calls.length, 3, calls.join("\n"));
  const byCmd = Object.fromEntries(calls.map((c) => [/'(\w[\w-]*) --name/.exec(c)[1], c]));
  assert.deepEqual(Object.keys(byCmd).sort(), ["check", "delete-profile", "info"], "info, check and delete-profile only");
  for (const flag of ["--name", "--profile-record", "--sid", "--grant"]) assert.ok(argsRs.includes(`"${flag}"`) || argsRs.includes(`"${flag}" |`), flag);
  assert.match(byCmd.info, /--profile-record/); assert.ok(!/--sid|--grant/.test(byCmd.info), "info takes no --sid and no grant");
  assert.match(byCmd["delete-profile"], /--sid/); assert.match(byCmd["delete-profile"], /--profile-record/);
  assert.ok(!/--profile-record/.test(inner.slice(inner.indexOf("$checkArgs = ")).split("\n")[0]), "check takes no --profile-record");
  assert.match(inner, /\$checkArgs = 'check --name ' \+ \$RunName \+ ' --grant ' \+ \(Format-Arg \('rx:' \+ \$InstallDir\)\)/);
  assert.ok(argsRs.includes('"rx" => Some(Mode::Rx)'), "the read-only check names a grant mode the product accepts");
  // the rules the parser enforces, as the argument tests state them
  assert.ok(argsRs.includes('with a per-run profile needs --profile-record') && argsRs.includes('--profile-record is only for run, info and delete-profile') && argsRs.includes('delete-profile needs --sid') && argsRs.includes('--sid is only for check, revoke and delete-profile'));
  assert.ok(!/\bInvoke-Native \$Launcher \('run /.test(inner) && !/--exe|--cmdline|--stdin|--stdout/.test(inner), "no contained run: it needs the files and limits the backend's plan writes");
  assert.match(inner, /\$RunName -cmatch '\^NimbleNewtRun-\[0-9a-f\]\{16\}\$'/);
  assert.match(fnText("New-RunName"), /New-Object byte\[\] 8[\s\S]*RNGCryptoServiceProvider[\s\S]*ToString\('x2'\)/);
  assert.ok(read("native", "nn-launcher", "src", "profile.rs").includes('"NimbleNewtRun-"') || read("native", "nn-launcher", "src", "profile.rs").includes("NimbleNewtRun-"));
  assert.match(inner, /-cmatch '\^S-1-15-2\(-\[0-9\]\+\)\{7\}\$'/, "a SID is checked before it is passed");
});

test("the JSON fields and stages the verdict reads are the ones the launcher writes", () => {
  for (const key of ["windowStationOk", "windowStationError", "containerSid", "profileDeleted", "profileGone", "elevated", "sessionId"]) assert.ok(winRs.includes(`"${key}"`) || read("native", "nn-launcher", "src", "profile.rs").includes(key) || read("native", "nn-launcher", "src", "desk.rs").includes(key), key);
  assert.ok(winRs.includes('j.s("windowStation", "private")'));
  assert.ok(winRs.includes('fail(j, "container"') && winRs.includes('fail(j, "grant", &e)'), "the stages the verdict maps");
  assert.ok(read("native", "nn-launcher", "src", "desk.rs").includes("window objects:") || winRs.includes("window objects:"), "the message prefix the verdict matches");
  assert.ok(winRs.includes('"info" => {') && winRs.includes('"check" => {'));
  const readme = read("native", "nn-launcher", "README.md");
  assert.ok(readme.includes("`info`") && readme.includes("`check`") && readme.includes("`delete-profile`"));
});

test("each launcher call is bounded and captured, the result is written after every step and in a finally, and a failure never escapes unwritten", () => {
  for (const t of ["120000", "60000", "30000"]) assert.ok(inner.includes(t), t);
  const n = inner.slice(inner.indexOf("function Invoke-Native"), inner.indexOf("# The launcher prints ONE JSON line"));
  assert.match(n, /\$p\.WaitForExit\(\$TimeoutMs\)[\s\S]*\$p\.Kill\(\)/);
  assert.match(n, /RedirectStandardOutput = \$true[\s\S]*RedirectStandardError = \$true/);
  assert.match(n, /ReadToEndAsync\(\)[\s\S]*ReadToEndAsync\(\)/, "both pipes are drained while waiting");
  assert.match(n, /catch \{ \$r\.error = \$_\.Exception\.Message \}/, "never throws");
  assert.match(inner, /\} catch \{\s*\$Result\.fatal = \$_\.Exception\.Message[\s\S]*\} finally \{\s*Save-Result \$true\s*\}/);
  assert.ok((inner.match(/Save-Result \$false/g) ?? []).length >= 4, "partial results are saved as it goes");
  assert.match(inner, /\[System\.IO\.File\]::Copy\(\$Tmp, \$Final, \$true\)/);
  // the waiting script reads probe-result.json every half second: a copy over it at that moment is a sharing violation, so the copy is retried (bounded) and the final 'complete' is not lost
  const save = inner.slice(inner.indexOf("function Save-Result"), inner.indexOf("function Get-P"));
  assert.match(save, /for \(\$i = 0; \(\$i -lt 20\) -and \(-not \$copied\); \$i\+\+\) \{\n\s*try \{ \[System\.IO\.File\]::Copy\(\$Tmp, \$Final, \$true\); \$copied = \$true \} catch \{ \[System\.Threading\.Thread\]::Sleep\(100\) \}/);
  assert.ok(save.indexOf("$copied = $false") > 0 && save.indexOf("$copied = $false") < save.indexOf("for ($i"), "initialised before the loop (StrictMode)");
  for (const part of ["WindowsIdentity]::GetCurrent()", "IsSystem", "administratorRole", "integrityLevel", "sessionId", "'/user', '/groups', '/priv'", "userProfile", "temp = "]) assert.ok(inner.includes(part), part);
});

test("the final block says what changed and what stayed, and names the files", () => {
  for (const part of ["Changed on this machine: nothing except the temporary task and the temporary files named above", "no password was used", "Kept: $resultPath", "PASTE THIS BLOCK BACK", "LastTaskResult", "Verdict: $($verdict.Label)", "Probe program sha256", "Cleanup: task $TaskName removed"]) assert.ok(ps.includes(part), part);
  assert.match(ps, /exit 2/);
  assert.match(ps, /\$script:Exit = 3/);
});

// ------------------------------------------------------------------------------------------------ what the probe relies on in the installer

test("the control folder the probe writes into is the one the installer opens to the account: create on the folder, Modify below, no more", () => {
  assert.match(installer, /@\{ Who = \$account; Rights = 'ReadAndExecute, Write'; Scope = 'Folder'/);
  assert.match(installer, /@\{ Who = \$account; Rights = 'Modify'; Scope = 'Below'/);
  assert.match(installer, /\$ControlDir = Join-Path \$DataDir 'native'/);
  assert.match(installer, /\$ExeName = 'nn-launcher\.exe'/);
  assert.match(installer, /\$RightsGranted = @\('SeBatchLogonRight'\)/);
});

// ------------------------------------------------------------------------------------------------ the hosted workflow

const wf = read(".github", "workflows", "windows-appcontainer-experiment.yml");
const hosted = wf.slice(wf.indexOf("  hosted:"), wf.indexOf("  own-runner:"));
const stepAt = hosted.indexOf("id: probe_whatif");
const step = hosted.slice(stepAt, hosted.indexOf("# The programs the own-runner job runs"));

test("the hosted job parses the probe with PowerShell 5.1 and runs its -WhatIf path end to end with a made-up manifest, and asserts nothing was created", () => {
  assert.ok(stepAt > hosted.indexOf("id: build_product") && stepAt > hosted.indexOf("G05 containment cases through the native backend") && stepAt < hosted.indexOf("id: stage"), "after the G05 step, before staging");
  assert.match(step, /shell: powershell\n/);
  assert.match(step, /if: always\(\)/);
  for (const part of ["Probe-NimbleNewtWorker.ps1", "[System.Management.Automation.Language.Parser]::ParseInput", "'-WhatIf'", "'-ManifestPath'", "'-ControlDir'", "install-manifest.json", "nimblenewt.native-install/1", "Get-ScheduledTask", "Get-ChildItem -LiteralPath $control", "the control folder is not empty", "<LogonType>S4U</LogonType>", "What if: Performing the operation", "REFUSED", "powershell.exe"]) assert.ok(step.includes(part), part);
  // three runs: the dry run (exit 0), the same overrides WITHOUT -WhatIf (refused, exit 2), an absent manifest (refused, exit 2)
  assert.ok((step.match(/Invoke-Probe /g) ?? []).length >= 4, "the function and three calls");
  assert.match(step, /only accepted together with -WhatIf/);
  assert.match(step, /No install manifest at/);
  assert.ok(!/continue-on-error/.test(step), "the check is a gate");
  assert.ok(!/(^|\n)\s+permissions:/.test(step) && !/uses:/.test(step), "action pins and permissions are not touched by this step");
  assert.ok(!/uses: [^\n@]+@(?![0-9a-f]{40}\b)/.test(wf), "every action is still pinned to a commit");
  assert.ok(!/Register-ScheduledTask|Unregister-ScheduledTask|Start-ScheduledTask/.test(step), "the workflow never registers a task itself");
});

// ------------------------------------------------------------------------------------------------ documentation

test("the README section, the plan and the contribution guide describe the probe and what it cannot show", () => {
  const readme = read("native", "install", "README.md");
  const at = readme.indexOf("## The standard-account probe");
  assert.ok(at > 0);
  const section = readme.slice(at, readme.indexOf("\n## ", at + 5) > 0 ? readme.indexOf("\n## ", at + 5) : undefined);
  for (const part of ["Probe-NimbleNewtWorker.ps1", "-WhatIf", "NimbleNewtProbe", "probe-result.json", "Windows Home", "reboot", "restart", "(c) registration refused", "No password", "run", "elevated", "paste"]) assert.ok(section.includes(part), part);
  const plan = read("docs", "nimblenewt", "windows-isolation-plan.md");
  assert.ok(plan.includes("Probe-NimbleNewtWorker.ps1"), "plan 12.3 points to the script");
  assert.ok(read("CONTRIBUTING.md").includes("native/install/Probe-NimbleNewtWorker.ps1"));
  assert.ok(read("docs", "nimblenewt", "implementation-plan", "implementation-notes.md").includes("Probe-NimbleNewtWorker.ps1"));
});
