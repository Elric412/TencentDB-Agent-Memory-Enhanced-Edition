/**
 * A parse failure during extraction must NOT look like
 * "nothing worth remembering."
 *
 * Plan.md §5: parseExtractionResult currently returns [] when the
 * model's output cannot be parsed — exactly what a legitimately uneventful
 * conversation produces, so downstream code and metrics cannot tell the two
 * apart. Fix: throw a typed ExtractionParseError, count it as
 * l1_parse_failure_rate, and do not report a clean zero-extraction turn.
 *
 * Test: feed the parser malformed JSON and assert the failure counter
 * increments; assert also that the pipeline does NOT report a clean
 * zero-extraction turn.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  extractL1Memories,
  ExtractionParseError,
} from "./l1-extractor.js";
import type { LLMRunner } from "../types.js";
import { setReporter, resetReporter } from "../report/reporter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** A message batch that will survive the shouldExtractL1 content filter. */
const messages = [
  { role: "user", content: "Please remember that I prefer dark roast coffee in the morning.", timestamp: "2026-01-01T09:00:00Z" },
  { role: "assistant", content: "Got it, noted your coffee preference.", timestamp: "2026-01-01T09:00:01Z" },
] as any;

function baseParams(llmRunner: LLMRunner) {
  return {
    sessionKey: "sess-f11",
    sessionId: "sess-f11",
    baseDir: "/tmp/f11-unused",
    messages,
    config: {},
    logger: noopLogger,
    options: {
      enableDedup: false,
      llmRunner,
    },
  } as any;
}

describe("parse failure is not a clean zero-extraction", () => {
  afterEach(() => {
    resetReporter();
  });

  it("throws a typed ExtractionParseError when the model output has no JSON array", async () => {
    const llmRunner: LLMRunner = {
      run: async () => "I'm sorry, I cannot extract anything from this conversation.",
    };

    await expect(extractL1Memories(baseParams(llmRunner))).rejects.toBeInstanceOf(ExtractionParseError);
  });

  it("throws a typed ExtractionParseError when the JSON is syntactically broken", async () => {
    const llmRunner: LLMRunner = {
      run: async () => '[{"scene_name": "coffee", "memories": [ { "content": "broken', // truncated mid-array
    };

    await expect(extractL1Memories(baseParams(llmRunner))).rejects.toBeInstanceOf(ExtractionParseError);
  });

  it("increments the l1_parse_failure_rate counter on parse failure", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    setReporter({
      reportFunc(_category: string, payload: Record<string, unknown>) {
        payloads.push(payload);
      },
    });

    const llmRunner: LLMRunner = { run: async () => "no json here at all" };

    await expect(extractL1Memories(baseParams(llmRunner))).rejects.toBeInstanceOf(ExtractionParseError);

    const failures = payloads.filter((p) => p.event === "l1_parse_failure_rate");
    expect(failures.length).toBe(1);
    expect(failures[0].sessionKey).toBe("sess-f11");
  });

  it("does NOT report a clean l1_extraction success event on parse failure", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    setReporter({
      reportFunc(_category: string, payload: Record<string, unknown>) {
        payloads.push(payload);
      },
    });

    const llmRunner: LLMRunner = { run: async () => "no json here at all" };

    await expect(extractL1Memories(baseParams(llmRunner))).rejects.toBeInstanceOf(ExtractionParseError);

    const successes = payloads.filter((p) => p.event === "l1_extraction");
    expect(successes.length).toBe(0);
  });

  it("still returns a clean zero-extraction result when the model legitimately extracts nothing", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    setReporter({
      reportFunc(_category: string, payload: Record<string, unknown>) {
        payloads.push(payload);
      },
    });

    // Well-formed JSON, no scenes / no memories — a genuine "nothing to remember" turn
    const llmRunner: LLMRunner = { run: async () => "[]" };

    const result = await extractL1Memories(baseParams(llmRunner));
    expect(result.success).toBe(true);
    expect(result.extractedCount).toBe(0);

    // No parse failure counted
    expect(payloads.filter((p) => p.event === "l1_parse_failure_rate").length).toBe(0);
  });
});
