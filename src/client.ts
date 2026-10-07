/**
 * HTTP client for the Magnus `/v1` API (OpenAI-compatible surface).
 *
 * Magnus exposes its agents as OpenAI "models". The envelope is OpenAI's; the
 * semantics are not, and the differences are what this client exists to hide:
 *
 * - **history is not state.** The server reads only the last user message and
 *   keeps conversation state server-side, so resending history does not restore
 *   a thread. `session_id` does. Prefer {@link MagnusClient.conversation}.
 * - **the agent owns the turn.** `tools`, `response_format` and friends are
 *   refused rather than ignored, because a silently dropped `response_format`
 *   is worse than a 400.
 * - **a streamed turn can fail after HTTP 200.** See `./stream.ts`.
 *
 * See CONTRACT.md for the wire format this client is written against.
 */
import {
  MagnusConnectionError,
  MagnusTimeoutError,
  NotFoundError,
  errorFromResponse,
} from "./errors.ts";
import { ChatStream, iterSSE } from "./stream.ts";
import type {
  Agent, ChatMessage, ChatResponse, Content, ConversationUpdates, OperatorMessage, Usage,
} from "./types.ts";

export const VERSION = "0.1.0";

/**
 * Above the 60s read timeout common in reverse proxies. Matching it exactly
 * means the client gives up at the same instant the proxy does, turning a clean
 * server-side timeout into an ambiguous client error.
 */
export const DEFAULT_TIMEOUT_MS = 90_000;

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MagnusClientOptions {
  /** The server root, e.g. `https://app.iamagnus.com`. Not the `/v1` prefix. */
  baseUrl: string;
  /** A System API Key or User API Key from the Magnus dashboard. */
  apiKey: string;
  /** End-user identifier for multi-tenant attribution. Overridable per call. */
  user?: string;
  /** Milliseconds, per attempt. */
  timeout?: number;
  /** Extra attempts for 429/5xx and transport failures. */
  maxRetries?: number;
  /**
   * Both are accepted by the server; the header only matters behind a proxy
   * that strips one of them.
   */
  authScheme?: "bearer" | "x-api-key";
  /** Injected for tests. */
  fetch?: typeof globalThis.fetch;
}

export interface ChatOptions {
  user?: string;
  /** Must be a UUID. Continues that conversation. */
  sessionId?: string;
  /**
   * Makes the turn safe to retry: the server replays its first response
   * instead of running the pipeline again. It is also what allows this client
   * to retry a failed POST at all.
   */
  idempotencyKey?: string;
  /**
   * Forward compatibility: a server field newer than this SDK, sent as-is.
   * Nothing here is validated — that is the point, and why it is not the
   * ordinary path.
   */
  extraBody?: Record<string, unknown>;
}

export interface StreamOptions extends Omit<ChatOptions, "idempotencyKey"> {
  /** Ask for the extra final chunk carrying `usage`. */
  includeUsage?: boolean;
}

export class MagnusClient {
  readonly baseUrl: string;
  readonly authScheme: "bearer" | "x-api-key";
  user?: string;
  timeout: number;
  maxRetries: number;

  /** Last seen rate-limit budget, for callers that pace themselves. */
  rateLimitRemaining: number | null = null;
  rateLimitReset: string | null = null;

  #apiKey: string;
  #fetch: typeof globalThis.fetch;

  constructor(options: MagnusClientOptions | string, apiKey?: string) {
    const opts: MagnusClientOptions =
      typeof options === "string" ? { baseUrl: options, apiKey: apiKey ?? "" } : options;
    if (!opts.baseUrl) throw new TypeError("baseUrl is required");
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#apiKey = opts.apiKey ?? "";
    this.user = opts.user;
    this.timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = Math.max(0, opts.maxRetries ?? 2);
    this.authScheme = opts.authScheme ?? "bearer";
    if (this.authScheme !== "bearer" && this.authScheme !== "x-api-key") {
      throw new TypeError("authScheme must be 'bearer' or 'x-api-key'");
    }
    this.#fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  // ------------------------------------------------------------------ plumbing

  #headers(extra?: Record<string, string | undefined>): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": `iamagnus-node/${VERSION}`,
    };
    if (this.authScheme === "bearer") headers.Authorization = `Bearer ${this.#apiKey}`;
    else headers["X-API-Key"] = this.#apiKey;
    // Merge rather than replace: a caller passing one extra header must not
    // drop the credential.
    for (const [key, value] of Object.entries(extra ?? {})) {
      if (value !== undefined) headers[key] = value;
    }
    return headers;
  }

  #noteRateLimit(response: Response): void {
    const remaining = response.headers.get("X-RateLimit-Remaining");
    if (remaining !== null) {
      const parsed = Number.parseInt(remaining, 10);
      if (Number.isFinite(parsed)) this.rateLimitRemaining = parsed;
    }
    const reset = response.headers.get("X-RateLimit-Reset");
    if (reset) this.rateLimitReset = reset;
  }

  /**
   * How long to wait before the next attempt. The server's own `Retry-After`
   * wins when it sent one — guessing shorter just burns the next window too.
   */
  #backoffMs(attempt: number, response?: Response): number {
    const raw = response?.headers.get("Retry-After");
    if (raw) {
      const seconds = Number.parseInt(raw, 10);
      if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    }
    // Jittered. Without jitter, every client that hit the same 429 retries in
    // the same instant.
    return Math.min(8000, 2 ** attempt * 500) * (0.5 + Math.random() / 2);
  }

  async #request(
    method: string,
    path: string,
    init: {
      body?: unknown;
      headers?: Record<string, string | undefined>;
      retry?: boolean;
      stream?: boolean;
    } = {},
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const attempts = init.retry ? this.maxRetries + 1 : 1;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < attempts; attempt++) {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method,
          headers: this.#headers({
            ...init.headers,
            ...(init.stream ? { Accept: "text/event-stream" } : {}),
          }),
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: AbortSignal.timeout(this.timeout),
        });
      } catch (cause) {
        const isTimeout =
          cause instanceof Error &&
          (cause.name === "TimeoutError" || cause.name === "AbortError");
        lastError = isTimeout
          ? new MagnusTimeoutError(
              `${method} ${url} timed out after ${this.timeout}ms. The turn may still ` +
                `have run; retry only with an Idempotency-Key.`,
            )
          : new MagnusConnectionError(
              `${method} ${url} failed: ${(cause as Error)?.message ?? cause}`,
            );
        if (attempt < attempts - 1) {
          await sleep(this.#backoffMs(attempt));
          continue;
        }
        throw lastError;
      }

      this.#noteRateLimit(response);
      if (response.ok) return response;

      if (init.retry && RETRY_STATUSES.has(response.status) && attempt < attempts - 1) {
        const delay = this.#backoffMs(attempt, response);
        // Drain, or the socket is held until GC.
        await response.arrayBuffer().catch(() => {});
        await sleep(delay);
        continue;
      }

      throw errorFromResponse(response.status, await safeJson(response), response.headers);
    }

    throw lastError ?? new MagnusConnectionError("request failed");
  }

  // -------------------------------------------------------------------- health

  /**
   * Reachability probe — `GET /api/health/simple`, no key needed.
   *
   * Run this first when a setup is not working: it separates "wrong base URL"
   * from "bad key", which otherwise both surface as a failure on the first
   * chat call.
   */
  async health(): Promise<{ status: string; timestamp?: string; version?: unknown }> {
    const response = await this.#request("GET", "/api/health/simple", { retry: true });
    return ((await safeJson(response)) ?? {}) as { status: string };
  }

  // -------------------------------------------------------------------- models

  /** Agents (personas) this key can reach — `GET /v1/models`. */
  async listAgents(): Promise<Agent[]> {
    const response = await this.#request("GET", "/v1/models", { retry: true });
    const data = (await safeJson(response)) as { data?: Agent[] } | null;
    return data?.data ?? [];
  }

  /** One agent by id, or `null` if it does not exist for this key. */
  async getAgent(agentId: string): Promise<Agent | null> {
    try {
      const response = await this.#request(
        "GET",
        `/v1/models/${encodeURIComponent(agentId)}`,
        { retry: true },
      );
      return (await safeJson(response)) as Agent;
    } catch (error) {
      // 404 here means "no such persona", which is an answer, not a failure.
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  // ---------------------------------------------------------------------- chat

  #payload(
    agentId: string,
    messages: ChatMessage[],
    options: ChatOptions & { stream?: boolean; includeUsage?: boolean },
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = { model: agentId, messages };
    const user = options.user ?? this.user;
    if (user !== undefined) payload.user = user;
    if (options.sessionId !== undefined) {
      requireUuid(options.sessionId);
      payload.session_id = options.sessionId;
    }
    if (options.stream) {
      payload.stream = true;
      if (options.includeUsage) payload.stream_options = { include_usage: true };
    }
    if (options.extraBody) Object.assign(payload, options.extraBody);
    return payload;
  }

  /**
   * Run one turn and return the whole OpenAI-shaped response.
   *
   * `choices[0].message.content` is the answer; `magnus.session_id` is the
   * conversation to carry into the next turn.
   */
  async chat(
    agentId: string,
    messages: ChatMessage[],
    options: ChatOptions = {},
  ): Promise<ChatResponse> {
    const response = await this.#request("POST", "/v1/chat/completions", {
      body: this.#payload(agentId, messages, options),
      headers: options.idempotencyKey
        ? { "Idempotency-Key": options.idempotencyKey }
        : undefined,
      // Without an Idempotency-Key a retry runs the pipeline a second time.
      retry: Boolean(options.idempotencyKey),
    });
    return ((await safeJson(response)) ?? {}) as ChatResponse;
  }

  /**
   * Run one turn, delivered as it is generated.
   *
   * `for await (const delta of stream)` yields text; when it ends, `.text`,
   * `.usage`, `.sessionId` and `.magnus` hold what a buffered call returns.
   *
   * No `idempotencyKey`: a streamed body cannot be replayed, so the server
   * releases the key and a retry re-runs the turn. Use {@link chat} when a turn
   * must not run twice.
   */
  async streamChat(
    agentId: string,
    messages: ChatMessage[],
    options: StreamOptions & { onFinish?: (stream: ChatStream) => void } = {},
  ): Promise<ChatStream> {
    const response = await this.#request("POST", "/v1/chat/completions", {
      body: this.#payload(agentId, messages, { ...options, stream: true }),
      stream: true,
      // A stream has no idempotency key, so a retry would silently run the
      // turn a second time.
      retry: false,
    });
    if (!response.body) {
      throw new MagnusConnectionError("Magnus returned a streamed response with no body.");
    }
    return new ChatStream(iterSSE(response.body), options.onFinish);
  }

  /**
   * One user message in, the answer's text out.
   *
   * `history` is accepted for OpenAI-shaped call sites, but it does not restore
   * a thread — the server reads only the last user message. Use
   * {@link conversation} for continuity.
   */
  async sendMessage(
    agentId: string,
    content: Content,
    options: ChatOptions & { history?: ChatMessage[] } = {},
  ): Promise<string> {
    const messages: ChatMessage[] = [
      ...(options.history ?? []),
      { role: "user", content },
    ];
    const response = await this.chat(agentId, messages, options);
    return firstText(response);
  }

  /**
   * One page of `GET /v1/conversations/updates`.
   *
   * The replies a person from the team wrote to `user` in the dashboard after
   * the message `after` (or within the last 24 hours), and `handoff`: whether a
   * person owns the conversation now. A chat turn cannot carry these — they are
   * written while the end user is not asking anything. Prefer
   * {@link Conversation.updates} and {@link Conversation.follow}, which keep the
   * cursor.
   */
  async conversationUpdates(
    agentId: string,
    options: { user?: string; after?: string } = {},
  ): Promise<ConversationUpdates> {
    const params = new URLSearchParams({ model: agentId });
    const user = options.user ?? this.user;
    if (user !== undefined) params.set("user", user);
    if (options.after !== undefined) params.set("after", options.after);
    const response = await this.#request("GET", `/v1/conversations/updates?${params}`, {
      retry: true,
    });
    const body = (await safeJson(response)) as Partial<ConversationUpdates> | null;
    return {
      object: "list",
      handoff: body?.handoff === true,
      data: body?.data ?? [],
      has_more: body?.has_more === true,
    };
  }

  /**
   * Open a thread with an agent for one end user.
   *
   * Prefer this over {@link sendMessage} with `history`: the server keeps
   * memory server-side and reads only the last user message. A thread is the
   * end user, not resent history: there is one live thread per (API key,
   * `user`, agent), and it ends after 30 idle minutes. Pass `user`, or everyone
   * calling through the key shares one thread.
   *
   * The conversation sends back the `session_id` the server reports, but the
   * server does not let a session id select, resume or reset a thread.
   */
  conversation(
    agentId: string,
    options: { user?: string; sessionId?: string } = {},
  ): Conversation {
    return new Conversation(this, agentId, options.user ?? this.user, options.sessionId);
  }
}

/**
 * A thread with an agent for one end user.
 *
 * The server reads only the last user message and keeps the conversation's
 * memory and state server-side. The thread is (API key, `user`, agent), not
 * the history a client resends; `sessionId` reports which session the server
 * ran on.
 */
export class Conversation {
  sessionId: string | null;
  sessionSource: string | null = null;
  lastTraceId: string | null = null;
  lastTurnId: string | null = null;
  lastUsage: Usage | null = null;
  lastUsageSource: string | null = null;
  /** True while a person from the team owns the conversation (see `MagnusExtensions.handoff`). */
  handoff = false;
  /**
   * The id of the last reply from the team that `updates()` returned. An app
   * that must not show a reply twice across restarts stores it and sets it back
   * on a new conversation.
   */
  lastUpdateId: string | null = null;

  readonly agentId: string;
  #client: MagnusClient;
  #user?: string;

  constructor(
    client: MagnusClient,
    agentId: string,
    user?: string,
    sessionId?: string,
  ) {
    if (sessionId !== undefined) requireUuid(sessionId);
    this.#client = client;
    this.agentId = agentId;
    this.#user = user;
    this.sessionId = sessionId ?? null;
  }

  /** Run one turn and return the answer's text. */
  async send(content: Content, options: { idempotencyKey?: string } = {}): Promise<string> {
    const response = await this.#client.chat(
      this.agentId,
      [{ role: "user", content }],
      {
        user: this.#user,
        sessionId: this.sessionId ?? undefined,
        idempotencyKey: options.idempotencyKey,
      },
    );
    this.#adopt(response.magnus, response.session_id, response.usage);
    return firstText(response);
  }

  /**
   * Run one turn, delivered as it is generated.
   *
   * The session is adopted when the stream finishes — including when it throws,
   * since a turn that failed mid-stream still ran and still moved the
   * conversation.
   */
  async stream(content: Content, options: { includeUsage?: boolean } = {}): Promise<ChatStream> {
    return this.#client.streamChat(this.agentId, [{ role: "user", content }], {
      user: this.#user,
      sessionId: this.sessionId ?? undefined,
      includeUsage: options.includeUsage,
      onFinish: (stream) => {
        this.#adopt(stream.magnus, stream.sessionId ?? undefined, stream.usage ?? undefined);
      },
    });
  }

  /**
   * The replies a person from the team wrote since the last call, oldest first.
   *
   * The operator is never named (`author` is always "human"). Also refreshes
   * `handoff`. The first call, with no `lastUpdateId`, returns the last 24 hours.
   */
  async updates(): Promise<OperatorMessage[]> {
    const messages: OperatorMessage[] = [];
    for (;;) {
      const page = await this.#client.conversationUpdates(this.agentId, {
        user: this.#user,
        after: this.lastUpdateId ?? undefined,
      });
      messages.push(...page.data);
      const last = page.data.at(-1);
      if (last) this.lastUpdateId = last.id;
      this.handoff = page.handoff;
      if (!page.has_more || !page.data.length) return messages;
    }
  }

  /**
   * Yield the team's replies as they arrive, while a person is in charge.
   *
   * Polls `updates()` every `intervalMs` and ends once the conversation is back
   * with the agent (`handoff` false) — so it ends at once when nobody had taken
   * over. Pass a `signal` to stop it earlier.
   */
  async *follow(
    options: { intervalMs?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<OperatorMessage> {
    const interval = options.intervalMs ?? 5000;
    for (;;) {
      if (options.signal?.aborted) return;
      for (const message of await this.updates()) yield message;
      if (!this.handoff || options.signal?.aborted) return;
      await sleep(interval);
    }
  }

  /**
   * Forget the session id this object holds.
   *
   * The server still continues the end user's live thread: a new thread starts
   * after 30 idle minutes, or with a different `user`.
   */
  reset(): void {
    this.sessionId = null;
    this.sessionSource = null;
  }

  #adopt(
    magnus: Partial<import("./types.ts").MagnusExtensions> | undefined,
    fallbackSessionId: string | undefined,
    usage: Usage | undefined | null,
  ): void {
    // The pipeline may roll the session mid-turn (persona, user or org change),
    // so the id the server says it ran on wins over the one sent.
    this.sessionId = magnus?.session_id ?? fallbackSessionId ?? this.sessionId;
    this.sessionSource = magnus?.session_source ?? this.sessionSource;
    this.lastTraceId = magnus?.trace_id ?? null;
    this.lastTurnId = magnus?.turn_id ?? null;
    this.lastUsageSource = magnus?.usage_source ?? null;
    // A server older than the field omits it: that is not a handoff.
    this.handoff = magnus?.handoff === true;
    if (usage) this.lastUsage = usage;
  }
}

// ----------------------------------------------------------------------- helpers

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: a proxy error page, or HTML from the wrong host. Handing the
    // text back lets the error carry a readable slice of it.
    return text;
  }
}

function requireUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new TypeError(
      `sessionId must be a UUID, got ${JSON.stringify(value)}. Magnus rejects ` +
        `anything else with a 400 rather than silently starting a new conversation.`,
    );
  }
}

function firstText(response: ChatResponse): string {
  const choice = response.choices?.[0];
  if (!choice) throw new MagnusConnectionError("Magnus returned no choices for this turn.");
  return choice.message?.content ?? "";
}
