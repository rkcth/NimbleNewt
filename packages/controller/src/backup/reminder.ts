import type { NotificationService } from "../notifications/index.js";

const REF_DUE = { kind: "backup-proof", id: "due" } as const;
const REF_OVERDUE = { kind: "backup-proof", id: "overdue" } as const;
const DAY = 86_400_000;

export interface ProofReminderSource {
  /** Whether a proof of a passcode or the recovery file is due (every three months; K01b). */
  due(): boolean;
  /** When the clock for the next proof started: the last good proof, or the key's creation. */
  since(): string | undefined;
  readonly everyDays: number;
}

export interface ProofReminderOptions {
  readonly notifications: Pick<NotificationService, "emitFromController" | "settleFromController" | "openRefIds">;
  readonly source: ProofReminderSource;
  readonly now?: () => Date;
  /** Days past the due date before the reminder becomes Urgent (default 14). */
  readonly escalateAfterDays?: number;
  /** Least time between two looks (default 5 minutes): the check is cheap but the dispatcher ticks often. */
  readonly everyMs?: number;
}

/**
 * The quarterly proof as a notification (card K01b3). When a proof is due the owner gets a "Needs you" item that says what to do (put the passcode or recovery file where the host expects it and run the proof; it
 * names no file and holds no secret). If it stays due for `escalateAfterDays` more days it becomes Urgent (an interrupting item, once). A successful proof closes both. Restarts do not reset the clock: it counts from
 * the recorded proof, and an item that is already open is not reported again.
 */
export class BackupProofReminder {
  readonly #o: ProofReminderOptions;
  #next = 0;
  #seq = 0;
  constructor(options: ProofReminderOptions) { this.#o = options; }
  #now(): Date { return (this.#o.now ?? (() => new Date()))(); }

  async sweep(options: { readonly throttled?: boolean } = {}): Promise<{ raised: string[]; cleared: string[] }> {
    const raised: string[] = []; const cleared: string[] = [];
    const now = this.#now();
    // A clock set back would otherwise hold the next look off for as long as it went back.
    if (options.throttled === true && now.getTime() < this.#next && this.#next - now.getTime() <= (this.#o.everyMs ?? 300_000)) return { raised, cleared };
    this.#next = now.getTime() + (this.#o.everyMs ?? 300_000);
    const n = this.#o.notifications;
    const open = await n.openRefIds(REF_DUE.kind);
    if (!this.#o.source.due()) {
      for (const ref of [REF_DUE, REF_OVERDUE]) if (open.includes(ref.id)) { await n.settleFromController({ commandId: `proof-ok:${now.toISOString()}:${this.#seq++}:${ref.id}`, kind: "maintenance", ref }); cleared.push(ref.id); }
      return { raised, cleared };
    }
    const since = Date.parse(this.#o.source.since() ?? "");
    const dueFor = Number.isFinite(since) ? Math.max(0, Math.floor((now.getTime() - since) / DAY) - this.#o.source.everyDays) : 0;
    if (!open.includes(REF_DUE.id)) {
      await n.emitFromController({ commandId: `proof-due:${now.toISOString()}:${this.#seq++}`, kind: "maintenance", ref: REF_DUE, label: "Time to check your backup passcode or recovery file", detail: `Backups are encrypted and nobody has proved in ${this.#o.source.everyDays} days that the passcode or recovery file still opens them. Put one where the host expects it and run backup.encryption.verify (a backup you cannot open is no backup).`.slice(0, 190) });
      raised.push(REF_DUE.id);
    }
    if (dueFor >= (this.#o.escalateAfterDays ?? 14) && !open.includes(REF_OVERDUE.id)) {
      await n.emitFromController({ commandId: `proof-overdue:${now.toISOString()}:${this.#seq++}`, kind: "maintenance", interrupt: true, ref: REF_OVERDUE, label: `Urgent: backup passcode or recovery file not proved for ${dueFor + this.#o.source.everyDays} days`, detail: "The check that your backups can still be opened is overdue. Run backup.encryption.verify.".slice(0, 190) });
      raised.push(REF_OVERDUE.id);
    }
    return { raised, cleared };
  }
}
