/**
 * @deepseek-ai/* 类型存根。
 *
 * 运行时这些包由 esbuild 从 DSH profile 的 node_modules 解析并打进 bundle
 * （build.mjs nodePaths）。本仓库不携带它们，只需 tsc 能通过——这里声明最小
 * 形状，与已按 0.1.5-rc.1 核实过的运行时契约对齐。
 */

declare module '@deepseek-ai/dsh-tools' {
  export interface ToolDefinition {
    name: string
    description?: string
    parameters?: Record<string, unknown>
    output: {
      schema: Record<string, unknown>
      render: (args: unknown, value: unknown) => unknown[]
      presentationMeta?: (args: unknown, value: unknown) => unknown
    }
    execute: (args: unknown, exec: ToolRunContext) => Promise<unknown>
    presentCall?: (args: unknown) => { card: string; title: string; kind: string } | undefined
    presentResult?: (args: unknown, result: unknown) => unknown
    timeoutMs?: number
    isConcurrencySafe?: (args: unknown) => boolean
  }
  export interface ToolRunContext {
    agent?: { session?: { header?: { cwd?: string } } }
    signal?: AbortSignal
    deferContext?: (msg: unknown) => void
    concludeTurn?: () => void
  }
}

declare module '@deepseek-ai/dsh-llm' {
  export function createUserMessage(
    input: Record<string, unknown>,
  ): Record<string, unknown> & { id?: string; role?: string }
}
