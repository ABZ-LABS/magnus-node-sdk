import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { StreamError } from "../src/index.ts";
import { useMagnus } from "./helpers.ts";

const ctx = useMagnus();

async function drain(stream: AsyncIterable<string>): Promise<string[]> {
  const pieces: string[] = [];
  for await (const piece of stream) pieces.push(piece);
  return pieces;
}

describe("streaming", () => {
  it("delivers deltas one by one", async () => {
    ctx.magnus().reply = "Hola que tal";
    const stream = await ctx.client().streamChat("magnus_standard", [
      { role: "user", content: "hi" },
    ]);
    assert.deepEqual(await drain(stream), ["Hola", " que", " tal"]);
  });

  it("exposes the whole text once the stream ends", async () => {
    ctx.magnus().reply = "Hola que tal";
    const stream = await ctx.client().streamChat("magnus_standard", [
      { role: "user", content: "hi" },
    ]);
    await drain(stream);
    assert.equal(stream.text, "Hola que tal");
    assert.equal(stream.finishReason, "stop");
  });

  it("still delivers a turn the server sent whole", async () => {
    // The server may deliver a turn whole; it then comes as one delta, not zero.
    ctx.magnus().streamMode = "single";
    ctx.magnus().reply = "Respuesta entera";
    const stream = await ctx.client().streamChat("magnus_standard", [
      { role: "user", content: "hi" },
    ]);
    assert.deepEqual(await drain(stream), ["Respuesta entera"]);
    assert.equal(stream.text, "Respuesta entera");
  });

  it("merges extensions from whichever chunk carries them", async () => {
    // Live path puts them on the closing chunk, buffered path on the first.
    for (const mode of ["tokens", "single"] as const) {
      ctx.magnus().streamMode = mode;
      const stream = await ctx.client().streamChat("magnus_standard", [
        { role: "user", content: "hi" },
      ]);
      await drain(stream);
      assert.ok(stream.sessionId, `no session id in ${mode} mode`);
      assert.ok(["new", "explicit"].includes(stream.magnus.session_source!));
      assert.equal(stream.magnus.usage_source, "measured");
    }
  });

  it("collect() drains and returns the text", async () => {
    ctx.magnus().reply = "Todo junto";
    const stream = await ctx.client().streamChat("magnus_standard", [
      { role: "user", content: "hi" },
    ]);
    assert.equal(await stream.collect(), "Todo junto");
  });

  it("withholds usage unless asked for", async () => {
    const stream = await ctx.client().streamChat("magnus_standard", [
      { role: "user", content: "hi" },
    ]);
    await drain(stream);
    assert.equal(stream.usage, null);
  });

  it("yields a final usage chunk when includeUsage is set", async () => {
    ctx.magnus().usage = { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 };
    const stream = await ctx.client().streamChat(
      "magnus_standard", [{ role: "user", content: "hi" }], { includeUsage: true },
    );
    await drain(stream);
    assert.deepEqual(stream.usage, ctx.magnus().usage);
  });

  it("asks for usage in the documented shape", async () => {
    await ctx.client().streamChat(
      "magnus_standard", [{ role: "user", content: "hi" }], { includeUsage: true },
    );
    const body = ctx.magnus().requests.at(-1)!.body;
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
  });

  it("reassembles a frame split across chunk boundaries", async () => {
    // A read can land in the middle of a JSON body. Splitting on whatever each
    // read happens to contain is the classic way to lose a turn's last token.
    const { iterSSE, ChatStream } = await import("../src/index.ts");
    const frames = [
      'data: {"choices":[{"index":0,"delta":{"content":"Ho',
      'la"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,',
      '"delta":{"content":" mundo"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
        controller.close();
      },
    });
    const stream = new ChatStream(iterSSE(body));
    assert.deepEqual(await drain(stream), ["Hola", " mundo"]);
  });
});

describe("a failure that looks like success", () => {
  // The status line went out as 200 before the turn failed. A client that reads
  // only `delta.content` hands back a truncated answer as though it were the
  // real one. This is the whole reason the stream is parsed rather than
  // concatenated.

  it("throws on a mid-stream error", async () => {
    ctx.magnus().streamMode = "error";
    const stream = await ctx.client().streamChat("magnus_standard", [
      { role: "user", content: "hi" },
    ]);
    await assert.rejects(() => drain(stream), StreamError);
  });

  it("carries the server envelope onto the thrown error", async () => {
    ctx.magnus().streamMode = "error";
    ctx.magnus().streamError = {
      message: "El agente no pudo completar el turno.",
      type: "server_error", param: null, code: "pipeline_failed",
    };
    const stream = await ctx.client().streamChat("magnus_standard", [
      { role: "user", content: "hi" },
    ]);
    await assert.rejects(() => drain(stream), (error: StreamError) => {
      assert.equal(error.code, "pipeline_failed");
      assert.equal(error.type, "server_error");
      assert.match(error.serverMessage, /no pudo completar/);
      return true;
    });
  });

  it("keeps what the reader already saw", async () => {
    // Contradicting bytes already delivered is worse than truncating.
    ctx.magnus().streamMode = "error";
    ctx.magnus().reply = "Hola mundo";
    const stream = await ctx.client().streamChat("magnus_standard", [
      { role: "user", content: "hi" },
    ]);
    const seen: string[] = [];
    await assert.rejects(
      async () => {
        for await (const piece of stream) seen.push(piece);
      },
      (error: StreamError) => {
        assert.equal(seen.join(""), error.partialText);
        assert.equal(error.partialText, "Hola ");
        return true;
      },
    );
  });
});
