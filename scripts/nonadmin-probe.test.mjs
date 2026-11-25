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

test("exactly one task is touched, by its exact name: no wildcard, no other scheduled-task cmdlet", () => {
  const verbs = new Set([...outer.matchAll(/\b([A-Z][a-z]+)-ScheduledTask(Info)?\b/g)].map((m) => m[0]));
  assert.deepEqual([...verbs].sort(), ["Get-ScheduledTask", "Get-ScheduledTaskInfo", "Register-ScheduledTask", "Start-ScheduledTask", "Stop-ScheduledTask", "Unregister-ScheduledTask"]);
  for (const line of outer.split("\n")) {
    if (!/-ScheduledTask\b|-ScheduledTaskInfo\b/.test(line)) continue;
    assert.ok(line.includes("-TaskName $TaskName"), `names the task by the constant: ${line.trim().slice(0, 100)}`);
    assert.ok(!/[*?]/.test(line.replace(/'(?:[^']|'')*'/g, "''")), `no wildcard: ${line.trim().slice(0, 100)}`);
  }
  assert.equal((outer.match(/Unregister-ScheduledTask/g) ?? []).length, 1);
  assert.match(outer, /Unregister-ScheduledTask -TaskName \$TaskName -TaskPath '\\' -Confirm:\$false/);
  assert.ok(!/\$TaskName\s*=[^=]/.test(outer.replace(/\$TaskName = 'NimbleNewtProbe'/, "")), "the name is assigned once, as a constant");
});

test("the task is removed in a finally block, and only when this run registered it; an existing task of that name is refused, not touched", () => {
  const un = outer.indexOf("Unregister-ScheduledTask");
  const fin = outer.lastIndexOf("} finally {", un);
  assert.ok(fin > 0, "a finally block precedes it");
  const stopped = outer.indexOf("Stopped by an error");
  assert.ok(stopped > 0 && fin > stopped && fin - stopped < 300, "it is the finally of the try that does the work (right after its catch), not another one");
  const between = outer.slice(fin + 1, un);
  assert.ok((between.match(/\{/g) ?? []).length - (between.match(/\}/g) ?? []).length > 0, "the call is inside that finally block");
  assert.ok(outer.slice(fin, un).includes("if ($registered)"), "only a task this run registered");
  const reg = outer.indexOf("Register-ScheduledTask");
  assert.ok(outer.indexOf("$registered = $true", reg) > reg && outer.indexOf("$registered = $true", reg) < reg + 200, "the flag is set only after the registration call succeeded");
  const ctx = fnText("Get-Context");
  assert.match(ctx, /Get-ScheduledTask -TaskPath '\\' -TaskName \$TaskName[\s\S]*A task named \$TaskName already exists\. It is not touched/);
  // the files: only by exact name, after the task; the result file is kept
  const fin2 = outer.slice(fin);
  for (const v of ["$innerPath", "$tmpPath", "$recordPath", "$profilesPath"]) assert.ok(fin2.includes(v), v);
  assert.ok(!/Remove-Item|-Recurse|Directory\]::Delete\([^)]*\$true/.test(outer), "no recursive or wildcard removal");
  assert.ok(!fin2.includes("Remove-OwnFile $resultPath"), "probe-result.json is kept");
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
  assert.match(ctx, /catch \{ throw "Could not read the Administrators group/, "an unreadable group fails closed");
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
  assert.ok(seen >= 8, `the scan saw the read calls (${seen})`);
  // the inner program runs as the account, never under -WhatIf, and calls none of them
  // (ConvertFrom-Json there only turns the launcher's own output line into an object; it reads no machine setting)
  assert.equal([...stripComments(inner).matchAll(READ_CMDLETS)].filter((m) => m[0] !== "ConvertFrom-Json").length, 0, "the inner program uses no read cmdlet (.NET only)");
});

// ------------------------------------------------------------------------------------------------ waiting, results, verdict

test("the wait is bounded and conditional (task state and result file, a deadline), never one fixed pause", () => {
  assert.match(outer, /\$deadline = \[DateTime\]::UtcNow\.AddSeconds\(\$TimeoutSeconds\)/);
  assert.match(outer, /if \(\[DateTime\]::UtcNow -gt \$deadline\)/);
  assert.match(outer, /Get-Prop \$result 'complete'\) -eq \$true\) \{ break \}/);
  assert.match(outer, /\(\$taskState -eq 'Ready'\) -and \(\$last -ne 267011\) -and \(\$last -ne 267009\)/);
  const sleeps = [...outer.matchAll(/Start-Sleep[^\n]*/g)].map((m) => m[0]);
  assert.equal(sleeps.length, 1);
  assert.match(sleeps[0], /-Milliseconds 500$/, "a short poll inside the bounded loop");
  assert.match(ps, /\[ValidateRange\(60, 900\)\] \[int\] \$TimeoutSeconds = 240/);
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
  assert.match(outer, /\[System\.IO\.FileMode\]::CreateNew, \[System\.IO\.FileAccess\]::Write, \[System\.IO\.FileShare\]::None/);
});

test("the verdict covers every row of plan 12.3's outcome table and the invalid case", () => {
  const v = fnText("Get-Verdict");
  for (const label of ["(c) registration refused", "(d) task did not start", "(d) task never ran or ended before writing", "invalid probe", "(e) launcher did not answer", "OK: profile and private window station work", "(b) private window station refused", "(a) profile creation failed", "(e) info failed elsewhere"]) assert.ok(v.includes(label), label);
  assert.match(v, /Risk 6 does not bite for an S4U non-administrator/);
  assert.match(v, /stage -eq 'grant' -and \$err -like 'window objects:\*'/);
  assert.match(v, /\$stage -eq 'container' -or \$stage -eq 'profile'/);
  assert.ok(v.indexOf("(c) registration") < v.indexOf("(d) task did not start") && v.indexOf("(d) task did not start") < v.indexOf("(d) task never ran") && v.indexOf("invalid probe") < v.indexOf("OK:"), "registration first, then no result, then the token, then the launcher");
  const plan = read("docs", "nimblenewt", "windows-isolation-plan.md");
  for (const row of ["`info` ok with the private station", "stage `grant`", "registering the probe is refused", "the task never starts"]) assert.ok(plan.includes(row), row);
  // the codes it names are the documented ones
  for (const code of ["0x00041303", "0x00041301", "0x80070569", "0x8007052E", "0x80070005"]) assert.ok(fnText("Get-ResultMeaning").includes(code), code);
  assert.match(fnText("Format-Hresult"), /4294967296/, "a negative value is shown as the unsigned code");
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
