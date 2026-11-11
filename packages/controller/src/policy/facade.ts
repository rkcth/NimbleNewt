import type { ApprovalLoadService } from "./load.js";
import type { ProfileSuggestionService } from "./suggestion.js";

/** What the state API and the status views use of the approval services (cards A07b, A07c; U08): the load figures and standing-rule proposals, and the strict-to-derived profile suggestion. */
export interface ApprovalsFacade {
  readonly load: Pick<ApprovalLoadService, "load" | "proposals" | "propose" | "accept" | "acceptBySwitching" | "dismiss">;
  readonly suggestion: Pick<ProfileSuggestionService, "check" | "answer">;
}
