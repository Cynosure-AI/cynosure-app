import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import * as path from 'node:path'
import type { ToolDefinition, ToolResult } from '../../gateway/providers/base.provider.js'
import { getDataDir } from '../../data-dir.js'
import { findBlockedShellCommand } from './shell-guard.js'

// Large output is saved as session content by the executor; this only bounds memory.
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 120
const MAX_COMMAND_TIMEOUT_SECONDS = 600
const MAX_EXPLANATION_LENGTH = 500

/** Commands still running; killed when the server exits so they are not left orphaned. */
const runningChildren = new Set<ChildProcess>()
let exitHookInstalled = false

export function makeShellTool(options: { defaultCwd?: string } = {}): ToolDefinition {
    const defaultCwd = options.defaultCwd || undefined
    const operatingSystems: Partial<Record<NodeJS.Platform, string>> = { linux: 'Linux', win32: 'Windows', darwin: 'macOS' }
    const operatingSystem = operatingSystems[process.platform] ?? process.platform
    // Match Node's default shell and use the same executable advertised to the model.
    const shell = process.platform === 'win32'
        ? process.env.ComSpec || process.env.comspec || 'cmd.exe'
        : process.platform === 'android' ? '/system/bin/sh' : '/bin/sh'
    return {
        name: 'shell_execute',
        description: `Execute a shell command on the Cynosure server host running ${operatingSystem} (${process.platform}), using ${shell}. Write commands for this operating system and shell. Use this for command-line operations such as inspecting files and directories, running scripts or programs, invoking installed CLI tools, managing processes, and performing system-level tasks. Commands run with the permissions and environment of the Cynosure server process and may modify the filesystem or system state. Commands that could destroy the system are refused: recursive deletion of the filesystem root, the home directory, system directories, the project or Cynosure's data; formatting or overwriting disks; and shutting down the host. Delete specific paths instead. Simple read-only commands (such as ls, cat, grep, find, git status/diff/log) run without asking the user; to inspect, run them on their own rather than chained with commands that change things.`,
        parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['command', 'explanation'],
            properties: {
                command: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 16000,
                    description: 'The shell command to execute.',
                },
                explanation: {
                    type: 'string',
                    minLength: 1,
                    maxLength: MAX_EXPLANATION_LENGTH,
                    description: 'A short, plain-language description of what the command does and what it changes, shown to the user when they approve it. Example: "Delete all .tmp files under build/ recursively".',
                },
                cwd: {
                    type: 'string',
                    description: defaultCwd
                        ? `Directory in which to execute the command. Defaults to the project directory ${defaultCwd}.`
                        : 'Directory in which to execute the command. Defaults to the current server working directory.',
                },
                timeoutSeconds: {
                    type: 'integer',
                    minimum: 1,
                    maximum: MAX_COMMAND_TIMEOUT_SECONDS,
                    description: 'Maximum execution time in seconds before the command is terminated. Defaults to 120 seconds.',
                },
            },
        },
        timeout: (MAX_COMMAND_TIMEOUT_SECONDS + 10) * 1000,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        execution: { readOnly: false },
        async execute(params: unknown, signal?: AbortSignal): Promise<ToolResult> {
            const input = params as { command?: unknown; explanation?: unknown; cwd?: unknown; timeoutSeconds?: unknown }
            if (typeof input.command !== 'string' || !input.command.trim() || input.command.length > 16000) {
                return { success: false, output: 'Enter a command of at most 16,000 characters.' }
            }
            if (typeof input.explanation !== 'string' || !input.explanation.trim() || input.explanation.length > MAX_EXPLANATION_LENGTH) {
                return { success: false, output: `explanation is required: describe in at most ${MAX_EXPLANATION_LENGTH} characters what the command does.` }
            }
            if (input.cwd !== undefined && (typeof input.cwd !== 'string' || !input.cwd.trim())) {
                return { success: false, output: 'Working directory must be a nonempty path.' }
            }
            if (input.timeoutSeconds !== undefined && (!Number.isInteger(input.timeoutSeconds) || Number(input.timeoutSeconds) < 1 || Number(input.timeoutSeconds) > MAX_COMMAND_TIMEOUT_SECONDS)) {
                return { success: false, output: 'timeoutSeconds must be an integer from 1 to 600.' }
            }
            const cwd = path.resolve(defaultCwd ?? process.cwd(), typeof input.cwd === 'string' ? input.cwd : '.')
            const timeoutMs = Number(input.timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS) * 1000
            const blocked = findBlockedShellCommand(input.command, {
                cwd,
                protectedPaths: [defaultCwd ?? '', process.cwd(), getDataDir()],
            })
            if (blocked) {
                return {
                    success: false,
                    output: `Blocked by the shell safety guard: ${blocked}. This command was not run. Do not try to work around the guard; if the user really intends it, ask them to run it themselves.`,
                }
            }
            try {
                signal?.throwIfAborted()
                return await runCommand(input.command, cwd, timeoutMs, shell, signal)
            } catch (error) {
                if (signal?.aborted) throw error
                return { success: false, output: `Error: ${(error as Error).message}` }
            }
        },
    }
}

function runCommand(command: string, cwd: string, timeoutMs: number, shell: string, signal?: AbortSignal): Promise<ToolResult> {
    return new Promise((resolve) => {
        const child = spawn(command, { shell, cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
        trackChild(child)
        const chunks: Buffer[] = []
        let bytes = 0
        let stopped: string | undefined
        const stop = (reason: string) => {
            if (stopped) return
            stopped = reason
            if (process.platform !== 'win32' && child.pid) {
                try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
            } else if (process.platform === 'win32' && child.pid) {
                spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }).once('error', () => child.kill('SIGKILL'))
            } else child.kill('SIGKILL')
        }
        const collect = (chunk: Buffer) => {
            const remaining = MAX_OUTPUT_BYTES - bytes
            if (bytes < MAX_OUTPUT_BYTES) {
                const kept = chunk.subarray(0, remaining)
                chunks.push(kept)
                bytes += kept.length
            }
            if (bytes >= MAX_OUTPUT_BYTES) stop('Output exceeded 8 MiB.')
        }
        child.stdout.on('data', collect)
        child.stderr.on('data', collect)
        const timer = setTimeout(() => stop(`Command timed out after ${Math.round(timeoutMs / 1000)} seconds.`), timeoutMs)
        const onAbort = () => stop('Command was cancelled.')
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted) onAbort()
        let settled = false
        const finish = (code: number | null, error?: Error) => {
            if (settled) return
            settled = true
            runningChildren.delete(child)
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
            const output = Buffer.concat(chunks).toString('utf8')
            resolve({ success: !stopped && !error && code === 0, output: [stopped || error?.message || `Exit code: ${code ?? 'unknown'}`, output].filter(Boolean).join('\n') })
        }
        child.once('error', error => finish(null, error))
        child.once('close', code => finish(code))
    })
}

function trackChild(child: ChildProcess): void {
    runningChildren.add(child)
    if (exitHookInstalled) return
    exitHookInstalled = true
    // Commands run in their own process group, so they outlive the server unless killed here.
    // Exit handlers must be synchronous; a hard kill of the server (SIGKILL) cannot be handled.
    process.once('exit', () => {
        for (const running of runningChildren) {
            if (!running.pid) continue
            try {
                if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(running.pid), '/t', '/f'], { stdio: 'ignore' })
                else process.kill(-running.pid, 'SIGKILL')
            } catch { /* Already exited. */ }
        }
    })
}
