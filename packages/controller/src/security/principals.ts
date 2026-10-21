import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import { DomainError } from "../domain/errors.js";
import { onlyKnown, type View } from "../domain/model.js";
import { CommandRunner, view, type CommandMeta, type RunnerOptions } from "../domain/runner.js";
import { mayHold } from "./access.js";
import { effectiveOf } from "./grants.js";
import { credentialIdOf, hashSecret, makeToken, newSecret, parseToken, verifySecret, type StoredCredential } from "./credentials.js";

/**
 * `service` is a trusted controller service such as the recovery service (card A10): it holds only `recovery.*` actions, cannot be addressed in a conversation and cannot use the conversation API.
 * `client` is an external agent or service that talks to NimbleNewt agents through the conversation API (card U02). It is not a worker: the only actions it can ever hold are
 * the `conversation.*` ones, whoever grants them and however, so joining a thread gives it no tool, task or file capability.
 */
export type PrincipalKind = "owner" | "agent" | "host" | "client" | "service";
export const PRINCIPAL_KINDS: readonly PrincipalKind[] = ["owner", "agent", "host", "client", "service"];

/** What a principal may do: an action (a dotted name such as `task.create`, or `*`) within a project (an ID, or `*` for every project and for actions that belong to none). */
export interface Grant {
  readonly action: string;
  readonly project: string;
  /** Narrows the grant to one resource (such as one task). Without it the grant covers the whole project. */
  readonly resource?: { readonly kind: string; readonly id: string };
  /** The grant record this came from (card A02); absent for grants given at enrollment. */
  readonly grantId?: string;
  /** After this UTC time the grant no longer counts. */
  readonly expiresAt?: string;
}

/** A prohibition that beats any grant (card A02). */
export interface Restriction {
  readonly action: string;
  readonly project: string;
  readonly resource?: { readonly kind: string; readonly id: string };
  readonly restrictionId?: string;
  readonly reason?: string;
}

export interface PrincipalBody {
  readonly kind: PrincipalKind;
  readonly name: string;
  readonly state: "active" | "disabled";
  readonly grants: readonly Grant[];
  /** Absent until a credential is issued. The secret itself is never stored. */
  readonly credential?: StoredCredential;
  readonly createdBy: string;
}

/** Who is acting, as established by authentication: nothing a caller says about itself can produce one. */
export interface Principal {
  readonly id: string;
  readonly kind: PrincipalKind;
  readonly name: string;
  readonly grants: readonly Grant[];
  /** Standing prohibitions that apply to this principal; they win over grants. Filled by `GrantService.effective`. */
  readonly restrictions?: readonly Restriction[];
  /** When this snapshot of grants and restrictions was taken. */
  readonly asOf?: string;
  /** Which credential this principal authenticated with (a digest of the stored credential, which changes whenever the credential does). Rotating the credential changes it, so work done with an older object can be refused. Absent on an object that did not come from authentication. */
  readonly credentialId?: string;
}

export interface IssuedCredential {
  readonly principalId: string;
  /** Shown once. Only its hash is kept, so it cannot be recovered: issue a new one instead. */
  readonly token: string;
}

export const PRINCIPAL_LIMITS = { name: 40, grants: 200, action: 60 } as const;
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ACTION = /^(?:\*|[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*(?:\.\*)?)$/;
const PROJECT = /^(?:\*|proj-[a-z2-7]{20})$/;

/** A command as the security layer takes it: the actor is never supplied, it is the authenticated principal. */
export type NoActor = Omit<CommandMeta, "actor">;

export const principalIdOf = (kind: PrincipalKind, name: string): string => `${kind}:${name}`;

const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

export function grants(value: unknown, field = "grants"): Grant[] {
  if (!Array.isArray(value)) return invalid(field, "must be a list");
  if (value.length > PRINCIPAL_LIMITS.grants) return invalid(field, `must have at most ${PRINCIPAL_LIMITS.grants} entries`);
  return value.map((raw: unknown, i) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return invalid(`${field}[${i}]`, "must be an object");
    const entry = raw as Record<string, unknown>;
    for (const key of Object.keys(entry)) if (key !== "action" && key !== "project") invalid(`${field}[${i}].${key}`, "is not a grant field");
    const action = typeof entry["action"] === "string" && entry["action"].length <= PRINCIPAL_LIMITS.action && ACTION.test(entry["action"]) ? entry["action"] : invalid(`${field}[${i}].action`, "must be an action name such as task.create, a prefix such as task.*, or *");
    const project = typeof entry["project"] === "string" && PROJECT.test(entry["project"]) ? entry["project"] : invalid(`${field}[${i}].project`, "must be a project ID or *");
    return { action, project };
  });
}

/** What a failed authentication says, whatever the reason: no hint about which part was wrong. */
const refusal = (): DomainError => new DomainError("unauthenticated", "the credential was not accepted");

/**
 * Identities and credentials (card A01). There is one owner per installation (the installation record is created once, so two bootstraps cannot make
 * two owners); the owner enrolls agents and hosts and gives them grants; every principal authenticates with a token whose secret is stored only as a hash.
 * Authentication never says whether the principal exists, is disabled, or had the wrong secret.
 */
export class PrincipalService {
  readonly #runner: CommandRunner;
  readonly #clockNow: () => string;

  private constructor(runner: CommandRunner) {
    this.#runner = runner;
    this.#clockNow = () => runner.now();
  }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): PrincipalService {
    return new PrincipalService(new CommandRunner(storage, epoch, options));
  }

  /**
   * Creates the installation's one owner and its first credential. Allowed once: afterwards it is refused, whatever name is given. The token is returned
   * to the caller of this method (the installer) and nowhere else.
   */
  async bootstrapOwner(input: { name: string; commandId?: string }): Promise<IssuedCredential> {
    const name = nameOf(input.name);
    const id = principalIdOf("owner", name);
    const secret = newSecret();
    const body: PrincipalBody = { kind: "owner", name, state: "active", grants: [], credential: await hashSecret(secret, this.#clockNow()), createdBy: "bootstrap" };
    const installation: AggregateRef = { kind: "installation", id: "installation" };
    const principal: AggregateRef = { kind: "principal", id };
    const result = await this.#runner.command("owner.bootstrap", { commandId: input.commandId ?? `bootstrap:${randomId()}`, actor: "bootstrap" }, async () => ({
      payload: { name },
      build: async () => ({
        ref: principal, creates: true,
        changes: [{ type: "create", ref: installation, body: { ownerId: id } }, { type: "create", ref: principal, body: body as unknown as JsonObject }],
        detail: { principal: id },
        contention: async () => new DomainError("forbidden", "this installation already has an owner"),
      }),
    }));
    // A replay of an earlier bootstrap stored nothing new, so the secret generated here would match no stored credential: refuse rather than hand back a token that cannot work.
    if (result.replayed) throw new DomainError("forbidden", "this installation was already bootstrapped; the owner can issue a new credential");
    return { principalId: id, token: makeToken(id, secret) };
  }

  /** The owner enrolls an agent or a host (no credential yet, and no grants unless given). */
  async enroll(owner: Principal, command: NoActor & { kind: PrincipalKind; name: string; grants?: readonly Grant[] }): Promise<{ id: string }> {
    requireOwner(owner);
    return this.#runner.command("principal.enroll", { ...command, actor: owner.id }, async () => {
      onlyKnown(command, ["commandId", "kind", "name", "grants"]);
      const kind = command.kind === "agent" || command.kind === "host" || command.kind === "client" || command.kind === "service" ? command.kind : invalid("kind", "must be agent, host, client or service (there is one owner, created at installation)");
      const name = nameOf(command.name);
      const given = command.grants === undefined ? [] : grants(command.grants);
      for (const g of given) if (!mayHold(kind, g.action)) invalid("grants", `${kind === "client" ? "a client may hold only conversation actions" : kind === "service" ? "a service may hold only recovery actions" : "that action is not allowed"}, not ${g.action}`);
      const id = principalIdOf(kind, name);
      const body: PrincipalBody = { kind, name, state: "active", grants: given, createdBy: owner.id };
      return {
        payload: { kind, name, grants: given as unknown as JsonObject[] },
        build: async () => ({ ref: { kind: "principal", id }, creates: true, changes: [{ type: "create", ref: { kind: "principal", id }, body: body as unknown as JsonObject }], detail: { kind, name } }),
      };
    }).then((r) => ({ id: r.id }));
  }

  /** Replaces a principal's grants (the owner only). The change takes effect for the next authentication. */
  async setGrants(owner: Principal, command: NoActor & { principalId: string; expectedRevision: number; grants: readonly Grant[] }): Promise<void> {
    requireOwner(owner);
    return this.#update(owner, "principal.grants", command, (body) => {
      const next = grants(command.grants);
      for (const g of next) if (!mayHold(body.kind, g.action)) invalid("grants", `${body.kind === "client" ? "a client may hold only conversation actions" : "a service may hold only recovery actions"}, not ${g.action}`);
      return { ...body, grants: next };
    }, { grants: grants(command.grants).length });
  }

  /** Disables a principal: every later authentication fails, whatever its secret. */
  async disable(owner: Principal, command: NoActor & { principalId: string; expectedRevision: number }): Promise<void> {
    requireOwner(owner);
    return this.#update(owner, "principal.disable", command, (body) => {
      if (body.kind === "owner") throw new DomainError("invalid_command", "the owner cannot be disabled", { field: "principalId" });
      return { ...body, state: "disabled" };
    }, {});
  }

  /**
   * Issues a new credential for a principal and returns its token, once. Replaces any earlier credential (which stops working at once). The owner may
   * issue for anyone; nobody else may. A crash after the credential is stored and before the token is read leaves no way to recover it: issue again.
   */
  async issueCredential(owner: Principal, principalId: string): Promise<IssuedCredential> {
    requireOwner(owner);
    const current = await this.#runner.get("principal", principalId);
    if (current === undefined) throw new DomainError("not_found", `principal ${principalId} does not exist`);
    const secret = newSecret();
    const credential = await hashSecret(secret, this.#clockNow());
    await this.#update(owner, "principal.credential", { commandId: `credential:${randomId()}`, principalId, expectedRevision: current.revision }, (body) => ({ ...body, credential }), {});
    return { principalId, token: makeToken(principalId, secret) };
  }

  /** The principal a token proves, or `unauthenticated`. */
  async authenticate(token: unknown): Promise<Principal> {
    const parsed = parseToken(token);
    // Look up (or not), and always verify, so unknown, disabled and wrong-secret cases look the same and cost the same.
    const found = parsed === undefined ? undefined : await this.#runner.get("principal", parsed.principalId);
    const body = found?.body as unknown as PrincipalBody | undefined;
    const ok = await verifySecret(parsed?.secret, body?.credential);
    if (!ok || found === undefined || body === undefined || body.state !== "active") throw refusal();
    // The principal comes with its grant records and restrictions as of now; take a new one for each request so a revocation or restriction shows.
    return effectiveOf(this.#runner, { id: found.id, kind: body.kind, name: body.name, grants: body.grants, ...(body.credential === undefined ? {} : { credentialId: credentialIdOf(body.credential) }) }, this.#clockNow());
  }

  async get(principalId: string): Promise<(View<Omit<PrincipalBody, "credential">> & { hasCredential: boolean }) | undefined> {
    const found = await this.#runner.get("principal", principalId);
    if (found === undefined) return undefined;
    const { credential, ...rest } = found.body as unknown as PrincipalBody;
    return { ...view<Omit<PrincipalBody, "credential">>({ ...found, body: rest as unknown as JsonObject }), hasCredential: credential !== undefined };
  }

  async #update(owner: Principal, type: string, command: NoActor & { principalId: string; expectedRevision: number }, change: (body: PrincipalBody) => PrincipalBody, detail: JsonObject): Promise<void> {
    await this.#runner.command(type, { commandId: command.commandId, actor: owner.id }, async () => ({
      payload: { principalId: command.principalId, expectedRevision: command.expectedRevision, ...detail },
      build: async () => {
        const current = await this.#runner.existing("principal", command.principalId, command.expectedRevision);
        const next = change(current.body as unknown as PrincipalBody);
        const ref: AggregateRef = { kind: "principal", id: command.principalId };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }], detail: { principalId: command.principalId, ...detail } };
      },
    }));
  }
}

function requireOwner(principal: Principal): void {
  if (principal.kind !== "owner") throw new DomainError("forbidden", `${principal.id} is not the owner; only the owner manages principals`);
}

function nameOf(value: unknown): string {
  return typeof value === "string" && NAME.test(value) ? value : invalid("name", "must be 1 to 40 lower-case letters, digits or hyphens, starting with a letter or digit");
}

const randomId = (): string => Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(12))).toString("base64url");

