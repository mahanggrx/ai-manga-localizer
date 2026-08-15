import assert from "node:assert/strict";
import test from "node:test";
import {
  assertTranslationReportContainsNoPrivateIdentifiers,
  createTranslationBenchmarkSpec,
  deriveHistoricalTranslationCandidateRun,
  deriveHistoricalTranslationReviewOverlay,
  deriveTranslationBenchmarkInput,
  evaluateTranslationBenchmark,
  parseTranslationBenchmarkInput,
  serializeTranslationArtifact,
  type TranslationCandidateDeclaration,
  type TranslationCandidateRun,
  type TranslationProtocolIdentity,
  type TranslationReviewOverlay,
} from "../src/translation-benchmark.ts";
import { sha256Bytes } from "../src/file-utils.ts";
import { assertSchema } from "../src/schema.ts";

const HISTORICAL_PROTOCOL: TranslationProtocolIdentity = {
  promptMode: "historical-unverified",
  contextMode: "historical-unverified",
  glossaryMode: "historical-unverified",
  formattingContract: "plain-text-v1",
  nonRefusalInstruction: false,
};

const CONTROLLED_PROTOCOL: TranslationProtocolIdentity = {
  promptMode: "controlled-model-mode-v1",
  contextMode: "page-ordered-v1",
  glossaryMode: "none-v1",
  formattingContract: "plain-text-v1",
  nonRefusalInstruction: true,
};

const HISTORICAL_MODEL = {
  id: "historical-model",
  family: "Synthetic Historical",
  version: "1",
  quantization: "Q4",
  sha256: "1".repeat(64),
  license: "synthetic-test-only",
};

const CONTROLLED_MODEL = {
  id: "controlled-model",
  family: "Synthetic Controlled",
  version: "1",
  quantization: "Q4",
  sha256: "2".repeat(64),
  license: "synthetic-test-only",
};

interface Fixture {
  reviewBytes: Uint8Array;
  ocrOverlayBytes: Uint8Array;
  inputBytes: Uint8Array;
  historicalRunBytes: Uint8Array;
  historicalOverlayBytes: Uint8Array;
  specBytes: Uint8Array;
  controlledRunBytes: Uint8Array;
  controlledOverlayBytes: Uint8Array;
}

function reviewHtml(): Uint8Array {
  const annotations = {
    "private-r1": { expectedOcr: "alpha", expectedTranslation: "Reference one", semanticUsable: false, termsCorrect: false, layoutOk: true, nonRefusalRequired: true },
    "private-r2": { expectedOcr: "second case", expectedTranslation: "Reference two", semanticUsable: false, termsCorrect: false, layoutOk: false, nonRefusalRequired: true },
    "private-r3": { expectedOcr: "bravo", expectedTranslation: "Reference three", semanticUsable: true, termsCorrect: true, layoutOk: true, nonRefusalRequired: true },
    "private-r4": { expectedOcr: "fourth control", expectedTranslation: "Reference four", semanticUsable: true, termsCorrect: true, layoutOk: true, nonRefusalRequired: true },
    "private-r5": { expectedOcr: "gold input", expectedTranslation: "Reference five", semanticUsable: false, termsCorrect: false, layoutOk: false, nonRefusalRequired: true },
    "private-r6": { expectedOcr: "not text", expectedTranslation: "Reference six", semanticUsable: false, termsCorrect: false, layoutOk: false, nonRefusalRequired: true },
    "private-r7": { expectedOcr: "missed", expectedTranslation: "Reference seven", semanticUsable: false, termsCorrect: false, layoutOk: false, nonRefusalRequired: true },
  };
  const region = (id: keyof typeof annotations, pageId: string, order: number, sourceText = annotations[id].expectedOcr) => ({
    schemaVersion: 1,
    id,
    pageId,
    order,
    sourceText,
    translatedText: "Historical " + id.slice(-2),
    ocrCandidates: [{ engine: "synthetic-ocr", text: sourceText }],
  });
  const dataset = {
    schemaVersion: 1,
    reviewRevision: 5,
    benchmarkId: "synthetic-review",
    candidate: { id: "historical-candidate", model: HISTORICAL_MODEL },
    pages: [
      {
        pageId: "private-p1",
        selectionOrder: 1,
        category: "ordinary-dialogue",
        regions: [
          region("private-r1", "private-p1", 0),
          region("private-r3", "private-p1", 1),
          region("private-r5", "private-p1", 2, "wrong input"),
        ],
      },
      {
        pageId: "private-p2",
        selectionOrder: 2,
        category: "dense-text",
        regions: [
          region("private-r2", "private-p2", 0),
          region("private-r4", "private-p2", 1),
          region("private-r6", "private-p2", 2),
        ],
      },
    ],
    preAnnotations: {
      regions: annotations,
      extraRegions: {
        "private-p2": [{ id: "private-r7", pageId: "private-p2", order: 3 }],
      },
    },
  };
  return Buffer.from("<html><script id=\"dataset\" type=\"application/json\">" + JSON.stringify(dataset) + "</script></html>", "utf8");
}

function fixture(): Fixture {
  const reviewBytes = reviewHtml();
  const overlay = {
    schemaVersion: 1,
    overlayRevision: 1,
    benchmarkId: "synthetic-ocr-v1",
    base: {
      artifact: "synthetic-review.html",
      sha256: sha256Bytes(reviewBytes),
      byteLength: reviewBytes.byteLength,
      reviewRevision: 5,
    },
    entries: [{ regionId: "private-r6", ocrEligibility: "excluded", exclusionReason: "non-text-false-positive" }],
  };
  const ocrOverlayBytes = serializeTranslationArtifact(overlay);
  const inputBytes = serializeTranslationArtifact(deriveTranslationBenchmarkInput(reviewBytes, ocrOverlayBytes, "synthetic-translation-v1"));
  const historicalRun = deriveHistoricalTranslationCandidateRun(reviewBytes, inputBytes, HISTORICAL_PROTOCOL);
  const historicalRunBytes = serializeTranslationArtifact(historicalRun);
  const historicalOverlayBytes = serializeTranslationArtifact(deriveHistoricalTranslationReviewOverlay(reviewBytes, inputBytes, historicalRunBytes));
  const candidates: TranslationCandidateDeclaration[] = [
    {
      candidateId: historicalRun.candidateId,
      evaluationMode: "historical-e2e",
      model: HISTORICAL_MODEL,
      protocol: HISTORICAL_PROTOCOL,
    },
    {
      candidateId: "controlled-candidate",
      evaluationMode: "fixed-working-gold",
      model: CONTROLLED_MODEL,
      protocol: CONTROLLED_PROTOCOL,
    },
  ];
  const spec = createTranslationBenchmarkSpec(inputBytes, historicalRunBytes, historicalOverlayBytes, candidates, {
    specId: "synthetic-translation-spec-v1",
    seed: "synthetic-seed-v1",
    hardCaseLimit: 2,
    successControlPerStratum: 1,
    bootstrapSeed: 42,
    bootstrapReplicates: 1000,
  });
  const specBytes = serializeTranslationArtifact(spec);
  const input = parseTranslationBenchmarkInput(inputBytes);
  const inputById = new Map(input.regions.map((region) => [region.id, region]));
  const references = new Map((JSON.parse(Buffer.from(historicalOverlayBytes).toString("utf8")) as TranslationReviewOverlay).entries.map((entry) => [entry.regionId, entry.referenceTranslation]));
  const controlledRun: TranslationCandidateRun = {
    schemaVersion: 1,
    runId: "controlled-run-v1",
    benchmarkId: input.benchmarkId,
    candidateId: "controlled-candidate",
    evaluationMode: "fixed-working-gold",
    input: { sha256: sha256Bytes(inputBytes), byteLength: inputBytes.byteLength },
    model: CONTROLLED_MODEL,
    protocol: CONTROLLED_PROTOCOL,
    outputs: spec.challenge.selectedRegionIds.map((regionId, index) => ({
      regionId,
      sourceText: inputById.get(regionId)!.workingGoldOcr!,
      translatedText: index === 0 ? "Acceptable paraphrase" : references.get(regionId)!,
    })),
  };
  const controlledRunBytes = serializeTranslationArtifact(controlledRun);
  const controlledOverlay: TranslationReviewOverlay = {
    schemaVersion: 1,
    reviewRevision: 1,
    benchmarkId: input.benchmarkId,
    candidateId: controlledRun.candidateId,
    source: {
      input: { sha256: sha256Bytes(inputBytes), byteLength: inputBytes.byteLength },
      candidateRun: { sha256: sha256Bytes(controlledRunBytes), byteLength: controlledRunBytes.byteLength },
    },
    entries: controlledRun.outputs.map((output) => ({
      regionId: output.regionId,
      referenceTranslation: references.get(output.regionId)!,
      semanticUsable: "pass",
      terminologyCorrect: "pass",
      refusalDilution: "pass",
      contextCharacterConsistent: "pass",
      layoutUsable: "pass",
    })),
  };
  const controlledOverlayBytes = serializeTranslationArtifact(controlledOverlay);
  return { reviewBytes, ocrOverlayBytes, inputBytes, historicalRunBytes, historicalOverlayBytes, specBytes, controlledRunBytes, controlledOverlayBytes };
}

test("translation derivation separates fixed OCR, historical E2E, and non-translation responsibility", () => {
  const f = fixture();
  const input = parseTranslationBenchmarkInput(f.inputBytes);
  assert.equal(input.regions.length, 7);
  assert.equal(input.regions.filter((region) => region.translationEligibility === "eligible").length, 5);
  assert.deepEqual(
    input.regions.filter((region) => region.translationEligibility === "excluded").map((region) => region.exclusionReason).sort(),
    ["detection-missed", "non-text-false-positive"],
  );
  const serializedInput = Buffer.from(f.inputBytes).toString("utf8");
  assert.ok(!serializedInput.includes("Reference one"));
  assert.ok(!serializedInput.includes("semanticUsable"));

  const report = evaluateTranslationBenchmark(
    f.inputBytes,
    f.specBytes,
    [f.historicalRunBytes, f.controlledRunBytes],
    [f.historicalOverlayBytes, f.controlledOverlayBytes],
  );
  const historical = report.candidates.find((candidate) => candidate.candidateId === "historical-candidate")!;
  assert.deepEqual(historical.attribution, {
    workingGoldRegions: 7,
    translationEligibleRegions: 5,
    nonTranslationResponsibilityRegions: 2,
    observedOutputs: 6,
    eligibleOutputs: 5,
    excludedOutputs: 1,
    missingEligibleOutputs: 0,
    ocrInputRawExact: 4,
    ocrInputNormalizationOnlyExact: 0,
    ocrInputDifferent: 1,
    translationQualityAnalyzable: 4,
    historicalE2EOnly: 1,
  });
  assert.equal(historical.historicalE2E?.population, 7);
  assert.equal(historical.historicalE2E?.ocrInputDifferentSubset.population, 1);
  assert.equal(report.claimBoundary.historicalRunsAreNotFixedOcrModelScores, true);
  assert.equal(report.population.nonTranslationResponsibilityRegions, 2);
});

test("challenge is deterministic, content-free to the runner, and resists post-hoc reselection", () => {
  const first = fixture();
  const second = fixture();
  assert.equal(sha256Bytes(first.inputBytes), sha256Bytes(second.inputBytes));
  assert.equal(sha256Bytes(first.specBytes), sha256Bytes(second.specBytes));
  const specText = Buffer.from(first.specBytes).toString("utf8");
  assert.ok(!specText.includes("Reference one"));
  assert.ok(!specText.includes("expectedTranslation"));
  const spec = JSON.parse(specText);
  assert.equal(spec.challenge.hardCaseCount, 2);
  assert.equal(spec.challenge.successControlCount, 2);
  assert.equal(spec.challenge.nonRefusalCount, 4);
  assert.equal(spec.challenge.selectedRegionIds.length, 4);

  spec.challenge.hardCaseLimit = 1;
  const staleSpecBytes = serializeTranslationArtifact(spec);
  assert.throws(
    () => evaluateTranslationBenchmark(first.inputBytes, staleSpecBytes, [first.historicalRunBytes], [first.historicalOverlayBytes]),
    /selection no longer reproduces/,
  );
});

test("scorer keeps reference distance diagnostic and produces paired page-grouped confidence intervals", () => {
  const f = fixture();
  const report = evaluateTranslationBenchmark(
    f.inputBytes,
    f.specBytes,
    [f.historicalRunBytes, f.controlledRunBytes],
    [f.historicalOverlayBytes, f.controlledOverlayBytes],
  );
  const controlled = report.candidates.find((candidate) => candidate.candidateId === "controlled-candidate")!;
  assert.deepEqual(controlled.challenge.semanticUsable, { reviewed: 4, passed: 4, failed: 0, passRate: 1 });
  assert.equal(controlled.challenge.referenceDiagnostics.normalizedExact, 3);
  assert.equal(report.claimBoundary.referenceDistanceIsDiagnosticOnly, true);
  const semantic = report.pairedComparisons.find((comparison) => comparison.metric === "semantic-usable")!;
  assert.equal(semantic.evidenceClass, "historical-input-agreement-subset-diagnostic");
  assert.equal(semantic.pairedRegions, 4);
  assert.equal(semantic.pairedPages, 2);
  assert.equal(semantic.confidenceInterval.replicates, 1000);
  assert.ok(semantic.confidenceInterval.lower <= semantic.differenceBMinusA);
  assert.ok(semantic.confidenceInterval.upper >= semantic.differenceBMinusA);
});

test("fixed-working-gold candidate input drift and stale review pins fail closed", () => {
  const f = fixture();
  const drifted = JSON.parse(Buffer.from(f.controlledRunBytes).toString("utf8"));
  drifted.outputs[0].sourceText = "changed OCR";
  assert.throws(
    () => evaluateTranslationBenchmark(f.inputBytes, f.specBytes, [f.historicalRunBytes, serializeTranslationArtifact(drifted)], [f.historicalOverlayBytes, f.controlledOverlayBytes]),
    /source drifted/,
  );
  const stale = JSON.parse(Buffer.from(f.controlledOverlayBytes).toString("utf8"));
  stale.source.candidateRun.sha256 = "0".repeat(64);
  assert.throws(
    () => evaluateTranslationBenchmark(f.inputBytes, f.specBytes, [f.historicalRunBytes, f.controlledRunBytes], [f.historicalOverlayBytes, serializeTranslationArtifact(stale)]),
    /fixed hash/,
  );
});

test("preregistered historical source pins and working-gold references cannot be replaced", () => {
  const f = fixture();
  const changedRun = JSON.parse(Buffer.from(f.historicalRunBytes).toString("utf8"));
  changedRun.outputs[0].translatedText = "replacement that does not affect selection";
  const changedRunBytes = serializeTranslationArtifact(changedRun);
  const changedSourceOverlay = JSON.parse(Buffer.from(f.historicalOverlayBytes).toString("utf8"));
  changedSourceOverlay.source.candidateRun = { sha256: sha256Bytes(changedRunBytes), byteLength: changedRunBytes.byteLength };
  const changedSourceOverlayBytes = serializeTranslationArtifact(changedSourceOverlay);
  assert.throws(
    () => evaluateTranslationBenchmark(f.inputBytes, f.specBytes, [changedRunBytes], [changedSourceOverlayBytes]),
    /challenge source candidate run does not match its fixed hash/,
  );

  const referenceDrift = JSON.parse(Buffer.from(f.controlledOverlayBytes).toString("utf8"));
  referenceDrift.entries[0].referenceTranslation = "replacement reference";
  assert.throws(
    () => evaluateTranslationBenchmark(
      f.inputBytes,
      f.specBytes,
      [f.historicalRunBytes, f.controlledRunBytes],
      [f.historicalOverlayBytes, serializeTranslationArtifact(referenceDrift)],
    ),
    /reference drifted/,
  );
});

test("all translation artifacts satisfy schemas and the report omits private page and region ids", async () => {
  const f = fixture();
  const input = JSON.parse(Buffer.from(f.inputBytes).toString("utf8"));
  const run = JSON.parse(Buffer.from(f.historicalRunBytes).toString("utf8"));
  const overlay = JSON.parse(Buffer.from(f.historicalOverlayBytes).toString("utf8"));
  const spec = JSON.parse(Buffer.from(f.specBytes).toString("utf8"));
  const report = evaluateTranslationBenchmark(
    f.inputBytes,
    f.specBytes,
    [f.historicalRunBytes, f.controlledRunBytes],
    [f.historicalOverlayBytes, f.controlledOverlayBytes],
  );
  await assert.doesNotReject(() => assertSchema("translation-benchmark-input.schema.json", input));
  await assert.doesNotReject(() => assertSchema("translation-candidate-run.schema.json", run));
  await assert.doesNotReject(() => assertSchema("translation-review-overlay.schema.json", overlay));
  await assert.doesNotReject(() => assertSchema("translation-benchmark-spec.schema.json", spec));
  await assert.doesNotReject(() => assertSchema("translation-benchmark-report.schema.json", report));
  assert.doesNotThrow(() => assertTranslationReportContainsNoPrivateIdentifiers(report, input));
  const reportText = JSON.stringify(report);
  assert.ok(!reportText.includes("private-r"));
  assert.ok(!reportText.includes("private-p"));
  assert.ok(!reportText.includes("Reference "));
});
