import { createHash } from "node:crypto";
import { parseName } from "@nimblenewt/registry";
import { canonicalJson } from "../storage/json.js";
import type { CommandSource } from "./resolve.js";

/** What the controller says of one of its own operations (the state API's `Operation`, without its code). */
export interface BuiltinOperation { readonly name: string; readonly kind: "query" | "command"; readonly args: Readonly<Record<string, string>> }

/** The version every built-in command has. Its digest changes with the operation's name, kind and arguments, so queued work notices a changed operation. */
export const BUILTIN_VERSION = "1.0.0";
/** The operation that runs a typed command; it is not itself a command, so a command cannot run a command. */
const NOT_COMMANDS = new Set(["command.run"]);

/** `grant.list` is `/nimblenewt.grant-list`: a command name has no dots. */
export const builtinCommandName = (op: string): string => `nimblenewt.${op.replace(/\./g, "-")}`;

const sha = (value: unknown): string => createHash("sha256").update(canonicalJson(value as never)).digest("hex");

/**
 * The commands of the `nimblenewt` namespace (card T09b): the controller's own state-API operations, each reachable as `/nimblenewt.<operation with dots as hyphens>`. They belong to the controller, so
 * nothing in the catalog can stand in for one; `toolbox.` and `a_<id>.` names are read from the catalog as before. Every caller sees every built-in name (the list is public in the API reference); who may run
 * one is decided by the operation when it runs, under the caller's own rights.
 */
export class BuiltinCommands {
  readonly #byName = new Map<string, BuiltinOperation>();

  constructor(operations: readonly BuiltinOperation[]) {
    for (const op of operations) {
      if (NOT_COMMANDS.has(op.name)) continue;
      const name = builtinCommandName(op.name);
      const parsed = parseName(name);
      if (parsed === null || parsed.canonical !== name) throw new RangeError(`operation ${op.name} has no valid command name (${name})`);
      if (this.#byName.has(name)) throw new RangeError(`operations ${this.#byName.get(name)!.name} and ${op.name} would share the command name ${name}`);
      this.#byName.set(name, op);
    }
  }

  /** The operation a canonical built-in name stands for. */
  operationOf(canonical: string): BuiltinOperation | undefined { return this.#byName.get(canonical); }

  names(): string[] { return [...this.#byName.keys()].sort(); }

  /** A command source for the resolver: built-ins here, everything else from `inner`. */
  source(inner: CommandSource): CommandSource {
    return {
      names: async (by) => [
        ...this.names().map((name) => ({ name, layer: "protected" as const, latest: BUILTIN_VERSION })),
        ...(await inner.names(by)).filter((e) => e.layer !== "protected"),
      ],
      version: async (by, name, version) => {
        if (!name.startsWith("nimblenewt.")) return inner.version(by, name, version);
        const op = this.#byName.get(name);
        if (op === undefined || (version !== undefined && version !== BUILTIN_VERSION)) return undefined;
        return { name, layer: "protected" as const, version: BUILTIN_VERSION, digest: sha({ name: op.name, kind: op.kind, args: op.args }), schemaDigest: sha(op.args).slice(0, 32), revoked: false };
      },
    };
  }
}
