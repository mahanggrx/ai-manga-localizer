import { sha256Bytes } from "./file-utils.ts";
import { LocalizerError } from "./errors.ts";

export type OcrDetectionStatus = "detected" | "missed";
export type OcrScoringEligibility = "eligible" | "excluded";
export type OcrExclusionReason = "detection-missed" | "non-text-false-positive" | "partial-glyph-bbox" | "boundary-clipped";

export interface OcrEligibilityOverlayEntry {
  regionId: string;
  detectionStatus?: OcrDetectionStatus;
  ocrEligibility?: OcrScoringEligibility;
  exclusionReason?: OcrExclusionReason;
  expectedOcr?: string;
}

export interface OcrEligibilityOverlay {
  schemaVersion: 1;
  overlayRevision: number;
  benchmarkId: string;
  base: {
    artifact: string;
    sha256: string;
    byteLength: number;
    reviewRevision: number;
  };
  entries: OcrEligibilityOverlayEntry[];
}

export interface OcrBenchmarkCandidate {
  engine: string;
  text: string;
}

export interface OcrBenchmarkRegion {
  id: string;
  pageId: string;
  pageOrder: number;
  category: string;
  detectionStatus: OcrDetectionStatus;
  ocrEligibility: OcrScoringEligibility;
  exclusionReason?: OcrExclusionReason;
  expectedOcr?: string;
  candidates: OcrBenchmarkCandidate[];
}

export interface OcrBenchmarkInput {
  schemaVersion: 1;
  benchmarkId: string;
  source: {
    baseSha256: string;
    overlaySha256: string;
    reviewRevision: number;
    overlayRevision: number;
  };
  regions: OcrBenchmarkRegion[];
}

export interface OcrCandidateBaseline {
  engine: string;
  eligibleRegions: number;
  availableRegions: number;
  missingRegions: number;
  availabilityRate: number;
  normalizedExact: number;
  exactRateAmongAvailable: number;
  exactRateOverEligible: number;
  availableGoldCharacters: number;
  availableEditDistance: number;
  corpusCerAmongAvailable: number;
  coverageAdjustedEditDistance: number;
  eligibleGoldCharacters: number;
  coverageAdjustedCorpusCer: number;
}

export interface OcrBenchmarkReport {
  schemaVersion: 1;
  benchmarkId: string;
  source: OcrBenchmarkInput["source"];
  denominators: {
    workingGoldRegions: number;
    detectorOutputRegions: number;
    missedDetectionRegions: number;
    ocrEligibleDetectedRegions: number;
    excludedDetectedRegions: number;
    pairedEligibleRegions: number;
  };
  candidates: OcrCandidateBaseline[];
  pair: {
    leftEngine: string;
    rightEngine: string;
    pairedEligibleRegions: number;
    rawAgreement: number;
    normalizedAgreement: number;
    normalizationOnlyAgreement: number;
    agreementGoldExact: number;
    agreementJointWrong: number;
    leftOnlyExact: number;
    rightOnlyExact: number;
    neitherExact: number;
  };
}

interface ReviewCandidate {
  engine?: unknown;
  text?: unknown;
}

interface ReviewRegion {
  id?: unknown;
  pageId?: unknown;
  order?: unknown;
  ocrCandidates?: unknown;
}

interface ReviewPage {
  selectionOrder?: unknown;
  category?: unknown;
  pageId?: unknown;
  regions?: unknown;
}

interface ReviewAnnotation {
  expectedOcr?: unknown;
}

interface ReviewDataset {
  reviewRevision?: unknown;
  pages?: unknown;
  preAnnotations?: {
    regions?: unknown;
    extraRegions?: unknown;
  };
}

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_CATEGORY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DETECTION_STATUSES = new Set<OcrDetectionStatus>(["detected", "missed"]);
const ELIGIBILITIES = new Set<OcrScoringEligibility>(["eligible", "excluded"]);
const EXCLUSION_REASONS = new Set<OcrExclusionReason>(["detection-missed", "non-text-false-positive", "partial-glyph-bbox", "boundary-clipped"]);
const OVERLAY_FIELDS = new Set(["schemaVersion", "overlayRevision", "benchmarkId", "base", "entries"]);
const OVERLAY_BASE_FIELDS = new Set(["artifact", "sha256", "byteLength", "reviewRevision"]);
const OVERLAY_ENTRY_FIELDS = new Set(["regionId", "detectionStatus", "ocrEligibility", "exclusionReason", "expectedOcr"]);
const INPUT_FIELDS = new Set(["schemaVersion", "benchmarkId", "source", "regions"]);
const INPUT_SOURCE_FIELDS = new Set(["baseSha256", "overlaySha256", "reviewRevision", "overlayRevision"]);
const INPUT_REGION_FIELDS = new Set(["id", "pageId", "pageOrder", "category", "detectionStatus", "ocrEligibility", "exclusionReason", "expectedOcr", "candidates"]);
const INPUT_CANDIDATE_FIELDS = new Set(["engine", "text"]);

function invalid(message: string): never {
  throw new LocalizerError("OCR_BENCHMARK_CONTRACT_INVALID", message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) invalid(`${label} must be a non-empty string`);
  return value;
}

function safeIdentifier(value: unknown, label: string): string {
  const text = nonEmptyString(value, label);
  if (!SAFE_IDENTIFIER.test(text)) invalid(`${label} is not a safe identifier`);
  return text;
}

function integer(value: unknown, label: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) invalid(`${label} must be an integer >= ${minimum}`);
  return value;
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new LocalizerError("OCR_BENCHMARK_JSON_INVALID", `${label} is not valid UTF-8 JSON`, { cause: error });
  }
}

function parseOverlay(bytes: Uint8Array): OcrEligibilityOverlay {
  const value = record(parseJson(bytes, "OCR eligibility overlay"), "OCR eligibility overlay");
  for (const key of Object.keys(value)) if (!OVERLAY_FIELDS.has(key)) invalid(`overlay contains unsupported field ${key}`);
  if (value.schemaVersion !== 1) invalid("overlay schemaVersion must be 1");
  const overlayRevision = integer(value.overlayRevision, "overlayRevision", 1);
  const benchmarkId = safeIdentifier(value.benchmarkId, "benchmarkId");
  const base = record(value.base, "overlay base");
  for (const key of Object.keys(base)) if (!OVERLAY_BASE_FIELDS.has(key)) invalid(`overlay base contains unsupported field ${key}`);
  const artifact = nonEmptyString(base.artifact, "base artifact");
  const baseSha256 = nonEmptyString(base.sha256, "base sha256").toLowerCase();
  if (!SHA256.test(baseSha256)) invalid("base sha256 must contain 64 lowercase hexadecimal characters");
  const byteLength = integer(base.byteLength, "base byteLength", 1);
  const reviewRevision = integer(base.reviewRevision, "base reviewRevision", 1);
  if (!Array.isArray(value.entries) || value.entries.length === 0) invalid("overlay entries must be a non-empty array");
  const seen = new Set<string>();
  const entries = value.entries.map((item, index) => {
    const entry = record(item, `overlay entry ${index}`);
    for (const key of Object.keys(entry)) if (!OVERLAY_ENTRY_FIELDS.has(key)) invalid(`overlay entry ${index} contains unsupported field ${key}`);
    const regionId = safeIdentifier(entry.regionId, `overlay entry ${index} regionId`);
    if (seen.has(regionId)) invalid("overlay contains duplicate region ids");
    seen.add(regionId);
    const detectionStatus = entry.detectionStatus as OcrDetectionStatus | undefined;
    const ocrEligibility = entry.ocrEligibility as OcrScoringEligibility | undefined;
    const exclusionReason = entry.exclusionReason as OcrExclusionReason | undefined;
    const expectedOcr = entry.expectedOcr;
    if (detectionStatus !== undefined && !DETECTION_STATUSES.has(detectionStatus)) invalid(`overlay entry ${index} has invalid detection status`);
    if (ocrEligibility !== undefined && !ELIGIBILITIES.has(ocrEligibility)) invalid(`overlay entry ${index} has invalid OCR eligibility`);
    if (exclusionReason !== undefined && !EXCLUSION_REASONS.has(exclusionReason)) invalid(`overlay entry ${index} has invalid exclusion reason`);
    if (expectedOcr !== undefined && (typeof expectedOcr !== "string" || expectedOcr.trim().length === 0)) invalid(`overlay entry ${index} expectedOcr must be non-empty`);
    if (ocrEligibility === "excluded" && exclusionReason === undefined) invalid(`overlay entry ${index} excludes OCR scoring without a reason`);
    if (exclusionReason !== undefined && ocrEligibility !== "excluded") invalid(`overlay entry ${index} has an exclusion reason without excluded eligibility`);
    if (expectedOcr !== undefined && ocrEligibility === "excluded") invalid(`overlay entry ${index} cannot replace gold text while excluding the region`);
    if (detectionStatus === "missed" && (ocrEligibility !== "excluded" || exclusionReason !== "detection-missed")) invalid(`overlay entry ${index} must exclude missed detection from OCR scoring`);
    if (detectionStatus === undefined && ocrEligibility === undefined && expectedOcr === undefined) invalid(`overlay entry ${index} does not change the base`);
    return { regionId, ...(detectionStatus ? { detectionStatus } : {}), ...(ocrEligibility ? { ocrEligibility } : {}), ...(exclusionReason ? { exclusionReason } : {}), ...(typeof expectedOcr === "string" ? { expectedOcr } : {}) };
  });
  return { schemaVersion: 1, overlayRevision, benchmarkId, base: { artifact, sha256: baseSha256, byteLength, reviewRevision }, entries };
}

function parseReviewHtml(bytes: Uint8Array): ReviewDataset {
  const html = Buffer.from(bytes).toString("utf8");
  const match = html.match(/<script id="dataset" type="application\/json">([\s\S]*?)<\/script>/u);
  if (!match) invalid("review HTML does not contain the embedded dataset");
  try {
    return record(JSON.parse(match[1]), "review dataset") as ReviewDataset;
  } catch (error) {
    throw new LocalizerError("OCR_BENCHMARK_REVIEW_INVALID", "review dataset is not valid JSON", { cause: error });
  }
}

function candidates(value: unknown, label: string): OcrBenchmarkCandidate[] {
  if (!Array.isArray(value)) invalid(`${label} OCR candidates must be an array`);
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    const item = record(candidate, `${label} candidate ${index}`) as ReviewCandidate;
    const engine = safeIdentifier(item.engine, `${label} candidate ${index} engine`);
    if (seen.has(engine)) invalid(`${label} has duplicate OCR engines`);
    seen.add(engine);
    if (typeof item.text !== "string" || item.text.length === 0) invalid(`${label} candidate ${index} text must be non-empty`);
    return { engine, text: item.text };
  });
}

function assertRegionContract(region: OcrBenchmarkRegion): void {
  for (const key of Object.keys(region)) if (!INPUT_REGION_FIELDS.has(key)) invalid(`OCR benchmark region contains unsupported field ${key}`);
  if (!SAFE_IDENTIFIER.test(region.id) || !SAFE_IDENTIFIER.test(region.pageId)) invalid("OCR benchmark region identifiers are invalid");
  if (!Number.isInteger(region.pageOrder) || region.pageOrder < 1 || !SAFE_CATEGORY.test(region.category)) invalid("OCR benchmark region page metadata is invalid");
  if (!DETECTION_STATUSES.has(region.detectionStatus) || !ELIGIBILITIES.has(region.ocrEligibility)) invalid("OCR benchmark region state is invalid");
  if (region.exclusionReason !== undefined && !EXCLUSION_REASONS.has(region.exclusionReason)) invalid("OCR benchmark exclusion reason is invalid");
  if (!Array.isArray(region.candidates)) invalid("OCR benchmark candidates must be an array");
  if (region.detectionStatus === "missed") {
    if (region.ocrEligibility !== "excluded" || region.exclusionReason !== "detection-missed") invalid("missed detection must be excluded with detection-missed reason");
    if (region.candidates.length > 0) invalid("missed detection cannot contain OCR candidates");
  }
  if (region.ocrEligibility === "eligible") {
    if (region.detectionStatus !== "detected") invalid("OCR-eligible region must be detected");
    if (region.exclusionReason !== undefined) invalid("OCR-eligible region cannot have an exclusion reason");
    if (typeof region.expectedOcr !== "string" || normalizeOcrText(region.expectedOcr).length === 0) invalid("OCR-eligible region must have non-empty normalized gold text");
  } else {
    if (region.exclusionReason === undefined) invalid("OCR-excluded region must have an exclusion reason");
    if (region.expectedOcr !== undefined) invalid("OCR-excluded region cannot expose gold text to the scorer");
    if (region.candidates.length > 0) invalid("OCR-excluded region cannot expose candidate text to the scorer");
  }
  if (region.detectionStatus === "detected" && region.exclusionReason === "detection-missed") invalid("detected region cannot use detection-missed exclusion");
}

export function deriveOcrBenchmarkInput(baseBytes: Uint8Array, overlayBytes: Uint8Array): OcrBenchmarkInput {
  const overlay = parseOverlay(overlayBytes);
  const baseSha256 = sha256Bytes(baseBytes);
  if (baseSha256 !== overlay.base.sha256 || baseBytes.byteLength !== overlay.base.byteLength) invalid("overlay base hash or byte length does not match the review artifact");
  const review = parseReviewHtml(baseBytes);
  if (review.reviewRevision !== overlay.base.reviewRevision) invalid("overlay reviewRevision does not match the review artifact");
  if (!Array.isArray(review.pages)) invalid("review pages must be an array");
  const preAnnotations = record(review.preAnnotations, "review preAnnotations");
  const annotationRecord = record(preAnnotations.regions, "review region annotations");
  const extraRecord = record(preAnnotations.extraRegions, "review extra regions");
  const annotations = annotationRecord as Record<string, ReviewAnnotation>;
  const overlayEntries = new Map(overlay.entries.map((entry) => [entry.regionId, entry]));
  const applied = new Set<string>();
  const regions: OcrBenchmarkRegion[] = [];

  const addRegion = (page: ReviewPage, source: ReviewRegion, detectionStatus: OcrDetectionStatus): void => {
    const id = safeIdentifier(source.id, "review region id");
    const pageId = safeIdentifier(page.pageId, "review page id");
    if (source.pageId !== pageId) invalid("review region pageId does not match its page");
    const pageOrder = integer(page.selectionOrder, "review page order", 1);
    const category = nonEmptyString(page.category, "review page category");
    if (!SAFE_CATEGORY.test(category)) invalid("review page category is invalid");
    const annotation = annotations[id];
    if (!annotation) invalid("review region is missing its working-gold annotation");
    if (typeof annotation.expectedOcr !== "string" || annotation.expectedOcr.trim().length === 0) invalid("review working-gold OCR is missing");
    const patch = overlayEntries.get(id);
    if (patch) applied.add(id);
    const finalDetection = patch?.detectionStatus ?? detectionStatus;
    const finalEligibility = patch?.ocrEligibility ?? (finalDetection === "detected" ? "eligible" : "excluded");
    const exclusionReason = patch?.exclusionReason ?? (finalDetection === "missed" ? "detection-missed" : undefined);
    const expectedOcr = patch?.expectedOcr ?? annotation.expectedOcr;
    const region: OcrBenchmarkRegion = {
      id,
      pageId,
      pageOrder,
      category,
      detectionStatus: finalDetection,
      ocrEligibility: finalEligibility,
      ...(exclusionReason ? { exclusionReason } : {}),
      ...(finalEligibility === "eligible" ? { expectedOcr } : {}),
      candidates: finalDetection === "detected" && finalEligibility === "eligible" ? candidates(source.ocrCandidates ?? [], "review region") : [],
    };
    assertRegionContract(region);
    regions.push(region);
  };

  for (const pageValue of review.pages) {
    const page = pageValue as ReviewPage;
    if (!Array.isArray(page.regions)) invalid("review page regions must be an array");
    for (const region of page.regions) addRegion(page, region as ReviewRegion, "detected");
    const pageId = safeIdentifier(page.pageId, "review page id");
    const extras = extraRecord[pageId];
    if (extras !== undefined && !Array.isArray(extras)) invalid("review extra regions entry must be an array");
    for (const region of (extras as ReviewRegion[] | undefined) ?? []) addRegion(page, region, "missed");
  }
  if (regions.length !== Object.keys(annotations).length) invalid("review annotation and region counts do not match");
  if (applied.size !== overlay.entries.length) invalid("overlay contains a region id that is absent from the base review");
  const ids = new Set<string>();
  for (const region of regions) {
    if (ids.has(region.id)) invalid("derived input contains duplicate region ids");
    ids.add(region.id);
  }
  regions.sort((left, right) => left.pageOrder - right.pageOrder || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return {
    schemaVersion: 1,
    benchmarkId: overlay.benchmarkId,
    source: {
      baseSha256,
      overlaySha256: sha256Bytes(overlayBytes),
      reviewRevision: overlay.base.reviewRevision,
      overlayRevision: overlay.overlayRevision,
    },
    regions,
  };
}

export function normalizeOcrText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/gu, "");
}

function editDistance(leftText: string, rightText: string): number {
  const left = [...normalizeOcrText(leftText)];
  const right = [...normalizeOcrText(rightText)];
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[right.length];
}

function candidateFor(region: OcrBenchmarkRegion, engine: string): OcrBenchmarkCandidate | undefined {
  return region.candidates.find((candidate) => candidate.engine === engine);
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function evaluateOcrBaseline(input: OcrBenchmarkInput, pair: readonly [string, string]): OcrBenchmarkReport {
  for (const key of Object.keys(input)) if (!INPUT_FIELDS.has(key)) invalid(`OCR benchmark input contains unsupported field ${key}`);
  if (input.schemaVersion !== 1 || !SAFE_IDENTIFIER.test(input.benchmarkId) || !Array.isArray(input.regions)) invalid("OCR benchmark input is invalid");
  const source = record(input.source, "OCR benchmark source");
  for (const key of Object.keys(source)) if (!INPUT_SOURCE_FIELDS.has(key)) invalid(`OCR benchmark source contains unsupported field ${key}`);
  if (typeof source.baseSha256 !== "string" || !SHA256.test(source.baseSha256)
    || typeof source.overlaySha256 !== "string" || !SHA256.test(source.overlaySha256)
    || typeof source.reviewRevision !== "number" || !Number.isInteger(source.reviewRevision) || source.reviewRevision < 1
    || typeof source.overlayRevision !== "number" || !Number.isInteger(source.overlayRevision) || source.overlayRevision < 1) invalid("OCR benchmark source provenance is invalid");
  const [leftEngine, rightEngine] = pair;
  if (leftEngine === rightEngine || !SAFE_IDENTIFIER.test(leftEngine) || !SAFE_IDENTIFIER.test(rightEngine)) invalid("OCR benchmark pair must contain two distinct safe engine ids");
  const ids = new Set<string>();
  for (const region of input.regions) {
    if (ids.has(region.id)) invalid("OCR benchmark input contains duplicate region ids");
    ids.add(region.id);
    assertRegionContract(region);
    const engines = new Set<string>();
    for (const candidate of region.candidates) {
      for (const key of Object.keys(candidate)) if (!INPUT_CANDIDATE_FIELDS.has(key)) invalid(`OCR benchmark candidate contains unsupported field ${key}`);
      if (!SAFE_IDENTIFIER.test(candidate.engine) || typeof candidate.text !== "string" || candidate.text.length === 0) invalid("OCR benchmark candidate is invalid");
      if (engines.has(candidate.engine)) invalid("OCR benchmark region contains duplicate engines");
      engines.add(candidate.engine);
    }
  }
  const detected = input.regions.filter((region) => region.detectionStatus === "detected");
  const eligible = detected.filter((region) => region.ocrEligibility === "eligible");
  const eligibleGoldCharacters = eligible.reduce((sum, region) => sum + [...normalizeOcrText(region.expectedOcr!)].length, 0);
  const allEngines = [...new Set(eligible.flatMap((region) => region.candidates.map((candidate) => candidate.engine)))].sort();
  if (!allEngines.includes(leftEngine) || !allEngines.includes(rightEngine)) invalid("OCR benchmark pair engine is absent from eligible candidates");
  const candidateReports = allEngines.map((engine): OcrCandidateBaseline => {
    let normalizedExact = 0;
    let availableEditDistance = 0;
    let availableGoldCharacters = 0;
    let availableRegions = 0;
    for (const region of eligible) {
      const candidate = candidateFor(region, engine);
      if (!candidate) continue;
      availableRegions += 1;
      const expected = region.expectedOcr!;
      const distance = editDistance(expected, candidate.text);
      const goldLength = [...normalizeOcrText(expected)].length;
      availableEditDistance += distance;
      availableGoldCharacters += goldLength;
      if (distance === 0) normalizedExact += 1;
    }
    const missingRegions = eligible.length - availableRegions;
    const missingGoldCharacters = eligibleGoldCharacters - availableGoldCharacters;
    const coverageAdjustedEditDistance = availableEditDistance + missingGoldCharacters;
    return {
      engine,
      eligibleRegions: eligible.length,
      availableRegions,
      missingRegions,
      availabilityRate: rate(availableRegions, eligible.length),
      normalizedExact,
      exactRateAmongAvailable: rate(normalizedExact, availableRegions),
      exactRateOverEligible: rate(normalizedExact, eligible.length),
      availableGoldCharacters,
      availableEditDistance,
      corpusCerAmongAvailable: rate(availableEditDistance, availableGoldCharacters),
      coverageAdjustedEditDistance,
      eligibleGoldCharacters,
      coverageAdjustedCorpusCer: rate(coverageAdjustedEditDistance, eligibleGoldCharacters),
    };
  });
  const paired = eligible.filter((region) => candidateFor(region, leftEngine) && candidateFor(region, rightEngine));
  let rawAgreement = 0;
  let normalizedAgreement = 0;
  let normalizationOnlyAgreement = 0;
  let agreementGoldExact = 0;
  let agreementJointWrong = 0;
  let leftOnlyExact = 0;
  let rightOnlyExact = 0;
  let neitherExact = 0;
  for (const region of paired) {
    const expected = region.expectedOcr!;
    const left = candidateFor(region, leftEngine)!.text;
    const right = candidateFor(region, rightEngine)!.text;
    const rawSame = left === right;
    const normalizedSame = normalizeOcrText(left) === normalizeOcrText(right);
    const leftExact = editDistance(expected, left) === 0;
    const rightExact = editDistance(expected, right) === 0;
    if (rawSame) rawAgreement += 1;
    if (normalizedSame) {
      normalizedAgreement += 1;
      if (!rawSame) normalizationOnlyAgreement += 1;
      if (leftExact) agreementGoldExact += 1;
      else agreementJointWrong += 1;
    } else if (leftExact) leftOnlyExact += 1;
    else if (rightExact) rightOnlyExact += 1;
    else neitherExact += 1;
  }
  return {
    schemaVersion: 1,
    benchmarkId: input.benchmarkId,
    source: input.source,
    denominators: {
      workingGoldRegions: input.regions.length,
      detectorOutputRegions: detected.length,
      missedDetectionRegions: input.regions.length - detected.length,
      ocrEligibleDetectedRegions: eligible.length,
      excludedDetectedRegions: detected.length - eligible.length,
      pairedEligibleRegions: paired.length,
    },
    candidates: candidateReports,
    pair: {
      leftEngine,
      rightEngine,
      pairedEligibleRegions: paired.length,
      rawAgreement,
      normalizedAgreement,
      normalizationOnlyAgreement,
      agreementGoldExact,
      agreementJointWrong,
      leftOnlyExact,
      rightOnlyExact,
      neitherExact,
    },
  };
}
