import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { createMvpCbz, defaultMangaTranslatorAssets, llamaServerArgs, mangaTranslatorArgs, mangaTranslatorModelPreset, mangaTranslatorOutputTarget } from "../src/mvp-translate.ts";
import { readZipImagesBuffer } from "../src/archive.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { assertSchema } from "../src/schema.ts";

test("MVP command uses the local Hy-MT2 server and offline MangaTranslator path", () => {
  const assets = defaultMangaTranslatorAssets("C:/repo");
  const server = llamaServerArgs(assets, "C:/run/models.ini");
  assert.deepEqual(server.slice(0, 4), ["--models-preset", "C:/run/models.ini", "--models-max", "1"]);
  assert.deepEqual(server.slice(server.indexOf("--host"), server.indexOf("--host") + 4), ["--host", "127.0.0.1", "--port", "8081"]);
  const preset = mangaTranslatorModelPreset(assets);
  assert.match(preset, /\[hy-mt2-local\]/u);
  assert.match(preset, /\[sakura-galtransl-local\]/u);
  assert.doesNotMatch(preset, /models-max/u, "router capacity is enforced by CLI arguments, not the preset");

  const args = mangaTranslatorArgs(assets, "C:/input", "C:/output", true);
  assert.ok(args.includes("--batch"));
  assert.equal(args[args.indexOf("--openai-compatible-url") + 1], "http://127.0.0.1:8080/v1");
  assert.equal(args[args.indexOf("--model-name") + 1], "hy-mt2-local");
  assert.equal(args[args.indexOf("--ocr-method") + 1], "manga-ocr");
  assert.equal(args[args.indexOf("--upscale-method") + 1], "none");
  assert.equal(args[args.indexOf("--vertical-font-size-mult") + 1], "1.15");
  const instructions = args[args.indexOf("--special-instructions") + 1];
  assert.match(instructions, /never output Latin letters unless the source itself contains/u);
  assert.match(instructions, /Japanese katakana loanwords/u);
  assert.match(instructions, /do not phonetically transliterate/u);
  assert.match(instructions, /……/u);
  assert.equal(args[args.indexOf("--output-language") + 1], "Chinese (Simplified)");
  assert.equal(args.some((value) => /^https:/u.test(value)), false);
  assert.equal(args.includes("--osb-enable"), false);
  assert.equal(path.basename(assets.python).toLowerCase(), "python.exe");
});

test("outside-text MVP mode uses only RT-DETR text_free detections with OpenCV inpainting", () => {
  const assets = defaultMangaTranslatorAssets("C:/repo");
  const args = mangaTranslatorArgs(assets, "C:/input", "C:/output", true, true);
  assert.ok(args.includes("--osb-enable"));
  assert.ok(args.includes("--osb-text-free-only"));
  assert.equal(args[args.indexOf("--osb-inpainting-method") + 1], "opencv");
});

test("single-image MVP invocation does not enable batch mode", () => {
  const assets = defaultMangaTranslatorAssets("C:/repo");
  assert.equal(mangaTranslatorArgs(assets, "C:/input.png", "C:/output", false).includes("--batch"), false);
  assert.equal(mangaTranslatorOutputTarget("C:/run/images", false), path.join("C:/run/images", "translated"));
  assert.equal(mangaTranslatorOutputTarget("C:/run/images", true), "C:/run/images");
});

test("MVP packages translated images into a naturally ordered CBZ", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mvp-cbz-"));
  const images = path.join(root, "images");
  await mkdir(images);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  await writeFile(path.join(images, "page_10.png"), Buffer.concat([png, Buffer.from([10])]));
  await writeFile(path.join(images, "page_2.png"), Buffer.concat([png, Buffer.from([2])]));
  const cbz = path.join(root, "translated.cbz");
  assert.equal(await createMvpCbz(images, cbz), 2);
  const archived = readZipImagesBuffer(await readFile(cbz), DEFAULT_CONFIG);
  assert.deepEqual(archived.map((image) => image.fileName), ["0001.png", "0002.png"]);
  assert.equal(archived[0].bytes.at(-1), 2);
  assert.equal(archived[1].bytes.at(-1), 10);
});

test("MVP report satisfies its public schema", async () => {
  await assert.doesNotReject(() => assertSchema("mvp-report.schema.json", {
    schemaVersion: 4,
    status: "completed",
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(1).toISOString(),
    inputKind: "directory",
    outputImages: 3,
    failedImages: 0,
    outsideTextMode: "disabled",
    engine: { pipeline: "MangaTranslator", translator: "Hy-MT2-7B-Q4_K_M", fallbackTranslator: "Sakura-GalTransl-7B-v3.7-IQ4_XS", ocr: "manga-ocr" },
    sakuraFallbackRegions: 1,
    sakuraFallbackFailures: 0,
    cbz: "translated.cbz",
  }));
});
