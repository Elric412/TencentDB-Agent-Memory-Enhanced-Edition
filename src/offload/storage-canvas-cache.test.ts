/**
 * Regression tests — the canvas file is read from disk once per file, not
 * once per tool call.
 *
 * Plan.md (after-tool-call.ts readMmd): the canvas was read from disk on
 * every single tool call. On a turn with a dozen tool calls that is a dozen
 * synchronous reads of a file whose contents only change when the L2 stage
 * runs — far less often. Fix: cache the canvas content in storage and
 * invalidate at the write points (writeMmd / patchMmd / deleteMmd), which is
 * well-defined because all MMD writes funnel through those three functions.
 *
 * Test strategy: count readFile calls hitting the mmds directory across a run
 * of reads. Pre-fix the count grows linearly with reads; post-fix it is 1.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile as realWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Count readFile calls that hit the mmds directory.
const readCounter = vi.hoisted(() => ({ mmdReads: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const mod: Record<string, unknown> = { ...(actual as Record<string, unknown>) };
  mod.readFile = async (path: unknown, ...rest: unknown[]) => {
    if (typeof path === "string" && path.includes(`${join("mmds")}`)) {
      readCounter.mmdReads++;
    }
    return (actual.readFile as any)(path, ...rest);
  };
  mod.default = mod;
  return mod;
});

import {
  createStorageContext,
  ensureDirs,
  readMmd,
  writeMmd,
  patchMmd,
  deleteMmd,
  _clearMmdCacheForTest,
  type StorageContext,
} from "./storage.js";

let dataRoot: string;
let ctx: StorageContext;

beforeEach(async () => {
  _clearMmdCacheForTest();
  readCounter.mmdReads = 0;
  dataRoot = await mkdtemp(join(tmpdir(), "offload-f17-test-"));
  ctx = createStorageContext(dataRoot, "agent-a", "sess-1");
  await ensureDirs(ctx);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dataRoot, { recursive: true, force: true });
});

describe("readMmd serves repeated reads from cache", () => {
  it("ten reads of the same canvas hit disk exactly once", async () => {
    await writeMmd(ctx, "task.mmd", "graph TD\n  001-N1[\"start\"]\n");
    _clearMmdCacheForTest();
    readCounter.mmdReads = 0;

    for (let i = 0; i < 10; i++) {
      const content = await readMmd(ctx, "task.mmd");
      expect(content).toContain("001-N1");
    }
    expect(readCounter.mmdReads).toBe(1);
  });

  it("writeMmd updates the cache — the next read sees new content with no disk read", async () => {
    await writeMmd(ctx, "task.mmd", "graph TD\n  001-N1[\"v1\"]\n");
    _clearMmdCacheForTest();
    readCounter.mmdReads = 0;

    await writeMmd(ctx, "task.mmd", "graph TD\n  001-N1[\"v2\"]\n");
    const content = await readMmd(ctx, "task.mmd");
    expect(content).toContain("v2");
    expect(readCounter.mmdReads).toBe(0);
  });

  it("patchMmd updates the cache — the next read sees patched content with no disk read", async () => {
    await writeMmd(ctx, "task.mmd", "line1\nline2\nline3\n");
    // Production scenario: the cache is warm (after_tool_call already read the
    // canvas this turn). patchMmd's internal readMmd then also hits the cache,
    // so the whole patch + subsequent read perform zero disk reads.
    await readMmd(ctx, "task.mmd"); // warm the cache
    readCounter.mmdReads = 0;

    const ok = await patchMmd(ctx, "task.mmd", [
      { startLine: 2, endLine: 2, content: "line2-patched" },
    ]);
    expect(ok).toBe(true);
    const content = await readMmd(ctx, "task.mmd");
    expect(content).toBe("line1\nline2-patched\nline3\n");
    expect(readCounter.mmdReads).toBe(0);
  });

  it("deleteMmd invalidates the cache — a later read returns null without resurrecting the file", async () => {
    await writeMmd(ctx, "task.mmd", "graph TD\n  001-N1[\"x\"]\n");
    await readMmd(ctx, "task.mmd"); // warm the cache
    await deleteMmd(ctx, "task.mmd");
    const content = await readMmd(ctx, "task.mmd");
    expect(content).toBeNull();
  });

  it("a missing file's null result is cached (no per-call existsSync thrash)", async () => {
    // Never written at all.
    for (let i = 0; i < 5; i++) {
      expect(await readMmd(ctx, "ghost.mmd")).toBeNull();
    }
    expect(readCounter.mmdReads).toBe(0);
  });
});
