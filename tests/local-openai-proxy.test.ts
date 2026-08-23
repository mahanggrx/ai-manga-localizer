import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { normalizeNumberedListDelimiters, sanitizeChatCompletion, sanitizeChatCompletionWithDiagnostics, startLocalOpenAiProxy, stripModelReasoning } from "../src/local-openai-proxy.ts";

test("reasoning sanitizer accepts only direct text or one exact leading think block", () => {
  assert.equal(stripModelReasoning("<think>x</think>最终译文"), "最终译文");
  assert.equal(stripModelReasoning("  直接译文  "), "直接译文");
  assert.equal(stripModelReasoning("<think></think>最终译文"), "最终译文");

  const rejected = [
    ["<think>unterminated", "MODEL_REASONING_UNTERMINATED"],
    ["<think>x</think><think>y</think>译文", "MODEL_REASONING_DUPLICATE"],
    ["<think>x<think>y</think>译文", "MODEL_REASONING_NESTED"],
    ["<think attr>x</think>译文", "MODEL_REASONING_TAG_VARIANT"],
    ["<Think>x</think>译文", "MODEL_REASONING_TAG_VARIANT"],
    ["<think>x</Think>译文", "MODEL_REASONING_TAG_VARIANT"],
    ["<think>x</think attr>译文", "MODEL_REASONING_TAG_VARIANT"],
    ["<think>x</think>译文<think>y</think>", "MODEL_REASONING_TRAILING_MARKER"],
    ["译文<think>x</think>", "MODEL_REASONING_NON_PREFIX"],
    ["译文<|analysis|>", "MODEL_REASONING_TAG_VARIANT"],
    ["<think>x</think>", "MODEL_RESPONSE_EMPTY"],
    ["   ", "MODEL_RESPONSE_EMPTY"],
  ] as const;
  for (const [value, code] of rejected) {
    assert.throws(() => stripModelReasoning(value), (error: unknown) => (error as { code?: string }).code === code);
  }

  const diagnosticEvents: Record<string, unknown>[] = [];
  const sanitized = sanitizeChatCompletionWithDiagnostics({
    reasoning_content: "discard-top-level",
    reasoning: "discard-top-level",
    choices: [{
      reasoning_content: "discard-choice",
      reasoning: "discard-choice",
      finish_reason: "stop",
      message: { content: "<think>x</think>最终译文", reasoning_content: "discard-message", reasoning: "discard-message" },
    }],
    usage: { completion_tokens: 7 },
  }, { httpStatus: 200, onDiagnostic: (diagnostics) => diagnosticEvents.push(diagnostics) });
  assert.deepEqual(sanitized.response, {
    choices: [{ finish_reason: "stop", message: { content: "最终译文" } }],
    usage: { completion_tokens: 7 },
  });
  assert.deepEqual(sanitized.diagnostics, {
    httpStatus: 200,
    choiceCount: 1,
    finishReason: "stop",
    completionTokens: 7,
    contentIsString: true,
    reasoningFieldsPresent: true,
    failureStage: "accepted",
    failureCode: null,
    reasoningObserved: true,
    reasoningDiscarded: true,
  });
  assert.equal(diagnosticEvents.length, 2);
  assert.equal(diagnosticEvents[0].failureStage, "pre_sanitize");
  assert.equal(diagnosticEvents[1].failureStage, "accepted");
  assert.deepEqual(Object.keys(diagnosticEvents[1]).sort(), [
    "choiceCount",
    "completionTokens",
    "contentIsString",
    "failureCode",
    "failureStage",
    "finishReason",
    "httpStatus",
    "reasoningDiscarded",
    "reasoningFieldsPresent",
    "reasoningObserved",
  ]);
  assert.deepEqual(sanitizeChatCompletion({ choices: [{ message: { content: "直接译文" } }] }), { choices: [{ message: { content: "直接译文" } }] });

  const independentReasoning = sanitizeChatCompletionWithDiagnostics({
    choices: [{ finish_reason: "stop", message: { content: "独立字段译文", reasoning_content: "discard-message" } }],
  });
  assert.deepEqual(independentReasoning.response, {
    choices: [{ finish_reason: "stop", message: { content: "独立字段译文" } }],
  });
  assert.equal(independentReasoning.diagnostics.reasoningFieldsPresent, true);
  assert.equal(independentReasoning.diagnostics.reasoningObserved, true);
  assert.equal(independentReasoning.diagnostics.reasoningDiscarded, true);
});

test("completion diagnostics classify failures without retaining model text", () => {
  const collect = (value: unknown, httpStatus = 200): { events: Record<string, unknown>[]; error: unknown } => {
    const events: Record<string, unknown>[] = [];
    let error: unknown;
    try {
      sanitizeChatCompletionWithDiagnostics(value, { httpStatus, onDiagnostic: (diagnostics) => events.push(diagnostics) });
    } catch (caught) {
      error = caught;
    }
    assert.equal(events.length, 2);
    return { events, error };
  };

  const length = collect({ choices: [{ finish_reason: "length", message: { content: "截断译文" } }], usage: { completion_tokens: 2_048 } });
  assert.equal((length.events[1] as { finishReason?: unknown }).finishReason, "length");
  assert.equal((length.events[1] as { completionTokens?: unknown }).completionTokens, 2_048);
  assert.equal((length.events[1] as { failureStage?: unknown }).failureStage, "accepted");
  assert.equal((length.events[1] as { failureCode?: unknown }).failureCode, null);
  assert.equal((length.error as { code?: unknown } | undefined)?.code, undefined);

  const missing = collect({ choices: [{ message: { content: "缺失元数据译文" } }] });
  assert.equal((missing.events[1] as { finishReason?: unknown }).finishReason, null);
  assert.equal((missing.events[1] as { completionTokens?: unknown }).completionTokens, null);
  assert.equal((missing.events[1] as { reasoningFieldsPresent?: unknown }).reasoningFieldsPresent, false);

  const invalidShape = collect({ choices: [{ finish_reason: "stop", message: { content: { text: "非字符串" } } }] });
  assert.equal((invalidShape.events[1] as { contentIsString?: unknown }).contentIsString, false);
  assert.equal((invalidShape.events[1] as { failureStage?: unknown }).failureStage, "response_shape");
  assert.equal((invalidShape.events[1] as { failureCode?: unknown }).failureCode, "MODEL_RESPONSE_INVALID");

  const malformed = [
    ["<think>未闭合", "MODEL_REASONING_UNTERMINATED"],
    ["译文<think>非前置</think>", "MODEL_REASONING_NON_PREFIX"],
    ["<think>嵌套<think>区块</think>译文", "MODEL_REASONING_NESTED"],
    ["<think>一</think><think>二</think>译文", "MODEL_REASONING_DUPLICATE"],
    ["<Think>标签变体</think>译文", "MODEL_REASONING_TAG_VARIANT"],
    ["<think>区块</think>译文</think>", "MODEL_REASONING_TRAILING_MARKER"],
    ["<think>只有区块</think>", "MODEL_RESPONSE_EMPTY"],
  ] as const;
  for (const [content, expectedCode] of malformed) {
    const result = collect({ choices: [{ finish_reason: "stop", message: { content } }], usage: { completion_tokens: 4 } });
    assert.equal((result.events[1] as { failureCode?: unknown }).failureCode, expectedCode);
    assert.equal((result.events[1] as { reasoningDiscarded?: unknown }).reasoningDiscarded, false);
  }
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
    if (observedRequest?.model === "invalid-json") {
      response.end("not-json");
      return;
    }
    if (observedRequest?.model === "oversized") {
      response.end(Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
      return;
    }
    if (observedRequest?.model === "multiple") {
      response.end(JSON.stringify({ choices: [{ message: { content: "译文" } }, { message: { content: "第二个" } }] }));
      return;
    }
    if (observedRequest?.model === "non-string") {
      response.end(JSON.stringify({ choices: [{ message: { content: { text: "译文" } } }] }));
      return;
    }
    const content = observedRequest?.model === "malformed" ? "<think>unterminated" : "<think>x</think>最终译文";
    response.end(JSON.stringify({
      reasoning_content: "discard-top-level",
      reasoning: "discard-top-level",
      choices: [{
        reasoning_content: "discard-choice",
        reasoning: "discard-choice",
        finish_reason: "stop",
        message: { content, reasoning_content: "discard-message", reasoning: "discard-message" },
      }],
      usage: { completion_tokens: 7 },
    }));
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
  assert.deepEqual(completion, {
    choices: [{ finish_reason: "stop", message: { content: "最终译文" } }],
    usage: { completion_tokens: 7 },
  });
  const completionHeaders = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "local-test-model", messages: [], stream: false }),
  });
  assert.equal(completionHeaders.headers.get("content-type"), "application/json; charset=utf-8");
  await completionHeaders.body?.cancel();
  assert.equal(observedRequest?.max_tokens, 2_048);
  assert.equal(observedRequest?.temperature, 0.3);
  const healthAfterCompletion = await fetch(`${base}/health`).then((response) => response.json()) as Record<string, unknown>;
  assert.deepEqual(healthAfterCompletion.lastCompletion, {
    httpStatus: 200,
    choiceCount: 1,
    finishReason: "stop",
    completionTokens: 7,
    contentIsString: true,
    reasoningFieldsPresent: true,
    failureStage: "accepted",
    failureCode: null,
    reasoningObserved: true,
    reasoningDiscarded: true,
  });
  const malformed = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "malformed", messages: [], stream: false }),
  });
  assert.equal(malformed.status, 502);
  assert.equal((await malformed.json() as { error: { code: string } }).error.code, "MODEL_REASONING_UNTERMINATED");
  const healthAfterMalformed = await fetch(`${base}/health`).then((response) => response.json()) as Record<string, unknown>;
  assert.equal(healthAfterMalformed.lastFailureCode, "MODEL_REASONING_UNTERMINATED");
  assert.deepEqual(healthAfterMalformed.lastCompletion, {
    httpStatus: 200,
    choiceCount: 1,
    finishReason: "stop",
    completionTokens: 7,
    contentIsString: true,
    reasoningFieldsPresent: true,
    failureStage: "reasoning",
    failureCode: "MODEL_REASONING_UNTERMINATED",
    reasoningObserved: true,
    reasoningDiscarded: false,
  });
  const invalidJson = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "invalid-json", messages: [], stream: false }),
  });
  assert.equal(invalidJson.status, 502);
  assert.equal((await invalidJson.json() as { error: { code: string } }).error.code, "MODEL_RESPONSE_INVALID");
  const oversized = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "oversized", messages: [], stream: false }),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json() as { error: { code: string } }).error.code, "LOCAL_PROXY_BODY_TOO_LARGE");
  const multiple = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "multiple", messages: [], stream: false }),
  });
  assert.equal(multiple.status, 502);
  assert.equal((await multiple.json() as { error: { code: string } }).error.code, "MODEL_RESPONSE_INVALID");
  const nonString = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "non-string", messages: [], stream: false }),
  });
  assert.equal(nonString.status, 502);
  assert.equal((await nonString.json() as { error: { code: string } }).error.code, "MODEL_RESPONSE_INVALID");
  const invalidRequest = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not-json",
  });
  assert.equal(invalidRequest.status, 502);
  assert.equal((await invalidRequest.json() as { error: { code: string } }).error.code, "MODEL_REQUEST_INVALID");
  for (const body of [
    JSON.stringify({ model: "local-test-model", messages: [] }),
    JSON.stringify({ model: "local-test-model", messages: [], stream: true }),
  ]) {
    const invalidStream = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(invalidStream.status, 502);
    assert.equal((await invalidStream.json() as { error: { code: string } }).error.code, "MODEL_STREAM_UNSUPPORTED");
  }
  const health = await fetch(`${base}/health`).then((response) => response.json()) as Record<string, unknown>;
  assert.equal(health.completionRequests, 10);
  assert.equal(health.completionSuccesses, 2);
  assert.equal(health.lastFailureCode, "MODEL_STREAM_UNSUPPORTED");
});
