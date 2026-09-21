/**
 * dsh-memery — 记忆注入。
 *
 * 两档注入，挂在 agent/pre-step 上（见 index.ts）：
 *  - 首轮（会话首条真实用户消息）：注入长期记忆快照 —— fact/lesson/rules 全量
 *    （短条目可一次给全）+ topic/project 标题导引。首轮不跑命中。
 *  - 每轮（第 2 条起的每条真实用户消息）：关键词命中 top-K
 *    （fact/lesson/rules/topic，短条目），注入「可能相关的记忆」。
 *
 * 已见记账（injected）按会话写入 .dsh-memery/sessions/<id>.json，注入不重复。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { allRowsMerged, coversProject, LEVEL_LABELS, relativeTime, type MemoryRow } from './db.js'
import { search, extractKeywords } from './bm25.js'

export interface InjectOptions {
  hitTopK: number
  titleMax: number
}

const HIT_LEVELS = ['fact', 'lesson', 'rules', 'topic'] as const
/** 首轮快照包含的短条目层；project/topic 单独列导引。 */
const SNAPSHOT_LEVELS = ['fact', 'lesson', 'rules'] as const

function sessionsFile(workspace: string, dir: string): string {
  return join(workspace, dir, 'sessions')
}

/** 读本会话已注入的 id 集合。 */
export function readInjected(workspace: string, sessionId: string, dir = '.dsh-memery'): Set<string> {
  try {
    const p = join(sessionsFile(workspace, dir), `${sessionId}.json`)
    const data = JSON.parse(readFileSync(p, 'utf8')) as { injected?: string[]; searched?: string[] }
    return new Set(data.injected ?? [])
  } catch {
    return new Set()
  }
}

export function writeInjected(workspace: string, sessionId: string, ids: Iterable<string>, dir = '.dsh-memery'): void {
  try {
    const dirPath = sessionsFile(workspace, dir)
    mkdirSync(dirPath, { recursive: true })
    const p = join(dirPath, `${sessionId}.json`)
    const prev: Record<string, unknown> = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}
    writeFileSync(p, JSON.stringify({ ...prev, injected: [...new Set(ids)] }, null, 2), 'utf8')
  } catch {
    /* 记账失败不阻塞注入 */
  }
}

/** 未标记项目 → 显示为「全局」。 */
function projectLabel(r: MemoryRow): string {
  if (r.project === null || r.project === '' || r.project === '全局' || r.project === 'global') return '全局'
  return r.project
}

function shortLine(r: MemoryRow, titleMax: number): string {
  const title = r.title !== null ? `「${r.title.length > titleMax ? `${r.title.slice(0, titleMax)}…` : r.title}」` : ''
  const head = r.content.length > 80 ? `${r.content.slice(0, 80)}…` : r.content
  return `- [${LEVEL_LABELS[r.level]}]${title} ${head}`.trim()
}

/**
 * 首轮长期记忆快照。返回 null 表示没有可注入内容（库空）。
 * 导引：列出 topic/project 的标题，供模型用 memory_project 深入。
 */
export function buildInjection(
  workspace: string,
  dir: string,
  sessionId: string,
  opts: InjectOptions,
  currentProject: string | null,
): { text: string; injectedIds: string[] } | null {
  // 读取合并工作区库 + 全局库（全局记忆所有工作区可见）。
  const all = allRowsMerged(workspace, dir)
  const snap = all.filter((r) => (SNAPSHOT_LEVELS as readonly string[]).includes(r.level) && r.status === 'active')
  const topics = all.filter((r) => r.level === 'topic' && r.status === 'active')
  const projects = all.filter((r) => r.level === 'project' && r.status === 'active')

  if (snap.length === 0 && topics.length === 0 && projects.length === 0) {
    writeInjected(workspace, sessionId, [], dir)
    return null
  }

  const lines: string[] = []
  lines.push('===== 长期记忆 =====')
  lines.push('以下是此前会话沉淀的记忆。事实类直接采信；区间/判断类供参考。')
  if (snap.length > 0) {
    lines.push('')
    lines.push('【记忆】')
    for (const r of snap) lines.push(shortLine(r, opts.titleMax))
  }
  if (topics.length > 0) {
    lines.push('')
    lines.push('【进行中的话题】')
    for (const r of topics.slice(0, 10)) {
      const goal = r.goal ? `（目标：${r.goal}）` : ''
      lines.push(`- 「${truncate(r.title ?? r.content, opts.titleMax)}」${goal}`)
    }
  }
  if (projects.length > 0) {
    lines.push('')
    lines.push('【项目】可用 memory_project 查看详情')
    for (const r of projects.slice(0, 10)) {
      lines.push(`- ${projectLabel(r)}${r.subcategory ? ` / ${r.subcategory}` : ''}`)
    }
  }
  if (currentProject) lines.push('')
  lines.push('')
  lines.push(
    '【记忆导引】记忆由 agent 在对话中主动写入（memory_remember）；如需某项详情，用 memory_project(project=…) 或 memory_search(keywords=…) 检索。',
  )

  writeInjected(
    workspace,
    sessionId,
    snap.concat(topics, projects).map((r) => r.id),
    dir,
  )
  return { text: lines.join('\n'), injectedIds: snap.concat(topics, projects).map((r) => r.id) }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/**
 * 每轮关键词命中：从第 2 条用户消息起，检索 fact/lesson/rules/topic。
 * 范围 = 全局 + 当前 project 锚定；已见 id 不再重复注入。
 */
export function buildHitInjection(
  workspace: string,
  dir: string,
  sessionId: string,
  userText: string,
  opts: InjectOptions,
  currentProject: string | null,
): { text: string; injectedIds: string[] } | null {
  const candidates = allRowsMerged(workspace, dir).filter(
    (r) =>
      (HIT_LEVELS as readonly string[]).includes(r.level) && r.status === 'active' && coversProject(r, currentProject),
  )
  if (candidates.length === 0) return null

  const seen = readInjected(workspace, sessionId, dir)
  const hitResults = search(candidates, userText, { topK: opts.hitTopK }).filter((h) => !seen.has(h.row.id))

  if (hitResults.length === 0) return null
  const ids = hitResults.map((h) => h.row.id)
  writeInjected(workspace, sessionId, [...seen, ...ids], dir)

  const lines: string[] = ['可能相关的记忆，仅供参考：']
  for (const { row } of hitResults) {
    lines.push(shortLine(row, opts.titleMax))
  }
  return { text: lines.join('\n'), injectedIds: ids }
}

/** 工具共用：写入时自动提取关键词（LLM 未提供时）。 */
export function ensureKeywords(row: { keywords?: string[]; content: string }): string[] {
  return row.keywords !== undefined && Array.isArray(row.keywords) && row.keywords.length > 0
    ? row.keywords
    : extractKeywords(row.content, 8)
}
