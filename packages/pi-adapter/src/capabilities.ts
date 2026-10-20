/**
 * What the Pi adapter supports and what it does not, in a form dependent work can check. G02 records this list; a feature
 * whose acceptance needs an unsupported capability is blocked until the capability exists, not silently built on a gap.
 */
export interface Capability {
  readonly id: string;
  readonly description: string;
}

export interface UnsupportedCapability extends Capability {
  /** Why it is missing and what would provide it. */
  readonly why: string;
  /** Task cards whose acceptance depends on it. */
  readonly blocks: readonly string[];
}

export const SUPPORTED_CAPABILITIES: readonly Capability[] = [
  { id: "idempotent-submission", description: "Submitting the same request ID again returns the original submission and recorded result; reusing it with different content is rejected." },
  { id: "semantic-tool-output", description: "Tool output reaches the next model step through Pi's `output` contract and is reported per call with its call ID." },
  { id: "task-separation", description: "Independent tasks start with empty, separate contexts; aborting or discarding one does not touch another." },
  { id: "inquiry-branches", description: "Side conversations fork from a completed-turn boundary (including a compacted context) and leave the parent unchanged." },
  { id: "selective-update", description: "A selected update is applied to a task once per request ID, either running immediately or placed for later." },
  { id: "abort-and-retention", description: "Aborting never executes a partially streamed tool call; queued requests are withdrawn, retained and run only when explicitly readmitted." },
  { id: "restart-recovery", description: "After a process kill the storage is held; interrupted work is reviewed, abandoned or resumed in one audited step; replay-safe tools re-run, others are reported interrupted." },
  { id: "checkpoints", description: "Checkpoints of completed-turn boundaries verify history and runtime compatibility and restore as a new conversation." },
  { id: "compatibility-gate", description: "Storage written by an unknown or different runtime is refused untouched; unmarked storage is adopted only on request after a read-only scan; old checkpoint formats are upgraded without mutation and incompatible ones rejected with a reason." },
  { id: "audit-trail", description: "Abort, readmission, branch discard, checkpoint restore, task creation and recovery are reported to an audit sink." },
];

export const UNSUPPORTED_CAPABILITIES: readonly UnsupportedCapability[] = [
  {
    id: "portable-history-export",
    description: "Exporting a conversation's history and importing it into an empty store.",
    why: "A checkpoint is a reference; restoring needs the same storage or a faithful copy. Needs an artifact manifest of the history.",
    blocks: ["H02", "K01", "G08"],
  },
  {
    id: "cross-process-fencing",
    description: "Preventing two processes from opening one storage, or a hung process from racing its replacement.",
    why: "Pi's JSONL storage has no lock and the interrupted-work hold is per adapter instance. Needs worker ownership and leases.",
    blocks: ["H01", "H02", "H08", "G08", "K05"],
  },
  {
    id: "per-conversation-resume",
    description: "Resuming one interrupted conversation while keeping another stopped.",
    why: "Pi's scheduler is harness-wide; the only per-conversation choice is to abandon.",
    blocks: ["L01", "L02", "U06"],
  },
  {
    id: "wait-by-request-id",
    description: "Waiting for a result by request ID without holding the original handle or resubmitting the payload.",
    why: "Not on the controller port yet; `lookup` polls and resubmitting the same payload returns the original.",
    blocks: ["S09", "H06"],
  },
  {
    id: "cancel-single-request",
    description: "Withdrawing one queued request without aborting the whole conversation.",
    why: "`abort()` is whole-conversation; Pi has `abortSubmission` for a queued one.",
    blocks: ["L01", "U03"],
  },
  {
    id: "transcript-paging",
    description: "Reading a long history in pages.",
    why: "`transcript()` returns the full history.",
    blocks: ["U05", "U07"],
  },
  {
    id: "progress-events",
    description: "A stream of progress and status events for UIs.",
    why: "Not built; Pi exposes watches the adapter does not yet surface.",
    blocks: ["H06", "V01", "U05", "U07"],
  },
  {
    id: "forward-migration",
    description: "Continuing from storage or checkpoints written by a different Pi Durable version by migrating them.",
    why: "No migration is defined. Storage written by Pi 1.0.1, 1.2.0 and 1.3.0 has the same on-disk layout in the fixtures tested, so it is adopted, not migrated; a storage whose marker names another version is refused. A Pi release that changes the layout needs a real, atomic migration (G03 qualified the gate, not a migration).",
    blocks: ["K03"],
  },
  {
    id: "in-flight-state",
    description: "Forking or checkpointing a turn that is still in progress.",
    why: "Branches and checkpoints start at completed-turn boundaries; the in-flight turn is excluded. Needs finish-and-hold or a parallel inquiry policy.",
    blocks: ["G09", "L01"],
  },
  {
    id: "usage-accounting",
    description: "Reading what a request or conversation cost (tokens and spend) through the controller port.",
    why: "Pi records spend per conversation (`pi.usage`, `harness.usage()`), but neither `SemanticResult` nor the port exposes it.",
    blocks: ["R02", "B01", "X07"],
  },
  {
    id: "per-task-model-and-tools",
    description: "Choosing the model or the tool set per task or per request.",
    why: "Every task and branch runs on the single model and fixed tool set given to `PiAdapter.open`.",
    blocks: ["R01", "T01"],
  },
  {
    id: "workspace-checkpoints",
    description: "Capturing files and uncommitted changes with a checkpoint.",
    why: "Out of the adapter's scope; the controller pairs a checkpoint with an immutable workspace artifact manifest.",
    blocks: ["P02", "S06", "K01"],
  },
  {
    id: "history-retention",
    description: "Deleting or archiving old branches, tasks and results.",
    why: "Everything is kept for review; the single results document and discarded branches grow without bound.",
    blocks: ["K01", "X08"],
  },
];
