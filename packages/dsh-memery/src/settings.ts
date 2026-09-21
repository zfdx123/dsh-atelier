/**
 * dsh-memery — 设置页数据面（宿主路由 + settings 命名空间）。
 *
 * client 只在设置页展示/管理记忆，数据走 webServer exact 路由：
 *   GET    /dsh-memery/workspaces    — 工作区清单（含全局库计数）
 *   GET    /dsh-memery/memories      — 列表（level/status/q/project 过滤；合并工作区库+全局库）
 *   POST   /dsh-memery/memory-add    — 新建（project=「全局」→ 全局库，否则当前工作区库）
 *   POST   /dsh-memery/memory-update — 更新（按 id 定位所在库；project 跨 scope 变更自动搬库）
 *   POST   /dsh-memery/memory-delete — 删除
 *
 * 工作区范围：?workspace= 查询参数（client 从 useWorkspaces 取），缺省用
 * sessionPersistence 第一条兜底；都拿不到则返回全局库记忆而不是猜测。
 */

import {
  getDb,
  getGlobalDb,
  listMemories,
  insertMemory,
  updateMemory,
  deleteMemory,
  allRowsMerged,
  locateRow,
  isGlobalProjectField,
  ensureRowInRightLibrary,
  coversProject,
  relativeTime,
  LEVELS,
  Level,
  PROJECT_SUBCATEGORIES,
  type ScopedRow,
  type MemoryScope,
} from './db.js'
import { search } from './bm25.js'

const DIR = '.dsh-memery'

export interface RouteHandlerOptions {
  dir?: string
  /** 获取一个默认工作区（面板打开时没有 workspace 参数时用）。 */
  defaultWorkspace: () => string | null
  /** 列出所有可作为记忆仓的工作区（扫描记忆库用；返回 null/空 = 无法枚举）。 */
  listWorkspaces?: () => string[]
}

/** 内存缓存：workspace → 记忆数（路由轻量用，不重复全表COUNT）。 */
const countsCache = new Map<string, { at: number; count: number }>()
const COUNTS_TTL = 5000

function memoryCountOf(workspace: string, dir: string): number {
  const cached = countsCache.get(workspace)
  if (cached !== undefined && Date.now() - cached.at < COUNTS_TTL) return cached.count
  try {
    const rows = listMemories(getDb(workspace, dir))
    countsCache.set(workspace, { at: Date.now(), count: rows.length })
    return rows.length
  } catch {
    return 0 // 路径不是 Git 工作区 / 库打不开：算 0
  }
}

function memoryCountOfGlobal(): number {
  try {
    return listMemories(getGlobalDb()).length
  } catch {
    return 0
  }
}

function memoryView(r: ScopedRow): Record<string, unknown> {
  return {
    id: r.id,
    level: r.level,
    title: r.title,
    content: r.content,
    importance: r.importance,
    keywords: r.keywords,
    status: r.status,
    project: r.project,
    subcategory: r.subcategory,
    goal: r.goal,
    corrected: r.corrected,
    scope: r.scope,
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
    updated_rel: relativeTime(r.updated_at),
  }
}

function writeJson(
  res: { writeHead: (s: number, h: Record<string, string>) => void; end: (b: string) => void },
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readBody(req: {
  on: (ev: 'data' | 'end' | 'error', cb: (...args: never[]) => void) => unknown
}): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk
    })
    req.on('end', () => resolve(data))
    req.on('error', () => resolve(''))
  })
}

function clampImportance(n: unknown): number {
  return Math.max(1, Math.min(4, Math.floor(Number(n) || 1)))
}

function validLevel(s: unknown): Level {
  return (LEVELS as readonly string[]).includes(String(s)) ? (String(s) as Level) : 'fact'
}

function validStatus(s: unknown): string | null {
  return ['active', 'archived', 'stale'].includes(String(s)) ? String(s) : null
}

function validSubcategory(s: unknown): string | null {
  return (PROJECT_SUBCATEGORIES as readonly string[]).includes(String(s)) ? String(s) : null
}

export function createSettingsRouteHandler(
  ctx: {
    effect: (fn: () => unknown) => unknown
    get?: (name: string) => unknown
    logger?: { info?: (m: string) => void; warn?: (m: string) => void }
  },
  opts: RouteHandlerOptions,
): void {
  const dir = opts.dir ?? DIR
  const webServer = ctx.get?.('webServer') as
    | {
        register: (route: { kind: 'exact'; path: string; handler: (req: unknown, res: unknown) => void }) => () => void
      }
    | undefined
  if (webServer === undefined || typeof webServer.register !== 'function') {
    ctx.logger?.warn?.('dsh-memery: webServer 不可用，设置页数据接口未注册（插件本体不受影响）')
    return
  }

  const resolveWorkspace = (url: URL): string | null => {
    const ws = url.searchParams.get('workspace')
    if (ws !== null && ws.trim() !== '') return ws.trim()
    return opts.defaultWorkspace()
  }

  const registerOne = (path: string, handler: (req: any, res: any) => void): void => {
    try {
      ctx.effect(() => webServer.register({ kind: 'exact', path, handler }))
    } catch (e) {
      ctx.logger?.warn?.(`dsh-memery: 路由 ${path} 注册失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  registerOne('/dsh-memery/workspaces', (req, res) => {
    void (async () => {
      try {
        const list = opts.listWorkspaces?.() ?? []
        const defaultWs = opts.defaultWorkspace()
        const items = list
          .map((ws) => ({
            workspace: ws,
            count: memoryCountOf(ws, dir),
            current: ws === defaultWs,
          }))
          .sort((a, b) => b.count - a.count)
        writeJson(res, 200, { ok: true, workspaces: items, global_count: memoryCountOfGlobal() })
      } catch (e) {
        writeJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    })()
  })

  registerOne('/dsh-memery/memories', (req, res) => {
    void (async () => {
      try {
        const url = new URL((req as { url?: string }).url ?? '/', 'http://localhost')
        const ws = resolveWorkspace(url)
        const scopeParam = url.searchParams.get('scope')
        // scope=global → 只看全局库；带 workspace → 只看该工作区库（不混入全局条目）；
        // 两者都没有 → 兜底回全局库（拿不到工作区时至少能看全局记忆）。
        const rows: ScopedRow[] =
          scopeParam === 'global'
            ? listMemories(getGlobalDb()).map((r) => ({ ...r, scope: 'global' as const }))
            : ws !== null
              ? allRowsMerged(ws, dir).filter((r) => r.scope === 'workspace')
              : listMemories(getGlobalDb()).map((r) => ({ ...r, scope: 'global' as const }))
        const q = url.searchParams.get('q') ?? ''
        const level = url.searchParams.get('level') as Level | null
        const status = url.searchParams.get('status') ?? 'all'
        const project = url.searchParams.get('project') ?? null
        let filtered = rows
        if (level !== null && LEVELS.includes(level)) filtered = filtered.filter((r) => r.level === level)
        if (status !== 'all') filtered = filtered.filter((r) => r.status === status)
        if (project !== null && project !== '') filtered = filtered.filter((r) => coversProject(r, project))
        if (q.trim() !== '') {
          const hits = search(filtered, q, { topK: 200 })
          filtered = hits.map((h) => h.row)
        }
        filtered.sort((a, b) => b.updated_at - a.updated_at)
        writeJson(res, 200, {
          ok: true,
          workspace: scopeParam === 'global' ? null : ws,
          memories: filtered.map(memoryView),
        })
      } catch (e) {
        writeJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    })()
  })

  registerOne('/dsh-memery/projects', (req, res) => {
    void (async () => {
      try {
        const url = new URL((req as { url?: string }).url ?? '/', 'http://localhost')
        const ws = url.searchParams.get('workspace')?.trim() || opts.defaultWorkspace()
        // 该工作区库出现过的项目名（管理面添加表单的下拉数据源）
        const seen = new Set<string>()
        if (ws !== null && ws !== '') {
          for (const r of allRowsMerged(ws, dir).filter((x) => x.scope === 'workspace')) {
            if (r.project === null || r.project === '') continue
            for (const p of r.project.split(',')) {
              const t = p.trim()
              if (t !== '') seen.add(t)
            }
          }
        }
        writeJson(res, 200, { ok: true, projects: [...seen].sort() })
      } catch (e) {
        writeJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    })()
  })

  registerOne('/dsh-memery/memory-add', (req, res) => {
    void (async () => {
      try {
        if ((req as { method?: string }).method !== 'POST')
          return writeJson(res, 405, { ok: false, error: 'method not allowed' })
        const url = new URL((req as { url?: string }).url ?? '/', 'http://localhost')
        const ws = resolveWorkspace(url)
        const body = JSON.parse(await readBody(req as never)) as Record<string, unknown>
        const content = typeof body.content === 'string' ? body.content.trim() : ''
        const project = typeof body.project === 'string' ? body.project.trim() : ''
        if (content === '') return writeJson(res, 400, { ok: false, error: 'content 必填' })
        if (project === '') return writeJson(res, 400, { ok: false, error: 'project 必填（项目名或「全局」）' })
        if (!isGlobalProjectField(project) && ws === null) {
          return writeJson(res, 400, { ok: false, error: 'workspace required（工作区记忆需要知道目标工作区）' })
        }
        const db = isGlobalProjectField(project) ? getGlobalDb() : getDb(ws as string, dir)
        const row = insertMemory(db, {
          level: validLevel(body.level),
          title: typeof body.title === 'string' && body.title.trim() !== '' ? body.title.trim() : null,
          content,
          importance: clampImportance(body.importance),
          keywords: Array.isArray(body.keywords) ? body.keywords.map(String).filter(Boolean) : [],
          status: (validStatus(body.status) ?? 'active') as 'active' | 'archived' | 'stale',
          project,
          subcategory: (validSubcategory(body.subcategory) as never) ?? null,
          goal: typeof body.goal === 'string' && body.goal.trim() !== '' ? body.goal.trim() : null,
          corrected: body.corrected === true,
        })
        const scope: MemoryScope = isGlobalProjectField(project) ? 'global' : 'workspace'
        writeJson(res, 200, { ok: true, memory: memoryView({ ...row, scope }) })
      } catch (e) {
        writeJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    })()
  })

  registerOne('/dsh-memery/memory-update', (req, res) => {
    void (async () => {
      try {
        if ((req as { method?: string }).method !== 'POST')
          return writeJson(res, 405, { ok: false, error: 'method not allowed' })
        const url = new URL((req as { url?: string }).url ?? '/', 'http://localhost')
        const ws = resolveWorkspace(url)
        const body = JSON.parse(await readBody(req as never)) as Record<string, unknown>
        const id = typeof body.id === 'string' ? body.id : ''
        if (id === '') return writeJson(res, 400, { ok: false, error: 'id required' })
        // 定位物理所在库（工作区优先，其次全局）
        const target = locateRow(ws, dir, id)
        if (target === null) return writeJson(res, 404, { ok: false, error: 'memory not found' })
        const db = target.scope === 'global' ? getGlobalDb() : getDb(ws as string, dir)
        const patch: Record<string, unknown> = {}
        if (body.status !== undefined) {
          const s = validStatus(body.status)
          if (s !== null) patch.status = s
        }
        if (body.content !== undefined) patch.content = String(body.content)
        if (body.title !== undefined) patch.title = String(body.title)
        if (body.importance !== undefined) patch.importance = clampImportance(body.importance)
        if (Array.isArray(body.keywords)) patch.keywords = body.keywords.map(String).filter(Boolean)
        if (body.subcategory !== undefined) patch.subcategory = validSubcategory(body.subcategory)
        if (body.goal !== undefined) patch.goal = String(body.goal)
        let updated = updateMemory(db, id, patch as never)
        if (updated === null) return writeJson(res, 404, { ok: false, error: 'memory not found' })
        let scope: MemoryScope = target.scope
        if (body.project !== undefined && String(body.project).trim() !== '') {
          const project = String(body.project).trim()
          updated = ensureRowInRightLibrary({ ...updated, project }, target.scope, ws as string, dir)
          scope = isGlobalProjectField(project) ? 'global' : 'workspace'
        }
        writeJson(res, 200, { ok: true, memory: memoryView({ ...updated, scope }) })
      } catch (e) {
        writeJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    })()
  })

  registerOne('/dsh-memery/memory-delete', (req, res) => {
    void (async () => {
      try {
        if ((req as { method?: string }).method !== 'POST')
          return writeJson(res, 405, { ok: false, error: 'method not allowed' })
        const url = new URL((req as { url?: string }).url ?? '/', 'http://localhost')
        const ws = resolveWorkspace(url)
        const body = JSON.parse(await readBody(req as never)) as { id?: string }
        if (typeof body.id !== 'string' || body.id === '')
          return writeJson(res, 400, { ok: false, error: 'id required' })
        const target = locateRow(ws, dir, body.id)
        if (target === null) return writeJson(res, 404, { ok: false, error: 'memory not found' })
        const db = target.scope === 'global' ? getGlobalDb() : getDb(ws as string, dir)
        const deleted = deleteMemory(db, body.id)
        if (!deleted) return writeJson(res, 404, { ok: false, error: 'memory not found' })
        writeJson(res, 200, { ok: true, deleted: body.id })
      } catch (e) {
        writeJson(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    })()
  })
}
