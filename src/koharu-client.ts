import { setTimeout as delay } from "node:timers/promises";
import { LocalizerError } from "./errors.ts";
import { assertSceneSnapshot } from "./scene-integrity.ts";
import { parseSseStream } from "./sse.ts";
import type { SafeLogger } from "./logger.ts";
import type {
  InputImage,
  JsonObject,
  JsonValue,
  KoharuMeta,
  KoharuOperationSnapshot,
  KoharuProjectIdentity,
  KoharuProjectsSnapshot,
  KoharuSceneSnapshot,
  KoharuSourceTextPatch,
  LlmTarget,
  LocalizerConfig,
  PipelineRunRequest,
} from "./types.ts";

type FetchLike = typeof fetch;

export const KOHARU_BLOB_MAX_BYTES = 32 * 1024 * 1024;
export const KOHARU_BLOB_TIMEOUT_MS = 10_000;
const KOHARU_BLOB_MAX_CHUNKS = 4_096;

interface KoharuClientOptions {
  fetchImpl?: FetchLike;
  logger?: SafeLogger;
  blobMaxBytes?: number;
  blobTimeoutMs?: number;
  ownedMutationGuard?: () => Promise<void>;
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function eventKind(value: unknown, fallback?: string): string | undefined {
  if (typeof value !== "object" || value === null) return fallback;
  const record = value as Record<string, unknown>;
  for (const key of ["type", "kind", "event", "status"]) if (typeof record[key] === "string") return record[key] as string;
  return fallback;
}

function operationId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["operationId", "jobId", "id"]) if (typeof record[key] === "string") return record[key] as string;
  for (const key of ["job", "operation", "data"]) {
    const nested = operationId(record[key]);
    if (nested) return nested;
  }
  for (const nestedValue of Object.values(record)) {
    const nested = operationId(nestedValue);
    if (nested) return nested;
  }
  return undefined;
}

function operationStatus(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["status", "state", "result"]) if (typeof record[key] === "string") return record[key] as string;
  for (const key of ["job", "operation", "data"]) {
    const nested = operationStatus(record[key]);
    if (nested) return nested;
  }
  return eventKind(value);
}

function failedOperationStatus(status: string): boolean {
  return ["failed", "error", "cancelled"].some((value) => status.includes(value));
}

export class KoharuClient {
  readonly baseUrl: URL;
  readonly eventsUrl: URL;
  private readonly requestTimeoutMs: number;
  private readonly operationTimeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly logger?: SafeLogger;
  private readonly blobMaxBytes: number;
  private readonly blobTimeoutMs: number;
  private readonly ownedMode: boolean;
  private readonly ownedMutationGuard?: () => Promise<void>;

  constructor(config: LocalizerConfig["koharu"], options?: KoharuClientOptions) {
    this.baseUrl = new URL(config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`);
    if (!["http:", "https:"].includes(this.baseUrl.protocol)) throw new LocalizerError("KOHARU_URL_PROTOCOL", "Koharu URL must use HTTP or HTTPS");
    if (!config.allowRemote && !isLoopback(this.baseUrl.hostname)) throw new LocalizerError("KOHARU_REMOTE_FORBIDDEN", "Remote Koharu URLs require koharu.allowRemote=true");
    this.eventsUrl = new URL("events", this.baseUrl);
    this.requestTimeoutMs = config.requestTimeoutMs;
    this.operationTimeoutMs = config.operationTimeoutMs;
    this.fetchImpl = options?.fetchImpl ?? fetch;
    this.logger = options?.logger;
    this.blobMaxBytes = options?.blobMaxBytes ?? KOHARU_BLOB_MAX_BYTES;
    this.blobTimeoutMs = options?.blobTimeoutMs ?? Math.min(config.requestTimeoutMs, KOHARU_BLOB_TIMEOUT_MS);
    this.ownedMode = config.mode === "owned";
    this.ownedMutationGuard = options?.ownedMutationGuard;
    if (!Number.isSafeInteger(this.blobMaxBytes) || this.blobMaxBytes < 1) throw new LocalizerError("KOHARU_BLOB_LIMIT_INVALID", "Koharu blob byte limit must be a positive safe integer");
    if (!Number.isSafeInteger(this.blobTimeoutMs) || this.blobTimeoutMs < 1) throw new LocalizerError("KOHARU_BLOB_TIMEOUT_INVALID", "Koharu blob timeout must be a positive safe integer");
  }

  private async assertOwnedMutation(): Promise<void> {
    if (!this.ownedMode || !this.ownedMutationGuard) {
      throw new LocalizerError("KOHARU_SAFE_SOURCE_TEXT_WRITEBACK_UNAVAILABLE", "Koharu mutation requires a verified runner-owned process");
    }
    await this.ownedMutationGuard();
  }

  private async request(path: string, init: RequestInit = {}, timeoutMs = this.requestTimeoutMs): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(new URL(path, this.baseUrl), { ...init, signal: controller.signal });
      if (response.status === 503) {
        await response.body?.cancel().catch(() => undefined);
        throw new LocalizerError("KOHARU_BOOTSTRAPPING", "Koharu is still bootstrapping", { status: 503, recoverable: true });
      }
      if (response.status === 409) {
        await response.body?.cancel().catch(() => undefined);
        throw new LocalizerError("KOHARU_EPOCH_CONFLICT", "Koharu rejected the operation because the scene epoch changed; response body omitted for content privacy", { status: 409, recoverable: true });
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new LocalizerError("KOHARU_HTTP_ERROR", `Koharu returned HTTP ${response.status}; response body omitted for content privacy`, { status: response.status, recoverable: response.status >= 500 });
      }
      return response;
    } catch (error) {
      if (error instanceof LocalizerError) throw error;
      if ((error as Error).name === "AbortError") throw new LocalizerError("KOHARU_TIMEOUT", `Koharu request timed out: ${path}`, { recoverable: true, cause: error });
      throw new LocalizerError("KOHARU_UNREACHABLE", `Cannot reach Koharu at ${this.baseUrl.origin}`, { recoverable: true, cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(path, init);
    return await response.json() as T;
  }

  async getMeta(): Promise<KoharuMeta> {
    const meta = await this.json<Record<string, unknown>>("meta");
    const version = typeof meta.version === "string" ? meta.version : typeof meta.appVersion === "string" ? meta.appVersion : undefined;
    if (!version) throw new LocalizerError("KOHARU_META_INVALID", "Koharu /meta response has no version");
    const device = typeof meta.device === "string" ? meta.device : typeof meta.mlDevice === "string" ? meta.mlDevice : undefined;
    return { ...meta, version, ...(device ? { device } : {}) } as KoharuMeta;
  }

  async waitUntilReady(beforeAttempt?: () => Promise<void>): Promise<KoharuMeta> {
    const deadline = Date.now() + this.operationTimeoutMs;
    while (true) {
      await beforeAttempt?.();
      try {
        return await this.getMeta();
      } catch (error) {
        if (!(error instanceof LocalizerError) || error.code !== "KOHARU_BOOTSTRAPPING" || Date.now() >= deadline) throw error;
        await delay(Math.min(250, Math.max(1, deadline - Date.now())));
      }
    }
  }

  async getEngines(): Promise<JsonValue> { return await this.json<JsonValue>("engines"); }
  async getConfig(): Promise<JsonObject> { return await this.json<JsonObject>("config"); }
  async getSceneSnapshot(): Promise<KoharuSceneSnapshot> {
    const snapshot = await this.json<unknown>("scene.json");
    assertSceneSnapshot(snapshot);
    return snapshot;
  }
  async getScene(): Promise<JsonObject> { return (await this.getSceneSnapshot()).scene; }
  async getOperations(): Promise<JsonValue> { return await this.json<JsonValue>("operations"); }
  async getOperationSnapshot(): Promise<KoharuOperationSnapshot> {
    const snapshot = await this.getOperations();
    const operations = Array.isArray(snapshot)
      ? snapshot
      : snapshot && typeof snapshot === "object" && Array.isArray(snapshot.operations)
        ? snapshot.operations
        : undefined;
    if (!operations) throw new LocalizerError("KOHARU_OPERATIONS_INVALID", "Koharu /operations response has no operation array");
    return { operations };
  }

  async readBlob(hash: string): Promise<Uint8Array> {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new LocalizerError("KOHARU_BLOB_HASH_INVALID", "Koharu blob hash is invalid");
    if (!isLoopback(this.baseUrl.hostname)) throw new LocalizerError("KOHARU_BLOB_REMOTE_FORBIDDEN", "Koharu blob reads are restricted to loopback hosts");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.blobTimeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.fetchImpl(new URL(`blobs/${hash}`, this.baseUrl), {
        headers: { accept: "application/octet-stream,image/webp" },
        redirect: "error",
        signal: controller.signal,
      });
      if (response.status === 503) {
        await response.body?.cancel().catch(() => undefined);
        throw new LocalizerError("KOHARU_BOOTSTRAPPING", "Koharu is still bootstrapping", { status: 503, recoverable: true });
      }
      if (response.status === 409) {
        await response.body?.cancel().catch(() => undefined);
        throw new LocalizerError("KOHARU_EPOCH_CONFLICT", "Koharu rejected the blob read because the scene epoch changed; response body omitted for content privacy", { status: 409, recoverable: true });
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new LocalizerError("KOHARU_BLOB_HTTP_ERROR", `Koharu blob endpoint returned HTTP ${response.status}; response body omitted for content privacy`, { status: response.status, recoverable: response.status >= 500 });
      }
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null) {
        const declaredBytes = Number(contentLength);
        if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > this.blobMaxBytes) {
          await response.body?.cancel().catch(() => undefined);
          throw new LocalizerError("KOHARU_BLOB_TOO_LARGE", "Koharu blob exceeds the response byte limit");
        }
      }
      if (!response.body) throw new LocalizerError("KOHARU_BLOB_EMPTY", "Koharu blob response has no body");
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > this.blobMaxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new LocalizerError("KOHARU_BLOB_TOO_LARGE", "Koharu blob exceeds the response byte limit");
        }
        if (chunks.length >= KOHARU_BLOB_MAX_CHUNKS) {
          await reader.cancel().catch(() => undefined);
          throw new LocalizerError("KOHARU_BLOB_STREAM_INVALID", "Koharu blob response contains too many chunks");
        }
        chunks.push(value);
      }
      if (totalBytes === 0) throw new LocalizerError("KOHARU_BLOB_EMPTY", "Koharu blob response is empty");
      const bytes = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    } catch (error) {
      if (error instanceof LocalizerError) throw error;
      if ((error as Error).name === "AbortError") throw new LocalizerError("KOHARU_BLOB_TIMEOUT", "Koharu blob read timed out", { recoverable: true });
      throw new LocalizerError("KOHARU_BLOB_UNREACHABLE", `Cannot read a blob from Koharu at ${this.baseUrl.origin}`, { recoverable: true });
    } finally {
      clearTimeout(timer);
      reader?.releaseLock();
      controller.abort();
    }
  }

  async createProject(name: string): Promise<KoharuProjectIdentity> {
    await this.assertOwnedMutation();
    const response = await this.json<JsonObject>("projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const project = response.project && typeof response.project === "object" && !Array.isArray(response.project) ? response.project : response;
    if (typeof project.id !== "string" || project.id.length === 0) throw new LocalizerError("KOHARU_PROJECT_ID_MISSING", "Koharu project creation response has no project id");
    return {
      id: project.id,
      ...(typeof project.name === "string" ? { name: project.name } : {}),
      ...(typeof project.path === "string" ? { path: project.path } : {}),
    };
  }

  async listProjects(): Promise<KoharuProjectsSnapshot> {
    const response = await this.json<JsonValue>("projects");
    const projects = Array.isArray(response)
      ? response
      : response && typeof response === "object" && Array.isArray(response.projects)
        ? response.projects
        : undefined;
    if (!projects) throw new LocalizerError("KOHARU_PROJECTS_INVALID", "Koharu projects response has no project array");
    return {
      projects: projects.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.id !== "string" || item.id.length === 0) {
          throw new LocalizerError("KOHARU_PROJECTS_INVALID", "Koharu projects response contains an invalid project identity");
        }
        return {
          id: item.id,
          ...(typeof item.name === "string" ? { name: item.name } : {}),
          ...(typeof item.path === "string" ? { path: item.path } : {}),
        };
      }),
    };
  }

  async uploadPages(images: InputImage[]): Promise<JsonValue> {
    await this.assertOwnedMutation();
    const form = new FormData();
    for (const image of images) form.append("files", new Blob([image.bytes], { type: image.mediaType }), image.fileName);
    return await this.json<JsonValue>("pages", { method: "POST", body: form });
  }

  async applySourceTextBatch(observedEpoch: number, patches: KoharuSourceTextPatch[], label: string): Promise<{ epoch: number }> {
    await this.assertOwnedMutation();
    if (!Number.isSafeInteger(observedEpoch) || observedEpoch < 0) throw new LocalizerError("KOHARU_EPOCH_INVALID", "History apply requires a locally observed non-negative safe epoch");
    if (patches.length === 0) throw new LocalizerError("KOHARU_HISTORY_BATCH_EMPTY", "History Batch must contain at least one source-text patch");
    // Koharu 0.61.2 accepts an Op directly and has no expected-epoch field.
    // observedEpoch is intentionally local evidence, never represented as CAS.
    const response = await this.json<JsonObject>("history/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        batch: {
          label,
          ops: patches.map((patch) => ({
            updateNode: {
              page: patch.pageId,
              id: patch.nodeId,
              patch: { data: { text: { text: patch.sourceText } } },
            },
          })),
        },
      }),
    });
    if (!Number.isSafeInteger(response.epoch) || Number(response.epoch) < 0) throw new LocalizerError("KOHARU_HISTORY_RESPONSE_INVALID", "Koharu history response has no valid epoch");
    return { epoch: Number(response.epoch) };
  }

  async loadLlm(target: LlmTarget): Promise<void> {
    await this.assertOwnedMutation();
    const { options, ...targetIdentity } = target;
    await this.request("llm/current", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: targetIdentity, ...(options ? { options } : {}) }),
    });
  }

  async unloadLlm(): Promise<void> { await this.assertOwnedMutation(); await this.request("llm/current", { method: "DELETE" }); }

  async getLlmState(): Promise<JsonValue> { return await this.json<JsonValue>("llm/current"); }

  async waitForLlmReady(timeoutMs = this.operationTimeoutMs): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.getLlmState();
      const kind = eventKind(state)?.toLowerCase();
      if (kind && ["ready", "loaded", "running"].includes(kind)) return;
      if (kind && ["error", "failed"].includes(kind)) throw new LocalizerError("KOHARU_LLM_LOAD_FAILED", "Koharu failed to load the LLM; service detail omitted for content privacy");
      await delay(500);
    }
    throw new LocalizerError("KOHARU_LLM_LOAD_TIMEOUT", "Timed out waiting for Koharu LLM", { recoverable: true });
  }

  async startPipeline(request: PipelineRunRequest): Promise<string> {
    await this.assertOwnedMutation();
    if (request.steps.length === 0) throw new LocalizerError("PIPELINE_EMPTY", "Pipeline must contain at least one engine id");
    const result = await this.json<Record<string, unknown>>("pipelines", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const id = operationId(result);
    if (!id) throw new LocalizerError("KOHARU_OPERATION_ID_MISSING", "Koharu pipeline response has no operation id");
    return id;
  }

  async waitForOperation(id: string): Promise<{ warnings: string[] }> {
    const warnings: string[] = [];
    const deadline = Date.now() + this.operationTimeoutMs;
    let lastEventId: string | undefined;
    let reconnects = 0;
    while (Date.now() < deadline && reconnects < 3) {
      const controller = new AbortController();
      const remaining = deadline - Date.now();
      const timer = setTimeout(() => controller.abort(), Math.min(remaining, this.requestTimeoutMs));
      try {
        const headers: Record<string, string> = { accept: "text/event-stream" };
        if (lastEventId) headers["last-event-id"] = lastEventId;
        const response = await this.fetchImpl(this.eventsUrl, { headers, signal: controller.signal });
        if (!response.ok || !response.body) throw new LocalizerError("KOHARU_SSE_ERROR", `Koharu event stream returned HTTP ${response.status}`, { recoverable: true });
        for await (const message of parseSseStream(response.body)) {
          if (message.id) lastEventId = message.id;
          const payload = message.json;
          const event = (eventKind(payload, message.event) ?? "").toLowerCase();
          const status = (operationStatus(payload) ?? "").toLowerCase();
          const payloadId = operationId(payload);
          if (payloadId !== id) continue;
          if (event.includes("warning")) {
            warnings.push("KOHARU_PIPELINE_WARNING");
            this.logger?.warn("KOHARU_JOB_WARNING", { operationId: id, count: warnings.length });
          }
          if (failedOperationStatus(status) || failedOperationStatus(event)) {
            throw new LocalizerError("KOHARU_PIPELINE_FAILED", `Pipeline ${id} failed; service detail omitted for content privacy`, { recoverable: true });
          }
          if (event.includes("finished") || event === "completed" || event === "success") return { warnings };
        }
        // A cleanly closed stream is still a lost subscription until a terminal
        // event arrives. Count it so the documented polling fallback is reached.
        reconnects += 1;
      } catch (error) {
        if (error instanceof LocalizerError && error.code === "KOHARU_PIPELINE_FAILED") throw error;
        reconnects += 1;
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    }
    return await this.pollOperation(id, warnings, deadline);
  }

  private async pollOperation(id: string, warnings: string[], deadline: number): Promise<{ warnings: string[] }> {
    while (Date.now() < deadline) {
      const snapshot = await this.getOperations();
      const records = Array.isArray(snapshot) ? snapshot : typeof snapshot === "object" && snapshot !== null && Array.isArray((snapshot as JsonObject).operations) ? (snapshot as JsonObject).operations as JsonValue[] : [];
      const operation = records.find((item) => operationId(item) === id);
      if (operation) {
        const status = (operationStatus(operation) ?? "").toLowerCase();
        if (failedOperationStatus(status)) throw new LocalizerError("KOHARU_PIPELINE_FAILED", `Pipeline ${id} failed; service detail omitted for content privacy`, { recoverable: true });
        if (["finished", "completed", "success", "succeeded"].some((value) => status.includes(value))) return { warnings };
      }
      await delay(500);
    }
    throw new LocalizerError("KOHARU_OPERATION_TIMEOUT", `Timed out waiting for pipeline ${id}`, { recoverable: true });
  }

  async runPipeline(request: PipelineRunRequest): Promise<{ operationId: string; warnings: string[] }> {
    const id = await this.startPipeline(request);
    this.logger?.info("KOHARU_JOB_STARTED", { operationId: id });
    const result = await this.waitForOperation(id);
    return { operationId: id, ...result };
  }

  async exportProject(format: "khr" | "psd" | "rendered" | "inpainted", pages?: string[]): Promise<{ bytes: Uint8Array; contentType: string }> {
    await this.assertOwnedMutation();
    const response = await this.request("projects/current/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ format, ...(pages ? { pages } : {}) }),
    }, this.operationTimeoutMs);
    return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get("content-type") ?? "application/octet-stream" };
  }
}

export function flattenEngineIds(catalog: JsonValue): Array<{ path: string; id: string }> {
  const result: Array<{ path: string; id: string }> = [];
  const walk = (value: JsonValue, parts: string[]): void => {
    if (Array.isArray(value)) value.forEach((item, index) => walk(item, [...parts, String(index)]));
    else if (value && typeof value === "object") {
      const record = value as JsonObject;
      const directId = typeof record.id === "string" ? record.id : typeof record.engineId === "string" ? record.engineId : undefined;
      if (directId) result.push({ path: parts.join("."), id: directId });
      for (const [key, item] of Object.entries(record)) {
        if (item && typeof item === "object") walk(item, [...parts, key]);
      }
    }
  };
  walk(catalog, []);
  return [...new Map(result.map((entry) => [entry.id, entry])).values()];
}

export function selectEngine(catalog: JsonValue, stageHint: string, preferredHints: string[]): string | undefined {
  const stage = stageHint.toLowerCase();
  const hints = preferredHints.map((hint) => hint.toLowerCase());
  const entries = flattenEngineIds(catalog).filter((entry) => `${entry.path} ${entry.id}`.toLowerCase().includes(stage));
  const scored = entries.map((entry) => ({
    entry,
    score: hints.reduce((score, hint) => score + (`${entry.path} ${entry.id}`.toLowerCase().includes(hint) ? 1 : 0), 0),
  })).sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
  return scored[0]?.score ? scored[0].entry.id : entries[0]?.id;
}

export function selectedPipelineEngine(config: JsonObject, stage: string): string | undefined {
  const pipeline = config.pipeline;
  if (!pipeline || typeof pipeline !== "object" || Array.isArray(pipeline)) return undefined;
  const snakeCaseStage = stage.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  for (const key of new Set([stage, snakeCaseStage])) {
    const value = (pipeline as JsonObject)[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}
