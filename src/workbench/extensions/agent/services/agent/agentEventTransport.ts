import type { AgentWsEvent } from '../../schemas/agentApiSchema'

import { areWorkflowIdsEquivalent } from '@/platform/workflow/core/utils/workflowId'

import { STALE_AFTER_MS } from '../../crdt/agentCrdtDocLifecycle'
import type {
  AskUserResolution,
  AssistantMessage,
  TextPart,
  ThinkingPart,
  ToolPart
} from './agentMessageParts'
import {
  askIdOf,
  retireAskParts,
  snapshotMessage,
  toAskOrNoticePart,
  toAskResolution
} from './agentMessageParts'
import { toolCanMutateCanvas } from './agentToolClassification'
import type {
  UndeliverableAskContext,
  UndeliverableAskReason
} from './undeliverableAskReporter'
import { createUndeliverableAskReporter } from './undeliverableAskReporter'

export type AgentChatEvent = Extract<
  AgentWsEvent,
  {
    type:
      | 'agent_thinking'
      | 'agent_tool_call'
      | 'agent_message_delta'
      | 'agent_message_draft'
      | 'agent_message_done'
      | 'agent_active_tab'
      | 'agent_ask'
      | 'agent_ask_resolved'
  }
>

type AgentToolCallEvent = Extract<AgentChatEvent, { type: 'agent_tool_call' }>
type AgentActiveTabEvent = Extract<AgentChatEvent, { type: 'agent_active_tab' }>
type AgentAskEvent = Extract<AgentChatEvent, { type: 'agent_ask' }>
type AgentThinkingEvent = Extract<AgentChatEvent, { type: 'agent_thinking' }>
type AgentAskResolvedEvent = Extract<
  AgentChatEvent,
  { type: 'agent_ask_resolved' }
>
type AgentMessageDeltaEvent = Extract<
  AgentChatEvent,
  { type: 'agent_message_delta' }
>
type AgentMessageDraftEvent = Extract<
  AgentChatEvent,
  { type: 'agent_message_draft' }
>

export type CanvasConfirmation = 'none' | 'awaiting' | 'unavailable'

export interface AgentEventTransport {
  ingest: (event: AgentChatEvent) => void
  settle: () => void
  notifyCanvasCaughtUp: (workflowId: string) => void
  hasPendingCanvasSync: () => boolean
  retireAskPart: (askId: string, resolution: AskUserResolution) => void
  /**
   * Tears the transport down for a reason other than natural completion
   * (abort, drop, reset, hydrate). Flushes any tool-call parts held pending
   * canvas catch-up to `done` and cancels their `STALE_AFTER_MS` timers, so
   * none can fire later against a `message` object the store has since
   * discarded or replaced with authoritative content under the same id.
   */
  dispose: () => void
}

function updateSkill(part: ToolPart, skill: string | null | undefined): void {
  if (skill) part.skill = skill
}

export function createAgentEventTransport(
  message: AssistantMessage,
  emit: (m: AssistantMessage) => void,
  canvasConfirmation: (workflowId?: string) => CanvasConfirmation = () =>
    'none',
  reportUndeliverableAsk: (
    data: AgentAskEvent['data'],
    reason: UndeliverableAskReason,
    context?: UndeliverableAskContext
  ) => void = createUndeliverableAskReporter().report
): AgentEventTransport {
  let openText: TextPart | null = null
  // The answer the model is still writing. Provisional: the round's first tool
  // call shows it was narration, and the final answer supersedes it.
  let draft: TextPart | null = null
  let openThinking: ThinkingPart | null = null
  let openThinkingStartedAt = 0
  // Seeded from any tool parts already on `message` (a hydrated pending row
  // restores its tool_calls before this transport exists) so the next live
  // `agent_tool_call` for an already-restored call updates that part in
  // place instead of pushing a duplicate.
  const tools = new Map<string, ToolPart>(
    message.parts
      .filter((part): part is ToolPart => part.type === 'tool')
      .map((part) => [part.callId, part])
  )
  let settled = false
  let lastTabTargetKey: string | undefined
  let lastWorkflowId: string | undefined
  let lastObservedWorkflowId: string | undefined
  const pendingCanvasSync = new Map<
    ToolPart,
    { timer: ReturnType<typeof setTimeout>; workflowId?: string }
  >()
  const toolWorkflowIds = new Map<ToolPart, string>()
  const observedRunningTools = new Set<ToolPart>()
  const unclaimedObservations = new Map<string, number>()

  function clearPendingCanvasSyncTimer(part: ToolPart): void {
    const pending = pendingCanvasSync.get(part)
    if (pending !== undefined) clearTimeout(pending.timer)
    pendingCanvasSync.delete(part)
  }

  function settlePendingCanvasSync(part: ToolPart, confirmed: boolean): void {
    clearPendingCanvasSyncTimer(part)
    part.state = 'done'
    part.canvasConfirmed = confirmed
  }

  function flushPendingCanvasSync(): void {
    if (pendingCanvasSync.size === 0) return
    for (const part of pendingCanvasSync.keys())
      settlePendingCanvasSync(part, false)
    emit(snapshotMessage(message))
  }

  function notifyCanvasCaughtUp(workflowId: string): void {
    lastObservedWorkflowId = workflowId
    let observed = false
    for (const [part, pending] of pendingCanvasSync) {
      if (
        pending.workflowId !== undefined &&
        !areWorkflowIdsEquivalent(pending.workflowId, workflowId)
      )
        continue
      toolWorkflowIds.set(part, workflowId)
      settlePendingCanvasSync(part, true)
      observed = true
    }
    for (const part of tools.values()) {
      const targetWorkflowId = toolWorkflowIds.get(part)
      if (
        part.state !== 'streaming' ||
        !toolCanMutateCanvas(part.name) ||
        (targetWorkflowId !== undefined &&
          !areWorkflowIdsEquivalent(targetWorkflowId, workflowId))
      )
        continue
      toolWorkflowIds.set(part, workflowId)
      observedRunningTools.add(part)
      observed = true
    }
    if (!observed) {
      const key = workflowId.toLowerCase()
      unclaimedObservations.set(key, (unclaimedObservations.get(key) ?? 0) + 1)
      return
    }
    emit(snapshotMessage(message))
  }

  function hasPendingCanvasSync(): boolean {
    return pendingCanvasSync.size > 0
  }

  function dispose(): void {
    flushPendingCanvasSync()
  }

  function resolveToolCallState(
    part: ToolPart,
    status: 'success' | 'error',
    durationMs: number | undefined
  ): void {
    if (part.state === 'done' && part.canvasConfirmed === true) return
    part.ok = status === 'success'
    part.durationMs = durationMs
    clearPendingCanvasSyncTimer(part)
    const workflowId = toolWorkflowIds.get(part)
    const confirmation =
      status === 'success' && toolCanMutateCanvas(part.name)
        ? canvasConfirmation(workflowId)
        : 'none'
    if (confirmation === 'none') {
      part.state = 'done'
      return
    }
    const observationKey = workflowId?.toLowerCase()
    const availableObservations =
      observationKey === undefined
        ? 0
        : (unclaimedObservations.get(observationKey) ?? 0)
    if (observedRunningTools.delete(part) || availableObservations > 0) {
      if (availableObservations > 0 && observationKey !== undefined)
        unclaimedObservations.set(observationKey, availableObservations - 1)
      part.state = 'done'
      part.canvasConfirmed = true
      return
    }
    if (confirmation === 'unavailable') {
      settlePendingCanvasSync(part, false)
      return
    }
    pendingCanvasSync.set(part, {
      workflowId,
      timer: setTimeout(() => {
        settlePendingCanvasSync(part, false)
        emit(snapshotMessage(message))
      }, STALE_AFTER_MS)
    })
  }

  function handleToolCallEvent(data: AgentToolCallEvent['data']): void {
    let part = tools.get(data.tool_call_id)
    if (!part) {
      part = {
        type: 'tool',
        callId: data.tool_call_id,
        name: data.tool_name,
        state: 'streaming'
      }
      tools.set(data.tool_call_id, part)
      message.parts.push(part)
      const workflowId = lastWorkflowId ?? lastObservedWorkflowId
      if (workflowId !== undefined) toolWorkflowIds.set(part, workflowId)
    }
    part.name = data.tool_name
    updateSkill(part, data.skill)
    if (data.status !== 'running') {
      resolveToolCallState(part, data.status, data.duration_ms)
    }
  }

  /**
   * Applies one `agent_active_tab` frame. The agent re-announces the same
   * tab as it keeps working on it, with text and tool calls in between, so
   * only a change of tab is worth another link in the transcript. Returns
   * `false` when this frame repeats the last-announced tab and was
   * otherwise a no-op, mirroring `ingest`'s early `return` for that case.
   */
  function handleActiveTabEvent(data: AgentActiveTabEvent['data']): boolean {
    const targetKey = `${data.workflow_id}\u0000${data.node_locator_id ?? ''}`
    if (lastTabTargetKey === targetKey) return false
    lastTabTargetKey = targetKey
    lastWorkflowId = data.workflow_id
    closeOpenText()
    closeOpenThinking()
    message.thinking = false
    message.thinkingText = undefined
    message.parts.push({
      type: 'tabLink',
      workflowId: data.workflow_id,
      locatorId: data.node_locator_id,
      name: data.name
    })
    return true
  }

  function reportUnrenderedAsk(data: AgentAskEvent['data']): void {
    reportUndeliverableAsk(
      data,
      data.kind === 'unknown' ? 'unknown-kind' : 'unrendered-kind'
    )
  }

  function handleAskEvent(data: AgentAskEvent['data']): boolean {
    const shown = message.parts.find((part) => askIdOf(part) === data.ask_id)
    if (shown) {
      if (shown.type === 'askUnavailable') reportUnrenderedAsk(data)
      return false
    }
    const part = toAskOrNoticePart(data)
    if (part.type === 'askUnavailable') reportUnrenderedAsk(data)
    dropDraft()
    closeOpenText()
    closeOpenThinking()
    message.thinking = false
    message.thinkingText = undefined
    message.parts.push(part)
    return true
  }

  /** Applies one `agent_thinking` frame: appends its delta to the open
   * thinking part, opening one first if none is open. */
  function handleThinkingEvent(data: AgentThinkingEvent['data']): void {
    closeOpenText()
    message.thinking = true
    ;(openThinking ?? openNewThinking()).text += data.delta
    message.thinkingText = openThinking?.text
  }

  function handleAskResolvedEvent(
    data: AgentAskResolvedEvent['data']
  ): boolean {
    const parts = retireAskParts(
      message.parts,
      data.ask_id,
      toAskResolution(data)
    )
    if (parts === message.parts) return false
    message.parts = parts
    return true
  }

  /** Applies one `agent_message_delta` frame: appends its delta to the open
   * text part, opening one first if none is open. */
  function handleMessageDeltaEvent(data: AgentMessageDeltaEvent['data']): void {
    dropDraft()
    closeOpenThinking()
    message.thinking = false
    message.thinkingText = undefined
    ;(openText ?? openNewText()).text += data.delta
  }

  function closeOpenText(): void {
    if (openText) {
      openText.state = 'done'
      openText = null
    }
  }

  function openNewText(): TextPart {
    const part: TextPart = { type: 'text', text: '', state: 'streaming' }
    message.parts.push(part)
    openText = part
    return part
  }

  function dropDraft(): void {
    if (!draft) return
    const stale = draft
    message.parts = message.parts.filter((part) => part !== stale)
    draft = null
  }

  /** Applies one `agent_message_draft` frame: the whole reply so far replaces
   * the last draft, and an empty one withdraws it. */
  function handleMessageDraftEvent(data: AgentMessageDraftEvent['data']): void {
    if (data.text) showDraft(data.text)
    else dropDraft()
  }

  function showDraft(text: string): void {
    closeOpenThinking()
    message.thinking = false
    message.thinkingText = undefined
    if (!draft) {
      closeOpenText()
      draft = { type: 'text', text: '', state: 'streaming' }
      message.parts.push(draft)
    }
    draft.text = text
  }

  function closeOpenThinking(): void {
    if (openThinking) {
      openThinking.state = 'done'
      const durationMs = Date.now() - openThinkingStartedAt
      if (durationMs > 0) openThinking.durationMs = durationMs
      openThinking = null
    }
  }

  function openNewThinking(): ThinkingPart {
    const part: ThinkingPart = {
      type: 'thinking',
      text: '',
      state: 'streaming'
    }
    message.parts.push(part)
    openThinking = part
    openThinkingStartedAt = Date.now()
    return part
  }

  function applyChatEvent(event: AgentChatEvent): boolean {
    switch (event.type) {
      case 'agent_thinking':
        handleThinkingEvent(event.data)
        return true
      case 'agent_tool_call':
        dropDraft()
        closeOpenText()
        closeOpenThinking()
        message.thinking = false
        message.thinkingText = undefined
        handleToolCallEvent(event.data)
        return true
      case 'agent_active_tab':
        return handleActiveTabEvent(event.data)
      case 'agent_ask':
        return handleAskEvent(event.data)
      case 'agent_ask_resolved':
        return handleAskResolvedEvent(event.data)
      case 'agent_message_delta':
        handleMessageDeltaEvent(event.data)
        return true
      case 'agent_message_draft':
        handleMessageDraftEvent(event.data)
        return true
      case 'agent_message_done':
        settle()
        return false
    }
  }

  function ingest(event: AgentChatEvent): void {
    if (settled) {
      if (event.type === 'agent_ask')
        reportUndeliverableAsk(event.data, 'settled-turn')
      return
    }
    if (applyChatEvent(event)) emit(snapshotMessage(message))
  }

  function settle(): void {
    if (settled) return
    settled = true
    dropDraft()
    closeOpenText()
    closeOpenThinking()
    message.thinking = false
    message.thinkingText = undefined
    message.streaming = false
    emit(snapshotMessage(message))
  }

  function retireAskPart(askId: string, resolution: AskUserResolution): void {
    const parts = retireAskParts(message.parts, askId, resolution)
    if (parts === message.parts) return
    message.parts = parts
    emit(snapshotMessage(message))
  }

  return {
    ingest,
    settle,
    notifyCanvasCaughtUp,
    hasPendingCanvasSync,
    dispose,
    retireAskPart
  }
}
