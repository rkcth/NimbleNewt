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
      for (const s of secrets) if (s.value.length >= 6 && (text.includes(s.value) || latin.includes(s.value) || file.bytes.includes(Buffer.from(s.value, "utf8")))) return `holds the value of the secret ${s.name.slice(0, 60)}`;
    }
    return undefined;
  };
}
