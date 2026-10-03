# Relay harness probes

Isolated, offline experiments for the [Relay harness assessment](../../docs/relay/harness-test-results.md). These use installed harness code, deterministic fake models, SQLite, and fake external effects. Five recovery scenarios deliberately kill their own worker with SIGKILL after committing a fake effect but before returning its result. The approval scenario exits normally and resumes in a new process. The runner itself is not killed.

Do not run this against production state. Use a fresh scratch directory; the runner refuses to reuse its output directory. No live model credentials are needed. No project service or inference server is called. The child process environment omits inherited credentials and uses a scratch home directory.

Verified October 3, 2026 on macOS arm64 with Python 3.12.14 and Node 22.23.2:

- Deep Agents 0.7.21, LangGraph 1.2.12, SQLite checkpointer 3.1.1.
- Pi Durable 1.0.1; full dependency versions in the lockfiles.
- Six recovery scenarios and one Pi runtime-controls suite. Expected duplication in deliberately unprotected cases is asserted, not counted as a production safety pass.

Relay requires macOS, Linux, and Windows support. This initial probe suite is not yet a cross-platform qualification suite: it uses POSIX SIGKILL, expects exit code `-9`, and documents POSIX shell commands. Linux execution is unverified; Windows needs adapted termination, environment setup, and installation instructions. Required crash/recovery assertions must be preserved when making the suite portable, not skipped. See the [platform requirements](../../docs/relay/portability-and-configuration.md#required-operating-system-support).

## Reproduce

From the repository root, with Python 3.12 and Node >=22.19 available:

```sh
RELAY_PROBE_DIR=$(mktemp -d /tmp/relay-probe.XXXXXX)
python3.12 -m venv "$RELAY_PROBE_DIR/venv"
"$RELAY_PROBE_DIR/venv/bin/python" -m pip install -r benchmarks/relay-harness/requirements.lock
mkdir "$RELAY_PROBE_DIR/pi"
cp benchmarks/relay-harness/package.json benchmarks/relay-harness/package-lock.json "$RELAY_PROBE_DIR/pi/"
npm ci --ignore-scripts --prefix "$RELAY_PROBE_DIR/pi"
"$RELAY_PROBE_DIR/venv/bin/python" benchmarks/relay-harness/run_probes.py \
  --python "$RELAY_PROBE_DIR/venv/bin/python" \
  --pi-dir "$RELAY_PROBE_DIR/pi" \
  --output "$RELAY_PROBE_DIR/results"
```

The script copies Pi probes beside the temporary npm dependencies. Models are scripted; token quality, real provider protocols, and billing are outside the experiment. Each subprocess has a 45-second timeout. The runtime-control suite waits on an explicit tool-start signal rather than a timing guess.

`results.json` records recovery counts and subprocess exits. Per-scenario SQLite files, stdout/stderr, synthetic model inputs, and Pi views remain in the output directory for inspection. `pi-controls/results.json` records runtime-control assertions. The checked-in `recorded-2026-10-03/` contains the final summary outputs, not a production transcript.

The fake external service uses a separate SQLite database with a unique operation ID for the idempotent cases. That demonstrates a service-side deduplication pattern; it does not demonstrate that an arbitrary external API supports it. Thread separation is logical context separation, not an authorization boundary. No host reboot, power failure, real background process recovery, compression integration, or multi-process ownership race is exercised.
