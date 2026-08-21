/**
 * The "at most 3 calls" limit on memory tools must exist in code.
 *
 * Plan.md §5: a shared per-turn counter checked in before_tool_call,
 * covering all memory tools together rather than each one separately.
 * Test: issue four memory-tool calls within one turn and assert the fourth
 * is refused with a structured error the model can read.
 *
 * Root index.ts is not importable by vitest (root files are outside the
 * include globs), so the limiter lives in src/core/tools/tool-call-limiter.ts
 * and is tested directly here; index.ts wires it into the before_tool_call hook.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  MemoryToolCallLimiter,
  MEMORY_TOOL_NAMES,
  MEMORY_TOOL_CALL_LIMIT_DEFAULT,
  type ToolCallLimiterEvent,
  type ToolCallLimiterCtx,
} from "./tool-call-limiter.js";
import { setReporter, resetReporter } from "../report/reporter.js";

const memoryTool = MEMORY_TOOL_NAMES[0];
const otherMemoryTool = MEMORY_TOOL_NAMES[1];

function ev(toolName: string, runId?: string): ToolCallLimiterEvent {
  return { toolName, runId };
}

function ctx(sessionKey: string, runId?: string): ToolCallLimiterCtx {
  return { sessionKey, runId };
}

describe("memory tool call limiter", () => {
  let limiter: MemoryToolCallLimiter;

  beforeEach(() => {
    limiter = new MemoryToolCallLimiter();
  });

  it("refuses the 4th combined memory-tool call in one turn with a structured error", () => {
    const c = ctx("session-a", "run-1");

    // 3 calls allowed, mixed across both memory tools (combined limit)
    expect(limiter.beforeToolCall(ev(memoryTool, "run-1"), c)).toBeUndefined();
    expect(limiter.beforeToolCall(ev(memoryTool, "run-1"), c)).toBeUndefined();
    expect(limiter.beforeToolCall(ev(otherMemoryTool, "run-1"), c)).toBeUndefined();

    // 4th call within the same turn must be refused with a structured error
    const decision = limiter.beforeToolCall(ev(memoryTool, "run-1"), c);
    expect(decision).toBeDefined();
    expect(decision?.block).toBe(true);
    expect(typeof decision?.blockReason).toBe("string");
    // Model-readable: states the limit, the current count, and what to do next
    expect(decision?.blockReason).toContain(String(MEMORY_TOOL_CALL_LIMIT_DEFAULT));
    expect(decision?.blockReason?.toLowerCase()).toContain("limit");
  });

  it("applies the limit across both memory tools combined, not per tool", () => {
    const c = ctx("session-a", "run-1");
    limiter.beforeToolCall(ev(memoryTool, "run-1"), c);
    limiter.beforeToolCall(ev(memoryTool, "run-1"), c);
    limiter.beforeToolCall(ev(memoryTool, "run-1"), c);

    // Even a *different* memory tool is refused once the combined budget is spent
    const decision = limiter.beforeToolCall(ev(otherMemoryTool, "run-1"), c);
    expect(decision?.block).toBe(true);
  });

  it("ignores non-memory tools entirely", () => {
    const c = ctx("session-a", "run-1");
    for (let i = 0; i < 10; i++) {
      expect(limiter.beforeToolCall(ev("exec", "run-1"), c)).toBeUndefined();
      expect(limiter.beforeToolCall(ev("web_search", "run-1"), c)).toBeUndefined();
    }
  });

  it("resets the counter when a new turn starts (new runId)", () => {
    const c1 = ctx("session-a", "run-1");
    limiter.beforeToolCall(ev(memoryTool, "run-1"), c1);
    limiter.beforeToolCall(ev(memoryTool, "run-1"), c1);
    limiter.beforeToolCall(ev(memoryTool, "run-1"), c1);
    expect(limiter.beforeToolCall(ev(memoryTool, "run-1"), c1)?.block).toBe(true);

    // Next turn (new runId, same session): budget is fresh again
    const c2 = ctx("session-a", "run-2");
    expect(limiter.beforeToolCall(ev(memoryTool, "run-2"), c2)).toBeUndefined();
    expect(limiter.beforeToolCall(ev(memoryTool, "run-2"), c2)).toBeUndefined();
    expect(limiter.beforeToolCall(ev(memoryTool, "run-2"), c2)).toBeUndefined();
    expect(limiter.beforeToolCall(ev(memoryTool, "run-2"), c2)?.block).toBe(true);
  });

  it("keys counters per session so sessions do not share a budget", () => {
    const a = ctx("session-a", "run-1");
    const b = ctx("session-b", "run-1");
    limiter.beforeToolCall(ev(memoryTool, "run-1"), a);
    limiter.beforeToolCall(ev(memoryTool, "run-1"), a);
    limiter.beforeToolCall(ev(memoryTool, "run-1"), a);
    expect(limiter.beforeToolCall(ev(memoryTool, "run-1"), a)?.block).toBe(true);

    // session-b unaffected
    expect(limiter.beforeToolCall(ev(memoryTool, "run-1"), b)).toBeUndefined();
  });

  it("reports a tool_call_limit_block event when a call is refused", () => {
    const events: Array<Record<string, unknown>> = [];
    setReporter({
      reportFunc(_category: string, payload: Record<string, unknown>) {
        events.push(payload);
      },
    });

    try {
      const c = ctx("session-a", "run-1");
      limiter.beforeToolCall(ev(memoryTool, "run-1"), c);
      limiter.beforeToolCall(ev(memoryTool, "run-1"), c);
      limiter.beforeToolCall(ev(memoryTool, "run-1"), c);
      limiter.beforeToolCall(ev(memoryTool, "run-1"), c); // blocked

      const blocks = events.filter((p) => p.event === "tool_call_limit_block");
      expect(blocks.length).toBe(1);
      expect(blocks[0].tool).toBe(memoryTool);
      expect(blocks[0].limit).toBe(MEMORY_TOOL_CALL_LIMIT_DEFAULT);
      expect(blocks[0].count).toBe(MEMORY_TOOL_CALL_LIMIT_DEFAULT + 1);
      expect(blocks[0].sessionKey).toBe("session-a");
    } finally {
      resetReporter();
    }
  });

  it("falls back to a session-key turn when runId is unavailable", () => {
    // No runId anywhere — counter still works, keyed per sessionKey
    const c = ctx("session-a");
    limiter.beforeToolCall(ev(memoryTool), c);
    limiter.beforeToolCall(ev(memoryTool), c);
    limiter.beforeToolCall(ev(memoryTool), c);
    expect(limiter.beforeToolCall(ev(memoryTool), c)?.block).toBe(true);
  });

  it("honours a configurable limit", () => {
    const small = new MemoryToolCallLimiter(2);
    const c = ctx("session-a", "run-1");
    expect(small.beforeToolCall(ev(memoryTool, "run-1"), c)).toBeUndefined();
    expect(small.beforeToolCall(ev(memoryTool, "run-1"), c)).toBeUndefined();
    const decision = small.beforeToolCall(ev(memoryTool, "run-1"), c);
    expect(decision?.block).toBe(true);
    expect(decision?.blockReason).toContain("2");
  });
});
