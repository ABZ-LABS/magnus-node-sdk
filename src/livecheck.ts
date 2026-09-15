#!/usr/bin/env node
/**
 * End-to-end check: run the CONTRACT.md checklist against a real Magnus.
 *
 *     MAGNUS_BASE_URL=https://... MAGNUS_API_KEY=magnus_... npx magnus-livecheck
 *
 * Exits 0 only when every check passes. Checks 5, 8, 9, 10 and 13 run real
 * turns against the target agent - they cost tokens and are recorded like any
 * other conversation.
 */
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { MagnusClient, VERSION } from "./client.ts";
import { MagnusError, UnsupportedParameterError } from "./errors.ts";

// Written as an escape rather than a literal so the source stays plain ASCII.
const ESC = "\u001b";
const GREEN = `${ESC}[32m`;
const RED = `${ESC}[31m`;
const YELLOW = `${ESC}[33m`;
const DIM = `${ESC}[2m`;
const RESET = `${ESC}[0m`;

export interface LivecheckOptions {
  baseUrl: string;
  apiKey: string;
  agent?: string;
  prompt?: string;
  timeout?: number;
  color?: boolean;
  log?: (line: string) => void;
}

interface Check {
  number: number;
  name: string;
  /** Returns a problem description, or null when the check passed. */
  run: () => Promise<string | null>;
}

export async function livecheck(options: LivecheckOptions): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const paint = options.color === false
    ? (text: string, _color: string) => text
    : (text: string, color: string) => `${color}${text}${RESET}`;

  const prompt = options.prompt ?? "Hi, what can you do?";
  const client = new MagnusClient({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    timeout: options.timeout ?? 90_000,
    maxRetries: 1,
  });

  const state: Record<string, any> = { agentId: options.agent };

  const checks: Check[] = [
    { number: 1, name: "health probe answers", run: async () => {
      const body = await client.health();
      return body.status === "ok"
        ? null
        : `health said ${JSON.stringify(body.status)}, expected "ok"`;
    } },
    { number: 2, name: "the key can list agents", run: async () => {
      const agents = await client.listAgents();
      if (agents.length === 0) {
        return "no agents visible to this key (wrong org, or none configured)";
      }
      const ids = agents.map((a) => a.id);
      if (!state.agentId) state.agentId = ids[0];
      else if (!ids.includes(state.agentId)) {
        return `agent "${state.agentId}" is not in this key's list: ${ids.join(", ")}`;
      }
      return null;
    } },
    { number: 3, name: "a single agent can be retrieved", run: async () => {
      const agent = await client.getAgent(state.agentId);
      return agent?.id === state.agentId
        ? null
        : `GET /v1/models/${state.agentId} did not return that agent`;
    } },
    { number: 4, name: "an unknown agent is absent, not an error", run: async () => {
      const found = await client.getAgent(`no_such_agent_${randomUUID().slice(0, 8)}`);
      return found === null ? null : "an invented model id came back as if it existed";
    } },
    { number: 5, name: "a buffered turn returns text", run: async () => {
      state.response = await client.chat(state.agentId, [{ role: "user", content: prompt }]);
      const text = state.response.choices?.[0]?.message?.content;
      if (!text) return "the turn returned no text";
      state.text = text;
      return null;
    } },
    { number: 6, name: "the magnus extensions survive", run: async () => {
      const magnus = state.response.magnus ?? {};
      if (!magnus.session_id) return "response carried no magnus.session_id";
      if (!magnus.session_source) return "response carried no magnus.session_source";
      return null;
    } },
    { number: 7, name: "usage is reported with its provenance", run: async () => {
      const usage = state.response.usage ?? {};
      if (!usage.total_tokens) {
        return `usage.total_tokens was ${JSON.stringify(usage.total_tokens)}`;
      }
      const source = state.response.magnus?.usage_source;
      if (source !== "measured" && source !== "estimated") {
        return `magnus.usage_source was ${JSON.stringify(source)}`;
      }
      state.usageSource = source;
      return null;
    } },
    { number: 8, name: "a conversation keeps its session", run: async () => {
      const chat = client.conversation(state.agentId);
      await chat.send(prompt);
      const first = chat.sessionId;
      if (!first) return "the first turn produced no session id";
      await chat.send("¿Y algo más?");
      if (!chat.sessionId) return "the session was lost on the second turn";
      state.continuity = `${first.slice(0, 8)}... -> ${chat.sessionId.slice(0, 8)}...`;
      return null;
    } },
    { number: 9, name: "a streamed turn parses and closes", run: async () => {
      const stream = await client.streamChat(
        state.agentId, [{ role: "user", content: prompt }],
      );
      let pieces = 0;
      for await (const _ of stream) pieces += 1;
      if (!stream.text) return "the streamed turn produced no text";
      if (!stream.sessionId) return "the stream carried no session id";
      state.streamShape = pieces > 1 ? "token by token" : "single delta";
      return null;
    } },
    { number: 10, name: "include_usage reports usage", run: async () => {
      const stream = await client.streamChat(
        state.agentId, [{ role: "user", content: prompt }], { includeUsage: true },
      );
      await stream.collect();
      return stream.usage?.total_tokens
        ? null
        : `include_usage produced ${JSON.stringify(stream.usage)}`;
    } },
    { number: 11, name: "'tools' is refused by name", run: async () => {
      // Sent via extraBody: this check is about the *server's* refusal, and the
      // typed surface deliberately has no way to pass `tools`.
      try {
        await client.chat(state.agentId, [{ role: "user", content: prompt }], {
          extraBody: {
            tools: [{ type: "function", function: { name: "f", parameters: {} } }],
          },
        });
      } catch (error) {
        if (error instanceof UnsupportedParameterError) {
          return error.param === "tools"
            ? null
            : `refused, but named param=${JSON.stringify(error.param)} instead of "tools"`;
        }
        if (error instanceof MagnusError) {
          return `expected an unsupported_parameter error, got ${error.message}`;
        }
        throw error;
      }
      return "the server accepted 'tools', which it is documented to refuse";
    } },
    { number: 12, name: "a non-UUID session_id is refused locally", run: async () => {
      try {
        await client.chat(
          state.agentId, [{ role: "user", content: prompt }], { sessionId: "not-a-uuid" },
        );
      } catch (error) {
        if (error instanceof TypeError) return null;
        throw error;
      }
      return "a non-UUID sessionId was not refused";
    } },
    { number: 13, name: "one idempotency key runs one turn", run: async () => {
      const key = `livecheck-${randomUUID()}`;
      const messages = [{ role: "user" as const, content: prompt }];
      const first = await client.chat(state.agentId, messages, { idempotencyKey: key });
      const second = await client.chat(state.agentId, messages, { idempotencyKey: key });
      return first.id === second.id
        ? null
        : `the same Idempotency-Key ran two turns (${first.id} vs ${second.id})`;
    } },
    { number: 14, name: "the rate-limit budget is observable", run: async () => {
      if (client.rateLimitRemaining === null) {
        return "no X-RateLimit-Remaining header was seen on any response";
      }
      state.budget = client.rateLimitRemaining;
      return null;
    } },
  ];

  log(`magnus-node-sdk ${VERSION} -> ${options.baseUrl}`);
  log(paint("checks 5, 8, 9, 10 and 13 run real turns and cost tokens.\n", YELLOW));

  const failures: Array<[Check, string]> = [];
  for (const check of checks) {
    const started = Date.now();
    let problem: string | null;
    try {
      problem = await check.run();
    } catch (error) {
      // A bug in the SDK is also a failed check.
      problem = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    const elapsed = `${Date.now() - started}ms`;
    const mark = problem === null ? paint("PASS", GREEN) : paint("FAIL", RED);
    log(`  ${mark} ${String(check.number).padStart(2)}. ${check.name} ${paint(elapsed, DIM)}`);
    if (problem !== null) {
      failures.push([check, problem]);
      log(`        ${paint(problem, RED)}`);
    }
  }

  log("");
  if (state.agentId) log(`  agent          ${state.agentId}`);
  if (state.streamShape) log(`  stream shape   ${state.streamShape}`);
  if (state.usageSource) {
    const note = state.usageSource === "measured"
      ? ""
      : "  (character heuristic - do not bill on this)";
    log(`  usage source   ${state.usageSource}${note}`);
  }
  if (state.continuity) log(`  session        ${state.continuity}`);
  if (state.budget !== undefined) log(`  budget left    ${state.budget}`);
  log("");

  if (failures.length > 0) {
    log(paint(`${failures.length} of ${checks.length} checks failed - this deployment does not meet the contract.`, RED));
    return 1;
  }
  log(paint(`all ${checks.length} checks passed - this deployment meets the contract.`, GREEN));
  return 0;
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const baseUrl = (args["base-url"] as string) ?? process.env.MAGNUS_BASE_URL;
  const apiKey = (args["api-key"] as string) ?? process.env.MAGNUS_API_KEY;

  if (!baseUrl || !apiKey) {
    console.error(
      "magnus-livecheck: MAGNUS_BASE_URL and MAGNUS_API_KEY are required " +
        "(or pass --base-url / --api-key).",
    );
    return 2;
  }

  return livecheck({
    baseUrl,
    apiKey,
    agent: (args.agent as string) ?? process.env.MAGNUS_AGENT,
    prompt: args.prompt as string | undefined,
    timeout: args.timeout ? Number(args.timeout) : undefined,
    color: !args["no-color"],
  });
}

// Run when invoked directly, not when imported by the test suite. npm installs
// the `magnus-livecheck` bin as a symlink under another name, so the entry
// point is compared by real path rather than by file name.
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().then((code) => process.exit(code));
}
