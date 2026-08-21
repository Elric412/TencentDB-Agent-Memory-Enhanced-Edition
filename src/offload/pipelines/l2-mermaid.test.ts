/**
 * Regression tests — L2 node_id fabrication removal.
 *
 * Plan.md (pipelines/l2-mermaid.ts backfillNodeIds): when the L2 model's
 * `node_mapping` omits some tool calls, the pre-fix code filled the gaps by
 * guessing — `getMostFrequent` attributed the call to the most common node id
 * in the mapping, and `pickMmdDerivedFallbackNodeId` picked one out of the
 * canvas text. The resulting mapping parsed cleanly but was factually invented,
 * and the drill-down text then presented that attribution to the model as fact.
 *
 * Fix (per Plan.md): unmapped calls get `node_id: null`, the count of them is
 * surfaced as an `unmapped` metric, and the guessing heuristic is deleted
 * rather than improved.
 *
 * This test fails on the pre-fix code: with a deliberate gap in `node_mapping`,
 * the pre-fix `backfillNodeIds` fabricates ids via getMostFrequent /
 * pickMmdDerivedFallbackNodeId, so a node id appears in the output that was not
 * in the model's response.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createStorageContext,
  ensureDirs,
  appendOffloadEntries,
  readAllOffloadEntries,
  type StorageContext,
} from "../storage.js";
import { backfillNodeIds } from "./l2-mermaid.js";
import type { OffloadEntry } from "../types.js";

let dataRoot: string;
let ctx: StorageContext;

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as any;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "l2-mermaid-f5-test-"));
  ctx = createStorageContext(dataRoot, "agent-a", "sess-1");
  await ensureDirs(ctx);
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function makeEntry(toolCallId: string, extra: Partial<OffloadEntry> = {}): OffloadEntry {
  return {
    timestamp: "2026-08-06T00:00:00.000Z",
    node_id: null,
    tool_call: `bash(command="echo ${toolCallId}")`,
    summary: `summary for ${toolCallId}`,
    result_ref: `refs/${toolCallId}.md`,
    tool_call_id: toolCallId,
    ...extra,
  } as unknown as OffloadEntry;
}

describe("no fabricated node_id from backfillNodeIds", () => {
  it("a gapped node_mapping leaves unmapped wait entries without an invented node id", async () => {
    // Four wait entries; the model's node_mapping covers only three of them.
    // Entry "tc-4" is deliberately omitted — a gap in the model's response.
    await appendOffloadEntries(ctx, [
      makeEntry("tc-1", { node_id: "wait" }),
      makeEntry("tc-2", { node_id: "wait" }),
      makeEntry("tc-3", { node_id: "wait" }),
      makeEntry("tc-4", { node_id: "wait" }),
    ]);

    // The model's response: maps tc-1..tc-3, omits tc-4.
    // NOTE: the model never mentions "007-N9" anywhere.
    const nodeMapping: Record<string, string> = {
      "tc-1": "007-N1",
      "tc-2": "007-N2",
      "tc-3": "007-N1",
    };
    const waitIds = new Set(["tc-1", "tc-2", "tc-3", "tc-4"]);

    // A canvas text that mentions node ids — including 007-N9, which the model
    // did NOT put in node_mapping. Pre-fix, pickMmdDerivedFallbackNodeId could
    // lift an id from this text and attribute tc-4 to it.
    const mmdFallbackText = "graph TD\n  007-N1[step one]\n  007-N2[step two]\n  007-N9[orphan]\n";

    await backfillNodeIds(ctx, nodeMapping, waitIds, logger, {
      mmdFallbackText,
      mmdPrefix: "007",
    });

    const entries = await readAllOffloadEntries(ctx);
    const byId = new Map(entries.map((e) => [e.tool_call_id, e]));

    // Model-mapped entries keep exactly what the model said.
    expect(byId.get("tc-1")?.node_id).toBe("007-N1");
    expect(byId.get("tc-2")?.node_id).toBe("007-N2");
    expect(byId.get("tc-3")?.node_id).toBe("007-N1");

    // The gap entry must NOT receive any node id that was not in the model's
    // response. Pre-fix it would be fabricated as "007-N1" (most frequent) or
    // "007-N9" (mmd-derived). Post-fix it stays null.
    expect(byId.get("tc-4")?.node_id).toBeNull();

    // Global invariant: no node id in the output that was not in the model's
    // response (for the previously-wait entries).
    const modelNodeIds = new Set(Object.values(nodeMapping));
    for (const id of ["tc-1", "tc-2", "tc-3", "tc-4"]) {
      const nid = byId.get(id)?.node_id;
      if (nid !== null && nid !== "wait") {
        expect(modelNodeIds.has(nid as string)).toBe(true);
      }
    }
  });

  it("backfillNodeIds reports the unmapped count as a metric", async () => {
    await appendOffloadEntries(ctx, [
      makeEntry("tc-1", { node_id: "wait" }),
      makeEntry("tc-2", { node_id: "wait" }),
    ]);
    // Model maps only tc-1; tc-2 is a gap.
    const nodeMapping = { "tc-1": "001-N1" };
    const waitIds = new Set(["tc-1", "tc-2"]);

    const result: any = await (backfillNodeIds as any)(
      ctx,
      nodeMapping,
      waitIds,
      logger,
      { mmdFallbackText: "", mmdPrefix: "001" },
    );

    // The unmapped count must be surfaced (returned and/or emitted as a metric).
    // Pre-fix the function returned void and only counted "fallback" successes,
    // so there was no honest unmapped count anywhere.
    const unmapped =
      (result && typeof result.unmapped === "number" ? result.unmapped : undefined) ??
      (logger as any).__lastUnmapped;
    expect(typeof unmapped).toBe("number");
    expect(unmapped).toBe(1);

    const entries = await readAllOffloadEntries(ctx);
    const byId = new Map(entries.map((e) => [e.tool_call_id, e]));
    expect(byId.get("tc-1")?.node_id).toBe("001-N1");
    expect(byId.get("tc-2")?.node_id).toBeNull();
  });
});
