import { isDeepStrictEqual } from "node:util";
import { LocalizerError } from "./errors.ts";
import { sha256Bytes } from "./file-utils.ts";
import {
  evaluateOcrBaseline,
  type OcrBenchmarkCandidate,
  type OcrBenchmarkInput,
  type OcrBenchmarkRegion,
  type OcrBenchmarkReport,
} from "./ocr-benchmark.ts";
import { inspectOcrText, normalizeOcrText, type OcrHardSafetyReason } from "./ocr-safety.ts";
import {
  evaluateRoutingRegression,
  type RoutingRegressionInput,
  type RoutingRegressionObservation,
} from "./routing-regression.ts";

export type OcrArbitrationPolicy = "always-paddle" | "always-manga" | "agreement-category" | "agreement-category-bubble";
export type BubbleRelation = "bubble-contained" | "bubble-external";
export type HardCandidateAnomaly = OcrHardSafetyReason;

export interface OcrArbitrationSourcePin {
  sha256: string;
  byteLength: number;
}

export interface OcrArbitrationEvaluationSpec {
  schemaVersion: 1;
  evaluationId: string;
  baseCodeRevision: string;
  sources: {
    benchmarkInput: OcrArbitrationSourcePin;
    baselineReport: OcrArbitrationSourcePin;
    routingObservations: OcrArbitrationSourcePin;
  };
  engines: {
    paddle: string;
    manga: string;
  };
  minimumGroupSupport: number;
  bootstrap: {
    seed: number;
    replicates: number;
    confidenceLevel: 0.95;
  };
}

export interface OcrArbitrationMetrics {
  regionCount: number;
  exactRegions: number;
  exactRate: number;
  goldCharacters: number;
  editDistance: number;
  corpusCer: number;
  regionMacroCer: number;
  p50Cer: number;
  p90Cer: number;
  p95Cer: number;
  maxCer: number;
  cerAtMost3PercentRegions: number;
  cerAtMost3PercentRate: number;
}

export interface OcrArbitrationReport {
  schemaVersion: 1;
  evaluationId: string;
  source: {
    baseCodeRevision: string;
    benchmarkInputSha256: string;
    baselineReportSha256: string;
    routingObservationsSha256: string;
    benchmarkId: string;
    routingBenchmarkId: string;
  };
  contract: {
    normalization: "NFKC_REMOVE_WHITESPACE";
    crossValidation: "LEAVE_ONE_PAGE_OUT";
    trainingObjective: "EXACT_ERROR_RATE_PLUS_CORPUS_CER";
    hardAnomalies: HardCandidateAnomaly[];
    softDiagnosticsUsedForSelection: false;
    policies: OcrArbitrationPolicy[];
    minimumGroupSupport: number;
    fallbackHierarchy: {
      agreementCategory: string[];
      agreementCategoryBubble: string[];
    };
    bootstrap: OcrArbitrationEvaluationSpec["bootstrap"];
  };
  association: {
    benchmarkRegions: number;
    routingObservations: number;
    matchedRegions: number;
    eligibleRegions: number;
    pageCount: number;
    evaluatedPageCount: number;
  };
  denominators: OcrBenchmarkReport["denominators"];
  crossValidation: {
    foldCount: number;
    minimumTrainingPages: number;
    maximumTrainingPages: number;
    minimumTestRegions: number;
    maximumTestRegions: number;
  };
  qa: {
    hardCandidateAnomalyCounts: Array<{ engine: string; reason: HardCandidateAnomaly; count: number }>;
    hardCandidateResiduals: Array<{ regionRef: string; engine: string; reasons: HardCandidateAnomaly[] }>;
    jointWrongAgreementCount: number;
    jointWrongAgreementResiduals: Array<{ regionRef: string }>;
  };
  softDiagnostics: {
    usedForSelection: false;
    candidates: Array<{
      engine: string;
      availableRegions: number;
      normalizedLength: NumericDistribution;
      maximumRepeatedRun: NumericDistribution;
      repeatedBlockSignalRegions: number;
    }>;
    pair: {
      pairedRegions: number;
      normalizedLengthRatio: NumericDistribution;
      scriptComponentLoss: Array<{ script: ScriptComponent; paddleMissingRegions: number; mangaMissingRegions: number }>;
    };
  };
  strategies: OcrStrategyReport[];
  decision: {
    status: "FREEZE" | "DO_NOT_FREEZE";
    selectedPolicy?: OcrArbitrationPolicy;
    reasons: string[];
  };
}

interface NumericDistribution {
  count: number;
  p50: number;
  p90: number;
  p95: number;
  max: number;
}

type ScriptComponent = "han" | "hiragana" | "katakana" | "latin" | "number";

interface DeltaInterval {
  estimate: number;
  lower: number;
  upper: number;
  crossesZero: boolean;
}

interface OcrStrategyReport {
  policy: OcrArbitrationPolicy;
  overall: OcrArbitrationMetrics;
  byPageCategory: Array<{ stratum: string; metrics: OcrArbitrationMetrics }>;
  byBubbleRelation: Array<{ stratum: BubbleRelation; metrics: OcrArbitrationMetrics }>;
  selectionCounts: Array<{ reason: SelectionReason; count: number }>;
  bootstrapComparisons: Array<{
    baselinePolicy: "always-paddle" | "always-manga";
    exactRateDelta: DeltaInterval;
    corpusCerDelta: DeltaInterval;
  }>;
  structuralNegativeSafety: {
    exactNotWorseThanPaddle: boolean;
    corpusCerNotWorseThanPaddle: boolean;
    passed: boolean;
  };
  freezeGate: {
    simultaneousPointImprovementOverBoth: boolean;
    confidenceIntervalsExcludeZeroInImprovementDirection: boolean;
    structuralNegativeSafetyPassed: boolean;
    passed: boolean;
  };
}

type SelectionReason = "fixed-paddle" | "fixed-manga" | "normalized-agreement" | "sole-safe-paddle" | "sole-safe-manga" | "category-bubble" | "category" | "bubble" | "global" | "paddle-fallback" | "no-safe-candidate";

interface JoinedRegion {
  benchmark: OcrBenchmarkRegion;
  routing: RoutingRegressionObservation;
  bubbleRelation?: BubbleRelation;
}

interface CandidateState {
  candidate?: OcrBenchmarkCandidate;
  normalized: string;
  hardReasons: HardCandidateAnomaly[];
  safe: boolean;
}

interface EvaluationUnit {
  pageId: string;
  category: string;
  bubbleRelation: BubbleRelation;
  regionId: string;
  expected: string;
  expectedLength: number;
  paddle: CandidateState;
  manga: CandidateState;
}

interface Prediction {
  text: string;
  reason: SelectionReason;
}

interface TrainingModel {
  categoryBubble: Map<string, string>;
  category: Map<string, string>;
  bubble: Map<string, string>;
  global?: string;
}

interface TrainingStats {
  support: number;
  paddleExactErrors: number;
  mangaExactErrors: number;
  paddleEditDistance: number;
  mangaEditDistance: number;
  goldCharacters: number;
}

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_REVISION = /^[a-f0-9]{40}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const POLICIES: OcrArbitrationPolicy[] = ["always-paddle", "always-manga", "agreement-category", "agreement-category-bubble"];
const HARD_ANOMALIES: HardCandidateAnomaly[] = ["candidate-missing", "normalized-empty", "replacement-character", "unpaired-surrogate", "forbidden-control", "bidi-control"];
const SCRIPT_COMPONENTS: ScriptComponent[] = ["han", "hiragana", "katakana", "latin", "number"];
const SPEC_FIELDS = new Set(["schemaVersion", "evaluationId", "baseCodeRevision", "sources", "engines", "minimumGroupSupport", "bootstrap"]);
const SOURCE_FIELDS = new Set(["benchmarkInput", "baselineReport", "routingObservations"]);
const PIN_FIELDS = new Set(["sha256", "byteLength"]);
const ENGINE_FIELDS = new Set(["paddle", "manga"]);
const BOOTSTRAP_FIELDS = new Set(["seed", "replicates", "confidenceLevel"]);

function invalid(message: string): never {
  throw new LocalizerError("OCR_ARBITRATION_CONTRACT_INVALID", message);
}

export function assertOcrPredictionCompleteness(predictions: readonly unknown[], expectedCount: number): void {
  if (!Array.isArray(predictions) || !Number.isInteger(expectedCount) || expectedCount < 0 || predictions.length !== expectedCount) {
    invalid("strategy prediction count does not match the fixed denominator");
  }
  for (let index = 0; index < expectedCount; index += 1) {
    if (!(index in predictions) || predictions[index] === undefined) invalid("leave-one-page-out evaluation did not produce complete predictions");
  }
}

function completePredictions(slots: Array<Prediction | undefined>, expectedCount: number): Prediction[] {
  assertOcrPredictionCompleteness(slots, expectedCount);
  const complete: Prediction[] = [];
  for (let index = 0; index < expectedCount; index += 1) complete.push(slots[index]!);
  return complete;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new LocalizerError("OCR_ARBITRATION_JSON_INVALID", `${label} must be UTF-8 JSON`, { cause: error });
  }
}

function assertOnlyFields(value: Record<string, unknown>, fields: Set<string>, label: string): void {
  for (const key of Object.keys(value)) if (!fields.has(key)) invalid(`${label} contains an unsupported field`);
}

function safeIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) invalid(`${label} must be a safe identifier`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) invalid(`${label} must be a positive integer`);
  return value;
}

function parsePin(value: unknown, label: string): OcrArbitrationSourcePin {
  const pin = record(value, label);
  assertOnlyFields(pin, PIN_FIELDS, label);
  if (typeof pin.sha256 !== "string" || !SHA256.test(pin.sha256)) invalid(`${label} sha256 is invalid`);
  return { sha256: pin.sha256, byteLength: positiveInteger(pin.byteLength, `${label} byteLength`) };
}

function parseSpec(value: unknown): OcrArbitrationEvaluationSpec {
  const spec = record(value, "OCR arbitration spec");
  assertOnlyFields(spec, SPEC_FIELDS, "OCR arbitration spec");
  if (spec.schemaVersion !== 1) invalid("OCR arbitration spec schemaVersion must be 1");
  const evaluationId = safeIdentifier(spec.evaluationId, "evaluationId");
  if (typeof spec.baseCodeRevision !== "string" || !GIT_REVISION.test(spec.baseCodeRevision)) invalid("baseCodeRevision must be a lowercase Git commit hash");
  const sources = record(spec.sources, "OCR arbitration sources");
  assertOnlyFields(sources, SOURCE_FIELDS, "OCR arbitration sources");
  const engines = record(spec.engines, "OCR arbitration engines");
  assertOnlyFields(engines, ENGINE_FIELDS, "OCR arbitration engines");
  const paddle = safeIdentifier(engines.paddle, "Paddle engine");
  const manga = safeIdentifier(engines.manga, "Manga engine");
  if (paddle === manga) invalid("OCR arbitration engines must be distinct");
  const bootstrap = record(spec.bootstrap, "OCR arbitration bootstrap");
  assertOnlyFields(bootstrap, BOOTSTRAP_FIELDS, "OCR arbitration bootstrap");
  const seed = positiveInteger(bootstrap.seed, "bootstrap seed");
  if (seed > 0xffffffff) invalid("bootstrap seed must fit uint32");
  const replicates = positiveInteger(bootstrap.replicates, "bootstrap replicates");
  if (replicates < 100 || replicates > 100000) invalid("bootstrap replicates must be between 100 and 100000");
  if (bootstrap.confidenceLevel !== 0.95) invalid("bootstrap confidenceLevel must be 0.95");
  return {
    schemaVersion: 1,
    evaluationId,
    baseCodeRevision: spec.baseCodeRevision,
    sources: {
      benchmarkInput: parsePin(sources.benchmarkInput, "benchmark input pin"),
      baselineReport: parsePin(sources.baselineReport, "baseline report pin"),
      routingObservations: parsePin(sources.routingObservations, "routing observations pin"),
    },
    engines: { paddle, manga },
    minimumGroupSupport: positiveInteger(spec.minimumGroupSupport, "minimumGroupSupport"),
    bootstrap: { seed, replicates, confidenceLevel: 0.95 },
  };
}

function assertPinned(bytes: Uint8Array, pin: OcrArbitrationSourcePin, label: string): void {
  if (bytes.byteLength !== pin.byteLength || sha256Bytes(bytes) !== pin.sha256) invalid(`${label} does not match its fixed SHA-256 and byte length`);
}

export function inspectOcrCandidate(candidate: OcrBenchmarkCandidate | undefined): CandidateState {
  const inspected = inspectOcrText(candidate?.text);
  return { ...(candidate ? { candidate } : {}), normalized: inspected.normalized, hardReasons: inspected.hardReasons, safe: inspected.safe };
}

function editDistanceNormalized(left: string, right: string): number {
  const leftChars = [...left];
  const rightChars = [...right];
  let previous = Array.from({ length: rightChars.length + 1 }, (_, index) => index);
  for (let row = 1; row <= leftChars.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= rightChars.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (leftChars[row - 1] === rightChars[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[rightChars.length];
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function quantile(values: number[], probability: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(probability * sorted.length) - 1);
  return sorted[index];
}

function distribution(values: number[]): NumericDistribution {
  return {
    count: values.length,
    p50: quantile(values, 0.5),
    p90: quantile(values, 0.9),
    p95: quantile(values, 0.95),
    max: values.length === 0 ? 0 : Math.max(...values),
  };
}

function candidateFor(region: OcrBenchmarkRegion, engine: string): OcrBenchmarkCandidate | undefined {
  return region.candidates.find((candidate) => candidate.engine === engine);
}

function joinInputs(benchmark: OcrBenchmarkInput, routing: RoutingRegressionInput): JoinedRegion[] {
  evaluateRoutingRegression(routing);
  const routingById = new Map<string, RoutingRegressionObservation>();
  for (const observation of routing.observations) {
    if (routingById.has(observation.id)) invalid("routing observations contain duplicate region identifiers");
    routingById.set(observation.id, observation);
  }
  if (routingById.size !== benchmark.regions.length) invalid("benchmark and routing region populations differ");
  const joined: JoinedRegion[] = [];
  for (const region of benchmark.regions) {
    const observation = routingById.get(region.id);
    if (!observation) invalid("routing observations do not completely cover the benchmark");
    if (observation.pageId !== region.pageId || observation.pageOrder !== region.pageOrder || observation.category !== region.category
      || observation.detected !== (region.detectionStatus === "detected")) invalid("benchmark and routing region metadata conflict");
    let bubbleRelation: BubbleRelation | undefined;
    if (observation.evidence?.insideBubble === true) bubbleRelation = "bubble-contained";
    else if (observation.evidence?.insideBubble === false) bubbleRelation = "bubble-external";
    if (region.ocrEligibility === "eligible" && bubbleRelation === undefined) invalid("eligible OCR region lacks a deterministic bubble relationship");
    joined.push({ benchmark: region, routing: observation, ...(bubbleRelation ? { bubbleRelation } : {}) });
    routingById.delete(region.id);
  }
  if (routingById.size !== 0) invalid("routing observations contain regions outside the benchmark");
  return joined;
}

function makeUnits(joined: JoinedRegion[], paddleEngine: string, mangaEngine: string): EvaluationUnit[] {
  return joined.filter(({ benchmark }) => benchmark.detectionStatus === "detected" && benchmark.ocrEligibility === "eligible").map(({ benchmark, bubbleRelation }) => {
    const expected = normalizeOcrText(benchmark.expectedOcr!);
    return {
      pageId: benchmark.pageId,
      category: benchmark.category,
      bubbleRelation: bubbleRelation!,
      regionId: benchmark.id,
      expected,
      expectedLength: [...expected].length,
      paddle: inspectOcrCandidate(candidateFor(benchmark, paddleEngine)),
      manga: inspectOcrCandidate(candidateFor(benchmark, mangaEngine)),
    };
  });
}

function emptyTrainingStats(): TrainingStats {
  return { support: 0, paddleExactErrors: 0, mangaExactErrors: 0, paddleEditDistance: 0, mangaEditDistance: 0, goldCharacters: 0 };
}

function addTrainingUnit(stats: TrainingStats, unit: EvaluationUnit): void {
  stats.support += 1;
  const paddleDistance = editDistanceNormalized(unit.expected, unit.paddle.normalized);
  const mangaDistance = editDistanceNormalized(unit.expected, unit.manga.normalized);
  stats.paddleExactErrors += paddleDistance === 0 ? 0 : 1;
  stats.mangaExactErrors += mangaDistance === 0 ? 0 : 1;
  stats.paddleEditDistance += paddleDistance;
  stats.mangaEditDistance += mangaDistance;
  stats.goldCharacters += unit.expectedLength;
}

function preferredEngine(stats: TrainingStats, paddleEngine: string, mangaEngine: string): string {
  const paddleLoss = rate(stats.paddleExactErrors, stats.support) + rate(stats.paddleEditDistance, stats.goldCharacters);
  const mangaLoss = rate(stats.mangaExactErrors, stats.support) + rate(stats.mangaEditDistance, stats.goldCharacters);
  return mangaLoss < paddleLoss ? mangaEngine : paddleEngine;
}

function buildTrainingModel(units: EvaluationUnit[], minimumSupport: number, paddleEngine: string, mangaEngine: string): TrainingModel {
  const categoryBubbleStats = new Map<string, TrainingStats>();
  const categoryStats = new Map<string, TrainingStats>();
  const bubbleStats = new Map<string, TrainingStats>();
  const globalStats = emptyTrainingStats();
  const disagreements = units.filter((unit) => unit.paddle.safe && unit.manga.safe && unit.paddle.normalized !== unit.manga.normalized);
  for (const unit of disagreements) {
    const categoryBubbleKey = `${unit.category}\u0000${unit.bubbleRelation}`;
    const category = categoryBubbleStats.get(categoryBubbleKey) ?? emptyTrainingStats();
    const pageCategory = categoryStats.get(unit.category) ?? emptyTrainingStats();
    const bubble = bubbleStats.get(unit.bubbleRelation) ?? emptyTrainingStats();
    addTrainingUnit(category, unit);
    addTrainingUnit(pageCategory, unit);
    addTrainingUnit(bubble, unit);
    addTrainingUnit(globalStats, unit);
    categoryBubbleStats.set(categoryBubbleKey, category);
    categoryStats.set(unit.category, pageCategory);
    bubbleStats.set(unit.bubbleRelation, bubble);
  }
  const eligibleChoices = (stats: Map<string, TrainingStats>): Map<string, string> => new Map(
    [...stats.entries()].filter(([, value]) => value.support >= minimumSupport).map(([key, value]) => [key, preferredEngine(value, paddleEngine, mangaEngine)]),
  );
  return {
    categoryBubble: eligibleChoices(categoryBubbleStats),
    category: eligibleChoices(categoryStats),
    bubble: eligibleChoices(bubbleStats),
    ...(globalStats.support >= minimumSupport ? { global: preferredEngine(globalStats, paddleEngine, mangaEngine) } : {}),
  };
}

function selectAdaptive(unit: EvaluationUnit, policy: OcrArbitrationPolicy, model: TrainingModel, paddleEngine: string, mangaEngine: string): Prediction {
  if (unit.paddle.safe && unit.manga.safe && unit.paddle.normalized === unit.manga.normalized) {
    return { text: unit.paddle.candidate!.text, reason: "normalized-agreement" };
  }
  if (unit.paddle.safe && !unit.manga.safe) return { text: unit.paddle.candidate!.text, reason: "sole-safe-paddle" };
  if (!unit.paddle.safe && unit.manga.safe) return { text: unit.manga.candidate!.text, reason: "sole-safe-manga" };
  if (!unit.paddle.safe && !unit.manga.safe) return { text: "", reason: "no-safe-candidate" };
  let selectedEngine: string | undefined;
  let reason: SelectionReason | undefined;
  if (policy === "agreement-category-bubble") {
    selectedEngine = model.categoryBubble.get(`${unit.category}\u0000${unit.bubbleRelation}`);
    if (selectedEngine) reason = "category-bubble";
  }
  if (!selectedEngine) {
    selectedEngine = model.category.get(unit.category);
    if (selectedEngine) reason = "category";
  }
  if (!selectedEngine && policy === "agreement-category-bubble") {
    selectedEngine = model.bubble.get(unit.bubbleRelation);
    if (selectedEngine) reason = "bubble";
  }
  if (!selectedEngine && model.global) {
    selectedEngine = model.global;
    reason = "global";
  }
  if (!selectedEngine) {
    selectedEngine = paddleEngine;
    reason = "paddle-fallback";
  }
  return selectedEngine === mangaEngine
    ? { text: unit.manga.candidate!.text, reason: reason! }
    : { text: unit.paddle.candidate!.text, reason: reason! };
}

function fixedPrediction(unit: EvaluationUnit, policy: OcrArbitrationPolicy): Prediction {
  if (policy === "always-paddle") return { text: unit.paddle.candidate?.text ?? "", reason: "fixed-paddle" };
  return { text: unit.manga.candidate?.text ?? "", reason: "fixed-manga" };
}

function evaluatePredictions(units: EvaluationUnit[], predictions: Prediction[], indexes = units.map((_, index) => index)): OcrArbitrationMetrics {
  if (units.length !== predictions.length) invalid("prediction count does not match the eligible benchmark denominator");
  let exactRegions = 0;
  let goldCharacters = 0;
  let totalEditDistance = 0;
  let cerAtMost3PercentRegions = 0;
  const regionCers: number[] = [];
  for (const index of indexes) {
    const unit = units[index];
    const selected = normalizeOcrText(predictions[index].text);
    const distance = editDistanceNormalized(unit.expected, selected);
    const regionCer = distance / unit.expectedLength;
    if (distance === 0) exactRegions += 1;
    if (regionCer <= 0.03) cerAtMost3PercentRegions += 1;
    goldCharacters += unit.expectedLength;
    totalEditDistance += distance;
    regionCers.push(regionCer);
  }
  return {
    regionCount: indexes.length,
    exactRegions,
    exactRate: rate(exactRegions, indexes.length),
    goldCharacters,
    editDistance: totalEditDistance,
    corpusCer: rate(totalEditDistance, goldCharacters),
    regionMacroCer: rate(regionCers.reduce((sum, value) => sum + value, 0), regionCers.length),
    p50Cer: quantile(regionCers, 0.5),
    p90Cer: quantile(regionCers, 0.9),
    p95Cer: quantile(regionCers, 0.95),
    maxCer: regionCers.length === 0 ? 0 : Math.max(...regionCers),
    cerAtMost3PercentRegions,
    cerAtMost3PercentRate: rate(cerAtMost3PercentRegions, indexes.length),
  };
}

function strataMetrics(units: EvaluationUnit[], predictions: Prediction[], field: "category" | "bubbleRelation"): Array<{ stratum: string; metrics: OcrArbitrationMetrics }> {
  const strata = new Map<string, number[]>();
  units.forEach((unit, index) => {
    const key = unit[field];
    const indexes = strata.get(key) ?? [];
    indexes.push(index);
    strata.set(key, indexes);
  });
  return [...strata.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([stratum, indexes]) => ({
    stratum,
    metrics: evaluatePredictions(units, predictions, indexes),
  }));
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrapComparisons(
  units: EvaluationUnit[],
  predictionsByPolicy: Map<OcrArbitrationPolicy, Prediction[]>,
  pageIndexes: number[][],
  spec: OcrArbitrationEvaluationSpec,
  overallByPolicy: Map<OcrArbitrationPolicy, OcrArbitrationMetrics>,
): Map<OcrArbitrationPolicy, OcrStrategyReport["bootstrapComparisons"]> {
  const random = mulberry32(spec.bootstrap.seed);
  const samples = Array.from({ length: spec.bootstrap.replicates }, () => Array.from(
    { length: pageIndexes.length },
    () => Math.floor(random() * pageIndexes.length),
  ));
  const totals = new Map<OcrArbitrationPolicy, Array<{ regions: number; exact: number; gold: number; edits: number }>>();
  for (const policy of POLICIES) {
    const predictions = predictionsByPolicy.get(policy)!;
    totals.set(policy, pageIndexes.map((indexes) => {
      const metrics = evaluatePredictions(units, predictions, indexes);
      return { regions: metrics.regionCount, exact: metrics.exactRegions, gold: metrics.goldCharacters, edits: metrics.editDistance };
    }));
  }
  const result = new Map<OcrArbitrationPolicy, OcrStrategyReport["bootstrapComparisons"]>();
  for (const policy of POLICIES) {
    const comparisons: OcrStrategyReport["bootstrapComparisons"] = [];
    for (const baselinePolicy of ["always-paddle", "always-manga"] as const) {
      const exactDeltas: number[] = [];
      const cerDeltas: number[] = [];
      for (const sample of samples) {
        let policyRegions = 0;
        let policyExact = 0;
        let policyGold = 0;
        let policyEdits = 0;
        let baselineRegions = 0;
        let baselineExact = 0;
        let baselineGold = 0;
        let baselineEdits = 0;
        for (const pageIndex of sample) {
          const policyTotal = totals.get(policy)![pageIndex];
          const baselineTotal = totals.get(baselinePolicy)![pageIndex];
          policyRegions += policyTotal.regions;
          policyExact += policyTotal.exact;
          policyGold += policyTotal.gold;
          policyEdits += policyTotal.edits;
          baselineRegions += baselineTotal.regions;
          baselineExact += baselineTotal.exact;
          baselineGold += baselineTotal.gold;
          baselineEdits += baselineTotal.edits;
        }
        exactDeltas.push(rate(policyExact, policyRegions) - rate(baselineExact, baselineRegions));
        cerDeltas.push(rate(policyEdits, policyGold) - rate(baselineEdits, baselineGold));
      }
      const confidenceTail = (1 - spec.bootstrap.confidenceLevel) / 2;
      const exactLower = quantile(exactDeltas, confidenceTail);
      const exactUpper = quantile(exactDeltas, 1 - confidenceTail);
      const cerLower = quantile(cerDeltas, confidenceTail);
      const cerUpper = quantile(cerDeltas, 1 - confidenceTail);
      comparisons.push({
        baselinePolicy,
        exactRateDelta: {
          estimate: overallByPolicy.get(policy)!.exactRate - overallByPolicy.get(baselinePolicy)!.exactRate,
          lower: exactLower,
          upper: exactUpper,
          crossesZero: exactLower <= 0 && exactUpper >= 0,
        },
        corpusCerDelta: {
          estimate: overallByPolicy.get(policy)!.corpusCer - overallByPolicy.get(baselinePolicy)!.corpusCer,
          lower: cerLower,
          upper: cerUpper,
          crossesZero: cerLower <= 0 && cerUpper >= 0,
        },
      });
    }
    result.set(policy, comparisons);
  }
  return result;
}

function maximumRepeatedRun(text: string): number {
  const characters = [...text];
  let maximum = 0;
  let current = 0;
  let previous: string | undefined;
  for (const character of characters) {
    current = character === previous ? current + 1 : 1;
    previous = character;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

function hasRepeatedBlockSignal(text: string): boolean {
  const characters = [...text];
  for (let blockSize = 1; blockSize <= Math.min(8, Math.floor(characters.length / 3)); blockSize += 1) {
    for (let start = 0; start + blockSize * 3 <= characters.length; start += 1) {
      const first = characters.slice(start, start + blockSize).join("");
      const second = characters.slice(start + blockSize, start + blockSize * 2).join("");
      const third = characters.slice(start + blockSize * 2, start + blockSize * 3).join("");
      if (first === second && second === third) return true;
    }
  }
  return false;
}

function scripts(text: string): Set<ScriptComponent> {
  const result = new Set<ScriptComponent>();
  if (/\p{Script=Han}/u.test(text)) result.add("han");
  if (/\p{Script=Hiragana}/u.test(text)) result.add("hiragana");
  if (/\p{Script=Katakana}/u.test(text)) result.add("katakana");
  if (/\p{Script=Latin}/u.test(text)) result.add("latin");
  if (/\p{Number}/u.test(text)) result.add("number");
  return result;
}

function softDiagnostics(units: EvaluationUnit[], paddleEngine: string, mangaEngine: string): OcrArbitrationReport["softDiagnostics"] {
  const candidateDiagnostics = ([{ engine: paddleEngine, key: "paddle" }, { engine: mangaEngine, key: "manga" }] as const).map(({ engine, key }) => {
    const present = units.map((unit) => unit[key]).filter((state) => state.candidate !== undefined);
    return {
      engine,
      availableRegions: present.length,
      normalizedLength: distribution(present.map((state) => [...state.normalized].length)),
      maximumRepeatedRun: distribution(present.map((state) => maximumRepeatedRun(state.normalized))),
      repeatedBlockSignalRegions: present.filter((state) => hasRepeatedBlockSignal(state.normalized)).length,
    };
  });
  const paired = units.filter((unit) => unit.paddle.candidate && unit.manga.candidate);
  const ratios = paired.map((unit) => {
    const paddleLength = [...unit.paddle.normalized].length;
    const mangaLength = [...unit.manga.normalized].length;
    const shorter = Math.min(paddleLength, mangaLength);
    const longer = Math.max(paddleLength, mangaLength);
    return shorter === 0 ? 0 : longer / shorter;
  });
  const scriptComponentLoss = SCRIPT_COMPONENTS.map((script) => {
    let paddleMissingRegions = 0;
    let mangaMissingRegions = 0;
    for (const unit of paired) {
      const paddleScripts = scripts(unit.paddle.normalized);
      const mangaScripts = scripts(unit.manga.normalized);
      if (!paddleScripts.has(script) && mangaScripts.has(script)) paddleMissingRegions += 1;
      if (!mangaScripts.has(script) && paddleScripts.has(script)) mangaMissingRegions += 1;
    }
    return { script, paddleMissingRegions, mangaMissingRegions };
  });
  return {
    usedForSelection: false,
    candidates: candidateDiagnostics,
    pair: { pairedRegions: paired.length, normalizedLengthRatio: distribution(ratios), scriptComponentLoss },
  };
}

function regionRef(regionId: string): string {
  return sha256Bytes(Buffer.from(`ocr-m3.2-region:${regionId}`, "utf8"));
}

function qaReport(units: EvaluationUnit[], baseline: OcrBenchmarkReport, paddleEngine: string, mangaEngine: string): OcrArbitrationReport["qa"] {
  const counts = new Map<string, number>();
  const hardCandidateResiduals: OcrArbitrationReport["qa"]["hardCandidateResiduals"] = [];
  for (const unit of units) {
    for (const { engine, state } of [{ engine: paddleEngine, state: unit.paddle }, { engine: mangaEngine, state: unit.manga }]) {
      for (const reason of state.hardReasons) counts.set(`${engine}\u0000${reason}`, (counts.get(`${engine}\u0000${reason}`) ?? 0) + 1);
      if (state.hardReasons.length > 0) hardCandidateResiduals.push({ regionRef: regionRef(unit.regionId), engine, reasons: state.hardReasons });
    }
  }
  const hardCandidateAnomalyCounts = [paddleEngine, mangaEngine].flatMap((engine) => HARD_ANOMALIES.map((reason) => ({
    engine,
    reason,
    count: counts.get(`${engine}\u0000${reason}`) ?? 0,
  })));
  const jointWrongAgreementResiduals = units.filter((unit) => unit.paddle.candidate && unit.manga.candidate
    && unit.paddle.normalized === unit.manga.normalized && unit.paddle.normalized !== unit.expected).map((unit) => ({ regionRef: regionRef(unit.regionId) }));
  if (jointWrongAgreementResiduals.length !== baseline.pair.agreementJointWrong) invalid("joint-wrong agreement residual count conflicts with the fixed baseline");
  return {
    hardCandidateAnomalyCounts,
    hardCandidateResiduals,
    jointWrongAgreementCount: jointWrongAgreementResiduals.length,
    jointWrongAgreementResiduals,
  };
}

function verifyFixedBaselines(
  metrics: Map<OcrArbitrationPolicy, OcrArbitrationMetrics>,
  baseline: OcrBenchmarkReport,
  paddleEngine: string,
  mangaEngine: string,
): void {
  for (const { policy, engine } of [{ policy: "always-paddle" as const, engine: paddleEngine }, { policy: "always-manga" as const, engine: mangaEngine }]) {
    const expected = baseline.candidates.find((candidate) => candidate.engine === engine);
    const actual = metrics.get(policy)!;
    if (!expected || actual.regionCount !== expected.eligibleRegions || actual.exactRegions !== expected.normalizedExact
      || actual.goldCharacters !== expected.eligibleGoldCharacters || actual.editDistance !== expected.coverageAdjustedEditDistance) {
      invalid("fixed policy metrics do not reproduce the pinned baseline report");
    }
  }
}

export function evaluateOcrArbitration(
  benchmarkInputBytes: Uint8Array,
  baselineReportBytes: Uint8Array,
  routingObservationsBytes: Uint8Array,
  specValue: unknown,
): OcrArbitrationReport {
  const spec = parseSpec(specValue);
  assertPinned(benchmarkInputBytes, spec.sources.benchmarkInput, "benchmark input");
  assertPinned(baselineReportBytes, spec.sources.baselineReport, "baseline report");
  assertPinned(routingObservationsBytes, spec.sources.routingObservations, "routing observations");
  const benchmark = parseJson(benchmarkInputBytes, "benchmark input") as OcrBenchmarkInput;
  const baseline = record(parseJson(baselineReportBytes, "baseline report"), "baseline report") as unknown as OcrBenchmarkReport;
  const routing = parseJson(routingObservationsBytes, "routing observations") as RoutingRegressionInput;
  const recalculatedBaseline = evaluateOcrBaseline(benchmark, [spec.engines.paddle, spec.engines.manga]);
  if (!isDeepStrictEqual(baseline, recalculatedBaseline)) invalid("pinned baseline report does not exactly match a fresh in-memory recalculation");
  if (baseline.pair.leftEngine !== spec.engines.paddle || baseline.pair.rightEngine !== spec.engines.manga) invalid("fixed baseline engine order conflicts with the arbitration spec");
  const eligibleEngines = new Set(benchmark.regions.filter((region) => region.ocrEligibility === "eligible").flatMap((region) => region.candidates.map((candidate) => candidate.engine)));
  if (eligibleEngines.size !== 2 || !eligibleEngines.has(spec.engines.paddle) || !eligibleEngines.has(spec.engines.manga)) invalid("benchmark candidates are outside the two predeclared engines");
  const joined = joinInputs(benchmark, routing);
  const units = makeUnits(joined, spec.engines.paddle, spec.engines.manga);
  if (units.length !== baseline.denominators.ocrEligibleDetectedRegions) invalid("eligible region denominator conflicts with the fixed baseline");

  const allPageIds = [...new Set(joined.map(({ benchmark: region }) => region.pageId))].sort();
  const pageIds = [...new Set(units.map((unit) => unit.pageId))].sort();
  const predictionSlotsByPolicy = new Map<OcrArbitrationPolicy, Array<Prediction | undefined>>(POLICIES.map((policy) => [
    policy,
    Array.from({ length: units.length }, () => undefined),
  ]));
  const testSizes: number[] = [];
  for (const heldPageId of allPageIds) {
    const training = units.filter((unit) => unit.pageId !== heldPageId);
    if (training.some((unit) => unit.pageId === heldPageId)) invalid("leave-one-page-out training leakage detected");
    const model = buildTrainingModel(training, spec.minimumGroupSupport, spec.engines.paddle, spec.engines.manga);
    const testIndexes = units.map((unit, index) => ({ unit, index })).filter(({ unit }) => unit.pageId === heldPageId);
    testSizes.push(testIndexes.length);
    for (const { unit, index } of testIndexes) {
      predictionSlotsByPolicy.get("always-paddle")![index] = fixedPrediction(unit, "always-paddle");
      predictionSlotsByPolicy.get("always-manga")![index] = fixedPrediction(unit, "always-manga");
      predictionSlotsByPolicy.get("agreement-category")![index] = selectAdaptive(unit, "agreement-category", model, spec.engines.paddle, spec.engines.manga);
      predictionSlotsByPolicy.get("agreement-category-bubble")![index] = selectAdaptive(unit, "agreement-category-bubble", model, spec.engines.paddle, spec.engines.manga);
    }
  }
  const fixedDenominator = baseline.denominators.ocrEligibleDetectedRegions;
  const predictionsByPolicy = new Map<OcrArbitrationPolicy, Prediction[]>(POLICIES.map((policy) => [
    policy,
    completePredictions(predictionSlotsByPolicy.get(policy)!, fixedDenominator),
  ]));

  const overallByPolicy = new Map<OcrArbitrationPolicy, OcrArbitrationMetrics>(POLICIES.map((policy) => [policy, evaluatePredictions(units, predictionsByPolicy.get(policy)!)]));
  verifyFixedBaselines(overallByPolicy, baseline, spec.engines.paddle, spec.engines.manga);
  const pageIndexes = pageIds.map((pageId) => units.map((unit, index) => ({ unit, index })).filter(({ unit }) => unit.pageId === pageId).map(({ index }) => index));
  const comparisons = bootstrapComparisons(units, predictionsByPolicy, pageIndexes, spec, overallByPolicy);
  const paddleStructural = strataMetrics(units, predictionsByPolicy.get("always-paddle")!, "category").find(({ stratum }) => stratum === "structural-negative")?.metrics;
  if (!paddleStructural) invalid("structural-negative stratum is absent from the eligible benchmark");

  const strategies: OcrStrategyReport[] = POLICIES.map((policy) => {
    const predictions = predictionsByPolicy.get(policy)!;
    const byPageCategory = strataMetrics(units, predictions, "category");
    const byBubbleRelation = strataMetrics(units, predictions, "bubbleRelation") as OcrStrategyReport["byBubbleRelation"];
    const structural = byPageCategory.find(({ stratum }) => stratum === "structural-negative")?.metrics;
    if (!structural) invalid("strategy is missing structural-negative metrics");
    const exactNotWorseThanPaddle = structural.exactRate >= paddleStructural.exactRate;
    const corpusCerNotWorseThanPaddle = structural.corpusCer <= paddleStructural.corpusCer;
    const bootstrap = comparisons.get(policy)!;
    const simultaneousPointImprovementOverBoth = bootstrap.every((comparison) => comparison.exactRateDelta.estimate > 0 && comparison.corpusCerDelta.estimate < 0);
    const confidenceIntervalsExcludeZeroInImprovementDirection = bootstrap.every((comparison) => comparison.exactRateDelta.lower > 0 && comparison.corpusCerDelta.upper < 0);
    const adaptive = policy === "agreement-category" || policy === "agreement-category-bubble";
    const structuralNegativeSafetyPassed = exactNotWorseThanPaddle && corpusCerNotWorseThanPaddle;
    const selectionCounts = [...new Set(predictions.map(({ reason }) => reason))].sort().map((reason) => ({ reason, count: predictions.filter((prediction) => prediction.reason === reason).length }));
    const selectionCountTotal = selectionCounts.reduce((sum, item) => sum + item.count, 0);
    if (predictions.length !== fixedDenominator || overallByPolicy.get(policy)!.regionCount !== fixedDenominator || selectionCountTotal !== fixedDenominator) {
      invalid("strategy prediction accounting does not match the fixed denominator");
    }
    return {
      policy,
      overall: overallByPolicy.get(policy)!,
      byPageCategory,
      byBubbleRelation,
      selectionCounts,
      bootstrapComparisons: bootstrap,
      structuralNegativeSafety: { exactNotWorseThanPaddle, corpusCerNotWorseThanPaddle, passed: structuralNegativeSafetyPassed },
      freezeGate: {
        simultaneousPointImprovementOverBoth,
        confidenceIntervalsExcludeZeroInImprovementDirection,
        structuralNegativeSafetyPassed,
        passed: adaptive && simultaneousPointImprovementOverBoth && confidenceIntervalsExcludeZeroInImprovementDirection && structuralNegativeSafetyPassed,
      },
    };
  });
  const selected = (["agreement-category", "agreement-category-bubble"] as const).find((policy) => strategies.find((strategy) => strategy.policy === policy)!.freezeGate.passed);
  const adaptiveStrategies = strategies.filter(({ policy }) => policy === "agreement-category" || policy === "agreement-category-bubble");
  const reasons: string[] = [];
  if (!selected) {
    if (adaptiveStrategies.every(({ freezeGate }) => !freezeGate.simultaneousPointImprovementOverBoth)) reasons.push("POINT_ESTIMATES_NOT_SIMULTANEOUSLY_BETTER_THAN_BOTH_BASELINES");
    if (adaptiveStrategies.every(({ freezeGate }) => !freezeGate.confidenceIntervalsExcludeZeroInImprovementDirection)) reasons.push("BOOTSTRAP_INTERVALS_DO_NOT_EXCLUDE_ZERO");
    if (adaptiveStrategies.every(({ freezeGate }) => !freezeGate.structuralNegativeSafetyPassed)) reasons.push("STRUCTURAL_NEGATIVE_WORSE_THAN_PADDLE");
    reasons.push("NO_PREDECLARED_POLICY_PASSED_ALL_GATES");
  }
  return {
    schemaVersion: 1,
    evaluationId: spec.evaluationId,
    source: {
      baseCodeRevision: spec.baseCodeRevision,
      benchmarkInputSha256: spec.sources.benchmarkInput.sha256,
      baselineReportSha256: spec.sources.baselineReport.sha256,
      routingObservationsSha256: spec.sources.routingObservations.sha256,
      benchmarkId: benchmark.benchmarkId,
      routingBenchmarkId: routing.benchmarkId,
    },
    contract: {
      normalization: "NFKC_REMOVE_WHITESPACE",
      crossValidation: "LEAVE_ONE_PAGE_OUT",
      trainingObjective: "EXACT_ERROR_RATE_PLUS_CORPUS_CER",
      hardAnomalies: HARD_ANOMALIES,
      softDiagnosticsUsedForSelection: false,
      policies: POLICIES,
      minimumGroupSupport: spec.minimumGroupSupport,
      fallbackHierarchy: {
        agreementCategory: ["normalized-agreement", "sole-safe-candidate", "category", "global", "paddle-fallback"],
        agreementCategoryBubble: ["normalized-agreement", "sole-safe-candidate", "category-bubble", "category", "bubble", "global", "paddle-fallback"],
      },
      bootstrap: spec.bootstrap,
    },
    association: {
      benchmarkRegions: benchmark.regions.length,
      routingObservations: routing.observations.length,
      matchedRegions: joined.length,
      eligibleRegions: units.length,
      pageCount: allPageIds.length,
      evaluatedPageCount: pageIds.length,
    },
    denominators: baseline.denominators,
    crossValidation: {
      foldCount: allPageIds.length,
      minimumTrainingPages: Math.max(0, allPageIds.length - 1),
      maximumTrainingPages: Math.max(0, allPageIds.length - 1),
      minimumTestRegions: Math.min(...testSizes),
      maximumTestRegions: Math.max(...testSizes),
    },
    qa: qaReport(units, baseline, spec.engines.paddle, spec.engines.manga),
    softDiagnostics: softDiagnostics(units, spec.engines.paddle, spec.engines.manga),
    strategies,
    decision: selected
      ? { status: "FREEZE", selectedPolicy: selected, reasons: ["ALL_PREDECLARED_GATES_PASSED"] }
      : { status: "DO_NOT_FREEZE", reasons },
  };
}
