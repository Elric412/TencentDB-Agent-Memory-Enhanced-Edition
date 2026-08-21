/**
 * Regression tests — storage layer: content-addressed refs + atomic rewrite.
 *
 * Plan.md (storage.ts writeRefMd): the archive filename was derived from
 * the entry timestamp alone, so two tool results archived in the same
 * millisecond shared a path and the second overwrote the first — recovery of
 * the first entry then silently returned the WRONG tool call's output.
 * Fix: content-addressed refs (sha256 of the full content), `{digest, byteLen}`
 * stored alongside the pointer, verify-on-read with a typed RefIntegrityError.
 *
 * Plan.md (storage.ts rewriteOffloadEntries / rewriteAllOffloadEntries):
 * both helpers overwrote the live JSONL with a plain writeFile, so a crash
 * mid-write left a truncated log. Fix: write tmp file → fsync → rename.
 *
 * Both tests fail on the pre-fix code:
 *  - Content addressing: the second write clobbers the first, so payload A is unrecoverable.
 *  - Atomic rewrite: an injected failure after truncate-but-before-complete leaves a torn
 *    file on disk instead of the previous intact version.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Toggleable fault injection for the atomic-rename step. When `failRename` is
// set, the mocked `rename` throws — simulating a crash after the tmp file was
// written+fsynced but before it could replace the live log.
const failState = vi.hoisted(() => ({ failRename: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const mod: Record<string, unknown> = { ...(actual as Record<string, unknown>) };
  mod.rename = async (oldPath: unknown, newPath: unknown) => {
    if (failState.failRename) throw new Error("injected rename failure");
    return (actual.rename as any)(oldPath, newPath);
  };
  mod.default = mod;
  return mod;
});

import {
  createStorageContext,
  ensureDirs,
  writeRefMd,
  readRefMd,
  readRefMdVerified,
  verifyRefIntegrity,
  RefIntegrityError,
  rewriteOffloadEntries,
  readOffloadEntries,
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
  dataRoot = await mkdtemp(join(tmpdir(), "offload-storage-test-"));
  ctx = createStorageContext(dataRoot, "agent-a", "sess-1");
  await ensureDirs(ctx);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dataRoot, { recursive: true, force: true });
});

function makeEntry(toolCallId: string, resultRef: string, extra: Partial<OffloadEntry> = {}): OffloadEntry {
  return {
    timestamp: "2026-08-06T00:00:00.000Z",
    node_id: null,
    tool_call: `bash(command="echo ${toolCallId}")`,
    summary: `summary for ${toolCallId}`,
    result_ref: resultRef,
    tool_call_id: toolCallId,
    ...extra,
  } as unknown as OffloadEntry;
}

describe("content-addressed ref files", () => {
  it("two different payloads written in the same millisecond are both retrievable with their own content", async () => {
    // Freeze the logical timestamp: both entries share one millisecond.
    const ts = "2026-08-06T12:00:00.000Z";
    const payloadA = "**Result A:** the first tool call output — alpha";
    const payloadB = "**Result B:** a completely different tool call output — beta";

    const refA = await writeRefMd(ctx, ts, "bash", payloadA);
    const refB = await writeRefMd(ctx, ts, "bash", payloadB);

    // Distinct content → distinct addresses, even with identical timestamps.
    expect(refA).not.toBe(refB);

    // Both payloads are independently recoverable.
    const readA = await readRefMd(ctx, refA);
    const readB = await readRefMd(ctx, refB);
    expect(readA).toContain("alpha");
    expect(readB).toContain("beta");
    expect(readA).not.toContain("beta");
  });

  it("identical payloads converge on the same address (idempotent re-write)", async () => {
    const ts = "2026-08-06T12:00:00.000Z";
    const payload = "**Result:** deterministic content";
    const refA = await writeRefMd(ctx, ts, "bash", payload);
    const refB = await writeRefMd(ctx, ts, "bash", payload);
    expect(refA).toBe(refB);
    const read = await readRefMd(ctx, refA);
    expect(read).toContain("deterministic content");
  });

  it("verify-on-read: corrupted content raises a typed RefIntegrityError instead of returning bytes", async () => {
    const ts = "2026-08-06T12:00:00.000Z";
    const payload = "**Result:** integrity-checked content";
    const ref = await writeRefMd(ctx, ts, "bash", payload);

    // Corrupt the stored file after writing.
    const absPath = join(ctx.dataDir, ref);
    await writeFile(absPath, "tampered bytes", "utf-8");

    await expect(readRefMdVerified(ctx, ref)).rejects.toBeInstanceOf(RefIntegrityError);
  });

  it("verifyRefIntegrity returns the digest and byteLen recorded for the stored content", async () => {
    const ts = "2026-08-06T12:00:00.000Z";
    const payload = "**Result:** measured content";
    const ref = await writeRefMd(ctx, ts, "bash", payload);
    const info = await verifyRefIntegrity(ctx, ref);
    expect(info.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(info.byteLen).toBeGreaterThan(0);
  });
});

describe("atomic JSONL rewrite (tmp + fsync + rename)", () => {
  it("an injected failure mid-write leaves the previous intact version on disk", async () => {
    const original = [makeEntry("tc_1", "refs/a.md"), makeEntry("tc_2", "refs/b.md")];
    await rewriteOffloadEntries(ctx, original);
    const before = await readOffloadEntries(ctx, logger);
    expect(before).toHaveLength(2);

    // Inject a failure during the rewrite: make the atomic rename throw so
    // the new (tmp) content never replaces the live log.
    failState.failRename = true;
    try {
      const replacement = [makeEntry("tc_9", "refs/z.md")];
      await expect(rewriteOffloadEntries(ctx, replacement)).rejects.toThrow("injected rename failure");
    } finally {
      failState.failRename = false;
    }

    // The file on disk must still be the previous, parseable version.
    const after = await readOffloadEntries(ctx, logger);
    expect(after.map((e) => e.tool_call_id)).toEqual(["tc_1", "tc_2"]);
  });

  it("a successful rewrite replaces the file atomically and parses cleanly", async () => {
    const original = [makeEntry("tc_1", "refs/a.md")];
    await rewriteOffloadEntries(ctx, original);

    const replacement = [makeEntry("tc_2", "refs/b.md"), makeEntry("tc_3", "refs/c.md")];
    await rewriteOffloadEntries(ctx, replacement);

    const after = await readOffloadEntries(ctx, logger);
    expect(after.map((e) => e.tool_call_id)).toEqual(["tc_2", "tc_3"]);

    // No stray temp files left behind.
    const raw = await readFile(ctx.offloadJsonl, "utf-8");
    expect(() => raw.trim().split("\n").forEach((l) => JSON.parse(l))).not.toThrow();
  });
});
