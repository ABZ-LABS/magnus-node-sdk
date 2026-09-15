/**
 * SSE parsing for streamed turns.
 *
 * Magnus streams an OpenAI-shaped `text/event-stream`. Two things about it are
 * not OpenAI's and are the reason this is a module and not four lines inline:
 *
 * - the Magnus extensions (`session_id`, `magnus`) ride on whichever chunk
 *   carries them — the first content chunk when the turn was buffered, the
 *   closing chunk when it streamed — so they are merged as they arrive rather
 *   than read from a fixed position;
 * - a turn that fails after the stream opened reports it *inside* the stream,
 *   with HTTP 200 already sent. That chunk is the difference between a
 *   truncated answer and a thrown error.
 */
import { StreamError } from "./errors.ts";
import type { MagnusExtensions, Usage } from "./types.ts";

export interface StreamChunk {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index?: number;
    delta?: { role?: string; content?: string };
    finish_reason?: string | null;
  }>;
  usage?: Usage;
  session_id?: string;
  magnus?: Partial<MagnusExtensions>;
  error?: { message?: string; type?: string | null; param?: string | null; code?: string | null };
}

/**
 * Split a byte stream into SSE `data:` payloads.
 *
 * A chunk boundary can land anywhere, including the middle of a JSON body, so
 * the buffer is carried across reads. Splitting on whatever each read happens
 * to contain is the classic way to lose the last token of a turn.
 */
export async function* iterSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, unknown> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line || line.startsWith(":")) continue;
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        yield payload;
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:")) {
      const payload = tail.slice(5).trim();
      if (payload && payload !== "[DONE]") yield payload;
    }
  } finally {
    reader.releaseLock();
    // Cancelling is what tells the server to stop generating when a caller
    // breaks out of the loop early.
    await body.cancel().catch(() => {});
  }
}

/**
 * A turn arriving as it is generated.
 *
 * `for await (const delta of stream)` yields text deltas. Once iteration
 * finishes, the whole turn is on the fields below — the same values a buffered
 * response carries.
 */
export class ChatStream implements AsyncIterable<string> {
  text = "";
  usage: Usage | null = null;
  sessionId: string | null = null;
  magnus: Partial<MagnusExtensions> = {};
  id: string | null = null;
  model: string | null = null;
  finishReason: string | null = null;
  readonly chunks: StreamChunk[] = [];

  #payloads: AsyncIterable<string>;
  #onFinish?: (stream: ChatStream) => void;
  #finished = false;

  constructor(payloads: AsyncIterable<string>, onFinish?: (stream: ChatStream) => void) {
    this.#payloads = payloads;
    this.#onFinish = onFinish;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string, void, unknown> {
    try {
      for await (const payload of this.#payloads) {
        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(payload) as StreamChunk;
        } catch {
          // A frame we cannot parse is not worth failing a turn over, but
          // silently dropping it would hide a server-side format change.
          continue;
        }
        if (!chunk || typeof chunk !== "object") continue;
        this.chunks.push(chunk);

        this.id = chunk.id ?? this.id;
        this.model = chunk.model ?? this.model;

        // Extensions can be on any chunk; merge, never overwrite with nothing.
        if (chunk.session_id) this.sessionId = chunk.session_id;
        if (chunk.magnus && typeof chunk.magnus === "object") {
          Object.assign(this.magnus, chunk.magnus);
          if (chunk.magnus.session_id) this.sessionId = chunk.magnus.session_id;
        }
        if (chunk.usage) this.usage = chunk.usage;

        // A turn that failed after the stream opened. Thrown, not returned:
        // the alternative is handing back a truncated answer as a success.
        if (chunk.error && typeof chunk.error === "object") {
          throw new StreamError(chunk.error.message ?? "The turn failed mid-stream.", {
            type: chunk.error.type,
            code: chunk.error.code,
            param: chunk.error.param,
            partialText: this.text,
          });
        }

        for (const choice of chunk.choices ?? []) {
          if (!choice || typeof choice !== "object") continue;
          if (choice.finish_reason) this.finishReason = choice.finish_reason;
          const piece = choice.delta?.content;
          if (piece) {
            this.text += piece;
            yield piece;
          }
        }
      }
    } finally {
      this.#finish();
    }
  }

  /** Consume the whole turn and return its text. */
  async collect(): Promise<string> {
    for await (const _ of this) {
      // drained for its side effects
    }
    return this.text;
  }

  #finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#onFinish?.(this);
  }
}
