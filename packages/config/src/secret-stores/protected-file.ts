import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { checkName, checkValue, SecretStoreError, type SecretStore } from "./store.js";

const hex = (name: string): string => Buffer.from(name, "utf8").toString("hex");

/**
 * A directory of files only the current user can read (Linux fallback when no Secret Service is available, and other POSIX hosts): the directory is 0700 and each secret file 0600, both owned by
 * the user running NimbleNewt. Before every read the owner and mode are checked and anything broader is refused by name (a file that others can read is no longer a secret). Names are stored
 * hex-encoded, so no name can be a path and case-insensitive filesystems cannot merge two names. Not available on Windows, where permissions are not modes: use the DPAPI store there.
 */
export function protectedFileStore(directory: string): SecretStore {
  const file = (name: string): string => join(directory, `${hex(checkName(name))}.secret`);
  const posix = (): void => { if (process.platform === "win32") throw new SecretStoreError("unavailable", "-", "the protected-file store needs POSIX permissions; use the Windows DPAPI store"); };
  const uid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

  async function safe(name: string, path: string, wantDirectory: boolean): Promise<boolean> {
    let info;
    try { info = await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw new SecretStoreError("unavailable", name, "the secret store could not be read"); }
    if (info.isSymbolicLink()) throw new SecretStoreError("unsafe", name, `${wantDirectory ? "the secret directory" : "the secret file"} is a link, which is not trusted`);
    if (wantDirectory !== info.isDirectory()) throw new SecretStoreError("unsafe", name, `${wantDirectory ? "the secret directory" : "the secret file"} is not what it should be`);
    if ((info.mode & 0o077) !== 0) throw new SecretStoreError("unsafe", name, `${wantDirectory ? "the secret directory" : "the secret file"} can be read by other users (mode ${(info.mode & 0o777).toString(8)}); make it ${wantDirectory ? "0700" : "0600"} and owned by the NimbleNewt user`);
    if (uid() !== undefined && info.uid !== uid()) throw new SecretStoreError("unsafe", name, `${wantDirectory ? "the secret directory" : "the secret file"} is owned by another user`);
    return true;
  }

  return {
    kind: "protected-file",
    async resolve(name) {
      posix();
      const path = file(name);
      if (!(await safe(name, directory, true))) return undefined;
      if (!(await safe(name, path, false))) return undefined;
      // Open without following a link and judge the open file itself (owner, mode, kind), so nothing can change between the check and the read.
      let handle;
      try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (e) { throw new SecretStoreError((e as NodeJS.ErrnoException).code === "ELOOP" ? "unsafe" : "unavailable", name, (e as NodeJS.ErrnoException).code === "ELOOP" ? "the secret file is a link, which is not trusted" : "the secret file could not be read"); }
      try {
        const info = await handle.stat();
        if (!info.isFile() || (info.mode & 0o077) !== 0 || (uid() !== undefined && info.uid !== uid())) throw new SecretStoreError("unsafe", name, "the secret file is not an owner-only file of this user");
        return await handle.readFile("utf8");
      } catch (e) { if (e instanceof SecretStoreError) throw e; throw new SecretStoreError("unavailable", name, "the secret file could not be read"); }
      finally { await handle.close(); }
    },
    async set(name, value) {
      posix();
      const path = file(name);
      checkValue(name, value);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await safe(name, directory, true);
      const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
      let created = false;
      try {
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        created = true;
        try { await handle.writeFile(value, "utf8"); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, path);
      } catch (e) {
        if (created) await rm(temporary, { force: true });
        if (e instanceof SecretStoreError) throw e;
        throw new SecretStoreError("unavailable", name, "the secret could not be written");
      }
    },
    async remove(name) {
      posix();
      const path = file(name);
      if (!(await safe(name, directory, true)) || !(await safe(name, path, false))) return false;
      await rm(path, { force: true });
      return true;
    },
    async check() {
      if (process.platform === "win32") return { ok: false, detail: "the protected-file store needs POSIX permissions; use the Windows DPAPI store" };
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await safe("-", directory, true);
        return { ok: true, detail: `secrets are kept in ${directory} (owner-only)` };
      } catch (e) { return { ok: false, detail: e instanceof SecretStoreError ? e.message : "the secret directory is not usable" }; }
    },
  };
}
