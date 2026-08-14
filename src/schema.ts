import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalizerError } from "./errors.ts";

type Schema = Record<string, unknown>;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function loadSchema(name: string): Promise<Schema> {
  const safeName = path.basename(name);
  if (safeName !== name || !safeName.endsWith(".schema.json")) {
    throw new LocalizerError("INVALID_SCHEMA_NAME", `Invalid schema name: ${name}`);
  }
  return JSON.parse(await readFile(path.join(ROOT, "schemas", safeName), "utf8")) as Schema;
}

function resolveLocalReference(root: Schema, reference: string): Schema | undefined {
  if (!reference.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const encoded of reference.slice(2).split("/")) {
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (typeof current !== "object" || current === null || Array.isArray(current) || !(key in current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "object" && current !== null && !Array.isArray(current) ? current as Schema : undefined;
}

export function validateSchema(value: unknown, schema: Schema, at = "$", errors: string[] = [], root: Schema = schema): string[] {
  if (typeof schema.$ref === "string") {
    const resolved = resolveLocalReference(root, schema.$ref);
    if (!resolved) {
      errors.push(`${at}: unsupported or unresolved schema reference`);
      return errors;
    }
    return validateSchema(value, resolved, at, errors, root);
  }
  if (Array.isArray(schema.allOf)) {
    for (const child of schema.allOf) validateSchema(value, child as Schema, at, errors, root);
  }
  const matches = (candidate: Schema): boolean => validateSchema(value, candidate, at, [], root).length === 0;
  if (schema.if && typeof schema.if === "object" && !Array.isArray(schema.if)) {
    const branch = matches(schema.if as Schema) ? schema.then : schema.else;
    if (branch && typeof branch === "object" && !Array.isArray(branch)) validateSchema(value, branch as Schema, at, errors, root);
  }
  if (schema.not && typeof schema.not === "object" && !Array.isArray(schema.not) && matches(schema.not as Schema)) {
    errors.push(`${at}: must not match forbidden schema`);
  }
  const expected = schema.type;
  const objectValue = typeof value === "object" && value !== null && !Array.isArray(value);
  if (expected === "object" && !objectValue) {
      errors.push(`${at}: expected object`);
      return errors;
  }
  if (objectValue) {
    const record = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required as string[] : [];
    for (const key of required) if (!(key in record)) errors.push(`${at}.${key}: required`);
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const [key, child] of Object.entries(properties)) {
      if (key in record) validateSchema(record[key], child, `${at}.${key}`, errors, root);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) if (!(key in properties)) errors.push(`${at}.${key}: unexpected property`);
    }
  }
  if (expected === "array" && !Array.isArray(value)) {
      errors.push(`${at}: expected array`);
      return errors;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${at}: too few items`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${at}: too many items`);
    if (schema.items && typeof schema.items === "object") {
      value.forEach((item, index) => validateSchema(item, schema.items as Schema, `${at}[${index}]`, errors, root));
    }
    if (schema.contains && typeof schema.contains === "object" && !Array.isArray(schema.contains)) {
      const matchCount = value.filter((item, index) => validateSchema(item, schema.contains as Schema, `${at}[${index}]`, [], root).length === 0).length;
      const minimum = typeof schema.minContains === "number" ? schema.minContains : 1;
      if (matchCount < minimum) errors.push(`${at}: contains fewer than ${minimum} matching items`);
      if (typeof schema.maxContains === "number" && matchCount > schema.maxContains) errors.push(`${at}: contains more than ${schema.maxContains} matching items`);
    }
  }
  if (expected === "string") {
    if (typeof value !== "string") errors.push(`${at}: expected string`);
    else {
      if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${at}: too short`);
      if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: pattern mismatch`);
    }
  } else if (expected === "number" || expected === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (expected === "integer" && !Number.isInteger(value))) {
      errors.push(`${at}: expected ${expected}`);
    } else {
      if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${at}: below minimum`);
      if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${at}: above maximum`);
    }
  } else if (expected === "boolean" && typeof value !== "boolean") {
    errors.push(`${at}: expected boolean`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${at}: not in enum`);
  if (schema.const !== undefined && value !== schema.const) errors.push(`${at}: must equal ${JSON.stringify(schema.const)}`);
  return errors;
}

export async function assertSchema(name: string, value: unknown): Promise<void> {
  const errors = validateSchema(value, await loadSchema(name));
  if (errors.length > 0) throw new LocalizerError("SCHEMA_VALIDATION_FAILED", `${name}: ${errors.join("; ")}`);
}
