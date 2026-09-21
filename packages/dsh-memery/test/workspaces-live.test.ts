// 回归：设置页「工作区清单」必须实时反映 workspaceRegistry。
//
// 症状（用户报告）：在 GUI 里新加的工作区，设置页「记忆」的下拉里不显示。
// 根因：清单曾在 ctx.inject(['workspaceRegistry']) 回调里被一次性快照成数组，
// 该回调只在依赖就绪时跑一次 —— 之后新增的工作区永远进不了这个数组。
// 本测试模拟「插件已激活 → 用户新增工作区 → 打开设置页」这一时序。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeAllDbs, getDb, insertMemory } from '../src/db.js'
import { apply, type HostCtx } from '../src/index.js'

const DIR = '.dsh-memery'
let dir: string
let wsOld: string
let wsNew: string

/** 假 registry：list() 每次现算当前登记项（等价于 cordis 服务上的同步读）。 */
let registryPaths: string[] = []
let routes: Record<string, (req: unknown, res: unknown) => void> = {}

function fakeCtx(): HostCtx {
  routes = {}
  const services: Record<string, unknown> = {
    webServer: {
      register(route: { path: string; handler: (req: unknown, res: unknown) => void }) {
        routes[route.path] = route.handler
        return () => {}
      },
    },
    workspaceRegistry: { list: () => registryPaths.map((path) => ({ path })) },
  }
  return {
    tools: { register: () => () => {} },
    logger: { info: () => {}, warn: () => {} },
    on: () => () => {},
    get: (name: string) => services[name],
    // cordis 语义：依赖就绪时回调执行一次，回调返回的函数作为清理函数。
    inject(_names: string[], cb: (scope: never) => unknown) {
      cb({
        get: (name: string) => services[name],
        effect: (fn: () => unknown) => {
          fn()
          return () => {}
        },
        logger: { info: () => {}, warn: () => {} },
      } as never)
      return () => {}
    },
  } as unknown as HostCtx
}

async function getWorkspaces(): Promise<{ ok: boolean; workspaces: Array<{ workspace: string; count: number }> }> {
  const h = routes['/dsh-memery/workspaces']
  assert.ok(typeof h === 'function', '应注册 /dsh-memery/workspaces 路由')
  const out = { status: 0, body: '' }
  h(
    { method: 'GET', url: '/dsh-memery/workspaces' },
    {
      writeHead(status: number) {
        out.status = status
      },
      end(body: string) {
        out.body = body
      },
    },
  )
  await new Promise((r) => setTimeout(r, 10)) // handler 是 void (async () => …)()
  return JSON.parse(out.body) as { ok: boolean; workspaces: Array<{ workspace: string; count: number }> }
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'memery-ws-'))
  wsOld = join(dir, 'ws-old')
  wsNew = join(dir, 'ws-new')
  process.env.DSH_MEMERY_HOME = join(dir, 'home') // 别碰真实 ~/.dsh-memery
})
after(() => {
  closeAllDbs()
  delete process.env.DSH_MEMERY_HOME
  rmSync(dir, { recursive: true, force: true })
})

describe('设置页工作区清单实时性', () => {
  it('插件激活后新增的工作区应立刻出现（不是等插件重载）', async () => {
    registryPaths = [wsOld]
    insertMemory(getDb(wsOld, DIR), { level: 'fact', content: '老工作区的记忆', project: 'p', keywords: ['老'] })

    await apply(fakeCtx(), {})

    const first = await getWorkspaces()
    assert.equal(first.ok, true)
    assert.deepEqual(
      first.workspaces.map((w) => w.workspace),
      [wsOld],
      '激活时应看到老工作区',
    )
    assert.equal(first.workspaces[0]!.count, 1)

    // 用户在 GUI 里新增了工作区（registry 现查即得新路径）
    registryPaths = [wsNew, wsOld]
    insertMemory(getDb(wsNew, DIR), { level: 'fact', content: '新工作区的记忆', project: 'p', keywords: ['新'] })

    const second = await getWorkspaces()
    assert.deepEqual(
      second.workspaces.map((w) => w.workspace).sort(),
      [wsNew, wsOld].sort(),
      '新增工作区必须立刻出现在清单里（快照式实现会漏掉它）',
    )
  })

  it('registry 被卸载（get 返回 undefined）时退化为空清单，不抛错', async () => {
    registryPaths = []
    await apply(fakeCtx(), {})
    const r = await getWorkspaces()
    assert.equal(r.ok, true)
    assert.deepEqual(r.workspaces, [])
  })
})
