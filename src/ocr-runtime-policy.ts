import { isDeepStrictEqual } from "node:util";
import { LocalizerError } from "./errors.ts";
import { inspectOcrText, type OcrHardSafetyReason } from "./ocr-safety.ts";
import type { BoundingBox, JsonObject, OcrCandidate, OcrRuntimePolicyName, QaFlag, RegionRecord } from "./types.ts";

export const OCR_RUNTIME_POLICY_VERSION = 1 as const;

export type OcrRuntimePassStatus = "ran" | "not-run";
export type OcrRuntimeSelectionReason = "raw-agreement" | "normalized-agreement" | "low-manual-paddle-precedence" | "qa-blocked";
export type OcrRuntimeQaReason =
  | "fallback-not-run"
  | "candidate-disagreement"
  | `paddle-${OcrHardSafetyReason}`
  | `manga-${OcrHardSafetyReason}`;

export interface OcrRuntimeRegionCandidate {
  id: string;
  pageId: string;
  order: number;
  sourceGeometry: BoundingBox & { rotationDeg?: number };
  text?: string;
  confidence?: number;
}

export interface OcrRuntimePass {
  status: OcrRuntimePassStatus;
  engine: string;
  regions: OcrRuntimeRegionCandidate[];
}

export interface OcrRuntimeDecision {
  id: string;
  pageId: string;
  order: number;
  sourceGeometry: OcrRuntimeRegionCandidate["sourceGeometry"];
  policy: { name: OcrRuntimePolicyName; version: typeof OCR_RUNTIME_POLICY_VERSION };
  candidates: [OcrCandidate, OcrCandidate];
  selectedEngine?: string;
  selectedSourceText?: string;
  selectionReason: OcrRuntimeSelectionReason;
  qaReasons: OcrRuntimeQaReason[];
}

export interface OcrRuntimeResult {
  policy: { name: OcrRuntimePolicyName; version: typeof OCR_RUNTIME_POLICY_VERSION };
  decisions: OcrRuntimeDecision[];
  blocked: boolean;
}

function invalid(code: string, message: string): never {
  throw new LocalizerError(code, message);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringField(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) if (typeof value[key] === "string" && value[key].length > 0) return value[key] as string;
  return undefined;
}

function geometry(value: unknown): OcrRuntimeRegionCandidate["sourceGeometry"] | undefined {
  const item = record(value);
  if (!item) return undefined;
  const x = item.x;
  const y = item.y;
  const width = item.width;
  const height = item.height;
  if (![x, y, width, height].every((part) => typeof part === "number" && Number.isFinite(part))
    || (width as number) < 0 || (height as number) < 0) return undefined;
  const rotationDeg = item.rotationDeg;
  if (rotationDeg !== undefined && (typeof rotationDeg !== "number" || !Number.isFinite(rotationDeg))) return undefined;
  return { x: x as number, y: y as number, width: width as number, height: height as number, ...(rotationDeg === undefined ? {} : { rotationDeg }) };
}

function orderedEntries(value: unknown): Array<[string | undefined, Record<string, unknown>]> {
  if (Array.isArray(value)) return value.map((item) => [undefined, record(item)] as const).filter((entry): entry is [undefined, Record<string, unknown>] => entry[1] !== undefined);
  const item = record(value);
  return item ? Object.entries(item).map(([key, child]) => [key, record(child)] as const).filter((entry): entry is [string, Record<string, unknown>] => entry[1] !== undefined) : [];
}

export function extractOcrRuntimeRegions(sceneSnapshot: JsonObject): OcrRuntimeRegionCandidate[] {
  const snapshot = record(sceneSnapshot)!;
  const scene = record(snapshot.scene) ?? snapshot;
  const pages = orderedEntries(scene.pages);
  if (pages.length === 0) invalid("OCR_RUNTIME_SCENE_INVALID", "Koharu scene has no page population for OCR runtime association");
  const pageIds = new Set<string>();
  const regionIds = new Set<string>();
  const regions: OcrRuntimeRegionCandidate[] = [];
  for (const [pageKey, page] of pages) {
    const explicitPageId = stringField(page, ["id", "pageId", "page_id"]);
    if (pageKey && explicitPageId && pageKey !== explicitPageId) {
      invalid("OCR_RUNTIME_PAGE_IDENTITY_CONFLICT", "Koharu OCR page identity conflicts with its scene population key");
    }
    const pageId = explicitPageId ?? pageKey;
    if (!pageId) invalid("OCR_RUNTIME_PAGE_ID_MISSING", "Koharu OCR page has no stable identity");
    if (pageIds.has(pageId)) invalid("OCR_RUNTIME_DUPLICATE_PAGE_ID", "Koharu OCR scene contains duplicate page identities");
    pageIds.add(pageId);
    const nodes = orderedEntries(page.nodes);
    for (let order = 0; order < nodes.length; order += 1) {
      const [nodeKey, node] = nodes[order];
      const kind = record(node.kind);
      const textData = record(kind?.text);
      const directTextNode = ["sourceText", "source_text", "recognizedText", "recognized_text", "ocrText", "ocr_text"].some((key) => key in node);
      if (!textData && !directTextNode) continue;
      const explicitNodeId = stringField(node, ["id", "nodeId", "node_id"]);
      if (nodeKey && explicitNodeId && nodeKey !== explicitNodeId) {
        invalid("OCR_RUNTIME_REGION_IDENTITY_CONFLICT", "Koharu OCR region identity conflicts with its scene population key");
      }
      const id = explicitNodeId ?? nodeKey;
      if (!id) invalid("OCR_RUNTIME_REGION_ID_MISSING", "Koharu OCR text node has no stable region identity");
      if (regionIds.has(id)) invalid("OCR_RUNTIME_DUPLICATE_REGION_ID", "Koharu OCR scene contains duplicate region identities");
      regionIds.add(id);
      const sourceGeometry = geometry(node.transform ?? node.bbox);
      if (!sourceGeometry) invalid("OCR_RUNTIME_GEOMETRY_MISSING", "Koharu OCR text node has no valid source geometry");
      const text = textData
        ? (typeof textData.text === "string" ? textData.text : undefined)
        : stringField(node, ["sourceText", "source_text", "recognizedText", "recognized_text", "ocrText", "ocr_text"]);
      const confidenceValue = textData?.confidence ?? node.ocrConfidence ?? node.ocr_confidence;
      if (confidenceValue !== undefined && (typeof confidenceValue !== "number" || !Number.isFinite(confidenceValue) || confidenceValue < 0 || confidenceValue > 1)) {
        invalid("OCR_RUNTIME_CONFIDENCE_INVALID", "Koharu OCR candidate confidence is outside its engine provenance contract");
      }
      regions.push({ id, pageId, order, sourceGeometry, ...(text === undefined ? {} : { text }), ...(confidenceValue === undefined ? {} : { confidence: confidenceValue as number }) });
    }
  }
  return regions;
}

function indexPass(pass: OcrRuntimePass, side: "paddle" | "manga"): Map<string, OcrRuntimeRegionCandidate> {
  if (!pass.engine) invalid("OCR_RUNTIME_ENGINE_INVALID", "OCR runtime engine identity must be non-empty");
  const byId = new Map<string, OcrRuntimeRegionCandidate>();
  for (const region of pass.regions) {
    if (byId.has(region.id)) invalid(`OCR_RUNTIME_DUPLICATE_${side.toUpperCase()}_REGION`, `OCR runtime ${side} pass contains duplicate region identities`);
    byId.set(region.id, region);
  }
  return byId;
}

function qaReasons(side: "paddle" | "manga", reasons: readonly OcrHardSafetyReason[]): OcrRuntimeQaReason[] {
  return reasons.map((reason) => `${side}-${reason}` as OcrRuntimeQaReason);
}

function candidate(engine: string, role: "paddle" | "manga", region: OcrRuntimeRegionCandidate | undefined, status: OcrCandidate["status"], selected: boolean, reason: OcrRuntimeSelectionReason): OcrCandidate {
  return {
    engine,
    role,
    status,
    ...(region?.text === undefined ? {} : { text: region.text }),
    ...(region?.confidence === undefined ? {} : { confidence: region.confidence }),
    selected,
    selectionReason: reason,
  };
}

export function applyOcrRuntimePolicy(paddle: OcrRuntimePass, manga: OcrRuntimePass, policyName: OcrRuntimePolicyName): OcrRuntimeResult {
  if (policyName !== "strict-quality" && policyName !== "low-manual") invalid("OCR_RUNTIME_POLICY_INVALID", "OCR runtime policy name is unsupported");
  if (paddle.status !== "ran") invalid("OCR_RUNTIME_PRIMARY_NOT_RUN", "Paddle OCR must run before runtime arbitration");
  if (paddle.engine === manga.engine) invalid("OCR_RUNTIME_ENGINES_NOT_DISTINCT", "OCR runtime policies require distinct Paddle and Manga OCR engines");
  if (manga.status === "not-run" && manga.regions.length !== 0) invalid("OCR_RUNTIME_FALLBACK_STATUS_INVALID", "A fallback marked not-run cannot contain candidates");
  const paddleById = indexPass(paddle, "paddle");
  const mangaById = indexPass(manga, "manga");
  if (paddleById.size === 0) invalid("OCR_RUNTIME_ELIGIBLE_REGIONS_EMPTY", "OCR runtime policy has no eligible Paddle regions");
  if (manga.status === "ran") {
    for (const [id, fallback] of mangaById) {
      const primary = paddleById.get(id);
      if (!primary) invalid("OCR_RUNTIME_EXTRA_FALLBACK_REGION", "Manga OCR produced a region outside the eligible Paddle population");
      if (primary.pageId !== fallback.pageId) invalid("OCR_RUNTIME_PAGE_ASSOCIATION_CONFLICT", "OCR passes associate the same region with different pages");
      if (!isDeepStrictEqual(primary.sourceGeometry, fallback.sourceGeometry)) invalid("OCR_RUNTIME_GEOMETRY_ASSOCIATION_CONFLICT", "OCR passes disagree on source region geometry");
    }
    for (const id of paddleById.keys()) if (!mangaById.has(id)) invalid("OCR_RUNTIME_FALLBACK_REGION_MISSING", "Manga OCR scene is missing an eligible region association");
  }

  const policy = { name: policyName, version: OCR_RUNTIME_POLICY_VERSION } as const;
  const decisions = paddle.regions.map((primary): OcrRuntimeDecision => {
    const fallback = manga.status === "ran" ? mangaById.get(primary.id)! : undefined;
    const primarySafety = inspectOcrText(primary.text);
    const fallbackSafety = manga.status === "ran" ? inspectOcrText(fallback.text) : undefined;
    const hardQa = [
      ...qaReasons("paddle", primarySafety.hardReasons),
      ...(fallbackSafety ? qaReasons("manga", fallbackSafety.hardReasons) : ["fallback-not-run" as const]),
    ];
    let selectionReason: OcrRuntimeSelectionReason = "qa-blocked";
    let selectedSourceText: string | undefined;
    let selectedEngine: string | undefined;
    const runtimeQa: OcrRuntimeQaReason[] = [...hardQa];
    if (hardQa.length === 0 && fallbackSafety) {
      if (primary.text === fallback.text) {
        selectionReason = "raw-agreement";
        selectedSourceText = primary.text;
        selectedEngine = paddle.engine;
      } else if (primarySafety.normalized === fallbackSafety.normalized) {
        selectionReason = "normalized-agreement";
        selectedSourceText = primary.text;
        selectedEngine = paddle.engine;
      } else if (policyName === "low-manual") {
        selectionReason = "low-manual-paddle-precedence";
        selectedSourceText = primary.text;
        selectedEngine = paddle.engine;
      } else runtimeQa.push("candidate-disagreement");
    }
    const selected = selectedEngine !== undefined;
    return {
      id: primary.id,
      pageId: primary.pageId,
      order: primary.order,
      sourceGeometry: primary.sourceGeometry,
      policy,
      candidates: [
        candidate(paddle.engine, "paddle", primary, primary.text === undefined ? "missing" : "present", selected, selectionReason),
        candidate(manga.engine, "manga", fallback, manga.status === "not-run" ? "not-run" : fallback.text === undefined ? "missing" : "present", false, selectionReason),
      ],
      ...(selectedEngine === undefined ? {} : { selectedEngine }),
      ...(selectedSourceText === undefined ? {} : { selectedSourceText }),
      selectionReason,
      qaReasons: runtimeQa,
    };
  });
  return { policy, decisions, blocked: decisions.some((decision) => decision.qaReasons.length > 0) };
}

function runtimeQaFlag(region: RegionRecord, reason: OcrRuntimeQaReason): QaFlag {
  return { code: `OCR_RUNTIME_${reason.replaceAll("-", "_").toUpperCase()}`, severity: "error", retryable: false, regionId: region.id, pageId: region.pageId };
}

export function applyOcrRuntimeDecisions(regions: RegionRecord[], result: OcrRuntimeResult): RegionRecord[] {
  const byId = new Map<string, RegionRecord>();
  for (const region of regions) {
    if (byId.has(region.id)) invalid("OCR_RUNTIME_DUPLICATE_REGION_RECORD", "Primary region records contain duplicate identities");
    byId.set(region.id, region);
  }
  if (byId.size !== result.decisions.length) invalid("OCR_RUNTIME_REGION_RECORD_POPULATION_CONFLICT", "Primary region records do not match OCR runtime decisions");
  const updated = result.decisions.map((decision) => {
    const region = byId.get(decision.id);
    if (!region) invalid("OCR_RUNTIME_REGION_RECORD_MISSING", "An OCR runtime decision has no primary region record");
    if (region.pageId !== decision.pageId) invalid("OCR_RUNTIME_REGION_RECORD_ASSOCIATION_CONFLICT", "Primary region record identity conflicts with OCR runtime association");
    const decisionBbox = { x: decision.sourceGeometry.x, y: decision.sourceGeometry.y, width: decision.sourceGeometry.width, height: decision.sourceGeometry.height };
    if (!region.bbox || !isDeepStrictEqual(region.bbox, decisionBbox)) invalid("OCR_RUNTIME_REGION_RECORD_GEOMETRY_CONFLICT", "Primary region record geometry conflicts with OCR runtime association");
    byId.delete(decision.id);
    return {
      ...region,
      schemaVersion: 2 as const,
      ...(decision.selectedSourceText === undefined ? {} : { sourceText: decision.selectedSourceText }),
      ocrCandidates: decision.candidates,
      ocrRuntimePolicy: decision.policy,
      ...(decision.selectedEngine === undefined ? {} : { selectedOcrEngine: decision.selectedEngine }),
      ocrSelectionReason: decision.selectionReason,
      ocrQaReasons: decision.qaReasons,
      qaFlags: [...region.qaFlags, ...decision.qaReasons.map((reason) => runtimeQaFlag(region, reason))],
    };
  });
  if (byId.size !== 0) invalid("OCR_RUNTIME_REGION_RECORD_EXTRA", "Primary region records contain regions outside OCR runtime decisions");
  return updated;
}
