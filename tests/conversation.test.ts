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

// A person from the team can take a conversation over from the agent. The server
// keeps answering 200 — the agent's hand-off, then a fixed notice — so without
// the flag a caller cannot tell a person is in charge.
describe("conversation handoff", () => {
  it("starts with the agent", async () => {
    const chat = ctx.client().conversation("magnus_standard");
    await chat.send("Hola");
    assert.equal(chat.handoff, false);
  });

  it("follows the server turn by turn", async () => {
    const chat = ctx.client().conversation("magnus_standard");
    ctx.magnus().handoff = true;
    await chat.send("Quiero hablar con una persona");
    assert.equal(chat.handoff, true);
    ctx.magnus().handoff = false;
    await chat.send("Hola de nuevo");
    assert.equal(chat.handoff, false);
  });

  it("is reported by a streamed turn too", async () => {
    ctx.magnus().handoff = true;
    const chat = ctx.client().conversation("magnus_standard");
    const stream = await chat.stream("Hola");
    await stream.collect();
    assert.equal(chat.handoff, true);
  });

  it("is false when the server does not send the field", async () => {
    ctx.magnus().handoff = null;
    const chat = ctx.client().conversation("magnus_standard");
    await chat.send("Hola");
    assert.equal(chat.handoff, false);
  });
});

// A person from the team answers in the dashboard while the end user is not
// asking anything, so no chat turn can carry the reply: the SDK fetches it.
function operatorMessage(content: string) {
  return { id: randomUUID(), object: "conversation.message", author: "human", content, created: 1767225600 };
}

describe("the team's replies", () => {
  it("updates() returns the replies and the handoff", async () => {
    ctx.magnus().handoff = true;
    ctx.magnus().operatorMessages = [operatorMessage("Hola, soy del equipo")];
    const chat = ctx.client().conversation("magnus_standard", { user: "jane@company.com" });

    const replies = await chat.updates();

    assert.deepEqual(replies.map((r) => r.content), ["Hola, soy del equipo"]);
    assert.equal(replies[0].author, "human");
    assert.equal(chat.handoff, true);
    const request = ctx.magnus().requests.at(-1)!;
    assert.equal(request.method, "GET");
    assert.match(request.path, /user=jane%40company\.com/);
    assert.match(request.path, /model=magnus_standard/);
  });

  it("brings only what is new on a second call", async () => {
    ctx.magnus().handoff = true;
    ctx.magnus().operatorMessages = [operatorMessage("uno")];
    const chat = ctx.client().conversation("magnus_standard");
    await chat.updates();
    const first = chat.lastUpdateId;
    ctx.magnus().operatorMessages.push(operatorMessage("dos"));

    assert.deepEqual((await chat.updates()).map((r) => r.content), ["dos"]);
    assert.match(ctx.magnus().requests.at(-1)!.path, new RegExp(`after=${first}`));
  });

  it("follows pages to the end", async () => {
    ctx.magnus().updatesPage = 2;
    ctx.magnus().operatorMessages = ["m0", "m1", "m2", "m3", "m4"].map(operatorMessage);
    const chat = ctx.client().conversation("magnus_standard");

    assert.deepEqual((await chat.updates()).map((r) => r.content), ["m0", "m1", "m2", "m3", "m4"]);
  });

  it("follow() yields as replies arrive and ends with the handoff", async () => {
    ctx.magnus().handoff = true;
    const script = [["uno"], ["dos", "tres"], []];
    ctx.magnus().beforeUpdates = (server) => {
      const next = script.shift();
      if (next) server.operatorMessages.push(...next.map(operatorMessage));
      else server.handoff = false;
    };
    const chat = ctx.client().conversation("magnus_standard");

    const seen: string[] = [];
    for await (const message of chat.follow({ intervalMs: 0 })) seen.push(message.content);

    assert.deepEqual(seen, ["uno", "dos", "tres"]);
    assert.equal(chat.handoff, false);
  });

  it("follow() ends at once when nobody took over", async () => {
    const chat = ctx.client().conversation("magnus_standard");
    const seen: unknown[] = [];
    for await (const message of chat.follow({ intervalMs: 0 })) seen.push(message);

    assert.deepEqual(seen, []);
    assert.equal(ctx.magnus().requests.length, 1);
  });

  it("resumes from a stored cursor without repeats", async () => {
    ctx.magnus().operatorMessages = [operatorMessage("visto"), operatorMessage("nuevo")];
    const chat = ctx.client().conversation("magnus_standard");
    chat.lastUpdateId = ctx.magnus().operatorMessages[0].id;

    assert.deepEqual((await chat.updates()).map((r) => r.content), ["nuevo"]);
  });
});
