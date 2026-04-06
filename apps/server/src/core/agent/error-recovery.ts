export interface RecoveryAction {
  action: 'retry' | 'escalate'
  newState?: AgentState
  error?: Error
}

export interface AgentState {
  taskId: string
  currentState: string
  plan: string
  desiredState: string
  history: { role: string; content: string }[]
  iteration: number
}

export class ErrorRecovery {
  private maxRetries = 3

  setMaxRetries(max: number): void {
    this.maxRetries = max
  }

  async handle(
    error: Error,
    state: AgentState,
    attempt: number
  ): Promise<RecoveryAction> {
    // L1: Retryable errors — modify and retry at sub-agent level
    if (attempt < this.maxRetries && this.isRetryable(error)) {
      return {
        action: 'retry',
        newState: {
          ...state,
          history: [
            ...state.history,
            {
              role: 'system',
              content: `Previous attempt failed with error: ${error.message}. Please try a different approach.`
            }
          ]
        }
      }
    }

    // L2: Escalate to main agent for re-evaluation
    return { action: 'escalate', error }
  }

  private isRetryable(error: Error): boolean {
    const message = error.message.toLowerCase()
    // Network errors, timeouts, rate limits are retryable
    if (message.includes('timeout')) return true
    if (message.includes('econnrefused')) return true
    if (message.includes('rate limit')) return true
    if (message.includes('429')) return true
    if (message.includes('503')) return true
    // Tool execution failures are retryable (try different approach)
    if (message.includes('tool')) return true
    return true // Default: retry with a different approach
  }
}

let errorRecoveryInstance: ErrorRecovery | null = null

export function getErrorRecovery(): ErrorRecovery {
  if (!errorRecoveryInstance) {
    errorRecoveryInstance = new ErrorRecovery()
  }
  return errorRecoveryInstance
}
