import { DomainError } from "../domain/errors.js";
import type { Principal } from "../security/principals.js";
import type { ControllerStorage } from "../storage/types.js";

/** `done`: set up. `default`: not chosen, the installation's default applies and works. `missing`: nothing yet. `optional`: not needed to start; shown so the owner knows it exists. */
export type ReadinessState = "done" | "default" | "missing" | "optional";

export interface ReadinessItem {
  readonly id: "owner" | "profile" | "project" | "model-route" | "host" | "notifications" | "agent" | "task";
  readonly label: string;
  readonly state: ReadinessState;
  /** Whether a first agent cannot work without it. */
  readonly required: boolean;
  /** What was found, in plain words. */
  readonly detail: string;
  /** The operation or step that sets it up. */
  readonly how: string;
}

export interface Readiness {
  /** True when every required item is `done`. */
  readonly ready: boolean;
  readonly items: readonly ReadinessItem[];
  /** The first required item that is missing, in the order a person sets them up; absent when ready. */
  readonly next?: ReadinessItem["id"];
}

const PAGE = 200;
const MAX_PAGES = 5;

/**
 * What is set up and what is missing before a first agent can work (card U14): a read-only look at the records, owner only. It changes nothing and reads no secret; a count is
 * the most it reports about a project or an agent. A thing the owner chose not to set (the approval profile, the notification channel) shows as `default`, not as a gap.
 */
export class SetupReadinessService {
  readonly #storage: ControllerStorage;
  private constructor(storage: ControllerStorage) { this.#storage = storage; }

  static withEpoch(storage: ControllerStorage, _epoch: number): SetupReadinessService { return new SetupReadinessService(storage); }

  async #each(kind: string, visit: (id: string, body: Record<string, unknown>) => void): Promise<boolean> {
    let afterId: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await this.#storage.listAggregates(kind, { ...(afterId === undefined ? {} : { afterId }), limit: PAGE });
      for (const a of page) { afterId = a.id; visit(a.id, a.body as unknown as Record<string, unknown>); }
      if (page.length < PAGE) return true;
    }
    return false; // more than the pages read; counts are then "at least"
  }

  async check(owner: Principal): Promise<Readiness> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not read the setup readiness`);
    const s = this.#storage;
    const items: ReadinessItem[] = [];
    const plural = (n: number, one: string, more: string, capped: boolean): string => `${capped ? "at least " : ""}${n} ${n === 1 ? one : more}`;

    const installation = await s.getAggregate({ kind: "installation", id: "installation" });
    items.push({ id: "owner", label: "Owner identity and credential", required: true, state: installation === undefined ? "missing" : "done", detail: installation === undefined ? "this installation has no owner yet" : `owner principal ${String((installation.body as { ownerId?: unknown }).ownerId ?? "")}`, how: "PrincipalService.bootstrapOwner (once), then keep the token it returns" });

    const policy = await s.getAggregate({ kind: "approval-policy", id: "installation" });
    const chosen = (policy?.body as { profile?: unknown } | undefined)?.profile;
    items.push({ id: "profile", label: "Approval profile", required: false, state: typeof chosen === "string" ? "done" : "default", detail: typeof chosen === "string" ? `${chosen}` : "strict (the default for a new installation; nothing has been chosen)", how: "ask in chat to switch to derived or autonomous (strict, derived or autonomous)" });

    let projects = 0; let withRepository = 0;
    const completeP = await this.#each("project", (_id, body) => { if (body["state"] === "archived") return; projects++; if (Array.isArray(body["repositories"]) && body["repositories"].length > 0) withRepository++; });
    items.push({ id: "project", label: "A project", required: true, state: projects > 0 ? "done" : "missing", detail: projects === 0 ? "no project yet" : `${plural(projects, "active project", "active projects", !completeP)}, ${withRepository} with a repository bound`, how: "project.create, then resource.bind for its repository" });

    const table = (await s.getAggregate({ kind: "routing-table", id: "routing" }))?.body as { providers?: Record<string, { enabled?: boolean }>; routes?: Record<string, unknown> } | undefined;
    const enabled = Object.entries(table?.providers ?? {}).filter(([, p]) => p.enabled === true).map(([name]) => name);
    const routes = Object.keys(table?.routes ?? {}).filter((r) => enabled.includes(r.split("/")[0]!));
    items.push({ id: "model-route", label: "A model provider and route", required: true, state: routes.length > 0 ? "done" : "missing", detail: table === undefined ? "no routing table" : routes.length > 0 ? `${enabled.length} enabled provider(s), ${routes.length} usable route(s)` : "the routing table has no route on an enabled provider", how: "ConfigurationService.bindRouting from a configuration document (not yet an API operation or chat step)" });

    let hosts = 0; let announced = 0;
    const completeH = await this.#each("principal", (_id, body) => { if (body["kind"] === "host" && body["state"] === "active") hosts++; });
    await this.#each("host-record", () => { announced++; });
    items.push({ id: "host", label: "A host to run agents on", required: true, state: hosts > 0 && announced > 0 ? "done" : "missing", detail: hosts === 0 ? "no host enrolled" : announced === 0 ? `${plural(hosts, "host", "hosts", !completeH)} enrolled, none has announced itself` : `${plural(hosts, "host", "hosts", !completeH)} enrolled, ${announced} announced`, how: "PrincipalService.enroll kind host, then the worker announces itself; the local host is built in code (dispatch.local)" });

    const notices = (await s.getAggregate({ kind: "notification-settings", id: "installation" }))?.body as { channel?: unknown; channelName?: unknown } | undefined;
    items.push({ id: "notifications", label: "How you are notified", required: false, state: notices === undefined ? "default" : "done", detail: notices === undefined ? "the inbox (nothing leaves the installation)" : notices.channel === "external" ? `external channel ${String(notices.channelName ?? "")}` : "the inbox", how: "notifications.configure" });

    let agents = 0;
    const completeA = await this.#each("agent", (_id, body) => { if (body["state"] === "active") agents++; });
    items.push({ id: "agent", label: "A first agent", required: true, state: agents > 0 ? "done" : "missing", detail: agents === 0 ? "no active agent" : plural(agents, "active agent", "active agents", !completeA), how: "agent.create, then a credential and rights for it (PrincipalService.issueCredential, grant.create)" });

    let tasks = 0;
    const completeT = await this.#each("task", () => { tasks++; });
    items.push({ id: "task", label: "A first task", required: false, state: tasks > 0 ? "done" : "optional", detail: tasks === 0 ? "no task yet" : plural(tasks, "task", "tasks", !completeT), how: "task.create, task.transition, task.assign" });

    const next = items.find((i) => i.required && i.state !== "done")?.id;
    return { ready: next === undefined, items, ...(next === undefined ? {} : { next }) };
  }
}
