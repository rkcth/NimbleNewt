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
  /** The typed arguments held something that redaction changed (a secret): the stored text is not what was typed, so the command is not run from it. */
  readonly redacted?: true;
  readonly requestedBy: string;
  readonly queuedAt: string;
  /** The context the shortcut was resolved in, so a reader can see why it meant this. */
  readonly context: { readonly agent?: string; readonly scope?: string };
}

/** What came of running a queued command, kept so that running it again answers from the record and never runs it twice (card T09b). */
export interface RunBody {
  readonly queuedId: string;
  readonly by: string;
  readonly state: "done" | "failed" | "unsupported";
  /** For `failed` and `unsupported`: the reason, in plain words. */
  readonly error?: { readonly code: string; readonly message: string };
  readonly at: string;
}

/** How a queued command is run: the operation a built-in name stands for, and a call to it as the typist (the state API, so the operation's own checks decide). */
/** What running a command gives back: the record, and for a success the operation's answer, cut to a bound (`truncated` says so). The answer is not kept. */
export type RunResult = RunBody & { readonly answer?: JsonObject; readonly truncated?: true };
const TRANSIENT = new Set(["unavailable", "stale_revision", "internal", "rate_limited", "timeout", "lease_lost"]);
/** Cuts at a character count without splitting a surrogate pair. */
const cutAt = (text: string, n: number): string => { const cut = text.slice(0, n); const last = cut.charCodeAt(cut.length - 1); return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut; };

export interface CommandInvoker {
  operationOf(canonical: string): string | undefined;
  invoke(operation: string, args: JsonObject, commandId: string): Promise<{ readonly ok: true; readonly result: JsonObject } | { readonly ok: false; readonly code: string; readonly message: string }>;
}

export const COMMAND_LIMITS = { args: 4000, aliases: 200, answer: 8000 } as const;
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
        const body: QueuedBody = { typed: redactText(typed).slice(0, 80), asked, target: now.target, args: redactText(now.rest).slice(0, COMMAND_LIMITS.args), ...(redactText(now.rest) !== now.rest || now.rest.length > COMMAND_LIMITS.args ? { redacted: true as const } : {}), requestedBy: by.id, queuedAt: this.#runner.now(), context: { ...(context.agent === undefined ? {} : { agent: context.agent }), ...(context.scope === undefined ? {} : { scope: context.scope }) } };
        return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { operation: now.target.operationId, version: now.target.version } };
      },
    }));
    const found = (await this.#runner.get("queued-command", done.id))!;
    return { status: "queued", id: done.id, revision: done.revision, replayed: done.replayed, target: (found.body as unknown as QueuedBody).target };
  }

  /**
   * Runs a queued command as the one who typed it (card T09b). Only the requester runs it. A built-in command (`/nimblenewt.…`) calls the state-API operation of that name with the typed arguments (a JSON object, or none) under the
   * requester's own rights, so the operation decides whether they may; its command ID comes from the queued command, so the operation itself answers a second run from its own record. The outcome is kept: running the
   * same queued command again returns it without calling the operation. A toolbox or agent command is answered once as not runnable yet (cards T09c and T09d).
   */
  async run(by: Principal, command: NoActor & { id: string }, how: CommandInvoker): Promise<RunResult> {
    onlyKnown(command, ["commandId", "id"]);
    const queued = await this.queued(by, command.id);
    if (queued === undefined || queued.requestedBy !== by.id) throw new DomainError("not_found", "no such queued command");
    const runId = derivedId("crn", queued.id);
    const prior = await this.#runner.get("command-run", runId);
    const before = prior === undefined ? undefined : (prior.body as unknown as RunBody);
    // Failures and the unsupported are final. A success is recorded without its answer (an answer is the source's data, not ours to keep): running again calls the operation again with the same command ID, which answers from its own record under the caller's rights as they are now.
    if (before !== undefined && before.state !== "done") return before;
    const operation = queued.target.layer === "protected" ? how.operationOf(queued.target.operationId) : undefined;
    let outcome: Omit<RunBody, "queuedId" | "by" | "at">;
    let answer: { answer?: JsonObject; truncated?: true } = {};
    if (queued.target.layer !== "protected") outcome = { state: "unsupported", error: { code: "unsupported", message: `${queued.target.layer === "toolbox" ? "toolbox" : "agent"} commands cannot be run from here yet` } };
    else if (operation === undefined) outcome = { state: "failed", error: { code: "not_found", message: `${queued.target.operationId} is no longer a command of this controller` } };
    else {
      let args: JsonObject = {};
      const raw = queued.args.trim();
      let bad: string | undefined;
      if (raw !== "") {
        try { const parsed: unknown = JSON.parse(raw); if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) bad = "the arguments must be a JSON object, for example {\"project\": \"proj-…\"}"; else args = parsed as JsonObject; } catch { bad = "the arguments must be a JSON object, for example {\"project\": \"proj-…\"}"; }
      }
      if (queued.redacted === true) bad = "the arguments held something that looks like a secret, so they were not kept and the command is not run from them; send the operation through the API instead";
      if (bad !== undefined) outcome = { state: "failed", error: { code: "invalid_command", message: bad } };
      else {
        const answered = await how.invoke(operation, args, `cmd-${queued.id}`);
        if (!answered.ok) {
          const now = this.#runner.now();
          // A refusal that may pass (the controller busy, a revision that moved) is told but not recorded as final.
          if (TRANSIENT.has(answered.code)) return { queuedId: queued.id, by: by.id, state: "failed", error: { code: answered.code, message: redactText(answered.message).slice(0, 500) }, at: now };
          outcome = { state: "failed", error: { code: answered.code, message: redactText(answered.message).slice(0, 500) } };
        } else {
          const text = JSON.stringify(answered.result);
          answer = text.length <= COMMAND_LIMITS.answer ? { answer: answered.result } : { answer: { cut: cutAt(text, COMMAND_LIMITS.answer) }, truncated: true };
          outcome = { state: "done" };
        }
      }
    }
    if (before !== undefined) return { ...before, ...answer };
    const ref: AggregateRef = { kind: "command-run", id: runId };
    const body: RunBody = { queuedId: queued.id, by: by.id, ...outcome, at: this.#runner.now() };
    try {
      await this.#runner.command("command.run", { commandId: scopedCommandId(by.id, `run-${queued.id}`), actor: by.id }, async () => ({
        payload: { queuedId: queued.id, state: body.state },
        build: async () => ({ ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { operation: queued.target.operationId, state: body.state } }),
      }));
    } catch (error) {
      // Two runs at the same moment: the first record stands, and this one answers with it.
      if (!(error instanceof DomainError) || (error.code !== "command_conflict" && error.code !== "stale_revision")) throw error;
    }
    return { ...((await this.#runner.get("command-run", runId))!.body as unknown as RunBody), ...answer };
  }

  /** A queued command: its requester or the owner. Anyone else reads it like a missing one. */
  async queued(by: Principal, id: string): Promise<View<QueuedBody> | undefined> {
    const found = await this.#runner.get("queued-command", typeof id === "string" ? id : "");
    if (found === undefined) return undefined;
    const body = found.body as unknown as QueuedBody;
    return by.kind === "owner" || body.requestedBy === by.id ? view<QueuedBody>(found) : undefined;
  }
}
