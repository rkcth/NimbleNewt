import { DomainError } from "../domain/errors.js";
import { commandId as checkCommandId, onlyKnown, taskId as checkTaskId, text, type TaskBody } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { allows, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { Principal } from "../security/principals.js";
import type { ControllerStorage } from "../storage/types.js";
import type { ArtifactService } from "./service.js";

export interface PublishForTask {
  readonly commandId: string;
  readonly taskId: string;
  readonly name: string;
  /** Text files (UTF-8). A non-code task's output: a research note, a document, a design description. */
  readonly files: readonly { readonly path: string; readonly text: string }[];
}

/**
 * How the output of a task that is not code becomes an artifact (card P03). The agent that does the task (or the owner) publishes its files for THAT task; the artifact records the task,
 * the project and the digests, so a deliverable (card Q01) can name it, and any later change of the bytes is found by the check at submit and accept. Needs `artifact.publish` in the
 * task's project and the right to read the task; a task credential reaches its own task only. Repeating the command ID publishes once.
 */
export class TaskArtifactPublisher {
  readonly #runner: CommandRunner;
  readonly #artifacts: Pick<ArtifactService, "publish">;
  private constructor(runner: CommandRunner, artifacts: Pick<ArtifactService, "publish">) { this.#runner = runner; this.#artifacts = artifacts; }

  static withEpoch(storage: ControllerStorage, epoch: number, artifacts: Pick<ArtifactService, "publish">, options: RunnerOptions = {}): TaskArtifactPublisher {
    return new TaskArtifactPublisher(new CommandRunner(storage, epoch, options), artifacts);
  }

  async publish(by: Principal, command: PublishForTask): Promise<{ id: string; revision: number; replayed: boolean }> {
    onlyKnown(command, ["commandId", "taskId", "name", "files"]);
    const commandId = checkCommandId(command.commandId);
    const taskId = checkTaskId(command.taskId);
    const name = text(command.name, "name", { min: 1, max: 120 });
    if (!Array.isArray(command.files) || command.files.length === 0) throw new DomainError("invalid_command", "files: must be a list of at least one file", { field: "files" });
    const files = command.files.map((f, i) => {
      if (f === null || typeof f !== "object" || Array.isArray(f)) throw new DomainError("invalid_command", `files[${i}]: must be an object { path, text }`, { field: `files[${i}]` });
      onlyKnown(f, ["path", "text"]);
      if (typeof f.path !== "string" || typeof f.text !== "string") throw new DomainError("invalid_command", `files[${i}]: path and text must be strings`, { field: `files[${i}]` });
      return { path: f.path, content: Buffer.from(f.text, "utf8") };
    });
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    const hidden = (): never => { throw new DomainError("not_found", "no such task"); };
    if (task === undefined) return hidden();
    if (by.kind !== "owner" && by.kind !== "agent") throw new DomainError("forbidden", `${by.id} may not publish an artifact`);
    if (by.kind === "agent") {
      if ((by.taskScope !== undefined && (!inTaskScope(by, task.projectId) || by.taskScope.taskId !== taskId)) || !allows(by, "task.read", task.projectId, { resource: { kind: "task", id: taskId } })) return hidden();
      if (!allows(by, "artifact.publish", task.projectId, { resource: { kind: "task", id: taskId } })) throw new DomainError("forbidden", `${by.id} may not publish artifacts for this task`);
    }
    if (task.state === "cancelled") throw new DomainError("invalid_command", "the task is cancelled");
    const made = await this.#artifacts.publish({ commandId: scopedCommandId(by.id, commandId), actor: by.id, name, projectId: task.projectId, taskId, files });
    return { id: made.id, revision: made.revision, replayed: made.replayed };
  }
}
