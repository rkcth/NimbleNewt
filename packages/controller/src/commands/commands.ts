import { createHash } from "node:crypto";
import { parseName } from "@nimblenewt/registry";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { commandId as checkCommandId, onlyKnown, text, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import { CommandResolver, isScope, type CommandContext, type CommandSource, type Resolution, type Target } from "./resolve.js";

/** What a `/custom.` alias is: a name in an explicit scope for one canonical command. Resolved when it is used, so it grants nothing and shares no namespace. */
export interface AliasBody { readonly scope: string; readonly alias: string; readonly target: string; readonly definedBy: string; readonly definedAt: string; /** Set when the owner removed it; the name can then be defined again. */ readonly removedAt?: string }
/** A command waiting to run: the resolved target and the arguments as typed. The shortcut is kept only to show what was typed. */
export interface QueuedBody {
  readonly typed: string;
  /** A digest of what was asked (the text and the context), so the same command ID with something else is a conflict, not a replay. */
  readonly asked: string;
  readonly target: Target;
  readonly args: string;
  readonly requestedBy: string;
  readonly queuedAt: string;
  /** The context the shortcut was resolved in, so a reader can see why it meant this. */
  readonly context: { readonly agent?: string; readonly scope?: string };
}

export const COMMAND_LIMITS = { args: 4000, aliases: 200 } as const;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

export class CommandService {
  readonly #runner: CommandRunner;
  readonly #source: CommandSource;

  private constructor(runner: CommandRunner, source: CommandSource) { this.#runner = runner; this.#source = source; }

  static withEpoch(storage: ControllerStorage, epoch: number, source: CommandSource, options: RunnerOptions = {}): CommandService {
    return new CommandService(new CommandRunner(storage, epoch, options), source);
  }

  /** The resolver over the catalog and the aliases defined here. */
  resolver(): CommandResolver {
    return new CommandResolver(this.#source, async (scope, alias) => {
      const found = await this.#runner.get("command-alias", derivedId("cal", `${scope}|${alias}`));
      const body = found?.body as unknown as AliasBody | undefined;
      return body === undefined || body.removedAt !== undefined ? undefined : body.target;
    });
  }

  // ---- aliases ------------------------------------------------------------------------------------------------------------------

  /**
   * The owner defines `/custom.<alias>` in a scope for a canonical command they can see. An alias is another name for one command: it grants nothing, cannot name another alias, and an alias already
   * defined in the scope is refused (change it by removing it and defining it again), so what a name means in a scope never changes without a record of it.
   */
  async defineAlias(owner: Principal, command: NoActor & { scope: string; alias: string; target: string }): Promise<{ id: string; revision: number; replayed: boolean }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not define command aliases`);
    onlyKnown(command, ["commandId", "scope", "alias", "target"]);
    if (!isScope(command.scope)) invalid("scope", "must be lower-case letters, digits and : _ . - (at most 64 characters)");
    const probe = new CommandResolver(this.#source).resolve(owner, `/custom.${typeof command.alias === "string" ? command.alias : ""}`, {});
    if ((await probe).status === "refused") invalid("alias", "must be lower-case letters, digits and single hyphens, at most 28 characters");
    const target = parseName(command.target);
    if (target === null) invalid("target", "must be a canonical command name (nimblenewt., toolbox. or a_<id>.)");
    const canonical = target!.canonical;
    const id = derivedId("cal", `${command.scope}|${command.alias}`);
    const ref: AggregateRef = { kind: "command-alias", id };
    return this.#runner.command("command.alias.define", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { scope: command.scope, alias: command.alias, target: canonical },
      build: async () => {
        const old = await this.#runner.get(ref.kind, ref.id);
        if (old !== undefined && (old.body as unknown as AliasBody).removedAt === undefined) throw new DomainError("invalid_command", `/custom.${command.alias} already exists in ${command.scope}; remove it first`, { field: "alias" });
        if ((await this.#source.version(owner, canonical)) === undefined) throw new DomainError("not_found", `no command ${canonical} that you can use`);
        const at = this.#runner.now();
        const body: AliasBody = { scope: command.scope, alias: command.alias, target: canonical, definedBy: owner.id, definedAt: at };
        return { ref, creates: old === undefined, changes: [old === undefined ? { type: "create", ref, body: body as unknown as JsonObject } : { type: "update", ref, expectedRevision: old.revision, body: body as unknown as JsonObject }], detail: { scope: command.scope, alias: command.alias, target: canonical } };
      },
    }));
  }

  /** The owner removes an alias. */
  async removeAlias(owner: Principal, command: NoActor & { scope: string; alias: string; expectedRevision: number }): Promise<void> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not remove command aliases`);
    onlyKnown(command, ["commandId", "scope", "alias", "expectedRevision"]);
    if (!isScope(command.scope)) invalid("scope", "is not a valid scope");
    const id = derivedId("cal", `${command.scope}|${typeof command.alias === "string" ? command.alias : ""}`);
    await this.#runner.command("command.alias.remove", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { scope: command.scope, alias: command.alias, expectedRevision: command.expectedRevision },
      build: async () => {
        const current = await this.#runner.existing("command-alias", id, command.expectedRevision);
        const ref: AggregateRef = { kind: "command-alias", id: current.id };
        const old = current.body as unknown as AliasBody;
        if (old.removedAt !== undefined) throw new DomainError("invalid_command", `/custom.${command.alias} is already removed`, { field: "alias" });
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: { ...old, removedAt: this.#runner.now() } as unknown as JsonObject }], detail: { scope: command.scope, alias: command.alias } };
      },
    }));
  }

  /** The aliases of one scope. Owner only. */
  async aliases(owner: Principal, scope: string): Promise<View<AliasBody>[]> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not read command aliases`);
    if (!isScope(scope)) invalid("scope", "is not a valid scope");
    const out: View<AliasBody>[] = [];
    for (let after: string | undefined; ;) {
      const page = await this.#runner.list("command-alias", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const row of page) { after = row.id; const b = row.body as unknown as AliasBody; if (b.scope === scope && b.removedAt === undefined) out.push(view<AliasBody>(row)); }
      if (page.length < 200 || out.length >= COMMAND_LIMITS.aliases) return out.sort((a, b) => (a.alias < b.alias ? -1 : 1));
    }
  }

  // ---- queued work --------------------------------------------------------------------------------------------------------------

  /**
   * Resolves what was typed (or chosen) for the caller and, when it resolves, queues it with the resolved target. Anything that does not resolve (ambiguous, needs a context, unknown, refused) is
   * returned as it is and nothing is queued. The owner or an agent may queue; whether the caller may run the command is decided where it runs, not here.
   */
  async enqueue(by: Principal, command: NoActor & { typed: string; context?: CommandContext }): Promise<Resolution | { status: "queued"; id: string; revision: number; replayed: boolean; target: Target }> {
    if (by.kind !== "owner" && by.kind !== "agent") throw new DomainError("forbidden", `${by.id} may not queue commands`);
    onlyKnown(command, ["commandId", "typed", "context"]);
    const typed = text(command.typed, "typed", { min: 2, max: COMMAND_LIMITS.args, multiline: true });
    const context = command.context ?? {};
    onlyKnown(context, ["agent", "scope", "version"]);
    const resolver = this.resolver();
    const asked = createHash("sha256").update(JSON.stringify([typed, context.agent ?? null, context.scope ?? null, context.version ?? null])).digest("hex");
    // A command already queued under this command ID is answered from its record even when the name no longer resolves (a revoked version, a removed alias): the work is queued.
    const prior = await this.#runner.get("queued-command", derivedId("qcm", checkCommandId(command.commandId) + "|" + by.id));
    if (prior !== undefined) {
      const body = prior.body as unknown as QueuedBody;
      if (body.asked !== asked) throw new DomainError("command_conflict", "that command ID was used for something else", { field: "commandId" });
      return { status: "queued", id: prior.id, revision: prior.revision, replayed: true, target: body.target };
    }
    const first = await resolver.resolve(by, typed, context);
    if (first.status !== "resolved") return first;
    const done = await this.#runner.command("command.queue", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { typed, context: context as unknown as JsonObject },
      build: async () => {
        // Resolved again inside the command, so a retry never queues something other than what the first call saw resolve.
        const now = await resolver.resolve(by, typed, context);
        if (now.status !== "resolved") throw new DomainError("command_conflict", `the command no longer resolves: ${now.status}`);
        const id = derivedId("qcm", command.commandId + "|" + by.id);
        const ref: AggregateRef = { kind: "queued-command", id };
        const body: QueuedBody = { typed: redactText(typed).slice(0, 80), asked, target: now.target, args: redactText(now.rest).slice(0, COMMAND_LIMITS.args), requestedBy: by.id, queuedAt: this.#runner.now(), context: { ...(context.agent === undefined ? {} : { agent: context.agent }), ...(context.scope === undefined ? {} : { scope: context.scope }) } };
        return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { operation: now.target.operationId, version: now.target.version } };
      },
    }));
    const found = (await this.#runner.get("queued-command", done.id))!;
    return { status: "queued", id: done.id, revision: done.revision, replayed: done.replayed, target: (found.body as unknown as QueuedBody).target };
  }

  /** A queued command: its requester or the owner. Anyone else reads it like a missing one. */
  async queued(by: Principal, id: string): Promise<View<QueuedBody> | undefined> {
    const found = await this.#runner.get("queued-command", typeof id === "string" ? id : "");
    if (found === undefined) return undefined;
    const body = found.body as unknown as QueuedBody;
    return by.kind === "owner" || body.requestedBy === by.id ? view<QueuedBody>(found) : undefined;
  }
}
