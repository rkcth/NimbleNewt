import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
      if (options.killFirstAttempt && attemptsIn(logFile) === 1) (process.kill(process.pid, "SIGKILL"), Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0));
      return EFFECT_OUTPUT;
    },
  };
}

/**
 * Tools for the two-conversation crash scenario. In the child, toolA blocks forever and toolB waits until toolA has
 * started and then kills the process; in the parent both just log and return (replay-safe).
 */
export function twoConversationTools(dir: string, options: { child: boolean }): AdapterTool[] {
  const log = (name: string) => appendFileSync(join(dir, `${name}.log`), "x\n");
  return [
    {
      name: "toolA", description: "Blocks in the child", parameters: Type.Object({}), replay: "safe",
      execute: async () => { log("toolA"); if (options.child) await new Promise(() => {}); return "A-DONE"; },
    },
    {
      name: "toolB", description: "Kills the child once toolA has started", parameters: Type.Object({}), replay: "safe",
      execute: async () => {
        log("toolB");
        if (options.child) {
          while (!existsSync(join(dir, "toolA.log"))) await new Promise((resolve) => setTimeout(resolve, 20));
          (process.kill(process.pid, "SIGKILL"), Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0));
        }
        return "B-DONE";
      },
    },
  ];
}
