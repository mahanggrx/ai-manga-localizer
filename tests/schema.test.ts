import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertOwnedKoharuRuntimeConfig, DEFAULT_CONFIG, loadConfig } from "../src/config.ts";
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
    schemaVersion: 2, id: "r1", pageId: "p1", order: 0, role: "dialogue", policy: "replace", sourceText: "text",
    ocrRuntimePolicy: { name: "strict-quality", version: 1 }, selectedOcrEngine: "paddle", ocrSelectionReason: "raw-agreement", ocrQaReasons: [],
    ocrCandidates: [
      { engine: "paddle", role: "paddle", status: "present", text: "text", selected: true },
      { engine: "manga", role: "manga", status: "present", text: "text", selected: false, selectionReason: "raw-agreement" },
    ],
    translationCandidates: [], qaFlags: [],
  };
  assert.ok(validateSchema(invalidRegion, regionSchema).some((error) => error.includes("selectionReason")));
  const validRoleEvidence = {
    schemaVersion: 2, id: "r2", pageId: "p1", order: 1, role: "dialogue", policy: "replace", sourceText: "text",
    insideBubble: true, bubbleInstanceId: "p1:7", geometrySource: "line-polygons", roleConfidence: 0.95, roleProvenance: "bubble-mask",
    ocrRuntimePolicy: { name: "strict-quality", version: 1 }, selectedOcrEngine: "paddle", ocrSelectionReason: "raw-agreement", ocrQaReasons: [],
    ocrCandidates: [
      { engine: "paddle", role: "paddle", status: "present", text: "text", selected: true, selectionReason: "raw-agreement" },
      { engine: "manga", role: "manga", status: "present", text: "text", selected: false, selectionReason: "raw-agreement" },
    ],
    translationCandidates: [], qaFlags: [],
  };
  assert.deepEqual(validateSchema(validRoleEvidence, regionSchema), []);
  assert.ok(validateSchema({ ...validRoleEvidence, roleConfidence: 2 }, regionSchema).some((error) => error.includes("above maximum")));
  assert.ok(validateSchema({ ...validRoleEvidence, geometrySource: "transform" }, regionSchema).some((error) => error.includes("not in enum")));
  const blocked = {
    ...validRoleEvidence,
    ocrSelectionReason: "qa-blocked",
    selectedOcrEngine: undefined,
    ocrQaReasons: ["candidate-disagreement"],
    ocrCandidates: validRoleEvidence.ocrCandidates.map((candidate) => ({ ...candidate, selected: false, selectionReason: "qa-blocked" })),
  };
  assert.deepEqual(validateSchema(JSON.parse(JSON.stringify(blocked)), regionSchema), []);
  assert.ok(validateSchema({ ...validRoleEvidence, ocrRuntimePolicy: { name: "category", version: 1 } }, regionSchema).some((error) => error.includes("not in enum")));
  assert.ok(validateSchema({ ...validRoleEvidence, ocrCandidates: [...validRoleEvidence.ocrCandidates, validRoleEvidence.ocrCandidates[1]] }, regionSchema).some((error) => error.includes("too many items")));
  assert.ok(validateSchema({ ...validRoleEvidence, ocrCandidates: validRoleEvidence.ocrCandidates.map((candidate) => ({ ...candidate, role: "paddle" })) }, regionSchema).some((error) => error.includes("matching items")));
  assert.ok(validateSchema({ ...validRoleEvidence, ocrCandidates: validRoleEvidence.ocrCandidates.map((candidate) => ({ ...candidate, selected: false })) }, regionSchema).some((error) => error.includes("matching items")));
  const presentWithoutText = JSON.parse(JSON.stringify({ ...validRoleEvidence, ocrCandidates: validRoleEvidence.ocrCandidates.map((candidate) => candidate.role === "paddle" ? { ...candidate, text: undefined } : candidate) }));
  assert.ok(validateSchema(presentWithoutText, regionSchema).some((error) => error.includes("required")));
  assert.ok(validateSchema({ ...blocked, selectedOcrEngine: "paddle" }, regionSchema).some((error) => error.includes("forbidden schema")));
  assert.ok(validateSchema({ ...blocked, ocrQaReasons: ["unknown-reason"] }, regionSchema).some((error) => error.includes("not in enum")));
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

test("owned Koharu config is conditional and private runtime records are versioned", async () => {
  const schema = await loadSchema("localizer-config.schema.json");
  const ownedProcess = {
    executablePath: "C:/tools/koharu.exe",
    host: "127.0.0.1" as const,
    port: 4042,
    allowedRunRoot: "C:/runs",
    shadowCacheRoot: "C:/runs/shadow-model-cache",
    shadowCacheManifest: "C:/runs/shadow-model-cache.json",
    appDataModelRoots: ["C:/Users/example/AppData/Roaming/Koharu/models"],
  };
  const owned = { ...DEFAULT_CONFIG, koharu: { ...DEFAULT_CONFIG.koharu, mode: "owned", baseUrl: "http://127.0.0.1:4042/api/v1", ownedProcess } };
  assert.deepEqual(validateSchema(owned, schema), []);
  assert.doesNotThrow(() => assertOwnedKoharuRuntimeConfig(owned.koharu));
  assert.throws(() => assertOwnedKoharuRuntimeConfig({ ...owned.koharu, baseUrl: "http://127.0.0.1:4000/api/v1" }), (error: unknown) => (error as { code?: string }).code === "CONFIG_OWNED_KOHARU_ADDRESS_MISMATCH");
  assert.throws(() => assertOwnedKoharuRuntimeConfig({ ...owned.koharu, baseUrl: "http://user:secret@127.0.0.1:4042/api/v1" }), (error: unknown) => (error as { code?: string }).code === "CONFIG_OWNED_KOHARU_ADDRESS_MISMATCH");
  assert.ok(validateSchema({ ...DEFAULT_CONFIG, koharu: { ...DEFAULT_CONFIG.koharu, mode: "owned" } }, schema).some((error) => error.includes("ownedProcess")));
  assert.ok(validateSchema({ ...DEFAULT_CONFIG, koharu: { ...DEFAULT_CONFIG.koharu, ownedProcess } }, schema).some((error) => error.includes("forbidden")));
  await assert.doesNotReject(() => assertSchema("shadow-cache-manifest.schema.json", {
    schemaVersion: 1,
    files: [{ path: "blobs/model.bin", size: 3, sha256: "a".repeat(64) }],
  }));
  await assert.doesNotReject(() => assertSchema("owned-runtime-journal-entry.schema.json", {
    schemaVersion: 1, sequence: 0, phase: "PREPARED", recordedAt: new Date(0).toISOString(), epoch: 0, fullHash: "b".repeat(64), count: 1,
  }));
  await assert.doesNotReject(() => assertSchema("owned-koharu-identity.schema.json", {
    schemaVersion: 1, pid: 42, startTimeMs: 1, executablePath: "C:/tools/koharu.exe", executableSha256: "c".repeat(64), localAddress: "127.0.0.1", localPort: 4042, dataRoot: "C:/runs/data",
  }));
});
