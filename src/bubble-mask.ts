import sharp from "sharp";
import { LocalizerError } from "./errors.ts";
import type { BoundingBox, JsonObject } from "./types.ts";

export const BUBBLE_MASK_MAX_PIXELS = 25_000_000;
export const BUBBLE_MASK_MAX_REGION_SCAN_PIXELS = 4_000_000;
export const BUBBLE_ROLE_MIN_OVERLAP = 0.8;
export const BUBBLE_OUTSIDE_MAX_OVERLAP = 0.05;
const BUBBLE_MASK_MAX_POLYGONS = 256;
const BUBBLE_MASK_MAX_POLYGON_POINTS = 4_096;
const BUBBLE_MASK_MAX_GEOMETRY_OPERATIONS = 16_000_000;

interface Point {
  x: number;
  y: number;
}

type Polygon = Point[];

export interface BubbleRoleEvidence {
  insideBubble?: boolean;
  bubbleInstanceId?: string;
  overlapRate: number;
  confidence: number;
}

export type BubbleMaskEvidence = ReadonlyMap<string, BubbleRoleEvidence>;

export interface BubbleMaskOptions {
  maxPixels?: number;
  maxRegionScanPixels?: number;
}

interface DecodedMask {
  width: number;
  height: number;
  labels: Uint8Array;
}

interface ScenePage {
  id: string;
  width: number;
  height: number;
  nodes: Record<string, unknown>[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function positiveLimit(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new LocalizerError(code, "Bubble mask limit must be a positive safe integer");
  return value;
}

function validateMaskDimensions(width: number, height: number, maxPixels: number): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new LocalizerError("BUBBLE_MASK_PAGE_DIMENSIONS_INVALID", "Koharu page dimensions are invalid for a bubble mask");
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > maxPixels) throw new LocalizerError("BUBBLE_MASK_PIXEL_LIMIT", "Koharu bubble mask exceeds the decoded pixel limit");
  return pixels;
}

function pageNodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(record).filter((item): item is Record<string, unknown> => item !== undefined);
  const item = record(value);
  return item ? Object.values(item).map(record).filter((node): node is Record<string, unknown> => node !== undefined) : [];
}

function collectPages(scene: JsonObject): ScenePage[] {
  const pages: ScenePage[] = [];
  const seenObjects = new Set<object>();
  const seenIds = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    const item = record(value);
    if (!item || seenObjects.has(item)) return;
    seenObjects.add(item);
    const id = typeof item.id === "string" ? item.id : typeof item.pageId === "string" ? item.pageId : undefined;
    const width = item.width;
    const height = item.height;
    if (id && typeof width === "number" && typeof height === "number" && item.nodes !== undefined) {
      if (seenIds.has(id)) throw new LocalizerError("BUBBLE_MASK_PAGE_DUPLICATE", "Bubble mask adapter found duplicate page ids");
      seenIds.add(id);
      pages.push({ id, width, height, nodes: pageNodes(item.nodes) });
      return;
    }
    Object.values(item).forEach(walk);
  };
  walk(scene);
  return pages;
}

function bubbleBlobHash(node: Record<string, unknown>): string | undefined {
  const kind = record(node.kind);
  const mask = record(kind?.mask);
  if (!mask || mask.role !== "bubble") return undefined;
  if (typeof mask.blob !== "string" || !/^[0-9a-f]{64}$/.test(mask.blob)) {
    throw new LocalizerError("BUBBLE_MASK_BLOB_INVALID", "Koharu bubble mask has an invalid blob reference");
  }
  return mask.blob;
}

function parseBbox(value: unknown): BoundingBox | undefined {
  const item = record(value);
  if (!item) return undefined;
  const x = Number(item.x);
  const y = Number(item.y);
  const width = Number(item.width);
  const height = Number(item.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return undefined;
  return { x, y, width, height };
}

function parsePoint(value: unknown): Point | undefined {
  if (Array.isArray(value) && value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number" && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
    return { x: value[0], y: value[1] };
  }
  const item = record(value);
  return item && typeof item.x === "number" && typeof item.y === "number" && Number.isFinite(item.x) && Number.isFinite(item.y)
    ? { x: item.x, y: item.y }
    : undefined;
}

function parsePolygon(value: unknown): Polygon | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length >= 6 && value.length <= BUBBLE_MASK_MAX_POLYGON_POINTS * 2 && value.every((item) => typeof item === "number" && Number.isFinite(item)) && value.length % 2 === 0) {
    const points: Point[] = [];
    for (let index = 0; index < value.length; index += 2) points.push({ x: value[index] as number, y: value[index + 1] as number });
    return points;
  }
  if (value.length > BUBBLE_MASK_MAX_POLYGON_POINTS) return undefined;
  const points = value.map(parsePoint);
  return points.length >= 3 && points.every((point) => point !== undefined) ? points as Point[] : undefined;
}

function parsePolygons(value: unknown): Polygon[] | undefined {
  if (value === undefined) return undefined;
  const direct = parsePolygon(value);
  if (direct) return [direct];
  if (!Array.isArray(value) || value.length > BUBBLE_MASK_MAX_POLYGONS) return [];
  const polygons = value.map((item) => parsePolygon(record(item)?.points ?? item));
  return polygons.every((polygon) => polygon !== undefined)
    && polygons.reduce((count, polygon) => count + (polygon?.length ?? 0), 0) <= BUBBLE_MASK_MAX_POLYGON_POINTS
    ? polygons as Polygon[]
    : [];
}

function polygonArea(polygon: Polygon): number {
  let area = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    area += current.x * next.y - next.x * current.y;
  }
  return Math.abs(area) / 2;
}

function pointInsidePolygon(x: number, y: number, polygon: Polygon): boolean {
  let inside = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
    const a = polygon[current];
    const b = polygon[previous];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function geometryForNode(node: Record<string, unknown>): { bbox?: BoundingBox; polygons?: Polygon[] } | undefined {
  const kind = record(node.kind);
  const text = record(kind?.text);
  if (!text) return undefined;
  const polygonValue = text.linePolygons ?? text.line_polygons ?? node.linePolygons ?? node.line_polygons;
  const polygons = parsePolygons(polygonValue);
  if (polygons !== undefined) return polygons.length > 0 ? { polygons } : undefined;
  const transform = record(node.transform);
  const rotation = Number(transform?.rotationDeg ?? transform?.rotation_deg ?? 0);
  if (!Number.isFinite(rotation) || rotation !== 0) return undefined;
  const bbox = parseBbox(node.transform ?? node.bbox ?? node.bounds);
  return bbox ? { bbox } : undefined;
}

function geometryBounds(geometry: { bbox?: BoundingBox; polygons?: Polygon[] }): BoundingBox | undefined {
  if (geometry.bbox) return geometry.bbox;
  const points = geometry.polygons?.flat();
  if (!points || points.length === 0) return undefined;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function overlapEvidence(
  pageId: string,
  mask: DecodedMask,
  geometry: { bbox?: BoundingBox; polygons?: Polygon[] },
  maxRegionScanPixels: number,
  pageScanBudget: { remaining: number },
): BubbleRoleEvidence | undefined {
  const bounds = geometryBounds(geometry);
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return undefined;
  if (bounds.x < 0 || bounds.y < 0 || bounds.x + bounds.width > mask.width || bounds.y + bounds.height > mask.height) return undefined;
  if (geometry.polygons?.some((polygon) => polygonArea(polygon) <= 0)) return undefined;
  const startX = Math.floor(bounds.x);
  const startY = Math.floor(bounds.y);
  const endX = Math.ceil(bounds.x + bounds.width);
  const endY = Math.ceil(bounds.y + bounds.height);
  const scanPixels = (endX - startX) * (endY - startY);
  const polygonPoints = geometry.polygons?.reduce((count, polygon) => count + polygon.length, 0) ?? 1;
  if (!Number.isSafeInteger(scanPixels) || scanPixels < 1 || scanPixels > maxRegionScanPixels || scanPixels > pageScanBudget.remaining) return undefined;
  if (!Number.isSafeInteger(scanPixels * polygonPoints) || scanPixels * polygonPoints > BUBBLE_MASK_MAX_GEOMETRY_OPERATIONS) return undefined;
  pageScanBudget.remaining -= scanPixels;
  const labelCounts = new Map<number, number>();
  let geometryPixels = 0;
  let nonzeroPixels = 0;
  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      if (geometry.polygons && !geometry.polygons.some((polygon) => pointInsidePolygon(x + 0.5, y + 0.5, polygon))) continue;
      geometryPixels += 1;
      const label = mask.labels[y * mask.width + x];
      if (label === 0) continue;
      nonzeroPixels += 1;
      labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
  }
  if (geometryPixels === 0) return undefined;
  const overlapRate = nonzeroPixels / geometryPixels;
  const dominant = [...labelCounts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  const dominantShare = dominant ? dominant[1] / nonzeroPixels : 0;
  const bubbleInstanceId = dominant && dominantShare >= BUBBLE_ROLE_MIN_OVERLAP ? `${pageId}:${dominant[0]}` : undefined;
  if (overlapRate >= BUBBLE_ROLE_MIN_OVERLAP && bubbleInstanceId) {
    return { insideBubble: true, bubbleInstanceId, overlapRate, confidence: Math.min(overlapRate, dominantShare) };
  }
  if (overlapRate <= BUBBLE_OUTSIDE_MAX_OVERLAP) return { insideBubble: false, overlapRate, confidence: 1 - overlapRate };
  return { ...(bubbleInstanceId ? { bubbleInstanceId } : {}), overlapRate, confidence: Math.max(overlapRate, 1 - overlapRate) };
}

export function bubbleEvidenceKey(pageId: string, regionId: string): string {
  return JSON.stringify([pageId, regionId]);
}

export async function decodeBubbleMask(bytes: Uint8Array, expectedWidth: number, expectedHeight: number, options: BubbleMaskOptions = {}): Promise<DecodedMask> {
  const maxPixels = positiveLimit(options.maxPixels ?? BUBBLE_MASK_MAX_PIXELS, "BUBBLE_MASK_PIXEL_LIMIT_INVALID");
  const expectedPixels = validateMaskDimensions(expectedWidth, expectedHeight, maxPixels);
  try {
    const image = sharp(bytes, { failOn: "error", limitInputPixels: maxPixels, sequentialRead: true });
    const metadata = await image.metadata();
    if (metadata.format !== "webp") throw new LocalizerError("BUBBLE_MASK_FORMAT_INVALID", "Koharu bubble mask is not WebP");
    if (metadata.width !== expectedWidth || metadata.height !== expectedHeight) throw new LocalizerError("BUBBLE_MASK_DIMENSIONS_MISMATCH", "Koharu bubble mask dimensions do not match its page");
    if ((metadata.pages ?? 1) !== 1) throw new LocalizerError("BUBBLE_MASK_PAGES_INVALID", "Koharu bubble mask must contain exactly one image");
    if (!metadata.channels || metadata.channels < 1 || metadata.channels > 4) throw new LocalizerError("BUBBLE_MASK_CHANNELS_INVALID", "Koharu bubble mask has unsupported channels");
    const { data, info } = await image.raw({ depth: "uchar" }).toBuffer({ resolveWithObject: true });
    if (info.width !== expectedWidth || info.height !== expectedHeight || info.channels < 1 || info.channels > 4 || data.byteLength !== expectedPixels * info.channels) {
      throw new LocalizerError("BUBBLE_MASK_DECODE_SHAPE_INVALID", "Decoded Koharu bubble mask has an invalid shape");
    }
    if (info.channels === 1) return { width: expectedWidth, height: expectedHeight, labels: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
    const labels = new Uint8Array(expectedPixels);
    for (let pixel = 0; pixel < expectedPixels; pixel += 1) {
      const offset = pixel * info.channels;
      const label = data[offset];
      if (info.channels === 2) {
        if (data[offset + 1] !== 255) throw new LocalizerError("BUBBLE_MASK_CHANNELS_INVALID", "Koharu bubble mask alpha channel is not opaque");
      } else {
        if (data[offset + 1] !== label || data[offset + 2] !== label) throw new LocalizerError("BUBBLE_MASK_CHANNELS_INVALID", "Koharu bubble mask color channels are not integer labels");
        if (info.channels === 4 && data[offset + 3] !== 255) throw new LocalizerError("BUBBLE_MASK_CHANNELS_INVALID", "Koharu bubble mask alpha channel is not opaque");
      }
      labels[pixel] = label;
    }
    return { width: expectedWidth, height: expectedHeight, labels };
  } catch (error) {
    if (error instanceof LocalizerError) throw error;
    throw new LocalizerError("BUBBLE_MASK_DECODE_FAILED", "Koharu bubble mask could not be decoded; image content omitted for privacy");
  }
}

export async function buildBubbleMaskEvidence(
  scene: JsonObject,
  readBlob: (hash: string) => Promise<Uint8Array>,
  options: BubbleMaskOptions = {},
): Promise<BubbleMaskEvidence> {
  const maxPixels = positiveLimit(options.maxPixels ?? BUBBLE_MASK_MAX_PIXELS, "BUBBLE_MASK_PIXEL_LIMIT_INVALID");
  const maxRegionScanPixels = positiveLimit(options.maxRegionScanPixels ?? BUBBLE_MASK_MAX_REGION_SCAN_PIXELS, "BUBBLE_MASK_REGION_LIMIT_INVALID");
  const evidence = new Map<string, BubbleRoleEvidence>();
  for (const page of collectPages(scene)) {
    const bubbleHashes = page.nodes.map(bubbleBlobHash).filter((hash): hash is string => hash !== undefined);
    if (bubbleHashes.length === 0) continue;
    if (bubbleHashes.length !== 1) throw new LocalizerError("BUBBLE_MASK_COUNT_INVALID", "Koharu page must have at most one bubble mask");
    const pagePixels = validateMaskDimensions(page.width, page.height, maxPixels);
    const mask = await decodeBubbleMask(await readBlob(bubbleHashes[0]), page.width, page.height, { maxPixels, maxRegionScanPixels });
    const pageScanBudget = { remaining: Math.min(Number.MAX_SAFE_INTEGER, pagePixels * 2) };
    for (const node of page.nodes) {
      const id = typeof node.id === "string" ? node.id : undefined;
      const geometry = geometryForNode(node);
      if (!id || !geometry) continue;
      const item = overlapEvidence(page.id, mask, geometry, maxRegionScanPixels, pageScanBudget);
      if (item) evidence.set(bubbleEvidenceKey(page.id, id), item);
    }
  }
  return evidence;
}
