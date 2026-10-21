/**
 * What an agent harness (the runtime that holds a conversation, such as Pi Durable) can do about restarts and moves, stated once so that the controller can refuse work a harness could not
 * recover instead of finding out after a crash (card F08). A declaration is data: the adapter for a harness ships one (the type is the same structure as `HarnessDeclaration` in the contracts package, which the
 * controller does not import), taken from what its acceptance record proves, and `declarationProblems` is the check that every declaration must pass.
 */

/** What a task needs from its harness to be recovered. `none`: the work may be lost and redone. `native-continuation`: the harness continues the conversation itself from its own storage after a restart. `portable-reconstruction`: the conversation can be rebuilt on another machine from exported records. */
export type RecoveryRequirement = "none" | "native-continuation" | "portable-reconstruction";
export const RECOVERY_REQUIREMENTS: readonly RecoveryRequirement[] = ["none", "native-continuation", "portable-reconstruction"];

/** How much of a conversation can be stopped: nothing, the whole conversation, or one request. */
export type AbortSemantics = "none" | "conversation" | "request";

export interface HarnessDeclaration {
  /** The harness's name, such as `pi`. */
  readonly harness: string;
  readonly nativeContinuation: boolean;
  readonly portableReconstruction: boolean;
  /** History and state can be exported and imported into an empty store. A harness that reconstructs portably must have it. */
  readonly checkpointExport: boolean;
  readonly abort: AbortSemantics;
}

const NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** What is wrong with a declaration (empty when it is sound). Every harness's declaration must pass this, which is the shared contract the second harness is held to as well. */
export function declarationProblems(d: HarnessDeclaration): string[] {
  const problems: string[] = [];
  if (typeof d.harness !== "string" || !NAME.test(d.harness)) problems.push("the harness name must be lower-case letters, digits and hyphens, starting with a letter");
  for (const key of ["nativeContinuation", "portableReconstruction", "checkpointExport"] as const) if (typeof d[key] !== "boolean") problems.push(`${key} must be true or false`);
  if (d.abort !== "none" && d.abort !== "conversation" && d.abort !== "request") problems.push("abort must be none, conversation or request");
  if (d.portableReconstruction === true && d.checkpointExport !== true) problems.push("portable reconstruction needs checkpoint export");
  return problems;
}

/** Whether durable tasks may use the harness at all: it must be able to continue a conversation itself or to have it rebuilt. A harness with neither is unsupported for durable tasks. */
export function durableSupport(d: HarnessDeclaration): { readonly supported: boolean; readonly reason?: string } {
  return d.nativeContinuation || d.portableReconstruction
    ? { supported: true }
    : { supported: false, reason: `harness ${d.harness} can neither continue a conversation from its own storage nor rebuild one from exported records, so it is unsupported for durable tasks` };
}

/** Why the harness cannot meet the requirement, or undefined when it can. */
export function recoveryGap(requirement: RecoveryRequirement, d: HarnessDeclaration): string | undefined {
  if (requirement === "none") return undefined;
  const support = durableSupport(d);
  if (!support.supported) return support.reason;
  if (requirement === "native-continuation" && !d.nativeContinuation) return `harness ${d.harness} cannot continue a conversation from its own storage after a restart, which this task requires`;
  if (requirement === "portable-reconstruction" && !d.portableReconstruction) return `harness ${d.harness} cannot rebuild a conversation from exported records (no portable history export), which this task requires`;
  return undefined;
}
