import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { LocalizerError } from "../src/errors.ts";
import { classifyProbeFailure } from "../golden-private/m4.2-controlled-challenge-20260815T133415Z/m4.2c-protocol-v2-probe.mjs";
import { fetchJson, parseM42ChatCompletion } from "../golden-private/m4.2-controlled-challenge-20260815T133415Z/m4.2-runner.mjs";

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

test("M4.2c.1 preserves a real sanitizer error code and the last safe callback event", () => {
  const lastEvent = {
    httpStatus: 200,
    choiceCount: 1,
    finishReason: "stop",
    completionTokens: 312,
    contentIsString: true,
    reasoningFieldsPresent: false,
    failureStage: "reasoning",
    failureCode: "MODEL_REASONING_UNTERMINATED",
    reasoningObserved: true,
    reasoningDiscarded: false,
  };
  const preserved = classifyProbeFailure(new LocalizerError("MODEL_REASONING_UNTERMINATED", "omitted"), lastEvent);
  assert.deepEqual(preserved, lastEvent);
});

test("M4.2c.1 falls back to generic shape failure for unknown exceptions without retaining error text", () => {
  const fallback = {
    httpStatus: 200,
    choiceCount: 1,
    finishReason: "stop",
    completionTokens: 312,
    contentIsString: true,
    reasoningFieldsPresent: false,
    failureStage: "pre_sanitize",
    failureCode: null,
    reasoningObserved: true,
    reasoningDiscarded: false,
  };
  const classified = classifyProbeFailure(new Error("omitted"), undefined, fallback);
  assert.equal(classified.failureStage, "response_shape");
  assert.equal(classified.failureCode, "MODEL_RESPONSE_INVALID");
  assert.equal("message" in classified, false);
  assert.equal(classified.httpStatus, 200);
  assert.equal(classified.reasoningObserved, true);
});

test("M4.2 parser uses the shared strict message.content contract and returns only diagnostics", () => {
  const direct = parseM42ChatCompletion({
    choices: [{ finish_reason: "stop", message: { content: "直接译文" } }],
  }, { httpStatus: 200 });
  assert.equal(direct.translatedText, "直接译文");
  assert.deepEqual(direct.diagnostics, {
    httpStatus: 200,
    choiceCount: 1,
    finishReason: "stop",
    completionTokens: null,
    contentIsString: true,
    reasoningFieldsPresent: false,
    failureStage: "accepted",
    failureCode: null,
    reasoningObserved: false,
    reasoningDiscarded: false,
  });

  const withReasoning = parseM42ChatCompletion({
    reasoning_content: "discard-top-level",
    choices: [{
      reasoning: "discard-choice",
      finish_reason: "stop",
      message: { content: "  <think>x</think>最终译文", reasoning_content: "discard-message" },
    }],
    usage: { completion_tokens: 9 },
  });
  assert.equal(withReasoning.translatedText, "最终译文");
  assert.deepEqual(withReasoning.diagnostics, {
    httpStatus: null,
    choiceCount: 1,
    finishReason: "stop",
    completionTokens: 9,
    contentIsString: true,
    reasoningFieldsPresent: true,
    failureStage: "accepted",
    failureCode: null,
    reasoningObserved: true,
    reasoningDiscarded: true,
  });

  const independent = parseM42ChatCompletion({
    choices: [{ finish_reason: "stop", message: { content: "独立字段译文", reasoning_content: "discard-message" } }],
  });
  assert.equal(independent.translatedText, "独立字段译文");
  assert.equal(independent.diagnostics.reasoningFieldsPresent, true);
  assert.equal(independent.diagnostics.reasoningObserved, true);
  assert.equal(independent.diagnostics.reasoningDiscarded, true);

  const rejected = [
    { choices: [], error: "MODEL_COMPLETION_PROTOCOL_INVALID" },
    { choices: [{ message: { content: 12 } }], error: "MODEL_COMPLETION_PROTOCOL_INVALID" },
    { choices: [{ message: { content: "<think>x</think>" } }], error: "MODEL_EMPTY_OUTPUT" },
    { choices: [{ message: { content: "<think attr>x</think>译文" } }], error: "MODEL_REASONING_TAG_VARIANT" },
    { choices: [{ message: { content: "<Think>x</think>译文" } }], error: "MODEL_REASONING_TAG_VARIANT" },
    { choices: [{ message: { content: "<think>x</Think>译文" } }], error: "MODEL_REASONING_TAG_VARIANT" },
    { choices: [{ message: { content: "<think>x</think><think>y</think>译文" } }], error: "MODEL_REASONING_DUPLICATE" },
    { choices: [{ message: { content: "<think>x</think>译文<think>y</think>" } }], error: "MODEL_REASONING_TRAILING_MARKER" },
  ];
  for (const value of rejected) {
    assert.throws(() => parseM42ChatCompletion(value), (error: unknown) => codeOf(error) === value.error);
  }
});

test("mocked llama-server b8935 response contract enforces JSON and byte limits", async (context) => {
  const server = createServer((request, response) => {
    if (request.url === "/invalid-json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("not-json");
      return;
    }
    if (request.url === "/oversized") {
      const size = 8 * 1024 * 1024 + 1;
      response.writeHead(200, { "content-type": "application/json", "content-length": size });
      response.end(Buffer.alloc(size, 0x20));
      return;
    }
    if (request.url === "/length") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ finish_reason: "length", message: { content: "截断译文" } }],
        usage: { completion_tokens: 2_048 },
      }));
      return;
    }
    if (request.url === "/unclosed") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "<think>未闭合" } }],
        usage: { completion_tokens: 4 },
      }));
      return;
    }
    if (request.url === "/malformed") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "<Think>标签变体</think>译文" } }],
        usage: { completion_tokens: 4 },
      }));
      return;
    }
    if (request.url === "/missing") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "缺失元数据译文" } }] }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "<think>x</think>最终译文" } }],
      usage: { completion_tokens: 11 },
    }));
  });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", () => resolve()));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  const readCompletion = async (path: string) => {
    let httpStatus: number | null = null;
    const completion = await fetchJson(`${base}${path}`, { headers: { accept: "application/json" } }, "MOCK_FETCH_FAILED", {
      onResponseStatus: (status: number) => { httpStatus = status; },
    });
    const diagnostics: Record<string, unknown>[] = [];
    try {
      return {
        httpStatus,
        parsed: parseM42ChatCompletion(completion, { httpStatus, onDiagnostic: (entry) => diagnostics.push(entry) }),
        diagnostics,
        error: undefined,
      };
    } catch (error) {
      return { httpStatus, parsed: undefined, diagnostics, error };
    }
  };

  const success = await readCompletion("/v1/chat/completions");
  assert.equal(success.httpStatus, 200);
  assert.ok(success.parsed);
  assert.deepEqual(success.parsed, {
    translatedText: "最终译文",
    diagnostics: {
      httpStatus: 200,
      choiceCount: 1,
      finishReason: "stop",
      completionTokens: 11,
      contentIsString: true,
      reasoningFieldsPresent: false,
      failureStage: "accepted",
      failureCode: null,
      reasoningObserved: true,
      reasoningDiscarded: true,
    },
  });
  assert.equal(success.diagnostics.length, 2);
  assert.equal(success.diagnostics[0].failureStage, "pre_sanitize");

  const length = await readCompletion("/length");
  assert.ok(length.parsed);
  assert.equal(length.parsed.diagnostics.finishReason, "length");
  assert.equal(length.parsed.diagnostics.completionTokens, 2_048);
  assert.equal(length.parsed.diagnostics.failureStage, "accepted");

  const unclosed = await readCompletion("/unclosed");
  assert.equal(codeOf(unclosed.error), "MODEL_REASONING_UNTERMINATED");
  assert.equal(unclosed.httpStatus, 200);
  assert.equal(unclosed.diagnostics[1].failureCode, "MODEL_REASONING_UNTERMINATED");
  assert.equal(unclosed.diagnostics[1].failureStage, "reasoning");

  const malformed = await readCompletion("/malformed");
  assert.equal(codeOf(malformed.error), "MODEL_REASONING_TAG_VARIANT");
  assert.equal(malformed.diagnostics[1].failureCode, "MODEL_REASONING_TAG_VARIANT");

  const missing = await readCompletion("/missing");
  assert.ok(missing.parsed);
  assert.equal(missing.parsed.diagnostics.finishReason, null);
  assert.equal(missing.parsed.diagnostics.completionTokens, null);
  assert.equal(missing.parsed.diagnostics.reasoningFieldsPresent, false);

  let invalidJsonStatus: number | null = null;
  await assert.rejects(() => fetchJson(`${base}/invalid-json`, {}, "MOCK_FETCH_FAILED", {
    onResponseStatus: (status: number) => { invalidJsonStatus = status; },
  }), (error: unknown) => codeOf(error) === "MODEL_RESPONSE_INVALID_JSON");
  assert.equal(invalidJsonStatus, 200);
  await assert.rejects(() => fetchJson(`${base}/oversized`, {}, "MOCK_FETCH_FAILED"), (error: unknown) => codeOf(error) === "MODEL_RESPONSE_TOO_LARGE");
});
