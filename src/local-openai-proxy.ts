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

interface ProxyMetrics {
  completionRequests: number;
  completionSuccesses: number;
  failuresByCode: Record<string, number>;
  lastFailureCode?: string;
  lastCompletion?: CompletionDiagnostics;
}

export type CompletionFinishReason = "stop" | "length" | "tool_calls" | "function_call" | "content_filter" | "other" | null;
export type CompletionDiagnosticFailureCode =
  | "MODEL_RESPONSE_INVALID"
  | "MODEL_RESPONSE_EMPTY"
  | "MODEL_REASONING_UNTERMINATED"
  | "MODEL_REASONING_NON_PREFIX"
  | "MODEL_REASONING_DUPLICATE"
  | "MODEL_REASONING_NESTED"
  | "MODEL_REASONING_TAG_VARIANT"
  | "MODEL_REASONING_TRAILING_MARKER"
  | "MODEL_REASONING_FORMAT_INVALID";
export type CompletionDiagnosticStage = "pre_sanitize" | "response_shape" | "reasoning" | "translation" | "accepted";

export interface CompletionDiagnostics {
  httpStatus: number | null;
  choiceCount: number | null;
  finishReason: CompletionFinishReason;
  completionTokens: number | null;
  contentIsString: boolean;
  reasoningFieldsPresent: boolean;
  failureStage: CompletionDiagnosticStage;
  failureCode: CompletionDiagnosticFailureCode | null;
  reasoningObserved: boolean;
  reasoningDiscarded: boolean;
}

export interface SanitizedChatCompletion {
  response: Record<string, unknown>;
  content: string;
  diagnostics: CompletionDiagnostics;
}

export interface SanitizeChatCompletionOptions {
  normalizeNumberedLists?: boolean;
  httpStatus?: number | null;
  onDiagnostic?: (diagnostics: CompletionDiagnostics) => void;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

const EXACT_OPENING_TAG = "<think>";
const EXACT_CLOSING_TAG = "</think>";
const REASONING_MARKER = /<\/?think\b(?:[^>]*>|[^>]*$)>?|<\|(?:analysis|reasoning)(?:_content)?\|>/giu;

function reasoningMarkers(value: string): Array<{ index: number; token: string }> {
  return Array.from(value.matchAll(REASONING_MARKER), (match) => ({ index: match.index ?? -1, token: match[0] }));
}

function reasoningFailure(code: CompletionDiagnosticFailureCode, message: string): LocalizerError {
  return new LocalizerError(code, message);
}

function directMarkerFailureCode(leading: string): CompletionDiagnosticFailureCode {
  const first = reasoningMarkers(leading)[0];
  if (!first) return "MODEL_REASONING_FORMAT_INVALID";
  if (first.token === EXACT_OPENING_TAG || first.token === EXACT_CLOSING_TAG) return "MODEL_REASONING_NON_PREFIX";
  return "MODEL_REASONING_TAG_VARIANT";
}

function blockMarkerFailureCode(reasoningBlock: string): CompletionDiagnosticFailureCode | undefined {
  const markers = reasoningMarkers(reasoningBlock);
  if (markers.some(({ token }) => token === EXACT_OPENING_TAG)) return "MODEL_REASONING_NESTED";
  if (markers.length > 0) return "MODEL_REASONING_TAG_VARIANT";
  return undefined;
}

function tailMarkerFailureCode(translation: string): CompletionDiagnosticFailureCode | undefined {
  const markers = reasoningMarkers(translation);
  if (markers.length === 0) return undefined;
  if (markers.some(({ token }) => token !== EXACT_OPENING_TAG && token !== EXACT_CLOSING_TAG)) return "MODEL_REASONING_TAG_VARIANT";
  if (translation.trimStart().startsWith(EXACT_OPENING_TAG)) return "MODEL_REASONING_DUPLICATE";
  return "MODEL_REASONING_TRAILING_MARKER";
}

export function sanitizeModelContent(content: string): { content: string; reasoningObserved: boolean; reasoningDiscarded: boolean } {
  const leading = content.trimStart();
  if (!leading.startsWith(EXACT_OPENING_TAG)) {
    if (reasoningMarkers(leading).length > 0) {
      const code = directMarkerFailureCode(leading);
      throw reasoningFailure(code, "Model output contains a reasoning marker outside the allowed prefix");
    }
    const translation = leading.trimEnd();
    if (translation.length === 0) throw new LocalizerError("MODEL_RESPONSE_EMPTY", "Model output has no non-empty translation");
    return { content: translation, reasoningObserved: false, reasoningDiscarded: false };
  }
  const afterOpening = leading.slice(EXACT_OPENING_TAG.length);
  const closingIndex = afterOpening.indexOf(EXACT_CLOSING_TAG);
  if (closingIndex < 0) {
    const markers = reasoningMarkers(afterOpening);
    if (markers.some(({ token }) => token === EXACT_OPENING_TAG)) throw reasoningFailure("MODEL_REASONING_NESTED", "Model output contains a nested reasoning block");
    if (markers.length > 0) throw reasoningFailure("MODEL_REASONING_TAG_VARIANT", "Model output contains a reasoning tag variant");
    throw new LocalizerError("MODEL_REASONING_UNTERMINATED", "Model output contains an unterminated reasoning block");
  }
  const reasoningBlock = afterOpening.slice(0, closingIndex);
  const blockFailureCode = blockMarkerFailureCode(reasoningBlock);
  if (blockFailureCode) throw reasoningFailure(blockFailureCode, "Model output contains an invalid reasoning block structure");
  const translation = afterOpening.slice(closingIndex + EXACT_CLOSING_TAG.length).trim();
  const tailFailureCode = tailMarkerFailureCode(translation);
  if (tailFailureCode) throw reasoningFailure(tailFailureCode, "Model output contains a reasoning marker after the allowed prefix");
  if (translation.length === 0) throw new LocalizerError("MODEL_RESPONSE_EMPTY", "Model output has no non-empty translation");
  return { content: translation, reasoningObserved: true, reasoningDiscarded: true };
}

export function stripModelReasoning(content: string): string {
  return sanitizeModelContent(content).content;
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

function deleteReasoningFields(record: Record<string, unknown>): void {
  delete record.reasoning_content;
  delete record.reasoning;
}

function normalizeHttpStatus(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function diagnosticFinishReason(choice: Record<string, unknown> | undefined): CompletionFinishReason {
  if (!choice || typeof choice.finish_reason !== "string") return null;
  switch (choice.finish_reason) {
    case "stop":
    case "length":
    case "tool_calls":
    case "function_call":
    case "content_filter":
      return choice.finish_reason;
    default:
      return "other";
  }
}

function diagnosticCompletionTokens(completion: Record<string, unknown>): number | null {
  const usage = asRecord(completion.usage);
  const value = usage?.completion_tokens;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function hasReasoningFields(record: Record<string, unknown> | undefined): boolean {
  return record !== undefined && (Object.prototype.hasOwnProperty.call(record, "reasoning_content") || Object.prototype.hasOwnProperty.call(record, "reasoning"));
}

function hasAnyReasoningFields(completion: Record<string, unknown> | undefined, choices: unknown[] | undefined): boolean {
  if (hasReasoningFields(completion)) return true;
  for (const rawChoice of choices ?? []) {
    const choice = asRecord(rawChoice);
    if (hasReasoningFields(choice) || hasReasoningFields(asRecord(choice?.message))) return true;
  }
  return false;
}

export function inspectChatCompletionDiagnostics(value: unknown, options?: { httpStatus?: number | null }): CompletionDiagnostics {
  const completion = asRecord(value);
  const choices = completion && Array.isArray(completion.choices) ? completion.choices : undefined;
  const choice = choices?.length === 1 ? asRecord(choices[0]) : undefined;
  const message = asRecord(choice?.message);
  const content = message?.content;
  return {
    httpStatus: normalizeHttpStatus(options?.httpStatus),
    choiceCount: choices ? choices.length : null,
    finishReason: diagnosticFinishReason(choice),
    completionTokens: completion ? diagnosticCompletionTokens(completion) : null,
    contentIsString: typeof content === "string",
    reasoningFieldsPresent: hasAnyReasoningFields(completion, choices),
    failureStage: "pre_sanitize",
    failureCode: null,
    reasoningObserved: typeof content === "string" && content.trimStart().startsWith(EXACT_OPENING_TAG),
    reasoningDiscarded: false,
  };
}

function diagnosticFailureCode(error: unknown): CompletionDiagnosticFailureCode {
  const code = error instanceof LocalizerError ? error.code : "MODEL_RESPONSE_INVALID";
  switch (code) {
    case "MODEL_RESPONSE_INVALID":
    case "MODEL_RESPONSE_EMPTY":
    case "MODEL_REASONING_UNTERMINATED":
    case "MODEL_REASONING_NON_PREFIX":
    case "MODEL_REASONING_DUPLICATE":
    case "MODEL_REASONING_NESTED":
    case "MODEL_REASONING_TAG_VARIANT":
    case "MODEL_REASONING_TRAILING_MARKER":
    case "MODEL_REASONING_FORMAT_INVALID":
      return code;
    default:
      return "MODEL_RESPONSE_INVALID";
  }
}

function diagnosticFailureStage(code: CompletionDiagnosticFailureCode): CompletionDiagnosticStage {
  if (code === "MODEL_RESPONSE_EMPTY") return "translation";
  if (code.startsWith("MODEL_REASONING_")) return "reasoning";
  return "response_shape";
}

export function sanitizeChatCompletionWithDiagnostics(value: unknown, options?: SanitizeChatCompletionOptions): SanitizedChatCompletion {
  const before = inspectChatCompletionDiagnostics(value, { httpStatus: options?.httpStatus });
  options?.onDiagnostic?.(before);
  try {
    const completion = asRecord(structuredClone(value));
    const choices = completion && Array.isArray(completion.choices) ? completion.choices : undefined;
    if (!completion || !choices || choices.length !== 1) throw new LocalizerError("MODEL_RESPONSE_INVALID", "OpenAI-compatible response must contain exactly one choice");
    const choice = asRecord(choices[0]);
    const message = asRecord(choice?.message);
    if (!choice || !message || typeof message.content !== "string") throw new LocalizerError("MODEL_RESPONSE_INVALID", "OpenAI-compatible response has no string assistant content");
    const sanitized = sanitizeModelContent(message.content);
    message.content = options?.normalizeNumberedLists === false ? sanitized.content : normalizeNumberedListDelimiters(sanitized.content);
    deleteReasoningFields(completion);
    deleteReasoningFields(choice);
    deleteReasoningFields(message);
    const diagnostics: CompletionDiagnostics = {
      ...before,
      finishReason: diagnosticFinishReason(choice),
      completionTokens: diagnosticCompletionTokens(completion),
      failureStage: "accepted",
      failureCode: null,
      // Independent reasoning fields are deliberately detected only by key
      // presence. Their values are never read, retained, logged, or copied.
      reasoningObserved: sanitized.reasoningObserved || before.reasoningFieldsPresent,
      reasoningDiscarded: sanitized.reasoningDiscarded || before.reasoningFieldsPresent,
    };
    options?.onDiagnostic?.(diagnostics);
    return { response: completion, content: message.content, diagnostics };
  } catch (error) {
    const failureCode = diagnosticFailureCode(error);
    options?.onDiagnostic?.({ ...before, failureStage: diagnosticFailureStage(failureCode), failureCode, reasoningDiscarded: false });
    throw error;
  }
}

export function sanitizeChatCompletion(value: unknown): Record<string, unknown> {
  return sanitizeChatCompletionWithDiagnostics(value).response;
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

function parseJson(bytes: Uint8Array, code: string, message: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch (error) {
    throw new LocalizerError(code, message, { cause: error });
  }
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
      const parsed = parseJson(body, "MODEL_REQUEST_INVALID", "Chat completion request is not valid JSON");
      const requestBody = asRecord(parsed);
      if (!requestBody) throw new LocalizerError("MODEL_REQUEST_INVALID", "Chat completion request must be a JSON object");
      if (requestBody.stream !== false) throw new LocalizerError("MODEL_STREAM_UNSUPPORTED", "Chat completion request must set stream to false");
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
    const value = completion ? parseJson(upstreamBytes, "MODEL_RESPONSE_INVALID", "OpenAI-compatible response is not valid JSON") : parseJson(upstreamBytes, "LOCAL_PROXY_FAILED", "Model discovery response is not valid JSON");
    const sanitized = completion ? sanitizeChatCompletionWithDiagnostics(value, {
      httpStatus: upstreamResponse.status,
      onDiagnostic: (diagnostics) => { metrics.lastCompletion = diagnostics; },
    }) : undefined;
    const output = sanitized?.response ?? value;
    if (sanitized) {
      metrics.completionSuccesses += 1;
      metrics.lastCompletion = sanitized.diagnostics;
    }
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
