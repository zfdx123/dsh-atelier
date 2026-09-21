// 回归：设置页「默认工作区」的解析必须只用 DSH 0.1.6-alpha.2 真实存在的字段。
//
// 症状（本轮兼容性审计发现）：DSH 0.1.6-alpha.2 的 SessionListState 只有
//   { ids, byId, phase, subagentsByParent, jobsBySession }
// （dsh-api-session-controller/lib/types/client/sessions/service.d.ts:42-57），
// 没有 `current` —— 会话选中态是 ui-session 的私有字段，根作用域的
// standardProps 拿不到（ISessions 也只暴露 list）。旧代码读 s.current 永远
// undefined，于是「当前对话所在工作区」这条路径从未生效，永远退化成注册表
// 里的第一个工作区。
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'lib', 'client.js')

let bundle: string
before(() => {
  bundle = readFileSync(bundlePath, 'utf8')
})

/** 最小 document + window.__ModuleLoader__，装载并物化 bundle。 */
function loadBundle(): Record<string, unknown> {
  let registration: { id: string; factory: (r: (s: string) => unknown) => Record<string, unknown> } | null = null
  const doc = {
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ setAttribute() {}, textContent: '' }),
    head: { appendChild() {} },
    documentElement: undefined,
  }
  const sandbox: Record<string, unknown> = {
    window: {
      __ModuleLoader__: {
        load: (d: { id: string; factory: never }) => {
          registration = d
        },
      },
    },
    document: doc,
    console,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    fetch: async () => {
      throw new Error('no fetch in test')
    },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  new vm.Script(bundle).runInContext(sandbox)
  assert.ok(registration !== null, 'bundle 必须调用 __ModuleLoader__.load')
  return (registration as unknown as { factory: (r: (s: string) => unknown) => Record<string, unknown> }).factory(
    (spec: string) => {
      if (spec === 'react') {
        return {
          createElement: () => null,
          useState: (v: unknown) => [typeof v === 'function' ? v() : v, () => {}],
          useEffect: () => {},
          useCallback: (f: never) => f,
          useMemo: (f: () => unknown) => f(),
          useRef: (v: unknown) => ({ current: v }),
        }
      }
      if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
        return { RiskConfirmation: () => null }
      }
      throw new Error(`unexpected require: ${spec}`)
    },
  )
}

/** alpha.2 真实快照形状：只有 ids/byId/phase，没有 current。 */
function alpha2Snapshot(): Record<string, unknown> {
  return {
    ids: ['s1', 's2'],
    byId: {
      s1: { id: 's1', cwd: 'E:/ws-old', updatedAt: 100 },
      s2: { id: 's2', cwd: 'E:/ws-new', updatedAt: 900 },
    },
    phase: 'ready',
  }
}

describe('默认工作区解析（alpha.2 快照形状）', () => {
  it('从 byId 里取最近活动过的会话所在工作区', () => {
    const mod = loadBundle()
    const resolve = mod.resolveDefaultWorkspace as (p: Record<string, unknown>) => string | undefined
    assert.equal(typeof resolve, 'function', '必须导出 resolveDefaultWorkspace 供测试')
    const snapshot = alpha2Snapshot()
    const props = { useSessions: (sel: (s: unknown) => unknown) => sel(snapshot) }
    assert.equal(resolve(props), 'E:/ws-new')
  })

  it('byId 里没有可用 cwd 时返回 undefined（调用方回退注册表顺序）', () => {
    const mod = loadBundle()
    const resolve = mod.resolveDefaultWorkspace as (p: Record<string, unknown>) => string | undefined
    const props = { useSessions: (sel: (s: unknown) => unknown) => sel({ ids: [], byId: {}, phase: 'ready' }) }
    assert.equal(resolve(props), undefined)
  })

  it('useSessions 缺席时不抛错（降级）', () => {
    const mod = loadBundle()
    const resolve = mod.resolveDefaultWorkspace as (p: Record<string, unknown>) => string | undefined
    assert.equal(resolve({}), undefined)
  })
})
