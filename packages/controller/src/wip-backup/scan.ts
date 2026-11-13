import { scanSecrets } from "../security/secret-scan.js";

/**
 * The scan every file passes before a work-in-progress push (card P02b). It is the controller's own secret scan (`scanSecrets`: every shape of the credential patterns, the key prefixes, private key blocks, long high-entropy
 * runs, read the way a reader sees the text) plus the secret VALUES the installation uses (F09: the host's secret store), looked for as bytes anywhere in the file. A file it names is left out of the push and reported; the
 * reason never repeats what was found (it names the kind of credential or the secret's name, never a value, a position or a snippet).
 * Deliberately conservative: a file that merely looks like a key (a long random string in a lock file or a minified bundle) is left out too, and reported, rather than sent.
 */
export interface WipScannerOptions {
  /** The secret values in use, read at each scan (a value added after a backup began still counts). Values shorter than 6 bytes are not searched for (they would match ordinary text). A throw blocks the file. */
  readonly secrets?: () => Promise<readonly { readonly name: string; readonly value: string }[]> | readonly { readonly name: string; readonly value: string }[];
}

export type WipScan = (file: { path: string; bytes: Buffer }) => Promise<string | undefined>;

export function createWipScanner(options: WipScannerOptions = {}): WipScan {
  return async (file) => {
    const text = file.bytes.toString("utf8");
    const found = scanSecrets(text)[0];
    if (found !== undefined) return `looks like a credential (${found.name})`;
    if (options.secrets !== undefined) {
      // A secret the store holds is looked for as the exact bytes, and as the text a reader sees (UTF-8 or Latin-1 decoding of a binary file may differ).
      const secrets = await options.secrets();
      const latin = file.bytes.toString("latin1");
      const lower = latin.toLowerCase();
      for (const s of secrets) if (s.value.length >= 6 && (text.includes(s.value) || latin.includes(s.value) || encodings(s.value).some((e) => (e.lower ? lower.includes(e.text) : latin.includes(e.text)) || file.bytes.includes(Buffer.from(e.text, "latin1"))))) return `holds the value of the secret ${s.name.slice(0, 60)}`;
    }
    return undefined;
  };
}

/**
 * The other forms a secret value is commonly stored in (P02b review): UTF-16 (little and big endian, as Windows tools and some binary formats write text), hexadecimal (either case) and base64 (standard and URL-safe,
 * at each of the three byte alignments, with the edge characters that depend on the neighbouring bytes cut off). Each form is searched for in the file's bytes.
 */
function encodings(value: string): { text: string; lower: boolean }[] {
  const bytes = Buffer.from(value, "utf8");
  const out: { text: string; lower: boolean }[] = [
    { text: Buffer.from(value, "utf16le").toString("latin1"), lower: false },
    { text: Buffer.from(value, "utf16le").swap16().toString("latin1"), lower: false },
    { text: bytes.toString("hex"), lower: true },
  ];
  for (let shift = 0; shift < 3; shift++) {
    const b64 = Buffer.concat([Buffer.alloc(shift), bytes]).toString("base64").replace(/=+$/, "");
    // The characters that mix the padding bytes (start) or an unknown next byte (end) are cut off; what is left is fixed by the value alone.
    const start = shift === 0 ? 0 : Math.ceil((shift * 8) / 6);
    const end = ((shift + bytes.length) % 3) === 0 ? b64.length : b64.length - 1;
    const core = b64.slice(start, end);
    if (core.length >= 8) for (const form of [core, core.replace(/\+/g, "-").replace(/\//g, "_")]) out.push({ text: form, lower: false });
  }
  return out;
}
