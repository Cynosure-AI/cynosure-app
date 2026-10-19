import { createInterface, type Interface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { ChatEventDraft, ConversationExecutionConfig } from '@shared/types'
import { runConfigFromExecutionConfig } from '../core/chat/run-config.js'

interface ConsoleOptions {
  request: (method: 'GET' | 'POST', url: string, body?: object) => Promise<unknown>
  configuration: () => ConversationExecutionConfig
  approve: (taskId: string, approved: boolean) => boolean
  shutdown: () => void
  input?: Readable
  output?: Writable
}

const HELP = `Type a message to chat with Cyno. Commands remain available during a reply.
/help                Show commands
/status              Show server status and this conversation
/new                 Start a new saved conversation
/stop                Cancel the current reply
/approve [task-id]   Approve a pending tool request once
/deny [task-id]      Deny a pending tool request
/exit                Shut down the server (also Ctrl+C or Ctrl+D)`

/** A local client of the normal chat routes; it does not run a second agent. */
export function startInteractiveConsole(options: ConsoleOptions) {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const terminal = Boolean((input as NodeJS.ReadStream).isTTY && (output as NodeJS.WriteStream).isTTY)
  const rl: Interface = createInterface({ input, output, terminal, prompt: 'cyno> ' })
  let conversationId: string | undefined
  let config: ConversationExecutionConfig | undefined
  let busy = false
  let stopRequested = false
  let closed = false
  const approvals = new Set<string>()
  const print = (message: string) => output.write(`${message}\n`)
  const prompt = () => { if (!closed) rl.prompt(true) }
  const cancel = async () => {
    if (conversationId) await options.request('POST', '/api/chat/cancel', { conversationId })
    approvals.clear()
  }

  async function handleLine(line: string) {
    const text = line.trim()
    if (!text || closed) return
    const [command, taskId, ...extra] = text.split(/\s+/)
    if (command === '/exit' || command === '/quit') {
      options.shutdown()
      return
    }
    if (command === '/help') { print(HELP); return }
    if (command === '/status') {
      print(JSON.stringify(await options.request('GET', '/api/health'), null, 2))
      print(`Conversation: ${conversationId ?? '(send a message to start)'}${busy ? ' — replying' : ''}`)
      return
    }
    if (command === '/stop') { stopRequested = true; await cancel(); print('Stop requested.'); return }
    if (command === '/approve' || command === '/deny') {
      const id = taskId ?? (approvals.size === 1 ? [...approvals][0] : undefined)
      if (extra.length || !id || !approvals.has(id)) {
        print('Choose a pending task ID: ' + ([...approvals].join(', ') || '(none)'))
        return
      }
      const resolved = options.approve(id, command === '/approve')
      approvals.delete(id)
      print(resolved ? `Request ${command === '/approve' ? 'approved once' : 'denied'}.` : 'Request is no longer pending.')
      return
    }
    if (command === '/new') {
      if (busy) { print('Use /stop and wait for the reply to finish before /new.'); return }
      conversationId = undefined
      config = undefined
      approvals.clear()
      print('The next message will start a new conversation. Previous chats remain saved.')
      return
    }
    if (text.startsWith('/')) { print('Unknown command. Type /help.'); return }
    if (busy) { print('Cyno is replying. Use /stop or wait before sending another message.'); return }

    busy = true
    stopRequested = false
    try {
      if (!conversationId) {
        config = options.configuration()
        const conversation = await options.request('POST', '/api/chat/conversations', {
          title: 'Terminal chat', origin: 'chat', executionConfig: config,
        }) as { id: string }
        conversationId = conversation.id
        if (closed || stopRequested) return
        print(`Conversation: ${conversationId}`)
      }
      await options.request('POST', `/api/chat/conversations/${conversationId}/send`, {
        content: text, run: runConfigFromExecutionConfig(config!),
      })
    } finally {
      busy = false
      approvals.clear()
      if (!closed) print('')
    }
  }

  rl.on('line', (line) => {
    void handleLine(line).catch((error: unknown) => {
      if (!closed) print(`Error: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(prompt)
  })
  rl.on('SIGINT', options.shutdown)
  rl.on('close', () => { if (!closed) options.shutdown() })
  print(`Interactive Cyno console. Type /help for commands.\n${HELP}`)
  prompt()

  return {
    receive(event: string, data: unknown) {
      if (closed || !data || typeof data !== 'object') return
      const message = data as { conversationId?: string; taskId: string; toolCalls?: unknown }
      if (!conversationId || message.conversationId !== conversationId) return
      if (event === 'agent:hitl-request') {
        approvals.add(message.taskId)
        print(`\nApproval required (${message.taskId}):\n${JSON.stringify(message.toolCalls, null, 2)}\n/approve ${message.taskId} or /deny ${message.taskId}`)
        prompt()
      } else if (event === 'agent:hitl-resolved') {
        approvals.delete(message.taskId)
      } else if (event === 'chat:event') {
        const { payload } = data as ChatEventDraft
        if (payload.type === 'content-delta' && payload.scope === 'main' && payload.block.type === 'text') {
          output.write(payload.block.text)
        } else if (payload.type === 'stream-error' && payload.scope === 'main') {
          print(`\nError: ${payload.error}`)
        } else if (payload.type === 'media-added' && payload.scope === 'main') {
          print(`\n${JSON.stringify(payload.blocks)}`)
        }
      }
    },
    async close() {
      if (closed) return
      closed = true
      rl.close()
      await cancel()
    },
  }
}
