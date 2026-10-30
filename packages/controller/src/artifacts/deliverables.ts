import { DomainError } from "../domain/errors.js";
import { artifactId as checkArtifactId, taskId as checkTaskId, type TaskBody } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { allows, inTaskScope } from "../security/access.js";
import type { Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { ArtifactBody } from "./service.js";

/** What a reader sees of one deliverable: the artifact's record (immutable, so `revision` only counts storage writes) with names redacted. */
export interface DeliverableView {
  readonly id: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly name: string;
  readonly projectId?: string;
  readonly taskId: string;
  readonly manifestDigest: string;
  readonly totalBytes: number;
  readonly createdBy: string;
  readonly files: readonly { readonly path: string; readonly digest: string; readonly size: number }[];
}

const SCAN_PAGE = 500;
const SCAN_READS = 20;

/**
 * Read-only access to the artifacts recorded as a task's deliverables (card U13). Rights are the task's read right, as for the task itself; what the caller may not read reads as `not_found`.
 * Needs no blob store: it only reads manifests (checking the files against their bytes is `ArtifactService.verify`).
 */
export class DeliverableService {
  readonly #runner: CommandRunner;
  private constructor(runner: CommandRunner) { this.#runner = runner; }

  static withEpoch(storage: ConstructorParameters<typeof CommandRunner>[0], epoch: number, options: RunnerOptions = {}): DeliverableService {
    return new DeliverableService(new CommandRunner(storage, epoch, options));
  }

  async #mayRead(by: Principal, taskId: string): Promise<TaskBody> {
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    const hidden = (): never => { throw new DomainError("not_found", "no such task"); };
    if (task === undefined) return hidden();
    const scoped = by.taskScope === undefined || (inTaskScope(by, task.projectId) && by.taskScope.taskId === taskId);
    if (!scoped || !(by.kind === "owner" || by.kind === "host" || by.kind === "service" || allows(by, "task.read", task.projectId, { resource: { kind: "task", id: taskId } }))) return hidden();
    return task;
  }

  #show(id: string, revision: number, createdAt: string, body: ArtifactBody): DeliverableView {
    return {
      id, revision, createdAt, name: redactText(body.name), ...(body.projectId === undefined ? {} : { projectId: body.projectId }), taskId: body.taskId!, manifestDigest: body.manifestDigest, totalBytes: body.totalBytes, createdBy: body.createdBy,
      files: body.entries.map((e) => ({ path: redactText(e.path), digest: e.digest, size: e.size })),
    };
  }

  /** The artifacts recorded for a task, in ID order, from `afterId`; `next` is the cursor to continue from (absent at the end). */
  async list(by: Principal, taskIdValue: string, page: { afterId?: string; limit: number }): Promise<{ items: DeliverableView[]; next?: string; scanLimited?: boolean }> {
    const taskId = checkTaskId(taskIdValue);
    await this.#mayRead(by, taskId);
    const items: DeliverableView[] = [];
    let after = page.afterId === undefined ? undefined : checkArtifactId(page.afterId);
    for (let reads = 0; reads < SCAN_READS; reads++) {
      const chunk = await this.#runner.list("artifact", { ...(after === undefined ? {} : { afterId: after }), limit: SCAN_PAGE });
      for (const a of chunk) {
        after = a.id;
        const body = a.body as unknown as ArtifactBody;
        if (body.taskId !== taskId) continue;
        items.push(this.#show(a.id, a.revision, a.createdAt, body));
        // A full page ends here; a next cursor is given only if more may follow.
        if (items.length >= page.limit) return { items, next: a.id };
      }
      if (chunk.length < SCAN_PAGE) return { items };
    }
    return { items, ...(after === undefined ? {} : { next: after }), scanLimited: true };
  }

  /** One deliverable by artifact ID. An artifact that belongs to no task, or to a task the caller may not read, reads as missing. */
  async get(by: Principal, id: string): Promise<DeliverableView | undefined> {
    const found = await this.#runner.get("artifact", checkArtifactId(id));
    const body = found?.body as unknown as ArtifactBody | undefined;
    if (found === undefined || body === undefined || body.taskId === undefined) return undefined;
    await this.#mayRead(by, body.taskId);
    return this.#show(found.id, found.revision, found.createdAt, body);
  }
}
