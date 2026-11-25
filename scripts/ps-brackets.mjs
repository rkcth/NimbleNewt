// Shared by the tests that read PowerShell scripts as text: a bracket and string checker that a Linux cell can run.
/** The brackets of a PowerShell script, outside comments and strings (single-quoted with '' escapes, double-quoted with backtick escapes and $( ) inside, here-strings):
 *  the first mismatch as "line N: ...", or "" when every bracket closes in order. Not a full parser (the hosted run parses it with PowerShell's own); it catches what a Linux cell can. */
export function psBracketProblem(text) {
  const close = { ")": "(", "}": "{", "]": "[" };
  const stack = [];
  let line = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const skipTo = (end) => { const j = text.indexOf(end, i); if (j < 0) return false; line += text.slice(i, j).split("\n").length - 1; i = j + end.length - 1; return true; };
    if (c === "\n") { line++; continue; }
    if (text.startsWith("<#", i)) { if (!skipTo("#>")) return `line ${line}: unclosed block comment`; continue; }
    if ((text.startsWith("@'\n", i) || text.startsWith("@'\r\n", i))) { if (!skipTo("\n'@")) return `line ${line}: unclosed here-string`; continue; }
    if ((text.startsWith('@"\n', i) || text.startsWith('@"\r\n', i))) { if (!skipTo('\n"@')) return `line ${line}: unclosed here-string`; continue; }
    if (c === "#") { const j = text.indexOf("\n", i); i = (j < 0 ? text.length : j) - 1; continue; }
    if (c === "'") {
      let j = i + 1;
      for (;;) { if (j >= text.length) return `line ${line}: unclosed '-string`; if (text[j] === "'") { if (text[j + 1] === "'") { j += 2; continue; } break; } if (text[j] === "\n") line++; j++; }
      i = j; continue;
    }
    if (c === '"') {
      let j = i + 1; let depth = 0;
      for (;;) {
        if (j >= text.length) return `line ${line}: unclosed "-string`;
        if (text[j] === "`") { j += 2; continue; }
        if (text.startsWith("$(", j)) { depth++; j += 2; continue; }
        if (text[j] === ")" && depth > 0) { depth--; j++; continue; }
        if (text[j] === '"' && depth === 0) break;
        if (text[j] === "\n") line++;
        j++;
      }
      i = j; continue;
    }
    if (c === "(" || c === "{" || c === "[") stack.push([c, line]);
    else if (c in close) {
      const top = stack.pop();
      if (top === undefined || top[0] !== close[c]) return `line ${line}: '${c}' closes ${top === undefined ? "nothing" : `'${top[0]}' of line ${top[1]}`}`;
    }
  }
  return stack.length === 0 ? "" : `line ${stack.at(-1)[1]}: '${stack.at(-1)[0]}' is never closed`;
}
