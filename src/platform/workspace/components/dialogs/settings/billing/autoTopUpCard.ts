import type { AutoTopUpSetup } from '@comfyorg/ingest-types'

import type { AutoReloadSettings } from '@/platform/workspace/api/workspaceApi'

export interface AutoTopUpRule {
  amountCents: number
  credits: number
  thresholdCredits: number
}

export interface AutoTopUpLimit {
  spentCents: number
  limitCents: number
  resetsAt: string | null
}

export type AutoTopUpCardState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'hidden' }
  | { kind: 'off' }
  | { kind: 'noCard' }
  | { kind: 'failed' }
  | { kind: 'onHold'; rule: AutoTopUpRule | null }
  | { kind: 'paused'; rule: AutoTopUpRule | null; resumesAt: string | null }
  | { kind: 'on'; rule: AutoTopUpRule | null; limit: AutoTopUpLimit | null }

function ruleOf(settings: AutoReloadSettings): AutoTopUpRule | null {
  const {
    reload_amount_cents: amountCents,
    reload_credits: credits,
    threshold_credits: thresholdCredits
  } = settings
  if (amountCents === null) return null
  if (credits === null) return null
  if (thresholdCredits === null) return null
  return { amountCents, credits, thresholdCredits }
}

function limitOf(settings: AutoReloadSettings): AutoTopUpLimit | null {
  if (settings.monthly_budget_cents === null) return null
  return {
    spentCents: settings.spent_this_cycle_cents,
    limitCents: settings.monthly_budget_cents,
    resetsAt: settings.cycle_resets_at
  }
}

/** Maps the served auto top-up settings and setup guidance onto the card. */
export function deriveAutoTopUpCard(
  settings: AutoReloadSettings,
  setup: AutoTopUpSetup | null
): AutoTopUpCardState {
  if (setup?.state === 'unavailable') return { kind: 'hidden' }
  if (settings.paused_by_decline) return { kind: 'failed' }
  if (settings.disabled_reason !== null) return { kind: 'failed' }

  const paymentMethodMissing =
    setup?.reason === 'default_payment_method_missing'
  if (!settings.enabled) {
    return paymentMethodMissing ? { kind: 'noCard' } : { kind: 'off' }
  }

  const rule = ruleOf(settings)
  if (paymentMethodMissing) return { kind: 'onHold', rule }
  if (settings.paused_by_budget) {
    return { kind: 'paused', rule, resumesAt: settings.cycle_resets_at }
  }
  return { kind: 'on', rule, limit: limitOf(settings) }
}
