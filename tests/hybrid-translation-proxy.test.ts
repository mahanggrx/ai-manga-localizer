import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { HY_MODEL_ALIAS, SAKURA_MODEL_ALIAS, startHybridTranslationProxy } from "../src/hybrid-translation-proxy.ts";

async function readJson(request: AsyncIterable<Uint8Array>): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

test("hybrid proxy passes Paddle multimodal OCR requests through unchanged", async (context) => {
  let received: Record<string, unknown> | undefined;
  const upstream = createServer(async (request, response) => {
    received = await readJson(request);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "OCR result" } }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => upstream.close());
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");

  const proxy = await startHybridTranslationProxy({ upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/`, port: 0 });
  context.after(() => proxy.server.close());
  const proxyAddress = proxy.server.address();
  assert.ok(proxyAddress && typeof proxyAddress === "object");
  const body = {
    model: "paddleocr-vl-local",
    messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: "data:image/png;base64,c2FtcGxl" } },
      { type: "text", text: "OCR:" },
    ] }],
    temperature: 0,
    stream: false,
  };
  const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(received, body);
  assert.equal(proxy.metrics.fallbackRequests, 0);
});

test("hybrid proxy replaces only long-Latin Hy translations with Sakura output", async (context) => {
  const models: string[] = [];
  const upstream = createServer(async (request, response) => {
    const body = await readJson(request);
    models.push(String(body.model));
    const content = body.model === SAKURA_MODEL_ALIAS ? "Sakura 的另一行\n技能名称" : JSON.stringify({ "1": "正常译文", "2": "SkillName" });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => upstream.close());
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");

  const proxy = await startHybridTranslationProxy({ upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/`, port: 0 });
  context.after(() => proxy.server.close());
  const proxyAddress = proxy.server.address();
  assert.ok(proxyAddress && typeof proxyAddress === "object");
  const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: HY_MODEL_ALIAS,
      messages: [{ role: "user", content: [{ type: "text", text: `Translate:\n${JSON.stringify({ "1": "通常", "2": "スキル名" })}` }] }],
      stream: false,
    }),
  });
  assert.equal(response.status, 200);
  const completion = await response.json() as { choices: Array<{ message: { content: string } }> };
  assert.deepEqual(JSON.parse(completion.choices[0].message.content), { "1": "正常译文", "2": "技能名称" });
  assert.deepEqual(models, [HY_MODEL_ALIAS, SAKURA_MODEL_ALIAS]);
  assert.deepEqual(proxy.metrics, { primaryRequests: 1, fallbackRequests: 1, fallbackRegions: 1, fallbackFailures: 0 });
});

test("hybrid proxy does not call Sakura when Hy output has no long Latin text", async (context) => {
  let calls = 0;
  const upstream = createServer(async (request, response) => {
    await readJson(request);
    calls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ "1": "正常译文" }) } }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => upstream.close());
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");
  const proxy = await startHybridTranslationProxy({ upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/`, port: 0 });
  context.after(() => proxy.server.close());
  const proxyAddress = proxy.server.address();
  assert.ok(proxyAddress && typeof proxyAddress === "object");
  const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: HY_MODEL_ALIAS, messages: [{ role: "user", content: `Translate:\n${JSON.stringify({ "1": "通常" })}` }] }),
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.equal(proxy.metrics.fallbackRequests, 0);
});

test("hybrid proxy repairs explicit orgasm meaning lost by the primary translation", async (context) => {
  const models: string[] = [];
  const upstream = createServer(async (request, response) => {
    const body = await readJson(request);
    models.push(String(body.model));
    const content = body.model === SAKURA_MODEL_ALIAS
      ? "也许能让悠真高潮\n悠真也高潮了……\n普通译文"
      : JSON.stringify({ "1": "也许能让悠真兴奋起来", "2": "悠真也说……", "3": "普通译文" });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => upstream.close());
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");

  const proxy = await startHybridTranslationProxy({ upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/`, port: 0 });
  context.after(() => proxy.server.close());
  const proxyAddress = proxy.server.address();
  assert.ok(proxyAddress && typeof proxyAddress === "object");
  const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: HY_MODEL_ALIAS,
      messages: [{ role: "user", content: `Translate:\n${JSON.stringify({ "1": "悠真をイかせられるかも", "2": "悠真も……イって……", "3": "普通" })}` }],
      stream: false,
    }),
  });
  assert.equal(response.status, 200);
  const completion = await response.json() as { choices: Array<{ message: { content: string } }> };
  assert.deepEqual(JSON.parse(completion.choices[0].message.content), { "1": "也许能让悠真高潮", "2": "悠真也高潮了……", "3": "普通译文" });
  assert.deepEqual(models, [HY_MODEL_ALIAS, SAKURA_MODEL_ALIAS]);
  assert.deepEqual(proxy.metrics, { primaryRequests: 1, fallbackRequests: 1, fallbackRegions: 2, fallbackFailures: 0 });
});

test("hybrid proxy keeps the primary response when fallback still loses required meaning", async (context) => {
  const upstream = createServer(async (request, response) => {
    const body = await readJson(request);
    const content = body.model === SAKURA_MODEL_ALIAS ? "也许能让悠真兴奋起来" : JSON.stringify({ "1": "也许能让悠真兴奋起来" });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => upstream.close());
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");

  const proxy = await startHybridTranslationProxy({ upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/`, port: 0 });
  context.after(() => proxy.server.close());
  const proxyAddress = proxy.server.address();
  assert.ok(proxyAddress && typeof proxyAddress === "object");
  const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: HY_MODEL_ALIAS, messages: [{ role: "user", content: `Translate:\n${JSON.stringify({ "1": "悠真をイかせられるかも" })}` }] }),
  });
  const completion = await response.json() as { choices: Array<{ message: { content: string } }> };
  assert.deepEqual(JSON.parse(completion.choices[0].message.content), { "1": "也许能让悠真兴奋起来" });
  assert.deepEqual(proxy.metrics, { primaryRequests: 1, fallbackRequests: 1, fallbackRegions: 0, fallbackFailures: 1 });
});

test("hybrid proxy does not confuse ordinary death or movement wording with the adult semantic trigger", async (context) => {
  let calls = 0;
  const upstream = createServer(async (request, response) => {
    await readJson(request);
    calls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ "1": "他已经逝去了", "2": "我去去就回" }) } }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => upstream.close());
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");
  const proxy = await startHybridTranslationProxy({ upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/`, port: 0 });
  context.after(() => proxy.server.close());
  const proxyAddress = proxy.server.address();
  assert.ok(proxyAddress && typeof proxyAddress === "object");
  await fetch(`http://127.0.0.1:${proxyAddress.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: HY_MODEL_ALIAS, messages: [{ role: "user", content: `Translate:\n${JSON.stringify({ "1": "彼は逝ってしまった", "2": "イってきます" })}` }] }),
  });
  assert.equal(calls, 1);
  assert.equal(proxy.metrics.fallbackRequests, 0);
});

test("hybrid proxy replaces an incomplete primary JSON result instead of leaking missing-item placeholders downstream", async (context) => {
  const models: string[] = [];
  const upstream = createServer(async (request, response) => {
    const body = await readJson(request);
    models.push(String(body.model));
    const content = body.model === SAKURA_MODEL_ALIAS ? "第一条译文\n第二条译文" : JSON.stringify({ "1": "第一条译文" });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => upstream.close());
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");
  const proxy = await startHybridTranslationProxy({ upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/`, port: 0 });
  context.after(() => proxy.server.close());
  const proxyAddress = proxy.server.address();
  assert.ok(proxyAddress && typeof proxyAddress === "object");
  const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: HY_MODEL_ALIAS, messages: [{ role: "user", content: `Translate:\n${JSON.stringify({ "1": "一つ目", "2": "二つ目" })}` }] }),
  });
  assert.equal(response.status, 200);
  const completion = await response.json() as { choices: Array<{ message: { content: string } }> };
  assert.deepEqual(JSON.parse(completion.choices[0].message.content), { "1": "第一条译文", "2": "第二条译文" });
  assert.deepEqual(models, [HY_MODEL_ALIAS, SAKURA_MODEL_ALIAS]);
  assert.deepEqual(proxy.metrics, { primaryRequests: 1, fallbackRequests: 1, fallbackRegions: 2, fallbackFailures: 0 });
});

test("hybrid proxy can rebuild a malformed primary completion from a complete Sakura fallback", async (context) => {
  let calls = 0;
  const upstream = createServer(async (request, response) => {
    const body = await readJson(request);
    calls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body.model === SAKURA_MODEL_ALIAS
      ? JSON.stringify({ choices: [{ message: { content: "修复后的译文" } }] })
      : JSON.stringify({ choices: [] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => upstream.close());
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");
  const proxy = await startHybridTranslationProxy({ upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/`, port: 0 });
  context.after(() => proxy.server.close());
  const proxyAddress = proxy.server.address();
  assert.ok(proxyAddress && typeof proxyAddress === "object");
  const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: HY_MODEL_ALIAS, messages: [{ role: "user", content: `Translate:\n${JSON.stringify({ "1": "原文" })}` }] }),
  });
  assert.equal(response.status, 200);
  const completion = await response.json() as { choices: Array<{ message: { content: string } }> };
  assert.deepEqual(JSON.parse(completion.choices[0].message.content), { "1": "修复后的译文" });
  assert.equal(calls, 2);
});

test("hybrid proxy treats an empty primary translation as a page-level protocol failure", async (context) => {
  const upstream = createServer(async (request, response) => {
    const body = await readJson(request);
    const content = body.model === SAKURA_MODEL_ALIAS ? "完整译文" : JSON.stringify({ "1": "   " });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => upstream.close());
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");
  const proxy = await startHybridTranslationProxy({ upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/`, port: 0 });
  context.after(() => proxy.server.close());
  const proxyAddress = proxy.server.address();
  assert.ok(proxyAddress && typeof proxyAddress === "object");
  const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: HY_MODEL_ALIAS, messages: [{ role: "user", content: `Translate:\n${JSON.stringify({ "1": "原文" })}` }] }),
  });
  const completion = await response.json() as { choices: Array<{ message: { content: string } }> };
  assert.deepEqual(JSON.parse(completion.choices[0].message.content), { "1": "完整译文" });
});

test("hybrid proxy fails the request instead of returning a sparse primary result when protocol recovery fails", async (context) => {
  const upstream = createServer(async (request, response) => {
    const body = await readJson(request);
    const content = body.model === SAKURA_MODEL_ALIAS ? "only one line" : JSON.stringify({ "1": "第一条译文" });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => upstream.close());
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");
  const proxy = await startHybridTranslationProxy({ upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/`, port: 0 });
  context.after(() => proxy.server.close());
  const proxyAddress = proxy.server.address();
  assert.ok(proxyAddress && typeof proxyAddress === "object");
  const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: HY_MODEL_ALIAS, messages: [{ role: "user", content: `Translate:\n${JSON.stringify({ "1": "一つ目", "2": "二つ目" })}` }] }),
  });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: { code: "MVP_TRANSLATION_PROTOCOL_RECOVERY_FAILED" } });
});

test("hybrid proxy falls back for invented multi-digit claims and retained Japanese", async (context) => {
  const upstream = createServer(async (request, response) => {
    const body = await readJson(request);
    const content = body.model === SAKURA_MODEL_ALIAS
      ? "看起来真好吃\n已经处理好了"
      : JSON.stringify({ "1": "1997年看起来真好吃", "2": "已经処理した" });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => upstream.close());
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");
  const proxy = await startHybridTranslationProxy({ upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/`, port: 0 });
  context.after(() => proxy.server.close());
  const proxyAddress = proxy.server.address();
  assert.ok(proxyAddress && typeof proxyAddress === "object");
  const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: HY_MODEL_ALIAS, messages: [{ role: "user", content: `Translate:\n${JSON.stringify({ "1": "おいしそう", "2": "もう済んだ" })}` }] }),
  });
  const completion = await response.json() as { choices: Array<{ message: { content: string } }> };
  assert.deepEqual(JSON.parse(completion.choices[0].message.content), { "1": "看起来真好吃", "2": "已经处理好了" });
  assert.deepEqual(proxy.metrics, { primaryRequests: 1, fallbackRequests: 1, fallbackRegions: 2, fallbackFailures: 0 });
});

test("hybrid proxy preserves a real Japanese-numeral date after contextual review", async (context) => {
  let calls = 0;
  const upstream = createServer(async (request, response) => {
    await readJson(request);
    calls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ "1": "10月19日" }) } }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => upstream.close());
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");
  const proxy = await startHybridTranslationProxy({ upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/`, port: 0 });
  context.after(() => proxy.server.close());
  const proxyAddress = proxy.server.address();
  assert.ok(proxyAddress && typeof proxyAddress === "object");
  await fetch(`http://127.0.0.1:${proxyAddress.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: HY_MODEL_ALIAS, messages: [{ role: "user", content: `Translate:\n${JSON.stringify({ "1": "十月十九日" })}` }] }),
  });
  assert.equal(calls, 2);
  assert.deepEqual(proxy.metrics, { primaryRequests: 1, fallbackRequests: 1, fallbackRegions: 1, fallbackFailures: 0 });
});

test("hybrid proxy asks the contextual fallback to review calendar-shaped OCR without forcing real dates to disappear", async (context) => {
  const upstream = createServer(async (request, response) => {
    const body = await readJson(request);
    const content = body.model === SAKURA_MODEL_ALIAS
      ? "10月19日见面\n看起来真好吃"
      : JSON.stringify({ "1": "10月19日见面", "2": "1997年看起来真好吃" });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => upstream.close());
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");
  const proxy = await startHybridTranslationProxy({ upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/`, port: 0 });
  context.after(() => proxy.server.close());
  const proxyAddress = proxy.server.address();
  assert.ok(proxyAddress && typeof proxyAddress === "object");
  const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: HY_MODEL_ALIAS, messages: [{ role: "user", content: `Translate:\n${JSON.stringify({ "1": "10月19日に会う", "2": "1997年おいしそう" })}` }] }),
  });
  const completion = await response.json() as { choices: Array<{ message: { content: string } }> };
  assert.deepEqual(JSON.parse(completion.choices[0].message.content), { "1": "10月19日见面", "2": "看起来真好吃" });
  assert.deepEqual(proxy.metrics, { primaryRequests: 1, fallbackRequests: 1, fallbackRegions: 2, fallbackFailures: 0 });
});

test("hybrid proxy reviews calendar-shaped OCR written with Japanese numerals", async (context) => {
  const upstream = createServer(async (request, response) => {
    const body = await readJson(request);
    const content = body.model === SAKURA_MODEL_ALIAS
      ? "看起来真好吃\n看着很有气势"
      : JSON.stringify({ "1": "一九九七年看起来真好吃", "2": "十月十九日看着很有气势" });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => upstream.close());
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");
  const proxy = await startHybridTranslationProxy({ upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/`, port: 0 });
  context.after(() => proxy.server.close());
  const address = proxy.server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: HY_MODEL_ALIAS, messages: [{ role: "user", content: `Translate:\n${JSON.stringify({ "1": "一九九七年おいしそう", "2": "十月十九日かっこいいね" })}` }] }),
  });
  const completion = await response.json() as { choices: Array<{ message: { content: string } }> };
  assert.deepEqual(JSON.parse(completion.choices[0].message.content), { "1": "看起来真好吃", "2": "看着很有气势" });
  assert.deepEqual(proxy.metrics, { primaryRequests: 1, fallbackRequests: 1, fallbackRegions: 2, fallbackFailures: 0 });
});

test("hybrid proxy preserves evidenced body-part and oral-action meaning through fallback validation", async (context) => {
  const upstream = createServer(async (request, response) => {
    const body = await readJson(request);
    const content = body.model === SAKURA_MODEL_ALIAS
      ? "睾丸被碰到了\n用嘴含住"
      : JSON.stringify({ "1": "阴茎头部被碰到了", "2": "现场做给我看" });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => upstream.close());
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");
  const proxy = await startHybridTranslationProxy({ upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/`, port: 0 });
  context.after(() => proxy.server.close());
  const proxyAddress = proxy.server.address();
  assert.ok(proxyAddress && typeof proxyAddress === "object");
  const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: HY_MODEL_ALIAS, messages: [{ role: "user", content: `Translate:\n${JSON.stringify({ "1": "玉を触った", "2": "咥えて" })}` }] }),
  });
  const completion = await response.json() as { choices: Array<{ message: { content: string } }> };
  assert.deepEqual(JSON.parse(completion.choices[0].message.content), { "1": "睾丸被碰到了", "2": "用嘴含住" });
  assert.deepEqual(proxy.metrics, { primaryRequests: 1, fallbackRequests: 1, fallbackRegions: 2, fallbackFailures: 0 });
});

test("hybrid proxy repairs release onomatopoeia that the primary route mistakes for wind or a generic action", async (context) => {
  const upstream = createServer(async (request, response) => {
    const body = await readJson(request);
    const content = body.model === SAKURA_MODEL_ALIAS
      ? "刚才喷得到处都是\n一下子射出来了"
      : JSON.stringify({ "1": "刚才风呼呼地吹", "2": "刚才的动作很帅" });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  context.after(() => upstream.close());
  const upstreamAddress = upstream.address();
  assert.ok(upstreamAddress && typeof upstreamAddress === "object");
  const proxy = await startHybridTranslationProxy({ upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}/`, port: 0 });
  context.after(() => proxy.server.close());
  const proxyAddress = proxy.server.address();
  assert.ok(proxyAddress && typeof proxyAddress === "object");
  const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: HY_MODEL_ALIAS, messages: [{ role: "user", content: `Translate:\n${JSON.stringify({ "1": "ビュービュー出てたね", "2": "ビャッってでたね" })}` }] }),
  });
  const completion = await response.json() as { choices: Array<{ message: { content: string } }> };
  assert.deepEqual(JSON.parse(completion.choices[0].message.content), { "1": "刚才喷得到处都是", "2": "一下子射出来了" });
  assert.deepEqual(proxy.metrics, { primaryRequests: 1, fallbackRequests: 1, fallbackRegions: 2, fallbackFailures: 0 });
});
