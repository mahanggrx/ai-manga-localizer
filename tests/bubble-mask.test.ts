import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { buildBubbleMaskEvidence, decodeBubbleMask } from "../src/bubble-mask.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { extractRegionsFromScene, renderProtectionPlan } from "../src/quality.ts";
import type { JsonObject } from "../src/types.ts";

const HASH = "a".repeat(64);

async function webpMask(width: number, height: number, labels: Uint8Array): Promise<Uint8Array> {
  return await sharp(labels, { raw: { width, height, channels: 1 } }).webp({ lossless: true }).toBuffer();
}

function sceneWithNodes(width: number, height: number, nodes: Record<string, unknown>): JsonObject {
  return {
    epoch: 1,
    scene: {
      pages: {
        page1: {
          id: "page1",
          width,
          height,
          nodes: {
            bubbleMask: {
              id: "bubbleMask",
              kind: { mask: { role: "bubble", blob: HASH } },
              transform: { x: 0, y: 0, width: 0, height: 0, rotationDeg: 0 },
            },
            ...nodes,
          },
        },
      },
    },
  } as unknown as JsonObject;
}

function textNode(id: string, x: number, y: number, width: number, height: number, extraText: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    kind: { text: { text: `source-${id}`, ...extraText } },
    transform: { x, y, width, height, rotationDeg: 0 },
  };
}

test("bubble mask maps inside, outside, partial, shared-label, polygon, and page-coordinate evidence", async () => {
  const width = 8;
  const height = 4;
  const labels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < 4; x += 1) labels[y * width + x] = 7;
  const bytes = await webpMask(width, height, labels);
  const scene = sceneWithNodes(width, height, {
    inside1: textNode("inside1", 0, 0, 2, 2, { translation: "target-inside1" }),
    inside2: textNode("inside2", 2, 2, 2, 2, { translation: "target-inside2" }),
    outside: textNode("outside", 6, 0, 2, 2),
    partial: textNode("partial", 2, 0, 4, 2),
    polygon: textNode("polygon", 6, 2, 2, 2, { translation: "target-polygon", linePolygons: [[[0, 2], [2, 2], [2, 4], [0, 4]]] }),
    nullPolygon: textNode("nullPolygon", 0, 0, 2, 2, { translation: "target-null", linePolygons: null }),
    emptyPolygon: textNode("emptyPolygon", 0, 0, 2, 2, { translation: "target-empty", linePolygons: [] }),
  });
  const evidence = await buildBubbleMaskEvidence(scene, async () => bytes);
  const regions = extractRegionsFromScene(scene, {
    ocrEngine: "ocr",
    translationModel: "llm",
    quality: DEFAULT_CONFIG.quality,
    bubbleEvidence: evidence,
  });
  const byId = new Map(regions.map((region) => [region.id, region]));

  assert.equal(byId.get("inside1")?.insideBubble, true);
  assert.equal(byId.get("inside1")?.role, "dialogue");
  assert.equal(byId.get("inside1")?.policy, "replace");
  assert.equal(byId.get("inside1")?.roleProvenance, "bubble-mask");
  assert.equal(byId.get("inside1")?.roleConfidence, 1);
  assert.equal(byId.get("inside1")?.bubbleInstanceId, "page1:7");
  assert.equal(byId.get("inside1")?.geometrySource, "bbox");
  assert.equal(byId.get("inside2")?.bubbleInstanceId, byId.get("inside1")?.bubbleInstanceId);

  assert.equal(byId.get("outside")?.insideBubble, false);
  assert.equal(byId.get("outside")?.role, "unknown");
  assert.equal(byId.get("outside")?.policy, "preserve-with-annotation");
  assert.equal(byId.get("partial")?.insideBubble, undefined);
  assert.equal(byId.get("partial")?.role, "unknown");
  assert.equal(byId.get("partial")?.bubbleInstanceId, "page1:7");
  assert.equal(byId.get("polygon")?.role, "dialogue");
  assert.equal(byId.get("polygon")?.geometrySource, "line-polygons");
  assert.equal(byId.get("nullPolygon")?.geometrySource, "bbox");
  assert.equal(byId.get("emptyPolygon")?.geometrySource, "bbox");
  assert.deepEqual(renderProtectionPlan(["page1"], regions, DEFAULT_CONFIG.quality.structuralProtection), [
    { pageId: "page1", codes: ["UNCLASSIFIED_TEXT_REGION"] },
  ]);
});

test("missing or malformed text geometry fails closed without geometry provenance", async () => {
  const bytes = await webpMask(4, 4, new Uint8Array(16).fill(3));
  const scene = sceneWithNodes(4, 4, {
    missingGeometry: { id: "missingGeometry", kind: { text: { text: "source-missing" } } },
    malformedPolygons: textNode("malformedPolygons", 0, 0, 2, 2, { linePolygons: [[0, 0], [1, 1]] }),
  });
  const evidence = await buildBubbleMaskEvidence(scene, async () => bytes);
  const regions = extractRegionsFromScene(scene, { ocrEngine: "ocr", translationModel: "llm", quality: DEFAULT_CONFIG.quality, bubbleEvidence: evidence });
  assert.equal(evidence.size, 0);
  assert.ok(regions.every((region) => region.role === "unknown" && region.policy === "preserve-with-annotation" && region.geometrySource === undefined));
});

test("missing bubble masks preserve unknown regions and block page rendering", async () => {
  const scene = {
    scene: {
      pages: {
        page1: { id: "page1", width: 4, height: 4, nodes: { text1: textNode("text1", 0, 0, 2, 2) } },
      },
    },
  } as unknown as JsonObject;
  const evidence = await buildBubbleMaskEvidence(scene, async () => assert.fail("missing masks must not read a blob"));
  assert.equal(evidence.size, 0);
  const regions = extractRegionsFromScene(scene, { ocrEngine: "ocr", translationModel: "llm", quality: DEFAULT_CONFIG.quality, bubbleEvidence: evidence });
  assert.equal(regions[0].role, "unknown");
  assert.equal(regions[0].policy, "preserve-with-annotation");
  assert.equal(regions[0].roleConfidence, 0);
  assert.equal(regions[0].roleProvenance, "insufficient-evidence");
  assert.deepEqual(renderProtectionPlan(["page1"], regions, DEFAULT_CONFIG.quality.structuralProtection), [
    { pageId: "page1", codes: ["UNCLASSIFIED_TEXT_REGION"] },
  ]);
});

test("bubble mask decoding fails closed for corrupt, mismatched, oversized, and invalid-channel images", async () => {
  await assert.rejects(
    () => decodeBubbleMask(new TextEncoder().encode("private image bytes"), 2, 2),
    (error: unknown) => (error as { code?: string }).code === "BUBBLE_MASK_DECODE_FAILED" && !String(error).includes("private image bytes"),
  );

  const valid = await webpMask(4, 4, new Uint8Array(16));
  await assert.rejects(
    () => decodeBubbleMask(valid, 3, 4),
    (error: unknown) => (error as { code?: string }).code === "BUBBLE_MASK_DIMENSIONS_MISMATCH",
  );
  await assert.rejects(
    () => decodeBubbleMask(valid, 4, 4, { maxPixels: 15 }),
    (error: unknown) => (error as { code?: string }).code === "BUBBLE_MASK_PIXEL_LIMIT",
  );

  const rgb = new Uint8Array(2 * 2 * 3);
  for (let index = 0; index < rgb.length; index += 3) {
    rgb[index] = 1;
    rgb[index + 1] = 2;
    rgb[index + 2] = 3;
  }
  const invalidChannels = await sharp(rgb, { raw: { width: 2, height: 2, channels: 3 } }).webp({ lossless: true }).toBuffer();
  await assert.rejects(
    () => decodeBubbleMask(invalidChannels, 2, 2),
    (error: unknown) => (error as { code?: string }).code === "BUBBLE_MASK_CHANNELS_INVALID",
  );
});

test("out-of-bounds and excessive text geometry cannot create replace evidence", async () => {
  const bytes = await webpMask(4, 4, new Uint8Array(16).fill(9));
  const scene = sceneWithNodes(4, 4, {
    outsidePage: textNode("outsidePage", -1, 0, 2, 2),
    tooLarge: textNode("tooLarge", 0, 0, 4, 4),
  });
  const evidence = await buildBubbleMaskEvidence(scene, async () => bytes, { maxRegionScanPixels: 4 });
  const regions = extractRegionsFromScene(scene, { ocrEngine: "ocr", translationModel: "llm", quality: DEFAULT_CONFIG.quality, bubbleEvidence: evidence });
  assert.ok(regions.every((region) => region.role === "unknown" && region.policy === "preserve-with-annotation"));
});
