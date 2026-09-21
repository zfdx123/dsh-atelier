// 集成自检：用假 ctx + 假 agent 跑一遍完整 apply() 注册与 pre-step 注入。
// 这是把「参考架构的集成点」在本机复现为可执行验证。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeAllDbs } from '../src/db.js'
import { apply, type HostCtx } from '../src/index.js'
import { getDb, insertMemory } from '../src/db.js'

const DIR = '.dsh-memery'
let dir: string
let ws: string
let handlers: Record<string, (payload: unknown, next: () => unknown) => unknown> = {}
let registeredTools: string[] = []
let logLines: string[] = []

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'memery-int-'))
  ws = join(dir, 'ws')
  // 全局库指向临时主目录，绝不碰真实用户 ~/.dsh-memery
  process.env.DSH_MEMERY_HOME = join(dir, 'home')
  // 预填两条记忆，验证注入真实发生
  const db = getDb(ws, DIR)
  insertMemory(db, { level: 'fact', content: '自包含 SQLite 记忆库', keywords: ['sqlite'], project: 'ws' })
  insertMemory(db, { level: 'rules', content: '不重复注入已见记忆', keywords: ['注入'], project: '全局' })
})
after(() => {
  closeAllDbs()
  delete process.env.DSH_MEMERY_HOME
  rmSync(dir, { recursive: true, force: true })
})

function fakeCtx(): HostCtx {
  registeredTools = []
  handlers = {}
  logLines = []
  const ctx = {
    tools: {
      register(t: unknown) {
        registeredTools.push((t as { name: string }).name)
        return () => {}
      },
    },
    logger: {
      info: (m: string) => {
        logLines.push(m)
      },
      warn: (m: string) => {
        logLines.push(m)
      },
    },
    on(event: string, handler: unknown) {
      handlers[event] = handler as (p: unknown, n: () => unknown) => unknown
      return () => {}
    },
    inject(_names: string[], _cb: (scope: never) => void) {
      return () => {}
    },
  } as unknown as HostCtx
  return ctx
}

function userMsg(text: string) {
  return { source: { kind: 'user' }, content: [{ type: 'text' as const, text }] }
}

function fakeAgent(sid: string, events: unknown[] = []) {
  return {
    agent: { session: { header: { id: sid, cwd: ws, origin: undefined }, events } },
    messages: [userMsg('你好')],
    signal: { aborted: false },
  }
}

describe('apply 集成', () => {
  it('注册全部 6 个 memory_* 工具', async () => {
    const ctx = fakeCtx()
    await apply(ctx, {})
    for (const t of [
      'memory_remember',
      'memory_search',
      'memory_read',
      'memory_update',
      'memory_delete',
      'memory_project',
    ]) {
      assert.ok(registeredTools.includes(t), `应注册 ${t}，实际 [${registeredTools.join(',')}]`)
    }
  })

  it('注册了 agent/pre-step 监听', async () => {
    const ctx = fakeCtx()
    await apply(ctx, {})
    assert.ok(typeof handlers['agent/pre-step'] === 'function', '应注册 agent/pre-step 监听')
  })

  it('enabled=false 时不注册任何东西', async () => {
    const ctx = fakeCtx()
    await apply(ctx, { enabled: false })
    assert.equal(registeredTools.length, 0)
    assert.equal(handlers['agent/pre-step'], undefined)
  })
})

describe('pre-step 注入', () => {
  it('首条用户消息注入长期记忆快照（不改写原消息）', async () => {
    const ctx = fakeCtx()
    await apply(ctx, {})
    const preStep = handlers['agent/pre-step']
    const decision = {
      kind: 'enter',
      messages: [userMsg('帮我看看这个项目的记忆')],
    }
    const out = (await preStep(fakeAgent('sess-1', []), async () => decision)) as { kind: string; messages: unknown[] }
    assert.equal(out.kind, 'enter')
    assert.ok(out.messages.length === 2, `应有 2 条消息（快照+原消息），实际 ${out.messages.length}`)
    const snap = out.messages[0] as { source?: { form?: string }; content?: Array<{ text?: string }> }
    assert.equal((snap.source as { form?: string })?.form, 'snapshot')
    const text = (snap.content ?? []).map((b) => b.text ?? '').join(' ')
    assert.match(text, /长期记忆/)
    assert.match(text, /自包含 SQLite 记忆库/)
    // 原用户消息不变
    assert.equal((out.messages[1] as { source: { kind: string } }).source.kind, 'user')
  })

  it('恢复会话（已有历史消息）只跑命中链路，不重复注入快照', async () => {
    const ctx = fakeCtx()
    await apply(ctx, {})
    const preStep = handlers['agent/pre-step']
    const prior = [{ type: 'user/message', data: { source: { kind: 'user' } } }]
    const decision = { kind: 'enter', messages: [userMsg('sqlite 相关的问题')] }
    const out = (await preStep(fakeAgent('sess-2', prior), async () => decision)) as { messages: unknown[] }
    const snap = out.messages[0] as { content?: Array<{ text?: string }>; source?: { form?: string } }
    // 恢复会话没有首轮快照；命中应先于原消息（若有命中）
    const text = (snap.content ?? []).map((b) => b.text ?? '').join(' ')
    assert.match(text, /可能相关的记忆/)
  })

  it('子代理不注入（origin=subagent）', async () => {
    const ctx = fakeCtx()
    await apply(ctx, {})
    const preStep = handlers['agent/pre-step']
    const agent = fakeAgent('sess-3', [])
    agent.agent.session.header.origin = 'subagent'
    const decision = { kind: 'enter', messages: [userMsg('子代理消息')] }
    const out = await preStep(agent, async () => decision)
    assert.equal((out as { messages: unknown[] }).messages.length, 1, '子代理不应注入')
  })

  it('注入失败 fail-open：返回原始 decision 不阻塞', async () => {
    const ctx = fakeCtx()
    // 清空日志避免噪音
    await apply(ctx, {})
    const preStep = handlers['agent/pre-step']
    const decision = { kind: 'reject' }
    const out = await preStep(fakeAgent('sess-4', []), async () => decision)
    assert.equal((out as { kind: string }).kind, 'reject')
  })

  it('重复命中同一会话不重复注入（已见记账）', async () => {
    const ctx = fakeCtx()
    await apply(ctx, {})
    const preStep = handlers['agent/pre-step']
    const decision = () => ({ kind: 'enter', messages: [userMsg('sqlite 存储方案')] })
    const first = (await preStep(
      fakeAgent('sess-5', [{ type: 'user/message', data: { source: { kind: 'user' } } }]),
      async () => decision(),
    )) as { messages: unknown[] }
    assert.ok(first.messages.length >= 2, '第一次应有命中')
    const second = (await preStep(
      fakeAgent('sess-5', [{ type: 'user/message', data: { source: { kind: 'user' } } }]),
      async () => decision(),
    )) as { messages: unknown[] }
    // 已见的不再命中 —— 但第二条 'sqlite 存储方案' 与第一条相同，命中被 seen 挡下
    const snap = second.messages[0] as { content?: Array<{ text?: string }> }
    const text = (snap.content ?? []).map((b) => b.text ?? '').join(' ')
    assert.ok(!text.includes('可能相关的记忆') || second.messages.length === 1, '同一会话不应重复命中同一条')
  })
})
