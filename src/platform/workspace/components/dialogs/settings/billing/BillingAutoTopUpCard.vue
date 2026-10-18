<template>
  <section
    v-if="state.kind !== 'hidden'"
    class="flex flex-col"
    data-testid="billing-auto-top-up-card"
  >
    <Skeleton v-if="state.kind === 'loading'" class="h-16 w-full" />
    <p
      v-else-if="state.kind === 'unavailable'"
      class="m-0 flex items-center gap-1 rounded-lg border border-interface-stroke p-4 text-sm text-muted-foreground"
      role="alert"
    >
      {{ $t('workspacePanel.billingTab.autoTopUp.unavailable') }}
      <Button variant="link" size="sm" @click="retry">
        {{ $t('workspacePanel.billingTab.tryAgain') }}
      </Button>
    </p>
    <div
      v-else-if="view"
      :class="
        cn(
          'flex items-start justify-between gap-4 rounded-lg border p-4',
          STATUS[view.status].border
        )
      "
    >
      <div class="flex min-w-0 flex-col gap-1">
        <h3
          class="m-0 flex items-center gap-2 text-sm font-semibold text-base-foreground"
        >
          {{ $t('workspacePanel.billingTab.autoTopUp.title') }}
          <span
            :class="
              cn(
                'flex items-center gap-1 text-xs font-normal',
                STATUS[view.status].text
              )
            "
            data-testid="billing-auto-top-up-status"
          >
            <span
              :class="cn('size-1.5 rounded-full', STATUS[view.status].dot)"
              aria-hidden="true"
            />
            {{ $t(STATUS[view.status].label) }}
          </span>
        </h3>
        <p
          v-for="line in view.lines"
          :key="line.text"
          class="m-0 flex items-center gap-1 text-sm text-muted-foreground"
        >
          {{ line.text }}
          <Button
            v-if="line.tooltip"
            :tooltip="line.tooltip"
            :aria-label="line.tooltip"
            variant="muted-textonly"
            size="icon-sm"
          >
            <i class="icon-[lucide--info] size-4" aria-hidden="true" />
          </Button>
        </p>
      </div>
      <Button
        as="a"
        :href="billingUrl"
        target="_blank"
        rel="noopener"
        :variant="ACTIONS[view.action].variant"
        class="shrink-0"
      >
        {{ $t(ACTIONS[view.action].label) }}
        <i class="icon-[lucide--external-link] size-4" aria-hidden="true" />
      </Button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { cn } from '@comfyorg/tailwind-utils'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { formatCredits, formatUsdFromCents } from '@/base/credits/comfyCredits'
import Button from '@/components/ui/button/Button.vue'
import Skeleton from '@/components/ui/skeleton/Skeleton.vue'
import type {
  AutoTopUpLimit,
  AutoTopUpRule
} from '@/platform/workspace/components/dialogs/settings/billing/autoTopUpCard'
import { formatPlanDate } from '@/platform/workspace/components/dialogs/settings/billing/planRow'
import { useBillingAutoTopUpCard } from '@/platform/workspace/components/dialogs/settings/billing/useBillingAutoTopUpCard'
import { platformLink } from '@/platform/workspace/utils/platformLink'

type Status = 'off' | 'on' | 'paused' | 'onHold' | 'failed'
type Action = 'turnOn' | 'addCard' | 'manage' | 'updatePayment'

interface Line {
  text: string
  tooltip?: string
}

interface CardView {
  status: Status
  lines: Line[]
  action: Action
}

const NEUTRAL = {
  border: 'border-interface-stroke',
  text: 'text-muted-foreground'
} as const

const DANGER = {
  border: 'border-destructive-background',
  text: 'text-destructive-background'
} as const

const STATUS = {
  off: {
    ...NEUTRAL,
    label: 'workspacePanel.billingTab.autoTopUp.status.off',
    dot: 'bg-muted-foreground'
  },
  on: {
    ...NEUTRAL,
    label: 'workspacePanel.billingTab.autoTopUp.status.on',
    dot: 'bg-success-background'
  },
  paused: {
    ...NEUTRAL,
    label: 'workspacePanel.billingTab.autoTopUp.status.paused',
    dot: 'bg-warning-background'
  },
  onHold: {
    ...NEUTRAL,
    label: 'workspacePanel.billingTab.autoTopUp.status.onHold',
    dot: 'bg-warning-background'
  },
  failed: {
    ...DANGER,
    label: 'workspacePanel.billingTab.autoTopUp.status.failed',
    dot: 'bg-destructive-background'
  }
} as const satisfies Record<
  Status,
  { label: string; dot: string; border: string; text: string }
>

const ACTIONS = {
  turnOn: {
    label: 'workspacePanel.billingTab.autoTopUp.actions.turnOn',
    variant: 'secondary'
  },
  addCard: {
    label: 'workspacePanel.billingTab.autoTopUp.actions.addCard',
    variant: 'secondary'
  },
  manage: {
    label: 'workspacePanel.billingTab.autoTopUp.actions.manage',
    variant: 'secondary'
  },
  updatePayment: {
    label: 'workspacePanel.billingTab.autoTopUp.actions.updatePayment',
    variant: 'inverted'
  }
} as const satisfies Record<Action, { label: string; variant: string }>

const { t, locale } = useI18n()
const { state, retry } = useBillingAutoTopUpCard()
const billingUrl = computed(() => platformLink('/profile/billing'))

function usd(cents: number) {
  return formatUsdFromCents({
    cents,
    locale: locale.value,
    numberOptions: {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: cents % 100 === 0 ? 0 : 2
    }
  })
}

function credits(value: number) {
  return formatCredits({
    value,
    locale: locale.value,
    numberOptions: { maximumFractionDigits: 0 }
  })
}

function day(isoDate: string) {
  return formatPlanDate(isoDate, locale.value, 'monthly')
}

function limitTooltip(resetsAt: string | null) {
  return resetsAt === null
    ? t('workspacePanel.billingTab.autoTopUp.limitTooltipNoDate')
    : t('workspacePanel.billingTab.autoTopUp.limitTooltip', {
        date: day(resetsAt)
      })
}

function ruleLines(rule: AutoTopUpRule | null): Line[] {
  if (rule === null) return []
  return [
    {
      text: t('workspacePanel.billingTab.autoTopUp.rule', {
        amount: usd(rule.amountCents),
        credits: credits(rule.credits),
        threshold: credits(rule.thresholdCredits)
      })
    }
  ]
}

function limitLines(limit: AutoTopUpLimit | null): Line[] {
  if (limit === null) return []
  return [
    {
      text: t('workspacePanel.billingTab.autoTopUp.limit', {
        spent: usd(limit.spentCents),
        limit: usd(limit.limitCents)
      }),
      tooltip: limitTooltip(limit.resetsAt)
    }
  ]
}

function pausedLine(resumesAt: string | null): Line {
  return {
    text:
      resumesAt === null
        ? t('workspacePanel.billingTab.autoTopUp.pausedNoDate')
        : t('workspacePanel.billingTab.autoTopUp.paused', {
            date: day(resumesAt)
          }),
    tooltip: limitTooltip(resumesAt)
  }
}

const view = computed<CardView | null>(() => {
  const current = state.value
  switch (current.kind) {
    case 'off':
      return {
        status: 'off',
        lines: [{ text: t('workspacePanel.billingTab.autoTopUp.off') }],
        action: 'turnOn'
      }
    case 'noCard':
      return {
        status: 'off',
        lines: [{ text: t('workspacePanel.billingTab.autoTopUp.noCard') }],
        action: 'addCard'
      }
    case 'failed':
      return {
        status: 'failed',
        lines: [{ text: t('workspacePanel.billingTab.autoTopUp.failed') }],
        action: 'updatePayment'
      }
    case 'onHold':
      return {
        status: 'onHold',
        lines: [
          ...ruleLines(current.rule),
          { text: t('workspacePanel.billingTab.autoTopUp.onHold') }
        ],
        action: 'updatePayment'
      }
    case 'paused':
      return {
        status: 'paused',
        lines: [...ruleLines(current.rule), pausedLine(current.resumesAt)],
        action: 'manage'
      }
    case 'on':
      return {
        status: 'on',
        lines: [...ruleLines(current.rule), ...limitLines(current.limit)],
        action: 'manage'
      }
    default:
      return null
  }
})
</script>
