import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AuthenticationError, MagnusClient } from "../src/index.ts";
import { MockMagnus } from "./mock-magnus.ts";
import { useMagnus } from "./helpers.ts";

const ctx = useMagnus();

describe("models", () => {
  it("lists the agents the key can reach", async () => {
    const agents = await ctx.client().listAgents();
    assert.deepEqual(agents.map((a) => a.id), ctx.magnus().agents);
    assert.equal(agents[0]!.object, "model");
    assert.equal(agents[0]!.owned_by, "magnus");
  });

  it("retrieves one agent", async () => {
    assert.equal((await ctx.client().getAgent("porteria"))?.id, "porteria");
  });

  it("treats magnus as an alias for magnus_standard", async () => {
    assert.equal((await ctx.client().getAgent("magnus"))?.id, "magnus_standard");
  });

  it("returns null for an unknown agent rather than throwing", async () => {
    // 404 here means "no such persona", which is an answer, not a failure.
    assert.equal(await ctx.client().getAgent("no_such_agent"), null);
  });

  it("escapes an agent id containing a slash", async () => {
    await ctx.client().getAgent("weird/id");
    assert.equal(ctx.magnus().requests.at(-1)!.path, "/v1/models/weird%2Fid");
  });
});

describe("authentication", () => {
  it("rejects a request with no key", async () => {
    const client = new MagnusClient({
      baseUrl: ctx.magnus().url, apiKey: "", maxRetries: 0,
    });
    await assert.rejects(() => client.listAgents(), AuthenticationError);
  });

  it("sends the key as a bearer token by default", async () => {
    await ctx.client().listAgents();
    assert.equal(
      ctx.magnus().requests.at(-1)!.headers.authorization,
      "Bearer magnus_test_key",
    );
  });

  it("can send the key as X-API-Key instead", async () => {
    // Both are accepted by the server; a proxy may strip one or the other.
    const client = new MagnusClient({
      baseUrl: ctx.magnus().url, apiKey: "k", authScheme: "x-api-key", maxRetries: 0,
    });
    await client.listAgents();
    const headers = ctx.magnus().requests.at(-1)!.headers;
    assert.equal(headers["x-api-key"], "k");
    assert.equal(headers.authorization, undefined);
  });

  it("refuses an unknown auth scheme at construction", () => {
    assert.throws(
      () => new MagnusClient({
        baseUrl: "http://x", apiKey: "k", authScheme: "basic" as never,
      }),
      TypeError,
    );
  });

  it("distinguishes a wrong key from a missing one", async () => {
    ctx.magnus().apiKey = "the_right_key";
    const client = new MagnusClient({
      baseUrl: ctx.magnus().url, apiKey: "wrong", maxRetries: 0,
    });
    await assert.rejects(() => client.listAgents(), (error: AuthenticationError) => {
      assert.equal(error.status, 401);
      assert.equal(error.code, "invalid_api_key");
      return true;
    });
  });
});

describe("health", () => {
  it("needs no key", async () => {
    const client = new MagnusClient({
      baseUrl: ctx.magnus().url, apiKey: "", maxRetries: 0,
    });
    assert.equal((await client.health()).status, "ok");
  });

  it("lives outside the /v1 prefix", async () => {
    await ctx.client().health();
    assert.equal(ctx.magnus().requests.at(-1)!.path, "/api/health/simple");
  });
});

describe("base URL", () => {
  // The base URL is configuration, not a constant. The SDK is pointed at
  // production, staging or a local server by its caller; nothing about
  // iamagnus.com is baked into the client.

  it("sends requests to the configured host", async () => {
    const client = ctx.client();
    assert.equal(client.baseUrl, ctx.magnus().url);
    assert.ok((await client.listAgents()).length > 0);
    assert.ok(ctx.magnus().requests.length > 0);
  });

  it("trims a trailing slash", async () => {
    // The most common way to end up requesting //v1/models.
    const client = new MagnusClient({
      baseUrl: `${ctx.magnus().url}/`, apiKey: "k", maxRetries: 0,
    });
    await client.listAgents();
    assert.equal(ctx.magnus().requests.at(-1)!.path, "/v1/models");
  });

  it("refuses an empty base URL at construction", () => {
    assert.throws(() => new MagnusClient({ baseUrl: "", apiKey: "k" }), TypeError);
  });

  it("accepts the positional (url, key) form too", async () => {
    const client = new MagnusClient(ctx.magnus().url, "k");
    assert.equal(client.baseUrl, ctx.magnus().url);
    assert.ok((await client.listAgents()).length > 0);
  });

  it("lets two clients point at different deployments", async () => {
    // Staging and production side by side is a normal thing to want.
    const other = await MockMagnus.start();
    other.agents = ["solo_en_el_otro"];
    try {
      const a = new MagnusClient({ baseUrl: ctx.magnus().url, apiKey: "k", maxRetries: 0 });
      const b = new MagnusClient({ baseUrl: other.url, apiKey: "k", maxRetries: 0 });
      assert.deepEqual((await b.listAgents()).map((x) => x.id), ["solo_en_el_otro"]);
      assert.deepEqual((await a.listAgents()).map((x) => x.id), ctx.magnus().agents);
    } finally {
      await other.close();
    }
  });
});
