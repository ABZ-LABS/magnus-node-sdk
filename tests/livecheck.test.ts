/**
 * The livecheck, checked.
 *
 * A livecheck that passes because it silently skipped half its checks is worse
 * than no livecheck, so it is run end to end against the contract mock.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import { livecheck } from "../src/livecheck.ts";
import { useMagnus } from "./helpers.ts";

const ctx = useMagnus();

function capture() {
  const lines: string[] = [];
  return { log: (line: string) => lines.push(line), text: () => lines.join("\n") };
}

describe("livecheck", () => {
  it("passes cleanly against a conforming server", async () => {
    const out = capture();
    const code = await livecheck({
      baseUrl: ctx.magnus().url, apiKey: "k", color: false, log: out.log,
    });
    assert.equal(code, 0, out.text());
    assert.match(out.text(), /all 14 checks passed/);
    assert.doesNotMatch(out.text(), /FAIL/);
  });

  it("actually runs every check", async () => {
    const out = capture();
    await livecheck({ baseUrl: ctx.magnus().url, apiKey: "k", color: false, log: out.log });
    for (let n = 1; n <= 14; n++) {
      assert.match(out.text(), new RegExp(`\\s${n}\\. `), `check ${n} never ran`);
    }
  });

  it("fails the gate on a bad key", async () => {
    ctx.magnus().apiKey = "the_right_key";
    const out = capture();
    const code = await livecheck({
      baseUrl: ctx.magnus().url, apiKey: "wrong_key", color: false, log: out.log,
    });
    assert.equal(code, 1);
    assert.match(out.text(), /does not meet the contract/);
  });

  it("fails the gate on a dead host without crashing", async () => {
    const out = capture();
    const code = await livecheck({
      baseUrl: "http://127.0.0.1:1", apiKey: "k", color: false, log: out.log, timeout: 2000,
    });
    assert.equal(code, 1);
    assert.match(out.text(), /FAIL/);
  });

  it("names an agent that is outside the key's list", async () => {
    const out = capture();
    const code = await livecheck({
      baseUrl: ctx.magnus().url, apiKey: "k", agent: "no_such_agent",
      color: false, log: out.log,
    });
    assert.equal(code, 1);
    assert.match(out.text(), /no_such_agent/);
  });

  it("fails check 11 if the server stops refusing tools", async () => {
    // The check must fail loudly if the server drops a documented refusal.
    ctx.magnus().unsupportedParams = [];
    const out = capture();
    const code = await livecheck({
      baseUrl: ctx.magnus().url, apiKey: "k", color: false, log: out.log,
    });
    assert.equal(code, 1);
    assert.match(out.text(), /documented to refuse/);
  });

  it("calls out an estimated usage source", async () => {
    // `estimated` is a character heuristic; the report should say so.
    ctx.magnus().usageSource = "estimated";
    const out = capture();
    await livecheck({ baseUrl: ctx.magnus().url, apiKey: "k", color: false, log: out.log });
    assert.match(out.text(), /do not bill on this/);
  });
  it("runs when started through a symlinked bin", () => {
    // npm installs `magnus-livecheck` as a symlink under another name. Without
    // credentials the command must refuse (exit 2), not silently exit 0.
    const dir = mkdtempSync(join(tmpdir(), "livecheck-bin-"));
    try {
      const link = join(dir, "magnus-bin.ts");
      symlinkSync(fileURLToPath(new URL("../src/livecheck.ts", import.meta.url)), link);
      const env = { ...process.env };
      delete env.MAGNUS_BASE_URL;
      delete env.MAGNUS_API_KEY;
      const run = spawnSync(process.execPath, [link], { env, encoding: "utf8" });
      assert.equal(run.status, 2, run.stderr);
      assert.match(run.stderr, /MAGNUS_BASE_URL and MAGNUS_API_KEY are required/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
