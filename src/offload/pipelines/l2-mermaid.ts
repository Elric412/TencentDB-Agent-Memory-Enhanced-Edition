/**
 * L2 Mermaid Generation Pipeline (Independent Trigger):
 *
 * L2 is NO LONGER triggered directly from L1. Instead it runs independently:
 *   - Trigger condition A: offload.jsonl has >= l2NullThreshold entries with node_id=null
 *   - Trigger condition B: time since last L2 trigger exceeds l2TimeoutSeconds
 */
import { PLUGIN_DEFAULTS, type OffloadEntry, type PluginConfig, type PluginLogger } from "../types.js";
import {
  readAllOffloadEntries,
  rewriteAllOffloadEntries,
  type StorageContext,
} from "../storage.js";
import type { OffloadStateManager } from "../state-manager.js";
import { report } from "../../core/report/reporter.js";

function isHeartbeatEntry(entry: OffloadEntry): boolean {
  try {
    const tc = entry.tool_call ?? "";
    return tc.includes("HEARTBEAT.md");
  } catch {
    return false;
  }
}

function normalizeNodeMapping(raw: any): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== "string" || !k) continue;
    const s = typeof v === "string" ? v.trim() : v != null ? String(v).trim() : "";
    if (s) out[k] = s;
  }
  return out;
}

// ─── L2 Independent Trigger Check ─────────────────────────────────────────────

export async function checkL2Trigger(
  stateManager: OffloadStateManager,
  pluginConfig: Partial<PluginConfig> | undefined,
  logger: PluginLogger,
): Promise<{
  shouldTrigger: boolean;
  reason: string;
  entriesByMmd: Map<string, OffloadEntry[]>;
}> {
  const nullThreshold =
    pluginConfig?.l2NullThreshold ?? PLUGIN_DEFAULTS.l2NullThreshold;
  const timeoutSeconds =
    pluginConfig?.l2TimeoutSeconds ?? PLUGIN_DEFAULTS.l2TimeoutSeconds;
  const timeNeedsNewOffload =
    (pluginConfig as any)?.l2TimeTriggerRequiresNewOffload ??
    PLUGIN_DEFAULTS.l2TimeTriggerRequiresNewOffload;
  const waitRetrySeconds =
    (pluginConfig as any)?.l2WaitRetrySeconds ??
    PLUGIN_DEFAULTS.l2WaitRetrySeconds;

  const emptyResult = { shouldTrigger: false as const, reason: "", entriesByMmd: new Map<string, OffloadEntry[]>() };

  const allEntries = await readAllOffloadEntries(stateManager.ctx);
  const nowMs = Date.now();

  // Collect eligible null entries using boundary-based grouping
  const entriesByMmd = new Map<string, OffloadEntry[]>();
  let eligibleNullCount = 0;

  for (const entry of allEntries) {
    if (isHeartbeatEntry(entry)) continue;
    if (entry.node_id !== null && entry.node_id !== "wait") continue;

    // For "wait" entries, only include if they exceeded retry timeout
    if (entry.node_id === "wait") {
      const tsIso = entry.timestamp;
      if (tsIso) {
        const tsMs = new Date(tsIso).getTime();
        if (!Number.isNaN(tsMs) && (nowMs - tsMs) / 1000 < waitRetrySeconds) continue;
      }
    }

    // Resolve the owning boundary by the entry's durable seq, never by list
    // position: the read path backfills seq onto every entry, and seq stays
    // attached to its entry across entry-log rewrites that reorder rows.
    const boundary =
      typeof entry.seq === "number" ? stateManager.resolveBoundaryForSeq(entry.seq) : null;
    if (!boundary) continue;                       // no boundary coverage → skip
    if (boundary.result !== "long") continue;       // short task → skip
    if (!boundary.targetMmd) continue;              // no target mmd → skip

    if (entry.node_id === null) eligibleNullCount++;

    const mmd = boundary.targetMmd;
    let bucket = entriesByMmd.get(mmd);
    if (!bucket) { bucket = []; entriesByMmd.set(mmd, bucket); }
    // Dedup by tool_call_id within the same bucket
    if (entry.tool_call_id && bucket.some((e) => e.tool_call_id === entry.tool_call_id)) continue;
    bucket.push(entry);
  }

  const totalEligible = Array.from(entriesByMmd.values()).reduce((sum, arr) => sum + arr.length, 0);

  if (totalEligible === 0) {
    return { ...emptyResult, reason: "no eligible entries (boundary-filtered)" };
  }

  // Condition A: null count threshold
  if (eligibleNullCount >= nullThreshold) {
    return {
      shouldTrigger: true,
      reason: `null_count=${eligibleNullCount} >= threshold=${nullThreshold} (${entriesByMmd.size} mmd(s))`,
      entriesByMmd,
    };
  }

  // Condition B: timeout
  const lastL2Time = stateManager.getLastL2TriggerTime();
  if (lastL2Time) {
    const elapsed = (Date.now() - new Date(lastL2Time).getTime()) / 1000;
    if (elapsed >= timeoutSeconds) {
      if (timeNeedsNewOffload) {
        // Seq-based "new offload" test: only null entries beyond the seq
        // cursor of the last L2 pass count as new work. Entry timestamps are
        // not reliable for this — equal-millisecond writes or clock skew can
        // hide genuinely new rows, while seq is assigned monotonically at
        // append time.
        const lastProcessedSeq = stateManager.getLastProcessedSeq();
        const hasNewRows = allEntries.some(
          (e) =>
            e.node_id === null &&
            !isHeartbeatEntry(e) &&
            (lastProcessedSeq === null || (typeof e.seq === "number" && e.seq > lastProcessedSeq)),
        );
        if (!hasNewRows && totalEligible === eligibleNullCount) {
          return { ...emptyResult, reason: "timeout but no new offload rows" };
        }
      }
      return {
        shouldTrigger: true,
        reason: `timeout: ${elapsed.toFixed(0)}s >= ${timeoutSeconds}s (${entriesByMmd.size} mmd(s))`,
        entriesByMmd,
      };
    }
  } else {
    // No prior L2: check retry-wait entries or oldest null age
    const hasRetryWait = totalEligible > eligibleNullCount;
    if (hasRetryWait) {
      return {
        shouldTrigger: true,
        reason: `no prior L2 + retry-wait entries (${entriesByMmd.size} mmd(s))`,
        entriesByMmd,
      };
    }
    const nullEntries = allEntries.filter((e) => e.node_id === null && !isHeartbeatEntry(e));
    if (nullEntries.length > 0) {
      const oldestTs = nullEntries[0]?.timestamp;
      if (oldestTs) {
        const elapsed = (Date.now() - new Date(oldestTs).getTime()) / 1000;
        if (elapsed >= timeoutSeconds) {
          return {
            shouldTrigger: true,
            reason: `no prior L2 + oldest null entry age=${elapsed.toFixed(0)}s`,
            entriesByMmd,
          };
        }
      }
    }
  }

  return {
    ...emptyResult,
    reason: `null_count=${eligibleNullCount} < ${nullThreshold}, timeout not reached`,
  };
}

/**
 * Apply the model's `node_mapping` to "wait" entries — and nothing more.
 *
 * The guessing heuristic is deleted, not improved (Plan.md): when the model
 * omits a tool call from `node_mapping`, there is no better guess available,
 * only a more convincing one. Unmapped wait entries are therefore reset to
 * `node_id: null` (so they become eligible for a future L2 pass again) and
 * their count is surfaced as the `unmapped` metric / `unmapped_node_rate`
 * report event. No node id ever appears in the output that was not present in
 * the model's response.
 *
 * @returns `{ mapped, unmapped }` counts for the caller and for metrics.
 */
export async function backfillNodeIds(
  ctx: StorageContext,
  nodeMapping: Record<string, string>,
  waitIds: Set<string>,
  logger: PluginLogger,
): Promise<{ mapped: number; unmapped: number }> {
  const mapping = normalizeNodeMapping(nodeMapping);
  const allEntries = await readAllOffloadEntries(ctx);
  let changed = false;

  let mappedCount = 0;
  let unmappedCount = 0;

  for (const entry of allEntries) {
    const mapped = mapping[entry.tool_call_id];
    if (mapped) {
      if (entry.node_id !== mapped) changed = true;
      entry.node_id = mapped;
      mappedCount++;
      continue;
    }
    if (entry.node_id === "wait" && waitIds.has(entry.tool_call_id)) {
      // Gap in the model's response: leave the entry honestly unmapped (null)
      // instead of fabricating an attribution. It becomes eligible for the
      // next L2 pass via the null-entry trigger again.
      entry.node_id = null;
      changed = true;
      unmappedCount++;
    }
  }
  if (changed) {
    await rewriteAllOffloadEntries(ctx, allEntries);
  }
  if (unmappedCount > 0) {
    report("unmapped_node_rate", {
      source: "l2_backfill",
      mapped: mappedCount,
      unmapped: unmappedCount,
      total: waitIds.size,
      sessionId: ctx.sessionId,
    });
  }
  logger.debug?.(`[context-offload] L2 backfill: mapped=${mappedCount}, unmapped=${unmappedCount}, total=${waitIds.size}`);
  return { mapped: mappedCount, unmapped: unmappedCount };
}

// Local runL2Pipeline removed — all L2 processing goes through backend (index.ts → backendClient.l2Generate).

