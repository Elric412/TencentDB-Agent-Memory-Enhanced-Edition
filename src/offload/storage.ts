/**
 * File I/O layer for the context offload plugin.
 *
 * Multi-agent / multi-session storage isolation:
 *   - Different agents get separate subdirectories under dataRoot
 *   - Same agent shares mmds/, refs/, state.json
 *   - offload is per-session: offload-<sessionId>.jsonl
 *   - L2 aggregation reads all offload-*.jsonl in the agent dir
 *   - All I/O functions require a StorageContext (no global mutable state)
 */
import { readFile, writeFile, appendFile, mkdir, readdir, unlink, open, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import type { OffloadEntry, PluginLogger } from "./types.js";

/** Default root data directory (parent of all agent subdirectories) */
export const DEFAULT_DATA_ROOT = join(homedir(), ".openclaw", "context-offload");

// ─── StorageContext ──────────────────────────────────────────────────────────

/** Immutable per-session storage path context. Created once per session switch. */
export interface StorageContext {
  readonly dataRoot: string;
  readonly dataDir: string;
  readonly refsDir: string;
  readonly mmdsDir: string;
  readonly offloadJsonl: string;
  readonly stateFile: string;
  readonly agentName: string;
  readonly sessionId: string;
}

/**
 * Build an immutable StorageContext for a given agent + session.
 * Once created, paths are frozen and cannot be affected by other sessions.
 */
export function createStorageContext(
  dataRoot: string,
  agentName: string,
  sessionId: string,
): StorageContext {
  const dataDir = join(dataRoot, agentName);
  return Object.freeze({
    dataRoot,
    dataDir,
    refsDir: join(dataDir, "refs"),
    mmdsDir: join(dataDir, "mmds"),
    offloadJsonl: join(dataDir, `offload-${sessionId}.jsonl`),
    stateFile: join(dataDir, "state.json"),
    agentName,
    sessionId,
  });
}

// ─── SessionKey Parsing ──────────────────────────────────────────────────────

/** Sanitize a string for use as a directory/file name */
function sanitizePath(s: string): string {
  return s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\.{2,}/g, "_");
}

/**
 * Parse a sessionKey into agentName and sessionId.
 * Expected format: "agent:<agent-name>:<session-id>"
 *
 * Worker isolation: if the sessionId contains a "swebench-w{N}" pattern
 * (from multi-worker inference), the worker suffix is merged into agentName
 * so each worker gets its own dataDir (state.json, mmds/, refs/).
 *
 * Returns null if format doesn't match.
 */
export function parseSessionKey(
  sessionKey: string,
): { agentName: string; sessionId: string } | null {
  if (typeof sessionKey !== "string") return null;
  const parts = sessionKey.split(":");
  if (parts.length < 3 || parts[0] !== "agent" || !parts[1]) return null;
  let agentName = parts[1];
  const sessionId = parts.slice(2).join(":");
  if (!sessionId) return null;
  const workerMatch = sessionId.match(/swebench-w(\d+)/);
  if (workerMatch) {
    agentName = `${agentName}-w${workerMatch[1]}`;
  }
  return {
    agentName: sanitizePath(agentName),
    sessionId: sanitizePath(sessionId),
  };
}

// ─── Directory Operations ────────────────────────────────────────────────────

/** Ensure all required directories exist for the given context */
export async function ensureDirs(ctx: StorageContext): Promise<void> {
  await mkdir(ctx.dataRoot, { recursive: true });
  await mkdir(ctx.dataDir, { recursive: true });
  await mkdir(ctx.refsDir, { recursive: true });
  await mkdir(ctx.mmdsDir, { recursive: true });
}

// ─── Session Registry ────────────────────────────────────────────────────────

/** Record a sessionKey → realSessionId mapping in the agent's registry. */
export async function registerSession(
  ctx: StorageContext,
  sessionKey: string,
  realSessionId: string,
): Promise<void> {
  if (!sessionKey || !realSessionId || !existsSync(ctx.dataDir)) return;
  const registryPath = join(ctx.dataDir, "sessions-registry.json");
  let registry: Record<string, unknown> = {};
  try {
    if (existsSync(registryPath)) {
      registry = JSON.parse(await readFile(registryPath, "utf-8"));
    }
  } catch {
    /* corrupt file, start fresh */
  }
  registry[sessionKey] = {
    sessionId: realSessionId,
    offloadFile: `offload-${realSessionId}.jsonl`,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(registryPath, JSON.stringify(registry, null, 2), "utf-8");
}

/** Look up the real sessionId for a given sessionKey from the registry. */
export async function lookupSessionId(
  ctx: StorageContext,
  sessionKey: string,
): Promise<string | null> {
  if (!sessionKey || !existsSync(ctx.dataDir)) return null;
  const registryPath = join(ctx.dataDir, "sessions-registry.json");
  try {
    if (!existsSync(registryPath)) return null;
    const registry = JSON.parse(await readFile(registryPath, "utf-8")) as Record<string, { sessionId?: string }>;
    return registry[sessionKey]?.sessionId ?? null;
  } catch {
    return null;
  }
}

/** List all registered sessions for the given context. */
export async function listRegisteredSessions(
  ctx: StorageContext,
): Promise<Array<{ sessionKey: string; [key: string]: unknown }>> {
  if (!existsSync(ctx.dataDir)) return [];
  const registryPath = join(ctx.dataDir, "sessions-registry.json");
  try {
    if (!existsSync(registryPath)) return [];
    const registry = JSON.parse(await readFile(registryPath, "utf-8")) as Record<string, Record<string, unknown>>;
    return Object.entries(registry).map(([key, val]) => ({
      sessionKey: key,
      ...val,
    }));
  } catch {
    return [];
  }
}

// ─── JSONL Defense Layer ─────────────────────────────────────────────────────

const UNSAFE_CHAR_RE =
  /[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F\u0080-\u009F\uD800-\uDFFF\u200B-\u200F\u2028\u2029\uFEFF]/gu;

/** Layer 0 — Source text sanitize. Strips unsafe characters from arbitrary text. */
export function sanitizeText(text: string): string {
  if (typeof text !== "string") return text;
  return text.replace(UNSAFE_CHAR_RE, "");
}

/** Layer 1 — Write sanitize. Strips unsafe characters from a JSON string with roundtrip verification. */
export function sanitizeJsonLine(jsonStr: string): string {
  let cleaned = jsonStr.replace(UNSAFE_CHAR_RE, "");
  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch {
    /* fall through */
  }
  cleaned = jsonStr.replace(
    /[^\x09\x0A\x0D\x20-\x7E\u00A0-\u024F\u3400-\u4DBF\u4E00-\u9FFF\uFF00-\uFFEF]/g,
    "",
  );
  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch {
    /* fall through */
  }
  try {
    const obj = JSON.parse(jsonStr.replace(/[^\x20-\x7E\t\n\r]/g, ""));
    return JSON.stringify(obj);
  } catch {
    return "{}";
  }
}

/** Layer 3 — Entry schema validation. */
export function validateEntry(entry: unknown): boolean {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry))
    return false;
  const e = entry as Record<string, unknown>;
  if (typeof e.tool_call_id !== "string" || (e.tool_call_id as string).length === 0)
    return false;
  return true;
}

/** Layer 2+3+4 — Safe JSONL parser with tolerance, validation, and metrics. */
export function parseJsonlSafe(
  content: string,
  options?: { sourceLabel?: string; skipValidation?: boolean },
): {
  entries: Array<Record<string, unknown>>;
  corruptCount: number;
  invalidCount: number;
  corruptSample: string | null;
} {
  const entries: Array<Record<string, unknown>> = [];
  let corruptCount = 0;
  let invalidCount = 0;
  let corruptSample: string | null = null;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      try {
        parsed = JSON.parse(trimmed.replace(UNSAFE_CHAR_RE, ""));
      } catch {
        corruptCount++;
        if (corruptSample === null) {
          corruptSample = trimmed.slice(0, 200);
        }
        continue;
      }
    }
    if (!options?.skipValidation && !validateEntry(parsed)) {
      invalidCount++;
      continue;
    }
    entries.push(parsed as Record<string, unknown>);
  }
  return { entries, corruptCount, invalidCount, corruptSample };
}

function safeStringifyEntry(entry: Record<string, unknown>): string {
  return sanitizeJsonLine(JSON.stringify(entry));
}

// ─── JSONL Operations (current session) ──────────────────────────────────────

// ─── Session-scoped id-set cache for write-time dedup ─────────────────────
// The previous implementation re-read and re-scanned the entire offload JSONL on
// every append in order to reject duplicate ids, so total cost across a session
// grew quadratically with entry count — and it happened on the path taken by
// every single tool call. The fix holds the id set in memory, seeded once from
// disk (lazily on first append), and consults that instead. Per-append cost is
// then O(k) in the number of NEW entries, independent of log size.
//
// The cache is keyed by file path because appends can target a non-current
// session file (targetSessionId). It is invalidated by any function that
// rewrites an offload log from scratch (see _invalidateDedupCache calls below)
// so a post-rewrite append re-seeds from the new on-disk state.
interface OffloadFileCache {
  ids: Set<string>;
  maxSeq: number;
}
const _dedupCache = new Map<string, OffloadFileCache>();

/** Test-only: drop the dedup cache so a test can observe a fresh cold seed. */
export function _clearDedupCacheForTest(): void {
  _dedupCache.clear();
}

function _invalidateDedupCache(filePath: string): void {
  _dedupCache.delete(filePath);
}

/** Extract the dedup-relevant ids (raw + underscore-normalised) from one entry's tool_call_id. */
function _dedupIds(id: string): string[] {
  const norm = id.replace(/_/g, "");
  return norm !== id ? [id, norm] : [id];
}

/** Scan an on-disk JSONL once, collecting both known tool_call_ids and max seq. */
async function _seedOffloadFileCache(filePath: string): Promise<OffloadFileCache> {
  const ids = new Set<string>();
  let maxSeq = -1;
  const content = await readFile(filePath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed.tool_call_id === "string") {
        for (const id of _dedupIds(parsed.tool_call_id)) ids.add(id);
      }
      if (typeof parsed.seq === "number" && parsed.seq > maxSeq) maxSeq = parsed.seq;
    } catch {
      /* skip corrupt lines */
    }
  }
  return { ids, maxSeq };
}

/**
 * The seq that will be assigned to the next entry appended to this session's
 * log. Boundaries are recorded against this value so they reference the
 * durable entry sequence number, never a positional index. Unlike a read of
 * maxSeq from the cache, this guarantees the cache is seeded first, so the
 * returned value reflects what is actually on disk.
 */
export async function peekNextSeq(ctx: StorageContext): Promise<number> {
  const filePath = ctx.offloadJsonl;
  let cache = _dedupCache.get(filePath);
  if (!cache) {
    cache = { ids: new Set<string>(), maxSeq: -1 };
    if (existsSync(filePath)) {
      try {
        cache = await _seedOffloadFileCache(filePath);
      } catch {
        /* proceed with empty cache */
      }
    }
    _dedupCache.set(filePath, cache);
  }
  return cache.maxSeq + 1;
}

/**
 * Assign seq by file order to any entry that lacks one (legacy logs written
 * before seq existed). Mutates the array in place and returns whether any
 * entry was changed, so callers can persist the backfill once.
 */
export function ensureEntrySeqs(entries: Array<OffloadEntry & { seq?: number }>): boolean {
  let maxSeq = -1;
  let changed = false;
  // First pass: find the highest existing seq so backfilled entries continue from it.
  for (const e of entries) {
    if (typeof e.seq === "number" && e.seq > maxSeq) maxSeq = e.seq;
  }
  // Second pass: entries without a seq get the next available number in file order.
  for (const e of entries) {
    if (typeof e.seq !== "number") {
      e.seq = ++maxSeq;
      changed = true;
    }
  }
  return changed;
}

/** Append one or more entries to an offload JSONL with write-time dedup. */
export async function appendOffloadEntries(
  ctx: StorageContext,
  entries: OffloadEntry[],
  targetSessionId?: string,
  logger?: PluginLogger,
): Promise<void> {
  const filePath =
    targetSessionId && targetSessionId !== ctx.sessionId
      ? join(ctx.dataDir, `offload-${targetSessionId}.jsonl`)
      : ctx.offloadJsonl;

  // Consult the session-scoped in-memory cache (id set + max seq); seed it
  // from disk exactly once. Per-append cost is O(k) in the new entries, not O(N)
  // in the whole log — previously this re-read the file on every append, making
  // total session cost quadratic in entry count.
  let cache = _dedupCache.get(filePath);
  if (!cache) {
    cache = { ids: new Set<string>(), maxSeq: -1 };
    if (existsSync(filePath)) {
      try {
        cache = await _seedOffloadFileCache(filePath);
      } catch {
        /* If reading existing file fails, proceed with an empty cache */
      }
    }
    _dedupCache.set(filePath, cache);
  }

  let newEntries: OffloadEntry[] = entries;
  if (cache.ids.size > 0) {
    const before = newEntries.length;
    const duplicates: string[] = [];
    newEntries = entries.filter((e) => {
      const id = e.tool_call_id;
      if (!id) return true;
      const norm = id.replace(/_/g, "");
      if (cache!.ids.has(id) || cache!.ids.has(norm)) {
        duplicates.push(id);
        return false;
      }
      return true;
    });
    if (duplicates.length > 0) {
      logger?.warn?.(
        `[context-offload] appendOffloadEntries DEDUP: ${duplicates.length}/${before} entries are duplicates, writing ${newEntries.length}. file=${basename(filePath)} duplicateIds=[${duplicates.join(",")}]`,
      );
    }
  }

  if (newEntries.length === 0) {
    logger?.info?.(
      `[context-offload] appendOffloadEntries: all ${entries.length} entries deduped, nothing to write`,
    );
    return;
  }

  // Assign a monotonic `seq` to any entry that doesn't already carry one.
  // seq is never reused and is the durable identity that boundaries reference
  // (a positional index into the log is not stable across rewrites).
  // The running max lives in the cache rather than being re-derived from disk.
  let maxSeq = cache.maxSeq;
  for (const e of newEntries) {
    if (typeof (e as any).seq !== "number") {
      (e as any).seq = ++maxSeq;
    } else if ((e as any).seq > maxSeq) {
      maxSeq = (e as any).seq;
    }
  }
  cache.maxSeq = maxSeq;

  // Record the appended ids so subsequent appends in this session don't
  // need a rescan to detect duplicates.
  for (const e of newEntries) {
    if (e.tool_call_id) {
      for (const id of _dedupIds(e.tool_call_id)) cache.ids.add(id);
    }
  }

  const lines = newEntries.map((e) => safeStringifyEntry(e as unknown as Record<string, unknown>)).join("\n") + "\n";
  await appendFile(filePath, lines, "utf-8");
}

/** Read all entries from the current session's offload JSONL. */
export async function readOffloadEntries(
  ctx: StorageContext,
  logger?: PluginLogger,
): Promise<OffloadEntry[]> {
  if (!existsSync(ctx.offloadJsonl)) return [];
  let content: string;
  try {
    content = await readFile(ctx.offloadJsonl, "utf-8");
  } catch (err) {
    logger?.warn?.(
      `[context-offload] readOffloadEntries: failed to read ${ctx.offloadJsonl}: ${(err as Error).message}`,
    );
    return [];
  }
  const { entries, corruptCount, invalidCount, corruptSample } = parseJsonlSafe(
    content,
    { sourceLabel: basename(ctx.offloadJsonl) },
  );
  if (corruptCount > 0 || invalidCount > 0) {
    logger?.warn?.(
      `[context-offload] readOffloadEntries: skipped ${corruptCount} corrupt + ${invalidCount} invalid lines in ${basename(ctx.offloadJsonl)}. Sample: ${corruptSample?.slice(0, 100)}`,
    );
  }
  const typed = entries as unknown as Array<OffloadEntry & { seq?: number }>;
  // One-time backfill: entries written before seq existed get a seq by file
  // order. Persisted immediately so the assignment is stable across reads and
  // boundaries recorded against it stay valid after a restart.
  if (ensureEntrySeqs(typed)) {
    await rewriteOffloadEntries(ctx, typed);
  }
  return typed as unknown as OffloadEntry[];
}

/** Rewrite the current session's offload JSONL with the given entries (sanitized, atomic). */
export async function rewriteOffloadEntries(
  ctx: StorageContext,
  entries: OffloadEntry[],
): Promise<void> {
  const content =
    entries.map((e) => safeStringifyEntry(e as unknown as Record<string, unknown>)).join("\n") +
    (entries.length > 0 ? "\n" : "");
  await atomicWriteFile(ctx.offloadJsonl, content);
  // The on-disk id/seq state just changed; force the next append to re-seed.
  _invalidateDedupCache(ctx.offloadJsonl);
}

/** Mark offload entries by tool_call_id with an `offloaded` status. */
export async function markOffloadStatus(
  ctx: StorageContext,
  updates: Map<string, string | boolean>,
): Promise<void> {
  if (!existsSync(ctx.offloadJsonl) || updates.size === 0) return;
  const entries = (await readOffloadEntries(ctx)) as Array<OffloadEntry & { offloaded?: string | boolean }>;
  let changed = false;
  for (const entry of entries) {
    const status = updates.get(entry.tool_call_id);
    if (status !== undefined && entry.offloaded !== status) {
      entry.offloaded = status;
      changed = true;
    }
  }
  if (changed) {
    await rewriteOffloadEntries(ctx, entries);
  }
}

/** Extract confirmed (offloaded) tool_call_ids from entries. */
export function extractConfirmedIdsFromEntries(
  entries: Array<OffloadEntry & { offloaded?: unknown }>,
): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.offloaded) {
      const id = entry.tool_call_id;
      if (!id) continue;
      ids.add(id);
      const normalized = id.replace(/_/g, "");
      if (normalized !== id) ids.add(normalized);
    }
  }
  return ids;
}

/** Extract aggressively deleted tool_call_ids from entries. */
export function extractDeletedIdsFromEntries(
  entries: Array<OffloadEntry & { offloaded?: unknown }>,
): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.offloaded === "deleted") {
      const id = entry.tool_call_id;
      if (!id) continue;
      ids.add(id);
      const normalized = id.replace(/_/g, "");
      if (normalized !== id) ids.add(normalized);
    }
  }
  return ids;
}

// ─── JSONL Operations (all sessions under current agent) ─────────────────────

/** Read offload entries from ALL session files under ctx.dataDir. */
export async function readAllOffloadEntries(
  ctx: StorageContext,
  logger?: PluginLogger,
): Promise<Array<OffloadEntry & { _sourceFile?: string }>> {
  if (!existsSync(ctx.dataDir)) return [];
  let files: string[];
  try {
    files = await readdir(ctx.dataDir);
  } catch (err) {
    logger?.warn?.(
      `[context-offload] readAllOffloadEntries: failed to readdir ${ctx.dataDir}: ${(err as Error).message}`,
    );
    return [];
  }
  const offloadFiles = files
    .filter((f) => f.startsWith("offload-") && f.endsWith(".jsonl"))
    .sort();
  if (offloadFiles.length === 0) return [];
  const allEntries: Array<OffloadEntry & { _sourceFile?: string }> = [];
  let totalCorrupt = 0;
  let totalInvalid = 0;
  await Promise.all(
    offloadFiles.map(async (filename) => {
      try {
        const filePath = join(ctx.dataDir, filename);
        const content = await readFile(filePath, "utf-8");
        const { entries, corruptCount, invalidCount } = parseJsonlSafe(content, {
          sourceLabel: filename,
        });
        totalCorrupt += corruptCount;
        totalInvalid += invalidCount;
        // One-time backfill: assign seq by file order to legacy entries that
        // predate it, persisting the assignment so it is stable across reads
        // and boundaries recorded against it stay valid after a restart.
        const typed = entries as Array<OffloadEntry & { seq?: number }>;
        if (ensureEntrySeqs(typed)) {
          const backfilled =
            typed.map((e) => safeStringifyEntry(e as unknown as Record<string, unknown>)).join("\n") +
            (typed.length > 0 ? "\n" : "");
          await atomicWriteFile(filePath, backfilled);
          _invalidateDedupCache(filePath);
        }
        for (const entry of typed) {
          (entry as Record<string, unknown>)._sourceFile = filename;
          allEntries.push(entry as unknown as OffloadEntry & { _sourceFile?: string });
        }
      } catch (err) {
        logger?.warn?.(
          `[context-offload] readAllOffloadEntries: failed to read ${filename}: ${(err as Error).message}`,
        );
      }
    }),
  );
  if (totalCorrupt > 0 || totalInvalid > 0) {
    logger?.warn?.(
      `[context-offload] readAllOffloadEntries: skipped ${totalCorrupt} corrupt + ${totalInvalid} invalid lines across ${offloadFiles.length} files`,
    );
  }
  return allEntries;
}

/** Write entries back to their respective source files. */
export async function rewriteAllOffloadEntries(
  ctx: StorageContext,
  entries: Array<Record<string, unknown> | any>,
): Promise<void> {
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const entry of entries) {
    const sourceFile = (entry._sourceFile as string) ?? basename(ctx.offloadJsonl);
    if (!groups.has(sourceFile)) {
      groups.set(sourceFile, []);
    }
    const clean = { ...entry };
    delete clean._sourceFile;
    groups.get(sourceFile)!.push(clean);
  }
  if (existsSync(ctx.dataDir)) {
    const files = await readdir(ctx.dataDir);
    const offloadFiles = files.filter(
      (f) => f.startsWith("offload-") && f.endsWith(".jsonl"),
    );
    for (const f of offloadFiles) {
      if (!groups.has(f)) {
        groups.set(f, []);
      }
    }
  }
  await Promise.all(
    Array.from(groups.entries()).map(async ([filename, fileEntries]) => {
      const filePath = join(ctx.dataDir, filename);
      const content =
        fileEntries.map(safeStringifyEntry).join("\n") +
        (fileEntries.length > 0 ? "\n" : "");
      await atomicWriteFile(filePath, content);
      // Rewritten file's id/seq state changed; force next append to re-seed.
      _invalidateDedupCache(filePath);
    }),
  );
}

// ─── Append-only boundary log ──────────────────────────────────────────────

/** Path of the append-only boundary log for the current session. */
export function boundariesLogPath(ctx: StorageContext): string {
  return join(ctx.dataDir, `boundaries-${ctx.sessionId}.jsonl`);
}

/**
 * Append a boundary record to the session's boundaries.jsonl. Append-only:
 * records are never rewritten or deleted, so a boundary's `startSeq` stays a
 * durable reference to a monotonic entry sequence number (F4).
 */
export async function appendBoundary(
  ctx: StorageContext,
  boundary: { startSeq: number; result: "long" | "short" | "pending"; targetMmd: string | null },
): Promise<void> {
  const line = safeStringifyEntry(boundary as unknown as Record<string, unknown>) + "\n";
  await appendFile(boundariesLogPath(ctx), line, "utf-8");
}

/** Read all persisted boundaries for the current session (ascending by startSeq). */
export async function readBoundaries(
  ctx: StorageContext,
): Promise<Array<{ startSeq: number; result: "long" | "short" | "pending"; targetMmd: string | null }>> {
  const path = boundariesLogPath(ctx);
  if (!existsSync(path)) return [];
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return [];
  }
  const out: Array<{ startSeq: number; result: "long" | "short" | "pending"; targetMmd: string | null }> = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const b = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof b.startSeq !== "number") continue;
      out.push({
        startSeq: b.startSeq,
        result: (b.result === "long" || b.result === "short" ? b.result : "pending") as "long" | "short" | "pending",
        targetMmd: typeof b.targetMmd === "string" ? b.targetMmd : null,
      });
    } catch { /* skip corrupt lines */ }
  }
  out.sort((a, b) => a.startSeq - b.startSeq);
  return out;
}

/** Update specific entries by tool_call_id across ALL session files (L2 backfill). */
export async function updateOffloadNodeIds(
  ctx: StorageContext,
  updates: Map<string, string>,
): Promise<void> {
  const entries = await readAllOffloadEntries(ctx);
  let changed = false;
  for (const entry of entries) {
    const newNodeId = updates.get(entry.tool_call_id);
    if (newNodeId !== undefined) {
      entry.node_id = newNodeId;
      changed = true;
    }
  }
  if (changed) {
    await rewriteAllOffloadEntries(ctx, entries as unknown as Array<Record<string, unknown>>);
  }
}

// ─── MD (Tool Result Refs) Operations ────────────────────────────────────────

/** Convert ISO 8601 timestamp to a safe filename (replace special chars) */
export function isoToFilename(iso: string): string {
  return iso.replace(/:/g, "-").replace(/\./g, "-").replace(/\+/g, "p");
}

// ─── Atomic file rewrite ───────────────────────────────────────────────────

/**
 * Atomically replace `targetPath` with `content`.
 *
 * Sequence: write to a same-directory tmp file → fsync → rename over target.
 * A crash at any point before the rename leaves the previous version on disk
 * fully intact; the rename itself is atomic on POSIX. The tmp file is removed
 * on failure so no orphans accumulate.
 */
export async function atomicWriteFile(targetPath: string, content: string): Promise<void> {
  const dir = dirname(targetPath);
  const tmpPath = join(
    dir,
    `.${basename(targetPath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  try {
    const handle = await open(tmpPath, "w");
    try {
      await handle.writeFile(content, "utf-8");
      await handle.sync(); // fsync — force bytes to durable storage before rename
    } finally {
      await handle.close();
    }
    await rename(tmpPath, targetPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

// ─── Content-addressed refs ────────────────────────────────────────────────

/** Typed error raised when a ref file's stored bytes fail integrity verification. */
export class RefIntegrityError extends Error {
  constructor(
    message: string,
    readonly refPath: string,
    readonly expectedDigest: string,
    readonly actualDigest: string,
  ) {
    super(message);
    this.name = "RefIntegrityError";
  }
}

/** Integrity metadata stored alongside a ref pointer. */
export interface RefIntegrity {
  digest: string;
  byteLen: number;
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Write tool result content to a content-addressed ref file (F1).
 *
 * The filename is derived from the sha256 of the *full* stored bytes (header +
 * sanitized content), not the timestamp — two results archived in the same
 * millisecond can no longer collide, and identical content converges on the
 * same address (idempotent re-write). The timestamp remains only inside the
 * file body for human readability.
 */
export async function writeRefMdContentAddressed(
  ctx: StorageContext,
  timestamp: string,
  toolName: string,
  content: string,
): Promise<{ refPath: string; digest: string; byteLen: number }> {
  const safeContent = (content ?? "").replace(UNSAFE_CHAR_RE, "");
  const header = `# Tool Result: ${toolName}\n\n**Timestamp:** ${timestamp}\n\n---\n\n`;
  const full = header + safeContent;
  const digest = `sha256:${sha256Hex(full)}`;
  const byteLen = Buffer.byteLength(full, "utf-8");
  const filename = `${digest.slice("sha256:".length)}.md`;
  const filePath = join(ctx.refsDir, filename);
  if (!existsSync(filePath)) {
    await atomicWriteFile(filePath, full);
  }
  return { refPath: `refs/${filename}`, digest, byteLen };
}

/** Verify a ref file's integrity; returns its digest + byteLen. Throws RefIntegrityError on mismatch with a recorded digest. */
export async function verifyRefIntegrity(
  ctx: StorageContext,
  refPath: string,
  expectedDigest?: string,
): Promise<RefIntegrity> {
  const filePath = join(ctx.dataDir, refPath);
  if (!existsSync(filePath)) {
    throw new RefIntegrityError(`Ref file not found: ${refPath}`, refPath, expectedDigest ?? "(none)", "(missing)");
  }
  const content = await readFile(filePath, "utf-8");
  const actualDigest = `sha256:${sha256Hex(content)}`;
  if (expectedDigest && expectedDigest !== actualDigest) {
    throw new RefIntegrityError(
      `Ref integrity mismatch for ${refPath}: expected ${expectedDigest}, got ${actualDigest}`,
      refPath,
      expectedDigest,
      actualDigest,
    );
  }
  return { digest: actualDigest, byteLen: Buffer.byteLength(content, "utf-8") };
}

/** Read a ref file with integrity verification against the digest embedded in a content-addressed path. */
export async function readRefMdVerified(ctx: StorageContext, refPath: string): Promise<string> {
  const filePath = join(ctx.dataDir, refPath);
  if (!existsSync(filePath)) return null as unknown as string;
  const content = await readFile(filePath, "utf-8");
  // For content-addressed names the filename itself is the expected digest.
  const m = /refs\/([0-9a-f]{64})\.md$/.exec(refPath);
  if (m) {
    const actual = sha256Hex(content);
    if (actual !== m[1]) {
      throw new RefIntegrityError(
        `Ref content does not match its content-addressed name: ${refPath}`,
        refPath,
        `sha256:${m[1]}`,
        `sha256:${actual}`,
      );
    }
  }
  return content;
}

/**
 * Write tool result content to a ref MD file, return relative path.
 *
 * This now delegates to the content-addressed writer — the returned path
 * is `refs/<sha256>.md`, so two results archived in the same millisecond no
 * longer collide. Callers that need the integrity metadata should call
 * `writeRefMdContentAddressed` directly.
 */
export async function writeRefMd(
  ctx: StorageContext,
  timestamp: string,
  toolName: string,
  content: string,
): Promise<string> {
  const { refPath } = await writeRefMdContentAddressed(ctx, timestamp, toolName, content);
  return refPath;
}

/** Read a ref MD file by relative path */
export async function readRefMd(
  ctx: StorageContext,
  refPath: string,
): Promise<string | null> {
  const filePath = join(ctx.dataDir, refPath);
  if (!existsSync(filePath)) return null;
  return readFile(filePath, "utf-8");
}

// ─── MMD (Mermaid) Operations ────────────────────────────────────────────────

// ─── Session-scoped canvas content cache ───────────────────────────────────
// after_tool_call.ts called readMmd once per tool call; a turn with a dozen
// tool calls meant a dozen synchronous reads of a file whose contents only
// change when the L2 stage writes it — far less often. The fix caches the
// canvas content in memory and invalidates at every write point (writeMmd,
// patchMmd, deleteMmd), which is well-defined because all MMD writes funnel
// through these three functions in this module.
const _mmdCache = new Map<string, string | null>();

/** Test-only: drop the MMD cache so a test can observe a fresh cold read. */
export function _clearMmdCacheForTest(): void {
  _mmdCache.clear();
}

/** A single replace block for patchMmd */
export interface MmdReplaceBlock {
  /** 1-based start line number (inclusive) */
  startLine: number;
  /** 1-based end line number (inclusive). If endLine < startLine, treat as pure insertion */
  endLine: number;
  /** Replacement content (may contain newlines) */
  content: string;
}

/** Write/overwrite an MMD file */
export async function writeMmd(
  ctx: StorageContext,
  filename: string,
  content: string,
): Promise<void> {
  const filePath = join(ctx.mmdsDir, filename);
  await writeFile(filePath, content, "utf-8");
  // New content on disk — update the cache in place (no re-read needed).
  _mmdCache.set(filePath, content);
}

/** Apply incremental line-based replace blocks to an existing MMD file. */
export async function patchMmd(
  ctx: StorageContext,
  filename: string,
  blocks: MmdReplaceBlock[],
): Promise<boolean> {
  const filePath = join(ctx.mmdsDir, filename);
  const original = await readMmd(ctx, filename);
  if (original === null) return false;
  const lines = original.split("\n");
  let allValid = true;
  const sorted = [...blocks].sort((a, b) => b.startLine - a.startLine);
  for (const block of sorted) {
    const start = block.startLine;
    const end = block.endLine;
    if (start < 1 || start > lines.length + 1) {
      allValid = false;
      continue;
    }
    const newContentLines = block.content ? block.content.split("\n") : [];
    if (end < start) {
      lines.splice(start - 1, 0, ...newContentLines);
    } else {
      const clampedEnd = Math.min(end, lines.length);
      const deleteCount = clampedEnd - start + 1;
      lines.splice(start - 1, deleteCount, ...newContentLines);
    }
  }
  const newContent = lines.join("\n");
  if (newContent !== original) {
    await writeFile(filePath, newContent, "utf-8");
    // Content changed on disk — update the cache in place.
    _mmdCache.set(filePath, newContent);
  }
  return allValid;
}

/** Read an MMD file */
export async function readMmd(
  ctx: StorageContext,
  filename: string,
): Promise<string | null> {
  const filePath = join(ctx.mmdsDir, filename);
  // Serve from the session-scoped cache; seed from disk once per file.
  if (_mmdCache.has(filePath)) return _mmdCache.get(filePath)!;
  let content: string | null;
  if (!existsSync(filePath)) {
    content = null;
  } else {
    content = await readFile(filePath, "utf-8");
  }
  _mmdCache.set(filePath, content);
  return content;
}

/** Delete an MMD file */
export async function deleteMmd(
  ctx: StorageContext,
  filename: string,
): Promise<boolean> {
  const filePath = join(ctx.mmdsDir, filename);
  if (!existsSync(filePath)) {
    // Ensure any stale cache entry cannot resurrect a deleted file.
    _mmdCache.set(filePath, null);
    return false;
  }
  await unlink(filePath);
  // File gone on disk — reflect that in the cache.
  _mmdCache.set(filePath, null);
  return true;
}

/** List all MMD files in the mmds directory */
export async function listMmds(ctx: StorageContext): Promise<string[]> {
  if (!existsSync(ctx.mmdsDir)) return [];
  const files = await readdir(ctx.mmdsDir);
  return files.filter((f) => f.endsWith(".mmd")).sort();
}

// ─── State File Operations ───────────────────────────────────────────────────

/** Read the state.json file */
export async function readStateFile<T>(
  ctx: StorageContext,
  defaultValue: T,
): Promise<T> {
  if (!existsSync(ctx.stateFile)) return defaultValue;
  try {
    const content = await readFile(ctx.stateFile, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return defaultValue;
  }
}

/** Write the state.json file */
export async function writeStateFile<T>(
  ctx: StorageContext,
  state: T,
): Promise<void> {
  await mkdir(dirname(ctx.stateFile), { recursive: true });
  await writeFile(ctx.stateFile, JSON.stringify(state, null, 2), "utf-8");
}
