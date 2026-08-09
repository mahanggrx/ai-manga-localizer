import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { compatibleVersion } from "../src/doctor.ts";
import { KoharuClient, flattenEngineIds, selectEngine, selectedPipelineEngine } from "../src/koharu-client.ts";

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
  const client = new KoharuClient({ ...DEFAULT_CONFIG.koharu, baseUrl: `http://127.0.0.1:${address.port}/api/v1`, operationTimeoutMs: 2000 });
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
    const client = new KoharuClient(DEFAULT_CONFIG.koharu, { fetchImpl: async () => new Response("private scene detail", { status }) });
    await assert.rejects(() => client.getMeta(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code?: string }).code, code);
      assert.doesNotMatch(error.message, /private scene detail/);
      return true;
    });
  }
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
  const client = new KoharuClient(DEFAULT_CONFIG.koharu, {
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
