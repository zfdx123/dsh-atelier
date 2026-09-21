// 客户端刷新契约（构建产物 lib/client.js）：
// 设置页「↻ 刷新」必须同时刷新记忆列表与工作区清单（下拉 + 计数），
// 否则下拉里一直是打开设置页那一刻的工作区快照 —— 新加的工作区要关掉重开才出现。
//
// 做法：把 lib/client.js 装进 vm，用「假 React」把组件渲染成普通对象树
// （createElement 返回 {type, props, children}），再从树里找到「↻ 刷新」
// 按钮直接调它的 onClick，断言 fetch 打到了两个数据面。
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

interface El {
  type: unknown
  props: Record<string, any>
  children: unknown[]
}

/** 假 React：渲染成对象树，hooks 可调用但不重渲染（够用来触发事件处理器）。 */
function fakeReact(effects: Array<() => void>) {
  const createElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): El => ({
    type,
    props: props ?? {},
    children: children.flat(),
  })
  return {
    createElement,
    Fragment: Symbol('Fragment'),
    useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => {}],
    useEffect: (fn: () => void) => {
      effects.push(fn)
    },
    useCallback: (fn: unknown) => fn,
    useMemo: (fn: () => unknown) => fn(),
    useRef: (v: unknown) => ({ current: v }),
  }
}

function findAll(node: unknown, pred: (el: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, pred, out)
    return out
  }
  if (node === null || typeof node !== 'object') return out
  const el = node as El
  if (pred(el)) out.push(el)
  findAll(el.children, pred, out)
  return out
}

/** 装载 bundle → apply 到假 slots → 拿回注册的组件 + fetch 记录。 */
function mount() {
  const fetched: string[] = []
  const effects: Array<() => void> = []
  const React = fakeReact(effects)
  let registration: { id: string; factory: (r: (s: string) => unknown) => any } | null = null

  const sandbox: Record<string, unknown> = {
    window: {
      __ModuleLoader__: {
        load: (d: { id: string; factory: never }) => {
          registration = d
        },
      },
      confirm: () => true,
    },
    document: {
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ setAttribute() {}, textContent: '' }),
      head: { appendChild() {} },
      documentElement: undefined,
    },
    console,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    fetch: async (url: string) => {
      fetched.push(String(url))
      return { json: async () => ({ ok: true, memories: [], workspaces: [], global_count: 0 }) }
    },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  new vm.Script(bundle).runInContext(sandbox)

  assert.ok(registration !== null, 'bundle 必须调用 __ModuleLoader__.load')
  const mod = registration.factory((spec: string) => {
    if (spec === 'react') return React
    throw new Error(`unexpected require: ${spec}`)
  })

  let Component: ((props: Record<string, unknown>) => El) | null = null
  mod.apply({
    slots: {
      inject: (_name: string, fn: () => unknown) => {
        fn()
        return () => {}
      },
      register: (_def: unknown, comp: never) => {
        Component = comp
        return () => {}
      },
    },
  })
  assert.ok(Component !== null, 'apply 必须注册 settings.section 组件')
  return { tree: (Component as unknown as (p: Record<string, unknown>) => El)({}), fetched, effects }
}

const tick = () => new Promise((r) => setTimeout(r, 10))

describe('设置页刷新契约', () => {
  it('挂载时拉取工作区清单与记忆', async () => {
    const { fetched, effects } = mount()
    for (const fn of effects) fn()
    await tick()
    assert.ok(
      fetched.some((u) => u.startsWith('/dsh-memery/workspaces')),
      `挂载应拉工作区清单，实际 ${fetched.join(' | ')}`,
    )
  })

  it('点「↻ 刷新」同时刷新记忆与工作区清单（新加的工作区不用重开设置页）', async () => {
    const { tree, fetched } = mount()
    const buttons = findAll(tree, (el) => el.props.title === '刷新')
    assert.equal(buttons.length, 1, '工具栏应有且仅有一个「↻ 刷新」按钮')

    buttons[0]!.props.onClick()
    await tick()

    assert.ok(
      fetched.some((u) => u.startsWith('/dsh-memery/memories')),
      `刷新应重载记忆列表，实际 ${fetched.join(' | ')}`,
    )
    assert.ok(
      fetched.some((u) => u.startsWith('/dsh-memery/workspaces')),
      `刷新应同时重载工作区清单（下拉与计数），实际 ${fetched.join(' | ')}`,
    )
  })
})
