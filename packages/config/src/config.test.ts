import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { inspect } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  CURRENT_CONFIG_VERSION, DEFAULT_LIMITS, Secret, describeConfig, directorySecrets, environmentSecrets, exportProfile, formatErrors, importProfile,
  loadConfig, memorySecrets, migrateConfig, resolveSecrets, secretReferences, validateConfig, type ConfigMigration, type NimbleNewtConfig,
} from "./index.js";

const example = (name: string): string => readFileSync(fileURLToPath(new URL(`../examples/${name}.example.json`, import.meta.url)), "utf8");
const parsed = (name: string) => JSON.parse(example(name)) as Record<string, any>;
const messages = (result: ReturnType<typeof loadConfig>): string[] => (result.ok ? [] : result.errors.map((e) => (e.path === "" ? e.message : `${e.path}: ${e.message}`)));
const loadOk = (doc: unknown): NimbleNewtConfig => { const r = loadConfig(doc); assert.ok(r.ok, formatErrors(r.ok ? [] : r.errors)); return r.config; };

// ------------------------------------------------------------------------------------------------ examples

test("the public and private example profiles load, with defaults filled in", () => {
  const pub = loadOk(example("public"));
  assert.equal(pub.profile, "public");
  assert.deepEqual(pub.limits, DEFAULT_LIMITS);
  assert.deepEqual([pub.execution.isolation, pub.api.remoteExposure, pub.approvals.preset, pub.approvals.grants], ["strong", false, "derived", []]);
  const priv = loadOk(example("private"));
  assert.equal(priv.profile, "private");
  assert.equal(priv.approvals.grants.some((g) => g.visibility === "private"), true);
});

test("the approval preset is derived by default, strict and autonomous are options, and the old name tight keeps its meaning as strict", () => {
  const base = parsed("public");
  for (const preset of ["derived", "strict", "autonomous"]) assert.equal(loadOk({ ...base, approvals: { preset, grants: [] } }).approvals.preset, preset);
  assert.equal(loadOk({ ...base, approvals: { grants: [] } }).approvals.preset, "derived");
  assert.equal(loadOk({ ...base, approvals: { preset: "tight", grants: [] } }).approvals.preset, "strict", "an old document never becomes looser");
  assert.ok(messages(loadConfig({ ...base, approvals: { preset: "loose", grants: [] } })).some((m) => m.startsWith("approvals.preset")));
});

test("the public example enables nothing that costs money or needs a credential", () => {
  const pub = loadOk(example("public"));
  for (const [name, provider] of Object.entries(pub.models.providers)) {
    if (provider.paid) assert.equal(provider.enabled, false, `${name} is paid and must be disabled`);
  }
  assert.equal(Object.values(pub.models.providers).filter((p) => p.enabled).every((p) => p.adapter === "fake"), true);
  assert.equal(example("public").includes("sk-"), false);
});

// ------------------------------------------------------------------------------- clear failure messages

test("problems are reported with their path, all at once, and misspelled settings get a suggestion", () => {
  const doc = parsed("public");
  doc.limits = { productiveAttempts: 0, perhost: 2 };
  doc.models.providers.fake.enabled = "yes";
  delete doc.installation.name;
  doc.contollr = {};
  const found = messages(loadConfig(doc));
  assert.ok(found.includes('limits.productiveAttempts: must be at least 1, found 0'), found.join("\n"));
  assert.ok(found.includes('limits.perhost: unknown setting "perhost" (did you mean "perHost"?)'), found.join("\n"));
  assert.ok(found.includes("models.providers.fake.enabled: expected true or false, found a string"), found.join("\n"));
  assert.ok(found.includes('installation.name: missing required setting "name"'), found.join("\n"));
  assert.ok(found.includes('contollr: unknown setting "contollr" (did you mean "controller"?)'), found.join("\n"));
});

test("wrong shapes at any depth say what was expected and what was found", () => {
  const cases: readonly [string, (d: Record<string, any>) => void, string][] = [
    ["storage kind", (d) => { d.controller.storage.kind = "mysql"; }, 'controller.storage.kind: "kind" must be one of "sqlite", "postgres"'],
    ["isolation", (d) => { d.execution = { isolation: "loose" }; }, 'execution.isolation: expected one of "strong", "trusted-host", found a string'],
    ["list", (d) => { d.models.difficulty.simple = "fake/scripted"; }, "models.difficulty.simple: expected a list, found a string"],
    ["route", (d) => { d.models.difficulty.simple = ["scripted"]; }, 'models.difficulty.simple[0]: must look like "provider/model"'],
    ["provider name", (d) => { d.models.providers["bad name"] = d.models.providers.fake; }, "models.providers.bad name: \"bad name\" is not a valid name"],
    ["whole number", (d) => { d.limits = { inquirySlots: 1.5 }; }, "limits.inquirySlots: expected a whole number, found a number"],
    ["not an object", (d) => { d.models = []; }, "models: expected an object, found an array"],
    ["endpoint with a password", (d) => { d.models.providers["example-cloud"].endpoint = "https://user:pw@host.invalid/v1"; }, "looks like a URL with a password in it"],
    ["endpoint with a user name", (d) => { d.models.providers["example-cloud"].endpoint = "https://user@host.invalid/v1"; }, "must be an http(s) URL without embedded credentials"],
    ["endpoint that is not http", (d) => { d.models.providers["example-cloud"].endpoint = "ftp://host.invalid/v1"; }, "must be an http(s) URL without embedded credentials"],
  ];
  for (const [label, edit, expected] of cases) {
    const doc = parsed("public");
    edit(doc);
    const found = messages(loadConfig(doc)).join("\n");
    assert.ok(found.includes(expected), `${label}: expected "${expected}" in:\n${found}`);
  }
});

test("a JSON syntax error points at the line and column", () => {
  const text = '{\n  "configVersion": 1,\n  "profile": "public",\n  "installation": { "name": "x", },\n}';
  const found = messages(loadConfig(text));
  assert.equal(found.length, 1);
  assert.match(found[0]!, /^not valid JSON at line \d+, column \d+/);
  assert.deepEqual(messages(loadConfig("")).length, 1);
  assert.match(messages(loadConfig("[]"))[0]!, /must be an object/);
  assert.match(messages(loadConfig("null"))[0]!, /must be an object/);
});

test("cross-setting mistakes are caught: unknown or unlisted routes, duplicate routes, unreachable providers, impossible limits", () => {
  const doc = parsed("public");
  doc.models.difficulty.simple = ["ghost/model"];
  doc.models.difficulty.medium = ["fake/not-listed"];
  doc.models.difficulty.demanding = ["fake/scripted", "fake/scripted"];
  doc.models.providers.reachable = { adapter: "openai-compatible", enabled: true, paid: false, models: [] };
  doc.limits = { productiveAttempts: 2, perHost: 3 };
  const found = messages(loadConfig(doc)).join("\n");
  assert.match(found, /models\.difficulty\.simple\[0\]: route "ghost\/model" names unknown provider "ghost"/);
  assert.match(found, /models\.difficulty\.medium\[0\]: provider "fake" does not list model "not-listed"/);
  assert.match(found, /models\.difficulty\.demanding: lists the same route twice/);
  assert.match(found, /models\.providers\.reachable: is enabled but names neither an endpoint nor a credential/);
  assert.match(found, /limits\.perHost: cannot exceed limits\.productiveAttempts/);
});

test("trusted-host execution needs a named authorizer and a reason, and strong isolation must not carry one", () => {
  const priv = parsed("private");
  delete priv.execution.trustedHost;
  assert.match(messages(loadConfig(priv)).join("\n"), /execution\.trustedHost: is required when isolation is "trusted-host"/);
  const strong = parsed("private");
  strong.execution = { isolation: "strong", trustedHost: { authorizedBy: "someone", reason: "leftover" } };
  assert.match(messages(loadConfig(strong)).join("\n"), /execution\.trustedHost: is set but isolation is "strong"/);
});

// --------------------------------------------------------------------------------- unsupported versions

test("a configuration from a newer NimbleNewt, or with a missing or invalid version, is refused with a clear reason", () => {
  const newer = { ...parsed("public"), configVersion: CURRENT_CONFIG_VERSION + 1 };
  assert.match(messages(loadConfig(newer))[0]!, /configVersion: is 2, newer than this version of NimbleNewt understands \(1\)/);
  for (const bad of [undefined, 0, -1, 1.5, "1", null]) {
    const doc = { ...parsed("public"), configVersion: bad };
    assert.match(messages(loadConfig(doc))[0]!, /^configVersion: missing or invalid/, String(bad));
  }
  assert.ok(!validateConfig({ ...parsed("public"), configVersion: 2 }).ok);
});

// ------------------------------------------------------------------------------------------- migrations

const stepUp = (from: number, add: string): ConfigMigration => ({ from, to: from + 1, migrate: (d) => ({ ...d, [add]: true }) });

test("migrations run one step at a time, in order, without touching the input (synthetic chain: no older layout exists yet)", () => {
  const input = { configVersion: 1, name: "old" };
  const frozen = JSON.stringify(input);
  const result = migrateConfig(input, [stepUp(1, "two"), stepUp(2, "three")], 3);
  assert.ok(result.ok);
  assert.deepEqual([result.document, result.fromVersion, result.steps], [{ configVersion: 3, name: "old", two: true, three: true }, 1, 2]);
  assert.equal(JSON.stringify(input), frozen, "the stored original was modified");
  assert.equal((migrateConfig({ configVersion: 3 }, [], 3) as { steps: number }).steps, 0);
});

test("a missing step, a failing step and a newer version leave the original alone and say why", () => {
  const input = { configVersion: 1, name: "old" };
  const frozen = JSON.stringify(input);
  const gap = migrateConfig(input, [stepUp(2, "three")], 3);
  assert.ok(!gap.ok && /no migration from configuration version 1 to 2/.test(gap.errors[0]!.message));
  const failing = migrateConfig(input, [{ from: 1, to: 2, migrate: (d) => { (d as any).mutated = true; throw new Error("boom"); } }], 2);
  assert.ok(!failing.ok && /migration from version 1 to 2 failed \(boom\); the original document was not changed/.test(failing.errors[0]!.message));
  assert.equal(JSON.stringify(input), frozen, "a failing migration changed its input");
  assert.ok(!migrateConfig({ configVersion: 9 }, [], 3).ok);
});

test("loadConfig applies a migration, reports that it did, and validates the result", () => {
  const legacy = { ...parsed("public"), configVersion: 0 };
  assert.ok(!loadConfig(legacy).ok, "version 0 is not a valid version");
  const doc = parsed("public");
  const res = loadConfig({ ...doc, configVersion: 1 });
  assert.ok(res.ok && !res.migrated && res.fromVersion === 1);
  const migrated = loadConfig({ ...doc, configVersion: 1, legacyName: "x" }, [stepUp(1, "added")]);
  assert.ok(!migrated.ok, "an unknown setting from the migration or the document is still rejected");
});

// ------------------------------------------------------------------------------------------------ secrets

const SECRETS = [
  "sk-abcdefghijklmnopqrstuvwxyz0123456789",
  "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  "AKIAABCDEFGHIJKLMNOP",
  "-----BEGIN RSA PRIVATE KEY-----\nMIIE",
  "xoxb-1234567890-abcdefghij",
  "postgres://admin:hunter2password@db.internal/nimblenewt",
];

test("secrets written into a configuration are refused by path, and the message never repeats the secret", () => {
  for (const secret of SECRETS) {
    for (const place of ["installation.name", "models.providers.fake.endpoint", "approvals.grants"] as const) {
      const doc = parsed("private");
      if (place === "installation.name") doc.installation.name = secret;
      else if (place === "models.providers.fake.endpoint") doc.models.providers.local.endpoint = secret;
      else doc.approvals.grants.push({ id: "x", action: secret, scope: "s", visibility: "public" });
      const res = loadConfig(doc);
      assert.ok(!res.ok, `${secret.slice(0, 8)}… in ${place} was accepted`);
      const text = JSON.stringify(res.ok ? [] : res.errors);
      assert.equal(text.includes(secret), false, "the error repeated the secret");
      assert.equal(text.includes(secret.slice(0, 12)), false, "the error repeated part of the secret");
      assert.match(text, /secrets must never be written into configuration/);
    }
  }
});

test("a string where a secret reference belongs is refused without echoing it, and reference names are checked", () => {
  const doc = parsed("public");
  doc.models.providers["example-cloud"].credential = "my-plain-password";
  const found = JSON.stringify(loadConfig(doc));
  assert.match(found, /secrets must never be written into configuration, only the name of a secret held in the secret store/);
  assert.equal(found.includes("my-plain-password"), false);
  doc.models.providers["example-cloud"].credential = { secret: "../../etc/passwd" };
  assert.match(messages(loadConfig(doc)).join("\n"), /credential\.secret: the secret name must start with a letter/);
  doc.models.providers["example-cloud"].credential = { secret: "ok", extra: 1 };
  assert.match(messages(loadConfig(doc)).join("\n"), /expected a secret reference/);
});

test("references are listed by name and use; resolution reports everything missing by name, never by value", async () => {
  const config = loadOk(example("private"));
  const refs = secretReferences(config);
  assert.deepEqual(refs.map((r) => [r.name, r.usedBy]), [["controller.database-url", "controller.storage.url"], ["example-cloud.api-key", "models.providers.example-cloud.credential"]]);
  const none = await resolveSecrets(config, memorySecrets({}));
  assert.ok(!none.ok && none.missing.length === 2);
  const partial = await resolveSecrets(config, memorySecrets({ "controller.database-url": "postgres://x" }));
  assert.ok(!partial.ok && partial.missing.map((m) => m.name).join() === "example-cloud.api-key");
  const all = await resolveSecrets(config, memorySecrets({ "controller.database-url": "postgres://u:p@h/db", "example-cloud.api-key": "key-value-123" }));
  assert.ok(all.ok);
  assert.equal(all.secrets.get("example-cloud.api-key")?.reveal(), "key-value-123");
});

test("a disabled provider's credential is not required", async () => {
  const config = loadOk(example("public"));
  assert.deepEqual(secretReferences(config).map((r) => r.name), ["example-cloud.api-key"]);
  assert.ok((await resolveSecrets(config, memorySecrets({}))).ok);
});

test("a resolved secret cannot be printed or serialized by accident", async () => {
  const value = "super-secret-value-9f3a";
  const secret = new Secret(value);
  for (const shown of [String(secret), `${secret}`, JSON.stringify(secret), JSON.stringify({ nested: { secret } }), inspect(secret), inspect({ a: [secret] }, { depth: 5 }), JSON.stringify([...new Map([["k", secret]])])]) {
    assert.equal(shown.includes(value), false, shown);
    assert.match(shown, /redacted/);
  }
  assert.equal(secret.reveal(), value);
  const config = loadOk(example("private"));
  const resolved = await resolveSecrets(config, memorySecrets({ "controller.database-url": value, "example-cloud.api-key": value }));
  assert.ok(resolved.ok);
  assert.equal(describeConfig(config).includes(value), false);
  assert.equal(JSON.stringify(resolved).includes(value), false);
  assert.equal(inspect(resolved, { depth: 6 }).includes(value), false);
});

test("secrets come from the environment or from files, and a secret name can never be a path", async () => {
  const env = environmentSecrets({ NIMBLENEWT_SECRET_EXAMPLE__DASH__CLOUD__DOT__API__DASH__KEY: "from-env", NIMBLENEWT_SECRET_EMPTY: "" });
  assert.equal(await env.resolve("example-cloud.api-key"), "from-env");
  assert.equal(await env.resolve("missing"), undefined);
  // names that used to collapse into one variable stay distinct
  const distinct = environmentSecrets({ NIMBLENEWT_SECRET_A__DOT__B: "dot", NIMBLENEWT_SECRET_A__DASH__B: "dash", NIMBLENEWT_SECRET_A_B: "underscore" });
  assert.deepEqual([await distinct.resolve("a.b"), await distinct.resolve("a-b"), await distinct.resolve("a_b")], ["dot", "dash", "underscore"]);
  assert.equal(await distinct.resolve("a__DOT__b"), undefined, "a name containing the encoding is refused");
  const dir = mkdtempSync(join(tmpdir(), "nn secrets-"));
  try {
    writeFileSync(join(dir, "db.password"), "from-file\n");
    writeFileSync(join(tmpdir(), "nn-outside-secret"), "outside");
    const files = directorySecrets(dir);
    assert.equal(await files.resolve("db.password"), "from-file");
    assert.equal(await files.resolve("absent"), undefined);
    assert.equal(await files.resolve("../nn-outside-secret"), undefined, "a secret name escaped the secrets directory");
    assert.equal(await files.resolve("/etc/passwd"), undefined);
    for (const device of ["con", "NUL", "aux.txt", "com1", "LPT9", "prn"]) {
      writeFileSync(join(dir, device), "device");
      assert.equal(await files.resolve(device), undefined, `${device} is a Windows device name`);
    }
    writeFileSync(join(dir, "trailing"), "x");
    assert.equal(await files.resolve("trailing."), undefined);
    assert.equal(await files.resolve("console"), undefined, "an ordinary name that merely starts with a device name is simply absent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(tmpdir(), "nn-outside-secret"), { force: true });
  }
});

// ------------------------------------------------------------------------ public profile, private grants

test("a public profile cannot hold private grants, an enabled paid provider, trusted-host execution or remote exposure", () => {
  const priv = parsed("private");
  const asPublic = { ...priv, profile: "public" };
  const found = messages(loadConfig(asPublic)).join("\n");
  assert.match(found, /approvals\.grants\[0\]: is a private grant; a public profile may not contain private grants/);
  assert.match(found, /models\.providers\.example-cloud\.enabled: a public profile must not enable a paid provider/);
  assert.match(found, /execution\.isolation: a public profile must use "strong" isolation/);
  assert.match(found, /api\.remoteExposure: a public profile must leave remote exposure off/);
  assert.ok(loadConfig(priv).ok, "the same settings are fine in a private profile");
});

test("a private profile cannot carry unfilled placeholders", () => {
  const doc = parsed("public");
  doc.profile = "private";
  const found = messages(loadConfig(doc)).join("\n");
  assert.match(found, /installation\.dataDir: still contains a \{\{placeholder\}\}/);
  assert.match(found, /controller\.storage\.path: still contains a \{\{placeholder\}\}/);
});

// --------------------------------------------------------------------------------------- export / import

test("an export keeps the useful settings, drops what is private or machine-specific, and previews exactly that", () => {
  const config = loadOk(example("private"));
  const { document, preview } = exportProfile(config);
  const text = JSON.stringify(document);
  assert.equal(document.profile, "public");
  assert.equal(text.includes("/srv/example"), false, "a host path leaked into the export");
  assert.equal(text.includes("example-owner"), false, "the trusted-host authorizer leaked into the export");
  assert.equal(text.includes("owner-git-push"), false, "a private grant leaked into the export");
  assert.equal(text.includes("read-docs"), true, "the public grant should be kept");
  assert.equal(text.includes("example-cloud.api-key"), true, "secret references are kept by name");
  assert.deepEqual(preview.omitted.map((o) => o.path).sort(), ["api.remoteExposure", "approvals.grants[0] (owner-git-push)", "execution.trustedHost", "models.providers.example-cloud.enabled"].sort());
  assert.deepEqual(preview.placeholders.map((p) => p.name).sort(), ["dataDir", "grant.read-docs.scope", "installationName", "provider.example-cloud.endpoint", "provider.local.endpoint", "workspace.main-checkout"]);
  for (const privateValue of ["example-private", "127.0.0.1", "api.example.invalid", "8000"]) assert.equal(text.includes(privateValue), false, `${privateValue} survived the export`);
  const leaves = preview.kept.join("\n");
  assert.equal(leaves.includes("installation.name"), false, "a placeholder is not 'kept'");
  assert.ok(preview.kept.includes("models.difficulty.simple[0]") && preview.kept.includes("limits.perHost"), "the kept list is built from the document");
  assert.ok(loadConfig(document).ok, "an exported profile is itself a valid public profile");
  assert.deepEqual(((document.models as any).difficulty), config.models.difficulty);
});

test("importing fills placeholders from a mapping and needs nothing from the original machine; gaps and extras are named", () => {
  const exported = exportProfile(loadOk(example("private"))).document;
  const fullMapping = { dataDir: "D:\\nimblenewt\\data", "workspace.main-checkout": "D:\\work\\project", installationName: "windows-box", "grant.read-docs.scope": "docs", "provider.local.endpoint": "http://127.0.0.1:9000/v1", "provider.example-cloud.endpoint": "https://api.example.invalid/v1" };
  const imported = importProfile(exported, fullMapping);
  assert.ok(imported.ok, formatErrors(imported.ok ? [] : imported.errors));
  assert.equal(imported.config.installation.dataDir, "D:\\nimblenewt\\data");
  assert.equal(imported.config.installation.workspaces["main-checkout"]?.path, "D:\\work\\project");
  assert.equal(imported.config.profile, "private");
  assert.equal(imported.config.approvals.grants.every((g) => g.visibility === "public"), true);
  assert.equal(imported.config.installation.name, "windows-box");
  const missing = importProfile(exported, { dataDir: "x" });
  assert.ok(!missing.ok && missing.errors.some((e) => e.message.includes("{{workspace.main-checkout}}")));
  const extra = importProfile(exported, { ...fullMapping, nothing: "z" });
  assert.ok(!extra.ok && extra.errors.some((e) => e.message.includes('"nothing"')));
});

test("exporting a SQLite profile and importing it elsewhere round-trips the settings", () => {
  const pub = loadOk(example("public"));
  const { document, preview } = exportProfile(pub);
  assert.deepEqual(preview.placeholders.map((p) => p.name).sort(), ["dataDir", "installationName", "provider.example-cloud.endpoint", "sqlitePath"]);
  const back = importProfile(document, { dataDir: "/data", sqlitePath: "/data/controller.sqlite", installationName: "elsewhere", "provider.example-cloud.endpoint": "https://api.example.invalid/v1" });
  assert.ok(back.ok);
  assert.equal(back.config.installation.name, "elsewhere");
  assert.deepEqual([back.config.models, back.config.limits, back.config.controller.storage], [pub.models, pub.limits, { kind: "sqlite", path: "/data/controller.sqlite" }]);
});

// ------------------------------------------------------------------------------ review findings

test("a JSON syntax error never echoes any of the text, even a secret near the mistake", () => {
  const key = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
  const cases = [
    `{"configVersion": 1, "x": ${key}}`,
    `{"configVersion": 1, ${key}: 1}`,
    `{"configVersion": 1, "x": "${key}`,
    `{"configVersion": 1, "x": "${key}",}`,
    `{"configVersion": 1 "x": "${key}"}`,
    `["${key}" "${key}"]`,
    `{"a": "bad \\q ${key}"}`,
    `${key}`,
    `{"a": 1} ${key}`,
  ];
  for (const text of cases) {
    const found = JSON.stringify(loadConfig(text));
    assert.match(found, /not valid JSON at line \d+, column \d+/, text);
    assert.equal(found.includes("sk-"), false, `echoed part of the input for ${text}`);
    assert.equal(found.includes("ABCDEF"), false, text);
  }
  assert.match(messages(loadConfig('{\n  "a": 1,\n  "b": ]\n}'))[0]!, /line 3, column 8: a value was expected here/);
  assert.match(messages(loadConfig('{"a": 1,}'))[0]!, /line 1, column 9: a property name in double quotes was expected/);
  assert.match(messages(loadConfig("   "))[0]!, /the document ends too soon/);
  assert.match(messages(loadConfig("x".repeat(6 * 1024 * 1024)))[0]!, /larger than 5 MiB/);
  assert.ok(loadConfig(example("public")).ok && loadConfig(example("private")).ok, "valid text still parses");
});

test("validateConfig never throws on inherited property names or hostile shapes", () => {
  for (const route of ["toString/x", "constructor/x", "__proto__/x", "hasOwnProperty/x", "valueOf/x"]) {
    const doc = parsed("public");
    doc.models.difficulty = { hard: [route] };
    const found = messages(loadConfig(doc)).join("\n");
    assert.match(found, /names unknown provider/, route);
  }
  const polluted = JSON.parse('{"configVersion":1,"profile":"public","__proto__":{"polluted":true},"installation":{"name":"x","dataDir":"{{d}}","workspaces":{"__proto__":{"path":"{{p}}"}}}}');
  assert.doesNotThrow(() => loadConfig(polluted));
  assert.equal(({} as any).polluted, undefined);
  let deep: unknown = "x";
  for (let i = 0; i < 9000; i++) deep = [deep];
  for (const input of [{ configVersion: 1, a: deep }, { a: deep }]) {
    const res = loadConfig(input);
    assert.ok(!res.ok && /nested more than 64 levels/.test(res.errors[0]!.message), JSON.stringify(res).slice(0, 200));
  }
  assert.ok(!loadConfig(deep).ok);
  assert.ok(!loadConfig(`${"[".repeat(5000)}${"]".repeat(5000)}`).ok, "deeply nested text is refused, not a crash");
  assert.doesNotThrow(() => validateConfig({ configVersion: 1, profile: "public", installation: null }));
});

test("secret-shaped names and unexpected enum values are not echoed", () => {
  const doc = parsed("public");
  doc.models.providers["sk-ABCDEFGHIJKLMNOPQRSTUVWX"] = doc.models.providers.fake;
  const res = JSON.stringify(loadConfig(doc));
  assert.equal(res.includes("ABCDEFGH"), false, res);
  assert.match(res, /<key withheld>/);
  const e = parsed("public");
  e.profile = "hunter2-password";
  e.configVersion = 1;
  assert.equal(JSON.stringify(loadConfig(e)).includes("hunter2"), false);
  assert.equal(JSON.stringify(loadConfig({ ...parsed("public"), configVersion: "hunter2-password" })).includes("hunter2"), false);
  const lit = parsed("private");
  lit.approvals.preset = "hunter2-password";
  assert.equal(JSON.stringify(loadConfig(lit)).includes("hunter2"), false);
});

test("secret names that differ only by case are reported, since the store treats them alike", () => {
  const doc = parsed("private");
  doc.models.providers["example-cloud"].credential = { secret: "Controller.Database-URL" };
  assert.match(messages(loadConfig(doc)).join("\n"), /"Controller\.Database-URL" and "controller\.database-url" differ only by letter case/);
  const underscore = parsed("private");
  underscore.models.providers["example-cloud"].credential = { secret: "bad__name" };
  assert.match(messages(loadConfig(underscore)).join("\n"), /secret name must start with a letter/);
});

test("a public profile uses placeholders for locations and may not point at private addresses", () => {
  for (const host of ["localhost:8000", "127.0.0.1", "10.1.2.3", "192.168.0.5:80", "172.20.1.1", "[::1]", "build.internal", "gpu-box", "nas.local"]) {
    const doc = parsed("public");
    doc.models.providers["example-cloud"].endpoint = `http://${host}/v1`;
    assert.match(messages(loadConfig(doc)).join("\n"), /must not point at localhost or a private network address/, host);
  }
  const ok = parsed("public");
  ok.models.providers["example-cloud"].endpoint = "{{provider.example-cloud.endpoint}}";
  assert.ok(loadConfig(ok).ok);
  const real = parsed("public");
  real.installation.dataDir = "/home/someone/nimblenewt";
  real.installation.workspaces = { main: { path: "C:\\Users\\someone\\project" } };
  real.controller.storage.path = "/var/lib/nn.sqlite";
  const found = messages(loadConfig(real)).join("\n");
  assert.match(found, /installation\.dataDir: a public profile must use a \{\{placeholder\}\}/);
  assert.match(found, /installation\.workspaces\.main\.path: a public profile must use/);
  assert.match(found, /controller\.storage\.path: a public profile must use/);
});
