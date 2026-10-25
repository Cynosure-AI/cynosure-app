/**
 * Decides whether a shell command only reads, so it may run without approval
 * while the shell tool follows default approval.
 *
 * This is an allowlist: a command is read-only only when every simple command
 * in it is a known reader with no writing options, and it neither redirects
 * output to a file nor substitutes commands. Anything else asks. The model's
 * own description of the command is never consulted.
 */
import { commandName, tokenize } from './shell-guard.js'

export interface ShellCommandReview {
    readOnly: boolean
    /** Why the command needs approval; empty when it is read-only. */
    reasons: string[]
}

/** Commands that only read, unless an option in WRITING_OPTIONS is present. */
const READ_ONLY_COMMANDS = new Set([
    'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'fd', 'pwd', 'echo', 'printf',
    'which', 'whereis', 'type', 'file', 'stat', 'du', 'df', 'tree', 'diff', 'cmp', 'sort', 'uniq', 'cut', 'nl',
    'basename', 'dirname', 'realpath', 'readlink', 'date', 'whoami', 'id', 'uname', 'hostname', 'jq', 'true',
    'false', 'test', '[', 'md5sum', 'sha1sum', 'sha256sum', 'ps', 'free', 'uptime', 'lsblk', 'column', 'tr',
    // Windows cmd and PowerShell
    'dir', 'where', 'findstr', 'get-childitem', 'gci', 'get-content', 'gc', 'get-location', 'gl', 'select-string', 'sls',
])

/** Options that make an otherwise read-only command write, delete or run other programs. */
const WRITING_OPTIONS: Record<string, RegExp> = {
    find: /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/,
    fd: /^(-x|-X|--exec|--exec-batch)$/,
    sort: /^(-o|--output)/,
    rg: /^--pre(=|$)/,
    date: /^(-s|--set)/,
    hostname: /^[^-]/,
}

/** Git subcommands that only read the repository. */
const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'branch', 'tag', 'remote'])

export function reviewShellCommand(command: string, platform: NodeJS.Platform = process.platform): ShellCommandReview {
    const reasons: string[] = []
    // Substitutions run inside quotes too, where the tokenizer does not split them.
    if (/\$\(|`|[<>]\(/.test(command)) reasons.push('it runs a command substitution')

    const { segments, redirects } = tokenize(command, platform !== 'win32')
    if (redirects.some((target) => !/^(\d+|\/dev\/null|nul)$/i.test(target))) reasons.push('it redirects to or from a file')
    if (!segments.length) reasons.push('no command was found')

    for (const segment of segments) {
        // Leading NAME=value assignments only set the environment of the command.
        const start = segment.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
        if (start === -1) continue
        const reason = reviewSimpleCommand(segment.slice(start))
        if (reason && !reasons.includes(reason)) reasons.push(reason)
    }
    return { readOnly: reasons.length === 0, reasons }
}

function reviewSimpleCommand(argv: string[]): string | null {
    const name = commandName(argv[0])
    const args = argv.slice(1)
    if (args.length === 1 && args[0] === '--version') return null
    if (name === 'git') return reviewGit(args)
    if (!READ_ONLY_COMMANDS.has(name)) return `\`${name}\` is not on the read-only list`
    const writing = WRITING_OPTIONS[name]
    const option = writing && args.find((arg) => writing.test(arg))
    return option ? `\`${name} ${option}\` can write or run other programs` : null
}

function reviewGit(args: string[]): string | null {
    // Options before the subcommand (-C, -c) can redirect git or set an external command.
    const subcommand = args[0]
    if (!subcommand || !READ_ONLY_GIT.has(subcommand)) return `\`git${subcommand ? ` ${subcommand}` : ''}\` is not on the read-only list`
    const rest = args.slice(1)
    if (rest.some((arg) => /^--(output|ext-diff|textconv)/.test(arg))) return `\`git ${subcommand}\` with these options can write or run other programs`
    // branch, tag and remote only read when listing.
    if ((subcommand === 'branch' || subcommand === 'tag') && rest.some((arg) => !arg.startsWith('-') || /^-(d|D|m|M|c|C|f)$|^--(delete|move|copy|force|set-upstream|unset-upstream|edit-description)/.test(arg))) {
        return `\`git ${subcommand}\` with these arguments changes the repository`
    }
    if (subcommand === 'remote' && rest.some((arg) => arg !== '-v' && arg !== '--verbose')) return '`git remote` with these arguments changes the repository'
    return null
}
