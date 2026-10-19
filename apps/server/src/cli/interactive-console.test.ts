import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationExecutionConfig } from '@shared/types'
import { startInteractiveConsole } from './interactive-console.js'

const configuration: ConversationExecutionConfig = {
  allowedTools: ['test-tool'], subAgents: [], memoryFolderIds: ['memory'],
  systemPrompt: 'Be Cyno', model: 'test-model', providerId: 'test-provider',
  thinkingEnabled: true, reasoningEffort: 'medium', autoToolRouting: true, autoMemory: true,
}

const consoles: ReturnType<typeof startInteractiveConsole>[] = []
afterEach(async () => { await Promise.all(consoles.splice(0).map((console) => console.close())) })

function setup(send: () => Promise<unknown> = async () => ({ success: true })) {
  const input = new PassThrough()
  let output = ''
  let created = 0
  const request = vi.fn(async (_method: string, url: string, _body?: object) => {
    if (url === '/api/chat/conversations') return { id: `chat-${++created}` }
    if (url.endsWith('/send')) return send()
    return { status: 'ok' }
  })
  const approve = vi.fn(() => true)
  const shutdown = vi.fn()
  const console = startInteractiveConsole({
    input, output: new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback() } }),
    configuration: () => configuration, request, approve, shutdown,
  })
  consoles.push(console)
  return { console, input, request, approve, shutdown, output: () => output }
}

describe('interactive console', () => {
  it('saves a Cyno conversation, reuses its history, and starts a fresh chat with /new', async () => {
    const client = setup()
    client.input.write('Hello\n')
    await new Promise<void>((resolve) => setImmediate(resolve))
    await vi.waitFor(() => expect(client.output()).toMatch(/cyno> $/))
    expect(client.request).toHaveBeenCalledWith('POST', '/api/chat/conversations', {
      title: 'Terminal chat', origin: 'chat', executionConfig: configuration,
    })
    expect(client.request).toHaveBeenCalledWith('POST', '/api/chat/conversations/chat-1/send', {
      content: 'Hello', run: expect.objectContaining({ providerOverride: 'test-provider', model: 'test-model', allowedTools: ['test-tool'] }),
    })
    client.input.write('Follow up\n')
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith('POST', '/api/chat/conversations/chat-1/send', expect.objectContaining({ content: 'Follow up' })))
    await new Promise<void>((resolve) => setImmediate(resolve))
    client.input.write('/new\nAnother topic\n')
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith('POST', '/api/chat/conversations/chat-2/send', expect.objectContaining({ content: 'Another topic' })))
  })

  it('accepts approvals and cancellation while a send is pending and ignores other chats', async () => {
    let finish!: () => void
    const client = setup(() => new Promise<void>((resolve) => { finish = resolve }))
    client.input.write('Use a tool\n')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    client.console.receive('agent:hitl-request', { conversationId: 'other-chat', taskId: 'foreign', toolCalls: [] })
    client.input.write('/approve foreign\n')
    expect(client.approve).not.toHaveBeenCalled()
    client.console.receive('agent:hitl-request', { conversationId: 'chat-1', taskId: 'tool-1', toolCalls: [{ name: 'write', arguments: '{"path":"/tmp/file"}' }] })
    expect(client.output()).toContain('/tmp/file')
    client.input.write('/approve\n')
    expect(client.approve).toHaveBeenCalledWith('tool-1', true)
    client.console.receive('agent:hitl-request', { conversationId: 'chat-1', taskId: 'tool-2', toolCalls: [] })
    client.input.write('/deny tool-2\n')
    expect(client.approve).toHaveBeenCalledWith('tool-2', false)
    client.input.write('Do something else\n/stop\n')
    expect(client.output()).toContain('Cyno is replying')
    expect(client.request).toHaveBeenCalledWith('POST', '/api/chat/cancel', { conversationId: 'chat-1' })
    finish()
  })

  it('streams only this conversation and the main assistant, and recovers from send errors', async () => {
    let rejectSend!: (error: Error) => void
    const client = setup(() => new Promise((_resolve, reject) => { rejectSend = reject }))
    client.input.write('Hello\n')
    await vi.waitFor(() => expect(rejectSend).toBeTypeOf('function'))
    const payload = { type: 'content-delta', scope: 'main', block: { type: 'text', text: 'Visible reply' } }
    client.console.receive('chat:event', { conversationId: 'other-chat', payload })
    client.console.receive('chat:event', { conversationId: 'chat-1', payload: { ...payload, scope: 'subagent' } })
    expect(client.output()).not.toContain('Visible reply')
    client.console.receive('chat:event', { conversationId: 'chat-1', payload })
    expect(client.output()).toContain('Visible reply')
    rejectSend(new Error('Configure a provider'))
    await vi.waitFor(() => expect(client.output()).toContain('Error: Configure a provider'))
    client.input.write('/status\n')
    await vi.waitFor(() => expect(client.output()).toContain('"status": "ok"'))
  })

  it('does not start a reply when stopped while creating the conversation', async () => {
    const client = setup()
    let created!: (value: { id: string }) => void
    client.request.mockImplementationOnce(() => new Promise<{ id: string }>((resolve) => { created = resolve }))
    client.input.write('Hello\n/stop\n')
    created({ id: 'chat-1' })
    await vi.waitFor(() => expect(client.output()).toContain('Stop requested.'))
    expect(client.request).not.toHaveBeenCalledWith('POST', '/api/chat/conversations/chat-1/send', expect.anything())
    await client.console.close()
    expect(client.request).toHaveBeenCalledWith('POST', '/api/chat/cancel', { conversationId: 'chat-1' })
  })

  it('requests shutdown for /exit and EOF, and closes without recursively shutting down', async () => {
    const client = setup()
    client.input.write('/exit\n')
    expect(client.shutdown).toHaveBeenCalledOnce()
    await client.console.close()
    expect(client.shutdown).toHaveBeenCalledOnce()
    const eof = setup()
    eof.input.end()
    await vi.waitFor(() => expect(eof.shutdown).toHaveBeenCalledOnce())
  })
})
