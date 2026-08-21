/**
 * Degraded entries get a retry queue and an explicit unknown.
 *
 * When the L1 backend fails past its retry budget, the affected tool pairs are
 * written as degraded entries carrying `score: null` (an explicit unknown,
 * distinct from 0 — see F3) and enqueued here for L1 retry with exponential
 * backoff against the existing serial queue. Until a retry succeeds the entry
 * stays unknown: excluded from neither cascades nor protection, but ordered
 * after every scored entry (see llm-input-l3.ts cascade tiering).
 *
 * The pool is bounded (config `l1DegradedRetryPoolCap`, default 10). Past the
 * cap the oldest pending unknown is evicted first: its entry is marked
 * `l1RetriesExhausted` in offload.jsonl, after which it becomes the last
 * resort in the mild cascade ordering. An item whose retry attempts are all
 * consumed is likewise marked exhausted rather than silently dropped.
 *
 * Queue state is persisted per session in `degraded-retry-<session>.json`
 * (via the storage readStateFile/writeStateFile helpers) so retries survive
 * restarts; in-memory degradation is acceptable on load failure.
 */
import {
  readStateFile,
  writeStateFile,
  readAllOffloadEntries,
  rewriteAllOffloadEntries,
  type StorageContext,
} from "./storage.js";
import type { PluginLogger, ToolPair } from "./types.js";

/** Maximum L1 retry attempts for a degraded item before it is exhausted. */
export const DEGRADED_MAX_RETRY_ATTEMPTS = 3;
/** Base backoff delay in milliseconds; attempt n waits base * 2^(n-1). */
export const DEGRADED_RETRY_BASE_DELAY_MS = 30_000;

export interface DegradedRetryItem {
  /** The original tool pairs awaiting a fresh L1 summarization attempt. */
  pairs: ToolPair[];
  /** tool_call_ids of the degraded entries these pairs produced. */
  toolCallIds: string[];
  /** Number of retry attempts already consumed (0 = never retried yet). */
  attempts: number;
  /** Epoch ms before which the next retry must not be attempted. */
  nextRetryAtMs: number;
  /** ISO timestamp of the original degradation (for FIFO eviction). */
  enqueuedAt: string;
}

interface DegradedQueueFile {
  version: 1;
  items: DegradedRetryItem[];
}

function queueFilePath(ctx: StorageContext): string {
  // Sibling of boundaries-<session>.jsonl; keep the naming convention.
  return `${ctx.dataDir}/degraded-retry-${ctx.sessionId}.json`;
}

export class DegradedRetryQueue {
  private items: DegradedRetryItem[] = [];
  private loaded = false;

  constructor(
    private readonly ctx: StorageContext,
    private readonly logger: PluginLogger,
    private readonly poolCap: number,
  ) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readStateFile<DegradedQueueFile>(
        { ...this.ctx, stateFile: queueFilePath(this.ctx) } as StorageContext,
        { version: 1, items: [] },
      );
      this.items = Array.isArray(raw?.items) ? raw.items : [];
    } catch (err) {
      this.logger.warn?.(`[context-offload] degraded queue load failed, starting empty: ${err}`);
      this.items = [];
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    try {
      await writeStateFile(
        { ...this.ctx, stateFile: queueFilePath(this.ctx) } as StorageContext,
        { version: 1, items: this.items } satisfies DegradedQueueFile,
      );
    } catch (err) {
      this.logger.warn?.(`[context-offload] degraded queue save failed: ${err}`);
    }
  }

  get size(): number {
    return this.items.length;
  }

  /** Number of items whose retry attempts are NOT yet exhausted. */
  pendingCount(): number {
    return this.items.filter((it) => it.attempts < DEGRADED_MAX_RETRY_ATTEMPTS).length;
  }

  /** Snapshot for tests/inspection. */
  snapshot(): ReadonlyArray<DegradedRetryItem> {
    return this.items.map((it) => ({ ...it, pairs: [...it.pairs], toolCallIds: [...it.toolCallIds] }));
  }

  /**
   * Enqueue newly degraded pairs. If the pool is at capacity, the OLDEST
   * pending item is evicted first: its degraded entries are marked
   * `l1RetriesExhausted` in offload.jsonl (bounded protection, per E9).
   */
  async enqueue(pairs: ToolPair[], toolCallIds: string[]): Promise<void> {
    await this.load();
    while (this.pendingCount() >= this.poolCap && this.items.length > 0) {
      const oldestIdx = this.items.findIndex((it) => it.attempts < DEGRADED_MAX_RETRY_ATTEMPTS);
      if (oldestIdx === -1) break;
      const evicted = this.items.splice(oldestIdx, 1)[0];
      this.logger.warn?.(
        `[context-offload] degraded retry pool at cap (${this.poolCap}): evicting oldest item ` +
        `(${evicted.toolCallIds.length} entries → exhausted)`,
      );
      await this.markExhausted(evicted.toolCallIds);
    }
    this.items.push({
      pairs,
      toolCallIds,
      attempts: 0,
      nextRetryAtMs: Date.now() + DEGRADED_RETRY_BASE_DELAY_MS,
      enqueuedAt: new Date().toISOString(),
    });
    await this.save();
  }

  /**
   * Pop the next item whose backoff has elapsed. Returns null when nothing is
   * due. Items with no attempts left are marked exhausted and removed.
   */
  async dequeueDue(nowMs = Date.now()): Promise<DegradedRetryItem | null> {
    await this.load();
    // Sweep fully-exhausted items first (they never become due again).
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].attempts >= DEGRADED_MAX_RETRY_ATTEMPTS) {
        const dead = this.items.splice(i, 1)[0];
        await this.markExhausted(dead.toolCallIds);
      }
    }
    const idx = this.items.findIndex((it) => it.nextRetryAtMs <= nowMs);
    if (idx === -1) {
      await this.save();
      return null;
    }
    const item = this.items.splice(idx, 1)[0];
    await this.save();
    return item;
  }

  /**
   * Record the outcome of a retry attempt. On failure the item is re-enqueued
   * with exponential backoff; once attempts are exhausted the degraded entries
   * are marked `l1RetriesExhausted` so the cascade treats them as last resort.
   */
  async recordResult(item: DegradedRetryItem, success: boolean): Promise<void> {
    await this.load();
    if (success) return; // already removed by dequeueDue
    const attempts = item.attempts + 1;
    const next: DegradedRetryItem = {
      ...item,
      attempts,
      // Exponential backoff: attempt 1 waited BASE, attempt 2 waits 2×BASE,
      // attempt 3 waits 4×BASE.
      nextRetryAtMs: Date.now() + DEGRADED_RETRY_BASE_DELAY_MS * 2 ** attempts,
    };
    if (next.attempts >= DEGRADED_MAX_RETRY_ATTEMPTS) {
      this.logger.warn?.(
        `[context-offload] retries exhausted for ${item.toolCallIds.length} degraded entries — marking l1RetriesExhausted`,
      );
      await this.markExhausted(next.toolCallIds);
    } else {
      this.items.push(next);
    }
    await this.save();
  }

  /** Mark the given degraded entries as retry-exhausted in offload.jsonl. */
  private async markExhausted(toolCallIds: string[]): Promise<void> {
    if (toolCallIds.length === 0) return;
    try {
      const ids = new Set(toolCallIds);
      const entries = await readAllOffloadEntries(this.ctx);
      let changed = false;
      for (const entry of entries) {
        if (ids.has(entry.tool_call_id) && !entry.l1RetriesExhausted) {
          entry.l1RetriesExhausted = true;
          changed = true;
        }
      }
      if (changed) await rewriteAllOffloadEntries(this.ctx, entries);
    } catch (err) {
      this.logger.warn?.(`[context-offload] markExhausted failed: ${err}`);
    }
  }
}
