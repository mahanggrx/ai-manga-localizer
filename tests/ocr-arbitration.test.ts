import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateOcrArbitration,
  inspectOcrCandidate,
  type OcrArbitrationEvaluationSpec,
} from "../src/ocr-arbitration.ts";
import { evaluateOcrBaseline, type OcrBenchmarkInput } from "../src/ocr-benchmark.ts";
import { sha256Bytes } from "../src/file-utils.ts";
import type { RoutingRegressionInput } from "../src/routing-regression.ts";
import { assertSchema } from "../src/schema.ts";

const encoder = new TextEncoder();
const PADDLE = "engine-paddle";
const MANGA = "engine-manga";

interface SyntheticRegion {
  id: string;
  pageId: string;
  pageOrder: number;
  category: string;
  insideBubble: boolean;
  expected: string;
  paddle?: string;
  manga?: string;
}

interface Fixture {
  benchmarkBytes: Uint8Array;
  baselineBytes: Uint8Array;
  routingBytes: Uint8Array;
  spec: OcrArbitrationEvaluationSpec;
}

function bytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function pin(value: Uint8Array): { sha256: string; byteLength: number } {
  return { sha256: sha256Bytes(value), byteLength: value.byteLength };
}

function makeFixture(regions: SyntheticRegion[], minimumGroupSupport = 1): Fixture {
  const benchmark: OcrBenchmarkInput = {
    schemaVersion: 1,
    benchmarkId: "synthetic-arbitration-v1",
    source: { baseSha256: "a".repeat(64), overlaySha256: "b".repeat(64), reviewRevision: 1, overlayRevision: 1 },
    regions: regions.map((region) => ({
      id: region.id,
      pageId: region.pageId,
      pageOrder: region.pageOrder,
      category: region.category,
      detectionStatus: "detected",
      ocrEligibility: "eligible",
      expectedOcr: region.expected,
      candidates: [
        ...(region.paddle === undefined ? [] : [{ engine: PADDLE, text: region.paddle }]),
        ...(region.manga === undefined ? [] : [{ engine: MANGA, text: region.manga }]),
      ],
    })),
  };
  const routing: RoutingRegressionInput = {
    schemaVersion: 2,
    benchmarkId: "synthetic-routing-v1",
    observations: regions.map((region) => ({
      id: region.id,
      pageId: region.pageId,
      pageOrder: region.pageOrder,
      category: region.category,
      detected: true,
      evidence: region.insideBubble
        ? { insideBubble: true, confidence: 1, roleProvenance: "bubble-mask", geometrySource: "bbox" }
        : { insideBubble: false, confidence: 1, roleProvenance: "bubble-mask", geometrySource: "bbox" },
      overlapRate: region.insideBubble ? 1 : 0,
      dominantShare: region.insideBubble ? 1 : 0,
    })),
  };
  const benchmarkBytes = bytes(benchmark);
  const baselineBytes = bytes(evaluateOcrBaseline(benchmark, [PADDLE, MANGA]));
  const routingBytes = bytes(routing);
  const spec: OcrArbitrationEvaluationSpec = {
    schemaVersion: 1,
    evaluationId: "synthetic-evaluation-v1",
    baseCodeRevision: "c".repeat(40),
    sources: { benchmarkInput: pin(benchmarkBytes), baselineReport: pin(baselineBytes), routingObservations: pin(routingBytes) },
    engines: { paddle: PADDLE, manga: MANGA },
    minimumGroupSupport,
    bootstrap: { seed: 123456, replicates: 100, confidenceLevel: 0.95 },
  };
  return { benchmarkBytes, baselineBytes, routingBytes, spec };
}

function leakageFixture(): Fixture {
  return makeFixture([
    { id: "synthetic-a", pageId: "synthetic-page-a", pageOrder: 1, category: "structural-negative", insideBubble: true, expected: "A", paddle: "A", manga: "X" },
    { id: "synthetic-b", pageId: "synthetic-page-b", pageOrder: 2, category: "structural-negative", insideBubble: false, expected: "B", paddle: "X", manga: "B" },
    { id: "synthetic-c", pageId: "synthetic-page-c", pageOrder: 3, category: "structural-negative", insideBubble: false, expected: "C", paddle: "X", manga: "C" },
  ]);
}

function repinRouting(fixture: Fixture, routing: RoutingRegressionInput): Fixture {
  const routingBytes = bytes(routing);
  return {
    ...fixture,
    routingBytes,
    spec: { ...fixture.spec, sources: { ...fixture.spec.sources, routingObservations: pin(routingBytes) } },
  };
}

function repinBaseline(fixture: Fixture, baselineValue: unknown): Fixture {
  const baselineBytes = bytes(baselineValue);
  return {
    ...fixture,
    baselineBytes,
    spec: { ...fixture.spec, sources: { ...fixture.spec.sources, baselineReport: pin(baselineBytes) } },
  };
}

test("hard OCR candidate checks fail closed on unsafe Unicode structure", () => {
  assert.deepEqual(inspectOcrCandidate(undefined).hardReasons, ["candidate-missing"]);
  assert.deepEqual(inspectOcrCandidate({ engine: PADDLE, text: " \n\t" }).hardReasons, ["normalized-empty"]);
  assert.deepEqual(inspectOcrCandidate({ engine: PADDLE, text: "x\ufffd" }).hardReasons, ["replacement-character"]);
  assert.deepEqual(inspectOcrCandidate({ engine: PADDLE, text: "x\ud800" }).hardReasons, ["unpaired-surrogate"]);
  assert.deepEqual(inspectOcrCandidate({ engine: PADDLE, text: "x\u0001" }).hardReasons, ["forbidden-control"]);
  assert.deepEqual(inspectOcrCandidate({ engine: PADDLE, text: "x\u202e" }).hardReasons, ["bidi-control"]);
  assert.equal(inspectOcrCandidate({ engine: PADDLE, text: "A\nB" }).safe, true);
});

test("source pins and complete region association fail closed", () => {
  const fixture = leakageFixture();
  const staleSpec = structuredClone(fixture.spec);
  staleSpec.sources.benchmarkInput.sha256 = "0".repeat(64);
  assert.throws(() => evaluateOcrArbitration(fixture.benchmarkBytes, fixture.baselineBytes, fixture.routingBytes, staleSpec), /fixed SHA-256/);

  const missingRouting = JSON.parse(new TextDecoder().decode(fixture.routingBytes)) as RoutingRegressionInput;
  missingRouting.observations.pop();
  const missingFixture = repinRouting(fixture, missingRouting);
  assert.throws(() => evaluateOcrArbitration(missingFixture.benchmarkBytes, missingFixture.baselineBytes, missingFixture.routingBytes, missingFixture.spec), /populations differ|completely cover/);

  const duplicateRouting = JSON.parse(new TextDecoder().decode(fixture.routingBytes)) as RoutingRegressionInput;
  duplicateRouting.observations[1].id = duplicateRouting.observations[0].id;
  const duplicateFixture = repinRouting(fixture, duplicateRouting);
  assert.throws(() => evaluateOcrArbitration(duplicateFixture.benchmarkBytes, duplicateFixture.baselineBytes, duplicateFixture.routingBytes, duplicateFixture.spec), /duplicate/i);

  const conflictingRouting = JSON.parse(new TextDecoder().decode(fixture.routingBytes)) as RoutingRegressionInput;
  conflictingRouting.observations[0].category = "ordinary-dialogue";
  const conflictingFixture = repinRouting(fixture, conflictingRouting);
  assert.throws(() => evaluateOcrArbitration(conflictingFixture.benchmarkBytes, conflictingFixture.baselineBytes, conflictingFixture.routingBytes, conflictingFixture.spec), /metadata conflict/);

  const conflictingBaseline = JSON.parse(new TextDecoder().decode(fixture.baselineBytes));
  conflictingBaseline.denominators.ocrEligibleDetectedRegions += 1;
  const baselineFixture = repinBaseline(fixture, conflictingBaseline);
  assert.throws(() => evaluateOcrArbitration(baselineFixture.benchmarkBytes, baselineFixture.baselineBytes, baselineFixture.routingBytes, baselineFixture.spec), /fresh in-memory recalculation/);
});

test("leave-one-page-out training excludes the held page and bubble fallback is predeclared", () => {
  const fixture = leakageFixture();
  const report = evaluateOcrArbitration(fixture.benchmarkBytes, fixture.baselineBytes, fixture.routingBytes, fixture.spec);
  const category = report.strategies.find((strategy) => strategy.policy === "agreement-category")!;
  const bubble = report.strategies.find((strategy) => strategy.policy === "agreement-category-bubble")!;
  assert.equal(category.overall.exactRegions, 0);
  assert.equal(bubble.overall.exactRegions, 2);
  assert.deepEqual(report.strategies.find((strategy) => strategy.policy === "always-paddle")!.overall, {
    regionCount: 3,
    exactRegions: 1,
    exactRate: 1 / 3,
    goldCharacters: 3,
    editDistance: 2,
    corpusCer: 2 / 3,
    regionMacroCer: 2 / 3,
    p50Cer: 1,
    p90Cer: 1,
    p95Cer: 1,
    maxCer: 1,
    cerAtMost3PercentRegions: 1,
    cerAtMost3PercentRate: 1 / 3,
  });
  assert.deepEqual(report.crossValidation, {
    foldCount: 3,
    minimumTrainingPages: 2,
    maximumTrainingPages: 2,
    minimumTestRegions: 1,
    maximumTestRegions: 1,
  });
  assert.equal(category.structuralNegativeSafety.passed, false);
  assert.equal(report.decision.status, "DO_NOT_FREEZE");

  const supportedFixture = leakageFixture();
  supportedFixture.spec.minimumGroupSupport = 2;
  const supported = evaluateOcrArbitration(supportedFixture.benchmarkBytes, supportedFixture.baselineBytes, supportedFixture.routingBytes, supportedFixture.spec);
  assert.equal(supported.strategies.find((strategy) => strategy.policy === "agreement-category-bubble")!.overall.exactRegions, 0);
});

test("QA residuals retain hard anomalies and joint-wrong agreement without private ids or text", () => {
  const fixture = makeFixture([
    { id: "case-missing", pageId: "page-a", pageOrder: 1, category: "structural-negative", insideBubble: true, expected: "A", manga: "A" },
    { id: "case-empty", pageId: "page-b", pageOrder: 2, category: "structural-negative", insideBubble: false, expected: "B", paddle: "   ", manga: "B" },
    { id: "case-replacement", pageId: "page-c", pageOrder: 3, category: "structural-negative", insideBubble: true, expected: "C", paddle: "C\ufffd", manga: "C" },
    { id: "case-surrogate", pageId: "page-d", pageOrder: 4, category: "structural-negative", insideBubble: false, expected: "D", paddle: "D\ud800", manga: "D" },
    { id: "case-control", pageId: "page-e", pageOrder: 5, category: "structural-negative", insideBubble: true, expected: "E", paddle: "E\u0001", manga: "E" },
    { id: "case-bidi", pageId: "page-f", pageOrder: 6, category: "structural-negative", insideBubble: false, expected: "F", paddle: "F\u202e", manga: "F" },
    { id: "case-joint-wrong", pageId: "page-g", pageOrder: 7, category: "structural-negative", insideBubble: true, expected: "G", paddle: "X", manga: "X" },
    { id: "case-repeat", pageId: "page-h", pageOrder: 8, category: "structural-negative", insideBubble: false, expected: "ABC", paddle: "ABC", manga: "ABCABCABC" },
    { id: "case-script", pageId: "page-i", pageOrder: 9, category: "structural-negative", insideBubble: true, expected: "\u3042", paddle: "\u3042", manga: "A" },
  ]);
  const report = evaluateOcrArbitration(fixture.benchmarkBytes, fixture.baselineBytes, fixture.routingBytes, fixture.spec);
  assert.equal(report.qa.hardCandidateResiduals.length, 6);
  assert.equal(report.qa.jointWrongAgreementCount, 1);
  assert.equal(report.qa.jointWrongAgreementResiduals.length, 1);
  assert.equal(report.qa.hardCandidateAnomalyCounts.find(({ engine, reason }) => engine === PADDLE && reason === "candidate-missing")!.count, 1);
  assert.equal(report.softDiagnostics.usedForSelection, false);
  assert.equal(report.softDiagnostics.candidates.find(({ engine }) => engine === MANGA)!.repeatedBlockSignalRegions, 1);
  assert.ok(report.softDiagnostics.pair.scriptComponentLoss.find(({ script }) => script === "hiragana")!.mangaMissingRegions >= 1);
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes("case-"));
  assert.ok(!serialized.includes("expectedOcr"));
  assert.ok(!serialized.includes("ABCABCABC"));
});

test("bootstrap is deterministic and versioned spec and report satisfy schemas", async () => {
  const fixture = leakageFixture();
  const first = evaluateOcrArbitration(fixture.benchmarkBytes, fixture.baselineBytes, fixture.routingBytes, fixture.spec);
  const second = evaluateOcrArbitration(fixture.benchmarkBytes, fixture.baselineBytes, fixture.routingBytes, fixture.spec);
  assert.deepEqual(first.strategies.map(({ bootstrapComparisons }) => bootstrapComparisons), second.strategies.map(({ bootstrapComparisons }) => bootstrapComparisons));
  await assert.doesNotReject(() => assertSchema("ocr-arbitration-spec.schema.json", fixture.spec));
  await assert.doesNotReject(() => assertSchema("ocr-arbitration-report.schema.json", first));
});

test("renaming synthetic pages and regions does not change strategy behavior", () => {
  const originalFixture = leakageFixture();
  const renamedFixture = makeFixture([
    { id: "renamed-a", pageId: "renamed-page-a", pageOrder: 1, category: "structural-negative", insideBubble: true, expected: "A", paddle: "A", manga: "X" },
    { id: "renamed-b", pageId: "renamed-page-b", pageOrder: 2, category: "structural-negative", insideBubble: false, expected: "B", paddle: "X", manga: "B" },
    { id: "renamed-c", pageId: "renamed-page-c", pageOrder: 3, category: "structural-negative", insideBubble: false, expected: "C", paddle: "X", manga: "C" },
  ]);
  const original = evaluateOcrArbitration(originalFixture.benchmarkBytes, originalFixture.baselineBytes, originalFixture.routingBytes, originalFixture.spec);
  const renamed = evaluateOcrArbitration(renamedFixture.benchmarkBytes, renamedFixture.baselineBytes, renamedFixture.routingBytes, renamedFixture.spec);
  assert.deepEqual(original.strategies, renamed.strategies);
  assert.deepEqual(original.decision, renamed.decision);
});
