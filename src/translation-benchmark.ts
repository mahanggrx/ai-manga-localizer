import { LocalizerError } from "./errors.ts";
import { sha256Bytes } from "./file-utils.ts";
import { deriveOcrBenchmarkInput, normalizeOcrText, type OcrExclusionReason } from "./ocr-benchmark.ts";

export type TranslationEvaluationMode = "fixed-working-gold" | "historical-e2e";
export type TranslationProtocolComparisonMode = "identical-controlled-v1" | "explicit-protocol-divergent-pipeline-v1";
export type TranslationEligibility = "eligible" | "excluded";
export type TranslationLengthStratum = "short" | "medium" | "long";
export type TranslationReviewVerdict = "pass" | "fail" | "not-reviewed";
export type RefusalDilutionVerdict = "pass" | "refusal" | "dilution" | "not-reviewed";

export interface ArtifactPin {
  sha256: string;
  byteLength: number;
}

export interface TranslationModelIdentity {
  id: string;
  family: string;
  version: string;
  quantization: string;
  sha256: string;
  license: string;
}

export interface TranslationProtocolIdentity {
  promptMode: string;
  contextMode: string;
  glossaryMode: string;
  formattingContract: "plain-text-v1";
  nonRefusalInstruction: boolean;
}

export interface TranslationBenchmarkRegion {
  id: string;
  pageId: string;
  pageOrder: number;
  regionOrder: number;
  category: string;
  lengthStratum: TranslationLengthStratum | "not-applicable";
  translationEligibility: TranslationEligibility;
  exclusionReason?: OcrExclusionReason;
  workingGoldOcr?: string;
  nonRefusalRequired: boolean;
}

export interface TranslationBenchmarkInput {
  schemaVersion: 1;
  benchmarkId: string;
  source: {
    review: ArtifactPin & { revision: number };
    ocrOverlay: ArtifactPin & { revision: number };
  };
  regions: TranslationBenchmarkRegion[];
}

export interface TranslationCandidateOutput {
  regionId: string;
  sourceText: string;
  translatedText: string;
}

export interface TranslationCandidateRun {
  schemaVersion: 1;
  runId: string;
  benchmarkId: string;
  candidateId: string;
  evaluationMode: TranslationEvaluationMode;
  input: ArtifactPin;
  model: TranslationModelIdentity;
  protocol: TranslationProtocolIdentity;
  outputs: TranslationCandidateOutput[];
}

export interface TranslationReviewOverlayEntry {
  regionId: string;
  referenceTranslation: string;
  semanticUsable: TranslationReviewVerdict;
  terminologyCorrect: TranslationReviewVerdict;
  refusalDilution: RefusalDilutionVerdict;
  contextCharacterConsistent: TranslationReviewVerdict;
  layoutUsable: TranslationReviewVerdict;
}

export interface TranslationReviewOverlay {
  schemaVersion: 1;
  reviewRevision: number;
  benchmarkId: string;
  candidateId: string;
  source: {
    input: ArtifactPin;
    candidateRun: ArtifactPin;
  };
  entries: TranslationReviewOverlayEntry[];
}

export interface TranslationCandidateDeclaration {
  candidateId: string;
  evaluationMode: TranslationEvaluationMode;
  model: TranslationModelIdentity;
  protocol: TranslationProtocolIdentity;
}

export interface TranslationBenchmarkSpec {
  schemaVersion: 1;
  specRevision: 1;
  specId: string;
  benchmarkId: string;
  input: ArtifactPin;
  challenge: {
    selectorRevision: 1;
    seed: string;
    sourceCandidateId: string;
    sourceCandidateRun: ArtifactPin;
    sourceReviewOverlay: ArtifactPin;
    hardCaseLimit: number;
    successControlPerStratum: number;
    hardCaseDefinition: "historical-input-agreement-and-semantic-or-terminology-fail";
    successControlDefinition: "historical-input-agreement-and-semantic-and-terminology-pass";
    selectionSha256: string;
    selectedRegionIds: string[];
    hardCaseCount: number;
    successControlCount: number;
    nonRefusalCount: number;
    pageCount: number;
    categoryCounts: Record<string, number>;
    lengthCounts: Record<TranslationLengthStratum, number>;
  };
  candidates: TranslationCandidateDeclaration[];
  metrics: {
    primary: [
      "semantic-usable",
      "terminology-correct",
      "refusal-dilution",
      "formatting-validity",
      "context-character-consistency",
      "deterministic-structural-qa",
      "candidate-coverage",
    ];
    diagnostics: ["reference-normalized-exact", "reference-edit-distance"];
    referenceDistancePolicy: "diagnostic-only-never-a-semantic-gate";
  };
  structuralQa: {
    maxLineCount: number;
    maxLengthRatio: number;
    repetitionWindow: number;
  };
  comparison: {
    method: "paired-page-grouped-bootstrap-percentile";
    bootstrapSeed: number;
    replicates: number;
    confidenceLevel: 0.95;
    protocolComparisonMode?: TranslationProtocolComparisonMode;
  };
}

export interface BinaryMetricSummary {
  reviewed: number;
  passed: number;
  failed: number;
  passRate: number;
}

export interface RefusalDilutionSummary {
  reviewed: number;
  passed: number;
  refusal: number;
  dilution: number;
  passRate: number;
}

export interface StructuralQaSummary {
  evaluated: number;
  passed: number;
  failed: number;
  passRate: number;
  flags: Record<StructuralQaCode, number>;
}

export interface TranslationCandidateReport {
  candidateId: string;
  evidenceClass: "controlled-fixed-working-gold" | "protocol-divergent-fixed-working-gold" | "historical-attribution-only";
  evaluationMode: TranslationEvaluationMode;
  model: TranslationModelIdentity;
  protocol: TranslationProtocolIdentity;
  attribution: {
    workingGoldRegions: number;
    translationEligibleRegions: number;
    nonTranslationResponsibilityRegions: number;
    observedOutputs: number;
    eligibleOutputs: number;
    excludedOutputs: number;
    missingEligibleOutputs: number;
    ocrInputRawExact: number;
    ocrInputNormalizationOnlyExact: number;
    ocrInputDifferent: number;
    translationQualityAnalyzable: number;
    historicalE2EOnly: number;
  };
  historicalE2E?: {
    population: number;
    semanticUsable: BinaryMetricSummary;
    terminologyCorrect: BinaryMetricSummary;
    layoutUsable: BinaryMetricSummary;
    ocrInputDifferentSubset: {
      population: number;
      semanticUsable: BinaryMetricSummary;
      terminologyCorrect: BinaryMetricSummary;
      layoutUsable: BinaryMetricSummary;
    };
  };
  challenge: {
    selectedRegions: number;
    availableOutputs: number;
    missingOutputs: number;
    coverageRate: number;
    translationQualityAnalyzable: number;
    historicalE2EOnly: number;
    semanticUsable: BinaryMetricSummary;
    terminologyCorrect: BinaryMetricSummary;
    refusalDilution: RefusalDilutionSummary;
    formattingValidity: BinaryMetricSummary;
    contextCharacterConsistency: BinaryMetricSummary;
    layoutUsable: BinaryMetricSummary;
    structuralQa: StructuralQaSummary;
    referenceDiagnostics: {
      evaluated: number;
      normalizedExact: number;
      normalizedExactRate: number;
      totalEditDistance: number;
      referenceCharacters: number;
      corpusEditDistanceRatio: number;
    };
  };
}

export type ComparisonMetric = "semantic-usable" | "terminology-correct" | "refusal-dilution-pass" | "formatting-valid" | "context-character-consistent" | "structural-qa-pass";

export interface TranslationPairedComparison {
  candidateA: string;
  candidateB: string;
  evidenceClass: "controlled-paired" | "protocol-divergent-pipeline-comparison" | "historical-input-agreement-subset-diagnostic";
  metric: ComparisonMetric;
  pairedRegions: number;
  pairedPages: number;
  candidateARate: number;
  candidateBRate: number;
  differenceBMinusA: number;
  confidenceInterval: {
    method: "paired-page-grouped-bootstrap-percentile";
    confidenceLevel: 0.95;
    replicates: number;
    lower: number;
    upper: number;
  };
}

export interface TranslationBenchmarkReport {
  schemaVersion: 1;
  benchmarkId: string;
  specId: string;
  source: {
    input: ArtifactPin;
    spec: ArtifactPin;
    candidateRuns: Array<{ candidateId: string; run: ArtifactPin; reviewOverlay: ArtifactPin }>;
  };
  population: {
    workingGoldRegions: number;
    translationEligibleRegions: number;
    nonTranslationResponsibilityRegions: number;
    challengeRegions: number;
    challengePages: number;
  };
  claimBoundary: {
    fixedWorkingGoldRequiredForControlledScore: true;
    historicalRunsAreNotFixedOcrModelScores: true;
    ocrDifferentRegionsAreHistoricalE2EOnly: true;
    nonTranslationResponsibilityRegionsExcluded: true;
    referenceDistanceIsDiagnosticOnly: true;
    controlledPairedRequiresIdenticalProtocol: true;
    protocolDivergentPipelineComparisonsAreNotControlledScores: true;
    modelOnlyClaimsAreNotSupportedByProtocolDivergentComparison: true;
  };
  plannedCandidateCount: number;
  evaluatedCandidateCount: number;
  unevaluatedCandidateIds: string[];
  candidates: TranslationCandidateReport[];
  pairedComparisons: TranslationPairedComparison[];
}

interface ReviewCandidateMetadata {
  id?: unknown;
  model?: unknown;
}

interface ReviewRegion {
  id?: unknown;
  pageId?: unknown;
  order?: unknown;
  sourceText?: unknown;
  translatedText?: unknown;
}

interface ReviewPage {
  pageId?: unknown;
  selectionOrder?: unknown;
  category?: unknown;
  regions?: unknown;
}

interface ReviewAnnotation {
  expectedOcr?: unknown;
  expectedTranslation?: unknown;
  semanticUsable?: unknown;
  termsCorrect?: unknown;
  layoutOk?: unknown;
  nonRefusalRequired?: unknown;
}

interface ReviewDataset {
  reviewRevision?: unknown;
  benchmarkId?: unknown;
  candidate?: ReviewCandidateMetadata;
  pages?: unknown;
  preAnnotations?: {
    regions?: unknown;
    extraRegions?: unknown;
  };
}

interface ChallengeSelection {
  selected: TranslationBenchmarkRegion[];
  hardCaseCount: number;
  successControlCount: number;
}

type StructuralQaCode = "empty-output" | "surrounding-whitespace" | "disallowed-control" | "unpaired-surrogate" | "markdown-fence" | "too-many-lines" | "japanese-kana-remains" | "source-echo" | "excessive-length-ratio" | "excessive-repetition";

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_CATEGORY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REVIEW_VERDICTS = new Set<TranslationReviewVerdict>(["pass", "fail", "not-reviewed"]);
const REFUSAL_VERDICTS = new Set<RefusalDilutionVerdict>(["pass", "refusal", "dilution", "not-reviewed"]);
const ELIGIBILITIES = new Set<TranslationEligibility>(["eligible", "excluded"]);
const EVALUATION_MODES = new Set<TranslationEvaluationMode>(["fixed-working-gold", "historical-e2e"]);
const PROTOCOL_COMPARISON_MODES = new Set<TranslationProtocolComparisonMode>(["identical-controlled-v1", "explicit-protocol-divergent-pipeline-v1"]);
const EXCLUSION_REASONS = new Set<OcrExclusionReason>(["detection-missed", "non-text-false-positive", "partial-glyph-bbox", "boundary-clipped"]);
const LENGTH_STRATA = new Set<TranslationLengthStratum>(["short", "medium", "long"]);
const PRIMARY_METRICS = ["semantic-usable", "terminology-correct", "refusal-dilution", "formatting-validity", "context-character-consistency", "deterministic-structural-qa", "candidate-coverage"] as const;
const DIAGNOSTIC_METRICS = ["reference-normalized-exact", "reference-edit-distance"] as const;
const STRUCTURAL_CODES: StructuralQaCode[] = ["empty-output", "surrounding-whitespace", "disallowed-control", "unpaired-surrogate", "markdown-fence", "too-many-lines", "japanese-kana-remains", "source-echo", "excessive-length-ratio", "excessive-repetition"];

function invalid(message: string): never {
  throw new LocalizerError("TRANSLATION_BENCHMARK_CONTRACT_INVALID", message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(label + " must be an object");
  return value as Record<string, unknown>;
}

function allowedFields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) if (!set.has(key)) invalid(label + " contains unsupported field " + key);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) invalid(label + " must be a non-empty string");
  return value;
}

function safeIdentifier(value: unknown, label: string): string {
  const text = nonEmptyString(value, label);
  if (!SAFE_IDENTIFIER.test(text)) invalid(label + " is not a safe identifier");
  return text;
}

function integer(value: unknown, label: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) invalid(label + " must be an integer >= " + minimum);
  return value;
}

function finiteNumber(value: unknown, label: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) invalid(label + " must be a finite number >= " + minimum);
  return value;
}

function sha256(value: unknown, label: string): string {
  const text = nonEmptyString(value, label).toLowerCase();
  if (!SHA256.test(text)) invalid(label + " must be a lowercase SHA-256");
  return text;
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new LocalizerError("TRANSLATION_BENCHMARK_JSON_INVALID", label + " is not valid UTF-8 JSON", { cause: error });
  }
}

function artifactPin(bytes: Uint8Array): ArtifactPin {
  return { sha256: sha256Bytes(bytes), byteLength: bytes.byteLength };
}

function assertPin(value: unknown, label: string): ArtifactPin {
  const item = record(value, label);
  allowedFields(item, ["sha256", "byteLength"], label);
  return { sha256: sha256(item.sha256, label + " sha256"), byteLength: integer(item.byteLength, label + " byteLength", 1) };
}

function assertPinned(bytes: Uint8Array, pin: ArtifactPin, label: string): void {
  if (pin.sha256 !== sha256Bytes(bytes) || pin.byteLength !== bytes.byteLength) invalid(label + " does not match its fixed hash and byte length");
}

export function serializeTranslationArtifact(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");
}

function parseReviewHtml(bytes: Uint8Array): ReviewDataset {
  const html = Buffer.from(bytes).toString("utf8");
  const match = html.match(/<script id="dataset" type="application\/json">([\s\S]*?)<\/script>/u);
  if (!match) invalid("review HTML does not contain the embedded dataset");
  try {
    return record(JSON.parse(match[1]), "review dataset") as ReviewDataset;
  } catch (error) {
    throw new LocalizerError("TRANSLATION_BENCHMARK_REVIEW_INVALID", "review dataset is not valid JSON", { cause: error });
  }
}

function lengthStratum(text: string): TranslationLengthStratum {
  const length = [...normalizeOcrText(text)].length;
  return length <= 8 ? "short" : length <= 20 ? "medium" : "long";
}

function boolVerdict(value: unknown, label: string): TranslationReviewVerdict {
  if (typeof value !== "boolean") invalid(label + " must be a boolean in the working review");
  return value ? "pass" : "fail";
}

export function deriveTranslationBenchmarkInput(reviewBytes: Uint8Array, ocrOverlayBytes: Uint8Array, benchmarkId: string): TranslationBenchmarkInput {
  safeIdentifier(benchmarkId, "translation benchmarkId");
  const review = parseReviewHtml(reviewBytes);
  const ocr = deriveOcrBenchmarkInput(reviewBytes, ocrOverlayBytes);
  const reviewRevision = integer(review.reviewRevision, "review revision", 1);
  if (reviewRevision !== ocr.source.reviewRevision) invalid("review revision differs from the OCR overlay provenance");
  const preAnnotations = record(review.preAnnotations, "review preAnnotations");
  const annotations = record(preAnnotations.regions, "review region annotations") as Record<string, ReviewAnnotation>;
  const regions = ocr.regions.map((region): TranslationBenchmarkRegion => {
    const annotation = annotations[region.id];
    if (!annotation) invalid("working review is missing a translation annotation");
    nonEmptyString(annotation.expectedTranslation, "working-gold reference translation");
    if (typeof annotation.nonRefusalRequired !== "boolean") invalid("working review is missing the non-refusal requirement");
    const base = {
      id: region.id,
      pageId: region.pageId,
      pageOrder: region.pageOrder,
      regionOrder: integer(findRegionOrder(review, region.id), "review region order", 0),
      category: region.category,
      lengthStratum: region.ocrEligibility === "eligible" ? lengthStratum(region.expectedOcr!) : "not-applicable" as const,
      translationEligibility: region.ocrEligibility === "eligible" ? "eligible" as const : "excluded" as const,
      nonRefusalRequired: annotation.nonRefusalRequired,
    };
    if (region.ocrEligibility === "excluded") {
      if (!region.exclusionReason) invalid("OCR-excluded region has no translation exclusion reason");
      return { ...base, exclusionReason: region.exclusionReason };
    }
    return { ...base, workingGoldOcr: region.expectedOcr! };
  });
  return {
    schemaVersion: 1,
    benchmarkId,
    source: {
      review: { ...artifactPin(reviewBytes), revision: reviewRevision },
      ocrOverlay: { ...artifactPin(ocrOverlayBytes), revision: ocr.source.overlayRevision },
    },
    regions,
  };
}

function findRegionOrder(review: ReviewDataset, regionId: string): unknown {
  if (!Array.isArray(review.pages)) invalid("review pages must be an array");
  for (const pageValue of review.pages) {
    const page = pageValue as ReviewPage;
    if (!Array.isArray(page.regions)) invalid("review page regions must be an array");
    const found = (page.regions as ReviewRegion[]).find((region) => region.id === regionId);
    if (found) return found.order;
  }
  const extras = record(record(review.preAnnotations, "review preAnnotations").extraRegions, "review extra regions");
  for (const value of Object.values(extras)) {
    if (!Array.isArray(value)) invalid("review extra-region group must be an array");
    const found = (value as ReviewRegion[]).find((region) => region.id === regionId);
    if (found) return found.order;
  }
  invalid("review region order is missing");
}

function parseModel(value: unknown, label: string): TranslationModelIdentity {
  const item = record(value, label);
  allowedFields(item, ["id", "family", "version", "quantization", "sha256", "license"], label);
  return {
    id: safeIdentifier(item.id, label + " id"),
    family: nonEmptyString(item.family, label + " family"),
    version: nonEmptyString(item.version, label + " version"),
    quantization: nonEmptyString(item.quantization, label + " quantization"),
    sha256: sha256(item.sha256, label + " sha256"),
    license: nonEmptyString(item.license, label + " license"),
  };
}

function parseReviewModel(value: unknown): TranslationModelIdentity {
  const item = record(value, "review candidate model");
  allowedFields(item, ["id", "family", "version", "quantization", "sha256", "license", "role"], "review candidate model");
  if (item.role !== undefined && item.role !== "translation") invalid("review candidate model role is not translation");
  return parseModel({
    id: item.id,
    family: item.family,
    version: item.version,
    quantization: item.quantization,
    sha256: item.sha256,
    license: item.license,
  }, "review candidate model identity");
}

function parseProtocol(value: unknown, label: string): TranslationProtocolIdentity {
  const item = record(value, label);
  allowedFields(item, ["promptMode", "contextMode", "glossaryMode", "formattingContract", "nonRefusalInstruction"], label);
  if (item.formattingContract !== "plain-text-v1" || typeof item.nonRefusalInstruction !== "boolean") invalid(label + " is invalid");
  return {
    promptMode: safeIdentifier(item.promptMode, label + " promptMode"),
    contextMode: safeIdentifier(item.contextMode, label + " contextMode"),
    glossaryMode: safeIdentifier(item.glossaryMode, label + " glossaryMode"),
    formattingContract: "plain-text-v1",
    nonRefusalInstruction: item.nonRefusalInstruction,
  };
}

export function deriveHistoricalTranslationCandidateRun(
  reviewBytes: Uint8Array,
  inputBytes: Uint8Array,
  protocol: TranslationProtocolIdentity,
  runId = "historical-working-review-v1",
): TranslationCandidateRun {
  const input = parseTranslationBenchmarkInput(inputBytes);
  assertPinned(reviewBytes, input.source.review, "historical candidate review source");
  const review = parseReviewHtml(reviewBytes);
  const candidate = record(review.candidate, "review candidate");
  const candidateId = safeIdentifier(candidate.id, "review candidate id");
  const model = parseReviewModel(candidate.model);
  const outputs: TranslationCandidateOutput[] = [];
  if (!Array.isArray(review.pages)) invalid("review pages must be an array");
  for (const pageValue of review.pages) {
    const page = pageValue as ReviewPage;
    if (!Array.isArray(page.regions)) invalid("review page regions must be an array");
    for (const value of page.regions) {
      const region = value as ReviewRegion;
      if (typeof region.sourceText !== "string" || typeof region.translatedText !== "string") continue;
      outputs.push({
        regionId: safeIdentifier(region.id, "historical output region id"),
        sourceText: region.sourceText,
        translatedText: region.translatedText,
      });
    }
  }
  outputs.sort((left, right) => regionIndex(input, left.regionId) - regionIndex(input, right.regionId));
  return {
    schemaVersion: 1,
    runId: safeIdentifier(runId, "historical runId"),
    benchmarkId: input.benchmarkId,
    candidateId,
    evaluationMode: "historical-e2e",
    input: artifactPin(inputBytes),
    model,
    protocol: parseProtocol(protocol, "historical protocol"),
    outputs,
  };
}

function regionIndex(input: TranslationBenchmarkInput, regionId: string): number {
  const index = input.regions.findIndex((region) => region.id === regionId);
  if (index < 0) invalid("candidate output contains a region outside the benchmark input");
  return index;
}

export function deriveHistoricalTranslationReviewOverlay(
  reviewBytes: Uint8Array,
  inputBytes: Uint8Array,
  candidateRunBytes: Uint8Array,
  reviewRevision = 1,
): TranslationReviewOverlay {
  const input = parseTranslationBenchmarkInput(inputBytes);
  assertPinned(reviewBytes, input.source.review, "historical review overlay source review");
  const run = parseTranslationCandidateRun(candidateRunBytes, input);
  assertPinned(inputBytes, run.input, "historical review overlay candidate input");
  if (run.evaluationMode !== "historical-e2e") invalid("historical review overlay requires a historical candidate run");
  const review = parseReviewHtml(reviewBytes);
  const annotations = record(record(review.preAnnotations, "review preAnnotations").regions, "review region annotations") as Record<string, ReviewAnnotation>;
  const entries = input.regions.map((region): TranslationReviewOverlayEntry => {
    const annotation = annotations[region.id];
    if (!annotation) invalid("working review annotation is missing from the historical overlay");
    return {
      regionId: region.id,
      referenceTranslation: nonEmptyString(annotation.expectedTranslation, "working-gold reference translation"),
      semanticUsable: boolVerdict(annotation.semanticUsable, "semanticUsable"),
      terminologyCorrect: boolVerdict(annotation.termsCorrect, "termsCorrect"),
      refusalDilution: "not-reviewed",
      contextCharacterConsistent: "not-reviewed",
      layoutUsable: boolVerdict(annotation.layoutOk, "layoutOk"),
    };
  });
  return {
    schemaVersion: 1,
    reviewRevision: integer(reviewRevision, "translation review revision", 1),
    benchmarkId: input.benchmarkId,
    candidateId: run.candidateId,
    source: { input: artifactPin(inputBytes), candidateRun: artifactPin(candidateRunBytes) },
    entries,
  };
}

function deterministicKey(seed: string, bucket: string, region: TranslationBenchmarkRegion): string {
  return sha256Bytes(Buffer.from(seed + "\u0000" + bucket + "\u0000" + region.pageId + "\u0000" + region.id, "utf8"));
}

function inputAgreement(region: TranslationBenchmarkRegion, output: TranslationCandidateOutput): "raw" | "normalized-only" | "different" {
  if (region.translationEligibility !== "eligible" || region.workingGoldOcr === undefined) invalid("input agreement requires a translation-eligible region");
  if (output.sourceText === region.workingGoldOcr) return "raw";
  return normalizeOcrText(output.sourceText) === normalizeOcrText(region.workingGoldOcr) ? "normalized-only" : "different";
}

function reviewPass(entry: TranslationReviewOverlayEntry, field: "semanticUsable" | "terminologyCorrect"): boolean {
  return entry[field] === "pass";
}

function chooseStratified(pool: TranslationBenchmarkRegion[], limit: number, perStratum: number, seed: string, bucket: string): TranslationBenchmarkRegion[] {
  const selected: TranslationBenchmarkRegion[] = [];
  const selectedIds = new Set<string>();
  const groups = new Map<string, TranslationBenchmarkRegion[]>();
  for (const region of pool) {
    const key = region.category + "|" + region.lengthStratum;
    const group = groups.get(key) ?? [];
    group.push(region);
    groups.set(key, group);
  }
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)!.sort((left, right) => deterministicKey(seed, bucket + "|" + key, left).localeCompare(deterministicKey(seed, bucket + "|" + key, right)));
    for (const region of group.slice(0, perStratum)) {
      if (selected.length >= limit) break;
      selected.push(region);
      selectedIds.add(region.id);
    }
  }
  const pageCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();
  const lengthCounts = new Map<string, number>();
  for (const region of selected) {
    pageCounts.set(region.pageId, (pageCounts.get(region.pageId) ?? 0) + 1);
    categoryCounts.set(region.category, (categoryCounts.get(region.category) ?? 0) + 1);
    lengthCounts.set(region.lengthStratum, (lengthCounts.get(region.lengthStratum) ?? 0) + 1);
  }
  while (selected.length < limit) {
    const remaining = pool.filter((region) => !selectedIds.has(region.id));
    if (remaining.length === 0) break;
    remaining.sort((left, right) => {
      const page = (pageCounts.get(left.pageId) ?? 0) - (pageCounts.get(right.pageId) ?? 0);
      if (page !== 0) return page;
      const category = (categoryCounts.get(left.category) ?? 0) - (categoryCounts.get(right.category) ?? 0);
      if (category !== 0) return category;
      const length = (lengthCounts.get(left.lengthStratum) ?? 0) - (lengthCounts.get(right.lengthStratum) ?? 0);
      if (length !== 0) return length;
      return deterministicKey(seed, bucket + "|fill", left).localeCompare(deterministicKey(seed, bucket + "|fill", right));
    });
    const next = remaining[0];
    selected.push(next);
    selectedIds.add(next.id);
    pageCounts.set(next.pageId, (pageCounts.get(next.pageId) ?? 0) + 1);
    categoryCounts.set(next.category, (categoryCounts.get(next.category) ?? 0) + 1);
    lengthCounts.set(next.lengthStratum, (lengthCounts.get(next.lengthStratum) ?? 0) + 1);
  }
  return selected;
}

function selectChallenge(
  input: TranslationBenchmarkInput,
  sourceRun: TranslationCandidateRun,
  sourceOverlay: TranslationReviewOverlay,
  seed: string,
  hardCaseLimit: number,
  successControlPerStratum: number,
): ChallengeSelection {
  if (sourceRun.evaluationMode !== "historical-e2e") invalid("challenge source candidate must be a historical E2E run");
  const outputById = new Map(sourceRun.outputs.map((output) => [output.regionId, output]));
  const reviewById = new Map(sourceOverlay.entries.map((entry) => [entry.regionId, entry]));
  const hardPool: TranslationBenchmarkRegion[] = [];
  const controlPool: TranslationBenchmarkRegion[] = [];
  for (const region of input.regions) {
    if (region.translationEligibility !== "eligible") continue;
    const output = outputById.get(region.id);
    const review = reviewById.get(region.id);
    if (!output || !review || inputAgreement(region, output) === "different") continue;
    if (!reviewPass(review, "semanticUsable") || !reviewPass(review, "terminologyCorrect")) hardPool.push(region);
    else if (reviewPass(review, "semanticUsable") && reviewPass(review, "terminologyCorrect")) controlPool.push(region);
  }
  if (hardPool.length < hardCaseLimit) invalid("historical source does not contain enough preregistered hard cases");
  const hard = chooseStratified(hardPool, hardCaseLimit, 1, seed, "hard");
  const controlLimit = new Set(controlPool.map((region) => region.category + "|" + region.lengthStratum)).size * successControlPerStratum;
  const controls = chooseStratified(controlPool, controlLimit, successControlPerStratum, seed, "control");
  if (controls.length !== controlLimit) invalid("historical source does not contain enough stratified success controls");
  const selected = [...hard, ...controls].sort((left, right) => left.pageOrder - right.pageOrder || left.regionOrder - right.regionOrder || left.id.localeCompare(right.id));
  return { selected, hardCaseCount: hard.length, successControlCount: controls.length };
}

function selectionSha256(benchmarkId: string, seed: string, selectedRegionIds: string[]): string {
  return sha256Bytes(Buffer.from(JSON.stringify({ selectorRevision: 1, benchmarkId, seed, selectedRegionIds }), "utf8"));
}

function countBy<T extends string>(values: T[]): Record<T, number> {
  const result = {} as Record<T, number>;
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

export function createTranslationBenchmarkSpec(
  inputBytes: Uint8Array,
  sourceRunBytes: Uint8Array,
  sourceOverlayBytes: Uint8Array,
  candidates: TranslationCandidateDeclaration[],
  options: {
    specId: string;
    seed: string;
    hardCaseLimit?: number;
    successControlPerStratum?: number;
    bootstrapSeed?: number;
    bootstrapReplicates?: number;
    protocolComparisonMode?: TranslationProtocolComparisonMode;
  },
): TranslationBenchmarkSpec {
  const input = parseTranslationBenchmarkInput(inputBytes);
  const sourceRun = parseTranslationCandidateRun(sourceRunBytes, input);
  assertPinned(inputBytes, sourceRun.input, "challenge source candidate input");
  const sourceOverlay = parseTranslationReviewOverlay(sourceOverlayBytes, input, sourceRunBytes, sourceRun);
  assertPinned(inputBytes, sourceOverlay.source.input, "challenge source review input");
  if (sourceOverlay.entries.length !== input.regions.length || new Set(sourceOverlay.entries.map((entry) => entry.regionId)).size !== input.regions.length) invalid("challenge source review overlay must cover the complete fixed population");
  const declarations = candidates.map((candidate, index) => parseCandidateDeclaration(candidate, "candidate declaration " + index));
  if (new Set(declarations.map((candidate) => candidate.candidateId)).size !== declarations.length) invalid("candidate declarations contain duplicate ids");
  const protocolComparisonMode = options.protocolComparisonMode ?? "identical-controlled-v1";
  if (!PROTOCOL_COMPARISON_MODES.has(protocolComparisonMode)) invalid("translation protocol comparison mode is invalid");
  validateProtocolComparisonMode(declarations, protocolComparisonMode);
  const sourceDeclaration = declarations.find((candidate) => candidate.candidateId === sourceRun.candidateId);
  if (!sourceDeclaration || sourceDeclaration.evaluationMode !== "historical-e2e") invalid("candidate declarations omit the historical challenge source");
  assertCandidateIdentity(sourceRun, sourceDeclaration);
  const seed = safeIdentifier(options.seed, "challenge seed");
  const hardCaseLimit = integer(options.hardCaseLimit ?? 24, "hardCaseLimit", 1);
  const successControlPerStratum = integer(options.successControlPerStratum ?? 1, "successControlPerStratum", 1);
  const selection = selectChallenge(input, sourceRun, sourceOverlay, seed, hardCaseLimit, successControlPerStratum);
  if (selection.selected.some((region) => !region.nonRefusalRequired)) invalid("preregistered challenge must require non-refusal/non-dilution review for every selected region");
  const selectedRegionIds = selection.selected.map((region) => region.id);
  const categoryCounts = countBy(selection.selected.map((region) => region.category));
  const rawLengthCounts = countBy(selection.selected.map((region) => region.lengthStratum));
  const lengthCounts: Record<TranslationLengthStratum, number> = { short: rawLengthCounts.short ?? 0, medium: rawLengthCounts.medium ?? 0, long: rawLengthCounts.long ?? 0 };
  return {
    schemaVersion: 1,
    specRevision: 1,
    specId: safeIdentifier(options.specId, "specId"),
    benchmarkId: input.benchmarkId,
    input: artifactPin(inputBytes),
    challenge: {
      selectorRevision: 1,
      seed,
      sourceCandidateId: sourceRun.candidateId,
      sourceCandidateRun: artifactPin(sourceRunBytes),
      sourceReviewOverlay: artifactPin(sourceOverlayBytes),
      hardCaseLimit,
      successControlPerStratum,
      hardCaseDefinition: "historical-input-agreement-and-semantic-or-terminology-fail",
      successControlDefinition: "historical-input-agreement-and-semantic-and-terminology-pass",
      selectionSha256: selectionSha256(input.benchmarkId, seed, selectedRegionIds),
      selectedRegionIds,
      hardCaseCount: selection.hardCaseCount,
      successControlCount: selection.successControlCount,
      nonRefusalCount: selection.selected.filter((region) => region.nonRefusalRequired).length,
      pageCount: new Set(selection.selected.map((region) => region.pageId)).size,
      categoryCounts,
      lengthCounts,
    },
    candidates: declarations,
    metrics: {
      primary: [...PRIMARY_METRICS],
      diagnostics: [...DIAGNOSTIC_METRICS],
      referenceDistancePolicy: "diagnostic-only-never-a-semantic-gate",
    },
    structuralQa: { maxLineCount: 6, maxLengthRatio: 4, repetitionWindow: 4 },
    comparison: {
      method: "paired-page-grouped-bootstrap-percentile",
      bootstrapSeed: integer(options.bootstrapSeed ?? 20260815, "bootstrapSeed", 0),
      replicates: integer(options.bootstrapReplicates ?? 5000, "bootstrapReplicates", 1000),
      confidenceLevel: 0.95,
      ...(options.protocolComparisonMode === undefined ? {} : { protocolComparisonMode: options.protocolComparisonMode }),
    },
  };
}

export function parseTranslationBenchmarkInput(bytes: Uint8Array): TranslationBenchmarkInput {
  const value = record(parseJson(bytes, "translation benchmark input"), "translation benchmark input");
  allowedFields(value, ["schemaVersion", "benchmarkId", "source", "regions"], "translation benchmark input");
  if (value.schemaVersion !== 1 || !Array.isArray(value.regions)) invalid("translation benchmark input header is invalid");
  const source = record(value.source, "translation benchmark source");
  allowedFields(source, ["review", "ocrOverlay"], "translation benchmark source");
  const parseRevisionPin = (raw: unknown, label: string): ArtifactPin & { revision: number } => {
    const item = record(raw, label);
    allowedFields(item, ["sha256", "byteLength", "revision"], label);
    return { sha256: sha256(item.sha256, label + " sha256"), byteLength: integer(item.byteLength, label + " byteLength", 1), revision: integer(item.revision, label + " revision", 1) };
  };
  const ids = new Set<string>();
  const pageMetadata = new Map<string, string>();
  const regions = value.regions.map((raw, index): TranslationBenchmarkRegion => {
    const item = record(raw, "translation benchmark region " + index);
    allowedFields(item, ["id", "pageId", "pageOrder", "regionOrder", "category", "lengthStratum", "translationEligibility", "exclusionReason", "workingGoldOcr", "nonRefusalRequired"], "translation benchmark region " + index);
    const id = safeIdentifier(item.id, "translation benchmark region id");
    const pageId = safeIdentifier(item.pageId, "translation benchmark page id");
    const pageOrder = integer(item.pageOrder, "translation benchmark pageOrder", 1);
    const regionOrder = integer(item.regionOrder, "translation benchmark regionOrder", 0);
    const category = nonEmptyString(item.category, "translation benchmark category");
    if (!SAFE_CATEGORY.test(category)) invalid("translation benchmark category is invalid");
    const stratum = item.lengthStratum as TranslationLengthStratum | "not-applicable";
    const eligibility = item.translationEligibility as TranslationEligibility;
    if ((!LENGTH_STRATA.has(stratum as TranslationLengthStratum) && stratum !== "not-applicable") || !ELIGIBILITIES.has(eligibility) || typeof item.nonRefusalRequired !== "boolean") invalid("translation benchmark region state is invalid");
    if (ids.has(id)) invalid("translation benchmark input contains duplicate region ids");
    ids.add(id);
    const pageSignature = String(pageOrder) + "|" + category;
    if (pageMetadata.has(pageId) && pageMetadata.get(pageId) !== pageSignature) invalid("translation benchmark page metadata conflicts across regions");
    pageMetadata.set(pageId, pageSignature);
    if (eligibility === "eligible") {
      if (stratum === "not-applicable") invalid("translation-eligible region requires a real length stratum");
      if (item.exclusionReason !== undefined) invalid("translation-eligible region cannot have an exclusion reason");
      const workingGoldOcr = nonEmptyString(item.workingGoldOcr, "translation working-gold OCR");
      if (normalizeOcrText(workingGoldOcr).length === 0) invalid("translation working-gold OCR normalizes to empty");
      if (stratum !== lengthStratum(workingGoldOcr)) invalid("translation length stratum differs from working-gold OCR");
      return { id, pageId, pageOrder, regionOrder, category, lengthStratum: stratum, translationEligibility: eligibility, workingGoldOcr, nonRefusalRequired: item.nonRefusalRequired };
    }
    if (stratum !== "not-applicable") invalid("non-translation responsibility region must use not-applicable length stratum");
    if (item.workingGoldOcr !== undefined) invalid("translation-excluded region cannot expose working-gold OCR");
    const exclusionReason = item.exclusionReason as OcrExclusionReason;
    if (!EXCLUSION_REASONS.has(exclusionReason)) invalid("translation-excluded region requires a supported non-translation responsibility reason");
    return { id, pageId, pageOrder, regionOrder, category, lengthStratum: stratum, translationEligibility: eligibility, exclusionReason, nonRefusalRequired: item.nonRefusalRequired };
  });
  if (regions.length === 0) invalid("translation benchmark input has no regions");
  return {
    schemaVersion: 1,
    benchmarkId: safeIdentifier(value.benchmarkId, "translation benchmarkId"),
    source: { review: parseRevisionPin(source.review, "translation review source pin"), ocrOverlay: parseRevisionPin(source.ocrOverlay, "translation OCR overlay pin") },
    regions,
  };
}

export function parseTranslationCandidateRun(bytes: Uint8Array, input: TranslationBenchmarkInput): TranslationCandidateRun {
  const value = record(parseJson(bytes, "translation candidate run"), "translation candidate run");
  allowedFields(value, ["schemaVersion", "runId", "benchmarkId", "candidateId", "evaluationMode", "input", "model", "protocol", "outputs"], "translation candidate run");
  if (value.schemaVersion !== 1 || !Array.isArray(value.outputs)) invalid("translation candidate run header is invalid");
  const evaluationMode = value.evaluationMode as TranslationEvaluationMode;
  if (!EVALUATION_MODES.has(evaluationMode)) invalid("translation candidate evaluation mode is invalid");
  const inputById = new Map(input.regions.map((region) => [region.id, region]));
  const ids = new Set<string>();
  const outputs = value.outputs.map((raw, index): TranslationCandidateOutput => {
    const item = record(raw, "translation candidate output " + index);
    allowedFields(item, ["regionId", "sourceText", "translatedText"], "translation candidate output " + index);
    const regionId = safeIdentifier(item.regionId, "translation candidate output regionId");
    const region = inputById.get(regionId);
    if (!region) invalid("translation candidate output is outside the fixed benchmark population");
    if (ids.has(regionId)) invalid("translation candidate run contains duplicate region ids");
    ids.add(regionId);
    const sourceText = nonEmptyString(item.sourceText, "translation candidate sourceText");
    if (typeof item.translatedText !== "string") invalid("translation candidate translatedText must be a string");
    if (evaluationMode === "fixed-working-gold") {
      if (region.translationEligibility !== "eligible") invalid("fixed-working-gold run cannot translate a non-translation responsibility region");
      if (sourceText !== region.workingGoldOcr) invalid("fixed-working-gold candidate source drifted from the exact working-gold OCR input");
    }
    return { regionId, sourceText, translatedText: item.translatedText };
  });
  const protocol = parseProtocol(value.protocol, "translation candidate protocol");
  if (evaluationMode === "fixed-working-gold" && !protocol.nonRefusalInstruction) invalid("controlled translation candidate omitted the non-refusal/non-dilution instruction");
  return {
    schemaVersion: 1,
    runId: safeIdentifier(value.runId, "translation runId"),
    benchmarkId: safeIdentifier(value.benchmarkId, "translation candidate benchmarkId"),
    candidateId: safeIdentifier(value.candidateId, "translation candidateId"),
    evaluationMode,
    input: assertPin(value.input, "translation candidate input pin"),
    model: parseModel(value.model, "translation candidate model"),
    protocol,
    outputs,
  };
}

export function parseTranslationReviewOverlay(
  bytes: Uint8Array,
  input: TranslationBenchmarkInput,
  runBytes: Uint8Array,
  run: TranslationCandidateRun,
): TranslationReviewOverlay {
  const value = record(parseJson(bytes, "translation review overlay"), "translation review overlay");
  allowedFields(value, ["schemaVersion", "reviewRevision", "benchmarkId", "candidateId", "source", "entries"], "translation review overlay");
  if (value.schemaVersion !== 1 || !Array.isArray(value.entries)) invalid("translation review overlay header is invalid");
  const source = record(value.source, "translation review overlay source");
  allowedFields(source, ["input", "candidateRun"], "translation review overlay source");
  const inputPin = assertPin(source.input, "translation review overlay input pin");
  const candidateRunPin = assertPin(source.candidateRun, "translation review overlay candidate run pin");
  assertPinned(runBytes, candidateRunPin, "translation review overlay candidate run");
  const knownIds = new Set(input.regions.map((region) => region.id));
  const ids = new Set<string>();
  const entries = value.entries.map((raw, index): TranslationReviewOverlayEntry => {
    const item = record(raw, "translation review entry " + index);
    allowedFields(item, ["regionId", "referenceTranslation", "semanticUsable", "terminologyCorrect", "refusalDilution", "contextCharacterConsistent", "layoutUsable"], "translation review entry " + index);
    const regionId = safeIdentifier(item.regionId, "translation review regionId");
    if (!knownIds.has(regionId)) invalid("translation review entry is outside the fixed benchmark population");
    if (ids.has(regionId)) invalid("translation review overlay contains duplicate region ids");
    ids.add(regionId);
    const semanticUsable = item.semanticUsable as TranslationReviewVerdict;
    const terminologyCorrect = item.terminologyCorrect as TranslationReviewVerdict;
    const refusalDilution = item.refusalDilution as RefusalDilutionVerdict;
    const contextCharacterConsistent = item.contextCharacterConsistent as TranslationReviewVerdict;
    const layoutUsable = item.layoutUsable as TranslationReviewVerdict;
    if (!REVIEW_VERDICTS.has(semanticUsable) || !REVIEW_VERDICTS.has(terminologyCorrect) || !REFUSAL_VERDICTS.has(refusalDilution)
      || !REVIEW_VERDICTS.has(contextCharacterConsistent) || !REVIEW_VERDICTS.has(layoutUsable)) invalid("translation review verdict is invalid");
    return {
      regionId,
      referenceTranslation: nonEmptyString(item.referenceTranslation, "translation review referenceTranslation"),
      semanticUsable,
      terminologyCorrect,
      refusalDilution,
      contextCharacterConsistent,
      layoutUsable,
    };
  });
  const benchmarkId = safeIdentifier(value.benchmarkId, "translation review benchmarkId");
  const candidateId = safeIdentifier(value.candidateId, "translation review candidateId");
  if (benchmarkId !== input.benchmarkId || candidateId !== run.candidateId) invalid("translation review overlay identity differs from its input or candidate run");
  return {
    schemaVersion: 1,
    reviewRevision: integer(value.reviewRevision, "translation review revision", 1),
    benchmarkId,
    candidateId,
    source: { input: inputPin, candidateRun: candidateRunPin },
    entries,
  };
}

function parseCandidateDeclaration(value: unknown, label: string): TranslationCandidateDeclaration {
  const item = record(value, label);
  allowedFields(item, ["candidateId", "evaluationMode", "model", "protocol"], label);
  const evaluationMode = item.evaluationMode as TranslationEvaluationMode;
  if (!EVALUATION_MODES.has(evaluationMode)) invalid(label + " evaluationMode is invalid");
  const protocol = parseProtocol(item.protocol, label + " protocol");
  if (evaluationMode === "fixed-working-gold" && !protocol.nonRefusalInstruction) invalid(label + " controlled protocol omits non-refusal/non-dilution instruction");
  return { candidateId: safeIdentifier(item.candidateId, label + " candidateId"), evaluationMode, model: parseModel(item.model, label + " model"), protocol };
}

function validateProtocolComparisonMode(candidates: TranslationCandidateDeclaration[], mode: TranslationProtocolComparisonMode): void {
  const controlled = candidates.filter((candidate) => candidate.evaluationMode === "fixed-working-gold");
  if (controlled.length > 1) {
    const shared = controlled[0].protocol;
    const protocolDifferenceObserved = controlled.slice(1).some((candidate) => JSON.stringify(candidate.protocol) !== JSON.stringify(shared));
    if (mode === "identical-controlled-v1" && protocolDifferenceObserved) invalid("controlled candidates do not share an identical protocol identity");
    if (mode === "explicit-protocol-divergent-pipeline-v1" && !protocolDifferenceObserved) invalid("protocol-divergent pipeline comparison does not contain a protocol difference");
  } else if (mode === "explicit-protocol-divergent-pipeline-v1") {
    invalid("protocol-divergent pipeline comparison requires at least two fixed-working-gold candidates");
  }
}

function assertCandidateIdentity(run: TranslationCandidateRun, declaration: TranslationCandidateDeclaration): void {
  if (run.candidateId !== declaration.candidateId || run.evaluationMode !== declaration.evaluationMode
    || JSON.stringify(run.model) !== JSON.stringify(declaration.model) || JSON.stringify(run.protocol) !== JSON.stringify(declaration.protocol)) {
    invalid("candidate run identity differs from its preregistered declaration");
  }
}

function integerRecord(value: unknown, label: string): Record<string, number> {
  const item = record(value, label);
  const result: Record<string, number> = {};
  for (const [key, count] of Object.entries(item)) {
    if (!SAFE_CATEGORY.test(key)) invalid(label + " contains an unsafe key");
    result[key] = integer(count, label + " count", 0);
  }
  return result;
}

function exactStringArray(value: unknown, expected: readonly string[], label: string): void {
  if (!Array.isArray(value) || value.length !== expected.length || value.some((item, index) => item !== expected[index])) invalid(label + " differs from the fixed metric contract");
}

export function parseTranslationBenchmarkSpec(bytes: Uint8Array, input: TranslationBenchmarkInput): TranslationBenchmarkSpec {
  const value = record(parseJson(bytes, "translation benchmark spec"), "translation benchmark spec");
  allowedFields(value, ["schemaVersion", "specRevision", "specId", "benchmarkId", "input", "challenge", "candidates", "metrics", "structuralQa", "comparison"], "translation benchmark spec");
  if (value.schemaVersion !== 1 || value.specRevision !== 1 || !Array.isArray(value.candidates) || value.candidates.length === 0) invalid("translation benchmark spec header is invalid");
  const challenge = record(value.challenge, "translation challenge");
  allowedFields(challenge, ["selectorRevision", "seed", "sourceCandidateId", "sourceCandidateRun", "sourceReviewOverlay", "hardCaseLimit", "successControlPerStratum", "hardCaseDefinition", "successControlDefinition", "selectionSha256", "selectedRegionIds", "hardCaseCount", "successControlCount", "nonRefusalCount", "pageCount", "categoryCounts", "lengthCounts"], "translation challenge");
  if (challenge.selectorRevision !== 1 || challenge.hardCaseDefinition !== "historical-input-agreement-and-semantic-or-terminology-fail"
    || challenge.successControlDefinition !== "historical-input-agreement-and-semantic-and-terminology-pass" || !Array.isArray(challenge.selectedRegionIds) || challenge.selectedRegionIds.length === 0) invalid("translation challenge definition is invalid");
  const known = new Map(input.regions.map((region) => [region.id, region]));
  const seen = new Set<string>();
  const selectedRegionIds = challenge.selectedRegionIds.map((raw, index) => {
    const id = safeIdentifier(raw, "translation challenge region " + index);
    if (seen.has(id)) invalid("translation challenge contains duplicate region ids");
    seen.add(id);
    const region = known.get(id);
    if (!region || region.translationEligibility !== "eligible") invalid("translation challenge contains a non-translation responsibility region");
    return id;
  });
  const seed = safeIdentifier(challenge.seed, "translation challenge seed");
  const fixedSelectionSha256 = sha256(challenge.selectionSha256, "translation challenge selection sha256");
  if (fixedSelectionSha256 !== selectionSha256(input.benchmarkId, seed, selectedRegionIds)) invalid("translation challenge selection hash is stale");
  const lengthCountsValue = record(challenge.lengthCounts, "translation challenge length counts");
  allowedFields(lengthCountsValue, ["short", "medium", "long"], "translation challenge length counts");
  const lengthCounts: Record<TranslationLengthStratum, number> = {
    short: integer(lengthCountsValue.short, "translation challenge short count", 0),
    medium: integer(lengthCountsValue.medium, "translation challenge medium count", 0),
    long: integer(lengthCountsValue.long, "translation challenge long count", 0),
  };
  const selected = selectedRegionIds.map((id) => known.get(id)!);
  if (JSON.stringify(lengthCounts) !== JSON.stringify({ short: selected.filter((region) => region.lengthStratum === "short").length, medium: selected.filter((region) => region.lengthStratum === "medium").length, long: selected.filter((region) => region.lengthStratum === "long").length })) invalid("translation challenge length counts are stale");
  const categoryCounts = integerRecord(challenge.categoryCounts, "translation challenge category counts");
  if (JSON.stringify(categoryCounts) !== JSON.stringify(countBy(selected.map((region) => region.category)))) invalid("translation challenge category counts are stale");
  const nonRefusalCount = integer(challenge.nonRefusalCount, "translation challenge nonRefusalCount", 0);
  if (nonRefusalCount !== selected.filter((region) => region.nonRefusalRequired).length || nonRefusalCount !== selected.length) invalid("translation challenge does not fully preregister non-refusal/non-dilution checks");
  const pageCount = integer(challenge.pageCount, "translation challenge pageCount", 1);
  if (pageCount !== new Set(selected.map((region) => region.pageId)).size) invalid("translation challenge page count is stale");
  const candidates = value.candidates.map((candidate, index) => parseCandidateDeclaration(candidate, "candidate declaration " + index));
  if (new Set(candidates.map((candidate) => candidate.candidateId)).size !== candidates.length) invalid("translation benchmark spec contains duplicate candidate ids");
  const sourceCandidateId = safeIdentifier(challenge.sourceCandidateId, "translation challenge sourceCandidateId");
  if (!candidates.some((candidate) => candidate.candidateId === sourceCandidateId && candidate.evaluationMode === "historical-e2e")) invalid("translation challenge source is not a declared historical candidate");
  const comparison = record(value.comparison, "translation comparison spec");
  allowedFields(comparison, ["method", "bootstrapSeed", "replicates", "confidenceLevel", "protocolComparisonMode"], "translation comparison spec");
  if (comparison.method !== "paired-page-grouped-bootstrap-percentile" || comparison.confidenceLevel !== 0.95) invalid("translation paired comparison contract is invalid");
  const protocolComparisonMode = (comparison.protocolComparisonMode ?? "identical-controlled-v1") as TranslationProtocolComparisonMode;
  if (!PROTOCOL_COMPARISON_MODES.has(protocolComparisonMode)) invalid("translation protocol comparison mode is invalid");
  validateProtocolComparisonMode(candidates, protocolComparisonMode);
  const metrics = record(value.metrics, "translation benchmark metrics");
  allowedFields(metrics, ["primary", "diagnostics", "referenceDistancePolicy"], "translation benchmark metrics");
  exactStringArray(metrics.primary, PRIMARY_METRICS, "translation primary metrics");
  exactStringArray(metrics.diagnostics, DIAGNOSTIC_METRICS, "translation diagnostic metrics");
  if (metrics.referenceDistancePolicy !== "diagnostic-only-never-a-semantic-gate") invalid("reference string distance was promoted outside diagnostics");
  const structuralQa = record(value.structuralQa, "translation structural QA spec");
  allowedFields(structuralQa, ["maxLineCount", "maxLengthRatio", "repetitionWindow"], "translation structural QA spec");
  const maxLineCount = integer(structuralQa.maxLineCount, "maxLineCount", 1);
  const maxLengthRatio = finiteNumber(structuralQa.maxLengthRatio, "maxLengthRatio", 1);
  const repetitionWindow = integer(structuralQa.repetitionWindow, "repetitionWindow", 2);
  if (maxLineCount > 100 || maxLengthRatio > 20 || repetitionWindow > 32) invalid("translation structural QA thresholds are outside supported bounds");
  const benchmarkId = safeIdentifier(value.benchmarkId, "translation spec benchmarkId");
  if (benchmarkId !== input.benchmarkId) invalid("translation spec benchmarkId differs from input");
  return {
    schemaVersion: 1,
    specRevision: 1,
    specId: safeIdentifier(value.specId, "translation specId"),
    benchmarkId,
    input: assertPin(value.input, "translation spec input pin"),
    challenge: {
      selectorRevision: 1,
      seed,
      sourceCandidateId,
      sourceCandidateRun: assertPin(challenge.sourceCandidateRun, "translation challenge source candidate run pin"),
      sourceReviewOverlay: assertPin(challenge.sourceReviewOverlay, "translation challenge source review overlay pin"),
      hardCaseLimit: integer(challenge.hardCaseLimit, "hardCaseLimit", 1),
      successControlPerStratum: integer(challenge.successControlPerStratum, "successControlPerStratum", 1),
      hardCaseDefinition: "historical-input-agreement-and-semantic-or-terminology-fail",
      successControlDefinition: "historical-input-agreement-and-semantic-and-terminology-pass",
      selectionSha256: fixedSelectionSha256,
      selectedRegionIds,
      hardCaseCount: integer(challenge.hardCaseCount, "hardCaseCount", 1),
      successControlCount: integer(challenge.successControlCount, "successControlCount", 1),
      nonRefusalCount,
      pageCount,
      categoryCounts,
      lengthCounts,
    },
    candidates,
    metrics: { primary: [...PRIMARY_METRICS], diagnostics: [...DIAGNOSTIC_METRICS], referenceDistancePolicy: "diagnostic-only-never-a-semantic-gate" },
    structuralQa: { maxLineCount, maxLengthRatio, repetitionWindow },
    comparison: {
      method: "paired-page-grouped-bootstrap-percentile",
      bootstrapSeed: integer(comparison.bootstrapSeed, "bootstrapSeed", 0),
      replicates: integer(comparison.replicates, "bootstrap replicates", 1000),
      confidenceLevel: 0.95,
      protocolComparisonMode,
    },
  };
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function binarySummary(verdicts: TranslationReviewVerdict[]): BinaryMetricSummary {
  const reviewed = verdicts.filter((verdict) => verdict !== "not-reviewed");
  const passed = reviewed.filter((verdict) => verdict === "pass").length;
  return { reviewed: reviewed.length, passed, failed: reviewed.length - passed, passRate: rate(passed, reviewed.length) };
}

function refusalSummary(verdicts: RefusalDilutionVerdict[]): RefusalDilutionSummary {
  const reviewed = verdicts.filter((verdict) => verdict !== "not-reviewed");
  const passed = reviewed.filter((verdict) => verdict === "pass").length;
  const refusal = reviewed.filter((verdict) => verdict === "refusal").length;
  const dilution = reviewed.filter((verdict) => verdict === "dilution").length;
  return { reviewed: reviewed.length, passed, refusal, dilution, passRate: rate(passed, reviewed.length) };
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

function hasUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function hasExcessiveRepetition(text: string, window: number): boolean {
  const normalized = [...normalizeOcrText(text)];
  if (normalized.length < window * 3) return false;
  for (let index = 0; index <= normalized.length - window * 3; index += 1) {
    const first = normalized.slice(index, index + window).join("");
    const second = normalized.slice(index + window, index + window * 2).join("");
    const third = normalized.slice(index + window * 2, index + window * 3).join("");
    if (first === second && second === third) return true;
  }
  return false;
}

function structuralFlags(text: string, source: string, spec: TranslationBenchmarkSpec["structuralQa"]): Set<StructuralQaCode> {
  const flags = new Set<StructuralQaCode>();
  if (text.trim().length === 0) flags.add("empty-output");
  if (text !== text.trim()) flags.add("surrounding-whitespace");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) flags.add("disallowed-control");
  if (hasUnpairedSurrogate(text)) flags.add("unpaired-surrogate");
  if (text.includes("```")) flags.add("markdown-fence");
  if (text.split(/\r?\n/u).length > spec.maxLineCount) flags.add("too-many-lines");
  if (/[\u3040-\u30ff]/u.test(text)) flags.add("japanese-kana-remains");
  const normalizedText = normalizeOcrText(text);
  const normalizedSource = normalizeOcrText(source);
  if (normalizedText.length > 0 && normalizedText === normalizedSource) flags.add("source-echo");
  if (normalizedSource.length > 0 && [...normalizedText].length / [...normalizedSource].length > spec.maxLengthRatio) flags.add("excessive-length-ratio");
  if (hasExcessiveRepetition(text, spec.repetitionWindow)) flags.add("excessive-repetition");
  return flags;
}

function formattingValid(flags: Set<StructuralQaCode>): boolean {
  return !["empty-output", "surrounding-whitespace", "disallowed-control", "unpaired-surrogate", "markdown-fence", "too-many-lines"].some((code) => flags.has(code as StructuralQaCode));
}

interface OutcomeValue {
  pageId: string;
  value: number;
}

interface CandidateEvaluation {
  report: TranslationCandidateReport;
  outcomes: Map<ComparisonMetric, Map<string, OutcomeValue>>;
}

function setOutcome(outcomes: Map<ComparisonMetric, Map<string, OutcomeValue>>, metric: ComparisonMetric, region: TranslationBenchmarkRegion, value: number): void {
  const values = outcomes.get(metric) ?? new Map<string, OutcomeValue>();
  values.set(region.id, { pageId: region.pageId, value });
  outcomes.set(metric, values);
}

function verdictOutcome(verdict: TranslationReviewVerdict): number | undefined {
  return verdict === "not-reviewed" ? undefined : verdict === "pass" ? 1 : 0;
}

function reviewMetrics(entries: TranslationReviewOverlayEntry[]): { semanticUsable: BinaryMetricSummary; terminologyCorrect: BinaryMetricSummary; layoutUsable: BinaryMetricSummary } {
  return {
    semanticUsable: binarySummary(entries.map((entry) => entry.semanticUsable)),
    terminologyCorrect: binarySummary(entries.map((entry) => entry.terminologyCorrect)),
    layoutUsable: binarySummary(entries.map((entry) => entry.layoutUsable)),
  };
}

function evaluateCandidate(
  input: TranslationBenchmarkInput,
  spec: TranslationBenchmarkSpec,
  run: TranslationCandidateRun,
  overlay: TranslationReviewOverlay,
): CandidateEvaluation {
  const regionById = new Map(input.regions.map((region) => [region.id, region]));
  const outputById = new Map(run.outputs.map((output) => [output.regionId, output]));
  const reviewById = new Map(overlay.entries.map((entry) => [entry.regionId, entry]));
  const eligible = input.regions.filter((region) => region.translationEligibility === "eligible");
  const excluded = input.regions.filter((region) => region.translationEligibility === "excluded");
  let rawExact = 0;
  let normalizationOnly = 0;
  let different = 0;
  let eligibleOutputs = 0;
  let excludedOutputs = 0;
  const differentIds = new Set<string>();
  for (const output of run.outputs) {
    const region = regionById.get(output.regionId)!;
    if (region.translationEligibility === "excluded") {
      excludedOutputs += 1;
      continue;
    }
    eligibleOutputs += 1;
    const agreement = inputAgreement(region, output);
    if (agreement === "raw") rawExact += 1;
    else if (agreement === "normalized-only") normalizationOnly += 1;
    else {
      different += 1;
      differentIds.add(region.id);
    }
  }
  if (run.evaluationMode === "fixed-working-gold" && (normalizationOnly !== 0 || different !== 0)) invalid("fixed-working-gold run contains an OCR-input mismatch");

  const selected = spec.challenge.selectedRegionIds.map((id) => regionById.get(id)!);
  const semanticVerdicts: TranslationReviewVerdict[] = [];
  const terminologyVerdicts: TranslationReviewVerdict[] = [];
  const refusalVerdicts: RefusalDilutionVerdict[] = [];
  const contextVerdicts: TranslationReviewVerdict[] = [];
  const layoutVerdicts: TranslationReviewVerdict[] = [];
  const formattingVerdicts: TranslationReviewVerdict[] = [];
  const structuralCounts = Object.fromEntries(STRUCTURAL_CODES.map((code) => [code, 0])) as Record<StructuralQaCode, number>;
  let structuralEvaluated = 0;
  let structuralPassed = 0;
  let availableOutputs = 0;
  let analyzable = 0;
  let historicalOnly = 0;
  let referenceEvaluated = 0;
  let normalizedExact = 0;
  let totalEditDistance = 0;
  let referenceCharacters = 0;
  const outcomes = new Map<ComparisonMetric, Map<string, OutcomeValue>>();

  for (const region of selected) {
    const output = outputById.get(region.id);
    if (!output) continue;
    availableOutputs += 1;
    if (inputAgreement(region, output) === "different") {
      historicalOnly += 1;
      continue;
    }
    analyzable += 1;
    const review = reviewById.get(region.id);
    if (!review) invalid("translation review overlay does not cover an analyzable challenge output");
    semanticVerdicts.push(review.semanticUsable);
    terminologyVerdicts.push(review.terminologyCorrect);
    refusalVerdicts.push(review.refusalDilution);
    contextVerdicts.push(review.contextCharacterConsistent);
    layoutVerdicts.push(review.layoutUsable);
    const semantic = verdictOutcome(review.semanticUsable);
    const terminology = verdictOutcome(review.terminologyCorrect);
    const context = verdictOutcome(review.contextCharacterConsistent);
    if (semantic !== undefined) setOutcome(outcomes, "semantic-usable", region, semantic);
    if (terminology !== undefined) setOutcome(outcomes, "terminology-correct", region, terminology);
    if (review.refusalDilution !== "not-reviewed") setOutcome(outcomes, "refusal-dilution-pass", region, review.refusalDilution === "pass" ? 1 : 0);
    if (context !== undefined) setOutcome(outcomes, "context-character-consistent", region, context);
    const flags = structuralFlags(output.translatedText, output.sourceText, spec.structuralQa);
    const formatPass = formattingValid(flags);
    formattingVerdicts.push(formatPass ? "pass" : "fail");
    structuralEvaluated += 1;
    if (flags.size === 0) structuralPassed += 1;
    for (const flag of flags) structuralCounts[flag] += 1;
    setOutcome(outcomes, "formatting-valid", region, formatPass ? 1 : 0);
    setOutcome(outcomes, "structural-qa-pass", region, flags.size === 0 ? 1 : 0);
    const normalizedOutput = normalizeOcrText(output.translatedText);
    const normalizedReference = normalizeOcrText(review.referenceTranslation);
    const distance = editDistance(output.translatedText, review.referenceTranslation);
    referenceEvaluated += 1;
    if (normalizedOutput === normalizedReference) normalizedExact += 1;
    totalEditDistance += distance;
    referenceCharacters += [...normalizedReference].length;
  }

  const historicalEntries = run.evaluationMode === "historical-e2e" ? input.regions.map((region) => reviewById.get(region.id)).filter((entry): entry is TranslationReviewOverlayEntry => entry !== undefined) : [];
  const differentEntries = run.evaluationMode === "historical-e2e" ? [...differentIds].map((id) => reviewById.get(id)).filter((entry): entry is TranslationReviewOverlayEntry => entry !== undefined) : [];
  const historicalMetrics = reviewMetrics(historicalEntries);
  const differentMetrics = reviewMetrics(differentEntries);
  const formatting = binarySummary(formattingVerdicts);
  const report: TranslationCandidateReport = {
    candidateId: run.candidateId,
    evidenceClass: run.evaluationMode === "fixed-working-gold"
      ? spec.comparison.protocolComparisonMode === "explicit-protocol-divergent-pipeline-v1" ? "protocol-divergent-fixed-working-gold" : "controlled-fixed-working-gold"
      : "historical-attribution-only",
    evaluationMode: run.evaluationMode,
    model: run.model,
    protocol: run.protocol,
    attribution: {
      workingGoldRegions: input.regions.length,
      translationEligibleRegions: eligible.length,
      nonTranslationResponsibilityRegions: excluded.length,
      observedOutputs: run.outputs.length,
      eligibleOutputs,
      excludedOutputs,
      missingEligibleOutputs: eligible.length - eligibleOutputs,
      ocrInputRawExact: rawExact,
      ocrInputNormalizationOnlyExact: normalizationOnly,
      ocrInputDifferent: different,
      translationQualityAnalyzable: rawExact + normalizationOnly,
      historicalE2EOnly: run.evaluationMode === "historical-e2e" ? different : 0,
    },
    ...(run.evaluationMode === "historical-e2e" ? {
      historicalE2E: {
        population: historicalEntries.length,
        ...historicalMetrics,
        ocrInputDifferentSubset: { population: differentEntries.length, ...differentMetrics },
      },
    } : {}),
    challenge: {
      selectedRegions: selected.length,
      availableOutputs,
      missingOutputs: selected.length - availableOutputs,
      coverageRate: rate(availableOutputs, selected.length),
      translationQualityAnalyzable: analyzable,
      historicalE2EOnly: historicalOnly,
      semanticUsable: binarySummary(semanticVerdicts),
      terminologyCorrect: binarySummary(terminologyVerdicts),
      refusalDilution: refusalSummary(refusalVerdicts),
      formattingValidity: formatting,
      contextCharacterConsistency: binarySummary(contextVerdicts),
      layoutUsable: binarySummary(layoutVerdicts),
      structuralQa: {
        evaluated: structuralEvaluated,
        passed: structuralPassed,
        failed: structuralEvaluated - structuralPassed,
        passRate: rate(structuralPassed, structuralEvaluated),
        flags: structuralCounts,
      },
      referenceDiagnostics: {
        evaluated: referenceEvaluated,
        normalizedExact,
        normalizedExactRate: rate(normalizedExact, referenceEvaluated),
        totalEditDistance,
        referenceCharacters,
        corpusEditDistanceRatio: rate(totalEditDistance, referenceCharacters),
      },
    },
  };
  return { report, outcomes };
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function quantile(sorted: number[], probability: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function compareCandidates(
  left: CandidateEvaluation,
  right: CandidateEvaluation,
  spec: TranslationBenchmarkSpec,
): TranslationPairedComparison[] {
  const metrics: ComparisonMetric[] = ["semantic-usable", "terminology-correct", "refusal-dilution-pass", "formatting-valid", "context-character-consistent", "structural-qa-pass"];
  const comparisons: TranslationPairedComparison[] = [];
  for (const metric of metrics) {
    const leftValues = left.outcomes.get(metric) ?? new Map<string, OutcomeValue>();
    const rightValues = right.outcomes.get(metric) ?? new Map<string, OutcomeValue>();
    const pairs = [...leftValues.entries()].filter(([id]) => rightValues.has(id)).map(([id, leftValue]) => ({ pageId: leftValue.pageId, left: leftValue.value, right: rightValues.get(id)!.value }));
    if (pairs.length === 0) continue;
    const byPage = new Map<string, typeof pairs>();
    for (const pair of pairs) {
      const page = byPage.get(pair.pageId) ?? [];
      page.push(pair);
      byPage.set(pair.pageId, page);
    }
    const pages = [...byPage.keys()].sort();
    const leftRate = rate(pairs.reduce((sum, pair) => sum + pair.left, 0), pairs.length);
    const rightRate = rate(pairs.reduce((sum, pair) => sum + pair.right, 0), pairs.length);
    const hashSeed = Number.parseInt(sha256Bytes(Buffer.from(left.report.candidateId + "|" + right.report.candidateId + "|" + metric, "utf8")).slice(0, 8), 16);
    const random = seededRandom(spec.comparison.bootstrapSeed ^ hashSeed);
    const deltas: number[] = [];
    for (let replicate = 0; replicate < spec.comparison.replicates; replicate += 1) {
      let leftSum = 0;
      let rightSum = 0;
      let count = 0;
      for (let index = 0; index < pages.length; index += 1) {
        const sampled = byPage.get(pages[Math.floor(random() * pages.length)])!;
        for (const pair of sampled) {
          leftSum += pair.left;
          rightSum += pair.right;
          count += 1;
        }
      }
      deltas.push(rate(rightSum, count) - rate(leftSum, count));
    }
    deltas.sort((a, b) => a - b);
    comparisons.push({
      candidateA: left.report.candidateId,
      candidateB: right.report.candidateId,
      evidenceClass: left.report.evaluationMode === "fixed-working-gold" && right.report.evaluationMode === "fixed-working-gold"
        ? spec.comparison.protocolComparisonMode === "explicit-protocol-divergent-pipeline-v1" ? "protocol-divergent-pipeline-comparison" : "controlled-paired"
        : "historical-input-agreement-subset-diagnostic",
      metric,
      pairedRegions: pairs.length,
      pairedPages: pages.length,
      candidateARate: leftRate,
      candidateBRate: rightRate,
      differenceBMinusA: rightRate - leftRate,
      confidenceInterval: {
        method: "paired-page-grouped-bootstrap-percentile",
        confidenceLevel: 0.95,
        replicates: spec.comparison.replicates,
        lower: quantile(deltas, 0.025),
        upper: quantile(deltas, 0.975),
      },
    });
  }
  return comparisons;
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function evaluateTranslationBenchmark(
  inputBytes: Uint8Array,
  specBytes: Uint8Array,
  candidateRunBytes: Uint8Array[],
  reviewOverlayBytes: Uint8Array[],
): TranslationBenchmarkReport {
  if (candidateRunBytes.length === 0 || candidateRunBytes.length !== reviewOverlayBytes.length) invalid("translation benchmark requires one review overlay for every candidate run");
  const input = parseTranslationBenchmarkInput(inputBytes);
  const spec = parseTranslationBenchmarkSpec(specBytes, input);
  assertPinned(inputBytes, spec.input, "translation benchmark spec input");
  const declarationById = new Map(spec.candidates.map((candidate) => [candidate.candidateId, candidate]));
  const runByCandidate = new Map<string, { bytes: Uint8Array; run: TranslationCandidateRun }>();
  for (const bytes of candidateRunBytes) {
    const run = parseTranslationCandidateRun(bytes, input);
    assertPinned(inputBytes, run.input, "translation candidate fixed input");
    if (run.benchmarkId !== input.benchmarkId) invalid("translation candidate benchmarkId differs from the fixed input");
    const declaration = declarationById.get(run.candidateId);
    if (!declaration) invalid("translation candidate run was not preregistered");
    assertCandidateIdentity(run, declaration);
    if (runByCandidate.has(run.candidateId)) invalid("translation benchmark contains duplicate candidate runs");
    runByCandidate.set(run.candidateId, { bytes, run });
  }
  const overlayByCandidate = new Map<string, { bytes: Uint8Array; overlay: TranslationReviewOverlay }>();
  for (const bytes of reviewOverlayBytes) {
    const raw = record(parseJson(bytes, "translation review overlay identity"), "translation review overlay identity");
    const candidateId = safeIdentifier(raw.candidateId, "translation review overlay candidateId");
    const found = runByCandidate.get(candidateId);
    if (!found) invalid("translation review overlay has no candidate run");
    const overlay = parseTranslationReviewOverlay(bytes, input, found.bytes, found.run);
    assertPinned(inputBytes, overlay.source.input, "translation review overlay fixed input");
    if (overlayByCandidate.has(candidateId)) invalid("translation benchmark contains duplicate review overlays");
    overlayByCandidate.set(candidateId, { bytes, overlay });
  }
  if (overlayByCandidate.size !== runByCandidate.size) invalid("translation candidate/review overlay populations differ");
  const sourceRun = runByCandidate.get(spec.challenge.sourceCandidateId);
  const sourceOverlay = overlayByCandidate.get(spec.challenge.sourceCandidateId);
  if (!sourceRun || !sourceOverlay) invalid("translation benchmark omits the preregistered historical challenge source artifacts");
  assertPinned(sourceRun.bytes, spec.challenge.sourceCandidateRun, "translation challenge source candidate run");
  assertPinned(sourceOverlay.bytes, spec.challenge.sourceReviewOverlay, "translation challenge source review overlay");
  if (sourceOverlay.overlay.entries.length !== input.regions.length || new Set(sourceOverlay.overlay.entries.map((entry) => entry.regionId)).size !== input.regions.length) invalid("translation challenge source review no longer covers the complete fixed population");
  const sourceReferenceById = new Map(sourceOverlay.overlay.entries.map((entry) => [entry.regionId, entry.referenceTranslation]));
  for (const [candidateId, review] of overlayByCandidate) {
    if (candidateId === spec.challenge.sourceCandidateId) continue;
    for (const entry of review.overlay.entries) {
      if (sourceReferenceById.get(entry.regionId) !== entry.referenceTranslation) invalid("translation review overlay reference drifted from the fixed working-gold reference");
    }
  }
  const recomputed = selectChallenge(input, sourceRun.run, sourceOverlay.overlay, spec.challenge.seed, spec.challenge.hardCaseLimit, spec.challenge.successControlPerStratum);
  const recomputedIds = recomputed.selected.map((region) => region.id);
  if (!sameStringArray(recomputedIds, spec.challenge.selectedRegionIds) || recomputed.hardCaseCount !== spec.challenge.hardCaseCount || recomputed.successControlCount !== spec.challenge.successControlCount) {
    invalid("translation challenge selection no longer reproduces from its preregistered historical source");
  }
  const evaluations: CandidateEvaluation[] = [];
  const sourcePins: TranslationBenchmarkReport["source"]["candidateRuns"] = [];
  for (const declaration of spec.candidates) {
    const found = runByCandidate.get(declaration.candidateId);
    if (!found) continue;
    const review = overlayByCandidate.get(declaration.candidateId)!;
    evaluations.push(evaluateCandidate(input, spec, found.run, review.overlay));
    sourcePins.push({ candidateId: declaration.candidateId, run: artifactPin(found.bytes), reviewOverlay: artifactPin(review.bytes) });
  }
  const pairedComparisons: TranslationPairedComparison[] = [];
  for (let left = 0; left < evaluations.length; left += 1) {
    for (let right = left + 1; right < evaluations.length; right += 1) pairedComparisons.push(...compareCandidates(evaluations[left], evaluations[right], spec));
  }
  const eligibleCount = input.regions.filter((region) => region.translationEligibility === "eligible").length;
  return {
    schemaVersion: 1,
    benchmarkId: input.benchmarkId,
    specId: spec.specId,
    source: { input: artifactPin(inputBytes), spec: artifactPin(specBytes), candidateRuns: sourcePins },
    population: {
      workingGoldRegions: input.regions.length,
      translationEligibleRegions: eligibleCount,
      nonTranslationResponsibilityRegions: input.regions.length - eligibleCount,
      challengeRegions: spec.challenge.selectedRegionIds.length,
      challengePages: spec.challenge.pageCount,
    },
    claimBoundary: {
      fixedWorkingGoldRequiredForControlledScore: true,
      historicalRunsAreNotFixedOcrModelScores: true,
      ocrDifferentRegionsAreHistoricalE2EOnly: true,
      nonTranslationResponsibilityRegionsExcluded: true,
      referenceDistanceIsDiagnosticOnly: true,
      controlledPairedRequiresIdenticalProtocol: true,
      protocolDivergentPipelineComparisonsAreNotControlledScores: true,
      modelOnlyClaimsAreNotSupportedByProtocolDivergentComparison: true,
    },
    plannedCandidateCount: spec.candidates.length,
    evaluatedCandidateCount: evaluations.length,
    unevaluatedCandidateIds: spec.candidates.filter((candidate) => !runByCandidate.has(candidate.candidateId)).map((candidate) => candidate.candidateId),
    candidates: evaluations.map((evaluation) => evaluation.report),
    pairedComparisons,
  };
}

export function assertTranslationReportContainsNoPrivateIdentifiers(report: TranslationBenchmarkReport, input: TranslationBenchmarkInput): void {
  const serialized = JSON.stringify(report);
  for (const region of input.regions) {
    if (serialized.includes(region.id) || serialized.includes(region.pageId)) invalid("translation report leaks a private region or page identifier");
  }
}
