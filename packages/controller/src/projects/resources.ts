import { mergeChanges } from "../domain/changes.js";
import { DomainError, isDomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { LIMITS, onlyKnown, projectId as checkProjectId, revision as checkRevision, taskId as checkTaskId, text, type ProjectBody, type Repository, type TaskBody, type View } from "../domain/model.js";
import { CommandRunner, view, type CommandResult, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { Aggregate, AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import { PROJECT_WORK_LIMITS as L, hidden, invalid, may, noCredential, scanAll, slug } from "./common.js";

export const RESOURCE_KINDS = ["repository", "output", "document", "service", "other"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** What a project may do with one bound resource: read or write, and whether only below some paths of it. No paths means the whole resource. */
export interface AccessScope {
  readonly mode: "read" | "write";
  readonly paths: readonly string[];
}

/**
 * A resource bound to one project (kind `project-resource`): a repository, a place outputs go (a folder, a document), a service. The binding, not the resource, carries the access
 * scope, so the same repository bound to two projects is two records with two scopes. `locator` is opaque to the controller (a path, URL or name); it is never read or written here.
 */
export interface ResourceBody {
  readonly projectId: string;
  readonly kind: ResourceKind;
  readonly label: string;
  readonly locator: string;
  /** For a repository: the project's own handle for it (the `repositoryId` a task names). */
  readonly repositoryId?: string;
  readonly scope: AccessScope;
  readonly state: "bound" | "unbound";
  /** Starts at 1; every move of the locator adds one. A task's checkout is pinned to it. */
  readonly locatorEpoch: number;
  readonly createdBy: string;
}

/** The claim of a responsibility on a resource it manages (kind `resource-claim`, ID = the resource's ID): one holder at a time. */
export interface ClaimBody {
  readonly resourceId: string;
  readonly projectId: string;
  readonly responsibilityId: string;
  readonly state: "held" | "released";
}

/** The checkout a task was dispatched against (kind `task-checkout`, ID = the task's ID): which binding and which version of its location. */
export interface CheckoutBody {
  readonly taskId: string;
  readonly projectId: string;
  readonly resourceId: string;
  readonly repositoryId: string;
  readonly locatorEpoch: number;
  readonly pinnedBy: string;
  /** Set when the pin was given up because its task no longer names a repository; a released pin holds nothing and the task is pinned afresh if it names one again. */
  readonly released?: { readonly by: string; readonly at: string };
}

/** What a task resolves to: the binding it works in, as it is now, checked against what it was pinned to. */
export interface Checkout {
  readonly taskId: string;
  readonly projectId: string;
  readonly resourceId: string;
  readonly repositoryId: string;
  readonly label: string;
  readonly locator: string;
  readonly scope: AccessScope;
  /** False for a task not yet dispatched: it resolves to the current binding and nothing is pinned. */
  readonly pinned: boolean;
}

export const RESOURCE = "project-resource";
export const CLAIM = "resource-claim";
export const CHECKOUT = "task-checkout";
const REGISTRY = "resource-registry";
/** One record per binding listing the tasks whose checkout is (or was) pinned to it, so ending a binding reads that list and not every checkout of every project. */
const PINS = "resource-pins";
/** A binding's pin list is pruned of finished tasks once it holds this many. */
const PRUNE_AT = 50;

// ---- scopes -------------------------------------------------------------------------------------------------------------------

/** A path relative to a resource, normalised to `a/b/c`, or `undefined` if it is not a safe relative path (absolute, drive-lettered, with `..`, empty or `.` segments, a stream marker or a trailing dot or space). */
export function relativePath(raw: string): string | undefined {
  if (raw.length === 0 || raw.length > L.path) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f:*?"<>|%]/.test(raw)) return undefined;
  const parts = raw.replace(/\\/g, "/").split("/");
  if (parts[0] === "" || parts[0] === "~") return undefined;
  if (parts[parts.length - 1] === "") parts.pop();
  if (parts.length === 0) return undefined;
  for (const p of parts) if (p === "" || p === "." || p === ".." || /[. ]$/.test(p)) return undefined;
  return parts.join("/");
}

function scopeOf(mode: unknown, paths: unknown, field: string): AccessScope {
  if (mode !== "read" && mode !== "write") return invalid(`${field}`, "must be read or write");
  if (paths === undefined) return { mode, paths: [] };
  if (!Array.isArray(paths) || paths.length > L.paths) return invalid("paths", `must be a list of at most ${L.paths} relative paths`);
  const out = new Set<string>();
  for (const [i, raw] of paths.entries()) {
    const p = typeof raw === "string" ? relativePath(raw) : undefined;
    if (p === undefined) return invalid(`paths[${i}]`, "must be a path below the resource: relative, without '..', drive letters or special characters");
    out.add(p);
  }
  return { mode, paths: [...out].sort() };
}

const under = (path: string, base: string): boolean => path === base || path.startsWith(`${base}/`);

/**
 * Whether a scope allows a use. A write needs a write scope. A scope limited to paths allows only a use of a path below one of them; a use of "the whole resource" (no path) is not
 * allowed by a limited scope. The comparison is exact and case-sensitive on purpose: on a case-folding file system a differently-cased path is refused rather than guessed at.
 */
export function scopeAllows(scope: AccessScope, use: { mode: "read" | "write"; path?: string }): boolean {
  if (use.mode === "write" && scope.mode !== "write") return false;
  // A path that is not a safe relative path is refused whatever the scope: an unlimited scope covers the resource, not other places.
  const p = use.path === undefined ? undefined : relativePath(use.path);
  if (use.path !== undefined && p === undefined) return false;
  if (scope.paths.length === 0) return true;
  return p !== undefined && scope.paths.some((base) => under(p, base));
}

/** Whether `next` lets a project do more than `previous` (a write where it could only read, or paths where there were fewer). */
const widens = (previous: AccessScope, next: AccessScope): boolean =>
  (next.mode === "write" && previous.mode === "read")
  || (previous.paths.length > 0 && (next.paths.length === 0 || next.paths.some((p) => !previous.paths.some((base) => under(p, base)))));

/**
 * A location in a comparable form, for the overlap guard only: backslashes become slashes, `file://` is dropped (a host left over means a UNC-style `//host/share`), repeated separators and `.`
 * segments collapse, and case is folded. Nothing is resolved on disk, so this sees spelling, not symlinks, bind mounts, substituted drives or a share versus the path behind it.
 */
const normLocator = (l: string): string => {
  let t = l.replace(/\\/g, "/");
  if (/^file:\/\//i.test(t)) { t = t.slice(7); if (!t.startsWith("/") && !/^[a-z]:/i.test(t)) t = `//${t}`; }
  const lead = t.startsWith("//") ? "//" : t.startsWith("/") ? "/" : "";
  return (lead + t.split("/").filter((seg) => seg !== "" && seg !== ".").join("/")).toLowerCase();
};
/** Refuses a locator that cannot be compared safely: a `..` segment, or a percent-escape of a separator or dot. */
function checkLocator(locator: string): string {
  if (locator.replace(/\\/g, "/").split("/").some((seg) => seg === "..")) invalid("locator", "must not contain '..' segments; give the full location");
  if (/%(2f|5c|2e)/i.test(locator)) invalid("locator", "must not hide a separator or dot in a percent-escape; give the location plainly");
  return locator;
}
const under_ = (base: string, x: string): boolean => x.startsWith(base.endsWith("/") ? base : `${base}/`);
/** Whether one location lies inside the other (equal locations do not count: binding one repository to two projects is allowed). */
const nested = (a: string, b: string): boolean => { const x = normLocator(a); const y = normLocator(b); return x !== y && (under_(x, y) || under_(y, x)); };

const REPOSITORY_HANDLE = /[^a-z0-9]+/g;
const handleFrom = (label: string): string => label.toLowerCase().replace(REPOSITORY_HANDLE, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");

export interface BindResource extends NoActor {
  readonly projectId: string;
  readonly kind: ResourceKind;
  readonly label: string;
  readonly locator: string;
  readonly repositoryId?: string;
  /** Default `read`. */
  readonly access?: "read" | "write";
  readonly paths?: readonly string[];
  /** Bind although the location contains, or lies inside, a location bound to another project. Needs `resource.scope.write`. */
  readonly acknowledgeOverlap?: boolean;
}

/**
 * Project resource bindings and task checkouts (card P01). A project is not a repository: it may bind none, one or several repositories and any number of other resources (output
 * folders, documents, services), and may bind the same repository as another project with a different scope. Everything here is a controller record; nothing is ever written to, or
 * read from, a bound location (this file imports no file-system module), so the controller's own state cannot appear in a target repository.
 *
 * - **Binding.** `bindResource` creates a record with a derived ID. Labels are unique among a project's bound resources, a repository handle is unique among all of its bindings. A repository
 *   binding also lists the repository in the project record (the S01 `repositories`), in the same operation, so tasks can name it; binding a repository the project already lists must
 *   agree with its location. Uniqueness is serialized through one registry record per project, so two simultaneous binds cannot both take a label.
 * - **Scope.** Reading is the default. A write scope, or a change that widens a scope, needs `resource.scope.write` as well as `resource.write`; narrowing needs only `resource.write`.
 * - **Moves do not redirect work.** A task is dispatched to a binding by the project's handle for the repository (never by location, label or name). `pinCheckout` records the binding and its
 *   location version; if the location is moved, the binding unbound, or the task is pointed at another repository, `resolveCheckout` refuses (`checkout_changed`) until `repinCheckout`
 *   confirms the new one. A second binding with the same label or location is another binding with another handle and captures nothing.
 */
export class ProjectResourceService {
  readonly #runner: CommandRunner;
  readonly #scanLimit: number;

  private constructor(runner: CommandRunner, scanLimit: number) { this.#runner = runner; this.#scanLimit = scanLimit; }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions & { scanLimit?: number } = {}): ProjectResourceService {
    return new ProjectResourceService(new CommandRunner(storage, epoch, options), options.scanLimit ?? L.scan);
  }

  get runner(): CommandRunner { return this.#runner; }

  // ---- commands ---------------------------------------------------------------------------------------------------------------

  async bindResource(by: Principal, command: BindResource): Promise<CommandResult> {
    return this.#runner.command("resource.bind", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async (meta) => {
      onlyKnown(command, ["commandId", "projectId", "kind", "label", "locator", "repositoryId", "access", "paths", "acknowledgeOverlap"]);
      const projectId = checkProjectId(command.projectId);
      const kind = (RESOURCE_KINDS as readonly string[]).includes(command.kind) ? command.kind : invalid("kind", `must be one of ${RESOURCE_KINDS.join(", ")}`);
      const label = text(command.label, "label", { min: 1, max: L.label });
      const locator = checkLocator(noCredential(text(command.locator, "locator", { min: 1, max: L.locator }), "locator"));
      const scope = scopeOf(command.access ?? "read", command.paths, "access");
      if (kind !== "repository" && command.repositoryId !== undefined) invalid("repositoryId", "only a repository has one");
      if (command.acknowledgeOverlap !== undefined && typeof command.acknowledgeOverlap !== "boolean") invalid("acknowledgeOverlap", "must be true or false");
      const acknowledged = command.acknowledgeOverlap === true;
      const explicit = kind === "repository" && command.repositoryId !== undefined ? slug(command.repositoryId, "repositoryId") : undefined;
      const base = kind === "repository" ? (explicit ?? handleFrom(label)) : undefined;
      if (base === "") invalid("repositoryId", "give a repository ID: the label has no usable letters or digits");
      return {
        payload: { projectId, kind, label, locator, ...(explicit === undefined ? {} : { repositoryId: explicit }), scope: scope as unknown as JsonObject, ...(acknowledged ? { acknowledgeOverlap: true } : {}) },
        build: async () => {
          // The registry is read first (the S10 pattern): a concurrent change to the project's bindings after this read makes our write of it fail, so the checks below cannot be raced.
          const snapshot = await this.#runner.get(REGISTRY, projectId);
          const known = await this.#idsOf(projectId, snapshot);
          const project = await this.#project(by, projectId, "resource.write", "bind resources");
          const owner = project.body as unknown as ProjectBody;
          if (owner.state === "archived") invalid("projectId", `project ${projectId} is archived; reactivate it to bind resources`);
          if (scope.mode === "write" && !may(by, "resource.scope.write", projectId)) throw hidden(by, "give write access to a resource");
          const here = await this.#resourcesOf(projectId);
          await this.#checkOverlap(by, projectId, locator, acknowledged);
          if (here.some((r) => r.state === "bound" && r.label.toLowerCase() === label.toLowerCase())) invalid("label", `the project already has a bound resource called "${label}"`);
          const changes: Change[] = [];
          let handle = base;
          if (handle !== undefined && explicit === undefined) {
            // A handle made from the label steps aside for one already used (an unbound one is never reused).
            const taken = new Set([...here.map((r) => r.repositoryId), ...owner.repositories.filter((r) => r.location !== locator).map((r) => r.id)]);
            for (let i = 2; taken.has(handle) || here.some((r) => r.repositoryId === handle); i++) handle = `${base!.slice(0, 36)}-${i}`;
          }
          if (handle !== undefined) {
            if (here.some((r) => r.repositoryId === handle)) invalid("repositoryId", `the project has already bound a repository ${handle} (unbound handles are not reused)`);
            const listed = owner.repositories.find((r) => r.id === handle);
            if (listed !== undefined && listed.location !== locator) invalid("repositoryId", `the project already lists repository ${handle} at another location; move it instead`);
            if (listed === undefined && owner.repositories.length >= LIMITS.repositories) invalid("projectId", `a project has at most ${LIMITS.repositories} repositories`);
            const entry: Repository = { id: handle, location: locator, ...(label.length <= LIMITS.label ? { label } : {}) };
            changes.push(listed === undefined
              ? { type: "update", ref: { kind: "project", id: projectId }, expectedRevision: project.revision, body: { ...owner, repositories: [...owner.repositories, entry] } as unknown as JsonObject }
              : { type: "check", ref: { kind: "project", id: projectId }, expectedRevision: project.revision });
          } else changes.push({ type: "check", ref: { kind: "project", id: projectId }, expectedRevision: project.revision });
          const id = derivedId("rsc", meta.commandId);
          const ref: AggregateRef = { kind: RESOURCE, id };
          const body: ResourceBody = { projectId, kind, label, locator, ...(handle === undefined ? {} : { repositoryId: handle }), scope, state: "bound", locatorEpoch: 1, createdBy: by.id };
          changes.unshift({ type: "create", ref, body: body as unknown as JsonObject });
          if (known.length >= this.#scanLimit) invalid("projectId", `a project has at most ${this.#scanLimit} bindings (unbound ones count)`);
          changes.push(this.#bump(projectId, snapshot, [...known, id], { ...await this.#locsOf(projectId, snapshot), [id]: locator }));
          changes.push({ type: "create", ref: { kind: PINS, id }, body: { tasks: [] } });
          return { ref, creates: true, changes: mergeChanges(changes), detail: { projectId, kind, label, access: scope.mode }, contention: async () => raced() };
        },
      };
    });
  }

  /** Points a bound resource at another location. Work already dispatched to it is not redirected (see `resolveCheckout`). */
  async moveResource(by: Principal, command: NoActor & { resourceId: string; expectedRevision: number; locator: string; acknowledgeOverlap?: boolean }): Promise<CommandResult> {
    return this.#runner.command("resource.move", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => {
      onlyKnown(command, ["commandId", "resourceId", "expectedRevision", "locator", "acknowledgeOverlap"]);
      if (command.acknowledgeOverlap !== undefined && typeof command.acknowledgeOverlap !== "boolean") invalid("acknowledgeOverlap", "must be true or false");
      const id = resourceIdOf(command.resourceId);
      const expected = checkRevision(command.expectedRevision);
      const locator = checkLocator(noCredential(text(command.locator, "locator", { min: 1, max: L.locator }), "locator"));
      return {
        payload: { resourceId: id, expectedRevision: expected, locator, ...(command.acknowledgeOverlap === true ? { acknowledgeOverlap: true } : {}) },
        build: async () => {
          const first = await this.#runner.get(RESOURCE, id);
          const where = (first?.body as unknown as ResourceBody | undefined)?.projectId ?? "unknown";
          const snapshot = await this.#runner.get(REGISTRY, where);
          const { found, body } = await this.#resource(by, id, "resource.write", "move resources");
          if (found.revision !== expected) throw new DomainError("stale_revision", `resource ${id} is at revision ${found.revision}, not ${expected}`, { currentRevision: found.revision });
          if (body.state !== "bound") invalid("resourceId", "the resource is unbound");
          if (body.locator === locator) invalid("locator", "the resource is already there");
          // A move re-targets everything the scope allows, so it needs the right to give that scope (a write or unlimited one).
          if ((body.scope.mode === "write" || body.scope.paths.length === 0) && !may(by, "resource.scope.write", body.projectId)) throw hidden(by, "move a resource that has write or unlimited access");
          await this.#checkOverlap(by, body.projectId, locator, command.acknowledgeOverlap === true);
          const project = await this.#project(by, body.projectId, "resource.write", "move resources");
          const owner = project.body as unknown as ProjectBody;
          const ref: AggregateRef = { kind: RESOURCE, id };
          const next: ResourceBody = { ...body, locator, locatorEpoch: body.locatorEpoch + 1 };
          const changes: Change[] = [{ type: "update", ref, expectedRevision: expected, body: next as unknown as JsonObject }];
          if (body.repositoryId !== undefined && owner.repositories.some((r) => r.id === body.repositoryId)) {
            const repositories = owner.repositories.map((r) => (r.id === body.repositoryId ? { ...r, location: locator } : r));
            changes.push({ type: "update", ref: { kind: "project", id: body.projectId }, expectedRevision: project.revision, body: { ...owner, repositories } as unknown as JsonObject });
          }
          changes.push(this.#bump(body.projectId, snapshot, undefined, { ...await this.#locsOf(body.projectId, snapshot), [id]: locator }));
          return { ref, creates: false, changes: mergeChanges(changes), detail: { projectId: body.projectId, locatorEpoch: next.locatorEpoch }, contention: async () => raced() };
        },
      };
    });
  }

  /** Replaces a resource's access scope. Widening it (or granting write) needs `resource.scope.write` as well. */
  async setScope(by: Principal, command: NoActor & { resourceId: string; expectedRevision: number; access: "read" | "write"; paths?: readonly string[] }): Promise<CommandResult> {
    return this.#runner.command("resource.scope", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => {
      onlyKnown(command, ["commandId", "resourceId", "expectedRevision", "access", "paths"]);
      const id = resourceIdOf(command.resourceId);
      const expected = checkRevision(command.expectedRevision);
      const scope = scopeOf(command.access, command.paths, "access");
      return {
        payload: { resourceId: id, expectedRevision: expected, scope: scope as unknown as JsonObject },
        build: async () => {
          const { found, body } = await this.#resource(by, id, "resource.write", "change the scope of resources");
          if (found.revision !== expected) throw new DomainError("stale_revision", `resource ${id} is at revision ${found.revision}, not ${expected}`, { currentRevision: found.revision });
          if (body.state !== "bound") invalid("resourceId", "the resource is unbound");
          if (JSON.stringify(body.scope) === JSON.stringify(scope)) invalid("access", "the resource already has this scope");
          if (widens(body.scope, scope) && !may(by, "resource.scope.write", body.projectId)) throw hidden(by, "widen the scope of a resource");
          const ref: AggregateRef = { kind: RESOURCE, id };
          const next: ResourceBody = { ...body, scope };
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: expected, body: next as unknown as JsonObject }], detail: { projectId: body.projectId, access: scope.mode }, contention: async () => raced() };
        },
      };
    });
  }

  /** Ends a binding. Refused while a responsibility manages the resource. Tasks pinned to it then fail to resolve (`checkout_changed`). A repository's handle stays in the project's list, since tasks may name it. */
  async unbindResource(by: Principal, command: NoActor & { resourceId: string; expectedRevision: number }): Promise<CommandResult> {
    return this.#runner.command("resource.unbind", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => {
      onlyKnown(command, ["commandId", "resourceId", "expectedRevision"]);
      const id = resourceIdOf(command.resourceId);
      const expected = checkRevision(command.expectedRevision);
      return {
        payload: { resourceId: id, expectedRevision: expected },
        build: async () => {
          const first = await this.#runner.get(RESOURCE, id);
          const where = (first?.body as unknown as ResourceBody | undefined)?.projectId ?? "unknown";
          const snapshot = await this.#runner.get(REGISTRY, where);
          const { found, body } = await this.#resource(by, id, "resource.write", "unbind resources");
          if (found.revision !== expected) throw new DomainError("stale_revision", `resource ${id} is at revision ${found.revision}, not ${expected}`, { currentRevision: found.revision });
          if (body.state !== "bound") invalid("resourceId", "the resource is already unbound");
          const claim = await this.#runner.get(CLAIM, id);
          if (claim !== undefined && (claim.body as unknown as ClaimBody).state === "held") invalid("resourceId", "a responsibility manages this resource; release it from the responsibility first");
          const pinned = await this.#liveTasksPinnedTo(id);
          if (pinned.length > 0) invalid("resourceId", `tasks still work against this binding (${pinned.slice(0, 5).join(", ")}${pinned.length > 5 ? `, and ${pinned.length - 5} more` : ""}); unbind it after they finish`);
          const ref: AggregateRef = { kind: RESOURCE, id };
          const changes: Change[] = [{ type: "update", ref, expectedRevision: expected, body: { ...body, state: "unbound" } as unknown as JsonObject }];
          if (claim !== undefined) changes.push({ type: "check", ref: { kind: CLAIM, id }, expectedRevision: claim.revision });
          const { [id]: _gone, ...remaining } = await this.#locsOf(body.projectId, snapshot);
          changes.push(this.#bump(body.projectId, snapshot, undefined, remaining));
          return { ref, creates: false, changes: mergeChanges(changes), detail: { projectId: body.projectId }, contention: async () => raced() };
        },
      };
    });
  }

  /**
   * Records which binding, and which version of its location, a task is dispatched against. Needs `assignment.manage` for the task (dispatching is assigning) and `resource.read`.
   * The task must name a repository of its project and that repository must be bound. Once pinned, a task keeps this checkout whatever happens to names, labels or locations.
   */
  async pinCheckout(by: Principal, command: NoActor & { taskId: string }): Promise<CommandResult> {
    return this.#runner.command("checkout.pin", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => {
      onlyKnown(command, ["commandId", "taskId"]);
      const taskId = checkTaskId(command.taskId);
      return {
        payload: { taskId },
        build: async () => {
          const { task, revision } = await this.#taskFor(by, taskId);
          const record = await this.#runner.get(CHECKOUT, taskId);
          if (record !== undefined && (record.body as unknown as CheckoutBody).released === undefined) invalid("taskId", `task ${taskId} already has a checkout; confirm a changed one with checkout.repin`);
          const resource = await this.#bindingFor(task);
          const ref: AggregateRef = { kind: CHECKOUT, id: taskId };
          const body: CheckoutBody = { taskId, projectId: task.projectId, resourceId: resource.id, repositoryId: task.repositoryId!, locatorEpoch: resource.body.locatorEpoch, pinnedBy: by.id };
          const changes: Change[] = [
            record === undefined ? { type: "create", ref, body: body as unknown as JsonObject } : { type: "update", ref, expectedRevision: record.revision, body: body as unknown as JsonObject },
            { type: "check", ref: { kind: "task", id: taskId }, expectedRevision: revision },
            { type: "check", ref: { kind: RESOURCE, id: resource.id }, expectedRevision: resource.revision },
            ...await this.#pinListChanges(taskId, resource.id),
          ];
          return { ref, creates: record === undefined, changes: mergeChanges(changes), detail: { taskId, resourceId: resource.id, locatorEpoch: body.locatorEpoch }, contention: async () => raced() };
        },
      };
    });
  }

  /** Confirms the checkout a task now resolves to (after a move, or after the task was pointed at another repository). `expectedRevision` is the pin's revision. */
  async repinCheckout(by: Principal, command: NoActor & { taskId: string; expectedRevision: number }): Promise<CommandResult> {
    return this.#runner.command("checkout.repin", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => {
      onlyKnown(command, ["commandId", "taskId", "expectedRevision"]);
      const taskId = checkTaskId(command.taskId);
      const expected = checkRevision(command.expectedRevision);
      return {
        payload: { taskId, expectedRevision: expected },
        build: async () => {
          const { task, revision } = await this.#taskFor(by, taskId);
          const existing = await this.#runner.get(CHECKOUT, taskId);
          if (existing === undefined || (existing.body as unknown as CheckoutBody).released !== undefined) invalid("taskId", `task ${taskId} has no checkout to confirm; pin one first`);
          if (existing!.revision !== expected) throw new DomainError("stale_revision", `the checkout of ${taskId} is at revision ${existing!.revision}, not ${expected}`, { currentRevision: existing!.revision });
          const resource = await this.#bindingFor(task);
          const ref: AggregateRef = { kind: CHECKOUT, id: taskId };
          const body: CheckoutBody = { taskId, projectId: task.projectId, resourceId: resource.id, repositoryId: task.repositoryId!, locatorEpoch: resource.body.locatorEpoch, pinnedBy: by.id };
          const changes: Change[] = [
            { type: "update", ref, expectedRevision: expected, body: body as unknown as JsonObject },
            { type: "check", ref: { kind: "task", id: taskId }, expectedRevision: revision },
            { type: "check", ref: { kind: RESOURCE, id: resource.id }, expectedRevision: resource.revision },
            ...await this.#pinListChanges(taskId, resource.id, (existing!.body as unknown as CheckoutBody).resourceId),
          ];
          return { ref, creates: false, changes: mergeChanges(changes), detail: { taskId, resourceId: resource.id, locatorEpoch: body.locatorEpoch }, contention: async () => raced() };
        },
      };
    });
  }

  /**
   * Gives up the pin of a task that no longer names a repository (its repository was cleared after it was dispatched): the task holds no checkout, and is pinned afresh if it names a repository again. Refused while
   * the task still names one (confirm it with `checkout.repin`). `expectedRevision` is the pin's revision.
   */
  async releaseCheckout(by: Principal, command: NoActor & { taskId: string; expectedRevision: number }): Promise<CommandResult> {
    return this.#runner.command("checkout.release", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => {
      onlyKnown(command, ["commandId", "taskId", "expectedRevision"]);
      const taskId = checkTaskId(command.taskId);
      const expected = checkRevision(command.expectedRevision);
      return {
        payload: { taskId, expectedRevision: expected },
        build: async () => {
          const found = await this.#runner.get("task", taskId);
          const task = found?.body as unknown as TaskBody | undefined;
          if (found === undefined || task === undefined || !may(by, "assignment.manage", task.projectId, { kind: "task", id: taskId }) || !may(by, "resource.read", task.projectId)) throw hidden(by, "release that checkout");
          const existing = await this.#runner.get(CHECKOUT, taskId);
          const pin = existing?.body as unknown as CheckoutBody | undefined;
          if (existing === undefined || pin === undefined || pin.released !== undefined) invalid("taskId", `task ${taskId} has no checkout to release`);
          if (existing!.revision !== expected) throw new DomainError("stale_revision", `the checkout of ${taskId} is at revision ${existing!.revision}, not ${expected}`, { currentRevision: existing!.revision });
          if (task.repositoryId !== undefined) invalid("taskId", `task ${taskId} still names repository ${task.repositoryId}; confirm the checkout with checkout.repin instead`);
          const ref: AggregateRef = { kind: CHECKOUT, id: taskId };
          const body: CheckoutBody = { ...pin!, released: { by: by.id, at: this.#runner.now() } };
          const changes: Change[] = [{ type: "update", ref, expectedRevision: expected, body: body as unknown as JsonObject }, { type: "check", ref: { kind: "task", id: taskId }, expectedRevision: found.revision }, ...await this.#pinListChanges(taskId, undefined, pin!.resourceId)];
          return { ref, creates: false, changes: mergeChanges(changes), detail: { taskId }, contention: async () => raced() };
        },
      };
    });
  }

  // ---- reads ------------------------------------------------------------------------------------------------------------------

  /** One binding, or `undefined` when it does not exist or the caller may not read the project (the two look the same). */
  async get(by: Principal, resourceId: string): Promise<View<ResourceBody> | undefined> {
    const found = await this.#runner.get(RESOURCE, resourceIdOf(resourceId));
    if (found === undefined) return undefined;
    const body = found.body as unknown as ResourceBody;
    return may(by, "resource.read", body.projectId) ? view<ResourceBody>(found) : undefined;
  }

  /** A project's bindings in ID order (`state` narrows). `undefined` for a project the caller may not read. Never truncated: more than the scan limit is `unavailable`. */
  async list(by: Principal, projectId: string, filter: { state?: "bound" | "unbound" } = {}): Promise<View<ResourceBody>[] | undefined> {
    const id = checkProjectId(projectId);
    if (!may(by, "resource.read", id) || (await this.#runner.get("project", id)) === undefined) return undefined;
    const mine = await this.#resourcesOf(id, true) as { id: string; revision: number; body: ResourceBody }[];
    mine.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    return mine.filter((a) => filter.state === undefined || a.body.state === filter.state).map((a) => view<ResourceBody>({ id: a.id, revision: a.revision, body: a.body as never } as never));
  }

  /** Whether a project may use a bound resource in this way, and why not. A use of an unbound or foreign resource is refused. Needs `resource.read`; hidden like a missing resource otherwise. */
  async authorizeUse(by: Principal, resourceId: string, use: { mode: "read" | "write"; path?: string }): Promise<{ allowed: boolean; reason?: string } | undefined> {
    const found = await this.get(by, resourceId);
    if (found === undefined) return undefined;
    if (found.state !== "bound") return { allowed: false, reason: "the resource is unbound" };
    return scopeAllows(found.scope, use) ? { allowed: true } : { allowed: false, reason: found.scope.mode === "read" && use.mode === "write" ? "the project has read access only" : "outside the paths this project may use" };
  }

  /**
   * The checkout a task works in, from records. A task not yet dispatched resolves to the binding of the repository it names now. A dispatched (pinned) task resolves only while the
   * binding is the one it was pinned to, at the location version it was pinned at; otherwise `checkout_changed`. `undefined` when the task is missing or unreadable. A task that names
   * no repository, or one the project has not bound, is `invalid_command`: there is nothing to dispatch it to.
   */
  async resolveCheckout(by: Principal, taskId: string): Promise<Checkout | undefined> {
    const id = checkTaskId(taskId);
    const found = await this.#runner.get("task", id);
    if (found === undefined) return undefined;
    const task = found.body as unknown as TaskBody;
    if (!may(by, "task.read", task.projectId, { kind: "task", id }) || !may(by, "resource.read", task.projectId)) return undefined;
    return this.#resolve(id, task);
  }

  async #resolve(id: string, task: TaskBody): Promise<Checkout> {
    const stored = (await this.#runner.get(CHECKOUT, id))?.body as unknown as CheckoutBody | undefined;
    const pin = stored?.released === undefined ? stored : undefined;
    if (task.repositoryId === undefined) {
      if (pin !== undefined) throw new DomainError("checkout_changed", `task ${id} no longer names the repository it was dispatched against`);
      return invalid("repositoryId", `task ${id} names no repository, so it has no checkout`);
    }
    const resources = await this.#resourcesOf(task.projectId, true);
    const bound = resources.find((r) => r.body.repositoryId === task.repositoryId);
    if (pin !== undefined) {
      if (bound === undefined || bound.id !== pin.resourceId || pin.repositoryId !== task.repositoryId) throw new DomainError("checkout_changed", `task ${id} was dispatched against another checkout than the one it now names; confirm the new one first`);
      if (bound.body.state !== "bound") throw new DomainError("checkout_changed", `the checkout task ${id} was dispatched against has been unbound`);
      if (bound.body.locatorEpoch !== pin.locatorEpoch) throw new DomainError("checkout_changed", `the checkout task ${id} was dispatched against has moved; confirm the new location first`);
    } else if (bound === undefined || bound.body.state !== "bound") return invalid("repositoryId", `repository ${task.repositoryId} is not bound to the project; bind it first`);
    const b = bound.body;
    return { taskId: id, projectId: task.projectId, resourceId: bound.id, repositoryId: task.repositoryId, label: b.label, locator: b.locator, scope: b.scope, pinned: pin !== undefined };
  }

  /**
   * The dispatcher's step (card P01): a task that names a repository is pinned to the binding and location version it has now, the moment its work is about to start (`pin: true`; before that the call only looks, so a waiting task holds nothing), and every later dispatch must find the
   * same checkout. It takes no caller's rights: only code that builds the services can run it (the dispatcher acts as the controller, whose service principal holds no `assignment.manage`), and it writes
   * only the pin. `none` for a task that names no repository (nothing to bind), `unbound` or `changed` with the reason when the work must not start.
   */
  async dispatchCheckout(command: { commandId: string; taskId: string; actor: string; /** Write the pin (when the work is about to start); otherwise only look. */ pin: boolean }): Promise<{ kind: "none" } | { kind: "ok"; checkout: Checkout; pinnedNow: boolean } | { kind: "unbound" | "changed"; reason: string }> {
    const taskId = checkTaskId(command.taskId);
    const found = await this.#runner.get("task", taskId);
    const task = found?.body as unknown as TaskBody | undefined;
    if (found === undefined || task === undefined) return { kind: "none" };
    const record = await this.#runner.get(CHECKOUT, taskId);
    // A pin given up (its repository was cleared) holds nothing: the task is as if it had none.
    const existing = record !== undefined && (record.body as unknown as CheckoutBody).released !== undefined ? undefined : record;
    if (task.repositoryId === undefined && existing === undefined) return { kind: "none" };
    let pinnedNow = false;
    if (existing === undefined && !command.pin) {
      try { await this.#bindingFor(task); } catch (error) { if (isDomainError(error, "invalid_command")) return { kind: "unbound", reason: error.message }; throw error; }
      return { kind: "none" };
    }
    if (existing === undefined) {
      let bound: { id: string; revision: number; body: ResourceBody };
      try { bound = await this.#bindingFor(task); } catch (error) { if (isDomainError(error, "invalid_command")) return { kind: "unbound", reason: error.message }; throw error; }
      let result: CommandResult;
      try { result = await this.#runner.command("checkout.pin", { commandId: scopedCommandId(command.actor, record === undefined ? command.commandId : `${command.commandId}:r${record.revision}`), actor: command.actor }, async () => ({
        payload: { taskId },
        build: async () => {
          const ref: AggregateRef = { kind: CHECKOUT, id: taskId };
          const body: CheckoutBody = { taskId, projectId: task.projectId, resourceId: bound.id, repositoryId: task.repositoryId!, locatorEpoch: bound.body.locatorEpoch, pinnedBy: command.actor };
          const changes: Change[] = [
            record === undefined ? { type: "create", ref, body: body as unknown as JsonObject } : { type: "update", ref, expectedRevision: record.revision, body: body as unknown as JsonObject },
            { type: "check", ref: { kind: "task", id: taskId }, expectedRevision: found.revision },
            { type: "check", ref: { kind: RESOURCE, id: bound.id }, expectedRevision: bound.revision },
            ...await this.#pinListChanges(taskId, bound.id),
          ];
          return { ref, creates: record === undefined, changes: mergeChanges(changes), detail: { taskId, resourceId: bound.id, locatorEpoch: body.locatorEpoch }, contention: async () => raced() };
        },
      })); } catch (error) {
        // Too many records to check safely: the work must not start, and the reason is told as a blocker (not a failed tick).
        if (isDomainError(error, "unavailable")) return { kind: "unbound", reason: error.message };
        throw error;
      }
      pinnedNow = !result.replayed;
    }
    try { return { kind: "ok", checkout: await this.#resolve(taskId, task), pinnedNow }; } catch (error) {
      if (isDomainError(error, "checkout_changed")) return { kind: "changed", reason: error.message };
      if (isDomainError(error, "invalid_command")) return { kind: "unbound", reason: error.message };
      throw error;
    }
  }

  /** The pin of a task, for the one who must confirm a changed checkout. Needs `assignment.read` for the task. */
  async getPin(by: Principal, taskId: string): Promise<View<CheckoutBody> | undefined> {
    const id = checkTaskId(taskId);
    const task = (await this.#runner.get("task", id))?.body as unknown as TaskBody | undefined;
    if (task === undefined || !may(by, "assignment.read", task.projectId, { kind: "task", id })) return undefined;
    const pin = await this.#runner.get(CHECKOUT, id);
    return pin === undefined ? undefined : view<CheckoutBody>(pin);
  }

  // ---- plumbing ---------------------------------------------------------------------------------------------------------------

  async #project(by: Principal, projectId: string, action: string, what: string): Promise<Aggregate> {
    const project = await this.#runner.get("project", projectId);
    if (project === undefined || !may(by, action, projectId)) throw hidden(by, what);
    return project;
  }

  async #resource(by: Principal, id: string, action: string, what: string): Promise<{ found: Aggregate; body: ResourceBody }> {
    const found = await this.#runner.get(RESOURCE, id);
    const body = found?.body as unknown as ResourceBody | undefined;
    if (found === undefined || body === undefined || !may(by, action, body.projectId)) throw hidden(by, what);
    return { found, body };
  }

  async #taskFor(by: Principal, taskId: string): Promise<{ task: TaskBody; revision: number }> {
    const found = await this.#runner.get("task", taskId);
    const task = found?.body as unknown as TaskBody | undefined;
    if (found === undefined || task === undefined || !may(by, "assignment.manage", task.projectId, { kind: "task", id: taskId }) || !may(by, "resource.read", task.projectId)) throw hidden(by, "dispatch that task");
    if (task.state === "done" || task.state === "cancelled") invalid("taskId", `task ${taskId} is ${task.state}`);
    return { task, revision: found.revision };
  }

  /** The bound binding of the repository a task names. */
  async #bindingFor(task: TaskBody): Promise<{ id: string; revision: number; body: ResourceBody }> {
    if (task.repositoryId === undefined) return invalid("repositoryId", "the task names no repository, so there is nothing to dispatch it to");
    const found = (await this.#resourcesOf(task.projectId, true)).find((r) => r.body.repositoryId === task.repositoryId);
    if (found === undefined || found.body.state !== "bound") return invalid("repositoryId", `repository ${task.repositoryId} is not bound to the project; bind it first`);
    return found;
  }

  async #resourcesOf(projectId: string): Promise<ResourceBody[]>;
  async #resourcesOf(projectId: string, withIds: true): Promise<{ id: string; revision: number; body: ResourceBody }[]>;
  async #resourcesOf(projectId: string, withIds?: true): Promise<ResourceBody[] | { id: string; revision: number; body: ResourceBody }[]> {
    const all: { id: string; revision: number; body: ResourceBody }[] = [];
    for (const id of await this.#idsOf(projectId)) {
      const found = await this.#runner.get(RESOURCE, id);
      if (found !== undefined && (found.body as unknown as ResourceBody).projectId === projectId) all.push({ id: found.id, revision: found.revision, body: found.body as unknown as ResourceBody });
    }
    return withIds === true ? all : all.map((r) => r.body);
  }

  /** Task IDs, not yet finished, whose checkout is pinned to the binding: from the binding's pin list, or (for a binding made before the list existed) by looking through the checkouts once. */
  async #liveTasksPinnedTo(resourceId: string): Promise<string[]> {
    const list = await this.#runner.get(PINS, resourceId);
    const ids = list !== undefined
      ? (list.body as unknown as { tasks: string[] }).tasks
      : (await scanAll(this.#runner, CHECKOUT, this.#scanLimit, (a) => (a.body as unknown as CheckoutBody).resourceId === resourceId && (a.body as unknown as CheckoutBody).released === undefined)).map((a) => a.id);
    const live: string[] = [];
    for (const id of ids) {
      const pin = (await this.#runner.get(CHECKOUT, id))?.body as unknown as CheckoutBody | undefined;
      if (pin === undefined || pin.resourceId !== resourceId || pin.released !== undefined) continue;
      const task = (await this.#runner.get("task", id))?.body as unknown as TaskBody | undefined;
      if (task !== undefined && task.state !== "done" && task.state !== "cancelled") live.push(id);
    }
    return live;
  }

  /**
   * The changes that keep binding pin lists right when a task's checkout is pinned to `add`, taken from `drop`, or both. A binding made before the list existed gets it on its first pin,
   * filled by one look through the checkouts (refused as `unavailable` past the scan limit, never made from part). A list holding many tasks is cleared of the finished ones first.
   */
  async #pinListChanges(taskId: string, add?: string, drop?: string): Promise<Change[]> {
    const changes: Change[] = [];
    if (drop !== undefined && drop !== add) {
      const old = await this.#runner.get(PINS, drop);
      if (old !== undefined) {
        const tasks = (old.body as unknown as { tasks: string[] }).tasks;
        if (tasks.includes(taskId)) changes.push({ type: "update", ref: { kind: PINS, id: drop }, expectedRevision: old.revision, body: { tasks: tasks.filter((t) => t !== taskId) } });
      }
    }
    if (add !== undefined) {
      const list = await this.#runner.get(PINS, add);
      let tasks: string[] = list !== undefined
        ? [...(list.body as unknown as { tasks: string[] }).tasks]
        : (await scanAll(this.#runner, CHECKOUT, this.#scanLimit, (a) => (a.body as unknown as CheckoutBody).resourceId === add && (a.body as unknown as CheckoutBody).released === undefined)).map((a) => a.id);
      if (tasks.length >= PRUNE_AT) {
        const kept: string[] = [];
        for (const id of tasks) {
          const task = (await this.#runner.get("task", id))?.body as unknown as TaskBody | undefined;
          if (id !== taskId && task !== undefined && task.state !== "done" && task.state !== "cancelled") kept.push(id);
        }
        tasks = kept;
      }
      if (!tasks.includes(taskId)) tasks.push(taskId);
      if (tasks.length > this.#scanLimit) throw new DomainError("unavailable", `binding ${add} has more than ${this.#scanLimit} pinned tasks, too many to track safely`);
      if (list === undefined) changes.push({ type: "create", ref: { kind: PINS, id: add }, body: { tasks } });
      else if (JSON.stringify(tasks) !== JSON.stringify((list.body as unknown as { tasks: string[] }).tasks)) changes.push({ type: "update", ref: { kind: PINS, id: add }, expectedRevision: list.revision, body: { tasks } });
      else changes.push({ type: "check", ref: { kind: PINS, id: add }, expectedRevision: list.revision });
    }
    return changes;
  }

  /**
   * Refuses a location that contains, or lies inside, a location bound to another project, unless acknowledged by someone who may give scopes. Equal locations are allowed (one repository, two projects).
   * It reads each project's registry (one record per project, listing its bound locations), not every binding of every project; the limit applies to the number of projects.
   */
  async #checkOverlap(by: Principal, projectId: string, locator: string, acknowledged: boolean): Promise<void> {
    const registries = await scanAll(this.#runner, REGISTRY, this.#scanLimit, (a) => a.id !== projectId);
    let clash = false;
    for (const registry of registries) {
      for (const other of Object.values(await this.#locsOf(registry.id, registry))) if (nested(other, locator)) { clash = true; break; }
      if (clash) break;
    }
    if (!clash) return;
    if (!acknowledged) invalid("locator", "this location contains, or lies inside, a location bound to another project, so access in one project could reach the other's files; bind it with acknowledgeOverlap if that is intended");
    if (!may(by, "resource.scope.write", projectId)) throw hidden(by, "bind overlapping locations");
  }

  /** The bound locations of a project by binding ID: from its registry, or (for a registry made before they were listed) from its bindings. */
  async #locsOf(projectId: string, snapshot?: Aggregate): Promise<Record<string, string>> {
    const registry = snapshot ?? await this.#runner.get(REGISTRY, projectId);
    if (registry === undefined) return {};
    const listed = (registry.body as unknown as { locs?: Record<string, string> }).locs;
    if (listed !== undefined) return { ...listed };
    const out: Record<string, string> = {};
    for (const id of await this.#idsOf(projectId, registry)) {
      const found = (await this.#runner.get(RESOURCE, id))?.body as unknown as ResourceBody | undefined;
      if (found !== undefined && found.projectId === projectId && found.state === "bound") out[id] = found.locator;
    }
    return out;
  }

  /**
   * The per-project record every change to the project's bindings updates at the revision it read first (so uniqueness checks cannot be raced). It also lists the project's binding IDs (`ids`) and their bound locations (`locs`), so a lookup reads that
   * project's bindings and not every binding of every project; `ids` given replaces the list (bind), absent keeps it.
   */
  #bump(projectId: string, registry: Aggregate | undefined, ids?: readonly string[], locs?: Record<string, string>): Change {
    const ref: AggregateRef = { kind: REGISTRY, id: projectId };
    const old = registry?.body as unknown as { n: number; ids?: readonly string[]; locs?: Record<string, string> } | undefined;
    const kept = ids ?? old?.ids;
    const keptLocs = locs ?? old?.locs;
    const body = { n: (old?.n ?? 0) + 1, ...(kept === undefined ? {} : { ids: kept }), ...(keptLocs === undefined ? {} : { locs: keptLocs }) };
    return registry === undefined ? { type: "create", ref, body } : { type: "update", ref, expectedRevision: registry.revision, body };
  }

  /** The IDs of a project's bindings: from its registry, or (for a registry made before the list existed) by looking through the bindings once. */
  async #idsOf(projectId: string, snapshot?: Aggregate): Promise<string[]> {
    const registry = snapshot ?? await this.#runner.get(REGISTRY, projectId);
    // Every bind writes the registry, so a project without one has no bindings.
    if (registry === undefined) return [];
    const listed = (registry.body as unknown as { ids?: readonly string[] }).ids;
    if (listed !== undefined) {
      if (listed.length > this.#scanLimit) throw new DomainError("unavailable", `project ${projectId} has more than ${this.#scanLimit} bindings, too many to check safely`);
      return [...listed];
    }
    return (await scanAll(this.#runner, RESOURCE, this.#scanLimit, (a) => (a.body as unknown as ResourceBody).projectId === projectId)).map((a) => a.id);
  }
}

const RESOURCE_ID = /^rsc-[a-z2-7]{20}$/;
export const resourceIdOf = (value: unknown, field = "resourceId"): string => (typeof value === "string" && RESOURCE_ID.test(value) ? value : invalid(field, "is not a resource ID"));
const raced = (): DomainError => new DomainError("stale_revision", "the project's resources changed meanwhile; read them again and retry");
