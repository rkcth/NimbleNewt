import { lstatSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

/**
 * Where a local worker host keeps the agents' homes, and so their own conversation stores (card K01i). The process keeps its conversation in `<home>/pi` (`localWorkerParts`); a host that gives every home from this one
 * folder (`home(key)`, one home per key the host chooses: a task, an agent) has every conversation store at `<root>/<key>/pi`. The controller is composed with `piState` (`dispatch.local.piState`): backups then copy every
 * store found here and a restore puts each one back where it was (`final`), so the conversation memory comes back with the records.
 *
 * The key is the store's ID inside a backup: letters, digits, `.`, `_` and `-`, starting with a letter or digit, at most 128 characters (the backup's own rule). Links are not followed: a home or a `pi` folder that is a link
 * is left out of the list (it would let a backup copy, or a restore write, somewhere else).
 */
export interface ConversationStoresOptions {
  /** An absolute, normalised folder this host owns for the agents' homes. */
  readonly root: string;
  /**
   * The folder inside `<root>/<key>` that is the agent's home (card K01i). The product hosts keep `<base>/attempts/<attemptId>/home` (next to the attempt's `scratch`), so they give `root = <base>/attempts` and `homeFolder = "home"`: the
   * conversation is then at `<root>/<key>/home/pi`. Default: none (the home is `<root>/<key>` itself).
   */
  readonly homeFolder?: string;
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The same rule the backup applies to a store ID. */
export const validConversationKey = (key: unknown): key is string => typeof key === "string" && KEY.test(key) && !key.includes("..");
/** The most stores listed (the backup's own limit). */
export const CONVERSATION_STORES_MAX = 50_000;

export class LocalConversationStores {
  readonly #root: string;
  readonly #sub: readonly string[];
  constructor(options: ConversationStoresOptions) {
    if (options.homeFolder !== undefined && (typeof options.homeFolder !== "string" || !validConversationKey(options.homeFolder))) throw new Error("the home folder must be a plain folder name");
    this.#sub = options.homeFolder === undefined ? [] : [options.homeFolder];
    if (typeof options.root !== "string" || !isAbsolute(options.root) || normalize(options.root) !== options.root) throw new Error("the homes root must be an absolute, normalised path");
    this.#root = options.root;
  }

  /** The home folder for a key (pass it as the attempt workspace's `home`). Throws for a key a backup could not keep. */
  home(key: string): string {
    if (!validConversationKey(key)) throw new Error("a home key must be letters, digits, '.', '_' or '-' (at most 128, starting with a letter or digit)");
    return join(this.#root, key, ...this.#sub);
  }

  /** Where the conversation store of `id` goes back on a restore; undefined for an ID that is not a key of this host. Pass it as `dispatch.local.piState.final`. */
  /**
   * A home or a `pi` folder that is a link (or not a folder) is not a place to restore to: an agent may replace its own `pi` folder with a link, and a restore that followed it would move whatever the link names
   * aside and put the conversation there. Such a store is not mapped here (the controller then restores it into its own data directory). One not made yet is mapped (the restore makes it).
   */
  readonly final = (id: string): string | undefined => {
    if (!validConversationKey(id)) return undefined;
    const home = join(this.#root, id, ...this.#sub);
    for (const p of [join(this.#root, id), home, join(home, "pi")]) {
      let info: ReturnType<typeof lstatSync> | undefined;
      try { info = lstatSync(p); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; return undefined; }
      if (!info.isDirectory()) return undefined;
    }
    return join(home, "pi");
  };

  /** Every conversation store on this host. Pass it as `dispatch.local.piState.source`. */
  readonly source = {
    list: async (): Promise<readonly { readonly id: string; readonly dir: string }[]> => {
      let names: string[];
      try { names = (await readdir(this.#root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      names.sort();
      const stores: { id: string; dir: string }[] = [];
      for (const name of names) {
        if (!validConversationKey(name)) continue;
        const dir = join(this.#root, name, ...this.#sub, "pi");
        const folders = [join(this.#root, name, ...this.#sub), dir];
        let plain = true;
        for (const f of folders) { const i = await lstat(f).catch(() => undefined); if (i === undefined || !i.isDirectory()) { plain = false; break; } }
        if (!plain) continue;
        if (stores.length >= CONVERSATION_STORES_MAX) throw new Error(`more than ${CONVERSATION_STORES_MAX} conversation stores on this host: too many to back up`);
        stores.push({ id: name, dir });
      }
      return stores;
    },
  };
}
