// Card W09 third slice: the checkout tool's `run` refuses a command that only waits.
//
// On the W09 bench, 9 of 12 timeouts were finished work (every held-out test passed) where the agent never ended: it spent up to 29 minutes in `sleep 240` to `sleep 420` calls, polling a wide test run. A command that starts
// with a sleep of more than `WAIT_GUARD.maxSleepSeconds` seconds, alone or before `;`, `&&`, `||`, a line break or a comment, is refused before it runs, with a hint to run the named test instead. The reading is conservative: a
// sleep it cannot read for certain (a variable, a quote, an option, a pipe, a background `&`, a subshell, anything before it) is left alone, so nothing else is ever refused. It is a single bounded left-to-right scan, no
// regular expression over the command.

export const WAIT_GUARD = { maxSleepSeconds: 60, scan: 400, args: 8 } as const;

const SPACE = new Set([" ", "\t"]);
const UNITS: Readonly<Record<string, number>> = { "": 1, s: 1, m: 60, h: 3600, d: 86_400 };
const SLEEPS = new Set(["sleep", "/bin/sleep", "/usr/bin/sleep"]);

/** Seconds of one `sleep` argument (`240`, `4m`, `1.5h`, `infinity`), or undefined when it is not one for certain. */
function secondsOf(arg: string): number | undefined {
  if (arg === "infinity" || arg === "inf") return Number.POSITIVE_INFINITY;
  let i = 0, digits = 0, dot = false;
  while (i < arg.length) {
    const ch = arg[i]!;
    if (ch >= "0" && ch <= "9") digits++;
    else if (ch === "." && !dot) dot = true;
    else break;
    i++;
  }
  if (digits === 0 || digits > 12) return undefined;
  const unit = UNITS[arg.slice(i)];
  if (unit === undefined) return undefined;
  const n = Number(arg.slice(0, i));
  return Number.isFinite(n) ? n * unit : undefined;
}

/** The seconds a command waits when it starts with a plain sleep before nothing, `;`, `&&`, `||`, a line break or a comment; undefined otherwise. */
export function leadingSleepSeconds(command: string): number | undefined {
  const whole = String(command);
  // A command longer than the scan is not judged: its end is not seen.
  if (whole.length > WAIT_GUARD.scan) return undefined;
  const text = whole;
  let i = 0;
  const skip = (): void => { while (i < text.length && SPACE.has(text[i]!)) i++; };
  const word = (): string => { const start = i; while (i < text.length && !SPACE.has(text[i]!) && !";&|\n\r#".includes(text[i]!)) i++; return text.slice(start, i); };
  while (i < text.length && (SPACE.has(text[i]!) || text[i] === "\n" || text[i] === "\r")) i++;
  if (!SLEEPS.has(word())) return undefined;
  let total = 0, args = 0;
  for (;;) {
    const before = i;
    skip();
    if (i >= text.length) break;
    const ch = text[i]!;
    if (ch === "\n" || ch === "\r" || ch === ";") break;
    // A comment starts only after white space: `240#x` is one word to the shell.
    if (ch === "#") { if (i === before) return undefined; break; }
    if (ch === "&" || ch === "|") { if (text[i + 1] === ch) break; return undefined; }
    // An argument must be set apart from the program name or the one before.
    if (i === before) return undefined;
    const arg = word();
    const s = secondsOf(arg);
    if (s === undefined || ++args > WAIT_GUARD.args) return undefined;
    total += s;
  }
  return args === 0 ? undefined : total;
}

/** The refusal of a command that only waits, or undefined when it may run. */
export function waitRefusal(command: string): string | undefined {
  const s = leadingSleepSeconds(command);
  if (s === undefined || s <= WAIT_GUARD.maxSleepSeconds) return undefined;
  // Rounded up, so a refused wait is never named as 60 s or less (first review: `sleep 60.4` read "waits 60 s (more than 60 s)").
  return `a command that waits ${Number.isFinite(s) ? `${Math.ceil(s)} s` : "without end"} (more than ${WAIT_GUARD.maxSleepSeconds} s) is not run: run the test files you named directly (for example node --test followed by the file) and read their result; once the build and those tests pass, end with work-end`;
}
