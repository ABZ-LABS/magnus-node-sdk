import { after, before, beforeEach } from "node:test";

import { MagnusClient } from "../src/index.ts";
import { MockMagnus } from "./mock-magnus.ts";

/**
 * One mock server per test file, reset between tests.
 *
 * Starting a server per test costs more than it buys: `reset()` clears
 * everything a test can set, and the recorded requests are per-test either way.
 */
export function useMagnus(): { magnus: () => MockMagnus; client: () => MagnusClient } {
  let server: MockMagnus;
  let client: MagnusClient;

  before(async () => {
    server = await MockMagnus.start();
  });

  beforeEach(() => {
    server.reset();
    // No retries by default: a test that wants them asks, and the rest fail
    // fast instead of sleeping through a backoff.
    client = new MagnusClient({
      baseUrl: server.url,
      apiKey: "magnus_test_key",
      maxRetries: 0,
      timeout: 10_000,
    });
  });

  after(async () => {
    await server.close();
  });

  return { magnus: () => server, client: () => client };
}
