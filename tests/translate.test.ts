import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { carryOcrProvenance, reassembleRenderedPages, runTranslate } from "../src/translate.ts";
import type { InputImage, RegionRecord } from "../src/types.ts";
import type { SafeLogger } from "../src/logger.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const silentLogger: SafeLogger = { info() {}, warn() {}, error() {} };
const healthyMemory = async () => ({ totalPhysicalMiB: 16_000, availablePhysicalMiB: 6_000, committedMiB: 20_000, commitLimitMiB: 40_000, commitHeadroomMiB: 20_000 });

test("rendered page assembly preserves blocked pages in original order", () => {
  const source = (fileName: string, marker: number): InputImage => ({
    fileName,
    mediaType: "image/webp",
    bytes: Uint8Array.from([marker]),
    sha256: String(marker).repeat(64).slice(0, 64),
  });
  const sourceImages = [source("001.webp", 1), source("002.webp", 2), source("003.webp", 3)];
  const rendered = { ...source("0002.png", 9), mediaType: "image/png" as const };
  const assembled = reassembleRenderedPages({
    sourceImages,
    scenePageIds: ["p1", "p2", "p3"],
    renderedPageIds: ["p2"],
    renderedImages: [rendered],
  });
  assert.equal(assembled.length, 3);
  assert.equal(assembled[0], sourceImages[0]);
  assert.equal(assembled[1], rendered);
  assert.equal(assembled[2], sourceImages[2]);
  assert.throws(
    () => reassembleRenderedPages({ sourceImages, scenePageIds: ["p1", "p2", "p3"], renderedPageIds: ["p2"], renderedImages: [] }),
    (error: unknown) => (error as { code?: string }).code === "RENDERED_PAGE_MAPPING_INVALID",
  );
});

test("carrying OCR provenance preserves verified sourceText and fails closed on population drift", () => {
  const selected: RegionRecord = {
    schemaVersion: 2,
    id: "r1",
    pageId: "p1",
    order: 0,
    role: "dialogue",
    policy: "replace",
    sourceText: "verified-selected-source",
    bbox: { x: 0, y: 0, width: 1, height: 1 },
    ocrRuntimePolicy: { name: "strict-quality", version: 1 },
    selectedOcrEngine: "paddle-ocr",
    ocrSelectionReason: "raw-agreement",
    ocrQaReasons: [],
    ocrCandidates: [
      { engine: "paddle-ocr", role: "paddle", status: "present", text: "verified-selected-source", selected: true, selectionReason: "raw-agreement" },
      { engine: "manga-ocr", role: "manga", status: "present", text: "verified-selected-source", selected: false, selectionReason: "raw-agreement" },
    ],
    translationCandidates: [],
    qaFlags: [],
  };
  const reread = { ...selected, translatedText: "translated" };
  const carried = carryOcrProvenance([selected], [reread]);
  assert.equal(carried[0].sourceText, "verified-selected-source");
  assert.equal(carried[0].translatedText, "translated");
  assert.throws(() => carryOcrProvenance([selected], [{ ...reread, sourceText: "stale-scene-source" }]), (error: unknown) => (error as { code?: string }).code === "OCR_PROVENANCE_SOURCE_MISMATCH");
  assert.throws(() => carryOcrProvenance([selected], []), /missing verified selected OCR regions/);
  assert.throws(() => carryOcrProvenance([selected], [{ ...reread, bbox: { x: 1, y: 0, width: 1, height: 1 } }]), /population and geometry/);
});

test("external/shared Koharu mode stops before every project, scene mutation, and translator call", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "manga-localizer-translate-"));
  const input = path.join(root, "input");
  const output = path.join(root, "output");
  await mkdir(input);
  await writeFile(path.join(input, "001.png"), PNG);
  let latestOperation = "none";
  let operationIndex = 0;
  let translated = false;
  let translatorCalls = 0;
  let fallbackCalls = 0;
  let llmLoadCalls = 0;
  let historyApplyCalls = 0;
  let fetchCalls = 0;
  const fetchImpl: typeof fetch = async (inputValue, init) => {
    fetchCalls += 1;
    const url = new URL(String(inputValue));
    const method = init?.method ?? "GET";
    const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url.pathname.endsWith("/meta")) return json({ version: "0.61.2", device: "CUDA" });
    if (url.pathname.endsWith("/engines")) return json({
      detector: [{ id: "layout-detector" }], segmenter: [{ id: "text-segmenter" }],
      ocr: [{ id: "paddle-ocr-vl-1.6" }, { id: "manga-ocr" }], translator: [{ id: "llm-translator" }],
      inpainter: [{ id: "aot-inpainting" }, { id: "lama-inpainting" }], renderer: [{ id: "manga-renderer" }],
    });
    if (url.pathname.endsWith("/config")) return json({ pipeline: { detector: "layout-detector", segmenter: "text-segmenter", ocr: "paddle-ocr-vl-1.6", translator: "llm-translator", inpainter: "aot-inpainting", renderer: "manga-renderer" } });
    if (url.pathname.endsWith("/projects") || url.pathname.endsWith("/pages")) return json({ ok: true });
    if (url.pathname.endsWith("/llm/current") && method === "GET") return json({ status: "loaded" });
    if (url.pathname.endsWith("/llm/current")) { llmLoadCalls += 1; return new Response(null, { status: 204 }); }
    if (url.pathname.endsWith("/history/apply")) { historyApplyCalls += 1; return json({ epoch: 1 }); }
    if (url.pathname.endsWith("/pipelines")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      operationIndex += 1;
      latestOperation = `op-${operationIndex}`;
      if (Array.isArray(body.steps) && body.steps.includes("llm-translator")) { translated = true; translatorCalls += 1; }
      if (Array.isArray(body.steps) && body.steps.includes("manga-ocr")) {
        fallbackCalls += 1;
        assert.deepEqual(body.pages, ["p1"]);
      }
      return json({ operationId: latestOperation });
    }
    if (url.pathname.endsWith("/events")) {
      return new Response(`id: ${operationIndex}\nevent: JobFinished\ndata: ${JSON.stringify({ type: "JobFinished", operationId: latestOperation })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname.endsWith("/scene.json")) return json({ pages: [{ pageId: "p1", nodes: [{ id: "r1", sourceText: "こんにちは！", ...(translated ? { translatedText: "你好！" } : {}), ocrConfidence: 0.99, insideBubble: true, bbox: { x: 0, y: 0, width: 200, height: 100 } }] }] });
    if (url.pathname.endsWith("/projects/current/export")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.format === "rendered") return new Response(PNG, { headers: { "content-type": "image/png" } });
      if (body.format === "khr") return new Response(Buffer.from("KOHARU-PROJECT"), { headers: { "content-type": "application/octet-stream" } });
    }
    return json({ error: "not found" }, 404);
  };
  const config = { ...DEFAULT_CONFIG, koharu: { ...DEFAULT_CONFIG.koharu, requestTimeoutMs: 2000, operationTimeoutMs: 5000 } };
  await assert.rejects(
    () => runTranslate(config, { inputPath: input, outputParent: output, allowCloud: false, psd: false, fetchImpl, logger: silentLogger, readSystemMemory: healthyMemory }),
    (error: unknown) => (error as { code?: string }).code === "KOHARU_SAFE_SOURCE_TEXT_WRITEBACK_UNAVAILABLE",
  );
  assert.equal(fetchCalls, 0);
  assert.equal(fallbackCalls, 0);
  assert.equal(translatorCalls, 0);
  assert.equal(llmLoadCalls, 0);
  assert.equal(historyApplyCalls, 0);
  assert.equal(translated, false);
  let memoryRead = false;
  await assert.rejects(
    () => runTranslate(config, {
      inputPath: input,
      outputParent: output,
      allowCloud: false,
      psd: false,
      fetchImpl,
      logger: silentLogger,
      readSystemMemory: async () => { memoryRead = true; return { totalPhysicalMiB: 16_000, availablePhysicalMiB: 2_000, commitHeadroomMiB: 20_000 }; },
    }),
    (error: unknown) => (error as { code?: string }).code === "KOHARU_SAFE_SOURCE_TEXT_WRITEBACK_UNAVAILABLE",
  );
  assert.equal(memoryRead, false);
  assert.equal(operationIndex, 0);
});

test("translate refuses a remote Koharu even when remote diagnostics are configured", async () => {
  const config = { ...DEFAULT_CONFIG, koharu: { ...DEFAULT_CONFIG.koharu, baseUrl: "https://koharu.example/api/v1", allowRemote: true } };
  await assert.rejects(
    () => runTranslate(config, { inputPath: "unused", outputParent: "unused", allowCloud: false, psd: false }),
    (error: unknown) => (error as { code?: string }).code === "KOHARU_SAFE_SOURCE_TEXT_WRITEBACK_UNAVAILABLE",
  );
});
