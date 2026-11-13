import type { WipBackupPort, WipTaskRef } from "./wip-backup.js";

/**
 * Which tasks have work in progress, and where (card P02b, the product wiring). A task is a candidate while it can still hold unfinished work (ready, in progress or blocked) and some host has taken an attempt of it, so
 * there is a checkout somewhere; the host that last took it is the `executor` of the backup. The agent that owns it now (or, with none, the one who created it) is the `developer`. Nothing here reads a file or a secret.
 */
export interface WipTaskSourceDeps {
  readonly tasks: { listTasks(query: { projectId?: string; afterId?: string; limit: number }): Promise<{ items: readonly { id: string; state: string; createdBy: string }[]; next?: string }> };
  readonly assignment: (taskId: string) => Promise<{ readonly state: string; readonly owner?: { readonly kind: string; readonly id: string } } | undefined>;
  /** The host that last took an attempt of the task, or undefined when none did. */
  readonly placed: (taskId: string) => Promise<string | undefined>;
}

const OPEN_STATES: ReadonlySet<string> = new Set(["ready", "in_progress", "blocked"]);
const plainName = (value: string): string => value.replace(/[^A-Za-z0-9._:@-]/g, "-").slice(0, 120);

export function wipTasksSource(deps: WipTaskSourceDeps): (projectId: string) => Promise<readonly WipTaskRef[]> {
  return async (projectId) => {
    const out: WipTaskRef[] = [];
    let after: string | undefined;
    for (let page = 0; page < 20 && out.length < 100; page++) {
      const chunk = await deps.tasks.listTasks({ projectId, limit: 100, ...(after === undefined ? {} : { afterId: after }) });
      for (const task of chunk.items) {
        if (!OPEN_STATES.has(task.state)) continue;
        const executor = await deps.placed(task.id);
        if (executor === undefined) continue;
        const owner = (await deps.assignment(task.id))?.owner;
        const developer = owner === undefined ? task.createdBy : owner.id.includes(":") ? owner.id : `${owner.kind}:${owner.id}`;
        out.push({ taskId: task.id, developer: plainName(developer), executor: plainName(executor) });
        if (out.length >= 100) break;
      }
      if (chunk.next === undefined) break;
      after = chunk.next;
    }
    return out;
  };
}

/**
 * The port the sweep and the restore use in a product that has ONE worker host on this computer. The call goes to that host only when the task works there. A remote worker host cannot carry a backup or a restore over the worker
 * protocol yet (the file scan is a function and cannot cross the wire, and a host's credentials are its own), so a task on one is refused with that reason in plain words, recorded and reported to the owner like any failed backup. Nothing is pretended.
 */
export function wipBackupRouter(options: { readonly localHostId: string; readonly local: WipBackupPort; readonly placed: (taskId: string) => Promise<string | undefined> }): WipBackupPort {
  const refusal = (host: string): string => `the task works on ${host}, a remote worker host, and the worker protocol cannot carry a work-in-progress backup or restore to a remote host yet; only tasks on this computer's worker host are backed up`;
  return {
    backup: async (call) => (call.executor === options.localHostId ? options.local.backup(call) : { ok: false, reason: refusal(call.executor) }),
    restore: async (call) => {
      const host = await options.placed(call.taskId);
      if (host !== undefined && host !== options.localHostId) return { ok: false, reason: refusal(host) };
      return options.local.restore === undefined ? { ok: false, reason: "this computer's worker host does not restore backups" } : options.local.restore(call);
    },
  };
}
