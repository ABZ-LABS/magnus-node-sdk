# Magnus SDK for Node.js

**English** · [Español](README.es.md)

The official Node.js and TypeScript client for
**[Magnus Core](https://core.iamagnus.com)**: governed AI agents behind an
OpenAI-compatible API. The model understands and writes; the agent's rules
decide what happens and which actions wait for a confirmation, and every turn
leaves a trace.

```bash
npm install iamagnus
```

Node 20+. No runtime dependencies. ESM, with types included. If
`npm install iamagnus` fails, the same package installs straight from GitHub:
see [Installing without the npm registry](#installing-without-the-npm-registry).

```ts
import { MagnusClient } from "iamagnus";

const client = new MagnusClient({
  baseUrl: "https://app.iamagnus.com",
  apiKey: "magnus_sys_...",
});

const [agent] = await client.listAgents();

// One thread per end user: `user` continues it, not resent history.
const chat = client.conversation(agent.id, { user: "jane@company.com" });

console.log(await chat.send("Hi, what can you do?"));
console.log(await chat.send("And the price?"));
```

## Installing without the npm registry

Use this when the package is not on npm, or the machine cannot reach it. The
code is the same and so is the import, `import { MagnusClient } from "iamagnus"`.

**From GitHub.** npm fetches a tag of this repository and compiles it on
install. It needs `git` on the machine:

```bash
npm install github:ABZ-LABS/magnus-node-sdk#v0.2.0
```

which leaves this in `package.json`:

```json
"dependencies": {
  "iamagnus": "github:ABZ-LABS/magnus-node-sdk#v0.2.0"
}
```

Pin a tag, as above, so every install gets the same code. `#main` follows the
latest commit, which is not a release. Compiling on install pulls TypeScript
from the npm registry for a moment; if the registry is out of reach entirely,
use a tarball.

**Without network access to GitHub or npm** (a closed CI, a customer's
network). Build the tarball once on a machine that has access, and ship the
file with the project:

```bash
git clone --branch v0.2.0 https://github.com/ABZ-LABS/magnus-node-sdk
cd magnus-node-sdk && npm ci && npm pack
# iamagnus-0.2.0.tgz goes into the project, e.g. under vendor/

npm install ./vendor/iamagnus-0.2.0.tgz
```

The tarball is complete: the library has no runtime dependencies.

## Getting an API key

1. In the Magnus dashboard, open **System API Keys**, under *Integration keys*
   in the sidebar. Organization admins see it.
2. **Create key**, and choose **which agent should answer**. A key is created
   for one agent and always answers as that agent: `listAgents()` returns exactly
   that one, and naming another agent of your organization is refused with
   `model_not_allowed`. Keys for your own agents need a paid plan; the sample
   agents are open on every plan.
3. Under **What will use this key?**, keep **My app or backend**. That choice is
   stamped on every turn the key runs, so prefer one key per integration over
   one shared key.
4. **Copy it right away.** Magnus stores only a hash and shows the key once.

Keys start with `magnus_sys_` (`magnus_gpt_` for a key made for a chat client
such as OpenWebUI).

> **Not to be confused with "LLM API Keys".** That screen holds *your* OpenAI,
> Anthropic or other provider credentials, so that Magnus can call models on your
> behalf. They do not authenticate you against Magnus; using one here gives a
> 401.

## Pointing the client at a deployment

The base URL is configuration, not a constant: nothing about `iamagnus.com` is
built into the library. The hosted service is `https://app.iamagnus.com`, the
same address as the dashboard. Pass the **server root**, without `/v1` — the
client builds `/v1/...` itself, plus `/api/health/simple`, which lives outside
that prefix.

```ts
const hosted = new MagnusClient({ baseUrl: "https://app.iamagnus.com", apiKey: "magnus_sys_..." });
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

## What is different from OpenAI

**The key picks the agent.** `model` does not choose who answers; the key's
agent does. Naming another agent of the organization is refused
(`model_not_allowed`), and any other value, such as `gpt-4o`, is ignored, so an
OpenAI client works unchanged.

**A thread is the end user, not the history.** The server reads only the last
user message and keeps the conversation's memory and state server-side, so
resending history restores nothing. There is one live thread per (API key,
`user`, agent): the same `user` continues it, and it ends after 30 idle
minutes. **Always pass `user`**: without it, everyone calling through the key
shares one thread. Each response reports the session the server ran on, but
sending a session id back cannot select, resume or reset a thread.

**The agent owns the turn.** `tools`, `tool_choice`, `functions`,
`function_call`, `response_format` and `n > 1` are *refused*, not ignored: tools
are configured per agent and the response format is the agent's decision.
`temperature`, `max_tokens`, `top_p`, `stop`, `seed` and `presence_penalty` are
accepted and ignored — the agent owns them too. Some OpenAI clients send
`tool_choice: "auto"` or `response_format: {"type": "text"}` by default; those
count as set and are refused, so strip them.

**Some limits answer 200.** When an end user, the organization or its plan runs
out of turns, the turn returns HTTP 200 with a sentence instead of an answer,
`usage_source: "estimated"` and no trace id, not a 429. The list is in
[CONTRACT.md](CONTRACT.md#limits-that-answer-200).

**A person can take over.** When the agent hands a conversation to someone on
your team, or they take it from the dashboard, the agent stops answering until
the team hands it back. Every turn still returns 200 — first the agent's
hand-off message, then a fixed notice — and `chat.handoff` is `true` for as
long as a person is in charge. What the person writes is not the answer to any
turn, so this client fetches it — something an OpenAI client cannot do:

```ts
await chat.send("I want to talk to someone");
if (chat.handoff) {
  // Polls every 5 s and ends when the agent is back; author is always "human".
  for await (const message of chat.follow()) show(message.content);
}
```

`chat.updates()` returns what is new without waiting, for your own loop, and
`follow({ signal })` stops on an `AbortSignal`. To avoid showing a reply twice
across restarts, store `chat.lastUpdateId` and set it back on the new
conversation.

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
| `InvalidRequestError` | 400, including `code: model_not_allowed` (the key belongs to another agent) |
| `UnsupportedParameterError` | 400, `code: unsupported_parameter` (extends the above) |
| `AuthenticationError` | 401 |
| `PermissionDeniedError` | 403, the key's organization is missing or deactivated |
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

Use a fresh UUID for each turn: the server matches the key across the whole
organization for 24 hours, without looking at the body or the end user.

## Metering

`response.usage` holds real provider token counts when
`response.magnus.usage_source === "measured"`. `"estimated"` means the turn never
reached an LLM, which includes the limits that answer 200, and the numbers are a
`len/4` heuristic. **Do not bill on an estimate.**

`client.rateLimitRemaining` tracks the last seen budget for the key.

## Multi-tenancy

`{ user: "jane@company.com" }` on the client, the conversation, or a single call.
It sets the OpenAI `user` field, and it is what keeps your end users apart:
each value is one person, with their own thread and memory, and a call without
it lands in the one thread shared by everyone on the key. The part before an
`@` becomes the name the agent sees. Values are scoped to the key, so a new or
rotated key starts every person over.

## Verifying a deployment

`magnus-livecheck` runs the fifteen checks in [CONTRACT.md](CONTRACT.md)
against a real deployment and exits non-zero unless all of them pass:

```bash
export MAGNUS_BASE_URL=https://app.iamagnus.com
export MAGNUS_API_KEY=magnus_sys_...   # a key created for a test agent

npx magnus-livecheck
```

Checks 5, 8, 9, 10 and 13 run real turns, which cost tokens and are recorded
like any other conversation. A key answers only as its own agent, so create the
key for a test agent.

## API

| | |
|---|---|
| `new MagnusClient({ baseUrl, apiKey, user?, timeout?, maxRetries?, authScheme? })` | |
| `health()` | unauthenticated reachability probe |
| `listAgents()` / `getAgent(id)` | agents; an unknown id is `null` |
| `chat(agent, messages, opts?)` | one buffered turn |
| `streamChat(agent, messages, opts?)` | one streamed turn |
| `sendMessage(agent, content, opts?)` | text in, text out |
| `conversation(agent, { user?, sessionId? })` | a thread for one end user: `.send()`, `.stream()`, `.reset()`; after each turn `.lastTraceId`, `.lastUsageSource` and `.handoff`; the team's replies with `.updates()` and `.follow({ intervalMs?, signal? })` |
| `conversationUpdates(agent, { user?, after? })` | one page of the team's replies, raw |

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
