import { readFile } from "node:fs/promises";
import path from "node:path";
import { LocalizerError } from "./errors.ts";
import { createUniqueDirectory, writeJsonExclusive } from "./file-utils.ts";
import { looksLikeRefusal } from "./quality.ts";
import { assertSchema } from "./schema.ts";
import type { BenchmarkMetrics, BoundingBox, LockedModel, ModelLock } from "./types.ts";

interface GoldenRegion {
  id: string;
  pageId: string;
  expectedOcr: string;
  expectedTranslation?: string;
  bbox?: BoundingBox;
  nonRefusalRequired?: boolean;
}

interface GoldenDataset {
  schemaVersion: 1;
  benchmarkId: string;
  koharuVersion: string;
  availableVramMiB: number;
  regions: GoldenRegion[];
  candidates: Array<{
    id: string;
    resultsFile: string;
    model: Omit<LockedModel, "selected">;
  }>;
}

interface CandidateRegion {
  id?: string;
  pageId: string;
  detected: boolean;
  ocrText?: string;
  translation?: string;
  bbox?: BoundingBox;
  semanticUsable?: boolean;
  termsCorrect?: boolean;
  layoutOk?: boolean;
}

interface CandidateResults {
  schemaVersion: 1;
  candidateId: string;
  peakVramMiB?: number;
  formatValid: boolean;
  regions: CandidateRegion[];
  pages?: Array<{ pageId: string; repairLetteringScore?: number }>;
}

export interface BenchmarkCandidateReport {
  id: string;
  metrics: BenchmarkMetrics;
  acceptance: Record<string, boolean>;
}

export interface BenchmarkReport {
  schemaVersion: 1;
  benchmarkId: string;
  generatedAt: string;
  winner: string;
  candidates: BenchmarkCandidateReport[];
}

function normalizedChars(text: string): string[] {
  return [...text.normalize("NFKC").replace(/\s+/g, "")];
}

export function levenshtein(a: string, b: string): number {
  const left = normalizedChars(a);
  const right = normalizedChars(b);
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

export function characterErrorRate(expected: string, actual: string): number {
  const denominator = Math.max(1, normalizedChars(expected).length);
  return levenshtein(expected, actual) / denominator;
}

function iou(a: BoundingBox, b: BoundingBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function matchRegion(golden: GoldenRegion, results: CandidateResults, used: Set<CandidateRegion>): CandidateRegion | undefined {
  const byId = results.regions.find((region) => !used.has(region) && region.id === golden.id);
  if (byId) return byId;
  if (!golden.bbox) return undefined;
  return results.regions
    .filter((region) => !used.has(region) && region.pageId === golden.pageId && region.bbox)
    .map((region) => ({ region, score: iou(golden.bbox!, region.bbox!) }))
    .filter((entry) => entry.score >= 0.5)
    .sort((a, b) => b.score - a.score)[0]?.region;
}

function average(values: number[], empty = 0): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : empty;
}

export function scoreCandidate(golden: GoldenDataset, results: CandidateResults): BenchmarkMetrics {
  const used = new Set<CandidateRegion>();
  const matched = golden.regions.map((reference) => {
    const candidate = matchRegion(reference, results, used);
    if (candidate) used.add(candidate);
    return { reference, candidate };
  });
  const detected = matched.filter(({ candidate }) => candidate?.detected);
  const ocrScores = detected.filter(({ candidate }) => candidate?.ocrText !== undefined).map(({ reference, candidate }) => characterErrorRate(reference.expectedOcr, candidate!.ocrText!));
  const semantic = detected.filter(({ candidate }) => candidate?.semanticUsable !== undefined).map(({ candidate }) => candidate!.semanticUsable ? 1 : 0);
  const terms = detected.filter(({ candidate }) => candidate?.termsCorrect !== undefined).map(({ candidate }) => candidate!.termsCorrect ? 1 : 0);
  const required = matched.filter(({ reference }) => reference.nonRefusalRequired);
  const requiredNonRefusal = required.map(({ candidate }) => candidate?.translation && !looksLikeRefusal(candidate.translation) ? 1 : 0);
  const pages = [...new Set(golden.regions.map((region) => region.pageId))];
  const noEditPages = pages.map((pageId) => {
    const page = matched.filter(({ reference }) => reference.pageId === pageId);
    return page.every(({ reference, candidate }) => candidate?.detected
      && candidate.ocrText !== undefined
      && characterErrorRate(reference.expectedOcr, candidate.ocrText) <= 0.03
      && candidate.semanticUsable === true
      && candidate.termsCorrect !== false
      && candidate.layoutOk === true
      && (!candidate.translation || !looksLikeRefusal(candidate.translation))) ? 1 : 0;
  });
  const repairScores = (results.pages ?? []).map((page) => page.repairLetteringScore).filter((value): value is number => typeof value === "number");
  const detectionRecall = detected.length / Math.max(1, golden.regions.length);
  const ocrCer = average(ocrScores, 1);
  const semanticUsableRate = average(semantic, 0);
  const termConsistency = average(terms, 0);
  const noEditPageRate = average(noEditPages, 0);
  const repairLetteringScore = average(repairScores, 0);
  const requiredNonRefusalRate = required.length === 0 ? 1 : average(requiredNonRefusal, 0);
  const formatValidRate = results.formatValid ? 1 : 0;
  const hardGatePassed = results.formatValid
    && requiredNonRefusalRate === 1
    && (results.peakVramMiB === undefined || results.peakVramMiB <= golden.availableVramMiB)
    && detectionRecall >= 0.95
    && ocrCer <= 0.05
    && semanticUsableRate >= 0.8;
  const weightedScore = 0.15 * detectionRecall
    + 0.15 * Math.max(0, 1 - Math.min(1, ocrCer))
    + 0.35 * semanticUsableRate
    + 0.15 * termConsistency
    + 0.1 * noEditPageRate
    + 0.05 * Math.min(1, repairLetteringScore / 5)
    + 0.05 * formatValidRate;
  return { detectionRecall, ocrCer, semanticUsableRate, termConsistency, noEditPageRate, repairLetteringScore, requiredNonRefusalRate, formatValidRate, peakVramMiB: results.peakVramMiB, weightedScore, hardGatePassed };
}

function acceptance(metrics: BenchmarkMetrics): Record<string, boolean> {
  return {
    detectionRecall: metrics.detectionRecall >= 0.98,
    ocrCer: metrics.ocrCer <= 0.03,
    semanticUsableRate: metrics.semanticUsableRate >= 0.9,
    termConsistency: metrics.termConsistency >= 0.99,
    noEditPageRate: metrics.noEditPageRate >= 0.85,
    repairLetteringScore: metrics.repairLetteringScore >= 4,
    requiredNonRefusalRate: metrics.requiredNonRefusalRate === 1,
    formatValidRate: metrics.formatValidRate === 1,
  };
}

export async function runBenchmark(goldenSetDirectory: string, outputParent: string): Promise<{ directory: string; report: BenchmarkReport; lock: ModelLock }> {
  const goldenPath = path.resolve(goldenSetDirectory, "golden.json");
  const golden = JSON.parse(await readFile(goldenPath, "utf8")) as GoldenDataset;
  if (golden.schemaVersion !== 1 || !golden.benchmarkId || !Array.isArray(golden.regions) || !Array.isArray(golden.candidates) || golden.candidates.length === 0) {
    throw new LocalizerError("GOLDEN_SET_INVALID", "golden.json is missing required version 1 fields");
  }
  const reports: BenchmarkCandidateReport[] = [];
  for (const candidate of golden.candidates) {
    const resultPath = path.resolve(goldenSetDirectory, candidate.resultsFile);
    const relative = path.relative(path.resolve(goldenSetDirectory), resultPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new LocalizerError("BENCHMARK_RESULT_ESCAPE", `Candidate result escapes golden-set directory: ${candidate.resultsFile}`);
    const results = JSON.parse(await readFile(resultPath, "utf8")) as CandidateResults;
    if (results.schemaVersion !== 1 || results.candidateId !== candidate.id || !Array.isArray(results.regions)) throw new LocalizerError("CANDIDATE_RESULT_INVALID", candidate.id);
    const metrics = scoreCandidate(golden, results);
    reports.push({ id: candidate.id, metrics, acceptance: acceptance(metrics) });
  }
  const eligible = reports.filter((report) => report.metrics.hardGatePassed).sort((a, b) => b.metrics.weightedScore - a.metrics.weightedScore || a.id.localeCompare(b.id));
  if (eligible.length === 0) throw new LocalizerError("NO_MODEL_PASSED_HARD_GATES", "No candidate passed VRAM, format, required non-refusal, detection, OCR, and semantic hard gates");
  const winner = eligible[0].id;
  const generatedAt = new Date().toISOString();
  const report: BenchmarkReport = { schemaVersion: 1, benchmarkId: golden.benchmarkId, generatedAt, winner, candidates: reports };
  const lock: ModelLock = {
    schemaVersion: 1,
    generatedAt,
    benchmarkId: golden.benchmarkId,
    koharuVersion: golden.koharuVersion,
    models: golden.candidates.map((candidate) => ({ ...candidate.model, selected: candidate.id === winner })),
  };
  await assertSchema("model-lock.schema.json", lock);
  const output = await createUniqueDirectory(outputParent, `benchmark-results-${golden.benchmarkId}`);
  await writeJsonExclusive(path.join(output.directory, "benchmark-report.json"), report);
  await writeJsonExclusive(path.join(output.directory, "models.lock.json"), lock);
  return { directory: output.directory, report, lock };
}
