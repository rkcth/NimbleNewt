import { checkName, checkValue, run, SecretStoreError, type SecretStore } from "./store.js";

const SERVICE = "nimblenewt";

/**
 * The Linux Secret Service (GNOME Keyring, KWallet) through `secret-tool` (card F09). The value is sent on standard input. A host with no session bus, no `secret-tool`, or a locked collection
 * that needs a prompt reports it by name; an unattended server usually has none of these and uses the protected-file store instead (see `chooseSecretStore`).
 */
export function linuxSecretServiceStore(options: { service?: string } = {}): SecretStore {
  const service = options.service ?? SERVICE;
  const fail = (name: string, r: { stderr: string; timedOut: boolean; missing: boolean }): SecretStoreError => {
    if (r.missing) return new SecretStoreError("unavailable", name, "`secret-tool` (libsecret) is not installed on this host");
    if (r.timedOut || /locked|prompt|dismissed|not authorized/i.test(r.stderr)) return new SecretStoreError("locked", name, "the Secret Service collection is locked or needs a prompt an unattended service cannot answer");
    if (/dbus|bus|connect|org\.freedesktop/i.test(r.stderr)) return new SecretStoreError("unavailable", name, "there is no Secret Service session on this host");
    return new SecretStoreError("unavailable", name, "the Secret Service could not be used");
  };
  return {
    kind: "linux-secret-service",
    async resolve(name) {
      checkName(name);
      const r = await run("secret-tool", ["lookup", "service", service, "name", name], undefined, 10_000);
      if (r.code === 0 && r.stdout !== "") return r.stdout.replace(/\n$/, "");
      if (!r.missing && !r.timedOut && r.stderr.trim() === "") return undefined; // not found: exit 1, nothing said
      throw fail(name, r);
    },
    async set(name, value) {
      checkName(name); checkValue(name, value);
      if (value.endsWith("\n")) throw new SecretStoreError("invalid", name, "the Secret Service store cannot keep a value that ends in a line break");
      const r = await run("secret-tool", ["store", "--label", `NimbleNewt ${name}`, "service", service, "name", name], value, 10_000);
      if (r.code !== 0) throw fail(name, r);
    },
    async remove(name) {
      checkName(name);
      const present = await this.resolve(name);
      if (present === undefined) return false;
      const r = await run("secret-tool", ["clear", "service", service, "name", name], undefined, 10_000);
      if (r.code !== 0) throw fail(name, r);
      return true;
    },
    async check() {
      const r = await run("secret-tool", ["lookup", "service", service, "name", "nimblenewt-probe"], undefined, 10_000);
      if (r.code === 0 || (!r.missing && !r.timedOut && r.stderr.trim() === "")) return { ok: true, detail: "the Secret Service is reachable" };
      return { ok: false, detail: fail("-", r).message.replace(/^secret "-": /, "") };
    },
  };
}
