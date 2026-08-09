import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { characterErrorRate, runBenchmark } from "../src/benchmark.ts";

test("CER uses normalized Unicode characters", () => {
  assert.equal(characterErrorRate("テスト", "テスト"), 0);
  assert.equal(characterErrorRate("１２３", "123"), 0);
  assert.ok(characterErrorRate("猫", "犬") > 0);
});

test("benchmark selects the eligible highest-quality model and writes a lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "manga-localizer-benchmark-"));
  const sha = "a".repeat(64);
  const golden = {
    schemaVersion: 1,
    benchmarkId: "synthetic-v1",
    koharuVersion: "0.61.2",
    availableVramMiB: 8188,
    regions: [
      { id: "r1", pageId: "p1", expectedOcr: "こんにちは！", nonRefusalRequired: false },
      { id: "r2", pageId: "p1", expectedOcr: "要翻訳文", nonRefusalRequired: true },
    ],
    candidates: [{
      id: "candidate-a",
      resultsFile: "candidate-a.json",
      model: { id: "candidate-a", family: "Synthetic", version: "1", sha256: sha, license: "test-only", role: "translation" },
    }],
  };
  const candidate = {
    schemaVersion: 1,
    candidateId: "candidate-a",
    peakVramMiB: 7000,
    formatValid: true,
    regions: [
      { id: "r1", pageId: "p1", detected: true, ocrText: "こんにちは！", translation: "你好！", semanticUsable: true, termsCorrect: true, layoutOk: true },
      { id: "r2", pageId: "p1", detected: true, ocrText: "要翻訳文", translation: "需要翻译的文字", semanticUsable: true, termsCorrect: true, layoutOk: true },
    ],
    pages: [{ pageId: "p1", repairLetteringScore: 4.5 }],
  };
  await writeFile(path.join(root, "golden.json"), JSON.stringify(golden));
  await writeFile(path.join(root, "candidate-a.json"), JSON.stringify(candidate));
  const result = await runBenchmark(root, root);
  assert.equal(result.report.winner, "candidate-a");
  assert.equal(result.lock.models[0].selected, true);
  const written = JSON.parse(await readFile(path.join(result.directory, "models.lock.json"), "utf8"));
  assert.equal(written.benchmarkId, "synthetic-v1");
});
