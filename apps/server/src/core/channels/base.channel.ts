/** Base interface and types for messaging channel providers. */

export type ChannelType = 'telegram' | 'discord' | 'slack'

export interface ChannelConfig {
    id: string
    name: string
    type: ChannelType
    agentId: string
    config: Record<string, unknown>
    enabled: boolean
    createdAt: number
    updatedAt: number
}

export interface ChannelStatus {
    connected: boolean
    error?: string
    username?: string
}

export interface ActiveChannelExecution {
    id: string
    channelId: string
    agentId: string
    conversationId: string
    startedAt: number
}

/**
 * All channel providers must implement this interface.
 * Channel lifecycle:  start() → running → stop()
 */
export interface ChannelProvider {
    /** Start receiving messages (polling, webhook, WS, etc.) */
    start(): Promise<void>

    /** Stop the channel gracefully. */
    stop(): Promise<void>

    /** Return current connection status. */
    status(): ChannelStatus

    /** Validate config and test connectivity. Returns the bot username or display name. */
    test(): Promise<{ success: boolean; username?: string; error?: string }>

    /** Return all currently running executions for this channel. */
    getActiveExecutions(): ActiveChannelExecution[]

    /** Cancel a running execution. Returns true if found and cancelled. */
    cancelExecution(executionId: string): boolean

    /** Re-register platform commands (e.g. Telegram bot menu) after agent changes. */
    refreshCommands?(): Promise<void>
}
