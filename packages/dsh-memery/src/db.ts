/**
 * dsh-memery — SQLite 数据层（自包含，零外部服务）。
 *
 * 每 level 一表（fact / lesson / rules / topic / project），
 * id = 时间前缀 UUID（排序即创建顺序），updated_at = 记忆时间戳。
 * 数据目录：`<workspace>/.dsh-memery/memory.db`（workspace = 会话 cwd）。
 *
 * 驱动：node:sqlite（Node ≥22.13 内置）。
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type Level = 'fact' | 'lesson' | 'rules' | 'topic' | 'project'
export type Status = 'active' | 'archived' | 'stale'

export const LEVELS: readonly Level[] = ['fact', 'lesson', 'rules', 'topic', 'project']

export const LEVEL_LABELS: Record<Level, string> = {
  fact: '原子事实',
  lesson: '错误与教训',
  rules: '设计原则与行为准则',
  topic: '话题',
  project: '项目',
}

/** project 子类。 */
export const PROJECT_SUBCATEGORIES = ['overview', 'structure', 'decisions', 'quotes', 'ops', 'todo'] as const
export type ProjectSubcategory = (typeof PROJECT_SUBCATEGORIES)[number]

export interface MemoryRow {
  id: string
  level: Level
  title: string | null
  content: string
  importance: number
  keywords: string[]
  status: Status
  project: string | null
  subcategory: ProjectSubcategory | null
  goal: string | null
  corrected: boolean
  created_at: number
  updated_at: number
}

/** 记忆物理所在库：workspace=工作区库（<cwd>/.dsh-memery），global=用户级全局库。 */
export type MemoryScope = 'workspace' | 'global'

/** 带上 scope 的记忆行（合并读取时标注物理位置）。 */
export type ScopedRow = MemoryRow & { scope: MemoryScope }

export interface MemoryPatch {
  title?: string | null
  content?: string
  importance?: number
  status?: Status
  project?: string | null
  subcategory?: ProjectSubcategory | null
  goal?: string | null
  corrected?: boolean
  keywords?: string[]
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 1,
  keywords TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  project TEXT,
  subcategory TEXT,
  goal TEXT,
  corrected INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_level ON memory(level);
CREATE INDEX IF NOT EXISTS idx_memory_status ON memory(status);
CREATE INDEX IF NOT EXISTS idx_memory_project ON memory(project);
CREATE INDEX IF NOT EXISTS idx_memory_updated ON memory(updated_at);
`

export function memoryDbPath(workspace: string, dir = '.dsh-memery'): string {
  return join(workspace, dir, 'memory.db')
}

/**
 * 跨工作区全局记忆库路径（用户级，所有工作区共享）。
 * 测试可用 DSH_MEMERY_HOME 指到临时目录，避免碰真实用户主目录。
 */
export function globalMemoryDbPath(homeDir?: string): string {
  const base = homeDir ?? process.env.DSH_MEMERY_HOME ?? homedir()
  return join(base, '.dsh-memery', 'memory.db')
}

// 进程内单例：同一 db 文件（工作区库或全局库）的多个会话共享一个连接。
const open = new Map<string, DatabaseSync>()

export function getDbFile(path: string): DatabaseSync {
  let db = open.get(path)
  if (db !== undefined) return db
  mkdirSync(dirname(path), { recursive: true })
  db = new DatabaseSync(path)
  db.exec(SCHEMA)
  open.set(path, db)
  return db
}

export function getDb(workspace: string, dir = '.dsh-memery'): DatabaseSync {
  return getDbFile(memoryDbPath(workspace, dir))
}

/** 全局库（跨工作区共享）。 */
export function getGlobalDb(homeDir?: string): DatabaseSync {
  return getDbFile(globalMemoryDbPath(homeDir))
}

/**
 * project 字段决定记忆落哪个库（方案 B：跨工作区全局库）：
 *  -「全局」/「global」→ 全局库（~/.dsh-memery/memory.db，所有工作区共享）
 *  - 其它（含 null/未标记）→ 当前工作区库
 */
export function isGlobalProjectField(project: string | null | undefined): boolean {
  if (project === null || project === undefined) return false
  const t = String(project).trim().toLowerCase()
  return t === '全局' || t === 'global'
}

export function closeAllDbs(): void {
  for (const db of open.values()) {
    try {
      db.close()
    } catch {
      /* 已关闭 */
    }
  }
  open.clear()
}

/** 时间前缀 id：可排序，碰撞免疫。 */
export function newId(now = Date.now()): string {
  return `${now.toString(36)}-${randomUUID().slice(0, 12)}`
}

function rowToMemory(row: Record<string, unknown>): MemoryRow {
  return {
    id: String(row.id),
    level: row.level as Level,
    title: row.title === null ? null : String(row.title),
    content: String(row.content),
    importance: Number(row.importance),
    keywords: JSON.parse(String(row.keywords ?? '[]')) as string[],
    status: row.status as Status,
    project: row.project === null ? null : String(row.project),
    subcategory: row.subcategory === null ? null : (row.subcategory as ProjectSubcategory),
    goal: row.goal === null ? null : String(row.goal),
    corrected: Number(row.corrected) === 1,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  }
}

function selectAll(db: DatabaseSync): MemoryRow[] {
  const rows = db.prepare('SELECT * FROM memory').all() as Record<string, unknown>[]
  return rows.map(rowToMemory)
}

export interface InsertInput {
  level: Level
  title?: string | null
  content: string
  importance?: number
  keywords?: string[]
  status?: Status
  project?: string | null
  subcategory?: ProjectSubcategory | null
  goal?: string | null
  corrected?: boolean
}

export function insertMemory(db: DatabaseSync, input: InsertInput, now = Date.now()): MemoryRow {
  const id = newId(now)
  // node:sqlite 不接受 undefined/boolean：全部转成 null 或 0/1。
  const row: Record<string, unknown> = {
    id,
    level: input.level,
    title: input.title ?? null,
    content: input.content,
    importance: input.importance ?? 1,
    keywords: JSON.stringify(input.keywords ?? []),
    status: input.status ?? 'active',
    project: input.project ?? null,
    subcategory: input.subcategory ?? null,
    goal: input.goal ?? null,
    corrected: input.corrected === true ? 1 : 0,
    created_at: now,
    updated_at: now,
  }
  const cols = Object.keys(row)
  const values = Object.values(row).map((v) => {
    if (v === undefined) return null
    if (typeof v === 'boolean') return v ? 1 : 0
    return v as string | number | null
  })
  db.prepare(`INSERT INTO memory (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...values)
  return rowToMemory(row)
}

export function getMemory(db: DatabaseSync, id: string): MemoryRow | null {
  const row = db.prepare('SELECT * FROM memory WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row === undefined ? null : rowToMemory(row)
}

export function updateMemory(db: DatabaseSync, id: string, patch: MemoryPatch, now = Date.now()): MemoryRow | null {
  const existing = getMemory(db, id)
  if (existing === null) return null
  const merged: Record<string, unknown> = {
    title: patch.title !== undefined ? patch.title : existing.title,
    content: patch.content !== undefined ? patch.content : existing.content,
    importance: patch.importance !== undefined ? patch.importance : existing.importance,
    keywords: patch.keywords !== undefined ? JSON.stringify(patch.keywords) : JSON.stringify(existing.keywords),
    status: patch.status !== undefined ? patch.status : existing.status,
    project: patch.project !== undefined ? patch.project : existing.project,
    subcategory: patch.subcategory !== undefined ? patch.subcategory : existing.subcategory,
    goal: patch.goal !== undefined ? patch.goal : existing.goal,
    corrected: patch.corrected !== undefined ? (patch.corrected === true ? 1 : 0) : existing.corrected ? 1 : 0,
    updated_at: now,
  }
  db.prepare(
    `UPDATE memory SET title=?, content=?, importance=?, keywords=?, status=?, project=?, subcategory=?, goal=?, corrected=?, updated_at=? WHERE id=?`,
  ).run(
    ...[
      'title',
      'content',
      'importance',
      'keywords',
      'status',
      'project',
      'subcategory',
      'goal',
      'corrected',
      'updated_at',
    ]
      .map((k) => {
        const v = merged[k]
        if (v === undefined) return null
        if (typeof v === 'boolean') return v ? 1 : 0
        return v as string | number | null
      })
      .concat(id), // WHERE id=? 用真实 id
  )
  return getMemory(db, id)
}

export function deleteMemory(db: DatabaseSync, id: string): boolean {
  const r = db.prepare('DELETE FROM memory WHERE id = ?').run(id)
  return Number(r.changes) > 0
}

/**
 * 原样插入一行（保留 id / created_at / updated_at），供库间搬迁
 * （遗留全局条目迁移、update 改 project 后的 relocate）使用。
 * 与 insertMemory 不同：id 由调用方给定，绝不重新生成。
 */
function insertRowRaw(db: DatabaseSync, row: MemoryRow, updatedAt = row.updated_at): void {
  db.prepare(
    `INSERT INTO memory (id,level,title,content,importance,keywords,status,project,subcategory,goal,corrected,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.id,
    row.level,
    row.title,
    row.content,
    row.importance,
    JSON.stringify(row.keywords),
    row.status,
    row.project,
    row.subcategory,
    row.goal,
    row.corrected ? 1 : 0,
    row.created_at,
    updatedAt,
  )
}

/**
 * 把工作区库里的「遗留全局条目」（旧版把 全局/未标记项目 写进了工作区库）搬进全局库。
 * 幂等：目标库已有同 id 则跳过。返回搬移条数。
 */
export function migrateLegacyGlobalRows(ws: string, dir = '.dsh-memery'): number {
  try {
    const wsDb = getDb(ws, dir)
    const globalDb = getGlobalDb()
    let moved = 0
    for (const r of selectAll(wsDb)) {
      if (!isGlobalMemory(r)) continue
      if (getMemory(globalDb, r.id) !== null) {
        // 目标已有同 id（理论上只发生在此前迁移中断后重试）：清掉工作区副本
        deleteMemory(wsDb, r.id)
        moved++
        continue
      }
      insertRowRaw(globalDb, r)
      deleteMemory(wsDb, r.id)
      moved++
    }
    return moved
  } catch {
    return 0
  }
}

/**
 * 合并读取：工作区库 + 全局库（缺一不致命），按 id 去重（工作区副本优先），
 * 每条标注 scope。读取前顺手迁移遗留全局条目（幂等）。
 */
export function allRowsMerged(ws: string, dir = '.dsh-memery'): ScopedRow[] {
  try {
    migrateLegacyGlobalRows(ws, dir)
  } catch {
    /* 迁移失败不阻塞读取 */
  }
  const out = new Map<string, ScopedRow>()
  try {
    for (const r of listMemories(getDb(ws, dir))) out.set(r.id, { ...r, scope: 'workspace' })
  } catch {
    /* 工作区库打不开不致命 */
  }
  try {
    for (const r of listMemories(getGlobalDb())) {
      if (!out.has(r.id)) out.set(r.id, { ...r, scope: 'global' })
    }
  } catch {
    /* 全局库不可用：只回退工作区行 */
  }
  return [...out.values()]
}

/** 按 id 定位（工作区优先，找不到再查全局库），返回行 + 物理 scope。 */
export function locateRow(ws: string | null, dir: string, id: string): ScopedRow | null {
  if (ws !== null) {
    try {
      const r = getMemory(getDb(ws, dir), id)
      if (r !== null) return { ...r, scope: 'workspace' }
    } catch {
      /* 继续查全局库 */
    }
  }
  try {
    const r = getMemory(getGlobalDb(), id)
    if (r !== null) return { ...r, scope: 'global' }
  } catch {
    /* 全局库不可用 */
  }
  return null
}

/**
 * 把行搬到 project 语义对应的库（更新了 project 字段后调用）。
 * 不变更 scope 归属（工程上保持「project=全局 ⇒ 全局库」的物理一致）。
 */
export function ensureRowInRightLibrary(
  row: MemoryRow,
  currentScope: MemoryScope,
  ws: string,
  dir = '.dsh-memery',
): MemoryRow {
  const wantGlobal = isGlobalProjectField(row.project)
  if (wantGlobal === (currentScope === 'global')) return row
  const dst = wantGlobal ? getGlobalDb() : getDb(ws, dir)
  const src = wantGlobal ? getDb(ws, dir) : getGlobalDb()
  try {
    insertRowRaw(dst, row)
    deleteMemory(src, row.id)
  } catch {
    /* 目标已有同 id：保留源副本即可，语义以 project 为准 */
  }
  return row
}

export function listMemories(db: DatabaseSync, opts: { level?: Level; project?: string | null } = {}): MemoryRow[] {
  let rows = selectAll(db)
  if (opts.level !== undefined) rows = rows.filter((r) => r.level === opts.level)
  if (opts.project !== undefined && opts.project !== null) {
    rows = rows.filter((r) => r.project === opts.project)
  }
  return rows
}

/** 是否全局记忆（project 字段为 '全局' 或空/未标记）。 */
export function isGlobalMemory(r: MemoryRow): boolean {
  return r.project === null || r.project === '' || r.project === '全局' || r.project === 'global'
}

/** 记忆是否属于某个当前项目（全局记忆天然覆盖）。 */
export function coversProject(r: MemoryRow, project: string | null): boolean {
  if (project === null || project === '') return true
  if (isGlobalMemory(r)) return true
  const projects = String(r.project)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return projects.includes(project)
}

/** 相对时间显示（“记忆时间戳”人性化）。 */
export function relativeTime(ms: number | null | undefined): string {
  if (!ms) return ''
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return new Date(ms).toISOString().slice(0, 10)
}
