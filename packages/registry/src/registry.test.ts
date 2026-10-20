import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { MAX_WIRE_LENGTH, RegistryError, canonicalFromWire, createRegistry, parseName, wireName, type Artifact, type Registry, type RegistryErrorCode } from "./index.js";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const art = (version: string, content = version): Artifact => ({ version, digest: digest(content) });
const AGENT_A = "abc123";
const AGENT_B = "def456";

function fresh(): Registry {
  const registry = createRegistry();
  registry.trusted.allocateAgent(AGENT_A);
  registry.trusted.allocateAgent(AGENT_B);
  return registry;
}
const refuses = (code: RegistryErrorCode, run: () => unknown) =>
  assert.throws(run, (error: unknown) => error instanceof RegistryError && error.code === code, `expected ${code}`);

test("names: only the exact lower-case grammar parses, nothing is normalised", () => {
  assert.equal(parseName("nimblenewt.pause")?.layer, "protected");
  assert.equal(parseName("toolbox.run-tests")?.layer, "toolbox");
  assert.deepEqual([parseName(`a_${AGENT_A}.run-tests`)?.agentId, parseName(`a_${AGENT_A}.run-tests`)?.layer], [AGENT_A, "agent"]);
  for (const bad of ["", ".x", "nimblenewt.", "NimbleNewt.pause", "nimblenewt.Pause", "nimblenewt.pa_use", "nimblenewt.pause-", "nimblenewt.-pause", "nimblenewt.9lives",
    "nimblenewt.pause.again", "nimblenewt /pause", "/nimblenewt.pause", "nimblenewt.ｐause", "nimblenewt.pause\n", "a_ab.x", `a_${"x".repeat(33)}.x`, "a_ABC123.x", "agent.x", "custom.x",
    `nimblenewt.${"x".repeat(29)}`, "nimblenewt.pause\u0000", "nimblenewt.pа" /* cyrillic a */, "ŉimblenewt.x"]) {
    assert.equal(parseName(bad), null, JSON.stringify(bad));
  }
  for (const notText of [null, undefined, 5, {}, ["nimblenewt.x"], Symbol("x")]) assert.equal(parseName(notText), null);
  assert.equal(parseName("nimblenewt.x".repeat(100)), null);
});

test("wire names are provider-safe, within the length limit, and reversible without merging any two names", () => {
  const longest = `a_${"z".repeat(32)}.${"y".repeat(28)}`;
  assert.equal(wireName(longest).length, MAX_WIRE_LENGTH);
  const names = ["nimblenewt.pause", "toolbox.pause", `a_${AGENT_A}.pause`, `a_${AGENT_B}.pause`, "nimblenewt.run-tests", "nimblenewt.run", "nimblenewt.run-tests-2", longest];
  const wires = names.map(wireName);
  assert.equal(new Set(wires).size, names.length);
  for (const [i, name] of names.entries()) {
    assert.match(wires[i] as string, /^[A-Za-z0-9_-]{1,64}$/);
    assert.equal(canonicalFromWire(wires[i]), name);
  }
  // Wire spellings that this scheme never produces do not decode.
  for (const wire of ["nimblenewt_pause", "nimblenewt__", "__pause", "nimblenewt__Pause", "a___x", `a_${AGENT_A}_pause`, "toolbox__a__b", 5, null]) assert.equal(canonicalFromWire(wire), null, String(wire));
  assert.throws(() => wireName("nimblenewt.Pause"), RangeError);
});

test("a personal extension cannot register a reserved name, another agent's name, or a name in no namespace", () => {
  const registry = fresh();
  const a = registry.forAgent(AGENT_A);
  refuses("reserved_namespace", () => a.publish("nimblenewt.pause", art("1.0.0")));
  refuses("reserved_namespace", () => a.publish("toolbox.run", art("1.0.0")));
  refuses("foreign_namespace", () => a.publish(`a_${AGENT_B}.run`, art("1.0.0")));
  refuses("invalid_name", () => a.publish("pause", art("1.0.0")));
  refuses("invalid_name", () => a.publish("NimbleNewt.pause", art("1.0.0")));
  refuses("invalid_name", () => a.publish(`a_${AGENT_A.toUpperCase()}.run`, art("1.0.0")));
  refuses("invalid_name", () => a.publish("nimblenewt.pause​", art("1.0.0")));
  refuses("foreign_namespace", () => a.publish("a_zzzzzz.run", art("1.0.0")));
  refuses("unknown_agent", () => registry.trusted.publish("a_zzzzzz.run", art("1.0.0")));
  assert.deepEqual(registry.read.list(), [], "refusals changed nothing");
  assert.equal(registry.trusted.snapshot().length, 2, "only the two allocations are in the history");
  assert.equal(a.publish(`a_${AGENT_A}.run`, art("1.0.0")), "added");
});

test("a personal extension cannot replace a protected tool, before or after sealing, nor reach the trusted capability", () => {
  const registry = fresh();
  registry.trusted.publish("nimblenewt.pause", art("1.0.0", "the real pause"));
  const a = registry.forAgent(AGENT_A);
  refuses("reserved_namespace", () => a.publish("nimblenewt.pause", art("2.0.0", "shadow")));
  refuses("reserved_namespace", () => a.publish("nimblenewt.pause", art("1.0.0", "shadow")));
  assert.equal(registry.read.resolve("nimblenewt.pause").digest, digest("the real pause"));
  // Nothing an agent holds leads to the trusted capability or lets the facade be modified.
  const held: object[] = [a, registry.read, registry];
  for (const object of held) {
    assert.ok(Object.isFrozen(object));
    assert.equal(Object.getPrototypeOf(object), Object.prototype);
    assert.throws(() => { (object as Record<string, unknown>)["publish"] = () => "added"; }, TypeError);
  }
  assert.equal("trusted" in a || "trusted" in registry.read, false);
  // Methods use no `this`, so detaching or rebinding them gains nothing.
  const { publish } = a;
  refuses("reserved_namespace", () => publish.call({ agentId: "other" }, "nimblenewt.pause", art("3.0.0")));
  const resolved = registry.read.resolve("nimblenewt.pause");
  assert.ok(Object.isFrozen(resolved));
  assert.throws(() => { (resolved as { digest: string }).digest = digest("x"); }, TypeError);
});

test("no last-installed-wins: a published version is immutable, versions only increase, republishing the same content is a no-op", () => {
  const registry = fresh();
  const a = registry.forAgent(AGENT_A);
  const name = `a_${AGENT_A}.lint`;
  assert.equal(a.publish(name, art("1.2.0")), "added");
  assert.equal(a.publish(name, art("1.2.0")), "unchanged");
  refuses("version_exists", () => a.publish(name, art("1.2.0", "different bytes")));
  refuses("not_increasing", () => a.publish(name, art("1.1.9")));
  refuses("not_increasing", () => a.publish(name, art("0.9.0")));
  assert.equal(a.publish(name, art("1.10.0")), "added");
  assert.equal(registry.read.resolve(name).version, "1.10.0", "versions compare numerically, not as text");
  assert.equal(registry.read.resolve(name, "1.2.0").digest, digest("1.2.0"), "an older version stays selectable by exact version");
  for (const bad of ["1", "1.0", "01.0.0", "1.0.0-beta", "1.0.0+x", "v1.0.0", "1.0.0 ", "1.0.1234567890", "", "-1.0.0"]) refuses("invalid_version", () => a.publish(name, { version: bad, digest: digest("x") }));
  for (const bad of ["", "abc", digest("x").toUpperCase(), `${digest("x")}0`, "g".repeat(64)]) refuses("invalid_digest", () => a.publish(name, { version: "2.0.0", digest: bad }));
  refuses("invalid_input", () => a.publish(name, null as unknown as Artifact));
});

test("the protected namespace can be sealed: no new protected tool afterwards, and an agent still cannot add one", () => {
  const registry = fresh();
  registry.trusted.publish("nimblenewt.pause", art("1.0.0"));
  registry.trusted.sealProtected();
  registry.trusted.sealProtected();
  refuses("sealed", () => registry.trusted.publish("nimblenewt.resume", art("1.0.0")));
  refuses("sealed", () => registry.trusted.publish("nimblenewt.pause", art("1.1.0")));
  assert.equal(registry.trusted.publish("nimblenewt.pause", art("1.0.0")), "unchanged", "an exact repeat is still harmless");
  assert.equal(registry.trusted.publish("toolbox.share", art("1.0.0")), "added", "the shared toolbox is not sealed");
  assert.equal(registry.trusted.snapshot().filter((o) => o.op === "seal").length, 1);
});

test("agent ids come from the controller, can be retired, and are never reused", () => {
  const registry = createRegistry();
  refuses("unknown_agent", () => registry.forAgent(AGENT_A));
  refuses("invalid_input", () => registry.trusted.allocateAgent("Nope"));
  registry.trusted.allocateAgent(AGENT_A);
  refuses("agent_exists", () => registry.trusted.allocateAgent(AGENT_A));
  const a = registry.forAgent(AGENT_A);
  a.publish(`a_${AGENT_A}.run`, art("1.0.0"));
  registry.trusted.retireAgent(AGENT_A);
  refuses("retired_agent", () => a.publish(`a_${AGENT_A}.run`, art("2.0.0")));
  refuses("retired_agent", () => registry.forAgent(AGENT_A));
  refuses("retired_agent", () => registry.trusted.allocateAgent(AGENT_A));
  refuses("retired_agent", () => registry.trusted.publish(`a_${AGENT_A}.other`, art("1.0.0")));
  assert.equal(registry.read.resolve(`a_${AGENT_A}.run`).version, "1.0.0", "history stays readable");
  refuses("unknown_agent", () => registry.trusted.retireAgent("zzzzzz"));
});

test("two agents with the same command name keep distinct canonical and wire names", () => {
  const registry = fresh();
  registry.forAgent(AGENT_A).publish(`a_${AGENT_A}.run-tests`, art("1.0.0", "A's"));
  registry.forAgent(AGENT_B).publish(`a_${AGENT_B}.run-tests`, art("1.0.0", "B's"));
  const [x, y] = [registry.read.resolve(`a_${AGENT_A}.run-tests`), registry.read.resolve(`a_${AGENT_B}.run-tests`)];
  assert.notEqual(x.wireName, y.wireName);
  assert.notEqual(x.digest, y.digest);
  assert.equal(registry.read.fromWire(x.wireName), `a_${AGENT_A}.run-tests`);
  assert.equal(registry.read.fromWire("run-tests"), null, "a bare friendly name resolves to nothing");
  assert.equal(registry.read.fromWire(wireName("toolbox.run-tests")), null, "a valid wire name that is not registered resolves to nothing");
});

test("selection: the highest live version, an exact version, and refusal when everything is revoked", () => {
  const registry = fresh();
  registry.trusted.publish("toolbox.fmt", art("1.0.0"));
  registry.trusted.publish("toolbox.fmt", art("1.1.0"));
  registry.trusted.publish("toolbox.fmt", art("2.0.0"));
  registry.trusted.revoke("toolbox.fmt", "2.0.0", "bad release");
  assert.equal(registry.read.resolve("toolbox.fmt").version, "1.1.0", "a revoked version is skipped for new selections");
  refuses("revoked", () => registry.read.resolve("toolbox.fmt", "2.0.0"));
  refuses("unknown_version", () => registry.read.resolve("toolbox.fmt", "3.0.0"));
  refuses("unknown_entry", () => registry.read.resolve("toolbox.missing"));
  refuses("invalid_name", () => registry.read.resolve("fmt"));
  registry.trusted.revoke("toolbox.fmt", "1.0.0", "old");
  registry.trusted.revoke("toolbox.fmt", "1.1.0", "old");
  registry.trusted.revoke("toolbox.fmt", "1.1.0", "again");
  refuses("no_version", () => registry.read.resolve("toolbox.fmt"));
  assert.deepEqual(registry.read.list(), [], "a fully revoked name is not offered");
  assert.equal(registry.trusted.publish("toolbox.fmt", art("3.0.0")), "added", "a new version can follow a revoked one");
  assert.equal(registry.read.resolve("toolbox.fmt").version, "3.0.0");
  refuses("unknown_version", () => registry.trusted.revoke("toolbox.fmt", "9.9.9", "x"));
  refuses("invalid_input", () => registry.trusted.revoke("toolbox.fmt", "3.0.0", ""));
});

test("a paused attempt restores its pinned versions even after newer ones appear", () => {
  const registry = fresh();
  registry.trusted.publish("nimblenewt.desk", art("1.0.0"));
  registry.trusted.publish("toolbox.fmt", art("1.0.0"));
  const pins = registry.read.pin(["toolbox.fmt", "nimblenewt.desk", "toolbox.fmt"]);
  assert.deepEqual(pins.pins.map((p) => p.canonical), ["nimblenewt.desk", "toolbox.fmt"], "sorted and de-duplicated");
  const stored = JSON.parse(JSON.stringify(pins));
  registry.trusted.publish("toolbox.fmt", art("2.0.0"));
  registry.trusted.publish("nimblenewt.desk", art("1.5.0"));
  const restored = registry.read.restore(stored);
  assert.equal(restored.status, "restored");
  if (restored.status === "restored") assert.deepEqual(restored.selections.map((s) => [s.canonical, s.version]), [["nimblenewt.desk", "1.0.0"], ["toolbox.fmt", "1.0.0"]]);
  assert.equal(registry.read.resolve("toolbox.fmt").version, "2.0.0", "new work gets the new version");
});

test("a paused attempt blocks, and is never given another version, when a pinned version is revoked, changed or gone", () => {
  const registry = fresh();
  registry.trusted.publish("toolbox.fmt", art("1.0.0"));
  registry.trusted.publish("toolbox.lint", art("1.0.0"));
  const stored = JSON.parse(JSON.stringify(registry.read.pin(["toolbox.fmt", "toolbox.lint"])));
  registry.trusted.publish("toolbox.fmt", art("1.1.0"));
  registry.trusted.revoke("toolbox.fmt", "1.0.0", "vulnerable");
  const blocked = registry.read.restore(stored);
  assert.equal(blocked.status, "blocked");
  if (blocked.status === "blocked") assert.deepEqual(blocked.reasons.map((r) => [r.code, r.canonical, r.version]), [["revoked", "toolbox.fmt", "1.0.0"]]);
  // The same pins against a registry that lost an entry, or holds different bytes under the same version.
  const other = createRegistry();
  other.trusted.publish("toolbox.fmt", art("1.0.0", "tampered"));
  const against = other.read.restore(stored);
  assert.equal(against.status, "blocked");
  if (against.status === "blocked") assert.deepEqual(against.reasons.map((r) => [r.code, r.canonical]), [["digest_mismatch", "toolbox.fmt"], ["missing", "toolbox.lint"]]);
});

test("a pin set that is inconsistent or malformed is rejected, whatever it contains; the digest is a checksum, not a signature", () => {
  const registry = fresh();
  registry.trusted.publish("toolbox.fmt", art("1.0.0"));
  registry.trusted.publish("toolbox.fmt", art("1.1.0"));
  const good = JSON.parse(JSON.stringify(registry.read.pin(["toolbox.fmt"])));
  const blockedWith = (value: unknown) => {
    const result = registry.read.restore(value);
    assert.equal(result.status, "blocked");
    return result.status === "blocked" ? result.reasons.map((r) => r.code) : [];
  };
  assert.deepEqual(blockedWith({ ...good, pins: [{ ...good.pins[0], version: "1.0.0", digest: digest("1.0.0") }] }), ["invalid_pin_set"], "edited pins no longer match the digest");
  assert.deepEqual(blockedWith({ ...good, digest: digest("x") }), ["invalid_pin_set"]);
  assert.deepEqual(blockedWith({ ...good, schema: 2 }), ["invalid_pin_set"]);
  for (const bad of [null, undefined, 5, "x", [], {}, { schema: 1 }, { schema: 1, pins: "x", digest: "x" }, { schema: 1, pins: [null], digest: "x" }, { schema: 1, pins: [{ canonical: "x" }], digest: "x" },
    { schema: 1, pins: new Array(1001).fill(good.pins[0]), digest: "x" }]) assert.deepEqual(blockedWith(bad), ["invalid_pin_set"]);
  assert.equal(registry.read.restore(good).status, "restored", "the untouched pin set still restores");
  // Documented limit: whoever can write a stored pin set can recompute the plain digest and select another registered version.
  const pins1 = [{ canonical: "toolbox.fmt", version: "1.0.0", digest: digest("1.0.0") }];
  const reissued = { schema: 1, pins: pins1, digest: createHash("sha256").update(JSON.stringify(pins1.map((p) => [p.canonical, p.version, p.digest]))).digest("hex") };
  const accepted = registry.read.restore(reissued);
  assert.equal(accepted.status, "restored");
  if (accepted.status === "restored") assert.equal(accepted.selections[0]?.digest, digest("1.0.0"), "still the registered content of an existing version, never anything else");
  refuses("invalid_input", () => registry.read.pin("toolbox.fmt" as unknown as string[]));
  refuses("unknown_entry", () => registry.read.pin(["toolbox.nope"]));
});

test("the protected set is verified against expected digests: missing, changed, extra or revoked tools are reported", () => {
  const registry = fresh();
  registry.trusted.publish("nimblenewt.desk", art("1.0.0", "desk"));
  registry.trusted.publish("nimblenewt.pause", art("1.0.0", "pause"));
  const expected = { "nimblenewt.desk": digest("desk"), "nimblenewt.pause": digest("pause") };
  assert.deepEqual(registry.read.verifyReserved(expected), []);
  assert.deepEqual(registry.read.verifyReserved({ ...expected, "nimblenewt.pause": digest("other") }).map((p) => [p.canonical, p.code]), [["nimblenewt.pause", "digest_mismatch"]]);
  assert.deepEqual(registry.read.verifyReserved({ "nimblenewt.desk": digest("desk") }).map((p) => [p.canonical, p.code]), [["nimblenewt.pause", "unexpected"]]);
  assert.deepEqual(registry.read.verifyReserved({ ...expected, "nimblenewt.gone": digest("x") }).map((p) => [p.canonical, p.code]), [["nimblenewt.gone", "missing"]]);
  assert.deepEqual(registry.read.verifyReserved({ ...expected, "toolbox.x": digest("x") }).map((p) => [p.canonical, p.code]), [["toolbox.x", "unexpected"]]);
  registry.trusted.revoke("nimblenewt.pause", "1.0.0", "compromised");
  assert.deepEqual(registry.read.verifyReserved(expected).map((p) => [p.canonical, p.code]), [["nimblenewt.pause", "revoked"]]);
});

test("the history rebuilds an identical registry through the same rules, and a history that breaks them is refused", () => {
  const registry = fresh();
  registry.trusted.publish("nimblenewt.desk", art("1.0.0"));
  registry.trusted.sealProtected();
  registry.forAgent(AGENT_A).publish(`a_${AGENT_A}.run`, art("1.0.0"));
  registry.forAgent(AGENT_A).publish(`a_${AGENT_A}.run`, art("1.1.0"));
  registry.trusted.revoke(`a_${AGENT_A}.run`, "1.1.0", "oops");
  registry.trusted.retireAgent(AGENT_B);
  const history = JSON.parse(JSON.stringify(registry.trusted.snapshot()));
  const rebuilt = createRegistry(history);
  assert.deepEqual(rebuilt.read.list(), registry.read.list());
  assert.deepEqual(rebuilt.trusted.snapshot(), registry.trusted.snapshot());
  refuses("sealed", () => rebuilt.trusted.publish("nimblenewt.new", art("1.0.0")));
  refuses("retired_agent", () => rebuilt.trusted.allocateAgent(AGENT_B));
  const pins = registry.read.pin(["nimblenewt.desk"]);
  assert.equal(rebuilt.read.restore(JSON.parse(JSON.stringify(pins))).status, "restored");
  // Tampered histories: an agent tool without an allocation, a shadowed protected tool after the seal, a changed version, junk.
  const op = (o: object) => o as never;
  refuses("unknown_agent", () => createRegistry([op({ op: "publish", canonical: `a_${AGENT_A}.run`, version: "1.0.0", digest: digest("x") })]));
  refuses("sealed", () => createRegistry([...history, op({ op: "publish", canonical: "nimblenewt.evil", version: "1.0.0", digest: digest("x") })]));
  refuses("version_exists", () => createRegistry([...history, op({ op: "publish", canonical: "nimblenewt.desk", version: "1.0.0", digest: digest("evil") })]));
  refuses("invalid_input", () => createRegistry([op({ op: "format-disk" })]));
  refuses("invalid_input", () => createRegistry([null as never]));
  assert.equal(rebuilt.trusted.snapshot().length, history.length, "replay did not duplicate history entries");
});

test("hostile inputs fail as registry errors and never echo more than a short preview", () => {
  const registry = fresh();
  const huge = "x".repeat(100000);
  try {
    registry.read.resolve(huge);
    assert.fail("should refuse");
  } catch (error) {
    assert.ok(error instanceof RegistryError);
    assert.ok((error as Error).message.length < 200);
  }
  for (const input of [undefined, null, 5, {}, [], Symbol("s"), () => 1]) {
    assert.throws(() => registry.read.resolve(input as never), RegistryError);
    assert.throws(() => registry.trusted.publish(input as never, art("1.0.0")), RegistryError);
    assert.equal(registry.read.has(input as never), false);
  }
  const proto = JSON.parse('{"version":"1.0.0","digest":"' + digest("p") + '","__proto__":{"polluted":true}}');
  registry.trusted.publish("toolbox.proto", proto);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    assert.equal(registry.read.has(key), false);
    assert.equal(registry.read.fromWire(key), null);
  }
  assert.deepEqual(registry.read.verifyReserved(JSON.parse('{"__proto__":{"x":1}}')).map((p) => [p.canonical, p.code]), [["__proto__", "unexpected"]], "an own __proto__ key is just an unexpected name");
});
