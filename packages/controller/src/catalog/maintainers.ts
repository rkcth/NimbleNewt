import type { AgentService } from "../agents/index.js";
import { DomainError } from "../domain/errors.js";
import { allows } from "../security/access.js";
import type { Principal } from "../security/principals.js";
import type { PrincipalService } from "../security/principals.js";
import { maintainsAnywhere, mayManage, toolboxName, TOOLBOX_MANAGE, type CatalogService } from "./catalog.js";
import type { ToolboxProposalService } from "./proposals.js";

/**
 * Who may decide the shared toolbox's proposals (card T08, eighth slice), for the owner. A maintainer is an active agent that holds `toolbox.manage` NOW: the rights are read as the controller itself judges them (the agent's
 * own record and the rights given by grant, restrictions, expiry and archived projects included), never copied from a second list. For each one: whether the right covers every project or only some, and how many
 * proposals wait for a decision it may make (open or with changes requested; its own are not counted, an author never decides its own). With a tool named, only the maintainers whose right covers that tool.
 * Read only: nothing is created or changed. An agent never reads this (it is the owner's view); another project's agent and a stranger get `not_found` from the proposals themselves.
 */
export const MAINTAINER_LIMITS = { page: 10, scan: 1000, waiting: 100 } as const;
export interface MaintainerRow {
  /** The agent's principal ID (`agent:<ID>`). */
  readonly agent: string;
  readonly everyProject: boolean;
  /** Projects the right names (empty when it covers every project). */
  readonly projects: readonly string[];
  /** Proposals waiting for a decision it may make; absent when they could not be counted. */
  readonly waiting?: number;
  /** More than `waiting` exist (the count stopped at the limit). */
  readonly waitingMore?: true;
}
export interface MaintainersAnswer {
  /** The tool asked about (`toolbox.<name>`), when one was named. */
  readonly tool?: string;
  readonly items: readonly MaintainerRow[];
  /** The number of maintainers skipped (the request's `after`). */
  readonly after: number;
  readonly more: boolean;
  /** The look stopped at the scan limit before it had seen every agent. */
  readonly scanLimited: boolean;
}
export interface MaintainerPorts {
  readonly agents: Pick<AgentService, "list">;
  readonly principals: Pick<PrincipalService, "current">;
  readonly catalog: Pick<CatalogService, "toolbox">;
  readonly proposals: Pick<ToolboxProposalService, "list">;
}

const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

export async function toolboxMaintainers(by: Principal, ports: MaintainerPorts, query: { name?: unknown; after?: unknown } = {}): Promise<MaintainersAnswer> {
  if (by.kind !== "owner" || by.taskScope !== undefined) throw new DomainError("forbidden", "only the owner reads who maintains the toolbox");
  if (query.after !== undefined && (typeof query.after !== "number" || !Number.isSafeInteger(query.after) || query.after < 0 || query.after > 1_000_000)) invalid("after", "must be a whole number from 0 (how many maintainers were already shown)");
  const after = (query.after as number | undefined) ?? 0;
  let tool: { name: string; audience: Parameters<typeof mayManage>[1] } | undefined;
  if (query.name !== undefined) {
    const name = toolboxName(query.name);
    const found = (await ports.catalog.toolbox(by)).items.find((t) => t.name === name);
    if (found === undefined) throw new DomainError("not_found", `no shared tool ${name}`);
    tool = { name, audience: found.audience };
  }
  const items: MaintainerRow[] = [];
  let matched = 0, scanned = 0, more = false, scanLimited = false;
  scanning: for (let afterId: string | undefined; ;) {
    const page = await ports.agents.list(by, { state: "active", ...(afterId === undefined ? {} : { afterId }), limit: 200 });
    for (const agent of page.items) {
      scanned += 1;
      const p = await ports.principals.current(agent.principalId);
      if (p !== undefined && p.kind === "agent" && maintainsAnywhere(p) && (tool === undefined || mayManage(p, tool.audience))) {
        matched += 1;
        if (matched > after) {
          if (items.length === MAINTAINER_LIMITS.page) { more = true; break scanning; }
          items.push(await row(p, ports, tool?.name));
        }
      }
      if (scanned >= MAINTAINER_LIMITS.scan && page.next !== undefined) { scanLimited = true; break scanning; }
    }
    if (page.next === undefined) break;
    afterId = page.next;
  }
  return { ...(tool === undefined ? {} : { tool: tool.name }), items, after, more, scanLimited };
}

async function row(p: Principal, ports: MaintainerPorts, name: string | undefined): Promise<MaintainerRow> {
  const everyProject = allows(p, TOOLBOX_MANAGE, undefined);
  const projects = everyProject ? [] : [...new Set(p.grants.filter((g) => g.project !== "*" && allows(p, TOOLBOX_MANAGE, g.project)).map((g) => g.project))].sort();
  try {
    // Read as the maintainer: the proposals it may decide (and its own, which are not counted). One page; a longer wait is "or more".
    const found = await ports.proposals.list(p, { ...(name === undefined ? {} : { name }), limit: MAINTAINER_LIMITS.waiting });
    const waiting = found.items.filter((x) => x.author !== p.id).length;
    return { agent: p.id, everyProject, projects, waiting, ...(found.next !== undefined || found.partial === true ? { waitingMore: true as const } : {}) };
  } catch { return { agent: p.id, everyProject, projects }; }
}
