/**
 * When deduplication fails, duplicates must NOT be silently
 * written to the live corpus as if they were verified.
 *
 * Plan.md §5: fallbackStoreAll (l1-dedup.ts) stores every candidate
 * when the dedup judgment cannot be completed, making duplicates permanent
 * members of the live corpus with no signal. Fix: quarantine the batch in a
 * pending area and retry it; if retries are exhausted, store it with a
 * dedup: "unverified" flag so recall can deliberately down-weight it. This
 * keeps the fail-open guarantee without pretending the data is clean.
 *
 * Test: force a dedup failure and assert the live corpus size is unchanged
 * (no verified writes) and the pending count went up by the batch size.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { batchDedup, DedupFailureError } from "./l1-dedup.js";
import {
  extractL1Memories,
  readPendingDedup,
  countPendingDedup,
  clearPendingDedup,
} from "./l1-extractor.js";
import type { LLMRunner } from "../types.js";
import type { IMemoryStore, L1FtsResult } from "../store/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** An existing record in the corpus, returned by the FTS stub as a candidate. */
const EXISTING: L1FtsResult = {
  record_id: "existing-1",
  content: "User likes dark roast coffee",
  type: "episodic",
  priority: 50,
  scene_name: "coffee",
  score: 0.9,
  timestamp_str: "2026-01-01T09:00:00Z",
  timestamp_start: "",
  timestamp_end: "",
  session_key: "sess-f12",
  session_id: "sess-f12",
  metadata_json: "{}",
};

/**
 * Minimal IMemoryStore stub: pretends the corpus is non-empty (countL1=1) and
 * FTS is available, and returns one candidate so the dedup path reaches the
 * LLM judgment stage. Records every upsert so tests can assert what was
 * written to the live corpus.
 */
function makeFtsStore(upsertLog: unknown[]): IMemoryStore {
  return {
    countL1: async () => 1,
    isFtsAvailable: () => true,
    searchL1Fts: async () => [EXISTING],
    upsertL1: async (rec: unknown) => {
      upsertLog.push(rec);
      return true;
    },
    deleteL1Batch: async () => true,
  } as unknown as IMemoryStore;
}

/** A message batch that survives the shouldExtractL1 content filter. */
const messages = [
  { role: "user", content: "Please remember that I prefer dark roast coffee in the morning.", timestamp: "2026-01-01T09:00:00Z" },
  { role: "assistant", content: "Got it, noted your coffee preference for future mornings.", timestamp: "2026-01-01T09:00:01Z" },
] as any;

/** A valid extraction payload with two new memories. */
const EXTRACTION_OK = JSON.stringify([
  {
    scene_name: "coffee",
    message_ids: ["m1", "m2"],
    memories: [
      { content: "User prefers dark roast coffee in the morning", type: "episodic", priority: 60, source_message_ids: ["m1"], metadata: {} },
      { content: "User likes coffee a lot in general", type: "persona", priority: 40, source_message_ids: ["m2"], metadata: {} },
    ],
  },
]);

/** Read every L1 record currently in the live corpus (records/*.jsonl). */
async function readLiveCorpus(baseDir: string): Promise<Array<Record<string, unknown>>> {
  const recordsDir = path.join(baseDir, "records");
  const out: Array<Record<string, unknown>> = [];
  let files: string[] = [];
  try {
    files = (await fs.readdir(recordsDir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  for (const f of files) {
    const text = await fs.readFile(path.join(recordsDir, f), "utf-8");
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (t) out.push(JSON.parse(t));
    }
  }
  return out;
}

/** Count records in the live corpus NOT flagged dedup:"unverified" (in metadata). */
function countVerified(records: Array<Record<string, unknown>>): number {
  return records.filter((r) => (r.metadata as any)?.dedup !== "unverified").length;
}

describe("dedup failure quarantines instead of dirtying the live corpus", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "f12-"));
  });
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("batchDedup throws DedupFailureError when the LLM judgment output is unparseable", async () => {
    const upsertLog: unknown[] = [];
    const vectorStore = makeFtsStore(upsertLog);
    const llmRunner: LLMRunner = { run: async () => "not json, no array here" };

    await expect(
      batchDedup({
        memories: [
          { content: "c1", type: "episodic", priority: 50, source_message_ids: [], metadata: {}, scene_name: "s", record_id: "r1" },
        ] as any,
        config: {},
        logger: noopLogger,
        vectorStore,
        llmRunner,
      }),
    ).rejects.toBeInstanceOf(DedupFailureError);

    // Nothing was written to the live corpus by the failed judgment itself
    expect(upsertLog.length).toBe(0);
  });

  it("on dedup failure, live corpus gains NO verified records and pending count grows by the batch size", async () => {
    const upsertLog: unknown[] = [];
    const vectorStore = makeFtsStore(upsertLog);

    // First call (extraction) returns a valid payload; second call (dedup
    // judgment) returns garbage, forcing a dedup failure.
    let call = 0;
    const llmRunner: LLMRunner = {
      run: async ({ taskId }) => {
        call += 1;
        if (taskId === "l1-extraction") return EXTRACTION_OK;
        return "garbage — no usable JSON"; // l1-conflict-detection
      },
    };

    const before = countVerified(await readLiveCorpus(baseDir));
    const pendingBefore = await countPendingDedup(baseDir, "sess-f12");

    const result = await extractL1Memories({
      messages,
      sessionKey: "sess-f12",
      sessionId: "sess-f12",
      baseDir,
      config: {},
      logger: noopLogger,
      options: { enableDedup: true, llmRunner, vectorStore },
    } as any);

    // Extraction itself succeeded; the batch is not reported as cleanly deduped.
    expect(result.success).toBe(true);
    expect(call).toBe(2); // extraction + dedup judgment both ran

    // Live corpus: no new VERIFIED records appeared from the failed batch.
    const after = countVerified(await readLiveCorpus(baseDir));
    expect(after - before).toBe(0);

    // The batch was quarantined: pending grew by the batch size (2 memories).
    const pendingAfter = await countPendingDedup(baseDir, "sess-f12");
    expect(pendingAfter - pendingBefore).toBe(2);
    const pending = await readPendingDedup(baseDir, "sess-f12");
    expect(pending.length).toBe(2);
    expect(pending.every((m) => (m as any).dedup === "unverified")).toBe(true);
  });

  it("quarantined batch is stored with dedup: \"unverified\" so recall can down-weight it", async () => {
    const upsertLog: Array<Record<string, unknown>> = [];
    const vectorStore = makeFtsStore(upsertLog);

    let call = 0;
    const llmRunner: LLMRunner = {
      run: async ({ taskId }) => {
        call += 1;
        if (taskId === "l1-extraction") return EXTRACTION_OK;
        return "garbage";
      },
    };

    await extractL1Memories({
      messages,
      sessionKey: "sess-f12",
      sessionId: "sess-f12",
      baseDir,
      config: {},
      logger: noopLogger,
      options: { enableDedup: true, llmRunner, vectorStore },
    } as any);

    // The fail-open guarantee is preserved (records exist somewhere), but
    // every quarantined record carries the unverified flag.
    const pending = await readPendingDedup(baseDir, "sess-f12");
    expect(pending.length).toBe(2);
    for (const m of pending) {
      expect((m as any).dedup).toBe("unverified");
    }
  });

  it("clearPendingDedup removes the quarantine for a session", async () => {
    const vectorStore = makeFtsStore([]);
    let call = 0;
    const llmRunner: LLMRunner = {
      run: async ({ taskId }) => {
        call += 1;
        return taskId === "l1-extraction" ? EXTRACTION_OK : "garbage";
      },
    };

    await extractL1Memories({
      messages,
      sessionKey: "sess-f12",
      sessionId: "sess-f12",
      baseDir,
      config: {},
      logger: noopLogger,
      options: { enableDedup: true, llmRunner, vectorStore },
    } as any);

    expect(await countPendingDedup(baseDir, "sess-f12")).toBe(2);
    await clearPendingDedup(baseDir, "sess-f12");
    expect(await countPendingDedup(baseDir, "sess-f12")).toBe(0);
  });
});
