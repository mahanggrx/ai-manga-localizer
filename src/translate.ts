import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createCbzBuffer, detectMediaType, loadInputImages, readZipImagesBuffer } from "./archive.ts";
import { buildBubbleMaskEvidence, type BubbleMaskEvidence } from "./bubble-mask.ts";
import { asLocalizerError, LocalizerError } from "./errors.ts";
import { createUniqueDirectory, safeSlug, writeExclusive, writeJsonExclusive } from "./file-utils.ts";
import { KoharuClient, selectEngine, selectedPipelineEngine } from "./koharu-client.ts";
import { assertLocalTranslationTarget } from "./local-translation.ts";
import { logger, type SafeLogger } from "./logger.ts";
import { applyChapterQa, buildGlossaryPrompt, buildRetryPrompt, chunkPageIds, deriveGlossary, extractPageIds, extractRegionsFromScene, lowOcrPages, markRenderBlockedPages, qaSummary, renderProtectionPlan, translationRetryPages } from "./quality.ts";
import { assertSchema } from "./schema.ts";
import { assessResourceHeadroom, readSystemMemorySnapshot, type SystemMemorySnapshot } from "./system-resources.ts";
import type { ChapterManifest, InputImage, JsonObject, JsonValue, LocalizerConfig, RegionRecord, RunReport, StageReport } from "./types.ts";

export interface TranslateOptions {
  inputPath: string;
  outputParent: string;
  allowCloud: boolean;
  psd: boolean;
  logger?: SafeLogger;
  fetchImpl?: typeof fetch;
  readSystemMemory?: () => Promise<SystemMemorySnapshot>;
}

interface PipelineEngines {
  detect: string[];
  primaryOcr: string;
  fallbackOcr?: string;
  translator: string;
  inpainter: string;
  fallbackInpainter?: string;
  renderer: string;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function assertImageUploadIsLocal(baseUrl: string): void {
  const hostname = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    throw new LocalizerError("REMOTE_KOHARU_IMAGE_UPLOAD_FORBIDDEN", "translate requires a loopback Koharu URL so original manga images never leave this machine");
  }
}

function resolveEngines(catalog: JsonValue, runtimeConfig: JsonObject, config: LocalizerConfig): PipelineEngines {
  const primaryOcr = selectEngine(catalog, "ocr", config.quality.primaryOcrHints) ?? selectedPipelineEngine(runtimeConfig, "ocr");
  const fallbackOcr = selectEngine(catalog, "ocr", config.quality.fallbackOcrHints);
  const translator = selectedPipelineEngine(runtimeConfig, "translator") ?? selectEngine(catalog, "translat", ["translat"]);
  const inpainter = selectEngine(catalog, "inpaint", config.quality.primaryInpainterHints) ?? selectedPipelineEngine(runtimeConfig, "inpainter");
  const fallbackInpainter = selectEngine(catalog, "inpaint", config.quality.fallbackInpainterHints);
  const renderer = selectedPipelineEngine(runtimeConfig, "renderer") ?? selectEngine(catalog, "render", ["render"]);
  if (!primaryOcr || !translator || !inpainter || !renderer) {
    throw new LocalizerError("PIPELINE_ENGINE_MISSING", "Koharu engine catalog is missing a required OCR, translator, inpainter, or renderer engine");
  }
  const detect = unique([
    selectedPipelineEngine(runtimeConfig, "detector") ?? selectEngine(catalog, "detect", ["layout", "detect"]),
    selectedPipelineEngine(runtimeConfig, "fontDetector"),
    selectedPipelineEngine(runtimeConfig, "segmenter") ?? selectEngine(catalog, "segment", ["segment"]),
    selectedPipelineEngine(runtimeConfig, "bubbleSegmenter"),
    primaryOcr,
  ]);
  if (detect.length < 2) throw new LocalizerError("DETECTION_PIPELINE_INCOMPLETE", "Could not resolve Koharu detection and OCR engines");
  return { detect, primaryOcr, fallbackOcr: fallbackOcr !== primaryOcr ? fallbackOcr : undefined, translator, inpainter, fallbackInpainter: fallbackInpainter !== inpainter ? fallbackInpainter : undefined, renderer };
}

function imageExtension(mediaType: InputImage["mediaType"]): string {
  return mediaType === "image/png" ? ".png" : mediaType === "image/jpeg" ? ".jpg" : ".webp";
}

function exportedImages(bytes: Uint8Array, contentType: string, config: LocalizerConfig): InputImage[] {
  const buffer = Buffer.from(bytes);
  const zip = contentType.includes("zip") || (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50);
  if (zip) return readZipImagesBuffer(buffer, config);
  for (const extension of [".png", ".jpg", ".webp"]) {
    try {
      const mediaType = detectMediaType(`page-0001${extension}`, buffer);
      return [{ fileName: `page-0001${extension}`, mediaType, bytes: buffer, sha256: "" }];
    } catch { /* try next supported image type */ }
  }
  throw new LocalizerError("RENDERED_EXPORT_INVALID", "Koharu rendered export is neither a supported image nor ZIP archive");
}

export function reassembleRenderedPages(options: {
  sourceImages: InputImage[];
  scenePageIds: string[];
  renderedPageIds: string[];
  renderedImages: InputImage[];
}): InputImage[] {
  if (options.scenePageIds.length !== options.sourceImages.length || new Set(options.scenePageIds).size !== options.scenePageIds.length) {
    throw new LocalizerError("SCENE_PAGE_MAPPING_INVALID", "Scene page ids cannot be mapped one-to-one to the input images");
  }
  if (options.renderedPageIds.length !== options.renderedImages.length || new Set(options.renderedPageIds).size !== options.renderedPageIds.length) {
    throw new LocalizerError("RENDERED_PAGE_MAPPING_INVALID", "Rendered page ids cannot be mapped one-to-one to the exported images");
  }
  const sceneIds = new Set(options.scenePageIds);
  if (options.renderedPageIds.some((pageId) => !sceneIds.has(pageId))) {
    throw new LocalizerError("RENDERED_PAGE_MAPPING_INVALID", "Koharu exported a page that is absent from the current input scene");
  }
  const renderedByPageId = new Map(options.renderedPageIds.map((pageId, index) => [pageId, options.renderedImages[index]]));
  return options.scenePageIds.map((pageId, index) => renderedByPageId.get(pageId) ?? options.sourceImages[index]);
}

function mergeOcrPass(primary: RegionRecord[], fallback: RegionRecord[], fallbackEngine: string): RegionRecord[] {
  const fallbackById = new Map(fallback.map((region) => [region.id, region]));
  const merged = primary.map((before) => {
    const region = fallbackById.get(before.id);
    if (!region) return before;
    fallbackById.delete(before.id);
    const selectedFallback = (region.ocrConfidence ?? 0) >= (before.ocrConfidence ?? 0);
    return {
      ...(selectedFallback ? region : before),
      ocrCandidates: [
        ...before.ocrCandidates.map((candidate) => ({
          ...candidate,
          selected: !selectedFallback,
          selectionReason: selectedFallback ? "lower-confidence-than-fallback" : "higher-confidence-than-fallback",
        })),
        {
          engine: fallbackEngine,
          text: region.sourceText,
          confidence: region.ocrConfidence,
          selected: selectedFallback,
          selectionReason: selectedFallback ? "higher-or-equal-confidence-fallback" : "lower-confidence-fallback",
        },
      ],
    };
  });
  return [...merged, ...fallbackById.values()];
}

function carryOcrProvenance(previous: RegionRecord[], current: RegionRecord[]): RegionRecord[] {
  const byId = new Map(previous.map((region) => [region.id, region]));
  return current.map((region) => {
    const before = byId.get(region.id);
    return before ? { ...region, ocrCandidates: before.ocrCandidates, ocrConfidence: before.ocrConfidence ?? region.ocrConfidence } : region;
  });
}

function markCloudRoute(regions: RegionRecord[], pages: Set<string>, model: string): RegionRecord[] {
  return regions.map((region) => {
    if (!pages.has(region.pageId) || !region.translatedText) return region;
    return {
      ...region,
      translationCandidates: [
        ...region.translationCandidates.map((candidate) => ({ ...candidate, selected: false })),
        { model, text: region.translatedText, selected: true, selectionReason: "local-qa-failed-and-cloud-was-explicitly-enabled", route: "cloud" as const },
      ],
    };
  });
}

function stage(name: string): StageReport {
  return { name, status: "pending", warnings: [] };
}

async function writeCheckpoint(directory: string, index: number, item: StageReport): Promise<void> {
  const safeName = safeSlug(item.name);
  await writeJsonExclusive(path.join(directory, `${String(index).padStart(2, "0")}-${safeName}.json`), {
    schemaVersion: 1,
    stage: item.name,
    status: item.status,
    startedAt: item.startedAt,
    finishedAt: item.finishedAt,
    durationMs: item.durationMs,
    errorCode: item.errorCode,
    warnings: item.warnings,
  });
}

async function executeStage<T>(report: RunReport, checkpoints: string, name: string, action: (item: StageReport) => Promise<T>): Promise<T> {
  const item = stage(name);
  item.status = "running";
  item.startedAt = new Date().toISOString();
  report.stages.push(item);
  const started = Date.now();
  try {
    const result = await action(item);
    item.status = item.warnings.length > 0 ? "warning" : "passed";
    return result;
  } catch (error) {
    const failure = asLocalizerError(error);
    item.status = "failed";
    item.errorCode = failure.code;
    throw failure;
  } finally {
    item.finishedAt = new Date().toISOString();
    item.durationMs = Date.now() - started;
    await writeCheckpoint(checkpoints, report.stages.length, item);
  }
}

async function assertHeavyProcessHeadroom(options: TranslateOptions, item: StageReport): Promise<void> {
  let snapshot: SystemMemorySnapshot;
  try {
    snapshot = await (options.readSystemMemory ?? readSystemMemorySnapshot)();
  } catch (error) {
    throw new LocalizerError("RESOURCE_CHECK_UNAVAILABLE", "System memory could not be measured before starting a heavy local process", { cause: error });
  }
  const assessment = assessResourceHeadroom(snapshot);
  if (!assessment.ok) throw new LocalizerError(assessment.code, assessment.detail);
  if (assessment.code === "COMMIT_COUNTER_UNAVAILABLE") item.warnings.push(assessment.code);
}

export async function runTranslate(config: LocalizerConfig, options: TranslateOptions): Promise<{ directory: string; report: RunReport }> {
  assertImageUploadIsLocal(config.koharu.baseUrl);
  const safeLogger = options.logger ?? logger;
  const loaded = await loadInputImages(options.inputPath, config);
  const prefix = `translation-results-${path.basename(path.resolve(options.inputPath), path.extname(options.inputPath))}`;
  const output = await createUniqueDirectory(options.outputParent, prefix);
  const checkpoints = path.join(output.directory, "checkpoints");
  await mkdir(checkpoints, { recursive: false });
  const report: RunReport = {
    schemaVersion: 1,
    runId: output.runId,
    status: "running",
    startedAt: new Date().toISOString(),
    inputKind: loaded.kind,
    inputPageCount: loaded.images.length,
    outputDirectory: output.directory,
    cloudAllowed: options.allowCloud,
    cloudRegions: [],
    stages: [],
    qaSummary: {},
    artifacts: {},
  };
  const client = new KoharuClient(config.koharu, { fetchImpl: options.fetchImpl, logger: safeLogger });
  let llmLoaded = false;
  let projectCreated = false;
  let regions: RegionRecord[] = [];
  let scenePageIds: string[] = [];
  let bubbleEvidence: BubbleMaskEvidence | undefined;
  try {
    const { meta, engines } = await executeStage(report, checkpoints, "connect-koharu", async () => {
      const meta = await client.getMeta();
      if (meta.version.replace(/^v/, "") !== config.koharu.requiredVersion.replace(/^v/, "")) throw new LocalizerError("KOHARU_VERSION_MISMATCH", `Required ${config.koharu.requiredVersion}, found ${meta.version}`);
      const engines = await client.getEngines();
      report.koharuVersion = meta.version;
      return { meta, engines };
    });
    safeLogger.info("KOHARU_CONNECTED", { runId: report.runId, version: meta.version, device: typeof meta.device === "string" ? meta.device : undefined });
    const runtimeConfig = await client.getConfig();
    assertLocalTranslationTarget(config.translation.localTarget, runtimeConfig);
    const pipeline = resolveEngines(engines, runtimeConfig, config);

    await executeStage(report, checkpoints, "create-project-and-upload", async () => {
      await client.createProject(`${safeSlug(path.basename(options.inputPath))}-${report.runId.slice(0, 8)}`);
      projectCreated = true;
      await client.uploadPages(loaded.images);
    });

    await executeStage(report, checkpoints, "detect-and-primary-ocr", async (item) => {
      await assertHeavyProcessHeadroom(options, item);
      const run = await client.runPipeline({ steps: pipeline.detect });
      item.warnings.push(...run.warnings.map(() => "KOHARU_PIPELINE_WARNING"));
    });

    regions = await executeStage(report, checkpoints, "inspect-primary-ocr", async () => {
      const scene = await client.getScene();
      scenePageIds = extractPageIds(scene);
      bubbleEvidence = await buildBubbleMaskEvidence(scene, (hash) => client.readBlob(hash));
      const extracted = extractRegionsFromScene(scene, { ocrEngine: pipeline.primaryOcr, translationModel: config.translation.localTarget.modelId, quality: config.quality, bubbleEvidence });
      if (extracted.length === 0) throw new LocalizerError("SCENE_TEXT_NOT_FOUND", "Koharu scene contains no recognizable source-text regions; the scene schema may be incompatible", { recoverable: true });
      return extracted;
    });

    const fallbackPages = lowOcrPages(regions);
    if (fallbackPages.length > 0 && pipeline.fallbackOcr) {
      const before = regions;
      await executeStage(report, checkpoints, "fallback-ocr", async (item) => {
        const run = await client.runPipeline({ steps: [pipeline.fallbackOcr!], pages: fallbackPages });
        item.warnings.push(...run.warnings.map(() => "KOHARU_PIPELINE_WARNING"));
      });
      const fallback = extractRegionsFromScene(await client.getScene(), { ocrEngine: pipeline.fallbackOcr, translationModel: config.translation.localTarget.modelId, quality: config.quality, bubbleEvidence });
      regions = mergeOcrPass(before, fallback, pipeline.fallbackOcr);
    }

    await executeStage(report, checkpoints, "load-local-translator", async (item) => {
      await assertHeavyProcessHeadroom(options, item);
      await client.loadLlm(config.translation.localTarget);
      llmLoaded = true;
      await client.waitForLlmReady();
    });

    const orderedPages = scenePageIds.length > 0 ? scenePageIds : unique(regions.map((region) => region.pageId));
    const chunks = chunkPageIds(orderedPages, config.translation.chunkPages, config.translation.contextOverlapPages);
    if (chunks.length === 0) throw new LocalizerError("TRANSLATION_CHUNKS_EMPTY", "No page ids are available for chapter translation");
    for (let index = 0; index < chunks.length; index += 1) {
      const pages = chunks[index];
      await executeStage(report, checkpoints, `translate-chunk-${index + 1}-of-${chunks.length}`, async (item) => {
        const run = await client.runPipeline({
          steps: [pipeline.translator],
          pages,
          targetLanguage: config.translation.targetLanguage,
          systemPrompt: buildGlossaryPrompt(config.translation.systemPrompt, deriveGlossary(regions)),
        });
        item.warnings.push(...run.warnings.map(() => "KOHARU_PIPELINE_WARNING"));
      });
      regions = applyChapterQa(carryOcrProvenance(regions, extractRegionsFromScene(await client.getScene(), { ocrEngine: pipeline.primaryOcr, translationModel: config.translation.localTarget.modelId, quality: config.quality, bubbleEvidence })), config.quality);
    }

    let retryPages = translationRetryPages(regions);
    for (let retry = 1; retry <= config.quality.maxRetries && retryPages.length > 0; retry += 1) {
      const beforeRetry = regions;
      await executeStage(report, checkpoints, `local-quality-retry-${retry}`, async (item) => {
        const run = await client.runPipeline({
          steps: [pipeline.translator],
          pages: retryPages,
          targetLanguage: config.translation.targetLanguage,
          systemPrompt: buildRetryPrompt(config.translation.retryPrompt, deriveGlossary(regions)),
        });
        item.warnings.push(...run.warnings.map(() => "KOHARU_PIPELINE_WARNING"));
      });
      regions = applyChapterQa(carryOcrProvenance(beforeRetry, extractRegionsFromScene(await client.getScene(), { ocrEngine: pipeline.primaryOcr, translationModel: config.translation.localTarget.modelId, quality: config.quality, bubbleEvidence })), config.quality);
      retryPages = translationRetryPages(regions);
    }

    const cloudPages = translationRetryPages(regions);
    if (options.allowCloud && cloudPages.length > 0) {
      if (!config.translation.cloudTarget) {
        report.stages.push({ name: "cloud-fallback", status: "warning", warnings: ["CLOUD_TARGET_NOT_CONFIGURED"] });
      } else {
        await executeStage(report, checkpoints, "cloud-text-fallback", async (item) => {
          await client.unloadLlm();
          llmLoaded = false;
          await client.loadLlm(config.translation.cloudTarget!);
          llmLoaded = true;
          await client.waitForLlmReady();
          const run = await client.runPipeline({
            steps: [pipeline.translator],
            pages: cloudPages,
            targetLanguage: config.translation.targetLanguage,
            systemPrompt: buildRetryPrompt(config.translation.retryPrompt, deriveGlossary(regions)),
          });
          item.warnings.push(...run.warnings.map(() => "KOHARU_PIPELINE_WARNING"));
        });
        const cloudSet = new Set(cloudPages);
        regions = markCloudRoute(applyChapterQa(carryOcrProvenance(regions, extractRegionsFromScene(await client.getScene(), { ocrEngine: pipeline.primaryOcr, translationModel: config.translation.cloudTarget.modelId, quality: config.quality, bubbleEvidence })), config.quality), cloudSet, config.translation.cloudTarget.modelId);
        report.cloudRegions = regions.filter((region) => cloudSet.has(region.pageId)).map((region) => region.id);
      }
    }

    const preservationReasons = renderProtectionPlan(orderedPages, regions, config.quality.structuralProtection);
    const preservedPages = preservationReasons.map((item) => item.pageId);
    const preservedPageSet = new Set(preservedPages);
    const renderPages = orderedPages.filter((pageId) => !preservedPageSet.has(pageId));
    regions = markRenderBlockedPages(regions, preservedPageSet);
    report.renderSafety = {
      preservedPageCount: preservedPages.length,
      renderedPageCount: renderPages.length,
      preservedPages,
      preservationReasons,
    };
    await executeStage(report, checkpoints, "render-safety-gate", async (item) => {
      if (preservationReasons.some((reason) => reason.codes.includes("BLOCKING_REGION_QA"))) item.warnings.push("PAGES_PRESERVED_AFTER_BLOCKING_QA");
      if (preservationReasons.some((reason) => reason.codes.some((code) => code !== "BLOCKING_REGION_QA"))) item.warnings.push("STRUCTURAL_PAGES_PRESERVED");
    });

    await executeStage(report, checkpoints, "release-llm", async (item) => {
      try { await client.unloadLlm(); llmLoaded = false; } catch { item.warnings.push("LLM_UNLOAD_FAILED"); }
    });

    await executeStage(report, checkpoints, "inpaint", async (item) => {
      if (renderPages.length === 0) {
        item.warnings.push("ALL_PAGES_PRESERVED_AFTER_BLOCKING_QA");
        return;
      }
      const run = await client.runPipeline({ steps: [pipeline.inpainter], pages: renderPages });
      item.warnings.push(...run.warnings.map(() => "KOHARU_PIPELINE_WARNING"));
    });
    await executeStage(report, checkpoints, "render", async (item) => {
      if (renderPages.length === 0) {
        item.warnings.push("ALL_PAGES_PRESERVED_AFTER_BLOCKING_QA");
        return;
      }
      const run = await client.runPipeline({ steps: [pipeline.renderer], pages: renderPages });
      item.warnings.push(...run.warnings.map(() => "KOHARU_PIPELINE_WARNING"));
    });

    const rendered = await executeStage(report, checkpoints, "export-and-structural-visual-qa", async (item) => {
      let exported: InputImage[] = [];
      if (renderPages.length > 0) {
        const renderedExport = await client.exportProject("rendered", renderPages);
        exported = exportedImages(renderedExport.bytes, renderedExport.contentType, config);
      }
      const images = reassembleRenderedPages({
        sourceImages: loaded.images,
        scenePageIds,
        renderedPageIds: renderPages,
        renderedImages: exported,
      });
      if (images.some((image) => image.bytes.length === 0)) throw new LocalizerError("RENDERED_PAGE_EMPTY", "Koharu exported an empty rendered page");
      if (preservedPages.length > 0) item.warnings.push("SOURCE_PAGES_PRESERVED_AFTER_BLOCKING_QA");
      item.warnings.push("PIXEL_EDGE_AND_RESIDUAL_QA_REQUIRES_REAL_IMAGE_RUNTIME");
      return images;
    });

    await executeStage(report, checkpoints, "write-artifacts", async () => {
      const renderedDirectory = path.join(output.directory, "rendered");
      await mkdir(renderedDirectory, { recursive: false });
      for (let index = 0; index < rendered.length; index += 1) {
        const image = rendered[index];
        const fileName = `${String(index + 1).padStart(4, "0")}${imageExtension(image.mediaType)}`;
        await writeExclusive(path.join(renderedDirectory, fileName), image.bytes);
      }
      const cbzPath = path.join(output.directory, "translated.cbz");
      await writeExclusive(cbzPath, createCbzBuffer(rendered.map((image, index) => ({ fileName: `${String(index + 1).padStart(4, "0")}${imageExtension(image.mediaType)}`, bytes: image.bytes }))));
      const khr = await client.exportProject("khr");
      if (khr.bytes.length === 0) throw new LocalizerError("KHR_EXPORT_EMPTY", "Koharu returned an empty KHR export");
      await writeExclusive(path.join(output.directory, "chapter.khr"), khr.bytes);
      if (options.psd) {
        const psd = await client.exportProject("psd");
        if (psd.bytes.length === 0) throw new LocalizerError("PSD_EXPORT_EMPTY", "Koharu returned an empty PSD export");
        const extension = psd.contentType.includes("zip") ? "zip" : "psd";
        await writeExclusive(path.join(output.directory, `editable-psd.${extension}`), psd.bytes);
        report.artifacts.psd = `editable-psd.${extension}`;
      }
      report.artifacts.renderedDirectory = "rendered";
      report.artifacts.cbz = "translated.cbz";
      report.artifacts.khr = "chapter.khr";
    });

    const manifest: ChapterManifest = {
      schemaVersion: 1,
      chapterId: report.runId,
      title: path.basename(options.inputPath, path.extname(options.inputPath)),
      sourceLanguage: "ja",
      targetLanguage: "zh-CN",
      createdAt: report.startedAt,
      sourceFiles: loaded.images.map((image, index) => ({ pageId: scenePageIds[index] ?? `source-page-${index + 1}`, fileName: image.fileName, sha256: image.sha256 })),
      regions,
      glossary: deriveGlossary(regions),
    };
    for (const region of manifest.regions) {
      await assertSchema("region-record.schema.json", region);
      for (const flag of region.qaFlags) await assertSchema("qa-flag.schema.json", flag);
    }
    await assertSchema("chapter-manifest.schema.json", manifest);
    await writeJsonExclusive(path.join(output.directory, "chapter-manifest.json"), manifest);
    report.artifacts.manifest = "chapter-manifest.json";
    report.qaSummary = qaSummary(regions);
    const hasQa = Object.values(report.qaSummary).some((count) => count > 0);
    const hasStageWarnings = report.stages.some((item) => item.status === "warning");
    report.status = hasQa || hasStageWarnings ? "completed-with-warnings" : "completed";
    report.finishedAt = new Date().toISOString();
  } catch (error) {
    const failure = asLocalizerError(error);
    report.status = "failed";
    report.qaSummary = qaSummary(regions);
    report.failure = { code: failure.code, message: failure.message, recoverable: failure.recoverable };
    safeLogger.error("TRANSLATION_FAILED", { runId: report.runId, errorCode: failure.code, status: "failed" });
    if (projectCreated) {
      await executeStage(report, checkpoints, "recover-partial-artifacts", async (item) => {
        let recovered = 0;
        try {
          const khr = await client.exportProject("khr");
          if (khr.bytes.length > 0) {
            await writeExclusive(path.join(output.directory, "recovery-partial.khr"), khr.bytes);
            report.artifacts.recoveryKhr = "recovery-partial.khr";
            recovered += 1;
          }
        } catch { item.warnings.push("PARTIAL_KHR_RECOVERY_UNAVAILABLE"); }
        try {
          const renderedExport = await client.exportProject("rendered");
          const images = exportedImages(renderedExport.bytes, renderedExport.contentType, config);
          if (images.length > 0) {
            const recoveryDirectory = path.join(output.directory, "recovery-rendered");
            await mkdir(recoveryDirectory, { recursive: false });
            const cbzFiles: Array<{ fileName: string; bytes: Uint8Array }> = [];
            for (let index = 0; index < images.length; index += 1) {
              const fileName = `${String(index + 1).padStart(4, "0")}${imageExtension(images[index].mediaType)}`;
              await writeExclusive(path.join(recoveryDirectory, fileName), images[index].bytes);
              cbzFiles.push({ fileName, bytes: images[index].bytes });
            }
            await writeExclusive(path.join(output.directory, "recovery-partial.cbz"), createCbzBuffer(cbzFiles));
            report.artifacts.recoveryRenderedDirectory = "recovery-rendered";
            report.artifacts.recoveryCbz = "recovery-partial.cbz";
            recovered += 1;
          }
        } catch { item.warnings.push("PARTIAL_RENDER_RECOVERY_UNAVAILABLE"); }
        if (recovered === 0) item.warnings.push("NO_PARTIAL_ARTIFACT_RECOVERED");
      }).catch(() => undefined);
    }
    report.finishedAt = new Date().toISOString();
  } finally {
    if (llmLoaded) {
      try { await client.unloadLlm(); } catch { /* best effort release of an external runtime */ }
    }
  }
  report.artifacts.report = "report.json";
  await assertSchema("run-report.schema.json", report);
  await writeJsonExclusive(path.join(output.directory, "report.json"), report);
  if (report.status === "failed") throw new LocalizerError(report.failure?.code ?? "TRANSLATION_FAILED", `${report.failure?.message ?? "Translation failed"}\nRecovery report: ${path.join(output.directory, "report.json")}`, { recoverable: report.failure?.recoverable });
  return { directory: output.directory, report };
}
