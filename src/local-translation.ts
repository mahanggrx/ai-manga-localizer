import { LocalizerError } from "./errors.ts";
import type { JsonObject, LlmTarget } from "./types.ts";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function loopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function assertLocalTranslationTarget(target: LlmTarget, runtimeConfig: JsonObject): void {
  if (target.kind === "local") return;
  if (target.providerId !== "openai-compatible") {
    throw new LocalizerError("LOCAL_TRANSLATOR_PROVIDER_UNSUPPORTED", "Primary translation may only use a Koharu local model or the openai-compatible provider on a loopback address");
  }
  const providers = Array.isArray(runtimeConfig.providers) ? runtimeConfig.providers : [];
  const provider = providers.map(record).find((item) => item?.id === target.providerId);
  const baseUrl = provider?.baseUrl ?? provider?.base_url;
  if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) {
    throw new LocalizerError("LOCAL_TRANSLATOR_PROVIDER_MISSING", "Koharu has no configured loopback openai-compatible provider for the primary translation target");
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch (error) {
    throw new LocalizerError("LOCAL_TRANSLATOR_URL_INVALID", "The primary openai-compatible provider URL is invalid", { cause: error });
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !loopback(parsed.hostname) || parsed.username || parsed.password) {
    throw new LocalizerError("LOCAL_TRANSLATOR_REMOTE_FORBIDDEN", "The primary openai-compatible provider must use an HTTP(S) loopback URL without embedded credentials");
  }
}
