import type { ToolDefinition, ToolResult } from '../gateway/providers/base.provider.js'

export class Sandbox {
  async execute(tool: ToolDefinition, params: unknown): Promise<ToolResult> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), tool.timeout || 30000)

    try {
      const result = await Promise.race([
        tool.execute(params),
        new Promise<ToolResult>((_, reject) => {
          controller.signal.addEventListener('abort', () =>
            reject(new Error(`Tool '${tool.name}' timed out after ${tool.timeout}ms`))
          )
        })
      ])
      return result
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : String(error)
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}

let sandboxInstance: Sandbox | null = null

export function getSandbox(): Sandbox {
  if (!sandboxInstance) {
    sandboxInstance = new Sandbox()
  }
  return sandboxInstance
}
