import assert from "node:assert/strict";
import { test } from "node:test";
import { WITHHELD, redact, redactAndCut, scrub, scrubDeep } from "./windows-redact.js";

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

test("SIDs go, with and without the icacls asterisk", () => {
  assert.equal(redact("owner S-1-5-21-111-222-333-1001 and *S-1-5-18", names), "owner <sid> and <sid>");
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
  assert.deepEqual(nested, { a: "<home>\\x", b: ["mail <email>"], c: 5, d: { key: "<sid>" } });
  assert.equal(WITHHELD, "<withheld: possible personal data>");
});

test("surnames, split names, lower-case SIDs, short names and DNS suffixes", () => {
  const full = { users: ["DESKTOP-4F2K9\\Robert Hostetter", "NimbleNewtRunner"], hosts: ["DESKTOP-4F2K9"] };
  for (const text of ["Hostetter said", "D:\\Data\\Hostetter\\x", "Robert.Hostetter", "robert_hostetter.log", "user Robert\nHostetter split", "user Robert   \r\n  Hostetter"]) assert.ok(!/hostetter/i.test(redact(text, full)), text);
  assert.ok(!/hostetter/i.test(redactAndCut("user Robert\nHostetter split", full)));
  assert.equal(scrub("Hostetter", { users: ["Robert Hostetter"] }), "<user>");
  assert.ok(!/s-1-5/i.test(redact("s-1-5-21-1-2-3-1001 *s-1-5-18", full)));
  assert.equal(scrub("x s-1-5-21-1-2-3-1001", full), "x <sid>");
  for (const text of ["at ROBERT~1 and ROBERT~1.DES", "ROBERT~1\\AppData", "robert~2"]) assert.ok(!/robert/i.test(redact(text, full)), text);
  const ms = { users: ["DESKTOP-4F2K9\\rober"], hosts: ["DESKTOP-4F2K9"] };
  assert.equal(redact("rober~1 and ROBER~1.TXT", ms), "<user> and <user>");
  // A known name that is a prefix of another account must not leave the rest visible.
  assert.ok(!/er\b/.test(redact("DESKTOP-4F2K9\\rober", { users: ["rob", "DESKTOP-4F2K9\\rober"], hosts: ["DESKTOP-4F2K9"] }).replace("<user>", "")));
  assert.equal(redact("DESKTOP-4F2K9\\rober", { users: ["rob"], hosts: ["DESKTOP-4F2K9"] }), "<host>\\rober");
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
  assert.equal(redactAndCut("short", names), "short");
  const once = redact("C:\\Users\\Alice S-1-5-18 and S-1-5-19", names);
  assert.ok(!/Alice|S-1-5/.test(once), once);
  assert.equal(redact(once, names), once, "redacting twice changes nothing");
});

test("plain system text is left alone", () => {
  const text = "C:\\Windows\\System32\\icacls.exe exit 5: Access is denied. C:\\Program Files\\WindowsApps\\X_0.8.107.0_x64__8wekyb3d8bbwe";
  assert.equal(redact(text, names), text);
});
