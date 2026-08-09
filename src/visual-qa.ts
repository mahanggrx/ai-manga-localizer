import { LocalizerError } from "./errors.ts";

export interface VisualQaMetrics {
  outsideMaskChangedPixels: number;
  outsideMaskMaxChannelDelta: number;
  outsideMaskChangeRate: number;
  insideMaskEdgeDensity: number;
  surroundingEdgeDensity: number;
  residualTextRisk: boolean;
}

function grayscale(pixels: Uint8Array, pixelIndex: number, channels: number): number {
  const offset = pixelIndex * channels;
  return 0.299 * pixels[offset] + 0.587 * pixels[offset + 1] + 0.114 * pixels[offset + 2];
}

function edgeMagnitude(pixels: Uint8Array, x: number, y: number, width: number, height: number, channels: number): number {
  const at = (px: number, py: number): number => grayscale(pixels, Math.max(0, Math.min(height - 1, py)) * width + Math.max(0, Math.min(width - 1, px)), channels);
  const gx = -at(x - 1, y - 1) + at(x + 1, y - 1) - 2 * at(x - 1, y) + 2 * at(x + 1, y) - at(x - 1, y + 1) + at(x + 1, y + 1);
  const gy = -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
  return Math.hypot(gx, gy);
}

export function compareOutsideMask(options: {
  original: Uint8Array;
  processed: Uint8Array;
  mask: Uint8Array;
  width: number;
  height: number;
  channels?: 3 | 4;
  channelTolerance?: number;
}): VisualQaMetrics {
  const channels = options.channels ?? 4;
  const pixels = options.width * options.height;
  if (options.width <= 0 || options.height <= 0 || options.mask.length !== pixels || options.original.length !== pixels * channels || options.processed.length !== pixels * channels) {
    throw new LocalizerError("VISUAL_QA_BUFFER_SHAPE", "Visual QA buffers do not match width, height, and channel count");
  }
  const tolerance = options.channelTolerance ?? 0;
  let outsidePixels = 0;
  let changed = 0;
  let maxDelta = 0;
  let insideEdgeTotal = 0;
  let insideEdgeCount = 0;
  let surroundingEdgeTotal = 0;
  let surroundingEdgeCount = 0;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const masked = options.mask[pixel] > 0;
    if (!masked) {
      outsidePixels += 1;
      let pixelChanged = false;
      for (let channel = 0; channel < Math.min(3, channels); channel += 1) {
        const delta = Math.abs(options.original[pixel * channels + channel] - options.processed[pixel * channels + channel]);
        maxDelta = Math.max(maxDelta, delta);
        if (delta > tolerance) pixelChanged = true;
      }
      if (pixelChanged) changed += 1;
    }
    const x = pixel % options.width;
    const y = Math.floor(pixel / options.width);
    const edge = edgeMagnitude(options.processed, x, y, options.width, options.height, channels);
    if (masked) {
      insideEdgeTotal += edge;
      insideEdgeCount += 1;
    } else {
      let nearMask = false;
      for (let dy = -2; dy <= 2 && !nearMask; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < options.width && ny >= 0 && ny < options.height && options.mask[ny * options.width + nx] > 0) { nearMask = true; break; }
      }
      if (nearMask) {
        surroundingEdgeTotal += edge;
        surroundingEdgeCount += 1;
      }
    }
  }
  const insideMaskEdgeDensity = insideEdgeCount > 0 ? insideEdgeTotal / insideEdgeCount : 0;
  const surroundingEdgeDensity = surroundingEdgeCount > 0 ? surroundingEdgeTotal / surroundingEdgeCount : 0;
  return {
    outsideMaskChangedPixels: changed,
    outsideMaskMaxChannelDelta: maxDelta,
    outsideMaskChangeRate: changed / Math.max(1, outsidePixels),
    insideMaskEdgeDensity,
    surroundingEdgeDensity,
    residualTextRisk: insideEdgeCount > 0 && insideMaskEdgeDensity > Math.max(80, surroundingEdgeDensity * 2.5),
  };
}
