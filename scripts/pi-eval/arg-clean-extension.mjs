// Card W01b: the bench's Pi extension (loaded by pi-agent.mjs with `-e`). Before each provider request it replaces lone
// surrogates in the request (lib/arg-clean.mjs: tool-call arguments as JSON text, raw ones in every other string) with
// U+FFFD, so a call Pi's edit tool decoded in place can no longer make the server refuse the history. A request that needs
// nothing is passed on untouched (the handler returns nothing). It never throws.
//
// Counts only, never content: when PI_EVAL_ARG_CLEAN_FILE names a file (pi-agent.mjs puts it next to the run's log, in the
// run's own artifacts folder), it holds { requests, requestsChanged, stringsChanged, argumentsChanged, errors }, written at
// load and after every request; the runner copies it into the run record (argClean). It reads and writes nothing else.
import { renameSync, writeFileSync } from "node:fs";
import { cleanPayload } from "./lib/arg-clean.mjs";

/** The extension's state and handler, apart from Pi (tests drive it with a fake runner). */
export function createArgClean({ file = process.env.PI_EVAL_ARG_CLEAN_FILE } = {}) {
  const counts = { requests: 0, requestsChanged: 0, stringsChanged: 0, argumentsChanged: 0, errors: 0 };
  const save = () => {
    if (!file) return;
    try {
      writeFileSync(`${file}.tmp`, `${JSON.stringify(counts)}\n`);
      renameSync(`${file}.tmp`, file);
    } catch { /* a record that cannot be written must not stop the request */ }
  };
  const handler = (event) => {
    try {
      counts.requests++;
      const r = cleanPayload(event.payload);
      if (r.strings > 0) {
        counts.requestsChanged++;
        counts.stringsChanged += r.strings;
        counts.argumentsChanged += r.arguments;
      }
      save();
      return r.strings > 0 ? r.payload : undefined;
    } catch {
      try { counts.errors++; save(); } catch { /* nothing more to do */ }
      return undefined;
    }
  };
  save();
  return { counts, handler };
}

export default function argCleanExtension(pi) {
  const { handler } = createArgClean();
  pi.on("before_provider_request", handler);
}
