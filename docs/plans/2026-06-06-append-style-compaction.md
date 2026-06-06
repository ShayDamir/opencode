# Append-Style Compaction Plan

## Fork Setup

- Public fork: `https://github.com/PlunderStruck/opencode`
- Upstream remote: `origin -> https://github.com/anomalyco/opencode.git`
- Fork remote: `fork -> https://github.com/PlunderStruck/opencode.git`
- Working branch: `codex/append-style-compaction`

## Core Concepts

Compaction is a session-history reduction operation: it takes the earlier turns in a long agent conversation and replaces their model-facing representation with a shorter checkpoint so later model requests can continue without exceeding the model context limit.

A KV cache is a model-runtime reuse mechanism: it stores computation for an identical starting sequence of tokens so a later request with the same beginning can skip recomputing that prefix.

An append-style compaction turn is a compaction summary request that keeps the ordinary session request prefix intact and adds one final instruction asking the same active model to summarize the older context.

A checkpoint is a durable session message pair: a compaction user marker plus a summary assistant message that tells later request assembly where old history stops and retained recent history resumes.

## Standards Loaded

No `agent-os/standards/index.yml` exists in this repo. This plan follows the repo-local `AGENTS.md` rules: keep the change scoped, avoid premature helpers, prefer existing Effect/service patterns, run package-local tests and typecheck from `packages/opencode`, and preserve existing compaction data semantics.

## Gate A: Current Behavior

- `/compact` in the TUI calls `sdk.client.session.summarize` with the selected model. The command is defined in `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:570-592`.
  Source: `scip-query code packages/opencode/src/cli/cmd/tui/routes/session/index.tsx:570-592`

- The HTTP summarize handler creates a compaction user message for the current agent and selected model, then calls `promptSvc.loop`. It does not itself construct the model request. The handler is in `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:271-290`.
  Source: `scip-query code packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:271-290`

- The prompt loop reads compacted history through `MessageV2.filterCompactedEffect`, extracts pending tasks, and when it sees a compaction task calls `compaction.process`. Automatic compaction is triggered after an assistant turn when `compaction.isOverflow` returns true. This is in `packages/opencode/src/session/prompt.ts:1217-1305`.
  Source: `scip-query code packages/opencode/src/session/prompt.ts:1217-1305`

- Normal assistant turns build the active agent request from transformed messages, environment/system context, instructions, skills, tools, permissions, and the active model. This is the request shape whose prefix is likely to be cache-friendly in a long local-model run. The call site is `packages/opencode/src/session/prompt.ts:1408-1461`.
  Source: `scip-query code packages/opencode/src/session/prompt.ts:1408-1461`

- Current compaction switches to the hidden `compaction` agent, optionally switches to the compaction agent model, strips media/tool outputs, then calls the processor with `tools: {}`, `system: []`, and `messages: [...modelMessages, appendedPrompt]`. Because lower request prep includes `input.agent.prompt`, this summary turn uses the compaction agent prompt instead of the normal active agent prompt. The key path is `packages/opencode/src/session/compaction.ts:338-424`.
  Source: `scip-query code packages/opencode/src/session/compaction.ts:299-424`

- Lower LLM request prep prepends `input.agent.prompt`, `input.system`, and `input.user.system` as the first system message for non-OpenAI-OAuth/non-workflow models. This explains why changing the agent changes the effective request prefix. The logic is in `packages/opencode/src/session/llm/request.ts:56-132`.
  Source: `scip-query code packages/opencode/src/session/llm/request.ts:56-132`

- After a completed compaction, `MessageV2.filterCompacted` makes future model-visible history start at the compaction marker and summary, then re-adds retained recent tail when `tail_start_id` exists. This checkpoint behavior should remain intact. The filter is in `packages/opencode/src/session/message-v2.ts:533-587`.
  Source: `scip-query code packages/opencode/src/session/message-v2.ts:533-587`

## Gate B: Existing Reuse Targets

- Keep `completedCompactions`, `summaryText`, `select`, `turns`, and `splitTurn`. These already find previous summaries and select older head versus retained recent tail. Do not replace this machinery with a parallel selector. The relevant code is `packages/opencode/src/session/compaction.ts:64-140` and `packages/opencode/src/session/compaction.ts:180-249`.
  Source: `scip-query code packages/opencode/src/session/compaction.ts:64-140`; `scip-query code packages/opencode/src/session/compaction.ts:180-249`

- Keep `experimental.session.compacting` and `experimental.compaction.autocontinue`. Plugins already use the first hook to adjust compaction prompt/context and the second to disable synthetic continuation. The hook call sites are in `packages/opencode/src/session/compaction.ts:352-358` and `packages/opencode/src/session/compaction.ts:444-493`.
  Source: `scip-query code packages/opencode/src/session/compaction.ts:299-424`; `scip-query code packages/opencode/src/session/compaction.ts:424-493`

- Keep the existing overflow threshold config. `compaction.auto`, `tail_turns`, `preserve_recent_tokens`, and `reserved` already exist in V1 config, and `usable` already subtracts reserved headroom from input-limited models. The schema is in `packages/core/src/v1/config/config.ts:143-162`; the threshold is in `packages/opencode/src/session/overflow.ts:10-34`.
  Source: `scip-query code packages/core/src/v1/config/config.ts:143-162`; `scip-query code packages/opencode/src/session/overflow.ts:10-34`

- Keep test helpers in `packages/opencode/test/session/compaction.test.ts:313-383`; they already capture `LLM.StreamInput`, inject fake LLM output, and mock plugin hooks.
  Source: `scip-query code packages/opencode/test/session/compaction.test.ts:313-383`

## Gate C: Blast Radius

- `packages/opencode/src/session/compaction.ts` directly depends on `session/llm`, `session/message-v2`, `session/overflow`, `session/processor`, `session/session`, V1 config/session types, and plugin/event services.
  Source: `scip-query deps packages/opencode/src/session/compaction.ts`

- Reverse dependencies are limited to `packages/opencode/src/session/prompt.ts`, compaction tests, prompt tests, and snapshot-tool-race tests. This supports a focused patch and package-local verification.
  Source: `scip-query rdeps packages/opencode/src/session/compaction.ts`

## Implementation Checklist

- [x] In `packages/opencode/src/session/compaction.ts:299-424`, add an append-style request path inside `processCompaction` after `selected`, `nextPrompt`, and `recent` are computed. Keep the existing assistant summary message creation and event publishing unchanged so `filterCompacted` keeps working.
      Source: `scip-query code packages/opencode/src/session/compaction.ts:299-424`

- [x] In `packages/opencode/src/session/compaction.ts:338-424`, stop selecting the hidden `compaction` agent for request execution. Instead, select `userMessage.agent` with `agents.get(userMessage.agent)` and use `userMessage.model` to get the active model. Keep the compaction agent prompt as text inside `nextPrompt`, not as the request system prompt. This preserves the normal request prefix while still giving the model compaction-specific summary rules.
      Source: `scip-query code packages/opencode/src/session/compaction.ts:338-424`; `scip-query code packages/opencode/src/session/llm/request.ts:56-132`

- [x] Add a small local prompt builder near the existing compaction prompt construction that wraps the current compaction instructions and the existing `buildPrompt({ previousSummary, context })` output into one appended user message. Do not introduce a new module. The prompt should state that the model must only summarize and must not call tools, continue implementation, or answer the user.
      Source: `scip-query code packages/opencode/src/session/compaction.ts:352-358`

- [x] Keep `tools: {}` in the compaction processor call even though the active agent is used. This makes the summary-only instruction enforceable at the tool layer while preserving the active agent/model prefix.
      Source: `scip-query code packages/opencode/src/session/compaction.ts:410-424`

- [x] Keep `MessageV2.toModelMessagesEffect(selected.head, model, { stripMedia: true, toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS })` for the summarized head so large media and old tool outputs still compact safely. Do not include retained tail in summary input; it remains serialized into `recent`.
      Source: `scip-query code packages/opencode/src/session/compaction.ts:359-376`; `scip-query code packages/opencode/test/session/compaction.test.ts:1377-1410`

- [x] Preserve `compactionPart.tail_start_id` updates and `SessionEvent.Compaction.Ended` payloads so existing future-turn checkpoint assembly remains unchanged.
      Source: `scip-query code packages/opencode/src/session/compaction.ts:437-550`; `scip-query code packages/opencode/src/session/message-v2.ts:533-587`

- [x] Keep automatic continuation behavior exactly as-is after summary success. Auto compaction should still add the synthetic continue message unless `experimental.compaction.autocontinue` disables it.
      Source: `scip-query code packages/opencode/src/session/compaction.ts:444-526`; `scip-query code packages/opencode/test/session/compaction.test.ts:1108-1138`

- [x] Add tests in `packages/opencode/test/session/compaction.test.ts` proving the captured `LLM.StreamInput` for compaction uses the active user agent/model rather than `agent: "compaction"`, has no tools, and contains the appended summary instruction after the selected head messages.
      Source: `scip-query code packages/opencode/test/session/compaction.test.ts:313-383`; `scip-query code packages/opencode/src/session/compaction.ts:410-424`

- [x] Update the existing test `"summarizes only the head while keeping recent tail out of summary input"` only if its string expectations need to account for the embedded compaction-agent instructions. It must still assert the retained tail is excluded from summary input.
      Source: `scip-query code packages/opencode/test/session/compaction.test.ts:1377-1410`

- [x] Verify the existing repeated-compaction regression still proves the appended prompt includes exactly one previous summary and preserves the existing structured sections.
      Source: `scip-query code packages/opencode/test/session/compaction.test.ts:1414-1451`

- [x] Run verification from the package directory: `cd packages/opencode && bun test test/session/compaction.test.ts test/session/message-v2.test.ts && bun typecheck`. Do not run tests from repo root.
      Source: repo `AGENTS.md` test/typecheck rules; package script confirmed by `packages/opencode/package.json` previously inspected in this session.

## Failure And Concurrency Notes

- If summarization overflows, keep the existing `result === "compact"` error handling that marks the summary assistant as failed. This avoids a half-applied checkpoint.
  Source: `scip-query code packages/opencode/src/session/compaction.ts:426-435`

- If the user manually runs `/compact` twice, `state.ensureRunning` in the prompt loop still serializes loop execution; this plan does not add a parallel path.
  Source: `scip-query code packages/opencode/src/session/prompt.ts:1475-1479`

- If auto compaction succeeds, the model can pick up autonomously because the existing synthetic continue message remains in place.
  Source: `scip-query code packages/opencode/src/session/compaction.ts:444-526`

## Verification

- `cd packages/opencode && bun test test/session/compaction.test.ts`
- `cd packages/opencode && bun test test/session/message-v2.test.ts`
- `cd packages/opencode && bun typecheck`
- `scip-query diff-impact` was attempted from the repo root, but the command ran out of Node heap before producing a report.

## Rollback

Revert the single commit touching `packages/opencode/src/session/compaction.ts` and `packages/opencode/test/session/compaction.test.ts`. No database schema or stored message format changes are planned, so existing sessions should remain readable after rollback.
