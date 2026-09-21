// 设置页数据路由测试：合并读取 + 添加/更新/删除 的 scope 路由。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, getGlobalDb, closeAllDbs, listMemories, insertMemory } from '../src/db.js'
import { createSettingsRouteHandler } from '../src/settings.js'

const DIR = '.dsh-memery'
let dir: string
let ws: string
let handlers: Record<string, (req: unknown, res: unknown) => void> = {}

function makeReq(method: string, url: string, body?: unknown) {
  return {
    method,
    url,
    on(ev: 'data' | 'end' | 'error', cb: (...args: any[]) => void) {
      if (ev === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)))
      if (ev === 'end') cb()
      return this
    },
  }
}

function makeRes() {
  const out: { status: number; body: string } = { status: 0, body: '' }
  return {
    res: {
      writeHead(status: number, _h: Record<string, string>) {
        out.status = status
      },
      end(b: string) {
        out.body = b
      },
    },
    out,
  }
}

function setup(defaultWorkspace: () => string | null) {
  handlers = {}
  const webServer = {
    register(route: { path: string; handler: (req: unknown, res: unknown) => void }) {
      handlers[route.path] = route.handler
      return () => {}
    },
  }
  const ctx = {
    effect: (fn: () => unknown) => {
      fn()
      return () => {}
    },
    get: (name: string) => (name === 'webServer' ? webServer : undefined),
    logger: { info: () => {}, warn: () => {} },
  }
  createSettingsRouteHandler(ctx as never, { dir: DIR, defaultWorkspace, listWorkspaces: () => [ws] })
}

async function call(path: string, req: unknown): Promise<{ status: number; json: Record<string, any> | null }> {
  const h = handlers[path]
  assert.ok(typeof h === 'function', `路由 ${path} 应已注册`)
  const { res, out } = makeRes()
  h(req, res)
  // handler 内部是 void (async () => …)()：等微任务链跑完
  await new Promise((r) => setTimeout(r, 10))
  return { status: out.status, json: out.body === '' ? null : JSON.parse(out.body) }
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'memery-set-'))
  ws = join(dir, 'ws')
  process.env.DSH_MEMERY_HOME = join(dir, 'home')
  setup(() => ws)
})
after(() => {
  closeAllDbs()
  delete process.env.DSH_MEMERY_HOME
  rmSync(dir, { recursive: true, force: true })
})

describe('设置页路由（方案 B 全局库）', () => {
  it('GET /memories 合并工作区库+全局库，scope 标注', async () => {
    insertMemory(getDb(ws, DIR), {
      level: 'fact',
      content: '界面里的工作区记忆 uiws',
      project: 'p',
      keywords: ['uiws'],
    })
    insertMemory(getGlobalDb(), {
      level: 'fact',
      content: '界面里的全局记忆 uigl',
      project: '全局',
      keywords: ['uigl'],
    })
    const { status, json } = await call('/dsh-memery/memories', makeReq('GET', '/dsh-memery/memories'))
    assert.equal(status, 200)
    assert.ok(json!.memories.some((m: any) => m.content.includes('uiws') && m.scope === 'workspace'))
    assert.ok(!json!.memories.some((m: any) => m.content.includes('uigl')), '工作区视图不应混入全局条目')
  })

  it('GET /memories?scope=global → 只回全局库条目', async () => {
    const { status, json } = await call('/dsh-memery/memories', makeReq('GET', '/dsh-memery/memories?scope=global'))
    assert.equal(status, 200)
    assert.equal(json!.workspace, null)
    assert.ok(json!.memories.some((m: any) => m.content.includes('uigl') && m.scope === 'global'))
    assert.ok(!json!.memories.some((m: any) => m.content.includes('uiws')), '全局视图不应含工作区条目')
  })

  it('GET /memories 无工作区（defaultWorkspace=null）→ 只回全局库', async () => {
    setup(() => null)
    const { status, json } = await call('/dsh-memery/memories', makeReq('GET', '/dsh-memery/memories'))
    assert.equal(status, 200)
    assert.equal(json!.workspace, null)
    assert.ok(json!.memories.length > 0, '至少应有全局记忆')
    assert.ok(json!.memories.every((m: any) => m.scope === 'global'))
  })

  it('GET /projects 返回该工作区出现过的项目名（去重排序）', async () => {
    setup(() => ws)
    insertMemory(getDb(ws, DIR), { level: 'fact', content: '项目a', project: 'alpha', keywords: ['alpha'] })
    insertMemory(getDb(ws, DIR), { level: 'fact', content: '项目b', project: 'beta', keywords: ['beta'] })
    insertMemory(getDb(ws, DIR), { level: 'fact', content: '多项目', project: 'alpha,gamma', keywords: ['gamma'] })
    const { status, json } = await call(
      '/dsh-memery/projects',
      makeReq('GET', '/dsh-memery/projects?workspace=' + encodeURIComponent(ws)),
    )
    assert.equal(status, 200)
    const projects = json!.projects as string[]
    assert.ok(projects.includes('alpha'))
    assert.ok(projects.includes('beta'))
    assert.ok(projects.includes('gamma'))
    assert.equal(projects.filter((p) => p === 'alpha').length, 1, '应去重')
  })

  it('POST /memory-add 写「全局」→ 全局库，scope=global', async () => {
    setup(() => ws)
    const { status, json } = await call(
      '/dsh-memery/memory-add',
      makeReq('POST', '/dsh-memery/memory-add', {
        level: 'fact',
        content: '界面添加的全局 addglobal',
        project: '全局',
        keywords: ['addglobal'],
      }),
    )
    assert.equal(status, 200)
    assert.equal(json!.memory.scope, 'global')
    assert.ok(listMemories(getGlobalDb()).some((r) => r.content === '界面添加的全局 addglobal'))
  })

  it('POST /memory-add 写普通项目 → 工作区库，scope=workspace', async () => {
    const { status, json } = await call(
      '/dsh-memery/memory-add',
      makeReq('POST', '/dsh-memery/memory-add', {
        level: 'fact',
        content: '界面添加的工作区 addws',
        project: 'p',
        keywords: ['addws'],
      }),
    )
    assert.equal(status, 200)
    assert.equal(json!.memory.scope, 'workspace')
    assert.ok(listMemories(getDb(ws, DIR)).some((r) => r.content === '界面添加的工作区 addws'))
    assert.ok(!listMemories(getGlobalDb()).some((r) => r.content === '界面添加的工作区 addws'))
  })

  it('POST /memory-add 缺 content/project → 400', async () => {
    const r1 = await call(
      '/dsh-memery/memory-add',
      makeReq('POST', '/dsh-memery/memory-add', { content: '', project: 'p' }),
    )
    assert.equal(r1.status, 400)
    const r2 = await call(
      '/dsh-memery/memory-add',
      makeReq('POST', '/dsh-memery/memory-add', { content: 'x', project: '' }),
    )
    assert.equal(r2.status, 400)
  })

  it('POST /memory-update 改 project 为「全局」→ 自动搬进全局库', async () => {
    const created = insertMemory(getDb(ws, DIR), {
      level: 'fact',
      content: '先本地后全局 ui-rel',
      project: 'p',
      keywords: ['uirel'],
    })
    const u = await call(
      '/dsh-memery/memory-update',
      makeReq('POST', '/dsh-memery/memory-update', { id: created.id, project: '全局', importance: 3 }),
    )
    assert.equal(u.status, 200)
    assert.equal(u.json!.memory.scope, 'global')
    assert.ok(
      listMemories(getGlobalDb()).some((r) => r.id === created.id),
      '已搬进全局库',
    )
    assert.ok(!listMemories(getDb(ws, DIR)).some((r) => r.id === created.id), '工作区副本已删除')
    assert.equal(listMemories(getGlobalDb()).find((r) => r.id === created.id)!.importance, 3)
  })

  it('POST /memory-update 改全局条目（不带 project）→ 仍在全局库更新', async () => {
    const g = insertMemory(getGlobalDb(), {
      level: 'fact',
      content: '全局待编辑 uid-upd',
      project: '全局',
      keywords: ['uidupd'],
    })
    const u = await call(
      '/dsh-memery/memory-update',
      makeReq('POST', '/dsh-memery/memory-update', { id: g.id, status: 'archived' }),
    )
    assert.equal(u.status, 200)
    assert.equal(u.json!.memory.scope, 'global')
    const back = listMemories(getGlobalDb()).find((r) => r.id === g.id)
    assert.ok(back !== undefined && back!.status === 'archived')
  })

  it('POST /memory-delete 定位全局库条目并删除', async () => {
    const g = insertMemory(getGlobalDb(), {
      level: 'fact',
      content: '界面删除全局 uid',
      project: '全局',
      keywords: ['uid'],
    })
    const d = await call('/dsh-memery/memory-delete', makeReq('POST', '/dsh-memery/memory-delete', { id: g.id }))
    assert.equal(d.status, 200)
    assert.ok(!listMemories(getGlobalDb()).some((r) => r.id === g.id))
  })

  it('POST /memory-delete 不存在的 id → 404', async () => {
    const d = await call('/dsh-memery/memory-delete', makeReq('POST', '/dsh-memery/memory-delete', { id: 'nope' }))
    assert.equal(d.status, 404)
  })
})
