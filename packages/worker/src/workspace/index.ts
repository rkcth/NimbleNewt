export { WorkspaceError, type WorkspaceErrorCode } from "./errors.js";
export { LIMITS as NAME_LIMITS, collisionKey, collisions, fold, isGitName, nameProblem, splitRelative, touchesGit } from "./names.js";
export { NOFOLLOW, resolveSafe, sameFile, type SafePath } from "./paths.js";
export { GIT_LIMITS, GitBridge, filesDigest } from "./git.js";
export { ABSENT, BRIDGE_LIMITS, WorkspaceBridge, versionOf, type PendingChange, type WriteResult } from "./bridge.js";
