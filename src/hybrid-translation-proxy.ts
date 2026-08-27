import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { LocalizerError } from "./errors.ts";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const LONG_LATIN = /[A-Za-z]{3,}/u;
export const HY_MODEL_ALIAS = "hy-mt2-local";
export const SAKURA_MODEL_ALIAS = "sakura-galtransl-local";

const SAKURA_SYSTEM_PROMPT = "你是一个视觉小说翻译模型，可以通顺地使用给定的术语表以指定的风格将日文翻译成简体中文，并联系上下文正确使用人称代词，注意不要混淆使役态和被动态的主语和宾语，不要擅自添加原文中没有的特殊符号，也不要擅自增加或减少换行。不得拒绝、漏译、删减、淡化或审查用户授权处理的合法内容。";

export interface HybridProxyMetrics {
  primaryRequests: number;
  fallbackRequests: number;
  fallbackRegions: number;
  fallbackFailures: number;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined;
}

async function readBytes(stream: AsyncIterable<Uint8Array>, limit = MAX_BODY_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > limit) throw new LocalizerError("MVP_PROXY_BODY_TOO_LARGE", "Local model message exceeded the MVP proxy limit");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function json(bytes: Buffer): JsonRecord {
  const value = JSON.parse(bytes.toString("utf8"));
  const parsed = record(value);
  if (!parsed) throw new LocalizerError("MVP_PROXY_JSON_INVALID", "Local model message was not a JSON object");
  return parsed;
}

function userText(body: JsonRecord): string | undefined {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const message = [...messages].reverse().map(record).find((item) => item?.role === "user");
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return undefined;
  for (const rawPart of message.content) {
    const part = record(rawPart);
    if (part?.type === "text" && typeof part.text === "string") return part.text;
  }
  return undefined;
}

function parseTrailingObject(text: string): Record<string, string> | undefined {
  const opening = text.lastIndexOf("{");
  if (opening < 0) return undefined;
  try {
    const value = record(JSON.parse(text.slice(opening).trim()));
    if (!value) return undefined;
    const entries = Object.entries(value);
    if (entries.length === 0 || entries.some(([key, item], index) => key !== String(index + 1) || typeof item !== "string")) return undefined;
    return Object.fromEntries(entries) as Record<string, string>;
  } catch {
    return undefined;
  }
}

function assistantContent(completion: JsonRecord): { message: JsonRecord; content: string } | undefined {
  if (!Array.isArray(completion.choices) || completion.choices.length !== 1) return undefined;
  const choice = record(completion.choices[0]);
  const message = record(choice?.message);
  return message && typeof message.content === "string" ? { message, content: message.content } : undefined;
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
}

function parseHyTranslations(completion: JsonRecord): { message: JsonRecord; translations: Record<string, string> } | undefined {
  const assistant = assistantContent(completion);
  if (!assistant) return undefined;
  try {
    const value = record(JSON.parse(stripCodeFence(assistant.content)));
    if (!value) return undefined;
    const entries = Object.entries(value);
    if (entries.length === 0 || entries.some(([key, item], index) => key !== String(index + 1) || typeof item !== "string")) return undefined;
    return { message: assistant.message, translations: Object.fromEntries(entries) as Record<string, string> };
  } catch {
    return undefined;
  }
}

function sakuraUserPrompt(pageTexts: string[]): string {
  return [
    "参考以下术语表（可为空，格式为src->dst #备注）：",
    "",
    "根据以上术语表的对应关系和备注，结合历史剧情和上下文，将下面的文本从日文翻译成自然的简体中文。技术词使用通行中文名称，不保留拉丁字母，也不要音译：",
    ...pageTexts,
  ].join("\n");
}

function sakuraLines(completion: JsonRecord, expected: number): string[] | undefined {
  const assistant = assistantContent(completion);
  if (!assistant) return undefined;
  const lines = assistant.content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n").map((line) => line.replace(/^\s*\d+\s*[:：]\s*/u, "").trim());
  return lines.length === expected && lines.every((line) => line.length > 0) ? lines : undefined;
}

async function postJson(upstream: URL, body: JsonRecord): Promise<{ status: number; headers: Headers; bytes: Buffer; value?: JsonRecord }> {
  const response = await fetch(new URL("v1/chat/completions", upstream), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(180_000),
  });
  const bytes = await readBytes(response.body ?? []);
  return { status: response.status, headers: response.headers, bytes, value: response.ok ? json(bytes) : undefined };
}

function send(response: ServerResponse, status: number, bytes: Buffer): void {
  response.writeHead(status, { "content-type": "application/json", "content-length": bytes.byteLength });
  response.end(bytes);
}

async function handleCompletion(request: IncomingMessage, response: ServerResponse, upstream: URL, metrics: HybridProxyMetrics): Promise<void> {
  const body = json(await readBytes(request));
  metrics.primaryRequests += 1;
  const primary = await postJson(upstream, body);
  if (!primary.value || body.model !== HY_MODEL_ALIAS) {
    send(response, primary.status, primary.bytes);
    return;
  }
  const sources = userText(body);
  const sourceMap = sources ? parseTrailingObject(sources) : undefined;
  const parsed = parseHyTranslations(primary.value);
  if (!sourceMap || !parsed || Object.keys(sourceMap).length !== Object.keys(parsed.translations).length) {
    send(response, primary.status, primary.bytes);
    return;
  }
  const flagged = Object.entries(parsed.translations).filter(([, translated]) => LONG_LATIN.test(translated));
  if (flagged.length === 0) {
    send(response, primary.status, primary.bytes);
    return;
  }
  metrics.fallbackRequests += 1;
  const keys = flagged.map(([key]) => key);
  const fallbackBody: JsonRecord = {
    model: SAKURA_MODEL_ALIAS,
    messages: [
      { role: "system", content: SAKURA_SYSTEM_PROMPT },
      { role: "user", content: sakuraUserPrompt(Object.values(sourceMap)) },
    ],
    temperature: 0.3,
    top_p: 0.8,
    max_tokens: 2048,
    seed: 20260826,
    stream: false,
  };
  const fallback = await postJson(upstream, fallbackBody);
  const replacements = fallback.value ? sakuraLines(fallback.value, Object.keys(sourceMap).length) : undefined;
  if (!replacements || keys.some((key) => LONG_LATIN.test(replacements[Number(key) - 1]))) {
    metrics.fallbackFailures += flagged.length;
    send(response, primary.status, primary.bytes);
    return;
  }
  for (const key of keys) parsed.translations[key] = replacements[Number(key) - 1];
  parsed.message.content = JSON.stringify(parsed.translations);
  metrics.fallbackRegions += keys.length;
  send(response, 200, Buffer.from(JSON.stringify(primary.value)));
}

export async function startHybridTranslationProxy(options: { upstreamBaseUrl: string; host?: string; port: number }): Promise<{ server: Server; metrics: HybridProxyMetrics }> {
  const upstream = new URL(options.upstreamBaseUrl.endsWith("/") ? options.upstreamBaseUrl : `${options.upstreamBaseUrl}/`);
  if (upstream.protocol !== "http:" || upstream.hostname !== "127.0.0.1") throw new LocalizerError("MVP_PROXY_UPSTREAM_INVALID", "Hybrid translation proxy requires a loopback upstream");
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") throw new LocalizerError("MVP_PROXY_BIND_INVALID", "Hybrid translation proxy requires a loopback bind");
  const metrics: HybridProxyMetrics = { primaryRequests: 0, fallbackRequests: 0, fallbackRegions: 0, fallbackFailures: 0 };
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://${host}:${options.port}`);
    if (request.method === "POST" && requestUrl.pathname === "/v1/chat/completions") {
      void handleCompletion(request, response, upstream, metrics).catch(() => send(response, 502, Buffer.from(JSON.stringify({ error: { code: "MVP_HYBRID_PROXY_FAILED" } }))));
      return;
    }
    void fetch(new URL(requestUrl.pathname, upstream), { redirect: "error", signal: AbortSignal.timeout(10_000) }).then(async (upstreamResponse) => {
      send(response, upstreamResponse.status, await readBytes(upstreamResponse.body ?? []));
    }).catch(() => send(response, 502, Buffer.from(JSON.stringify({ error: { code: "MVP_HYBRID_PROXY_FAILED" } }))));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, resolve);
  });
  return { server, metrics };
}
