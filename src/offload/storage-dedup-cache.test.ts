/**
 * Regression tests — appendOffloadEntries per-append cost is O(k), not O(N).
 *
 * Plan.md (storage.ts appendOffloadEntries): the dedup check re-read and
 * re-scanned the entire offload JSONL on every append, so total cost across a
 * session grew quadratically with entry count — and it ran on the path taken
 * by every single tool call. Fix: hold the id set (and running max seq) in a
 * session-scoped in-memory cache, seeded once from disk; subsequent appends
 * consult memory and perform zero additional file reads.
 *
 * Test strategy: count how many times readFile is invoked on the offload
 * JSONL across a run of appends. Pre-fix the count grows linearly with the
 * number of appends (one full rescan each). Post-fix it is 1 regardless of
 * how many appends follow — per-append cost is flat as N grows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile as realReadFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Count readFile calls that hit the offload JSONL (distinguished by suffix).
const readCounter = vi.hoisted(() => ({ offloadReads: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const mod: Record<string, unknown> = { ...(actual as Record<string, unknown>) };
  mod.readFile = async (path: unknown, ...rest: unknown[]) => {
    if (typeof path === "string" && /offload-.*\.jsonl$/.test(path)) {
      readCounter.offloadReads++;
    }
    return (actual.readFile as any)(path, ...rest);
  };
  mod.default = mod;
  return mod;
});

import {
  createStorageContext,
  ensureDirs,
  appendOffloadEntries,
  readOffloadEntries,
  rewriteOffloadEntries,
  _clearDedupCacheForTest,
  type StorageContext,
} from "./storage.js";
import type { OffloadEntry } from "./types.js";

let dataRoot: string;
let ctx: StorageContext;

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any;

beforeEach(async () => {
  _clearDedupCacheForTest();
  readCounter.offloadReads = 0;
  dataRoot = await mkdtemp(join(tmpdir(), "offload-f7-test-"));
  ctx = createStorageContext(dataRoot, "agent-a", "sess-1");
  await ensureDirs(ctx);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dataRoot, { recursive: true, force: true });
});

function makeEntry(toolCallId: string): OffloadEntry {
  return {
    timestamp: "2026-08-06T00:00:00.000Z",
    node_id: null,
    tool_call: `bash(command="${toolCallId}")`,
    summary: `summary ${toolCallId}`,
    result_ref: `refs/${toolCallId}.md`,
    tool_call_id: toolCallId,
  } as unknown as OffloadEntry;
}

describe("appendOffloadEntries does not rescan the log per append", () => {
  it("reads the offload file once across many appends (flat per-append cost)", async () => {
    // First append: cold cache → seeds from disk (file absent → 0 reads, or 1 if present).
    await appendOffloadEntries(ctx, [makeEntry("call-0")], undefined, logger);
    const readsAfterFirst = readCounter.offloadReads;

    // 40 further appends must NOT add further reads of the offload JSONL.
    // (Capture the count BEFORE the verification readback below — readOffloadEntries
    // legitimately reads the file itself and would pollute the counter.)
    for (let i = 1; i <= 40; i++) {
      await appendOffloadEntries(ctx, [makeEntry(`call-${i}`)], undefined, logger);
    }
    expect(readCounter.offloadReads).toBe(readsAfterFirst);

    // All 41 entries are durably written and retrievable.
    const all = await readOffloadEntries(ctx);
    expect(all).toHaveLength(41);
  });

  it("duplicate ids are still rejected using the in-memory cache (no rescan needed)", async () => {
    await appendOffloadEntries(ctx, [makeEntry("dup-1"), makeEntry("ok-1")], undefined, logger);
    const readsAfterSeed = readCounter.offloadReads;

    // Append a batch containing a repeat of dup-1 (and its underscore-normalised form).
    await appendOffloadEntries(ctx, [makeEntry("dup-1"), makeEntry("ok-2")], undefined, logger);
    // Assert the read count BEFORE the verification readback below (see test 1).
    expect(readCounter.offloadReads).toBe(readsAfterSeed);

    // Only the genuinely new id was written; dedup happened from cache.
    const all = await readOffloadEntries(ctx);
    expect(all.map((e) => e.tool_call_id).sort()).toEqual(["dup-1", "ok-1", "ok-2"]);
  });

  it("underscore-normalised ids dedup against cached raw ids", async () => {
    await appendOffloadEntries(ctx, [makeEntry("call_a_b")], undefined, logger);
    await appendOffloadEntries(ctx, [makeEntry("callab"), makeEntry("fresh")], undefined, logger);
    const ids = (await readOffloadEntries(ctx)).map((e) => e.tool_call_id);
    // "callab" normalises to the same key as "call_a_b" → dropped; "fresh" kept.
    expect(ids).toEqual(["call_a_b", "fresh"]);
  });

  it("seq stays monotonic across appends without re-deriving from disk", async () => {
    await appendOffloadEntries(ctx, [makeEntry("s0"), makeEntry("s1")], undefined, logger);
    await appendOffloadEntries(ctx, [makeEntry("s2"), makeEntry("s3")], undefined, logger);
    const seqs = (await readOffloadEntries(ctx)).map((e) => (e as any).seq);
    expect(seqs).toEqual([0, 1, 2, 3]);
  });

  it("a rewrite invalidates the cache so the next append re-seeds from the new state", async () => {
    await appendOffloadEntries(ctx, [makeEntry("keep-1"), makeEntry("drop-1")], undefined, logger);
    // Rewrite removes drop-1 entirely.
    await rewriteOffloadEntries(ctx, [makeEntry("keep-1")]);

    const readsBeforeAppend = readCounter.offloadReads;
    // Re-appending the dropped id must now succeed (it no longer exists on disk),
    // which requires re-seeding from the rewritten file.
    await appendOffloadEntries(ctx, [makeEntry("drop-1")], undefined, logger);
    expect(readCounter.offloadReads).toBe(readsBeforeAppend + 1);

    const ids = (await readOffloadEntries(ctx)).map((e) => e.tool_call_id).sort();
    expect(ids).toEqual(["drop-1", "keep-1"]);
  });
});
