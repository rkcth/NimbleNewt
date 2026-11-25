import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SERVICE_RESTART, ServiceSpecError, WORKER_SERVICE, generateServiceUnit, generateWorkerServiceUnit, windowsArg, type WorkerServiceSpec } from "./index.js";

/**
 * The worker's Task Scheduler unit (card A03b follow-up): an S4U principal (no stored password), a boot trigger, a bounded restart, explicit paths. The checks read the XML with a small parser of their own and compare
 * it with the Task Scheduler XSD (https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-schema, read 2026-11-25): the task's children, the settings and the principal are `xs:all` (any order), a trigger is a
 * sequence (Enabled, StartBoundary, EndBoundary, Repetition, ExecutionTimeLimit, then Delay), Exec's Command and WorkingDirectory are at most 260 characters.
 * Windows paths are written with an explicit win32 spelling: nothing here depends on the machine the test runs on.
 */
const GOLDEN = join(import.meta.dirname, "..", "..", "src", "release", "golden-units");
const golden = (file: string, actual: string): void => {
  if (process.env.NN_UPDATE_GOLDEN === "1") { mkdirSync(GOLDEN, { recursive: true }); writeFileSync(join(GOLDEN, file), actual); }
  assert.ok(existsSync(join(GOLDEN, file)), `golden file ${file} is missing`);
  assert.equal(actual, readFileSync(join(GOLDEN, file), "utf8"), `${file} differs from its golden output`);
};

const SPEC: WorkerServiceSpec = {
  node: "C:\\Program Files\\nodejs\\node.exe",
  entry: "C:\\Program Files\\NimbleNewt\\release\\scripts\\remote-worker.mjs",
  configFile: "C:\\ProgramData\\NimbleNewt\\worker.json",
  workingDirectory: "C:\\Program Files\\NimbleNewt\\release",
  windowsUser: "BOX\\nimblenewt-worker",
};

// ---- a minimal XML reader (well-formedness is part of what is tested) ----
interface El { readonly name: string; readonly attrs: Record<string, string>; readonly children: El[]; text: string }
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeXml = (s: string): string => s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) => {
  if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
  if (e.startsWith("#")) return String.fromCodePoint(parseInt(e.slice(1), 10));
  const v = ENTITIES[e];
  if (v === undefined) throw new Error(`unknown entity ${m}`);
  return v;
});
function parseXml(xml: string): El {
  const stack: El[] = [];
  let root: El | undefined;
  let i = 0;
  const decl = /^<\?xml version="1\.0" encoding="UTF-16"\?>\n/.exec(xml);
  assert.ok(decl, "an XML declaration first");
  i = decl[0].length;
  while (i < xml.length) {
    if (xml[i] === "<") {
      if (xml.startsWith("<!--", i)) { const e = xml.indexOf("-->", i); assert.ok(e > 0, "comment closed"); assert.ok(!xml.slice(i + 4, e).includes("--"), "no -- inside a comment"); i = e + 3; continue; }
      const e = xml.indexOf(">", i);
      assert.ok(e > 0, "tag closed");
      const tag = xml.slice(i + 1, e);
      assert.ok(!/[<"][^"]*$/.test(tag.replace(/"[^"]*"/g, "")), `stray characters in tag ${tag}`);
      if (tag.startsWith("/")) {
        const top = stack.pop();
        assert.ok(top !== undefined && top.name === tag.slice(1), `closing ${tag} does not match ${top?.name}`);
      } else {
        const selfClose = tag.endsWith("/");
        const m = /^([A-Za-z][A-Za-z0-9]*)((?:\s+[A-Za-z:]+="[^"<]*")*)\s*\/?$/.exec(tag);
        assert.ok(m, `bad tag <${tag}>`);
        const attrs: Record<string, string> = {};
        for (const a of (m[2] ?? "").matchAll(/\s+([A-Za-z:]+)="([^"]*)"/g)) attrs[a[1]!] = unescapeXml(a[2]!);
        const el: El = { name: m[1]!, attrs, children: [], text: "" };
        const parent = stack[stack.length - 1];
        if (parent === undefined) { assert.equal(root, undefined, "one root"); root = el; } else parent.children.push(el);
        if (!selfClose) stack.push(el);
      }
      i = e + 1;
    } else {
      const e = xml.indexOf("<", i);
      const t = xml.slice(i, e < 0 ? undefined : e);
      assert.ok(!/[>]/.test(t.replace(/&gt;/g, "")) && !/&(?!(amp|lt|gt|quot|apos);)/.test(t), `unescaped text ${JSON.stringify(t)}`);
      const top = stack[stack.length - 1];
      if (top !== undefined) top.text += unescapeXml(t); else assert.ok(t.trim() === "", "no text outside the root");
      i = e < 0 ? xml.length : e;
    }
  }
  assert.equal(stack.length, 0, "every element closed");
  assert.ok(root);
  return root;
}
const child = (e: El, name: string): El => { const c = e.children.filter((x) => x.name === name); assert.equal(c.length, 1, `${e.name} has exactly one ${name}`); return c[0]!; };
const has = (e: El, name: string): boolean => e.children.some((x) => x.name === name);
const names = (e: El): string[] => e.children.map((c) => c.name);
const val = (e: El, name: string): string => child(e, name).text;

/** CommandLineToArgvW for the common case (what node's C runtime does with the Arguments string). */
function argvOf(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (line[i] === " ") i++;
    if (i >= line.length) break;
    let cur = ""; let inQuote = false;
    for (;;) {
      let bs = 0;
      while (line[i] === "\\") { bs++; i++; }
      if (line[i] === '"') {
        cur += "\\".repeat(Math.floor(bs / 2));
        if (bs % 2 === 1) { cur += '"'; i++; } else { inQuote = !inQuote; i++; }
        continue;
      }
      cur += "\\".repeat(bs);
      if (i >= line.length || (line[i] === " " && !inQuote)) break;
      cur += line[i]; i++;
    }
    out.push(cur);
  }
  return out;
}

const XSD = {
  task: ["RegistrationInfo", "Triggers", "Settings", "Data", "Principals", "Actions"],
  trigger: ["Enabled", "StartBoundary", "EndBoundary", "Repetition", "ExecutionTimeLimit", "Delay"],
  principal: ["UserId", "LogonType", "GroupId", "DisplayName", "RunLevel", "ProcessTokenSidType", "RequiredPrivileges"],
  settings: ["AllowStartOnDemand", "RestartOnFailure", "MultipleInstancesPolicy", "DisallowStartIfOnBatteries", "StopIfGoingOnBatteries", "AllowHardTerminate", "StartWhenAvailable", "NetworkProfileName", "RunOnlyIfNetworkAvailable", "WakeToRun", "Enabled", "Hidden", "DeleteExpiredTaskAfter", "IdleSettings", "NetworkSettings", "ExecutionTimeLimit", "Priority", "RunOnlyIfIdle", "UseUnifiedSchedulingEngine", "DisallowStartOnRemoteAppSession"],
  exec: ["Command", "Arguments", "WorkingDirectory"],
};
const inOrder = (actual: string[], declared: string[], what: string): void => {
  let at = -1;
  for (const n of actual) { const k = declared.indexOf(n); assert.ok(k >= 0, `${what}: ${n} is not in the schema`); assert.ok(k > at, `${what}: ${n} out of the declared order`); at = k; }
  assert.equal(new Set(actual).size, actual.length, `${what}: a repeated element`);
};

test("golden: the worker task XML and its administrator steps for the installer's defaults", () => {
  const u = generateWorkerServiceUnit(SPEC);
  golden("win32-worker.xml", u.content);
  golden("win32-worker.steps.txt", u.steps.join("\n") + "\n");
  assert.equal(u.fileName, "NimbleNewtWorker.xml");
  assert.equal(u.name, WORKER_SERVICE.defaultName);
  // deterministic: the same description gives the same text
  assert.equal(generateWorkerServiceUnit({ ...SPEC }).content, u.content);
});

test("the XML is well formed and follows the Task Scheduler schema's element order and limits", () => {
  const u = generateWorkerServiceUnit(SPEC);
  const task = parseXml(u.content);
  assert.equal(task.name, "Task");
  assert.equal(task.attrs["xmlns"], "http://schemas.microsoft.com/windows/2004/02/mit/task");
  assert.equal(task.attrs["version"], "1.3");
  inOrder(names(task), XSD.task, "Task");
  for (const required of ["Triggers", "Settings", "Principals", "Actions"]) assert.ok(has(task, required), required);
  const trigger = child(child(task, "Triggers"), "BootTrigger");
  inOrder(names(trigger), XSD.trigger, "BootTrigger");
  assert.equal(val(trigger, "Enabled"), "true");
  assert.match(val(trigger, "Delay"), /^PT\d+[MS]$/);
  const settings = child(task, "Settings");
  inOrder(names(settings), XSD.settings, "Settings");
  for (const b of ["AllowStartOnDemand", "DisallowStartIfOnBatteries", "StopIfGoingOnBatteries", "AllowHardTerminate", "StartWhenAvailable", "RunOnlyIfNetworkAvailable", "WakeToRun", "Enabled", "Hidden"]) assert.match(val(settings, b), /^(true|false)$/, b);
  assert.ok(Number.isInteger(Number(val(settings, "Priority"))) && Number(val(settings, "Priority")) >= 0 && Number(val(settings, "Priority")) <= 10);
  const principals = child(task, "Principals");
  assert.equal(principals.children.length, 1);
  const principal = child(principals, "Principal");
  inOrder(names(principal), XSD.principal, "Principal");
  const actions = child(task, "Actions");
  assert.equal(actions.attrs["Context"], principal.attrs["id"], "the actions' context names the principal");
  assert.equal(actions.children.length, 1);
  const exec = child(actions, "Exec");
  inOrder(names(exec), XSD.exec, "Exec");
  assert.ok(val(exec, "Command").length <= 260 && val(exec, "WorkingDirectory").length <= 260 && val(exec, "Command").length > 0);
  // the restart policy's values are inside the schema's limits (interval at least one minute, count a byte of at least 1)
  const r = child(settings, "RestartOnFailure");
  assert.match(val(r, "Interval"), /^PT\d+M$/);
  assert.ok(Number(/\d+/.exec(val(r, "Interval"))![0]) >= 1);
  assert.ok(Number(val(r, "Count")) >= 1 && Number(val(r, "Count")) <= 255);
});

test("the unit is an S4U task of the worker account: no password, a boot trigger and no logon trigger, bounded restart, no time limit, one instance, explicit working directory", () => {
  const u = generateWorkerServiceUnit(SPEC);
  const task = parseXml(u.content);
  const principal = child(child(task, "Principals"), "Principal");
  assert.equal(val(principal, "UserId"), "BOX\\nimblenewt-worker");
  assert.equal(val(principal, "LogonType"), "S4U");
  assert.equal(val(principal, "RunLevel"), "LeastPrivilege");
  for (const forbidden of ["Password", "GroupId", "RequiredPrivileges", "ProcessTokenSidType"]) assert.ok(!has(principal, forbidden), forbidden);
  assert.ok(!/<Password|InteractiveToken|HighestAvailable|LogonTrigger|SessionStateChangeTrigger|RegistrationTrigger|CalendarTrigger|TimeTrigger/.test(u.content));
  assert.deepEqual(names(child(task, "Triggers")), ["BootTrigger"]);
  const s = child(task, "Settings");
  assert.equal(val(s, "ExecutionTimeLimit"), "PT0S");
  assert.equal(val(s, "MultipleInstancesPolicy"), "IgnoreNew");
  assert.equal(val(s, "StartWhenAvailable"), "true");
  assert.equal(val(s, "DisallowStartIfOnBatteries"), "false");
  assert.equal(val(s, "StopIfGoingOnBatteries"), "false");
  assert.equal(val(child(s, "RestartOnFailure"), "Count"), String(SERVICE_RESTART.windowsRestartCount));
  assert.equal(val(child(s, "RestartOnFailure"), "Interval"), SERVICE_RESTART.windowsRestartInterval);
  assert.equal(val(child(task, "Triggers").children[0]!, "Delay"), WORKER_SERVICE.bootDelay);
  const exec = child(child(task, "Actions"), "Exec");
  assert.equal(val(exec, "Command"), SPEC.node);
  assert.equal(val(exec, "WorkingDirectory"), SPEC.workingDirectory);
  assert.equal(val(exec, "Arguments"), '"--env-file=C:\\ProgramData\\NimbleNewt\\worker.env" "C:\\Program Files\\NimbleNewt\\release\\scripts\\remote-worker.mjs" "--config" "C:\\ProgramData\\NimbleNewt\\worker.json"');
  assert.deepEqual(argvOf(val(exec, "Arguments")), ["--env-file=C:\\ProgramData\\NimbleNewt\\worker.env", SPEC.entry, "--config", SPEC.configFile]);
});

test("paths with spaces, ampersands and apostrophes are quoted for the command line and escaped for XML, and read back exactly", () => {
  const spec: WorkerServiceSpec = {
    node: "C:\\Tools & Co\\node js\\node.exe",
    entry: "C:\\Nimble 'Newt'\\a b\\remote-worker.mjs",
    configFile: "C:\\Data (x86)\\cfg & more\\worker.json",
    workingDirectory: "C:\\Nimble 'Newt'\\a b",
    windowsUser: "MY-PC\\nimblenewt-worker",
    dataDir: "C:\\Program Data & More\\NimbleNewt",
  };
  const u = generateWorkerServiceUnit(spec);
  assert.ok(u.content.includes("C:\\Tools &amp; Co\\node js\\node.exe"));
  assert.ok(u.content.includes("&apos;Newt&apos;"));
  assert.ok(!/&(?!(amp|lt|gt|quot|apos);)/.test(u.content));
  const exec = child(child(parseXml(u.content), "Actions"), "Exec");
  assert.equal(val(exec, "Command"), spec.node);
  assert.equal(val(exec, "WorkingDirectory"), spec.workingDirectory);
  assert.deepEqual(argvOf(val(exec, "Arguments")), ["--env-file=C:\\Program Data & More\\NimbleNewt\\worker.env", spec.entry, "--config", spec.configFile]);
  // a path that ends in a backslash-free name still reads back when the quote follows a doubled backslash case
  assert.equal(val(child(child(parseXml(u.content), "Principals"), "Principal"), "UserId"), "MY-PC\\nimblenewt-worker");
});

test("a changed data folder moves worker.env with it, and a changed name moves the task", () => {
  const u = generateWorkerServiceUnit({ ...SPEC, dataDir: "D:\\NN", name: "nn.worker-2" });
  assert.ok(u.content.includes("--env-file=D:\\NN\\worker.env"));
  assert.equal(u.fileName, "nn.worker-2.xml");
  assert.match(u.steps.join("\n"), /Register-ScheduledTask -TaskName 'nn\.worker-2' -Xml \$xml/);
});

test("hostile values are refused before anything is written: relative, drive-less, UNC, device, control, injection, wildcard and variable characters, long paths, accounts that are not ordinary", () => {
  const refuse = (patch: Partial<WorkerServiceSpec> | Record<string, unknown>, field: string): void => {
    assert.throws(() => generateWorkerServiceUnit({ ...SPEC, ...patch } as WorkerServiceSpec), (e: unknown) => e instanceof ServiceSpecError && e.field === field, `${field}: ${JSON.stringify(patch)}`);
  };
  for (const field of ["node", "entry", "configFile", "workingDirectory", "dataDir"] as const) {
    for (const v of ["relative\\x", "\\\\server\\share\\x", "\\\\?\\C:\\x", "C:x", "C:\\a\\..\\b", "C:\\a\\\\b", "C:\\a\\", "C:\\a\\b.exe</Command><Command>evil", "C:\\a\"b", "C:\\a|b", "C:\\a<b", "C:\\a>b", "C:\\a*b", "C:\\a?b", "C:\\%TEMP%\\x", "C:\\a\nb", "C:\\a\u0000b", "C:\\a\u2028b", "C:\\a^b", "C:\\a`b", "C:\\a$b", "C:\\a;b", "C:\\a!b", "C:\\a#b", "C:\\caf\u00e9\\x", "C:\\a\\con", "C:\\a\\x.", "C:\\a\\x ", `C:\\${"a".repeat(260)}`, "", "  "]) refuse({ [field]: v }, field);
    refuse({ [field]: 42 }, field);
  }
  refuse({ dataDir: "C:\\it's" }, "dataDir");
  refuse({ dataDir: "C:\\a=b" }, "dataDir");
  for (const user of ["", "SYSTEM", "NT AUTHORITY\\SYSTEM", "NT SERVICE\\x", "BUILTIN\\Administrators", "BOX\\Administrator", "Administrator", "root", "LocalSystem", "x</UserId><UserId>y", "a\nb", "BOX\\ni\"x", "-bad", "BOX\\"]) refuse({ windowsUser: user }, "windowsUser");
  refuse({ windowsUser: undefined }, "windowsUser");
  for (const name of ["", "a b", "../x", "a/b", "x".repeat(65), "-x", "a<b", "a&b"]) refuse({ name }, "name");
});

test("no secret, password or key can enter the unit: the spec has no field for one, and a secret-looking path is still only a path", () => {
  const SENTINEL = "sk-test-SECRET-sentinel-0123456789";
  const u = generateWorkerServiceUnit({ ...SPEC, configFile: "C:\\ProgramData\\NimbleNewt\\worker-token.json" });
  const all = [u.content, ...u.steps, ...u.uninstall, ...u.notes].join("\n");
  assert.ok(!all.includes(SENTINEL));
  assert.ok(!/<Password|-Password|\/RP\b|\/RU\b|ConvertTo-SecureString|-Credential|Get-Credential/i.test(all), "no password or credential route anywhere");
  // Extra fields (as a careless caller might pass) never reach the text.
  const u2 = generateWorkerServiceUnit({ ...SPEC, password: SENTINEL, token: SENTINEL, env: { KEY: SENTINEL } } as unknown as WorkerServiceSpec);
  assert.equal(u2.content, generateWorkerServiceUnit(SPEC).content);
  // The environment is only the referenced file.
  assert.ok(!/<(Environment|Env)/i.test(u.content));
  assert.equal((u.content.match(/worker\.env/g) ?? []).length, 1 + 0, "worker.env named once, in Arguments (the header comment names the file kind only)");
});

test("the steps and notes say who registers it, that nothing here registered anything, and every limit of S4U and what is unproven", () => {
  const u = generateWorkerServiceUnit(SPEC);
  const steps = u.steps.join("\n");
  const notes = u.notes.join("\n");
  assert.match(steps, /ELEVATED PowerShell/);
  assert.match(steps, /Nothing below has been run by this program/);
  assert.match(steps, /Register-ScheduledTask -TaskName 'NimbleNewtWorker' -Xml \$xml/);
  assert.ok(!/^Register-ScheduledTask[^\n]*-(User|Password|RunLevel)/m.test(steps));
  assert.match(steps, /Install-NimbleNewtLauncher\.ps1 -Action Verify/);
  assert.match(notes, /Registered by an administrator only/);
  assert.match(notes, /NO stored password/);
  assert.match(notes, /no access to the network or to encrypted files/);
  assert.match(notes, /Session 0/);
  assert.match(notes, /NON-ADMINISTRATOR is UNPROVEN/);
  assert.match(notes, /OPEN, registration: .*different user's account.* must supply a password.*UNPROVEN/);
  assert.match(notes, /3 times, PT1M apart/);
  assert.match(notes, /schtasks \/Create \/TN <name> \/XML <file>/);
  assert.deepEqual(u.uninstall, ["Stop-ScheduledTask -TaskName 'NimbleNewtWorker'", "Unregister-ScheduledTask -TaskName 'NimbleNewtWorker' -Confirm:$false"]);
  // The here-string in the steps holds the XML exactly, and no line of it could end the string early.
  assert.ok(steps.includes(`$xml = @'\n${u.content}'@`));
  assert.ok(!u.content.split("\n").includes("'@"));
});

test("the controller's own Windows unit is untouched: still a logon-triggered interactive-token task for the installing user", () => {
  const c = generateServiceUnit({ platform: "win32", node: "C:\\Program Files\\nodejs\\node.exe", launcher: "C:\\NN\\scripts\\nimblenewt-launcher.mjs", root: "C:\\NN\\root", windowsUser: "BOX\\ann" });
  assert.match(c.content, /<LogonTrigger>/);
  assert.match(c.content, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.ok(!/BootTrigger|S4U/.test(c.content));
});

test("the account is one the installer could have made: its -AccountName pattern, no SID, no built-in or well-known name in any case, no lookalike or padded spelling", () => {
  const refuse = (user: string): void => {
    assert.throws(() => generateWorkerServiceUnit({ ...SPEC, windowsUser: user }), (e: unknown) => e instanceof ServiceSpecError && e.field === "windowsUser", JSON.stringify(user));
  };
  for (const user of [
    "S-1-5-18", "s-1-5-19", "BOX\\S-1-5-18", "S-1-5-21-1-2-3-500", "S-1\\nimblenewt-worker",
    "LocalService", "NetworkService", "localsystem", "ADMINISTRATOR", "box\\Administrator", "Admin", "DefaultAccount", "WDAGUtilityAccount", "defaultuser0", "Guest", "Everyone", "Users", "krbtgt", "TrustedInstaller",
    "BUILTIN\\x", "builtin\\nimblenewt-worker", "NT\\x", "NT-AUTHORITY\\x",
    "Administrator.", "nimblenewt-worker.", " nimblenewt-worker", "nimblenewt-worker ", "BOX\\ nimblenewt-worker", ".\\nimblenewt-worker", "BOX.\\nimblenewt-worker", "BOX\\\\nimblenewt-worker", "A\\B\\c",
    "nimblenewt.worker", "nimble newt", "1worker", "_worker", "x".repeat(21), "C".repeat(16) + "\\nimblenewt-worker",
    "nimblenewt\u2010worker", "nimbl\u0435newt", "nimblenewt-worker\n", "nimblenewt-worker\u0000", "nimblenewt-worker@BOX", "BOX/nimblenewt-worker",
  ]) refuse(user);
  for (const user of ["nimblenewt-worker", "BOX\\nimblenewt-worker", "my-pc\\nn_w2", "W".repeat(15) + "\\" + "w".repeat(20)]) {
    assert.equal(val(child(child(parseXml(generateWorkerServiceUnit({ ...SPEC, windowsUser: user }).content), "Principals"), "Principal"), "UserId"), user);
  }
  // The name part's pattern is the installer's -AccountName ValidatePattern, character for character, and the installer's default is the documented account.
  const ps1 = join(import.meta.dirname, "..", "..", "..", "..", "native", "install", "Install-NimbleNewtLauncher.ps1");
  assert.ok(existsSync(ps1), ps1);
  const m = /\[ValidatePattern\('\^([^']+)\$'\)\] \[string\] \$AccountName = 'nimblenewt-worker'/.exec(readFileSync(ps1, "utf8"));
  assert.ok(m, "the installer's AccountName parameter");
  const src = readFileSync(join(import.meta.dirname, "..", "..", "src", "release", "worker-service-unit.ts"), "utf8");
  assert.ok(src.includes(`\\\\)?(${m[1]})$/;`), `the generator's name part is the installer's pattern ${m[1]}`);
});

test("the command line round-trips through the Windows argument rules: backslash runs before a quote, a trailing backslash before the closing quote, spaces, and an argument made of them", () => {
  // A path that is the root of a drive ends in a backslash: inside quotes it must be doubled, or the closing quote is escaped and the next argument merges into it.
  const u = generateWorkerServiceUnit({ ...SPEC, configFile: "C:\\" });
  const args = val(child(child(parseXml(u.content), "Actions"), "Exec"), "Arguments");
  assert.ok(args.endsWith('"--config" "C:\\\\"'), args);
  assert.deepEqual(argvOf(args), ["--env-file=C:\\ProgramData\\NimbleNewt\\worker.env", SPEC.entry, "--config", "C:\\"]);
  // The quoting function itself, on the cases CommandLineToArgvW and the C runtime treat specially.
  for (const s of ["", " ", "a b", "a\\", "a\\\\", "\\", 'a"b', 'a\\"b', 'a\\\\"b', '"', '\\"', "a\\ b\\", "\t"]) assert.deepEqual(argvOf(windowsArg(s)), [s], JSON.stringify(s));
  // and on many strings built from the characters that matter, several per line
  let seed = 7;
  const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const alphabet = ["a", " ", "\\", '"', "&", "'"];
  for (let k = 0; k < 2000; k++) {
    const words = Array.from({ length: 1 + rnd(4) }, () => Array.from({ length: rnd(8) }, () => alphabet[rnd(alphabet.length)]).join(""));
    assert.deepEqual(argvOf(words.map(windowsArg).join(" ")), words, JSON.stringify(words));
  }
});
