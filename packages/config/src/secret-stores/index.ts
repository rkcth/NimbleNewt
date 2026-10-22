import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { linuxSecretServiceStore } from "./linux-secret-service.js";
import { macosKeychainStore } from "./macos-keychain.js";
import { protectedFileStore } from "./protected-file.js";
import type { SecretStore } from "./store.js";
import { windowsDpapiStore } from "./windows-dpapi.js";

import { SecretStoreError } from "./store.js";
export { SecretStoreError, MAX_SECRET_BYTES, type SecretStore, type SecretStoreFailure } from "./store.js";
export { linuxSecretServiceStore } from "./linux-secret-service.js";
export { macosKeychainStore } from "./macos-keychain.js";
export { protectedFileStore } from "./protected-file.js";
export { windowsDpapiStore } from "./windows-dpapi.js";

const MARKER = "secret-store.json";

/**
 * The store for this host: the Keychain on macOS, DPAPI on Windows, and on Linux the Secret Service when it answers, otherwise the permission-checked file store in `<dataDir>/secrets`.
 * The first choice is written to `<dataDir>/secret-store.json` and kept: a later start uses that store, and if it cannot be used the start fails naming it, instead of quietly switching to
 * another store where the secrets would look missing. Returns the store and why, so the choice can be shown to the owner.
 */
export async function chooseSecretStore(options: { dataDir: string; platform?: NodeJS.Platform }): Promise<{ store: SecretStore; reason: string }> {
  const platform = options.platform ?? process.platform;
  const build = (kind: SecretStore["kind"]): SecretStore | undefined => {
    if (kind === "macos-keychain" && platform === "darwin") return macosKeychainStore();
    if (kind === "windows-dpapi" && platform === "win32") return windowsDpapiStore(join(options.dataDir, "secrets"));
    if (kind === "linux-secret-service" && platform === "linux") return linuxSecretServiceStore();
    if (kind === "protected-file" && platform !== "win32") return protectedFileStore(join(options.dataDir, "secrets"));
    return undefined;
  };
  const marker = join(options.dataDir, MARKER);
  let recorded: string | undefined;
  try {
    const text = await readFile(marker, "utf8");
    recorded = (JSON.parse(text) as { kind?: string }).kind;
    if (typeof recorded !== "string") throw new Error("no kind");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new SecretStoreError("unavailable", "-", `${marker} exists but cannot be read as the record of which secret store this installation uses; fix or restore it (it was not replaced)`);
    recorded = undefined;
  }
  if (recorded !== undefined) {
    const store = build(recorded as SecretStore["kind"]);
    if (store === undefined) throw new SecretStoreError("unavailable", "-", `this installation keeps its secrets in the ${recorded} store, which this host cannot use; restore the host or move the secrets deliberately`);
    const health = await store.check();
    if (!health.ok) throw new SecretStoreError("unavailable", "-", `this installation keeps its secrets in the ${recorded} store, which cannot be used now (${health.detail}); it was not replaced by another store`);
    return { store, reason: `the ${recorded} store this installation chose earlier` };
  }
  let chosen: { store: SecretStore; reason: string };
  if (platform === "darwin") chosen = { store: macosKeychainStore(), reason: "macOS: the login Keychain" };
  else if (platform === "win32") chosen = { store: windowsDpapiStore(join(options.dataDir, "secrets")), reason: "Windows: DPAPI-protected files for this account" };
  else {
    const service = linuxSecretServiceStore();
    const health = await service.check();
    chosen = health.ok ? { store: service, reason: "Linux: the Secret Service" } : { store: protectedFileStore(join(options.dataDir, "secrets")), reason: `Linux: owner-only files in ${join(options.dataDir, "secrets")} (${health.detail})` };
  }
  await mkdir(options.dataDir, { recursive: true });
  try { await writeFile(marker, `${JSON.stringify({ kind: chosen.store.kind })}\n`, { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Another start chose first: use what it recorded.
    return chooseSecretStore(options);
  }
  return chosen;
}
