import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, createProvider, Type, type Models } from "@earendil-works/pi-ai";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { requestId, type TranscriptEntry } from "@nimblenewt/contracts";
import {
  AssignmentService, ContextBranchService, ContinuationService, DeskService, EffectService, GenerationRefused, GenerationService, HistoryService, InquiryService, ModelRelay, PrincipalService, ProjectService, RetrievalService, WaitService,
  streamTapFor, type AttemptRelay, type Grant, type Principal,
} from "@nimblenewt/controller";
import { backends } from "@nimblenewt/controller/testing";
import { PiAdapter, type AdapterConversation, type AdapterTool } from "@nimblenewt/pi-adapter";
import { lineDigest, measuredFetch, ServerGate, type Budget, type CallRecord, type RadianceKey } from "./g09-radiance-gate.js";

/**
 * Card G09 with a real model: the scenario. It runs the production pieces the offline G09 tests run (C05 branches, H04 inquiries, L05 generation with the L05b stream tap, C04 continuation, the Pi adapter over durable JSONL
 * storage) with the model calls going through the production model relay (H12b, `ModelRelay` with `streamTapFor`) to the owner's Radiance server. The worker process and its sandbox are not in the chain (Pi runs in this
 * process; the relay is called directly instead of over the worker channel): that part is shown offline by g09b. The fetch under the relay is `measuredFetch` (budget, one at a time, idle gate before every call).
 *
 * Every phase records checks (`ok` true or false with what was seen) and the calls it made. Nothing here throws on a failed check: the evidence says what held and what did not. A refusal of the gate or the budget stops
 * the run at once (the remaining phases are recorded as not run).
 */

export interface ProofEnv {
  /** The transport to the server (the global fetch on a real run, a scripted server offline). */
  readonly fetch: typeof globalThis.fetch;
  readonly key: RadianceKey;
  /** The server's OpenAI base address, such as `http://127.0.0.1:8002/v1`. */
  readonly baseUrl: string;
  readonly model: string;
  /** A directory this run owns (Pi's storage goes in it). */
  readonly dir: string;
  readonly budget: Budget;
  /** Reply limits: an ordinary call, and the two calls that are cut while they write. */
  readonly replyTokens?: { readonly short: number; readonly long: number };
  /** Rule lines in the brief (200 is about 7,000 tokens). */
  readonly briefLines?: number;
  readonly log?: (line: string) => void;
  /** Characters of the cut answer's text after which it is cancelled (default 400). */
  readonly cutAfterChars?: number;
  /** How long to wait for the server to say idle after this client closed its request (default 30 s). */
  readonly drainMaxMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Told each step of each model call (scrubbed), for diagnosing a run. */
  readonly trace?: (line: string) => void;
  /** Handed the evidence object as soon as it exists, so a caller can write what there is if the run never returns. */
  readonly onEvidence?: (evidence: Evidence) => void;
}

export interface Check { readonly name: string; readonly ok: boolean; readonly seen: string }
export interface PhaseRecord { readonly name: string; readonly checks: Check[]; measured: Record<string, unknown>; error?: string; ran: boolean }
export interface Evidence {
  readonly card: "G09"; readonly startedAt: string; finishedAt?: string; readonly model: string; readonly server: string;
  readonly budget: { readonly maxCalls: number; readonly maxReplyTokens: number; readonly replyTokens: { short: number; long: number } };
  readonly briefTokensApprox: number;
  phases: PhaseRecord[]; calls: CallRecord[]; gate: { first?: unknown; last?: unknown; readings: number }; stopped?: string;
  summary?: { checks: number; passed: number; failed: string[]; calls: number; promptTokens: number; cachedTokens: number; completionTokens: number };
}

const TEAMS = ["Kestrel", "Heron", "Otter", "Lynx", "Marten", "Plover", "Wren", "Badger", "Ibis", "Stoat"];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const pick = <T>(list: readonly T[]): T => list[randomBytes(1)[0]! % list.length]!;
/** The task's brief: rule lines with three facts the questions ask about (a code, a team, a colour the owner later corrects). Synthetic; nothing private. */
export function brief(nonce: string, lines: number): { text: string; code: string; team: string } {
  const code = `${pick(["amber", "cobalt", "saffron", "violet", "jade"])}-${100 + (randomBytes(2).readUInt16BE(0) % 900)}`;
  const team = pick(TEAMS);
  const out = [`Project brief, run ${nonce}. You are the agent on this task. Only call the tool record_note when a message explicitly asks you to record a note. Answer questions with the exact value only, no explanation.`];
  for (let i = 1; i <= lines; i++) {
    out.push(`Rule ${i}: entries in ledger section ${i} are reconciled every ${DAYS[i % 5]} by team ${TEAMS[(i * 7) % 10]}, with a tolerance of ${(i * 13) % 97} cents.`);
    if (i === Math.floor(lines / 2)) out.push(`Note: the vault code for this run is ${code}.`);
    if (i === Math.floor((lines * 3) / 4)) out.push(`Note: the on-call team for this run is ${team}.`);
  }
  out.push("Read the brief. Reply with exactly: READY");
  return { text: out.join("\n"), code, team };
}

const opts = { clock: () => new Date().toISOString(), pause: async () => undefined };
let seq = 0;
const cid = (label: string): string => `${label}-${Date.now().toString(36)}-${seq++}`;
const input = (id: string, content: string) => ({ kind: "input", requestId: requestId(id), content }) as const;
const lastAnswer = (entries: readonly TranscriptEntry[]): TranscriptEntry | undefined => [...entries].reverse().find((e) => e.kind === "pi.assistant" && e.role === "assistant");
const has = (text: string | undefined, expected: string): boolean => (text ?? "").toLowerCase().includes(expected.toLowerCase());
const floor2048 = (n: number): number => Math.floor(n / 2048) * 2048;

/**
 * The fetch Pi's SDK uses, in this process: straight into the attempt's relay. Like the worker host's side of the channel (worker `host/process.ts` `#fetch`), the reply is read from the relay as fast as it comes and handed
 * on, and a cancel of the body or the caller's abort aborts the relay's request (which closes the connection to the server). Pi's SDK stops reading at `[DONE]`; reading ahead lets the relay see the reply end normally
 * first, as the host does.
 */
export function viaRelay(relay: AttemptRelay): typeof globalThis.fetch {
  return (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const raw = init?.body;
    const body = typeof raw === "string" ? new TextEncoder().encode(raw) : raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : undefined;
    const headers = [...new Headers(init?.headers).entries()] as [string, string][];
    const abort = new AbortController();
    init?.signal?.addEventListener("abort", () => abort.abort(init.signal?.reason), { once: true });
    if (init?.signal?.aborted === true) abort.abort(init.signal.reason);
    const res = await relay.relay({ url, method: (init?.method ?? "GET").toUpperCase(), headers, body, signal: abort.signal });
    const iterable = res.body;
    const iterator = iterable === null ? undefined : iterable[Symbol.asyncIterator]();
    const stream = iterator === undefined ? null : new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          try {
            for (;;) {
              const r = await iterator.next();
              if (r.done) { controller.close(); return; }
              if (abort.signal.aborted) return;
              controller.enqueue(r.value);
            }
          } catch (error) { try { controller.error(error); } catch { /* the reader has gone */ } }
        })();
      },
      // The reader went away (Pi's SDK stops at the end marker; an abort): the relay's request is aborted and its reply closed, as the host does on the channel's `fetch.abort`.
      cancel() { abort.abort(); void iterator.return?.(undefined)?.catch(() => undefined); },
    });
    return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers as [string, string][] });
  }) as typeof globalThis.fetch;
}

/** Pi's models for one provider record whose calls go to the relay (the same shape the worker process builds, `relayModels`). */
export async function relayedModels(provider: string, model: string, alias: string): Promise<Models> {
  const api = await import("@earendil-works/pi-ai/api/openai-completions");
  const baseUrl = `http://relay.invalid/${alias}`;
  const models = createModels();
  models.setProvider(createProvider({
    id: provider, baseUrl,
    auth: { apiKey: { name: "relay", resolve: async () => ({ auth: { apiKey: "relay" } }) } },
    models: [{ id: model, name: model, api: "openai-completions", provider, baseUrl, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 16_384, compat: { supportsDeveloperRole: false, supportsReasoningEffort: false } }],
    api,
  } as never));
  return models;
}

export async function runG09Proof(env: ProofEnv): Promise<Evidence> {
  const log = env.log ?? (() => undefined);
  const sleep = env.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const reply = env.replyTokens ?? { short: 256, long: 1024 };
  const lines = env.briefLines ?? 200;
  const nonce = randomBytes(6).toString("hex");
  const facts = brief(nonce, lines);
  const evidence: Evidence = {
    card: "G09", startedAt: new Date().toISOString(), model: env.model, server: env.key.scrub(env.baseUrl),
    budget: { maxCalls: env.budget.maxCalls, maxReplyTokens: env.budget.maxReplyTokens, replyTokens: reply }, briefTokensApprox: Math.round(facts.text.length / 3.6),
    phases: [], calls: [], gate: { readings: 0 },
  };
  env.onEvidence?.(evidence);
  const gate = new ServerGate({ root: env.baseUrl, key: env.key, fetch: env.fetch, model: env.model, sleep });
  let current = "setup";
  let refused: Error | undefined;
  let replyLimit = reply.short;
  const measured = measuredFetch({ fetch: env.fetch, gate, budget: env.budget, key: env.key, phase: () => current, calls: evidence.calls, onRefused: (e) => { refused ??= e; }, ...(env.trace === undefined ? {} : { trace: env.trace }) });

  // ---- the controller's side ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
  const backend = backends.find((b) => b.name === "SQLite")!;
  const world = await backend.open();
  const projects = await ProjectService.open(world.storage, { holder: "c1", ...opts });
  const principals = PrincipalService.withEpoch(world.storage, projects.epoch, opts);
  const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
  const dispatcher = await principals.authenticate((await principals.provisionService("dispatcher")).token);
  const make = async (name: string, grants: Grant[]): Promise<Principal> => {
    await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name, grants });
    return principals.authenticate((await principals.issueCredential(owner, `agent:${name}`)).token);
  };
  const project = (await projects.createProject({ commandId: cid("pa"), actor: owner.id, name: "G09 real model" })).id;
  const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "keep the ledger" })).id;
  await projects.transitionTask({ commandId: cid("tr"), actor: owner.id, taskId: task, expectedRevision: 1, to: "ready" });
  const assignments = AssignmentService.withEpoch(world.storage, projects.epoch, projects, opts);
  await assignments.assignTask({ commandId: cid("as"), actor: owner.id, taskId: task, owner: { kind: "agent", id: "ann" } });
  const asg = (await assignments.getAssignment(task))!;
  const attemptId = (await assignments.admitAttempt({ commandId: cid("ad"), actor: owner.id, taskId: task, expectedRevision: asg.revision, generation: asg.generation, owner: { kind: "agent", id: "ann" } })).id;
  const histories = HistoryService.withEpoch(world.storage, projects.epoch, opts);
  const desks = DeskService.withEpoch(world.storage, projects.epoch, opts);
  const retrieval = RetrievalService.withEpoch(world.storage, projects.epoch, desks, histories, opts);
  const waits = WaitService.withEpoch(world.storage, projects.epoch, assignments, opts);
  const effects = EffectService.withEpoch(world.storage, projects.epoch, assignments, { holder: "exec-1", ...opts });
  const inquiries = InquiryService.withEpoch(world.storage, projects.epoch, { histories, retrieval, waits, assignments }, opts);
  const continuations = ContinuationService.withEpoch(world.storage, projects.epoch, opts);
  const rights: Grant[] = [{ action: "history.*", project }, { action: "desk.write", project }, { action: "desk.read", project }, { action: "attempt.work", project }];
  const ann = await make("ann", rights);
  const ben = await make("ben", rights);
  const host = await (async () => { await principals.enroll(owner, { commandId: cid("e"), kind: "host", name: "h1", grants: [] }); return principals.authenticate((await principals.issueCredential(owner, "host:h1")).token); })();
  const branches = (): ContextBranchService => ContextBranchService.withEpoch(world.storage, projects.epoch, { histories, retrieval }, opts);
  const generation = (): GenerationService => GenerationService.withEpoch(world.storage, projects.epoch, { assignments, effects }, opts);
  const gen = generation();
  const tapErrors: string[] = [];
  const relayFor = (route: string): AttemptRelay => new ModelRelay({ fetch: measured, endpoint: () => ({ url: env.baseUrl, kind: "radiance", headers: () => env.key.header() }), onError: (_r, m) => tapErrors.push(env.key.scrub(m).slice(0, 200)) }).forAttempt({
    route, model: env.model, kind: "radiance", budget: () => ({ maxTokens: replyLimit }),
    stream: streamTapFor({ generation: gen, principal: dispatcher, settings: async () => ({ record: true, cut: true, failClosed: true, batchMs: 0, batchChars: 0 }) as never, onError: (e) => tapErrors.push(env.key.scrub(e instanceof Error ? e.message : String(e)).slice(0, 200)) }, { attemptId, taskId: task, generation: asg.generation }),
  }, { payload: (body) => (body !== null && typeof body === "object" ? { ...(body as object), temperature: 0, chat_template_kwargs: { enable_thinking: false } } : body) });

  // The one tool with an outside effect. The bridge's way (L05d): the call is found in the generation record and admitted there, or it does nothing. `hold` lets the scenario put a correction between a complete call and its execution.
  const outside: { callId: string; revision: number }[] = [];
  const refusals: string[] = [];
  const tool: { reached?: ((callId: string) => void) | undefined; hold?: Promise<void> | undefined } = {};
  const recordNote: AdapterTool = {
    name: "record_note", description: "Records a note in the project ledger. This is an action with an outside effect.", parameters: Type.Object({ note: Type.String({ description: "The note to record" }) }),
    execute: async (_args, { callId }) => {
      tool.reached?.(callId);
      await tool.hold;
      try {
        await gen.admitCall(dispatcher, { commandId: cid("adm"), taskId: task, callId, target: "ledger.note" });
        outside.push({ callId, revision: (await gen.gate(owner, task))!.gate.contextRevision });
        return "recorded";
      } catch (error) {
        if (!(error instanceof GenerationRefused)) throw error;
        refusals.push(error.reason);
        return `refused: ${error.reason}`;
      }
    },
  };

  const piDir = join(env.dir, "pi");
  mkdirSync(piDir, { recursive: true });
  const openAdapter = async (provider: string, route: string): Promise<PiAdapter> => {
    const relay = relayFor(route);
    const fetch = viaRelay(relay);
    return PiAdapter.open({ storage: await openNodeJsonlStorage(piDir, BACKGROUND_CONTEXT), models: await relayedModels(provider, env.model, relay.alias), model: { provider, modelId: env.model }, tools: [recordNote], cache: { policy: () => ({ fetch: () => fetch }) } });
  };

  const phases = evidence.phases;
  const phase = async (name: string, body: (p: PhaseRecord) => Promise<void>): Promise<void> => {
    const p: PhaseRecord = { name, checks: [], measured: {}, ran: false };
    phases.push(p);
    if (evidence.stopped !== undefined) return;
    current = name; replyLimit = reply.short;
    log(`# ${name}`);
    p.ran = true;
    try { await body(p); } catch (error) { p.error = env.key.scrub(error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 400); }
    if (refused !== undefined) evidence.stopped = env.key.scrub(`${refused.name}: ${refused.message}`).slice(0, 300);
    for (const c of p.checks) log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name} (${c.seen})`);
  };
  const check = (p: PhaseRecord, name: string, ok: boolean, seen: string): void => { p.checks.push({ name, ok, seen: env.key.scrub(seen).slice(0, 400) }); };
  const callsOf = (name: string): CallRecord[] => evidence.calls.filter((c) => c.phase === name && c.ended !== "refused");
  const lastCall = (name: string): CallRecord | undefined => callsOf(name).at(-1);
  const cachedOf = (c: CallRecord | undefined): number => c?.facts?.cachedTokens ?? c?.facts?.cacheN ?? 0;
  const view = async () => { const g = (await gen.gate(owner, task))!.gate; return { g, run: g.current === undefined ? undefined : (await gen.view(owner, GenerationService.runIdOf(task, g.current)))?.run }; };
  const watch = async (until: () => Promise<boolean>, maxMs: number): Promise<boolean> => { const end = Date.now() + maxMs; while (Date.now() < end) { if (await until()) return true; await sleep(20); } return false; };

  let adapter: PiAdapter | undefined;
  let parent!: AdapterConversation;
  /** Mirrors the adapter's transcript text into the task history (the controller's copy C05 forks), as the offline fixture's `Mirror` does. */
  const mirrored = new Set<number>();
  // The controller's history takes entries of up to 8,000 characters; a longer message (the brief) is mirrored as consecutive parts, so the parts joined are the message.
  const PART = 7_900;
  const mirror = async (): Promise<void> => {
    for (const e of await parent.transcript()) {
      if (mirrored.has(e.id) || e.text === "" || (e.role !== "user" && e.role !== "assistant")) continue;
      const line = `${e.role}: ${e.text}`;
      for (let at = 0, k = 0; at < line.length; at += PART, k++) await histories.append(ann, HistoryService.taskScopeId(task), { commandId: `mirror-${task}-${e.id}-${k}`, text: line.slice(at, at + PART), taskId: task });
      mirrored.add(e.id);
    }
  };
  const transcriptText = async (c: AdapterConversation): Promise<string> => (await c.transcript()).filter((e) => e.text !== "" && (e.role === "user" || e.role === "assistant")).map((e) => `${e.role}: ${e.text}`).join("");
  const parentSnapshot = async (): Promise<string> => JSON.stringify([await parent.transcript(), await histories.read(owner, HistoryService.taskScopeId(task), { limit: 200, taskId: task }), await assignments.getAssignment(task)]);
  let inquiry: { branchId: string; inquiryId: string; fork: AdapterConversation } | undefined;
  let parentManifest: string[] = [];

  try {
    try { evidence.gate.first = (await gate.check(0)).stats; } catch (error) { evidence.stopped = env.key.scrub(error instanceof Error ? error.message : String(error)); throw error; }
    adapter = await openAdapter("radiance", "radiance/pinned");
    parent = adapter.root();

    await phase("A. the task's first turn", async (p) => {
      const r = await (await parent.submit(input(cid("brief"), facts.text))).result();
      const answer = lastAnswer(await parent.transcript())?.text;
      const c = lastCall(p.name);
      check(p, "the turn completed and the model answered READY", r.status === "completed" && has(answer, "READY"), `${r.status}: ${JSON.stringify(answer?.slice(0, 60))}`);
      parentManifest = c?.manifest ?? [];
      p.measured = { promptTokens: c?.facts?.promptTokens, cachedTokens: cachedOf(c), promptMs: c?.facts?.promptMs, wallMs: c?.endMs };
    });

    await phase("B. an inquiry on the retained context", async (p) => {
      await mirror();
      const before = await parentSnapshot();
      const asked = await inquiries.ask(owner, { commandId: cid("ask"), taskId: task, to: "agent:ann", question: "What is the vault code?" });
      const opened = await branches().open(ann, { commandId: cid("open"), taskId: task, purpose: "What is the vault code?", inquiryId: asked.id });
      const fork = await parent.branch({ requestId: requestId(opened.id) });
      inquiry = { branchId: opened.id, inquiryId: asked.id, fork: fork.conversation };
      const r = await (await fork.conversation.submit(input(cid("q"), "Inquiry from the owner: what is the vault code for this run? Answer with the code only."))).result();
      const answer = lastAnswer(await fork.conversation.transcript())?.text;
      const c = lastCall(p.name);
      const parentHistory = (await branches().history(ann, opened.id, { part: "parent", limit: 200 }))!.entries.map((e) => e.text);
      check(p, "the controller's branch inherits exactly the parent's history (the adapter's transcript text, part for part)", parentHistory.join("") === await transcriptText(parent) && has(parentHistory.at(-1), "READY"), `${parentHistory.length} entries`);
      check(p, "the inquiry's request is the parent's context plus the question, exactly", c !== undefined && parentManifest.length > 0 && JSON.stringify(c.manifest.slice(0, -1)) === JSON.stringify([...parentManifest, `assistant: ${lastAnswer((await parent.transcript()))?.text ?? ""}`]) && has(c.manifest.at(-1), "vault code"), c === undefined ? "no call" : c.manifest.map(lineDigest).join(" | ").slice(0, 380));
      check(p, "the real model answered from the original context (the vault code)", r.status === "completed" && has(answer, facts.code), `${JSON.stringify(answer?.slice(0, 60))} expected ${facts.code}`);
      const reuse = cachedOf(c);
      check(p, "the server reused the parent's cached context for the inquiry (whole 2,048-token steps)", reuse >= 2048 && reuse >= floor2048((evidence.calls.find((x) => x.phase.startsWith("A."))?.facts?.promptTokens ?? 0)) - 2048, `${reuse} of ${c?.facts?.promptTokens} prompt tokens cached`);
      await inquiries.answer(ann, { commandId: cid("ans"), inquiryId: asked.id, answer: answer ?? "" });
      const v = (await inquiries.view(owner, asked.id))!;
      check(p, "H04: the inquiry is answered and the task's generation is unchanged", v.inquiry.state === "answered" && v.generationUnchanged === true, `${v.inquiry.state}, generationUnchanged ${String(v.generationUnchanged)}`);
      check(p, "the parent is unpolluted: transcript, task history and assignment byte-identical", (await parentSnapshot()) === before, "compared as JSON");
      p.measured = { promptTokens: c?.facts?.promptTokens, cachedTokens: reuse, promptN: c?.facts?.promptN, promptMs: c?.facts?.promptMs, ttftMs: c?.facts?.ttftMs, wallMs: c?.endMs };
    });

    await phase("C. an unchanged resume", async (p) => {
      if (inquiry === undefined) throw new Error("no inquiry");
      const v = (await branches().view(ann, inquiry.branchId))!;
      const resumed = await branches().resume(ann, { commandId: cid("rsm"), branchId: inquiry.branchId, expectedRevision: v.branch.revision });
      check(p, "C05 resume returns to the task with no update selected", resumed.returnedTo.taskId === task && v.updates.length === 0, `${resumed.returnedTo.taskId === task}, ${v.updates.length} updates`);
      const r = await (await parent.submit(input(cid("go"), "Which team is on call for this run? Answer with the team name only."))).result();
      const answer = lastAnswer(await parent.transcript())?.text;
      const c = lastCall(p.name);
      const text = JSON.stringify(c?.manifest ?? []);
      check(p, "the parent's next request is its own context plus the new instruction, with nothing of the inquiry", c !== undefined && !text.includes("Inquiry from the owner") && JSON.stringify(c.manifest.slice(0, parentManifest.length)) === JSON.stringify(parentManifest) && c.manifest.length === parentManifest.length + 2, `${c?.manifest.length} messages (the first turn's request had ${parentManifest.length})`);
      check(p, "the model answered from the parent's context (the on-call team)", r.status === "completed" && has(answer, facts.team), `${JSON.stringify(answer?.slice(0, 60))} expected ${facts.team}`);
      check(p, "the parent's cached context survived the inquiry", cachedOf(c) >= 2048, `${cachedOf(c)} of ${c?.facts?.promptTokens} cached`);
      p.measured = { promptTokens: c?.facts?.promptTokens, cachedTokens: cachedOf(c), promptMs: c?.facts?.promptMs, wallMs: c?.endMs };
    });

    await phase("D. an updated resume: an owner decision corrected while an inquiry is open", async (p) => {
      env.trace?.("D: desk"); const decisionA = await desks.write(ann, { commandId: cid("d"), projectId: project, kind: "decision", title: "Release colour", body: "Owner decision: the release colour is RED.", visibility: "shared", status: "accepted" } as never);
      env.trace?.("D: placing"); const placed = await (await parent.submit({ kind: "update", requestId: requestId(cid("place")), content: "Owner decision: the release colour is RED.", run: false })).result();
      await mirror();
      const asked = await inquiries.ask(owner, { commandId: cid("ask"), taskId: task, to: "agent:ann", question: "Which colour?" });
      const svc = branches();
      const opened = await svc.open(ann, { commandId: cid("open"), taskId: task, purpose: "Which colour?", inquiryId: asked.id });
      let v = (await svc.view(ann, opened.id))!;
      await svc.applyUpdates(ann, { commandId: cid("upd"), branchId: opened.id, expectedRevision: v.branch.revision, updates: [{ kind: "desk-record", id: decisionA.id }] });
      const decisionB = await desks.write(ann, { commandId: cid("d"), projectId: project, kind: "decision", title: "Release colour", body: "Owner correction: RED is withdrawn; the release colour is GREEN.", visibility: "shared", status: "accepted", supersedes: decisionA.id } as never);
      v = (await svc.view(ann, opened.id))!;
      const cmd = cid("upd");
      const applied = await svc.applyUpdates(ann, { commandId: cmd, branchId: opened.id, expectedRevision: v.branch.revision, updates: [{ kind: "desk-record", id: decisionB.id }] });
      const again = await svc.applyUpdates(ann, { commandId: cmd, branchId: opened.id, expectedRevision: v.branch.revision, updates: [{ kind: "desk-record", id: decisionB.id }] });
      v = (await svc.view(ann, opened.id))!;
      check(p, "C05: the corrected decision is applied once (a replay is a replay) and the old one shows as changed", placed.status === "placed" && !applied.replayed && again.replayed && v.updates.some((u) => u.state === "changed") && v.updates.filter((u) => u.state === "current").length === 1, JSON.stringify(v.updates.map((u) => [u.revision, u.state])));
      const correction = v.updates.find((u) => u.state === "current")!.text!;
      env.trace?.("D: resume"); await svc.resume(ann, { commandId: cid("rsm"), branchId: opened.id, expectedRevision: v.branch.revision });
      const update = { kind: "update", requestId: requestId(cid("upd-run")), content: `${correction} Reply with the release colour now in force, one word.`, run: true } as const;
      env.trace?.("D: submitting the update");
      const first = await parent.submit(update);
      env.trace?.("D: submitting it again");
      const second = await parent.submit(update);
      env.trace?.("D: waiting for the turn");
      const r = await first.result();
      env.trace?.(`D: turn ${r.status}`);
      const answer = lastAnswer(await parent.transcript())?.text;
      const c = lastCall(p.name);
      const m = c?.manifest ?? [];
      const iRed = m.findIndex((l) => l.includes("release colour is RED")); const iGreen = m.findIndex((l) => l.includes("the release colour is GREEN"));
      check(p, "the parent's request holds its context, then the old decision, then the correction, and nothing of the inquiry", iRed > 0 && iGreen > iRed && !JSON.stringify(m).includes("Inquiry from the owner"), `RED at ${iRed}, GREEN at ${iGreen} of ${m.length}`);
      check(p, "a repeated submission is the same submission (the model is asked once)", second.submissionId === first.submissionId && callsOf(p.name).length === 1, `${callsOf(p.name).length} call(s)`);
      check(p, "the real model acts on the corrected decision (GREEN)", r.status === "completed" && has(answer, "GREEN") && !has(answer, "RED"), JSON.stringify(answer?.slice(0, 60)));
      const corrected = await gen.correct(owner, { commandId: cid("corr"), taskId: task, expectedContextRevision: (await gen.gate(owner, task))!.gate.contextRevision, reason: "owner corrected the release colour" });
      p.measured = { promptTokens: c?.facts?.promptTokens, cachedTokens: cachedOf(c), promptMs: c?.facts?.promptMs, wallMs: c?.endMs, contextRevision: corrected.contextRevision };
    });

    await phase("E. a correction while the model writes a tool call", async (p) => {
      replyLimit = reply.long;
      const rev = (await gen.gate(owner, task))!.gate.contextRevision;
      let reached: string | undefined;
      let release!: () => void;
      tool.hold = new Promise<void>((r) => { release = r; });
      const reachedP = new Promise<void>((r) => { tool.reached = (id) => { reached ??= id; r(); }; });
      const outsideBefore = outside.length;
      const handle = await parent.submit(input(cid("note"), "Record a note now: call record_note with a note that summarises rules 1 to 25 of the brief in full sentences, at least 200 words."));
      let settled = false;
      void handle.result().then(() => { settled = true; }, () => { settled = true; });
      let path = "none";
      let partialArgs = "";
      const runBefore = (await view()).g.current ?? 0;
      // Cut at the first sign of the call: its arguments arriving (partial), or the complete call reaching the tool before it is admitted.
      const seen = await watch(async () => {
        if (reached !== undefined) { path = "complete call held before admission"; return true; }
        const { g, run } = await view();
        if (run === undefined || (g.current ?? 0) <= runBefore) return false;
        const partial = run.toolCalls.find((t) => t.state === "partial" && t.args.length >= 40);
        if (partial !== undefined) { path = "partial call cut"; partialArgs = partial.args; return true; }
        if (settled) { path = "none: the turn ended without a tool call"; return true; }
        return false;
      }, 120_000);
      const t0 = performance.now();
      const corrected = await gen.correct(owner, { commandId: cid("corr"), taskId: task, expectedContextRevision: rev, reason: "owner correction: do not record that note; the ledger is frozen" });
      const correctionMs = Math.round(performance.now() - t0);
      void reachedP;
      release();
      tool.hold = undefined; tool.reached = undefined;
      let limit: ReturnType<typeof setTimeout> | undefined;
      const r = await Promise.race([handle.result(), new Promise<{ status: string }>((resolve) => { limit = setTimeout(() => resolve({ status: "timeout" }), 180_000); })]) as { status: string };
      clearTimeout(limit);
      const drain = await gate.waitIdle(env.drainMaxMs ?? 30_000);
      const { run: last } = await view();
      const first = (await gen.view(owner, GenerationService.runIdOf(task, runBefore + 1)))?.run;
      const c = callsOf(p.name)[0];
      check(p, "the cut landed while a tool call was being written or before its admission", seen && !path.startsWith("none"), path);
      check(p, "the generation under the old revision is interrupted by the correction", first?.state === "interrupted" && first.interrupted?.kind === "corrected", `${first?.state} ${first?.interrupted?.kind}`);
      check(p, "no call of the old generation is admitted or complete; none reached the outside", (first?.toolCalls ?? []).every((t) => t.state !== "admitted" && t.state !== "complete" && t.effectId === undefined) && outside.slice(outsideBefore).every((o) => o.revision > rev), JSON.stringify((first?.toolCalls ?? []).map((t) => [t.state, t.args.length])));
      if (path === "partial call cut") check(p, "the partial call is dropped for good", first?.toolCalls[0]?.state === "dropped", String(first?.toolCalls[0]?.state));
      else if (path === "complete call held before admission") check(p, "the complete call's admission was refused (the model is told so)", refusals.includes("interrupted") || refusals.includes("stale"), refusals.join(","));
      check(p, "this client closed its own request and the server went idle", c !== undefined && (c.ended === "cancelled" || c.ended === "error" || c.ended === "complete") && drain.ms !== undefined, `call ended ${c?.ended} after ${c?.endMs} ms, closed at ${c?.closedMs ?? "-"} ms; server idle ${drain.ms ?? "not within the limit"} ms after the turn ended (${drain.polls} polls)`);
      p.measured = {
        path, correctionMs, turnStatus: r.status, contextRevision: corrected.contextRevision, firstCall: c === undefined ? undefined : { ended: c.ended, endMs: c.endMs, closedMs: c.closedMs, bytes: c.bytes, toolPieces: c.facts?.toolPieces, textChars: c.facts?.textChars, promptTokens: c.facts?.promptTokens, cachedTokens: cachedOf(c) },
        laterCalls: callsOf(p.name).slice(1).map((x) => ({ ended: x.ended, cachedTokens: cachedOf(x), toolNames: x.facts?.toolNames })), lateRecorded: first?.late.length, partialArgsChars: partialArgs.length, drainMs: drain.ms,
        lastRun: last === undefined ? undefined : { number: last.number, state: last.state, contextRevision: last.contextRevision }, admittedAfterCorrection: outside.slice(outsideBefore).length,
      };
      (p as { partialArgs?: string }).partialArgs = partialArgs;
    });

    await phase("F. the owner cancels in the middle of a long answer", async (p) => {
      replyLimit = reply.long;
      const runBefore = (await view()).g.current ?? 0;
      const handle = await parent.submit(input(cid("essay"), "Without calling any tool, explain in about 400 words how the ledger sections are reconciled through the week."));
      const cutAfter = env.cutAfterChars ?? 400;
      const reachedText = await watch(async () => { const { g, run } = await view(); return run !== undefined && (g.current ?? 0) > runBefore && run.text.length >= cutAfter; }, 120_000);
      const t0 = performance.now();
      const interrupted = await gen.interrupt(owner, { commandId: cid("int"), taskId: task, mode: "cancel", reason: "owner said stop" });
      const aborted = await parent.abort();
      const commandMs = Math.round(performance.now() - t0);
      const r = await handle.result();
      const drain = await gate.waitIdle(env.drainMaxMs ?? 30_000);
      const c = callsOf(p.name).at(-1);
      const run = (await gen.view(owner, GenerationService.runIdOf(task, runBefore + 1)))?.run;
      check(p, "the answer was cut while it was being written", reachedText && (c?.ended === "cancelled" || c?.ended === "error"), `${run?.text.length} characters recorded; call ${c?.ended}`);
      check(p, "L05 records the generation interrupted (cancel) and holds the task", run?.state === "interrupted" && interrupted.cut && (await gen.gate(owner, task))!.gate.hold !== undefined, `${run?.state}, cut ${String(interrupted.cut)}`);
      check(p, "the turn ended aborted, with the adapter's own abort", r.status === "unanswered" && aborted.aborted.length >= 1, `${r.status}, ${aborted.aborted.length} aborted`);
      check(p, "the server stopped working for this client (idle again)", drain.ms !== undefined, `idle ${drain.ms ?? "not within the limit"} ms after the abort returned (${drain.polls} polls)`);
      await gen.release(owner, { commandId: cid("rel"), taskId: task, reason: "reviewed" });
      p.measured = { cutAfterChars: cutAfter, recordedChars: run?.text.length, streamedChars: c?.facts?.textChars, interruptAndAbortMs: commandMs, callEndedMs: c?.endMs, closedMs: c?.closedMs, drainMs: drain.ms, promptTokens: c?.facts?.promptTokens, cachedTokens: cachedOf(c), completionTokensReported: c?.facts?.completionTokens ?? null };
    });

    await phase("G. the next generation after both interruptions", async (p) => {
      const partial = (phases.find((x) => x.name.startsWith("E."))! as { partialArgs?: string }).partialArgs ?? "";
      const r = await (await parent.submit(input(cid("go"), "The owner has reviewed the interruptions. Which team is on call for this run? Answer with the team name only."))).result();
      const answer = lastAnswer(await parent.transcript())?.text;
      const c = lastCall(p.name);
      const text = JSON.stringify(c?.manifest ?? []);
      check(p, "the partial call's words are in nothing the model is shown next", partial.length < 20 || !text.includes(partial.slice(0, 20)), partial.length < 20 ? "no partial words were recorded (the call was complete)" : "checked the first 20 characters");
      check(p, "the model answered from the retained context (the on-call team)", r.status === "completed" && has(answer, facts.team), `${JSON.stringify(answer?.slice(0, 60))} expected ${facts.team}`);
      check(p, "the cached context survived the interruptions", cachedOf(c) >= 2048, `${cachedOf(c)} of ${c?.facts?.promptTokens} cached`);
      const run = (await view()).run;
      check(p, "the new generation is bound to the corrected revision and finished", run !== undefined && run.contextRevision === (await gen.gate(owner, task))!.gate.contextRevision && run.state === "finished", `${run?.number} ${run?.state} rev ${run?.contextRevision}`);
      p.measured = { promptTokens: c?.facts?.promptTokens, cachedTokens: cachedOf(c), promptMs: c?.facts?.promptMs, wallMs: c?.endMs, messages: c?.manifest.length };
    });

    await phase("H. a restart and a change of provider record", async (p) => {
      await mirror();
      const before = await parent.transcript();
      const checkpoint = await parent.checkpoint();
      const verified = await adapter!.verifyCheckpoint(checkpoint);
      const capture = await continuations.capture(host, {
        commandId: cid("cap"), taskId: task, identity: `conversation-${checkpoint.conversationId}`, agent: "agent:ann", boundary: { kind: "turn-complete" },
        checkpoint: { format: checkpoint.format, conversationId: checkpoint.conversationId, at: checkpoint.at, digest: checkpoint.digest, runtime: checkpoint.runtime }, durable: { verified: verified.valid },
        continuation: { artifacts: [], decisions: [], pendingEffects: [], budget: { spent: 1, remaining: 99, unit: "k-tokens" }, nextStep: "carry on with the task" },
        manifest: { summaryLineage: [], sourceRanges: [{ source: "history", from: 1, to: before.length }], compression: { state: "none", compactions: 0 }, branches: [], messageCursor: checkpoint.at, routingRevision: 1, environmentRevision: 1, adapter: { name: "pi-adapter", version: "0.0.0" } },
        nonCheckpointableTools: [{ name: "record_note", reason: "its effects are outside the history" }], scratchRecords: [], credentialRefs: [],
      } as never);
      await adapter!.close();
      adapter = await openAdapter("radiance-b", "radiance-b/pinned");
      parent = adapter.root();
      await parent.useModel({ provider: "radiance-b", modelId: env.model });
      const after = await parent.transcript();
      const verdict = await adapter.verifyCheckpoint(checkpoint);
      const resumed = await continuations.resume(host, { commandId: cid("rsm"), taskId: task, model: { provider: "radiance-b", id: env.model }, previousModel: { provider: "radiance", id: env.model }, after: "model-change", ...(verdict.valid ? { restoredBy: "native-restore" as const } : { restoredBy: "restart" as const }) });
      check(p, "the stored history came back exactly, with no summary in it", JSON.stringify(after) === JSON.stringify(before) && !after.some((e) => e.kind === "pi.compaction" || e.head !== undefined), `${after.length} entries`);
      check(p, "the checkpoint verifies on the reopened storage, and the resume record says native-restore", verdict.valid && resumed.restoredBy === "native-restore" && resumed.continuation.id === capture.id && resumed.modelChanged === true, `${JSON.stringify(verdict)} ${resumed.restoredBy}`);
      const r = await (await parent.submit(input(cid("go"), "After the restart: what is the vault code for this run? Answer with the code only."))).result();
      const answer = lastAnswer(await parent.transcript())?.text;
      const c = lastCall(p.name);
      check(p, "the real model answers from the restored context after the restart (the vault code)", r.status === "completed" && has(answer, facts.code), `${JSON.stringify(answer?.slice(0, 60))} expected ${facts.code}`);
      check(p, "the server still held this conversation's cached context after the restart", cachedOf(c) >= 2048, `${cachedOf(c)} of ${c?.facts?.promptTokens} cached`);
      let fork: CallRecord | undefined;
      let forkAnswer: string | undefined;
      if (inquiry !== undefined) {
        const again = await parent.branch({ requestId: requestId(inquiry.branchId) });
        await again.conversation.useModel({ provider: "radiance-b", modelId: env.model });
        const rf = await (await again.conversation.submit(input(cid("q2"), "And which team is on call for this run? Answer with the team name only."))).result();
        forkAnswer = lastAnswer(await again.conversation.transcript())?.text;
        fork = lastCall(p.name);
        check(p, "the inquiry's fork is found again by its branch ID and answers from its own context", again.conversation.id === inquiry.fork.id && rf.status === "completed" && has(forkAnswer, facts.team) && !JSON.stringify(fork?.manifest ?? []).includes("release colour"), `${JSON.stringify(forkAnswer?.slice(0, 40))}`);
      }
      p.measured = { promptTokens: c?.facts?.promptTokens, cachedTokens: cachedOf(c), promptMs: c?.facts?.promptMs, wallMs: c?.endMs, fork: fork === undefined ? undefined : { promptTokens: fork.facts?.promptTokens, cachedTokens: cachedOf(fork), promptMs: fork.facts?.promptMs } };
    });
  } catch (error) {
    evidence.stopped ??= env.key.scrub(error instanceof Error ? error.message : String(error)).slice(0, 300);
  } finally {
    try { await adapter?.close(); } catch { /* closing */ }
    try { evidence.gate.last = await gate.stats(); } catch { /* recorded as missing */ }
  }
  evidence.gate.readings = gate.readings.length;
  try {
    const g = (await gen.gate(owner, task))?.gate;
    const runs: unknown[] = [];
    for (let k = 1; k <= (g?.current ?? 0); k++) { const r = (await gen.view(owner, GenerationService.runIdOf(task, k)))?.run; runs.push(r === undefined ? null : { number: r.number, state: r.state, contextRevision: r.contextRevision, interrupted: r.interrupted?.kind, toolCalls: r.toolCalls.map((t) => t.state), late: r.late.length, textChars: r.text.length }); }
    (evidence as { generations?: unknown[] }).generations = runs;
  } catch { /* not readable */ }
  await world.close();
  evidence.finishedAt = new Date().toISOString();
  const all = phases.flatMap((p) => p.checks);
  const ok = evidence.calls.filter((c) => c.ended !== "refused");
  evidence.summary = {
    checks: all.length, passed: all.filter((c) => c.ok).length, failed: all.filter((c) => !c.ok).map((c) => c.name), calls: ok.length,
    promptTokens: ok.reduce((s, c) => s + (c.facts?.promptTokens ?? 0), 0), cachedTokens: ok.reduce((s, c) => s + (c.facts?.cachedTokens ?? c.facts?.cacheN ?? 0), 0), completionTokens: ok.reduce((s, c) => s + (c.facts?.completionTokens ?? 0), 0),
  };
  if (tapErrors.length > 0) (evidence as { tapErrors?: string[] }).tapErrors = tapErrors.slice(0, 20);
  return evidence;
}
