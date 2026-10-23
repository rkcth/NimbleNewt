export { Chaos, Crash } from "./chaos.js";
export { ANSWER, Clock, T, WORKER, check, conversationRequests, executedLines, fakeConversation, outsideLines, runPath, signature, startProcess, type Slice, type SliceWorld } from "./pipeline.js";
export { backends, stopServer, type Backend, type World } from "../domain/testing/backends.js";
// Test support for the integration proofs (card G04): the embedded PostgreSQL server and the proxy that cuts its connections at an exact statement.
export { startTestServer, withClient, type TestServer } from "../storage/postgres/testing/server.js";
export { FaultProxy, type OrdinalFault } from "../storage/postgres/testing/proxy.js";
// Simulated cache servers (llama.cpp slots, vLLM salted blocks, a Claude-style breakpoint cache) for the cache proofs (cards C06, C06b).
export { ClaudeSim, LlamaSim, VllmSim } from "../inference-cache/simulators.js";
