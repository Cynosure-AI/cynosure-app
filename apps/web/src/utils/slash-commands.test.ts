import { describe, expect, test, vi } from 'vitest'
import { composerCommandAt, findSlashCommand, parseSlashInput, rankSlashArgs, slashName, slashSuggestions, type SlashCommand } from './slash-commands'

const commands: SlashCommand[] = [
  { name: 'new', aliases: ['clear'], description: 'Start a new chat', icon: 'x', group: 'Chat', run: vi.fn() },
  {
    name: 'think',
    aliases: ['reasoning'],
    description: 'Set the reasoning level',
    icon: 'x',
    group: 'Settings',
    hint: 'level',
    args: query => rankSlashArgs([
      { key: 'low', label: 'Low', value: 'low', run: vi.fn() },
      { key: 'high', label: 'High', value: 'high', run: vi.fn() },
    ], query),
  },
  { name: 'auto-memory', description: 'Retrieve relevant memories automatically', icon: 'x', group: 'Settings', run: vi.fn() },
  { name: 'memory', description: 'Turn a memory folder on or off', icon: 'x', group: 'Settings', args: () => [] },
]

describe('parseSlashInput', () => {
  test('reads the command name and argument', () => {
    expect(parseSlashInput('/think high')).toEqual({ name: 'think', args: 'high', hasArgs: true })
    expect(parseSlashInput('/Think')).toEqual({ name: 'think', args: '', hasArgs: false })
    expect(parseSlashInput('/')).toEqual({ name: '', args: '', hasArgs: false })
  })

  test('ignores text that is not a command', () => {
    expect(parseSlashInput('hello /think')).toBeNull()
    expect(parseSlashInput('/etc/hosts is broken')).toBeNull()
    expect(parseSlashInput('/think\nmore')).toBeNull()
  })
})

describe('slashSuggestions', () => {
  test('lists every command for a bare slash, in definition order', () => {
    expect(slashSuggestions(commands, '/').map(option => option.label)).toEqual(['/new', '/think', '/auto-memory', '/memory'])
  })

  test('ranks an exact name above partial matches', () => {
    expect(slashSuggestions(commands, '/memory').map(option => option.label)).toEqual(['/memory', '/auto-memory'])
  })

  test('matches aliases', () => {
    expect(slashSuggestions(commands, '/reason')[0].label).toBe('/think')
    expect(findSlashCommand(commands, 'clear')?.name).toBe('new')
  })

  test('commands with arguments complete instead of running', () => {
    const [think] = slashSuggestions(commands, '/think')
    expect(think.run).toBeUndefined()
    expect(think.complete).toBe('/think ')
    expect(slashSuggestions(commands, '/new')[0].complete).toBe('/new')
  })

  test('shows argument options after a space, with their completion text', () => {
    const options = slashSuggestions(commands, '/think ')
    expect(options.map(option => option.label)).toEqual(['Low', 'High'])
    expect(options[1].complete).toBe('/think high')
    expect(options[1].key).toBe('think:high')
    expect(slashSuggestions(commands, '/think  HI ').map(option => option.label)).toEqual(['High'])
  })

  test('an unavailable command offers only itself, even with an argument', () => {
    const blocked: SlashCommand[] = [{ ...commands[1], unavailable: 'Not now.' }]
    for (const text of ['/think', '/think high']) {
      const options = slashSuggestions(blocked, text)
      expect(options).toHaveLength(1)
      expect(options[0]).toMatchObject({ label: '/think', unavailable: 'Not now.', complete: '/think' })
    }
  })

  test('has no suggestions for unknown commands or commands without arguments', () => {
    expect(slashSuggestions(commands, '/nothing')).toEqual([])
    expect(slashSuggestions(commands, '/nothing here')).toEqual([])
    expect(slashSuggestions(commands, '/new chat')).toEqual([])
    expect(slashSuggestions(commands, 'plain text')).toEqual([])
  })
})

describe('commands that send a message', () => {
  const goal: SlashCommand = { name: 'goal', description: 'Work toward a goal', icon: 'x', group: 'Chat', hint: 'objective', sendsMessage: true }

  test('complete with a space and offer no options for the argument', () => {
    expect(slashSuggestions([goal], '/go')).toMatchObject([{ label: '/goal', complete: '/goal ' }])
    expect(slashSuggestions([goal], '/goal Fix the build')).toEqual([])
  })
})

describe('slashName', () => {
  test('turns a label into a command name', () => {
    expect(slashName('GitHub')).toBe('github')
    expect(slashName('  Google Drive (beta) ')).toBe('google-drive-beta')
    expect(slashName('???')).toBe('')
  })
})


describe('composerCommandAt', () => {
  test('finds inline commands after text and line breaks', () => {
    expect(composerCommandAt('hello /think high')).toMatchObject({ name: 'think', args: 'high', start: 6, end: 17 })
    expect(composerCommandAt('hello\n/agent Research')).toMatchObject({ name: 'agent', args: 'Research', start: 6 })
    expect(slashSuggestions(commands, 'hello /think high')[0].label).toBe('High')
  })

  test('uses the cursor and replaces the rest of a partially edited word', () => {
    expect(composerCommandAt('hello /think later', 10)).toMatchObject({ text: '/thi', start: 6, end: 12 })
    expect(composerCommandAt('hello', -1)).toBeNull()
  })

  test('ignores email addresses, URLs, paths, and earlier lines', () => {
    for (const text of ['hello @researcher', 'user@example.com', 'https://example.com', '/etc/hosts', 'text/think', '/think\nhello']) {
      expect(composerCommandAt(text)).toBeNull()
    }
  })
})
