import { LLMEvent, type ProviderMetadata } from "@opencode-ai/llm"
import { Effect } from "effect"

const TOOL_CALL_OPEN = "<tool_call"
const TOOL_CALL_CLOSE = "</tool_call>"

type DeltaEvent = Extract<LLMEvent, { type: "text-delta" | "reasoning-delta" }>
type EndEvent = Extract<LLMEvent, { type: "text-end" | "reasoning-end" }>

type Pending = {
  readonly kind: "text" | "reasoning"
  readonly id: string
  readonly text: string
}

type State = {
  next: number
  pending: Record<string, Pending>
}

export function adapterState(): State {
  return {
    next: 0,
    pending: {},
  }
}

export function toLLMEvents(state: State, event: LLMEvent): Effect.Effect<ReadonlyArray<LLMEvent>> {
  return Effect.sync((): ReadonlyArray<LLMEvent> => {
    if (event.type === "text-delta" || event.type === "reasoning-delta") return consumeDelta(state, event)
    if (event.type === "text-end" || event.type === "reasoning-end") return flushPending(state, event)
    if (event.type === "finish" || event.type === "step-finish") return [...flushAllPending(state), event]
    return [event]
  })
}

function consumeDelta(state: State, event: DeltaEvent): LLMEvent[] {
  const key = pendingKey(event)
  const pending = state.pending[key]
  const parsed = parseStreamText(state, pending?.text ?? "", event.text, event.providerMetadata)
  const keep = parsed.pending
    ? {
        kind: event.type === "text-delta" ? ("text" as const) : ("reasoning" as const),
        id: event.id,
        text: parsed.pending,
      }
    : undefined

  if (keep) state.pending[key] = keep
  else delete state.pending[key]

  return parsed.events.map((item) => {
    if (item.type !== "delta") return item.event
    if (event.type === "text-delta") {
      return LLMEvent.textDelta({
        id: event.id,
        text: item.text,
        providerMetadata: event.providerMetadata,
      })
    }
    return LLMEvent.reasoningDelta({
      id: event.id,
      text: item.text,
      providerMetadata: event.providerMetadata,
    })
  })
}

function flushPending(state: State, event: EndEvent): LLMEvent[] {
  const key = pendingKey(event)
  const pending = state.pending[key]
  if (!pending) return [event]
  delete state.pending[key]
  return [...pendingDelta(pending, event.providerMetadata), event]
}

function flushAllPending(state: State): LLMEvent[] {
  const pending = Object.values(state.pending)
  state.pending = {}
  return pending.flatMap((item) => pendingDelta(item, undefined))
}

function pendingDelta(pending: Pending, providerMetadata: ProviderMetadata | undefined): LLMEvent[] {
  if (!pending.text) return []
  if (pending.kind === "text") return [LLMEvent.textDelta({ id: pending.id, text: pending.text, providerMetadata })]
  return [LLMEvent.reasoningDelta({ id: pending.id, text: pending.text, providerMetadata })]
}

function parseStreamText(
  state: State,
  previous: string,
  next: string,
  providerMetadata: ProviderMetadata | undefined,
) {
  const events: Array<{ type: "delta"; text: string } | { type: "event"; event: LLMEvent }> = []
  let input = previous + next

  while (input.length > 0) {
    const start = input.indexOf(TOOL_CALL_OPEN)
    if (start < 0) {
      const split = safeTextLength(input)
      if (split > 0) events.push({ type: "delta", text: input.slice(0, split) })
      return { events, pending: input.slice(split) }
    }

    if (start > 0) events.push({ type: "delta", text: input.slice(0, start) })

    const end = input.indexOf(TOOL_CALL_CLOSE, start)
    if (end < 0) return { events, pending: input.slice(start) }

    const closeEnd = end + TOOL_CALL_CLOSE.length
    const raw = input.slice(start, closeEnd)
    const parsed = parseToolCall(raw)
    if (!parsed) {
      events.push({ type: "delta", text: raw })
    } else {
      events.push({
        type: "event",
        event: LLMEvent.toolCall({
          id: `xml_tool_${state.next++}`,
          name: parsed.name,
          input: parsed.input,
          providerMetadata: {
            ...providerMetadata,
            opencode: {
              ...providerMetadata?.opencode,
              source: "xml-tool-call",
            },
          },
        }),
      })
    }
    input = input.slice(closeEnd)
  }

  return { events, pending: "" }
}

function safeTextLength(input: string) {
  const max = Math.min(input.length, TOOL_CALL_OPEN.length - 1)
  for (let size = max; size > 0; size--) {
    if (TOOL_CALL_OPEN.startsWith(input.slice(-size))) return input.length - size
  }
  return input.length
}

function parseToolCall(raw: string) {
  const fn = /<function=([A-Za-z0-9_.:-]+)>([\s\S]*?)<\/function>/i.exec(raw)
  if (!fn) return
  const input: Record<string, unknown> = {}
  for (const match of fn[2].matchAll(/<parameter=([A-Za-z0-9_.:-]+)>([\s\S]*?)<\/parameter>/gi)) {
    input[match[1]] = decodeParameter(match[2])
  }
  return {
    name: fn[1],
    input,
  }
}

function decodeXml(input: string) {
  return input
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&")
}

function decodeParameter(input: string) {
  const value = decodeXml(input.trim())
  if (!/^(?:-?\d+(?:\.\d+)?|true|false|null|["[{])/.test(value)) return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function pendingKey(event: DeltaEvent | EndEvent) {
  return `${event.type.startsWith("text") ? "text" : "reasoning"}:${event.id}`
}

export * as LLMXmlToolCall from "./xml-tool-call"
