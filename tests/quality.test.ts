import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { applyChapterQa, assessRegion, buildRetryPrompt, chunkPageIds, classifyRole, containsJapaneseKana, containsReasoningArtifact, deriveGlossary, extractPageIds, extractRegionsFromScene, looksLikeRefusal, markRenderBlockedPages, renderBlockedPages, renderProtectionPlan, translationRetryPages } from "../src/quality.ts";
import type { JsonObject, RegionRecord } from "../src/types.ts";

test("scene extractor supports direct node and semantic component shapes", () => {
  const scene = {
    pages: [
      {
        pageId: "p1",
        nodes: [{ id: "r1", sourceText: "こんにちは！", translatedText: "你好！", ocrConfidence: 0.95, insideBubble: true, bbox: { x: 0, y: 0, width: 200, height: 100 } }],
      },
    ],
    components: [
      { type: "SourceText", ownerId: "r2", pageId: "p2", value: { text: "ドン" } },
      { type: "Translation", ownerId: "r2", pageId: "p2", value: { text: "咚" } },
      { type: "OcrAnalysis", ownerId: "r2", pageId: "p2", confidence: 0.9 },
      { type: "Geometry", ownerId: "r2", pageId: "p2", value: { x: 10, y: 10, width: 100, height: 100 } },
      { type: "Region", ownerId: "r2", pageId: "p2", regionType: "sfx", insideBubble: false },
    ],
  } as unknown as JsonObject;
  const regions = extractRegionsFromScene(scene, { ocrEngine: "paddle", translationModel: "sakura", quality: DEFAULT_CONFIG.quality });
  assert.equal(regions.length, 2);
  assert.equal(regions.find((region) => region.id === "r1")?.role, "dialogue");
  assert.equal(regions.find((region) => region.id === "r2")?.policy, "preserve-with-annotation");
  assert.deepEqual(extractPageIds(scene), ["p1", "p2"]);
  assert.equal(regions[0].ocrCandidates[0].selectionReason, "primary-engine-output");
});

test("scene extractor supports Koharu 0.61.2 object maps and kind.text nodes", () => {
  const scene = {
    epoch: 16,
    scene: {
      pages: {
        "page-uuid": {
          id: "page-uuid",
          name: "001.png",
          width: 1200,
          height: 1800,
          nodes: {
            "region-uuid": {
              id: "region-uuid",
              kind: {
                text: {
                  text: "こんにちは！",
                  translation: "你好！",
                  confidence: 0.97,
                  sourceLang: "ja",
                },
              },
              transform: { x: 20, y: 30, width: 200, height: 100, rotationDeg: 0 },
              visible: true,
            },
          },
        },
      },
    },
  } as unknown as JsonObject;
  const regions = extractRegionsFromScene(scene, { ocrEngine: "paddle", translationModel: "sakura", quality: DEFAULT_CONFIG.quality });
  assert.deepEqual(extractPageIds(scene), ["page-uuid"]);
  assert.equal(regions.length, 1);
  assert.equal(regions[0].id, "region-uuid");
  assert.equal(regions[0].pageId, "page-uuid");
  assert.equal(regions[0].translatedText, "你好！");
  assert.equal(regions[0].ocrConfidence, 0.97);
  assert.deepEqual(regions[0].bbox, { x: 20, y: 30, width: 200, height: 100 });
});

test("chapter page chunks preserve order and overlap context", () => {
  assert.deepEqual(chunkPageIds(["p1", "p2", "p3", "p4", "p5"], 3, 1), [
    ["p1", "p2", "p3"],
    ["p3", "p4", "p5"],
  ]);
  assert.throws(() => chunkPageIds(["p1"], 2, 2), /smaller than chunkPages/);
});

test("quality rules detect refusal, kana leakage, missing tokens, and low OCR", () => {
  const region: RegionRecord = {
    schemaVersion: 1,
    id: "r1",
    pageId: "p1",
    order: 0,
    role: "dialogue",
    policy: "replace",
    sourceText: "テスト123！",
    translatedText: "抱歉，我无法翻译テスト",
    ocrConfidence: 0.2,
    ocrCandidates: [],
    translationCandidates: [],
    qaFlags: [],
  };
  const codes = assessRegion(region, DEFAULT_CONFIG.quality).map((flag) => flag.code);
  assert.ok(codes.includes("LOW_OCR_CONFIDENCE"));
  assert.ok(codes.includes("TRANSLATION_REFUSAL"));
  assert.ok(codes.includes("JAPANESE_KANA_REMAINS"));
  assert.ok(codes.includes("SIGNIFICANT_TOKEN_LOST"));
  assert.equal(containsJapaneseKana("中文テスト"), true);
  assert.equal(looksLikeRefusal("抱歉，我无法翻译"), true);
});

test("roles require native evidence or a high-confidence bubble mask", () => {
  assert.deepEqual(classifyRole("sfx"), { role: "sfx", confidence: 1, provenance: "native" });
  assert.deepEqual(classifyRole(undefined, { insideBubble: true, confidence: 0.95, provenance: "bubble-mask" }), { role: "dialogue", confidence: 0.95, provenance: "bubble-mask" });
  assert.deepEqual(classifyRole(undefined, { insideBubble: true, confidence: 0.5, provenance: "bubble-mask" }), { role: "unknown", confidence: 0, provenance: "insufficient-evidence" });
  assert.deepEqual(classifyRole(undefined, { insideBubble: false, confidence: 1, provenance: "bubble-mask" }), { role: "unknown", confidence: 0, provenance: "insufficient-evidence" });
  const make = (id: string): RegionRecord => ({
    schemaVersion: 1, id, pageId: "p1", order: Number(id.slice(1)), role: "dialogue", policy: "replace",
    sourceText: "山田", translatedText: "山田", ocrCandidates: [], translationCandidates: [], qaFlags: [],
  });
  const glossary = deriveGlossary(applyChapterQa([make("r1"), make("r2")], DEFAULT_CONFIG.quality));
  assert.equal(glossary["山田"], "山田");
  assert.match(buildRetryPrompt("重试", glossary), /山田 => 山田/);
});

test("pure OCR warnings do not trigger a cloud translation retry", () => {
  const region: RegionRecord = {
    schemaVersion: 1, id: "r1", pageId: "p1", order: 0, role: "dialogue", policy: "replace",
    sourceText: "こんにちは", translatedText: "你好", ocrConfidence: 0.1,
    ocrCandidates: [], translationCandidates: [], qaFlags: [],
  };
  const assessed = applyChapterQa([region], DEFAULT_CONFIG.quality);
  assert.ok(assessed[0].qaFlags.some((flag) => flag.code === "LOW_OCR_CONFIDENCE"));
  assert.deepEqual(translationRetryPages(assessed), []);
});

test("reasoning artifacts trigger retry and block rendering", () => {
  const region: RegionRecord = {
    schemaVersion: 1, id: "r1", pageId: "p1", order: 0, role: "dialogue", policy: "replace",
    sourceText: "原文", translatedText: "<think>internal reasoning</think>译文",
    ocrCandidates: [], translationCandidates: [], qaFlags: [],
  };
  const assessed = applyChapterQa([region], DEFAULT_CONFIG.quality);
  assert.equal(containsReasoningArtifact(region.translatedText!), true);
  assert.ok(assessed[0].qaFlags.some((flag) => flag.code === "LLM_REASONING_LEAK"));
  assert.deepEqual(translationRetryPages(assessed), ["p1"]);
  assert.deepEqual(renderBlockedPages(assessed), ["p1"]);
});

test("render safety preserves only strict blockers and compound overflow failures", () => {
  const make = (pageId: string, codes: string[]): RegionRecord => ({
    schemaVersion: 1,
    id: `region-${pageId}`,
    pageId,
    order: 0,
    role: "dialogue",
    policy: "replace",
    sourceText: "原文",
    translatedText: "译文",
    ocrCandidates: [],
    translationCandidates: [],
    qaFlags: codes.map((code) => ({ code, severity: code === "TEXT_OVERFLOW_RISK" ? "error" : "warning", retryable: true })),
  });
  const regions = [
    make("overflow-only", ["TEXT_OVERFLOW_RISK"]),
    make("compound-overflow", ["TEXT_OVERFLOW_RISK", "TRANSLATION_TOO_LONG"]),
    make("kana", ["JAPANESE_KANA_REMAINS"]),
    make("missing", ["MISSING_TRANSLATION"]),
  ];
  assert.deepEqual(renderBlockedPages(regions), ["compound-overflow", "kana", "missing"]);
  const marked = markRenderBlockedPages(regions, new Set(["compound-overflow"]));
  assert.equal(marked[0].qaFlags.some((flag) => flag.code === "RENDERING_SKIPPED_FOR_PAGE"), false);
  assert.equal(marked[1].qaFlags.filter((flag) => flag.code === "RENDERING_SKIPPED_FOR_PAGE").length, 1);
  assert.equal(markRenderBlockedPages(marked, new Set(["compound-overflow"]))[1].qaFlags.filter((flag) => flag.code === "RENDERING_SKIPPED_FOR_PAGE").length, 1);
});

test("structural render protection fails closed for risky boundary, empty, and artistic-only pages", () => {
  const make = (pageId: string, codes: string[] = [], policy: RegionRecord["policy"] = "replace", id = "1"): RegionRecord => ({
    schemaVersion: 1,
    id: `${pageId}-${id}`,
    pageId,
    order: Number(id),
    role: policy === "preserve-with-annotation" ? "sfx" : "dialogue",
    policy,
    sourceText: "source",
    translatedText: "target",
    ocrCandidates: [],
    translationCandidates: [],
    qaFlags: codes.map((code) => ({ code, severity: "warning", retryable: true })),
  });
  const pageIds = ["cover", "story", "art", "blank", "credits"];
  const regions = [
    make("cover", ["LOW_OCR_CONFIDENCE"]),
    make("story", ["JAPANESE_KANA_REMAINS"]),
    make("art", [], "preserve-with-annotation"),
    ...Array.from({ length: 12 }, (_, index) => make("credits", index < 6 ? ["LOW_OCR_CONFIDENCE"] : [], "replace", String(index))),
  ];
  assert.deepEqual(renderProtectionPlan(pageIds, regions, DEFAULT_CONFIG.quality.structuralProtection), [
    { pageId: "cover", codes: ["RISKY_BOUNDARY_PAGE"] },
    { pageId: "story", codes: ["BLOCKING_REGION_QA"] },
    { pageId: "art", codes: ["ARTISTIC_TEXT_ONLY_PAGE"] },
    { pageId: "blank", codes: ["NO_TEXT_REGIONS_DETECTED"] },
    { pageId: "credits", codes: ["RISKY_BOUNDARY_PAGE"] },
  ]);
  assert.deepEqual(renderProtectionPlan(["single"], [make("single")], DEFAULT_CONFIG.quality.structuralProtection), []);
});

test("structural render protection rejects ambiguous scene-to-region mappings", () => {
  const region: RegionRecord = {
    schemaVersion: 1,
    id: "region-orphan",
    pageId: "outside-scene",
    order: 0,
    role: "dialogue",
    policy: "replace",
    sourceText: "source",
    translatedText: "target",
    ocrCandidates: [],
    translationCandidates: [],
    qaFlags: [],
  };
  const expected = (error: unknown): boolean => (
    error instanceof Error
    && "code" in error
    && error.code === "RENDER_PROTECTION_PAGE_MAPPING_INVALID"
  );

  assert.throws(
    () => renderProtectionPlan(["duplicate", "duplicate"], [], DEFAULT_CONFIG.quality.structuralProtection),
    expected,
  );
  assert.throws(
    () => renderProtectionPlan(["inside-scene"], [region], DEFAULT_CONFIG.quality.structuralProtection),
    expected,
  );
});
