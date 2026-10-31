import { fold } from "./names.js";

/**
 * Paths whose change takes effect outside the code review of an ordinary file (card H12q review): Git's attribute and submodule files, hook directories, and the CI configuration that runs with the repository's
 * credentials. A landing never writes them by itself: they are kept for the owner's review. The list is a setting of the project (`workspace.landing.protectedPaths`, set through chat); this is its default.
 *
 * A pattern ending in `/` names a directory at the root of the repository (everything under it); any other pattern with a `/` names that path at the root; a pattern without a `/` names a file in any directory. Names are
 * compared the way a case-insensitive filesystem would see them (`fold`).
 */
export const DEFAULT_PROTECTED_PATHS: readonly string[] = [
  ".gitattributes", ".gitmodules", ".husky/", ".githooks/", ".github/workflows/", ".github/actions/", ".gitlab-ci.yml", ".circleci/", "azure-pipelines.yml", "Jenkinsfile", ".pre-commit-config.yaml", ".travis.yml", "bitbucket-pipelines.yml",
];

export function isProtectedPath(path: string, patterns: readonly string[] = DEFAULT_PROTECTED_PATHS): boolean {
  const parts = path.split("/").map(fold);
  for (const raw of patterns) {
    const pattern = raw.split("/").filter(Boolean).map(fold);
    if (pattern.length === 0) continue;
    if (raw.endsWith("/")) { if (pattern.every((p, i) => parts[i] === p) && parts.length > pattern.length) return true; continue; }
    if (pattern.length === 1) { if (parts[parts.length - 1] === pattern[0]) return true; continue; }
    if (pattern.length === parts.length && pattern.every((p, i) => parts[i] === p)) return true;
  }
  return false;
}
