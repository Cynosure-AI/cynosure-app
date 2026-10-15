/**
 * A last line of defense against catastrophic shell commands: recursive
 * deletion of the filesystem root, the home directory, system directories or
 * the project, disk formatting, and powering off the host.
 *
 * This is a denylist over a best-effort parse of the command. It catches
 * mistakes and naive commands, not a deliberate bypass (eval of encoded text,
 * computed paths, scripts written to disk); tool approval remains the boundary.
 */
import * as os from 'node:os'
import * as path from 'node:path'

export interface ShellGuardOptions {
    /** Directory the command starts in. */
    cwd: string
    platform?: NodeJS.Platform
    homeDir?: string
    env?: NodeJS.ProcessEnv
    /** Paths whose recursive deletion is blocked in addition to the system ones (the project root, the server directory). */
    protectedPaths?: string[]
}

interface GuardContext {
    win: boolean
    /** Variables assigned earlier in the script. */
    vars: Map<string, string>
    path: typeof path.posix
    home: string
    env: NodeJS.ProcessEnv
    /** Blocked for recursive deletion, moves, and ownership/permission changes. */
    systemPaths: string[]
    /** Blocked for recursive deletion only. */
    workspacePaths: string[]
}

const MAX_NESTING = 4

const POSIX_SYSTEM_PATHS = [
    '/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib32', '/lib64', '/libx32', '/media', '/mnt', '/opt',
    '/proc', '/root', '/run', '/sbin', '/snap', '/srv', '/sys', '/usr', '/usr/bin', '/usr/lib', '/usr/local',
    '/usr/sbin', '/usr/share', '/var', '/var/lib',
    // macOS
    '/Applications', '/Library', '/System', '/Users', '/Volumes', '/private',
]

const WINDOWS_SYSTEM_PATHS = [
    'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData', 'C:\\Users',
]

/** Leading words that run the rest of the line as a command, with their options that take a value. */
const COMMAND_PREFIXES: Record<string, string[]> = {
    sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U'],
    doas: ['-u', '-C'],
    env: ['-u', '-C', '-S'],
    nice: ['-n'],
    ionice: ['-c', '-n', '-p'],
    nohup: [],
    time: [],
    command: [],
    builtin: [],
    exec: [],
    stdbuf: ['-i', '-o', '-e'],
    xargs: ['-a', '-d', '-E', '-I', '-L', '-n', '-P', '-s'],
    busybox: [],
}
const KEYWORDS = new Set(['{', '}', '!', 'then', 'else', 'elif', 'do', 'if', 'while', 'until'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'ash'])
const POWER_COMMANDS = new Set(['shutdown', 'reboot', 'poweroff', 'halt', 'stop-computer', 'restart-computer'])
const DISK_COMMANDS = new Set(['wipefs', 'mke2fs', 'diskpart', 'format-volume', 'clear-disk', 'initialize-disk', 'remove-partition'])
const BLOCK_DEVICE = /^\/dev\/(sd[a-z]|hd[a-z]|vd[a-z]|xvd[a-z]|nvme\d|mmcblk\d|r?disk\d|md\d|dm-\d|mapper\/|root\b)/
const FORK_BOMB = /([\w:]+)\s*\(\s*\)\s*\{[^}]*\1\s*\|\s*\1\s*&/

/**
 * Return why `command` is blocked, or null when it may run.
 */
export function findBlockedShellCommand(command: string, options: ShellGuardOptions): string | null {
    const platform = options.platform ?? process.platform
    const win = platform === 'win32'
    const pathApi = win ? path.win32 : path.posix
    const home = options.homeDir ?? os.homedir()
    const ctx: GuardContext = {
        win,
        vars: new Map(),
        path: pathApi,
        home,
        env: options.env ?? process.env,
        systemPaths: [...(win ? WINDOWS_SYSTEM_PATHS : POSIX_SYSTEM_PATHS), home].filter(Boolean),
        workspacePaths: (options.protectedPaths ?? []).filter(Boolean).map((value) => pathApi.resolve(value)),
    }
    return checkScript(command, options.cwd, ctx, 0)
}

function checkScript(script: string, startCwd: string | null, ctx: GuardContext, depth: number): string | null {
    if (depth > MAX_NESTING) return null
    if (FORK_BOMB.test(script)) return 'it is a fork bomb'

    const { segments, redirects } = tokenize(script, !ctx.win)
    for (const target of redirects) {
        if (!ctx.win && BLOCK_DEVICE.test(target)) return `it writes directly to the disk device ${target}`
    }

    // `cd` changes where later relative paths point; null once it can't be followed.
    let cwd: string | null = startCwd
    for (const segment of segments) {
        recordAssignments(segment, cwd, ctx)
        const argv = stripPrefixes(segment)
        if (!argv.length) continue
        const name = commandName(argv[0])
        const args = argv.slice(1)

        if (name === 'cd') {
            cwd = changeDirectory(cwd, args, ctx)
            continue
        }
        const reason = checkCommand(name, args, cwd, ctx, depth)
        if (reason) return reason
    }
    return null
}

function checkCommand(name: string, args: string[], cwd: string | null, ctx: GuardContext, depth: number): string | null {
    // Nested scripts: sh -c '…', cmd /c …, powershell -Command …, eval …
    if (SHELLS.has(name)) {
        const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/i.test(arg))
        if (flag !== -1 && args[flag + 1] !== undefined) return checkScript(args[flag + 1], cwd, ctx, depth + 1)
        return null
    }
    if (name === 'cmd') {
        const flag = args.findIndex((arg) => /^\/[ck]$/i.test(arg))
        return flag === -1 ? null : checkScript(args.slice(flag + 1).join(' '), cwd, ctx, depth + 1)
    }
    if (name === 'powershell' || name === 'pwsh') {
        const flag = args.findIndex((arg) => /^-(c|command)$/i.test(arg))
        return flag === -1 ? null : checkScript(args.slice(flag + 1).join(' '), cwd, ctx, depth + 1)
    }
    if (name === 'eval') return checkScript(args.join(' '), cwd, ctx, depth + 1)

    if (name === 'rm' || name === 'remove-item' || name === 'ri' || name === 'del' || name === 'erase' || name === 'rd' || name === 'rmdir') {
        return checkRecursiveDelete(name, args, cwd, ctx)
    }
    if (name === 'shred') {
        const target = operands(args).find((arg) => BLOCK_DEVICE.test(arg) || coversAny(arg, cwd, ctx, true))
        return target ? `it shreds ${target}` : null
    }
    if (name === 'chmod' || name === 'chown' || name === 'chgrp') {
        if (!args.some((arg) => /^-[a-zA-Z]*R/.test(arg) || arg === '--recursive')) return null
        // The first operand is the mode, owner, or group.
        const target = operands(args).slice(1)
            .find((arg) => coversAny(arg, cwd, ctx, false))
        return target ? `it recursively changes ${name === 'chmod' ? 'permissions' : 'ownership'} of ${target}` : null
    }
    if (name === 'mv') {
        const sources = operands(args).slice(0, -1)
        const target = sources.find((arg) => coversAny(arg, cwd, ctx, false))
        return target ? `it moves the protected directory ${target}` : null
    }
    if (name === 'dd') {
        const output = args.find((arg) => arg.startsWith('of='))?.slice(3)
        return output && BLOCK_DEVICE.test(output) ? `it writes directly to the disk device ${output}` : null
    }
    if (name.startsWith('mkfs') || DISK_COMMANDS.has(name)) return `it formats or erases disks (${name})`
    if (name === 'format' && args.some((arg) => /^[a-z]:$/i.test(arg))) return 'it formats a drive'
    if (POWER_COMMANDS.has(name)) return `it shuts down or restarts the host (${name})`
    if ((name === 'init' || name === 'telinit') && (args[0] === '0' || args[0] === '6')) return 'it shuts down or restarts the host'
    if (name === 'systemctl' && args.some((arg) => /^(poweroff|reboot|halt|kexec)$/.test(arg))) return 'it shuts down or restarts the host'
    if (name === 'kill') {
        // `kill -1 <pid>` sends SIGHUP; `-1` after the signal targets every process.
        if (args.slice(1).includes('-1')) return 'it signals every process on the host'
        if (args.includes(String(process.pid))) return 'it signals the Cynosure server process'
    }
    return null
}

function checkRecursiveDelete(name: string, args: string[], cwd: string | null, ctx: GuardContext): string | null {
    if (args.includes('--no-preserve-root')) return 'it disables rm\'s protection of the filesystem root'
    let recursive: boolean
    let targets: string[]
    if (name === 'rd' || name === 'rmdir' || name === 'del' || name === 'erase') {
        // cmd.exe switches look like /s; PowerShell aliases these to Remove-Item.
        recursive = args.some((arg) => /^\/s$/i.test(arg) || isPowerShellRecurse(arg))
        targets = args.filter((arg) => !/^\/[a-z]$/i.test(arg) && !arg.startsWith('-'))
    } else if (name === 'rm') {
        recursive = args.some((arg) => arg === '--recursive' || (/^-[a-zA-Z]+$/.test(arg) && /[rR]/.test(arg)))
        targets = operands(args)
    } else {
        recursive = args.some(isPowerShellRecurse)
        targets = args.filter((arg) => !arg.startsWith('-'))
    }
    if (!recursive) return null
    const target = targets.find((arg) => coversAny(arg, cwd, ctx, true))
    return target ? `it recursively deletes ${describeTarget(target, cwd, ctx)}` : null
}

function isPowerShellRecurse(arg: string): boolean {
    return /^-r(e(c(u(r(s(e)?)?)?)?)?)?$/i.test(arg)
}

/** Arguments that are not options; everything after `--` is an operand. */
function operands(args: string[]): string[] {
    const end = args.indexOf('--')
    const before = (end === -1 ? args : args.slice(0, end)).filter((arg) => !arg.startsWith('-') || arg === '-')
    return end === -1 ? before : [...before, ...args.slice(end + 1)]
}

function describeTarget(target: string, cwd: string | null, ctx: GuardContext): string {
    const resolved = resolveTarget(target, cwd, ctx)
    return resolved && resolved !== target ? `${target} (${resolved})` : target
}

/**
 * Whether deleting `target` would delete a protected path: it is one, contains
 * one, or is a glob directly inside one.
 */
function coversAny(target: string, cwd: string | null, ctx: GuardContext, includeWorkspace: boolean): boolean {
    const resolved = resolveTarget(target, cwd, ctx)
    if (!resolved) return false
    const protectedPaths = includeWorkspace ? [...ctx.systemPaths, ...ctx.workspacePaths] : ctx.systemPaths
    if (ctx.win && /^[a-z]:\\?$/i.test(resolved)) return true
    return protectedPaths.some((protectedPath) => isSameOrAncestor(resolved, protectedPath, ctx))
}

/** Absolute path a delete would start from: the directory holding the first glob, or the target itself. */
function resolveTarget(target: string, cwd: string | null, ctx: GuardContext): string | null {
    const expanded = expandVariables(target, cwd, ctx)
    if (!expanded) return null
    const absolute = ctx.path.isAbsolute(expanded)
    if (!absolute && cwd === null) return null
    const sep = ctx.win ? /[\\/]/ : /\//
    const parts = expanded.split(sep)
    const globAt = parts.findIndex((part) => /[*?[]/.test(part))
    let base = globAt === -1 ? expanded : parts.slice(0, globAt).join(ctx.win ? '\\' : '/') || (absolute ? (ctx.win ? '\\' : '/') : '.')
    // A bare drive (C:) would resolve to the working directory on that drive.
    if (ctx.win && /^[a-z]:$/i.test(base)) base += '\\'
    return ctx.path.resolve(cwd ?? '/', base)
}

function isSameOrAncestor(candidate: string, protectedPath: string, ctx: GuardContext): boolean {
    const normalize = (value: string) => ctx.win ? ctx.path.resolve(value).toLowerCase() : ctx.path.resolve(value)
    const relative = ctx.path.relative(normalize(candidate), normalize(protectedPath))
    return relative === '' || (!relative.startsWith('..') && !ctx.path.isAbsolute(relative))
}

/** Expand ~ and variables; unknown variables expand to nothing, the way an unset one would. */
function expandVariables(word: string, cwd: string | null, ctx: GuardContext): string {
    const known = (name: string): string => {
        const assigned = ctx.vars.get(name)
        if (assigned !== undefined) return assigned
        if (name === 'HOME' || name.toUpperCase() === 'USERPROFILE') return ctx.home
        if (name === 'PWD') return cwd ?? ''
        const value = ctx.win
            ? Object.entries(ctx.env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1]
            : ctx.env[name]
        if (value) return value
        if (ctx.win && /^(systemroot|windir)$/i.test(name)) return 'C:\\Windows'
        return ''
    }
    let result = word.replace(/^~(?=$|[\\/])/, ctx.home)
    if (cwd !== null) result = result.replace(/\$\(pwd\)/g, cwd)
    result = result.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}/g, (_, name: string) => known(name))
    result = result.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, name: string) => known(name))
    result = result.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => known(name))
    if (ctx.win) result = result.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, name: string) => known(name))
    return result
}

/** Remember `NAME=value` and `export NAME=value` so later commands expand them. */
function recordAssignments(segment: string[], cwd: string | null, ctx: GuardContext): void {
    const words = segment[0] === 'export' ? segment.slice(1) : segment
    if (!words.length || !words.every((word) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word))) return
    for (const word of words) {
        const equals = word.indexOf('=')
        ctx.vars.set(word.slice(0, equals), expandVariables(word.slice(equals + 1), cwd, ctx))
    }
}

function changeDirectory(cwd: string | null, args: string[], ctx: GuardContext): string | null {
    const target = args.find((arg) => !arg.startsWith('-') || arg === '-')
    if (target === undefined) return ctx.home
    if (target === '-' || /\$\(|`/.test(target)) return null
    const expanded = expandVariables(target, cwd, ctx)
    if (!expanded) return null
    if (!ctx.path.isAbsolute(expanded) && cwd === null) return null
    return ctx.path.resolve(cwd ?? '/', expanded)
}

function commandName(word: string): string {
    const base = word.split(/[\\/]/).pop() ?? word
    return base.toLowerCase().replace(/\.exe$/, '')
}

/** Drop sudo, env assignments, shell keywords and similar wrappers so argv[0] is the real command. */
function stripPrefixes(argv: string[]): string[] {
    let index = 0
    while (index < argv.length) {
        const word = argv[index]
        if (KEYWORDS.has(word) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
            index++
            continue
        }
        const name = commandName(word)
        if (name === 'timeout') {
            index++
            while (index < argv.length && argv[index].startsWith('-')) index++
            index++ // duration
            continue
        }
        const valueOptions = COMMAND_PREFIXES[name]
        if (!valueOptions) break
        index++
        while (index < argv.length && (argv[index].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[index]))) {
            index += valueOptions.includes(argv[index]) ? 2 : 1
        }
    }
    return argv.slice(index)
}

/**
 * Split a script into simple commands. Quotes are removed, operators and
 * command substitutions end a command, and redirect targets are collected
 * separately so they are not mistaken for arguments.
 */
function tokenize(script: string, backslashEscapes: boolean): { segments: string[][]; redirects: string[] } {
    const segments: string[][] = []
    const redirects: string[] = []
    let current: string[] = []
    let word = ''
    let inWord = false
    let redirectNext = false

    const endWord = () => {
        if (!inWord) return
        if (redirectNext) redirects.push(word)
        else current.push(word)
        redirectNext = false
        word = ''
        inWord = false
    }
    const endSegment = () => {
        endWord()
        if (current.length) segments.push(current)
        current = []
    }

    for (let i = 0; i < script.length; i++) {
        const char = script[i]
        if (char === '\'') {
            const close = script.indexOf('\'', i + 1)
            word += script.slice(i + 1, close === -1 ? undefined : close)
            inWord = true
            i = close === -1 ? script.length : close
        } else if (char === '"') {
            inWord = true
            for (i++; i < script.length && script[i] !== '"'; i++) {
                if (backslashEscapes && script[i] === '\\' && /["\\$`]/.test(script[i + 1] ?? '')) i++
                word += script[i]
            }
        } else if (char === '\\' && backslashEscapes) {
            if (script[i + 1] === '\n') { i++; continue }
            word += script[i + 1] ?? ''
            inWord = true
            i++
        } else if (/\s/.test(char)) {
            if (char === '\n') endSegment()
            else endWord()
        } else if (char === '#' && !inWord) {
            const newline = script.indexOf('\n', i)
            i = newline === -1 ? script.length : newline - 1
        } else if (char === '$' && script[i + 1] === '(') {
            endSegment()
            i++
        } else if (';&|()`'.includes(char)) {
            if (char === '&' && script[i + 1] === '>') continue // &> redirect
            if (char === '&' && script[i - 1] === '>') continue // >& redirect
            endSegment()
        } else if (char === '>' || char === '<') {
            // A file descriptor number directly before the operator (2>) is not an argument.
            if (inWord && /^\d+$/.test(word)) { word = ''; inWord = false }
            endWord()
            while (script[i + 1] === '>' || script[i + 1] === '|' || script[i + 1] === '&') i++
            redirectNext = true
        } else {
            word += char
            inWord = true
        }
    }
    endSegment()
    return { segments, redirects }
}
