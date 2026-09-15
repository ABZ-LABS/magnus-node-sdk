/**
 * A fake Magnus that implements CONTRACT.md.
 *
 * The unit suite runs against this rather than a stubbed `fetch`, so the tests
 * exercise real sockets, real chunked transfer and real SSE framing — the three
 * things a stubbed transport cannot reproduce.
 *
 * Every behaviour here is specified in CONTRACT.md. When the contract changes,
 * change CONTRACT.md first, then this file, and let the suite fail.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

const AGENTS = ["magnus_standard", "porteria", "inmobiliaria"];

export interface RecordedRequest {
  method: string;
  path: string;
  body: any;
  headers: Record<string, string>;
}

export type StreamMode = "tokens" | "single" | "error";

interface Forced {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function errorBody(
  message: string,
  opts: { type?: string; param?: string | null; code?: string | null } = {},
) {
  return {
    error: {
      message,
      type: opts.type ?? "invalid_request_error",
      param: opts.param ?? null,
      code: opts.code ?? null,
    },
  };
}

function modelObject(id: string) {
  return {
    id,
    object: "model",
    created: 1757000000,
    owned_by: "magnus",
    permission: [],
    root: id,
    parent: null,
  };
}

/** The server reads only the last user message, flattening multimodal parts. */
function lastUserText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || typeof message !== "object" || message.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string" && content.trim()) return content;
    if (Array.isArray(content)) {
      const text = content
        .filter((part) => part && typeof part === "object" && part.type === "text")
        .map((part) => part.text ?? "")
        .join("");
      if (text.trim()) return text;
    }
  }
  return "";
}

/** Split into the kind of pieces the server streams: words, spaces kept. */
function tokenize(text: string): string[] {
  return text.split(" ").map((piece, index) => (index === 0 ? piece : ` ${piece}`));
}

/** A Magnus deployment that exists for the length of one test file. */
export class MockMagnus {
  agents = [...AGENTS];
  /** `null` accepts any non-empty key; set it to enforce one. */
  apiKey: string | null = null;
  requests: RecordedRequest[] = [];
  idempotency = new Map<string, "IN_FLIGHT" | { status: number; body: unknown }>();
  turnsRun = 0;
  reply = "Hola, soy Magnus.";
  traceId: string | null = "trace-1";
  turnId: string | null = "turn-1";
  usageSource = "measured";
  usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
  rateLimitRemaining = 119;
  rateLimitReset = "2026-09-09T12:01:00+00:00";
  rolledSessionId: string | null = null;
  unsupportedParams = ["tools", "tool_choice", "functions", "function_call", "response_format"];
  /**
   * How a streamed turn is delivered. `tokens` = word by word (the live path),
   * `single` = one delta (the server delivered the turn whole), `error` = a failure
   * after the stream opened.
   */
  streamMode: StreamMode = "tokens";
  streamError: Record<string, unknown> = {
    message: "Internal server error.",
    type: "server_error",
    param: null,
    code: null,
  };

  #forced: Forced[] = [];
  #server: Server;
  #url = "";

  private constructor() {
    this.#server = createServer((req, res) => {
      this.#handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  }

  static async start(): Promise<MockMagnus> {
    const mock = new MockMagnus();
    await new Promise<void>((resolve) => mock.#server.listen(0, "127.0.0.1", resolve));
    const address = mock.#server.address();
    if (address && typeof address === "object") {
      mock.#url = `http://127.0.0.1:${address.port}`;
    }
    return mock;
  }

  get url(): string {
    return this.#url;
  }

  /** Serve this next, once, before normal handling. */
  force(status: number, body: unknown, headers?: Record<string, string>): void {
    this.#forced.push({ status, body, headers });
  }

  /** Forget everything a previous test set, so one server can serve a whole file. */
  reset(): void {
    this.agents = [...AGENTS];
    this.apiKey = null;
    this.requests = [];
    this.idempotency.clear();
    this.turnsRun = 0;
    this.reply = "Hola, soy Magnus.";
    this.traceId = "trace-1";
    this.turnId = "turn-1";
    this.usageSource = "measured";
    this.usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
    this.rateLimitRemaining = 119;
    this.rolledSessionId = null;
    this.unsupportedParams = [
      "tools", "tool_choice", "functions", "function_call", "response_format",
    ];
    this.streamMode = "tokens";
    this.streamError = {
      message: "Internal server error.", type: "server_error", param: null, code: null,
    };
    this.#forced = [];
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  // ------------------------------------------------------------------ handling

  #json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      ...headers,
    });
    res.end(payload);
  }

  #authorized(req: IncomingMessage): boolean {
    const auth = req.headers.authorization;
    let presented: string | undefined;
    if (auth?.startsWith("Bearer ") && auth.slice(7)) presented = auth.slice(7);
    else if (req.headers["x-api-key"]) presented = String(req.headers["x-api-key"]);
    if (!presented) return false;
    return this.apiKey === null || presented === this.apiKey;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString();
    let body: any = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
    }
    const path = req.url ?? "";
    this.requests.push({
      method: req.method ?? "GET",
      path,
      body,
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v)]),
      ),
    });

    if (req.method === "GET" && path === "/api/health/simple") {
      return this.#json(res, 200, {
        status: "ok",
        timestamp: "2026-09-09T12:00:00+00:00",
        version: { version: "mock" },
      });
    }

    if (!this.#authorized(req)) {
      return this.#json(
        res, 401,
        errorBody("Incorrect API key provided.", { code: "invalid_api_key" }),
      );
    }

    const forced = this.#forced.shift();
    if (forced) return this.#json(res, forced.status, forced.body, forced.headers);

    if (req.method === "GET" && path === "/v1/models") {
      return this.#json(res, 200, {
        object: "list",
        data: this.agents.map(modelObject),
      });
    }

    if (req.method === "GET" && path.startsWith("/v1/models/")) {
      let id = decodeURIComponent(path.slice("/v1/models/".length));
      if (id === "magnus" && this.agents.includes("magnus_standard")) id = "magnus_standard";
      if (this.agents.includes(id)) return this.#json(res, 200, modelObject(id));
      return this.#json(
        res, 404,
        errorBody(`The model '${id}' does not exist or you do not have access.`, {
          param: "model", code: "model_not_found",
        }),
      );
    }

    if (req.method === "POST" && path === "/v1/chat/completions") {
      return this.#chat(req, res, body);
    }

    return this.#json(res, 404, errorBody("Not found."));
  }

  #chat(req: IncomingMessage, res: ServerResponse, body: any): void {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return this.#json(res, 400, errorBody("Request body must be a JSON object.", {
        param: "body",
      }));
    }

    // Refused rather than ignored — the pipeline owns these.
    for (const param of this.unsupportedParams) {
      const value = body[param];
      if (value === undefined || value === null) continue;
      if (Array.isArray(value) && value.length === 0) continue;
      if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) {
        continue;
      }
      return this.#json(res, 400, errorBody(
        `'${param}' is not supported by this endpoint.`,
        { param, code: "unsupported_parameter" },
      ));
    }
    if (body.n !== undefined && body.n !== null && body.n !== 1) {
      return this.#json(res, 400, errorBody("'n' must be 1.", {
        param: "n", code: "unsupported_parameter",
      }));
    }

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return this.#json(res, 400, errorBody("messages is required and must be a list.", {
        param: "messages",
      }));
    }

    const text = lastUserText(body.messages);
    if (!text) {
      return this.#json(res, 400, errorBody("No user message with text content found.", {
        param: "messages",
      }));
    }

    const requested = body.session_id ?? req.headers["x-magnus-session-id"];
    let source = "new";
    if (requested) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(requested))) {
        return this.#json(res, 400, errorBody("session_id must be a UUID.", {
          param: "session_id",
        }));
      }
      source = "explicit";
    }

    // The pipeline may roll the session mid-turn; the mock does it on demand so
    // a client that echoes the request value instead of the response one is
    // caught.
    const effectiveSession = this.rolledSessionId ?? String(requested ?? randomUUID());
    if (this.rolledSessionId) source = "new";

    const idemKey = req.headers["idempotency-key"] as string | undefined;
    if (idemKey) {
      const stored = this.idempotency.get(idemKey);
      if (stored === "IN_FLIGHT") {
        return this.#json(res, 409, errorBody(
          "A request with this Idempotency-Key is still in progress.",
          { param: "Idempotency-Key", code: "request_in_progress" },
        ));
      }
      if (stored) return this.#json(res, stored.status, stored.body);
    }

    this.turnsRun += 1;
    const reply = this.reply;
    const extensions = {
      session_id: effectiveSession,
      magnus: {
        session_id: effectiveSession,
        session_source: source,
        trace_id: this.traceId,
        turn_id: this.turnId,
        usage_source: this.usageSource,
      },
    };
    const usage = { ...this.usage };

    if (body.stream) {
      const includeUsage = Boolean(body.stream_options?.include_usage);
      return this.#sse(res, this.#buildStream(reply, extensions, usage, includeUsage));
    }

    const response = {
      id: "chatcmpl-mock",
      object: "chat.completion",
      created: 1757000000,
      model: body.model ?? "magnus_standard",
      choices: [{
        index: 0,
        message: { role: "assistant", content: reply },
        finish_reason: "stop",
      }],
      usage,
      ...extensions,
    };
    if (idemKey) this.idempotency.set(idemKey, { status: 200, body: response });
    return this.#json(res, 200, response, {
      "X-RateLimit-Remaining": String(this.rateLimitRemaining),
      "X-RateLimit-Reset": this.rateLimitReset,
    });
  }

  #sse(res: ServerResponse, frames: string[]): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    });
    for (const frame of frames) res.write(frame);
    res.end();
  }

  #buildStream(
    text: string,
    extensions: Record<string, unknown>,
    usage: Record<string, number>,
    includeUsage: boolean,
  ): string[] {
    const chunk = (
      choices: unknown[],
      extra?: Record<string, unknown>,
      usagePayload?: Record<string, number>,
    ): string => {
      const payload: Record<string, unknown> = {
        id: "chatcmpl-mock",
        object: "chat.completion.chunk",
        created: 1757000000,
        model: "magnus_standard",
        choices,
      };
      if (usagePayload !== undefined) payload.usage = usagePayload;
      if (extra) Object.assign(payload, extra);
      return `data: ${JSON.stringify(payload)}\n\n`;
    };

    const out: string[] = [];

    if (this.streamMode === "single") {
      // The buffered path: one delta, extensions riding on it.
      out.push(chunk(
        [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
        extensions,
      ));
      out.push(chunk([{ index: 0, delta: {}, finish_reason: "stop" }]));
    } else {
      // The live path: an opening chunk before any token, then tokens, then a
      // closing chunk carrying the extensions.
      out.push(chunk([{ index: 0, delta: { role: "assistant" }, finish_reason: null }]));
      if (this.streamMode === "error") {
        out.push(chunk([{ index: 0, delta: { content: text.slice(0, 5) }, finish_reason: null }]));
        out.push(chunk(
          [{ index: 0, delta: {}, finish_reason: "stop" }],
          { error: this.streamError },
        ));
        out.push("data: [DONE]\n\n");
        return out;
      }
      for (const piece of tokenize(text)) {
        out.push(chunk([{ index: 0, delta: { content: piece }, finish_reason: null }]));
      }
      out.push(chunk([{ index: 0, delta: {}, finish_reason: "stop" }], extensions));
    }

    if (includeUsage) out.push(chunk([], undefined, usage));
    out.push("data: [DONE]\n\n");
    return out;
  }
}
