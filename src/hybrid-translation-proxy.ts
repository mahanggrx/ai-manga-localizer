import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { LocalizerError } from "./errors.ts";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const LONG_LATIN = /[A-Za-z]{3,}/u;
const JAPANESE_SCRIPT = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const MODEL_PLACEHOLDER = /(?:\[?OpenAI-Compatible-Translate:)?\s*Missing item\b|翻译缺失|译文缺失/iu;
const SOURCE_NUMBER = /[0-9０-９一二三四五六七八九十百千万〇零]/u;
const TARGET_MULTI_DIGIT = /[0-9０-９]{2,}/u;
const SUSPICIOUS_OCR_CALENDAR = /(?:[12][0-9]{3}\s*年|[一二三四五六七八九〇零]{4}\s*年|[0-9０-９]{1,2}\s*月\s*[0-9０-９]{1,2}\s*日|[一二三四五六七八九十〇零]{1,3}\s*月\s*[一二三四五六七八九十〇零]{1,3}\s*日)/u;
const ORGASM_SOURCE = /イ(?:ク|く|[っッ](?:た|て)|[キき]そう|[っッ]ちゃう|かせ)/u;
const ORDINARY_MOVEMENT_SOURCE = /イ[っッ]て(?:き|来)/u;
const ORGASM_TARGET = /(?:高潮|射精)/u;
const TESTICLE_SOURCE = /(?:金)?玉(?:袋|を|が|に|は|の|へ|から|まで|だけ|も|痛|蹴|潰|揉|触|舐)/u;
const TESTICLE_TARGET = /(?:睾丸|阴囊|蛋蛋|蛋疼|精巢)/u;
const EJACULATION_SOURCE = /(?:射精|精液|ザーメン|中出し|ぶっかけ)/u;
const EJACULATION_TARGET = /(?:射精|精液|体液|内射|中出|喷射|喷出)/u;
const RELEASE_SOUND_SOURCE = /(?:ビュ|びゅ|ピュ|ぴゅ|ビャ|びゃ)(?:ー?(?:ビュ|びゅ|ピュ|ぴゅ|ビャ|びゃ))?[^。！？]{0,8}(?:出|で)/u;
const RELEASE_TARGET = /(?:射|喷|迸|涌|流|出来)/u;
const ORAL_SOURCE = /(?:しゃぶ|咥え|舐め|吸っ)/u;
const ORAL_TARGET = /(?:口交|吸|舔|含|吮|舌)/u;
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
    if (entries.length === 0 || entries.some(([key, item], index) => key !== String(index + 1) || typeof item !== "string" || item.trim().length === 0)) return undefined;
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
    if (entries.length === 0 || entries.some(([key, item], index) => key !== String(index + 1) || typeof item !== "string" || item.trim().length === 0)) return undefined;
    return { message: assistant.message, translations: Object.fromEntries(entries) as Record<string, string> };
  } catch {
    return undefined;
  }
}

function sakuraUserPrompt(pageTexts: string[]): string {
  return [
    "参考以下术语表（可为空，格式为src->dst #备注）：",
    "",
    "根据以上术语表的对应关系和备注，结合历史剧情和上下文，将下面的文本从日文翻译成自然的简体中文。技术词使用通行中文名称，不保留拉丁字母，也不要音译。输入来自漫画 OCR：真实日期必须保留，但如果某条日期或年份明显与同页对话语境冲突，应将其视为 OCR 形近误识并根据同页上下文恢复自然台词。成人语境中的「イク」及其变形必须明确译出高潮或射精含义；「ビャッ／ビュッ／ピュッって出た」一类表达必须译为射出或喷出，不能译成动作很帅、风声或普通动作：",
    `下面共有 ${pageTexts.length} 条输入。必须保持原顺序，每条只输出一行译文，最终恰好输出 ${pageTexts.length} 行；不要编号、解释、代码块或空行。`,
    ...pageTexts,
  ].join("\n");
}

function sakuraLines(completion: JsonRecord, expected: number): string[] | undefined {
  const assistant = assistantContent(completion);
  if (!assistant) return undefined;
  const lines = assistant.content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n").map((line) => line.replace(/^\s*\d+\s*[:：]\s*/u, "").trim());
  return lines.length === expected && lines.every((line) => line.length > 0) ? lines : undefined;
}

function fallbackReason(source: string, translated: string): string | undefined {
  if (MODEL_PLACEHOLDER.test(translated)) return "model-placeholder";
  if (JAPANESE_SCRIPT.test(translated)) return "retained-japanese";
  if (LONG_LATIN.test(translated)) return "long-latin";
  if (SUSPICIOUS_OCR_CALENDAR.test(source)) return "suspicious-ocr-calendar";
  if (!SOURCE_NUMBER.test(source) && TARGET_MULTI_DIGIT.test(translated)) return "introduced-number";
  if (ORGASM_SOURCE.test(source) && !ORDINARY_MOVEMENT_SOURCE.test(source) && !ORGASM_TARGET.test(translated)) return "lost-orgasm";
  if (TESTICLE_SOURCE.test(source) && !TESTICLE_TARGET.test(translated)) return "lost-testicle";
  if (EJACULATION_SOURCE.test(source) && !EJACULATION_TARGET.test(translated)) return "lost-ejaculation";
  if (RELEASE_SOUND_SOURCE.test(source) && !RELEASE_TARGET.test(translated)) return "lost-release-action";
  if (ORAL_SOURCE.test(source) && !ORAL_TARGET.test(translated)) return "lost-oral-action";
  return undefined;
}

function validFallbackForReason(source: string, translated: string, reason: string): boolean {
  if (MODEL_PLACEHOLDER.test(translated) || JAPANESE_SCRIPT.test(translated) || LONG_LATIN.test(translated)) return false;
  if (reason === "introduced-number") return SOURCE_NUMBER.test(source) || !TARGET_MULTI_DIGIT.test(translated);
  if (reason === "lost-orgasm") return ORGASM_TARGET.test(translated);
  if (reason === "lost-testicle") return TESTICLE_TARGET.test(translated);
  if (reason === "lost-ejaculation") return EJACULATION_TARGET.test(translated);
  if (reason === "lost-release-action") return RELEASE_TARGET.test(translated);
  if (reason === "lost-oral-action") return ORAL_TARGET.test(translated);
  return true;
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
  let outputCompletion = primary.value;
  if (!sourceMap) {
    send(response, primary.status, primary.bytes);
    return;
  }
  const sourceKeys = Object.keys(sourceMap);
  const parsedKeys = parsed ? Object.keys(parsed.translations) : [];
  const protocolInvalid = !parsed || sourceKeys.length !== parsedKeys.length || sourceKeys.some((key, index) => parsedKeys[index] !== key);
  const validParsed = protocolInvalid ? undefined : parsed;
  const flagged = !validParsed ? sourceKeys.map((key) => ({ key, reason: "protocol-invalid" })) : Object.entries(validParsed.translations).map(([key, translated]) => ({
    key,
    reason: fallbackReason(sourceMap[key] ?? "", translated),
  })).filter((item): item is { key: string; reason: string } => typeof item.reason === "string");
  if (flagged.length === 0) {
    send(response, primary.status, primary.bytes);
    return;
  }
  metrics.fallbackRequests += 1;
  const keys = flagged.map((item) => item.key);
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
  let fallback: Awaited<ReturnType<typeof postJson>>;
  try {
    fallback = await postJson(upstream, fallbackBody);
  } catch {
    metrics.fallbackFailures += flagged.length;
    if (protocolInvalid) send(response, 502, Buffer.from(JSON.stringify({ error: { code: "MVP_TRANSLATION_PROTOCOL_RECOVERY_FAILED" } })));
    else send(response, primary.status, primary.bytes);
    return;
  }
  const replacements = fallback.value ? sakuraLines(fallback.value, Object.keys(sourceMap).length) : undefined;
  if (!replacements || flagged.some((item) => {
    const replacement = replacements[Number(item.key) - 1];
    return !validFallbackForReason(sourceMap[item.key] ?? "", replacement, item.reason);
  })) {
    metrics.fallbackFailures += flagged.length;
    if (protocolInvalid) send(response, 502, Buffer.from(JSON.stringify({ error: { code: "MVP_TRANSLATION_PROTOCOL_RECOVERY_FAILED" } })));
    else send(response, primary.status, primary.bytes);
    return;
  }
  if (!validParsed) {
    const assistant = assistantContent(primary.value);
    const repaired = Object.fromEntries(sourceKeys.map((key) => [key, replacements[Number(key) - 1]]));
    if (assistant) assistant.message.content = JSON.stringify(repaired);
    else outputCompletion = { choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(repaired) } }] };
  } else {
    for (const key of keys) validParsed.translations[key] = replacements[Number(key) - 1];
    validParsed.message.content = JSON.stringify(validParsed.translations);
  }
  metrics.fallbackRegions += keys.length;
  send(response, 200, Buffer.from(JSON.stringify(outputCompletion)));
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
