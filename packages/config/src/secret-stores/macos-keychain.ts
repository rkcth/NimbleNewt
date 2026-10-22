import { checkName, checkValue, run, SecretStoreError, type SecretStore } from "./store.js";

const SERVICE = "nimblenewt";

/**
 * The macOS Keychain through the `security` tool (card F09). The value never appears on a command line: a write is sent to `security -i` on its standard input, and encoded as base64 (so any
 * text, quotes and newlines included, is stored safely). `keychain` names a keychain file (default: the login keychain). A locked keychain, or one that would need a prompt, is reported as locked
 * by name (an unattended service cannot answer a prompt); a missing secret is simply absent.
 */
export function macosKeychainStore(options: { keychain?: string; service?: string } = {}): SecretStore {
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
  return {
    kind: "macos-keychain",
    async resolve(name) {
      checkName(name);
      const r = await run("security", ["find-generic-password", "-s", service, "-a", name, "-w", ...keychain], undefined);
      if (r.code === 0) {
        const decoded = Buffer.from(r.stdout.trim(), "base64").toString("utf8");
        return decoded === "" ? undefined : decoded;
      }
      if (!r.missing && !r.timedOut && /could not be found|SecKeychainSearchCopyNext/i.test(r.stderr)) return undefined;
      throw fail(name, r);
    },
    async set(name, value) {
      checkName(name); checkValue(name, value);
      const encoded = Buffer.from(value, "utf8").toString("base64");
      const line = ["add-generic-password", "-U", "-s", service, "-a", name, "-l", `NimbleNewt.${name}`, "-w", encoded, ...keychain].map(quote).join(" ");
      const r = await run("security", ["-i"], `${line}\n`);
      // `security -i` reports a failed command on its output and still exits 0.
      if (r.code !== 0 || /^security: |error|Item already exists/im.test(`${r.stderr}${r.stdout}`.replace(encoded, ""))) throw fail(name, { ...r, stderr: `${r.stderr}${r.stdout}`.replace(encoded, "") });
    },
    async remove(name) {
      checkName(name);
      const r = await run("security", ["delete-generic-password", "-s", service, "-a", name, ...keychain], undefined);
      if (r.code === 0) return true;
      if (!r.missing && !r.timedOut && /could not be found/i.test(r.stderr)) return false;
      throw fail(name, r);
    },
    async check() {
      const r = await run("security", ["show-keychain-info", ...keychain], undefined);
      if (r.missing) return { ok: false, detail: "the macOS `security` tool is not available on this host" };
      return r.code === 0 ? { ok: true, detail: "the keychain can be opened" } : { ok: false, detail: "the keychain is locked or cannot be opened by this user" };
    },
  };
}
