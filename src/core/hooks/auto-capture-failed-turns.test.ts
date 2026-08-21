/**
 * Regression tests — failed turns are remembered.
 *
 * The agent_end hook returned early when the turn errored
 * (index.ts:661-664), so nothing reached L0, nothing reached L1, and the
 * failure left no trace in long-term memory. For a memory system, "we tried
 * approach X here and it did not work" is high-value memory — discarding it
 * lets the agent repeat the same failure without limit.
 *
 * Fix: capture failed turns with an explicit `outcome` field, and let the L1
 * extraction prompt decide what to do with a failure instead of filtering the
 * turn out before extraction ever sees it.
 *
 * Pre-fix these tests fail: `performAutoCapture` / `recordConversation` have
 * no outcome parameter, so the L0 record carries no `outcome` field at all.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { performAutoCapture } from "./auto-capture.js";
import { recordConversation } from "../conversation/l0-recorder.js";
import type { MemoryTdaiConfig } from "../../config.js";

let dataDir: string;

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as any;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "auto-capture-f10-test-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function readAllL0Records(): Promise<Array<Record<string, unknown>>> {
  const convDir = join(dataDir, "conversations");
  const files = await readdir(convDir).catch(() => [] as string[]);
  const out: Array<Record<string, unknown>> = [];
  for (const f of files.filter((f) => f.endsWith(".jsonl"))) {
    const text = await readFile(join(convDir, f), "utf-8");
    for (const line of text.split("\n")) {
      if (line.trim()) out.push(JSON.parse(line));
    }
  }
  return out;
}

describe("failed turns are captured with outcome: \"error\"", () => {
  it("recordConversation persists the outcome field on L0 records", async () => {
    const msgs = [
      { role: "user", content: "Try deploying with the experimental flag", timestamp: 1000 },
      { role: "assistant", content: "Deployment failed: remote rejected the build", timestamp: 1001 },
    ];

    const recorded = await recordConversation({
      sessionKey: "agent:main:sess-err",
      rawMessages: msgs,
      baseDir: dataDir,
      logger,
      outcome: "error",
    } as any);

    expect(recorded.length).toBeGreaterThan(0);
    const records = await readAllL0Records();
    expect(records.length).toBeGreaterThan(0);
    // Every L0 record from a failed turn must carry the explicit outcome.
    for (const r of records) {
      expect(r.outcome).toBe("error");
    }
  });

  it("performAutoCapture on a failed turn produces L0 records carrying outcome: \"error\"", async () => {
    const cfg = {
      capture: { enabled: true, excludeAgents: [], l0l1RetentionDays: 0, allowAggressiveCleanup: false },
    } as unknown as MemoryTdaiConfig;

    const result = await performAutoCapture({
      messages: [
        { role: "user", content: "Run the migration now", timestamp: 2000 },
        { role: "assistant", content: "Migration aborted: schema lock timeout", timestamp: 2001 },
      ],
      sessionKey: "agent:main:sess-fail",
      cfg,
      pluginDataDir: dataDir,
      logger,
      outcome: "error",
    } as any);

    // The turn was actually captured (not filtered out as "did not happen").
    expect(result.l0RecordedCount).toBeGreaterThan(0);
    expect(result.filteredMessages.length).toBeGreaterThan(0);

    const records = await readAllL0Records();
    expect(records.length).toBe(result.l0RecordedCount);
    for (const r of records) {
      expect(r.outcome).toBe("error");
      expect(r.sessionKey).toBe("agent:main:sess-fail");
    }
  });

  it("successful turns default to outcome: \"success\"", async () => {
    const cfg = {
      capture: { enabled: true, excludeAgents: [], l0l1RetentionDays: 0, allowAggressiveCleanup: false },
    } as unknown as MemoryTdaiConfig;

    const result = await performAutoCapture({
      messages: [
        { role: "user", content: "Summarize today's notes", timestamp: 3000 },
        { role: "assistant", content: "Here is the summary of your notes", timestamp: 3001 },
      ],
      sessionKey: "agent:main:sess-ok",
      cfg,
      pluginDataDir: dataDir,
      logger,
    } as any);

    expect(result.l0RecordedCount).toBeGreaterThan(0);
    const records = await readAllL0Records();
    for (const r of records) {
      expect(r.outcome).toBe("success");
    }
  });
});
