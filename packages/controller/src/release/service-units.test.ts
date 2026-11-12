import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CONTROLLER_EXIT, SERVICE_RESTART, SUPERVISOR_EXIT, ServiceSpecError, checkServicePath, generateServiceUnit, powershellQuote, shellQuote, systemdWord, windowsArg, xmlEscape, type ServiceSpec } from "./index.js";

/**
 * Service units (card K02 follow-up): golden outputs for the three platforms, hostile paths and arguments, and the alignment of the restart policy with the launcher's exit codes.
 * The goldens live in src/release/golden-units; NN_UPDATE_GOLDEN=1 rewrites them (read the diff).
 */
const GOLDEN = join(import.meta.dirname, "..", "..", "src", "release", "golden-units");
const golden = (file: string, actual: string): void => {
  if (process.env.NN_UPDATE_GOLDEN === "1") { mkdirSync(GOLDEN, { recursive: true }); writeFileSync(join(GOLDEN, file), actual); }
  assert.ok(existsSync(join(GOLDEN, file)), `golden file ${file} is missing`);
  assert.equal(actual, readFileSync(join(GOLDEN, file), "utf8"), `${file} differs from its golden output`);
};

const POSIX: ServiceSpec = { platform: "linux", node: "/usr/local/bin/node", launcher: "/opt/nimblenewt/scripts/nimblenewt-launcher.mjs", root: "/home/ann/nimblenewt/releases-root", envFile: "/home/ann/.config/nimblenewt/nimblenewt.env", logDir: "/home/ann/.local/state/nimblenewt", controllerArgs: ["--serve"] };
const WIN: ServiceSpec = { platform: "win32", node: "C:\\Program Files\\nodejs\\node.exe", launcher: "C:\\Program Files\\NimbleNewt\\scripts\\nimblenewt-launcher.mjs", root: "C:\\NimbleNewt\\root", envFile: "C:\\Users\\ann\\nimblenewt.env", controllerArgs: ["--serve"], windowsUser: "ANNPC\\ann" };

test("golden units: systemd user unit, launchd agent and Windows task for the same installation (K02 service units)", () => {
  const linux = generateServiceUnit(POSIX);
  const darwin = generateServiceUnit({ ...POSIX, platform: "darwin", logDir: "/Users/ann/Library/Logs/nimblenewt", envFile: "/Users/ann/.nimblenewt.env" });
  const win = generateServiceUnit(WIN);
  golden("linux.service", linux.content);
  golden("darwin.plist", darwin.content);
  golden("win32.xml", win.content);
  golden("linux.steps.txt", linux.steps.join("\n") + "\n");
  golden("darwin.steps.txt", darwin.steps.join("\n") + "\n");
  golden("win32.steps.txt", win.steps.join("\n") + "\n");
  assert.equal(linux.fileName, "nimblenewt.service");
  assert.equal(darwin.fileName, "local.nimblenewt.plist");
  assert.equal(win.fileName, "nimblenewt.xml");
});

test("the strict systemd variant lists the writable directories, and everything it needs is plain (K02 service units)", () => {
  const u = generateServiceUnit({ ...POSIX, protectSystem: "strict", readWritePaths: ["/home/ann/.nimblenewt"] });
  golden("linux-strict.service", u.content);
  assert.match(u.content, /^ProtectSystem=strict$/m);
  assert.match(u.content, /^ReadWritePaths="\/home\/ann\/nimblenewt\/releases-root" "\/home\/ann\/\.local\/state\/nimblenewt" "\/home\/ann\/\.nimblenewt"$/m);
  assert.throws(() => generateServiceUnit({ ...POSIX, root: "/home/ann/my root", protectSystem: "strict" }), ServiceSpecError);
  assert.throws(() => generateServiceUnit({ ...POSIX, readWritePaths: ["/x"] }), /strict/);
});

test("hardening and identity: the units run as the installing user, never name root, and carry no secrets (K02 service units)", () => {
  const SECRET = "sk-test-SECRET-sentinel-0123456789";
  for (const spec of [POSIX, { ...POSIX, platform: "darwin" as const }, WIN]) {
    const u = generateServiceUnit({ ...spec, controllerArgs: ["--serve", "--token-file=/home/ann/t"] });
    const all = [u.content, ...u.steps, ...u.uninstall, ...u.notes].join("\n");
    assert.ok(!all.includes(SECRET));
    assert.ok(!/^User=|<key>UserName<\/key>|<UserId>(SYSTEM|root)|HighestAvailable|sudo systemctl|sudo launchctl/im.test(all), "no root or elevated identity");
  }
  const linux = generateServiceUnit(POSIX).content;
  for (const line of ["NoNewPrivileges=true", "RestrictSUIDSGID=true", "LockPersonality=true", "UMask=0077"]) assert.ok(linux.split("\n").includes(line), line);
  assert.ok(generateServiceUnit(WIN).content.includes("<RunLevel>LeastPrivilege</RunLevel>"));
  // A logon trigger without a user fires for every user and needs an administrator: the user is required, and names both the trigger and the principal.
  assert.throws(() => generateServiceUnit({ platform: "win32", node: WIN.node, launcher: WIN.launcher, root: WIN.root }), /windowsUser.*required/);
  assert.match(generateServiceUnit(WIN).content, /<LogonTrigger>[^]*<UserId>ANNPC\\ann<\/UserId>[^]*<\/LogonTrigger>[^]*<Principal id="Author">\s*<UserId>ANNPC\\ann<\/UserId>/);
  // The environment is only referenced.
  assert.match(linux, /^EnvironmentFile=\/home\/ann\/\.config\/nimblenewt\/nimblenewt\.env$/m);
  assert.ok(generateServiceUnit({ ...POSIX, platform: "darwin" }).content.includes("<string>--env-file=/home/ann/.config/nimblenewt/nimblenewt.env</string>"));
  assert.ok(generateServiceUnit(WIN).content.includes("--env-file=C:\\Users\\ann\\nimblenewt.env"));
});

test("the default systemd unit sets no option that namespaces the service or blocks the sandbox: a user unit with PrivateTmp or ProtectSystem cannot start bubblewrap where user namespaces are restricted (K02 service units review)", () => {
  // Measured on Ubuntu (kernel.apparmor_restrict_unprivileged_userns=1) with systemd-run --user: the bubblewrap health probe is healthy with the options below absent and fails with PrivateTmp or ProtectSystem.
  const BREAKS = /^(PrivateTmp|ProtectSystem|ProtectHome|PrivateUsers|PrivateDevices|PrivateNetwork|PrivateMounts|PrivateIPC|ProtectKernel\w*|ProtectControlGroups|ProtectProc|ProcSubset|ProtectHostname|ProtectClock|ReadOnlyPaths|InaccessiblePaths|ReadWritePaths|TemporaryFileSystem|BindPaths|BindReadOnlyPaths|RootDirectory|RootImage|RestrictNamespaces|SystemCallFilter|MemoryDenyWriteExecute|RestrictAddressFamilies|DynamicUser)=/m;
  const { envFile: _e, logDir: _l, ...bare } = POSIX; void _e; void _l;
  for (const spec of [POSIX, bare]) {
    const u = generateServiceUnit(spec);
    assert.ok(!BREAKS.test(u.content), `default unit sets ${BREAKS.exec(u.content)?.[0]}`);
    assert.match(u.notes.join("\n"), /No PrivateTmp, ProtectSystem/);
  }
  // ProtectSystem stays an explicit opt-in, with a warning to check the sandbox.
  const full = generateServiceUnit({ ...POSIX, protectSystem: "full" });
  assert.match(full.content, /^ProtectSystem=full$/m);
  assert.ok(!/^PrivateTmp=/m.test(full.content));
  assert.match(full.notes.join("\n"), /WARNING: ProtectSystem=full/);
});

test("a percent sign in a path that systemd reads unquoted is doubled, so it is not taken for a specifier (K02 service units review)", () => {
  const u = generateServiceUnit({ ...POSIX, envFile: "/home/ann/50%h/nn.env", logDir: "/home/ann/logs%n", root: "/home/ann/r%%t", protectSystem: "strict", readWritePaths: ["/home/ann/d%i"] }).content;
  assert.match(u, /^EnvironmentFile=\/home\/ann\/50%%h\/nn\.env$/m);
  assert.match(u, /^StandardOutput=append:\/home\/ann\/logs%%n\/nimblenewt\.log$/m);
  assert.match(u, /^StandardError=append:\/home\/ann\/logs%%n\/nimblenewt\.log$/m);
  assert.match(u, /^ReadWritePaths="\/home\/ann\/r%%%%t" "\/home\/ann\/logs%%n" "\/home\/ann\/d%%i"$/m);
  assert.match(u, /"--root" "\/home\/ann\/r%%%%t"/);
  // No other single % is left anywhere in the unit (a specifier would be expanded by systemd).
  for (const line of u.split("\n").filter((l) => !l.startsWith("#"))) assert.ok(!/(^|[^%])%([^%]|$)/.test(line.replaceAll("%%", "")), line);
});

test("secrets and Node's own flags are refused as controller arguments (K02 service units)", () => {
  for (const arg of ["--token=abc", "--api-key=abc", "--password", "--secret=x", "sk-abcdefghijklmnop", "ghp_abcdefghijklmnopqrstuvwxyz", "AKIAABCDEFGHIJKLMNOP", "https://user:hunter2@example.com/x", "Bearer abc", "--env-file=/etc/shadow", "--env-file-if-exists", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9"]) {
    assert.throws(() => generateServiceUnit({ ...POSIX, controllerArgs: [arg] }), ServiceSpecError, arg);
  }
  // The shared credential scanner (any letter case, fullwidth letters, invisible characters, split strings, long random runs); the keys are built at run time, a push-protection scan reads every commit.
  const gh = "gh" + "p_" + "aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3kM5";
  for (const arg of [gh.toUpperCase(), gh.replace("ghp_", "\uff47\uff48\uff50\uff3f"), `${gh.slice(0, 10)}\u200b${gh.slice(10)}`, `"${gh.slice(0, 5)}"+"${gh.slice(5)}"`, "AS" + "IAABCDEFGHIJKLMNOP", "gl" + "pat-aB3dE5gH7jK9mN1pQ3sT", "aB3dE5gH7jK9mN1pQ3sT" + "5vX7zA9cE1gI3kM5nP7r"]) {
    assert.throws(() => generateServiceUnit({ ...POSIX, controllerArgs: [arg] }), ServiceSpecError, arg);
  }
  // A name that points at a file is fine; the value is not a secret.
  assert.doesNotThrow(() => generateServiceUnit({ ...POSIX, controllerArgs: ["--token-file=/home/ann/t", "--serve"] }));
});

test("hostile paths: relative, unnormalised, control characters and line breaks are refused on every platform (K02 service units)", () => {
  const posix = ["relative/path", "./x", "/a/../b", "/a/./b", "/a//b", "/a/b/", "", "/a\nExecStartPre=/bin/evil", "/a\rb", "/a\u0000b", "/a\u2028b", "/a\u2029b", "/a\u0085b", "/a\u007fb", "/a\u001bb", "/a\tb", "/a\ufeffb", "/lone\ud800", "x".repeat(2000)];
  for (const p of posix) for (const field of ["node", "launcher", "root"] as const) {
    assert.throws(() => generateServiceUnit({ ...POSIX, platform: "darwin", [field]: p }), ServiceSpecError, `${field}=${JSON.stringify(p).slice(0, 40)}`);
    assert.throws(() => generateServiceUnit({ ...POSIX, [field]: p }), ServiceSpecError);
  }
  const win = ["relative\\path", "C:relative", "\\\\server\\share\\x", "\\\\?\\C:\\x", "C:/forward/slash", "C:\\a\\..\\b", "C:\\a\\\\b", "C:\\a\\", "C:\\a\nb", "C:\\a\u0000b", "C:\\a|b", "C:\\a<b>", "C:\\a?b", "C:\\a*b", "C:\\a\"b", "C:\\50%\\x", "C:\\a:stream", "C:\\CON", "C:\\a\\nul.txt", "C:\\trailing.\\x", "C:\\trailing \\x", "/unix/path"];
  for (const p of win) for (const field of ["node", "launcher", "root"] as const) assert.throws(() => generateServiceUnit({ ...WIN, [field]: p }), ServiceSpecError, `${field}=${JSON.stringify(p)}`);
  for (const field of ["envFile", "logDir"] as const) {
    assert.throws(() => generateServiceUnit({ ...POSIX, [field]: "relative" }), ServiceSpecError);
    assert.throws(() => generateServiceUnit({ ...POSIX, [field]: "/a\nb" }), ServiceSpecError);
  }
});

test("hostile arguments: control characters and line breaks are refused; quotes, spaces, $, %, shell metacharacters and XML specials are escaped in each format (K02 service units)", () => {
  for (const arg of ["a\nb", "a\rb", "a\u0000b", "--x=\u2028y", "tab\there", ""]) for (const platform of ["linux", "darwin", "win32"] as const) {
    assert.throws(() => generateServiceUnit({ ...(platform === "win32" ? WIN : { ...POSIX, platform }), controllerArgs: [arg] }), ServiceSpecError, JSON.stringify(arg));
  }
  assert.throws(() => generateServiceUnit({ ...POSIX, controllerArgs: ["x".repeat(2000)] }), ServiceSpecError);
  assert.throws(() => generateServiceUnit({ ...POSIX, controllerArgs: Array.from({ length: 40 }, () => "a") }), ServiceSpecError);
  assert.throws(() => generateServiceUnit({ ...POSIX, controllerArgs: [";"] }), ServiceSpecError, "a lone ; separates systemd commands");
  assert.throws(() => generateServiceUnit({ ...POSIX, entry: "../evil.js" }), ServiceSpecError);
  assert.throws(() => generateServiceUnit({ ...POSIX, entry: "/etc/evil.js" }), ServiceSpecError);
  assert.throws(() => generateServiceUnit({ ...POSIX, entry: "a b.js" }), ServiceSpecError);

  const hostile = ["--note=say \"hi\" 'there'", "$(touch /tmp/pwn)", "`id`", "a;b|c&d>e<f", "50% $HOME ${HOME} %h", "<&>\"'", "back\\slash\\", "--x=a b  c", "\\\""];
  const linux = generateServiceUnit({ ...POSIX, controllerArgs: hostile }).content;
  const exec = linux.split("\n").find((l) => l.startsWith("ExecStart="))!;
  assert.ok(exec.includes('"--note=say \\"hi\\" \'there\'"'));
  assert.ok(exec.includes('"50%% $$HOME $${HOME} %%h"'), "specifiers and variables are doubled");
  assert.ok(exec.includes('"back\\\\slash\\\\"'));
  assert.equal(linux.split("\n").filter((l) => l.startsWith("ExecStart=")).length, 1, "no argument starts a second directive");
  const plist = generateServiceUnit({ ...POSIX, platform: "darwin", controllerArgs: hostile }).content;
  assert.ok(plist.includes("<string>&lt;&amp;&gt;&quot;&apos;</string>"));
  assert.equal((plist.match(/<string>/g) ?? []).length, (plist.match(/<\/string>/g) ?? []).length);
  const task = generateServiceUnit({ ...WIN, controllerArgs: hostile.filter((a) => !a.includes("%")) }).content;
  assert.ok(task.includes("&lt;&amp;&gt;"), "XML specials escaped");
  const argText = /<Arguments>([^]*?)<\/Arguments>/.exec(task)![1]!;
  assert.ok(!/[<>]/.test(argText) && !/&(?!amp;|lt;|gt;|quot;|apos;)/.test(argText), "only entities, no raw markup");
  assert.throws(() => generateServiceUnit({ ...WIN, controllerArgs: ["50%"] }), ServiceSpecError);
});

test("paths with spaces and XML specials are kept whole where the format allows it, and refused where an unquoted directive would split them (K02 service units)", () => {
  const spaced = { node: "/opt/my node/bin/node", launcher: "/opt/my tools/launcher dir/nimblenewt-launcher.mjs", root: "/data/New & Used/root" };
  const linux = generateServiceUnit({ ...POSIX, ...spaced }).content;
  assert.ok(linux.includes('ExecStart="/opt/my node/bin/node" "/opt/my tools/launcher dir/nimblenewt-launcher.mjs" "--root" "/data/New & Used/root"'));
  const darwin = generateServiceUnit({ ...POSIX, ...spaced, platform: "darwin" }).content;
  assert.ok(darwin.includes("<string>/data/New &amp; Used/root</string>"));
  assert.throws(() => generateServiceUnit({ ...POSIX, envFile: "/home/ann/my env" }), ServiceSpecError, "an unquoted EnvironmentFile cannot hold a space");
  assert.throws(() => generateServiceUnit({ ...POSIX, logDir: "/home/ann/$logs" }), ServiceSpecError);
  assert.doesNotThrow(() => generateServiceUnit({ ...POSIX, platform: "darwin", logDir: "/Users/ann/My Logs", envFile: "/Users/ann/My Env/.env" }));
  const win = generateServiceUnit({ ...WIN, root: "C:\\New & Used (x86)\\O'Brien" }).content;
  assert.ok(win.includes("<WorkingDirectory>C:\\New &amp; Used (x86)\\O&apos;Brien</WorkingDirectory>"));
  const steps = generateServiceUnit({ ...WIN, root: "C:\\O'Brien" }).steps.join("\n");
  assert.ok(steps.includes("'C:\\O''Brien'"), "PowerShell single quotes doubled");
  const shell = generateServiceUnit({ ...POSIX, platform: "darwin", root: "/data/it's here" }).steps.join("\n");
  assert.ok(shell.includes("'/data/it'\\''s here'"));
});

test("names are restricted so they cannot escape a file name, a label or a quoted step (K02 service units)", () => {
  for (const name of ["", "-x", ".x", "a b", "a/b", "a\\b", "a'b", "a\"b", "a$b", "a;b", "a\nb", "x".repeat(65), "../x", "a%b"]) assert.throws(() => generateServiceUnit({ ...POSIX, name }), ServiceSpecError, JSON.stringify(name));
  assert.equal(generateServiceUnit({ ...POSIX, name: "nn-test_2.a" }).fileName, "nn-test_2.a.service");
  for (const user of ["SYSTEM", "root", "Administrator", "NT AUTHORITY\\SYSTEM", "a'b", "a<b", "a\nb", "DOM\\"]) assert.throws(() => generateServiceUnit({ ...WIN, windowsUser: user }), ServiceSpecError, user);
  assert.throws(() => generateServiceUnit({ ...WIN, switcher: "symlink" }), ServiceSpecError);
  assert.throws(() => generateServiceUnit({ ...POSIX, windowsUser: "ann" }), ServiceSpecError);
  assert.throws(() => generateServiceUnit({ ...POSIX, platform: "freebsd" as never }), ServiceSpecError);
  assert.throws(() => generateServiceUnit({ ...POSIX, switcher: "hardlink" as never }), ServiceSpecError);
});

test("escaping helpers: round trips through each format's own parser rules (K02 service units)", () => {
  assert.equal(xmlEscape(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  assert.equal(powershellQuote("a'b"), "'a''b'");
  assert.equal(systemdWord('a"b\\c%d$e'), '"a\\"b\\\\c%%d$$e"');
  // CommandLineToArgvW rules, checked against an independent parser.
  const parse = (line: string): string[] => {
    const out: string[] = []; let cur = ""; let inQ = false; let started = false;
    for (let i = 0; i < line.length; i++) {
      let bs = 0;
      while (line[i] === "\\") { bs++; i++; }
      if (line[i] === '"') {
        cur += "\\".repeat(Math.floor(bs / 2)); started = true;
        if (bs % 2 === 1) cur += '"'; else if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ;
      } else {
        cur += "\\".repeat(bs); if (bs > 0) started = true;
        const ch = line[i];
        if (ch === undefined) break;
        if (/\s/.test(ch) && !inQ) { if (started) out.push(cur); cur = ""; started = false; } else { cur += ch; started = true; }
      }
    }
    if (started) out.push(cur);
    return out;
  };
  const samples = ["plain", "with space", 'quo"te', "back\\", "back\\\\", 'back\\"quote', "a\\b c\\", "C:\\Program Files\\x y\\", '""', "", "tail\\\\\\"];
  assert.deepEqual(parse(samples.map(windowsArg).join(" ")), samples);
});

test("checkServicePath accepts ordinary absolute paths in each platform's spelling (K02 service units)", () => {
  assert.equal(checkServicePath("linux", "p", "/"), "/");
  assert.equal(checkServicePath("darwin", "p", "/Users/Ann Lee/Library"), "/Users/Ann Lee/Library");
  assert.equal(checkServicePath("win32", "p", "C:\\"), "C:\\");
  assert.equal(checkServicePath("win32", "p", "D:\\Users\\Ann Lee\\NN"), "D:\\Users\\Ann Lee\\NN");
});

test("exit-code contract: the restart policy matches the launcher's and controller's exit codes (K02 service units)", () => {
  // The policy is derived from the supervisor's own table, and every code in that table is classified exactly once.
  const codes = [...Object.values(SUPERVISOR_EXIT), 1];
  assert.deepEqual([...SERVICE_RESTART.noRestart, ...SERVICE_RESTART.restart].sort(), [...new Set(codes)].sort(), "every exit code of the launcher is classified");
  assert.deepEqual([...SERVICE_RESTART.noRestart].sort(), [0, 2, 3, 4], "0 stop, 2 blocked, 3 no release and 4 crash loop stay down");
  assert.deepEqual([...SERVICE_RESTART.restart].sort(), [1, 5], "1 usage or unexpected error and 5 second launcher are restarted");
  assert.equal(SUPERVISOR_EXIT.stopped, CONTROLLER_EXIT.stop, "a controller stop on purpose is the launcher's exit 0");
  const unit = generateServiceUnit(POSIX).content;
  const prevent = /^RestartPreventExitStatus=(.*)$/m.exec(unit)![1]!.split(" ").map(Number).sort();
  assert.deepEqual(prevent, SERVICE_RESTART.noRestart.filter((n) => n !== 0).sort(), "systemd: 2 3 4 are prevented; 0 is already no restart under on-failure");
  assert.match(unit, /^Restart=on-failure$/m, "on-failure never restarts an exit 0");
  assert.ok(!SERVICE_RESTART.restart.some((c) => prevent.includes(c)), "1 and 5 are not prevented");
  assert.match(unit, new RegExp(`^RestartSec=${SERVICE_RESTART.delaySeconds}$`, "m"));
  assert.match(unit, new RegExp(`^StartLimitBurst=${SERVICE_RESTART.startLimitBurst}$`, "m"));
  // launchd: restart only after a failure (an exit 0 stays down), throttled; Windows: bounded restarts.
  const plist = generateServiceUnit({ ...POSIX, platform: "darwin" }).content;
  assert.ok(/<key>SuccessfulExit<\/key>\s*<false\/>/.test(plist));
  assert.ok(plist.includes(`<integer>${SERVICE_RESTART.launchdThrottleSeconds}</integer>`));
  const task = generateServiceUnit(WIN).content;
  assert.ok(task.includes(`<Count>${SERVICE_RESTART.windowsRestartCount}</Count>`) && task.includes(`<Interval>${SERVICE_RESTART.windowsRestartInterval}</Interval>`));
  // The documented limits of launchd and Task Scheduler are stated in the notes, not hidden.
  assert.match(generateServiceUnit({ ...POSIX, platform: "darwin" }).notes.join("\n"), /cannot tell the launcher's exit codes apart/);
  assert.match(generateServiceUnit(WIN).notes.join("\n"), /cannot tell the launcher's exit codes apart/);
  // The stop timeout leaves the launcher's own grace (10 s default) and the controller's stop room.
  assert.ok(SERVICE_RESTART.stopTimeoutSeconds >= 30);
});

test("the launcher program's header comment and the documented exit codes agree with the table (K02 service units)", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "scripts", "nimblenewt-launcher.mjs"), "utf8");
  for (const [code, word] of [[0, "stopped"], [2, "blocked"], [3, "no release"], [4, "gave up after a crash loop"], [5, "another launcher"]] as const) assert.ok(new RegExp(`${code} ${word}`).test(src), `launcher header names exit ${code} (${word})`);
  // The header's advice to a service manager is the table's (it once said "may restart it on 1, 4 and 5").
  const flat = src.split("\n").filter((l) => l.startsWith("//")).map((l) => l.replace(/^\/\/ ?/, "")).join(" ");
  const no = SERVICE_RESTART.noRestart;
  assert.ok(flat.includes(`should not restart the launcher on ${no.slice(0, -1).join(", ")} or ${no.at(-1)}`), "header: the codes not restarted");
  const yes = SERVICE_RESTART.restart;
  assert.ok(flat.includes(`may restart it on ${yes.slice(0, -1).join(", ")} and ${yes.at(-1)}`), "header: the codes restarted");
  for (const doc of ["maintenance-and-updates.md"]) {
    const text = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "docs", "nimblenewt", doc), "utf8");
    assert.ok(text.includes("should not restart it on 0, 2, 3 or 4") && text.includes("may restart it on 1 and 5"), `${doc} states the same policy`);
  }
});

test("the install steps never run anything themselves: they are text, the unit file is written by a heredoc the owner runs (K02 service units)", () => {
  for (const spec of [POSIX, { ...POSIX, platform: "darwin" as const }, WIN]) {
    const u = generateServiceUnit(spec);
    assert.ok(u.steps[0]!.includes("Nothing below has been run"));
    assert.ok(u.steps.some((s) => s.includes(u.content)), "the exact unit text is in the steps");
  }
});
