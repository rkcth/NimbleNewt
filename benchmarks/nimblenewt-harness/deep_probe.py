"""Offline Deep Agents recovery probe. Invoked by run_probes.py."""
import json
import os
import signal
import sqlite3
import sys
from pathlib import Path
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.types import Command
from deepagents import create_deep_agent

root = Path(sys.argv[1])
scenario, stage = sys.argv[2:4]
root.mkdir(parents=True, exist_ok=True)

def log(name, value):
    with (root / name).open('a') as f:
        f.write(json.dumps(value) + '\n')
        f.flush()
        os.fsync(f.fileno())

class ScriptedModel(BaseChatModel):
    @property
    def _llm_type(self):
        return 'nimblenewt-offline-probe'
    def bind_tools(self, tools, **kwargs):
        return self
    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        log('model.jsonl', [{'type': m.type, 'content': m.content} for m in messages])
        completed = {m.name for m in messages if isinstance(m, ToolMessage)}
        name = 'prepare' if 'prepare' not in completed else ('effect' if 'effect' not in completed else None)
        response = AIMessage(content='finished' if name is None else '', tool_calls=[] if name is None else [{'name': name, 'args': {}, 'id': 'call-' + name, 'type': 'tool_call'}])
        return ChatResult(generations=[ChatGeneration(message=response)])

def prepare() -> str:
    """Record a completed prerequisite."""
    log('prepare.jsonl', {'prepared': True})
    return 'prepared'

def effect() -> str:
    """Perform the fake external action."""
    log('attempts.jsonl', {'stage': stage})
    if scenario == 'idempotent':
        with sqlite3.connect(root / 'external.sqlite') as db:
            db.execute('CREATE TABLE IF NOT EXISTS effects (id TEXT PRIMARY KEY)')
            db.execute('INSERT OR IGNORE INTO effects VALUES (?)', ('operation-1',))
    else:
        log('effects.jsonl', {'effect': 'operation-1'})
    if stage == 'start' and scenario != 'approval':
        os.kill(os.getpid(), signal.SIGKILL)
    return 'effect completed'

with SqliteSaver.from_conn_string(str(root / 'checkpoints.sqlite')) as saver:
    agent = create_deep_agent(model=ScriptedModel(), tools=[prepare, effect], checkpointer=saver,
                              interrupt_on={'effect': True} if scenario == 'approval' else None)
    config = {'configurable': {'thread_id': 'task-A'}}
    if stage == 'start':
        result = agent.invoke({'messages': [{'role': 'user', 'content': 'Keep task-A-secret; prepare then effect.'}]}, config, durability='sync')
        assert '__interrupt__' in result, result
        assert not (root / 'attempts.jsonl').exists()
        print(json.dumps({'status': 'approval_suspended', 'next': agent.get_state(config).next}))
    else:
        payload = Command(resume={'decisions': [{'type': 'approve'}]}) if scenario == 'approval' else None
        result = agent.invoke(payload, config, durability='sync')
        assert result['messages'][-1].content == 'finished'
        assert 'task-A-secret' in str(result['messages'][0].content)
        # A meeting has an independent durable thread; returning to A preserves A.
        meeting = {'configurable': {'thread_id': 'meeting-B'}}
        agent.update_state(meeting, {'messages': [{'role': 'user', 'content': 'meeting-B-secret'}]})
        a = str(agent.get_state(config).values['messages'])
        b = str(agent.get_state(meeting).values['messages'])
        assert 'meeting-B-secret' not in a and 'task-A-secret' not in b
        print(json.dumps({'status': 'resumed', 'messages': len(result['messages']), 'thread_isolation': True}))
