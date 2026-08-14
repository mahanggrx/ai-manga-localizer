import assert from "node:assert/strict";
import test from "node:test";
import {
  OCR_RUNTIME_POLICY_VERSION,
  applyOcrRuntimeDecisions,
  applyOcrRuntimePolicy,
  extractOcrRuntimeRegions,
  type OcrRuntimePass,
  type OcrRuntimeRegionCandidate,
} from "../src/ocr-runtime-policy.ts";
import { assertSchema } from "../src/schema.ts";
import type { RegionRecord } from "../src/types.ts";

const geometry = { x: 10, y: 20, width: 30, height: 40 };

function region(overrides: Partial<OcrRuntimeRegionCandidate> = {}): OcrRuntimeRegionCandidate {
  return { id: "region-1", pageId: "page-1", order: 0, sourceGeometry: geometry, text: "原文", ...overrides };
}

function pass(engine: string, candidate: OcrRuntimeRegionCandidate, status: OcrRuntimePass["status"] = "ran"): OcrRuntimePass {
  return { engine, status, regions: status === "ran" ? [candidate] : [] };
}

function decide(paddleRegion: OcrRuntimeRegionCandidate, mangaRegion: OcrRuntimeRegionCandidate, policy: "strict-quality" | "low-manual" = "strict-quality") {
  return applyOcrRuntimePolicy(pass("paddle-ocr", paddleRegion), pass("manga-ocr", mangaRegion), policy).decisions[0];
}

test("runtime policy accepts raw and normalization-only agreement without confidence comparison", () => {
  const raw = decide(region({ confidence: 0.01 }), region({ confidence: 0.99 }));
  assert.equal(raw.selectionReason, "raw-agreement");
  assert.equal(raw.selectedEngine, "paddle-ocr");
  assert.equal(raw.selectedSourceText, "原文");
  assert.deepEqual(raw.qaReasons, []);
  assert.equal(raw.policy.version, OCR_RUNTIME_POLICY_VERSION);
  assert.equal(raw.candidates[0].confidence, 0.01);
  assert.equal(raw.candidates[1].confidence, 0.99);

  const normalizationOnly = decide(region({ text: "Ａ 原" }), region({ text: "A原" }));
  assert.equal(normalizationOnly.selectionReason, "normalized-agreement");
  assert.equal(normalizationOnly.selectedSourceText, "Ａ 原");

  const inverted = decide(region({ confidence: 0.99 }), region({ confidence: 0.01 }));
  assert.equal(inverted.selectionReason, raw.selectionReason);
  assert.equal(inverted.selectedEngine, raw.selectedEngine);
  assert.equal(inverted.selectedSourceText, raw.selectedSourceText);
});

test("strict-quality blocks safe disagreement while low-manual deterministically selects Paddle", () => {
  const strict = decide(region({ text: "甲" }), region({ text: "乙" }), "strict-quality");
  assert.equal(strict.selectionReason, "qa-blocked");
  assert.equal(strict.selectedEngine, undefined);
  assert.deepEqual(strict.qaReasons, ["candidate-disagreement"]);
  assert.equal(strict.candidates.some((candidate) => candidate.selected), false);

  const lowManual = decide(region({ text: "甲", confidence: 0.1 }), region({ text: "乙", confidence: 0.9 }), "low-manual");
  assert.equal(lowManual.selectionReason, "low-manual-paddle-precedence");
  assert.equal(lowManual.selectedEngine, "paddle-ocr");
  assert.equal(lowManual.selectedSourceText, "甲");
  assert.deepEqual(lowManual.qaReasons, []);
});

test("missing and hard-unsafe candidates enter blocking QA on either engine", () => {
  const primaryMissing = decide(region({ text: undefined }), region());
  assert.deepEqual(primaryMissing.qaReasons, ["paddle-candidate-missing"]);
  assert.equal(primaryMissing.candidates[0].status, "missing");

  const fallbackMissing = decide(region(), region({ text: undefined }));
  assert.deepEqual(fallbackMissing.qaReasons, ["manga-candidate-missing"]);
  assert.equal(fallbackMissing.candidates[1].status, "missing");

  const bothUnsafe = decide(region({ text: "x\ufffd" }), region({ text: "x\u202e" }), "low-manual");
  assert.deepEqual(bothUnsafe.qaReasons, ["paddle-replacement-character", "manga-bidi-control"]);
  assert.equal(bothUnsafe.selectionReason, "qa-blocked");
});

test("fallback not-run is distinct from a ran pass with a missing candidate", () => {
  const result = applyOcrRuntimePolicy(
    pass("paddle-ocr", region()),
    { engine: "manga-ocr", status: "not-run", regions: [] },
    "strict-quality",
  );
  assert.equal(result.blocked, true);
  assert.deepEqual(result.decisions[0].qaReasons, ["fallback-not-run"]);
  assert.equal(result.decisions[0].candidates[1].status, "not-run");

  const missing = decide(region(), region({ text: undefined }));
  assert.deepEqual(missing.qaReasons, ["manga-candidate-missing"]);
  assert.equal(missing.candidates[1].status, "missing");
});

test("runtime association fails closed on duplicate, extra, missing, page, and geometry conflicts", () => {
  const primary = pass("paddle-ocr", region());
  const duplicatePrimary: OcrRuntimePass = { engine: "paddle-ocr", status: "ran", regions: [region(), region()] };
  assert.throws(() => applyOcrRuntimePolicy(duplicatePrimary, pass("manga-ocr", region()), "strict-quality"), /duplicate region/i);
  const duplicate: OcrRuntimePass = { engine: "manga-ocr", status: "ran", regions: [region(), region()] };
  assert.throws(() => applyOcrRuntimePolicy(primary, duplicate, "strict-quality"), /duplicate region/i);

  const extra: OcrRuntimePass = { engine: "manga-ocr", status: "ran", regions: [region(), region({ id: "extra" })] };
  assert.throws(() => applyOcrRuntimePolicy(primary, extra, "strict-quality"), /outside the eligible Paddle population/);

  const missing: OcrRuntimePass = { engine: "manga-ocr", status: "ran", regions: [] };
  assert.throws(() => applyOcrRuntimePolicy(primary, missing, "strict-quality"), /missing an eligible region association/);

  assert.throws(() => applyOcrRuntimePolicy(primary, pass("manga-ocr", region({ pageId: "page-2" })), "strict-quality"), /different pages/);
  assert.throws(() => applyOcrRuntimePolicy(primary, pass("manga-ocr", region({ sourceGeometry: { ...geometry, width: 31 } })), "strict-quality"), /geometry/);
});

test("Koharu scene extraction retains a ran-but-missing text node and rejects duplicate IDs", () => {
  const snapshot = {
    epoch: 7,
    scene: {
      pages: {
        "page-1": {
          id: "page-1",
          nodes: {
            "region-1": { id: "region-1", transform: geometry, kind: { text: { text: null, confidence: 0.7 } } },
          },
        },
      },
    },
  };
  assert.deepEqual(extractOcrRuntimeRegions(snapshot), [{ id: "region-1", pageId: "page-1", order: 0, sourceGeometry: geometry, confidence: 0.7 }]);

  const duplicate = {
    pages: [{ pageId: "page-1", nodes: [
      { id: "region-1", bbox: geometry, sourceText: "甲" },
      { id: "region-1", bbox: geometry, sourceText: "乙" },
    ] }],
  };
  assert.throws(() => extractOcrRuntimeRegions(duplicate), /duplicate region identities/);

  const pageIdentityConflict = {
    pages: { "page-key": { id: "page-value", nodes: {} } },
  };
  assert.throws(() => extractOcrRuntimeRegions(pageIdentityConflict), /page identity conflicts/i);

  const regionIdentityConflict = {
    pages: { "page-1": { id: "page-1", nodes: {
      "region-key": { id: "region-value", bbox: geometry, sourceText: "synthetic" },
    } } },
  };
  assert.throws(() => extractOcrRuntimeRegions(regionIdentityConflict), /region identity conflicts/i);
});

test("accepted runtime decisions produce a versioned two-candidate RegionRecord", async () => {
  const result = applyOcrRuntimePolicy(pass("paddle-ocr", region({ confidence: 0.2 })), pass("manga-ocr", region({ confidence: 0.8 })), "strict-quality");
  const provisional: RegionRecord = {
    schemaVersion: 2,
    id: "region-1",
    pageId: "page-1",
    order: 0,
    role: "dialogue",
    policy: "replace",
    sourceText: "原文",
    bbox: geometry,
    ocrCandidates: [{ engine: "paddle-ocr", role: "paddle", status: "present", text: "原文", confidence: 0.2, selected: true, selectionReason: "primary-engine-output" }],
    translationCandidates: [],
    qaFlags: [],
  };
  const [record] = applyOcrRuntimeDecisions([provisional], result);
  assert.equal(record.schemaVersion, 2);
  assert.deepEqual(record.ocrRuntimePolicy, { name: "strict-quality", version: 1 });
  assert.equal(record.selectedOcrEngine, "paddle-ocr");
  assert.equal(record.ocrSelectionReason, "raw-agreement");
  assert.deepEqual(record.ocrQaReasons, []);
  assert.equal(record.ocrCandidates.length, 2);
  assert.equal("ocrConfidence" in record, false);
  await assert.doesNotReject(() => assertSchema("region-record.schema.json", record));

  const blockedResult = applyOcrRuntimePolicy(
    pass("paddle-ocr", region({ text: "left" })),
    pass("manga-ocr", region({ text: "right" })),
    "strict-quality",
  );
  const [blockedRecord] = applyOcrRuntimeDecisions([provisional], blockedResult);
  assert.equal(blockedRecord.ocrSelectionReason, "qa-blocked");
  assert.equal(blockedRecord.selectedOcrEngine, undefined);
  assert.deepEqual(blockedRecord.ocrQaReasons, ["candidate-disagreement"]);
  assert.deepEqual(blockedRecord.qaFlags.map((flag) => flag.code), ["OCR_RUNTIME_CANDIDATE_DISAGREEMENT"]);
  await assert.doesNotReject(() => assertSchema("region-record.schema.json", blockedRecord));
});
