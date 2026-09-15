import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AuthenticationError,
  ConflictError,
  InvalidRequestError,
  MagnusAPIError,
  MagnusClient,
  MagnusConnectionError,
  NotFoundError,
  RateLimitError,
  ServerError,
  UnsupportedParameterError,
  errorFromResponse,
} from "../src/index.ts";
import { useMagnus } from "./helpers.ts";

const ctx = useMagnus();

function envelope(
  message: string,
  extra: { type?: string; param?: string | null; code?: string | null } = {},
) {
  return {
    error: {
      message,
      type: extra.type ?? "invalid_request_error",
      param: extra.param ?? null,
      code: extra.code ?? null,
    },
  };
}

const RATE_LIMITED = envelope("Rate limit reached for this API key.", {
  type: "rate_limit_error", code: "rate_limit_exceeded",
});

describe("error mapping", () => {
  // The error envelope is the SDK's most-used surface after `.send()`. Losing
  // it turns "you sent a parameter Magnus refuses" and "your key expired" into
  // the same string.
  for (const [status, Expected] of [
    [400, InvalidRequestError],
    [401, AuthenticationError],
    [404, NotFoundError],
    [409, ConflictError],
    [429, RateLimitError],
    [500, ServerError],
    [503, ServerError],
    [418, MagnusAPIError],
  ] as const) {
    it(`maps ${status} to ${Expected.name}`, () => {
      const error = errorFromResponse(status, envelope("x"));
      assert.equal(error.constructor, Expected);
      assert.equal(error.status, status);
    });
  }

  it("lets unsupported_parameter beat the status mapping", () => {
    const error = errorFromResponse(
      400, envelope("no", { param: "tools", code: "unsupported_parameter" }),
    );
    assert.ok(error instanceof UnsupportedParameterError);
    assert.equal(error.param, "tools");
  });

  it("keeps every envelope field", () => {
    const error = errorFromResponse(400, envelope("bad", { param: "n", code: "c" }));
    assert.equal(error.serverMessage, "bad");
    assert.equal(error.type, "invalid_request_error");
    assert.equal(error.param, "n");
    assert.equal(error.code, "c");
  });

  it("reads Retry-After as a number", () => {
    assert.equal(errorFromResponse(429, RATE_LIMITED, { "Retry-After": "12" }).retryAfter, 12);
  });

  it("returns null rather than crashing on a missing Retry-After", () => {
    assert.equal(errorFromResponse(429, RATE_LIMITED).retryAfter, null);
  });

  it("returns null rather than crashing on a date-form Retry-After", () => {
    assert.equal(
      errorFromResponse(429, RATE_LIMITED, { "Retry-After": "Wed, 21 Oct" }).retryAfter,
      null,
    );
  });

  it("keeps a readable slice of a non-envelope body", () => {
    // A proxy error page, or HTML from the wrong host. "502" alone locates nothing.
    const error = errorFromResponse(502, "<html>nginx bad gateway</html>");
    assert.match(error.message, /nginx/);
  });

  it("still produces a message for an empty body", () => {
    assert.match(errorFromResponse(504, null).message, /504/);
  });

  it("leads its string form with what to act on", () => {
    const error = errorFromResponse(
      400, envelope("no tools", { param: "tools", code: "unsupported_parameter" }),
    );
    assert.match(error.message, /400/);
    assert.match(error.message, /unsupported_parameter/);
    assert.match(error.message, /tools/);
  });

  it("reports a dead host as a connection error, not a stack trace", async () => {
    // Port 1 on loopback: nothing listens, and it fails fast.
    const client = new MagnusClient({
      baseUrl: "http://127.0.0.1:1", apiKey: "k", maxRetries: 0, timeout: 2000,
    });
    await assert.rejects(() => client.health(), (error: MagnusConnectionError) => {
      assert.ok(error instanceof MagnusConnectionError);
      assert.match(error.message, /127\.0\.0\.1:1/);
      return true;
    });
  });
});

describe("idempotency", () => {
  it("sends the key as a header", async () => {
    await ctx.client().chat(
      "magnus_standard", [{ role: "user", content: "Hola" }], { idempotencyKey: "key-1" },
    );
    assert.equal(ctx.magnus().requests.at(-1)!.headers["idempotency-key"], "key-1");
  });

  it("replays instead of running a second turn", async () => {
    // A turn advances the conversation and can run tools; running it twice is a bug.
    const messages = [{ role: "user" as const, content: "Hola" }];
    const first = await ctx.client().chat("magnus_standard", messages, {
      idempotencyKey: "key-1",
    });
    const second = await ctx.client().chat("magnus_standard", messages, {
      idempotencyKey: "key-1",
    });
    assert.deepEqual(first, second);
    assert.equal(ctx.magnus().turnsRun, 1);
  });

  it("reports an in-flight turn as a conflict, not a retry", async () => {
    ctx.magnus().idempotency.set("key-1", "IN_FLIGHT");
    await assert.rejects(
      () => ctx.client().chat(
        "magnus_standard", [{ role: "user", content: "Hola" }], { idempotencyKey: "key-1" },
      ),
      (error: ConflictError) => {
        assert.equal(error.status, 409);
        assert.equal(error.code, "request_in_progress");
        return true;
      },
    );
  });

  it("reserves nothing without a key", async () => {
    await ctx.client().chat("magnus_standard", [{ role: "user", content: "Hola" }]);
    assert.equal(ctx.magnus().requests.at(-1)!.headers["idempotency-key"], undefined);
  });
});

describe("retries", () => {
  const retrying = () => new MagnusClient({
    baseUrl: ctx.magnus().url, apiKey: "k", maxRetries: 2, timeout: 10_000,
  });

  it("retries a GET through a 429", async () => {
    ctx.magnus().force(429, RATE_LIMITED, { "Retry-After": "0" });
    assert.ok((await retrying().listAgents()).length > 0);
  });

  it("gives up with the typed error", async () => {
    for (let i = 0; i < 3; i++) ctx.magnus().force(429, RATE_LIMITED, { "Retry-After": "0" });
    await assert.rejects(() => retrying().listAgents(), (error: RateLimitError) => {
      assert.equal(error.status, 429);
      assert.equal(error.code, "rate_limit_exceeded");
      return true;
    });
  });

  it("never retries a bare POST", async () => {
    // Without an Idempotency-Key a retry runs the pipeline a second time.
    ctx.magnus().force(503, envelope("upstream down", { type: "server_error" }));
    await assert.rejects(
      () => retrying().chat("magnus_standard", [{ role: "user", content: "Hola" }]),
      ServerError,
    );
    assert.equal(ctx.magnus().requests.filter((r) => r.method === "POST").length, 1);
  });

  it("retries a POST that carries an idempotency key", async () => {
    // Safe: the server replays rather than re-running.
    ctx.magnus().force(503, envelope("upstream down", { type: "server_error" }));
    const res = await retrying().chat(
      "magnus_standard", [{ role: "user", content: "Hola" }], { idempotencyKey: "key-1" },
    );
    assert.ok(res.choices[0]!.message.content);
    assert.equal(ctx.magnus().requests.filter((r) => r.method === "POST").length, 2);
  });

  it("does not retry a 4xx", async () => {
    ctx.magnus().force(400, envelope("bad", { param: "messages" }));
    await assert.rejects(() => retrying().listAgents(), InvalidRequestError);
    assert.equal(ctx.magnus().requests.filter((r) => r.path === "/v1/models").length, 1);
  });

  it("never retries a stream", async () => {
    // It has no idempotency key, so a retry silently runs the turn again.
    ctx.magnus().force(503, envelope("down", { type: "server_error" }));
    await assert.rejects(
      () => retrying().streamChat("magnus_standard", [{ role: "user", content: "Hola" }]),
      ServerError,
    );
    assert.equal(ctx.magnus().requests.filter((r) => r.method === "POST").length, 1);
  });
});

describe("rate-limit budget", () => {
  it("is tracked off every response", async () => {
    ctx.magnus().rateLimitRemaining = 42;
    const client = ctx.client();
    await client.chat("magnus_standard", [{ role: "user", content: "Hola" }]);
    assert.equal(client.rateLimitRemaining, 42);
    assert.equal(client.rateLimitReset, ctx.magnus().rateLimitReset);
  });
});
