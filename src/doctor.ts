import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, createReadStream, readFile } from "node:fs";
import { constants } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { KoharuClient, flattenEngineIds, selectEngine } from "./koharu-client.ts";
import { asLocalizerError, LocalizerError } from "./errors.ts";
import type { SafeLogger } from "./logger.ts";
import { assertSchema } from "./schema.ts";
import type { LocalizerConfig, ModelLock } from "./types.ts";

const execFileAsync = promisify(execFile);

export interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  code: string;
  detail: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
  gpu?: { name: string; memoryMiB: number; driver: string };
  koharu?: { version: string; device?: string; engineCount: number };
}

function normalizedVersion(version: string): string {
  return version.trim().replace(/^v/i, "").split(/[+-]/)[0];
}

export function compatibleVersion(actual: string, required: string): boolean {
  return normalizedVersion(actual) === normalizedVersion(required);
}

async function gpuInfo(): Promise<{ name: string; memoryMiB: number; driver: string }> {
  const { stdout } = await execFileAsync("nvidia-smi", ["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"], { timeout: 10_000, windowsHide: true });
  const line = stdout.trim().split(/\r?\n/)[0];
  const parts = line.split(",").map((item) => item.trim());
  if (parts.length < 3 || !Number.isFinite(Number(parts[1]))) throw new LocalizerError("GPU_OUTPUT_INVALID", "nvidia-smi returned an unexpected response");
  return { name: parts[0], memoryMiB: Number(parts[1]), driver: parts[2] };
}

async function sha256File(filePath: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function inspectModelLock(config: LocalizerConfig, checks: DoctorCheck[]): Promise<void> {
  const lockPath = path.resolve(config.modelsLockPath);
  try {
    await new Promise<void>((resolve, reject) => access(lockPath, constants.R_OK, (error) => error ? reject(error) : resolve()));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      checks.push({ name: "model-lock", status: "fail", code: "MODEL_LOCK_MISSING", detail: `${lockPath} does not exist; run benchmark before accepting a default model` });
      return;
    }
    throw error;
  }
  const lock = JSON.parse(await new Promise<string>((resolve, reject) => readFile(lockPath, "utf8", (error, data) => error ? reject(error) : resolve(data)))) as ModelLock;
  await assertSchema("model-lock.schema.json", lock);
  const selected = lock.models.filter((model) => model.selected);
  if (selected.length === 0) checks.push({ name: "model-lock", status: "fail", code: "MODEL_NOT_SELECTED", detail: "Model lock has no selected model" });
  for (const model of selected) {
    if (!model.localPath) {
      checks.push({ name: `model:${model.id}`, status: "fail", code: "MODEL_PATH_UNSET", detail: "Selected model has no localPath, so its checksum was not verified" });
      continue;
    }
    const modelPath = path.resolve(model.localPath);
    try {
      const actual = await sha256File(modelPath);
      checks.push(actual === model.sha256
        ? { name: `model:${model.id}`, status: "pass", code: "MODEL_HASH_OK", detail: modelPath }
        : { name: `model:${model.id}`, status: "fail", code: "MODEL_HASH_MISMATCH", detail: modelPath });
    } catch (error) {
      checks.push({ name: `model:${model.id}`, status: "fail", code: "MODEL_FILE_UNREADABLE", detail: modelPath });
    }
  }
}

export async function runDoctor(config: LocalizerConfig, options?: { logger?: SafeLogger; fetchImpl?: typeof fetch }): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const result: DoctorResult = { ok: false, checks };
  try {
    result.gpu = await gpuInfo();
    const expectedGpu = /RTX\s*4060/i.test(result.gpu.name);
    checks.push(result.gpu.memoryMiB >= 8_000 && expectedGpu
      ? { name: "gpu", status: "pass", code: "GPU_OK", detail: `${result.gpu.name}, ${result.gpu.memoryMiB} MiB, driver ${result.gpu.driver}` }
      : { name: "gpu", status: "warn", code: expectedGpu ? "GPU_MEMORY_LOW" : "GPU_UNEXPECTED", detail: `${result.gpu.name}, ${result.gpu.memoryMiB} MiB` });
  } catch (error) {
    checks.push({ name: "gpu", status: "warn", code: "GPU_NOT_DETECTED", detail: asLocalizerError(error).message });
  }

  try {
    const client = new KoharuClient(config.koharu, { fetchImpl: options?.fetchImpl, logger: options?.logger });
    const [meta, catalog] = await Promise.all([client.getMeta(), client.getEngines()]);
    const engines = flattenEngineIds(catalog);
    result.koharu = { version: meta.version, device: typeof meta.device === "string" ? meta.device : undefined, engineCount: engines.length };
    checks.push(compatibleVersion(meta.version, config.koharu.requiredVersion)
      ? { name: "koharu-version", status: "pass", code: "KOHARU_VERSION_OK", detail: meta.version }
      : { name: "koharu-version", status: "fail", code: "KOHARU_VERSION_MISMATCH", detail: `required ${config.koharu.requiredVersion}, found ${meta.version}` });
    const requiredEngines = [
      ["ocr-primary", selectEngine(catalog, "ocr", config.quality.primaryOcrHints)],
      ["ocr-fallback", selectEngine(catalog, "ocr", config.quality.fallbackOcrHints)],
      ["inpaint-primary", selectEngine(catalog, "inpaint", config.quality.primaryInpainterHints)],
      ["translator", selectEngine(catalog, "translat", ["translat"])],
      ["renderer", selectEngine(catalog, "render", ["render"])],
    ] as const;
    for (const [name, id] of requiredEngines) checks.push(id
      ? { name, status: "pass", code: "ENGINE_FOUND", detail: id }
      : { name, status: name.endsWith("fallback") ? "warn" : "fail", code: "ENGINE_MISSING", detail: "No matching engine in Koharu catalog" });
  } catch (error) {
    const failure = asLocalizerError(error, "KOHARU_CHECK_FAILED");
    checks.push({ name: "koharu", status: "fail", code: failure.code, detail: failure.message });
  }

  await inspectModelLock(config, checks);
  result.ok = checks.every((check) => check.status !== "fail");
  return result;
}
