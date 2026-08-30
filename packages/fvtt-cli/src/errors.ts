export class CliError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "CliError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function errorToJson(error: unknown): {
  code: string;
  message: string;
  details?: unknown;
} {
  if (error instanceof CliError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  }

  if (error instanceof Error) {
    return {
      code: "ERR_UNEXPECTED",
      message: error.message,
      ...(error.stack ? { details: { stack: error.stack } } : {}),
    };
  }

  return {
    code: "ERR_UNEXPECTED",
    message: String(error),
  };
}
