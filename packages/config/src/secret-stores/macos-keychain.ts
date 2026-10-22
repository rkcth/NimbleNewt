import { createHash, randomBytes } from "node:crypto";
import { checkName, checkValue, run, SecretStoreError, type SecretStore } from "./store.js";

const SERVICE = "nimblenewt";

/**
 * The macOS Keychain through the `security` tool (card F09). The value never appears on a command line: a write is sent to `security -i` on its standard input, and encoded as base64 (so any
 * text, quotes and newlines included, is stored safely). `keychain` names a keychain file (default: the login keychain). A locked keychain, or one that would need a prompt, is reported as locked
 * by name (an unattended service cannot answer a prompt); a missing secret is simply absent.
 */
export function macosKeychainStore(options: { keychain?: string; service?: string; run?: typeof run } = {}): SecretStore {
  const exec = options.run ?? run;
  const service = options.service ?? SERVICE;
  // Every argument of a `security -i` line is double-quoted; a path that could break out of the quotes is refused rather than escaped.
  if (options.keychain !== undefined && /["\\\n\r\0]/.test(options.keychain)) throw new SecretStoreError("invalid", "-", "the keychain path may not contain quotes, backslashes or line breaks");
  const keychain = options.keychain === undefined ? [] : [options.keychain];
  const quote = (word: string): string => `"${word}"`;
  const fail = (name: string, r: { stderr: string; timedOut: boolean; missing: boolean }): SecretStoreError => {
    if (r.missing) return new SecretStoreError("unavailable", name, "the macOS `security` tool is not available on this host");
    if (r.timedOut || /interaction is not allowed|user canceled|locked|authorization/i.test(r.stderr)) return new SecretStoreError("locked", name, "the keychain is locked or needs a prompt an unattended service cannot answer; unlock it or use a keychain the service can open");
    return new SecretStoreError("unavailable", name, "the keychain could not be used");
  };
  // `security -i` takes one command per line and a long line did not work on the hosted runner (a 16 KiB secret failed), so a value is kept as short chunk items plus a header
  // `nn2:<generation>:<chunks>:<digest>`. Each write uses a fresh generation, chunks first and the header last, and the old generation is removed only after the new header reads back, so a failed or
  // interrupted write leaves the old value whole, two writes at once leave one complete value, and a damaged entry is refused by name instead of returned.
  const CHUNK = 600;
  const HEADER = /^nn2:([0-9a-f]{16}):(\d{1,4}):([0-9a-f]{32})$/;
  const account = (name: string, generation: string, i: number): string => `${name}~${generation}~${i}`;
  const digestOf = (encoded: string): string => createHash("sha256").update(encoded).digest("hex").slice(0, 32);
  const find = async (name: string, acct: string): Promise<string | undefined> => {
    const r = await exec("security", ["find-generic-password", "-s", service, "-a", acct, "-w", ...keychain], undefined);
    if (r.code === 0) return r.stdout.replace(/\r?\n$/, "");
    if (!r.missing && !r.timedOut && /could not be found|SecKeychainSearchCopyNext/i.test(r.stderr)) return undefined;
    throw fail(name, r);
  };
  const drop = async (name: string, acct: string): Promise<boolean> => {
    const r = await exec("security", ["delete-generic-password", "-s", service, "-a", acct, ...keychain], undefined);
    if (r.code === 0) return true;
    if (!r.missing && !r.timedOut && /could not be found/i.test(r.stderr)) return false;
    throw fail(name, r);
  };
  const parse = (name: string, header: string): { generation: string; count: number; digest: string } => {
    const m = HEADER.exec(header);
    if (m === null) throw new SecretStoreError("unavailable", name, "the keychain entry is incomplete or damaged (not in the format this version writes)");
    return { generation: m[1]!, count: Number(m[2]), digest: m[3]! };
  };
  const dropGeneration = async (name: string, h: { generation: string; count: number }): Promise<void> => { for (let i = 0; i < h.count; i++) await drop(name, account(name, h.generation, i)); };
  return {
    kind: "macos-keychain",
    async resolve(name) {
      checkName(name);
      const raw = await find(name, name);
      if (raw === undefined) return undefined;
      const h = parse(name, raw);
      let encoded = "";
      for (let i = 0; i < h.count; i++) {
        const part = await find(name, account(name, h.generation, i));
        if (part === undefined) throw new SecretStoreError("unavailable", name, "the keychain entry is incomplete or damaged (a part is missing)");
        encoded += part;
      }
      if (digestOf(encoded) !== h.digest) throw new SecretStoreError("unavailable", name, "the keychain entry is incomplete or damaged (its parts do not match)");
      return Buffer.from(encoded, "base64").toString("utf8");
    },
    async set(name, value) {
      checkName(name); checkValue(name, value);
      const encoded = Buffer.from(value, "utf8").toString("base64");
      const chunks: string[] = [];
      for (let at = 0; at < encoded.length; at += CHUNK) chunks.push(encoded.slice(at, at + CHUNK));
      const generation = randomBytes(8).toString("hex");
      const header = `nn2:${generation}:${chunks.length}:${digestOf(encoded)}`;
      const previous = await find(name, name);
      const add = (acct: string, data: string): string => ["add-generic-password", "-U", "-s", service, "-a", acct, "-l", `NimbleNewt.${acct}`, "-w", data, ...keychain].map(quote).join(" ");
      const lines = [...chunks.map((c, i) => add(account(name, generation, i), c)), add(name, header)];
      const r = await exec("security", ["-i"], `${lines.join("\n")}\n`);
      // `security -i` reports a failed command on its output and still exits 0 (and carries on with the later lines); the values are cut out of that output before it is read.
      let output = `${r.stderr}${r.stdout}`;
      for (const piece of [...chunks, header]) output = output.split(piece).join("");
      const said = output.split(/\r?\n/).filter((l) => /^security: |SecKeychain|Item already exists/i.test(l)).join("\n");
      // Whatever it said, look at what is in the keychain now.
      // If the keychain cannot even be read now (it locked partway, say), nothing is cleaned up: the state is unknown and removing parts could damage a value that was written.
      const stored = await find(name, name);
      const wholeNew = async (): Promise<boolean> => {
        let got = "";
        for (let i = 0; i < chunks.length; i++) { const part = await find(name, account(name, generation, i)).catch(() => undefined); if (part === undefined) return false; got += part; }
        return digestOf(got) === digestOf(encoded);
      };
      const clean = async (): Promise<void> => { for (let i = 0; i < chunks.length; i++) await drop(name, account(name, generation, i)).catch(() => false); };
      if (stored === header && await wholeNew()) {
        // Written completely, whatever the exit code or the output said (a false alarm must not destroy a good value).
      } else if (stored === header) {
        // The new header is in but the value behind it is not whole: put the old value back before anything is removed.
        if (previous !== undefined) await exec("security", ["-i"], `${add(name, previous)}\n`);
        else await drop(name, name).catch(() => false);
        await clean();
        throw fail(name, { ...r, stderr: said || r.stderr });
      } else {
        await clean();
        throw fail(name, { ...r, stderr: said || r.stderr });
      }
      if (previous !== undefined && HEADER.test(previous)) await dropGeneration(name, parse(name, previous));
    },
    async remove(name) {
      checkName(name);
      const raw = await find(name, name);
      if (raw === undefined) return false;
      await drop(name, name);
      if (HEADER.test(raw)) await dropGeneration(name, parse(name, raw));
      return true;
    },
    async check() {
      const r = await exec("security", ["show-keychain-info", ...keychain], undefined);
      if (r.missing) return { ok: false, detail: "the macOS `security` tool is not available on this host" };
      return r.code === 0 ? { ok: true, detail: "the keychain can be opened" } : { ok: false, detail: "the keychain is locked or cannot be opened by this user" };
    },
  };
}
