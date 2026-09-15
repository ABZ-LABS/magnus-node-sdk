import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { StreamError } from "../src/index.ts";
import { useMagnus } from "./helpers.ts";

const ctx = useMagnus();

describe("conversation", () => {
  it("opens a session on the first turn", async () => {
    const chat = ctx.client().conversation("magnus_standard");
    assert.equal(chat.sessionId, null);
    await chat.send("Hola");
    assert.ok(chat.sessionId);
    assert.equal(chat.sessionSource, "new");
  });

  it("carries the session forward on later turns", async () => {
    const chat = ctx.client().conversation("magnus_standard");
    await chat.send("Hola");
    const first = chat.sessionId;
    await chat.send("¿Y el precio?");
    assert.equal(ctx.magnus().requests.at(-1)!.body.session_id, first);
  });

  it("adopts the session the server ran on, not the one sent", async () => {
    // The pipeline rolls the session on persona/user/org change mid-turn.
    // Echoing the request value back would pin the thread to a conversation the
    // server has already abandoned.
    const chat = ctx.client().conversation("magnus_standard");
    await chat.send("Hola");
    const rolled = randomUUID();
    ctx.magnus().rolledSessionId = rolled;
    await chat.send("Otra cosa");
    assert.equal(chat.sessionId, rolled);
  });

  it("exposes correlation ids for joining against traces", async () => {
    ctx.magnus().traceId = "trace-42";
    ctx.magnus().turnId = "turn-42";
    const chat = ctx.client().conversation("magnus_standard");
    await chat.send("Hola");
    assert.equal(chat.lastTraceId, "trace-42");
    assert.equal(chat.lastTurnId, "turn-42");
  });

  it("keeps usage and its provenance per turn", async () => {
    ctx.magnus().usageSource = "estimated";
    ctx.magnus().usage = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 };
    const chat = ctx.client().conversation("magnus_standard");
    await chat.send("Hola");
    assert.equal(chat.lastUsage!.total_tokens, 3);
    assert.equal(chat.lastUsageSource, "estimated");
  });

  it("starts a new conversation after reset()", async () => {
    const chat = ctx.client().conversation("magnus_standard");
    await chat.send("Hola");
    chat.reset();
    await chat.send("Empecemos de nuevo");
    assert.equal(ctx.magnus().requests.at(-1)!.body.session_id, undefined);
  });

  it("inherits the client's user", async () => {
    ctx.client().user = "juan@empresa.com";
    await ctx.client().conversation("magnus_standard").send("Hola");
    assert.equal(ctx.magnus().requests.at(-1)!.body.user, "juan@empresa.com");
  });

  it("can resume a known session", async () => {
    const sid = randomUUID();
    await ctx.client().conversation("magnus_standard", { sessionId: sid }).send("Seguimos");
    assert.equal(ctx.magnus().requests.at(-1)!.body.session_id, sid);
  });

  it("refuses to resume with a non-UUID", () => {
    assert.throws(
      () => ctx.client().conversation("magnus_standard", { sessionId: "nope" }),
      TypeError,
    );
  });
});

describe("conversation streaming", () => {
  it("advances the session on a streamed turn", async () => {
    const chat = ctx.client().conversation("magnus_standard");
    const stream = await chat.stream("Hola");
    await stream.collect();
    assert.ok(chat.sessionId);
    assert.equal(chat.sessionId, stream.sessionId);
  });

  it("keeps the session when a streamed turn fails", async () => {
    // It ran. Dropping the session would silently fork the thread.
    const chat = ctx.client().conversation("magnus_standard");
    await chat.send("Hola");
    const known = chat.sessionId;
    ctx.magnus().streamMode = "error";
    const stream = await chat.stream("Y esto");
    await assert.rejects(() => stream.collect(), StreamError);
    assert.equal(chat.sessionId, known);
  });
});
