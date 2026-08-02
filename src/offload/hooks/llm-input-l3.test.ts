/**
 * F2 — mild-cascade "revert" regression tests.
 *
 * Plan.md F2 (llm-input-l3.ts over-length branch): previously, when a
 * generated summary turned out LONGER than the original tool output,
 * replaceWithSummary (l3-helpers.ts) had already destroyed the message
 * content in place, so the "revert" branch only flipped `_offloaded` and
 * skipped the counters — the original tool output was silently lost AND the
 * metrics under-reported the event.
 *
 * These tests pin the fixed behavior:
 *  1. Detection test (per plan): force an over-length summary on a known
 *     message, trigger the revert path, assert content equality between the
 *     restored message and the original pre-replacement content.
 *  2. `revert_failed` stays at 0 across normal operation (the counter is
 *     exercised, not just added and forgotten).
 *  3. Reverted blocks are NOT counted in replacedCount / replacedDetails /
 *     replacedToolCallIds; genuinely-shorter summaries still are.
 */
import { describe, it, expect } from "vitest";
import { compressByScoreCascade } from "./llm-input-l3.js";
import type { OffloadEntry } from "../types.js";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as any;

function makeToolResult(toolCallId: string, content: string): any {
  return { role: "tool", toolCallId, content };
}

function makeEntry(toolCallId: string, summary: string, score = 9): OffloadEntry {
  return {
    tool_call_id: toolCallId,
    node_id: "001-N1",
    tool_call: `bash(command="cat huge.log")`,
    summary,
    result_ref: "offload/001-N1.json",
    score,
  } as unknown as OffloadEntry;
}

function makeMap(entries: OffloadEntry[]): Map<string, OffloadEntry> {
  const m = new Map<string, OffloadEntry>();
  for (const e of entries) m.set(e.tool_call_id, e);
  return m;
}

describe("F2 — mild cascade revert actually reverts", () => {
  it("detection: over-length summary triggers revert and restores the original content exactly", () => {
    const originalContent = "short output"; // 12 chars
    const messages = [
      makeToolResult("tc_1", originalContent),
      { role: "user", content: "filler tail message" },
    ];
    const originalSnapshot = JSON.parse(JSON.stringify(messages[0]));

    // Summary is deliberately far longer than the 12-char original, so
    // replaceWithSummary's returned summaryLength > originalLength.
    const hugeSummary =
      "This is an extremely verbose generated summary of a trivial tool output " +
      "that rambles on far beyond the size of the original payload it claims to compress. ".repeat(3);

    const result = compressByScoreCascade(
      messages,
      makeMap([makeEntry("tc_1", hugeSummary)]),
      new Set(),
      1.0, // scanRatio — scan all messages
      logger,
    );

    // Core assertion: the revert path restored the ACTUAL original content,
    // not the summary. Fails pre-fix (content would be the summary text).
    expect(messages[0].content).toBe(originalContent);
    // Full message equality modulo the intended _offloaded marker (which the
    // revert path sets deliberately so later cascade rounds skip this block).
    expect(messages[0]).toEqual({ ...originalSnapshot, _offloaded: true });

    // A successfully-reverted block is NOT a replacement.
    expect(result.replacedCount).toBe(0);
    expect(result.replacedDetails).toHaveLength(0);
    expect(result.replacedToolCallIds).toEqual([]);

    // The revert path was entered and restoration SUCCEEDED, so the
    // regression counter must not have fired.
    expect(result.revertFailedCount).toBe(0);

    // The block is still marked _offloaded so later cascade rounds skip it.
    expect(messages[0]._offloaded).toBe(true);
  });

  it("revert_failed stays 0 across normal operation (mixed shorter + longer summaries)", () => {
    const shortOriginal = "x".repeat(500); // long original → summary is a real win
    const longOriginal = "tiny"; // 4 chars → summary will be over-length
    const messages = [
      makeToolResult("tc_short", shortOriginal),
      makeToolResult("tc_long", longOriginal),
      { role: "user", content: "filler tail message" },
    ];
    const originalShort = messages[0].content;
    const originalLong = messages[1].content;

    const entries = [
      // Modest summary (~40 chars) — much shorter than 500-char original → replaced.
      makeEntry("tc_short", "ok: printed 500 x's", 9),
      // Huge summary vs 4-char original → revert path.
      makeEntry(
        "tc_long",
        "An absurdly long summary describing a four-character output in exhaustive, unnecessary detail. ".repeat(2),
        8,
      ),
    ];

    const result = compressByScoreCascade(messages, makeMap(entries), new Set(), 1.0, logger);

    // Counter exercised: revert path entered (tc_long) but never failed.
    expect(result.revertFailedCount).toBe(0);

    // replacedCount reflects only the block that was actually replaced —
    // the reverted block does not inflate the metric.
    expect(result.replacedCount).toBe(1);
    expect(result.replacedToolCallIds).toEqual(["tc_short"]);
    expect(result.replacedDetails.map((d) => d.toolCallId)).toEqual(["tc_short"]);

    // tc_short was replaced with its summary; tc_long was restored verbatim.
    expect(messages[0].content).not.toBe(originalShort);
    expect(String(messages[0].content)).toContain("[Offloaded Tool Result");
    expect(messages[1].content).toBe(originalLong);
  });

  it("revert_failed stays 0 when nothing triggers compression at all", () => {
    const messages = [
      makeToolResult("tc_none", "ordinary output of moderate length"),
      { role: "user", content: "filler tail message" },
    ];
    // No offload entries → zero candidates → early return.
    const result = compressByScoreCascade(messages, new Map(), new Set(), 1.0, logger);
    expect(result.revertFailedCount).toBe(0);
    expect(result.replacedCount).toBe(0);
    expect(messages[0].content).toBe("ordinary output of moderate length");
  });
});
