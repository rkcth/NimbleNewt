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
}): ResponsibilityHandover {
  const mine = (from: Owner): string => `agent:${from.id}`;
  return {
    async check(by, { taskId, ids, from, to }) {
      const projectId = await deps.projectOf(taskId);
      if (projectId === undefined) return refuse("the task has no project, so there are no responsibilities to move");
      if (!allows(by as never, "responsibility.assign", projectId)) return refuse("you may not assign responsibilities in this project");
      if (to.kind !== "agent") return refuse("responsibilities can only be moved to an agent");
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
      if (by === undefined) return { moved, failed: ids.map((id) => ({ id, reason: "the one who asked is gone or no longer active, so nothing was moved" })) };
      for (const id of ids) {
        try {
          let done = false;
          for (let attempt = 0; attempt < 3 && !done; attempt++) {
            const r = await deps.responsibilities.get(by, id);
            if (r === undefined) { failed.push({ id, reason: "no longer readable by the one who asked" }); done = true; break; }
            if (r.ownerId === `agent:${to.id}`) { moved.push(id); done = true; break; }
            if (r.ownerId !== mine(from)) { failed.push({ id, reason: "no longer answered for by the sender" }); done = true; break; }
            if (r.state === "retired") { failed.push({ id, reason: "retired meanwhile" }); done = true; break; }
            try {
              await deps.responsibilities.update(by, { commandId: `hr-${short(`${handoffId}\0${id}\0${r.revision}`)}`, responsibilityId: id, expectedRevision: r.revision, ownerId: `agent:${to.id}` } as never);
              moved.push(id); done = true;
            } catch (error) {
              if (!(error instanceof DomainError) || error.code !== "stale_revision") throw error;
            }
          }
          if (!done) failed.push({ id, reason: "changed repeatedly while it was being moved" });
        } catch (error) {
          failed.push({ id, reason: error instanceof DomainError ? error.message.slice(0, 200) : "could not be moved" });
        }
      }
      return { moved, failed };
    },
  };
}
