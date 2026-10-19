import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import type { AdapterTool } from "../adapter.js";

export const EFFECT_OUTPUT = "EFFECT-DONE";

export function attemptsIn(logFile: string): number {
  return existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).length : 0;
}

/**
 * A tool with an external effect: it logs every attempt, and when `killFirstAttempt` is set the first attempt kills the
 * whole process after logging, like a crash in the middle of the effect.
 */
export function effectTool(logFile: string, options: { killFirstAttempt: boolean; replay?: "safe" }): AdapterTool {
  return {
    name: "effect",
    description: "Performs an external effect",
    parameters: Type.Object({}),
    ...(options.replay === undefined ? {} : { replay: options.replay }),
    execute: async () => {
      appendFileSync(logFile, "attempt\n");
      if (options.killFirstAttempt && attemptsIn(logFile) === 1) process.kill(process.pid, "SIGKILL");
      return EFFECT_OUTPUT;
    },
  };
}
