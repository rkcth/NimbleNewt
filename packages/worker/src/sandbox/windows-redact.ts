import { hostname, userInfo } from "node:os";

/**
 * Makes text from a real Windows run safe for a public repository (card A03b). Account names, e-mail and Microsoft-account forms, domain and machine names, home directories, SIDs,
 * IP addresses and UNC server names are replaced by placeholders (`<user>`, `<email>`, `<host>`, `<home>`, `<sid>`, `<ip>`); the names to look for are the ones of the running
 * machine plus any the caller adds (for example the console user the test found). Output is cut to a size limit AFTER redaction, so a cut can never leave half of a name behind.
 * `scrub` is the last gate for anything that is written out: a field that still looks personal is withheld whole.
 */
export interface RedactionNames {
  readonly users?: readonly string[];
  readonly hosts?: readonly string[];
  /** Other words to hide, each shown as the given placeholder. */
  readonly other?: readonly { readonly text: string; readonly as: string }[];
}

export const WITHHELD = "<withheld: possible personal data>";
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
  out = out.replace(/\*?S-1-\d+(?:-\d+){1,14}/gi, "<sid>");
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
    const kept = account.split("\\").every((p) => WELL_KNOWN.test(p.trim())) ? account : "<user>";
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
  if (watched.some((n) => wholeWord(n).test(bare)) || new RegExp(EMAIL.source).test(bare) || /S-1-\d+(?:-\d+){1,14}/i.test(bare) || bare.includes("\0")) return WITHHELD;
  return out;
}

/** `scrub` over every string value in a JSON-like value (keys are the program's own fixed names and stay). */
export function scrubDeep<T>(value: T, names: RedactionNames = {}): T {
  if (typeof value === "string") return scrub(value, names) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, names)) as unknown as T;
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v, names)])) as unknown as T;
  return value;
}
