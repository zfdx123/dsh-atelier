// db 数据层测试。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getDb,
  getGlobalDb,
  closeAllDbs,
  insertMemory,
  getMemory,
  updateMemory,
  deleteMemory,
  listMemories,
  coversProject,
  relativeTime,
  allRowsMerged,
  locateRow,
  migrateLegacyGlobalRows,
  isGlobalProjectField,
  ensureRowInRightLibrary,
} from '../src/db.js'

let dir: string
let ws: string

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'memery-db-'))
  ws = join(dir, 'ws')
  // 全局库指向临时主目录，绝不碰真实用户 ~/.dsh-memery
  process.env.DSH_MEMERY_HOME = join(dir, 'home')
})
after(() => {
  closeAllDbs()
  delete process.env.DSH_MEMERY_HOME
  rmSync(dir, { recursive: true, force: true })
})

describe('db', () => {
  it('插入并读回', () => {
    const db = getDb(ws)
    const row = insertMemory(db, {
      level: 'fact',
      content: 'node:sqlite 在 Node 22.13+ 默认可用',
      keywords: ['sqlite', 'node'],
      project: 'dsh-memery',
      importance: 2,
    })
    const back = getMemory(db, row.id)
    assert.ok(back !== null)
    assert.equal(back!.content, 'node:sqlite 在 Node 22.13+ 默认可用')
    assert.deepEqual(back!.keywords, ['sqlite', 'node'])
    assert.equal(back!.project, 'dsh-memery')
    assert.equal(back!.importance, 2)
    assert.equal(back!.status, 'active')
  })

  it('id 排序即创建顺序（时间前缀）', () => {
    const db = getDb(ws)
    const a = insertMemory(db, { level: 'fact', content: 'a', project: 'x' })
    const b = insertMemory(db, { level: 'fact', content: 'b', project: 'x' })
    assert.ok(a.id < b.id, `${a.id} < ${b.id}`)
  })

  it('update 部分字段保留其余', () => {
    const db = getDb(ws)
    const row = insertMemory(db, { level: 'fact', content: 'orig', keywords: ['k1'], project: 'p' })
    const updated = updateMemory(db, row.id, { status: 'archived', content: 'new' })
    assert.ok(updated !== null)
    assert.equal(updated!.status, 'archived')
    assert.equal(updated!.content, 'new')
    assert.deepEqual(updated!.keywords, ['k1'], '未更新的字段应保留')
    assert.ok(updated!.updated_at >= row.updated_at)
  })

  it('update 不存在的 id 返回 null', () => {
    const db = getDb(ws)
    assert.equal(updateMemory(db, 'nope', {}), null)
  })

  it('delete 返回是否删除', () => {
    const db = getDb(ws)
    const row = insertMemory(db, { level: 'facts' as never, content: 'del' })
    assert.equal(deleteMemory(db, row.id), true)
    assert.equal(deleteMemory(db, row.id), false)
    assert.equal(getMemory(db, row.id), null)
  })

  it('listMemories 过滤 level 与 project', () => {
    const db = getDb(ws)
    insertMemory(db, { level: 'fact', content: 'f1', project: 'p1' })
    insertMemory(db, { level: 'rules', content: 'r1', project: 'p2' })
    insertMemory(db, { level: 'fact', content: 'f2', project: 'p2' })
    assert.equal(listMemories(db).length >= 3, true)
    assert.equal(listMemories(db, { level: 'facts' as never }).length, 0)
    assert.ok(listMemories(db, { project: 'p2' }).every((r) => r.project === 'p2'))
  })

  it('coversProject：全局/null 覆盖任何项目', () => {
    assert.equal(coversProject({ project: null, id: 'a' } as never, 'any'), true)
    assert.equal(coversProject({ project: '全局', id: 'b' } as never, 'any'), true)
    assert.equal(coversProject({ project: 'dsh-memery', id: 'c' } as never, 'dsh-memery'), true)
    assert.equal(coversProject({ project: 'dsh-memery', id: 'd' } as never, 'other'), false)
    assert.equal(coversProject({ project: 'a,b', id: 'e' } as never, 'b'), true)
  })

  it('relativeTime 格式化', () => {
    assert.equal(relativeTime(null), '')
    assert.equal(relativeTime(Date.now() - 30_000), '刚刚')
    assert.match(relativeTime(Date.now() - 5 * 60_000), /分钟前/)
    assert.match(relativeTime(Date.now() - 3 * 3600_000), /小时前/)
  })

  it('同一 workspace 复用连接（进程内单例）', () => {
    assert.equal(getDb(ws), getDb(ws))
  })

  it('isGlobalProjectField：只有 全局/global 走全局库', () => {
    assert.equal(isGlobalProjectField('全局'), true)
    assert.equal(isGlobalProjectField('global'), true)
    assert.equal(isGlobalProjectField('dsh-memery'), false)
    assert.equal(isGlobalProjectField(null), false)
    assert.equal(isGlobalProjectField(''), false)
  })

  it('全局库与工作区库物理隔离，路径落在 DSH_MEMERY_HOME', () => {
    const g = insertMemory(getGlobalDb(), { level: 'fact', content: '全局事', project: '全局', keywords: ['g'] })
    const w = insertMemory(getDb(ws), { level: 'fact', content: '工作区事', project: 'p', keywords: ['w'] })
    assert.equal(getMemory(getGlobalDb(), g.id) !== null, true)
    assert.equal(getMemory(getGlobalDb(), w.id), null, '工作区条目不应出现在全局库')
    assert.equal(getMemory(getDb(ws), g.id), null, '全局条目不应出现在工作区库')
  })

  it('allRowsMerged 合并两库、按 id 去重、scope 标注', () => {
    insertMemory(getDb(ws), { level: 'fact', content: '仅工作区 ws-only', project: 'p', keywords: ['ws'] })
    insertMemory(getGlobalDb(), { level: 'fact', content: '仅全局 g-only', project: '全局', keywords: ['g'] })
    const rows = allRowsMerged(ws)
    const wsRow = rows.find((r) => r.content.includes('ws-only'))
    const gRow = rows.find((r) => r.content.includes('g-only'))
    assert.ok(wsRow !== undefined && wsRow!.scope === 'workspace')
    assert.ok(gRow !== undefined && gRow!.scope === 'global')
  })

  it('locateRow：工作区优先，其次全局', () => {
    insertMemory(getDb(ws), { level: 'fact', content: '本地p', project: 'p', keywords: ['lp'] })
    insertMemory(getGlobalDb(), { level: 'fact', content: '全局q', project: '全局', keywords: ['gq'] })
    const p = locateRow(ws, '.dsh-memery', listMemories(getDb(ws)).find((r) => r.content === '本地p')!.id)
    const q = locateRow(ws, '.dsh-memery', listMemories(getGlobalDb()).find((r) => r.content === '全局q')!.id)
    assert.equal(p!.scope, 'workspace')
    assert.equal(q!.scope, 'global')
    assert.equal(locateRow(ws, '.dsh-memery', 'nope'), null)
    assert.equal(locateRow(null, '.dsh-memery', q!.id)!.scope, 'global', '无工作区也能定位全局条目')
  })

  it('migrateLegacyGlobalRows：工作区库的 全局/未标记 条目搬进全局库（幂等）', async () => {
    const ws2 = join(dir, 'ws2')
    insertMemory(getDb(ws2), { level: 'rules', content: '旧版全局准则 legacy', project: '全局', keywords: ['lg'] })
    insertMemory(getDb(ws2), { level: 'fact', content: '未标记项目的旧行', project: null, keywords: ['nu'] })
    insertMemory(getDb(ws2), { level: 'fact', content: '工作区专属行 keep', project: 'p', keywords: ['kp'] })
    const moved = migrateLegacyGlobalRows(ws2, '.dsh-memery')
    assert.equal(moved, 2, '全局+未标记 2 条搬走，项目行保留')
    const globalContent = listMemories(getGlobalDb()).map((r) => r.content)
    assert.ok(globalContent.includes('旧版全局准则 legacy'))
    assert.ok(globalContent.includes('未标记项目的旧行'))
    const ws2Content = listMemories(getDb(ws2)).map((r) => r.content)
    assert.ok(ws2Content.includes('工作区专属行 keep'))
    assert.ok(!ws2Content.includes('旧版全局准则 legacy'))
    // 幂等：再跑一次不报错、不重复
    assert.equal(migrateLegacyGlobalRows(ws2, '.dsh-memery'), 0)
  })

  it('allRowsMerged 自动迁移遗留全局条目（scope 变 global）', () => {
    const ws3 = join(dir, 'ws3')
    insertMemory(getDb(ws3), { level: 'fact', content: '待自动迁移 auto', project: '全局', keywords: ['au'] })
    const rows = allRowsMerged(ws3)
    const r = rows.find((x) => x.content === '待自动迁移 auto')
    assert.ok(r !== undefined && r!.scope === 'global', '读取时自动把旧全局条目当全局')
  })

  it('ensureRowInRightLibrary 跨库搬迁（改 project 后）', () => {
    const ws4 = join(dir, 'ws4')
    const db = getDb(ws4)
    const row = insertMemory(db, { level: 'fact', content: '要从工作区变全局 mv', project: 'p', keywords: ['mv'] })
    // 语义改为全局 → 从工作区库搬到全局库
    const moved = ensureRowInRightLibrary({ ...row, project: '全局' }, 'workspace', ws4, '.dsh-memery')
    assert.equal(moved.project, '全局')
    assert.equal(getMemory(getGlobalDb(), row.id) !== null, true, '已搬入全局库')
    assert.equal(getMemory(db, row.id), null, '工作区副本已删除')
    // scope 不变时不动
    const stay = ensureRowInRightLibrary({ ...row, project: 'p' }, 'workspace', ws4, '.dsh-memery')
    assert.equal(stay.project, 'p')
  })
})
