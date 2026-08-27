import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { HY_MODEL_ALIAS, SAKURA_MODEL_ALIAS, startHybridTranslationProxy } from "../src/hybrid-translation-proxy.ts";

async function readJson(request: AsyncIterable<Uint8Array>): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

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
