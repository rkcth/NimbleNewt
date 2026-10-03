"""Run actual subprocess-kill/reopen tests with fake models and fake external effects.
Usage: python run_probes.py --python /path/to/venv/bin/python --pi-dir /path/to/npm/project --output /new/output/directory
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--python', required=True)
parser.add_argument('--pi-dir', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=False)
source = Path(__file__).resolve().parent
shutil.copy2(source / 'pi_probe.mjs', args.pi_dir / 'pi_probe.mjs')
node = shutil.which('node')
assert node
# Do not inherit provider credentials, telemetry config, or the user's home configuration.
env = { 'PATH': os.environ['PATH'], 'HOME': str(args.output / 'home'), 'LANGSMITH_TRACING': 'false', 'LANGCHAIN_TRACING_V2': 'false', 'PYTHONUNBUFFERED': '1' }
Path(env['HOME']).mkdir()

def lines(file):
    return len(file.read_text().splitlines()) if file.exists() else 0

results = []
for framework, scenarios in [('deepagents', ['approval', 'plain', 'idempotent']), ('pi-durable', ['unsafe', 'safe', 'idempotent'])]:
    for scenario in scenarios:
        directory = args.output / f'{framework}-{scenario}'
        directory.mkdir()
        command = [args.python, str(source / 'deep_probe.py')] if framework == 'deepagents' else [node, str(args.pi_dir / 'pi_probe.mjs')]
        stages = []
        for stage in ['start', 'resume']:
            proc = subprocess.run(command + [str(directory), scenario, stage], env=env, capture_output=True, text=True, timeout=45)
            (directory / f'{stage}.stdout').write_text(proc.stdout)
            (directory / f'{stage}.stderr').write_text(proc.stderr)
            stages.append({'stage': stage, 'returncode': proc.returncode, 'stdout': proc.stdout.strip()})
            expected = 0 if stage == 'resume' or scenario == 'approval' else -9
            assert proc.returncode == expected, (framework, scenario, stage, proc.returncode, proc.stderr, proc.stdout)
        if scenario == 'idempotent':
            with sqlite3.connect(directory / 'external.sqlite') as db:
                effects = db.execute('SELECT COUNT(*) FROM effects').fetchone()[0]
        else:
            effects = lines(directory / 'effects.jsonl')
        attempts = lines(directory / 'attempts.jsonl')
        expected_attempts = 1 if scenario in ['approval', 'unsafe'] else 2
        expected_effects = 2 if scenario in ['plain', 'safe'] else 1
        assert attempts == expected_attempts and effects == expected_effects, (framework, scenario, attempts, effects)
        assert lines(directory / 'prepare.jsonl') == 1, 'Completed prerequisite repeated'
        if scenario == 'unsafe':
            assert 'interrupted' in (directory / 'view.json').read_text().lower()
        row = {'framework': framework, 'scenario': scenario, 'attempts': attempts, 'effects': effects, 'completed_prerequisite_runs': 1, 'stages': stages}
        results.append(row)
        print(json.dumps(row), flush=True)
(args.output / 'results.json').write_text(json.dumps(results, indent=2))
shutil.copy2(source / 'pi_controls.mjs', args.pi_dir / 'pi_controls.mjs')
controls = args.output / 'pi-controls'
proc = subprocess.run([node, str(args.pi_dir / 'pi_controls.mjs'), str(controls)], env=env, capture_output=True, text=True, timeout=45)
controls.mkdir(exist_ok=True)
(controls / 'stdout.log').write_text(proc.stdout)
(controls / 'stderr.log').write_text(proc.stderr)
assert proc.returncode == 0, proc.stderr
print(proc.stdout.strip())
