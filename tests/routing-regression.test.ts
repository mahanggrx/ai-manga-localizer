import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRoutingRegression, selectMinimalRoleHardCases, type RoutingRegressionInput } from "../src/routing-regression.ts";
import { assertSchema } from "../src/schema.ts";

function fixture(): RoutingRegressionInput {
  return {
    schemaVersion: 2,
    benchmarkId: "synthetic-routing-v2",
    observations: [
      {
        id: "inside",
        pageId: "p1",
        pageOrder: 1,
        category: "ordinary-dialogue",
        detected: true,
        nativeRole: "unknown",
        legacyPolicy: "replace",
        evidence: { insideBubble: true, confidence: 0.99, roleProvenance: "bubble-mask", geometrySource: "line-polygons" },
        overlapRate: 0.99,
        dominantShare: 1,
      },
      {
        id: "outside",
        pageId: "p2",
        pageOrder: 2,
        category: "artistic-sfx-action",
        detected: true,
        nativeRole: "unknown",
        legacyPolicy: "replace",
        evidence: { insideBubble: false, confidence: 1, roleProvenance: "bubble-mask", geometrySource: "bbox" },
        overlapRate: 0,
        dominantShare: 0,
        hardCaseTags: ["detected-external:artistic-sfx-action"],
        hardness: 2,
      },
      {
        id: "uncertain",
        pageId: "p3",
        pageOrder: 3,
        category: "dark-complex",
        detected: true,
        nativeRole: "unknown",
        legacyPolicy: "replace",
        evidence: { confidence: 0.6, roleProvenance: "bubble-mask", geometrySource: "line-polygons" },
        overlapRate: 0.6,
        dominantShare: 1,
        hardCaseTags: ["uncertain:threshold-band"],
        hardness: 3,
      },
      {
        id: "missed",
        pageId: "p4",
        pageOrder: 4,
        category: "structural-negative",
        detected: false,
        evidence: { insideBubble: false, confidence: 1, roleProvenance: "bubble-mask", geometrySource: "bbox" },
        overlapRate: 0,
        dominantShare: 0,
        hardCaseTags: ["undetected-external", "uncertain:threshold-band"],
        hardness: 1,
      },
    ],
  };
}

test("routing regression separates bubble evidence and preserves every runtime unknown", () => {
  const report = evaluateRoutingRegression(fixture());
  assert.equal(report.regionCount, 4);
  assert.equal(report.detectedRegionCount, 3);
  assert.deepEqual(report.distribution, { ordinaryDialogue: 1, bubbleExternal: 2, unknown: 1 });
  assert.deepEqual(report.detectedDistribution, { ordinaryDialogue: 1, bubbleExternal: 1, unknown: 1 });
  assert.deepEqual(report.runtimeRoles, { dialogue: 1, caption: 0, sfx: 0, unknown: 2 });
  assert.deepEqual(report.policies, { replace: 1, "preserve-with-annotation": 2 });
  assert.deepEqual(report.bubbleMapping, { mapped: 1, total: 3, rate: 1 / 3 });
  assert.deepEqual(report.deterministicEvidence, { classified: 2, total: 3, rate: 2 / 3 });
  assert.deepEqual(report.geometrySourceCounts, { "line-polygons": 2, bbox: 1 });
  assert.deepEqual(report.polygonGate, { status: "failed", freezeEligible: false, reasonCode: "BBOX_FALLBACK_PRESENT" });
  assert.deepEqual(report.pageSafety, {
    reviewedPages: 4,
    pagesWithDetectedUnknown: 2,
    pagesWithNoDetectedRegions: 1,
    pagesWithoutUnknownOrEmptyBlock: 1,
  });
  assert.deepEqual(report.overlapSeparation, {
    bubbleExternalMaximum: 0,
    ordinaryDialogueMinimum: 0.99,
    ordinaryDialogueDominantMinimum: 1,
  });
  assert.equal(report.legacyUnknownReplaceCount, 3);
  assert.equal(report.unknownReplaceViolationCount, 0);
});

test("hard-case selection covers every evidence facet with stable tie breaking", () => {
  const selected = selectMinimalRoleHardCases(fixture().observations);
  assert.deepEqual(selected.map((item) => item.id), ["outside", "missed"]);
  assert.deepEqual(selected[1].tags, ["uncertain:threshold-band", "undetected-external"]);
});

test("hard-case selection finds an exact minimum when greedy coverage would need three cases", () => {
  const candidate = (id: string, pageOrder: number, hardCaseTags: string[]) => ({
    id, pageId: `p${pageOrder}`, pageOrder, category: "synthetic", detected: true, hardCaseTags,
  });
  const selected = selectMinimalRoleHardCases([
    candidate("greedy", 1, ["a", "b", "c", "d"]),
    candidate("left", 2, ["a", "b", "e"]),
    candidate("right", 3, ["c", "d", "f"]),
    candidate("tail-e", 4, ["e"]),
    candidate("tail-f", 5, ["f"]),
  ]);
  assert.deepEqual(selected.map((item) => item.id), ["left", "right"]);
});

test("routing regression fails closed on invalid confidence and duplicate ids", () => {
  const invalidConfidence = fixture();
  invalidConfidence.observations[0].evidence!.confidence = 1.1;
  assert.throws(() => evaluateRoutingRegression(invalidConfidence), /confidence is invalid/);

  const duplicate = fixture();
  duplicate.observations[1].id = "inside";
  assert.throws(() => evaluateRoutingRegression(duplicate), /duplicate region ids/);

  const privateField = fixture() as RoutingRegressionInput & { observations: Array<RoutingRegressionInput["observations"][number] & { sourceText?: string }> };
  privateField.observations[0].sourceText = "must-not-pass";
  assert.throws(() => evaluateRoutingRegression(privateField), /unsupported field/);
});

test("strict polygon gate rejects all-bbox data and accepts only polygon geometry", () => {
  const allBbox = fixture();
  for (const observation of allBbox.observations) if (observation.evidence?.roleProvenance === "bubble-mask") observation.evidence.geometrySource = "bbox";
  const unavailable = evaluateRoutingRegression(allBbox);
  assert.deepEqual(unavailable.geometrySourceCounts, { "line-polygons": 0, bbox: 3 });
  assert.deepEqual(unavailable.polygonGate, { status: "failed", freezeEligible: false, reasonCode: "LINE_POLYGONS_UNAVAILABLE" });

  const allPolygons = fixture();
  for (const observation of allPolygons.observations) if (observation.evidence?.roleProvenance === "bubble-mask") observation.evidence.geometrySource = "line-polygons";
  const eligible = evaluateRoutingRegression(allPolygons);
  assert.deepEqual(eligible.geometrySourceCounts, { "line-polygons": 3, bbox: 0 });
  assert.deepEqual(eligible.polygonGate, { status: "passed", freezeEligible: true });

  const incompletePolygons = fixture();
  delete incompletePolygons.observations[1].evidence;
  delete incompletePolygons.observations[1].overlapRate;
  delete incompletePolygons.observations[1].dominantShare;
  const incomplete = evaluateRoutingRegression(incompletePolygons);
  assert.deepEqual(incomplete.geometrySourceCounts, { "line-polygons": 2, bbox: 0 });
  assert.deepEqual(incomplete.polygonGate, { status: "failed", freezeEligible: false, reasonCode: "GEOMETRY_EVIDENCE_INCOMPLETE" });
});

test("routing regression rejects evidence that contradicts overlap thresholds or derived confidence", () => {
  const insideBelowThreshold = fixture();
  insideBelowThreshold.observations[0].dominantShare = 0.7;
  assert.throws(() => evaluateRoutingRegression(insideBelowThreshold), /bubble state contradicts overlap evidence/);

  const outsideAboveThreshold = fixture();
  outsideAboveThreshold.observations[1].overlapRate = 0.1;
  outsideAboveThreshold.observations[1].dominantShare = 1;
  outsideAboveThreshold.observations[1].evidence!.confidence = 0.9;
  assert.throws(() => evaluateRoutingRegression(outsideAboveThreshold), /bubble state contradicts overlap evidence/);

  const falseUncertainty = fixture();
  falseUncertainty.observations[2].overlapRate = 0.9;
  falseUncertainty.observations[2].evidence!.confidence = 0.9;
  assert.throws(() => evaluateRoutingRegression(falseUncertainty), /bubble state contradicts overlap evidence/);

  const mixedLabelUncertainty = fixture();
  mixedLabelUncertainty.observations[2].overlapRate = 0.9;
  mixedLabelUncertainty.observations[2].dominantShare = 0.5;
  mixedLabelUncertainty.observations[2].evidence!.confidence = 0.9;
  assert.doesNotThrow(() => evaluateRoutingRegression(mixedLabelUncertainty));

  const wrongConfidence = fixture();
  wrongConfidence.observations[0].evidence!.confidence = 0.98;
  assert.throws(() => evaluateRoutingRegression(wrongConfidence), /confidence contradicts overlap evidence/);

  const impossibleDominantShare = fixture();
  impossibleDominantShare.observations[1].dominantShare = 0.5;
  assert.throws(() => evaluateRoutingRegression(impossibleDominantShare), /dominant-label share contradicts overlap rate/);
});

test("routing regression input and report satisfy their versioned schemas", async () => {
  const input = fixture();
  await assert.doesNotReject(() => assertSchema("routing-regression-input.schema.json", input));
  await assert.doesNotReject(() => assertSchema("routing-regression-report.schema.json", evaluateRoutingRegression(input)));

  const privateInput = fixture() as RoutingRegressionInput & { observations: Array<RoutingRegressionInput["observations"][number] & { sourceText?: string }> };
  privateInput.observations[0].sourceText = "must-not-pass";
  await assert.rejects(() => assertSchema("routing-regression-input.schema.json", privateInput), /unexpected property/);

  const blobInput = fixture() as RoutingRegressionInput & { observations: Array<RoutingRegressionInput["observations"][number] & { evidence?: RoutingRegressionInput["observations"][number]["evidence"] & { blobHash?: string } }> };
  blobInput.observations[0].evidence!.blobHash = "a".repeat(64);
  assert.throws(() => evaluateRoutingRegression(blobInput), /unsupported field/);
  await assert.rejects(() => assertSchema("routing-regression-input.schema.json", blobInput), /unexpected property/);
});
