import { mkdir } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createCbzBuffer, detectMediaType, loadInputImages, readZipImagesBuffer } from "./archive.ts";
import { buildBubbleMaskEvidence, type BubbleMaskEvidence } from "./bubble-mask.ts";
import { assertOwnedKoharuRuntimeConfig } from "./config.ts";
import { asLocalizerError, LocalizerError } from "./errors.ts";
import { createUniqueDirectory, safeSlug, writeExclusive, writeJsonExclusive } from "./file-utils.ts";
import { KoharuClient, selectEngine, selectedPipelineEngine } from "./koharu-client.ts";
import { assertLocalTranslationTarget } from "./local-translation.ts";
import { logger, type SafeLogger } from "./logger.ts";
import { applyOcrRuntimeDecisions, applyOcrRuntimePolicy, extractOcrRuntimeRegions, type OcrRuntimePass } from "./ocr-runtime-policy.ts";
import { OwnedKoharuProcess, createOwnedRunLayout, type OwnedProcessPlatform, type OwnedRunLayout } from "./owned-koharu-process.ts";
import { applyChapterQa, buildGlossaryPrompt, deriveGlossary, extractPageIds, extractRegionsFromScene, markRenderBlockedPages, qaSummary, renderProtectionPlan, translationRetryPages } from "./quality.ts";
import { OwnedProjectGuard } from "./run-ownership.ts";
import { assertSchema } from "./schema.ts";
import { applyOwnedScenePatch, DurablePrivateJournal, readStableScene, runOwnedTranslator } from "./scene-patch.ts";
import { sceneFullHash } from "./scene-integrity.ts";
import { cleanupOwnedCacheLinks, createOwnedRunCacheLink, loadAndValidateShadowCache, type OwnedCacheLink } from "./shadow-model-cache.ts";
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
  ownedProcessPlatform?: OwnedProcessPlatform;
}

interface PipelineEngines {
  detect: string[];
  primaryOcr: string;
  fallbackOcr: string;
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
  if (!fallbackOcr || fallbackOcr === primaryOcr) {
    throw new LocalizerError("OCR_RUNTIME_SECOND_ENGINE_MISSING", "quality-local requires distinct Paddle and Manga OCR engines for every eligible region");
  }
  if (!/paddle/i.test(primaryOcr)) {
    throw new LocalizerError("OCR_RUNTIME_PRIMARY_ENGINE_ROLE_MISMATCH", "The primary OCR engine cannot be verified as Paddle OCR");
  }
  if (!/manga/i.test(fallbackOcr)) {
    throw new LocalizerError("OCR_RUNTIME_FALLBACK_ENGINE_ROLE_MISMATCH", "The fallback OCR engine cannot be verified as Manga OCR");
  }
  const detect = unique([
    selectedPipelineEngine(runtimeConfig, "detector") ?? selectEngine(catalog, "detect", ["layout", "detect"]),
    selectedPipelineEngine(runtimeConfig, "fontDetector"),
    selectedPipelineEngine(runtimeConfig, "segmenter") ?? selectEngine(catalog, "segment", ["segment"]),
    selectedPipelineEngine(runtimeConfig, "bubbleSegmenter"),
    primaryOcr,
  ]);
  if (detect.length < 2) throw new LocalizerError("DETECTION_PIPELINE_INCOMPLETE", "Could not resolve Koharu detection and OCR engines");
  return { detect, primaryOcr, fallbackOcr, translator, inpainter, fallbackInpainter: fallbackInpainter !== inpainter ? fallbackInpainter : undefined, renderer };
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

export function carryOcrProvenance(previous: RegionRecord[], current: RegionRecord[]): RegionRecord[] {
  const byId = new Map<string, RegionRecord>();
  for (const region of previous) {
    if (byId.has(region.id)) throw new LocalizerError("OCR_PROVENANCE_DUPLICATE_REGION", "Selected OCR provenance contains duplicate region identities");
    byId.set(region.id, region);
  }
  const carried = current.map((region) => {
    const before = byId.get(region.id);
    if (!before || before.pageId !== region.pageId || !before.bbox || !region.bbox || !isDeepStrictEqual(before.bbox, region.bbox)) {
      throw new LocalizerError("OCR_PROVENANCE_ASSOCIATION_CONFLICT", "Post-translation scene regions do not match the verified selected OCR population and geometry");
    }
    if (region.sourceText !== before.sourceText) {
      throw new LocalizerError("OCR_PROVENANCE_SOURCE_MISMATCH", "Post-translation scene source text differs from the verified selected OCR input");
    }
    byId.delete(region.id);
    return {
      ...region,
      schemaVersion: 2 as const,
      sourceText: region.sourceText,
      ocrCandidates: before.ocrCandidates,
      ocrRuntimePolicy: before.ocrRuntimePolicy,
      selectedOcrEngine: before.selectedOcrEngine,
      ocrSelectionReason: before.ocrSelectionReason,
      ocrQaReasons: before.ocrQaReasons,
    };
  });
  if (byId.size !== 0) throw new LocalizerError("OCR_PROVENANCE_ASSOCIATION_CONFLICT", "Post-translation scene is missing verified selected OCR regions");
  return carried;
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
  if (config.koharu.mode !== "owned") {
    throw new LocalizerError(
      "KOHARU_SAFE_SOURCE_TEXT_WRITEBACK_UNAVAILABLE",
      "External/shared Koharu mode is read-only and cannot perform scene mutation or translator execution",
    );
  }
  assertOwnedKoharuRuntimeConfig(config.koharu);
  assertImageUploadIsLocal(config.koharu.baseUrl);
  const ownedConfig = config.koharu.ownedProcess;
  if (!ownedConfig) throw new LocalizerError("CONFIG_OWNED_KOHARU_REQUIRED", "koharu.ownedProcess is required for translation");
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
  let client: KoharuClient | undefined;
  let ownedProcess: OwnedKoharuProcess | undefined;
  let ownedLayout: OwnedRunLayout | undefined;
  let ownedLink: OwnedCacheLink | undefined;
  let ownedStartAttempted = false;
  let shadowManifestHash: string | undefined;
  let projectGuard: OwnedProjectGuard | undefined;
  let journal: DurablePrivateJournal | undefined;
  const privateRuntime = path.join(output.directory, "private-runtime");
  let llmLoaded = false;
  let regions: RegionRecord[] = [];
  let scenePageIds: string[] = [];
  let paddlePass: OcrRuntimePass | undefined;
  let bubbleEvidence: BubbleMaskEvidence | undefined;
  try {
    await mkdir(privateRuntime, { recursive: false, mode: 0o700 });
    await executeStage(report, checkpoints, "verify-shadow-model-cache", async () => {
      const verified = await loadAndValidateShadowCache(ownedConfig.shadowCacheRoot, ownedConfig.shadowCacheManifest);
      shadowManifestHash = verified.manifestHash;
      return verified;
    });
    await executeStage(report, checkpoints, "start-owned-koharu", async () => {
      ownedLayout = await createOwnedRunLayout(ownedConfig.allowedRunRoot, output.directory);
      ownedLink = await createOwnedRunCacheLink({
        runRoot: ownedLayout.root,
        linkPath: ownedLayout.modelLink,
        shadowRoot: ownedConfig.shadowCacheRoot,
        appDataModelRoots: ownedConfig.appDataModelRoots,
      });
      const linkedShadow = await loadAndValidateShadowCache(ownedConfig.shadowCacheRoot, ownedConfig.shadowCacheManifest);
      if (linkedShadow.manifestHash !== shadowManifestHash) throw new LocalizerError("SHADOW_CACHE_REBUILD_REQUIRED", "Shadow cache changed between preflight verification and owned-process start");
      ownedStartAttempted = true;
      ownedProcess = await OwnedKoharuProcess.start({
        executablePath: ownedConfig.executablePath,
        host: ownedConfig.host,
        port: ownedConfig.port,
        dataRoot: ownedLayout.dataRoot,
        platform: options.ownedProcessPlatform,
      });
      await ownedProcess.writeIdentity(path.join(privateRuntime, "owned-process.private.json"));
    });
    client = new KoharuClient(config.koharu, {
      fetchImpl: options.fetchImpl,
      logger: safeLogger,
      ownedMutationGuard: () => ownedProcess!.assertIdentity(),
    });
    const ownedClient = client;
    const processIdentity = ownedProcess;
    const layout = ownedLayout;
    if (!processIdentity || !layout) throw new LocalizerError("OWNED_KOHARU_START_FAILED", "Owned Koharu identity or run layout was not established");
    const { meta, engines } = await executeStage(report, checkpoints, "connect-koharu", async () => {
      await processIdentity.assertIdentity();
      const meta = await ownedClient.getMeta();
      if (meta.version.replace(/^v/, "") !== config.koharu.requiredVersion.replace(/^v/, "")) throw new LocalizerError("KOHARU_VERSION_MISMATCH", `Required ${config.koharu.requiredVersion}, found ${meta.version}`);
      const engines = await ownedClient.getEngines();
      report.koharuVersion = meta.version;
      return { meta, engines };
    });
    safeLogger.info("KOHARU_CONNECTED", { runId: report.runId, version: meta.version, device: typeof meta.device === "string" ? meta.device : undefined });
    const runtimeConfig = await ownedClient.getConfig();
    assertLocalTranslationTarget(config.translation.localTarget, runtimeConfig);
    const pipeline = resolveEngines(engines, runtimeConfig, config);

    await executeStage(report, checkpoints, "create-project-and-upload", async () => {
      await processIdentity.assertIdentity();
      const project = await ownedClient.createProject(`${safeSlug(path.basename(options.inputPath))}-${report.runId.slice(0, 8)}`);
      projectGuard = new OwnedProjectGuard({
        client: ownedClient,
        project,
        projectsRoot: layout.projects,
        assertProcess: () => processIdentity.assertIdentity(),
      });
      await projectGuard.assertProjectIdentity();
      await ownedClient.uploadPages(loaded.images);
    });
    const guard = projectGuard;
    if (!guard) throw new LocalizerError("OWNED_KOHARU_PROJECT_IDENTITY_MISSING", "Owned project identity was not established");

    await executeStage(report, checkpoints, "detect-and-primary-ocr", async (item) => {
      await assertHeavyProcessHeadroom(options, item);
      await guard.assertProjectIdentity();
      const run = await ownedClient.runPipeline({ steps: pipeline.detect });
      item.warnings.push(...run.warnings.map(() => "KOHARU_PIPELINE_WARNING"));
    });

    regions = await executeStage(report, checkpoints, "inspect-primary-ocr", async () => {
      await guard.assertProjectIdentity();
      const scene = await ownedClient.getScene();
      scenePageIds = extractPageIds(scene);
      bubbleEvidence = await buildBubbleMaskEvidence(scene, (hash) => ownedClient.readBlob(hash));
      paddlePass = { status: "ran", engine: pipeline.primaryOcr, regions: extractOcrRuntimeRegions(scene) };
      const extracted = extractRegionsFromScene(scene, { ocrEngine: pipeline.primaryOcr, translationModel: config.translation.localTarget.modelId, quality: config.quality, bubbleEvidence });
      if (paddlePass.regions.length === 0) throw new LocalizerError("SCENE_TEXT_NOT_FOUND", "Koharu scene contains no recognizable OCR-eligible text regions; the scene schema may be incompatible", { recoverable: true });
      return extracted;
    });

    if (!paddlePass) throw new LocalizerError("OCR_RUNTIME_PRIMARY_PASS_MISSING", "Paddle OCR inspection did not produce a runtime pass");
    const confirmedPaddlePass = paddlePass;
    const eligiblePages = unique(confirmedPaddlePass.regions.map((region) => region.pageId));
    await executeStage(report, checkpoints, "manga-ocr-all-eligible-pages", async (item) => {
      await guard.assertProjectIdentity();
      const run = await ownedClient.runPipeline({ steps: [pipeline.fallbackOcr], pages: eligiblePages });
      item.warnings.push(...run.warnings.map(() => "KOHARU_PIPELINE_WARNING"));
    });
    const fallbackSnapshot = await readStableScene(ownedClient, async () => {
      await guard.assertIdentity();
      await guard.assertProjectIdentity();
    });
    const fallbackScene = fallbackSnapshot.scene;
    const mangaPass: OcrRuntimePass = { status: "ran", engine: pipeline.fallbackOcr, regions: extractOcrRuntimeRegions(fallbackScene) };
    const arbitration = applyOcrRuntimePolicy(confirmedPaddlePass, mangaPass, config.quality.ocrRuntimePolicy.name);
    if (arbitration.blocked) {
      throw new LocalizerError("OCR_RUNTIME_QA_BLOCKED", "OCR runtime policy blocked translation because one or more eligible regions lack safe agreement or a required candidate");
    }
    regions = applyOcrRuntimeDecisions(regions, arbitration);
    await guard.establishSceneIdentity(fallbackSnapshot, path.join(privateRuntime, "owned-project.private.json"));

    journal = await DurablePrivateJournal.create(path.join(privateRuntime, "journal"));
    const patchResult = await executeStage(report, checkpoints, "selected-ocr-scene-patch", async () => {
      return await applyOwnedScenePatch({
        client: ownedClient,
        guard,
        journal: journal!,
        selected: regions.map((region) => ({ pageId: region.pageId, regionId: region.id, selectedSourceText: region.sourceText })),
      });
    });

    await executeStage(report, checkpoints, "load-local-translator", async (item) => {
      await assertHeavyProcessHeadroom(options, item);
      await guard.assertProjectIdentity(patchResult.snapshot);
      await ownedClient.loadLlm(config.translation.localTarget);
      llmLoaded = true;
      await ownedClient.waitForLlmReady();
    });

    const orderedPages = scenePageIds.length > 0 ? scenePageIds : unique(regions.map((region) => region.pageId));
    const translationPages = unique(regions.map((region) => region.pageId));
    if (translationPages.length === 0) throw new LocalizerError("TRANSLATION_PAGES_EMPTY", "No selected OCR pages are available for chapter translation");
    const translated = await executeStage(report, checkpoints, "translate-selected-source", async (item) => {
      const result = await runOwnedTranslator({
        client: ownedClient,
        guard,
        journal: journal!,
        expectedPatchedSnapshot: patchResult.snapshot,
        selected: regions.map((region) => ({ pageId: region.pageId, regionId: region.id, selectedSourceText: region.sourceText })),
        request: {
          steps: [pipeline.translator],
          pages: translationPages,
          textNodeIds: regions.map((region) => region.id),
          targetLanguage: config.translation.targetLanguage,
          systemPrompt: buildGlossaryPrompt(config.translation.systemPrompt, deriveGlossary(regions)),
        },
      });
      item.warnings.push(...result.warnings.map(() => "KOHARU_PIPELINE_WARNING"));
      return result;
    });
    regions = applyChapterQa(carryOcrProvenance(regions, extractRegionsFromScene(translated.snapshot.scene, { ocrEngine: pipeline.primaryOcr, translationModel: config.translation.localTarget.modelId, quality: config.quality, bubbleEvidence })), config.quality);
    const retryPages = translationRetryPages(regions);
    if (retryPages.length > 0) {
      report.stages.push({ name: "owned-translation-retry", status: "warning", warnings: ["OWNED_SINGLE_WRITER_RETRY_NOT_RUN"] });
    }
    await executeStage(report, checkpoints, "post-translator-render-gate", async () => {
      const immediatelyBeforeRender = await readStableScene(ownedClient, async () => {
        await guard.assertIdentity();
        await guard.assertProjectIdentity();
      });
      await guard.assertProjectIdentity(immediatelyBeforeRender);
      if (sceneFullHash(immediatelyBeforeRender) !== sceneFullHash(translated.snapshot)) {
        throw new LocalizerError("KOHARU_POST_TRANSLATOR_SCENE_DRIFT", "Scene changed after translator verification and before inpaint/render");
      }
    });

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
      try {
        await guard.assertProjectIdentity();
        await ownedClient.unloadLlm();
        llmLoaded = false;
      } catch { item.warnings.push("LLM_UNLOAD_FAILED"); }
    });

    await executeStage(report, checkpoints, "inpaint", async (item) => {
      if (renderPages.length === 0) {
        item.warnings.push("ALL_PAGES_PRESERVED_AFTER_BLOCKING_QA");
        return;
      }
      await guard.assertProjectIdentity();
      const run = await ownedClient.runPipeline({ steps: [pipeline.inpainter], pages: renderPages });
      item.warnings.push(...run.warnings.map(() => "KOHARU_PIPELINE_WARNING"));
    });
    await executeStage(report, checkpoints, "render", async (item) => {
      if (renderPages.length === 0) {
        item.warnings.push("ALL_PAGES_PRESERVED_AFTER_BLOCKING_QA");
        return;
      }
      await guard.assertProjectIdentity();
      const run = await ownedClient.runPipeline({ steps: [pipeline.renderer], pages: renderPages });
      item.warnings.push(...run.warnings.map(() => "KOHARU_PIPELINE_WARNING"));
    });

    const rendered = await executeStage(report, checkpoints, "export-and-structural-visual-qa", async (item) => {
      let exported: InputImage[] = [];
      if (renderPages.length > 0) {
        await guard.assertProjectIdentity();
        const renderedExport = await ownedClient.exportProject("rendered", renderPages);
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
      await guard.assertProjectIdentity();
      const khr = await ownedClient.exportProject("khr");
      if (khr.bytes.length === 0) throw new LocalizerError("KHR_EXPORT_EMPTY", "Koharu returned an empty KHR export");
      await writeExclusive(path.join(output.directory, "chapter.khr"), khr.bytes);
      if (options.psd) {
        const psd = await ownedClient.exportProject("psd");
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
    report.finishedAt = new Date().toISOString();
  } finally {
    const recordCleanupFailure = (error: unknown): void => {
      const failure = asLocalizerError(error, "OWNED_KOHARU_CLEANUP_FAILED");
      report.status = "failed";
      report.failure = { code: failure.code, message: failure.message, recoverable: false };
      report.finishedAt = new Date().toISOString();
    };
    if (llmLoaded && client && ownedProcess) {
      try {
        await ownedProcess.assertIdentity();
        await client.unloadLlm();
        llmLoaded = false;
      } catch (error) { recordCleanupFailure(error); }
    }
    let stopped = false;
    if (ownedProcess) {
      try {
        await ownedProcess.stop();
        stopped = true;
      } catch (error) { recordCleanupFailure(error); }
    }
    if (ownedLink && ownedLayout && ((!ownedStartAttempted) || stopped)) {
      try { await cleanupOwnedCacheLinks(ownedLayout.root, [ownedLink]); } catch (error) { recordCleanupFailure(error); }
    }
    if ((!ownedStartAttempted || stopped) && shadowManifestHash) {
      try {
        const after = await loadAndValidateShadowCache(ownedConfig.shadowCacheRoot, ownedConfig.shadowCacheManifest);
        if (after.manifestHash !== shadowManifestHash) throw new LocalizerError("SHADOW_CACHE_REBUILD_REQUIRED", "Shadow cache manifest identity changed during the owned run");
      } catch (error) { recordCleanupFailure(error); }
    }
  }
  report.artifacts.report = "report.json";
  await assertSchema("run-report.schema.json", report);
  await writeJsonExclusive(path.join(output.directory, "report.json"), report);
  if (report.status === "failed") throw new LocalizerError(report.failure?.code ?? "TRANSLATION_FAILED", `${report.failure?.message ?? "Translation failed"}\nRecovery report: ${path.join(output.directory, "report.json")}`, { recoverable: report.failure?.recoverable });
  return { directory: output.directory, report };
}
