/**
 * What an agent harness (the runtime that holds a conversation, such as Pi Durable) can do about restarts and moves, stated once so that the controller can refuse work a harness could not
 * recover instead of finding out after a crash (card F08). A declaration is data: the adapter for a harness ships one, taken from what its acceptance record proves. The controller checks declarations
 * with its own copy of this structure (it does not import the contracts); a test in the integration package runs the controller's checks on the Pi adapter's declaration.
 */

/** What a task needs from its harness to be recovered. `none`: the work may be lost and redone. `native-continuation`: the harness continues the conversation itself from its own storage after a restart. `portable-reconstruction`: the conversation can be rebuilt on another machine from exported records. */
export type RecoveryRequirement = "none" | "native-continuation" | "portable-reconstruction";

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

