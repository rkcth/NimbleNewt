import type { ActionClass, Mode } from "../policy/index.js";

/**
 * Whether a meeting decision that widens spend or rights may be carried out without the owner (owner decision 2026-10-30).
 * A specific setting (an explicit cell) decides; with none set the installation profile decides. The engine keeps a change of
 * rights (access-change) a decision for the owner whatever the profile says, so it is allowed only where the owner set that cell by hand.
 */
export function wideningDecision(cell: { readonly mode: Mode; readonly explicit: boolean }, cls: ActionClass): "allow" | "ask" {
  return cell.mode === "allow" && (cls === "spend" || cell.explicit) ? "allow" : "ask";
}
