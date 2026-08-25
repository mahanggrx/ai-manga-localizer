import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { compatibleVersion } from "../src/doctor.ts";
import { KoharuClient, flattenEngineIds, selectEngine, selectedPipelineEngine } from "../src/koharu-client.ts";

const OWNED_CLIENT_CONFIG = { ...DEFAULT_CONFIG.koharu, mode: "owned" as const };
const ownedMutationGuard = async (): Promise<void> => undefined;

test("Koharu client reads meta, catalogs engines, and completes an SSE job", async () => {
  let operation = "op-1";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/v1/meta") return void response.end(JSON.stringify({ version: "0.61.2", mlDevice: "auto" }));
    if (url.pathname === "/api/v1/engines") return void response.end(JSON.stringify({ ocr: [{ id: "paddle-ocr-vl-1.6" }, { id: "manga-ocr" }], renderer: [{ id: "manga-renderer" }] }));
    if (url.pathname === "/api/v1/pipelines") {
      operation = "op-2";
      response.setHeader("content-type", "application/json");
      return void response.end(JSON.stringify({ operationId: operation }));
    }
    if (url.pathname === "/api/v1/events") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      return void response.end(`id: 1\nevent: JobFinished\ndata: ${JSON.stringify({ type: "JobFinished", operationId: operation })}\n\n`);
    }
    response.statusCode = 404;
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new KoharuClient({ ...OWNED_CLIENT_CONFIG, baseUrl: `http://127.0.0.1:${address.port}/api/v1`, operationTimeoutMs: 2000 }, { ownedMutationGuard });
  try {
    const meta = await client.getMeta();
    assert.equal(meta.version, "0.61.2");
    assert.equal(meta.device, "auto");
    const catalog = await client.getEngines();
    assert.equal(selectEngine(catalog, "ocr", ["paddle", "1.6"]), "paddle-ocr-vl-1.6");
    assert.ok(flattenEngineIds(catalog).length >= 3);
    const result = await client.runPipeline({ steps: ["paddle-ocr-vl-1.6"] });
    assert.equal(result.operationId, "op-2");
  } finally {
    server.close();
    await once(server, "close");
  }
  assert.equal(compatibleVersion("v0.61.2+build", "0.61.2"), true);
});

test("operation polling prefers status over kind after SSE reconnect exhaustion", async () => {
  let eventCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/events")) {
      eventCalls += 1;
      return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname.endsWith("/operations")) return new Response(JSON.stringify([{ id: "op-poll", kind: "pipeline", status: "completed" }]), { headers: { "content-type": "application/json" } });
    return new Response(null, { status: 404 });
  };
  const client = new KoharuClient({ ...DEFAULT_CONFIG.koharu, operationTimeoutMs: 1000 }, { fetchImpl });
  const result = await client.waitForOperation("op-poll");
  assert.deepEqual(result.warnings, []);
  assert.equal(eventCalls, 3);
});

test("completed_with_errors fails closed in operation polling", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/events")) return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
    if (url.pathname.endsWith("/operations")) return new Response(JSON.stringify([{ id: "op-errors", kind: "pipeline", status: "completed_with_errors" }]), { headers: { "content-type": "application/json" } });
    return new Response(null, { status: 404 });
  };
  const client = new KoharuClient({ ...DEFAULT_CONFIG.koharu, operationTimeoutMs: 1000 }, { fetchImpl });
  await assert.rejects(() => client.waitForOperation("op-errors"), (error: unknown) => {
    assert.equal((error as Error & { code?: string }).code, "KOHARU_PIPELINE_FAILED");
    return true;
  });
});

test("completed_with_errors fails closed in a terminal SSE event", async () => {
  const payload = JSON.stringify({ type: "JobFinished", job: { id: "op-sse-errors", status: "completed_with_errors" } });
  const fetchImpl: typeof fetch = async () => new Response(`event: JobFinished\ndata: ${payload}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
  const client = new KoharuClient({ ...DEFAULT_CONFIG.koharu, operationTimeoutMs: 1000 }, { fetchImpl });
  await assert.rejects(() => client.waitForOperation("op-sse-errors"), (error: unknown) => {
    assert.equal((error as Error & { code?: string }).code, "KOHARU_PIPELINE_FAILED");
    return true;
  });
});

test("HTTP errors omit potentially sensitive response bodies", async () => {
  const fetchImpl: typeof fetch = async () => new Response("OCR text must not escape in error messages", { status: 500 });
  const client = new KoharuClient(DEFAULT_CONFIG.koharu, { fetchImpl });
  await assert.rejects(() => client.getMeta(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /OCR text/);
    assert.match(error.message, /body omitted/);
    return true;
  });
});

test("startup and epoch conflicts fail closed with stable error codes", async () => {
  for (const [status, code] of [[503, "KOHARU_BOOTSTRAPPING"], [409, "KOHARU_EPOCH_CONFLICT"]] as const) {
    let bodyCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("private scene detail")); },
      cancel() { bodyCancelled = true; },
    });
    const client = new KoharuClient(DEFAULT_CONFIG.koharu, { fetchImpl: async () => new Response(body, { status }) });
    await assert.rejects(() => client.getMeta(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code?: string }).code, code);
      assert.doesNotMatch(error.message, /private scene detail/);
      return true;
    });
    assert.equal(bodyCancelled, true);
  }
});

test("owned startup waits through bootstrapping and rechecks process identity", async () => {
  let metaCalls = 0;
  let identityChecks = 0;
  const fetchImpl: typeof fetch = async () => {
    metaCalls += 1;
    if (metaCalls === 1) return new Response(null, { status: 503 });
    return new Response(JSON.stringify({ version: "0.61.2" }), { headers: { "content-type": "application/json" } });
  };
  const client = new KoharuClient({ ...OWNED_CLIENT_CONFIG, operationTimeoutMs: 1000 }, { fetchImpl, ownedMutationGuard });
  const meta = await client.waitUntilReady(async () => { identityChecks += 1; });
  assert.equal(meta.version, "0.61.2");
  assert.equal(metaCalls, 2);
  assert.equal(identityChecks, 2);
});

test("engine selection ignores display names and produced component labels", () => {
  const catalog = {
    ocr: [{ id: "manga-ocr", name: "Manga OCR", produces: ["OcrText"] }],
    inpainters: [{ id: "aot-inpainting", name: "AOT Inpainting", produces: ["Inpainted"] }],
    renderers: [{ id: "koharu-renderer", name: "Koharu Renderer", produces: ["FinalRender", "RenderedSprites"] }],
  } as const;
  assert.deepEqual(flattenEngineIds(catalog as never).map((entry) => entry.id), ["manga-ocr", "aot-inpainting", "koharu-renderer"]);
  assert.equal(selectEngine(catalog as never, "ocr", ["manga"]), "manga-ocr");
  assert.equal(selectEngine(catalog as never, "inpaint", ["aot"]), "aot-inpainting");
  assert.equal(selectEngine(catalog as never, "render", ["render"]), "koharu-renderer");
});

test("pipeline selection accepts Koharu snake_case stage keys", () => {
  const config = {
    pipeline: {
      detector: "pp-doclayout-v3",
      font_detector: "yuzumarker-font-detection",
      bubble_segmenter: "speech-bubble-segmentation",
    },
  } as const;
  assert.equal(selectedPipelineEngine(config as never, "detector"), "pp-doclayout-v3");
  assert.equal(selectedPipelineEngine(config as never, "fontDetector"), "yuzumarker-font-detection");
  assert.equal(selectedPipelineEngine(config as never, "bubbleSegmenter"), "speech-bubble-segmentation");
});

test("LLM load uses the Koharu 0.61.2 target envelope", async () => {
  let body: unknown;
  const client = new KoharuClient(OWNED_CLIENT_CONFIG, {
    ownedMutationGuard,
    fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(null, { status: 204 });
    },
  });
  await client.loadLlm(DEFAULT_CONFIG.translation.localTarget);
  assert.deepEqual(body, {
    target: { kind: "local", modelId: "sakura-galtransl-7b-v3.7" },
    options: { temperature: 0.3, maxTokens: 8192 },
  });
});

test("blob reads accept only valid hashes from loopback and enforce the byte limit", async () => {
  const hash = "a".repeat(64);
  let requestedPath = "";
  const client = new KoharuClient(DEFAULT_CONFIG.koharu, {
    blobMaxBytes: 4,
    fetchImpl: async (input, init) => {
      requestedPath = new URL(String(input)).pathname;
      assert.equal(init?.redirect, "error");
      return new Response(new Uint8Array([1, 2, 3, 4]));
    },
  });
  assert.deepEqual(await client.readBlob(hash), new Uint8Array([1, 2, 3, 4]));
  assert.match(requestedPath, new RegExp(`/blobs/${hash}$`));
  await assert.rejects(() => client.readBlob("../private"), (error: unknown) => (error as { code?: string }).code === "KOHARU_BLOB_HASH_INVALID");

  const oversized = new KoharuClient(DEFAULT_CONFIG.koharu, {
    blobMaxBytes: 4,
    fetchImpl: async () => new Response(new Uint8Array([1, 2, 3, 4, 5])),
  });
  await assert.rejects(() => oversized.readBlob(hash), (error: unknown) => (error as { code?: string }).code === "KOHARU_BLOB_TOO_LARGE");

  let bootstrapBodyCancelled = false;
  const bootstrapBody = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("private boot detail")); },
    cancel() { bootstrapBodyCancelled = true; },
  });
  const bootstrapping = new KoharuClient(DEFAULT_CONFIG.koharu, {
    fetchImpl: async () => new Response(bootstrapBody, { status: 503 }),
  });
  await assert.rejects(() => bootstrapping.readBlob(hash), (error: unknown) => (error as { code?: string }).code === "KOHARU_BOOTSTRAPPING");
  assert.equal(bootstrapBodyCancelled, true);

  const remote = new KoharuClient({ ...DEFAULT_CONFIG.koharu, baseUrl: "https://koharu.example/api/v1", allowRemote: true }, {
    fetchImpl: async () => assert.fail("remote blob reads must fail before fetch"),
  });
  await assert.rejects(() => remote.readBlob(hash), (error: unknown) => (error as { code?: string }).code === "KOHARU_BLOB_REMOTE_FORBIDDEN");
});

test("blob reads time out without logging hashes, response bodies, or image details", async () => {
  const hash = "b".repeat(64);
  const logCalls: unknown[] = [];
  const logger = {
    info: (...args: unknown[]) => logCalls.push(args),
    warn: (...args: unknown[]) => logCalls.push(args),
    error: (...args: unknown[]) => logCalls.push(args),
  };
  const timeoutClient = new KoharuClient(DEFAULT_CONFIG.koharu, {
    blobTimeoutMs: 10,
    logger,
    fetchImpl: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  });
  await assert.rejects(() => timeoutClient.readBlob(hash), (error: unknown) => (error as { code?: string }).code === "KOHARU_BLOB_TIMEOUT");

  const privateBody = "OCR text, blob hash, and private image dimensions must not escape";
  const errorClient = new KoharuClient(DEFAULT_CONFIG.koharu, {
    logger,
    fetchImpl: async () => new Response(privateBody, { status: 500 }),
  });
  await assert.rejects(() => errorClient.readBlob(hash), (error: unknown) => {
    const message = String(error);
    assert.doesNotMatch(message, /OCR text|private image|dimensions/);
    assert.doesNotMatch(message, new RegExp(hash));
    return true;
  });
  assert.deepEqual(logCalls, []);
});

test("0.61.2 scene, project, operation, Batch, and textNodeIds contracts are typed and exact", async () => {
  const requests: Array<{ path: string; method: string; body?: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ path: url.pathname, method, body });
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    if (url.pathname.endsWith("/scene.json")) return json({ epoch: 4, scene: { pages: {} } });
    if (url.pathname.endsWith("/operations")) return json({ operations: [] });
    if (url.pathname.endsWith("/projects") && method === "POST") return json({ project: { id: "project-1", name: "owned" } });
    if (url.pathname.endsWith("/projects")) return json({ projects: [{ id: "project-1", name: "owned" }] });
    if (url.pathname.endsWith("/history/apply")) return json({ epoch: 5 });
    if (url.pathname.endsWith("/pipelines")) return json({ operationId: "op-text" });
    return json({});
  };
  const client = new KoharuClient(OWNED_CLIENT_CONFIG, { fetchImpl, ownedMutationGuard });
  assert.deepEqual(await client.getSceneSnapshot(), { epoch: 4, scene: { pages: {} } });
  assert.deepEqual(await client.getOperationSnapshot(), { operations: [] });
  assert.equal((await client.createProject("owned")).id, "project-1");
  assert.deepEqual((await client.listProjects()).projects.map((project) => project.id), ["project-1"]);
  assert.deepEqual(await client.applySourceTextBatch(4, [{ pageId: "p1", nodeId: "r1", sourceText: "private-source" }], "selected OCR"), { epoch: 5 });
  assert.equal(await client.startPipeline({ steps: ["translator"], pages: ["p1"], textNodeIds: ["r1"] }), "op-text");
  assert.equal(await client.startPipeline({ steps: ["renderer"], pages: ["p1"], defaultFont: "Synthetic Sans" }), "op-text");
  const history = requests.find((request) => request.path.endsWith("/history/apply"));
  assert.deepEqual(history?.body, {
    batch: { label: "selected OCR", ops: [{ updateNode: { page: "p1", id: "r1", patch: { data: { text: { text: "private-source" } } } } }] },
  });
  const pipelines = requests.filter((request) => request.path.endsWith("/pipelines"));
  assert.deepEqual(pipelines.map((request) => request.body), [
    { steps: ["translator"], pages: ["p1"], textNodeIds: ["r1"] },
    { steps: ["renderer"], pages: ["p1"], defaultFont: "Synthetic Sans" },
  ]);
});

test("external client mutation APIs fail before network access", async () => {
  let fetchCalls = 0;
  const client = new KoharuClient(DEFAULT_CONFIG.koharu, { fetchImpl: async () => { fetchCalls += 1; return new Response("{}"); } });
  await assert.rejects(() => client.createProject("forbidden"), (error: unknown) => (error as { code?: string }).code === "KOHARU_SAFE_SOURCE_TEXT_WRITEBACK_UNAVAILABLE");
  await assert.rejects(() => client.startPipeline({ steps: ["translator"] }), (error: unknown) => (error as { code?: string }).code === "KOHARU_SAFE_SOURCE_TEXT_WRITEBACK_UNAVAILABLE");
  await assert.rejects(() => client.applySourceTextBatch(0, [{ pageId: "p", nodeId: "n", sourceText: "private" }], "forbidden"), (error: unknown) => (error as { code?: string }).code === "KOHARU_SAFE_SOURCE_TEXT_WRITEBACK_UNAVAILABLE");
  assert.equal(fetchCalls, 0);
});
