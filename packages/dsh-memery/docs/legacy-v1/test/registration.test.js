// test/registration.test.js — 这是本次真实故障的回归测试。
//
// 故障现象：客户端面板正常显示，但 /api/dsh-memery/* 一律 404（DSH 共享通道
// 返回裸 "not found"）。根因是宿主半在装载的那一刻用 `ctx.get('connection')`
// **同步**探测载体；那时服务还没注册，于是两个分支都进不去、静默什么都没注册。
//
// 正确做法是 `ctx.inject(['connection','webServer'], scope => ...)` 延迟获取
// （dsh-lovelyaudit 就是这个模式）。这组测试钉死：
//   1. 不允许在 inject 回调之外同步注册（服务缺席时必须什么都不做，而不是胡乱注册）
//   2. inject 回调一触发，6 条路由必须全部注册
//   3. 只有 webServer 时的回退分支也要能注册
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(here, '..', 'index.js')).href)

const silentLogger = { info: () => {}, warn: () => {} }

/** 建一个假 ctx：inject 的回调被记录下来，由测试决定何时「服务就绪」。 */
function makeCtx({ connection, webServer, workspaces = [] } = {}) {
  const state = { pendingInject: [], effects: [], info: [], warn: [] }
  const logger = {
    info: (m) => state.info.push(String(m)),
    warn: (m) => state.warn.push(String(m)),
  }
  const ctx = {
    get(name) {
      if (name === 'logger') return logger
      // 故意让 connection/webServer/workspaceRegistry 在「装载时」都不可见
      // —— 重现真实故障场景：旧实现就是在这里静默什么都拿不到。
      return undefined
    },
    effect(fn, label) {
      state.effects.push(label)
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    inject(names, callback) {
      state.pendingInject.push({ names, callback })
      return Promise.resolve()
    },
  }
  state.serve = () => {
    const scope = {
      get(name) {
        if (name === 'connection') return connection
        if (name === 'webServer') return webServer
        if (name === 'workspaceRegistry') return { list: () => workspaces }
        if (name === 'logger') return logger
        return undefined
      },
      effect: (fn, label) => ctx.effect(fn, label),
    }
    for (const p of state.pendingInject) p.callback(scope)
  }
  return { ctx, state }
}

function fakeConnection(sink) {
  return {
    fetch: {
      register(route) {
        sink.push({ path: route.path, methods: route.methods })
        return () => {}
      },
    },
    requestRejection: () => undefined,
  }
}

describe('宿主半的路由注册（延迟获取）', () => {
  it('装载时用 ctx.inject 声明依赖，而不是同步 ctx.get 探测', () => {
    const { ctx, state } = makeCtx({ connection: fakeConnection([]) })
    mod.apply(ctx)
    const declared = state.pendingInject.map((p) => [...p.names].join('+'))
    assert.ok(declared.includes('connection+webServer'), `应声明载体依赖，实际：${declared.join(' | ')}`)
    assert.ok(
      declared.includes('workspaceRegistry'),
      `应声明工作区依赖（否则项目身份会错解析成进程 cwd），实际：${declared.join(' | ')}`,
    )
    assert.ok(
      state.pendingInject.every((p) => typeof p.callback === 'function'),
      '每次 inject 都必须带回调',
    )
  })

  it('★ 服务就绪前不注册任何路由（旧实现在这里静默失败，导致 404）', () => {
    const sink = []
    const { ctx } = makeCtx({ connection: fakeConnection(sink) })
    mod.apply(ctx)
    assert.equal(sink.length, 0, '回调未触发前不该有路由注册')
  })

  it('★ 服务就绪后 6 条路由全部注册（含 health）', () => {
    const sink = []
    const { ctx, state } = makeCtx({ connection: fakeConnection(sink) })
    mod.apply(ctx)
    state.serve()

    assert.equal(sink.length, 6, `应注册 6 条，实际 ${sink.length}: ${sink.map((r) => r.path).join(',')}`)
    const paths = sink.map((r) => r.path)
    for (const expected of [
      '/api/dsh-memery/health',
      '/api/dsh-memery/stats',
      '/api/dsh-memery/observations',
      '/api/dsh-memery/projects',
      '/api/dsh-memery/sessions',
      '/api/dsh-memery/resolve',
    ]) {
      assert.ok(paths.includes(expected), `缺少路由 ${expected}`)
    }
  })

  it('每条路由都声明了 methods，且 observations 支持 GET+DELETE', () => {
    const sink = []
    const { ctx, state } = makeCtx({ connection: fakeConnection(sink) })
    mod.apply(ctx)
    state.serve()
    for (const route of sink) {
      assert.ok(Array.isArray(route.methods) && route.methods.length > 0, `${route.path} 缺 methods`)
    }
    const obs = sink.find((r) => r.path === '/api/dsh-memery/observations')
    assert.deepEqual([...obs.methods].sort(), ['DELETE', 'GET'])
  })

  it('没有 connection 时回退到 webServer，仍注册 6 条', () => {
    const sink = []
    const webServer = {
      register: (route) => {
        sink.push({ path: route.path, kind: route.kind })
        return () => {}
      },
    }
    const { ctx, state } = makeCtx({ connection: undefined, webServer })
    mod.apply(ctx)
    state.serve()
    assert.equal(sink.length, 6, `应回退注册 6 条，实际 ${sink.length}`)
    assert.ok(
      sink.every((r) => r.kind === 'exact'),
      '回退分支必须用 exact 路由',
    )
  })

  it('两个载体都没有时明确告警，而不是静默', () => {
    const sink = []
    const { ctx, state } = makeCtx({ connection: undefined, webServer: undefined })
    mod.apply(ctx)
    state.serve()
    assert.equal(sink.length, 0)
    assert.ok(
      state.warn.some((m) => m.includes('未注册')),
      `应有「未注册」告警，实际：${state.warn.join(' | ')}`,
    )
  })

  it('每次注册都包在 effect 里，便于插件卸载时清理', () => {
    const sink = []
    const { ctx, state } = makeCtx({ connection: fakeConnection(sink) })
    mod.apply(ctx)
    state.serve()
    const routeEffects = state.effects.filter((l) => String(l).includes('/api/dsh-memery/'))
    assert.equal(routeEffects.length, 6, `应有 6 条 effect，实际 ${routeEffects.length}`)
  })

  it('工作区依赖就绪后日志会说明来源与候选项', () => {
    const sink = []
    const { ctx, state } = makeCtx({
      connection: fakeConnection(sink),
      workspaces: [{ id: 'w1', path: 'E:\\work\\ai\\dsh-memery' }],
    })
    mod.apply(ctx)
    state.serve()
    const line = state.info.find((m) => m.includes('工作区来源'))
    assert.ok(line, `应有工作区来源日志，实际：${state.info.join(' | ')}`)
    assert.match(line, /workspaceRegistry/)
    assert.match(line, /dsh-memery/)
  })

  it('没有任何工作区时回落到 cwd，但必须留下警告（不能静默）', () => {
    const sink = []
    const { ctx, state } = makeCtx({ connection: fakeConnection(sink), workspaces: [] })
    mod.apply(ctx)
    state.serve()
    assert.ok(
      state.warn.some((m) => m.includes('回落') || m.includes('DSH_MEMERY_WORKSPACE_ROOT')),
      `应警告回落 cwd，实际：${state.warn.join(' | ')}`,
    )
  })
})
