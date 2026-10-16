import { rankItems } from './command-palette'

/**
 * Slash commands for the chat composer. A message that starts with `/` (and
 * has no line break) is read as a command: `/name` picks a command and
 * `/name argument` picks one of its argument options.
 */

/** What a command reports back, shown briefly above the composer. */
export type SlashResult = string | void

export interface SlashOption {
  key: string
  label: string
  /** Placeholder for a required or optional argument, e.g. `on|off`. */
  hint?: string
  description?: string
  icon?: string
  iconUrl?: string | null
  group?: string
  /** Current state of the setting this option controls. */
  state?: 'on' | 'off' | 'mixed'
  /** Short muted text on the right, e.g. the current value. */
  detail?: string
  /** Composer text that Tab fills in. */
  complete?: string
  /** Why the command cannot run right now; choosing it shows this instead. */
  unavailable?: string
  /** Absent when the option needs an argument; choosing it then completes instead. */
  run?: () => SlashResult | Promise<SlashResult>
}

export interface SlashArgOption extends Omit<SlashOption, 'complete'> {
  /** The argument text Tab fills in. Defaults to the label. */
  value?: string
}

export interface SlashCommand {
  name: string
  aliases?: string[]
  description: string
  icon: string
  iconUrl?: string | null
  group: string
  hint?: string
  state?: SlashOption['state']
  detail?: string
  /**
   * Why the command cannot run right now. It stays listed (so typing it is
   * never mistaken for a message to the model) but only reports this reason.
   */
  unavailable?: string
  /** Runs the bare command. When absent the command needs an argument. */
  run?: () => SlashResult | Promise<SlashResult>
  /** Argument options for the typed argument text (already trimmed). */
  args?: (query: string) => SlashArgOption[]
  /** With an argument, the whole text is sent to the model as a message, e.g. `/goal …`. */
  sendsMessage?: boolean
}

export interface SlashInput {
  name: string
  args: string
  /** A space follows the command name, so the argument is being typed. */
  hasArgs: boolean
}

export function parseSlashInput(text: string): SlashInput | null {
  if (text.includes('\n')) return null
  // `/etc/hosts …` and other paths are not commands.
  const match = /^\/([^\s/]*)(?:(\s+)(.*))?$/.exec(text)
  if (!match) return null
  return { name: match[1].toLowerCase(), args: match[3] ?? '', hasArgs: match[2] !== undefined }
}

export function findSlashCommand(commands: readonly SlashCommand[], name: string): SlashCommand | undefined {
  const wanted = name.toLowerCase()
  return commands.find(command => command.name === wanted || command.aliases?.includes(wanted))
}

/** Filter and rank argument options against the typed argument. */
export function rankSlashArgs(options: readonly SlashArgOption[], query: string): SlashArgOption[] {
  return rankItems(options, query, option => [option.label, option.value, option.description], options.length)
}

/** Lowercase, dash-separated command name for a free-form label such as an MCP server name. */
export function slashName(label: string): string {
  return label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function commandOption(command: SlashCommand): SlashOption {
  return {
    key: `command:${command.name}`,
    label: `/${command.name}`,
    hint: command.hint,
    description: command.description,
    icon: command.icon,
    iconUrl: command.iconUrl,
    group: command.group,
    state: command.state,
    detail: command.detail,
    unavailable: command.unavailable,
    complete: (command.args || command.sendsMessage) && !command.unavailable ? `/${command.name} ` : `/${command.name}`,
    run: command.run,
  }
}

/** The menu options for the current composer text; empty when it is not a command. */
export function slashSuggestions(commands: readonly SlashCommand[], text: string): SlashOption[] {
  const input = parseSlashInput(text)
  if (!input) return []
  if (input.hasArgs) {
    const command = findSlashCommand(commands, input.name)
    if (command?.unavailable) return [commandOption(command)]
    if (!command?.args || command.sendsMessage) return []
    return command.args(input.args.trim()).map(({ value, ...option }) => ({
      ...option,
      key: `${command.name}:${option.key}`,
      complete: `/${command.name} ${value ?? option.label}`,
    }))
  }
  return rankItems(commands, input.name, command => [command.name, ...(command.aliases ?? []), command.description], commands.length)
    .map(commandOption)
}
