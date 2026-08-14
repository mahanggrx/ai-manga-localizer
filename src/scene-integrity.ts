import { createHash } from "node:crypto";
import { LocalizerError } from "./errors.ts";
import type { JsonObject, JsonValue, KoharuSceneSnapshot, KoharuSourceTextPatch } from "./types.ts";

const SOURCE_SENTINEL = "__MANGA_LOCALIZER_ALLOWED_SOURCE_TEXT__";
const TRANSLATION_SENTINEL = "__MANGA_LOCALIZER_ALLOWED_TRANSLATION__";

function object(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function canonicalJson(value: JsonValue, parentKey?: string): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const keys = Object.keys(value);
  if (parentKey !== "pages" && parentKey !== "nodes") keys.sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], key)}`).join(",")}}`;
}

export function jsonSha256(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function assertSceneSnapshot(value: unknown): asserts value is KoharuSceneSnapshot {
  const snapshot = object(value);
  if (!snapshot || !Number.isSafeInteger(snapshot.epoch) || Number(snapshot.epoch) < 0 || !object(snapshot.scene)) {
    throw new LocalizerError("KOHARU_SCENE_SNAPSHOT_INVALID", "Koharu scene response must contain a non-negative safe epoch and scene object");
  }
}

interface TextNodeRef {
  pageId: string;
  nodeId: string;
  node: JsonObject;
  text: JsonObject;
}

function entries(value: JsonValue | undefined, kind: "page" | "node"): Array<{ key?: string; value: JsonObject }> {
  if (Array.isArray(value)) return value.map((item) => {
    const record = object(item);
    if (!record) throw new LocalizerError("KOHARU_SCENE_SHAPE_INVALID", `Koharu scene ${kind} array contains a non-object value`);
    return { value: record };
  });
  const mapped = object(value);
  if (!mapped) throw new LocalizerError("KOHARU_SCENE_SHAPE_INVALID", `Koharu scene ${kind} collection is not an array or object map`);
  return Object.entries(mapped).map(([key, item]) => {
    const record = object(item);
    if (!record) throw new LocalizerError("KOHARU_SCENE_SHAPE_INVALID", `Koharu scene ${kind} map contains a non-object value`);
    return { key, value: record };
  });
}

function indexTextNodes(scene: JsonObject): Map<string, TextNodeRef> {
  const pages = entries(scene.pages, "page");
  const pageIds = new Set<string>();
  const nodeIds = new Set<string>();
  const result = new Map<string, TextNodeRef>();
  for (const pageEntry of pages) {
    const pageId = typeof pageEntry.value.id === "string" ? pageEntry.value.id : pageEntry.key;
    if (!pageId || (pageEntry.key !== undefined && pageEntry.value.id !== undefined && pageEntry.key !== pageId)) {
      throw new LocalizerError("KOHARU_SCENE_PAGE_ID_CONFLICT", "Koharu scene page identity conflicts with its map key");
    }
    if (pageIds.has(pageId)) throw new LocalizerError("KOHARU_SCENE_DUPLICATE_PAGE", "Koharu scene contains duplicate page ids");
    pageIds.add(pageId);
    const nodes = entries(pageEntry.value.nodes, "node");
    const localIds = new Set<string>();
    for (const nodeEntry of nodes) {
      const nodeId = typeof nodeEntry.value.id === "string" ? nodeEntry.value.id : nodeEntry.key;
      if (!nodeId || (nodeEntry.key !== undefined && nodeEntry.value.id !== undefined && nodeEntry.key !== nodeId)) {
        throw new LocalizerError("KOHARU_SCENE_NODE_ID_CONFLICT", "Koharu scene node identity conflicts with its map key");
      }
      if (localIds.has(nodeId)) throw new LocalizerError("KOHARU_SCENE_DUPLICATE_NODE", "Koharu scene contains duplicate node ids within a page");
      localIds.add(nodeId);
      if (nodeIds.has(nodeId)) throw new LocalizerError("KOHARU_SCENE_DUPLICATE_NODE", "Koharu scene contains duplicate node ids across pages");
      nodeIds.add(nodeId);
      const kind = object(nodeEntry.value.kind);
      const text = object(kind?.text);
      if (!text) continue;
      const transform = object(nodeEntry.value.transform);
      if (!transform || !["x", "y", "width", "height", "rotationDeg"].every((field) => typeof transform[field] === "number" && Number.isFinite(transform[field]))) {
        throw new LocalizerError("KOHARU_SCENE_GEOMETRY_INVALID", "A selected Koharu text node has incomplete or non-finite source geometry");
      }
      if (Number(transform.width) < 0 || Number(transform.height) < 0) throw new LocalizerError("KOHARU_SCENE_GEOMETRY_INVALID", "A selected Koharu text node has negative source geometry");
      const key = `${pageId}\u0000${nodeId}`;
      if (result.has(key)) throw new LocalizerError("KOHARU_SCENE_DUPLICATE_NODE", "Koharu scene contains duplicate page/node identities");
      result.set(key, { pageId, nodeId, node: nodeEntry.value, text });
    }
  }
  return result;
}

function selectedKey(pageId: string, nodeId: string): string {
  return `${pageId}\u0000${nodeId}`;
}

function maskedScene(snapshot: KoharuSceneSnapshot, targets: Set<string>, field: "source" | "translation"): JsonObject {
  const scene = clone(snapshot.scene);
  for (const [key, ref] of indexTextNodes(scene)) {
    if (!targets.has(key)) continue;
    if (field === "source") ref.text.text = SOURCE_SENTINEL;
    else ref.text.translation = TRANSLATION_SENTINEL;
  }
  return scene;
}

export interface PreparedScenePatch {
  epoch: number;
  expectedEpoch: number;
  beforeFullHash: string;
  beforeStructureHash: string;
  expectedFullHash: string;
  expectedScene: KoharuSceneSnapshot;
  patches: KoharuSourceTextPatch[];
  selectedNodeIds: string[];
  selectedPageIds: string[];
  selectedCount: number;
  changedCount: number;
}

export function prepareScenePatch(snapshot: KoharuSceneSnapshot, selected: Array<{ pageId: string; regionId: string; selectedSourceText: string }>): PreparedScenePatch {
  assertSceneSnapshot(snapshot);
  const refs = indexTextNodes(snapshot.scene);
  const targetKeys = new Set<string>();
  const ordered = [...selected].sort((a, b) => a.pageId.localeCompare(b.pageId) || a.regionId.localeCompare(b.regionId));
  const expected = clone(snapshot);
  const expectedRefs = indexTextNodes(expected.scene);
  const patches: KoharuSourceTextPatch[] = [];
  for (const item of ordered) {
    if (typeof item.selectedSourceText !== "string") throw new LocalizerError("KOHARU_SCENE_PATCH_TEXT_INVALID", "Selected OCR source text must be a string");
    const key = selectedKey(item.pageId, item.regionId);
    if (targetKeys.has(key)) throw new LocalizerError("KOHARU_SCENE_PATCH_DUPLICATE_TARGET", "Private source patch contains a duplicate page/node target");
    targetKeys.add(key);
    const before = refs.get(key);
    const after = expectedRefs.get(key);
    if (!before || !after) throw new LocalizerError("KOHARU_SCENE_PATCH_TARGET_MISSING", "A selected OCR region is absent from the Koharu scene");
    if (typeof before.text.text !== "string") throw new LocalizerError("KOHARU_SCENE_SOURCE_TEXT_INVALID", "A selected Koharu text node has no string source text");
    if (before.text.text !== item.selectedSourceText) {
      after.text.text = item.selectedSourceText;
      patches.push({ pageId: item.pageId, nodeId: item.regionId, sourceText: item.selectedSourceText });
    }
  }
  expected.epoch = snapshot.epoch + (patches.length > 0 ? 1 : 0);
  return {
    epoch: snapshot.epoch,
    expectedEpoch: expected.epoch,
    beforeFullHash: jsonSha256(snapshot as unknown as JsonValue),
    beforeStructureHash: jsonSha256(maskedScene(snapshot, targetKeys, "source")),
    expectedFullHash: jsonSha256(expected as unknown as JsonValue),
    expectedScene: expected,
    patches,
    selectedNodeIds: ordered.map((item) => item.regionId),
    selectedPageIds: [...new Set(ordered.map((item) => item.pageId))],
    selectedCount: ordered.length,
    changedCount: patches.length,
  };
}

export function verifyPatchedScene(plan: PreparedScenePatch, actual: KoharuSceneSnapshot): void {
  assertSceneSnapshot(actual);
  if (actual.epoch !== plan.expectedEpoch || jsonSha256(actual as unknown as JsonValue) !== plan.expectedFullHash) {
    throw new LocalizerError("KOHARU_SCENE_PATCH_QUARANTINED", "Scene patch postcondition failed; the isolated project must not be reused");
  }
}

export interface TranslatorBaseline {
  snapshot: KoharuSceneSnapshot;
  fullHash: string;
  selectedKeys: Set<string>;
  selectedSource: Map<string, string>;
  targetPages: string[];
}

export function prepareTranslatorBaseline(snapshot: KoharuSceneSnapshot, selected: Array<{ pageId: string; regionId: string; selectedSourceText: string }>, targetPages: string[]): TranslatorBaseline {
  assertSceneSnapshot(snapshot);
  const refs = indexTextNodes(snapshot.scene);
  const selectedKeys = new Set<string>();
  const selectedSource = new Map<string, string>();
  for (const item of selected) {
    const key = selectedKey(item.pageId, item.regionId);
    const ref = refs.get(key);
    if (!ref || ref.text.text !== item.selectedSourceText) throw new LocalizerError("KOHARU_TRANSLATOR_SOURCE_PRECONDITION", "Selected OCR source text is not present immediately before translator start");
    selectedKeys.add(key);
    selectedSource.set(key, item.selectedSourceText);
  }
  const uniquePages = [...new Set(targetPages)];
  if (uniquePages.length !== targetPages.length || uniquePages.some((pageId) => ![...selectedKeys].some((key) => key.startsWith(`${pageId}\u0000`)))) {
    throw new LocalizerError("KOHARU_TRANSLATOR_TARGET_INVALID", "Translator target pages must be unique and contain selected text nodes");
  }
  return { snapshot: clone(snapshot), fullHash: jsonSha256(snapshot as unknown as JsonValue), selectedKeys, selectedSource, targetPages: uniquePages };
}

export function verifyTranslatorScene(baseline: TranslatorBaseline, actual: KoharuSceneSnapshot): void {
  assertSceneSnapshot(actual);
  if (actual.epoch !== baseline.snapshot.epoch + baseline.targetPages.length) {
    throw new LocalizerError("KOHARU_TRANSLATOR_EPOCH_MISMATCH", "Translator epoch delta does not equal the actual target page count");
  }
  const refs = indexTextNodes(actual.scene);
  for (const [key, sourceText] of baseline.selectedSource) {
    const ref = refs.get(key);
    if (!ref || ref.text.text !== sourceText) throw new LocalizerError("KOHARU_TRANSLATOR_SOURCE_REWRITTEN", "Translator changed selected OCR source text");
    if (typeof ref.text.translation !== "string") throw new LocalizerError("KOHARU_TRANSLATOR_PARTIAL", "Translator did not produce a string translation for every selected text node");
  }
  const beforeMasked = maskedScene(baseline.snapshot, baseline.selectedKeys, "translation");
  const afterMasked = maskedScene(actual, baseline.selectedKeys, "translation");
  if (jsonSha256(beforeMasked) !== jsonSha256(afterMasked)) {
    throw new LocalizerError("KOHARU_TRANSLATOR_SCENE_DRIFT", "Translator changed a non-translation field or an unknown scene field");
  }
}

export function sceneFullHash(snapshot: KoharuSceneSnapshot): string {
  assertSceneSnapshot(snapshot);
  return jsonSha256(snapshot as unknown as JsonValue);
}
