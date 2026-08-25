import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCbzBuffer, detectMediaType, loadInputImages, naturalCompare } from "./archive.ts";
import { LocalizerError, asLocalizerError } from "./errors.ts";
import { createUniqueDirectory, safeSlug, writeExclusive, writeJsonExclusive } from "./file-utils.ts";
import { assertSchema } from "./schema.ts";
import type { LocalizerConfig } from "./types.ts";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "127.0.0.1";
const PORT = 8080;
const MODEL_ALIAS = "hy-mt2-local";
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export interface MangaTranslatorAssets {
  llamaServer: string;
  model: string;
  python: string;
  main: string;
  models: string;
  fonts: string;
  cache: string;
  outsideTextDetector: string;
}

export interface MvpTranslateReport {
  schemaVersion: 3;
  status: "completed" | "partial" | "failed";
  startedAt: string;
  completedAt: string;
  inputKind: "directory" | "zip" | "cbz" | "image" | "unknown";
  outputImages: number;
  failedImages: number;
  outsideTextMode: "disabled" | "text-free-opencv";
  engine: { pipeline: "MangaTranslator"; translator: "Hy-MT2-7B-Q4_K_M"; ocr: "manga-ocr" };
  cbz?: "translated.cbz";
  errorCode?: string;
}

export interface MvpTranslateResult {
  directory: string;
  imagesDirectory: string;
  cbzPath: string;
  report: MvpTranslateReport;
}

export function defaultMangaTranslatorAssets(root = PROJECT_ROOT): MangaTranslatorAssets {
  const mangaTranslator = path.join(root, ".local", "manga-translator", "MangaTranslator");
  return {
    llamaServer: path.join(root, ".local", "llama-server", "llama-server.exe"),
    model: path.join(root, ".localizer-cache", "models", "tencent--Hy-MT2-7B-GGUF", "ab8472660ac61fac25f1af43fac2599d52a8a775", "Hy-MT2-7B-Q4_K_M.gguf"),
    python: path.join(mangaTranslator, "runtime", "python.exe"),
    main: path.join(mangaTranslator, "main.py"),
    models: path.join(mangaTranslator, "models"),
    fonts: path.join(mangaTranslator, "fonts", "Noto Sans SC"),
    cache: path.join(root, ".local", "manga-translator", "cache"),
    outsideTextDetector: path.join(mangaTranslator, "models", "rtdetr", "comic-text-and-bubble-detector"),
  };
}

export function llamaServerArgs(assets: MangaTranslatorAssets): string[] {
  return [
    "-m", assets.model,
    "--alias", MODEL_ALIAS,
    "--host", HOST,
    "--port", String(PORT),
    "--no-webui",
    "--n-gpu-layers", "99",
    "--ctx-size", "8192",
    "--parallel", "1",
    "--no-cont-batching",
    "--flash-attn", "auto",
    "--reasoning-format", "none",
  ];
}

export function mangaTranslatorArgs(assets: MangaTranslatorAssets, input: string, output: string, batch: boolean, outsideText = false): string[] {
  return [
    assets.main,
    "--input", input,
    "--output", output,
    ...(batch ? ["--batch"] : []),
    "--parallel-requests", "1",
    "--provider", "OpenAI-Compatible",
    "--openai-compatible-url", `http://${HOST}:${PORT}/v1`,
    "--model-name", MODEL_ALIAS,
    "--models", assets.models,
    "--font-dir", assets.fonts,
    "--input-language", "Japanese",
    "--output-language", "Chinese (Simplified)",
    "--ocr-method", "manga-ocr",
    "--translation-mode", "two-step",
    "--temperature", "0.3",
    "--max-tokens", "2048",
    "--reasoning-effort", "none",
    "--upscale-method", "none",
    ...(outsideText ? ["--osb-enable", "--osb-text-free-only", "--osb-inpainting-method", "opencv"] : []),
    "--output-format", "png",
  ];
}

async function requireFile(filePath: string, code: string): Promise<void> {
  const info = await stat(filePath).catch(() => undefined);
  if (!info?.isFile() || info.size === 0) throw new LocalizerError(code, `Required local file is unavailable: ${filePath}`);
}

async function requireDirectory(directory: string, code: string): Promise<void> {
  const info = await stat(directory).catch(() => undefined);
  if (!info?.isDirectory()) throw new LocalizerError(code, `Required local directory is unavailable: ${directory}`);
}

export async function validateMangaTranslatorAssets(assets: MangaTranslatorAssets): Promise<void> {
  await Promise.all([
    requireFile(assets.llamaServer, "MVP_LLAMA_SERVER_MISSING"),
    requireFile(assets.model, "MVP_TRANSLATION_MODEL_MISSING"),
    requireFile(assets.python, "MVP_PYTHON_RUNTIME_MISSING"),
    requireFile(assets.main, "MVP_MANGA_TRANSLATOR_MISSING"),
    requireDirectory(assets.models, "MVP_MANGA_MODELS_MISSING"),
    requireDirectory(assets.fonts, "MVP_FONT_DIRECTORY_MISSING"),
  ]);
  await mkdir(assets.cache, { recursive: true });
}

async function validateOutsideTextDetector(assets: MangaTranslatorAssets): Promise<void> {
  await Promise.all([
    requireFile(path.join(assets.outsideTextDetector, "config.json"), "MVP_OUTSIDE_TEXT_MODEL_MISSING"),
    requireFile(path.join(assets.outsideTextDetector, "preprocessor_config.json"), "MVP_OUTSIDE_TEXT_MODEL_MISSING"),
    requireFile(path.join(assets.outsideTextDetector, "model.safetensors"), "MVP_OUTSIDE_TEXT_MODEL_MISSING"),
  ]);
}

async function validateDirectoryTree(current: string): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(current, entry.name);
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new LocalizerError("INPUT_REPARSE_POINT", `Symbolic links and junctions are unsupported: ${target}`);
    if (entry.isDirectory()) await validateDirectoryTree(target);
  }
}

async function prepareInput(inputPath: string, runDirectory: string, config: LocalizerConfig): Promise<{ kind: MvpTranslateReport["inputKind"]; path: string; batch: boolean; temporary?: string }> {
  const resolved = path.resolve(inputPath);
  const info = await lstat(resolved).catch((error) => {
    throw new LocalizerError("INPUT_NOT_FOUND", `Input not found: ${resolved}`, { cause: error });
  });
  if (info.isSymbolicLink()) throw new LocalizerError("INPUT_REPARSE_POINT", `Symbolic links and junctions are unsupported: ${resolved}`);
  if (info.isDirectory()) {
    await validateDirectoryTree(resolved);
    return { kind: "directory", path: resolved, batch: true };
  }
  const extension = path.extname(resolved).toLowerCase();
  if (extension === ".zip") {
    await loadInputImages(resolved, config);
    return { kind: "zip", path: resolved, batch: true };
  }
  if (extension === ".cbz") {
    await loadInputImages(resolved, config);
    const temporary = path.join(runDirectory, "input.cbz-as-zip.zip");
    await copyFile(resolved, temporary, constants.COPYFILE_EXCL);
    return { kind: "cbz", path: temporary, batch: true, temporary };
  }
  if (info.isFile() && IMAGE_EXTENSIONS.has(extension)) {
    await loadInputImagesFromSingleFile(resolved);
    return { kind: "image", path: resolved, batch: false };
  }
  throw new LocalizerError("INPUT_TYPE_UNSUPPORTED", "MVP input must be an image, image directory, ZIP, or CBZ");
}

async function loadInputImagesFromSingleFile(filePath: string): Promise<void> {
  detectMediaType(path.basename(filePath), await readFile(filePath));
}

async function waitForServer(child: ChildProcess, timeoutMs = 5 * 60_000): Promise<void> {
  let spawnError = false;
  child.once("error", () => { spawnError = true; });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError || child.exitCode !== null || child.signalCode !== null) throw new LocalizerError("MVP_LLAMA_SERVER_EXITED", "The local translation server exited during startup");
    try {
      const response = await fetch(`http://${HOST}:${PORT}/health`, { redirect: "error", signal: AbortSignal.timeout(3_000) });
      await response.body?.cancel().catch(() => undefined);
      if (response.ok) return;
    } catch {
      // The model can take a while to load on an 8 GB GPU.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new LocalizerError("MVP_LLAMA_SERVER_TIMEOUT", "Timed out waiting for the local translation model");
}

async function runChild(executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<void> {
  const child = spawn(executable, args, { ...options, windowsHide: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("error", (error) => reject(new LocalizerError("MVP_PROCESS_START_FAILED", `Could not start ${path.basename(executable)}`, { cause: error })));
    child.once("exit", (code) => code === 0 ? resolve() : reject(new LocalizerError("MVP_PIPELINE_FAILED", `MangaTranslator exited with code ${code ?? "unknown"}`)));
  });
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const firstExit = new Promise<boolean>((resolve) => child.once("exit", () => resolve(true)));
  child.kill();
  const exited = await Promise.race([
    firstExit,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    const forcedExit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await Promise.race([
      forcedExit,
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
}

async function assertPortAvailable(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", () => reject(new LocalizerError("MVP_PORT_IN_USE", `Loopback port ${PORT} is already in use`)));
    probe.listen(PORT, HOST, () => probe.close((error) => error ? reject(error) : resolve()));
  });
}

async function countOutputImages(directory: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) count += await countOutputImages(target);
    else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) count += 1;
  }
  return count;
}

async function collectOutputImages(directory: string, relative = ""): Promise<Array<{ path: string; extension: string }>> {
  const images: Array<{ path: string; extension: string }> = [];
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const childRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) images.push(...await collectOutputImages(directory, childRelative));
    else if (entry.isFile()) {
      const extension = path.extname(entry.name).toLowerCase();
      if (IMAGE_EXTENSIONS.has(extension)) images.push({ path: path.join(directory, childRelative), extension });
    }
  }
  return images.sort((left, right) => naturalCompare(path.relative(directory, left.path), path.relative(directory, right.path)));
}

export async function createMvpCbz(imagesDirectory: string, cbzPath: string): Promise<number> {
  const images = await collectOutputImages(imagesDirectory);
  if (images.length === 0) throw new LocalizerError("MVP_NO_OUTPUT_IMAGES", "Cannot create a CBZ without translated images");
  const files = await Promise.all(images.map(async (image, index) => ({
    fileName: `${String(index + 1).padStart(4, "0")}${image.extension === ".jpeg" ? ".jpg" : image.extension}`,
    bytes: await readFile(image.path),
  })));
  await writeExclusive(cbzPath, createCbzBuffer(files));
  return files.length;
}

async function consumeFailureList(imagesDirectory: string): Promise<number> {
  const failureFile = path.join(imagesDirectory, "failed_paths.txt");
  const contents = await readFile(failureFile, "utf8").catch(() => undefined);
  if (contents === undefined) return 0;
  const count = contents.split(/\r?\n/u).filter((line) => line.trim() !== "").length;
  await unlink(failureFile);
  return count;
}

function offlineEnvironment(assets: MangaTranslatorAssets): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    HF_HOME: assets.cache,
    YOLO_CONFIG_DIR: path.join(assets.cache, "ultralytics"),
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost,::1",
  };
}

export async function runMvpTranslate(config: LocalizerConfig, options: { inputPath: string; outputParent: string; outsideText?: boolean }): Promise<MvpTranslateResult> {
  const assets = defaultMangaTranslatorAssets();
  await validateMangaTranslatorAssets(assets);
  if (options.outsideText) await validateOutsideTextDetector(assets);
  const output = await createUniqueDirectory(options.outputParent, `translation-results-mvp-${safeSlug(path.basename(options.inputPath, path.extname(options.inputPath)))}`);
  const imagesDirectory = path.join(output.directory, "images");
  await mkdir(imagesDirectory);
  const startedAt = new Date().toISOString();
  let prepared: Awaited<ReturnType<typeof prepareInput>> | undefined;
  let server: ChildProcess | undefined;
  let report: MvpTranslateReport | undefined;
  try {
    prepared = await prepareInput(options.inputPath, output.directory, config);
    await assertPortAvailable();
    server = spawn(assets.llamaServer, llamaServerArgs(assets), {
      cwd: path.dirname(assets.llamaServer),
      env: offlineEnvironment(assets),
      windowsHide: true,
      stdio: "ignore",
    });
    await waitForServer(server);
    await runChild(assets.python, mangaTranslatorArgs(assets, prepared.path, imagesDirectory, prepared.batch, options.outsideText), {
      cwd: path.dirname(assets.main),
      env: offlineEnvironment(assets),
    });
    const outputImages = await countOutputImages(imagesDirectory);
    const failedImages = await consumeFailureList(imagesDirectory);
    if (outputImages === 0) throw new LocalizerError("MVP_NO_OUTPUT_IMAGES", "MangaTranslator completed without producing translated images");
    const cbzPath = path.join(output.directory, "translated.cbz");
    const packagedImages = await createMvpCbz(imagesDirectory, cbzPath);
    if (packagedImages !== outputImages) throw new LocalizerError("MVP_CBZ_PAGE_COUNT_MISMATCH", "CBZ page count does not match translated image count");
    report = {
      schemaVersion: 3,
      status: failedImages > 0 ? "partial" : "completed",
      startedAt,
      completedAt: new Date().toISOString(),
      inputKind: prepared.kind,
      outputImages,
      failedImages,
      outsideTextMode: options.outsideText ? "text-free-opencv" : "disabled",
      engine: { pipeline: "MangaTranslator", translator: "Hy-MT2-7B-Q4_K_M", ocr: "manga-ocr" },
      cbz: "translated.cbz",
    };
  } catch (error) {
    const failure = asLocalizerError(error, "MVP_TRANSLATION_FAILED");
    report = {
      schemaVersion: 3,
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      inputKind: prepared?.kind ?? "unknown",
      outputImages: await countOutputImages(imagesDirectory).catch(() => 0),
      failedImages: await consumeFailureList(imagesDirectory).catch(() => 0),
      outsideTextMode: options.outsideText ? "text-free-opencv" : "disabled",
      engine: { pipeline: "MangaTranslator", translator: "Hy-MT2-7B-Q4_K_M", ocr: "manga-ocr" },
      errorCode: failure.code,
    };
    await assertSchema("mvp-report.schema.json", report);
    await writeJsonExclusive(path.join(output.directory, "report.json"), report);
    throw new LocalizerError(failure.code, `${failure.message}. Results: ${output.directory}`, { cause: failure });
  } finally {
    await stopChild(server);
    if (prepared?.temporary) await unlink(prepared.temporary).catch(() => undefined);
  }
  await assertSchema("mvp-report.schema.json", report);
  await writeJsonExclusive(path.join(output.directory, "report.json"), report);
  return { directory: output.directory, imagesDirectory, cbzPath: path.join(output.directory, "translated.cbz"), report };
}
