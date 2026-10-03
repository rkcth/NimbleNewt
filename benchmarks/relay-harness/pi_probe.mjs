// Offline Pi Durable recovery probe. Invoked by run_probes.py.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, Type } from '@earendil-works/pi-ai';
import { Harness, createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
const [root, scenario, stage] = process.argv.slice(2);
fs.mkdirSync(root, { recursive: true });
function log(file, data) {
  const fd = fs.openSync(path.join(root, file), 'a');
  fs.writeSync(fd, JSON.stringify(data) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd);
}
const registry = createRegistry();
const prepare = defineTool({ name: 'prepare', description: 'Record completed prerequisite', parameters: Type.Object({}), execute: async () => {
  log('prepare.jsonl', { prepared: true }); return { content: [{ type: 'text', text: 'prepared' }] };
}});
const effect = defineTool({ name: 'effect', description: 'Perform fake external action', parameters: Type.Object({}),
  ...(scenario === 'unsafe' ? {} : { replay: 'safe' }), execute: async () => {
    log('attempts.jsonl', { stage });
    if (scenario === 'idempotent') {
      const db = new DatabaseSync(path.join(root, 'external.sqlite'));
      db.exec('CREATE TABLE IF NOT EXISTS effects (id TEXT PRIMARY KEY)');
      db.prepare('INSERT OR IGNORE INTO effects VALUES (?)').run('operation-1'); db.close();
    } else log('effects.jsonl', { effect: 'operation-1' });
    if (stage === 'start') process.kill(process.pid, 'SIGKILL');
    return { content: [{ type: 'text', text: 'effect completed' }] };
}});
registry.install(defineExtension({ name: 'relay-probe', tools: [prepare, effect] }));
const models = createModels();
const faux = fauxProvider({ provider: 'offline', models: [{ id: 'scripted' }] });
models.setProvider(faux.provider);
faux.setResponses(stage === 'start' ? [
  fauxAssistantMessage(fauxToolCall('prepare', {}, { id: 'call-prepare' }), { stopReason: 'toolUse' }),
  fauxAssistantMessage(fauxToolCall('effect', {}, { id: 'call-effect' }), { stopReason: 'toolUse' }),
] : [(context) => { log('model.jsonl', context); return fauxAssistantMessage('finished'); }]);
const harness = await Harness.open(await openNodeSqliteStorage(path.join(root, 'checkpoints.sqlite')), {
  models, registry, settings: { compaction: { enabled: false } },
}, ctx);
const convo = await harness.root(ctx, { agent: { model: { provider: 'offline', modelId: 'scripted' } } });
const request = { type: 'input', content: 'Keep task-A-secret; prepare then effect.', requestId: 'operation-1' };
const submission = await convo.submit(request, ctx);
if (stage === 'start') fs.writeFileSync(path.join(root, 'submission.json'), JSON.stringify({ id: submission.id, conversationId: convo.id }));
else {
  const before = JSON.parse(fs.readFileSync(path.join(root, 'submission.json')));
  if (before.id !== submission.id || before.conversationId !== convo.id) throw new Error('identity or submission dedup failed');
}
const result = await submission.wait(ctx);
const view = await convo.viewState(ctx);
fs.writeFileSync(path.join(root, 'view.json'), JSON.stringify(view.value, null, 2));
view.dispose();
await harness.close(ctx);
if (result.status !== 'done') throw new Error(JSON.stringify(result));
console.log(JSON.stringify({ status: 'resumed', submission_deduplicated: true, result }));
