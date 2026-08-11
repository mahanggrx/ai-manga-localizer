import { lstat, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { LocalizerError } from "./errors.ts";
import { classifyRole, replacementPolicyForRole } from "./quality.ts";
import { assertSchema } from "./schema.ts";
import type { RegionRecord } from "./types.ts";

export type RoutingClass = "ordinary-dialogue" | "bubble-external" | "unknown";

export interface RoutingRegressionObservation {
  id: string;
  pageId: string;
  pageOrder: number;
  category: string;
  detected: boolean;
  nativeRole?: RegionRecord["role"];
  legacyPolicy?: RegionRecord["policy"];
  evidence?: {
    insideBubble?: boolean;
    confidence: number;
    provenance: "native" | "bubble-mask";
  };
  overlapRate?: number;
  dominantShare?: number;
  hardCaseTags?: string[];
  hardness?: number;
}

export interface RoutingRegressionInput {
  schemaVersion: 1;
  benchmarkId: string;
  observations: RoutingRegressionObservation[];
}

interface Distribution {
  ordinaryDialogue: number;
  bubbleExternal: number;
  unknown: number;
}

export interface RoutingHardCase {
  id: string;
  pageId: string;
  pageOrder: number;
  category: string;
  detected: boolean;
  tags: string[];
  overlapRate?: number;
  dominantShare?: number;
}

export interface RoutingRegressionReport {
  schemaVersion: 1;
  benchmarkId: string;
  regionCount: number;
  detectedRegionCount: number;
  distribution: Distribution;
  detectedDistribution: Distribution;
  detectedByCategory: Record<string, Distribution>;
  runtimeRoles: Record<RegionRecord["role"], number>;
  policies: Record<RegionRecord["policy"], number>;
  bubbleMapping: { mapped: number; total: number; rate: number };
  deterministicEvidence: { classified: number; total: number; rate: number };
  pageSafety: {
    reviewedPages: number;
    pagesWithDetectedUnknown: number;
    pagesWithNoDetectedRegions: number;
    pagesWithoutUnknownOrEmptyBlock: number;
  };
  overlapSeparation: {
    bubbleExternalMaximum?: number;
    ordinaryDialogueMinimum?: number;
    ordinaryDialogueDominantMinimum?: number;
  };
  legacyUnknownReplaceCount: number;
  unknownReplaceViolationCount: number;
  hardCases: RoutingHardCase[];
}

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_LABEL = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAFE_TAG = /^[a-z0-9][a-z0-9-]{0,63}(?::[a-z0-9][a-z0-9-]{0,63})?$/;
const OBSERVATION_KEYS = new Set([
  "id", "pageId", "pageOrder", "category", "detected", "nativeRole", "legacyPolicy", "evidence",
  "overlapRate", "dominantShare", "hardCaseTags", "hardness",
]);
const ROLE_VALUES = new Set<RegionRecord["role"]>(["dialogue", "caption", "sfx", "unknown"]);
const POLICY_VALUES = new Set<RegionRecord["policy"]>(["replace", "preserve-with-annotation"]);
const MAX_ROUTING_INPUT_BYTES = 10_000_000;

function emptyDistribution(): Distribution {
  return { ordinaryDialogue: 0, bubbleExternal: 0, unknown: 0 };
}

function increment(distribution: Distribution, routingClass: RoutingClass): void {
  if (routingClass === "ordinary-dialogue") distribution.ordinaryDialogue += 1;
  else if (routingClass === "bubble-external") distribution.bubbleExternal += 1;
  else distribution.unknown += 1;
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function invalid(message: string): never {
  throw new LocalizerError("ROUTING_REGRESSION_INPUT_INVALID", message);
}

function validateObservation(item: RoutingRegressionObservation): void {
  if (!item || typeof item !== "object" || Array.isArray(item)) invalid("Routing observation must be an object");
  if (Object.keys(item).some((key) => !OBSERVATION_KEYS.has(key))) invalid("Routing observation contains an unsupported field");
  if (typeof item.id !== "string" || !SAFE_IDENTIFIER.test(item.id)) invalid("Routing observation id is invalid");
  if (typeof item.pageId !== "string" || !SAFE_IDENTIFIER.test(item.pageId)) invalid("Routing observation page id is invalid");
  if (!Number.isSafeInteger(item.pageOrder) || item.pageOrder < 1) invalid("Routing observation page order is invalid");
  if (typeof item.category !== "string" || !SAFE_LABEL.test(item.category)) invalid("Routing observation category is invalid");
  if (typeof item.detected !== "boolean") invalid("Routing observation detection state is invalid");
  if (item.nativeRole !== undefined && !ROLE_VALUES.has(item.nativeRole)) invalid("Routing observation native role is invalid");
  if (item.legacyPolicy !== undefined && !POLICY_VALUES.has(item.legacyPolicy)) invalid("Routing observation legacy policy is invalid");
  if (item.evidence !== undefined) {
    if (!item.evidence || typeof item.evidence !== "object" || Array.isArray(item.evidence)) invalid("Routing observation evidence is invalid");
    if (Object.keys(item.evidence).some((key) => !["insideBubble", "confidence", "provenance"].includes(key))) invalid("Routing observation evidence contains an unsupported field");
    if (item.evidence.insideBubble !== undefined && typeof item.evidence.insideBubble !== "boolean") invalid("Routing observation bubble state is invalid");
    if (!Number.isFinite(item.evidence.confidence) || item.evidence.confidence < 0 || item.evidence.confidence > 1) invalid("Routing observation confidence is invalid");
    if (item.evidence.provenance !== "native" && item.evidence.provenance !== "bubble-mask") invalid("Routing observation provenance is invalid");
  }
  for (const value of [item.overlapRate, item.dominantShare]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) invalid("Routing observation overlap evidence is invalid");
  }
  if (item.hardCaseTags !== undefined) {
    if (!Array.isArray(item.hardCaseTags) || item.hardCaseTags.length > 32 || item.hardCaseTags.some((tag) => typeof tag !== "string" || !SAFE_TAG.test(tag))) invalid("Routing hard-case tag is invalid");
    if (new Set(item.hardCaseTags).size !== item.hardCaseTags.length) invalid("Routing hard-case tags contain duplicates");
  }
  if (item.hardness !== undefined && !Number.isFinite(item.hardness)) invalid("Routing hard-case score is invalid");
}

function routingClassFor(item: RoutingRegressionObservation): { routingClass: RoutingClass; role: RegionRecord["role"]; policy: RegionRecord["policy"] } {
  const decision = classifyRole(item.nativeRole, item.evidence);
  const policy = replacementPolicyForRole(decision.role);
  if (decision.role === "dialogue" || decision.role === "caption") return { routingClass: "ordinary-dialogue", role: decision.role, policy };
  if (item.evidence?.insideBubble === false) return { routingClass: "bubble-external", role: decision.role, policy };
  return { routingClass: "unknown", role: decision.role, policy };
}

export function selectMinimalRoleHardCases(observations: RoutingRegressionObservation[]): RoutingHardCase[] {
  observations.forEach(validateObservation);
  const candidates = observations.filter((item) => (item.hardCaseTags?.length ?? 0) > 0);
  const tags = [...new Set(candidates.flatMap((item) => item.hardCaseTags ?? []))].sort();
  if (tags.length > 20) invalid("Routing hard-case exact cover supports at most 20 facets");
  if (tags.length === 0) return [];
  const tagIndex = new Map(tags.map((tag, index) => [tag, index]));
  type Selection = { items: RoutingRegressionObservation[]; hardness: number; key: string };
  const selectionKey = (items: RoutingRegressionObservation[]): string => items
    .map((item) => `${String(item.pageOrder).padStart(8, "0")}:${item.id}`)
    .sort()
    .join("|");
  const better = (candidate: Selection, current: Selection | undefined): boolean => !current
    || candidate.items.length < current.items.length
    || (candidate.items.length === current.items.length && candidate.hardness > current.hardness)
    || (candidate.items.length === current.items.length && candidate.hardness === current.hardness && candidate.key < current.key);
  const states = new Map<number, Selection>([[0, { items: [], hardness: 0, key: "" }]]);
  for (const item of candidates) {
    const itemMask = (item.hardCaseTags ?? []).reduce((mask, tag) => mask | (1 << tagIndex.get(tag)!), 0);
    for (const [covered, selection] of [...states.entries()]) {
      const nextMask = covered | itemMask;
      if (nextMask === covered) continue;
      const items = [...selection.items, item];
      const next = { items, hardness: selection.hardness + (item.hardness ?? 0), key: selectionKey(items) };
      if (better(next, states.get(nextMask))) states.set(nextMask, next);
    }
  }
  const selected = states.get((1 << tags.length) - 1);
  if (!selected) invalid("Routing hard-case tags could not be covered");
  return selected.items
    .sort((left, right) => (right.hardness ?? 0) - (left.hardness ?? 0) || left.pageOrder - right.pageOrder || left.id.localeCompare(right.id))
    .map((item) => ({
      id: item.id,
      pageId: item.pageId,
      pageOrder: item.pageOrder,
      category: item.category,
      detected: item.detected,
      tags: [...(item.hardCaseTags ?? [])].sort(),
      ...(item.overlapRate !== undefined ? { overlapRate: item.overlapRate } : {}),
      ...(item.dominantShare !== undefined ? { dominantShare: item.dominantShare } : {}),
    }));
}

export function evaluateRoutingRegression(input: RoutingRegressionInput): RoutingRegressionReport {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !["schemaVersion", "benchmarkId", "observations"].includes(key))
    || input.schemaVersion !== 1 || typeof input.benchmarkId !== "string" || !SAFE_IDENTIFIER.test(input.benchmarkId) || !Array.isArray(input.observations)) {
    invalid("Routing regression input is missing required version 1 fields");
  }
  input.observations.forEach(validateObservation);
  const ids = new Set<string>();
  for (const item of input.observations) {
    if (ids.has(item.id)) invalid("Routing regression contains duplicate region ids");
    ids.add(item.id);
  }

  const distribution = emptyDistribution();
  const detectedDistribution = emptyDistribution();
  const detectedByCategory: Record<string, Distribution> = {};
  const runtimeRoles: Record<RegionRecord["role"], number> = { dialogue: 0, caption: 0, sfx: 0, unknown: 0 };
  const policies: Record<RegionRecord["policy"], number> = { replace: 0, "preserve-with-annotation": 0 };
  let mapped = 0;
  let deterministicallyClassified = 0;
  let legacyUnknownReplaceCount = 0;
  let unknownReplaceViolationCount = 0;
  const bubbleExternalOverlaps: number[] = [];
  const ordinaryDialogueOverlaps: number[] = [];
  const ordinaryDialogueDominantShares: number[] = [];
  const detectedByPage = new Map<string, number>();
  const unknownPages = new Set<string>();

  for (const item of input.observations) {
    const routed = routingClassFor(item);
    increment(distribution, routed.routingClass);
    if (item.nativeRole === "unknown" && item.legacyPolicy === "replace") legacyUnknownReplaceCount += 1;
    if (!item.detected) continue;
    detectedByPage.set(item.pageId, (detectedByPage.get(item.pageId) ?? 0) + 1);
    increment(detectedDistribution, routed.routingClass);
    const category = detectedByCategory[item.category] ??= emptyDistribution();
    increment(category, routed.routingClass);
    runtimeRoles[routed.role] += 1;
    policies[routed.policy] += 1;
    if (item.evidence?.provenance === "bubble-mask" && item.evidence.insideBubble === true && routed.role === "dialogue") mapped += 1;
    if (routed.routingClass !== "unknown") deterministicallyClassified += 1;
    if (routed.role === "unknown" && routed.policy === "replace") unknownReplaceViolationCount += 1;
    if (routed.role === "unknown") unknownPages.add(item.pageId);
    if (routed.routingClass === "bubble-external" && item.overlapRate !== undefined) bubbleExternalOverlaps.push(item.overlapRate);
    if (routed.routingClass === "ordinary-dialogue") {
      if (item.overlapRate !== undefined) ordinaryDialogueOverlaps.push(item.overlapRate);
      if (item.dominantShare !== undefined) ordinaryDialogueDominantShares.push(item.dominantShare);
    }
  }

  const detectedRegionCount = input.observations.filter((item) => item.detected).length;
  const reviewedPageIds = new Set(input.observations.map((item) => item.pageId));
  const emptyPages = [...reviewedPageIds].filter((pageId) => !detectedByPage.has(pageId));
  const roleOrEmptyBlockedPages = new Set([...unknownPages, ...emptyPages]);
  return {
    schemaVersion: 1,
    benchmarkId: input.benchmarkId,
    regionCount: input.observations.length,
    detectedRegionCount,
    distribution,
    detectedDistribution,
    detectedByCategory: Object.fromEntries(Object.entries(detectedByCategory).sort(([left], [right]) => left.localeCompare(right))),
    runtimeRoles,
    policies,
    bubbleMapping: { mapped, total: detectedRegionCount, rate: rate(mapped, detectedRegionCount) },
    deterministicEvidence: { classified: deterministicallyClassified, total: detectedRegionCount, rate: rate(deterministicallyClassified, detectedRegionCount) },
    pageSafety: {
      reviewedPages: reviewedPageIds.size,
      pagesWithDetectedUnknown: unknownPages.size,
      pagesWithNoDetectedRegions: emptyPages.length,
      pagesWithoutUnknownOrEmptyBlock: reviewedPageIds.size - roleOrEmptyBlockedPages.size,
    },
    overlapSeparation: {
      ...(bubbleExternalOverlaps.length > 0 ? { bubbleExternalMaximum: Math.max(...bubbleExternalOverlaps) } : {}),
      ...(ordinaryDialogueOverlaps.length > 0 ? { ordinaryDialogueMinimum: Math.min(...ordinaryDialogueOverlaps) } : {}),
      ...(ordinaryDialogueDominantShares.length > 0 ? { ordinaryDialogueDominantMinimum: Math.min(...ordinaryDialogueDominantShares) } : {}),
    },
    legacyUnknownReplaceCount,
    unknownReplaceViolationCount,
    hardCases: selectMinimalRoleHardCases(input.observations),
  };
}

async function main(): Promise<void> {
  if (process.argv.length !== 3) invalid("Usage: node src/routing-regression.ts <observations.json>");
  const info = await lstat(process.argv[2]);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ROUTING_INPUT_BYTES) invalid("Routing regression input file is invalid");
  const input = JSON.parse(await readFile(process.argv[2], "utf8")) as RoutingRegressionInput;
  await assertSchema("routing-regression-input.schema.json", input);
  const report = evaluateRoutingRegression(input);
  await assertSchema("routing-regression-report.schema.json", report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const code = error instanceof LocalizerError ? error.code : "ROUTING_REGRESSION_FAILED";
    const message = error instanceof LocalizerError ? error.message : "Routing regression failed";
    process.stderr.write(`${code}: ${message}\n`);
    process.exitCode = 1;
  });
}
