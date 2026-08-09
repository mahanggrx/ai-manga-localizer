import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { assertSchema, loadSchema, validateSchema } from "../src/schema.ts";

test("default config satisfies its public JSON schema", async () => {
  await assert.doesNotReject(() => assertSchema("localizer-config.schema.json", DEFAULT_CONFIG));
});

test("schema validator rejects unknown top-level config fields", async () => {
  const schema = await loadSchema("localizer-config.schema.json");
  const invalid = { ...DEFAULT_CONFIG, secretText: "must not be accepted" };
  const errors = validateSchema(invalid, schema);
  assert.ok(errors.some((error) => error.includes("unexpected property")));
});

test("config schema requires a local primary target and complete candidate provenance", async () => {
  const configSchema = await loadSchema("localizer-config.schema.json");
  const remotePrimary = {
    ...DEFAULT_CONFIG,
    translation: { ...DEFAULT_CONFIG.translation, localTarget: { kind: "provider", modelId: "remote", providerId: "cloud" } },
  };
  assert.ok(validateSchema(remotePrimary, configSchema).some((error) => error.includes("must equal")));

  const regionSchema = await loadSchema("region-record.schema.json");
  const invalidRegion = {
    schemaVersion: 1, id: "r1", pageId: "p1", order: 0, role: "dialogue", policy: "replace", sourceText: "text",
    ocrCandidates: [{ engine: "ocr", text: "text", selected: true }], translationCandidates: [], qaFlags: [],
  };
  assert.ok(validateSchema(invalidRegion, regionSchema).some((error) => error.includes("selectionReason")));
});
