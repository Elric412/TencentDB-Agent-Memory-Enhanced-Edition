/**
 * Hard per-turn call limit for the memory tools.
 *
 * The tool descriptions have always *stated* a combined limit of 3 calls per
 * turn for tdai_memory_search + tdai_conversation_search, but nothing in code
 * enforced it (index.ts:350/:438 TODOs). This module is the enforcement half:
 * a shared per-turn counter consulted from the `before_tool_call` hook in
 * index.ts. It covers all memory tools together rather than each one
 * separately, and emits a `tool_call_limit_block` metric event every time the
 * stated contract and actual behaviour would otherwise have diverged.
 *
 * Turn identity: `runId` (event.runId ?? ctx.runId) when the host provides
 * one; otherwise the counter degrades to a per-sessionKey counter. Each new
 * runId observed for a session resets that session's budget.
 */

import { report } from "../report/reporter.js";

/** Memory tools covered by the combined per-turn limit. */
export const MEMORY_TOOL_NAMES = [
  "tdai_memory_search",
  "tdai_conversation_search",
] as const;

/** Default combined per-turn call budget (matches the tool descriptions). */
export const MEMORY_TOOL_CALL_LIMIT_DEFAULT = 3;

export interface ToolCallLimiterEvent {
  toolName?: string;
  runId?: string;
}

export interface ToolCallLimiterCtx {
  sessionKey?: string;
  runId?: string;
}

export interface ToolCallLimitDecision {
  block: true;
  blockReason: string;
}

interface TurnBudget {
  runId: string | null;
  count: number;
}

export class MemoryToolCallLimiter {
  private readonly limit: number;
  private readonly budgets = new Map<string, TurnBudget>();

  constructor(limit: number = MEMORY_TOOL_CALL_LIMIT_DEFAULT) {
    this.limit = limit;
  }

  /**
   * Consulted from the before_tool_call hook. Returns undefined to allow the
   * call, or { block: true, blockReason } to refuse it with a structured,
   * model-readable error.
   */
  beforeToolCall(
    event: ToolCallLimiterEvent,
    ctx: ToolCallLimiterCtx,
  ): ToolCallLimitDecision | undefined {
    const toolName = event.toolName ?? "";
    if (!(MEMORY_TOOL_NAMES as readonly string[]).includes(toolName)) {
      return undefined;
    }

    const sessionKey = ctx.sessionKey ?? "";
    const runId = event.runId ?? ctx.runId ?? null;

    let budget = this.budgets.get(sessionKey);
    // A new runId marks a new turn: reset the session's budget.
    if (!budget || (runId !== null && budget.runId !== runId)) {
      budget = { runId, count: 0 };
      this.budgets.set(sessionKey, budget);
    }

    budget.count += 1;

    if (budget.count <= this.limit) {
      return undefined;
    }

    report("tool_call_limit_block", {
      tool: toolName,
      count: budget.count,
      limit: this.limit,
      sessionKey,
      runId,
    });

    return {
      block: true,
      blockReason:
        `Memory tool call refused: tdai_memory_search and tdai_conversation_search ` +
        `share a combined limit of ${this.limit} calls per turn, and this turn has ` +
        `already used ${budget.count - 1}. Do not retry this tool in this turn; ` +
        `answer the user with what you have, or ask them to continue in a new message.`,
    };
  }
}
