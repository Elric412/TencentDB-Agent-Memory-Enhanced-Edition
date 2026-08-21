/**
 * L1 Memory Extractor: extracts structured memories from L0 conversation messages
 * using a single LLM call with JSON-mode structured output.
 *
 * v3: Aligned with Kenty's prompt — scene segmentation + memory extraction in one call,
 * followed by batch conflict detection.
 *
 * Pipeline:
 * 1. Read recent messages from L0 (split into background + new)
 * 2. Call LLM to extract scene-segmented memories
 * 3. Batch conflict detection against existing records
 * 4. Write to L1 JSONL files
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ConversationMessage } from "../conversation/l0-recorder.js";
import { EXTRACT_MEMORIES_SYSTEM_PROMPT, formatExtractionPrompt } from "../prompts/l1-extraction.js";
import { batchDedup, DedupFailureError } from "./l1-dedup.js";
import { writeMemory, generateMemoryId } from "./l1-writer.js";
import type { ExtractedMemory, MemoryRecord, MemoryType, DedupDecision } from "./l1-writer.js";
import { CleanContextRunner } from "../../utils/clean-context-runner.js";
import { sanitizeJsonForParse, shouldExtractL1 } from "../../utils/sanitize.js";
import type { IMemoryStore } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";
import { report } from "../report/reporter.js";
import type { LLMRunner, Logger } from "../types.js";

const TAG = "[memory-tdai][l1-extractor]";

// ============================
// Pending-dedup quarantine
// ============================
// When a batch's dedup judgment fails, the batch is quarantined here
// (one JSONL file per session, under <baseDir>/pending-dedup/) and retried
// on a later run instead of being committed to the live corpus as verified.
// Records already stored fail-open carry metadata.dedup="unverified".

function pendingDedupDir(baseDir: string): string {
  return path.join(baseDir, "pending-dedup");
}

function pendingDedupFile(baseDir: string, sessionKey: string): string {
  // Keep the filename filesystem-safe regardless of sessionKey contents.
  const safe = sessionKey.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(pendingDedupDir(baseDir), `${safe}.jsonl`);
}

/** Append a quarantined batch (one record per line) to the session's pending file. */
export async function appendPendingDedup(
  baseDir: string,
  sessionKey: string,
  memories: Array<ExtractedMemory & { record_id: string }>,
): Promise<void> {
  await fs.mkdir(pendingDedupDir(baseDir), { recursive: true });
  const file = pendingDedupFile(baseDir, sessionKey);
  const lines = memories
    .map((m) => JSON.stringify({ ...m, metadata: { ...m.metadata, dedup: "unverified" }, dedup: "unverified", quarantinedAt: new Date().toISOString() }))
    .join("\n");
  await fs.appendFile(file, lines + "\n", "utf-8");
}

/** Read all quarantined memories for a session (empty if none). */
export async function readPendingDedup(
  baseDir: string,
  sessionKey: string,
): Promise<Array<Record<string, unknown>>> {
  const file = pendingDedupFile(baseDir, sessionKey);
  let text: string;
  try {
    text = await fs.readFile(file, "utf-8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((x): x is Record<string, unknown> => x !== null);
}

/** Count quarantined memories for a session. */
export async function countPendingDedup(baseDir: string, sessionKey: string): Promise<number> {
  return (await readPendingDedup(baseDir, sessionKey)).length;
}

/** Remove the quarantine for a session (after a successful retry or manual clear). */
export async function clearPendingDedup(baseDir: string, sessionKey: string): Promise<void> {
  try {
    await fs.rm(pendingDedupFile(baseDir, sessionKey), { force: true });
  } catch {
    /* ignore */
  }
}

// ============================
// Types
// ============================

/** A scene segment with its extracted memories (LLM output) */
interface SceneSegment {
  scene_name: string;
  message_ids: string[];
  memories: Array<{
    content: string;
    type: string;
    priority: number;
    source_message_ids: string[];
    metadata: Record<string, unknown>;
  }>;
}

/**
 * Thrown when the LLM's extraction output cannot be parsed into the
 * expected SceneSegment[] shape. This is deliberately a distinguishable
 * failure: before this change, a parse failure was returned as `[]`, which
 * is exactly what a legitimately uneventful conversation produces, so
 * downstream code and metrics could not tell "nothing worth remembering"
 * apart from "the extractor broke."
 */
export class ExtractionParseError extends Error {
  /** Machine-readable failure reason. */
  readonly reason: "no_json_array" | "not_an_array" | "invalid_json";
  /** Truncated preview of the raw model output (for diagnostics). */
  readonly rawPreview: string;

  constructor(reason: ExtractionParseError["reason"], raw: string, cause?: unknown) {
    const preview = raw.length > 2048 ? `${raw.slice(0, 2048)}…(+${raw.length - 2048})` : raw;
    super(`L1 extraction parse failure (${reason}): rawLen=${raw.length}, rawPreview=${JSON.stringify(preview)}`);
    this.name = "ExtractionParseError";
    this.reason = reason;
    this.rawPreview = preview;
    if (cause !== undefined) this.cause = cause;
  }
}

export interface L1ExtractionResult {
  /** Whether extraction succeeded */
  success: boolean;
  /** Number of memories extracted */
  extractedCount: number;
  /** Number of memories actually stored (after dedup) */
  storedCount: number;
  /** The memory records that were stored */
  records: MemoryRecord[];
  /** Scene names detected during extraction */
  sceneNames: string[];
  /** Last scene name (for continuity in next extraction) */
  lastSceneName?: string;
}

// ============================
// Core function
// ============================

/**
 * Run the full L1 extraction pipeline on conversation messages.
 *
 * @param messages - Filtered conversation messages (from L0 or directly from hook)
 * @param sessionKey - The session key
 * @param baseDir - Base data directory (~/.openclaw/memory-tdai/)
 * @param config - OpenClaw config (for LLM access)
 * @param options - Extraction options
 * @param logger - Optional logger
 */
export async function extractL1Memories(params: {
  messages: ConversationMessage[];
  sessionKey: string;
  sessionId?: string;
  baseDir: string;
  config: unknown;
  options?: {
    /** Max new messages to send in one extraction call */
    maxMessagesPerExtraction?: number;
    /** Max background messages for context */
    maxBackgroundMessages?: number;
    /** Enable conflict detection */
    enableDedup?: boolean;
    /** Max memories extracted per call */
    maxMemoriesPerSession?: number;
    /** LLM model override */
    model?: string;
    /** Previous scene name for continuity */
    previousSceneName?: string;
    /** Vector store for cosine similarity candidate recall */
    vectorStore?: IMemoryStore;
    /** Embedding service for computing query vectors */
    embeddingService?: EmbeddingService;
    /** Top-K candidates for conflict recall (default: 5) */
    conflictRecallTopK?: number;
    /** Override embedding timeout for capture-path calls (milliseconds) */
    embeddingTimeoutMs?: number;
    /**
     * Host-neutral LLM runner. When provided, used instead of creating
     * a CleanContextRunner (decouples from OpenClaw runtime).
     */
    llmRunner?: LLMRunner;
  };
  logger?: Logger;
  /** Plugin instance ID for metric reporting (optional — metrics skipped if absent) */
  instanceId?: string;
}): Promise<L1ExtractionResult> {
  const { messages, sessionKey, sessionId, baseDir, config, logger, instanceId: metricInstanceId } = params;
  const options = params.options ?? {};
  const maxNewMessages = options.maxMessagesPerExtraction ?? 10;
  const maxBgMessages = options.maxBackgroundMessages ?? 5;
  const enableDedup = options.enableDedup ?? true;
  const maxMemoriesPerSession = options.maxMemoriesPerSession ?? 10;

  if (messages.length === 0) {
    logger?.debug?.(`${TAG} No messages to extract from`);
    return { success: true, extractedCount: 0, storedCount: 0, records: [], sceneNames: [] };
  }

  const l1StartMs = Date.now();

  // Quality gate: filter messages through L1 extraction rules (length, symbols,
  // prompt injection, etc.) before sending to the LLM. L0 deliberately captures
  // everything; the strict filtering happens here at L1 stage.
  const qualifiedMessages = messages.filter((m) => shouldExtractL1(m.content));
  if (qualifiedMessages.length < messages.length) {
    logger?.debug?.(
      `${TAG} L1 quality filter: ${messages.length} → ${qualifiedMessages.length} messages ` +
      `(${messages.length - qualifiedMessages.length} filtered out)`,
    );
  }

  if (qualifiedMessages.length === 0) {
    logger?.debug?.(`${TAG} All messages filtered out by L1 quality gate`);
    return { success: true, extractedCount: 0, storedCount: 0, records: [], sceneNames: [] };
  }

  // Split messages into background (older) + new (recent)
  const newMessages = qualifiedMessages.slice(-maxNewMessages);
  const bgEndIdx = qualifiedMessages.length - newMessages.length;
  const backgroundMessages = bgEndIdx > 0
    ? qualifiedMessages.slice(Math.max(0, bgEndIdx - maxBgMessages), bgEndIdx)
    : [];

  logger?.debug?.(`${TAG} Extracting from ${newMessages.length} new messages (+ ${backgroundMessages.length} background) [${qualifiedMessages.length} qualified from ${messages.length} input]`);

  // Step 1: LLM extraction (scene segmentation + memory extraction)
  let scenes: SceneSegment[];
  try {
    scenes = await callLlmExtraction({
      newMessages,
      backgroundMessages,
      previousSceneName: options.previousSceneName,
      config,
      logger,
      model: options.model,
      llmRunner: options.llmRunner,
    });
    logger?.debug?.(`${TAG} LLM detected ${scenes.length} scene(s)`);
  } catch (err) {
    if (err instanceof ExtractionParseError) {
      // A parse failure is NOT "nothing worth remembering." Count it
      // separately (l1_parse_failure_rate) and propagate the typed error so
      // the turn is visibly broken — never a clean zero-extraction success.
      logger?.error(`${TAG} LLM extraction parse failed: ${err.message}`);
      report("l1_parse_failure_rate", {
        sessionKey,
        reason: err.reason,
        inputMessageCount: messages.length,
      });
      throw err;
    }
    logger?.error(`${TAG} LLM extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    return { success: false, extractedCount: 0, storedCount: 0, records: [], sceneNames: [] };
  }

  // Flatten all memories across scenes
  const allExtracted: ExtractedMemory[] = [];
  const sceneNames: string[] = [];

  for (const scene of scenes) {
    sceneNames.push(scene.scene_name);
    for (const mem of scene.memories) {
      const memType = normalizeType(mem.type);
      if (!memType) {
        logger?.warn?.(`${TAG} Skipping memory with invalid type "${mem.type}"`);
        continue;
      }
      allExtracted.push({
        content: mem.content,
        type: memType,
        priority: typeof mem.priority === "number" ? mem.priority : 50,
        source_message_ids: Array.isArray(mem.source_message_ids) ? mem.source_message_ids : [],
        metadata: mem.metadata ?? {},
        scene_name: scene.scene_name,
      });
    }
  }

  logger?.debug?.(`${TAG} Total extracted memories: ${allExtracted.length} across ${scenes.length} scene(s)`);

  if (allExtracted.length === 0) {
    return {
      success: true,
      extractedCount: 0,
      storedCount: 0,
      records: [],
      sceneNames,
      lastSceneName: sceneNames[sceneNames.length - 1],
    };
  }

  // Limit per session — priority-band aware, NOT naive emission order.
  // The extraction prompt defines explicit priority bands per type (and for
  // instructions, priority -1 is a *strict global rule* — the MOST precious,
  // not the least). Slicing the raw emitted order would drop a top-priority
  // memory that happened to be emitted last in favour of a low-priority one
  // emitted first. So: sort by priority band (desc), then by type, then
  // truncate — and log what was dropped so the loss is visible.
  let extracted = allExtracted;
  if (extracted.length > maxMemoriesPerSession) {
    const sorted = [...allExtracted]
      .map((m, i) => ({ m, i }))
      .sort((a, b) => {
        const bandDiff = priorityBandRank(b.m) - priorityBandRank(a.m);
        if (bandDiff !== 0) return bandDiff;
        const typeDiff = typeRank(a.m.type) - typeRank(b.m.type);
        if (typeDiff !== 0) return typeDiff;
        return a.i - b.i; // stable: preserve emission order within a band+type
      })
      .map((x) => x.m);

    const kept = sorted.slice(0, maxMemoriesPerSession);
    const dropped = sorted.slice(maxMemoriesPerSession);
    logger?.warn?.(
      `${TAG} Truncated extraction from ${allExtracted.length} to ${maxMemoriesPerSession} memories (priority-aware); ` +
      `dropped ${dropped.length}: [${dropped.map((d) => `"${d.content.slice(0, 60)}"(type=${d.type},priority=${d.priority})`).join(", ")}]`,
    );
    report("l1_extraction_truncated", {
      sessionKey,
      extracted: allExtracted.length,
      kept: kept.length,
      dropped: dropped.length,
      droppedItems: dropped.map((d) => ({ content: d.content.slice(0, 120), type: d.type, priority: d.priority })),
    });
    extracted = kept;
  }

  // Assign temporary IDs to extracted memories (needed for batch dedup)
  const memoriesWithIds = extracted.map((m) => ({
    ...m,
    record_id: generateMemoryId(),
  }));

  // Step 2: Batch Conflict Detection + Write
  let storedRecords: MemoryRecord[];

  if (enableDedup) {
    try {
      const decisions = await batchDedup({
        memories: memoriesWithIds,
        config,
        logger,
        model: options.model,
        vectorStore: options.vectorStore,
        embeddingService: options.embeddingService,
        conflictRecallTopK: options.conflictRecallTopK,
        embeddingTimeoutMs: options.embeddingTimeoutMs,
        llmRunner: options.llmRunner,
      });

      storedRecords = await applyDecisions({
        memoriesWithIds,
        decisions,
        baseDir,
        sessionKey,
        sessionId,
        logger,
        vectorStore: options.vectorStore,
        embeddingService: options.embeddingService,
      });
    } catch (err) {
      if (err instanceof DedupFailureError) {
        // Quarantine the batch to the pending area and retry it later,
        // instead of committing unverified duplicates to the live corpus.
        // The fail-open guarantee is preserved — every record is still
        // persisted — but each carries metadata.dedup="unverified" so recall
        // can deliberately down-weight it and metrics can observe the loss.
        logger?.warn?.(`${TAG} Batch dedup failed, quarantining ${memoriesWithIds.length} memories to pending-dedup: ${err.message}`);
        storedRecords = await storeAllDirectly(
          memoriesWithIds.map((m) => ({ ...m, metadata: { ...m.metadata, dedup: "unverified" as const } })),
          baseDir,
          sessionKey,
          sessionId,
          logger,
          options.vectorStore,
          options.embeddingService,
        );
        await appendPendingDedup(baseDir, sessionKey, memoriesWithIds);
        report("l1_dedup_failure", {
          sessionKey,
          reason: err.reason,
          batchSize: memoriesWithIds.length,
          quarantined: memoriesWithIds.length,
        });
      } else {
        logger?.warn?.(`${TAG} Batch dedup failed, storing all as new: ${err instanceof Error ? err.message : String(err)}`);
        storedRecords = await storeAllDirectly(memoriesWithIds, baseDir, sessionKey, sessionId, logger, options.vectorStore, options.embeddingService);
      }
    }
  } else {
    storedRecords = await storeAllDirectly(memoriesWithIds, baseDir, sessionKey, sessionId, logger, options.vectorStore, options.embeddingService);
  }

  logger?.info(`${TAG} Extraction complete: extracted=${extracted.length}, stored=${storedRecords.length}`);

  // ── l1_extraction metric ──
  if (metricInstanceId && logger) {
    // Build type distribution of stored memories
    const memoriesByType: Record<string, number> = {};
    for (const r of storedRecords) {
      memoriesByType[r.type] = (memoriesByType[r.type] ?? 0) + 1;
    }
    report("l1_extraction", {
      sessionKey,
      inputMessageCount: messages.length,
      memoriesExtracted: extracted.length,
      memoriesStored: storedRecords.length,
      memoriesStoredContent: storedRecords.map((r) => ({
        content: r.content,
        type: r.type,
        scene: r.scene_name ?? null,
      })),
      memoriesByType,
      totalDurationMs: Date.now() - l1StartMs,
      success: true,
      error: null,
    });
  }

  return {
    success: true,
    extractedCount: extracted.length,
    storedCount: storedRecords.length,
    records: storedRecords,
    sceneNames,
    lastSceneName: sceneNames[sceneNames.length - 1],
  };
}

// ============================
// LLM call
// ============================

/**
 * Call LLM to extract scene-segmented memories from conversation messages.
 */
async function callLlmExtraction(params: {
  newMessages: ConversationMessage[];
  backgroundMessages: ConversationMessage[];
  previousSceneName?: string;
  config: unknown;
  logger?: Logger;
  model?: string;
  /** Host-neutral LLM runner — when provided, used instead of CleanContextRunner. */
  llmRunner?: LLMRunner;
}): Promise<SceneSegment[]> {
  const { newMessages, backgroundMessages, previousSceneName, config, logger, model, llmRunner } = params;

  const userPrompt = formatExtractionPrompt({
    newMessages,
    backgroundMessages,
    previousSceneName,
  });

  // [l1-debug] ENTRY — what are we about to ask the LLM to extract?
  logger?.debug?.(
    `${TAG} [l1-debug] ENTRY taskId=l1-extraction, newMsgs=${newMessages.length}, bgMsgs=${backgroundMessages.length}, userPromptLen=${userPrompt.length}, sysPromptLen=${EXTRACT_MEMORIES_SYSTEM_PROMPT.length}, model=${model ?? "(default)"}, previousSceneName=${previousSceneName ? JSON.stringify(previousSceneName) : "(none)"}, runnerKind=${llmRunner ? "llmRunner" : "CleanContextRunner"}`,
  );

  let result: string;

  if (llmRunner) {
    // Use the host-neutral LLMRunner interface
    result = await llmRunner.run({
      prompt: userPrompt,
      systemPrompt: EXTRACT_MEMORIES_SYSTEM_PROMPT,
      taskId: "l1-extraction",
      timeoutMs: 180_000,
    });
  } else {
    // Fallback: create CleanContextRunner (OpenClaw path)
    const runner = new CleanContextRunner({
      config,
      modelRef: model,
      enableTools: false,
      logger,
    });

    result = await runner.run({
      prompt: userPrompt,
      systemPrompt: EXTRACT_MEMORIES_SYSTEM_PROMPT,
      taskId: "l1-extraction",
      timeoutMs: 180_000,
    });
  }

  return parseExtractionResult(result, logger);
}

/**
 * Parse the LLM's JSON response into SceneSegment array.
 * Expected format: [{scene_name, message_ids, memories: [...]}]
 */
function parseExtractionResult(raw: string, logger?: Logger): SceneSegment[] {
  try {
    // Strip markdown code block wrappers if present
    let cleaned = raw.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }

    // Try to extract JSON array
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      logger?.warn?.(`${TAG} No JSON array found in extraction response`);
      // [l1-debug] NO_JSON — dump the full raw so we can see what the LLM actually said
      const rawPreview = raw.slice(0, 2048);
      logger?.warn?.(
        `${TAG} [l1-debug] NO_JSON taskId=l1-extraction, rawLen=${raw.length}, cleanedLen=${cleaned.length}, rawFull=${JSON.stringify(rawPreview)}${raw.length > 2048 ? `…(+${raw.length - 2048})` : ""}`,
      );
      throw new ExtractionParseError("no_json_array", raw);
    }

    // Sanitize control characters inside JSON string literals that LLM may produce
    const sanitized = sanitizeJsonForParse(arrayMatch[0]);
    const parsed = JSON.parse(sanitized) as unknown[];

    if (!Array.isArray(parsed)) {
      logger?.warn?.(`${TAG} Extraction response is not an array`);
      throw new ExtractionParseError("not_an_array", raw);
    }

    const scenes: SceneSegment[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const s = item as Record<string, unknown>;

      scenes.push({
        scene_name: typeof s.scene_name === "string" ? s.scene_name : "未知情境",
        message_ids: Array.isArray(s.message_ids) ? s.message_ids.map(String) : [],
        memories: Array.isArray(s.memories)
          ? (s.memories as Array<Record<string, unknown>>)
              .filter((m) => m && typeof m === "object" && typeof m.content === "string" && (m.content as string).length > 0)
              .map((m) => ({
                content: String(m.content),
                type: String(m.type ?? "episodic"),
                priority: typeof m.priority === "number" ? m.priority : 50,
                source_message_ids: Array.isArray(m.source_message_ids) ? m.source_message_ids.map(String) : [],
                metadata: (m.metadata && typeof m.metadata === "object" ? m.metadata : {}) as Record<string, unknown>,
              }))
          : [],
      });
    }

    return scenes;
  } catch (err) {
    // Rethrow typed parse failures unchanged; convert anything else
    // (typically a JSON.parse SyntaxError) into the typed error so callers
    // never see an indistinguishable [] for a broken extraction.
    if (err instanceof ExtractionParseError) {
      throw err;
    }
    logger?.warn?.(`${TAG} Failed to parse extraction result: ${err instanceof Error ? err.message : String(err)}`);
    throw new ExtractionParseError("invalid_json", raw, err);
  }
}

// ============================
// Write helpers
// ============================

/**
 * Apply batch dedup decisions — write memories according to their decisions.
 */
async function applyDecisions(params: {
  memoriesWithIds: Array<ExtractedMemory & { record_id: string }>;
  decisions: DedupDecision[];
  baseDir: string;
  sessionKey: string;
  sessionId?: string;
  logger?: Logger;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
}): Promise<MemoryRecord[]> {
  const { memoriesWithIds, decisions, baseDir, sessionKey, sessionId, logger, vectorStore, embeddingService } = params;
  const storedRecords: MemoryRecord[] = [];

  // Build a map from record_id → decision
  const decisionMap = new Map<string, DedupDecision>();
  for (const d of decisions) {
    decisionMap.set(d.record_id, d);
  }

  for (const memoryWithId of memoriesWithIds) {
    const decision = decisionMap.get(memoryWithId.record_id) ?? {
      record_id: memoryWithId.record_id,
      action: "store" as const,
      target_ids: [],
    };

    try {
      const record = await writeMemory({
        memory: memoryWithId,
        decision,
        baseDir,
        sessionKey,
        sessionId,
        logger,
        vectorStore,
        embeddingService,
      });

      if (record) {
        storedRecords.push(record);
      }
    } catch (err) {
      logger?.warn?.(
        `${TAG} Write failed for memory "${memoryWithId.content.slice(0, 50)}...": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return storedRecords;
}

/**
 * Store all memories directly (no dedup).
 */
async function storeAllDirectly(
  memoriesWithIds: Array<ExtractedMemory & { record_id: string }>,
  baseDir: string,
  sessionKey: string,
  sessionId: string | undefined,
  logger?: Logger,
  vectorStore?: IMemoryStore,
  embeddingService?: EmbeddingService,
): Promise<MemoryRecord[]> {
  const storedRecords: MemoryRecord[] = [];

  for (const memoryWithId of memoriesWithIds) {
    try {
      const record = await writeMemory({
        memory: memoryWithId,
        decision: {
          record_id: memoryWithId.record_id,
          action: "store",
          target_ids: [],
        },
        baseDir,
        sessionKey,
        sessionId,
        logger,
        vectorStore,
        embeddingService,
      });
      if (record) {
        storedRecords.push(record);
      }
    } catch (err) {
      logger?.warn?.(
        `${TAG} Write failed for memory "${memoryWithId.content.slice(0, 50)}...": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return storedRecords;
}

// ============================
// Helpers
// ============================

const VALID_TYPES: MemoryType[] = ["persona", "episodic", "instruction"];

function normalizeType(raw: string): MemoryType | null {
  const lower = raw.toLowerCase().trim();
  if (VALID_TYPES.includes(lower as MemoryType)) {
    return lower as MemoryType;
  }
  // Handle legacy type names
  if (lower === "episode") return "episodic";
  if (lower === "instruct") return "instruction";
  if (lower === "preference") return "persona"; // fold preference into persona
  return null;
}

/**
 * Rank a memory into its prompt-defined priority band (higher = more
 * precious, kept first when truncating).
 *
 * Bands follow src/core/prompts/l1-extraction.ts:
 * - persona:    80-100 core trait · 50-70 general · <50 discardable
 * - episodic:   80-100 important · 60-70 normal · <60 discardable
 * - instruction: **-1 = strict global rule (the MOST precious memory there
 *   is)** · 90-100 core rule · 70-80 important · <70 discardable
 *
 * The instruction -1 case is why a naive "sort by priority descending" would
 * be wrong — the strict global rule sorts *lowest* numerically but must
 * never be truncated away.
 */
function priorityBandRank(m: { type: MemoryType; priority: number }): number {
  const p = m.priority;
  if (m.type === "instruction" && p === -1) return 4; // strict global rule — always kept first
  if (p >= 80) return 3;
  if (m.type === "persona" && p >= 50) return 2;
  if (m.type === "episodic" && p >= 60) return 2;
  if (m.type === "instruction" && p >= 70) return 2;
  return 1; // below the type's "discardable" floor
}

/**
 * Within the same priority band, keep instructions before persona
 * before episodic: a behavioural rule constrains every future turn, a
 * persona trait colours them, an event is the most re-derivable.
 */
function typeRank(type: MemoryType): number {
  switch (type) {
    case "instruction":
      return 0;
    case "persona":
      return 1;
    case "episodic":
      return 2;
    default:
      return 3;
  }
}
