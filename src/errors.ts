/**
 * Typed errors for the Magnus API.
 *
 * The server always answers a failure with the same envelope:
 *
 *     {"error": {"message": ..., "type": ..., "param": ..., "code": ...}}
 *
 * Throwing a bare `Error: 400` threw that away and left the caller reading a
 * status code, so "you sent a parameter Magnus refuses" and "your key expired"
 * arrived looking identical. Every field of the envelope survives onto the
 * thrown value.
 */

export interface ErrorEnvelope {
  message?: string;
  type?: string | null;
  param?: string | null;
  code?: string | null;
}

/** Base class for every error this SDK throws. */
export class MagnusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The request never reached Magnus, or the connection died mid-flight. */
export class MagnusConnectionError extends MagnusError {}

/**
 * The request was still open when the client's timeout expired.
 *
 * A timeout is not an answer: the turn may well have run. Retrying it without
 * an `Idempotency-Key` can run the pipeline a second time and duplicate
 * whatever side effects its tools have.
 */
export class MagnusTimeoutError extends MagnusConnectionError {}

export interface APIErrorInit {
  status: number;
  type?: string | null;
  code?: string | null;
  param?: string | null;
  headers?: Headers | Record<string, string>;
  body?: unknown;
}

/** Magnus answered with an error envelope. */
export class MagnusAPIError extends MagnusError {
  readonly status: number;
  readonly type?: string | null;
  readonly code?: string | null;
  readonly param?: string | null;
  readonly headers: Record<string, string>;
  readonly body?: unknown;
  /** The server's own message, undecorated — for rendering to a person. */
  readonly serverMessage: string;

  constructor(message: string, init: APIErrorInit) {
    const bits: string[] = [String(init.status)];
    if (init.code) bits.push(init.code);
    if (init.param) bits.push(`param=${init.param}`);
    super(`[${bits.join(" ")}] ${message}`);
    this.status = init.status;
    this.type = init.type;
    this.code = init.code;
    this.param = init.param;
    this.body = init.body;
    this.headers = normalizeHeaders(init.headers);
    // `message` on Error carries the decorated form; the raw server text stays
    // reachable for anyone rendering it to a user.
    this.serverMessage = message;
  }

  /** Seconds the server asked us to wait, when it said. */
  get retryAfter(): number | null {
    const raw = this.headers["retry-after"];
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
}

/** 401 — no key, or a key Magnus does not accept. */
export class AuthenticationError extends MagnusAPIError {}
/** 403 — the key is valid but not for this. */
export class PermissionDeniedError extends MagnusAPIError {}
/** 404 — no such agent, or no access to it. */
export class NotFoundError extends MagnusAPIError {}
/** 400 — the request cannot be honoured as written. */
export class InvalidRequestError extends MagnusAPIError {}

/**
 * 400 with `code: "unsupported_parameter"`.
 *
 * Magnus runs its own agent pipeline: tools are configured per agent and the
 * response format is the agent's decision, so `tools`, `tool_choice`,
 * `functions`, `function_call`, `response_format` and `n > 1` are refused
 * rather than silently ignored. `.param` names the offender.
 */
export class UnsupportedParameterError extends InvalidRequestError {}

/** 409 — a turn with this `Idempotency-Key` is still running. */
export class ConflictError extends MagnusAPIError {}
/** 429 — the key's window is exhausted. See `.retryAfter`. */
export class RateLimitError extends MagnusAPIError {}
/** 5xx — Magnus failed to process the turn. */
export class ServerError extends MagnusAPIError {}

/**
 * A streamed turn failed after the stream had already opened.
 *
 * The status line went out as 200 with the first chunk and cannot be taken
 * back, so the failure arrives inside the stream instead. Whatever was streamed
 * before it is kept on `.partialText` — it is what the reader has already seen
 * — but the turn did not succeed.
 */
export class StreamError extends MagnusError {
  readonly type?: string | null;
  readonly code?: string | null;
  readonly param?: string | null;
  readonly partialText: string;
  readonly serverMessage: string;

  constructor(
    message: string,
    init: { type?: string | null; code?: string | null; param?: string | null; partialText?: string } = {},
  ) {
    super(`[stream ${init.code ?? init.type ?? "error"}] ${message}`);
    this.serverMessage = message;
    this.type = init.type;
    this.code = init.code;
    this.param = init.param;
    this.partialText = init.partialText ?? "";
  }
}

function normalizeHeaders(headers?: Headers | Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (typeof (headers as Headers).forEach === "function" && (headers as Headers).get) {
    (headers as Headers).forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

const BY_STATUS: Record<number, typeof MagnusAPIError> = {
  400: InvalidRequestError,
  401: AuthenticationError,
  403: PermissionDeniedError,
  404: NotFoundError,
  409: ConflictError,
  429: RateLimitError,
};

/** Build the right error from an HTTP failure. */
export function errorFromResponse(
  status: number,
  body: unknown,
  headers?: Headers | Record<string, string>,
): MagnusAPIError {
  let message: string;
  let type: string | null | undefined;
  let code: string | null | undefined;
  let param: string | null | undefined;

  const envelope = (body as { error?: unknown } | null)?.error;
  if (envelope && typeof envelope === "object") {
    const e = envelope as ErrorEnvelope;
    message = e.message ?? `Magnus returned ${status}.`;
    type = e.type;
    code = e.code;
    param = e.param;
  } else if (typeof envelope === "string") {
    message = envelope;
  } else {
    // Not an envelope at all — a proxy error page, or HTML from the wrong host.
    // Keep a slice of it: "502" alone never located anything.
    const snippet = typeof body === "string" ? body.slice(0, 200).trim() : "";
    message = `Magnus returned ${status}.${snippet ? ` ${snippet}` : ""}`;
  }

  let Ctor: typeof MagnusAPIError;
  if (code === "unsupported_parameter") Ctor = UnsupportedParameterError;
  else if (status >= 500) Ctor = ServerError;
  else Ctor = BY_STATUS[status] ?? MagnusAPIError;

  return new Ctor(message, { status, type, code, param, headers, body });
}
