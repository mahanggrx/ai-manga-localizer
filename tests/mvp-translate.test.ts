import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { defaultMangaTranslatorAssets, llamaServerArgs, mangaTranslatorArgs } from "../src/mvp-translate.ts";
import { assertSchema } from "../src/schema.ts";

test("MVP command uses the local Hy-MT2 server and offline MangaTranslator path", () => {
  const assets = defaultMangaTranslatorAssets("C:/repo");
  const server = llamaServerArgs(assets);
  assert.deepEqual(server.slice(0, 4), ["-m", assets.model, "--alias", "hy-mt2-local"]);
  assert.deepEqual(server.slice(server.indexOf("--host"), server.indexOf("--host") + 4), ["--host", "127.0.0.1", "--port", "8080"]);
  assert.ok(server.includes("--n-gpu-layers"));
  assert.ok(server.includes("none"));

  const args = mangaTranslatorArgs(assets, "C:/input", "C:/output", true);
  assert.ok(args.includes("--batch"));
  assert.equal(args[args.indexOf("--openai-compatible-url") + 1], "http://127.0.0.1:8080/v1");
  assert.equal(args[args.indexOf("--model-name") + 1], "hy-mt2-local");
  assert.equal(args[args.indexOf("--ocr-method") + 1], "manga-ocr");
  assert.equal(args[args.indexOf("--upscale-method") + 1], "none");
  assert.equal(args[args.indexOf("--output-language") + 1], "Chinese (Simplified)");
  assert.equal(args.some((value) => /^https:/u.test(value)), false);
  assert.equal(path.basename(assets.python).toLowerCase(), "python.exe");
});

test("single-image MVP invocation does not enable batch mode", () => {
  const assets = defaultMangaTranslatorAssets("C:/repo");
  assert.equal(mangaTranslatorArgs(assets, "C:/input.png", "C:/output", false).includes("--batch"), false);
});

test("MVP report satisfies its public schema", async () => {
  await assert.doesNotReject(() => assertSchema("mvp-report.schema.json", {
    schemaVersion: 1,
    status: "completed",
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(1).toISOString(),
    inputKind: "directory",
    outputImages: 3,
    failedImages: 0,
    engine: { pipeline: "MangaTranslator", translator: "Hy-MT2-7B-Q4_K_M", ocr: "manga-ocr" },
  }));
});
