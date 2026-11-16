/**
 * Which confinement mechanism a host uses to run agents, and whether its boundary is weaker than the strongest one (card U08, decision G01 of 2026-10-21): the owner sees this wherever they choose or review where work runs.
 * It is read from the operating system a host reports, never from a claim by an agent. The words are the controller's own and plain; nothing here is probed or run.
 */
export interface SandboxFacts {
  /** The operating system as the host reported it, or `unknown` when it said none. */
  readonly os: string;
  /** The mechanism: `bubblewrap`, `Seatbelt`, `Windows Sandbox` or `unknown`. */
  readonly mechanism: string;
  /** `strong`: a private view of files, processes and a private network; `weaker`: a boundary with known weaker limits; `unproven`: this system names no mechanism for that operating system. */
  readonly boundary: "strong" | "weaker" | "unproven";
  /** Whether the owner is shown a warning where they choose or review where work runs. */
  readonly warn: boolean;
  /** Plain-words limits of the mechanism (at most four short lines). */
  readonly limits: readonly string[];
}

const LINUX: SandboxFacts = { os: "linux", mechanism: "bubblewrap", boundary: "strong", warn: false, limits: ["Each agent gets its own view of files, its own processes and a private network; only what its recipe names is visible."] };
const MACOS: SandboxFacts = {
  os: "darwin", mechanism: "Seatbelt", boundary: "weaker", warn: true,
  limits: [
    "Seatbelt confines by what a process may touch; it is process-level and has weaker limits than Linux's bubblewrap.",
    "There is no private view of the filesystem: the agent sees host paths, and files outside its recipe are blocked rather than hidden.",
    "The loopback network is shared with the rest of the machine, so a task with a network route is refused.",
  ],
};
const WINDOWS: SandboxFacts = { os: "win32", mechanism: "Windows Sandbox", boundary: "strong", warn: false, limits: ["Each run is in its own guest; it works only while someone is signed in to the machine, and its networking is not proven private, so a task with a network route is refused."] };

/** What can be said about the sandbox of a host from the operating system it reported. An unknown system is said to be unproven (warned), never assumed strong. */
export function sandboxFor(reported: string | undefined): SandboxFacts {
  const os = (reported ?? "").trim().toLowerCase();
  if (os === "linux") return LINUX;
  if (os === "darwin" || os === "macos" || os === "mac" || os === "macos x") return MACOS;
  if (os === "win32" || os === "windows") return WINDOWS;
  return { os: os === "" ? "unknown" : os.slice(0, 40).replace(/[^a-z0-9._ -]/g, "?"), mechanism: "unknown", boundary: "unproven", warn: true, limits: ["This system does not know which confinement this operating system gives, so it is not assumed to be as strong as Linux's."] };
}
