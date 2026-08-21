/**
 * Regression tests — boundaries and the L2 trigger are anchored to durable
 * entry seq numbers, never to positions in the offload log.
 *
 * The correctness failure these tests lock out: a boundary recorded as a
 * positional index silently points at the wrong entries the moment the log is
 * rewritten (L2 backfill rewrites and reorders it routinely), and the
 * time-based L2 trigger decided "is there new work?" by comparing entry
 * timestamps, which equal-millisecond writes or clock skew can defeat.
 *
 * Post-fix contract under test:
 *  - boundaries are resolved through each entry's `seq`, so a shuffled rewrite
 *    of the log leaves L2's per-MMD attribution unchanged;
 *  - `lastProcessedSeq` (persisted in state.json) is the new-work cursor for
 *    the timeout trigger: rows with seq above it are new, rows at or below it
 *    are not;
 *  - legacy logs written before `seq` existed are backfilled in file order on
 *    first read and persisted, so the assignment is stable across restarts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OffloadStateManager } from "./state-manager.js";
import { checkL2Trigger } from "./pipelines/l2-mermaid.js";
import {
  createStorageContext,
  ensureDirs,
  appendOffloadEntries,
  rewriteOffloadEntries,
  readOffloadEntries,
  peekNextSeq,
  type StorageContext,
} from "./storage.js";
import type { OffloadEntry } from "./types.js";

let dataRoot: string;
let ctx: StorageContext;

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as any;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "offload-seq-boundary-test-"));
  ctx = createStorageContext(dataRoot, "agent-a", "sess-1");
  await ensureDirs(ctx);
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function makeEntry(toolCallId: string, extra: Partial<OffloadEntry> = {}): OffloadEntry {
  return {
    timestamp: "2026-08-06T00:00:00.000Z",
    node_id: null,
    tool_call: `bash(command="echo ${toolCallId}")`,
    summary: `summary for ${toolCallId}`,
    result_ref: `refs/${toolCallId}.md`,
    tool_call_id: toolCallId,
    ...extra,
  } as unknown as OffloadEntry;
}

describe("seq-anchored boundaries survive entry-log rewrites", () => {
  it("L2 attributes the same entries to the same MMDs after the log is rewritten in a different order", async () => {
    // Four entries; append assigns seq 0..3.
    await appendOffloadEntries(
      ctx,
      [makeEntry("t0"), makeEntry("t1"), makeEntry("t2"), makeEntry("t3")],
      undefined,
      undefined,
    );
    expect(await peekNextSeq(ctx)).toBe(4);

    const sm = new OffloadStateManager();
    await sm.init(dataRoot, "agent-a", "sess-1");

    // Boundary A covers seq 0-1, boundary B covers seq 2 onward.
    await sm.pushBoundary({ startSeq: 0, result: "long", targetMmd: "001-a.mmd" });
    await sm.pushBoundary({ startSeq: 2, result: "long", targetMmd: "002-b.mmd" });

    // Rewrite the log in a scrambled order, exactly what an L2 backfill pass
    // may do. Positions change; seqs do not.
    const shuffled = [
      makeEntry("t2", { seq: 2 }),
      makeEntry("t0", { seq: 0 }),
      makeEntry("t3", { seq: 3 }),
      makeEntry("t1", { seq: 1 }),
    ];
    await rewriteOffloadEntries(ctx, shuffled);

    // peekNextSeq is unaffected by the rewrite (seqs are never renumbered).
    expect(await peekNextSeq(ctx)).toBe(4);

    const res = await checkL2Trigger(sm, { l2NullThreshold: 1 }, logger);
    expect(res.shouldTrigger).toBe(true);

    const idsOf = (mmd: string) =>
      new Set((res.entriesByMmd.get(mmd) ?? []).map((e) => e.tool_call_id));
    // Seq-keyed resolution: t0/t1 (seq 0/1) still belong to boundary A and
    // t2/t3 (seq 2/3) to boundary B, regardless of their new file positions.
    expect(idsOf("001-a.mmd")).toEqual(new Set(["t0", "t1"]));
    expect(idsOf("002-b.mmd")).toEqual(new Set(["t2", "t3"]));
  });

  it("the timeout trigger uses lastProcessedSeq to tell new offload rows from already-processed ones", async () => {
    await appendOffloadEntries(
      ctx,
      [makeEntry("t0"), makeEntry("t1"), makeEntry("t2"), makeEntry("t3")],
      undefined,
      undefined,
    );

    const sm = new OffloadStateManager();
    await sm.init(dataRoot, "agent-a", "sess-1");
    await sm.pushBoundary({ startSeq: 0, result: "long", targetMmd: "001-a.mmd" });

    // Simulate a completed L2 pass: all current rows (max seq 3) processed,
    // long ago enough that the timeout condition is met.
    sm.setLastProcessedSeq(3);
    sm.setLastL2TriggerTime("2020-01-01T00:00:00.000Z");

    // High null threshold so only the timeout path can fire.
    const cfg = { l2NullThreshold: 99, l2TimeoutSeconds: 0 };
    const stale = await checkL2Trigger(sm, cfg, logger);
    expect(stale.shouldTrigger).toBe(false);
    expect(stale.reason).toContain("no new offload rows");

    // The cursor is monotonic: a lower value must not move it backwards.
    sm.setLastProcessedSeq(1);
    expect(sm.getLastProcessedSeq()).toBe(3);

    // The cursor survives a restart (persisted in state.json), and the
    // boundaries survive it too (reloaded from the append-only log).
    await sm.save();
    const sm2 = new OffloadStateManager();
    await sm2.init(dataRoot, "agent-a", "sess-1");
    await sm2.loadBoundaries();
    expect(sm2.getLastProcessedSeq()).toBe(3);
    const staleAfterRestart = await checkL2Trigger(sm2, cfg, logger);
    expect(staleAfterRestart.shouldTrigger).toBe(false);
    expect(staleAfterRestart.reason).toContain("no new offload rows");

    // A genuinely new row (seq 4 > cursor 3) makes the timeout trigger fire,
    // and the new row inherits the segment of the covering boundary.
    await appendOffloadEntries(ctx, [makeEntry("t4")], undefined, undefined);
    const fresh = await checkL2Trigger(sm2, cfg, logger);
    expect(fresh.shouldTrigger).toBe(true);
    const ids = new Set((fresh.entriesByMmd.get("001-a.mmd") ?? []).map((e) => e.tool_call_id));
    expect(ids.has("t4")).toBe(true);
  });

  it("legacy entries without seq are backfilled in file order, persisted, and stable across reads", async () => {
    // Write a raw log the way pre-seq versions of the plugin did: no seq field.
    const legacyLines = [
      JSON.stringify(makeEntry("legacy-0")),
      JSON.stringify(makeEntry("legacy-1")),
      JSON.stringify(makeEntry("legacy-2")),
    ].join("\n") + "\n";
    await writeFile(ctx.offloadJsonl, legacyLines, "utf-8");

    const first = await readOffloadEntries(ctx);
    expect(first.map((e) => e.seq)).toEqual([0, 1, 2]);

    // The backfill is persisted: the file on disk now carries the seqs.
    const onDisk = (await readFile(ctx.offloadJsonl, "utf-8")).trim().split("\n");
    expect(onDisk).toHaveLength(3);
    expect(onDisk.map((l) => JSON.parse(l).seq)).toEqual([0, 1, 2]);

    // A second read returns the identical assignment — boundaries recorded
    // against these seqs remain valid after a restart.
    const second = await readOffloadEntries(ctx);
    expect(second.map((e) => e.seq)).toEqual([0, 1, 2]);

    // New appends continue from the backfilled maximum.
    expect(await peekNextSeq(ctx)).toBe(3);
    await appendOffloadEntries(ctx, [makeEntry("new-0")], undefined, undefined);
    const after = await readOffloadEntries(ctx);
    expect(after.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(after[3].tool_call_id).toBe("new-0");
  });
});
