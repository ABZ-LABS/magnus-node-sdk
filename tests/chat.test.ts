import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { InvalidRequestError, UnsupportedParameterError } from "../src/index.ts";
import { useMagnus } from "./helpers.ts";

const ctx = useMagnus();

describe("chat", () => {
  it("returns the full OpenAI-shaped response", async () => {
    ctx.magnus().reply = "Buenas.";
    const res = await ctx.client().chat("magnus_standard", [
      { role: "user", content: "Hola" },
    ]);
    assert.equal(res.choices[0]!.message.content, "Buenas.");
    assert.equal(res.object, "chat.completion");
  });

  it("sendMessage returns only the text", async () => {
    ctx.magnus().reply = "Listo.";
    assert.equal(await ctx.client().sendMessage("magnus_standard", "Hola"), "Listo.");
  });

  it("sends the user field for multi-tenant attribution", async () => {
    ctx.client().user = "juan@empresa.com";
    await ctx.client().sendMessage("magnus_standard", "Hola");
    assert.equal(ctx.magnus().requests.at(-1)!.body.user, "juan@empresa.com");
  });

  it("lets a per-call user override the client default", async () => {
    ctx.client().user = "default@x.com";
    await ctx.client().sendMessage("magnus_standard", "Hola", { user: "otro@x.com" });
    assert.equal(ctx.magnus().requests.at(-1)!.body.user, "otro@x.com");
  });

  it("passes multimodal content through untouched", async () => {
    // The server flattens the text parts; the client must not mangle them first.
    const content = [
      { type: "text" as const, text: "¿Qué es esto?" },
      { type: "image_url" as const, image_url: { url: "https://x/y.png" } },
    ];
    await ctx.client().sendMessage("magnus_standard", content);
    assert.deepEqual(ctx.magnus().requests.at(-1)!.body.messages.at(-1).content, content);
  });

  it("carries the usage block to the caller", async () => {
    ctx.magnus().usage = { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 };
    const res = await ctx.client().chat("magnus_standard", [
      { role: "user", content: "Hola" },
    ]);
    assert.equal(res.usage!.total_tokens, 7);
  });

  it("reports whether the tokens are real or a heuristic", async () => {
    // `estimated` is a character count — nobody should bill on it unknowingly.
    ctx.magnus().usageSource = "estimated";
    const res = await ctx.client().chat("magnus_standard", [
      { role: "user", content: "Hola" },
    ]);
    assert.equal(res.magnus!.usage_source, "estimated");
  });

  it("forwards extraBody for server fields newer than this SDK", async () => {
    await ctx.client().chat(
      "magnus_standard",
      [{ role: "user", content: "Hola" }],
      { extraBody: { some_new_field: 42 } },
    );
    assert.equal(ctx.magnus().requests.at(-1)!.body.some_new_field, 42);
  });
});

describe("parameters Magnus refuses", () => {
  // Magnus refuses these rather than ignoring them; the SDK must say which.
  for (const [param, value] of [
    ["tools", [{ type: "function", function: { name: "f" } }]],
    ["tool_choice", "auto"],
    ["functions", [{ name: "f" }]],
    ["function_call", "auto"],
    ["response_format", { type: "json_object" }],
  ] as const) {
    it(`names ${param} when the server refuses it`, async () => {
      await assert.rejects(
        () => ctx.client().chat(
          "magnus_standard",
          [{ role: "user", content: "Hola" }],
          { extraBody: { [param]: value } },
        ),
        (error: UnsupportedParameterError) => {
          assert.ok(error instanceof UnsupportedParameterError);
          assert.ok(error instanceof InvalidRequestError);
          assert.equal(error.param, param);
          assert.equal(error.code, "unsupported_parameter");
          return true;
        },
      );
    });
  }

  it("refuses n > 1", async () => {
    await assert.rejects(
      () => ctx.client().chat(
        "magnus_standard", [{ role: "user", content: "Hola" }], { extraBody: { n: 3 } },
      ),
      (error: UnsupportedParameterError) => {
        assert.equal(error.param, "n");
        return true;
      },
    );
  });

  it("accepts empty values of the same parameters", async () => {
    // `{"tools": []}` says nothing, so refusing it would break clients for free.
    for (const extraBody of [{ n: 1 }, { tools: [] }, { response_format: {} }]) {
      const res = await ctx.client().chat(
        "magnus_standard", [{ role: "user", content: "Hola" }], { extraBody },
      );
      assert.ok(res.choices[0]!.message.content);
    }
  });

  it("makes an image-only turn a typed 400", async () => {
    await assert.rejects(
      () => ctx.client().chat("magnus_standard", [{
        role: "user",
        content: [{ type: "image_url" as const, image_url: { url: "x" } }],
      }]),
      (error: InvalidRequestError) => {
        assert.equal(error.status, 400);
        assert.equal(error.param, "messages");
        return true;
      },
    );
  });
});

describe("session ids", () => {
  it("sends a session id when given one", async () => {
    const sid = randomUUID();
    await ctx.client().chat(
      "magnus_standard", [{ role: "user", content: "Hola" }], { sessionId: sid },
    );
    assert.equal(ctx.magnus().requests.at(-1)!.body.session_id, sid);
  });

  it("refuses a non-UUID before the round trip", async () => {
    // The server 400s on this; failing locally names the caller's own bug.
    await assert.rejects(
      () => ctx.client().chat(
        "magnus_standard", [{ role: "user", content: "Hola" }], { sessionId: "not-a-uuid" },
      ),
      TypeError,
    );
    assert.equal(ctx.magnus().requests.length, 0);
  });
});
