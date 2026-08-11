import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";
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

test("config accepts only built-in or loopback-compatible primary target identities", async () => {
  const configSchema = await loadSchema("localizer-config.schema.json");
  const localProvider = {
    ...DEFAULT_CONFIG,
    translation: { ...DEFAULT_CONFIG.translation, localTarget: { kind: "provider", modelId: "local-model", providerId: "openai-compatible" } },
  };
  assert.deepEqual(validateSchema(localProvider, configSchema), []);

  const directory = await mkdtemp(path.join(os.tmpdir(), "manga-localizer-provider-"));
  const configPath = path.join(directory, "remote.json");
  await writeFile(configPath, JSON.stringify({
    ...DEFAULT_CONFIG,
    translation: { ...DEFAULT_CONFIG.translation, localTarget: { kind: "provider", modelId: "remote", providerId: "cloud" } },
  }));
  await assert.rejects(
    () => loadConfig(configPath),
    (error: unknown) => (error as { code?: string }).code === "CONFIG_LOCAL_TRANSLATOR_PROVIDER_UNSUPPORTED",
  );

  const regionSchema = await loadSchema("region-record.schema.json");
  const invalidRegion = {
    schemaVersion: 1, id: "r1", pageId: "p1", order: 0, role: "dialogue", policy: "replace", sourceText: "text",
    ocrCandidates: [{ engine: "ocr", text: "text", selected: true }], translationCandidates: [], qaFlags: [],
  };
  assert.ok(validateSchema(invalidRegion, regionSchema).some((error) => error.includes("selectionReason")));
  const validRoleEvidence = {
    schemaVersion: 1, id: "r2", pageId: "p1", order: 1, role: "dialogue", policy: "replace", sourceText: "text",
    insideBubble: true, bubbleInstanceId: "p1:7", roleConfidence: 0.95, roleProvenance: "bubble-mask",
    ocrCandidates: [{ engine: "ocr", text: "text", selected: true, selectionReason: "primary-engine-output" }], translationCandidates: [], qaFlags: [],
  };
  assert.deepEqual(validateSchema(validRoleEvidence, regionSchema), []);
  assert.ok(validateSchema({ ...validRoleEvidence, roleConfidence: 2 }, regionSchema).some((error) => error.includes("above maximum")));
});

test("config rejects overlapping sparse and dense structural thresholds", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manga-localizer-config-"));
  const configPath = path.join(directory, "invalid.json");
  const invalid = {
    ...DEFAULT_CONFIG,
    quality: {
      ...DEFAULT_CONFIG.quality,
      structuralProtection: {
        ...DEFAULT_CONFIG.quality.structuralProtection,
        boundarySparseRegionLimit: 12,
        boundaryDenseRegionThreshold: 12,
      },
    },
  };
  await writeFile(configPath, JSON.stringify(invalid));
  await assert.rejects(
    () => loadConfig(configPath),
    (error: unknown) => (error as { code?: string }).code === "CONFIG_STRUCTURAL_PROTECTION_INVALID",
  );
});
