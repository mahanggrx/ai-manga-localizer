export class LocalizerError extends Error {
  readonly code: string;
  readonly recoverable: boolean;
  readonly status?: number;

  constructor(code: string, message: string, options?: { recoverable?: boolean; status?: number; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LocalizerError";
    this.code = code;
    this.recoverable = options?.recoverable ?? false;
    this.status = options?.status;
  }
}

export function asLocalizerError(error: unknown, fallbackCode = "UNEXPECTED_ERROR"): LocalizerError {
  if (error instanceof LocalizerError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new LocalizerError(fallbackCode, message, { cause: error });
}

