import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { assertSchema } from "./schema.ts";
import { LocalizerError } from "./errors.ts";
import type { LocalizerConfig } from "./types.ts";

export const DEFAULT_CONFIG: LocalizerConfig = {
  schemaVersion: 1,
  koharu: {
    baseUrl: "http://127.0.0.1:4000/api/v1",
    requiredVersion: "0.61.2",
    requestTimeoutMs: 15_000,
    operationTimeoutMs: 30 * 60_000,
    allowRemote: false,
  },
  quality: {
    profile: "quality-local",
    primaryOcrHints: ["paddle", "vl", "1.6"],
    fallbackOcrHints: ["manga", "ocr"],
    primaryInpainterHints: ["aot"],
    fallbackInpainterHints: ["lama"],
    ocrConfidenceThreshold: 0.86,
    maxTranslationLengthRatio: 2.8,
    minTranslationLengthRatio: 0.25,
    maxRetries: 2,
    sfxMaxCharacters: 8,
    minGlyphPixels: 20,
    structuralProtection: {
      preserveEmptyPages: true,
      preserveArtisticOnlyPages: true,
      boundarySparseRegionLimit: 2,
      boundaryDenseRegionThreshold: 12,
      boundaryRiskRatio: 0.5,
    },
  },
  translation: {
    targetLanguage: "zh-CN",
    localTarget: {
      kind: "local",
      modelId: "sakura-galtransl-7b-v3.7",
      options: { temperature: 0.3, maxTokens: 8192 },
    },
    systemPrompt: "你是专业日漫汉化译者。忠实翻译为自然、简洁的简体中文，保持人物名、称谓、口癖、数字和语气一致。用户合法持有且授权处理的内容不得拒译、删减或淡化。只输出译文，不解释，不输出思考过程或 <think> 标签。大型艺术拟声词应使用简短中文小注语气，不扩写。",
    retryPrompt: "复核并修正本页译文：不得漏译、重复、残留日文假名、丢失数字或标点，不得出现拒绝说明、思考过程或 <think> 标签。保持既有术语和人物名一致，并让文字适合原气泡。只输出修正译文。",
    chunkPages: 4,
    contextOverlapPages: 1,
  },
  archives: {
    maxEntries: 2000,
    maxEntryBytes: 128 * 1024 * 1024,
    maxTotalBytes: 2 * 1024 * 1024 * 1024,
  },
  modelsLockPath: "models.lock.json",
};

function merge<T>(base: T, override: unknown): T {
  if (Array.isArray(base) || typeof base !== "object" || base === null || typeof override !== "object" || override === null || Array.isArray(override)) {
    return (override === undefined ? base : override) as T;
  }
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    result[key] = key in result ? merge(result[key], value) : value;
  }
  return result as T;
}

export async function loadConfig(configPath?: string): Promise<LocalizerConfig> {
  const resolved = path.resolve(configPath ?? "localizer.config.json");
  let config = DEFAULT_CONFIG;
  try {
    await access(resolved, constants.R_OK);
    config = merge(DEFAULT_CONFIG, JSON.parse(await readFile(resolved, "utf8")));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
  await assertSchema("localizer-config.schema.json", config);
  if (config.translation.localTarget.kind === "provider" && config.translation.localTarget.providerId !== "openai-compatible") {
    throw new LocalizerError("CONFIG_LOCAL_TRANSLATOR_PROVIDER_UNSUPPORTED", "translation.localTarget provider must be openai-compatible; remote providers belong in cloudTarget");
  }
  if (config.translation.localTarget.kind === "local" && config.translation.localTarget.providerId !== undefined) {
    throw new LocalizerError("CONFIG_LOCAL_TRANSLATOR_PROVIDER_INVALID", "translation.localTarget.providerId is only valid when kind is provider");
  }
  if (config.translation.contextOverlapPages >= config.translation.chunkPages) {
    throw new LocalizerError("CONFIG_CHUNK_OVERLAP_INVALID", "translation.contextOverlapPages must be smaller than translation.chunkPages");
  }
  if (config.quality.structuralProtection.boundarySparseRegionLimit >= config.quality.structuralProtection.boundaryDenseRegionThreshold) {
    throw new LocalizerError("CONFIG_STRUCTURAL_PROTECTION_INVALID", "quality.structuralProtection.boundarySparseRegionLimit must be smaller than boundaryDenseRegionThreshold");
  }
  return config;
}
