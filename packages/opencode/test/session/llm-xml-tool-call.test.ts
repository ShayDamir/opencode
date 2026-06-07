import { expect, test } from "bun:test"
import { LLMEvent } from "@opencode-ai/llm"
import { Effect } from "effect"
import { LLMXmlToolCall } from "@/session/llm/xml-tool-call"

function convert(state: ReturnType<typeof LLMXmlToolCall.adapterState>, event: LLMEvent) {
  return Effect.runSync(LLMXmlToolCall.toLLMEvents(state, event))
}

test("extracts an XML tool call from reasoning text", () => {
  const state = LLMXmlToolCall.adapterState()
  const events = convert(
    state,
    LLMEvent.reasoningDelta({
      id: "reasoning-0",
      text: [
        "<tool_call>",
        "<function=read>",
        "<parameter=filePath>",
        "/Users/aydansalois/Documents/million_dollars/src/pages/admin",
        "</parameter>",
        "</function>",
        "</tool_call>",
      ].join("\n"),
    }),
  )

  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({
    type: "tool-call",
    id: "xml_tool_0",
    name: "read",
    input: {
      filePath: "/Users/aydansalois/Documents/million_dollars/src/pages/admin",
    },
    providerMetadata: {
      opencode: {
        source: "xml-tool-call",
      },
    },
  })
})

test("extracts XML tool calls split across chunks", () => {
  const state = LLMXmlToolCall.adapterState()
  const first = convert(
    state,
    LLMEvent.reasoningDelta({
      id: "reasoning-0",
      text: "<tool",
    }),
  )
  const second = convert(
    state,
    LLMEvent.reasoningDelta({
      id: "reasoning-0",
      text: "_call><function=read><parameter=filePath>/tmp/a</parameter></function></tool_call>",
    }),
  )

  expect(first).toEqual([])
  expect(second).toHaveLength(1)
  expect(second[0]).toMatchObject({
    type: "tool-call",
    name: "read",
    input: {
      filePath: "/tmp/a",
    },
  })
})

test("preserves ordinary reasoning around extracted XML tool calls", () => {
  const state = LLMXmlToolCall.adapterState()
  const events = convert(
    state,
    LLMEvent.reasoningDelta({
      id: "reasoning-0",
      text: "before <tool_call><function=read><parameter=filePath>/tmp/a</parameter></function></tool_call> after",
    }),
  )

  expect(events).toHaveLength(3)
  expect(events[0]).toMatchObject({ type: "reasoning-delta", text: "before " })
  expect(events[1]).toMatchObject({ type: "tool-call", name: "read" })
  expect(events[2]).toMatchObject({ type: "reasoning-delta", text: " after" })
})

test("decodes JSON-shaped XML parameter values", () => {
  const state = LLMXmlToolCall.adapterState()
  const events = convert(
    state,
    LLMEvent.reasoningDelta({
      id: "reasoning-0",
      text: [
        "<tool_call>",
        "<function=read>",
        "<parameter=filePath>/tmp/a</parameter>",
        "<parameter=limit>500</parameter>",
        "<parameter=optional>null</parameter>",
        "</function>",
        "</tool_call>",
      ].join(""),
    }),
  )

  expect(events[0]).toMatchObject({
    type: "tool-call",
    input: {
      filePath: "/tmp/a",
      limit: 500,
      optional: null,
    },
  })
})

test("flushes incomplete XML as original reasoning text", () => {
  const state = LLMXmlToolCall.adapterState()
  const first = convert(
    state,
    LLMEvent.reasoningDelta({
      id: "reasoning-0",
      text: "<tool_call><function=read>",
    }),
  )
  const second = convert(
    state,
    LLMEvent.reasoningEnd({
      id: "reasoning-0",
    }),
  )

  expect(first).toEqual([])
  expect(second).toHaveLength(2)
  expect(second[0]).toMatchObject({
    type: "reasoning-delta",
    text: "<tool_call><function=read>",
  })
  expect(second[1]).toMatchObject({ type: "reasoning-end" })
})
