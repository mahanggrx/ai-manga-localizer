#!/usr/bin/env node
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { LocalizerError } from "./errors.ts";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_TOKENS = 2_048;
const TRANSLATION_TEMPERATURE = 0.3;
const REASONING_TAG = /<\/?think\b[^>]*>|<\|(?:analysis|reasoning)(?:_content)?\|>/iu;

interface ProxyMetrics {
  completionRequests: number;
  completionSuccesses: number;
  failuresByCode: Record<string, number>;
  lastFailureCode?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function stripModelReasoning(content: string): string {
  const leading = content.trimStart();
  const opening = leading.match(/^<think\b[^>]*>/iu);
  if (!opening) {
    if (REASONING_TAG.test(leading)) throw new LocalizerError("MODEL_REASONING_FORMAT_INVALID", "Model output contains a reasoning marker outside the supported leading block");
    return leading.trimEnd();
  }
  const afterOpening = leading.slice(opening[0].length);
  const closing = afterOpening.match(/<\/think\s*>/iu);
  if (!closing || closing.index === undefined) throw new LocalizerError("MODEL_REASONING_UNTERMINATED", "Model output contains an unterminated reasoning block");
  const translation = afterOpening.slice(closing.index + closing[0].length).trim();
  if (REASONING_TAG.test(translation)) throw new LocalizerError("MODEL_REASONING_FORMAT_INVALID", "Model output contains an additional reasoning marker after the leading block");
  return translation;
}

export function normalizeNumberedListDelimiters(content: string): string {
  const lines = content.split(/\r?\n/u);
  const parsed = lines.map((line) => line.match(/^(\s*)(\d+)\s*([:：﹕])\s*(.*)$/u));
  const nonBlank = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.trim().length > 0);
  if (nonBlank.length === 0 || nonBlank.some(({ index }) => !parsed[index])) return content;
  for (let ordinal = 0; ordinal < nonBlank.length; ordinal += 1) {
    const match = parsed[nonBlank[ordinal].index]!;
    if (Number(match[2]) !== ordinal + 1) return content;
  }
  return lines.map((line, index) => {
    const match = parsed[index];
    return match ? `${match[1]}${match[2]}: ${match[4]}` : line;
  }).join("\n");
}

export function sanitizeChatCompletion(value: unknown): Record<string, unknown> {
  const completion = asRecord(structuredClone(value));
  const choices = completion && Array.isArray(completion.choices) ? completion.choices : undefined;
  if (!completion || !choices || choices.length === 0) throw new LocalizerError("MODEL_RESPONSE_INVALID", "OpenAI-compatible response has no choices");
  for (const choiceValue of choices) {
    const choice = asRecord(choiceValue);
    const message = asRecord(choice?.message);
    if (!message || typeof message.content !== "string") throw new LocalizerError("MODEL_RESPONSE_INVALID", "OpenAI-compatible response has no string assistant content");
    message.content = normalizeNumberedListDelimiters(stripModelReasoning(message.content));
    delete message.reasoning_content;
    delete message.reasoning;
  }
  return completion;
}

async function readBytes(stream: AsyncIterable<Uint8Array>, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > limit) throw new LocalizerError("LOCAL_PROXY_BODY_TOO_LARGE", "Local proxy body exceeds the configured safety limit");
    chunks.push(chunk);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": body.byteLength });
  response.end(body);
}

function proxyError(response: ServerResponse, status: number, code: string, metrics?: ProxyMetrics): void {
  if (metrics) {
    metrics.failuresByCode[code] = (metrics.failuresByCode[code] ?? 0) + 1;
    metrics.lastFailureCode = code;
  }
  sendJson(response, status, { error: { code, message: "Local model adapter failed closed; content omitted for privacy" } });
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, upstream: URL, metrics: ProxyMetrics): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && requestUrl.pathname === "/health") {
    try {
      const health = await fetch(new URL("/health", upstream), { signal: AbortSignal.timeout(5_000) });
      sendJson(response, health.ok ? 200 : 503, { status: health.ok ? "ok" : "unavailable", ...metrics });
    } catch {
      sendJson(response, 503, { status: "unavailable", ...metrics });
    }
    return;
  }
  const modelList = request.method === "GET" && requestUrl.pathname === "/v1/models";
  const completion = request.method === "POST" && requestUrl.pathname === "/v1/chat/completions";
  if (!modelList && !completion) {
    proxyError(response, 404, "LOCAL_PROXY_ROUTE_NOT_FOUND");
    return;
  }
  if (completion) metrics.completionRequests += 1;
  try {
    let body: Uint8Array | undefined;
    if (completion) {
      body = await readBytes(request, MAX_REQUEST_BYTES);
      const parsed = JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
      const requestBody = asRecord(parsed);
      if (!requestBody) throw new LocalizerError("MODEL_REQUEST_INVALID", "Chat completion request must be a JSON object");
      if (requestBody.stream === true) throw new LocalizerError("MODEL_STREAM_UNSUPPORTED", "Streaming is disabled so reasoning removal can fail closed before returning content");
      requestBody.max_tokens = MAX_OUTPUT_TOKENS;
      requestBody.temperature = TRANSLATION_TEMPERATURE;
      delete requestBody.max_completion_tokens;
      body = Buffer.from(JSON.stringify(requestBody));
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (completion) headers["content-type"] = "application/json; charset=utf-8";
    if (typeof request.headers.authorization === "string") headers.authorization = request.headers.authorization;
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    request.once("aborted", abort);
    response.once("close", abort);
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(new URL(requestUrl.pathname, upstream), {
        method: request.method,
        headers,
        ...(body ? { body } : {}),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60_000)]),
      });
    } finally {
      request.off("aborted", abort);
      response.off("close", abort);
    }
    if (!upstreamResponse.ok) {
      await upstreamResponse.body?.cancel().catch(() => undefined);
      proxyError(response, 502, "MODEL_UPSTREAM_HTTP_ERROR", metrics);
      return;
    }
    const upstreamBytes = await readBytes(upstreamResponse.body ?? [], MAX_RESPONSE_BYTES);
    const value = JSON.parse(Buffer.from(upstreamBytes).toString("utf8")) as unknown;
    const output = completion ? sanitizeChatCompletion(value) : value;
    if (completion) metrics.completionSuccesses += 1;
    sendJson(response, 200, output);
  } catch (error) {
    const code = error instanceof LocalizerError ? error.code : (error as Error).name === "AbortError" ? "MODEL_UPSTREAM_ABORTED" : "LOCAL_PROXY_FAILED";
    proxyError(response, code === "LOCAL_PROXY_BODY_TOO_LARGE" ? 413 : 502, code, metrics);
  }
}

export async function startLocalOpenAiProxy(options: { upstreamBaseUrl: string; port: number; host?: string }): Promise<Server> {
  const upstream = new URL(options.upstreamBaseUrl.endsWith("/") ? options.upstreamBaseUrl : `${options.upstreamBaseUrl}/`);
  if (upstream.protocol !== "http:" || !isLoopback(upstream.hostname) || upstream.username || upstream.password) {
    throw new LocalizerError("LOCAL_PROXY_UPSTREAM_FORBIDDEN", "The reasoning-removal proxy only accepts an unauthenticated HTTP loopback upstream");
  }
  const host = options.host ?? "127.0.0.1";
  if (!isLoopback(host)) throw new LocalizerError("LOCAL_PROXY_BIND_FORBIDDEN", "The reasoning-removal proxy may only bind to a loopback address");
  const metrics: ProxyMetrics = { completionRequests: 0, completionSuccesses: 0, failuresByCode: {} };
  const server = createServer((request, response) => {
    void handleRequest(request, response, upstream, metrics).catch(() => proxyError(response, 500, "LOCAL_PROXY_FAILED", metrics));
  });
  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

function parseArgs(args: string[]): { upstreamBaseUrl: string; port: number } {
  let upstreamBaseUrl = "http://127.0.0.1:8080";
  let port = 8081;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const value = args[index + 1];
    if (token === "--upstream" && value) upstreamBaseUrl = value;
    else if (token === "--port" && value) port = Number(value);
    else throw new LocalizerError("LOCAL_PROXY_ARGUMENT_INVALID", `Unsupported local proxy argument: ${token}`);
    index += 1;
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new LocalizerError("LOCAL_PROXY_PORT_INVALID", "Local proxy port must be an integer from 1024 through 65535");
  return { upstreamBaseUrl, port };
}

const directRun = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (directRun) {
  const options = parseArgs(process.argv.slice(2));
  const server = await startLocalOpenAiProxy(options);
  process.stdout.write(`${JSON.stringify({ event: "LOCAL_PROXY_READY", host: "127.0.0.1", port: options.port, maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: TRANSLATION_TEMPERATURE })}\n`);
  const close = (): void => { server.close(() => process.exit(0)); };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
