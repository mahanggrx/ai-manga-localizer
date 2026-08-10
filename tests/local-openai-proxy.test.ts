import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { normalizeNumberedListDelimiters, sanitizeChatCompletion, startLocalOpenAiProxy, stripModelReasoning } from "../src/local-openai-proxy.ts";

test("reasoning sanitizer returns only the final translation and fails closed on malformed tags", () => {
  assert.equal(stripModelReasoning("<think>private analysis</think>最终译文"), "最终译文");
  assert.equal(stripModelReasoning("  直接译文  "), "直接译文");
  assert.throws(() => stripModelReasoning("<think>unterminated"), /unterminated reasoning block/i);
  assert.throws(() => stripModelReasoning("译文<think>late block</think>"), /outside the supported leading block/i);
  const sanitized = sanitizeChatCompletion({
    choices: [{ message: { content: "<think>private analysis</think>最终译文", reasoning_content: "private analysis" } }],
  });
  assert.deepEqual(sanitized, { choices: [{ message: { content: "最终译文" } }] });
});

test("numbered translation output normalizes full-width delimiters only for a complete sequential list", () => {
  assert.equal(normalizeNumberedListDelimiters("1：第一条\n2﹕第二条"), "1: 第一条\n2: 第二条");
  assert.equal(normalizeNumberedListDelimiters("时间：午夜"), "时间：午夜");
  assert.equal(normalizeNumberedListDelimiters("1：第一条\n3：第三条"), "1：第一条\n3：第三条");
});

test("local proxy forwards model discovery and sanitizes non-streaming completions", async (context) => {
  let observedRequest: Record<string, unknown> | undefined;
  const upstream = createServer(async (request, response) => {
    if (request.url === "/health") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "local-test-model" }] }));
      return;
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(chunk);
    observedRequest = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    response.setHeader("content-type", "application/json");
    const content = observedRequest?.model === "malformed" ? "<think>unterminated" : "<think>private analysis</think>最终译文";
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => upstream.close());
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");
  const proxy = await startLocalOpenAiProxy({ upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`, port: 0 });
  context.after(() => proxy.close());
  const proxyAddress = proxy.address();
  assert.ok(proxyAddress && typeof proxyAddress === "object");
  const base = `http://127.0.0.1:${proxyAddress.port}`;
  const models = await fetch(`${base}/v1/models`).then((response) => response.json());
  assert.deepEqual(models, { data: [{ id: "local-test-model" }] });
  const completion = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "local-test-model", messages: [], stream: false }),
  }).then((response) => response.json());
  assert.deepEqual(completion, { choices: [{ message: { content: "最终译文" } }] });
  const completionHeaders = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "local-test-model", messages: [], stream: false }),
  });
  assert.equal(completionHeaders.headers.get("content-type"), "application/json; charset=utf-8");
  await completionHeaders.body?.cancel();
  assert.equal(observedRequest?.max_tokens, 2_048);
  assert.equal(observedRequest?.temperature, 0.3);
  const malformed = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "malformed", messages: [] }),
  });
  assert.equal(malformed.status, 502);
  const health = await fetch(`${base}/health`).then((response) => response.json()) as Record<string, unknown>;
  assert.equal(health.completionRequests, 3);
  assert.equal(health.completionSuccesses, 2);
  assert.equal(health.lastFailureCode, "MODEL_REASONING_UNTERMINATED");
});
