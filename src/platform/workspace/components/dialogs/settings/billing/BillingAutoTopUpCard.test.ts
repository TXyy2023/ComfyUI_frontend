import type { AutoTopUpSetup } from '@comfyorg/ingest-types'
import { render, screen } from '@testing-library/vue'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { computed } from 'vue'
import { createI18n } from 'vue-i18n'

import enMessages from '@/locales/en/main.json'
import type { AutoReloadSettings } from '@/platform/workspace/api/workspaceApi'
import {
  WorkspaceApiError,
  workspaceApi
} from '@/platform/workspace/api/workspaceApi'
import { useBillingCapabilities } from '@/platform/workspace/composables/useBillingCapabilities'

import BillingAutoTopUpCard from './BillingAutoTopUpCard.vue'

vi.mock(import('@/platform/workspace/api/workspaceApi'))
vi.mock(import('@/platform/workspace/composables/useBillingCapabilities'))
vi.mock(import('@/platform/telemetry/reportError'))
vi.mock<unknown>(import('@/platform/workspace/utils/platformLink'), () => ({
  platformLink: (path: string) => `https://platform.test${path}`
}))

const off: AutoReloadSettings = {
  configured: false,
  cycle_resets_at: null,
  disabled_reason: null,
  enabled: false,
  last_failure_at: null,
  last_failure_reason: null,
  max_monthly_budget_cents: 100000,
  min_reload_credits: 1000,
  monthly_budget_cents: null,
  paused_by_budget: false,
  paused_by_decline: false,
  reload_amount_cents: null,
  reload_credits: null,
  spent_this_cycle_cents: 0,
  threshold_credits: null
}

const on: AutoReloadSettings = {
  ...off,
  configured: true,
  enabled: true,
  cycle_resets_at: '2026-11-28T00:00:00Z',
  reload_amount_cents: 2500,
  reload_credits: 5275,
  threshold_credits: 1000
}

const RULE = 'Adds $25 (5,275 credits) when below 1,000 credits.'

function renderCard(
  settings: AutoReloadSettings,
  setup: AutoTopUpSetup | null = null
) {
  vi.mocked(workspaceApi.getBillingAutoReload).mockResolvedValue(settings)
  vi.mocked(useBillingCapabilities)().autoTopUpSetup = computed(() => setup)
  return render(BillingAutoTopUpCard, {
    global: {
      plugins: [
        createI18n({
          legacy: false,
          locale: 'en',
          messages: { en: enMessages }
        })
      ]
    }
  })
}

describe('BillingAutoTopUpCard', () => {
  it.for<{
    case: string
    settings: AutoReloadSettings
    setup?: AutoTopUpSetup
    status: string
    lines: string[]
    action: string
  }>([
    {
      case: 'not set up',
      settings: off,
      status: 'Off',
      lines: ['Refills credits when your balance runs low'],
      action: 'Turn on'
    },
    {
      case: 'off with no saved card',
      settings: off,
      setup: { state: 'frozen', reason: 'default_payment_method_missing' },
      status: 'Off',
      lines: ['Auto top-up needs a saved card. Add one to turn it on.'],
      action: 'Add card'
    },
    {
      case: 'on with no monthly limit',
      settings: on,
      status: 'On',
      lines: [RULE],
      action: 'Manage'
    },
    {
      case: 'on with a monthly limit',
      settings: {
        ...on,
        monthly_budget_cents: 20000,
        spent_this_cycle_cents: 5000
      },
      status: 'On',
      lines: [RULE, 'Monthly limit: $50 of $200 used'],
      action: 'Manage'
    },
    {
      case: 'paused by the monthly limit',
      settings: { ...on, monthly_budget_cents: 20000, paused_by_budget: true },
      status: 'Paused',
      lines: [RULE, 'Monthly limit reached. Resumes November 28.'],
      action: 'Manage'
    },
    {
      case: 'paused by a declined charge',
      settings: { ...on, paused_by_decline: true },
      status: 'Failed',
      lines: [
        "Your charge didn't go through. Update your payment method or add credits manually."
      ],
      action: 'Update payment'
    },
    {
      case: 'turned off by the system after declines',
      settings: {
        ...off,
        configured: true,
        disabled_reason: 'consecutive_declines'
      },
      status: 'Failed',
      lines: [
        "Your charge didn't go through. Update your payment method or add credits manually."
      ],
      action: 'Update payment'
    },
    {
      case: 'on but the card was removed',
      settings: on,
      setup: { state: 'frozen', reason: 'default_payment_method_missing' },
      status: 'On hold',
      lines: [
        RULE,
        'Your card expired or was removed. Update it to resume auto top-up.'
      ],
      action: 'Update payment'
    },
    {
      case: 'on with only a past decline in history',
      settings: { ...on, last_failure_reason: 'card_declined' },
      status: 'On',
      lines: [RULE],
      action: 'Manage'
    }
  ])('renders $case', async ({ settings, setup, status, lines, action }) => {
    renderCard(settings, setup ?? null)

    expect(
      await screen.findByTestId('billing-auto-top-up-status')
    ).toHaveTextContent(status)
    for (const line of lines) {
      expect(screen.getByText(line)).toBeInTheDocument()
    }
    expect(screen.getByRole('link', { name: action })).toHaveAttribute(
      'href',
      'https://platform.test/profile/billing'
    )
  })

  it('renders nothing when the server marks setup unavailable', async () => {
    renderCard(on, {
      state: 'unavailable',
      reason: 'billing_rail_not_supported'
    })

    await vi.waitFor(() =>
      expect(workspaceApi.getBillingAutoReload).toHaveBeenCalled()
    )
    expect(
      screen.queryByTestId('billing-auto-top-up-card')
    ).not.toBeInTheDocument()
  })

  it('offers a retry when the settings read fails', async () => {
    vi.mocked(workspaceApi.getBillingAutoReload).mockRejectedValueOnce(
      new WorkspaceApiError('boom', 500)
    )
    renderCard(on)

    expect(
      await screen.findByText("Couldn't load auto top-up.")
    ).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(
      await screen.findByTestId('billing-auto-top-up-status')
    ).toHaveTextContent('On')
  })
})
