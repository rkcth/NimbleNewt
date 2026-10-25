import type { JsonObject } from "../storage/types.js";

/**
 * A checker for the structured arguments of a catalogued tool (card T06). The manifest's schemas (T01) are JSON objects that may refer only to themselves; this checks a value against one with the
 * keywords a tool needs and refuses a schema that uses any keyword it cannot check (a schema the controller cannot enforce is never treated as satisfied). No pattern or format is evaluated: a
 * regular expression written by an agent and run by the controller is a way to stall it.
 */
const ANNOTATIONS = new Set(["$schema", "$comment", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly", "$defs", "definitions"]);
const KEYWORDS = new Set(["type", "enum", "const", "properties", "required", "additionalProperties", "items", "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "anyOf", "oneOf", "allOf", "not", "$ref"]);
const TYPES = new Set(["string", "number", "integer", "boolean", "null", "object", "array"]);
export const SCHEMA_LIMITS = { depth: 32, problems: 8, nodes: 20_000 } as const;

export type Problems = string[];

class Walk {
  readonly problems: Problems = [];
  nodes = 0;
  /** Set when a check ran out of budget. Sticky: nothing clears it, so a combinator that treats a failed sub-check as "no match" cannot turn an unfinished check into a pass. */
  exhausted = false;
  constructor(readonly root: JsonObject) {}
  add(path: string, message: string): void { if (this.problems.length < SCHEMA_LIMITS.problems) this.problems.push(`${path === "" ? "(arguments)" : path}: ${message}`); }
}

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(sort(a)) === JSON.stringify(sort(b));
const sort = (v: unknown): unknown => (Array.isArray(v) ? v.map(sort) : isObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v);

const isCount = (v: unknown): boolean => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isNumber = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);
const isSchema = (v: unknown): boolean => typeof v === "boolean" || isObject(v);

/** The problems with a schema itself: a keyword this checker cannot enforce, a keyword value of the wrong kind, a reference that does not reach a schema, a bad type name. Empty when the schema can be enforced. */
export function schemaProblems(schema: JsonObject): Problems {
  const w = new Walk(schema);
  const seenRefs = new Set<string>();
  const visit = (node: unknown, path: string, depth: number): void => {
    if (depth > SCHEMA_LIMITS.depth) { w.add(path, "is nested too deeply"); return; }
    if (typeof node === "boolean") return;
    if (!isObject(node)) { w.add(path, "must be a schema object"); return; }
    for (const [key, v] of Object.entries(node)) {
      if (key === "$defs" || key === "definitions") { if (!isObject(v)) w.add(path, `${key} must be an object of schemas`); else for (const [k, sub] of Object.entries(v)) visit(sub, `${path}/${key}/${k}`, depth + 1); continue; }
      if (ANNOTATIONS.has(key)) continue;
      if (!KEYWORDS.has(key)) { w.add(path, `uses the keyword "${key}", which the controller cannot enforce`); continue; }
      const wrong = (what: string): void => w.add(path, `${key} must be ${what}`);
      switch (key) {
        case "type": for (const t of Array.isArray(v) ? v : [v]) if (typeof t !== "string" || !TYPES.has(t)) w.add(path, `has an unknown type ${JSON.stringify(t)?.slice(0, 30)}`); break;
        case "enum": if (!Array.isArray(v)) wrong("an array"); break;
        case "properties": if (!isObject(v)) wrong("an object of schemas"); else for (const [k, sub] of Object.entries(v)) visit(sub, `${path}/${k}`, depth + 1); break;
        case "required": if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) wrong("an array of names"); break;
        case "additionalProperties": if (!isSchema(v)) wrong("true, false or a schema"); else visit(v, `${path}/${key}`, depth + 1); break;
        case "items": if (!isSchema(v)) wrong("one schema (tuples are not supported)"); else visit(v, `${path}/${key}`, depth + 1); break;
        case "not": if (!isSchema(v)) wrong("a schema"); else visit(v, `${path}/${key}`, depth + 1); break;
        case "minItems": case "maxItems": case "minLength": case "maxLength": if (!isCount(v)) wrong("a whole number of at least 0"); break;
        case "minimum": case "maximum": case "exclusiveMinimum": case "exclusiveMaximum": if (!isNumber(v)) wrong("a number"); break;
        case "multipleOf": if (!isNumber(v) || (v as number) <= 0) wrong("a number above 0"); break;
        case "anyOf": case "oneOf": case "allOf": if (!Array.isArray(v) || v.length === 0 || v.some((x) => !isSchema(x))) wrong("a non-empty array of schemas"); else v.forEach((sub, i) => visit(sub, `${path}/${key}/${i}`, depth + 1)); break;
        case "$ref": {
          const target = typeof v === "string" ? resolve(w.root, v) : undefined;
          if (!isSchema(target)) w.add(path, "has a $ref that does not point at a schema inside this schema");
          else if (!seenRefs.has(v as string)) { seenRefs.add(v as string); visit(target, `${path}->${v as string}`, depth + 1); }
          break;
        }
        default: break;
      }
    }
  };
  visit(schema, "", 0);
  return w.problems;
}

function resolve(root: JsonObject, ref: string): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const part of ref.slice(2).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (Array.isArray(node)) { if (!/^(0|[1-9]\d*)$/.test(part) || Number(part) >= node.length) return undefined; node = node[Number(part)]; continue; }
    if (!isObject(node) || !Object.hasOwn(node, part)) return undefined;
    node = node[part];
  }
  return node;
}

/** The problems with a value against a schema, each naming the place (at most eight). Empty when it satisfies it. A schema the checker cannot enforce is itself reported. */
export function checkValue(schema: JsonObject, value: unknown): Problems {
  const bad = schemaProblems(schema);
  if (bad.length > 0) return bad.map((p) => `schema ${p}`);
  const w = new Walk(schema);
  const check = (s: unknown, v: unknown, path: string, depth: number, refs: number): boolean => {
    if (++w.nodes > SCHEMA_LIMITS.nodes || depth > SCHEMA_LIMITS.depth + 32 || refs > 64) { w.exhausted = true; w.add(path, "is too large or too deeply nested to check"); return false; }
    if (s === true) return true;
    if (s === false) { w.add(path, "is not allowed"); return false; }
    if (!isObject(s)) return false;
    let ok = true;
    const fail = (message: string): void => { ok = false; w.add(path, message); };
    if (typeof s["$ref"] === "string") { const target = resolve(w.root, s["$ref"]); if (!check(target, v, path, depth + 1, refs + 1)) ok = false; }
    if (s["type"] !== undefined) {
      const types = (Array.isArray(s["type"]) ? s["type"] : [s["type"]]) as string[];
      const actual = typeOf(v);
      if (!types.some((t) => t === actual || (t === "number" && actual === "integer"))) fail(`must be ${types.join(" or ")}, not ${actual}`);
    }
    if (Array.isArray(s["enum"]) && !s["enum"].some((e) => same(e, v))) fail("is not one of the allowed values");
    if ("const" in s && !same(s["const"], v)) fail("is not the required value");
    if (typeof v === "string") {
      if (typeof s["minLength"] === "number" && [...v].length < s["minLength"]) fail(`must be at least ${s["minLength"]} characters`);
      if (typeof s["maxLength"] === "number" && [...v].length > s["maxLength"]) fail(`must be at most ${s["maxLength"]} characters`);
    }
    if (typeof v === "number") {
      if (typeof s["minimum"] === "number" && v < s["minimum"]) fail(`must be at least ${s["minimum"]}`);
      if (typeof s["maximum"] === "number" && v > s["maximum"]) fail(`must be at most ${s["maximum"]}`);
      if (typeof s["exclusiveMinimum"] === "number" && v <= s["exclusiveMinimum"]) fail(`must be above ${s["exclusiveMinimum"]}`);
      if (typeof s["exclusiveMaximum"] === "number" && v >= s["exclusiveMaximum"]) fail(`must be below ${s["exclusiveMaximum"]}`);
      if (typeof s["multipleOf"] === "number" && s["multipleOf"] > 0 && Math.abs(v / s["multipleOf"] - Math.round(v / s["multipleOf"])) > 1e-9) fail(`must be a multiple of ${s["multipleOf"]}`);
    }
    if (Array.isArray(v)) {
      if (typeof s["minItems"] === "number" && v.length < s["minItems"]) fail(`must have at least ${s["minItems"]} items`);
      if (typeof s["maxItems"] === "number" && v.length > s["maxItems"]) fail(`must have at most ${s["maxItems"]} items`);
      if (s["items"] !== undefined) v.forEach((item, i) => { if (!check(s["items"], item, `${path}/${i}`, depth + 1, refs)) ok = false; });
    }
    if (isObject(v)) {
      const props = isObject(s["properties"]) ? s["properties"] : {};
      for (const key of Array.isArray(s["required"]) ? s["required"] : []) if (typeof key === "string" && !Object.hasOwn(v, key)) fail(`is missing "${key}"`);
      for (const [key, item] of Object.entries(v)) {
        if (Object.hasOwn(props, key)) { if (!check(props[key], item, `${path}/${key}`, depth + 1, refs)) ok = false; } else if (s["additionalProperties"] === false) fail(`has "${key}", which the tool does not take`);
        else if (s["additionalProperties"] !== undefined && s["additionalProperties"] !== true) { if (!check(s["additionalProperties"], item, `${path}/${key}`, depth + 1, refs)) ok = false; }
      }
    }
    // The combinators check silently: a failing alternative is not a problem of its own.
    const quiet = (sub: unknown): boolean => { const before = w.problems.length; const r = check(sub, v, path, depth + 1, refs); w.problems.length = before; return r; };
    if (Array.isArray(s["allOf"])) for (const sub of s["allOf"]) if (!check(sub, v, path, depth + 1, refs)) ok = false;
    if (Array.isArray(s["anyOf"]) && !s["anyOf"].some(quiet)) fail("matches none of the allowed shapes");
    if (Array.isArray(s["oneOf"]) && s["oneOf"].filter(quiet).length !== 1) fail("must match exactly one of the allowed shapes");
    if ("not" in s && quiet(s["not"])) fail("matches a shape that is not allowed");
    return ok;
  };
  const passed = check(schema, value, "", 0, 0);
  // The verdict is what the check returned, not what happened to be recorded: a check that ran out of budget inside a combinator, or failed without a message, is still a refusal.
  if (w.exhausted && !w.problems.some((p) => /too large/.test(p))) w.problems.unshift("(arguments): is too large or too deeply nested to check");
  if (!passed && w.problems.length === 0) w.problems.push("(arguments): does not match the schema");
  return w.problems;
}
