import { useAsyncState } from '@vueuse/core'
import { computed } from 'vue'

import { reportError } from '@/platform/telemetry/reportError'
import { workspaceApi } from '@/platform/workspace/api/workspaceApi'
import { deriveAutoTopUpCard } from '@/platform/workspace/components/dialogs/settings/billing/autoTopUpCard'
import type { AutoTopUpCardState } from '@/platform/workspace/components/dialogs/settings/billing/autoTopUpCard'
import { useBillingCapabilities } from '@/platform/workspace/composables/useBillingCapabilities'

export function useBillingAutoTopUpCard() {
  const { autoTopUpSetup } = useBillingCapabilities()
  const read = useAsyncState(() => workspaceApi.getBillingAutoReload(), null, {
    onError: (error) =>
      reportError(error, {
        errorType: 'auto_top_up_read_failed',
        surface: 'billing'
      })
  })

  const state = computed<AutoTopUpCardState>(() => {
    if (read.isLoading.value) return { kind: 'loading' }
    const settings = read.state.value
    if (settings === null) return { kind: 'unavailable' }
    return deriveAutoTopUpCard(settings, autoTopUpSetup.value)
  })

  async function retry() {
    await read.execute()
  }

  return { state, retry }
}
