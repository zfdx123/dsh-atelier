// 注入逻辑测试：首轮快照 + 每轮命中 + 已见记账。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, getGlobalDb, closeAllDbs, insertMemory } from '../src/db.js'
import { buildInjection, buildHitInjection, readInjected } from '../src/inject.js'

const DIR = '.dsh-memery'

let dir: string
let ws: string

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'memery-inj-'))
  ws = join(dir, 'ws')
  // 全局库指向临时主目录，绝不碰真实用户 ~/.dsh-memery
  process.env.DSH_MEMERY_HOME = join(dir, 'home')
})
after(() => {
  closeAllDbs()
  delete process.env.DSH_MEMERY_HOME
  rmSync(dir, { recursive: true, force: true })
})

const OPTS = { hitTopK: 2, titleMax: 40 }

describe('buildInjection（首轮）', () => {
  it('库空返回 null', () => {
    assert.equal(buildInjection(ws, DIR, 's1', OPTS, 'proj'), null)
  })

  it('含 fact/lesson/rules + topic/project 导引', () => {
    const db = getDb(ws)
    insertMemory(db, { level: 'fact', content: '启用 esbuild 打包', keywords: ['esbuild'], project: 'proj' })
    insertMemory(db, { level: 'rules', content: '只读信息不进记忆', keywords: ['rules'], project: null })
    insertMemory(db, {
      level: 'topic',
      title: '迁移旧库',
      content: '把 v1 迁移到 SQLite 结构',
      keywords: ['迁移'],
      project: 'proj',
    })
    insertMemory(db, {
      level: 'project',
      title: 'dsh-memery',
      content: '自包含记忆插件',
      keywords: ['插件'],
      project: 'proj',
    })

    const out = buildInjection(ws, DIR, 's1', OPTS, 'proj')
    assert.ok(out !== null)
    assert.match(out!.text, /长期记忆/)
    assert.match(out!.text, /esbuild/)
    assert.match(out!.text, /进行中的话题/)
    assert.match(out!.text, /迁移/)
    assert.match(out!.text, /项目/)
    assert.ok(out!.injectedIds.length >= 4)
    // 已见记账
    assert.equal(readInjected(ws, 's1', DIR).size, out!.injectedIds.length)
  })

  it('长标题被截断', () => {
    const db = getDb(ws)
    const long = 'x'.repeat(80)
    insertMemory(db, { level: 'topic', title: long, content: '长标题记忆', keywords: ['长'], project: 'p' })
    const out = buildInjection(ws, DIR, 's2', { ...OPTS, titleMax: 20 }, 'p')
    assert.ok(out !== null)
    assert.ok(!out!.text.includes(long))
    assert.match(out!.text, /…/)
  })
})

describe('buildHitInjection（每轮命中）', () => {
  it('无匹配返回 null', () => {
    assert.equal(buildHitInjection(ws, DIR, 's3', '查不到的任何内容zzz', OPTS, 'p'), null)
  })

  it('命中相关记忆且不重复（已见记账）', () => {
    const db = getDb(ws)
    insertMemory(db, {
      level: 'fact',
      content: 'SQLite 文件锁在 Windows 上更严格',
      keywords: ['sqlite', '锁'],
      project: 'p',
    })
    insertMemory(db, {
      level: 'lesson',
      content: 'execFile 会因守护进程继承管道而卡死',
      keywords: ['execfile'],
      project: 'p',
    })

    const first = buildHitInjection(ws, DIR, 's4', 'sqlite 锁怎么处理', OPTS, 'p')
    assert.ok(first !== null)
    assert.match(first!.text, /SQLite 文件锁/)

    const second = buildHitInjection(ws, DIR, 's4', 'sqlite 锁怎么处理', OPTS, 'p')
    assert.equal(second, null, '同一会话已见过的命中不应重复注入')
  })

  it('只命中 active', () => {
    const db = getDb(ws)
    const archived = insertMemory(db, {
      level: 'fact',
      content: '已归档的旧事实 abcdef',
      keywords: ['abc'],
      project: 'p',
    })
    db.prepare('UPDATE memory SET status=? WHERE id=?').run('archived', archived.id)
    assert.equal(buildHitInjection(ws, DIR, 's5', 'abcdef', OPTS, 'p'), null)
  })

  it('全局记忆覆盖当前项目，具体项目记忆只在自己项目内命中', () => {
    const db = getDb(ws)
    insertMemory(db, { level: 'fact', content: '所有项目通用规则 gggg', keywords: ['gg'], project: '全局' })
    insertMemory(db, { level: 'fact', content: '只属于 A 项目的 aaaa', keywords: ['aa'], project: 'A' })
    const globalHit = buildHitInjection(ws, DIR, 's6', 'gggg', OPTS, 'B')
    assert.ok(globalHit !== null, '全局记忆应命中任意项目')
    const aHit = buildHitInjection(ws, DIR, 's6', 'aaaa', OPTS, 'B')
    // 会话 s6 已注入过全局 gggg；aaaa 属于 A，B 项目不应命中
    assert.equal(aHit === null || !aHit.text.includes('aaaa'), true)
    const aInA = buildHitInjection(ws, DIR, 's7', 'aaaa', OPTS, 'A')
    assert.ok(aInA !== null && aInA.text.includes('aaaa'), 'A 项目记忆应在 A 项目内命中')
  })

  it('全局库条目进入首轮快照与每轮命中（跨工作区注入）', () => {
    // 只往「全局库」写（工作区库为空）
    insertMemory(getGlobalDb(), { level: 'fact', content: '全局注入事实 hhh', keywords: ['hhh'], project: '全局' })
    insertMemory(getGlobalDb(), { level: 'rules', content: '全局准则 rrr', keywords: ['rrr'], project: '全局' })
    const snap = buildInjection(ws, DIR, 's-g1', OPTS, 'proj')
    assert.ok(snap !== null)
    assert.match(snap!.text, /全局注入事实 hhh/)
    assert.match(snap!.text, /全局准则 rrr/)
    const hit = buildHitInjection(ws, DIR, 's-g2', 'hhh 相关', OPTS, 'proj')
    assert.ok(hit !== null && hit!.text.includes('全局注入事实 hhh'), '全局库条目应参与每轮命中')
  })

  it('遗留全局条目在工作区库时，首轮快照也包含（自动迁移后并入）', () => {
    insertMemory(getDb(ws), {
      level: 'fact',
      content: '旧版全局 legacy-snap',
      keywords: ['legacy-snap'],
      project: '全局',
    })
    const out = buildInjection(ws, DIR, 's-g3', OPTS, 'proj')
    assert.ok(out !== null)
    assert.match(out!.text, /legacy-snap/)
  })
})
