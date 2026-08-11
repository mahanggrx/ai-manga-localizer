import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRoutingRegression, selectMinimalRoleHardCases, type RoutingRegressionInput } from "../src/routing-regression.ts";
import { assertSchema } from "../src/schema.ts";

function fixture(): RoutingRegressionInput {
  return {
    schemaVersion: 1,
    benchmarkId: "synthetic-routing-v1",
    observations: [
      {
        id: "inside",
        pageId: "p1",
        pageOrder: 1,
        category: "ordinary-dialogue",
        detected: true,
        nativeRole: "unknown",
        legacyPolicy: "replace",
        evidence: { insideBubble: true, confidence: 0.98, provenance: "bubble-mask" },
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
        evidence: { insideBubble: false, confidence: 1, provenance: "bubble-mask" },
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
        evidence: { confidence: 0.6, provenance: "bubble-mask" },
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
        evidence: { insideBubble: false, confidence: 1, provenance: "bubble-mask" },
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

test("routing regression input and report satisfy their versioned schemas", async () => {
  const input = fixture();
  await assert.doesNotReject(() => assertSchema("routing-regression-input.schema.json", input));
  await assert.doesNotReject(() => assertSchema("routing-regression-report.schema.json", evaluateRoutingRegression(input)));
});
