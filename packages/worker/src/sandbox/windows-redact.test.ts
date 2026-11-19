import assert from "node:assert/strict";
import { test } from "node:test";
import { WITHHELD, cutWhole, redact, redactAccountName, redactAndCut, redactSid, scrub, scrubDeep, sidClass } from "./windows-redact.js";

const names = { users: ["JimBob", "NimbleNewtRunner"], hosts: ["DESKTOP-4F2K9"] };

test("home directories go, in every form they appear", () => {
  for (const text of ["C:\\Users\\Alice\\work", "c:/users/Alice/work", "C:\\\\Users\\\\Alice\\\\work", '"C:\\Users\\Alice Smith\\x"', "'C:\\Users\\Alice'", "D:\\Users\\Alice\\a"]) {
    const out = redact(text, names);
    assert.ok(!/Alice/i.test(out), `${text} -> ${out}`);
    assert.ok(out.includes("<home>"), out);
  }
  assert.equal(redact("C:\\Users\\Alice\\work\\x.txt", names), "<home>\\work\\x.txt");
  // A name with a space is one folder; an unknown name is a home too; old-style roots and URL-encoded forms are covered.
  assert.equal(redact("C:\\Users\\Alice Smith\\AppData\\x", names), "<home>\\AppData\\x");
  assert.equal(redact("C:\\Users\\Zed Q Public\\AppData\\x", names), "<home>\\AppData\\x");
  assert.equal(redact("C:\\Documents and Settings\\Zed\\x", names), "<home>\\x");
  assert.equal(redact("file=C%3A%5CUsers%5CZed%20Q%5Cx", names), "file=<home>\\x");
  assert.ok(!/Smith|Zed/.test(redact('"C:\\Users\\Alice Smith\\x" and C:\\\\Users\\\\Zed Q\\\\y', names)));
});

test("SIDs are redacted by class, with and without the icacls asterisk: machine, domain and account parts go, well-known kinds of account stay", () => {
  assert.equal(redact("owner S-1-5-21-111-222-333-1001 and *S-1-5-18", names), "owner S-1-5-21-<domain>-<account> and *S-1-5-18");
  // Well-known, machine-independent SIDs stay exactly: system accounts, built-in groups, the service SID of TrustedInstaller, app packages, capabilities, the SERVICE group.
  const kept = ["S-1-5-18", "S-1-5-19", "S-1-5-20", "S-1-5-6", "S-1-5-32-544", "S-1-5-32-545", "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464", "S-1-15-2-1", "S-1-15-2-2",
    "S-1-15-2-1430448594-2639229838-973813799-439329657-1197984847-4069167804-1277922394", "S-1-15-3-1024-3635283841-2530182609-996808640-1887759898-3848208603-3313616867-983405619-2501854204", "S-1-5-83-0", "S-1-1-0", "S-1-3-0"];
  for (const sid of kept) { assert.equal(redactSid(sid), sid); assert.equal(redact(`x ${sid}:(I)(RX)`, names), `x ${sid}:(I)(RX)`); assert.equal(scrub(`writer ${sid} (I)(OI)(CI)(M)`, names), `writer ${sid} (I)(OI)(CI)(M)`); }
  // Machine and domain SIDs keep their class, and only a built-in RID below 1000; Azure AD accounts, logon sessions and anything unknown keep only their kind.
  assert.equal(redactSid("S-1-5-21-111-222-333-500"), "S-1-5-21-<domain>-500");
  assert.equal(redactSid("S-1-5-21-111-222-333-504"), "S-1-5-21-<domain>-504");
  assert.equal(redactSid("S-1-5-21-111-222-333-1001"), "S-1-5-21-<domain>-<account>");
  assert.equal(redactSid("S-1-5-21-111-222-1001"), "S-1-5-21-<domain>-<account>", "a machine SID of another shape keeps no number");
  assert.equal(redactSid("s-1-5-21-111-222-333-1001"), "S-1-5-21-<domain>-<account>");
  assert.equal(redactSid("S-1-12-1-1111-2222-3333-4444"), "S-1-12-1-<account>");
  assert.equal(redactSid("S-1-5-5-0-123456"), "S-1-5-5-<session>");
  assert.equal(redactSid("S-1-9-1-2"), "S-1-9-<other>");
  assert.equal(redactSid("S-1-5-1234"), "S-1-5-<other>", "an unknown S-1-5 SID is not kept");
  assert.equal(redactSid("S-1-5-21"), "S-1-5-<other>");
  for (const notSid of ["", "S-1", "S-1-5", "NT AUTHORITY\\SYSTEM", "S-1-5-18 ", "S-1-5-x"]) assert.equal(redactSid(notSid), "<sid>", JSON.stringify(notSid));
  // A prefix that merely looks well-known is not: S-1-5-320 is not S-1-5-32-, S-1-15-20 is not S-1-15-2-.
  assert.equal(redactSid("S-1-5-320-1"), "S-1-5-<other>");
  assert.equal(redactSid("S-1-15-20-1"), "S-1-15-<other>");
  assert.equal(sidClass("S-1-15-3-1024-1"), "app capability");
  assert.equal(sidClass("S-1-15-2-5-6"), "app package");
  assert.equal(sidClass("S-1-5-80-1-2"), "service (per-service SID)");
  assert.equal(sidClass("S-1-5-21-1-2-3-1001"), "machine or domain account or group");
  assert.equal(sidClass("S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"), "TrustedInstaller");
  assert.equal(sidClass("x"), "not a SID");
  // Process trust labels (S-1-19-<type>-<level>) are fixed values, the same on every machine: kept, in text and in an access-list line, and passed by the last gate.
  assert.equal(redactSid("S-1-19-512-8192"), "S-1-19-512-8192");
  assert.equal(sidClass("S-1-19-512-8192"), "process trust label");
  assert.equal(redactSid("S-1-190-1-2"), "S-1-190-<other>", "S-1-190 is not S-1-19-");
  const label = "C:\\x NT AUTHORITY\\SYSTEM:(I)(F)\r\n      S-1-19-512-8192:(I)(RX,D,WDAC,WO,WA)";
  assert.equal(redact(label, names), label);
  assert.equal(scrub("wsb.exe can be changed by S-1-19-512-8192", names), "wsb.exe can be changed by S-1-19-512-8192");
  // In text and in the last gate: a machine SID is replaced (with its asterisk kept), the result is stable when redacted again, and an access-list line with a kept SID keeps it.
  const once = redact("C:\\x S-1-5-21-111-222-333-1001:(OI)(CI)(F)\r\n    *S-1-15-3-1024-1-2:(RX)\r\n    S-1-5-21-111-222-333-1001-5", names);
  assert.ok(!/111|222|333|1001/.test(once), once);
  assert.match(once, /S-1-15-3-1024-1-2:\(RX\)/);
  assert.equal(redact(once, names), once, "redacting twice changes nothing");
  assert.equal(scrub(once, names), once, "the gate accepts the redacted forms");
  assert.equal(scrub("S-1-5-21-<domain>-500 and S-1-12-1-<account> and S-1-9-<other>", names), "S-1-5-21-<domain>-500 and S-1-12-1-<account> and S-1-9-<other>");
});

test("an account on this machine that is not a known name still goes (another account at the console); a share on this machine stays", () => {
  assert.equal(
    redact("the console session belongs to DESKTOP-4F2K9\\Zed.Q, not the configured owner desktop-4f2k9\\\\JimBob", names),
    "the console session belongs to <host>\\<user>, not the configured owner <host>\\<user>",
  );
  assert.equal(redact("(DESKTOP-4F2K9\\other-account)", names), "(<host>\\<user>)");
  assert.equal(redact("\\\\DESKTOP-4F2K9\\share\\dir", names), "\\\\<host>\\share\\dir");
  assert.equal(scrub("the console session belongs to DESKTOP-4F2K9\\Zed, not the configured owner DESKTOP-4F2K9\\JimBob", names), "the console session belongs to <host>\\<user>, not the configured owner <host>\\<user>");
});

test("known user and machine names go as whole words, in quotes too, and case does not matter", () => {
  const out = redact(`user "JimBob" 'jimbob' (nimblenewtrunner) on DESKTOP-4F2K9; jimbobby stays, DESKTOP-4F2K9\\JimBob, DESKTOP-4F2K9\\\\JimBob`, names);
  assert.ok(!/JimBob\b|nimblenewtrunner|DESKTOP-4F2K9/i.test(out.replace("jimbobby", "")), out);
  assert.ok(out.includes('"<user>"') && out.includes("jimbobby"));
  assert.equal(redact("DESKTOP-4F2K9\\JimBob", names), "<host>\\<user>");
});

test("UNC server names go", () => {
  assert.equal(redact("\\\\fileserver01\\share\\dir", names), "\\\\<host>\\share\\dir");
  assert.equal(redact("\\\\?\\C:\\x \\\\.\\pipe\\y", names), "\\\\?\\C:\\x \\\\.\\pipe\\y");
  // Escaped as in JSON, a UNC path still loses its server name (the run of backslashes kept), after a space, a quote, an equals sign or a word's colon.
  assert.equal(redact("\\\\\\\\fileserver01\\\\share", names), "\\\\\\\\<host>\\\\share");
  assert.equal(redact('at "\\\\fileserver01\\share" path=\\\\fs2\\s file:\\\\fs3\\s', names), 'at "\\\\<host>\\share" path=\\\\<host>\\s file:\\\\<host>\\s');
});

test("a JSON-escaped local path keeps its folder names: two backslashes after a drive or inside a path are a separator, not a UNC server", () => {
  const escaped = JSON.stringify("C:\\Program Files\\WindowsApps\\MicrosoftWindows.WindowsSandbox_0.8.114.0_x64__cw5n1h2txyewy\\wsb.exe can be changed by S-1-19-512-8192");
  assert.equal(redact(escaped, names), escaped);
  const twice = JSON.stringify(escaped);
  assert.equal(redact(twice, names), twice);
  assert.equal(redact("D:\\\\Program Files (x86)\\\\Tools\\\\a.b\\\\c", names), "D:\\\\Program Files (x86)\\\\Tools\\\\a.b\\\\c");
  // A home folder in the escaped form is still replaced.
  assert.ok(!/Alice/.test(redact(JSON.stringify("C:\\Users\\Alice\\x"), names)));
  // After a placeholder or a closing brace the run is a separator too: the folder after a home, the account after a machine and a folder after a GUID folder keep their
  // placeholder or name, as they do unescaped.
  assert.equal(redact(JSON.stringify("C:\\Users\\Alice\\Documents\\x"), names), JSON.stringify("<home>\\Documents\\x"));
  assert.equal(redact(JSON.stringify("C:\\ProgramData\\Package Cache\\{AB-12}\\setup.exe"), names), JSON.stringify("C:\\ProgramData\\Package Cache\\{AB-12}\\setup.exe"));
  assert.equal(redact(JSON.stringify("DESKTOP-4F2K9\\someone ran it"), names), JSON.stringify("<host>\\<user> ran it"));
  assert.equal(redact(JSON.stringify("\\\\10.1.2.3\\share"), names), JSON.stringify("\\\\<host>\\share"));
  // Linear on long runs of backslashes.
  const started = Date.now();
  redact(`${"\\".repeat(100_000)} ${"a\\\\".repeat(100_000)}`, names);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});

test("escaped multi-line text: a server, a known name or an account at the start of a line (after \\n, \\t or a colour code) still goes", () => {
  // A UNC path on the next line of JSON or inspected output: the n of the escaped line break does not end a name, at one level of escaping and at two.
  assert.equal(redact(JSON.stringify("first line\n\\\\fileserver01\\share"), names), JSON.stringify("first line\n\\\\<host>\\share"));
  assert.equal(redact(JSON.stringify("a\t\\\\fs2\\s"), names), JSON.stringify("a\t\\\\<host>\\s"));
  const twice = JSON.stringify(JSON.stringify("x\r\n\\\\fs3\\s\r\nnext"));
  assert.equal(redact(twice, names), JSON.stringify(JSON.stringify("x\r\n\\\\<host>\\s\r\nnext")));
  assert.equal(redact("\x1b[31m\\\\fs4\\s", names), "\x1b[31m\\\\<host>\\s");
  // A long UNC path names its server after UNC; a long local path keeps its drive.
  assert.equal(redact("\\\\?\\UNC\\fs5\\share", names), "\\\\?\\UNC\\<host>\\share");
  assert.equal(redact(JSON.stringify("\\\\?\\UNC\\fs5\\share \\\\?\\C:\\x"), names), JSON.stringify("\\\\?\\UNC\\<host>\\share \\\\?\\C:\\x"));
  // Known names right after an escaped line break or a colour code, and in the last gate.
  assert.equal(redact(JSON.stringify("ran as\nJimBob"), names), JSON.stringify("ran as\n<user>"));
  assert.equal(redact("\x1b[32mJimBob\x1b[0m on \\x1b[1mDESKTOP-4F2K9", names), "\x1b[32m<user>\x1b[0m on \\x1b[1m<host>");
  assert.equal(scrub(JSON.stringify("x\tDESKTOP-4F2K9\\someone"), names), JSON.stringify("x\t<host>\\<user>"));
  assert.equal(redact("DESKTOP-4F2K9\\someone\x1b[31m\\\\fs6\\s", names), "<host>\\<user>\x1b[31m\\\\<host>\\s");
  // An access list printed escaped is one line: an account after an escaped DOMAIN\\ goes unless it is well known; the rights, the domain and the path stay.
  const acl = ["C:\\x NT AUTHORITY\\SYSTEM:(I)(F)", "      CORP\\bob:(OI)(CI)(M)", "      CORP\\John Smith:(F)", "      APPLICATION PACKAGE AUTHORITY\\ALL APPLICATION PACKAGES:(RX)", "      BUILTIN\\Users:(RX)"].join("\r\n");
  assert.equal(redact(JSON.stringify(acl), names), JSON.stringify(acl.replace("CORP\\bob", "CORP\\<user>").replace("CORP\\John Smith", "CORP\\<user>")));
  assert.equal(redact(JSON.stringify("C:\\x\\App Everyone:(R)"), names), JSON.stringify("C:\\x\\App Everyone:(R)"));
  // A drive at the start of an escaped line or after a colour code is a drive, at one level of escaping and at two; a colour code escaped twice is not a server; an
  // escaped colour code after a machine name is not an account.
  for (const local of ["ran\nC:\\Program Files\\WindowsApps\\x", "a\tD:\\Tools\\{AB-12}\\y", "\x1b[32mC:\\Program Files\\x\x1b[0m", "\x1b[32m\\\\?\\C:\\Program Files\\x"]) {
    assert.equal(redact(JSON.stringify(local), names), JSON.stringify(local));
    assert.equal(redact(JSON.stringify(JSON.stringify(local)), names), JSON.stringify(JSON.stringify(local)));
  }
  assert.equal(redact(JSON.stringify(JSON.stringify("\x1b[32m\\\\fs8\\s")), names), JSON.stringify(JSON.stringify("\x1b[32m\\\\<host>\\s")));
  assert.equal(redact(JSON.stringify("DESKTOP-4F2K9\x1b[0m"), names), JSON.stringify("<host>\x1b[0m"));
  // A coloured account after the machine name and its separator is still an account; an access-list account after a domain read as a server still goes.
  assert.equal(redact(JSON.stringify("DESKTOP-4F2K9\\\x1b[32mzed01\x1b[0m"), names), JSON.stringify("<host>\\\x1b[32m<user>\x1b[0m"));
  assert.equal(redact(JSON.stringify(JSON.stringify("DESKTOP-4F2K9\x1b[0m")), names), JSON.stringify(JSON.stringify("<host>\x1b[0m")));
  for (const local of ["x?\tCORP\\zed02:(F)", "DESKTOP-4F2K9\x1b[0m\nCORP\\zed03:(F)"]) assert.ok(!/zed0/.test(redact(JSON.stringify(JSON.stringify(local)), names)), local);
  // A `?` that is not part of a `\\?\` prefix does not make the next run a separator.
  assert.equal(redact("where?\\\\fs7\\s", names), "where?\\\\<host>\\s");
  // Linear on long lines of escapes, colour codes and domains.
  const started = Date.now();
  for (const long of ["a\\n".repeat(70_000), "\x1b[31m".repeat(40_000), " CORP\\\\bob".repeat(30_000), ` CORP${"\\".repeat(100_000)}b:(F)`]) redact(long, names);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});

test("accounts in an access list go unless they are well known; rights stay", () => {
  const acl = [
    "C:\\Jobs\\work NT AUTHORITY\\SYSTEM:(OI)(CI)(F)", "      BUILTIN\\Administrators:(OI)(CI)(F)", "      OTHERBOX\\Dana:(OI)(CI)(M)", "      Dana2:(I)(OI)(CI)(RX)",
    "      Authenticated Users:(I)(OI)(CI)(WD,AD)", "      CREATOR OWNER:(OI)(CI)(IO)(F)", "      Everyone:(DENY)(W)", "      NT SERVICE\\TrustedInstaller:(CI)(F)", "      MYDOMAIN\\Erin Lee:(DENY)(WD)",
  ].join("\n");
  const out = redact(acl, names);
  for (const gone of ["Dana", "OTHERBOX", "Erin", "Lee", "MYDOMAIN"]) assert.ok(!out.includes(gone), out);
  for (const kept of ["NT AUTHORITY\\SYSTEM:(OI)(CI)(F)", "BUILTIN\\Administrators:(OI)(CI)(F)", "Authenticated Users:(I)(OI)(CI)(WD,AD)", "CREATOR OWNER:(OI)(CI)(IO)(F)", "Everyone:(DENY)(W)", "NT SERVICE\\TrustedInstaller:(CI)(F)"]) assert.ok(out.includes(kept), kept + "\n" + out);
  assert.ok(out.includes("<user>:(OI)(CI)(M)") && out.includes("<user>:(I)(OI)(CI)(RX)"));
});

test("accounts with spaces, or behind a known machine name, are redacted whole", () => {
  const out = redact(["      DESKTOP-4F2K9\\Dana:(OI)(CI)(M)", "      <host>\\Dana Smith:(M)", "C:\\x MYDOMAIN\\Erin Lee:(DENY)(WD)", "      DESKTOP-4F2K9\\JimBob:(F)"].join("\n"), names);
  for (const gone of ["Dana", "Smith", "Erin", "Lee"]) assert.ok(!out.includes(gone), out);
  assert.ok(out.includes("(DENY)(WD)") && out.includes("<host>\\<user>:(F)"), out);
});

test("e-mail and Microsoft-account forms, and the local part elsewhere", () => {
  const out = redact("MicrosoftAccount\\robert.hostetter@gmail.com wrote to robert.hostetter@gmail.com; folder hostetter_stuff and robert.hostetter", names);
  assert.ok(!/hostetter|gmail/.test(out.replace("hostetter_stuff", "")), out);
  assert.ok(out.includes("<user>") && out.includes("<email>"));
  assert.ok(!/robert/.test(redact("mail a.robert@example.co.uk now", names)));
});

test("addresses go, loopback and version numbers stay", () => {
  assert.equal(redact("from 192.168.1.20 to 10.0.0.5 and fe80::1ff:fe23:4567:890a, 2001:db8:0:0:0:0:0:1", names), "from <ip> to <ip> and <ip>, <ip>");
  assert.equal(redact("127.0.0.1 ::1 0.8.107.0 10.0.26200", names), "127.0.0.1 ::1 0.8.107.0 10.0.26200");
});

test("UTF-16 output read as bytes is redacted too", () => {
  const utf16 = "C:\\Users\\Alice\\x JimBob".split("").join("\0");
  const out = redactAndCut(utf16, names);
  assert.ok(!out.includes("\0") && !/Alice|JimBob/.test(out), out);
});

test("the last gate withholds a field that still looks personal, and cleans nested values", () => {
  assert.equal(scrub("fine text 10.0.26200", names), "fine text 10.0.26200");
  assert.equal(scrub("owner JimBob here", { users: ["JimBob"] }), "owner <user> here");
  // An underscore is a separator, not part of a name.
  assert.equal(scrub("tmp_Quentinx1", { users: ["Quentinx1"] }), "tmp_<user>");
  const nested = scrubDeep({ a: "C:\\Users\\Alice\\x", b: ["mail me@host.example"], c: 5, d: { key: "S-1-5-21-1-2-3-1001" } }, names);
  assert.deepEqual(nested, { a: "<home>\\x", b: ["mail <email>"], c: 5, d: { key: "S-1-5-21-<domain>-<account>" } });
  assert.equal(WITHHELD, "<withheld: possible personal data>");
});

test("surnames, split names, lower-case SIDs, short names and DNS suffixes", () => {
  const full = { users: ["DESKTOP-4F2K9\\Robert Hostetter", "NimbleNewtRunner"], hosts: ["DESKTOP-4F2K9"] };
  for (const text of ["Hostetter said", "D:\\Data\\Hostetter\\x", "Robert.Hostetter", "robert_hostetter.log", "user Robert\nHostetter split", "user Robert   \r\n  Hostetter"]) assert.ok(!/hostetter/i.test(redact(text, full)), text);
  assert.ok(!/hostetter/i.test(redactAndCut("user Robert\nHostetter split", full)));
  assert.equal(scrub("Hostetter", { users: ["Robert Hostetter"] }), "<user>");
  assert.equal(redact("s-1-5-21-1-2-3-1001 *s-1-5-18", full), "S-1-5-21-<domain>-<account> *S-1-5-18");
  assert.equal(scrub("x s-1-5-21-1-2-3-1001", full), "x S-1-5-21-<domain>-<account>");
  for (const text of ["at ROBERT~1 and ROBERT~1.DES", "ROBERT~1\\AppData", "robert~2"]) assert.ok(!/robert/i.test(redact(text, full)), text);
  const ms = { users: ["DESKTOP-4F2K9\\rober"], hosts: ["DESKTOP-4F2K9"] };
  assert.equal(redact("rober~1 and ROBER~1.TXT", ms), "<user> and <user>");
  // A known name that is a prefix of another account must not leave the rest visible.
  assert.ok(!/er\b/.test(redact("DESKTOP-4F2K9\\rober", { users: ["rob", "DESKTOP-4F2K9\\rober"], hosts: ["DESKTOP-4F2K9"] }).replace("<user>", "")));
  // "rob" does not match inside "rober"; the account after the machine name goes anyway (any `<machine>\\account` is an account).
  assert.equal(redact("DESKTOP-4F2K9\\rober", { users: ["rob"], hosts: ["DESKTOP-4F2K9"] }), "<host>\\<user>");
  assert.equal(redact("rober and rob", { users: ["rob"], hosts: ["DESKTOP-4F2K9"] }), "rober and <user>");
  assert.equal(redact("desktop-4f2k9.fritz.box and DESKTOP-4F2K9.local", full), "<host> and <host>");
});

test("extra words are replaced by the placeholder asked for", () => {
  assert.equal(redact("task NimbleNewt-LockOnLogon runs C:\\Tools\\lock.exe", { other: [{ text: "NimbleNewt-LockOnLogon", as: "<lock-task>" }, { text: "C:\\Tools\\lock.exe", as: "<lock-helper>" }] }), "task <lock-task> runs <lock-helper>");
});

test("redaction is applied before the cut, so a cut cannot leave half a name; the cut is announced", () => {
  const long = `${"x".repeat(2040)} C:\\Users\\Alice\\z`;
  const out = redactAndCut(long, names);
  assert.ok(!out.includes("Ali"), out.slice(-60));
  assert.match(out, /\[cut, \d+ more characters\]$/);
  assert.ok(out.length <= 2048, String(out.length));
  // The note counts toward the limit, also when redaction made the text longer than the limit.
  const grows = "PC\\ab ".repeat(60);
  for (const limit of [400, 401, 4000]) { const cut = scrub(grows, { users: ["ab"], hosts: ["PC"] }, limit); assert.ok(cut.length <= limit && /\[cut, \d+ more characters\]$/.test(cut) === (redact(grows, { users: ["ab"], hosts: ["PC"] }).length > limit), `${limit}: ${cut.length}`); }
  assert.equal(redactAndCut("short", names), "short");
  const once = redact("C:\\Users\\Alice S-1-5-21-7-8-9-1001 and S-1-5-19", names);
  assert.ok(!/Alice|7-8-9/.test(once), once);
  assert.equal(redact(once, names), once, "redacting twice changes nothing");
});

test("plain system text is left alone", () => {
  const text = "C:\\Windows\\System32\\icacls.exe exit 5: Access is denied. C:\\Program Files\\WindowsApps\\X_0.8.107.0_x64__8wekyb3d8bbwe";
  assert.equal(redact(text, names), text);
});

test("access-list findings as the real run writes them pass the last gate whole, and account names in them are kept only when they are fixed names", () => {
  // The by-SID line of the facts: redacted SID, its kind, icacls-style rights. Every kind of SID gives a line the gate keeps as it is, and no machine or account number is left.
  for (const sid of ["S-1-15-3-1024-3635283841-2530182609-996808640-1887759898-3848208603-3313616867-983405619-2501854204", "S-1-5-80-1-2-3-4-5", "S-1-5-21-111-222-333-1001", "S-1-5-21-111-222-333-500", "S-1-12-1-1-2-3-4", "S-1-5-5-0-1", "S-1-9-1"]) {
    const line = `${redactSid(sid)} [${sidClass(sid)}] (I)(OI)(CI)(IO)(M) inherit-only`;
    assert.equal(scrub(line, names), line, line);
    assert.ok(!/111|222|333|1001/.test(line), line);
  }
  // icacls account names: SIDs by class; well-known names and names under authorities whose names are fixed stay; machine and domain accounts become <user>.
  assert.equal(redactAccountName("*S-1-5-21-1-2-3-1001"), "*S-1-5-21-<domain>-<account>");
  assert.equal(redactAccountName("S-1-15-3-1024-1"), "S-1-15-3-1024-1");
  for (const kept of ["NT AUTHORITY\\SYSTEM", "BUILTIN\\Users", "NT SERVICE\\TrustedInstaller", "NT SERVICE\\WaaSMedicSvc", "APPLICATION PACKAGE AUTHORITY\\ALL APPLICATION PACKAGES", "NT VIRTUAL MACHINE\\Virtual Machines", "Everyone", "CREATOR OWNER"]) assert.equal(redactAccountName(kept), kept);
  for (const gone of ["PC\\erin", "DESKTOP-4F2K9\\JimBob", "erin", "MYDOMAIN\\Erin Lee", "NT SERVICE\\a\\b", "NT SERVICE\\x:(F)", "", "NT SERVICE\\line\nbreak", "MicrosoftAccount\\me@example.com"]) assert.equal(redactAccountName(gone), "<user>", JSON.stringify(gone));
});

test("a SID is redacted whatever follows it and however long it is; only the redacted heads before a placeholder are left, and the gate judges the same way", () => {
  // A raw machine SID directly followed by "-<" (as when a name after it was already a placeholder) is still redacted, and the gate withholds it if it ever got through.
  assert.equal(redact("S-1-5-21-1111-2222-3333-1001-<x>", names), "S-1-5-21-<domain>-<account>-<x>");
  assert.equal(scrub("S-1-5-21-1111-2222-3333-1001-<x>", names), "S-1-5-21-<domain>-<account>-<x>");
  // A SID with the most sub-authorities Windows allows (15), and a longer run of numbers, are redacted too.
  const fifteen = "S-1-5-21-1-2-3-4-5-6-7-8-9-10-11-12-13-14";
  assert.equal(redactSid(fifteen), "S-1-5-21-<domain>-<account>");
  assert.equal(redact(`x ${fifteen} y`, names), "x S-1-5-21-<domain>-<account> y");
  assert.ok(!/1111|2222/.test(redact("S-1-5-21-1111-2222-3-4-5-6-7-8-9-10-11-12-13-14-15-16-17", names)));
  // Only the heads redactSid writes are exempt, and only before "-<": a raw head elsewhere, or another SID before "-<", is judged as a SID.
  assert.equal(scrub("S-1-5-21-<domain>-500 S-1-12-1-<account> S-1-5-5-<session>", names), "S-1-5-21-<domain>-500 S-1-12-1-<account> S-1-5-5-<session>");
  assert.equal(redact("S-1-5-21-77-<x>", names), "S-1-5-21-<domain>-<account>-<x>");
  // An access-list account that only starts like a SID is not kept as one.
  assert.equal(redact("C:\\x S-1-robert:(F)", names), "C:\\x <user>:(F)");
});

test("property: no machine, domain, account, session or virtual-machine number survives the last gate, in any wrapping, case or dash form (seeded random)", () => {
  let seed = 20261119;
  const rnd = (): number => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
  const num = (): string => String(100000 + Math.floor(rnd() * 4e9));
  const nums = (k: number): string[] => Array.from({ length: k }, num);
  // Each shape gives a SID and the numbers in it that must not be written out.
  const shapes: (() => { sid: string; secret: string[] })[] = [
    () => { const p = nums(3); return { sid: `S-1-5-21-${p.join("-")}-${String(1000 + Math.floor(rnd() * 9e5))}`, secret: p }; },
    () => { const p = nums(5); return { sid: `S-1-5-21-${p.join("-")}`, secret: p }; },
    () => { const p = nums(3); return { sid: `S-1-5-21-${p.join("-")}`, secret: p }; },
    () => { const p = nums(3); return { sid: `S-1-5-21-${p.join("-")}-500`, secret: p }; },
    () => { const p = nums(4); return { sid: `S-1-12-1-${p.join("-")}`, secret: p }; },
    () => { const p = nums(2); return { sid: `S-1-5-5-${p.join("-")}`, secret: p }; },
    () => { const p = nums(4); return { sid: `S-1-5-83-1-${p.join("-")}`, secret: p }; },
    () => { const p = nums(2); return { sid: `S-1-7-${p.join("-")}`, secret: p }; },
  ];
  const wraps: ((s: string) => string)[] = [(s) => s, (s) => `*${s}`, (s) => `(${s})`, (s) => `[${s}]`, (s) => `"${s}"`, (s) => `'${s}'`, (s) => `${s}:(F)`, (s) => `C:\\x ${s}:(I)(OI)(CI)(M)`,
    (s) => `    ${s}:(RX)\r\n`, (s) => `x:${s}:y`, (s) => JSON.stringify({ k: s }), (s) => `<${s}>`, (s) => `${s},${s}`, (s) => `a${s}b`, (s) => `${s}-<x>`, (s) => `S-1-5-18-${s}`, (s) => `${s}-`, (s) => encodeURIComponent(`"${s}"`)];
  const dashes = ["\u2010", "\u2011", "\u2012", "\u2013", "\u2014", "\u2212", "\uFE63", "\uFF0D"];
  for (let i = 0; i < 3000; i++) {
    const { sid, secret } = pick(shapes)();
    let s = rnd() < 0.3 ? sid.toLowerCase() : sid;
    if (rnd() < 0.2) { const d = pick(dashes); s = s.replace(/-/g, d); }
    else if (rnd() < 0.05) s = s.replace(/\d/g, (c) => String.fromCharCode(0xff10 + Number(c)));
    const text = pick(wraps)(s);
    for (const out of [scrub(text, names), JSON.stringify(scrubDeep({ a: [text], b: { c: text } }, names))]) {
      // Read back with full-width digits as plain ones, so a SID written in full-width digits is checked too, not only its ASCII spelling.
      const plain = out.normalize("NFKC");
      assert.ok(!secret.some((p) => plain.includes(p)), `${JSON.stringify(text)} -> ${out}`);
    }
  }
  // The kept kinds stay readable, and a virtual machine's own SID and account name are redacted (only the Virtual Machines group is fixed).
  assert.equal(scrub("S-1-5-83-0 S-1-5-83-<vm> S-1-15-3-1024-1-2", names), "S-1-5-83-0 S-1-5-83-<vm> S-1-15-3-1024-1-2");
  assert.equal(redactSid("S-1-5-83-1-1111-2222-3333-4444"), "S-1-5-83-<vm>");
  assert.equal(redactAccountName("NT VIRTUAL MACHINE\\1A2B3C4D-1111-2222-3333-444455556666"), "NT VIRTUAL MACHINE\\<vm>");
  assert.equal(redact("C:\\x S-1-5-83-1-1111-2222-3333-4444:(RX)", names), "C:\\x S-1-5-83-<vm>:(RX)");
  // A SID written with dash lookalikes is withheld whole by the gate.
  assert.equal(scrub("owner S\u20101\u20105\u201021\u2010111\u2010222\u2010333\u20101001", names), WITHHELD);
  // So is one written in full-width digits, and one with a full-width minus sign; a fixed SID in either form is still not personal data and is kept.
  const wide = (t: string): string => t.replace(/\d/g, (c) => String.fromCharCode(0xff10 + Number(c)));
  assert.equal(scrub(`owner ${wide("S-1-5-21-111-222-333-1001")}`, names), WITHHELD);
  assert.equal(scrub("owner S\uFF0D1\uFF0D5\uFF0D21\uFF0D111\uFF0D222\uFF0D333\uFF0D1001", names), WITHHELD);
  assert.equal(scrub("owner S\u22121\u22125\u221221\u2212111\u2212222\u2212333\u22121001", names), WITHHELD);
  assert.equal(scrub(`owner ${wide("S-1-5-18")}`, names), `owner ${wide("S-1-5-18")}`);
});

test("redaction time grows with the length of the text, not its square: 3 MB on one line finishes quickly, and e-mails and access lists are still redacted", { timeout: 30_000 }, () => {
  // redact runs on a whole field (scripts/redact-log.mjs passes whole lines of a job log) before the cut, so one long run must not take time growing with its square.
  const big = 3_000_000;
  for (const [kind, text] of [["letters", "x".repeat(big)], ["name characters", "a.b_c%d+e-".repeat(big / 10)], ["an address with no domain end", `a@${"x".repeat(big)}`], ["blanks", `${" ".repeat(big)}x`], ["a path then blanks", `C:\\x${" ".repeat(big)}y:`]] as const) {
    const started = process.hrtime.bigint();
    const out = scrub(text, names, 100);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 1500, `${kind}: ${ms} ms`);
    assert.ok(out.length < 200, kind);
  }
  // Real addresses are found as before: at the start of a run of name characters, right after another address, inside longer text, next to punctuation.
  assert.equal(redact("mail jim.bob+x@example.co.uk, or (a_b@mail.example.org).", names), "mail <email>, or (<email>).");
  assert.equal(redact("a@b.cd+x@e.fg", names), "<email><email>");
  assert.equal(redact("ab@c", names), "ab@c");
  // The last gate still finds an address that only appears once placeholders are taken out (here one written around a literal "<sid>").
  assert.equal(redact("x@ab<sid>.com", names), "x@ab<sid>.com");
  assert.equal(scrub("x@ab<sid>.com", names), WITHHELD);
  assert.equal(scrub(`${"y".repeat(100_000)} reach someone.else@example.com now`, names, 200_000), `${"y".repeat(100_000)} reach <email> now`);
  assert.ok(!scrub(`${"z".repeat(100_000)}someone@example.com`, names, 200_000).includes("someone"));
  // The access-list rule still keeps the indented account form and redacts a person's account after long blanks.
  assert.equal(redact(`C:\\work${" ".repeat(50_000)}DESKTOP-4F2K9\\Kim:(F)`, names), `C:\\work${" ".repeat(50_000)}<host>\\<user>:(F)`);
  assert.equal(redact(`${" ".repeat(50_000)}Kim Lee:(OI)(CI)(RX)`, names), `${" ".repeat(50_000)}<user>:(OI)(CI)(RX)`);
});

test("re-check: no search is retried in exponentially or quadratically many ways (separator runs, a break inside an access-list line, many addresses), and what each rule redacted is still redacted", { timeout: 30_000 }, () => {
  const timed = (kind: string, text: string): string => {
    const started = process.hrtime.bigint();
    const out = redact(text, names);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 1500, `${kind}: ${ms} ms`);
    return out;
  };
  // Runs of separators around a home root that is not followed by a name: each run could be split in exponentially many ways (22 and 22 backslashes took 15 s, 24 and
  // 24 took two minutes). The sizes here are kept small enough that the old patterns fail this test by time instead of hanging it.
  for (const text of ["C:\\\\Users\\\\Kim Lee\\x", "C:/\\/Users//\\Kim Lee\\x", `C:${"\\".repeat(30)}Users${"\\".repeat(30)}Kim Lee\\x`]) assert.ok(!/Kim/.test(redact(text, names)) && redact(text, names).includes("<home>"), text);
  timed("separator runs", `C:${"\\".repeat(22)}Users${"\\".repeat(22)}`);
  timed("separator runs, repeated", `C:${"\\".repeat(8)}Users${"\\".repeat(8)}`.repeat(100_000));
  // An access-list line with a carriage return or a line separator inside: the rule did not apply, and every later `:(` was tried again to the end of the line.
  for (const brk of ["\r", "\u2028"]) {
    assert.equal(redact(`C:\\work OTHERPC\\Bob:(F)${brk}more`, names), `C:\\work <user>:(F)${brk}more`);
    assert.equal(redact(`   Bob Q:(OI)(CI)(F)${brk}x`, names), `   <user>:(OI)(CI)(F)${brk}x`);
    const out = timed(`access list with ${JSON.stringify(brk)}`, `x ${":(F,".repeat(40_000)}${brk}y`);
    assert.ok(out.startsWith("x <user>:(F,"), out.slice(0, 40));
    timed(`3 MB access list with ${JSON.stringify(brk)}`, `x Bob${":(F,".repeat(750_000)}${brk}y`);
  }
  // 1 MB of different addresses on one line (3 MB takes about 1.5 s here, linear): each local part was searched for over the whole text. A local part that does occur elsewhere is still redacted there,
  // as its 8.3 short name and after a machine name.
  const many = Array.from({ length: 60_000 }, (_, i) => `q${i.toString(36)}@ex.com `).join("");
  assert.ok(many.length > 600_000);
  const out = timed("many addresses", `${many}pat.quinlan@ex.com then pat.quinlan, PATQUI~1.TXT and DESKTOP-4F2K9\\pat.quinlan, quinlan; pat.quinlanx stays`);
  assert.ok(out.endsWith("<email> then <user>, <user> and <host>\\<user>, <user>; pat.quinlanx stays"), out.slice(-120));
  assert.ok(!/q[0-9a-z]+@/.test(out));
  // A local part that matches a word of a placeholder still behaves as it did (the placeholders are searched too).
  assert.equal(redact("user@ex.com JimBob", names), redact("user@ex.com JimBob", { ...names, users: [...names.users, "user"] }));
  // A local part found only as the end of a longer run of name characters (the one-pass search must follow its fallback links).
  assert.equal(redact("x-ann.leeroy@ex.com ann.lee@ex.com; see x-ann.lee", names), "<email> <email>; see x-<user>");
});

test("an access-denied start's read-back and the real-sandbox detail's arguments: every account, home folder, SID and address goes, the folders and rights stay", () => {
  // The read-back windows-job.ts writes after an access-denied wsb start (own-hardware run 44501483353), with what a real machine can list: the console user, the machine's
  // own accounts, accounts of a domain the redaction does not know, Microsoft and Azure AD accounts, SIDs, and a job folder under the user's profile.
  const n = { users: ["DESKTOP-4F2K9\\robert", "Robert Hostetter"], hosts: ["DESKTOP-4F2K9"] };
  const readback = [
    "failed: Windows Sandbox refused the start (access denied, 0x80070005; wsb start exit 2147942405): this process (in the active console session: no; the console user: no): start the runner interactively",
    "shared C:\\nn\\work <- C:\\Users\\Robert Hostetter\\AppData\\Local\\Temp\\nn\\jobs\\j1\\guest\\work (writable, work):",
    "    NT AUTHORITY\\SYSTEM:(OI)(CI)(F)",
    "    BUILTIN\\Administrators:(OI)(CI)(F)",
    "    DESKTOP-4F2K9\\robert:(OI)(CI)M",
    "    CORP\\alice.smith:(OI)(CI)(RX)",
    "    FAMILY\\kidaccount:(I)(F)",
    "    S-1-5-21-1111111111-2222222222-3333333333-1001:(OI)(CI)(W)",
    "    AzureAD\\RobertH:(F)",
    "    MicrosoftAccount\\rob.hostetter@outlook.com:(F)",
    "shared C:\\nn\\work\\.git <- D:\\nn\\jobs\\j1\\guest\\work\\.git (read-only, protected):",
    "    DESKTOP-4F2K9\\robert:(DENY)(OI)(CI)(W,DC)",
    "    … 3 more entries",
  ].join("\r\n");
  const leaks = /robert|hostetter|alice|kidaccount|DESKTOP-4F2K9|1111111111|3333333333|outlook/i;
  for (const [what, out] of [["redact", redact(readback, n)], ["scrub", scrub(readback, n, 4000)], ["scrub 400", scrub(readback, n, 400)]] as const) {
    assert.ok(!leaks.test(out), `${what}: ${out}`);
    assert.notEqual(out, WITHHELD, what);
  }
  const out = redact(readback, n);
  // The folders, guest paths, kinds and rights stay readable.
  assert.match(out, /shared C:\\nn\\work <- <home>\\AppData\\Local\\Temp\\nn\\jobs\\j1\\guest\\work \(writable, work\):/);
  assert.match(out, /shared C:\\nn\\work\\.git <- D:\\nn\\jobs\\j1\\guest\\work\\.git \(read-only, protected\):/);
  for (const kept of ["    NT AUTHORITY\\SYSTEM:(OI)(CI)(F)", "    BUILTIN\\Administrators:(OI)(CI)(F)", "    <user>:(OI)(CI)(RX)", "    S-1-5-21-<domain>-<account>:(OI)(CI)(W)", "    <host>\\<user>:(DENY)(OI)(CI)(W,DC)"]) assert.ok(out.includes(kept), `${kept} in ${out}`);
  // The same entries joined on one line (as a summary may flatten them) or written as icacls arguments: every account after an unknown domain still goes.
  const inline = "x (writable, work): NT AUTHORITY\\SYSTEM:(OI)(CI)(F); CORP\\alice.smith:(OI)(CI)(RX); FAMILY\\kid account:(I)(F) | /deny | OTHERDOM\\carol:(OI)(CI)(W,DC) NT SERVICE\\TrustedInstaller:(F)";
  const flat = redact(inline, n);
  assert.ok(!/alice|kid|carol/i.test(flat), flat);
  // (The line rule takes the head and first account of such a line as one account.)
  assert.match(flat, /^x <user>:\(OI\)\(CI\)\(F\); CORP\\<user>:\(OI\)\(CI\)\(RX\); FAMILY\\<user>:\(I\)\(F\) \| \/deny \| OTHERDOM\\<user>:\(OI\)\(CI\)\(W,DC\) NT SERVICE\\TrustedInstaller:\(F\)$/);
  // The real-sandbox detail's arguments, one indented line each: a .wsb configuration under the profile and an icacls grant to the share account.
  const args = ["    start", "    --config", "    <Configuration><MappedFolders><MappedFolder><HostFolder>C:\\Users\\robert\\AppData\\Local\\Temp\\nn\\work</HostFolder><SandboxFolder>C:\\nn\\work</SandboxFolder></MappedFolder></MappedFolders></Configuration>", "    C:\\nn\\jobs\\j1\\work", "    /grant", "    CORP\\bob:(OI)(CI)M"].join("\n");
  const a = scrub(args, n, 1800);
  assert.ok(!/robert|bob/i.test(a), a);
  assert.ok(a.includes("<HostFolder><home>\\AppData") && a.includes("    /grant") && a.includes("    C:\\nn\\jobs\\j1\\work") && a.includes("    <user>:(OI)(CI)M"), a);
  // Redaction lengthens text (a short name becomes <host>\<user>); the cut comes after it and stays within the limit with its note.
  const longer = Array.from({ length: 200 }, () => "    DESKTOP-4F2K9\\robert:(OI)(CI)M").join("\n");
  for (const limit of [400, 1800, 2048]) { const c = scrub(longer, n, limit); assert.ok(c.length <= limit && !leaks.test(c) && c.endsWith("more characters]"), c); }
});

test("cutWhole: text not yet redacted is cut between words, so no half name, SID or address is left behind", () => {
  assert.equal(cutWhole("short", 10), "short");
  assert.equal(cutWhole("granted PC\\robert:(F) to", 15), "granted PC\\…");
  assert.equal(cutWhole("sid S-1-5-21-1111111111-2222", 20), "sid …");
  assert.equal(cutWhole("mail robert@example.com", 15), "mail …");
  assert.ok(!/robe|S-1-5-21-1/.test(redact(cutWhole("granted PC\\robert:(F) sid S-1-5-21-1111111111-2222", 15), { users: ["robert"], hosts: ["PC"] })));
});
