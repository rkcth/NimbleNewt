import { createHash } from "node:crypto";

/**
 * Card P02 (remote hosts): a remote worker host says which folder it uses for each project's shared repository, so the controller can ask the project's access scope (`ProjectResourceService.workspaceAdmission`) before it
 * sends that host any work that opens or writes a workspace. The folder is never sent as a path: the host announces `repo:<projectId>:sha256:<digest of the folder as written in its configuration>` in the capabilities' existing
 * `workspaces` list (named workspace bindings, at most 120 characters each). An older controller takes the entry as one more name, and an older host announces none, which the controller reads as "not admitted" for workspace work.
 * The controller compares the digest with the digests of the locations bound to the project, so the folder must be bound with exactly the text the host's operator configured.
 */
const DECLARATION = /^repo:(proj-[a-z2-7]{20}):sha256:([0-9a-f]{64})$/;
const PROJECT = /^proj-[a-z2-7]{20}$/;

/** The digest of a folder (or a bound location) as written: sha256 of its UTF-8 text, in lower-case hex. */
export function folderDigest(folder: string): string {
  return createHash("sha256").update(folder, "utf8").digest("hex");
}

/** What a host announces for the folder it uses for a project; undefined for something that is not a project ID or a folder. */
export function workspaceDeclaration(projectId: string, folder: string): string | undefined {
  if (typeof projectId !== "string" || !PROJECT.test(projectId) || typeof folder !== "string" || folder === "") return undefined;
  return `repo:${projectId}:sha256:${folderDigest(folder)}`;
}

/** The folder digests a host declared for a project, from its announced `workspaces` (other names are left alone). */
export function declaredFolders(workspaces: readonly string[] | undefined, projectId: string): string[] {
  const out: string[] = [];
  for (const w of workspaces ?? []) {
    const m = DECLARATION.exec(w);
    if (m !== null && m[1] === projectId && !out.includes(m[2]!)) out.push(m[2]!);
  }
  return out;
}

/** The controller's answer to "may this host open the task's workspace on the folder it declared?" (`ProjectResourceService.workspaceAdmissionByDigest` in the product). */
export type FolderAdmission = (call: { readonly taskId: string; readonly projectId: string; readonly folderDigest: string; /** The dispatcher's look before the checkout pin is written (see `workspaceAdmission`). */ readonly beforePin?: boolean }) => Promise<{ readonly admitted: true } | { readonly admitted: false; readonly reason: string }>;

/** The remote service's question (`RemoteDeps.workspaceAdmission`): the reasons this host may not be sent the task's workspace work, from what it announced; empty when it may. Throws when it cannot be read. */
export type HostWorkspaceAdmission = (call: { readonly hostId: string; readonly taskId: string; readonly projectId: string; readonly workspaces: readonly string[]; readonly beforePin?: boolean }) => Promise<readonly string[]>;

/**
 * The product's `HostWorkspaceAdmission` over a folder admission. A host that declares no folder for the project (an older host, or one whose configuration has no folder for it) and one that declares more than one are
 * refused without asking; otherwise the binding decides.
 */
export function hostWorkspaceAdmission(admit: FolderAdmission): HostWorkspaceAdmission {
  return async ({ hostId, taskId, projectId, workspaces, beforePin }) => {
    const digests = declaredFolders(workspaces, projectId);
    if (digests.length === 0) return [`${hostId} does not say which folder it uses for project ${projectId}, so no workspace is opened there (a host older than this controller says nothing: update it; otherwise set the project's folder in that host's configuration and bind that folder to the project with write access)`];
    if (digests.length > 1) return [`${hostId} names more than one folder for project ${projectId}, so no workspace is opened there`];
    const answer = await admit({ taskId, projectId, folderDigest: digests[0]!, ...(beforePin === true ? { beforePin: true } : {}) });
    if (answer?.admitted === true) return [];
    return [`${hostId} may not open this task's workspace: ${String((answer as { reason?: unknown } | undefined)?.reason ?? "the task's access scope does not admit that host's folder").slice(0, 400)}`];
  };
}
