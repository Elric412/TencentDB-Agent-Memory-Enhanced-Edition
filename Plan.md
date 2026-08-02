# Plan — Enhanced Fork of TencentDB Agent Memory

**Scope.** This document plans a fork of `@tencentdb-agent-memory/memory-tencentdb` (v0.3.6) that (a) fixes what is provably broken, (b) replaces three mechanisms that are currently "an LLM is asked nicely" with mechanisms that have invariants, and (c) turns the system into a library that any agent harness can embed — explicitly not an MCP server.

## 0. How to read this document

**Evidence rule.** Every claim about the current system carries a `path:line`. Every claim about an external technique carries a name and a citation (§10). Claims with neither are labelled as bets.

**Ambition tiers.** Each enhancement in §3 is tagged:

| Tier | Meaning |
|---|---|
| `fix` | Restores intended behaviour. No assumption is dropped. |
| `increment` | Improves a mechanism within the existing design frame. |
| `step-change` | Drops a load-bearing assumption (§2.5). Requires a kill-shot critique with a real answer and an explicit rollback path. |

**Confidence.** Each enhancement declares `confidence: high | medium | bet`. A `bet` must name its falsifier — the observation that would make me abandon it.

**Ordering rule.** §3 proposals each begin with the *baseline* fix (the obvious move) and state where it falls short. If nothing survives that test, the item is downgraded to `increment` and moves on. The baseline is never dressed up as the proposal.

---

## 1. Step 1 — What the system actually is

### 1.1 Shape and entry points

Single npm package, ESM, Node ≥ 22.16, published with exactly one export map entry: `"." → ./dist/index.mjs` (`package.json:12-17`). That entry is an **OpenClaw plugin**, not a library. `openclaw.compat.pluginApi >= 2026.3.13`; `openclaw >= 2026.3.7` is a peer dependency.

`index.ts` (866 lines) is the plugin shell. It registers:

- two agent-callable tools — `tdai_memory_search` (`index.ts:352`) and `tdai_conversation_search` (`index.ts:439`);
- lifecycle hooks — `before_prompt_build` (recall), `agent_end` (capture), `before_message_write`, `session_end`, `gateway_stop`;
- the offload subsystem via `registerOffload()` (`src/offload/index.ts:268`), which claims OpenClaw's **exclusive** `contextEngine` slot.

Two nearly independent subsystems live in the repo and share only the data directory and the logger:

| | Short-term ("offload") | Long-term (L0→L3) |
|---|---|---|
| Root | `src/offload/**` | `src/core/**` |
| Trigger | tool-call loop | conversation turns |
| Artifacts | `offload-<sessionId>.jsonl`, `refs/*.md`, `mmds/*.mmd`, `state.json` | `conversations/YYYY-MM-DD.jsonl`, SQLite/TCVDB rows, `scene_blocks/*.md`, `persona.md` |
| Host-neutral facade | **none** | `TdaiCore` (`src/core/tdai-core.ts`) |

That last row is the single most consequential structural fact in the repo, and §4 is built on it. `grep -n "offload" src/core/tdai-core.ts` returns nothing: the host-neutral facade does not know the short-term engine exists.

### 1.2 Short-term data flow: log → symbol compression → storage → retrieval

**(1) Observe.** `createAfterToolCallHandler` (`src/offload/hooks/after-tool-call.ts:94`) fires per tool call. It first runs `classifyPatchEffectiveness` (`:122`) to detect whether the host actually populated `event.messages`; if not, it warns and degrades. It skips approval-pending tools (`:169`), re-reads the active `.mmd` **from disk on every tool call** (`readMmd`, `:207`), refreshes a hardcoded-Chinese `<current_task_context>` message (`:214-222`), estimates tokens with a cheap heuristic (`quickTokenEstimate`, `:364`; CJK ≈ 1.5 tok/char, else /4, `:378`) with `MAX_CONSECUTIVE_QUICK_SKIPS = 5` (`:418`), and can run the whole L3 compression cascade inline inside the tool loop (`:458-553`).

**(2) L1 — tool-pair summarisation.** `flushL1` (`src/offload/index.ts:412`) batches `L1_BATCH_SIZE = 5` tool pairs, `MAX_L1_CHUNK_RETRIES = 3`. Before the LLM call it archives each raw tool result to `refs/<isoFilename>.md` (`writeRefMd`, `src/offload/storage.ts:532`). Then **one** LLM call with `L1_SYSTEM_PROMPT` (`src/offload/local-llm/prompts/l1-prompt.ts:9`) returning a JSON array of:

```
{ tool_call, summary (≤200 chars), tool_call_id, timestamp, score }
```

`score` is defined in the prompt (`l1-prompt.ts:26`) as *替代性* — how completely the summary can replace the original, 0–10. **This is the value function the entire L3 compression policy is built on, and it is a one-shot self-assessment by the model that just wrote the summary.**

Entries are appended to `offload-<sessionId>.jsonl` with `node_id: null` (`appendOffloadEntries`, `storage.ts:257`). On LLM failure a degraded entry is written with `summary: "[L1 degraded] …"` and `score: 0` (`src/offload/index.ts:507-515`).

**(3) L1.5 — task-boundary judgment.** `attemptL15` (`src/offload/index.ts:554`) / `judgeL15` (`:659`), one LLM call with `L15_SYSTEM_PROMPT` (`src/offload/local-llm/prompts/l15-prompt.ts:9`), sees the last 6 messages, the full active `.mmd`, and metadata for up to 10 historical `.mmd` files (`availableMmds = allMmds.slice(-10)`, `src/offload/index.ts:558`). Returns:

```
{ taskCompleted, isLongTask, isContinuation, continuationMmdFile, newTaskLabel }
```

This decides which `.mmd` is "active" and pushes a boundary into `l15Boundaries` (`src/offload/state-manager.ts:117`) — a **runtime-only** array, not in `DEFAULT_STATE` (`state-manager.ts:23`), wiped by `switchSession` (`:284-285`).

**(4) L2 — the Mermaid canvas. This is the "symbolic compression".** There is no algorithm. `checkL2Trigger` (`src/offload/pipelines/l2-mermaid.ts:96`) groups pending entries by L1.5 boundary and fires when either `eligibleNullCount >= l2NullThreshold` (default 4, `src/config.ts:254`) or a timeout elapses. `runL2WithBackend` (`src/offload/index.ts:694`) marks up to `L2_BATCH_SIZE = 30` entries `node_id = "wait"` and issues one LLM call with `L2_SYSTEM_PROMPT` (`src/offload/local-llm/prompts/l2-prompt.ts:9`).

That prompt asks a single model call to simultaneously:

- emit a `flowchart TD` with a `%%{ taskGoal, progress, createdTime, updatedTime }%%` header (`l2-prompt.ts:33`);
- use node format `NodeID["stage: action<br/>status: done|doing|paused|blocked<br/>summary: …<br/>Timestamp: ISO8601"]` (`:28`);
- decide node merging/splitting on its own judgment ("弹性聚合… 逻辑大洗牌", `:13`, `:24`);
- keep the file under 4000 chars (`:30`), with soft warnings injected at 2500 and 2000 chars (`:99-105`);
- emit a **complete** `node_mapping: {tool_call_id → node_id}` covering every input id (`:29`, "绝对不允许遗漏");
- choose between `write` (whole-file rewrite) and `replace_blocks` with **line-number-accurate** `start_line`/`end_line` against a line-numbered rendering of the existing file (`:41-47`, `:107-116`).

`patchMmd` (`storage.ts:579`) applies the line ranges, falling back to `writeMmd`. `backfillNodeIds` (`l2-mermaid.ts:220`) then handles the mapping gaps: unmapped `wait` entries all receive `getMostFrequent(mappedNodeIds)` (`:268`) or, failing that, `pickMmdDerivedFallbackNodeId` (`:68`) — the highest-numbered node in the file.

**(5) Storage.** Flat files under a per-agent directory. `parseSessionKey` (`storage.ts:73`) requires `agent:<name>:<id>`. Entries are JSONL; `appendOffloadEntries` re-reads the entire file for dedup on every append (`:257`); `rewriteOffloadEntries` (`:351`) and `rewriteAllOffloadEntries` (`:469`) are plain non-atomic `writeFile`; `markOffloadStatus` (`:362`) is read-all-then-rewrite-all.

**(6) Retrieval — two paths, one of them is prose.**

- *Push path*: `injectMmdIntoMessages` (`src/offload/mmd-injector.ts:33`) inserts a single `role: "user"` message carrying marker `_mmdContextMessage` (`:20`) containing the entire active `.mmd` inside `<current_task_context>`. Refresh is gated by `computeFingerprint` = `${content.length}:${content.slice(0,64)}` (`:372`).
- *Pull path*: there is **no retrieval API**. The injected block contains a Chinese sentence (`mmd-injector.ts:354`) instructing the model to look up the node in `offload.{sessionid}.jsonl` and read the `result_ref` file itself; the same pointer is embedded in each replaced tool result (`src/offload/l3-helpers.ts:228`). Retrieval of archived tool output therefore depends on (i) the host exposing generic file tools, (ii) the model reading Chinese, (iii) the model guessing the real filename, and (iv) the reclaimer not having deleted the ref (`src/offload/reclaimer.ts:288-290`).

**(7) L3 — context compression.** `OffloadContextEngine.assemble()` (`src/offload/index.ts:1393`) runs, in order: fingerprint boundary delete (`:1487`), fast-path re-apply (`:1525`), `fastEstimateMessages` with `FAST_EST_SAFETY_MARGIN = 0.85` (`:1624`), tail accumulation at `TAIL_ACCUM_TARGET_RATIO = 0.60` / `MIN_KEEP = 10` (`:1690-1743`), aggressive at `AGGRESSIVE_TARGET_RATIO = 0.85` (`:1803`), mild cascade (`:1901`), emergency (`:1940`), history-MMD injection (`:1992`).

The mild cascade is `compressByScoreCascade` (`src/offload/hooks/llm-input-l3.ts:402`): collect candidates in the first `scanRatio` of the array, default missing scores to 5 (`:446`), sort descending by score (`:452`), then walk `threshold` from `MILD_CASCADE_INITIAL_SCORE = 7` down to `MILD_CASCADE_FLOOR_SCORE = 1` (`:114-115`, `:492`), replacing every candidate with `score >= threshold` (`:495`). Aggressive (`:667`) splices; emergency (`:755`) does tail-delete of the largest tool-pair group (`:848`), truncates oversized messages to 2000 chars (`:968`), then strips any non-preserved field serialising over 500 chars (`:1141`).

### 1.3 Long-term data flow: conversation → extraction → storage → retrieval

**(1) Recall (read path).** `before_prompt_build` → `performAutoRecall` (`src/core/hooks/auto-recall.ts:72`), wrapped in a `Promise.race` against `recall.timeoutMs` default 5000 (`:83-99`); on timeout it resolves `undefined` and injects nothing. Inside (`:102`): sanitize the query (`:320`), then dispatch on `recall.strategy` (`src/config.ts:93`, default `hybrid`):

- `keyword` → FTS5 BM25 via `searchL1Fts`, with a small-corpus escape hatch that ignores the score threshold when the whole result set is smaller than `maxResults` (`auto-recall.ts:429-435`);
- `embedding` → `searchL1Vector`, `topK = maxResults * 2`, threshold filter (`:450-495`);
- `hybrid` → if the store advertises `nativeHybridSearch` use it in one call (`:377-384`), else run FTS and vector in parallel and merge with **RRF, `k = 60`** (`:511-645`).

Results are formatted into lines (`formatMemoryLine`, `:678`), budgeted by `applyRecallBudget` (`:708`) — a first-come-first-served character budget over `maxCharsPerMemory` / `maxTotalRecallChars` — and split into two injection sites for prompt-cache friendliness (`:186-218`): `persona.md` body + scene navigation + a static tools guide go into `appendSystemContext`; the recalled L1 lines go into `prependContext` as `<relevant-memories>`.

**(2) Capture (write path).** `agent_end` → `performAutoCapture` (`src/core/hooks/auto-capture.ts:45`). L0 recording and cursor advance are done inside one file lock (`checkpoint.captureAtomically`, `:105`). `recordConversation` (`src/core/conversation/l0-recorder.ts:89`) slices by position and by timestamp cursor, sanitizes, filters with `shouldCaptureL0` (`src/utils/sanitize.ts:112` — drops empty, framework noise, and anything starting with `/`), and appends one JSON object per message to `conversations/YYYY-MM-DD.jsonl`. Vector indexing follows: SQLite stores metadata + FTS synchronously and embeds in a fire-and-forget background task registered in `bgTaskRegistry` (`auto-capture.ts:254-290`); remote stores embed inline. Then `scheduler.notifyConversation` (`:303`).

**(3) Scheduling.** `MemoryPipelineManager` (`src/utils/pipeline-manager.ts:192`): three serial queues (`l1Queue`, `l2Queue`, `l3Queue`, `:208-210`), per-session state, warm-up threshold doubling 1→2→4→…→`everyNConversations` (`:346-381`), idle timeout, `l2DelayAfterL1` / `l2MinInterval` / `l2MaxInterval` timers (`:759-841`), stale-session GC every 50 notifications (`:244-248`).

**(4) L1 — atomic memories.** `extractL1Memories` (`src/core/record/l1-extractor.ts:75`), quality gate `shouldExtractL1` (`src/utils/sanitize.ts:135`, includes a prompt-injection filter), one LLM call (`:296`, `timeoutMs: 180_000`) with `EXTRACT_MEMORIES_SYSTEM_PROMPT` (`src/core/prompts/l1-extraction.ts:16`). The prompt does scene segmentation and memory extraction together and constrains output to three types — `persona`, `episodic`, `instruction` — with explicit priority bands (`l1-extraction.ts:44`, `:51`, `:57`; note `instruction` priority `-1` means "absolute standing order"). `parseExtractionResult` (`l1-extractor.ts:353`) regex-matches `\[[\s\S]*\]`, and returns `[]` on any failure. The result is truncated with `extracted.slice(0, maxMemoriesPerSession)` (`:209`) — array order, not priority order. `normalizeType` (`:518`) folds `preference` into `persona`.

**(5) Dedup.** `batchDedup` (`src/core/record/l1-dedup.ts:51`) calls `countL1()` on every batch (`:82`), then generates candidates in three tiers: vector (`:202`), FTS (`:259`), skip. One LLM judgment call (`:141`, `timeoutMs: 180_000`) returns per-memory `store | update | merge | skip`. Every failure path — parse error, timeout, unknown action — funnels to `fallbackStoreAll` (`:392`).

**(6) L2 — scene distillation. Also not an algorithm.** `SceneExtractor.extract()` (`src/core/scene/scene-extractor.ts`) runs eight phases. Phase 1 backs up the whole directory (`:140`). Phase 2 builds a prompt containing per-scene summaries plus a capacity counter `**当前场景总数：N / 15**` (`buildSceneSummaries`, `:412`, `:421`) and a tiered `sceneCountWarning` string (`:153-162`). Phase 4 is:

```ts
llmOutput = await this.runner.run({
  systemPrompt, prompt: userPrompt,
  taskId: `scene-extract-${Date.now()}`,
  timeoutMs: this.timeoutMs,     // 300_000
  workspaceDir: sceneBlocksDir,  // sandbox
});
```

— an **LLM agent with read/write file tools over `scene_blocks/`**. The scene cap is a sentence. Merging is the model's judgment. Deletion is the model writing the literal string `[DELETED]` into a file, cleaned up in Phase 5 (`:259-260`). The only rollback is `bm.restoreLatestDirectory` on a thrown exception (`:227`) — and a wrong merge does not throw. Phase 8 regex-scans the model's free text for a persona-update request (`parsePersonaUpdateSignal`, `:69`).

**(7) L3 — persona.** `PersonaTrigger.shouldGenerate` (`src/core/persona/persona-trigger.ts:33`) has five priorities: explicit agent request, cold start, corrupted-persona recovery, first scene, and `memories_since_last_persona >= triggerEveryN` (default 50). `PersonaGenerator.generateLocalPersona` (`src/core/persona/persona-generator.ts:60`) diffs scene blocks changed since `last_persona_time` (`:82-89`), preloads their full text into the prompt (`:117-126`), backs up `persona.md`, and runs **another tool-enabled LLM agent** sandboxed to `dataDir` (`:149-156`) that writes `persona.md` itself. Post-processing strips navigation, escapes XML tags (`:175`), rejects empty output (`:177`), and re-appends freshly generated scene navigation (`:183-185`).

### 1.4 Dependencies, config surface, integration points

**Runtime dependencies** (`package.json`): `ai ^6` + `@ai-sdk/openai ^3` (direct LLM calls in `standalone`/`local` mode), `js-tiktoken` (o200k_base token counting), `sqlite-vec 0.1.7-alpha.2` (local vector index over `node:sqlite` `DatabaseSync`), `@node-rs/jieba` (CJK tokenisation for FTS5), `@tencentdb-agent-memory/tcvdb-text` (local BM25 sparse encoding), `undici`, `yaml`, `json5`, `zod`. Optional: `opik` (tracing). Peer: `openclaw`, `node-llama-cpp`.

**Config surface** (`src/config.ts:291-325`): `timezone`, `capture`, `extraction`, `persona`, `pipeline`, `recall`, `embedding`, `storeBackend` (`sqlite | tcvdb`), `tcvdb`, `bm25`, `memoryCleanup`, `report`, `llm` (standalone override), `offload`. `parseConfig` (`:335`) defaults everything, so `{}` is valid. Notable knobs the plan depends on: `offload.mode` (`local | backend | collect`, `:234`), `offload.l2NullThreshold` (`:254`), `offload.mildOffloadRatio` / `aggressiveCompressRatio` / `mmdMaxTokenRatio` (`:258-262`), `recall.strategy` / `maxResults` / `scoreThreshold` (`:84-95`), `persona.maxScenes` (`:53`), `pipeline.*` (`:63-78`).

**Integration points.** OpenClaw hooks and `registerContextEngine`; an HTTP gateway (`src/gateway/server.ts:5-11`) exposing `/health`, `/recall`, `/capture`, `/search/memories`, `/search/conversations`, `/session/end`, `/seed` — **long-term only, no offload endpoints**; a Hermes Python plugin; host adapters (`src/adapters/openclaw/*`, `src/adapters/standalone/*`) implementing `HostAdapter` / `LLMRunner` / `LLMRunnerFactory` (`src/core/types.ts:95`, `:133`, `:154`); `CleanContextRunner` (`src/utils/clean-context-runner.ts`) as the in-process sub-agent; metric events via `report()` (`agent_turn`, `l1_extraction`, `l2_extraction`, `l3_persona_generation`, `tool_call`, `error_degradation`).

### 1.5 Design lineage — what is borrowed, what is actually new

Naming the lineage is how §3 avoids repackaging a known idea as an invention.

| Component | Lineage | Verdict |
|---|---|---|
| L3 context compression | MemGPT-style virtual context management / paging [1]; Anthropic-style tool-result clearing and compaction [11] | **Repackaged.** Multi-tier thresholds and tail deletion are standard. |
| L1 tool-pair summaries | Abstractive per-item summarisation. Compare LLMLingua-2's *extractive*, token-classification compression [4] | **Repackaged**, and weaker than the cited alternative on faithfulness guarantees. |
| Long-term L0→L1→dedup→vector/BM25 | The Mem0 lineage [5]: extract, deduplicate, store, hybrid-retrieve | **Repackaged.** RRF `k=60` is textbook. |
| L2 scene blocks + L3 persona | Hierarchical/reflective summarisation over an episodic log (generative-agents lineage) | **Repackaged.** |
| Not present | Temporal knowledge graph with bi-temporal validity and edge invalidation (Zep/Graphiti [2]) | Absent — `IMemoryStore` (`src/core/store/types.ts:235`) has no edge primitive. |
| Not present | Zettelkasten-style memory-to-memory linking (A-MEM [3]); PPR over an entity graph (HippoRAG [6]) | Absent. |
| **Mermaid task canvas** | Closest published analogue is ACE's evolving playbook [7] | **Genuinely distinctive** — a single mutable global task-graph artifact with a many-to-one `tool_call_id → node_id` map, used simultaneously as compression target, working-state anchor, and retrieval index. |

The distinctive piece is also where the design most diverges from the literature it resembles: ACE's central finding is that monolithic LLM rewrites of an accumulated context cause **context collapse**, and its answer is itemised delta updates with utility counters [7]. This codebase's L2 prompt offers exactly the opposite affordance as a first-class option — `file_action: "write"` for "逻辑大洗牌" (`l2-prompt.ts:24`, `:40`). §3/E3 is built on that gap.

---

## 2. Step 2 — Real problems, with evidence

### 2.1 Correctness

**P1 — `result_ref` can point at another tool's output.** `writeRefMd` (`storage.ts:532`) derives the filename purely from `isoToFilename(timestamp)` (`:527`). Two tool results archived in the same millisecond overwrite each other. Parallel tool calls in one assistant turn are normal. The failure is silent and worse than data loss: the *only* pull-path for archived output (`l3-helpers.ts:228`) returns confidently wrong bytes.

**P2 — task boundaries do not survive a restart, and are positional.** `l15Boundaries` (`state-manager.ts:117`) is runtime-only — absent from `DEFAULT_STATE` (`:23`) — and cleared by `switchSession` (`:284-285`), which also resets `entryCounter = entries.length`. `pushBoundary` (`:435-440`) *overwrites* the last boundary when `startIndex` matches. `resolveEntryBoundary` (`:449`) linearly scans positions. But entries are stored in a file that gets rewritten wholesale by `rewriteAllOffloadEntries` (`storage.ts:469`). Positional indices into a mutable log. Consequence: after a restart, `checkL2Trigger` (`l2-mermaid.ts:96`) skips entries with no resolvable boundary, so pending entries can sit at `node_id: null` permanently and never enter the canvas.

**P3 — `backfillNodeIds` fabricates provenance.** `l2-mermaid.ts:220-266`: every `wait` entry the model failed to map is assigned `getMostFrequent(mappedNodeIds)` (`:268`) or the highest-numbered node in the file (`:68`). The canvas then asserts that a node summarises tool calls that were never summarised into it. Every downstream consumer that trusts `node_id` — mild-cascade grouping, history-MMD injection (`llm-input-l3.ts:1181`), the drill-down instruction — inherits the lie.

**P4 — the mild cascade's "revert" does not revert.** `llm-input-l3.ts:530-538`. When the generated summary is *longer* than the original, the code logs "reverting", but `replaceWithSummary` (`l3-helpers.ts:224`) has already destroyed the message content; the branch merely sets `_offloaded = true` and skips the counter. The in-source comment concedes it ("the net effect is minimal since the size barely increased"). Net effect: the original tool output is gone from context, replaced by something larger, and the replacement is *not counted* in `replacedCount` or `replacedDetails` — so the metrics under-report both cost and loss.

**P5 — degraded entries are immortal.** The L1 fallback writes `score: 0` (`src/offload/index.ts:514`). The mild cascade floor is `MILD_CASCADE_FLOOR_SCORE = 1` (`llm-input-l3.ts:115`) and selection is `if (c.score < threshold) continue` (`:495`). A degraded entry is therefore *never* mildly compressed; it holds full-size context until aggressive/emergency deletion throws it away entirely. The exact entries the system understands least well are the ones it keeps longest and then destroys hardest.

**P6 — stale canvas injection.** `computeFingerprint` (`mmd-injector.ts:372`) is `length + first 64 chars`. A `replace_blocks` edit that keeps total length constant and does not touch the `%%{…}%%` header — an in-place `status: doing → done` flip of equal width, say — produces an identical fingerprint and the injected block is not refreshed.

**P7 — non-atomic writes.** `rewriteOffloadEntries` (`storage.ts:351`) and `rewriteAllOffloadEntries` (`:469`) are plain `writeFile`. A crash mid-write truncates the entry log, which is simultaneously the ref index, the node index, and the L2 work queue.

**P8 — failed turns are never captured.** `index.ts:661-664`: `agent_end` returns early when `!e.success`. Failures are where the highest-value memory lives (doc 13's "the most dangerous drift is the loss of *why*"); the system is structurally blind to them.

**P9 — the advertised tool budget is not enforced.** `index.ts:350` and `:438` both carry `// TODO: implement hard per-turn call limit via before_tool_call hook + execute early-return`. The "combined limit of 3 calls per turn" exists only as English prose inside the tool description (`:358`, `:448`) and in the injected guide (`auto-recall.ts:44-47`).

**P10 — silent parse loss.** `parseExtractionResult` (`l1-extractor.ts:353-409`) returns `[]` on any parse failure. A whole extraction window disappears with no distinguishable signal from "nothing worth remembering".

**P11 — dedup failures create duplicates.** `l1-dedup.ts:392` `fallbackStoreAll` is the terminal handler for every failure path in `batchDedup`. Duplicates accumulate silently and then compete with each other in RRF at recall time.

**P12 — arbitrary truncation.** `l1-extractor.ts:209` is `extracted.slice(0, maxMemoriesPerSession)`. The prompt spends three paragraphs assigning priority bands (`l1-extraction.ts:44-57`) and the truncation ignores them.

**P13 — recall timeouts are indistinguishable from empty recall.** `auto-recall.ts:92-97` resolves `undefined` on timeout; the caller cannot tell a 5-second timeout from "no memories matched", and no counter separates them.

### 2.2 Where cost actually is

Ranked by expected contribution, with the mechanism named:

1. **L2 output tokens.** Every `file_action: "write"` re-emits the entire canvas (up to ~4000 chars, `l2-prompt.ts:30`) plus the full `node_mapping`. Triggered as often as every 4 pending entries (`config.ts:254`). This is the largest recurring generation cost in the short-term path, and most of it is re-transcription of unchanged text.
2. **`countTokens(JSON.stringify(m))` over every message.** `computeAggressiveDeleteCount` (`llm-input-l3.ts:633`) runs full tiktoken over the entire array. `fast-token-estimate.ts` and `quickTokenEstimate` (`after-tool-call.ts:364`) exist precisely because this is too slow — meaning the system carries two token counters and a skip heuristic (`MAX_CONSECUTIVE_QUICK_SKIPS = 5`, `:418`) to work around one hot path.
3. **Disk I/O in the tool loop.** `readMmd` on every tool call (`after-tool-call.ts:207`); `appendOffloadEntries` re-reads the whole JSONL for dedup on every append (`storage.ts:257`) — O(N²) over a session; `readAllOffloadEntries` (`:418`) reads every `offload-*.jsonl` in the agent directory; `markOffloadStatus` (`:362`) is read-all + rewrite-all.
4. **Recall latency on the user's critical path.** `performAutoRecall` sits in `before_prompt_build` with a 5-second budget (`config.ts:95`). In non-native-hybrid mode it does an embedding round-trip plus an FTS query per turn (`auto-recall.ts:524-583`).
5. **Long-horizon LLM agents.** Scene extraction runs a tool-enabled agent with a 300-second timeout (`scene-extractor.ts:214`); persona generation another with 180 seconds (`persona-generator.ts:153`). Both are background, but both are full agent loops, not single calls.

### 2.3 Where memory quality degrades, and by which code path

**Q1 — compression decisions rest on an unvalidated self-report.** The L3 mild cascade orders the world by `entry.score` (`llm-input-l3.ts:446`, `:452`, `:495`), and `score` is produced by the same model call that wrote the summary, in the same JSON object (`l1-prompt.ts:26`), before anyone knows what the task will later need. Nothing in the codebase ever compares that prediction to an outcome. There is no feedback loop, so there is no calibration, so the number is a prior dressed as a measurement.

**Q2 — "never summarize summaries" is violated by construction.** `buildL2UserPrompt` receives only `{toolCallId, toolCall, summary, timestamp}` (`l2-prompt.ts:58-63`, `:120-123`). L2 never sees `refs/*.md`. Node summaries are summaries of L1 summaries. `buildHistoryMmdInjection` (`llm-input-l3.ts:1181`) then compresses the canvas again for injection. Three lossy stages, no regeneration from the lossless floor, and no drift measurement — the exact anti-pattern doc 13 names as the Golden Rule violation.

**Q3 — scene merging can fuse distinct entities with no check.** `scene-extractor.ts` gives an LLM write access to `scene_blocks/` (`:214`) with merge pressure applied as prompt text (`:153-162`, `:421`). Nothing validates that a merge is legitimate. A merge of "user's side project" and "user's employer" produces a plausible, well-formatted, wrong scene block, which then feeds persona generation (`persona-generator.ts:95-104`), which then gets injected into *every* turn as `<user-persona>` (`auto-recall.ts:198`). One unchecked merge propagates to the top of every future prompt.

**Q4 — retrieval treats standing orders as search hits.** `instruction` memories are ranked in the same pool, by the same lexical/semantic signal, as `episodic` events (`auto-recall.ts:511-645`). But a rule like "always answer in Chinese, keep it terse" shares essentially no vocabulary with the user's actual question — it is precisely the class similarity search is worst at. Worse, `applyRecallBudget` (`:708-761`) is first-come-first-served over characters: one long episodic line can evict every instruction from the injection.

**Q5 — no temporal validity.** L1 records carry `activity_start_time` / `activity_end_time` in metadata (`l1-extraction.ts:90`) but there is no notion of a fact being *superseded*. Dedup can `update` or `merge` (`l1-dedup.ts` action vocabulary) — which rewrites history in place rather than recording that a belief changed. "User lives in Beijing" and "user moved to Shenzhen" are two records competing in RRF, and the more lexically similar one wins.

**Q6 — the pull path is unmeasurable.** Because drill-down is a Chinese sentence pointing at a filename (`mmd-injector.ts:354`) rather than an API, there is no event when the agent recovers archived context, no event when it fails to, and no way to attribute a task failure to a bad compression decision.

### 2.4 Coupling — why this cannot be embedded today

| Coupling | Evidence | Consequence |
|---|---|---|
| The short-term engine assumes it is the *only* context engine | `src/offload/index.ts:1228-1234`: if the configured `contextEngine` slot is not this plugin, `_contextEngineRejected = true` and every offload hook becomes a no-op | Cannot coexist with a harness that has its own compaction |
| Compression mutates the host's message objects in place | `replaceWithSummary` (`l3-helpers.ts:224-256`), `msg._offloaded = true` (`llm-input-l3.ts:500`, `:539`), `_mmdContextMessage` marker (`mmd-injector.ts:20`) | The library must own the array; no other component may hold references |
| Module-level mutable singletons | `_sharedEngine`, `_contextEngineRegistered`, `_contextEngineRejected`, `_sharedSessions`, `_l2Running`, `_l2PollHandle`, `_reclaimTimer` (`src/offload/index.ts:75-95`) | One instance per process; no multi-tenant embedding, no test isolation |
| Host resolved by hardcoded absolute path | `src/offload/index.ts:2170`, `:2178-2179` reference `/usr/local/lib/node_modules/openclaw/` and `/usr/lib/node_modules/openclaw/dist/plugin-sdk/index.js` | Breaks on any non-global install, container, or non-OpenClaw host |
| Storage is `node:fs` inline | All of `src/offload/storage.ts` | No pluggable backend for the short-term artifacts, unlike long-term which has `IMemoryStore` |
| Package exposes only the plugin | `package.json:12-17`, single `"."` export → `dist/index.mjs` | There is no importable API even for the parts that are host-neutral |
| The host-neutral facade ignores half the system | `TdaiCore` (`src/core/tdai-core.ts`) contains zero references to offload; the gateway exposes long-term routes only (`src/gateway/server.ts:5-11`) | Embedding via the existing facade gets you long-term memory and nothing else |
| Prompts and injected text are hardcoded Chinese | `after-tool-call.ts:214-222`, `mmd-injector.ts:350-359`, `auto-recall.ts:35-48`, all four `src/core/prompts/*` | Unusable in an English-first harness without forking strings |

### 2.5 Load-bearing assumptions the current design treats as fixed

These are the things the code cannot question. §3 proceeds by dropping specific ones.

- **A1 — A reference is a filename.** Refs are addressed by timestamp string (`storage.ts:527`); there is no digest, no integrity check, no dangling-pointer detection.
- **A2 — The value of a compressed item is knowable at compression time.** The entire L3 policy is driven by `score` emitted at L1 time (`l1-prompt.ts:26`).
- **A3 — The symbolic canvas must be produced by an LLM as text.** The canvas has no in-memory representation; it exists only as `.mmd` bytes plus regexes that re-parse it (`llm-input-l3.ts:1269`, `mmd-injector.ts:342`).
- **A4 — Log entries are addressable by position.** Boundaries are `startIndex` integers (`state-manager.ts:435`, `:449`) into a file that is rewritten in place.
- **A5 — Relevance is a single scalar over a homogeneous memory pool.** All three L1 types compete in one RRF ranking and one character budget (`auto-recall.ts:632`, `:708`).
- **A6 — An LLM with a filesystem sandbox is an acceptable transaction manager.** Both L2 scene and L3 persona are agents that write their own output files (`scene-extractor.ts:214`, `persona-generator.ts:149`).
- **A7 — Each layer's input is the layer below's output.** L2 reads L1 summaries, never refs (`l2-prompt.ts:120-123`).
- **A8 — The host's generic file tools are the retrieval interface for short-term memory.** There is no `expand`/`drill-down` API; there is a sentence (`mmd-injector.ts:354`).
- **A9 — Exactly one memory system exists in the process.** Exclusive context-engine slot plus module singletons (`src/offload/index.ts:75-95`, `:1228-1234`).

---

## 3. Step 3 — Enhancements

Each item: **Baseline first** → **assumption dropped** → **import check** → the six required fields.

### E1 — Content-addressed refs with verified provenance

- **Baseline first.** Append a counter or UUID to `writeRefMd`'s filename (`storage.ts:527-543`). *Where it falls short:* it removes the collision but leaves `result_ref` a bare, unverifiable path. The reclaimer can delete a ref that an entry still points at (`reclaimer.ts:288-290` parses filenames to decide orphanhood), a rewritten entry log can lose the pointer entirely (P7), and a reader has no way to tell a correct ref from a recycled one. The pointer stays unauthenticated.
- **Assumption dropped.** A1 — a reference is a filename.
- **Import check.** Content-addressable storage / Merkle object model (Git). **Adapted, not invented**; the only new part is coupling the digest to the `tool_call_id` so a ref proves *which* call it came from.
- **Problem it solves.** P1, and the orphan-GC half of P7.
- **Mechanism.** `ref_id = sha256(tool_call_id || "\0" || raw_bytes)`; stored at `refs/<ref_id>.md` with a two-line header `{tool_call_id, sha256, bytes}`. The entry carries `result_ref` **and** `ref_digest`. Reads verify the digest and the embedded `tool_call_id` before returning; a mismatch raises a typed `RefIntegrityError` and emits a metric instead of returning bytes. The reclaimer computes `live = ⋃ ref_digest over all entries` and deletes by set difference over digests, never by parsing filenames. Writes are content-addressed and therefore idempotent — a retry cannot corrupt an existing ref.
- **Expected effect.** Same-millisecond collisions → 0 by construction. `ref_integrity_failures` becomes an observable counter that is currently structurally unobservable.
- **Ambition tier.** `fix`.
- **Kill-shot critique.** *"Hashing every raw tool result adds a full pass over potentially megabyte-scale outputs on the hot path, and you already have a cheap timestamp that works 99% of the time."* — **Answer:** the bytes are already being serialised and written to disk in that same code path (`storage.ts:532`), so the hash is one extra pass over data already in memory; SHA-256 runs at GB/s and the write dominates. The "99%" figure is the problem, not the defence: the 1% failure returns *wrong content silently* into a drill-down that the system advertises as its recovery path, and it is the failure mode most correlated with parallel tool calls, i.e. with heavy sessions.
- **Cost / risk.** Migration: existing refs keep working via a legacy-path fallback that logs a deprecation counter. Digest column added to the entry schema (additive, JSONL tolerates it).
- **Confidence.** high.

### E2 — Replace the self-reported replaceability score with a measured, Belady-labelled eviction policy

- **Baseline first.** Prompt-tune the L1 scorer, or score with a stronger model, or add a second "critic" call that re-scores summaries. *Where it falls short:* all three produce a better *prior*. The quantity that matters — will the agent need this raw output again before the task ends? — is not knowable at compression time by any model, however strong. No prompt makes a one-shot self-assessment calibrated, because there is no outcome to calibrate against. The current system has never once compared a `score` to what happened next.
- **Assumption dropped.** A2 — the value of a compressed item is knowable at compression time.
- **Import check.** Two named imports, both adapted:
  - **Belady's MIN as an offline oracle plus imitation learning** — Liu et al., *An Imitation Learning Approach for Cache Replacement*, ICML 2020 [8]. Their insight is that the optimal policy is uncomputable online but trivially computable *offline from a completed trace*, and that offline-optimal labels are far better supervision than reward. Adapted: a completed agent session is exactly such a trace.
  - **GDSF (Greedy-Dual-Size-Frequency)** — Cherkasova, HPL-98-69R1 [9]; Cao & Irani, USITS'97 [10]. Cost-aware eviction that scores by benefit ÷ size, with frequency and an aging term to prevent stale high-scorers from pinning the cache. Adapted: "size" is tokens saved, "cost" is the price of a re-fetch.
  - *Invented here:* the label source. Not re-access alone (see kill-shot) but **re-access ∪ tool-repetition** — the observation that an agent which has lost necessary context re-issues the same tool with the same normalised parameters.
- **Problem it solves.** Q1, and it makes P5 measurable rather than merely visible.
- **Mechanism.** Three parts, in dependency order.
  1. *Instrument.* Requires **E8**. Every `expand()` call emits `reaccess{tool_call_id, node_id, Δturns_since_replacement}`. Independently, a normalised tool-call signature `hash(tool_name, canonical(params))` is recorded per call; a repeat of a signature whose earlier result was replaced emits `repeat_after_replacement{tool_call_id, Δturns}`.
  2. *Label offline.* At session end, replay the trace. An item's Belady label is `SHOULD_HAVE_KEPT` iff it was re-accessed or repeated before its task's terminal L1.5 boundary, else `SAFE_TO_REPLACE`. No annotation, no judge model.
  3. *Score online.* Replace `entry.score ?? 5` (`llm-input-l3.ts:446`) with

     `H(e) = w₁·llm_score(e)/10 + w₂·(1 − summary_tokens/original_tokens) + w₃·log(1+repeat_prior(tool_class)) + w₄·recency_decay(e) − aging(clock)`

     — GDSF-shaped, with `aging` as the classic inflation term so an old high-`H` entry cannot pin context forever, and `repeat_prior` a per-tool-class empirical rate (a `read_file` on a file that was later edited is a very different risk than a `web_search`). Weights `w₁..w₄` fit by logistic regression on the Belady labels; a default vector ships with the library and a `tdai fit-eviction` script refits from a local event log. The LLM `score` is demoted from decision to feature.
- **Expected effect.** The target metric is **re-fetch rate after replacement** = fraction of mildly-compressed items the agent later had to expand or re-run. It is currently unmeasured and unmeasurable. Target: hold token savings at the current level (README claims −33% to −61%, `README.md:40-43`) while bringing re-fetch rate under 5%; or, at a fixed re-fetch rate, recover 5–10 percentage points of additional savings by safely replacing items the LLM scored conservatively. I state this as a *target*, not a prediction — see confidence.
- **Ambition tier.** `step-change`.
- **Kill-shot critique.** *"Re-access is a censored label. The agent cannot re-access what it does not know it lost. You will train a policy that happily discards silently-critical context, score beautifully offline, and degrade real task success — the classic reward-hacking outcome, and exactly what doc 33's AIDE² findings warn about."* — **Answer:** the objection is correct against re-access alone, and it is the reason the label is a union. Tool-repetition is the counter-signal: an agent that lost a file's contents does not need to know it lost them to re-read the file — it re-reads because the answer is not in context. Repetition is observable *without* the agent being aware of the loss, which is precisely the blind spot re-access has. Three further guards, all cheap: (i) the drill-down affordance is advertised in every injected canvas block and every replaced tool result (`mmd-injector.ts:354`, `l3-helpers.ts:228`), so the re-access action is available at every step, bounding the censoring; (ii) `error_degradation` events and L1.5 `taskCompleted` regressions are joined into the label as weak negatives; (iii) evaluation uses a held-out benchmark split — fit on WideSearch/AA-LCR traces, evaluate on SWE-bench traces — because a policy that only wins on its training distribution is the failure this critique describes.
  **Falsifier (named, as required).** If, across ≥ 200 sessions, `repeat_after_replacement` shows correlation `r < 0.2` with replacement events, then the label carries no signal about loss, the whole learned-policy story is unsupported, and E2 must be abandoned in favour of the far more modest E2′: keep the LLM score, add only the GDSF `size` and `aging` terms (which need no labels at all).
- **Cost / risk.** Requires E8 shipped and a session's worth of events before it can do better than the default weights; ships behind `policy.eviction: "llm_score" | "gdsf" | "learned"` with `llm_score` as the default until the falsifier test passes. Risk of overfitting to one harness's tool vocabulary — mitigated by making `repeat_prior` per-tool-class and refittable locally.
- **Confidence.** bet (mechanism is sound and the imports are real; the *magnitude* is unknown until Phase 0 measures the baseline re-fetch rate, which nobody has ever measured).

### E3 — Two-writer canvas: deterministic structure, LLM for judgment and prose only

- **Baseline first.** Improve the L2 prompt: more explicit mapping instructions, a larger char budget, few-shot examples, a retry on invalid JSON. *Where it falls short:* the prompt is already carrying eight distinct responsibilities simultaneously (§1.2 step 4), including **line-number arithmetic against a line-numbered rendering of a file** (`l2-prompt.ts:41-47`). `backfillNodeIds` (`l2-mermaid.ts:220`) exists solely because the mapping-completeness instruction — stated in the prompt in the strongest possible terms, "绝对不允许遗漏" (`l2-prompt.ts:29`) — is not reliably followed. Prompt improvements move the failure rate; they cannot make it checkable, because there is nothing to check against.
- **Assumption dropped.** A3 — the symbolic canvas must be produced by an LLM as text.
- **Import check.** ACE's central result: monolithic rewrites of an accumulated context cause **context collapse**, and the fix is itemised delta updates with utility counters [7]. Adapted directly — the codebase currently offers monolithic rewrite as a first-class option (`file_action: "write"`). Second import: compiler practice of keeping an AST and rendering text from it, rather than editing text. Also the graph-engineering discipline of deterministic code nodes for dedup/sort/route. **The synthesis is the contribution:** narrowing the LLM to exactly the two sub-problems that require judgment, while making every checkable property code.
- **Problem it solves.** P3, P6, the L2 half of §2.2 cost item 1, and Q2's error compounding (with E7).
- **Mechanism.** Persist the canvas as a typed structure, render `.mmd` from it:

  ```ts
  type TaskGraph = {
    meta: { taskGoal, progress, createdTime, updatedTime, schema: 1 },
    nodes: Map<NodeId, { label, status, summary, tsMin, tsMax, members: ToolCallId[] }>,
    edges: Array<{ from, to, label?, style: "solid" | "dotted" }>,
  }
  ```

  The L2 call is narrowed to two pure jobs and nothing else:
  - **assign** — for each new `tool_call_id`, return an existing `NodeId` or `"NEW"`, plus a ≤15-word reason;
  - **describe** — for each node whose membership changed, return a ≤150-char summary and a status.

  Everything checkable becomes code: monotonic id allocation (`<prefix>-N<k>`), `tsMin`/`tsMax` from member timestamps, `progress` from status counts, char-budget enforcement, mermaid rendering, and — critically — no line arithmetic at all, because there is no text patching. Validation is total: if any input id is missing from the assignment, the call is retried **with only the missing ids**, not the whole batch. After two failed retries the ids go to an explicit `unassigned` bucket that is visible in the canvas as a real node labelled "unclassified", rather than being silently glued onto the most popular node.

  Re-topologisation is preserved but promoted to an explicit operation: `recompact(graph)` may emit an entirely new node set, and is triggered at L1.5 task boundaries or when node count crosses a threshold — never as a side effect of an incremental update. It is guarded by a hard invariant checked in code:

  `⋃ members(new nodes) == ⋃ members(old nodes)` — no `tool_call_id` may be dropped or invented.

- **Expected effect.** `backfillNodeIds` deleted; `node_mapping` coverage becomes 1.0 by construction. Output tokens per L2 call drop from "the whole graph" to "≈ N assignment lines + a few summaries" — on a 4000-char graph with a 30-entry batch, roughly a 5–10× reduction in generated tokens per call. The class of `patchMmd` line-drift corruptions disappears because line patching disappears.
- **Ambition tier.** `step-change`.
- **Kill-shot critique.** *"You have reinvented a knowledge graph and thrown away the only genuinely interesting thing here — the LLM's freedom to re-topologise as understanding changes (`l2-prompt.ts:13`, `:24`). Freeze the structure and the graph accretes forever; you get a 200-node hairball that is strictly worse than today's occasionally-corrupt but occasionally-brilliant rewrite."* — **Answer:** re-topologisation is kept, not removed; what changes is that it becomes budgeted, triggered, and *verified*. Today a full rewrite can silently drop tool calls and nobody can tell, because there is no prior structure to diff against — `backfillNodeIds` is the evidence that this already happens. With a typed graph, `recompact` gets the membership-conservation invariant above, which is uncheckable in the current design and cheap in the new one. So the structure buys re-topologisation *with a safety net*, and the hairball risk is handled by the same trigger that today's char-budget warnings gesture at (`l2-prompt.ts:99-105`) — except enforced.
- **Cost / risk.** The largest change in this plan. Needs: a legacy `.mmd` parser (the regexes already exist at `llm-input-l3.ts:1269` and `mmd-injector.ts:342` and are sufficient for a one-way migration), two artifacts kept in sync (mitigated by making `.mmd` a pure derived render, never read back), and re-prompting L2. Rollback: `canvas.writer: "llm_text" | "structured"`, defaulting to `llm_text` until exit criteria in Phase 3 are met.
- **Confidence.** high on the mechanism and the cost reduction; medium on the quality gain, because the assignment sub-problem is still an LLM call and could be the dominant error term.

### E4 — Sequence-numbered entries and an append-only boundary log

- **Baseline first.** Add `l15Boundaries` to `DEFAULT_STATE` (`state-manager.ts:23`) so it persists. *Where it falls short:* persistence fixes restart amnesia but not the underlying defect — the boundaries are *positions* into a log that gets rewritten in place (`storage.ts:469`), and `pushBoundary` overwrites the previous boundary on index collision (`state-manager.ts:435-440`). Persisting a stale index is not an improvement.
- **Assumption dropped.** A4 — log entries are addressable by position.
- **Import check.** Log-sequence numbers from write-ahead logging; MVCC's rule that a version identifier is never reused. Adapted, standard.
- **Problem it solves.** P2, and it is a prerequisite for E1's digest-based reclamation and E2's trace replay.
- **Mechanism.** Every entry gets a monotonically increasing `seq` at append time, never renumbered, preserved across every rewrite. Boundaries become records `{fromSeq, mmdFile, decidedAt, judgment}` appended to `boundaries.jsonl` and never mutated; a later decision for the same range appends a superseding record rather than overwriting. `resolveEntryBoundary` becomes a binary search over `fromSeq`. `checkL2Trigger` filters on `seq > lastProcessedSeq`.
- **Expected effect.** The "entries stranded at `node_id: null` after a restart" class is eliminated. L2 trigger evaluation becomes deterministic and replayable — which Phase 0 needs.
- **Ambition tier.** `fix`.
- **Kill-shot critique.** *"You are adding a monotonic counter to a JSONL file with no transaction manager; two processes appending concurrently will duplicate `seq`."* — **Answer:** true, and the codebase already has the primitive: `acquireL1Lock` (`state-manager.ts:326`) serialises the L1 write path today. `seq` is allocated under that same lock; the invariant is enforced at read time by rejecting non-monotonic entries into a quarantine file rather than silently accepting them. Cross-*process* concurrency is out of scope here and is addressed by E-Fix F6's atomic-rename write path plus a per-directory lockfile.
- **Cost / risk.** Additive schema change; a one-time backfill assigns `seq` by file order on first read of a legacy log.
- **Confidence.** high.

### E5 — Class-partitioned recall: structured compatibility before semantic similarity

- **Baseline first.** Raise `recall.maxResults`, tune `scoreThreshold`, or add a cross-encoder reranker after RRF (`auto-recall.ts:632`). *Where it falls short:* all three improve *ordering inside a pool that should not exist*. A standing instruction ("always reply in Chinese, be terse") and an episodic fact ("flew to Osaka 2025-05-01") are ranked by the same signal against the same query, and then compete for the same character budget on a first-come-first-served basis (`applyRecallBudget`, `:708-761`). A perfect reranker still cannot retrieve an instruction that shares no vocabulary with the question, because similarity is the wrong relation for that class.
- **Assumption dropped.** A5 — relevance is a single scalar over a homogeneous memory pool.
- **Import check.** "Structured compatibility before semantic similarity" and per-class retrieval budgets are the retrieval discipline from the progressive-disclosure design notes; faceted retrieval is classical IR. Zep's bi-temporal validity [2] supplies the applicability predicate for episodic facts. **Adapted.** The invented part is the *budget partition* being a first-class config surface rather than an emergent property of line ordering.
- **Problem it solves.** Q4, and partially Q5.
- **Mechanism.** Two stages.
  - *Stage 1 — admission (deterministic, no LLM, no embedding).* Partition by `type`.
    - `instruction`: admitted by **standing-order semantics**, not search. Ranked by the priority bands the extraction prompt already produces (`l1-extraction.ts:57`; `-1` = absolute, `90-100` = core rule, `70-80` = important) and by supersession state, then filled up to a reserved budget share.
    - `persona`: admitted by priority × recency decay, up to its own share.
    - `episodic`: admitted only if it passes a compatibility predicate — activity-window overlap with any temporal expression in the query, or shared `scene_name`, or entity overlap via `source_message_ids`.
  - *Stage 2 — ranking.* RRF runs **within the episodic pool only**. Budget is `{instruction: 25%, persona: 25%, episodic: 50%}` by default and configurable; unused share in one class spills to the others.
- **Expected effect.** The headline metric is **instruction-adherence recall** — the fraction of turns where an applicable stored instruction is actually present in the injected block. Today that number is unmeasured and can be structurally 0 for any turn whose wording does not overlap the rule. This is also the most plausible mechanism behind the PersonaMem gap the README advertises (`README.md:43`).
- **Ambition tier.** `step-change`.
- **Kill-shot critique.** *"Bypassing similarity for instructions is how you get instruction bloat and contradiction. After 200 sessions you have 40 standing orders, half stale, mutually inconsistent, injected on every turn — you have reinvented the prompt-bloat problem you claim to solve, and similarity search was at least acting as a filter."* — **Answer:** correct, and it means the class needs a *lifecycle*, not just a bypass. Three mechanisms, each grounded in code that already exists: (i) `l1-dedup.ts` already has an `update | merge | skip` action vocabulary — extend it with `supersede`, which marks the older record inactive with a pointer to its successor rather than rewriting it in place, giving a bounded active set and, incidentally, fixing Q5's loss-of-history; (ii) the instruction budget is a hard cap ranked by priority band, so bloat degrades gracefully into "top-N rules" instead of unbounded growth; (iii) contradiction detection: two *active* instructions whose embeddings exceed cosine 0.9 but were extracted more than N sessions apart are flagged for supersession review during the fidelity audit (E7). **Falsifier:** if under this policy the active instruction set does not stabilise below ~20 items across 200 sessions, the bypass is unsafe and recall reverts to similarity-gated for instructions.
- **Cost / risk.** Adds a `superseded_by` column and an `active` predicate to L1 reads (both stores). Stage-1 admission is pure set arithmetic over data already in the row, so latency cost is ~0 — it *removes* work from the vector path by shrinking the pool.
- **Confidence.** high on the mechanism; medium on magnitude, pending a labelled recall set (Phase 0 deliverable).

### E6 — Scene distillation as propose-validate-commit

- **Baseline first.** Tighten the scene prompt, lower `persona.maxScenes`, keep more backups (`scene-extractor.ts:140`). *Where it falls short:* none of these adds a single check. The mechanism is an LLM agent with write access to `scene_blocks/` (`:214`); the cap is a sentence (`:421`); deletion is the literal string `[DELETED]` (`:259`); and the only rollback path is `restoreLatestDirectory` **on a thrown exception** (`:227`). A merge that fuses two distinct entities into one plausible, well-formatted scene block does not throw. Prompt tightening changes the probability of a silent corruption; it does not make the corruption detectable.
- **Assumption dropped.** A6 — an LLM with a filesystem sandbox is an acceptable transaction manager.
- **Import check.** Two-phase commit with write-set validation (optimistic concurrency control); entity resolution with blocking and an explicit match/non-match decision (Fellegi–Sunter lineage), as used for synonymy edges in HippoRAG [6]. Doc 22's "3+ examples before promotion" supplies the abstraction gate. **Adapted.** The invented part: defining "same entity" as *co-occurrence in an L1 record* so that the compatibility test is a set operation over ids and needs no NER call.
- **Problem it solves.** Q3, and the persona-propagation blast radius that follows from it.
- **Mechanism.** The LLM stops writing files. It emits a **change proposal**:

  ```ts
  type SceneOp =
    | { op: "create", filename, content, evidence: L1Id[] }
    | { op: "append", target,  content, evidence: L1Id[] }
    | { op: "merge",  targets: string[], content, evidence: L1Id[], rationale }
    | { op: "split",  target, into: Array<{filename, content, evidence: L1Id[]}> }
    | { op: "retire", target, absorbedBy: string[] }
  ```

  A deterministic applier validates before anything touches disk:
  - **merge compatibility** — for `merge(A, B)`, compute the L1 record sets behind A and B. If no record contains material from both, the merge is *not rejected* but **retyped** as an `abstract` block that carries both evidence sets and is excluded from the concrete-scene cap. Concrete scenes may only merge on evidence of co-occurrence. This is the promotion gate: abstraction is allowed, but it must be labelled as abstraction.
  - **evidence conservation** — every `retire` requires the retired block's evidence set to be fully covered by `absorbedBy`. No orphaned L1 ids, checked as a set difference.
  - **cap enforcement** — `maxScenes` is enforced in code; a proposal that would exceed it is rejected with a machine-readable reason and re-prompted with that reason.
  - **atomic commit** — the whole validated proposal is written to `scene_blocks.next/`, fsynced, and `rename`d over the live directory. Partial application becomes impossible; rollback is a rename, not a restore.
- **Expected effect.** Converts a silent-corruption path into a rejected-proposal path with a logged reason. New observable metrics: `scene_proposal_rejection_rate` (by reason), `orphaned_evidence_count` (0 by construction), `abstract_block_ratio`.
- **Ambition tier.** `step-change`.
- **Kill-shot critique.** *"Your entity-compatibility check needs entity extraction, so you have pushed the unreliability down one layer and added an LLM call. And a co-occurrence rule blocks the legitimate abstraction the scene layer exists to produce — 'I help this user with backend work' spans projects that never co-occur in a single message."* — **Answer:** (i) no extraction is needed. L1 records already carry `source_message_ids` and `scene_name` (`l1-extraction.ts:82`, `:75`); "same entity" is operationalised as "appears in the same L1 record", which is a set intersection over ids — deterministic, free, and no model in the loop. (ii) The rule is a *promotion gate*, not a prohibition: cross-context merges are permitted and produce an explicitly typed `abstract` block that keeps both evidence sets and does not consume concrete-scene capacity. So the abstraction survives, is labelled, and is auditable — instead of being smuggled into a concrete scene where nothing can tell it apart from a factual claim about one project.
- **Cost / risk.** Proposal schema plus a migration for existing blocks (a one-time evidence-backfill pass over L1 `source_message_ids`). The LLM must be re-prompted to emit proposals instead of using tools — which also **removes** the tool-enabled runner requirement for L2, simplifying the standalone host path.
- **Confidence.** high on the mechanism; medium on the merge-error rate improvement, which needs the sampled audit in §5 to quantify.

### E7 — Regenerate from the lossless floor, and audit the drift

- **Baseline first.** Feed more raw content into L2. *Where it falls short:* the raw content does not fit — that is why L1 exists. Feeding it wholesale just moves the context problem one layer up.
- **Assumption dropped.** A7 — each layer's input is the layer below's output.
- **Import check.** The "never summarize summaries" discipline and the periodic reconciliation / drift-audit pattern (drift > 15% → rebuild) come straight from the long-running-fidelity notes; the mechanism here — *budgeted, membership-triggered* regeneration — is the adaptation that makes it affordable in this codebase.
- **Problem it solves.** Q2.
- **Mechanism.** Two parts.
  1. *Regeneration.* When E3's `describe` step runs for a node whose membership changed, it reads the members' `refs/*.md` up to a per-call raw budget (default 8k tokens, selecting members with the lowest `H` confidence first) rather than reading L1 summary strings. Because E3 makes the number of touched nodes per call typically 1–3, this is affordable in a way that feeding raw output into today's whole-graph rewrite is not.
  2. *Fidelity audit.* A sampled background job: pick K nodes, re-derive their summaries from refs with a fixed prompt at temperature 0, score agreement 0–100. If the rolling mean drift exceeds 15, mark the canvas `stale` and schedule a `recompact`. The same job re-checks the E5 instruction-contradiction predicate.
- **Expected effect.** Bounds compounding error across the three lossy stages, and produces a **canvas fidelity number** where today there is none.
- **Ambition tier.** `increment` (the mechanism is a budgeted re-read; the discipline is imported wholesale).
- **Kill-shot critique.** *"Re-reading refs is precisely the token cost the offload system exists to avoid; you have reintroduced raw tool output through the back door, and the audit adds a whole extra LLM job."* — **Answer:** the budget is per-*touched-node*, not per-batch, and E3 is what makes touched-node count small — which is why E7 is scheduled after E3 and is meaningless before it. The audit is sampled (K nodes per N calls, both config) and runs in the background queue that already exists (`pipeline-manager.ts:210`). **Falsifier / kill switch:** if measured L2 cost rises more than 15% for a fidelity gain under 5 points, regeneration ships off by default and only the audit remains.
- **Cost / risk.** Extra reads; bounded by config. Depends on E1 (refs must be trustworthy) and E3.
- **Confidence.** medium.

### E8 — A real expansion API to replace the prose drill-down

- **Baseline first.** Fix the instruction string and translate it — note it currently names the wrong file (`offload.{sessionid}.jsonl`, `mmd-injector.ts:354`, versus the actual `offload-<sessionId>.jsonl` produced in `storage.ts`). *Where it falls short:* it remains an unmeasurable, unbounded, host-dependent affordance that requires the host to expose generic file tools and the model to construct a correct path. It is also the *single* recovery path for everything L3 deleted.
- **Assumption dropped.** A8 — the host's generic file tools are the retrieval interface for short-term memory.
- **Import check.** Standard tool-API design; the only notable choice is that expansion is **budgeted and windowed** rather than whole-file, which is the LongLLMLingua-style question-aware selection idea applied to a retrieval boundary rather than to token pruning.
- **Problem it solves.** Q6, part of A9's coupling story, and it is a hard prerequisite for E2.
- **Mechanism.** `tdai_context_expand({ node_id?, tool_call_id?, query?, maxTokens })`. Resolves through the entry index (by `seq`, per E4), verifies the ref digest (per E1), returns content windowed around `query` matches when `query` is supplied and head-truncated otherwise, always under `maxTokens`. Emits the `reaccess` event E2 consumes. Ships with a shared per-turn budget enforced in the `before_tool_call` hook — implementing the two TODOs at `index.ts:350` and `index.ts:438` — covering all three tools (`tdai_memory_search`, `tdai_conversation_search`, `tdai_context_expand`), replacing prose enforcement with real enforcement.
- **Expected effect.** Makes the recovery path measurable, host-independent, and bounded. Unlocks every quantitative claim in E2.
- **Ambition tier.** `increment` — but it is on the critical path for a `step-change`.
- **Kill-shot critique.** *"Another tool is another tool-choice failure mode, and it eats a slot. Your agents already under-use the two search tools you have — so much so that their advertised call limit was never even implemented (`index.ts:350`, `:438`)."* — **Answer:** this argues for *replacing*, not adding. `tdai_context_expand` subsumes the ad-hoc `read_file` path the system already instructs the model to take, so the number of distinct actions available to the model does not increase — one of them just becomes typed, budgeted, and instrumented. And the observation about under-use is the argument *for* instrumentation: nobody currently knows whether the drill-down is used at all, because no code path can observe it.
- **Cost / risk.** Low. One tool, one hook, one event.
- **Confidence.** high.

### E9 — Degraded entries get a retry queue and an explicit unknown

- **Baseline first.** Lower `MILD_CASCADE_FLOOR_SCORE` to 0. *Where it falls short:* it makes degraded entries the *first* thing replaced at the floor, replacing a 2000-char truncated raw result with a `[L1 degraded]` string that never had a real summary — trading immortality for guaranteed loss. The real defect is that `score: 0` (`src/offload/index.ts:514`) overloads "worthless" onto "unknown".
- **Assumption dropped.** None. Labelled `increment` and moving on, per the ordering rule.
- **Problem it solves.** P5.
- **Mechanism.** Degraded entries carry `score: null` (an explicit unknown, distinct from 0) and are enqueued for L1 retry with exponential backoff against the existing serial queue. Until a retry succeeds they are excluded from the mild cascade *and* protected from emergency tail-deletion ahead of scored entries — the ordering becomes: scored-safe → scored-risky → unknown → unknown-with-exhausted-retries.
- **Expected effect.** Removes the "least-understood entries are destroyed hardest" inversion. New counter: `degraded_entry_rate`, currently invisible.
- **Ambition tier.** `increment`.
- **Kill-shot critique.** *"Protecting entries you failed to summarise means one flaky LLM window pins your context window."* — **Answer:** the protection is bounded by retry exhaustion and by an absolute cap on the unknown pool (config, default 10 entries); past the cap, oldest-unknown is evicted first.
- **Cost / risk.** Minimal.
- **Confidence.** high.

### 3.1 Considered and rejected / flagged

Included because the discipline of rejecting the fashionable option is part of the evidence standard.

- **Migrate L1 to a temporal knowledge graph (Zep/Graphiti [2]).** *Rejected for this fork.* `IMemoryStore` (`src/core/store/types.ts:235`) has no edge primitive, and both backends are flat-record-plus-vector. Retrofitting a graph means rewriting the storage layer, both adapters, and the migration scripts — and the quality gap this repo actually exhibits (§2.3) is dominated by class-blind retrieval (E5) and unchecked scene merges (E6), not by multi-hop reasoning. The *narrow* piece of Zep worth importing is bi-temporal supersession, which E5 takes without the graph.
- **Learned extractive compression (LLMLingua-2 [4]) in place of L1 summaries.** *Flagged, not scheduled.* It is a real, well-evidenced import with a faithfulness guarantee that abstractive summarisation lacks. But this system's dominant losses are **structural** — wrong `node_id` (P3), wrong `result_ref` (P1), missing instruction (Q4) — not lexical. Revisit only after Phase 4 measurement shows lexical loss is material.
- **Zettelkasten-style memory linking (A-MEM [3]).** *Rejected.* It is a plausible upgrade to the L1 layer, but it duplicates what the scene layer already attempts and would add a second organising structure with no story for reconciling the two. Adding a competing hierarchy to a system whose measured problem is inconsistency between existing layers is the wrong direction.
- **Replace the offload engine with host-native compaction (Anthropic-style tool-result clearing [11]).** *Rejected as a replacement, adopted as a control arm.* It is strictly less capable than the canvas — it has no task-state anchor — but it is the correct baseline to measure against in Phase 0. Without it, every "the canvas helps" claim is unfalsifiable.
- **Multi-agent critic panel over compression decisions.** *Rejected.* Doc 33's finding that committees underperform their best member by a large margin, combined with the per-turn latency budget on `before_prompt_build` (5s, `config.ts:95`), makes this a cost increase with a negative expected quality delta.

---

## 4. Step 4 — Integration model: a library, not a server

### 4.0 What the code says today

The package ships exactly one entry point, `"." → ./dist/index.mjs` (`package.json:12-17`), and that entry point is an OpenClaw plugin. Consuming it means accepting all of the following at once:

| Coupling in the current build | Evidence |
| --- | --- |
| Registration happens through host hooks (`api.on(...)`, `registerTool`, `registerContextEngine`) | `src/offload/index.ts:268`, `index.ts:352`, `:441` |
| The context-engine slot is exclusive and the plugin *refuses to load* if another engine holds it | `src/offload/index.ts:1228-1234` |
| Offload state is module-level, so one process = one memory system | `src/offload/index.ts:75-95` |
| The offload engine mutates the host's message array in place and leaves private markers on it | `_offloaded` at `llm-input-l3.ts:500`, `:539`; `_mmdContextMessage` at `mmd-injector.ts:20` |
| Compaction resolves OpenClaw-specific paths by string | `src/offload/index.ts:2170`, `:2178-2179` |
| The host-neutral facade (`TdaiCore`) covers long-term memory only — `grep -n "offload" src/core/tdai-core.ts` returns nothing | `src/core/tdai-core.ts` |
| The one existing non-OpenClaw surface (the Hermes HTTP gateway) exposes recall/capture/search/session-end/seed and **no offload route at all** | `src/gateway/server.ts:5-11` |

So the honest statement of the integration problem is not "add an adapter." Half the system — the half that produces the token savings the README advertises — has never been callable from outside a specific host. Everything below is shaped by that.

### 4.1 The load-bearing decision: `plan()` returns a plan

**The library never mutates the harness's message array.**

`assemble()` (`src/offload/index.ts:1393`) currently rewrites the array it is handed and stamps `_offloaded` / `_mmdContextMessage` onto message objects the host also owns. That is what makes the engine exclusive: two components cannot both rewrite the same array and both be correct, so the plugin has to claim the slot (`:1228-1234`) and reject peers.

Instead:

```ts
type ContextOp =
  | { op: "keep";    index: number }
  | { op: "replace"; index: number; block: ContentBlock; reason: OpReason; restorable: RefId }
  | { op: "drop";    index: number; reason: OpReason }
  | { op: "insert";  before: number; block: ContentBlock; reason: OpReason };

interface ContextPlan {
  ops: ContextOp[];
  tokensBefore: number;
  tokensAfter: number;      // computed with the harness's own counter, injected
  trace: PlanTrace;         // per-op: score, tier, rule that fired
}
```

The harness applies the ops, or applies some of them, or rejects the plan and asks for a smaller budget. Three things fall out of this, and they are the reason the decision is load-bearing rather than stylistic:

1. **A9 is dropped.** Two memory components can coexist because neither owns the array; the harness arbitrates. The exclusive-slot check at `src/offload/index.ts:1228-1234` becomes unnecessary rather than being worked around.
2. **Phase 0 becomes possible.** A plan is a value. You can compute it, record it, and replay it against a fixed transcript without running an agent. Every measurement in §6 depends on this; today no such artefact exists, because the decision only exists as a side effect on an array that has already been overwritten.
3. **P4 becomes structurally impossible.** The fake revert at `llm-input-l3.ts:530-538` restores a message whose content was already destroyed. If compression is a proposed op rather than an in-place edit, "revert" is "discard the op" and cannot lie.

The cost is real and is stated plainly in §6 as a risk: the harness can apply a partial plan, which means the library's token accounting is a *prediction* rather than a fact. Mitigation is that `apply()` ships in the SDK, reports what it actually applied, and the discrepancy is a first-class metric (`plan_apply_divergence`).

### 4.2 Public API surface

Shaped by what §3 needs, not by what is currently exported.

```ts
import { createMemory } from "@tencentdb-agent-memory/core";

const mem = await createMemory({
  storage,           // StorageAdapter   — §4.3
  llm,               // LLMAdapter       — existing LLMRunnerFactory shape
  embedding,         // EmbeddingAdapter — optional; absent ⇒ FTS-only, capability-gated
  policy,            // PolicyConfig     — §4.4
  clock, idGen,      // injected for deterministic replay — §4.5
  logger,            // existing Logger (src/core/types.ts:23)
});

const s = mem.session({ userId, sessionKey, sessionId, agentContext });

// ---- read path
await s.recall({ query, budget });
//   → { blocks: RecallBlock[], budgetUsed: ClassBudget, trace }
//   blocks are class-tagged (instruction | fact | episode | scene | persona) — E5.
//   budget is per-class, not one scalar — this is the API shape E5 requires,
//   and the reason the current single `maxTotalRecallChars` knob
//   (config.ts:84-95, applied at auto-recall.ts:708-761) cannot express it.

// ---- context path
await s.plan({ messages, tokenBudget, contextWindow, counter });
//   → ContextPlan (§4.1). Pure: no I/O writes, no mutation.
const applied = mem.apply(messages, plan);   // harness may skip this and apply ops itself

// ---- write path
await s.observeToolCall({ toolCallId, name, params, result, at });
//   the single ingestion point for the offload pipeline. Today this is a hook
//   handler (after-tool-call.ts:94) that can only be reached from inside OpenClaw.
await s.capture({ messages, turnStartedAt });
//   L0/L1 ingestion; wraps what auto-capture.ts:45 does today.

// ---- recovery path
await s.expand({ nodeId?, toolCallId?, query?, maxTokens });
//   → { text, provenance: { refId, digest, offsets } }   — E8, prerequisite for E2.

await s.end();     // flush; today handleSessionEnd (tdai-core.ts:359) + BG_DRAIN_TIMEOUT_MS (:193)

mem.on("reaccess",    e => {});  // fires from expand() and from plan() keep-decisions — E2's label source
mem.on("replacement", e => {});
mem.on("degradation", e => {});  // today only reachable as a report() metric event
mem.on("audit",       e => {});  // E7 fidelity drift
```

Two API-shape claims worth defending explicitly, because they are the places where the surface is *not* the obvious one:

- **`recall()` returns class-tagged blocks and a per-class budget, not a ranked list.** A ranked list is the obvious shape and it is what `applyRecallBudget` (`auto-recall.ts:708-761`) consumes today; that shape is precisely what makes Q4 possible — a standing instruction competes on cosine similarity against an episodic fact and gets evicted by arrival order. An API that returns one list cannot express "the instruction is not a search hit."
- **`plan()` takes `counter`.** The harness's tokenizer, not ours. The system currently mixes `js-tiktoken` o200k_base with a heuristic `quickTokenEstimate` (`after-tool-call.ts:364`, `_quickCountTokens` at `:378`) and then makes eviction decisions against a ratio (`offload.mildOffloadRatio`, `config.ts:258`). A library that guesses the host's token accounting will systematically over- or under-compress on any host whose tokenizer differs. Taking the counter as a parameter converts a silent error into a required argument.

### 4.3 Pluggable backends

Four adapters. Two already exist in usable shape; two do not exist at all.

**`StorageAdapter`** — the substantive work. `IMemoryStore` (`src/core/store/types.ts:235`) already abstracts L0/L1 across SQLite+`sqlite-vec` and TencentDB VectorDB, with honest capability reporting (`StoreCapabilities`, `:181`). The offload artefacts have no such abstraction: `src/offload/storage.ts` calls `node:fs` directly throughout (`appendOffloadEntries` `:257`, `rewriteOffloadEntries` `:351`, `readAllOffloadEntries` `:418`, `writeRefMd` `:532`, `patchMmd` `:579`, `listMmds` `:635`). Extend the interface:

```ts
interface StorageAdapter extends IMemoryStore {
  putRef(bytes: Uint8Array): Promise<RefId>;        // content-addressed — E1
  getRef(id: RefId): Promise<Uint8Array | null>;
  listRefs(scope: SessionScope): AsyncIterable<RefMeta>;

  appendEntries(scope, entries: Entry[]): Promise<void>;   // seq-numbered — E4
  readEntries(scope, from?: Seq): Promise<Entry[]>;
  rewriteEntries(scope, entries: Entry[]): Promise<void>;  // must be atomic — F6

  readGraph(scope): Promise<TaskGraph | null>;      // typed, not text — E3
  writeGraph(scope, g: TaskGraph, expect: Version): Promise<CommitResult>;  // CAS

  casState(scope, expect: Version, next: SessionState): Promise<CommitResult>;
}
```

`writeGraph`/`casState` take an expected version and return a commit result rather than `void`. That is the whole of E3's two-writer safety and E4's boundary durability expressed at the storage boundary — a filesystem backend implements it with temp-write + `fsync` + `rename`, an object-store backend with a conditional PUT, and a SQL backend with a transaction. Ordinary `writeFile` cannot implement it, which is the point: the current non-atomic rewrites (F6) stop being an implementation detail and become an interface violation.

**`LLMAdapter`** — reuse `LLMRunnerFactory.createRunner()` / `LLMRunner.run()` (`src/core/types.ts:95-107`, `:133`) unchanged. It already carries the two things the pipelines need: a tool-enabled mode and a `workspaceDir` sandbox (`RuntimeContext`, `:41`), which is what `CleanContextRunner` relies on for scene extraction (`scene-extractor.ts:214`) and persona generation (`persona-generator.ts:149-156`).

**`EmbeddingAdapter`** — optional. Absent ⇒ capabilities report `vectorSearch: false` and hybrid recall degrades to FTS/BM25, which the store layer already models (`StoreCapabilities`, `src/core/store/types.ts:181`).

**`Clock` / `IdGen`** — injected. Today `Date.now()` and `crypto.randomBytes` are called inline (`auto-capture.ts:41-43`, `isoToFilename` at `storage.ts:527`). Injecting them is what makes Phase 0 replay bit-reproducible, and it is also the cheapest possible regression test for F1: a fixed clock makes the millisecond-collision bug deterministic instead of a heisenbug.

### 4.4 Configuration

`parseConfig` (`src/config.ts:335`) already produces a validated, layered object covering extraction, persona, pipeline, recall, and offload (`:18-325`). Keep it; change three things:

1. **Presets over knobs.** `policy: "conservative" | "balanced" | "aggressive" | PolicyConfig`. The current surface exposes `mildOffloadRatio`, `aggressiveCompressRatio`, `mmdMaxTokenRatio`, `l2NullThreshold` (`config.ts:254-262`) as free parameters with no stated interaction. Named presets, plus the escape hatch to the full object.
2. **Every threshold in the config, none in a constant.** `MILD_CASCADE_FLOOR_SCORE` (`llm-input-l3.ts:115`), `MAX_CONSECUTIVE_QUICK_SKIPS` (`after-tool-call.ts:418`), `RRF_K` (`auto-recall.ts:600`), `BG_DRAIN_TIMEOUT_MS` (`tdai-core.ts:193`) are load-bearing values currently unreachable from the outside. Anything a benchmark would sweep must be settable.
3. **Prompts and message strings are configuration.** The hardcoded Chinese strings at `mmd-injector.ts:354` and `after-tool-call.ts:214-222` are injected into the model's context on every turn and cannot be changed without a fork (F15).

### 4.5 Wiring examples

**(a) A bare while-loop harness** — the minimum viable integration:

```ts
const mem = await createMemory({ storage: fsStore(dir), llm, policy: "balanced", counter });
const s = mem.session({ userId, sessionKey, sessionId });

let messages = [system, ...history];
for (;;) {
  const recalled = await s.recall({ query: lastUserText(messages), budget: RECALL_BUDGET });
  const plan = await s.plan({ messages, tokenBudget: CTX * 0.8, contextWindow: CTX, counter });
  messages = mem.apply(messages, plan);                       // harness decides
  const out = await model.generate([...recalled.blocks, ...messages]);
  for (const tc of out.toolCalls) {
    const r = await runTool(tc);
    await s.observeToolCall({ toolCallId: tc.id, name: tc.name, params: tc.args, result: r, at: now() });
  }
  if (out.done) break;
}
await s.capture({ messages, turnStartedAt });
await s.end();
```

**(b) A graph/state-machine framework** — the library appears as two nodes plus one event sink. Per the graph-engineering playbook, `plan()` is a *deterministic code node*: given the same messages, policy, and stored state it returns the same ops, so it can sit on the critical path without adding a model call.

```
[ recall ] → [ plan ] → [ apply ] → [ model ] → [ tools ] → [ observe ] ─┐
     ↑                                                                    │
     └────────────────────────────────────────────────────────────────────┘
                 (s.expand registered as an ordinary tool node)
```

**(c) The OpenClaw plugin becomes a thin adapter** — this is the migration target, and the file that shrinks:

```ts
export default function plugin(api) {
  const mem = createMemoryLazy({ storage: fsStore(api.dataDir), llm: api.llmFactory, policy: cfg });
  api.on("before_prompt_build", async ctx => {
    const plan = await mem.session(ctxOf(ctx)).plan({ messages: ctx.messages, ...budgets(ctx) });
    ctx.messages = mem.apply(ctx.messages, plan);
  });
  api.on("after_tool_call", ctx => mem.session(ctxOf(ctx)).observeToolCall(toolEvent(ctx)));
  api.on("agent_end",       ctx => mem.session(ctxOf(ctx)).capture(turnOf(ctx)));   // incl. failed turns — F10
  api.registerTool(expandTool(mem), searchTool(mem), convTool(mem));
}
```

Note what is *not* there: no `registerContextEngine` exclusivity claim, no module-level singletons, no hardcoded path resolution. Those three are the entirety of the OpenClaw lock-in and all three are consequences of §4.1.

### 4.6 Stable contract vs internal

| Stable — semver-governed | Internal — may change in any release |
| --- | --- |
| `createMemory`, `Memory`, `Session` | The `.mmd` text format and node-id scheme (`<prefix>-N<k>`) |
| `ContextPlan` / `ContextOp` / `PlanTrace` | Every prompt string (`l1-prompt.ts`, `l15-prompt.ts`, `l2-prompt.ts`) |
| `RecallBlock` + its class taxonomy | Scoring weights, cascade thresholds, `RRF_K` defaults |
| The four adapter interfaces | JSONL layout on disk (migration provided, format not promised) |
| Event names and payloads | `_offloaded` / `_mmdContextMessage` markers — **these disappear**; nothing may depend on them |
| The config schema (additive changes only) | The `TaskGraph` internal representation behind `readGraph`/`writeGraph` |

The `.mmd` format is deliberately on the right-hand side. E3 replaces the LLM-authored Mermaid text with a typed `TaskGraph` whose Mermaid rendering is a *view*; if the text format were a stable contract, E3 could not ship.

### 4.7 Why this is not an MCP server

The distinction is not stylistic and it is not about MCP being a poor protocol. It is about which call is on the hot path.

`plan()` must run synchronously inside the harness's pre-inference path, with (i) the exact message array the harness is about to send, (ii) the harness's own token counter, and (iii) the ability to return a decision that the harness applies *before* it calls the model. MCP is a tool-call-shaped, out-of-process boundary: it is reached by the model deciding to call something, after the context has already been assembled and paid for. A memory layer that only speaks MCP is structurally incapable of doing the one thing this repo's offload engine exists to do — it cannot participate in context assembly, cannot enforce a budget against the harness's counter, and would add a serialization round-trip of the entire message array to every single inference.

There is also a plain cost argument. `plan()` fires once per turn on every turn. Shipping the full message array across a process boundary to get back an edit list, when the edit list is computed from that same array, is a round-trip whose payload is the thing being optimised.

Exactly one call in §4.2 is tool-shaped: `expand()`. It is model-initiated, infrequent, and returns a bounded payload — it would work fine over MCP, and a thin MCP façade over `expand()` alone is a reasonable future thing for somebody to build. It is listed as a non-goal in §8 rather than as a roadmap item, because building it would create pressure to move `plan()` across the same boundary, and that is the mistake this section exists to prevent.

---

## 5. Step 5 — Error-fix plan

This list is **separate from §3**. Nothing here is a feature; every item is a defect that makes the system do something other than what its own code claims it does. An item qualifies only if it can be stated as "the code at *X* asserts *Y*, and *Y* is false."

Each row: **root cause** (why it happens, not just where), **fix approach**, **detection** (the test that fails today and passes after). Severity: **S1** = silently returns wrong data to the model; **S2** = silently loses data or budget; **S3** = correctness-adjacent, cost, or maintainability.

### 5.1 S1 — silently wrong data reaches the model

**F1 — Ref filenames collide, so drill-down can return another tool call's output.**
`writeRefMd` (`storage.ts:532`) derives its filename purely from a timestamp via `isoToFilename` (`:527`) and returns `refs/${filename}` (`:543`). Two tool results archived in the same millisecond produce the same path; the second write wins and the first entry's `result_ref` now points at bytes that belong to a different tool call. Root cause: the reference identifier is a *name* derived from a non-unique attribute, and the ref path is the only drill-down route the system offers (`l3-helpers.ts:228`). Fix: content-addressed refs (E1) — filename = digest of bytes, ref = `{digest, byteLen}`, verify on read, reject on mismatch. Detection: a test that writes two distinct payloads with the clock frozen (possible once `Clock` is injected, §4.3) and asserts both are retrievable with correct content. Today that test fails.

**F2 — The "revert" in the mild cascade does not revert.**
`llm-input-l3.ts:530-538` restores a message reference after over-compression, but the content object was already replaced in place by `replaceWithSummary` (`l3-helpers.ts:224`); the restore hands back a message whose payload is the summary. Root cause: in-place mutation makes the pre-state unrecoverable, so "revert" can only be a gesture. Compounding: the failure is not counted anywhere, so the rate is unknown. Fix: short term, deep-copy the block before replacement and restore the copy, and emit a `revert_failed` counter; long term this disappears under §4.1, where compression is a proposed op. Detection: assert content equality after a forced revert.

**F3 — Degraded entries are immortal and crowd out real content.**
When L1 extraction fails, entries are stored with `score: 0` (`src/offload/index.ts:514`). The mild cascade floors at `MILD_CASCADE_FLOOR_SCORE = 1` (`llm-input-l3.ts:115`) and skips anything below the current threshold (`:495`). Since `score` is *replaceability* (`l1-prompt.ts:26`), score 0 means "never replace" — so precisely the entries the system failed to understand become the ones it will never compress, and pressure falls on well-summarised content instead. Root cause: `0` is being used for two incompatible meanings, "definitely keep" and "unknown." Fix: F3 is the correctness half of E9 — `score: null` as an explicit unknown with its own ordering position. Detection: a fixture with three degraded entries under memory pressure must not produce a plan that leaves all three untouched.

**F4 — Task boundaries are lost on session switch and can be overwritten.**
`l15Boundaries` lives only in runtime state (`state-manager.ts:117`) and is reset by `switchSession` (`:284-285`); `pushBoundary` (`:435-440`) overwrites on index collision; boundaries are positional indices into a log that `rewriteAllOffloadEntries` (`storage.ts:469`) renumbers. Root cause: an index into a mutable sequence used as a durable identifier. Fix: `seq`-numbered entries plus an append-only `boundaries.jsonl` (E4). Detection: write boundaries, switch sessions, rewrite the log, and assert boundary→entry resolution still points at the same entries.

**F5 — `backfillNodeIds` invents provenance.**
`l2-mermaid.ts:220-266` fills missing `node_mapping` entries using `getMostFrequent` (`:268`) and `pickMmdDerivedFallbackNodeId` (`:68`). This produces a mapping that is syntactically valid and semantically fabricated: a tool call is attributed to whichever node happened to be popular. Downstream, that attribution is what the drill-down prose (`mmd-injector.ts:354`) tells the model to trust. Root cause: the L2 prompt demands total mapping coverage ("绝对不允许遗漏", `l2-prompt.ts:29`), and when the model fails to deliver it, the code manufactures coverage instead of recording a gap. Fix: unmapped calls get `node_id: null` and are surfaced as an explicit `unmapped` count; the fallback heuristic is deleted, not improved. Detection: feed an L2 response with a deliberate mapping gap and assert no invented ids appear.

**F8 — Stale canvas injection from a weak fingerprint.**
`computeFingerprint` (`mmd-injector.ts:372`) is `${content.length}:${content.slice(0, 64)}`. Mermaid canvases share a header and change in the middle; two different canvases of equal length with an identical first 64 characters are not a contrived case, they are the normal case for an edited graph. The result is that `maybeUpdateMmdInMessages` (`:127`) concludes "unchanged" and injects an outdated task state. Root cause: a cheap fingerprint chosen for a workload it does not match. Fix: hash the full content (the digest machinery from E1 already exists at that point). Detection: two canvases, same length, same 64-char prefix, different bodies — assert the update fires.

**F15 — Drill-down instructions are hardcoded, partly in Chinese, and name the wrong thing.**
`mmd-injector.ts:354` and `after-tool-call.ts:214-222` inject fixed Chinese instruction strings into the model's context on every turn, and the drill-down prose refers to a file path that F1's collision can invalidate. Root cause: user-visible model-facing copy embedded as string literals in control-flow code. This is S1 rather than cosmetic because these strings *are* the instruction the model follows to recover compressed content. Fix: externalise into a message catalogue that is part of configuration (§4.4), with the ref identity supplied by the E1 digest rather than by a filename.

### 5.2 S2 — silent loss of data or budget

**F6 — Non-atomic rewrites can truncate the entry log.**
`rewriteOffloadEntries` (`storage.ts:351`) and `rewriteAllOffloadEntries` (`:469`) do plain `writeFile` over the live file. A crash mid-write leaves a partial JSONL; there is no temp file, no `fsync`, no rename. Root cause: durability was never a stated requirement of the storage helpers. Fix: write-temp → `fsync` → `rename`, behind the `StorageAdapter` boundary (§4.3) so every backend must provide it. Detection: inject a write failure and assert the previous file is intact and parseable.

**F10 — Failed turns are never captured.**
`index.ts:661-664` returns early from `agent_end` when the turn errored, so nothing reaches L0/L1. Root cause: the capture path treats failure as "nothing happened." But a failed turn is high-value memory — it is exactly the material for "we tried X and it did not work," and its absence means the same failure can be repeated indefinitely. Fix: capture failed turns with an outcome field, and let the L1 extraction prompt use the outcome rather than filtering the turn out upstream. Detection: run a turn that throws and assert an L0 record exists with `outcome: "error"`.

**F11 — Extraction parse failures return an empty array.**
`parseExtractionResult` (`l1-extractor.ts:353-409`) returns `[]` when the model's output does not parse. To every caller that is indistinguishable from "this conversation contained nothing worth remembering." Root cause: an error condition encoded as a valid-looking success value. Fix: throw a typed `ExtractionParseError`, count it (`l1_parse_failure_rate`), and route the turn to the retry queue from E9. Detection: feed malformed JSON and assert the counter increments rather than the pipeline reporting a clean zero-extraction turn.

**F12 — `fallbackStoreAll` writes duplicates on dedup failure.**
`l1-dedup.ts:392` stores every candidate when the dedup judgment fails. Root cause: fail-open chosen to avoid data loss, with the cost paid silently in corpus quality — duplicates then dilute retrieval and inflate every later dedup batch (`countL1` per batch, `:82`). Fix: quarantine the batch in a pending table and retry, rather than committing it to the live corpus; if retries exhaust, store with a `dedup: "unverified"` flag that recall can down-weight. Detection: force a dedup failure and assert the live corpus size is unchanged.

**F13 — Extraction truncation ignores priority.**
`l1-extractor.ts:209` applies `slice(0, maxMemoriesPerSession)` (`config.ts:43`) to the extracted list in model output order. The prompt defines explicit priority bands (`l1-extraction.ts:44`, `:51`, `:57`), and the truncation discards them. Root cause: a cap applied after extraction but before any ordering step. Fix: sort by priority band, then type, then truncate — and log what was dropped. Detection: an extraction whose last item is highest-priority must survive a cap of 1.

**F18 — Recall timeout is indistinguishable from no results.**
`performAutoRecall` (`auto-recall.ts:83-99`) races the inner call against `recall.timeoutMs` (`config.ts:95`) and returns empty on timeout. Downstream and in metrics, that is identical to a genuine miss. Root cause: two very different failure modes collapsed onto one return value. Fix: distinct `recall_timeout` counter and a distinguishable return, so §6 can report hit rate and timeout rate separately. Detection: force a timeout and assert the counters differ.

**F9 — The tool-call budget is advertised but not enforced.**
`index.ts:350` and `:438` are TODOs; the "at most 3 calls" limit exists only as prose in the tool descriptions (`:358`, `:448`) and in `MEMORY_TOOLS_GUIDE` (`auto-recall.ts:44-47`). Root cause: enforcement was deferred and the prose shipped anyway, so the documented contract and the actual behaviour differ with no runtime signal. Fix: a real shared per-turn counter in `before_tool_call`, covering all memory tools (this is the enforcement half of E8). Detection: issue four memory-tool calls in one turn and assert the fourth is refused with a structured message.

### 5.3 S3 — cost, hygiene, and maintainability

**F7 — O(N²) append-time dedup.**
`appendOffloadEntries` (`storage.ts:257`) re-reads and rescans the existing entries on every append to avoid duplicate ids. Cost grows quadratically in entries per session; for long sessions this is on the hot path of every tool call. Fix: keep an in-memory id set in session state, seeded once on load. Detection: a benchmark asserting append cost is flat in N.

**F16 — Message fingerprint is a 200-character prefix hash.**
`_msgFingerprint` (`src/offload/index.ts:123`) hashes role plus the first 200 characters. Long tool results routinely share their first 200 characters (a JSON envelope, a log preamble), so distinct messages collide and are treated as identical for change detection. Same class of defect as F8, different site; fix identically with a full-content digest. Detection: two messages with a shared 200-char prefix must produce distinct fingerprints.

**F17 — The canvas file is re-read on every tool call.**
`after-tool-call.ts:207` calls `readMmd` per tool call. On a tool-heavy turn this is repeated synchronous I/O for a file that changes only when L2 runs. Fix: cache in session state, invalidate on the L2 write (which becomes an explicit versioned commit under §4.3). Detection: count filesystem reads across a ten-tool turn.

**F14 — Hardcoded OpenClaw paths in compaction.**
`compact()` resolves host paths by string construction (`src/offload/index.ts:2170`, `:2178-2179`). This is what makes the offload engine unusable outside one host, and it is a bug rather than a design choice because the same file already receives a runtime context capable of supplying those paths. Fix: resolve through the adapter (§4.3). Detection: the offload engine runs to completion in a test harness with no OpenClaw installation — currently impossible, which is itself the finding.

### 5.4 Fix ordering

The dependency structure, stated so the roadmap in §7 is not free to reorder arbitrarily:

- **F1 → E1 → E8 → E2.** Content-addressed refs are a prerequisite for a trustworthy `expand()`, which is the only source of the re-access signal E2 learns from. Building E2 on colliding refs would train a policy on corrupted labels.
- **F4 → E3.** A typed task graph indexed by positional boundaries inherits F4's renumbering bug.
- **F2 → §4.1.** The fake revert is worth patching immediately *and* disappears under the plan-not-mutate model; do both, in that order, because the patch is what makes the migration measurable.
- **F11, F18 → §6.** Two of the metrics in §6 are uncomputable until these two error conditions stop masquerading as empty results. They are therefore Phase 0 work, not Phase 1 work.

Everything else is independent and can land in any order.

---

## 6. Metrics and success criteria

Separate from the roadmap on purpose. §7 says *when* things happen; this section says *what would have to be true* for any of it to count. If a mechanism in §3 cannot be evaluated against something here, it does not ship.

### 6.1 The measurement problem this repo has today

The README reports four benchmark results (`README.md:39-42`): WideSearch 33%→50% with tokens 221.31M→85.64M, SWE-bench 58.4%→64.2% with 3474.1M→2375.4M, AA-LCR 44.0%→47.5% with 112.0M→77.3M, and PersonaMem 48%→76%. These are the right benchmarks and they are real end-to-end numbers. They are also, for engineering purposes, nearly unusable:

- They compare *plugin on* vs *plugin off*. They cannot attribute a delta to L1 summarisation vs the L2 canvas vs L3 cascade vs long-term recall, so no individual mechanism in this plan can be credited or blamed.
- There is no compaction control arm. "Better than nothing" is not the relevant comparison when the host itself ships a compaction strategy [11].
- Several failure modes in §2 and §5 are *invisible to end-to-end scores by construction*: a wrong `result_ref` (F1) shows up as a slightly worse answer, indistinguishable from sampling noise; a fabricated `node_id` (F5) shows up as nothing at all.
- Nothing is deterministic. Timestamps, ids, and background scheduling all come from ambient sources (`storage.ts:527`, `auto-capture.ts:41-43`), so two runs of the same transcript are not the same experiment.

So the first success criterion is not a number. It is: **the same transcript, replayed twice, produces byte-identical plans.** Everything else is built on that.

### 6.2 Layer 0 — Determinism and instrumentation gates

Binary, and they gate everything downstream.

| Gate | Criterion |
| --- | --- |
| **Replay determinism** | With injected `Clock`/`IdGen` (§4.3), replaying a recorded transcript twice yields identical `ContextPlan.ops` and identical stored artefacts. |
| **Attribution** | Every op in a plan carries the rule that produced it (`PlanTrace`, §4.1), so token savings can be decomposed by mechanism. |
| **Error visibility** | `l1_parse_failure_rate` (F11), `recall_timeout` (F18), `revert_failed` (F2), `degraded_entry_rate` (E9), `unmapped_node_rate` (F5) all emit. Today all five are zero-by-construction — not because the conditions do not occur, but because the code returns a success-shaped value. |

Until these hold, every other number in this section is an anecdote.

### 6.3 Layer 1 — Mechanism metrics

These are the metrics individual §3 items are judged on. Each names the mechanism it scores and the failure it would expose.

**Compression / short-term**

| Metric | Definition | Why it exists |
| --- | --- | --- |
| `context_tokens_per_turn` | Tokens sent to the model, measured with the harness's counter (§4.2) | The headline cost number, now attributable per-rule |
| `wrong_replacement_rate` | Fraction of replaced blocks whose content is re-accessed within the same session, via `expand()` | **The central metric for E2.** A replacement followed by a re-access was a mistake by definition. Currently unmeasurable — no code path observes re-access (Q6) |
| `repeat_after_replacement` | Fraction of replacements followed by re-execution of an equivalent tool call | E2's second label channel; also E2's falsifier lives here |
| `recovery_success_rate` | `expand()` calls returning verified-correct bytes | F1's correctness, measured rather than assumed |
| `plan_apply_divergence` | Ops proposed vs ops the harness applied | The risk §4.1 accepts, made visible |

**Canvas / task state**

| Metric | Definition | Why it exists |
| --- | --- | --- |
| `canvas_entity_retention` | Fraction of entities present in canvas version *n* still present in *n+1*, excluding explicit deletes | Direct measurement of ACE-style context collapse [7]. `file_action: "write"` (`l2-prompt.ts:38-52`) makes wholesale loss a single-token decision |
| `canvas_fidelity` | Sampled audit: node summaries regenerated from refs vs stored summaries, scored for divergence | E7's signal; doc 13's >15% drift threshold is the action line |
| `mapping_coverage` / `unmapped_node_rate` | Real mapping coverage, with fabrication removed (F5) | The prompt currently demands 100% and the code manufactures it; this measures the true rate |
| `canvas_write_conflicts` | CAS rejections on `writeGraph` | E3's two-writer safety, observable |

**Retrieval / long-term**

| Metric | Definition | Why it exists |
| --- | --- | --- |
| `instruction_survival_rate` | Fraction of active standing instructions present in context when relevant | **Q4's metric.** An instruction evicted by an FCFS char budget (`auto-recall.ts:708-761`) is a silent policy violation |
| `recall_precision@k` / `recall_hit_rate` | On a labelled set, per class (instruction/fact/episode/scene/persona) | Per-class because E5's whole claim is that one pool is wrong |
| `stale_fact_rate` | Retrieved facts contradicted by a later record | Q5 — no supersession exists today |
| `entity_merge_error_rate` | Scene merges joining records with no co-occurrence support | Q3's metric and E6's acceptance test |
| `evidence_conservation` | L1 records referenced before a scene op vs after | E6's invariant, stated as a measurement |

**Cost and latency**

`llm_calls_per_turn` and `llm_tokens_per_turn` broken out by pipeline stage (L1/L1.5/L2/L3/scene/persona); `p50`/`p95` added latency on `before_prompt_build` against the 5s budget (`config.ts:95`); background queue depth and drain time at session end (`BG_DRAIN_TIMEOUT_MS`, `tdai-core.ts:193`); `storage_io_per_turn` (F7, F17).

### 6.4 Layer 2 — End-to-end criteria

Run against the four benchmarks the README already uses, with **three arms**, which is the change that matters:

1. **Off** — no memory layer.
2. **Host-native compaction** — the control arm §3.1 adopts. Without it, "the canvas helps" is unfalsifiable.
3. **This system** — at whichever phase is being evaluated.

Success criteria, stated as thresholds rather than hopes:

- **No regression floor.** No benchmark success rate may fall below the current measured baseline at any phase boundary. This is a hard gate, checked per phase.
- **Attribution requirement.** Any claimed token reduction must decompose across `PlanTrace` rules summing to within 5% of the observed total. A saving nobody can attribute is treated as unexplained and blocks the phase.
- **Beat the control.** By the end of the roadmap, arm 3 must beat arm 2 on at least one of (success rate, tokens) on every benchmark, and lose on neither by more than noise. Losing to host-native compaction on a benchmark is the single most informative negative result available, and it must be reported rather than dropped.
- **Long-term memory.** PersonaMem is the existing signal; add a supersession probe (facts that change mid-session must not be retrieved stale) and an instruction-adherence probe (standing instructions must be followed at turn 50 as reliably as at turn 5). Both target Q4/Q5, and neither is measured by PersonaMem.

### 6.5 Guarding against measuring the wrong thing

Doc 33's AIDE² result — that a large majority of self-proposed improvements are rejected once evaluated against a held-out split — is the relevant prior here, and the following are its concrete consequences:

- **Public/private benchmark split.** A public subset is used during development; a private held-out subset decides whether a phase passes. Mechanisms tuned against the public split and failing the private one are reverted, not re-tuned. The expectation, stated in advance so it is not a surprise later, is that **a majority of the mechanisms in §3 will not survive this**. E2 and E5 carry explicit falsifiers precisely because they are the most likely to be among them.
- **Token savings are never reported alone.** Every token number is paired with a success rate from the same run. Aggressive compression trivially wins on tokens; the pairing is what stops that from looking like progress.
- **Nothing is judged by an LLM grading its own output.** Canvas fidelity (E7) is scored by comparing regenerated summaries against source refs, not by asking a model whether it likes its own canvas.
- **Length-matched comparison.** Since lost-in-the-middle [12] and context-rot effects make quality a function of context length independent of content, any comparison of two retrieval strategies must hold total injected tokens roughly constant, or the result measures length rather than strategy.
