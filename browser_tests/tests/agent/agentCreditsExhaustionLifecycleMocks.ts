import type { Page, WebSocketRoute } from '@playwright/test'
import { expect, mergeTests } from '@playwright/test'

import type { AgentMessage } from '@comfyorg/ingest-types'

import type {
  AgentTurnAccepted,
  AgentWsEvent
} from '@/workbench/extensions/agent/schemas/agentApiSchema'
import type { AgentPanel } from '@e2e/fixtures/components/AgentPanel'
import { webSocketFixture } from '@e2e/fixtures/ws'
import { hostTelemetryFixture } from '@e2e/fixtures/hostTelemetryFixture'
import { jsonRoute } from '@e2e/fixtures/utils/jsonRoute'
import type { AgentFundingState } from '@e2e/tests/agent/agentPanelMocks'
import { agentTest } from '@e2e/tests/agent/agentPanelMocks'

class AgentCreditsLifecycleFixture {
  private readonly history: AgentMessage[] = []

  constructor(
    private readonly page: Page,
    private readonly agentPanel: AgentPanel,
    private readonly acceptedTurns: AgentTurnAccepted[],
    private readonly getAgentSocket: () => Promise<WebSocketRoute>,
    private readonly setFundingState: (state: AgentFundingState) => void
  ) {}

  async serveHistory(): Promise<void> {
    await this.page.route('**/api/agent/threads/*/messages', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill(jsonRoute(this.history))
        : route.fallback()
    )
  }

  async completeTurn(
    prompt: string,
    { fundingState }: { fundingState: AgentFundingState }
  ): Promise<void> {
    const acceptedTurnCount = this.acceptedTurns.length
    await this.agentPanel.sendMessage(prompt)
    await expect
      .poll(() => this.acceptedTurns.length)
      .toBe(acceptedTurnCount + 1)
    const accepted = this.acceptedTurns.at(acceptedTurnCount)
    if (accepted === undefined) {
      throw new Error('Accepted turn fixture did not record the submitted turn')
    }

    await expect(this.agentPanel.stopButton).toBeVisible()
    this.history.push(
      {
        id: `user-${accepted.message_id}`,
        thread_id: accepted.thread_id,
        turn_id: accepted.message_id,
        seq: this.history.length + 1,
        role: 'user',
        status: 'complete',
        content: { text: prompt }
      },
      {
        id: accepted.message_id,
        thread_id: accepted.thread_id,
        turn_id: accepted.message_id,
        seq: this.history.length + 2,
        role: 'assistant',
        status: 'complete',
        content: { text: 'Done.' }
      }
    )
    this.setFundingState(fundingState)
    const billingRefresh = this.page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === '/api/billing/status'
    )
    const doneEvent: AgentWsEvent = {
      type: 'agent_message_done',
      data: {
        message_id: accepted.message_id,
        thread_id: accepted.thread_id,
        usage: {
          input_tokens: 4493,
          output_tokens: 425,
          total_tokens: 12393,
          cache_read_input_tokens: 35596,
          cache_creation_input_tokens: 0
        }
      }
    }
    const ws = await this.getAgentSocket()
    ws.send(JSON.stringify(doneEvent))
    await billingRefresh
  }
}

const base = mergeTests(agentTest, hostTelemetryFixture, webSocketFixture)

export const test = base.extend<{
  creditsLifecycle: AgentCreditsLifecycleFixture
}>({
  creditsLifecycle: async (
    { acceptedTurns, agentBilling, agentPanel, getAgentSocket, page },
    use
  ) => {
    const fixture = new AgentCreditsLifecycleFixture(
      page,
      agentPanel,
      acceptedTurns,
      getAgentSocket,
      (state) => agentBilling.setFundingState(state)
    )
    await fixture.serveHistory()
    await use(fixture)
  }
})
