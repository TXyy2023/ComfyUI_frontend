import type { ActivityPart, PartState, ToolPart } from './agentMessageParts'

interface ToolRow {
  kind: 'tool'
  name: string
  skill?: string
  state: PartState
  ok?: boolean
  count: number
  canvasConfirmed?: boolean
}

interface ThinkingRow {
  kind: 'thinking'
  text: string
  state: PartState
}

export type ActivityRow = ToolRow | ThinkingRow

function matchingToolStep(
  previous: ActivityRow | undefined,
  part: ToolPart
): ToolRow | undefined {
  if (
    previous?.kind !== 'tool' ||
    previous.name !== part.name ||
    (part.name === 'load_skill' && previous.skill !== part.skill)
  )
    return undefined
  return previous
}

/**
 * Consecutive calls to the same tool read as one step carrying a count: the
 * transport keeps every call so a single one stays addressable, the trace only
 * needs the shape of the work.
 */
export function foldActivity(parts: readonly ActivityPart[]): ActivityRow[] {
  const rows: ActivityRow[] = []
  for (const part of parts) {
    if (part.type !== 'thinking') {
      const previous = matchingToolStep(rows.at(-1), part)
      if (previous) {
        previous.count += 1
        if (part.state === 'streaming') previous.state = 'streaming'
        if (part.ok !== undefined) previous.ok = part.ok
        if (part.canvasConfirmed === false) previous.canvasConfirmed = false
        else if (
          part.canvasConfirmed === true &&
          previous.canvasConfirmed === undefined
        )
          previous.canvasConfirmed = true
        continue
      }
    }
    rows.push(
      part.type === 'thinking'
        ? { kind: 'thinking', text: part.text, state: part.state }
        : {
            kind: 'tool',
            name: part.name,
            skill: part.skill,
            state: part.state,
            ok: part.ok,
            canvasConfirmed: part.canvasConfirmed,
            count: 1
          }
    )
  }
  return rows
}
