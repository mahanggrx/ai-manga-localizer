export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type QaSeverity = "info" | "warning" | "error";

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BubbleGeometrySource = "line-polygons" | "bbox";

export interface QaFlag {
  code: string;
  severity: QaSeverity;
  regionId?: string;
  pageId?: string;
  detail?: string;
  retryable: boolean;
}

export interface OcrCandidate {
  engine: string;
  text: string;
  confidence?: number;
  selected: boolean;
  selectionReason: string;
}

export interface TranslationCandidate {
  model: string;
  text: string;
  confidence?: number;
  selected: boolean;
  selectionReason: string;
  route: "local" | "cloud";
}

export interface RegionRecord {
  schemaVersion: 1;
  id: string;
  pageId: string;
  order: number;
  role: "dialogue" | "caption" | "sfx" | "unknown";
  policy: "replace" | "preserve-with-annotation";
  sourceText: string;
  translatedText?: string;
  bbox?: BoundingBox;
  insideBubble?: boolean;
  bubbleInstanceId?: string;
  geometrySource?: BubbleGeometrySource;
  roleConfidence?: number;
  roleProvenance?: "native" | "bubble-mask" | "insufficient-evidence";
  ocrConfidence?: number;
  ocrCandidates: OcrCandidate[];
  translationCandidates: TranslationCandidate[];
  qaFlags: QaFlag[];
}

export interface ChapterManifest {
  schemaVersion: 1;
  chapterId: string;
  title: string;
  sourceLanguage: "ja";
  targetLanguage: "zh-CN";
  createdAt: string;
  sourceFiles: Array<{ pageId: string; fileName: string; sha256: string }>;
  regions: RegionRecord[];
  glossary: Record<string, string>;
}

export interface StageReport {
  name: string;
  status: "pending" | "running" | "passed" | "warning" | "failed" | "skipped";
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  errorCode?: string;
  warnings: string[];
}

export interface RunReport {
  schemaVersion: 1;
  runId: string;
  status: "running" | "completed" | "completed-with-warnings" | "failed";
  startedAt: string;
  finishedAt?: string;
  inputKind: "directory" | "zip" | "cbz";
  inputPageCount: number;
  outputDirectory: string;
  koharuVersion?: string;
  gpu?: { name: string; memoryMiB: number; peakMemoryMiB?: number };
  cloudAllowed: boolean;
  cloudRegions: string[];
  renderSafety?: {
    preservedPageCount: number;
    renderedPageCount: number;
    preservedPages: string[];
    preservationReasons: Array<{ pageId: string; codes: string[] }>;
  };
  stages: StageReport[];
  qaSummary: Record<string, number>;
  artifacts: Record<string, string>;
  failure?: { code: string; message: string; recoverable: boolean };
}

export interface LockedModel {
  id: string;
  family: string;
  version: string;
  quantization?: string;
  sha256: string;
  localPath?: string;
  license: string;
  role: "ocr" | "translation" | "review" | "inpainting";
  selected: boolean;
}

export interface ModelLock {
  schemaVersion: 1;
  generatedAt: string;
  benchmarkId: string;
  koharuVersion: string;
  models: LockedModel[];
}

export interface LlmTarget {
  kind: "local" | "provider";
  modelId: string;
  providerId?: string;
  options?: {
    temperature?: number;
    maxTokens?: number;
    customSystemPrompt?: string;
  };
}

export interface LocalizerConfig {
  schemaVersion: 1;
  koharu: {
    baseUrl: string;
    requiredVersion: string;
    requestTimeoutMs: number;
    operationTimeoutMs: number;
    allowRemote: boolean;
  };
  quality: {
    profile: "quality-local";
    primaryOcrHints: string[];
    fallbackOcrHints: string[];
    primaryInpainterHints: string[];
    fallbackInpainterHints: string[];
    ocrConfidenceThreshold: number;
    maxTranslationLengthRatio: number;
    minTranslationLengthRatio: number;
    maxRetries: number;
    sfxMaxCharacters: number;
    minGlyphPixels: number;
    structuralProtection: {
      preserveEmptyPages: boolean;
      preserveArtisticOnlyPages: boolean;
      boundarySparseRegionLimit: number;
      boundaryDenseRegionThreshold: number;
      boundaryRiskRatio: number;
    };
  };
  translation: {
    targetLanguage: "zh-CN";
    localTarget: LlmTarget;
    cloudTarget?: LlmTarget;
    systemPrompt: string;
    retryPrompt: string;
    chunkPages: number;
    contextOverlapPages: number;
  };
  archives: {
    maxEntries: number;
    maxEntryBytes: number;
    maxTotalBytes: number;
  };
  modelsLockPath: string;
}

export interface InputImage {
  fileName: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  bytes: Uint8Array;
  sha256: string;
}

export interface KoharuMeta {
  version: string;
  device?: string;
  [key: string]: unknown;
}

export interface PipelineRunRequest {
  steps: string[];
  pages?: string[];
  targetLanguage?: string;
  systemPrompt?: string;
  defaultFont?: string;
}

export interface BenchmarkMetrics {
  detectionRecall: number;
  ocrCer: number;
  semanticUsableRate: number;
  termConsistency: number;
  noEditPageRate: number;
  repairLetteringScore: number;
  requiredNonRefusalRate: number;
  formatValidRate: number;
  peakVramMiB?: number;
  weightedScore: number;
  hardGatePassed: boolean;
}
