/**
 * dsh-memery — 自包含跨会话记忆插件（host 端）。
 *
 * 集成点（全部按运行时契约核实）：
 *  - ctx.tools.register：注册 memory_* 工具；
 *  - ctx.on('agent/pre-step', ...)：waterfall，把记忆快照/命中拼进
 *    decision.messages、插到真实用户消息前；
 *  - 工作区 = agent.session.header.cwd（会话自带，无需探测）；
 *  - webServer 注册设置页数据路由（延迟获取：ctx.inject(['webServer'])）；
 *  - settings 服务 installSection 注册设置命名空间（可选项，v2 简化）。
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { registerMemoryTools, type ToolEnvOptions } from './tools.js'
import { buildInjection, buildHitInjection } from './inject.js'
import { createSettingsRouteHandler } from './settings.js'
import { closeAllDbs, getDb } from './db.js'

export const name = 'dsh-memery'
export const inject = ['tools']

/**
 * 宿主 ctx 的最小运行时接口（cordis 类型包不在本仓库本地 node_modules，
 * 运行时契约已按 0.1.5-rc.1 逐项核实，见各集成点注释）。
 */
export interface HostCtx {
  tools: { register: (t: unknown) => unknown }
  logger?: { info?: (m: string) => void; warn?: (m: string) => void }
  inject?: (names: string[], cb: (scope: never) => void) => unknown
  on: (event: string, handler: unknown) => unknown
}

const DEFAULT_DIR = '.dsh-memery'

export interface ResolvedConfig {
  enabled: boolean
  dir: string
  hitTopK: number
  titleMax: number
}

/** pre-step 事件 payload 的最小形状（运行时契约：Scoped<Agent> 分发）。 */
interface PreStepPayload {
  agent: {
    session?: {
      header?: { id?: string; cwd?: string; origin?: string; parentSession?: unknown }
      events?: unknown[]
    }
  }
  messages: Array<{ source?: { kind?: string }; content?: Array<{ type?: string; text?: string }> }>
  signal: { aborted: boolean }
}

type PreStepDecision = { kind: 'enter'; messages: unknown[] } | { kind: 'reject' }

function workspaceOf(agent: PreStepPayload['agent']): string | null {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : null
}

function sessionIdOf(agent: PreStepPayload['agent']): string | null {
  const header = agent?.session?.header
  const id = typeof header?.id === 'string' && header.id.length > 0 ? header.id : null
  // 子 agent（origin='subagent'）归属父窗口
  if (header?.origin === 'subagent' && header.parentSession !== undefined) {
    const p: unknown = header.parentSession
    if (typeof p === 'string' && p.length > 0) return p
    if (p !== null && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string') {
      return (p as { id: string }).id
    }
  }
  return id
}

function textOf(msg: { content?: Array<{ type?: string; text?: string }> }): string {
  return (msg.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text ?? '')
    .join(' ')
}

function createSnapshotMessage(text: string, dir: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      // The kind must be the PRODUCER's own. The v3 `{kind:'plugin', plugin}`
      // wrapper was retired in session format v4: its admission check refuses a
      // bare `'plugin'` with "format v4 message requires a producer-owned source
      // kind" and fails the whole send. `plugin:<package>` is the same string
      // the v3→v4 migration derives for a released third-party wrapper, so a
      // migrated session and a freshly injected one carry identical attribution.
      kind: 'plugin:dsh-memery',
      form: 'snapshot',
      sections: [{ name: '长期记忆', text }],
    },
  })
}

/** 当前项目：取会话 cwd 的目录名作项目名（MySQL 项目 → "mysql"）。 */
function currentProjectOf(ws: string): string | null {
  const parts = ws.replace(/[/\\]+$/, '').split(/[/\\]/)
  return parts.length > 0 ? parts[parts.length - 1] : null
}

export async function apply(ctx: HostCtx, config: unknown): Promise<void> {
  const cfg: ResolvedConfig = {
    enabled: (config as { enabled?: boolean } | undefined)?.enabled ?? true,
    dir: (config as { dir?: string } | undefined)?.dir ?? DEFAULT_DIR,
    hitTopK: (config as { hitTopK?: number } | undefined)?.hitTopK ?? 2,
    titleMax: (config as { titleMax?: number } | undefined)?.titleMax ?? 40,
  }
  if (!cfg.enabled) return

  const toolOpts: ToolEnvOptions = {
    dir: cfg.dir,
    currentProject: (ws) => currentProjectOf(ws),
  }

  // 1) 工具
  registerMemoryTools((t) => ctx.tools.register(t), toolOpts)

  // 2) 设置页数据路由 + 工作区清单（延迟获取：webServer / workspaceRegistry 稍后才注册）
  //
  // 清单必须「读时」现查，不能在这里快照：ctx.inject 的回调只在依赖就绪时
  // 执行一次，若把 registry.list() 的结果存成数组，插件激活之后新增的工作区
  // 就永远进不了设置页（症状：GUI 里新加的工作区在下拉里不显示，重启才出现）。
  // 所以只存「怎么读」，每次请求再调一次 —— DSH 自身的 WorkspaceFeed.baseline()
  // 也是读时调 registry.list()。
  let readWorkspaces: (() => string[]) | null = null
  try {
    ctx.inject(['workspaceRegistry'], (scope: never) => {
      const scoped = scope as { get: (n: string) => unknown }
      readWorkspaces = () => {
        try {
          const reg = scoped.get('workspaceRegistry') as { list?: () => ReadonlyArray<{ path?: string }> } | undefined
          const list = typeof reg?.list === 'function' ? reg.list() : []
          return list.map((w) => (typeof w.path === 'string' ? w.path : '')).filter((p) => p !== '')
        } catch {
          return [] // workspaceRegistry 不可用不是错误：设置页仍可读单工作区
        }
      }
      // cordis：回调的返回值即该 fiber 的清理函数；服务卸载后不再读旧 registry。
      return () => {
        readWorkspaces = null
      }
    })
  } catch {
    /* workspaceRegistry 不可用不是错误：设置页仍可读单工作区 */
  }

  try {
    ctx.inject(['webServer'], (scope: never) => {
      createSettingsRouteHandler(scope as never, {
        dir: cfg.dir,
        defaultWorkspace: () => null,
        listWorkspaces: () => readWorkspaces?.() ?? [],
      })
      return undefined
    })
  } catch (e) {
    ctx.logger?.warn?.(`dsh-memery: 设置路由注册失败（不影响记忆本体）：${e instanceof Error ? e.message : String(e)}`)
  }

  // 3) pre-step 注入
  const firstHandled = new Set<string>()
  ctx.on(
    'agent/pre-step',
    async ({ agent, messages, signal }: PreStepPayload, next: () => Promise<PreStepDecision>) => {
      const decision = await next()
      try {
        if (decision === undefined || decision.kind !== 'enter' || signal.aborted) return decision
        if (!Array.isArray(decision.messages) || decision.messages.length === 0) return decision
        // 子代理不注入（dsh 权威标记）
        if (agent?.session?.header?.origin === 'subagent') return decision

        const ws = workspaceOf(agent)
        const sid = sessionIdOf(agent)
        if (ws === null || sid === null) return decision

        const userMsgs = decision.messages.filter((m) => (m as { source?: { kind?: string } }).source?.kind === 'user')
        if (userMsgs.length === 0) return decision

        const project = currentProjectOf(ws)

        // 会话首条真实用户消息：只注入长期快照（首轮不跑命中）。
        // 恢复的会话（已有历史）不算首轮：只走命中链路（快照由上个进程注入过）。
        let firstUserHandled = false
        if (!firstHandled.has(sid)) {
          firstHandled.add(sid)
          let priorUser = 0
          for (const e of agent?.session?.events ?? []) {
            const evt = e as { type?: string; data?: { source?: { kind?: string } } }
            if (evt?.type === 'user/message' && evt.data?.source?.kind === 'user') priorUser++
          }
          if (priorUser === 0) {
            firstUserHandled = true
            const injected = buildInjection(ws, cfg.dir, sid, { hitTopK: cfg.hitTopK, titleMax: cfg.titleMax }, project)
            if (injected !== null) {
              const firstUser = userMsgs[0]
              const rewritten = [...decision.messages] as unknown[]
              const idx = decision.messages.indexOf(firstUser)
              rewritten.splice(idx, 0, createSnapshotMessage(injected.text, cfg.dir))
              ctx.logger?.info?.(`dsh-memery: 已注入长期记忆快照（${injected.text.length} 字符）到会话首条消息前`)
              return { ...decision, messages: rewritten } as PreStepDecision
            }
          }
          // 恢复会话（priorUser>0）首轮不做快照，但仍要进入命中链路 —— 不能 return。
          // 快照已见记账由上个进程写入；这里只做命中。
        }

        // 命中链路（首轮除外）：关键词 top-K。
        if (firstUserHandled) return decision
        const lastUser = [...decision.messages]
          .reverse()
          .find((m) => (m as { source?: { kind?: string } }).source?.kind === 'user')
        if (lastUser !== undefined) {
          const text = textOf(lastUser as never)
          const hit = buildHitInjection(
            ws,
            cfg.dir,
            sid,
            text,
            { hitTopK: cfg.hitTopK, titleMax: cfg.titleMax },
            project,
          )
          if (hit !== null) {
            const rewritten = [...decision.messages] as unknown[]
            const idx = decision.messages.indexOf(lastUser)
            rewritten.splice(idx, 0, createSnapshotMessage(hit.text, cfg.dir))
            return { ...decision, messages: rewritten } as PreStepDecision
          }
        }
        return decision
      } catch (e) {
        // fail-open：注入失败放行原始消息，不阻塞用户对话。
        try {
          ctx.logger?.warn?.(
            `dsh-memery: pre-step 注入失败（放行原消息）：${e instanceof Error ? e.message : String(e)}`,
          )
        } catch {
          /* 日志失败不阻塞 */
        }
        return decision
      }
    },
  )

  // 4) 清理
  ctx.on('dispose', () => {
    closeAllDbs()
  })
}
