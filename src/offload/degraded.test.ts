/**
 * Retry-queue unit tests — the "retry the extraction" half of the degraded-entry fix.
 *
 * Plan.md: degraded entries are enqueued for L1 retry with exponential
 * backoff against the existing serial queue; the unknown pool is bounded
 * (default 10); past the cap the oldest unknown is evicted (marked exhausted)
 * first; retries are not frozen into the store.
 *
 * The companion cascade tests live in hooks/llm-input-l3-unknown-score.test.ts.
 * Pre-fix, none of this existed at all: degraded entries were written with
 * score: 0 and never retried (the DegradedRetryQueue module did not exist).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createStorageContext,
  ensureDirs,
  appendOffloadEntries,
  readAllOffloadEntries,
  type StorageContext,
} from "./storage.js";
import {
  DegradedRetryQueue,
  DEGRADED_MAX_RETRY_ATTEMPTS,
  DEGRADED_RETRY_BASE_DELAY_MS,
} from "./degraded.js";
import type { OffloadEntry, ToolPair } from "./types.js";

let dataRoot: string;
let ctx: StorageContext;

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as any;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "degraded-e9-test-"));
  ctx = createStorageContext(dataRoot, "agent-a", "sess-1");
  await ensureDirs(ctx);
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function makePair(id: string): ToolPair {
  return {
    toolName: "bash",
    toolCallId: id,
    params: { command: `echo ${id}` },
    result: `output of ${id}`,
    timestamp: "2026-08-06T00:00:00.000Z",
  };
}

function makeDegradedEntry(id: string): OffloadEntry {
  return {
    timestamp: "2026-08-06T00:00:00.000Z",
    node_id: null,
    tool_call: `bash(command="echo ${id}")`,
    summary: `[L1 degraded] bash: output of ${id}`,
    result_ref: `refs/${id}.md`,
    tool_call_id: id,
    score: null,
  } as unknown as OffloadEntry;
}

describe("degraded retry queue", () => {
  it("exponential backoff: an item is not due immediately, then becomes due after its delay", async () => {
    const q = new DegradedRetryQueue(ctx, logger, 10);
    await q.enqueue([makePair("tc-1")], ["tc-1"]);

    const t0 = Date.now();
    // Not due right away (first backoff applies).
    expect(await q.dequeueDue(t0)).toBeNull();

    // Due once the base delay has elapsed.
    const due = await q.dequeueDue(t0 + DEGRADED_RETRY_BASE_DELAY_MS + 1);
    expect(due).not.toBeNull();
    expect(due!.toolCallIds).toEqual(["tc-1"]);

    // Failed retry → re-enqueued with doubled backoff relative to NOW.
    const before = Date.now();
    await q.recordResult(due!, false);
    // Still inside the (doubled) backoff window → not due.
    expect(await q.dequeueDue(before + DEGRADED_RETRY_BASE_DELAY_MS + 1)).toBeNull();
    // After the doubled window → due, with the attempt counted.
    const again = await q.dequeueDue(before + DEGRADED_RETRY_BASE_DELAY_MS * 2 + 1);
    expect(again).not.toBeNull();
    expect(again!.attempts).toBe(1);
  });

  it("retry exhaustion marks the degraded entries l1RetriesExhausted instead of dropping them silently", async () => {
    await appendOffloadEntries(ctx, [makeDegradedEntry("tc-x")]);
    const q = new DegradedRetryQueue(ctx, logger, 10);
    await q.enqueue([makePair("tc-x")], ["tc-x"]);

    let now = Date.now();
    for (let i = 0; i < DEGRADED_MAX_RETRY_ATTEMPTS; i++) {
      const due = await q.dequeueDue(now + DEGRADED_RETRY_BASE_DELAY_MS * 2 ** i + 1);
      expect(due).not.toBeNull();
      now = due!.nextRetryAtMs;
      await q.recordResult(due!, false);
    }

    // Queue no longer holds the item...
    expect(q.size).toBe(0);
    // ...and the entry itself is flagged exhausted rather than frozen unknown.
    const entries = await readAllOffloadEntries(ctx);
    expect(entries.find((e) => e.tool_call_id === "tc-x")?.l1RetriesExhausted).toBe(true);
  });

  it("pool cap evicts the OLDEST unknown first and marks it exhausted", async () => {
    // Cap of 2; enqueue three items. The first (oldest) must be evicted.
    const cap = 2;
    await appendOffloadEntries(ctx, [
      makeDegradedEntry("tc-oldest"),
      makeDegradedEntry("tc-mid"),
      makeDegradedEntry("tc-new"),
    ]);
    const q = new DegradedRetryQueue(ctx, logger, cap);
    await q.enqueue([makePair("tc-oldest")], ["tc-oldest"]);
    await q.enqueue([makePair("tc-mid")], ["tc-mid"]);
    await q.enqueue([makePair("tc-new")], ["tc-new"]);

    // Pool stays bounded at the cap.
    expect(q.pendingCount()).toBe(cap);

    // The oldest item's entry was evicted → marked exhausted in the log.
    const entries = await readAllOffloadEntries(ctx);
    const byId = new Map(entries.map((e) => [e.tool_call_id, e]));
    expect(byId.get("tc-oldest")?.l1RetriesExhausted).toBe(true);
    expect(byId.get("tc-mid")?.l1RetriesExhausted).toBeUndefined();
    expect(byId.get("tc-new")?.l1RetriesExhausted).toBeUndefined();
  });

  it("queue state survives a reload (persistence)", async () => {
    const q1 = new DegradedRetryQueue(ctx, logger, 10);
    await q1.enqueue([makePair("tc-p")], ["tc-p"]);

    // Fresh instance over the same session dir sees the persisted item.
    const q2 = new DegradedRetryQueue(ctx, logger, 10);
    expect(q2.size).toBe(0); // not loaded yet
    const due = await q2.dequeueDue(Date.now() + DEGRADED_RETRY_BASE_DELAY_MS + 1);
    expect(due).not.toBeNull();
    expect(due!.toolCallIds).toEqual(["tc-p"]);
  });
});
