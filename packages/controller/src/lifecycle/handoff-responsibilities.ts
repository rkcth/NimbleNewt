import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { Owner } from "../domain/assignment-model.js";
import type { ResponsibilityService } from "../projects/responsibilities.js";
import { allows } from "../security/access.js";
import type { Principal } from "../security/principals.js";
import type { ResponsibilityHandover } from "./handoff.js";

const refuse = (message: string): never => { throw new DomainError("invalid_command", message, { field: "reassignResponsibilities" }); };
const short = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 16);

/**
 * Moves the sender's responsibilities to the recipient with the task (card L03i). Every read and write is made as the one who asked, so the rights are theirs (read and assign in the task's project,
 * checked by the responsibility service itself); the claims on managed resources stay with the responsibility and so move with it. An entry that is not the sender's, is retired, is in another project
 * or cannot be written is refused by `check` before anything moves, and reported per entry by `apply` if it changed since.
 */
export function responsibilityHandover(deps: {
  responsibilities: Pick<ResponsibilityService, "get" | "update">;
  /** The project a task belongs to, or undefined. */
  projectOf(taskId: string): Promise<string | undefined>;
  /** Whether the recipient is an active agent (the responsibility service refuses any other new answerable agent). Without it this is left to the update. */
  activeAgent?(to: Owner): Promise<boolean>;
  /** The rights the recipient needs for a duty in the project that it lacks (owner decision 2026-10-30: a reassignment is made at once and warns, naming what is missing). */
  missingRights?(agentPrincipalId: string, projectId: string): Promise<readonly string[]>;
  /** Raises the warning for a moved duty whose new holder lacks rights. A failure propagates: the warning must be recorded, so the step is repeated (its command ID is stable). */
  warn?(warning: { handoffId: string; responsibilityId: string; title: string; projectId: string; agent: string; missing: readonly string[] }): Promise<void>;
}): ResponsibilityHandover {
  const mine = (from: Owner): string => `agent:${from.id}`;
  return {
    async check(by, { taskId, ids, from, to }) {
      const projectId = await deps.projectOf(taskId);
      if (projectId === undefined) return refuse("the task has no project, so there are no responsibilities to move");
      // The update the move is made by needs both rights; refused here so nothing moves and the caller is told before completing.
      for (const right of ["responsibility.assign", "responsibility.write"]) if (!allows(by as never, right, projectId)) return refuse(`you may not assign responsibilities in this project (${right} is missing)`);
      if (to.kind !== "agent") return refuse("responsibilities can only be moved to an agent");
      if (deps.activeAgent !== undefined && !(await deps.activeAgent(to))) return refuse("the recipient is not an active agent, so it cannot answer for responsibilities");
      for (const id of ids) {
        const r = await deps.responsibilities.get(by, id);
        if (r === undefined) refuse(`${id}: no such responsibility, or you may not read it`);
        else if (r.projectId !== projectId) refuse(`${id}: belongs to another project than the task`);
        else if (r.state === "retired") refuse(`${id}: is retired`);
        else if (r.ownerId !== mine(from)) refuse(`${id}: is not answered for by the sender`);
      }
    },
    async apply(by, { handoffId, ids, from, to }) {
      const moved: string[] = []; const failed: { id: string; reason: string }[] = [];
      const warnings: { responsibilityId: string; title: string; projectId: string }[] = [];
      if (by === undefined) return { moved, failed: ids.map((id) => ({ id, reason: "the one who asked is gone or no longer active, so nothing was moved" })) };
      for (const id of ids) {
        try {
          let done = false;
          for (let attempt = 0; attempt < 3 && !done; attempt++) {
            const r = await deps.responsibilities.get(by, id);
            if (r === undefined) { failed.push({ id, reason: "no longer readable by the one who asked" }); done = true; break; }
            if (r.ownerId === `agent:${to.id}`) { moved.push(id); warnings.push({ responsibilityId: id, title: r.title, projectId: r.projectId }); done = true; break; }
            // Not the sender's any more: moved on already (a repeat after someone else changed it) or changed by someone since; either way it is not ours to move.
            if (r.ownerId !== mine(from)) { failed.push({ id, reason: "its answerable agent is no longer the sender (it was already moved or changed since the hand-off was completed)" }); done = true; break; }
            if (r.state === "retired") { failed.push({ id, reason: "retired meanwhile" }); done = true; break; }
            try {
              await deps.responsibilities.update(by, { commandId: `hr-${short(`${handoffId}\0${id}\0${r.revision}`)}`, responsibilityId: id, expectedRevision: r.revision, ownerId: `agent:${to.id}` } as never);
              moved.push(id); warnings.push({ responsibilityId: id, title: r.title, projectId: r.projectId }); done = true;
            } catch (error) {
              if (!(error instanceof DomainError) || error.code !== "stale_revision") throw error;
            }
          }
          if (!done) failed.push({ id, reason: "changed repeatedly while it was being moved" });
        } catch (error) {
          // A refusal of the update is a permanent answer for that entry; anything else (storage busy, I/O) is not an answer at all and is thrown so the whole step is repeated.
          if (!(error instanceof DomainError)) throw error;
          failed.push({ id, reason: error.message.slice(0, 200) });
        }
      }
      // The warning for a new holder that lacks rights is raised for every entry that is moved (also on a repeat: its command ID is stable, so nothing is recorded twice).
      if (deps.missingRights !== undefined && deps.warn !== undefined) {
        for (const w of warnings) {
          const missing = await deps.missingRights(`agent:${to.id}`, w.projectId);
          if (missing.length > 0) await deps.warn({ handoffId, ...w, agent: `agent:${to.id}`, missing });
        }
      }
      return { moved, failed };
    },
  };
}

/** The sentence for the task's activity record about the responsibilities moved with a hand-off: what moved, and which stayed with the sender and why. */
export function describeReassigned(r: { readonly moved: readonly string[]; readonly failed: readonly { readonly id: string; readonly reason: string }[] } | undefined): string {
  if (r === undefined) return "";
  const stayed = r.failed.length === 0 ? "" : ` ${r.failed.length} stayed with the sender: ${r.failed.map((f) => `${f.id} (${f.reason})`).join("; ")}.`;
  return ` Responsibilities moved with it: ${r.moved.length}.${stayed}`.slice(0, 900);
}

