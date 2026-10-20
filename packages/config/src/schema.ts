/** A path-addressed problem with a configuration value. Messages never contain the offending value of a secret. */
export interface ConfigError {
  /** Dotted path with array indexes, for example `models.providers.openrouter.credential`. Empty for the document itself. */
  readonly path: string;
  readonly message: string;
}

export type Schema =
  | { readonly kind: "string"; readonly minLength?: number; readonly pattern?: RegExp; readonly hint?: string }
  | { readonly kind: "integer"; readonly min?: number; readonly max?: number }
  | { readonly kind: "boolean" }
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "literal"; readonly value: string | number | boolean }
  | { readonly kind: "array"; readonly items: Schema; readonly maxItems?: number }
  | { readonly kind: "record"; readonly values: Schema; readonly keyPattern?: RegExp; readonly keyHint?: string }
  | { readonly kind: "object"; readonly props: Readonly<Record<string, Schema>>; readonly optional?: readonly string[] }
  /** An object whose `discriminator` field selects which variant schema applies. */
  | { readonly kind: "variant"; readonly discriminator: string; readonly variants: Readonly<Record<string, Schema>> }
  /** A reference to a named secret in the secret store: `{ "secret": "name" }`. Never the secret itself. */
  | { readonly kind: "secretRef" };

/** Secret names may not contain "__": the environment resolver uses it to encode '.' and '-' without collisions. */
export const SECRET_NAME = /^(?!.*__)[A-Za-z][A-Za-z0-9._-]{0,63}$/;

/** How deeply a document may nest before it is refused. Checked before anything recurses over it. */
export const MAX_DEPTH = 64;

/** True if the value nests deeper than `limit` levels. Iterative, so a hostile document cannot overflow the stack. */
export function tooDeep(value: unknown, limit = MAX_DEPTH): boolean {
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length > 0) {
    const [v, depth] = stack.pop()!;
    if (v === null || typeof v !== "object") continue;
    if (depth >= limit) return true;
    for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push([child, depth + 1]);
  }
  return false;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const describe = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "an array" : typeof v === "object" ? "an object" : `a ${typeof v}`);
const join = (path: string, key: string | number): string => (typeof key === "number" ? `${path}[${key}]` : path === "" ? key : `${path}.${key}`);

/** Levenshtein distance, for "did you mean" on misspelled keys. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

function suggestion(key: string, known: readonly string[]): string {
  const best = known.map((k) => [k, distance(key.toLowerCase(), k.toLowerCase())] as const).sort((x, y) => x[1] - y[1])[0];
  return best !== undefined && best[1] <= Math.max(1, Math.floor(best[0].length / 3)) ? ` (did you mean "${best[0]}"?)` : "";
}

/** Checks a value against a schema and returns every problem found, not just the first. */
export function validate(value: unknown, schema: Schema, path = ""): ConfigError[] {
  const errors: ConfigError[] = [];
  const fail = (message: string, at = path) => errors.push({ path: at, message });
  switch (schema.kind) {
    case "string":
      if (typeof value !== "string") fail(`expected a string, found ${describe(value)}`);
      else if (value.length < (schema.minLength ?? 0)) fail(value.length === 0 ? "must not be empty" : `must be at least ${schema.minLength} characters`);
      else if (schema.pattern !== undefined && !schema.pattern.test(value)) fail(schema.hint ?? "has an invalid format");
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) fail(`expected a whole number, found ${describe(value)}`);
      else if (schema.min !== undefined && value < schema.min) fail(`must be at least ${schema.min}, found ${value}`);
      else if (schema.max !== undefined && value > schema.max) fail(`must be at most ${schema.max}, found ${value}`);
      break;
    case "boolean":
      if (typeof value !== "boolean") fail(`expected true or false, found ${describe(value)}`);
      break;
    case "enum":
      if (typeof value !== "string" || !schema.values.includes(value)) fail(`expected one of ${schema.values.map((v) => `"${v}"`).join(", ")}, found ${describe(value)}`);
      break;
    case "literal":
      if (value !== schema.value) fail(`expected ${JSON.stringify(schema.value)}, found ${typeof value === "number" || typeof value === "boolean" ? JSON.stringify(value) : describe(value)}`);
      break;
    case "array":
      if (!Array.isArray(value)) fail(`expected a list, found ${describe(value)}`);
      else {
        if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`has ${value.length} entries; at most ${schema.maxItems} are allowed`);
        value.forEach((item, i) => errors.push(...validate(item, schema.items, join(path, i))));
      }
      break;
    case "record":
      if (!isObject(value)) fail(`expected an object, found ${describe(value)}`);
      else {
        for (const [key, item] of Object.entries(value)) {
          if (schema.keyPattern !== undefined && !schema.keyPattern.test(key)) fail(`"${key}" is not a valid name${schema.keyHint !== undefined ? `: ${schema.keyHint}` : ""}`, join(path, key));
          errors.push(...validate(item, schema.values, join(path, key)));
        }
      }
      break;
    case "object": {
      if (!isObject(value)) { fail(`expected an object, found ${describe(value)}`); break; }
      const known = Object.keys(schema.props);
      for (const key of Object.keys(value)) {
        if (!known.includes(key)) fail(`unknown setting "${key}"${suggestion(key, known)}`, join(path, key));
      }
      for (const [key, sub] of Object.entries(schema.props)) {
        if (value[key] === undefined) {
          if (!(schema.optional ?? []).includes(key)) fail(`missing required setting "${key}"`, join(path, key));
        } else errors.push(...validate(value[key], sub, join(path, key)));
      }
      break;
    }
    case "variant": {
      if (!isObject(value)) { fail(`expected an object, found ${describe(value)}`); break; }
      const tag = value[schema.discriminator];
      const names = Object.keys(schema.variants);
      if (typeof tag !== "string" || !names.includes(tag)) fail(`"${schema.discriminator}" must be one of ${names.map((n) => `"${n}"`).join(", ")}`, join(path, schema.discriminator));
      else errors.push(...validate(value, schema.variants[tag]!, path));
      break;
    }
    case "secretRef":
      if (typeof value === "string") fail('expected a secret reference like {"secret": "name"}; secrets must never be written into configuration, only the name of a secret held in the secret store');
      else if (!isObject(value) || typeof value.secret !== "string" || Object.keys(value).length !== 1) fail('expected a secret reference like {"secret": "name"}');
      else if (!SECRET_NAME.test(value.secret)) fail("the secret name must start with a letter and contain only letters, digits, '.', '_' or '-' (at most 64 characters)", join(path, "secret"));
      break;
  }
  return errors;
}
