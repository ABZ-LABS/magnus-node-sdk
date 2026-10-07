/**
 * Magnus Node SDK — talk to Magnus agents over the `/v1` API.
 *
 * ```ts
 * import { MagnusClient } from "iamagnus";
 *
 * const client = new MagnusClient({ baseUrl: "https://app.iamagnus.com", apiKey: "magnus_sys_..." });
 * const [agent] = await client.listAgents();
 *
 * // A thread. The session id — not resent history — is what continues it.
 * const chat = client.conversation(agent.id, { user: "jane@company.com" });
 * console.log(await chat.send("Hi, what can you do?"));
 * console.log(await chat.send("And the price?"));
 *
 * // Streamed
 * for await (const delta of await chat.stream("Tell me more")) process.stdout.write(delta);
 * ```
 *
 * Authentication is a System API Key or User API Key from the Magnus dashboard,
 * sent as `Authorization: Bearer <key>` (or `X-API-Key` via `authScheme`).
 */
export { MagnusClient, Conversation, VERSION, DEFAULT_TIMEOUT_MS } from "./client.ts";
export type { MagnusClientOptions, ChatOptions, StreamOptions } from "./client.ts";
export { ChatStream, iterSSE } from "./stream.ts";
export type { StreamChunk } from "./stream.ts";
export type {
  Agent,
  ChatMessage,
  ChatResponse,
  Content,
  ContentPart,
  ConversationUpdates,
  ImagePart,
  MagnusExtensions,
  OperatorMessage,
  TextPart,
  Usage,
} from "./types.ts";
export {
  AuthenticationError,
  ConflictError,
  InvalidRequestError,
  MagnusAPIError,
  MagnusConnectionError,
  MagnusError,
  MagnusTimeoutError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  ServerError,
  StreamError,
  UnsupportedParameterError,
  errorFromResponse,
} from "./errors.ts";
