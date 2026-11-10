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
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The same rule the backup applies to a store ID. */
export const validConversationKey = (key: unknown): key is string => typeof key === "string" && KEY.test(key) && !key.includes("..");
/** The most stores listed (the backup's own limit). */
export const CONVERSATION_STORES_MAX = 50_000;

export class LocalConversationStores {
  readonly #root: string;
  constructor(options: ConversationStoresOptions) {
    if (typeof options.root !== "string" || !isAbsolute(options.root) || normalize(options.root) !== options.root) throw new Error("the homes root must be an absolute, normalised path");
    this.#root = options.root;
  }

  /** The home folder for a key (pass it as the attempt workspace's `home`). Throws for a key a backup could not keep. */
  home(key: string): string {
    if (!validConversationKey(key)) throw new Error("a home key must be letters, digits, '.', '_' or '-' (at most 128, starting with a letter or digit)");
    return join(this.#root, key);
  }

  /** Where the conversation store of `id` goes back on a restore; undefined for an ID that is not a key of this host. Pass it as `dispatch.local.piState.final`. */
  readonly final = (id: string): string | undefined => (validConversationKey(id) ? join(this.#root, id, "pi") : undefined);

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
        const dir = join(this.#root, name, "pi");
        const info = await lstat(dir).catch(() => undefined);
        if (info === undefined || !info.isDirectory()) continue;
        if (stores.length >= CONVERSATION_STORES_MAX) throw new Error(`more than ${CONVERSATION_STORES_MAX} conversation stores on this host: too many to back up`);
        stores.push({ id: name, dir });
      }
      return stores;
    },
  };
}
