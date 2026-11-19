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
const FIXED_SIDS = new Set(["S-1-0-0", "S-1-1-0", "S-1-2-0", "S-1-2-1", "S-1-3-0", "S-1-3-1", "S-1-3-2", "S-1-3-3", "S-1-3-4", "S-1-5-1", "S-1-5-2", "S-1-5-3", "S-1-5-4", "S-1-5-6", "S-1-5-7", "S-1-5-8", "S-1-5-9", "S-1-5-10", "S-1-5-11", "S-1-5-12", "S-1-5-13", "S-1-5-14", "S-1-5-15", "S-1-5-17", "S-1-5-18", "S-1-5-19", "S-1-5-20", "S-1-5-33", "S-1-5-113", "S-1-5-114"]);
/**
 * Prefixes whose SIDs are derived from a fixed name (a built-in group, a service name, a package family or capability name, a mandatory label, a virtual machine), never from a
 * person: built-in groups (S-1-5-32-), service SIDs (S-1-5-80-), app packages (S-1-15-2-), capabilities (S-1-15-3-), virtual machines (S-1-5-83-), restricted services
 * (S-1-5-99-), driver hosts (S-1-5-84-, S-1-5-90-, S-1-5-96-), authentication packages (S-1-5-64-) and integrity labels (S-1-16-).
 */
const FIXED_PREFIXES = ["S-1-5-32-", "S-1-5-80-", "S-1-15-2-", "S-1-15-3-", "S-1-5-83-", "S-1-5-99-", "S-1-5-84-", "S-1-5-90-", "S-1-5-96-", "S-1-5-64-", "S-1-16-"];

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
  if (FIXED_SIDS.has(s) || FIXED_PREFIXES.some((p) => s.startsWith(p))) return "well-known";
  return "other";
}

/**
 * A SID as it may be written to a public record. Well-known, machine-independent SIDs (`FIXED_SIDS`, `FIXED_PREFIXES`) stay as they are. A machine or domain SID
 * (`S-1-5-21-<three numbers>-<RID>`) keeps only its class and, for the built-in accounts and groups below 1000 (500 Administrator, 501 Guest, 504 WDAGUtilityAccount, 513
 * None/Domain Users...), the RID: `S-1-5-21-<domain>-500`; any other RID is `<account>`. Azure AD accounts are `S-1-12-1-<account>`, logon sessions `S-1-5-5-<session>`, and
 * anything else keeps only its authority: `S-1-<n>-<other>`. Text that is not a SID at all becomes `<sid>`.
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
  return `S-1-${parts[2]!}-<other>`;
}
/** Authorities whose account names are fixed names (a service, a capability, a virtual machine), never a person's. */
const NAMED_AUTHORITIES = /^(?:nt service|application package authority|nt virtual machine|nt authority|builtin)$/i;
/**
 * One account name from an access list as it may be written to a public record: a SID is redacted by class (`redactSid`); a name stays only when every part of it is a
 * well-known name, or when it is `<authority>\<name>` for an authority whose names are fixed (NT SERVICE, APPLICATION PACKAGE AUTHORITY, NT VIRTUAL MACHINE, NT AUTHORITY,
 * BUILTIN); anything else, a machine or domain account above all, is `<user>`. A name with a line break, a colon or a parenthesis is `<user>` too.
 */
export function redactAccountName(account: string): string {
  const a = account.trim();
  const sid = /^(\*?)(S-1-.*)$/i.exec(a);
  if (sid !== null) return `${sid[1]!}${redactSid(sid[2]!)}`;
  if (a === "" || /[\r\n:()]/.test(a)) return "<user>";
  const parts = a.split("\\");
  if (parts.every((p) => WELL_KNOWN.test(p.trim()))) return a;
  if (parts.length === 2 && NAMED_AUTHORITIES.test(parts[0]!.trim()) && /^[A-Za-z0-9 ._$&'-]{1,80}$/.test(parts[1]!)) return a;
  return "<user>";
}
/** A SID in text, as long as it goes (up to 15 sub-authorities); a longer run of numbers is matched in parts, each judged on its own. */
const SID_IN_TEXT = /(\*?)(S-1-\d+(?:-\d+){1,15})(?!\d)/gi;
/** The heads `redactSid` writes in front of a placeholder (`S-1-5-21-<domain>-...`, `S-1-12-1-<account>`, `S-1-5-5-<session>`): only these, followed by `-<`, are left as they are. */
const REDACTED_HEADS = new Set(["S-1-5-21", "S-1-12-1", "S-1-5-5"]);
const isRedactedHead = (sid: string, after: string): boolean => after.startsWith("-<") && REDACTED_HEADS.has(sid.toUpperCase());
const WELL_KNOWN = /^(?:nt authority|builtin|nt service|nt virtual machine|window manager|font driver host|everyone|users|administrators|guests|system|creator owner|authenticated users|all application packages|trustedinstaller|<host>|<user>)$/i;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SEP = String.raw`(?:\\\\|\\|/)+`;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

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
  out = out.replace(EMAIL, (m) => { const local = m.split("@")[0]!; fromEmail.push(local, ...local.split(/[._%+-]/).filter((p) => p.length >= 4)); return "<email>"; });
  out = out.replace(SID_IN_TEXT, (m: string, star: string, sid: string, at: number, all: string) => (isRedactedHead(sid, all.slice(at + m.length)) ? m : `${star}${redactSid(sid)}`));
  // Addresses (loopback and 0.x, which are version numbers, stay).
  out = out.replace(/\b(?!127\.|0\.)(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g, "<ip>");
  out = out.replace(/(?<![\w:])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])|(?<![\w:])(?:[0-9a-f]{1,4}:)+:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?(?![\w:])/gi, "<ip>");

  const local = localNames();
  const users = [...local.users, ...(names.users ?? []), ...fromEmail].flatMap(withPieces).filter((u) => u.length >= 2);
  const hosts = [...local.hosts, ...(names.hosts ?? [])].flatMap((h) => [h, h.split("\\")[0]!]).filter((h) => h.length >= 2);
  for (const o of names.other ?? []) if (o.text.length >= 2) out = out.replace(new RegExp(escapeRe(o.text), "gi"), o.as);
  // Known names first (longest first), so that a home folder such as "Alice Smith" is already partly a placeholder when the home rule runs.
  const byLength = (a: string, b: string): number => b.length - a.length;
  for (const h of [...new Set(hosts)].sort(byLength)) for (const u of [...new Set(users)].sort(byLength)) out = out.replace(new RegExp(`${escapeRe(h)}\\\\{1,4}${escapeRe(u)}(?![A-Za-z0-9_])`, "gi"), "<host>\\<user>");
  // 8.3 short names (ROBERT~1, ROBERT~1.DES) anywhere, before the plain names are replaced.
  for (const p of new Set([...local.users, ...(names.users ?? []), ...fromEmail].map(shortPrefix))) if (p.length >= 3) out = out.replace(new RegExp(String.raw`(?<![A-Za-z0-9_])${escapeRe(p)}~\d+(?:\.\w{1,3})?`, "gi"), "<user>");
  for (const u of [...new Set(users)].sort(byLength)) out = out.replace(wholeWord(u), "<user>");
  for (const h of [...new Set(hosts)].sort(byLength)) out = out.replace(wholeWord(h), "<host>");
  out = out.replace(/<host>(?:\.[A-Za-z0-9-]+)+/g, "<host>");
  // Home directories: any drive's Users (or Documents and Settings) root, whatever the name; the name runs to the next separator or quote, spaces included.
  out = out.replace(new RegExp(String.raw`[A-Za-z]:${SEP}(?:Users|Documents and Settings)${SEP}[^\\/"'*?|\r\n:]*[^\\/"'*?|\r\n:\s]`, "gi"), "<home>");
  out = out.replace(/\\\\(?!\\)([^\\/"'\s]+)/g, (m, server: string) => (server === "?" || server === "." ? m : "\\\\<host>"));
  // Accounts in an access list, line by line: everything before the colon of `account:(RIGHTS)` is the account (spaces included); only well-known ones and placeholders stay.
  out = out.split("\n").map((line) => {
    const cr = line.endsWith("\r") ? "\r" : "";
    const body = line.replace(/\r$/, "");
    // A line that starts in column 0 begins with the folder's path; one that starts with blanks is a continuation holding only the account.
    const first = /^(\S+\s+)(.*?):(\((?:[A-Z]{1,5})[,)(].*)$/.exec(body);
    const more = /^(\s+)(.*?):(\((?:[A-Z]{1,5})[,)(].*)$/.exec(body);
    const m = more ?? first;
    if (m === null) return line;
    const account = m[2]!.trim();
    // A SID here was already redacted by class above, so it stays (a well-known one, or its placeholder form).
    const kept = account.split("\\").every((p) => WELL_KNOWN.test(p.trim())) || /^\*?S-1-\d+(?:-(?:\d+|<(?:domain|account|session|other)>))+$/.test(account) ? account : "<user>";
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
  const sidLeft = [...bare.matchAll(SID_IN_TEXT)].some((m) => !isRedactedHead(m[2]!, bare.slice(m.index + m[0].length)) && (redactSid(m[2]!) !== m[2]!.toUpperCase() || m[2]! !== m[2]!.toUpperCase()));
  if (watched.some((n) => wholeWord(n).test(bare)) || new RegExp(EMAIL.source).test(bare) || sidLeft || bare.includes("\0")) return WITHHELD;
  return out;
}

/** `scrub` over every string value in a JSON-like value (keys are the program's own fixed names and stay). */
export function scrubDeep<T>(value: T, names: RedactionNames = {}): T {
  if (typeof value === "string") return scrub(value, names) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, names)) as unknown as T;
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v, names)])) as unknown as T;
  return value;
}
