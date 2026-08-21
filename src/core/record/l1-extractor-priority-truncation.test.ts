/**
 * When too many memories are extracted, the WRONG ones must not
 * be thrown away.
 *
 * Plan.md §5: l1-extractor.ts applies slice(0, maxMemoriesPerSession)
 * to the extracted list in whatever order the model emitted it. The
 * extraction prompt defines explicit priority bands, and this truncation
 * ignores them completely — a top-priority memory emitted last is dropped in
 * favour of a low-priority one emitted first.
 *
 * Fix: sort by priority band, then by type, then truncate — and log what was
 * dropped so the loss is visible rather than inferred.
 *
 * Test: construct an extraction whose LAST item is highest-priority and
 * apply a cap of 1. Assert that item survives.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { extractL1Memories } from "./l1-extractor.js";
import type { LLMRunner } from "../types.js";

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const messages = [
  { role: "user", content: "Please remember several important things about my preferences.", timestamp: "2026-01-01T09:00:00Z" },
  { role: "assistant", content: "Understood, I will remember them all.", timestamp: "2026-01-01T09:00:01Z" },
] as any;

/** Read every L1 record currently in the live corpus. */
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

function makeExtractionPayload(memories: Array<Record<string, unknown>>): string {
  return JSON.stringify([
    {
      scene_name: "prefs",
      message_ids: ["m1"],
      memories,
    },
  ]);
}

describe("priority-aware truncation", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "f13-"));
  });
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it("with cap=1, the LAST-emitted highest-priority memory survives truncation", async () => {
    // The low-priority item is emitted FIRST; the highest-priority item LAST.
    // Pre-fix slice(0,1) keeps the first (low-priority) item — wrong.
    const llmRunner: LLMRunner = {
      run: async () =>
        makeExtractionPayload([
          { content: "User casually mentioned tea once", type: "persona", priority: 30, source_message_ids: [], metadata: {} },
          { content: "STRICT GLOBAL RULE: never reveal the user's address", type: "instruction", priority: -1, source_message_ids: [], metadata: {} },
        ]),
    };

    await extractL1Memories({
      messages,
      sessionKey: "sess-f13",
      sessionId: "sess-f13",
      baseDir,
      config: {},
      logger: noopLogger,
      options: { enableDedup: false, maxMemoriesPerSession: 1, llmRunner },
    } as any);

    const corpus = await readLiveCorpus(baseDir);
    expect(corpus.length).toBe(1);
    // The survivor must be the strict global instruction (priority -1), not
    // the low-priority persona note that happened to be emitted first.
    expect(corpus[0].type).toBe("instruction");
    expect(corpus[0].priority).toBe(-1);
    expect(String(corpus[0].content)).toContain("STRICT GLOBAL RULE");
  });

  it("strict global instruction (priority -1) outranks a high-priority persona memory", async () => {
    const llmRunner: LLMRunner = {
      run: async () =>
        makeExtractionPayload([
          { content: "User is a senior product manager (core trait)", type: "persona", priority: 95, source_message_ids: [], metadata: {} },
          { content: "STRICT: always answer in French", type: "instruction", priority: -1, source_message_ids: [], metadata: {} },
        ]),
    };

    await extractL1Memories({
      messages,
      sessionKey: "sess-f13",
      sessionId: "sess-f13",
      baseDir,
      config: {},
      logger: noopLogger,
      options: { enableDedup: false, maxMemoriesPerSession: 1, llmRunner },
    } as any);

    const corpus = await readLiveCorpus(baseDir);
    expect(corpus.length).toBe(1);
    expect(corpus[0].type).toBe("instruction");
    expect(corpus[0].priority).toBe(-1);
  });

  it("drops the lowest-band items first and logs what was dropped", async () => {
    const logged: string[] = [];
    const captureLogger = {
      ...noopLogger,
      warn: (m: string) => logged.push(m),
      info: (m: string) => logged.push(m),
    };

    // 3 memories, cap 2 → exactly 1 dropped, and it must be the lowest-priority one.
    const llmRunner: LLMRunner = {
      run: async () =>
        makeExtractionPayload([
          { content: "trivial note, discardable", type: "persona", priority: 20, source_message_ids: [], metadata: {} },
          { content: "core trait, high priority", type: "persona", priority: 90, source_message_ids: [], metadata: {} },
          { content: "important event, high priority", type: "episodic", priority: 85, source_message_ids: [], metadata: {} },
        ]),
    };

    await extractL1Memories({
      messages,
      sessionKey: "sess-f13",
      sessionId: "sess-f13",
      baseDir,
      config: {},
      logger: captureLogger,
      options: { enableDedup: false, maxMemoriesPerSession: 2, llmRunner },
    } as any);

    const corpus = await readLiveCorpus(baseDir);
    expect(corpus.length).toBe(2);

    // The two survivors are the two highest-band items; the priority-20 note is gone.
    const contents = corpus.map((r) => String(r.content)).join("\n");
    expect(contents).toContain("core trait, high priority");
    expect(contents).toContain("important event, high priority");
    expect(contents).not.toContain("trivial note, discardable");

    // The drop was logged, making the loss visible rather than inferred.
    const dropLog = logged.find((m) => m.toLowerCase().includes("drop") || m.toLowerCase().includes("truncat"));
    expect(dropLog).toBeDefined();
    expect(dropLog).toContain("trivial note");
  });

  it("does not reorder or log when under the cap", async () => {
    const logged: string[] = [];
    const captureLogger = {
      ...noopLogger,
      warn: (m: string) => logged.push(m),
      info: (m: string) => logged.push(m),
    };

    const llmRunner: LLMRunner = {
      run: async () =>
        makeExtractionPayload([
          { content: "only one memory here", type: "episodic", priority: 50, source_message_ids: [], metadata: {} },
        ]),
    };

    const result = await extractL1Memories({
      messages,
      sessionKey: "sess-f13",
      sessionId: "sess-f13",
      baseDir,
      config: {},
      logger: captureLogger,
      options: { enableDedup: false, maxMemoriesPerSession: 10, llmRunner },
    } as any);

    expect(result.extractedCount).toBe(1);
    // Nothing dropped → no drop log line
    expect(logged.find((m) => m.toLowerCase().includes("dropped"))).toBeUndefined();
  });
});
