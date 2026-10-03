// Narrow runtime-control probes; no network providers or real shell tools.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels, fauxProvider, fauxAssistantMessage as answer, fauxToolCall as call, Type } from '@earendil-works/pi-ai';
import { Harness, createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
const output = process.argv[2];
fs.mkdirSync(output, { recursive: true });
const registry = createRegistry();
const models = createModels();
const primary = fauxProvider({ provider: 'primary', models: [{ id: 'scripted' }] });
const backup = fauxProvider({ provider: 'backup', models: [{ id: 'scripted' }] });
models.setProvider(primary.provider); models.setProvider(backup.provider);
const db = await openNodeSqliteDatabase(path.join(output, 'controls.sqlite'));
const defaultSync = await db.get('PRAGMA synchronous');
await db.exec('PRAGMA synchronous=FULL');
const fullSync = await db.get('PRAGMA synchronous');
assert.equal(defaultSync.synchronous, 1); assert.equal(fullSync.synchronous, 2);
const harness = await Harness.open(await SqliteStorage.open(db), { models, registry, settings: { compaction: { enabled: false } } }, ctx);
const root = await harness.root(ctx, { agent: { model: { provider: 'primary', modelId: 'scripted' } } });
const seen = [];
function install(name, value) {
  registry.install(defineExtension({ name, tools: [defineTool({ name: 'protected_probe', description: 'Return revision', parameters: Type.Object({}), execute: async () => {
    seen.push(value); return { content: [{ type: 'text', text: value }] };
  } })] }));
}
async function invoke(content) { return (await root.submit({ type: 'input', content }, ctx)).wait(ctx); }
function toolTurn(provider) { provider.setResponses([answer(call('protected_probe', {}), { stopReason: 'toolUse' }), answer('finished')]); }
install('system', 'v1'); toolTurn(primary); await invoke('task-A-secret');
install('system', 'v2'); toolTurn(primary); await invoke('use new revision');
assert.deepEqual(seen, ['v1', 'v2']);
install('personal', 'overridden'); toolTurn(primary); await invoke('try protected tool');
assert.deepEqual(seen, ['v1', 'v2', 'overridden']); // Documents the hazard, not a desired security property.
const oldCount = primary.state.callCount;
await root.configure({ model: { provider: 'backup', modelId: 'scripted' } }, ctx);
let backupContext;
backup.setResponses([(context) => { backupContext = context; return answer('backup answer'); }]);
await invoke('continue on backup');
assert.equal(primary.state.callCount, oldCount);
assert.match(JSON.stringify(backupContext), /task-A-secret/);
const meeting = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: { model: { provider: 'backup', modelId: 'scripted' } } }, ctx);
backup.setResponses([answer('meeting answer')]);
await (await meeting.submit({ type: 'input', content: 'meeting-B-secret' }, ctx)).wait(ctx);
assert.doesNotMatch(JSON.stringify(await root.context(ctx)), /meeting-B-secret/);
assert.doesNotMatch(JSON.stringify(await meeting.context(ctx)), /task-A-secret/);
let ready;
const started = new Promise(resolve => { ready = resolve; });
registry.install(defineExtension({ name: 'blocking', tools: [defineTool({ name: 'block', description: 'Wait until cancelled', parameters: Type.Object({}), execute: async (_args, _api, context) => {
  ready();
  await new Promise((resolve, reject) => {
    if (context.abortSignal.aborted) reject(context.abortSignal.reason);
    else context.abortSignal.addEventListener('abort', () => reject(context.abortSignal.reason), { once: true });
  });
  return {};
} })] }));
backup.setResponses([answer(call('block', {}), { stopReason: 'toolUse' })]);
const active = await root.submit({ type: 'input', content: 'block now' }, ctx);
await started;
const queued = await root.submit({ type: 'input', content: 'queued input' }, ctx);
await root.abort(ctx);
const stopped = await active.wait(ctx);
const withdrawn = await queued.wait(ctx);
assert.equal(stopped.status, 'unanswered'); assert.equal(withdrawn.status, 'unanswered');
const countAfterAbort = backup.state.callCount;
backup.setResponses([answer('new input wakes the conversation')]);
await invoke('new input after abort');
assert.equal(backup.state.callCount, countAfterAbort + 1);
await harness.close(ctx);
const results = { sqlite_default_synchronous: defaultSync, explicit_full_synchronous: fullSync, hot_replacement: seen.slice(0, 2), protected_name_overridable: seen[2], next_request_model_switch_preserved_context: true, separate_meeting_context: true, abort: { active: stopped, queued: withdrawn }, new_submission_after_abort_runs: true };
fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
