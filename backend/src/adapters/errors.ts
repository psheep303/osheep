export type AdapterErrorCode =
  | "START_FAILED"
  | "SEND_FAILED"
  | "PROCESS_EXITED"
  | "SESSION_NOT_FOUND"
  | "UNSUPPORTED"
  | "TIMEOUT"
  | "INTERRUPTED"
  | "PERMISSION_DENIED"
  | "INVALID_CONFIG"
  | "UNKNOWN";
export class AdapterError extends Error {
  readonly name = "AdapterError";
  constructor(
    readonly code: AdapterErrorCode,
    message: string,
    readonly details: {
      adapterId?: string;
      sessionId?: string;
      retryable?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message);
  }
  get adapterId() {
    return this.details.adapterId;
  }
  get sessionId() {
    return this.details.sessionId;
  }
  get retryable() {
    return this.details.retryable ?? false;
  }
  get cause() {
    return this.details.cause;
  }
}
export function adapterError(
  code: AdapterErrorCode,
  message: string,
  details?: AdapterError["details"],
): AdapterError {
  return new AdapterError(code, message, details);
}
