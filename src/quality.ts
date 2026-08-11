import { createHash } from "node:crypto";
import { BUBBLE_ROLE_MIN_OVERLAP, bubbleEvidenceKey } from "./bubble-mask.ts";
import { LocalizerError } from "./errors.ts";
import type { BubbleMaskEvidence } from "./bubble-mask.ts";
import type { BoundingBox, JsonObject, JsonValue, LocalizerConfig, QaFlag, RegionRecord } from "./types.ts";

interface PartialRegion {
  id: string;
  pageId: string;
  order: number;
  sourceText?: string;
  translatedText?: string;
  confidence?: number;
  bbox?: BoundingBox;
  insideBubble?: boolean;
  role?: RegionRecord["role"];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function firstString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) if (typeof value[key] === "string") return value[key] as string;
  return undefined;
}

function nestedText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const item = record(value);
  if (!item) return undefined;
  return firstString(item, ["text", "content", "value", "sourceText", "translatedText"]);
}

function typeLabel(value: Record<string, unknown>): string {
  return firstString(value, ["$type", "type", "kind", "componentType", "component", "role", "name"]) ?? "";
}

function parseBbox(value: unknown): BoundingBox | undefined {
  const item = record(value);
  if (!item) return undefined;
  const x = Number(item.x ?? item.left ?? item.x0);
  const y = Number(item.y ?? item.top ?? item.y0);
  let width = Number(item.width ?? item.w);
  let height = Number(item.height ?? item.h);
  if (!Number.isFinite(width) && Number.isFinite(Number(item.x1)) && Number.isFinite(x)) width = Number(item.x1) - x;
  if (!Number.isFinite(height) && Number.isFinite(Number(item.y1)) && Number.isFinite(y)) height = Number(item.y1) - y;
  if (![x, y, width, height].every(Number.isFinite) || width < 0 || height < 0) return undefined;
  return { x, y, width, height };
}

function stableFallbackId(path: string): string {
  return `region-${createHash("sha256").update(path).digest("hex").slice(0, 16)}`;
}

function roleFromLabel(label: string, direct?: string): RegionRecord["role"] | undefined {
  const combined = `${label} ${direct ?? ""}`.toLowerCase();
  if (combined.includes("sfx") || combined.includes("sound") || combined.includes("onomatop")) return "sfx";
  if (combined.includes("caption") || combined.includes("narrat")) return "caption";
  if (combined.includes("dialog") || combined.includes("speech") || combined.includes("bubble")) return "dialogue";
  return undefined;
}

export function extractRegionsFromScene(scene: JsonObject, options: { ocrEngine: string; translationModel: string; quality: LocalizerConfig["quality"]; bubbleEvidence?: BubbleMaskEvidence }): RegionRecord[] {
  const grouped = new Map<string, PartialRegion>();
  let sequence = 0;

  const mergeRegion = (id: string, patch: Partial<PartialRegion>): void => {
    const current = grouped.get(id) ?? { id, pageId: patch.pageId ?? "unknown-page", order: sequence++ };
    grouped.set(id, { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) });
  };

  const walk = (value: JsonValue, path: string, context: { pageId?: string; entityId?: string }): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`, context));
      return;
    }
    if (!value || typeof value !== "object") return;
    const item = value as JsonObject;
    const label = typeLabel(item as Record<string, unknown>);
    const nodeKind = record(item.kind);
    const koharuTextNode = record(nodeKind?.text);
    const hasDirectText = ["sourceText", "source_text", "recognizedText", "recognized_text", "ocrText", "ocr_text", "translatedText", "translated_text", "translation", "targetText", "target_text"]
      .some((key) => typeof item[key] === "string") || koharuTextNode !== undefined;
    const looksLikeKoharuPage = typeof item.id === "string" && record(item.nodes) !== undefined && typeof item.width === "number" && typeof item.height === "number";
    const pageId = firstString(item as Record<string, unknown>, ["pageId", "page_id", "page"])
      ?? (looksLikeKoharuPage ? item.id as string : context.pageId);
    const entityId = firstString(item as Record<string, unknown>, ["entityId", "entity_id", "nodeId", "node_id", "ownerId", "owner_id"])
      ?? ((hasDirectText || /(text|region|translation|ocr|content)/i.test(label)) ? firstString(item as Record<string, unknown>, ["id"]) : undefined)
      ?? context.entityId;
    const nextContext = { pageId, entityId };
    const directSource = firstString(item as Record<string, unknown>, ["sourceText", "source_text", "recognizedText", "recognized_text", "ocrText", "ocr_text"])
      ?? (koharuTextNode ? firstString(koharuTextNode, ["text", "sourceText", "source_text", "recognizedText", "recognized_text", "ocrText", "ocr_text"]) : undefined);
    const directTranslation = firstString(item as Record<string, unknown>, ["translatedText", "translated_text", "translation", "targetText", "target_text"])
      ?? (koharuTextNode ? firstString(koharuTextNode, ["translatedText", "translated_text", "translation", "targetText", "target_text"]) : undefined);
    const semanticSource = /source.?text|ocr.?text/i.test(label) ? nestedText(item.value ?? item.data ?? item) : undefined;
    const semanticTranslation = /translation|target.?text/i.test(label) ? nestedText(item.value ?? item.data ?? item) : undefined;
    const textContent = /text.?content/i.test(label) ? nestedText(item.value ?? item.data ?? item) : undefined;
    const sourceText = directSource ?? semanticSource ?? (semanticTranslation ? undefined : textContent);
    const translatedText = directTranslation ?? semanticTranslation;
    const bbox = parseBbox(item.bbox ?? item.bounds ?? item.rect ?? item.geometry ?? item.transform ?? item.value);
    const confidenceValue = item.ocrConfidence ?? item.ocr_confidence ?? koharuTextNode?.confidence ?? (/(ocr|recognition)/i.test(label) ? item.confidence ?? item.score : undefined);
    const confidence = typeof confidenceValue === "number" && Number.isFinite(confidenceValue) ? Math.max(0, Math.min(1, confidenceValue)) : undefined;
    const insideBubbleValue = item.insideBubble ?? item.inside_bubble ?? item.isInBubble;
    const insideBubble = typeof insideBubbleValue === "boolean" ? insideBubbleValue : undefined;
    const role = roleFromLabel(label, firstString(item as Record<string, unknown>, ["semanticRole", "semantic_role", "regionType", "region_type"]));
    if (sourceText !== undefined || translatedText !== undefined || confidence !== undefined || bbox !== undefined || role !== undefined) {
      const id = entityId ?? stableFallbackId(path);
      mergeRegion(id, { pageId: pageId ?? "unknown-page", sourceText, translatedText, confidence, bbox, insideBubble, role });
    }
    for (const [key, child] of Object.entries(item)) walk(child, `${path}.${key}`, nextContext);
  };
  walk(scene, "$", {});

  const partial = [...grouped.values()].filter((item) => item.sourceText !== undefined && item.sourceText.trim() !== "");
  return partial.sort((a, b) => a.order - b.order).map((item, order) => {
    const sourceText = item.sourceText!.trim();
    const translatedText = item.translatedText?.trim();
    const bubbleEvidence = options.bubbleEvidence?.get(bubbleEvidenceKey(item.pageId, item.id));
    const insideBubble = bubbleEvidence?.insideBubble ?? item.insideBubble;
    const roleDecision = classifyRole(item.role, bubbleEvidence
      ? { insideBubble, confidence: bubbleEvidence.confidence, roleProvenance: "bubble-mask" }
      : item.insideBubble !== undefined
        ? { insideBubble, confidence: 1, roleProvenance: "native" }
        : undefined);
    const role = roleDecision.role;
    const region: RegionRecord = {
      schemaVersion: 1,
      id: item.id,
      pageId: item.pageId,
      order,
      role,
      policy: replacementPolicyForRole(role),
      sourceText,
      ...(translatedText ? { translatedText } : {}),
      ...(item.bbox ? { bbox: item.bbox } : {}),
      ...(insideBubble !== undefined ? { insideBubble } : {}),
      ...(bubbleEvidence?.bubbleInstanceId ? { bubbleInstanceId: bubbleEvidence.bubbleInstanceId } : {}),
      ...(bubbleEvidence ? { geometrySource: bubbleEvidence.geometrySource } : {}),
      roleConfidence: roleDecision.confidence,
      roleProvenance: roleDecision.roleProvenance,
      ...(item.confidence !== undefined ? { ocrConfidence: item.confidence } : {}),
      ocrCandidates: [{ engine: options.ocrEngine, text: sourceText, confidence: item.confidence, selected: true, selectionReason: "primary-engine-output" }],
      translationCandidates: translatedText ? [{ model: options.translationModel, text: translatedText, selected: true, selectionReason: "latest-local-pipeline-output", route: "local" }] : [],
      qaFlags: [],
    };
    region.qaFlags = assessRegion(region, options.quality);
    return region;
  });
}

export function extractPageIds(scene: JsonObject): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    const item = record(value);
    if (!item) return;
    const id = firstString(item, ["pageId", "page_id", "id"]);
    if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
  };
  const walk = (value: unknown): void => {
    const item = record(value);
    if (!item) {
      if (Array.isArray(value)) value.forEach(walk);
      return;
    }
    const contextualPageId = firstString(item, ["pageId", "page_id"]);
    if (contextualPageId && !seen.has(contextualPageId)) { seen.add(contextualPageId); ids.push(contextualPageId); }
    for (const [key, child] of Object.entries(item)) {
      if (key.toLowerCase() === "pages") {
        if (Array.isArray(child)) child.forEach(add);
        else {
          const pages = record(child);
          if (pages) {
            for (const [mapId, page] of Object.entries(pages)) {
              const before = ids.length;
              add(page);
              if (ids.length === before && !seen.has(mapId)) { seen.add(mapId); ids.push(mapId); }
            }
          }
        }
      }
      walk(child);
    }
  };
  walk(scene);
  return ids;
}

export function chunkPageIds(pageIds: string[], chunkPages: number, contextOverlapPages: number): string[][] {
  if (!Number.isInteger(chunkPages) || chunkPages < 1) throw new RangeError("chunkPages must be a positive integer");
  if (!Number.isInteger(contextOverlapPages) || contextOverlapPages < 0 || contextOverlapPages >= chunkPages) {
    throw new RangeError("contextOverlapPages must be an integer smaller than chunkPages");
  }
  const uniquePages = [...new Set(pageIds)];
  if (uniquePages.length === 0) return [];
  const chunks: string[][] = [];
  const step = chunkPages - contextOverlapPages;
  for (let start = 0; start < uniquePages.length; start += step) {
    chunks.push(uniquePages.slice(start, start + chunkPages));
    if (start + chunkPages >= uniquePages.length) break;
  }
  return chunks;
}

export interface RoleDecision {
  role: RegionRecord["role"];
  confidence: number;
  roleProvenance: NonNullable<RegionRecord["roleProvenance"]>;
}

export function replacementPolicyForRole(role: RegionRecord["role"]): RegionRecord["policy"] {
  return role === "dialogue" || role === "caption" ? "replace" : "preserve-with-annotation";
}

export function classifyRole(
  nativeRole: RegionRecord["role"] | undefined,
  evidence?: { insideBubble?: boolean; confidence: number; roleProvenance: "native" | "bubble-mask" },
): RoleDecision {
  if (nativeRole && (["dialogue", "caption", "sfx"] as const).includes(nativeRole as "dialogue" | "caption" | "sfx")) {
    return { role: nativeRole, confidence: 1, roleProvenance: "native" };
  }
  if (evidence?.insideBubble === true && evidence.confidence >= BUBBLE_ROLE_MIN_OVERLAP) {
    return { role: "dialogue", confidence: evidence.confidence, roleProvenance: evidence.roleProvenance };
  }
  return { role: "unknown", confidence: 0, roleProvenance: "insufficient-evidence" };
}

export function containsJapaneseKana(text: string): boolean {
  return /[\u3040-\u30ff\uff66-\uff9f]/u.test(text);
}

export function containsReasoningArtifact(text: string): boolean {
  return /<\/?think\b[^>]*>|<\|(?:analysis|reasoning)(?:_content)?\|>/iu.test(text);
}

export function looksLikeRefusal(text: string): boolean {
  return /(无法(?:协助|翻译|处理)|不能(?:协助|翻译|处理)|抱歉.{0,12}(?:不能|无法)|I\s+(?:can(?:not|'t)|am unable to)\s+(?:help|translate|assist))/iu.test(text);
}

function significantCharacters(text: string): string[] {
  return [...text.matchAll(/[0-9０-９]+|[!?！？…]+/gu)].map((match) => match[0]);
}

export function estimateCapacity(bbox: BoundingBox | undefined, minGlyphPixels: number): number | undefined {
  if (!bbox || bbox.width <= 0 || bbox.height <= 0) return undefined;
  return Math.max(1, Math.floor(bbox.width / minGlyphPixels) * Math.floor(bbox.height / minGlyphPixels));
}

export function assessRegion(region: RegionRecord, quality: LocalizerConfig["quality"]): QaFlag[] {
  const flags: QaFlag[] = [];
  const push = (code: string, severity: QaFlag["severity"], retryable: boolean, detail?: string): void => {
    flags.push({ code, severity, retryable, regionId: region.id, pageId: region.pageId, ...(detail ? { detail } : {}) });
  };
  if (region.ocrConfidence !== undefined && region.ocrConfidence < quality.ocrConfidenceThreshold) push("LOW_OCR_CONFIDENCE", "warning", true);
  if (/\ufffd|(.)(?:\1){4,}/u.test(region.sourceText)) push("OCR_TEXT_ANOMALY", "warning", true);
  if (!region.translatedText?.trim()) {
    if (region.policy === "replace") push("MISSING_TRANSLATION", "error", true);
    return flags;
  }
  const translated = region.translatedText.trim();
  if (containsReasoningArtifact(translated)) push("LLM_REASONING_LEAK", "error", true);
  if (looksLikeRefusal(translated)) push("TRANSLATION_REFUSAL", "error", true);
  if (region.policy === "replace" && containsJapaneseKana(translated)) push("JAPANESE_KANA_REMAINS", "error", true);
  const sourceSignals = significantCharacters(region.sourceText);
  const targetSignals = significantCharacters(translated);
  for (const signal of sourceSignals) if (!targetSignals.includes(signal)) push("SIGNIFICANT_TOKEN_LOST", "warning", true, signal);
  const sourceLength = Math.max(1, region.sourceText.replace(/\s/g, "").length);
  const targetLength = translated.replace(/\s/g, "").length;
  const ratio = targetLength / sourceLength;
  if (ratio > quality.maxTranslationLengthRatio) push("TRANSLATION_TOO_LONG", "warning", true);
  if (ratio < quality.minTranslationLengthRatio) push("TRANSLATION_TOO_SHORT", "warning", true);
  const capacity = estimateCapacity(region.bbox, quality.minGlyphPixels);
  if (capacity !== undefined && targetLength > capacity) push("TEXT_OVERFLOW_RISK", "error", true);
  return flags;
}

export function applyChapterQa(regions: RegionRecord[], quality: LocalizerConfig["quality"]): RegionRecord[] {
  const translations = new Map<string, Set<string>>();
  for (const region of regions) {
    if (!region.translatedText) continue;
    const normalized = region.translatedText.replace(/\s+/g, "").toLowerCase();
    const sources = translations.get(normalized) ?? new Set<string>();
    sources.add(region.sourceText.replace(/\s+/g, ""));
    translations.set(normalized, sources);
  }
  return regions.map((region) => {
    const qaFlags = assessRegion(region, quality);
    if (region.translatedText) {
      const normalized = region.translatedText.replace(/\s+/g, "").toLowerCase();
      if ((translations.get(normalized)?.size ?? 0) >= 3 && region.translatedText.length >= 3) {
        qaFlags.push({ code: "SUSPICIOUS_DUPLICATE_TRANSLATION", severity: "warning", retryable: true, regionId: region.id, pageId: region.pageId });
      }
    }
    return { ...region, qaFlags };
  });
}

export function pagesNeedingRetry(regions: RegionRecord[]): string[] {
  return [...new Set(regions.filter((region) => region.qaFlags.some((flag) => flag.retryable && flag.severity !== "info")).map((region) => region.pageId))];
}

const TRANSLATION_RETRY_CODES = new Set([
  "MISSING_TRANSLATION", "LLM_REASONING_LEAK", "TRANSLATION_REFUSAL", "JAPANESE_KANA_REMAINS", "SIGNIFICANT_TOKEN_LOST",
  "TRANSLATION_TOO_LONG", "TRANSLATION_TOO_SHORT", "TEXT_OVERFLOW_RISK", "SUSPICIOUS_DUPLICATE_TRANSLATION",
]);

export function translationRetryPages(regions: RegionRecord[]): string[] {
  return [...new Set(regions.filter((region) => region.qaFlags.some((flag) => flag.retryable && TRANSLATION_RETRY_CODES.has(flag.code))).map((region) => region.pageId))];
}

const STRICT_RENDER_BLOCKER_CODES = new Set([
  "MISSING_TRANSLATION",
  "LLM_REASONING_LEAK",
  "TRANSLATION_REFUSAL",
  "JAPANESE_KANA_REMAINS",
]);

function blocksSafeRendering(region: RegionRecord): boolean {
  const codes = new Set(region.qaFlags.map((flag) => flag.code));
  if ([...codes].some((code) => STRICT_RENDER_BLOCKER_CODES.has(code))) return true;
  return codes.has("TRANSLATION_TOO_LONG") && codes.has("TEXT_OVERFLOW_RISK");
}

export function renderBlockedPages(regions: RegionRecord[]): string[] {
  return [...new Set(regions.filter(blocksSafeRendering).map((region) => region.pageId))];
}

const STRUCTURAL_RISK_CODES = new Set([
  "LOW_OCR_CONFIDENCE",
  "OCR_TEXT_ANOMALY",
  "MISSING_TRANSLATION",
  "LLM_REASONING_LEAK",
  "TRANSLATION_REFUSAL",
  "JAPANESE_KANA_REMAINS",
  "SIGNIFICANT_TOKEN_LOST",
  "TRANSLATION_TOO_LONG",
  "TRANSLATION_TOO_SHORT",
  "TEXT_OVERFLOW_RISK",
  "SUSPICIOUS_DUPLICATE_TRANSLATION",
]);

export interface PagePreservationReason {
  pageId: string;
  codes: string[];
}

export function renderProtectionPlan(
  pageIds: string[],
  regions: RegionRecord[],
  config: LocalizerConfig["quality"]["structuralProtection"],
): PagePreservationReason[] {
  const pageIdSet = new Set(pageIds);
  if (pageIdSet.size !== pageIds.length) {
    throw new LocalizerError(
      "RENDER_PROTECTION_PAGE_MAPPING_INVALID",
      "Render protection requires unique ordered page ids",
    );
  }
  if (regions.some((region) => !pageIdSet.has(region.pageId))) {
    throw new LocalizerError(
      "RENDER_PROTECTION_PAGE_MAPPING_INVALID",
      "Render protection found a region outside the ordered scene pages",
    );
  }

  const strictPages = new Set(renderBlockedPages(regions));
  const regionsByPage = new Map<string, RegionRecord[]>();
  for (const pageId of pageIds) regionsByPage.set(pageId, []);
  for (const region of regions) regionsByPage.get(region.pageId)?.push(region);

  return pageIds.flatMap((pageId, index) => {
    const pageRegions = regionsByPage.get(pageId) ?? [];
    const codes: string[] = [];
    if (strictPages.has(pageId)) codes.push("BLOCKING_REGION_QA");
    if (config.preserveEmptyPages && pageRegions.length === 0) codes.push("NO_TEXT_REGIONS_DETECTED");
    if (pageRegions.some((region) => region.role === "unknown")) codes.push("UNCLASSIFIED_TEXT_REGION");
    if (
      config.preserveArtisticOnlyPages
      && pageRegions.length > 0
      && pageRegions.every((region) => region.role === "sfx" && region.policy === "preserve-with-annotation")
    ) {
      codes.push("ARTISTIC_TEXT_ONLY_PAGE");
    }

    const boundary = index === 0 || index === pageIds.length - 1;
    if (boundary && pageRegions.length > 0) {
      const riskyRegions = pageRegions.filter((region) => region.qaFlags.some((flag) => STRUCTURAL_RISK_CODES.has(flag.code))).length;
      const sparseAndAllRisky = pageRegions.length <= config.boundarySparseRegionLimit && riskyRegions === pageRegions.length;
      const denseAndMostlyRisky = pageRegions.length >= config.boundaryDenseRegionThreshold && riskyRegions / pageRegions.length >= config.boundaryRiskRatio;
      if (sparseAndAllRisky || denseAndMostlyRisky) codes.push("RISKY_BOUNDARY_PAGE");
    }
    return codes.length > 0 ? [{ pageId, codes }] : [];
  });
}

export function markRenderBlockedPages(regions: RegionRecord[], blockedPages: Set<string>): RegionRecord[] {
  return regions.map((region) => {
    if (!blockedPages.has(region.pageId) || region.qaFlags.some((flag) => flag.code === "RENDERING_SKIPPED_FOR_PAGE")) return region;
    return {
      ...region,
      qaFlags: [
        ...region.qaFlags,
        {
          code: "RENDERING_SKIPPED_FOR_PAGE",
          severity: "warning",
          retryable: false,
          regionId: region.id,
          pageId: region.pageId,
        },
      ],
    };
  });
}

export function lowOcrPages(regions: RegionRecord[]): string[] {
  return [...new Set(regions.filter((region) => region.qaFlags.some((flag) => flag.code === "LOW_OCR_CONFIDENCE" || flag.code === "OCR_TEXT_ANOMALY")).map((region) => region.pageId))];
}

export function qaSummary(regions: RegionRecord[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const region of regions) for (const flag of region.qaFlags) summary[flag.code] = (summary[flag.code] ?? 0) + 1;
  return summary;
}

export function deriveGlossary(regions: RegionRecord[]): Record<string, string> {
  const candidates = new Map<string, Map<string, number>>();
  for (const region of regions) {
    if (!region.translatedText || region.role === "sfx") continue;
    const source = region.sourceText.replace(/\s+/g, "").trim();
    const target = region.translatedText.replace(/\s+/g, "").trim();
    if (source.length < 2 || target.length < 1) continue;
    const translations = candidates.get(source) ?? new Map<string, number>();
    translations.set(target, (translations.get(target) ?? 0) + 1);
    candidates.set(source, translations);
  }
  const glossary: Record<string, string> = {};
  for (const [source, translations] of candidates) {
    const best = [...translations.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (best && best[1] >= 2) glossary[source] = best[0];
  }
  return glossary;
}

export function buildRetryPrompt(base: string, glossary: Record<string, string>): string {
  return buildGlossaryPrompt(base, glossary);
}

export function buildGlossaryPrompt(base: string, glossary: Record<string, string>): string {
  const entries = Object.entries(glossary).slice(0, 100);
  if (entries.length === 0) return base;
  const lines = entries.map(([source, target]) => `${source} => ${target}`).join("\n");
  return `${base}\n必须遵守以下章节术语表：\n${lines}`;
}
