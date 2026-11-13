import { randomBytes } from "node:crypto";
import type { Controller } from "../api/start.js";
import { CHAT_LIMITS } from "../chat/interpreter.js";

export interface TerminalChatOptions {
  readonly controller: Pick<Controller, "chat" | "api">;
  readonly ownerToken: string;
  /** What the owner types, one message per item (a line, or a paragraph pasted as one). */
  readonly input: AsyncIterable<string>;
  readonly write: (text: string) => void;
}

/**
 * The owner's chat in a terminal (card U14): each line goes to the chat exactly as typed and the plain-words answer is written back. No line is a command or a magic word; the model behind the chat
 * works out what is meant. A line that holds a credential is refused by the chat before anything sees it; nothing typed here is kept anywhere but in the chat's own records.
 */
export async function runTerminalChat(options: TerminalChatOptions): Promise<number> {
  const chat = options.controller.chat;
  if (chat === undefined) { options.write("The chat is not running in this start.\n"); return 2; }
  let turns = 0;
  // The first-run walk-through goes on by itself (card U14d): when a step has been answered and the next required one is open, the chat says what that is once, so the owner is never left to
  // guess what comes next. It is never said while the owner is being asked something or a proposal waits for a yes, and never twice for the same step.
  let told = await setupPosition(options.controller, options.ownerToken);
  for await (const raw of options.input) {
    const text = raw.trim();
    if (text === "") continue;
    if (text.length > CHAT_LIMITS.text) { options.write(`That message is longer than ${CHAT_LIMITS.text} characters; please send it in parts.\n`); continue; }
    try {
      const turn = await chat.submit(options.ownerToken, { messageId: `terminal-${Date.now().toString(36)}-${++turns}-${randomBytes(4).toString("hex")}`, text });
      const said = turn.reply.join("\n");
      // The chat's own line says the assistant is unavailable; at the terminal the likely cause on a new installation is that no model server is registered or reachable, which the setup view names.
      options.write(`${said}${/assistant that reads free-form messages is unavailable/.test(said) ? "\nIf this stays so: check that a model server is registered (the setup list shows it under \"A model provider and route\"), that it is running, and that its key, if it needs one, is in the secret store." : ""}\n`);
      for (const secret of turn.secrets ?? []) options.write(`${secret.label} (shown once, kept nowhere; copy it now):\n${secret.value}\n`);
      if (told !== undefined && !turn.outcomes.some((o) => o.status === "proposed" || o.status === "asked" || o.status === "held")) {
        const now = await setupPosition(options.controller, options.ownerToken);
        if (now !== undefined && now.key !== told.key) {
          options.write(now.next === undefined ? "That was the last required step: everything a first agent needs is set up. You can still add a first task, a notification channel or budgets whenever you like, in your own words.\n" : `Next step in the setup: ${now.next.question}\nSuggested: ${now.next.recommended}\n(You can answer in your own words, or say you would rather skip it.)\n`);
          told = now;
        }
      }
    } catch (error) {
      options.write(`${plainProblem(error)}\n`);
    }
  }
  return 0;
}

const plainProblem = (error: unknown): string => {
  const m = String((error as Error)?.message ?? error).slice(0, 300);
  return /no model route|no route gave a usable answer|has no model route/.test(m) ? `The chat cannot reach a model right now (${m}). Check that the model server is running and that its address and credential name are right; the readiness view still works.` : `That did not go through: ${m}`;
};

/** The opening of a first run, built from the readiness view alone (no model needed): what is done, what is open, and how to go on in the owner's own words. */
export async function setupGreeting(controller: Pick<Controller, "api">, ownerToken: string): Promise<string> {
  const r = await controller.api.handle(ownerToken, { v: 1, op: "setup.readiness", args: {} } as never) as { ok: boolean; result?: { item: { ready: boolean; next?: string; items: { id: string; label: string; state: string; required: boolean; detail: string; guide: { question: string; recommended: string } }[] } } };
  if (!r.ok || r.result === undefined) return "The setup view is not available.\n";
  const v = r.result.item;
  const mark = (s: string): string => (s === "done" ? "[x]" : s === "default" ? "[-]" : "[ ]");
  const lines = v.items.map((i) => `  ${mark(i.state)} ${i.label}${i.required && i.state !== "done" ? " (needed)" : ""}: ${i.detail}`);
  const next = v.items.find((i) => i.id === v.next);
  return [
    v.ready ? "Everything a first agent needs is set up." : "Not everything a first agent needs is set up yet:",
    ...lines,
    ...(next === undefined ? [] : ["", `Next: ${next.guide.question}`, `Suggested: ${next.guide.recommended}`]),
    "", "Talk to me in your own words; for example \"help me get started\" or \"my project is in /home/me/shop\". [x] done, [-] default is fine, [ ] still open.", "",
  ].join("\n");
}

interface SetupPosition { readonly key: string; readonly next?: { readonly question: string; readonly recommended: string } }

/** Where the first run stands, from the readiness view alone: the first required step still open, or nothing when none is. Undefined when the view cannot be read (nothing is then said). */
async function setupPosition(controller: Pick<Controller, "api">, ownerToken: string): Promise<SetupPosition | undefined> {
  try {
    const r = await controller.api.handle(ownerToken, { v: 1, op: "setup.readiness", args: {} } as never) as { ok: boolean; result?: { item: { next?: string; items: { id: string; guide: { question: string; recommended: string } }[] } } };
    if (!r.ok || r.result === undefined) return undefined;
    const v = r.result.item;
    const next = v.items.find((i) => i.id === v.next);
    return { key: v.next ?? "ready", ...(next === undefined ? {} : { next: { question: next.guide.question, recommended: next.guide.recommended } }) };
  } catch { return undefined; }
}
