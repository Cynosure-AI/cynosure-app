import { watch } from 'vue'
import type { ChatEvent } from '@shared/types'
import { api } from '../api/client'
import { useChatStore } from '../stores/chat.store'
import { useVoiceOutputStore } from '../stores/voice-output.store'
import { useSpeechPlayer, type SpeechStream } from './useSpeechPlayer'

/** A voice message whose reply has not started within this time is not read aloud. */
const ARMED_REPLY_TTL_MS = 5 * 60_000

/** A message sent by voice; its reply is read aloud. A null conversation is a chat being created. */
let armed: { conversationId: string | null; at: number } | null = null

export function armVoiceReply(conversationId: string | null): void {
    armed = { conversationId, at: Date.now() }
}

function takeArmed(conversationId: string): boolean {
    const match = armed !== null
        && Date.now() - armed.at < ARMED_REPLY_TTL_MS
        && (armed.conversationId === null || armed.conversationId === conversationId)
    if (match) armed = null
    return match
}

/**
 * Read replies in the open chat aloud while they stream: replies to voice
 * messages, or every reply when auto-read is set to always. Returns a cleanup.
 */
export function useVoiceAutoRead(): () => void {
    const chatStore = useChatStore()
    const voice = useVoiceOutputStore()
    const player = useSpeechPlayer()
    let current: { executionId: string; stream: SpeechStream } | null = null

    function startReading(event: ChatEvent & { type: 'stream-start' }): void {
        if (current?.executionId === event.executionId) return
        if (event.conversationId !== chatStore.activeConversationId || !voice.canSpeak) return
        const mode = voice.settings?.autoRead ?? 'off'
        const askedByVoice = takeArmed(event.conversationId)
        if (mode === 'always' || (mode === 'voice' && askedByVoice)) {
            current = { executionId: event.executionId, stream: player.startStream(`stream:${event.executionId}`) }
        }
    }

    const unsubscribe = api.chat.onEvent((event) => {
        if (event.type === 'stream-start' && event.scope === 'main') {
            startReading(event)
            return
        }
        if (!current || event.executionId !== current.executionId) return
        if (event.type === 'content-delta' && event.scope === 'main' && event.block.type === 'text') {
            current.stream.push(event.block.text)
        } else if ((event.type === 'stream-reset' || event.type === 'stream-discard') && event.scope === 'main') {
            current.stream.reset()
        } else if (event.type === 'execution-state' && event.state !== 'running') {
            current.stream.end()
            current = null
        }
    })

    // Leaving the chat silences it; the reply keeps streaming in the background.
    const stopWatching = watch(() => chatStore.activeConversationId, () => {
        if (!current) return
        current = null
        player.stop()
    })

    function onKeydown(event: KeyboardEvent): void {
        if (event.key !== 'Escape' || event.defaultPrevented || player.state.phase === 'idle') return
        player.stop()
    }
    document.addEventListener('keydown', onKeydown)

    return () => {
        unsubscribe()
        stopWatching()
        document.removeEventListener('keydown', onKeydown)
    }
}
