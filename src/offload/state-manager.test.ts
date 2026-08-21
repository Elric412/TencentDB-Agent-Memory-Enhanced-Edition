/**
 * Regression tests — task boundaries must survive session switch and log rewrite.
 *
 * Plan.md (state-manager.ts / storage.ts): `l15Boundaries` lived only in
 * runtime state, so `switchSession` wiped them; a boundary was a *positional
 * index* into the entry log, so `rewriteAllOffloadEntries` renumbered the log
 * out from under it; and `pushBoundary` silently overwrote a boundary that
 * landed on the same index.
 *
 * Fix: every entry carries a monotonic `seq` that is never reused, and
 * boundaries live in an append-only `boundaries.jsonl` keyed by `seq` rather
 * than array index. Resolution maps a boundary's `startSeq` to the entries
 * whose `seq` fall in its segment — independent of file position.
 *
 * The detection test fails on today's code at three independent points:
 *  - after switchSession the boundary list is empty (runtime-only);
 *  - pushBoundary overwrites a same-index boundary (no history);
 *  - resolution is by array index, so rewriting the log breaks it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { OffloadStateManager } from "./state-manager.js";
import {
  createStorageContext,
  ensureDirs,
  appendOffloadEntries,
  rewriteOffloadEntries,
  readOffloadEntries,
  appendBoundary,
  readBoundaries,
  type StorageContext,
} from "./storage.js";
import type { OffloadEntry } from "./types.js";

let dataRoot: string;
let ctx: StorageContext;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "offload-f4-test-"));
  ctx = createStorageContext(dataRoot, "agent-a", "sess-1");
  await ensureDirs(ctx);
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function makeEntry(toolCallId: string, seq?: number): OffloadEntry {
  return {
    timestamp: "2026-08-06T00:00:00.000Z",
    node_id: null,
    tool_call: `bash(command="echo ${toolCallId}")`,
    summary: `summary for ${toolCallId}`,
    result_ref: `refs/${toolCallId}.md`,
    tool_call_id: toolCallId,
    ...(seq !== undefined ? { seq } : {}),
  } as unknown as OffloadEntry;
}

describe("monotonic seq + append-only boundaries.jsonl", () => {
  it("appendOffloadEntries assigns monotonically increasing seq when absent", async () => {
    await appendOffloadEntries(ctx, [makeEntry("a"), makeEntry("b"), makeEntry("c")], undefined, undefined);
    const entries = await readOffloadEntries(ctx);
    const seqs = entries.map((e) => (e as any).seq);
    // seq present, unique, and monotonically increasing
    expect(seqs.every((s) => typeof s === "number")).toBe(true);
    expect(new Set(seqs).size).toBe(3);
    expect([...seqs]).toEqual([...seqs].sort((x, y) => x - y));
  });

  it("appendBoundary writes an append-only boundaries.jsonl that pushBoundary can reload after switchSession", async () => {
    // Write two boundaries directly to the log.
    await appendBoundary(ctx, { startSeq: 0, result: "long", targetMmd: "001-task-a.mmd" });
    await appendBoundary(ctx, { startSeq: 2, result: "long", targetMmd: "002-task-b.mmd" });

    const logPath = join(ctx.dataDir, "boundaries-sess-1.jsonl");
    expect(existsSync(logPath)).toBe(true);
    const lines = (await readFile(logPath, "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(2);

    // A fresh state manager over the same session must reload the boundaries.
    const sm = new OffloadStateManager();
    await sm.init(dataRoot, "agent-a", "sess-1");
    const loaded = await sm.loadBoundaries();
    expect(loaded).toHaveLength(2);
    expect(loaded[0].startSeq).toBe(0);
    expect(loaded[1].targetMmd).toBe("002-task-b.mmd");
  });

  it("boundaries survive a session switch and resolve to the same entries after a log rewrite", async () => {
    // Seed entries with explicit seqs.
    const initial = [
      makeEntry("t0", 0),
      makeEntry("t1", 1),
      makeEntry("t2", 2),
      makeEntry("t3", 3),
    ];
    await appendOffloadEntries(ctx, initial, undefined, undefined);

    const sm = new OffloadStateManager();
    await sm.init(dataRoot, "agent-a", "sess-1");

    // Two boundaries: task A covers seq 0-1, task B covers seq 2-3.
    await sm.pushBoundary({ startSeq: 0, result: "long", targetMmd: "001-a.mmd" });
    await sm.pushBoundary({ startSeq: 2, result: "long", targetMmd: "002-b.mmd" });

    // Switch sessions (wipes runtime state) then come back.
    await sm.switchSession("agent:agent-a:sess-2", dataRoot);
    expect(sm.l15Boundaries).toHaveLength(0); // runtime cleared

    await sm.switchSession("agent:agent-a:sess-1", dataRoot);
    // Reloaded from boundaries.jsonl
    expect(sm.l15Boundaries).toHaveLength(2);

    // Now rewrite the entry log (e.g. L2 backfill rewrites/reorders entries).
    // The seq-keyed resolution must still find the same logical entries.
    const rewritten = [
      makeEntry("t2", 2),
      makeEntry("t0", 0),
      makeEntry("t3", 3),
      makeEntry("t1", 1),
    ];
    await rewriteOffloadEntries(ctx, rewritten);

    const entriesAfter = await readOffloadEntries(ctx);
    const resolvedA = sm.resolveEntryBySeq(entriesAfter, 1); // was t1
    const resolvedB = sm.resolveEntryBySeq(entriesAfter, 3); // was t3
    expect(resolvedA?.tool_call_id).toBe("t1");
    expect(resolvedB?.tool_call_id).toBe("t3");

    // And the boundary covering seq 3 is still task B.
    const bFor3 = sm.resolveBoundaryForSeq(3);
    expect(bFor3?.targetMmd).toBe("002-b.mmd");
  });

  it("pushBoundary appends rather than overwriting a same-startSeq boundary (history is kept)", async () => {
    const sm = new OffloadStateManager();
    await sm.init(dataRoot, "agent-a", "sess-1");
    await sm.pushBoundary({ startSeq: 5, result: "short", targetMmd: null });
    await sm.pushBoundary({ startSeq: 5, result: "long", targetMmd: "009-x.mmd" });
    // Both must be present in the persisted log — no silent overwrite.
    const persisted = await readBoundaries(ctx);
    expect(persisted.filter((b) => b.startSeq === 5)).toHaveLength(2);
  });
});
