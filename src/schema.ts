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

export function validateSchema(value: unknown, schema: Schema, at = "$", errors: string[] = []): string[] {
  const expected = schema.type;
  if (expected === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push(`${at}: expected object`);
      return errors;
    }
    const record = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required as string[] : [];
    for (const key of required) if (!(key in record)) errors.push(`${at}.${key}: required`);
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const [key, child] of Object.entries(properties)) {
      if (key in record) validateSchema(record[key], child, `${at}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) if (!(key in properties)) errors.push(`${at}.${key}: unexpected property`);
    }
  } else if (expected === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${at}: expected array`);
      return errors;
    }
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${at}: too few items`);
    if (schema.items && typeof schema.items === "object") {
      value.forEach((item, index) => validateSchema(item, schema.items as Schema, `${at}[${index}]`, errors));
    }
  } else if (expected === "string") {
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

