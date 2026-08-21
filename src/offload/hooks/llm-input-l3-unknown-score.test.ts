/**
 * Regression tests — explicit unknown score in the mild cascade.
 *
 * When L1 extraction fails, the entry was stored with `score: 0`.
 * `score` means *replaceability* — high is safe to discard, low is precious —
 * so `0` read as "never replace this", and the mild cascade (floor 1) would
 * never touch it. One value carried two incompatible meanings: "definitely
 * keep" and "we don't know". The entries the system understood least became
 * the ones it would never compress.
 *
 * Fix: represent unknown as `score: null` with its own explicit
 * position in the ordering — after every scored entry (neither maximally
 * precious nor maximally disposable) and ahead of unknowns whose retries are
 * exhausted. Order: scored-safe → scored-risky → unknown → exhausted-unknown.
 *
 * These tests fail on the pre-fix code: `entry.score ?? 5` coerces a null
 * score to 5, so an unknown entry is treated as a *scored-safe* entry and is
 * compressed BEFORE genuinely precious scored entries — and no
 * `degraded_entry_rate` metric exists at all.
 */
import { describe, it, expect, afterEach } from "vitest";
import { compressByScoreCascade } from "./llm-input-l3.js";
import { setReporter, resetReporter, type IReporter } from "../../core/report/reporter.js";
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

function makeEntry(
  toolCallId: string,
  summary: string,
  score: number | null,
  extra: Record<string, unknown> = {},
): OffloadEntry {
  return {
    tool_call_id: toolCallId,
    node_id: "001-N1",
    tool_call: `bash(command="cat huge.log")`,
    summary,
    result_ref: "offload/001-N1.json",
    score,
    ...extra,
  } as unknown as OffloadEntry;
}

function makeMap(entries: OffloadEntry[]): Map<string, OffloadEntry> {
  const m = new Map<string, OffloadEntry>();
  for (const e of entries) m.set(e.tool_call_id, e);
  return m;
}

afterEach(() => {
  resetReporter();
});

describe("unknown score has its own explicit ordering tier", () => {
  it("an unknown (score:null) entry is compressed only AFTER scored entries, never before them", () => {
    const big = "x".repeat(500);
    const messages = [
      makeToolResult("tc_scored", big),
      makeToolResult("tc_unknown", big),
      { role: "user", content: "filler tail message" },
    ];
    const unknownOriginal = messages[1].content;

    const entries = [
      // A genuinely precious, low-replaceability scored entry.
      makeEntry("tc_scored", "ok", 2),
      // A degraded entry whose score is UNKNOWN (L1 extraction failed).
      makeEntry("tc_unknown", "[L1 degraded] bash: ...", null),
    ];

    // minCount=1: the cascade needs exactly one replacement.
    const result = compressByScoreCascade(
      messages,
      makeMap(entries),
      new Set(),
      1.0,
      logger,
      1, // minCount
      7, // initialScore
    );

    // The scored entry must be chosen first. Pre-fix, the null score is
    // coerced to 5 via `?? 5`, so the unknown entry outranks the scored one
    // and is replaced first.
    expect(result.replacedToolCallIds).toEqual(["tc_scored"]);
    // The unknown entry is untouched this round.
    expect(messages[1].content).toBe(unknownOriginal);
    expect(messages[1]._offloaded).toBeUndefined();
  });

  it("unknown entries sit ABOVE exhausted-retry unknowns in the ordering", () => {
    const big = "x".repeat(500);
    const messages = [
      makeToolResult("tc_low", big),
      makeToolResult("tc_unk", big),
      makeToolResult("tc_exhausted", big),
      { role: "user", content: "filler tail message" },
    ];
    const exhaustedOriginal = messages[2].content;

    const entries = [
      makeEntry("tc_low", "ok", 2),
      makeEntry("tc_unk", "[L1 degraded] a", null),
      makeEntry("tc_exhausted", "[L1 degraded] b", null, { l1RetriesExhausted: true }),
    ];

    // minCount=2: cascade must make two replacements.
    const result = compressByScoreCascade(
      messages,
      makeMap(entries),
      new Set(),
      1.0,
      logger,
      2, // minCount
      7,
    );

    // Order: scored (tc_low) → unknown (tc_unk). The exhausted unknown is the
    // very last resort and must NOT be touched while fresher candidates exist.
    expect(result.replacedToolCallIds).toEqual(["tc_low", "tc_unk"]);
    expect(messages[2].content).toBe(exhaustedOriginal);
    expect(messages[2]._offloaded).toBeUndefined();
  });

  it("plan-conformance: three failed-extraction entries under pressure — at least one is touched", () => {
    // Plan.md test: "build a fixture with three failed-extraction entries
    // and put the session under memory pressure. Assert the resulting plan
    // touches at least one of them." With the fix, unknown entries are no
    // longer frozen at the precious end — they are touchable once scored
    // candidates are gone.
    const big = "x".repeat(500);
    const messages = [
      makeToolResult("tc_d1", big),
      makeToolResult("tc_d2", big),
      makeToolResult("tc_d3", big),
      { role: "user", content: "filler tail message" },
    ];
    const entries = [
      makeEntry("tc_d1", "[L1 degraded] 1", null),
      makeEntry("tc_d2", "[L1 degraded] 2", null),
      makeEntry("tc_d3", "[L1 degraded] 3", null),
    ];

    const result = compressByScoreCascade(
      messages,
      makeMap(entries),
      new Set(),
      1.0,
      logger,
      1,
      7,
    );

    expect(result.replacedCount).toBeGreaterThanOrEqual(1);
  });

  it("surfaces a degraded_entry_rate metric when unknown-score entries flow through the cascade", () => {
    const events: Array<{ event?: string; [k: string]: unknown }> = [];
    const capture: IReporter = {
      reportFunc: (_category, payload) => {
        events.push(payload);
      },
    };
    setReporter(capture);

    const big = "x".repeat(500);
    const messages = [
      makeToolResult("tc_d1", big),
      { role: "user", content: "filler tail message" },
    ];
    const entries = [makeEntry("tc_d1", "[L1 degraded] 1", null)];

    compressByScoreCascade(messages, makeMap(entries), new Set(), 1.0, logger, 1, 7);

    const evt = events.find((e) => e.event === "degraded_entry_rate");
    // Pre-fix: no such event exists at all.
    expect(evt).toBeDefined();
    expect(typeof evt?.unknown).toBe("number");
    expect((evt?.unknown as number) >= 1).toBe(true);
  });
});
