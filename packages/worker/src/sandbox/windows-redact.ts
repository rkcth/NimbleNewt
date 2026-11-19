import { hostname, userInfo } from "node:os";

/**
 * Makes text from a real Windows run safe for a public repository (card A03b). Account names, e-mail and Microsoft-account forms, domain and machine names, home directories,
 * IP addresses and UNC server names are replaced by placeholders (`<user>`, `<email>`, `<host>`, `<home>`, `<ip>`). SIDs are redacted by class (`redactSid`): the well-known,
 * machine-independent ones (system accounts, built-in groups, service, app-package and capability SIDs) stay, because they name a kind of account and not a person; the
 * machine, domain and account parts of the others are replaced. The names to look for are the ones of the running machine plus any the caller adds (for example the console user the test found). Output is cut to a size limit AFTER redaction, so a cut can never leave half of a name behind.
 * `scrub` is the last gate for anything that is written out: a field that still looks personal is withheld whole.
 */
export interface RedactionNames {
  readonly users?: readonly string[];
  readonly hosts?: readonly string[];
  /** Other words to hide, each shown as the given placeholder. */
  readonly other?: readonly { readonly text: string; readonly as: string }[];
}

export const WITHHELD = "<withheld: possible personal data>";

/** A SID: revision 1, an authority and one to fifteen sub-authorities (Windows allows at most 15). */
const SID_SHAPE = /^S-1-\d+(?:-\d+){1,15}$/;
/** SIDs that are the same on every Windows machine and name a kind of account, never a person. */
const FIXED_SIDS = new Set(["S-1-0-0", "S-1-1-0", "S-1-2-0", "S-1-2-1", "S-1-3-0", "S-1-3-1", "S-1-3-2", "S-1-3-3", "S-1-3-4", "S-1-5-1", "S-1-5-2", "S-1-5-3", "S-1-5-4", "S-1-5-6", "S-1-5-7", "S-1-5-8", "S-1-5-9", "S-1-5-10", "S-1-5-11", "S-1-5-12", "S-1-5-13", "S-1-5-14", "S-1-5-15", "S-1-5-17", "S-1-5-18", "S-1-5-19", "S-1-5-20", "S-1-5-33", "S-1-5-83-0", "S-1-5-113", "S-1-5-114"]);
/**
 * Prefixes whose SIDs are derived from a fixed name (a built-in group, a service name, a package family or capability name, a mandatory label), never from a person: built-in
 * groups (S-1-5-32-), service SIDs (S-1-5-80-), app packages (S-1-15-2-), capabilities (S-1-15-3-), restricted services (S-1-5-99-), driver hosts (S-1-5-84-, S-1-5-90-,
 * S-1-5-96-), authentication packages (S-1-5-64-), integrity labels (S-1-16-) and process trust labels (S-1-19-<type>-<level>, for example S-1-19-512-8192, the label icacls
 * shows on the Store package of Windows Sandbox: a protection type and level, the same on every machine). Not virtual machines: only their group (S-1-5-83-0) is fixed; one machine's SID
 * (S-1-5-83-1-...) is made from that machine's own random id, so it is redacted (`S-1-5-83-<vm>`).
 */
const FIXED_PREFIXES = ["S-1-5-32-", "S-1-5-80-", "S-1-15-2-", "S-1-15-3-", "S-1-5-99-", "S-1-5-84-", "S-1-5-90-", "S-1-5-96-", "S-1-5-64-", "S-1-16-", "S-1-19-"];

/** The kind of account a SID names, in plain words (for the findings). */
export function sidClass(sid: string): string {
  const s = sid.toUpperCase();
  if (!SID_SHAPE.test(s)) return "not a SID";
  const named: Record<string, string> = { "S-1-5-18": "SYSTEM", "S-1-5-19": "LOCAL SERVICE", "S-1-5-20": "NETWORK SERVICE", "S-1-5-6": "SERVICE (any service)", "S-1-1-0": "Everyone", "S-1-3-0": "CREATOR OWNER", "S-1-5-11": "Authenticated Users", "S-1-5-4": "INTERACTIVE", "S-1-5-32-544": "Administrators", "S-1-5-32-545": "Users", "S-1-5-32-546": "Guests", "S-1-15-2-1": "ALL APPLICATION PACKAGES", "S-1-15-2-2": "ALL RESTRICTED APPLICATION PACKAGES", "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464": "TrustedInstaller" };
  if (named[s] !== undefined) return named[s];
  if (s.startsWith("S-1-5-32-")) return "built-in group";
  if (s.startsWith("S-1-5-80-")) return "service (per-service SID)";
  if (s.startsWith("S-1-15-2-")) return "app package";
  if (s.startsWith("S-1-15-3-")) return "app capability";
  if (s.startsWith("S-1-5-83-")) return "virtual machine";
  if (s.startsWith("S-1-5-99-")) return "restricted service";
  if (s.startsWith("S-1-5-21-")) return "machine or domain account or group";
  if (s.startsWith("S-1-12-1-")) return "Azure AD account";
  if (s.startsWith("S-1-5-5-")) return "logon session";
  if (s.startsWith("S-1-19-")) return "process trust label";
  if (FIXED_SIDS.has(s) || FIXED_PREFIXES.some((p) => s.startsWith(p))) return "well-known";
  return "other";
}

/**
 * A SID as it may be written to a public record. Well-known, machine-independent SIDs (`FIXED_SIDS`, `FIXED_PREFIXES`) stay as they are. A machine or domain SID
 * (`S-1-5-21-<three numbers>-<RID>`) keeps only its class and, for the built-in accounts and groups below 1000 (500 Administrator, 501 Guest, 504 WDAGUtilityAccount, 513
 * None/Domain Users...), the RID: `S-1-5-21-<domain>-500`; any other RID is `<account>`. Azure AD accounts are `S-1-12-1-<account>`, logon sessions `S-1-5-5-<session>`, and
 * one virtual machine's SID `S-1-5-83-<vm>`, anything else keeps only its authority: `S-1-<n>-<other>`. Text that is not a SID at all becomes `<sid>`.
 */
export function redactSid(sid: string): string {
  const s = sid.toUpperCase();
  if (!SID_SHAPE.test(s)) return "<sid>";
  if (FIXED_SIDS.has(s) || FIXED_PREFIXES.some((p) => s.startsWith(p))) return s;
  const parts = s.split("-");
  if (s.startsWith("S-1-5-21-")) {
    const rid = parts.length === 8 ? Number(parts[7]) : NaN;
    return `S-1-5-21-<domain>-${Number.isInteger(rid) && rid < 1000 ? String(rid) : "<account>"}`;
  }
  if (s.startsWith("S-1-12-1-")) return "S-1-12-1-<account>";
  if (s.startsWith("S-1-5-5-")) return "S-1-5-5-<session>";
  if (s.startsWith("S-1-5-83-")) return "S-1-5-83-<vm>";
  return `S-1-${parts[2]!}-<other>`;
}
/** Authorities whose account names are fixed names (a service, a capability, a virtual machine), never a person's. */
const NAMED_AUTHORITIES = /^(?:nt service|application package authority|nt virtual machine|nt authority|builtin)$/i;
/**
 * One account name from an access list as it may be written to a public record: a SID is redacted by class (`redactSid`); a name stays only when every part of it is a
 * well-known name, or when it is `<authority>\<name>` for an authority whose names are fixed (NT SERVICE, APPLICATION PACKAGE AUTHORITY, NT VIRTUAL MACHINE, NT AUTHORITY,
 * BUILTIN; under NT VIRTUAL MACHINE only the `Virtual Machines` group, one machine's id becomes `<vm>`); anything else, a machine or domain account above all, is `<user>`. A name with a line break, a colon or a parenthesis is `<user>` too.
 */
export function redactAccountName(account: string): string {
  const a = account.trim();
  const sid = /^(\*?)(S-1-.*)$/i.exec(a);
  if (sid !== null) return `${sid[1]!}${redactSid(sid[2]!)}`;
  if (a === "" || /[\r\n:()]/.test(a)) return "<user>";
  const parts = a.split("\\");
  if (parts.every((p) => WELL_KNOWN.test(p.trim()))) return a;
  if (parts.length === 2 && /^nt virtual machine$/i.test(parts[0]!.trim())) return /^virtual machines$/i.test(parts[1]!.trim()) ? a : `${parts[0]!}\\<vm>`;
  if (parts.length === 2 && NAMED_AUTHORITIES.test(parts[0]!.trim()) && /^[A-Za-z0-9 ._$&'-]{1,80}$/.test(parts[1]!)) return a;
  return "<user>";
}
/** A SID in text, as long as it goes (up to 15 sub-authorities); a longer run of numbers is matched in parts, each judged on its own. */
const SID_IN_TEXT = /(\*?)(S-1-\d+(?:-\d+){1,15})(?!\d)/gi;
/** The heads `redactSid` writes in front of a placeholder (`S-1-5-21-<domain>-...`, `S-1-12-1-<account>`, `S-1-5-5-<session>`, `S-1-5-83-<vm>`): only these, followed by `-<`, are left as they are. */
const REDACTED_HEADS = new Set(["S-1-5-21", "S-1-12-1", "S-1-5-5", "S-1-5-83"]);
const isRedactedHead = (sid: string, after: string): boolean => after.startsWith("-<") && REDACTED_HEADS.has(sid.toUpperCase());
const WELL_KNOWN = /^(?:nt authority|builtin|nt service|nt virtual machine|window manager|font driver host|everyone|users|administrators|guests|system|creator owner|authenticated users|all application packages|trustedinstaller|<host>|<user>)$/i;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A run of path separators. One character class, not an alternation of `\\\\`, `\\` and `/`: those split a run of backslashes in exponentially many ways, and a home-folder
 * search that failed after two such runs (`C:` + 24 backslashes + `Users` + 24 backslashes) took minutes. */
const SEP = String.raw`[\\/]+`;
/** An e-mail address, tried only where `replaceEmails` starts it (sticky). */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/y;
const isEmailLocal = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 37 || c === 43 || c === 45;
/**
 * Replaces every e-mail address in `text` with what `as` returns, finding the same addresses as a plain global search with `EMAIL` but in linear time. A plain search
 * retries at every character of a long run of name characters with no `@` (40 KB of letters took over a second, 3 MB never finished); here an address is tried only at
 * the start of such a run or where the previous address ended, and when that fails the rest of the run is skipped: every later start in the run reaches the same next
 * character, so it fails the same way.
 */
function replaceEmails(text: string, as: (email: string) => string): string {
  let out = "";
  let copied = 0;
  let i = 0;
  while (i < text.length) {
    if (!isEmailLocal(text.charCodeAt(i))) { i++; continue; }
    EMAIL.lastIndex = i;
    const m = EMAIL.exec(text);
    if (m !== null) { out += text.slice(copied, i) + as(m[0]); i = copied = i + m[0].length; continue; }
    while (i < text.length && isEmailLocal(text.charCodeAt(i))) i++;
  }
  return copied === 0 ? text : out + text.slice(copied);
}
const hasEmail = (text: string): boolean => { let found = false; replaceEmails(text, (m) => { found = true; return m; }); return found; };
/**
 * Which of `words` occur anywhere in `text`, ignoring the case of A to Z (as the case-insensitive searches below do for these ASCII words), in one pass over the text
 * (Aho-Corasick): searching once per word took time growing with the number of words times the length of the text.
 */
function occurring(text: string, words: readonly string[]): Set<string> {
  interface Node { readonly next: Map<number, Node>; fail: Node | null; readonly ends: string[]; seen: boolean }
  const lower = (c: number): number => (c >= 65 && c <= 90 ? c + 32 : c);
  const root: Node = { next: new Map(), fail: null, ends: [], seen: false };
  for (const w of words) {
    let n = root;
    for (let i = 0; i < w.length; i++) { const c = lower(w.charCodeAt(i)); let k = n.next.get(c); if (k === undefined) { k = { next: new Map(), fail: null, ends: [], seen: false }; n.next.set(c, k); } n = k; }
    n.ends.push(w);
  }
  const queue: Node[] = [];
  for (const k of root.next.values()) { k.fail = root; queue.push(k); }
  for (let q = 0; q < queue.length; q++) {
    const n = queue[q]!;
    for (const [c, k] of n.next) {
      let f = n.fail;
      while (f !== null && !f.next.has(c)) f = f.fail;
      k.fail = f === null ? root : f.next.get(c)!;
      queue.push(k);
    }
  }
  let n = root;
  for (let i = 0; i < text.length; i++) {
    const c = lower(text.charCodeAt(i));
    while (n !== root && !n.next.has(c)) n = n.fail!;
    n = n.next.get(c) ?? root;
    // Each node and the nodes its failure links lead to are marked once; a marked node's chain is already marked.
    for (let m: Node | null = n; m !== null && m !== root && !m.seen; m = m.fail) m.seen = true;
  }
  const found = new Set<string>();
  for (const k of queue) if (k.seen) for (const w of k.ends) found.add(w);
  return found;
}

function localNames(): { users: string[]; hosts: string[] } {
  const users: string[] = [];
  const hosts: string[] = [];
  const add = (list: string[], v: string | undefined): void => { if (v !== undefined && v.length >= 2) list.push(v); };
  add(users, process.env["USERNAME"]); add(users, process.env["USER"]);
  try { add(users, userInfo().username.split("\\").pop()); } catch { /* no user info */ }
  add(hosts, process.env["COMPUTERNAME"]); add(hosts, process.env["USERDOMAIN"]);
  try { add(hosts, hostname()); } catch { /* no host name */ }
  return { users, hosts };
}

/** A name as a whole word; a space in it matches any run of blanks, line breaks included (console output wraps). */
const wholeWord = (name: string): RegExp => new RegExp(String.raw`(?<![A-Za-z0-9])${escapeRe(name).replace(/ +/g, String.raw`\s+`)}(?![A-Za-z0-9])`, "gi");
/** The name and its parts of four or more characters (a surname alone, "Robert.Hostetter", "robert_hostetter"). */
const withPieces = (name: string): string[] => { const tail = name.split("\\").pop()!; return [name, tail, tail.replace(/[\s._-]+/g, ""), ...tail.split(/[\s._-]+/).filter((p) => p.length >= 4)]; };
/** The 8.3 short-name prefix of a name: its first six letters and digits (ROBERT~1, ROBERT~1.DES). */
const shortPrefix = (name: string): string => name.split("\\").pop()!.replace(/[^A-Za-z0-9]/g, "").slice(0, 6);

export function redact(text: string, names: RedactionNames = {}): string {
  // UTF-16 text read as bytes has a NUL between letters; URL-encoded text hides separators. Both are turned back into plain text first.
  let out = text.replace(/\0/g, "").replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => { try { return decodeURIComponent(m); } catch { return m; } });
  // Microsoft-account, Azure AD and e-mail forms; the local part of an e-mail is also a name to hide elsewhere.
  const fromEmail: string[] = [];
  out = out.replace(/(?:MicrosoftAccount|AzureAD)\\{1,2}[^\s:"'\\]+/gi, "<user>");
  // Only names of at most 64 characters (the longest local part an address may have) are searched for elsewhere: a longer run is not a person's name, and a pattern made
  // from it can be too large to build (100 KB of letters before an @ made redact throw).
  out = replaceEmails(out, (m) => { const local = m.split("@")[0]!; fromEmail.push(...[local, ...local.split(/[._%+-]/).filter((p) => p.length >= 4)].filter((p) => p.length <= 64)); return "<email>"; });
  out = out.replace(SID_IN_TEXT, (m: string, star: string, sid: string, at: number, all: string) => (isRedactedHead(sid, all.slice(at + m.length)) ? m : `${star}${redactSid(sid)}`));
  // Addresses (loopback and 0.x, which are version numbers, stay).
  out = out.replace(/\b(?!127\.|0\.)(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g, "<ip>");
  out = out.replace(/(?<![\w:])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])|(?<![\w:])(?:[0-9a-f]{1,4}:)+:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?(?![\w:])/gi, "<ip>");

  const local = localNames();
  const hosts = [...local.hosts, ...(names.hosts ?? [])].flatMap((h) => [h, h.split("\\")[0]!]).filter((h) => h.length >= 2);
  for (const o of names.other ?? []) if (o.text.length >= 2) out = out.replace(new RegExp(escapeRe(o.text), "gi"), o.as);
  // A name taken from an e-mail address is searched for only if it occurs in the text (or in the placeholders written below, which the searches also see): one search
  // per address over the whole text took time growing with the square of a line that held many addresses. These names are made of e-mail characters only and the
  // searches below only put in placeholders, whose `<`, `>` and `\` are none of them, so a name that does not occur here can never be found below: the result is the
  // same as searching for every name.
  const emailNames = fromEmail.flatMap(withPieces);
  const emailShort = fromEmail.map(shortPrefix);
  const present = fromEmail.length === 0 ? new Set<string>() : occurring(`${out}\n<host>\\<user>`, [...emailNames, ...emailShort]);
  const users = [...[...local.users, ...(names.users ?? [])].flatMap(withPieces), ...emailNames.filter((u) => present.has(u))].filter((u) => u.length >= 2);
  // Known names first (longest first), so that a home folder such as "Alice Smith" is already partly a placeholder when the home rule runs.
  const byLength = (a: string, b: string): number => b.length - a.length;
  for (const h of [...new Set(hosts)].sort(byLength)) for (const u of [...new Set(users)].sort(byLength)) out = out.replace(new RegExp(`${escapeRe(h)}\\\\{1,4}${escapeRe(u)}(?![A-Za-z0-9_])`, "gi"), "<host>\\<user>");
  // 8.3 short names (ROBERT~1, ROBERT~1.DES) anywhere, before the plain names are replaced.
  for (const p of new Set([...[...local.users, ...(names.users ?? [])].map(shortPrefix), ...emailShort.filter((p) => present.has(p))])) if (p.length >= 3) out = out.replace(new RegExp(String.raw`(?<![A-Za-z0-9_])${escapeRe(p)}~\d+(?:\.\w{1,3})?`, "gi"), "<user>");
  for (const u of [...new Set(users)].sort(byLength)) out = out.replace(wholeWord(u), "<user>");
  for (const h of [...new Set(hosts)].sort(byLength)) out = out.replace(wholeWord(h), "<host>");
  out = out.replace(/<host>(?:\.[A-Za-z0-9-]+)+/g, "<host>");
  // An account on this machine that is not among the known names (another account at the console, such as the owner when the runner has its own account): what follows
  // `<host>\` is an account name. Not after a backslash (a UNC path, whose next part is a share).
  out = out.replace(/(?<!\\)<host>(\\{1,4})(?!<user>)[^\s\\/:"',;()<>]+/g, "<host>$1<user>");
  // Home directories: any drive's Users (or Documents and Settings) root, whatever the name; the name runs to the next separator or quote, spaces included.
  out = out.replace(new RegExp(String.raw`[A-Za-z]:${SEP}(?:Users|Documents and Settings)${SEP}[^\\/"'*?|\r\n:]*[^\\/"'*?|\r\n:\s]`, "gi"), "<home>");
  // UNC server names (`\\server\share`, or `\\\\server` escaped), the whole run of backslashes kept. Not where the run continues a path (after a drive `C:`, a name
  // character, a dot or a closing bracket): in JSON-escaped text every separator is written `\\`, and `"C:\\Program Files\\WindowsApps"` would otherwise lose each folder
  // name to `<host>`.
  out = out.replace(/(?<![\w.$)\]\\-])(?<!\b[A-Za-z]:)(\\{2,})([^\\/"'\s]+)/g, (m, run: string, server: string) => (server === "?" || server === "." ? m : `${run}<host>`));
  // Accounts in an access list, line by line: everything before the colon of `account:(RIGHTS)` is the account (spaces included); only well-known ones and placeholders stay.
  out = out.split("\n").map((line) => {
    const cr = line.endsWith("\r") ? "\r" : "";
    const body = line.replace(/\r$/, "");
    // A line that starts in column 0 begins with the folder's path; one that starts with blanks is a continuation holding only the account.
    // `(?!\s)` keeps the blank runs from being retried shorter, which could never match where the longest did not and took time growing with the square of their length.
    // The rights run to the end of the line whatever they hold (`[^]*`): `.*$` stopped at a carriage return or line separator inside the line, so the rule did not apply
    // there and every later `:(` was tried again to the end of the line, taking time growing with the square of its length.
    const first = /^(\S+\s+)(?!\s)(.*?):(\((?:[A-Z]{1,5})[,)(][^]*)$/.exec(body);
    const more = /^(\s+)(?!\s)(.*?):(\((?:[A-Z]{1,5})[,)(][^]*)$/.exec(body);
    const m = more ?? first;
    if (m === null) return line;
    const account = m[2]!.trim();
    // A SID here was already redacted by class above, so it stays (a well-known one, or its placeholder form).
    const kept = account.split("\\").every((p) => WELL_KNOWN.test(p.trim())) || /^\*?S-1-\d+(?:-(?:\d+|<(?:domain|account|session|vm|other)>))+$/.test(account) ? account : "<user>";
    return `${m[1]!}${kept}:${m[3]!}${cr}`;
  }).join("\n");
  return out;
}

/** Redacts, then cuts to `limit` characters, saying so. */
export function redactAndCut(text: string, names: RedactionNames = {}, limit = 2048): string {
  const clean = redact(text, names);
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}...[cut, ${clean.length - limit} more characters]`;
}

/** The last gate: redact, cut, and if the result still holds anything that looks personal, withhold the whole field. */
export function scrub(text: string, names: RedactionNames = {}, limit = 2048): string {
  const out = redactAndCut(text, names, limit);
  const bare = out.replace(/<(?:user|host|home|sid|ip|email)>/g, "");
  const local = localNames();
  const watched = [...[...local.users, ...(names.users ?? [])].flatMap(withPieces), ...[...local.hosts, ...(names.hosts ?? [])].flatMap((n) => [n, n.split("\\")[0]!])].filter((n) => n.length >= 2);
  // Judged on a loosened copy too: dash lookalikes (U+2010 to U+2015, minus sign, small and full-width hyphen) and full-width letters and digits read as plain ones, so a SID
  // written with them, which the text pattern above does not see, is withheld rather than passed (Windows does not write SIDs that way; this only fails closed).
  const loose = bare.normalize("NFKC").replace(/[\p{Pd}\u2212]/gu, "-");
  const sidLeft = [...loose.matchAll(SID_IN_TEXT)].some((m) => !isRedactedHead(m[2]!, loose.slice(m.index + m[0].length)) && (redactSid(m[2]!) !== m[2]!.toUpperCase() || m[2]! !== m[2]!.toUpperCase()));
  if (watched.some((n) => wholeWord(n).test(bare)) || hasEmail(bare) || sidLeft || bare.includes("\0")) return WITHHELD;
  return out;
}

/** `scrub` over every string value in a JSON-like value (keys are the program's own fixed names and stay). */
export function scrubDeep<T>(value: T, names: RedactionNames = {}): T {
  if (typeof value === "string") return scrub(value, names) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, names)) as unknown as T;
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v, names)])) as unknown as T;
  return value;
}
