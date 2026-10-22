import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkName, checkValue, run, SecretStoreError, type SecretStore } from "./store.js";

const hex = (name: string): string => Buffer.from(name, "utf8").toString("hex");
const encodeScript = (script: string): string => Buffer.from(script, "utf16le").toString("base64");
const LOAD = "Add-Type -AssemblyName System.Security;";
const PROTECT = encodeScript(`${LOAD}$in=[Console]::In.ReadToEnd().Trim();$b=[Convert]::FromBase64String($in);$p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');[Console]::Out.Write([Convert]::ToBase64String($p))`);
const UNPROTECT = encodeScript(`${LOAD}$in=[Console]::In.ReadToEnd().Trim();$b=[Convert]::FromBase64String($in);$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');[Console]::Out.Write([Convert]::ToBase64String($p))`);

/**
 * Windows secrets protected with DPAPI for the current user (card F09): each secret is encrypted with the user's key (PowerShell `ProtectedData`, `CurrentUser` scope) and kept in a file in
 * `directory`. The key belongs to the account the service runs as, so it opens the same secrets after logout and reboot, and another account (or a copied file) cannot. The value reaches
 * PowerShell on its standard input as base64, never on a command line. A file that cannot be decrypted (another account, a damaged file) is reported by name.
 */
export function windowsDpapiStore(directory: string, options: { powershell?: string } = {}): SecretStore {
  const shell = options.powershell ?? "powershell.exe";
  const path = (name: string): string => join(directory, `${hex(checkName(name))}.dpapi`);
  const call = (encoded: string, input: string) => run(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], input, 30_000);
  const fail = (name: string, r: { missing: boolean; timedOut: boolean }, what: string): SecretStoreError =>
    r.missing ? new SecretStoreError("unavailable", name, "PowerShell is not available on this host") : new SecretStoreError(r.timedOut ? "locked" : "unavailable", name, what);
  return {
    kind: "windows-dpapi",
    async resolve(name) {
      const file = path(name);
      let stored: string;
      try { stored = (await readFile(file, "utf8")).trim(); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new SecretStoreError("unavailable", name, "the secret file could not be read"); }
      const r = await call(UNPROTECT, stored);
      if (r.code !== 0) throw fail(name, r, "the secret could not be decrypted for this Windows account (it was stored by another account or is damaged)");
      return Buffer.from(r.stdout.trim(), "base64").toString("utf8");
    },
    async set(name, value) {
      const file = path(name);
      checkValue(name, value);
      const r = await call(PROTECT, Buffer.from(value, "utf8").toString("base64"));
      if (r.code !== 0 || r.stdout.trim() === "") throw fail(name, r, "the secret could not be encrypted for this Windows account");
      await mkdir(directory, { recursive: true });
      const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
      let created = false;
      try { await writeFile(temporary, r.stdout.trim(), { flag: "wx" }); created = true; await rename(temporary, file); } catch { if (created) await rm(temporary, { force: true }); throw new SecretStoreError("unavailable", name, "the secret could not be written"); }
    },
    async remove(name) {
      const file = path(name);
      try { await readFile(file); } catch { return false; }
      await rm(file, { force: true });
      return true;
    },
    async check() {
      const r = await call(PROTECT, Buffer.from("probe", "utf8").toString("base64"));
      return r.code === 0 && r.stdout.trim() !== "" ? { ok: true, detail: `secrets are kept DPAPI-protected in ${directory}` } : { ok: false, detail: r.missing ? "PowerShell is not available on this host" : "DPAPI could not be used by this Windows account" };
    },
  };
}
