// 工具面测试：memory_remember/search/read/update/project/delete 的真实 execute。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeAllDbs, getGlobalDb, listMemories, getDb, insertMemory } from '../src/db.js'
import { rememberTool, searchTool, readTool, updateTool, projectTool, deleteTool } from '../src/tools.js'

const DIR = 'mem'
let dir: string
let ws: string

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'memery-tools-'))
  ws = join(dir, 'ws')
  // 全局库指向临时主目录，绝不碰真实用户 ~/.dsh-memery
  process.env.DSH_MEMERY_HOME = join(dir, 'home')
})
after(() => {
  closeAllDbs()
  delete process.env.DSH_MEMERY_HOME
  rmSync(dir, { recursive: true, force: true })
})

const exec = (cwd: string) => ({ agent: { session: { header: { cwd } } } })
type ToolResult = Record<string, any>

async function run<T extends { execute: (a: unknown, e: unknown) => Promise<unknown> }>(
  tool: T,
  args: unknown,
  execArg: unknown,
): Promise<ToolResult> {
  return (await tool.execute(args, execArg)) as ToolResult
}

describe('memory_remember', () => {
  it('必填校验：缺 content/project 报错', async () => {
    const t = rememberTool({ dir: DIR })
    const r1 = await run(t, { content: 'x', project: '' }, exec(ws))
    assert.equal(r1.ok, false)
    const r2 = await run(t, { content: '', project: 'p' }, exec(ws))
    assert.equal(r2.ok, false)
  })

  it('无 cwd 无法确定工作区', async () => {
    const t = rememberTool({ dir: DIR })
    const r = await run(t, { content: 'x', project: 'p', keywords: ['k'] }, {})
    assert.equal(r.ok, false)
  })

  it('成功写入并读回', async () => {
    const t = rememberTool({ dir: DIR })
    const r = await run(
      t,
      {
        content: '这是关键决策：用自包含 SQLite 而非外部 MCP',
        project: 'dsh-memery',
        level: 'decision',
        keywords: ['sqlite', '决策'],
      },
      exec(ws),
    )
    assert.equal(r.ok, true)
    assert.ok(typeof r.id === 'string')
    const read = await run(readTool({ dir: DIR }), { id: r.id }, exec(ws))
    assert.equal(read.ok, true)
    assert.equal(read.memory.project, 'dsh-memery')
  })

  it('keywords 缺省时自动 bigram 提取', async () => {
    const t = rememberTool({ dir: DIR })
    const r = await run(t, { content: '记忆插件采用关键词命中机制', project: 'p' }, exec(ws))
    assert.equal(r.ok, true)
    assert.ok(Array.isArray(r.keywords) && r.keywords.length > 0, '应自动提取关键词')
  })
})

describe('memory_search', () => {
  it('按关键词命中相关记忆', async () => {
    await run(
      rememberTool({ dir: DIR }),
      { content: 'SQLite 是全本地存储', project: 'p', keywords: ['sqlite'] },
      exec(ws),
    )
    const r = await run(searchTool({ dir: DIR }), { query: 'sqlite' }, exec(ws))
    assert.equal(r.ok, true)
    assert.ok(r.results.some((x: any) => x.content.includes('SQLite')))
  })

  it('status=all 包含已归档', async () => {
    const created = await run(
      rememberTool({ dir: DIR }),
      { content: '旧规则 abcxyz', project: 'p', keywords: ['abc'] },
      exec(ws),
    )
    await run(updateTool({ dir: DIR }), { id: created.id, status: 'archived' }, exec(ws))
    const active = await run(searchTool({ dir: DIR }), { query: 'abc' }, exec(ws))
    assert.ok(!active.results.some((x: any) => x.id === created.id), '默认只搜 active')
    const all = await run(searchTool({ dir: DIR }), { query: 'abc', status: 'all' }, exec(ws))
    assert.ok(
      all.results.some((x: any) => x.id === created.id),
      'status=all 应含已归档',
    )
  })
})

describe('memory_project', () => {
  it('按子标签分组项目全景', async () => {
    await run(
      rememberTool({ dir: DIR }),
      {
        content: '采用 esbuild 双产物',
        project: 'd',
        subcategory: 'decisions',
        level: 'project',
        keywords: ['esbuild'],
      },
      exec(ws),
    )
    const r = await run(projectTool({ dir: DIR }), { project: 'd' }, exec(ws))
    assert.equal(r.ok, true)
    assert.equal(r.project, 'd')
    assert.ok(r.sections.some((s: any) => s.title === 'decisions'))
  })

  it('project 参数必填', async () => {
    const r = await run(projectTool({ dir: DIR }), {}, exec(ws))
    assert.equal(r.ok, false)
  })
})

describe('memory_delete', () => {
  it('删除后 search 不可见', async () => {
    const created = await run(
      rememberTool({ dir: DIR }),
      { content: '待删除的临时事实 zzz', project: 'p', keywords: ['zzz'] },
      exec(ws),
    )
    const r = await run(deleteTool({ dir: DIR }), { id: created.id }, exec(ws))
    assert.equal(r.ok, true)
    const read = await run(readTool({ dir: DIR }), { id: created.id }, exec(ws))
    assert.equal(read.ok, false)
  })
})

describe('全局记忆（方案 B：跨工作区全局库）', () => {
  const ws2 = join(dir, 'ws2')

  it('remember 写「全局」→ scope=global，且其它工作区可见', async () => {
    const r = await run(
      rememberTool({ dir: DIR }),
      { content: '所有工作区共享的准则 ggg', project: '全局', keywords: ['gg', '全局'] },
      exec(ws),
    )
    assert.equal(r.ok, true)
    assert.equal(r.scope, 'global')
    const s = await run(searchTool({ dir: DIR }), { query: 'gg' }, exec(ws2))
    assert.equal(s.ok, true)
    const hit = s.results.find((x: any) => x.id === r.id)
    assert.ok(hit, '其它工作区应能搜到全局记忆')
    assert.equal(hit!.scope, 'global', '结果应标注 scope=global')
    assert.equal(hit!.project, '全局')
  })

  it('remember 写普通项目 → scope=workspace，不进入全局库', async () => {
    const r = await run(
      rememberTool({ dir: DIR }),
      { content: '工作区专属 zzzq', project: 'p', keywords: ['zzzq'] },
      exec(ws),
    )
    assert.equal(r.scope, 'workspace')
    const s = await run(searchTool({ dir: DIR }), { query: 'zzzq' }, exec(ws2))
    assert.ok(!s.results.some((x: any) => x.id === r.id), '工作区记忆不应跨工作区可见')
  })

  it('read/update/delete 跨工作区定位全局库条目', async () => {
    const r = await run(
      rememberTool({ dir: DIR }),
      { content: '全局待编辑 eee', project: '全局', keywords: ['eee'] },
      exec(ws),
    )
    // 从另一个工作区读
    const read = await run(readTool({ dir: DIR }), { id: r.id }, exec(ws2))
    assert.equal(read.ok, true)
    assert.equal(read.memory.scope, 'global')
    // 从另一个工作区改
    const u = await run(updateTool({ dir: DIR }), { id: r.id, content: '已编辑全局 fff', importance: 2 }, exec(ws2))
    assert.equal(u.ok, true)
    assert.equal(u.memory.scope, 'global')
    assert.equal(u.memory.content, '已编辑全局 fff')
    // 从另一个工作区删
    const d = await run(deleteTool({ dir: DIR }), { id: r.id }, exec(ws2))
    assert.equal(d.ok, true)
    const gone = await run(readTool({ dir: DIR }), { id: r.id }, exec(ws2))
    assert.equal(gone.ok, false)
  })

  it('update 把 project 改为「全局」时自动搬进全局库', async () => {
    const created = await run(
      rememberTool({ dir: DIR }),
      { content: '先在工作区，后改全局 relocate', project: 'p', keywords: ['relocate'] },
      exec(ws),
    )
    // 工作区条目从「本工作区」改 project → 自动搬进全局库（之后跨工作区可见）
    const u = await run(updateTool({ dir: DIR }), { id: created.id, project: '全局' }, exec(ws))
    assert.equal(u.ok, true)
    assert.equal(u.memory.scope, 'global')
    const s = await run(searchTool({ dir: DIR }), { query: 'relocate' }, exec(ws2))
    const hit = s.results.find((x: any) => x.id === created.id)
    assert.ok(hit !== undefined && hit!.scope === 'global')
  })

  it('工作区条目不可从其它工作区直接改（隔离由 locateRow 保证）', async () => {
    const created = await run(
      rememberTool({ dir: DIR }),
      { content: '隔离岛 iso', project: 'p', keywords: ['iso'] },
      exec(ws),
    )
    const u = await run(updateTool({ dir: DIR }), { id: created.id, content: 'x' }, exec(ws2))
    assert.equal(u.ok, false, '其它工作区不应能改本工作区条目')
  })

  it('project 全景合并两库（scope 已标注）', async () => {
    await run(
      rememberTool({ dir: DIR }),
      { content: '全局项目事实 ggpx', project: 'x', keywords: ['ggpx'], level: 'project', subcategory: 'decisions' },
      exec(ws),
    )
    await run(
      rememberTool({ dir: DIR }),
      { content: '全局项目事实 ggpg', project: '全局', keywords: ['ggpg'], level: 'fact' },
      exec(ws),
    )
    const p = await run(projectTool({ dir: DIR }), { project: 'x' }, exec(ws2))
    assert.equal(p.ok, true)
    assert.ok(p.sections.length >= 1)
    const allItems = p.sections.flatMap((s: any) => s.items ?? [])
    assert.ok(allItems.some((i: any) => i.content === '全局项目事实 ggpg' && i.scope === 'global'))
  })

  it('search 合并结果里工作区行 scope=workspace', async () => {
    await run(
      rememberTool({ dir: DIR }),
      { content: '本地项目知识 localk', project: 'k', keywords: ['localk'] },
      exec(ws),
    )
    const s = await run(searchTool({ dir: DIR }), { query: 'localk' }, exec(ws))
    const hit = s.results.find((x: any) => x.content.includes('localk'))
    assert.ok(hit !== undefined && hit!.scope === 'workspace')
  })

  it('遗留全局条目（旧版写在工作区库）读取时自动迁移，scope=global', async () => {
    insertMemory(getDb(ws, DIR), {
      level: 'rules',
      content: '旧版驻留工作区库的全局规则 legacyglob',
      project: '全局',
      keywords: ['legacyglob'],
    })
    const s = await run(searchTool({ dir: DIR }), { query: 'legacyglob' }, exec(ws))
    const hit = s.results.find((x: any) => x.content.includes('legacyglob'))
    assert.ok(hit !== undefined && hit!.scope === 'global', '合并读取时旧全局条目应被当作全局')
    assert.ok(
      listMemories(getGlobalDb()).some((r) => r.content.includes('legacyglob')),
      '应已物理迁移进全局库',
    )
  })
})
