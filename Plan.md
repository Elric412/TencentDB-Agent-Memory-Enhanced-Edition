# Plan — Enhanced Fork of TencentDB Agent Memory

**What this document is.** A plan for forking `@tencentdb-agent-memory/memory-tencentdb` (v0.3.6). Three goals, in priority order:

1. **Fix what is provably broken.** There are defects that make the system silently hand the model the wrong data. They are listed with file and line numbers in §2 and §5.
2. **Replace three mechanisms that currently work by asking an LLM politely.** The Mermaid task canvas, scene distillation, and the compression scoring policy are all "write a prompt and hope." Each is replaced with something that has a checkable rule — a rule that code can verify, not just a model that can be nudged.
3. **Turn the system into a library.** Today it only works as a plugin for one specific agent host (OpenClaw). It should be importable by any agent loop. It is explicitly **not** going to be an MCP server, and §4.7 explains why that is a technical decision rather than a taste one.

## 0. How to read this document

### 0.1 The rules this document holds itself to

**Evidence rule.** Every statement about how the current code behaves cites a `file:line`. Every statement about an outside technique cites a paper or a source (§10). If a statement has neither, it is labelled a bet and its falsifier is named.

**Ambition tiers.** Every proposal in §3 is tagged with how much it changes:

| Tier | Meaning |
|---|---|
| `fix` | Makes the code do what it already claims to do. Nothing about the design changes. |
| `increment` | Genuinely improves a mechanism, but keeps the existing design's assumptions intact. |
| `step-change` | Throws out one of the assumptions the current design is built on (the list is in §2.5). Must survive a hostile critique and must have a documented way to turn it back off. |

**Confidence.** Each proposal declares `high`, `medium`, or `bet`. A `bet` must state the specific observation that would make me abandon it. Two proposals here are bets, and both name their exit condition.

**Ordering rule.** Every §3 proposal opens with the *obvious* fix, then says exactly where the obvious fix stops working. If the obvious fix turns out to be sufficient, the item is downgraded to `increment` and I move on. What I do not do is take the obvious fix and describe it in impressive language.

### 0.2 Vocabulary

The codebase and the research literature both use terms that are not self-explanatory. Defined once here, used consistently after.

**Terms from the codebase**

| Term | What it means here |
|---|---|
| **offload** | The repo's name for its short-term memory subsystem — everything under `src/offload/**` that shrinks tool-call output out of the live context window. |
| **L0 / L1 / L2 / L3** | Confusingly, the repo uses these labels twice for different things. In *long-term* memory: L0 = raw conversation log, L1 = extracted individual facts, L2 = scene summaries, L3 = the user persona document. In *short-term* memory: L1 = per-tool-call summaries, L1.5 = task-boundary detection, L2 = the Mermaid canvas, L3 = the context-compression cascade. Where ambiguity is possible I say "long-term L2" or "offload L2". |
| **canvas / `.mmd`** | A single Mermaid flowchart file per task that holds the agent's working state. Nodes are task stages; each node stands in for a group of tool calls. The system rewrites it as work proceeds. |
| **ref** | An archived copy of one raw tool result, saved to `refs/*.md` before that result is compressed out of context. The only way to get the original data back. |
| **entry** | One line in `offload-<sessionId>.jsonl`: a tool call, its short summary, its `tool_call_id`, and a score. |
| **`node_mapping`** | The lookup table from `tool_call_id` to canvas node id. This is what makes it possible to ask "which task stage did this tool call belong to?" |
| **`score`** | A 0–10 number the LLM assigns to each summary, meaning *how safely this summary can stand in for the original*. Higher = safer to throw the original away. The entire compression policy is driven by it. |
| **cascade** | The compression strategy: repeatedly lower a score threshold and replace everything above it, until the context fits. |
| **degraded entry** | An entry whose summarisation LLM call failed. It gets a placeholder summary and `score: 0`. |
| **recall** | Fetching long-term memories and injecting them into the prompt, before the model runs. |
| **capture** | The reverse: reading a finished conversation turn and writing memories out of it. |
| **harness** | Whatever program runs the agent loop — sends messages to a model, executes tool calls, repeats. OpenClaw is one; a plain `while` loop is another. |

**Terms from the research literature**

| Term | What it means here |
|---|---|
| **context collapse** | A failure mode identified in ACE [7]: when an LLM is asked to rewrite an accumulated document from scratch, it quietly drops most of it. The document gets shorter and shallower on each rewrite. |
| **Belady's MIN / offline oracle** | The provably optimal cache-eviction rule: throw out whatever will be needed furthest in the future. Impossible to run live because it requires knowing the future — but easy to compute *after the fact* from a finished trace. That makes it a source of perfect training labels [8]. |
| **GDSF** | Greedy-Dual-Size-Frequency, a classic web-cache eviction rule [9][10]. Ranks items by value ÷ size, adjusted for access frequency, plus an "aging" term so that an item scored highly once cannot occupy the cache forever. |
| **RRF (Reciprocal Rank Fusion)** | A standard way to merge two ranked result lists (here: keyword search and vector search) using only ranks, not scores. The repo uses the textbook constant `k = 60`. |
| **bi-temporal validity** | From Zep [2]: storing both *when a fact was true* and *when the system learned it*. This is what makes it possible to say "the user used to live in Beijing, and now lives in Shenzhen" rather than having the two facts fight each other. |
| **supersession** | Marking an old fact as replaced by a newer one, instead of overwriting it. Preserves the history of what changed. |
| **content-addressed storage** | Naming a stored file after the hash of its own contents (as Git does). Two consequences: the name proves the contents, and writing the same data twice is harmless. |
| **CAS (compare-and-swap)** | A write that only succeeds if the data has not changed since you read it. The standard defence against two writers overwriting each other. |
| **lost in the middle** | The finding [12] that models attend well to the start and end of a long context and poorly to the middle. Means that *how much* you inject affects quality independently of *what* you inject. |
| **kill-shot critique** | My own convention in this document: for each `step-change`, the strongest objection a competing memory-system builder would raise, stated as harshly as they would state it, followed by my actual answer. If I cannot answer it, the proposal does not belong here. |
| **falsifier** | The specific measurement that would prove a proposal wrong. Stated up front so that abandoning the idea later is a planned outcome rather than an embarrassment. |

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

### 1.2 Short-term memory: how a tool result travels from the log to compression to retrieval

**In one paragraph, before the details.** Every time the agent calls a tool, the system archives the raw result to a file and then asks an LLM to write a ≤200-character summary of it, along with a score saying how safe it would be to throw the original away. Separately, another LLM call decides whether the agent has finished one task and started another. A third LLM call maintains a single Mermaid flowchart representing the task's current state, and records which flowchart node each tool call belongs to. When the context window fills up, a compression cascade walks the score threshold downward, swapping raw tool results for their summaries until things fit. If the agent later needs the original data back, there is no API for that — the system injects a sentence telling the model to go find the archive file itself.

The rest of this subsection is that same story with the code attached.

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

### 1.3 Long-term memory: how a conversation becomes a persona

**In one paragraph, before the details.** Every completed conversation turn is appended to a daily log file and indexed for search. In the background, an LLM reads batches of those turns and extracts individual memories, each tagged as a persona trait, an episodic event, or a standing instruction. A second LLM call decides whether each new memory duplicates something already stored. Periodically, an LLM *agent* with file-write access reorganises those memories into "scene" documents — one per recurring context in the user's life. Then another LLM agent reads the changed scenes and rewrites a single `persona.md`. On every subsequent turn, that persona plus a search over the extracted memories gets injected into the prompt.

The rest of this subsection is that same story with the code attached.

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

Findings are numbered `P1`–`P13` (correctness), `Q1`–`Q6` (memory quality), and `A1`–`A9` (assumptions). §3 and §5 refer back to these numbers.

### 2.1 Correctness

Each finding below opens with **what actually goes wrong**, in plain terms, followed by the code that makes it happen.

**P1 — Two tool results saved in the same millisecond overwrite each other, and the survivor answers for both.**
When the system archives a raw tool result, it names the file after the current timestamp — nothing else (`writeRefMd`, `storage.ts:532`, using `isoToFilename` at `:527`). If two tool calls finish in the same millisecond, both produce the same filename and the second write wins. The first entry's pointer now resolves to a different tool call's output. Parallel tool calls within one assistant turn are completely normal, so this is not a rare race. What makes it the worst finding in this list rather than merely a bug: that archive file is the *only* way to recover data the system has compressed away (`l3-helpers.ts:228`), so the recovery path does not fail loudly — it returns confidently wrong content.

**P2 — Task boundaries vanish on restart, and they point at positions in a file that gets renumbered.**
The system tracks where one task ends and the next begins. Those boundaries are stored as array indices in memory only (`l15Boundaries`, `state-manager.ts:117`) — they are absent from the persisted `DEFAULT_STATE` (`:23`) and are wiped whenever the session switches (`:284-285`). Two further problems compound it: `pushBoundary` silently overwrites the previous boundary when two share a start index (`:435-440`), and the entries that these indices point *into* get rewritten wholesale, renumbering everything (`rewriteAllOffloadEntries`, `storage.ts:469`). The visible consequence: after a restart, the canvas trigger (`checkL2Trigger`, `l2-mermaid.ts:96`) skips any entry whose boundary it cannot resolve, so those entries sit unprocessed forever and never make it into the canvas at all.

**P3 — When the model fails to say which task stage a tool call belongs to, the code makes something up.**
The canvas is supposed to record, for every tool call, which flowchart node it belongs to. When the model's response omits some of those assignments, `backfillNodeIds` (`l2-mermaid.ts:220-266`) fills the gaps by assigning the *most frequently occurring* node id (`getMostFrequent`, `:268`), or failing that, the highest-numbered node in the file (`:68`). The result is a canvas that claims a task stage summarises tool calls it never saw. This is not a cosmetic problem, because three separate consumers trust those assignments: compression grouping, the historical-canvas injection (`llm-input-l3.ts:1181`), and the instruction that tells the model where to find archived data.

**P4 — The compression code contains a "revert" that does not revert anything.**
In the compression cascade, if a generated summary turns out *longer* than the original it was meant to shrink, the code logs that it is reverting (`llm-input-l3.ts:530-538`). But the replacement already happened — `replaceWithSummary` (`l3-helpers.ts:224`) overwrote the message content in place, so there is nothing left to restore. The branch just marks the message as offloaded and skips incrementing the counter. The source comment admits as much ("the net effect is minimal since the size barely increased"). Two things are true afterwards: the original tool output is gone and has been replaced by something *bigger*, and because the counter was skipped, the metrics do not record either the cost or the loss.

**P5 — The entries the system understood least well are the ones it protects longest, then destroys entirely.**
When summarisation fails, the entry is stored with `score: 0` (`src/offload/index.ts:514`). Remember that `score` means *replaceability* — higher is safer to discard. The gentle compression pass never goes below a threshold of 1 (`MILD_CASCADE_FLOOR_SCORE`, `llm-input-l3.ts:115`) and skips anything under the current threshold (`:495`). So a score of 0 means "never gently compress this." The entry holds full-size space in the context window until pressure escalates, and then the aggressive and emergency passes delete it outright. The inversion is exact: least-understood content is the last to be summarised and the first to be destroyed.

**P6 — The check for "has the canvas changed?" misses the most common kind of change.**
Before re-injecting the canvas into context, the system compares fingerprints to avoid redundant work. The fingerprint is the content's length plus its first 64 characters (`computeFingerprint`, `mmd-injector.ts:372`). Canvases share a standard header and change in the middle. A status flip from `doing` to `done` of equal character width leaves both the length and the first 64 characters untouched — so the fingerprint matches, the system concludes nothing changed, and the model keeps seeing the old task state.

**P7 — A crash during a log rewrite truncates the log.**
`rewriteOffloadEntries` (`storage.ts:351`) and `rewriteAllOffloadEntries` (`:469`) overwrite the live file with a plain `writeFile` — no temporary file, no rename, no flush. An interrupted write leaves a partial file. That file is simultaneously the archive index, the canvas-node index, and the work queue, so a truncation takes out all three at once.

**P8 — Turns that failed are thrown away, and those are the valuable ones.**
`agent_end` returns early whenever the turn was unsuccessful (`index.ts:661-664`), so nothing is captured. But a failed turn is exactly the material for "we tried this and it did not work" — doc 13's point that the most damaging kind of memory loss is losing the *why*. As written, the system cannot learn from failure because it never records it.

**P9 — The tool-call limit the system advertises to the model is not implemented.**
Both memory tools carry the comment `// TODO: implement hard per-turn call limit via before_tool_call hook + execute early-return` (`index.ts:350`, `:438`). The "at most 3 calls per turn" rule exists only as English text inside the tool descriptions (`:358`, `:448`) and in the guide injected into the prompt (`auto-recall.ts:44-47`). The model is being told about an enforcement mechanism that does not exist.

**P10 — When memory extraction fails to parse, it reports finding nothing.**
`parseExtractionResult` (`l1-extractor.ts:353-409`) returns an empty array on any parse failure. An empty array is also the correct answer for "this conversation genuinely contained nothing worth remembering." The two cases are indistinguishable to every caller and to every metric, so an entire window of conversation can silently disappear and register as a clean, successful, zero-memory extraction.

**P11 — When deduplication fails, everything gets stored, duplicates included.**
`fallbackStoreAll` (`l1-dedup.ts:392`) is the last-resort handler for every failure path in the dedup step. It writes all candidates to the live store. Duplicates accumulate with no signal, then compete against each other in the search ranking at recall time, so one fact crowds out others by appearing several times.

**P12 — Memory extraction discards results in whatever order the model emitted them.**
The cap is applied as `extracted.slice(0, maxMemoriesPerSession)` (`l1-extractor.ts:209`). Meanwhile the extraction prompt spends three paragraphs assigning explicit priority bands to memories (`l1-extraction.ts:44-57`), including a band that means "absolute standing order." The truncation ignores all of it and keeps whichever items happened to come out first.

**P13 — A recall that timed out looks exactly like a recall that found nothing.**
`performAutoRecall` races the lookup against a 5-second budget and resolves `undefined` on timeout (`auto-recall.ts:92-97`). The caller cannot distinguish "we ran out of time" from "no memories matched," and no counter separates them. So the system cannot tell whether its recall is unhelpful or merely too slow.

### 2.2 Where the cost actually is

Ranked by how much each one likely contributes, with the responsible mechanism named. These are hypotheses ranked by inspection; Phase 0 exists to replace them with measurements.

1. **Regenerating the whole canvas on every update.** The canvas-maintenance prompt lets the model choose to rewrite the entire file (`file_action: "write"`), which means re-emitting up to 4000 characters (`l2-prompt.ts:30`) plus the complete tool-call-to-node mapping. This can fire as often as every 4 pending entries (`config.ts:254`). Most of those generated tokens are re-transcription of text that did not change. This is very likely the single largest recurring generation cost in the short-term path.
2. **Counting tokens by serialising and tokenising every message.** `computeAggressiveDeleteCount` (`llm-input-l3.ts:633`) runs the full tokeniser across the entire message array. The strongest evidence that this is too slow is that the codebase contains a *second*, cheaper token estimator to avoid it (`quickTokenEstimate`, `after-tool-call.ts:364`, plus `fast-token-estimate.ts`) and a skip heuristic on top of that (`MAX_CONSECUTIVE_QUICK_SKIPS = 5`, `:418`). Two counters and a skip rule are three workarounds for one hot path.
3. **Filesystem work inside the tool-call loop.** The canvas file is re-read on every single tool call (`readMmd`, `after-tool-call.ts:207`). Appending an entry re-reads the whole log to check for duplicates (`appendOffloadEntries`, `storage.ts:257`), which makes total append cost grow with the square of the number of entries in a session. `readAllOffloadEntries` (`:418`) reads every log file in the agent's directory, and `markOffloadStatus` (`:362`) reads everything and rewrites everything just to change one field.
4. **Recall sitting on the user's critical path.** Recall runs before the prompt is built, with a 5-second budget (`config.ts:95`). Unless the storage backend supports hybrid search natively, each turn costs an embedding round-trip plus a keyword query (`auto-recall.ts:524-583`) before the model can start.
5. **Two full agent loops running in the background.** Scene extraction runs a tool-enabled LLM agent with a 300-second timeout (`scene-extractor.ts:214`); persona generation runs another with 180 seconds (`persona-generator.ts:153`). Both are off the critical path, but neither is a single model call — each is an agent that reads and writes files in a loop.

### 2.3 Where memory quality degrades, and which code path causes it

**Q1 — Every compression decision rests on a number the model assigned to its own work, which nothing ever checks.**
The compression cascade ranks everything by `entry.score` (`llm-input-l3.ts:446`, `:452`, `:495`). That score comes from the same model call that wrote the summary, in the same JSON object (`l1-prompt.ts:26`), at a moment when nobody — model included — knows what the task will need later. Nothing in the codebase ever compares that prediction against what actually happened. With no feedback there is no calibration, which makes the score a guess presented as a measurement. This is the finding E2 is built on.

**Q2 — The system summarises summaries, three levels deep, and never checks the result against the original.**
The canvas prompt receives only `{toolCallId, toolCall, summary, timestamp}` (`l2-prompt.ts:58-63`, `:120-123`) — it never sees the archived raw output in `refs/*.md`. So canvas node descriptions are summaries of summaries. Then `buildHistoryMmdInjection` (`llm-input-l3.ts:1181`) compresses the canvas *again* before injecting it. That is three lossy stages stacked, with no step that regenerates from the original data and no measurement of how far the result has drifted. Doc 13 names this specific pattern as its Golden Rule violation: never summarise a summary.

**Q3 — One bad scene merge propagates to the top of every future prompt.**
Scene reorganisation hands an LLM write access to the `scene_blocks/` directory (`scene-extractor.ts:214`) and applies pressure to consolidate purely through prompt text (`:153-162`, `:421`). Nothing validates that a merge joins things that actually belong together. Merging "the user's side project" with "the user's employer" produces a scene document that is fluent, well-formatted, and wrong. That document then feeds persona generation (`persona-generator.ts:95-104`), and the resulting persona is injected into *every* turn as `<user-persona>` (`auto-recall.ts:198`). A single unchecked merge becomes a permanent false premise.

**Q4 — Standing instructions are made to compete in a similarity search they cannot win, then evicted by arrival order.**
Instructions ("always reply in Chinese, keep it terse") are ranked in the same pool, by the same signal, as episodic events ("flew to Osaka on 2025-05-01") — see `auto-recall.ts:511-645`. But an instruction shares almost no vocabulary with the question it applies to; instructions are precisely the category similarity search handles worst. It gets worse at the budgeting step: `applyRecallBudget` (`:708-761`) fills a character budget first-come-first-served, so one long episodic line can push every instruction out of the prompt entirely. A rule that silently stops being applied is a policy violation, not a ranking imperfection.

**Q5 — Nothing records that a fact was replaced by a newer fact.**
Memories carry activity start and end times in their metadata (`l1-extraction.ts:90`), but there is no concept of one fact *superseding* another. The dedup step can `update` or `merge`, both of which rewrite the record in place rather than recording that a belief changed. So "user lives in Beijing" and "user moved to Shenzhen" end up as two coexisting records competing in the search ranking, and whichever is more lexically similar to the query wins — regardless of which is currently true.

**Q6 — There is no way to tell whether context recovery ever works.**
Recovering compressed-away data is not an API call. It is a Chinese sentence in the prompt telling the model to go read a file (`mmd-injector.ts:354`). Because no code path observes it, there is no event when the agent successfully recovers something, no event when it tries and fails, and no way to trace a task failure back to a bad compression decision. This is why several metrics in §6 currently read zero: not because the failures do not happen, but because nothing can see them.

### 2.4 Why the system cannot be embedded in another agent today

| What the code does | Where | Why it blocks embedding |
|---|---|---|
| Assumes it is the only component allowed to manage context. If the host's context-engine slot is held by anything else, the plugin sets `_contextEngineRejected = true` and every one of its hooks becomes a no-op | `src/offload/index.ts:1228-1234` | Cannot coexist with a harness that has its own compaction strategy — it does not degrade, it switches off |
| Edits the host's message objects in place and leaves private markers on them | `replaceWithSummary` (`l3-helpers.ts:224-256`); `msg._offloaded = true` (`llm-input-l3.ts:500`, `:539`); the `_mmdContextMessage` marker (`mmd-injector.ts:20`) | The library has to own the message array outright. No other component can safely hold a reference to it |
| Keeps its state in module-level variables: `_sharedEngine`, `_contextEngineRegistered`, `_contextEngineRejected`, `_sharedSessions`, `_l2Running`, `_l2PollHandle`, `_reclaimTimer` | `src/offload/index.ts:75-95` | One instance per Node process. No multi-tenancy, and no test isolation either — tests leak state into each other |
| Locates the host by hardcoded absolute path — `/usr/local/lib/node_modules/openclaw/` and `/usr/lib/node_modules/openclaw/dist/plugin-sdk/index.js` | `src/offload/index.ts:2170`, `:2178-2179` | Breaks on any non-global install, in any container with a different layout, and on any host that is not OpenClaw |
| Calls `node:fs` directly for all short-term storage | throughout `src/offload/storage.ts` | The short-term half has no pluggable storage backend, even though the long-term half already has one (`IMemoryStore`) |
| Publishes exactly one entry point, and it is the plugin | `package.json:12-17` — a single `"."` export pointing at `dist/index.mjs` | There is no importable API at all, not even for the parts of the code that are already host-neutral |
| The host-neutral facade covers only half the system: `TdaiCore` contains zero references to offload, and the HTTP gateway exposes long-term routes only | `src/core/tdai-core.ts`; `src/gateway/server.ts:5-11` | Embedding through the existing facade gets you long-term memory and none of the short-term compression — which is the half that produces the advertised token savings |
| Prompts and injected instruction text are hardcoded Chinese string literals | `after-tool-call.ts:214-222`, `mmd-injector.ts:350-359`, `auto-recall.ts:35-48`, and all four files in `src/core/prompts/` | Cannot be used in an English-first harness without forking the source to edit strings |

### 2.5 The assumptions the current design cannot question

Everything above is a symptom. These nine are the causes: beliefs baked so deeply into the code that no amount of tuning or prompt improvement can work around them. §3 proceeds by picking specific ones and dropping them — which is exactly what separates a `step-change` from an `increment` in this document.

- **A1 — A reference is a filename.** Archived tool results are addressed by a timestamp string (`storage.ts:527`). There is no hash, no integrity check, and no way to detect that a pointer has gone stale. → dropped by **E1**.
- **A2 — How valuable a piece of context is can be known at the moment you compress it.** The whole compression policy runs on a score assigned during summarisation (`l1-prompt.ts:26`), before anything is known about what the task will need. → dropped by **E2**.
- **A3 — The task canvas has to be text written by an LLM.** There is no in-memory representation of the canvas anywhere; it exists only as `.mmd` bytes plus regular expressions that re-parse those bytes (`llm-input-l3.ts:1269`, `mmd-injector.ts:342`). → dropped by **E3**.
- **A4 — Log entries can be identified by their position.** Task boundaries are stored as array indices (`state-manager.ts:435`, `:449`) into a file that gets rewritten and renumbered. → dropped by **E4**.
- **A5 — Relevance is one number over one undifferentiated pool of memories.** All three memory types compete in a single ranking and a single character budget (`auto-recall.ts:632`, `:708`). → dropped by **E5**.
- **A6 — An LLM with filesystem access is an acceptable transaction manager.** Both scene reorganisation and persona generation are agents that write their own output files, with no validation step and no way to roll back a change that did not throw an exception (`scene-extractor.ts:214`, `persona-generator.ts:149`). → dropped by **E6**.
- **A7 — Each layer reads only the layer below it.** The canvas prompt sees L1 summaries and never the archived originals (`l2-prompt.ts:120-123`), so errors compound downward with no correction path. → dropped by **E7**.
- **A8 — The host's generic file-reading tools are the retrieval interface.** There is no expansion or drill-down API. There is a sentence in the prompt (`mmd-injector.ts:354`). → dropped by **E8**.
- **A9 — There is exactly one memory system in the process.** Enforced by the exclusive context-engine slot and the module-level singletons (`src/offload/index.ts:75-95`, `:1228-1234`). → dropped by **§4.1**.

---

## 3. Step 3 — Enhancements

### 3.0 The format of each proposal, and why it has this format

Nine proposals, `E1`–`E9`. Each one is forced through the same sequence, because that sequence is what stops a plan from confidently restating the obvious.

1. **Baseline first.** What is the obvious fix — the thing any competent engineer would try first? State it plainly, then state exactly where it stops working. If the obvious fix turns out to be enough, the proposal is downgraded and I move on. This ordering exists so the obvious move can never be quietly presented as the insight.
2. **Assumption dropped.** Which of the nine assumptions in §2.5 does this abandon? If the answer is "none," the item is an `increment` at best, and the proposal says so instead of implying otherwise.
3. **Import check.** Is there already a named, published solution to this shape of problem — from caching theory, database design, information retrieval, entity resolution? If so, use it and say plainly what was borrowed and what is genuinely new here. The point is to avoid reinventing something worse than the literature, and to avoid claiming credit for something borrowed.

Then six fields, every time:

- **Problem it solves** — a specific finding from §2, by number.
- **Mechanism** — the actual algorithm or data structure. Not a goal, not a direction.
- **Expected effect** — which metric moves, and roughly how much. Where the magnitude is genuinely unknown, it says so and Phase 0 is tasked with finding out.
- **Ambition tier** — `fix`, `increment`, or `step-change`.
- **Kill-shot critique** — the harshest objection a competing memory-system builder would raise, written as harshly as they would write it, followed by my real answer. If I have no answer, the proposal is cut.
- **Cost / risk** — what this costs to build, what it might break, and how it gets turned off.

Four proposals are tagged `step-change`: E2 (learned eviction), E3 (typed canvas), E5 (class-partitioned recall), and E6 (validated scene edits). Two of those — E2 and E5 — additionally carry a named falsifier, because they are the two most likely to be wrong.

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
- **The idea in plain terms, before the formalism.** Right now the system asks a model to guess, up front, how safe each piece of context is to throw away — and never checks whether the guess was right. The alternative: after a session finishes, you can look back and see exactly which discarded items the agent turned out to need. That hindsight is free and it is perfectly accurate. So use finished sessions to generate training labels, learn what "safe to discard" actually looks like, and let the model's guess become one input among several rather than the whole decision. The signal that an item was needed is either the agent explicitly asking for it back, or the agent quietly re-running the same tool call because the answer was no longer in front of it.
- **Mechanism.** Three parts, in dependency order.
  1. *Instrument.* Requires **E8**. Every `expand()` call emits `reaccess{tool_call_id, node_id, Δturns_since_replacement}`. Independently, a normalised tool-call signature `hash(tool_name, canonical(params))` is recorded per call; a repeat of a signature whose earlier result was replaced emits `repeat_after_replacement{tool_call_id, Δturns}`.
  2. *Label offline.* At session end, replay the trace. An item is labelled `SHOULD_HAVE_KEPT` if it was re-accessed or re-run before its task ended, and `SAFE_TO_REPLACE` otherwise. This is Belady's rule applied in hindsight: no human annotation, no judge model, no reward signal — just what actually happened.
  3. *Score online.* Replace `entry.score ?? 5` (`llm-input-l3.ts:446`) with

     `H(e) = w₁·llm_score(e)/10 + w₂·(1 − summary_tokens/original_tokens) + w₃·log(1+repeat_prior(tool_class)) + w₄·recency_decay(e) − aging(clock)`

     Reading the four terms in order: how safe the model *said* it was; how much space is actually saved by replacing it (a summary that saves nothing is not worth the risk); how often this *kind* of tool call historically gets repeated after being discarded; and how recently it was used. The subtracted `aging` term is standard GDSF practice — without it, an item that once scored highly stays protected forever, which is exactly the failure P5 describes from the other direction. `repeat_prior` is per tool class because the risks genuinely differ: a file read whose file was later edited is far more likely to be needed again than a one-off web search. The weights are fitted by logistic regression against the hindsight labels; sensible defaults ship with the library, and a `tdai fit-eviction` command refits them from a local event log. Note what happened to the LLM's score: it is still there, but demoted from *the decision* to *one feature among four*.
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
- **Problem it solves.** P3, P6, the canvas-rewrite cost in §2.2 item 1, and (together with E7) the compounding error in Q2.
- **The idea in plain terms, before the formalism.** Today one model call is asked to do eight things at once, including arithmetic on line numbers. Most of those eight things do not need a model at all — allocating an id, computing a timestamp range, counting how many stages are done, keeping the file under a character budget, rendering valid Mermaid. Exactly two need judgment: deciding which task stage a new tool call belongs to, and writing a readable one-line description of a stage. So: store the canvas as a real data structure, let code do all the bookkeeping, and narrow the model down to only the two questions it is actually needed for. Mermaid stops being the source of truth and becomes a rendering of it — which also means no more editing text by line number, and therefore no more line-number bugs.
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

  The ability to reorganise the whole graph is kept, but it becomes an explicit named operation instead of a side effect. `recompact(graph)` may produce an entirely new set of nodes, and it fires at task boundaries or when the node count crosses a threshold — never as an incidental consequence of adding one entry. And it is guarded by a rule that code checks every time:

  `⋃ members(new nodes) == ⋃ members(old nodes)`

  In words: every tool call that was accounted for before the reorganisation must still be accounted for after it. None may be dropped, and none may be invented. This is the check that is impossible to perform today — there is no prior structure to compare against — and it is nearly free once the structure exists.

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
- **Problem it solves.** Q4, and part of Q5.
- **The idea in plain terms, before the formalism.** The three kinds of memory answer three different questions, so they should not be retrieved the same way. A standing instruction is not a search result — it applies because it is in force, full stop, regardless of whether it shares any words with what the user just asked. A persona trait is background that is almost always somewhat relevant. Only episodic events are genuinely a search problem. So: stop putting them in one pool. Select instructions by whether they are currently active and how important they are. Select persona traits by importance and recency. Search only over episodic events. And give each of the three its own share of the prompt budget, so a long episodic result can no longer push an active instruction out of the prompt entirely.
- **Mechanism.** Two stages.
  - *Stage 1 — admission. Deterministic: no model call, no embedding.* Split by memory type and admit each differently.
    - `instruction` — admitted because it is **in force**, not because it matched a query. Ordered by the priority bands the extraction prompt already assigns (`l1-extraction.ts:57`, where `-1` means absolute standing order, `90-100` a core rule, `70-80` important) and by whether a newer instruction has superseded it. Filled up to a reserved share of the budget.
    - `persona` — ordered by priority with a recency decay, up to its own reserved share.
    - `episodic` — admitted only if it passes a cheap compatibility test: its activity window overlaps a time expression in the query, or it shares a `scene_name`, or it shares source messages with something already admitted.
  - *Stage 2 — ranking.* The existing hybrid search and RRF merge run **only over the episodic pool**, which is now smaller. The default budget split is `{instruction: 25%, persona: 25%, episodic: 50%}`, configurable, and any share a class does not use spills to the others rather than being wasted.
- **Expected effect.** The headline metric is **instruction-adherence recall** — the fraction of turns where an applicable stored instruction is actually present in the injected block. Today that number is unmeasured and can be structurally 0 for any turn whose wording does not overlap the rule. This is also the most plausible mechanism behind the PersonaMem gap the README advertises (`README.md:43`).
- **Ambition tier.** `step-change`.
- **Kill-shot critique.** *"Bypassing similarity for instructions is how you get instruction bloat and contradiction. After 200 sessions you have 40 standing orders, half stale, mutually inconsistent, injected on every turn — you have reinvented the prompt-bloat problem you claim to solve, and similarity search was at least acting as a filter."* — **Answer:** correct, and it means the class needs a *lifecycle*, not just a bypass. Three mechanisms, each grounded in code that already exists: (i) `l1-dedup.ts` already has an `update | merge | skip` action vocabulary — extend it with `supersede`, which marks the older record inactive with a pointer to its successor rather than rewriting it in place, giving a bounded active set and, incidentally, fixing Q5's loss-of-history; (ii) the instruction budget is a hard cap ranked by priority band, so bloat degrades gracefully into "top-N rules" instead of unbounded growth; (iii) contradiction detection: two *active* instructions whose embeddings exceed cosine 0.9 but were extracted more than N sessions apart are flagged for supersession review during the fidelity audit (E7). **Falsifier:** if under this policy the active instruction set does not stabilise below ~20 items across 200 sessions, the bypass is unsafe and recall reverts to similarity-gated for instructions.
- **Cost / risk.** Adds a `superseded_by` column and an `active` predicate to L1 reads (both stores). Stage-1 admission is pure set arithmetic over data already in the row, so latency cost is ~0 — it *removes* work from the vector path by shrinking the pool.
- **Confidence.** high on the mechanism; medium on magnitude, pending a labelled recall set (Phase 0 deliverable).

### E6 — Scene distillation as propose-validate-commit

- **Baseline first.** Tighten the scene prompt, lower `persona.maxScenes`, keep more backups (`scene-extractor.ts:140`). *Where it falls short:* none of these adds a single check. The mechanism is an LLM agent with write access to `scene_blocks/` (`:214`); the cap is a sentence (`:421`); deletion is the literal string `[DELETED]` (`:259`); and the only rollback path is `restoreLatestDirectory` **on a thrown exception** (`:227`). A merge that fuses two distinct entities into one plausible, well-formatted scene block does not throw. Prompt tightening changes the probability of a silent corruption; it does not make the corruption detectable.
- **Assumption dropped.** A6 — an LLM with a filesystem sandbox is an acceptable transaction manager.
- **Import check.** Two-phase commit with write-set validation (optimistic concurrency control); entity resolution with blocking and an explicit match/non-match decision (Fellegi–Sunter lineage), as used for synonymy edges in HippoRAG [6]. Doc 22's "3+ examples before promotion" supplies the abstraction gate. **Adapted.** The invented part: defining "same entity" as *co-occurrence in an L1 record* so that the compatibility test is a set operation over ids and needs no NER call.
- **Problem it solves.** Q3, and everything downstream of it — a bad scene reaches the persona, and the persona reaches every prompt.
- **The idea in plain terms, before the formalism.** Stop letting the model write the files. Have it *propose* a list of changes instead, then have ordinary code check those changes before any of them reach disk. The most important check is on merges: before combining two scenes, look at which extracted memories each one came from. If no single memory ever mentioned both, the model is generalising rather than observing — and that is allowed, but the result gets labelled as an abstraction instead of being silently filed as a fact about one project. The rest of the checks are similarly mechanical: nothing may be retired if it would orphan the memories behind it, the scene limit is enforced by code rather than requested in prose, and the whole set of changes is written to a new directory and swapped in with a single rename, so a half-applied update cannot exist.
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

### 3.1 Considered and rejected

This section exists because a plan that only lists what it will build is not a plan — it is a wish list. Each item below is something a reader might reasonably expect to find in §3, together with the reason it is not there.

- **Migrate L1 to a temporal knowledge graph (Zep/Graphiti [2]).** *Rejected for this fork.* `IMemoryStore` (`src/core/store/types.ts:235`) has no edge primitive, and both backends are flat-record-plus-vector. Retrofitting a graph means rewriting the storage layer, both adapters, and the migration scripts — and the quality gap this repo actually exhibits (§2.3) is dominated by class-blind retrieval (E5) and unchecked scene merges (E6), not by multi-hop reasoning. The *narrow* piece of Zep worth importing is bi-temporal supersession, which E5 takes without the graph.
- **Learned extractive compression (LLMLingua-2 [4]) in place of L1 summaries.** *Flagged, not scheduled.* It is a real, well-evidenced import with a faithfulness guarantee that abstractive summarisation lacks. But this system's dominant losses are **structural** — wrong `node_id` (P3), wrong `result_ref` (P1), missing instruction (Q4) — not lexical. Revisit only after Phase 4 measurement shows lexical loss is material.
- **Zettelkasten-style memory linking (A-MEM [3]).** *Rejected.* It is a plausible upgrade to the L1 layer, but it duplicates what the scene layer already attempts and would add a second organising structure with no story for reconciling the two. Adding a competing hierarchy to a system whose measured problem is inconsistency between existing layers is the wrong direction.
- **Replace the offload engine with host-native compaction (Anthropic-style tool-result clearing [11]).** *Rejected as a replacement, adopted as a control arm.* It is strictly less capable than the canvas — it has no task-state anchor — but it is the correct baseline to measure against in Phase 0. Without it, every "the canvas helps" claim is unfalsifiable.
- **Multi-agent critic panel over compression decisions.** *Rejected.* Doc 33's finding that committees underperform their best member by a large margin, combined with the per-turn latency budget on `before_prompt_build` (5s, `config.ts:95`), makes this a cost increase with a negative expected quality delta.

---

## 4. Step 4 — Integration model: a library, not a server

**The goal of this section.** Anyone should be able to add this memory system to their agent by installing a package and calling a few functions — the same way you add a database client. Today that is impossible, and the reasons are specific rather than vague.

### 4.0 What stands in the way today

The package publishes exactly one entry point, `"." → ./dist/index.mjs` (`package.json:12-17`), and that entry point is an OpenClaw plugin. Using any of it means accepting all of the following at once:

| What the current build requires | Where |
| --- | --- |
| Registration only happens through host-specific hooks (`api.on(...)`, `registerTool`, `registerContextEngine`) | `src/offload/index.ts:268`, `index.ts:352`, `:441` |
| It must be the *only* context manager. If another component holds that slot, the plugin disables itself entirely | `src/offload/index.ts:1228-1234` |
| Its state lives in module-level variables, so there can be one instance per process and no test isolation | `src/offload/index.ts:75-95` |
| It edits the host's message array in place and leaves private markers on the message objects | `_offloaded` at `llm-input-l3.ts:500`, `:539`; `_mmdContextMessage` at `mmd-injector.ts:20` |
| It locates the host by hardcoded absolute path | `src/offload/index.ts:2170`, `:2178-2179` |
| The one host-neutral facade it has covers long-term memory only — searching `src/core/tdai-core.ts` for "offload" returns nothing | `src/core/tdai-core.ts` |
| The one non-OpenClaw interface that exists (the HTTP gateway) exposes recall, capture, search, session-end, and seed — and no short-term compression routes at all | `src/gateway/server.ts:5-11` |

The honest framing of the problem, then, is not "write an adapter." It is that half the system — specifically the half that produces the token savings the README advertises — has never been reachable from outside one particular host. Everything in this section follows from that.

### 4.1 The one decision everything else depends on: return a plan, do not apply it

**The library never edits the harness's message array. It returns a list of proposed edits and lets the harness apply them.**

Today, `assemble()` (`src/offload/index.ts:1393`) rewrites the array it is handed and stamps private markers onto message objects the host also holds references to. That single design choice is what forces the plugin to be exclusive: two components cannot both rewrite the same array and both remain correct, so the plugin claims the slot (`:1228-1234`) and refuses to run if anything else has it.

Replace it with a description of the intended change:

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

The harness can then apply all of these edits, or some of them, or none — and ask for a smaller budget instead. Three consequences follow, and together they are why this is the section everything else in §4 hangs off:

1. **Assumption A9 disappears.** Two memory components can now coexist, because neither one owns the message array; the harness decides. The exclusivity check at `src/offload/index.ts:1228-1234` is not worked around, it becomes unnecessary and gets deleted.
2. **Phase 0 becomes possible at all.** A plan is just data. You can compute it, save it, and re-compute it against a recorded transcript without running an agent or calling a model. Every measurement in §6 depends on being able to do that. Today it is impossible, because the compression decision exists only as a side effect on an array that has already been overwritten by the time you could inspect it.
3. **The fake revert (P4) becomes impossible to write.** Today's "revert" tries to restore content that was already destroyed. When compression is a *proposed* edit rather than an applied one, reverting means discarding the proposal — which cannot silently fail, because nothing has happened yet.

There is a genuine cost, and §6 tracks it as a risk rather than hiding it: since the harness may apply only part of a plan, the library's token accounting becomes a prediction rather than a fact. The mitigation is that the library ships its own `apply()`, which reports exactly what it applied, and any gap between proposed and applied is itself a metric (`plan_apply_divergence`).

### 4.2 The public API

Shaped by what the §3 mechanisms actually need, rather than by what happens to be exported today.

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

Two of these design choices are not the obvious ones, and both are worth defending explicitly.

- **`recall()` returns memories grouped by kind, each with its own budget — not one ranked list.** One ranked list is the obvious design, and it is exactly what the current code produces and consumes (`applyRecallBudget`, `auto-recall.ts:708-761`). It is also the direct cause of Q4: as soon as everything is in one list, a standing instruction has to compete on textual similarity against an episodic fact, and then loses its place in the prompt to whatever arrived first. An API whose return type is a single list has no way to express "this instruction is not a search result — it simply applies." So the shape of the return value has to change before the behaviour can.
- **`plan()` requires the caller to pass in a token counter.** The harness's counter, not the library's. Today the code mixes an exact tokeniser with a cheap character-based estimate (`quickTokenEstimate`, `after-tool-call.ts:364`; `_quickCountTokens`, `:378`) and then makes irreversible eviction decisions against a ratio of the context window (`offload.mildOffloadRatio`, `config.ts:258`). Any library that *guesses* how its host counts tokens will systematically over-compress or under-compress on every host whose tokeniser differs from its assumption — silently, and in a way that looks like a quality problem rather than an accounting problem. Making the counter a required argument turns that silent error into something the integrator cannot get wrong by accident.

### 4.3 Pluggable backends

Four things get swapped out through interfaces. Two of those interfaces already exist in usable form; two do not exist at all.

**`StorageAdapter`** — this is where the real work is. The long-term half already has a proper storage interface: `IMemoryStore` (`src/core/store/types.ts:235`) covers both SQLite and TencentDB VectorDB and honestly reports which capabilities each backend has (`StoreCapabilities`, `:181`). The short-term half has nothing equivalent — `src/offload/storage.ts` calls `node:fs` directly throughout (`appendOffloadEntries` `:257`, `rewriteOffloadEntries` `:351`, `readAllOffloadEntries` `:418`, `writeRefMd` `:532`, `patchMmd` `:579`, `listMmds` `:635`). So the interface gets extended to cover the short-term artefacts too:

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

---

## 7. Step 6 — Phased roadmap

No time estimates. Phases are ordered by dependency, and by the rule that **fixes come before step-changes**. Where that rule is broken, the deviation is stated and justified on the spot. Every phase has an entry condition, an exit condition that is a test or a measurement rather than a judgement call, and — for `step-change` work — a rollback path that gets exercised rather than merely described.

### Phase 0 — Reproduce and measure the baseline

**No behavioural changes. None.** The only code written in this phase is code that observes.

**Scope**
- Stand up the three-arm test harness from §6.4 (no memory layer / host-native compaction / current system) on all four benchmarks (`README.md:39-42`), and reproduce the published numbers within noise. If they do not reproduce, that is this phase's finding, and the roadmap stops until it is understood.
- Build the transcript recorder and replayer: capture message arrays, tool calls, and tool results, then replay them offline. This is the artefact every later measurement depends on.
- Inject `Clock` and `IdGen` (§4.3) at the three places that currently read the ambient clock and random source (`storage.ts:527`, `auto-capture.ts:41-43`). This is a pure refactor with no change in behaviour, which is why it is allowed in a no-changes phase.
- Land the instrumentation gates from §6.2 and the error counters from F11 and F18. These two fixes are prerequisites *for* measurement rather than consequences of it (§5.4).
- Record the mechanism metrics in §6.3 as they stand today. Most will read zero or be uncomputable. **That reading is the baseline**, and it is what the rest of the plan is accountable to.
- Measure §2's cost hotspots against real traces: LLM calls and tokens per pipeline stage, `before_prompt_build` p95 latency, filesystem operations per turn.

**Dependencies** — none. This is the entry point.

**Ambition tiers delivered** — none, deliberately. Two `fix`-tier items (F11, F18) are pulled forward because §6 cannot be computed without them. That is the roadmap's only forward deviation from fixes-before-features, and it moves in the conservative direction.

**Entry criteria** — the repo builds and `vitest run` passes on `main`.

**Exit criteria — all must hold**
1. Published benchmark numbers reproduced within a documented noise band, or a written explanation of the gap.
2. A recorded transcript replays twice and produces byte-identical stored files.
3. Every metric in §6.3 has either a baseline value or a written reason it cannot yet be computed, naming the code path responsible.
4. The host-native-compaction control arm runs and produces numbers.

**Rollback** — not applicable. Nothing changed.

**The uncomfortable exit condition.** If the control arm matches the current system on three of the four benchmarks, then the value of the entire offload engine is in question, and Phases 2–5 need re-scoping *before* they are built rather than after. That is a legitimate outcome of this phase and must be reported as one.

### Phase 1 — Correctness floor

**Scope** — the S1 and S2 fixes from §5 that do not require the SDK refactor: F1 (using E1's content-addressed refs), F2 (the deep-copy patch), F3 with E9, F4 with E4, F5, F6, F8, F10, F12, F13, F16. Plus the two cheap S3 items, F7 and F17, because they reduce measurement noise.

**Dependencies** — Phase 0's replay harness. Each fix needs a failing test first, and several of these bugs (F1, F8, F16) are only reliably reproducible with a frozen clock.

**Ambition tiers** — all `fix`, plus one `increment` (E9). No step-changes.

**Entry** — Phase 0's exit criteria hold.

**Exit criteria — all must hold**
1. Every listed F-item has a test that fails on the Phase-0 commit and passes now. No exceptions, and nothing "verified by inspection."
2. `recovery_success_rate` is 100% on a replay corpus that deliberately forces same-millisecond ref writes.
3. `unmapped_node_rate` reports a real value, and the fabrication path at `l2-mermaid.ts:220-266` is deleted from the codebase rather than flagged.
4. No benchmark regression against the Phase-0 baseline (§6.4's no-regression floor).
5. `degraded_entry_rate` is non-zero and observable. If it reads zero, the instrumentation is wrong, because the code path that produces degraded entries demonstrably exists.

**Rollback** — the rollback unit for `fix`-tier work is the commit; per-fix feature flags are not warranted. F3 is the exception and ships behind a config switch, because it changes eviction order and could interact with the cascade in ways unit tests will not catch.

### Phase 2 — The SDK boundary

**Scope** — all of §4. `createMemory`/`Session`/`ContextPlan`, the four adapters, and the plan-instead-of-mutate migration. Delete the exclusive context-engine claim (`src/offload/index.ts:1228-1234`) and the module-level singletons (`:75-95`). Fix F14's hardcoded paths and F15's hardcoded strings. Ship F9's real tool budget together with E8's `expand()`. The OpenClaw plugin is rewritten as the thin adapter shown in §4.5(c).

**Dependencies** — Phase 1. Moving buggy behaviour to a new boundary preserves the bugs and makes them harder to find. E1 (Phase 1) is also a hard prerequisite for E8.

**Ambition tiers** — one `increment` (E8), plus a large structural refactor that is not itself a memory mechanism. It sits here rather than later because E2, E3, E5, and E6 all need the boundary: E2 needs `expand()`'s re-access events, E3 needs a versioned `writeGraph`, E5 needs a per-class recall budget that the current API cannot express.

**Entry** — Phase 1's exit criteria hold.

**Exit criteria — all must hold**
1. The offload engine runs to completion in a test harness with no OpenClaw installed (F14's detection test).
2. Benchmark results on the replay corpus are byte-identical before and after the refactor. This is a refactor; any behavioural difference is a mistake rather than an improvement, and must be traced before the phase closes.
3. `plan_apply_divergence` is 0 when the harness uses the supplied `apply()`.
4. Two memory components can be registered in one process without either one failing to load.
5. A worked wiring example for a non-OpenClaw harness runs end to end in CI.
6. Every constant named in §4.4 is reachable from configuration.

**Rollback** — the old plugin path stays in the tree behind a build flag until exit criterion 2 has held across a full benchmark run on the private split, then it is deleted. Keeping it longer produces two code paths that drift apart.

### Phase 3 — Retrieval correctness

**Scope** — E5 in full (class-partitioned recall, standing-order semantics for instructions, the 25/25/50 budget split, and the `supersede` operation), plus the parts of E6 that are pure hygiene: the `SceneOp` schema, evidence conservation, and the atomic directory rename that replaces the current backup-and-restore dance (`scene-extractor.ts:140`, `:227`).

**Dependencies** — Phase 2's per-class recall API. This phase comes deliberately *before* the compression step-changes, for two reasons: Q4 (a standing instruction silently evicted by a character budget) is a policy violation wearing a feature's clothing, and retrieval changes are far easier to attribute than compression changes.

**Ambition tiers** — one `step-change` (E5) and the fix-shaped half of another (E6). This is the roadmap's one deviation from strict fixes-before-step-changes, and the reason is stated rather than assumed: E5's step-change component is the *semantics* of instructions — standing orders rather than search hits — and that cannot be delivered as a fix, because the current API has nowhere to put it.

**Entry** — Phase 2's exit criteria hold.

**Exit criteria — all must hold**
1. `instruction_survival_rate` ≥ 0.95 on a labelled probe set whose instructions are deliberately placed beyond the old character budget. The Phase-0 baseline is expected to be substantially lower; the actual figure is what this target gets calibrated against.
2. `stale_fact_rate` measurably reduced on the supersession probe, with `supersede` operations visible in traces.
3. `evidence_conservation` is 1.0 across all scene operations on the replay corpus — no L1 record loses its last referent.
4. `recall_precision@k` not regressed for any class relative to Phase 0.
5. PersonaMem not regressed.
6. **E5's falsifier checked.** The active instruction set must stabilise below roughly 20 items across a 200-session corpus. If it does not, instructions are accumulating without expiry, E5's standing-order model is wrong as specified, it reverts to a weighted-class scheme, and the step-change claim is withdrawn.

**Rollback** — E5 ships behind a policy switch; `recall.partitioned: false` restores single-pool ranking. CI exercises the switch in both positions for the duration of the phase, so the fallback is known to work rather than assumed to.

### Phase 4 — The typed canvas

**Scope** — E3 in full: the typed `TaskGraph` behind `readGraph`/`writeGraph`, the two-writer split (deterministic code for structural updates, narrowed LLM calls for summaries only), and `recompact` guarded by the membership invariant. Mermaid becomes a rendered view rather than the source of truth. E7's regeneration-and-audit rides along, because it needs exactly the same provenance links.

**Dependencies** — Phase 2's versioned storage, and Phase 1's F4 (`seq` numbering), since a graph indexed by positional boundaries inherits the renumbering bug.

**Ambition tiers** — one `step-change` (E3) plus one `increment` (E7).

**Entry** — Phase 3's exit criteria hold.

**Exit criteria — all must hold**
1. `canvas_entity_retention` ≥ 0.99, excluding explicit deletions. The invariant makes silent entity loss unrepresentable, so a failure here indicates a bug in the invariant check rather than a tuning problem.
2. Structural updates require zero LLM calls, and L2's share of `llm_tokens_per_turn` falls. The actual reduction is reported against the Phase-0 figure, not predicted here.
3. `canvas_write_conflicts` is observable, and every conflict resolves without data loss.
4. `canvas_fidelity` is measured, and drift above 15% triggers `recompact` automatically (doc 13's threshold).
5. The rendered Mermaid stays valid and human-readable. The canvas is a debugging surface as well as a model input, and losing that is a real cost.
6. No benchmark regression.

**Rollback** — the LLM-authored canvas path is retained behind a config switch for the whole phase. E7's audit ships **off by default** and stays off unless it clears its own kill switch: more than a 15% increase in L2 cost for less than 5 points of fidelity gain means it does not ship enabled.

### Phase 5 — Learned eviction

**Scope** — E2. The offline Belady-style oracle over replayed sessions, the combined re-access and tool-repetition label, the learned scorer, and GDSF-style cost- and size-aware eviction with aging.

**Dependencies** — everything before it. Phase 0's replay corpus (the oracle is computed offline over completed sessions), Phase 1's E1 (labels must reference the right bytes), and Phase 2's E8 (`expand()` is the only source of re-access events). It is last because it is the only mechanism here that *learns*, and a learned policy trained on instrumentation that is wrong anywhere upstream will confidently encode that error.

**Ambition tiers** — one `step-change` (E2). The highest-variance item in the plan, scheduled at the point where its inputs are most trustworthy.

**Entry** — Phases 0–4 exit criteria hold, and the replay corpus contains at least 200 sessions with recorded re-access events.

**Exit criteria — all must hold**
1. `wrong_replacement_rate` reduced against the Phase-1 heuristic baseline on the **private** split, not the tuning split.
2. Success rate not regressed at equal or lower token count. Token savings alone do not pass this phase (§6.5).
3. Every replacement decision is inspectable: score plus top contributing features, recorded in `PlanTrace`.
4. Cold-start behaviour verified — with no trained model present, the system falls back to the Phase-1 heuristic and its metrics match Phase 1's exactly.
5. **E2's falsifier checked.** If `repeat_after_replacement` correlates with replacement at `r < 0.2` across 200 or more sessions, the label carries no signal. E2 is then abandoned in this form and replaced by E2′: GDSF using the existing LLM-assigned score as the value term, with size and aging from the classical algorithm and no learning at all. The plan states this in advance so the fallback is a decision rather than a retreat.

**Rollback** — three levels, all exercised in CI: learned scorer off (falls back to E2′), E2′ off (falls back to the Phase-1 heuristic), whole cascade off (falls back to host-native compaction). A trained model that cannot be disabled at runtime does not ship.

### 7.1 Why this order

The sequence is measurement → correctness → boundary → retrieval → structure → learning. It is chosen so that each phase is evaluated against instrumentation the previous phase made trustworthy.

The temptation is to build E2 early, because it is the most interesting item in §3. Doing that would mean training an eviction policy on re-access labels generated by an `expand()` that does not exist yet, over refs that can silently return the wrong bytes (F1), against a baseline nobody has reproduced. It would produce a number, and the number would mean nothing.

---

## 8. Non-goals

Stated explicitly, because each of these is something a reader might reasonably expect from a memory system and will not find here.

- **Not an MCP server.** §4.7 gives the reasoning. A thin MCP façade over `expand()` alone would be defensible; it is out of scope here because building it creates pressure to move `plan()` across the same boundary, which is the specific mistake §4 exists to prevent.
- **Not a hosted service.** The Hermes HTTP gateway (`src/gateway/server.ts:5-11`) stays as-is, a sidecar for one host. No multi-tenant service, no auth model, no rate limiting. Multi-tenancy is a genuinely different problem and pretending otherwise produces a design that serves neither case.
- **Not a knowledge graph.** §3.1 explains the rejection. Bi-temporal supersession is imported (E5); the graph substrate is not. `IMemoryStore` (`src/core/store/types.ts:235`) has no edge primitive, and the measured quality problems are elsewhere.
- **No multi-agent shared memory.** Cross-agent memory sharing raises write-privilege and trust questions — whose memory can poison whose — that this plan does not address. Single-agent, single-user scoping throughout.
- **No new model training beyond E2's eviction scorer.** No fine-tuned summariser, no learned compressor, no embedding training. E2's scorer is small, gradient-boosted-tree-scale, and disableable at three levels.
- **No prompt-language expansion.** The hardcoded Chinese strings become configuration (F15), which is a correctness and portability fix. Shipping a translated prompt set for N languages, with the evaluation that would require, is out of scope.
- **No migration guarantee for on-disk artefacts.** JSONL layout and `.mmd` text format are explicitly internal (§4.6). Migrations will be provided; the formats are not promised. E3 cannot ship if they are.
- **No automatic self-improvement loop.** Docs 22 and 33 describe systems that propose and evaluate their own changes. This plan borrows their *evaluation discipline* — the public/private split, the high rejection rate as the expected outcome (§6.5) — and none of their autonomy. Every mechanism here is proposed by a human and reviewed by a human.
- **Not a benchmark-score optimisation exercise.** §6.5's guards exist to make it hard to win on tokens while losing on quality. If a phase's only result is a better token number, the phase failed.

---

## 9. Summary of commitments

| Item | Tier | Phase | Falsifier / kill switch |
| --- | --- | --- | --- |
| F1–F18 error fixes (§5) | `fix` | 0–2 | Failing-test-first for each |
| E1 content-addressed refs | `fix` | 1 | — |
| E4 `seq` + append-only boundaries | `fix` | 1 | — |
| E9 explicit-unknown + retry queue | `increment` | 1 | Bounded unknown pool |
| E8 `expand()` + real tool budget | `increment` | 2 | — |
| SDK boundary (§4) | refactor | 2 | Byte-identical replay required |
| E5 class-partitioned recall | **`step-change`** | 3 | Instruction set must stabilise < ~20 items |
| E6 scene propose-validate-commit | **`step-change`** | 3 | `evidence_conservation` must be 1.0 |
| E3 typed task graph | **`step-change`** | 4 | Config switch to LLM-authored canvas |
| E7 regeneration + fidelity audit | `increment` | 4 | Off by default; >15% cost for <5pt gain ⇒ stays off |
| E2 learned eviction | **`step-change`** | 5 | `r < 0.2` on repeat-after-replacement ⇒ fall back to E2′ |

---

## 10. References

[1] Packer et al., *MemGPT: Towards LLMs as Operating Systems*, arXiv:2310.08560 — virtual context management, paging between main and external context.

[2] Rasmussen et al., *Zep: A Temporal Knowledge Graph Architecture for Agent Memory*, arXiv:2501.13956 — Graphiti's bi-temporal edge validity, from which E5 borrows supersession without the graph.

[3] Xu et al., *A-MEM: Agentic Memory for LLM Agents*, arXiv:2502.12110 — Zettelkasten-style interlinked memory notes; considered and rejected in §3.1.

[4] Pan et al., *LLMLingua-2: Data Distillation for Efficient and Faithful Task-Agnostic Prompt Compression*, arXiv:2403.12968 (ACL Findings 2024) — extractive compression as token classification; flagged in §3.1, not scheduled.

[5] Chhikara et al., *Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory*, arXiv:2504.19413 — production extract-consolidate architecture and LOCOMO evaluation.

[6] Gutiérrez et al., *HippoRAG: Neurobiologically Inspired Long-Term Memory for LLMs*, arXiv:2405.14831 (NeurIPS 2024) — personalized PageRank over a schemaless KG with synonymy edges; source of E6's entity-resolution approach.

[7] Zhang et al., *Agentic Context Engineering: Evolving Contexts for Self-Improving Language Models*, arXiv:2510.04618 — context collapse under monolithic rewrite, and itemized delta updates as the remedy. The direct source for E3.

[8] Liu et al., *An Imitation Learning Approach for Cache Replacement*, ICML 2020, arXiv:2006.16239 — Parrot: learning to imitate Belady's optimal offline policy. The template for E2.

[9] Cherkasova, *Improving WWW Proxies Performance with Greedy-Dual-Size-Frequency Caching Policy*, HP Labs HPL-98-69R1, 1998 — GDSF, the cost-and-size-aware eviction rule E2 adapts.

[10] Cao & Irani, *Cost-Aware WWW Proxy Caching Algorithms*, USITS 1997 — GreedyDual-Size and the aging term that prevents stale high-value entries from pinning the cache.

[11] Anthropic, *Effective context engineering for AI agents* (2025), plus the context-editing and tool-result-clearing documentation — the host-native compaction baseline used as the control arm in §6.4.

[12] Liu et al., *Lost in the Middle: How Language Models Use Long Contexts*, TACL 2024 — positional degradation in long contexts; the reason §6.5 requires length-matched comparisons. Chroma's *Context Rot* (2025) reports the same effect on more recent models.

**Internal documents referenced by number in the text:** doc 09 (memory skills and progressive disclosure — retrieval ordering, admission gates), doc 13 (long-running memory fidelity — the never-summarise-summaries rule, the 15% drift audit threshold), doc 22 (cross-project learning — extraction over curation, the three-example promotion gate), doc 33 (recursive self-improvement — the public/private evaluation split, and the finding that committees underperform their best member), and the graph engineering playbook (deterministic code nodes, reduce-with-traceability).
