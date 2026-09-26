// 删除确认契约（构建产物 lib/client.js）：
// 删除记忆必须走 DSH **原生** RiskConfirmation（警告行 + 「我已了解」勾选框，
// 勾选前不允许确认），而不是浏览器 window.confirm —— 后者是宿主外的系统弹窗，
// 与 DSH 的对话框（portal 到 body、遮罩、24px 圆角、原生按钮）完全两个世界。
//
// 原生组件来自平台模块表的 @deepseek-ai/dsh-client-ui-primitives（前端
// PLATFORM_MODULES 里有它），插件用惰性 require 取；宿主没有这个模块时
// 必须降级回 window.confirm 且**不能**影响客户端激活。
//
// 做法：把 bundle 装进 vm，用「有状态的小 React」（useState 存槽位 + setState
// 同步重渲染）把设置页组件渲染成对象树，从树里点「删除」按钮，检查弹出的
// 是什么、以及确认后打到哪个路由。
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'lib', 'client.js')
const KIT_ID = '@deepseek-ai/dsh-client-ui-primitives'

let bundle: string
before(() => {
  bundle = readFileSync(bundlePath, 'utf8')
})

interface El {
  type: unknown
  props: Record<string, any>
  children: unknown[]
}

const MEMORY = {
  id: 'mem-1',
  level: 'fact',
  title: '测试记忆',
  content: '第一条记忆正文，删错了就没了',
  importance: 2,
  keywords: ['记忆', '删除'],
  status: 'active',
  project: '全局',
  subcategory: null,
  goal: null,
  corrected: false,
  scope: 'global',
  updated_at: '2026-09-20T00:00:00.000Z',
  updated_rel: '刚刚',
}

/** 原生 UI 组件桩：只作标记，测试按 identity 在树里认它。 */
function kitStub() {
  const marker = (name: string) => {
    const C = (props: Record<string, unknown>) => ({ type: C, props: props ?? {}, children: [] })
    C.displayName = name
    return C
  }
  return {
    RiskConfirmation: marker('RiskConfirmation'),
    Button: marker('Button'),
    IconWarningOutline: marker('IconWarningOutline'),
  }
}

/** 装载 → apply → 渲染，返回可直接驱动的小世界。 */
function mount(opts: { withKit?: boolean } = {}) {
  const withKit = opts.withKit !== false
  const kit = kitStub()
  const fetched: string[] = []
  const posts: string[] = []
  const confirmCalls: string[] = []
  const effects: Array<() => void> = []
  const slots: unknown[] = []
  let cursor = 0
  let component: ((props: Record<string, unknown>) => El) | null = null
  let tree: El | null = null

  const render = () => {
    if (component === null) return
    cursor = 0
    tree = component({})
  }

  const React = {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): El => ({
      type,
      props: props ?? {},
      children: children.flat(),
    }),
    Fragment: Symbol('Fragment'),
    useState(init: unknown) {
      const i = cursor++
      if (!(i in slots)) slots[i] = typeof init === 'function' ? (init as () => unknown)() : init
      const set = (v: unknown) => {
        const next = typeof v === 'function' ? (v as (prev: unknown) => unknown)(slots[i]) : v
        if (next === slots[i]) return
        slots[i] = next
        render() // 同步重渲染：点一下就立刻能看到新树
      }
      return [slots[i], set]
    },
    useEffect: (fn: () => void) => {
      effects.push(fn)
    },
    useCallback: (fn: unknown) => fn,
    useMemo: (fn: () => unknown) => fn(),
    useRef: (v: unknown) => ({ current: v }),
  }

  const json = (value: unknown) => ({ json: async () => value })
  let registration: { id: string; factory: (r: (s: string) => unknown) => any } | null = null

  const sandbox: Record<string, unknown> = {
    window: {
      __ModuleLoader__: {
        load: (d: { id: string; factory: never }) => {
          registration = d
        },
      },
      confirm: (msg?: string) => {
        confirmCalls.push(String(msg))
        return true
      },
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
    fetch: async (url: string, init?: { method?: string }) => {
      const u = String(url)
      fetched.push(u)
      if (init?.method === 'POST') posts.push(u)
      if (u.startsWith('/dsh-memery/workspaces')) {
        return json({ ok: true, workspaces: [], global_count: 0 })
      }
      if (u.startsWith('/dsh-memery/memories')) {
        return json({ ok: true, memories: [MEMORY] })
      }
      return json({ ok: true })
    },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  new vm.Script(bundle).runInContext(sandbox)

  assert.ok(registration !== null, 'bundle 必须调用 __ModuleLoader__.load')
  const mod = registration.factory((spec: string) => {
    if (spec === 'react') return React
    if (spec === KIT_ID) {
      if (!withKit) throw new Error(`no such module: ${spec}`)
      return kit
    }
    throw new Error(`unexpected require: ${spec}`)
  })

  mod.apply({
    slots: {
      inject: (_name: string, fn: () => unknown) => {
        fn()
        return () => {}
      },
      register: (_def: unknown, comp: never) => {
        component = comp
        return () => {}
      },
    },
  })
  assert.ok(component !== null, 'apply 必须注册 settings.section 组件')
  render()

  const findAll = (pred: (el: El) => boolean, node: unknown = tree, out: El[] = []): El[] => {
    if (Array.isArray(node)) {
      for (const c of node) findAll(pred, c, out)
      return out
    }
    if (node === null || typeof node !== 'object') return out
    const el = node as El
    if (pred(el)) out.push(el)
    findAll(pred, el.children, out)
    return out
  }

  /** 卡片上的「删除」按钮（两条路径都认：原生 Button 或降级的自带 <button>，避免命中同名的关键词 chip）。 */
  const deleteButtons = (): El[] =>
    findAll((el) => (el.type === 'button' || el.type === kit.Button) && el.children.includes('删除'))

  return {
    fetched,
    posts,
    confirmCalls,
    kit,
    /** 跑挂载期副作用（拉数据），然后等 promise 链落地。 */
    async start() {
      for (const fn of effects.splice(0)) fn()
      await tick()
      assert.ok(
        fetched.some((u) => u.startsWith('/dsh-memery/memories')),
        `挂载应拉记忆列表，实际 ${fetched.join(' | ')}`,
      )
      assert.equal(deleteButtons().length, 1, '列表里应有且仅有一个「删除」按钮（先得有记忆渲染出来）')
    },
    clickDelete() {
      const buttons = deleteButtons()
      assert.equal(buttons.length, 1, '列表里应有且仅有一个「删除」按钮')
      buttons[0]!.props.onClick()
    },
    /** 当前树上的原生确认框（没有则为 undefined）。 */
    riskConfirmation() {
      return findAll((el) => el.type === kit.RiskConfirmation)[0]
    },
    deletePosts: () => posts.filter((u) => u.includes('memory-delete')),
  }
}

const tick = () => new Promise((r) => setTimeout(r, 10))

describe('删除确认走 DSH 原生组件', () => {
  it('点「删除」弹原生 RiskConfirmation，不再用 window.confirm', async () => {
    const h = mount()
    await h.start()

    h.clickDelete()

    assert.equal(h.confirmCalls.length, 0, '不该再弹浏览器 window.confirm')
    const rc = h.riskConfirmation()
    assert.ok(rc !== undefined, '必须渲染原生 RiskConfirmation')
    assert.equal(rc!.props.open, true, '确认框应打开')
    assert.equal(rc!.props.acknowledged, false, '刚打开时勾选框未勾选')
    assert.equal(rc!.props.disabled, false, '空闲时不应禁用确认')
    assert.ok(String(rc!.props.title).length > 0, '确认框要有标题')
    assert.ok(String(rc!.props.acknowledgeLabel).length > 0, '要有「我已了解」勾选文案')
    assert.ok(String(rc!.props.confirmLabel).length > 0, '要有确认按钮文案')
    assert.ok(String(rc!.props.cancelLabel).length > 0, '要有取消按钮文案')
    assert.ok(String(rc!.props.closeLabel).length > 0, '要有关闭按钮的无障碍文案')
  })

  it('确认框里能看到删的是哪条记忆', async () => {
    const h = mount()
    await h.start()
    h.clickDelete()

    const text = [h.riskConfirmation()!.props.title, h.riskConfirmation()!.props.description].join(' ')
    assert.ok(text.includes(MEMORY.title), `应显示记忆标题，实际 ${text}`)
    assert.ok(text.includes('不可恢复'), `应说明不可恢复，实际 ${text}`)
  })

  it('未勾选「我已了解」不发删除请求；勾选并确认后才删、并关掉确认框', async () => {
    const h = mount()
    await h.start()
    h.clickDelete()

    h.riskConfirmation()!.props.onConfirm() // 未勾选就被调用（原生按钮此时是 disabled）
    await tick()
    assert.equal(h.deletePosts().length, 0, '未勾选不得删除')

    h.riskConfirmation()!.props.onAcknowledgedChange(true)
    assert.equal(h.riskConfirmation()!.props.acknowledged, true, '勾选后 acknowledged 应为 true')

    h.riskConfirmation()!.props.onConfirm()
    await tick()

    assert.equal(h.deletePosts().length, 1, `确认后应发一次删除请求，实际 ${h.posts.join(' | ')}`)
    assert.ok(h.deletePosts()[0]!.startsWith('/dsh-memery/memory-delete'), '删除请求打 memory-delete 路由')
    assert.ok(h.riskConfirmation() === undefined, '确认后确认框应关闭')
  })

  it('取消不发请求并关掉确认框', async () => {
    const h = mount()
    await h.start()
    h.clickDelete()

    h.riskConfirmation()!.props.onCancel()
    await tick()

    assert.equal(h.deletePosts().length, 0, '取消不得删除')
    assert.ok(h.riskConfirmation() === undefined, '取消后确认框应关闭')
  })

  it('宿主没有 primitives 时降级回 window.confirm（不影响激活）', async () => {
    const h = mount({ withKit: false })
    await h.start()

    h.clickDelete()

    assert.equal(h.confirmCalls.length, 1, '取不到原生组件时应退回 window.confirm')
    await tick()
    assert.equal(h.deletePosts().length, 1, 'window.confirm 确认后照常删除')
  })
})
