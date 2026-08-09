import test from "node:test";
import assert from "node:assert/strict";
import { compareOutsideMask } from "../src/visual-qa.ts";

test("visual QA reports only changes outside the supplied mask", () => {
  const width = 3;
  const height = 3;
  const original = new Uint8Array(width * height * 4).fill(255);
  const processed = original.slice();
  const mask = new Uint8Array(width * height);
  mask[4] = 255;
  processed[4 * 4] = 0;
  const insideOnly = compareOutsideMask({ original, processed, mask, width, height });
  assert.equal(insideOnly.outsideMaskChangedPixels, 0);
  processed[0] = 0;
  const outside = compareOutsideMask({ original, processed, mask, width, height });
  assert.equal(outside.outsideMaskChangedPixels, 1);
  assert.equal(outside.outsideMaskMaxChannelDelta, 255);
});

