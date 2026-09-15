# Magnus SDK for Node.js

The official Node.js and TypeScript client for
**[Magnus Core](https://core.iamagnus.com)**: governed AI agents behind an
OpenAI-compatible API. The model understands and writes; rules decide what
happens, anything irreversible gets confirmed first, and every turn leaves a
trace.

```bash
npm install iamagnus
```

Node 20+. No runtime dependencies. ESM, with types included.

```ts
import { MagnusClient } from "iamagnus";

const client = new MagnusClient({
  baseUrl: "https://api.iamagnus.com",
  apiKey: "magnus_sys_...",
});

const [agent] = await client.listAgents();

// A thread: the session id continues it, not resent history.
const chat = client.conversation(agent.id, { user: "jane@company.com" });

console.log(await chat.send("Hi, what can you do?"));
console.log(await chat.send("And the price?"));
```

## Getting an API key

1. In the Magnus dashboard, open **Configuration → System API Keys**.
2. Create a key with a descriptive name and the `api_generic` channel. The
   channel is stamped on every turn the key runs, so prefer one key per
   integration over one shared key.
3. **Copy it right away.** Magnus stores only a hash and shows the key once.

Keys start with `magnus_sys_`.

> **Not to be confused with "LLM API Keys".** That screen holds *your* OpenAI,
> Anthropic or other provider credentials, so that Magnus can call models on your
> behalf. They do not authenticate you against Magnus; using one here gives a
> 401.

## Pointing the client at a deployment

The base URL is configuration, not a constant: nothing about `iamagnus.com` is
built into the library. Pass the **server root**, without `/v1` — the client
builds `/v1/...` itself, plus `/api/health/simple`, which lives outside that
prefix.

```ts
const hosted = new MagnusClient({ baseUrl: "https://api.iamagnus.com", apiKey: "magnus_sys_..." });
const local  = new MagnusClient({ baseUrl: "http://localhost:5001",    apiKey: "magnus_sys_..." });

// In a deployment, read both from the environment:
const client = new MagnusClient({
  baseUrl: process.env.MAGNUS_BASE_URL!,
  apiKey: process.env.MAGNUS_API_KEY!,
});
```

A trailing slash is trimmed, and an empty URL fails at construction rather than
as an unreadable transport error.

### Checking the URL and the key separately

```ts
await client.health();      // no key involved: proves the URL is right
await client.listAgents();  // uses the key: proves the credential
```

If `health()` works and `listAgents()` throws a 401, the key is the problem, not
the URL — and the other way round.

## Three things that are not OpenAI

**History is not state.** The server reads only the last user message and keeps
the conversation's memory and state server-side. Resending history does not
restore a thread — a session id does. Use `conversation()`; without one,
continuity falls back to a time window and is lost silently when it expires.

**The agent owns the turn.** `tools`, `tool_choice`, `functions`,
`function_call`, `response_format` and `n > 1` are *refused*, not ignored: tools
are configured per agent and the response format is the agent's decision.
`temperature`, `max_tokens`, `top_p`, `stop`, `seed` and `presence_penalty` are
accepted and ignored — the agent owns them too.

**A streamed turn can fail after HTTP 200.** Once the first chunk is out the
status line cannot be taken back, so a failure arrives *inside* the stream. This
client throws a `StreamError` rather than handing back a truncated answer as a
success.

## Streaming

```ts
const stream = await chat.stream("Tell me more");

for await (const delta of stream) {
  process.stdout.write(delta);
}

console.log(stream.text, stream.sessionId, stream.magnus.usage_source);
```

`await stream.collect()` drains it in one call. Two shapes are normal and both
are handled: token by token, and a single delta for a turn the server delivers
whole. `{ includeUsage: true }` adds the final chunk carrying `stream.usage`.

A turn that fails mid-stream throws out of the loop:

```ts
import { StreamError } from "iamagnus";

try {
  for await (const delta of stream) process.stdout.write(delta);
} catch (error) {
  if (error instanceof StreamError) {
    // error.partialText is what the reader already saw
    console.error(error.code, error.serverMessage);
  }
}
```

## Errors

Every failure carries the server's error envelope:

```ts
import { AuthenticationError, RateLimitError, UnsupportedParameterError } from "iamagnus";

try {
  await client.chat(agentId, messages);
} catch (error) {
  if (error instanceof RateLimitError) await sleep((error.retryAfter ?? 5) * 1000);
  else if (error instanceof UnsupportedParameterError) console.error(`refused: ${error.param}`);
  else if (error instanceof AuthenticationError) throw new Error("bad API key");
}
```

| Class | Status |
|---|---|
| `InvalidRequestError` | 400 |
| `UnsupportedParameterError` | 400, `code: unsupported_parameter` (extends the above) |
| `AuthenticationError` | 401 |
| `PermissionDeniedError` | 403 |
| `NotFoundError` | 404 |
| `ConflictError` | 409, a turn with this `Idempotency-Key` is still running |
| `RateLimitError` | 429, see `.retryAfter` |
| `ServerError` | 5xx |
| `MagnusConnectionError` / `MagnusTimeoutError` | never reached Magnus, or gave up waiting |
| `StreamError` | the turn failed after the stream opened |

All extend `MagnusError`. `.status`, `.type`, `.code`, `.param`, `.headers` and
`.serverMessage` carry the server's own words.

## Retries and idempotency

A turn advances the conversation and can run tools with side effects, so
retrying one blindly can duplicate them. This client therefore retries:

- **GET** always, on 429/5xx and transport failures;
- **POST** only when you passed an `idempotencyKey`, because the server then
  replays its first response instead of running the turn again;
- **never a stream** — a streamed body cannot be replayed.

`Retry-After` is honoured; otherwise the backoff is exponential with jitter.

```ts
await client.chat(agentId, messages, { idempotencyKey: crypto.randomUUID() });
```

## Metering

`response.usage` holds real provider token counts when
`response.magnus.usage_source === "measured"`. `"estimated"` means the turn never
reached an LLM and the numbers are a `len/4` heuristic. **Do not bill on an
estimate.**

`client.rateLimitRemaining` tracks the last seen budget for the key.

## Multi-tenancy

`{ user: "jane@company.com" }` on the client, the conversation, or a single call.
It sets the OpenAI `user` field, which Magnus uses to attribute the turn to an
end user inside the API key's organization.

## Verifying a deployment

`magnus-livecheck` runs the fourteen checks in [CONTRACT.md](CONTRACT.md)
against a real deployment and exits non-zero unless all of them pass:

```bash
export MAGNUS_BASE_URL=https://api.iamagnus.com
export MAGNUS_API_KEY=magnus_sys_...
export MAGNUS_AGENT=magnus_standard   # optional: defaults to the first agent listed

npx magnus-livecheck
```

Checks 5, 8, 9, 10 and 13 run real turns, which cost tokens and are recorded
like any other conversation — point it at a test agent with `--agent`.

## API

| | |
|---|---|
| `new MagnusClient({ baseUrl, apiKey, user?, timeout?, maxRetries?, authScheme? })` | |
| `health()` | unauthenticated reachability probe |
| `listAgents()` / `getAgent(id)` | agents; an unknown id is `null` |
| `chat(agent, messages, opts?)` | one buffered turn |
| `streamChat(agent, messages, opts?)` | one streamed turn |
| `sendMessage(agent, content, opts?)` | text in, text out |
| `conversation(agent, { user?, sessionId? })` | a thread: `.send()`, `.stream()`, `.reset()` |

`opts.extraBody` forwards server fields newer than this library. Every wire
detail is in [CONTRACT.md](CONTRACT.md).

## Development

```bash
npm install
npm run verify   # typecheck + tests
```

The suite runs against a fake Magnus that implements [CONTRACT.md](CONTRACT.md)
over real sockets, so SSE framing and chunk boundaries are exercised for real.
Running the TypeScript tests directly needs Node 22.18 or later. Releases are
described in [RELEASING.md](RELEASING.md).

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution.
