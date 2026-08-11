import assert from "node:assert/strict";
import test from "node:test";
import { deriveOcrBenchmarkInput, evaluateOcrBaseline, normalizeOcrText, type OcrEligibilityOverlay } from "../src/ocr-benchmark.ts";
import { sha256Bytes } from "../src/file-utils.ts";
import { assertSchema } from "../src/schema.ts";

const encoder = new TextEncoder();

function syntheticReview(): Uint8Array {
  const dataset = {
    reviewRevision: 7,
    pages: [
      {
        selectionOrder: 1,
        category: "synthetic-a",
        pageId: "page-a",
        regions: [
          { id: "region-a", pageId: "page-a", order: 0, ocrCandidates: [{ engine: "engine-left", text: "Alpha" }, { engine: "engine-right", text: "Al pha" }] },
          { id: "region-b", pageId: "page-a", order: 1, ocrCandidates: [{ engine: "engine-left", text: "Beta" }, { engine: "engine-right", text: "Wrong" }] },
        ],
      },
      {
        selectionOrder: 2,
        category: "synthetic-b",
        pageId: "page-b",
        regions: [
          { id: "region-c", pageId: "page-b", order: 0, ocrCandidates: [{ engine: "engine-left", text: "Shape" }, { engine: "engine-right", text: "Shape" }] },
          { id: "region-d", pageId: "page-b", order: 1, ocrCandidates: [{ engine: "engine-left", text: "Gamma" }] },
        ],
      },
    ],
    preAnnotations: {
      regions: {
        "region-a": { expectedOcr: "Alpha" },
        "region-b": { expectedOcr: "Beta" },
        "region-c": { expectedOcr: "Not text" },
        "region-d": { expectedOcr: "Old" },
        "region-missed": { expectedOcr: "Missed" },
      },
      extraRegions: {
        "page-b": [{ id: "region-missed", pageId: "page-b", order: 2 }],
      },
    },
  };
  return encoder.encode(`<html><script id="dataset" type="application/json">${JSON.stringify(dataset)}</script></html>`);
}

function overlay(base: Uint8Array): Uint8Array {
  const value: OcrEligibilityOverlay = {
    schemaVersion: 1,
    overlayRevision: 1,
    benchmarkId: "synthetic-ocr-v1",
    base: { artifact: "synthetic.html", sha256: sha256Bytes(base), byteLength: base.byteLength, reviewRevision: 7 },
    entries: [
      { regionId: "region-c", ocrEligibility: "excluded", exclusionReason: "non-text-false-positive" },
      { regionId: "region-d", expectedOcr: "Gamma" },
    ],
  };
  return encoder.encode(JSON.stringify(value));
}

test("eligibility overlay fixes the base hash and separates detection from OCR scoring", () => {
  const base = syntheticReview();
  const input = deriveOcrBenchmarkInput(base, overlay(base));
  assert.equal(input.regions.length, 5);
  assert.deepEqual(input.regions.map((region) => [region.id, region.detectionStatus, region.ocrEligibility, region.exclusionReason]), [
    ["region-a", "detected", "eligible", undefined],
    ["region-b", "detected", "eligible", undefined],
    ["region-c", "detected", "excluded", "non-text-false-positive"],
    ["region-d", "detected", "eligible", undefined],
    ["region-missed", "missed", "excluded", "detection-missed"],
  ]);
  assert.equal(input.regions[2].expectedOcr, undefined);
  assert.equal(input.regions[2].candidates.length, 0);
  assert.equal(input.regions[4].candidates.length, 0);
  assert.ok(!JSON.stringify(input).includes("confidence"));
});

test("baseline report uses fixed denominators and exposes candidate absence", () => {
  const base = syntheticReview();
  const input = deriveOcrBenchmarkInput(base, overlay(base));
  const report = evaluateOcrBaseline(input, ["engine-left", "engine-right"]);
  assert.deepEqual(report.denominators, {
    workingGoldRegions: 5,
    detectorOutputRegions: 4,
    missedDetectionRegions: 1,
    ocrEligibleDetectedRegions: 3,
    excludedDetectedRegions: 1,
    pairedEligibleRegions: 2,
  });
  assert.deepEqual(report.candidates.map((candidate) => [candidate.engine, candidate.availableRegions, candidate.missingRegions, candidate.normalizedExact]), [
    ["engine-left", 3, 0, 3],
    ["engine-right", 2, 1, 1],
  ]);
  assert.deepEqual(report.candidates.map((candidate) => [
    candidate.engine,
    candidate.availableGoldCharacters,
    candidate.availableEditDistance,
    candidate.corpusCerAmongAvailable,
    candidate.coverageAdjustedEditDistance,
    candidate.coverageAdjustedCorpusCer,
  ]), [
    ["engine-left", 14, 0, 0, 0, 0],
    ["engine-right", 9, 5, 5 / 9, 10, 10 / 14],
  ]);
  assert.deepEqual(report.pair, {
    leftEngine: "engine-left",
    rightEngine: "engine-right",
    pairedEligibleRegions: 2,
    rawAgreement: 0,
    normalizedAgreement: 1,
    normalizationOnlyAgreement: 1,
    agreementGoldExact: 1,
    agreementJointWrong: 0,
    leftOnlyExact: 1,
    rightOnlyExact: 0,
    neitherExact: 0,
  });
});

test("OCR normalization is NFKC plus whitespace removal", () => {
  assert.equal(normalizeOcrText(" \uff21\u3000B\n"), "AB");
});

test("overlay and derived artifacts satisfy public schemas", async () => {
  const base = syntheticReview();
  const overlayBytes = overlay(base);
  const overlayValue = JSON.parse(new TextDecoder().decode(overlayBytes));
  const input = deriveOcrBenchmarkInput(base, overlayBytes);
  const report = evaluateOcrBaseline(input, ["engine-left", "engine-right"]);
  await assert.doesNotReject(() => assertSchema("ocr-benchmark-overlay.schema.json", overlayValue));
  await assert.doesNotReject(() => assertSchema("ocr-benchmark-input.schema.json", input));
  await assert.doesNotReject(() => assertSchema("ocr-benchmark-report.schema.json", report));
});

test("eligibility contract fails closed on stale base and invalid exclusion state", () => {
  const base = syntheticReview();
  const stale = JSON.parse(new TextDecoder().decode(overlay(base)));
  stale.base.sha256 = "0".repeat(64);
  assert.throws(() => deriveOcrBenchmarkInput(base, encoder.encode(JSON.stringify(stale))), /base hash or byte length/);

  const invalid = JSON.parse(new TextDecoder().decode(overlay(base)));
  delete invalid.entries[0].exclusionReason;
  assert.throws(() => deriveOcrBenchmarkInput(base, encoder.encode(JSON.stringify(invalid))), /without a reason/);

  const unknown = JSON.parse(new TextDecoder().decode(overlay(base)));
  unknown.entries[0].privateText = "must-not-pass";
  assert.throws(() => deriveOcrBenchmarkInput(base, encoder.encode(JSON.stringify(unknown))), /unsupported field/);
});

test("baseline evaluator rejects text-bearing fields outside the private input contract", () => {
  const base = syntheticReview();
  const input = deriveOcrBenchmarkInput(base, overlay(base));
  const privateRegion = structuredClone(input) as typeof input & { regions: Array<(typeof input.regions)[number] & { sourceText?: string }> };
  privateRegion.regions[0].sourceText = "must-not-pass";
  assert.throws(() => evaluateOcrBaseline(privateRegion, ["engine-left", "engine-right"]), /unsupported field/);

  const candidateExtra = structuredClone(input) as typeof input & { regions: Array<(typeof input.regions)[number] & { candidates: Array<(typeof input.regions)[number]["candidates"][number] & { confidence?: number }> }> };
  candidateExtra.regions[0].candidates[0].confidence = 0.99;
  assert.throws(() => evaluateOcrBaseline(candidateExtra, ["engine-left", "engine-right"]), /unsupported field/);

  const nonStringCandidate = structuredClone(input) as unknown as { regions: Array<{ candidates: Array<{ text: unknown }> }> };
  nonStringCandidate.regions[0].candidates[0].text = 42;
  assert.throws(() => evaluateOcrBaseline(nonStringCandidate as never, ["engine-left", "engine-right"]), /candidate is invalid/);
});
