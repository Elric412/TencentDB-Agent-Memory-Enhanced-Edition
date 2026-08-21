/**
 * Regression tests — recall timeout is not a miss.
 *
 * performAutoRecall races the retrieval against recall.timeoutMs and used to
 * return an empty result on timeout — the same value downstream code and
 * every metric would see for a genuine miss. Two failure modes with
 * completely different remedies ("the index does not contain what you need"
 * vs "the index is too slow") were collapsed onto one return value.
 *
 * The fix is a separate `recall_timeout` counter plus a return value that
 * distinguishes the cases (RecallResult.timedOut), so hit rate and timeout
 * rate can be reported as independent numbers.
 *
 * Test: force a timeout (hanging embedding service + tiny deadline) and
 * assert the timeout counter moved while the miss path was not taken; then
 * verify a fast empty search resolves with timedOut !== true.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Capture every emitted metric so the test can assert recall_timeout fired
// and — just as importantly — that no other recall outcome counter did.
const emittedEvents = vi.hoisted(() => ({ events: [] as Array<{ event: string; data: Record<string, unknown> }> }));

import { performAutoRecall } from "./auto-recall.js";
import { setReporter, resetReporter } from "../report/reporter.js";
import type { MemoryTdaiConfig } from "../../config.js";
import type { EmbeddingService } from "../store/embedding.js";

let pluginDataDir: string;

beforeEach(async () => {
  emittedEvents.events.length = 0;
  setReporter({
    reportFunc: (_category: string, payload: Record<string, unknown>) => {
      const { event, ...data } = payload as { event: string } & Record<string, unknown>;
      emittedEvents.events.push({ event, data });
    },
  });
  pluginDataDir = await mkdtemp(join(tmpdir(), "recall-f18-test-"));
});

afterEach(async () => {
  resetReporter();
  vi.restoreAllMocks();
  await rm(pluginDataDir, { recursive: true, force: true });
});

function makeCfg(timeoutMs: number): MemoryTdaiConfig {
  return {
    recall: { enabled: true, strategy: "embedding", timeoutMs, maxResults: 5, scoreThreshold: 0.3 },
    embedding: { timeoutMs: 0, recallTimeoutMs: 0 }, // no inner timeout — the outer race must be what fires
  } as unknown as MemoryTdaiConfig;
}

/** An embedding service whose embed() never resolves — simulates a stuck index. */
function hangingEmbeddingService(): EmbeddingService {
  return {
    embed: () => new Promise<Float32Array>(() => {}),
    embedBatch: () => new Promise<Float32Array[]>(() => {}),
    getDimensions: () => 3,
    getProviderInfo: () => ({ provider: "test", model: "hanging" }),
    isReady: () => true,
    startWarmup: () => {},
  } as unknown as EmbeddingService;
}

/** Minimal vector store stub — enough for the embedding strategy path. */
function stubVectorStore() {
  return {
    getCapabilities: () => ({ nativeHybridSearch: false }),
    searchL1ByEmbedding: async () => [],
    searchL1Keyword: async () => [],
  } as any;
}

describe("recall timeout is distinguishable from a genuine miss", () => {
  it("a timed-out recall emits recall_timeout and returns timedOut=true (not a miss)", async () => {
    const result = await performAutoRecall({
      userText: "what databases did we evaluate last month?",
      actorId: "default_user",
      sessionKey: "sess-timeout",
      cfg: makeCfg(50), // 50ms deadline; embed() hangs forever
      pluginDataDir,
      vectorStore: stubVectorStore(),
      embeddingService: hangingEmbeddingService(),
    });

    // The distinguishing return value: timeout, NOT an empty/miss result.
    expect(result).toBeDefined();
    expect(result?.timedOut).toBe(true);

    // The timeout counter moved exactly once, with diagnostic context.
    const timeouts = emittedEvents.events.filter((e) => e.event === "recall_timeout");
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0].data.timeoutMs).toBe(50);
    expect(timeouts[0].data.sessionKey).toBe("sess-timeout");

    // No recall-completed outcome was recorded — the timeout must not be
    // double-counted as a normal (miss) recall.
    expect(emittedEvents.events.filter((e) => e.event === "recall_completed")).toHaveLength(0);
  });

  it("a fast search with no hits resolves with timedOut !== true and no recall_timeout", async () => {
    const result = await performAutoRecall({
      userText: "what databases did we evaluate last month?",
      actorId: "default_user",
      sessionKey: "sess-miss",
      cfg: makeCfg(5000),
      pluginDataDir,
      vectorStore: stubVectorStore(),
      embeddingService: {
        embed: async () => new Float32Array([0.1, 0.2, 0.3]),
        embedBatch: async () => [new Float32Array([0.1, 0.2, 0.3])],
        getDimensions: () => 3,
        getProviderInfo: () => ({ provider: "test", model: "instant" }),
        isReady: () => true,
        startWarmup: () => {},
      } as unknown as EmbeddingService,
    });

    // A genuine miss: the recall completed within the deadline. It may return
    // undefined (nothing to inject), but it must NOT be flagged as a timeout
    // and must NOT have emitted the recall_timeout counter.
    expect(result?.timedOut).not.toBe(true);
    expect(emittedEvents.events.filter((e) => e.event === "recall_timeout")).toHaveLength(0);
  });
});
