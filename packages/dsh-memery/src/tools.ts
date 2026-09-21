/**
 * dsh-memery — 工具面：memory_remember / memory_search / memory_read /
 * memory_update / memory_project / memory_delete。
 *
 * 「记忆可管理」的管理闭环：写入（remember）、检索（search）、读（read）、
 * 改/归档（update）、项目全景（project）、删除（delete）。
 *
 * 工作区 = exec.agent.session.header.cwd（会话自带，无需探测）。
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  getDb,
  getGlobalDb,
  insertMemory,
  updateMemory,
  deleteMemory,
  coversProject,
  relativeTime,
  LEVELS,
  Level,
  PROJECT_SUBCATEGORIES,
  ProjectSubcategory,
  isGlobalProjectField,
  allRowsMerged,
  locateRow,
  ensureRowInRightLibrary,
  type ScopedRow,
  type MemoryScope,
} from './db.js'
import { search, extractKeywords } from './bm25.js'
import { ensureKeywords } from './inject.js'

export interface ToolEnvOptions {
  dir?: string
  currentProject?: (workspace: string) => string | null
}

/** 从工具执行上下文取工作区（会话 cwd）；为空则不可用。 */
export function workspaceOf(exec: { agent?: { session?: { header?: { cwd?: string } } } }): string | null {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : null
}

type ExecLike = { agent?: { session?: { header?: { cwd?: string } } } }

function memoryJson(r: ScopedRow): Record<string, unknown> {
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
    updated_at: new Date(r.updated_at).toISOString(),
    updated_rel: relativeTime(r.updated_at),
  }
}

function renderText(value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** remember 写规则（进 description 呈现给模型）。 */
const WRITE_RULES = [
  'fact/lesson 一句话直陈，短（≤80 字）——短是关键词命中注入的前提',
  '用户介绍设计思路/框架/决策理由的原话保留措辞，不转述（project/lesson）',
  'project 必填项目名；同时适用多项目用英文逗号分隔；全局适用写「全局」',
  'importance 1-4（4=最重要的长期约束），默认 1',
  'keywords 必填 5-12 个（命中靠它），LLM 提取；不填则自动 bigram 提取',
].join('\n')

export function rememberTool(opts: ToolEnvOptions = {}): ToolDefinition {
  return {
    name: 'memory_remember',
    description: `写入一条记忆。规则：\n${WRITE_RULES}`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['content', 'project', 'keywords'],
      properties: {
        content: {
          type: 'string',
          description: '记忆正文。短条目（fact/lesson）一句话直陈；project 可写较长的结构/决策说明',
        },
        level: { type: 'string', enum: [...LEVELS], default: 'fact', description: '记忆层级' },
        title: { type: 'string', description: '可选标题（topic/project 建议给）' },
        project: { type: 'string', description: '项目名（逗号分隔多值；全局写「全局」）' },
        subcategory: { type: 'string', enum: [...PROJECT_SUBCATEGORIES], description: 'project 层专属子类' },
        goal: { type: 'string', description: 'topic 层目标句' },
        importance: { type: 'integer', default: 1, description: '1-4' },
        corrected: { type: 'boolean', default: false, description: '是否为纠正/教训（lesson 层）' },
        keywords: { type: 'array', items: { type: 'string' }, description: '检索关键词 5-12 个' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'id', 'level', 'project'],
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          level: { type: 'string' },
          project: { type: 'string' },
          scope: { type: 'string' },
          keywords: { type: 'array', items: { type: 'string' } },
          duplicates: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
        },
      },
      render(_args, value) {
        return renderText(value)
      },
    },
    presentCall(args: unknown) {
      const a = args as { content?: string; level?: string }
      return { card: 'generic', title: `memory_remember: ${String(a.content ?? '').slice(0, 24)}`, kind: 'write' }
    },
    async execute(args: unknown, exec: ExecLike & { signal?: AbortSignal }) {
      const a = args as {
        content?: string
        level?: string
        title?: string
        project?: string
        subcategory?: string
        goal?: string
        importance?: number
        corrected?: boolean
        keywords?: unknown
      }
      const ws = workspaceOf(exec)
      if (ws === null) return { ok: false, error: '无法确定工作区（无会话 cwd）' }
      if (typeof a.content !== 'string' || a.content.trim() === '') {
        return { ok: false, error: 'content 必填（写什么）' }
      }
      if (typeof a.project !== 'string' || a.project.trim() === '') {
        return { ok: false, error: 'project 必填（项目名或「全局」）' }
      }
      const level = (a.level ?? 'fact') as Level
      const keywords = Array.isArray(a.keywords) ? a.keywords.map((k) => String(k)).filter((k) => k.length > 0) : []
      const project = a.project.trim()
      // 全局记忆写全局库（跨工作区共享）；其它写当前工作区库（方案 B）。
      const db = isGlobalProjectField(project) ? getGlobalDb() : getDb(ws, opts.dir ?? '.dsh-memery')
      const row = insertMemory(db, {
        level,
        title: a.title ?? null,
        content: a.content.trim(),
        importance: Math.max(1, Math.min(4, Math.floor(Number(a.importance) || 1))),
        keywords: ensureKeywords({ keywords, content: a.content }),
        status: 'active',
        project,
        subcategory: (a.subcategory as ProjectSubcategory | undefined) ?? null,
        goal: a.goal ?? null,
        corrected: a.corrected === true,
      })
      return {
        ok: true,
        id: row.id,
        level: row.level,
        project: row.project,
        scope: isGlobalProjectField(project) ? 'global' : 'workspace',
        keywords: row.keywords,
        duplicates: [],
      }
    },
  }
}

export function searchTool(opts: ToolEnvOptions = {}): ToolDefinition {
  return {
    name: 'memory_search',
    description:
      '检索记忆。默认在当前项目 + 全局范围内命中 fact/lesson/rules/topic；带 project 参数可限定具体项目；status="all" 包含已归档。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: '关键词/短语（中文按相邻两字自动分词）' },
        limit: { type: 'integer', default: 10, description: '返回条数上限' },
        level: { type: 'string', enum: [...LEVELS], description: '限定层级' },
        status: { type: 'string', enum: ['active', 'archived', 'stale', 'all'], default: 'active' },
        project: { type: 'string', description: '限定项目名；省略=当前项目+全局' },
        days: { type: 'integer', description: '只返回最近 N 天更新的' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'results'],
        properties: {
          ok: { type: 'boolean' },
          results: { type: 'array', items: { type: 'object', additionalProperties: true } },
          error: { type: 'string' },
        },
      },
      render(_args, value) {
        return renderText(value)
      },
    },
    presentCall(args: unknown) {
      const a = args as { query?: string }
      return { card: 'generic', title: `memory_search: ${String(a.query ?? '').slice(0, 24)}`, kind: 'read' }
    },
    async execute(args: unknown, exec: ExecLike) {
      const a = args as {
        query?: string
        limit?: number
        level?: string
        status?: string
        project?: string
        days?: number
      }
      const ws = workspaceOf(exec)
      if (ws === null) return { ok: false, error: '无法确定工作区', results: [] }
      // 读取合并工作区库 + 全局库（方案 B：跨工作区共享的全局记忆随搜随到）
      const rows = allRowsMerged(ws, opts.dir ?? '.dsh-memery')
      const currentProject = opts.currentProject ? opts.currentProject(ws) : null
      const requested = a.project !== undefined && String(a.project).trim() !== '' ? String(a.project).trim() : null
      const query = String(a.query ?? '')
      const statuses = a.status === 'all' ? undefined : [a.status ?? 'active']
      const filtered = rows
        .filter((r) => (requested === null ? coversProject(r, currentProject) : coversProject(r, requested)))
        .filter((r) => (statuses ? statuses.includes(r.status) : true))
        .filter((r) => (a.level ? r.level === a.level : true))
        .filter((r) => (a.days ? Date.now() - r.updated_at <= a.days * 86_400_000 : true))

      // 用关键词 field 精确命中优先，再按 BM25 全文排序
      const kwExact =
        query.trim() === ''
          ? []
          : filtered.filter((r) => r.keywords.some((k) => k.toLowerCase().includes(query.toLowerCase())))
      const bm25 =
        query.trim() === ''
          ? (filtered.map((r) => ({ row: r, score: 1 })) as { score: number; row: ScopedRow }[])
          : search(filtered, query, { topK: 100 })
      // 合并且去重：关键词精确命中排前
      const ordered: ScopedRow[] = []
      for (const r of kwExact) if (!ordered.includes(r)) ordered.push(r)
      for (const h of bm25) if (!ordered.includes(h.row)) ordered.push(h.row)
      const limit = Math.max(1, Math.min(50, Math.floor(Number(a.limit) || 10)))
      return {
        ok: true,
        results: ordered.slice(0, limit).map((r) => memoryJson(r)),
      }
    },
  }
}

export function readTool(opts: ToolEnvOptions = {}): ToolDefinition {
  return {
    name: 'memory_read',
    description: '读取一条记忆全文（search 返回的是元数据视图，不含全文）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: { type: 'string', description: '记忆 id（search/remember 返回的 id）' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          memory: { type: 'object', additionalProperties: true },
          error: { type: 'string' },
        },
      },
      render(_args, value) {
        return renderText(value)
      },
    },
    presentCall(args: unknown) {
      const a = args as { id?: string }
      return { card: 'generic', title: `memory_read: ${String(a.id ?? '').slice(0, 16)}`, kind: 'read' }
    },
    async execute(args: unknown, exec: ExecLike) {
      const a = args as { id?: string }
      const ws = workspaceOf(exec)
      if (ws === null) return { ok: false, error: '无法确定工作区' }
      if (typeof a.id !== 'string' || a.id === '') return { ok: false, error: 'id 必填' }
      const row = locateRow(ws, opts.dir ?? '.dsh-memery', a.id)
      if (row === null) return { ok: false, error: `未找到记忆 ${a.id}` }
      return { ok: true, memory: memoryJson(row) }
    },
  }
}

export function updateTool(opts: ToolEnvOptions = {}): ToolDefinition {
  return {
    name: 'memory_update',
    description:
      '更新一条记忆（内容/重要性/关键词/状态：active|archived|stale/project 等项目归属）。归档=软删除（从命中里隐藏，不删库）。project 改为「全局」时自动把条目标记为全局（跨工作区共享）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: '记忆 id' },
        content: { type: 'string' },
        importance: { type: 'integer' },
        status: { type: 'string', enum: ['active', 'archived', 'stale'] },
        keywords: { type: 'array', items: { type: 'string' } },
        title: { type: 'string' },
        project: { type: 'string', description: '项目名（逗号分隔多值；「全局」= 跨工作区共享）' },
        subcategory: { type: 'string', enum: [...PROJECT_SUBCATEGORIES], description: 'project 层专属子类' },
        goal: { type: 'string', description: 'topic 层目标句' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          memory: { type: 'object', additionalProperties: true },
          error: { type: 'string' },
        },
      },
      render(_args, value) {
        return renderText(value)
      },
    },
    presentCall(args: unknown) {
      const a = args as { id?: string; status?: string }
      return {
        card: 'generic',
        title: `memory_update: ${a.status ?? 'patch'} ${String(a.id ?? '').slice(0, 12)}`,
        kind: 'write',
      }
    },
    async execute(args: unknown, exec: ExecLike) {
      const a = args as {
        id?: string
        content?: string
        importance?: number
        status?: string
        keywords?: unknown
        title?: string
        project?: string
        subcategory?: string
        goal?: string
      }
      const ws = workspaceOf(exec)
      if (ws === null) return { ok: false, error: '无法确定工作区' }
      if (typeof a.id !== 'string' || a.id === '') return { ok: false, error: 'id 必填' }
      const dir = opts.dir ?? '.dsh-memery'
      // 定位物理所在库（工作区优先，其次全局）
      const target = locateRow(ws, dir, a.id)
      if (target === null) return { ok: false, error: `未找到记忆 ${a.id}` }
      const db = target.scope === 'global' ? getGlobalDb() : getDb(ws, dir)
      const patch: Record<string, unknown> = {}
      if (a.content !== undefined) patch.content = a.content
      if (a.title !== undefined) patch.title = a.title
      if (a.importance !== undefined) patch.importance = Math.max(1, Math.min(4, Math.floor(Number(a.importance))))
      if (a.status !== undefined && ['active', 'archived', 'stale'].includes(a.status)) patch.status = a.status
      if (Array.isArray(a.keywords)) patch.keywords = a.keywords.map((k) => String(k)).filter(Boolean)
      if (a.subcategory !== undefined) {
        patch.subcategory = (PROJECT_SUBCATEGORIES as readonly string[]).includes(a.subcategory) ? a.subcategory : null
      }
      if (a.goal !== undefined) patch.goal = a.goal
      let updated = updateMemory(db, a.id, patch as never)
      if (updated === null) return { ok: false, error: `未找到记忆 ${a.id}` }
      // project 变更时保持物理库与语义一致（「全局」→ 全局库，反之搬回工作区库）
      let scope: MemoryScope = target.scope
      if (a.project !== undefined && String(a.project).trim() !== '') {
        const project = String(a.project).trim()
        updated = ensureRowInRightLibrary({ ...updated, project }, target.scope, ws, dir)
        scope = isGlobalProjectField(project) ? 'global' : 'workspace'
      }
      return { ok: true, memory: memoryJson({ ...updated, scope }) }
    },
  }
}

export function deleteTool(opts: ToolEnvOptions = {}): ToolDefinition {
  return {
    name: 'memory_delete',
    description: '永久删除一条记忆（不可恢复）。管理界面之外的硬删除入口；仅当你确定该记忆已无效时使用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: { type: 'string', description: '记忆 id' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          deleted: { type: 'boolean' },
          id: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render(_args, value) {
        return renderText(value)
      },
    },
    presentCall(args: unknown) {
      const a = args as { id?: string }
      return { card: 'generic', title: `memory_delete: ${String(a.id ?? '').slice(0, 16)}`, kind: 'write' }
    },
    async execute(args: unknown, exec: ExecLike) {
      const a = args as { id?: string }
      const ws = workspaceOf(exec)
      if (ws === null) return { ok: false, error: '无法确定工作区' }
      if (typeof a.id !== 'string' || a.id === '') return { ok: false, error: 'id 必填' }
      const dir = opts.dir ?? '.dsh-memery'
      const target = locateRow(ws, dir, a.id)
      if (target === null) return { ok: false, error: `未找到记忆 ${a.id}` }
      const db = target.scope === 'global' ? getGlobalDb() : getDb(ws, dir)
      const deleted = deleteMemory(db, a.id)
      if (!deleted) return { ok: false, error: `未找到记忆 ${a.id}` }
      return { ok: true, deleted: true, id: a.id }
    },
  }
}

export function projectTool(opts: ToolEnvOptions = {}): ToolDefinition {
  return {
    name: 'memory_project',
    description: '查看某项目的记忆全景（project 层全量 + 归属该项目的 fact/lesson/rules/topic），按子标签分组。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['project'],
      properties: {
        project: { type: 'string', description: '项目名（与写作时一致）；「全局」查看全局记忆' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          project: { type: 'string' },
          count: { type: 'number' },
          error: { type: 'string' },
          sections: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render(_args, value) {
        return renderText(value)
      },
    },
    presentCall(args: unknown) {
      const a = args as { project?: string }
      return { card: 'generic', title: `memory_project: ${String(a.project ?? '').slice(0, 24)}`, kind: 'read' }
    },
    async execute(args: unknown, exec: ExecLike) {
      const a = args as { project?: string }
      const ws = workspaceOf(exec)
      if (ws === null) return { ok: false, error: '无法确定工作区' }
      if (typeof a.project !== 'string' || a.project.trim() === '')
        return { ok: false, error: 'project 参数必填（要查看哪个项目？）' }
      const name = a.project.trim()
      const dir = opts.dir ?? '.dsh-memery'
      const rows = allRowsMerged(ws, dir)
        .filter((r) => coversProject(r, name))
        .filter((r) => r.status === 'active')

      // 按层级/子类分组
      const projects = rows.filter((r) => r.level === 'project')
      const facts = rows.filter((r) => r.level === 'fact')
      const lessons = rows.filter((r) => r.level === 'lesson')
      const rules = rows.filter((r) => r.level === 'rules')
      const topics = rows.filter((r) => r.level === 'topic')

      const sections: Array<{ title: string; items: Record<string, unknown>[] }> = []
      if (projects.length > 0) {
        for (const sc of PROJECT_SUBCATEGORIES) {
          const group = projects.filter((r) => r.subcategory === sc)
          if (group.length === 0) continue
          sections.push({
            title: sc,
            items: group.map((r) => ({ ...memoryJson(r), summary: r.content.slice(0, 200) })),
          })
        }
      }
      if (facts.length > 0) sections.push({ title: '事实', items: facts.map((r) => memoryJson(r)) })
      if (lessons.length > 0) sections.push({ title: '教训', items: lessons.map((r) => memoryJson(r)) })
      if (rules.length > 0) sections.push({ title: '准则', items: rules.map((r) => memoryJson(r)) })
      if (topics.length > 0) sections.push({ title: '话题', items: topics.map((r) => memoryJson(r)) })

      return { ok: true, project: name, count: rows.length, sections }
    },
  }
}

export function registerMemoryTools(register: (t: ToolDefinition) => void, opts: ToolEnvOptions = {}): void {
  register(rememberTool(opts))
  register(searchTool(opts))
  register(readTool(opts))
  register(updateTool(opts))
  register(deleteTool(opts))
  register(projectTool(opts))
}
