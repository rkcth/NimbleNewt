import type { NotificationLevel, NotificationService } from "../notifications/index.js";
import type { LauncherNotice } from "./launcher.js";

/**
 * Telling the owner about a failed start or a fall-back (card K02f). The launcher writes a `LauncherNotice` into its own file in the same write as its decision (it can run when the database cannot); the controller
 * reads those at its start and on its sweeps and hands them to a sink. This sink raises one maintenance item per release through the notification service (kind `release-start`, the release ID as the record): the
 * label is built here from the release ID and the kind of event only, so what leaves the installation holds no path or file name; the launcher's reason stays in the inbox detail. Bounded and deduped by the
 * service: one item per release (a repeat only raises its count), the Urgent hourly limit and per-record gap apply, a command ID per notice makes a repeated hand-over a replay.
 *
 * Level: a failed start that left nothing to run (no other last known good) is Urgent and sent at once; a fall-back, which leaves an older release running, is at the owner's `startFailureLevel` (default Needs you,
 * `urgent` interrupts like the controller's other Urgent triggers).
 */
export const START_NOTICE_REF = "release-start";
export type StartFailureLevel = "needs-you" | "urgent";
export const DEFAULT_START_FAILURE_LEVEL: StartFailureLevel = "needs-you";

export interface StartNoticeSink {
  raise(notice: LauncherNotice, ownerLevel: StartFailureLevel): Promise<void>;
  settle(notice: LauncherNotice): Promise<void>;
}

/** What the sink tells for a notice: its level and the text that may leave the installation. Exported for the tests. */
export function startNoticeText(n: LauncherNotice, ownerLevel: StartFailureLevel): { level: NotificationLevel; label: string } {
  const level: NotificationLevel = n.fallback ? ownerLevel : "urgent";
  const label = n.kind === "fell_back"
    ? `${level === "urgent" ? "Urgent: " : ""}release ${n.release} failed to start; the launcher fell back to release ${n.to ?? "the last known good"}`
    : n.fallback ? `${level === "urgent" ? "Urgent: " : ""}release ${n.release} did not start in time and is set aside`
      : `Urgent: release ${n.release} failed to start and no other release is known to work`;
  return { level, label };
}

export function notificationSink(notifications: NotificationService): StartNoticeSink {
  const ref = (n: LauncherNotice): { kind: string; id: string } => ({ kind: START_NOTICE_REF, id: n.release });
  return {
    async raise(n, ownerLevel) {
      const { level, label } = startNoticeText(n, ownerLevel);
      await notifications.emitFromController({
        commandId: `release-start:${n.kind}:${n.release}:${n.at}`, kind: "maintenance", ref: ref(n), label: label.slice(0, 200),
        ...(level === "urgent" ? { interrupt: true } : { level }), detail: `${n.reason}${n.to === undefined ? "" : ` (now running ${n.to})`}`.slice(0, 190),
      });
    },
    async settle(n) {
      await notifications.settleFromController({ commandId: `release-start-settle:${n.kind}:${n.release}:${n.at}`, kind: "maintenance", ref: ref(n) });
    },
  };
}
