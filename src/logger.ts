const ALLOWED_FIELDS = new Set([
  "runId", "stage", "regionId", "pageId", "durationMs", "errorCode", "status",
  "count", "operationId", "retry", "route", "version", "device", "fileName",
]);

export interface SafeLogger {
  info(code: string, metadata?: Record<string, unknown>): void;
  warn(code: string, metadata?: Record<string, unknown>): void;
  error(code: string, metadata?: Record<string, unknown>): void;
}

function sanitize(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!metadata) return {};
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!ALLOWED_FIELDS.has(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      safe[key] = value;
    }
  }
  return safe;
}

function emit(level: "info" | "warn" | "error", code: string, metadata?: Record<string, unknown>): void {
  const line = JSON.stringify({ time: new Date().toISOString(), level, code, ...sanitize(metadata) });
  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

export const logger: SafeLogger = {
  info: (code, metadata) => emit("info", code, metadata),
  warn: (code, metadata) => emit("warn", code, metadata),
  error: (code, metadata) => emit("error", code, metadata),
};

