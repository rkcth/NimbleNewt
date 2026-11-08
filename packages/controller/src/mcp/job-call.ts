import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { JobService, JobState } from "../jobs/jobs.js";
import { JOB_LIMITS } from "../jobs/jobs.js";
import type { Principal } from "../security/principals.js";
import type { RemoteMcpClient, RemoteToolResult } from "./http-client.js";

type Json = Parameters<RemoteMcpClient["callTool"]>[2];

export interface McpJobCall {
  readonly commandId: string;
  readonly taskId: string;
  readonly serverId: string;
  /** The caller's stable name of the operation: the same operation of the same task is the same job, and is never called twice. */
  readonly operationId: string;
  readonly tool: string;
  readonly args?: Json;
  readonly label?: string;
  readonly background?: boolean;
}

/**
 * A long-running MCP operation as a job (card T07b): the job is admitted first (as `by`, who needs `job.write` on the task; an MCP job is admitted only on a server the owner approved and has not revoked, `McpService.usable`), then the
 * tool is called over the controller's MCP client (which connects only to the server's checked address) and the job is ended with what came back. Asking again for the same operation answers from the job and calls nothing.
 *
 * - The server's answer is kept as the job's output (its text content, bounded and redacted by the job service); a tool that reports an error fails the job.
 * - A call refused before anything was sent (the server was revoked meanwhile, the arguments are refused) fails the job. A call whose answer never came (no answer in time, the connection dropped) is **outcome-unknown**: the operation may have
 *   run on the server, and a dependent action waits for its reconciliation. One call is one session, so the operation is not tracked remotely (`resumability: none`).
 */
export async function callToolAsJob(deps: { readonly jobs: Pick<JobService, "admit" | "report" | "finish" | "markUnknown" | "get">; readonly client: Pick<RemoteMcpClient, "callTool">; /** The controller's job host, which records the call's progress and end. */ readonly host: Principal }, by: Principal, call: McpJobCall): Promise<{ readonly jobId: string; readonly state: JobState; readonly replayed: boolean; readonly result?: RemoteToolResult }> {
  const admitted = await deps.jobs.admit(by, { commandId: call.commandId, taskId: call.taskId, kind: "mcp", serverId: call.serverId, label: call.label ?? `MCP ${call.tool}`.slice(0, JOB_LIMITS.label), operationId: call.operationId, resumability: "none", longRunning: true, ...(call.background === undefined ? {} : { background: call.background }) });
  const jobId = admitted.id;
  const current = await deps.jobs.get(deps.host, jobId);
  if (admitted.replayed || current === undefined || current.state !== "admitted") return { jobId, state: current?.state ?? "admitted", replayed: true };
  const cid = (step: string): string => `mcpjob:${createHash("sha256").update(jobId).digest("hex").slice(0, 24)}:${step}`;
  await deps.jobs.report(deps.host, { commandId: cid("d"), jobId, state: "dispatched" });
  await deps.jobs.report(deps.host, { commandId: cid("r"), jobId, state: "running" });
  let result: RemoteToolResult;
  try { result = await deps.client.callTool(call.serverId, call.tool, call.args ?? {}); } catch (error) {
    const refusedBeforeSending = error instanceof DomainError && (error.code === "forbidden" || error.code === "invalid_command" || error.code === "not_found");
    const reason = (error instanceof Error ? error.message : "the call failed").slice(0, JOB_LIMITS.reason);
    if (refusedBeforeSending) {
      await deps.jobs.finish(deps.host, { commandId: cid("end"), jobId, outcome: "failed", exit: { reason } });
      return { jobId, state: "failed", replayed: false };
    }
    await deps.jobs.markUnknown(deps.host, { commandId: cid("unknown"), jobId, reason: `the MCP server's answer never came (${reason}); the operation may have run there` });
    return { jobId, state: "outcome_unknown", replayed: false };
  }
  const text = result.content.map((item) => (typeof item === "object" && item !== null && !Array.isArray(item) && typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text : JSON.stringify(item))).join("\n").slice(-JOB_LIMITS.chunk);
  const outcome = result.isError ? "failed" : "completed";
  await deps.jobs.finish(deps.host, { commandId: cid("end"), jobId, outcome, ...(text.length === 0 ? {} : { output: text }), ...(result.isError ? { exit: { reason: "the MCP tool reported an error" } } : {}) });
  return { jobId, state: outcome, replayed: false, result };
}
