// 图标契约（构建产物 lib/client.js）：字形 → 外壳图标。
//
// 设置页原来拿 Unicode 字形当图标用：「＋ 添加」「↻ 刷新」「▾ 选择」，全局徽章则是
// 自己手搓的 chip。这些改成外壳 @deepseek-ai/dsh-client-ui-primitives 的原子
// （Button 的 icon 通道 + 图标节点、Tag），拿不到组件库时逐一退回今天的样子：
// 自带按钮 + 字形文案 + 手搓徽章，且不抛错（降级绝不白屏）。
//
// 做法与 client-delete-confirm.test.ts 一致：bundle 装进 vm，用「有状态的小 React」
// 渲染成对象树；组件库按需 require（withKit:false 时 require 抛错，模拟宿主没有这个
// 模块）。表单是子组件，测试里直接按元素类型调用它，把内部树也渲染出来。
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
  content: '第一条记忆正文',
  importance: 2,
  keywords: ['记忆'],
  status: 'active',
  project: '全局',
  subcategory: null,
  goal: null,
  corrected: false,
  scope: 'global',
  updated_at: '2026-09-20T00:00:00.000Z',
  updated_rel: '刚刚',
}

/**
 * 原生 UI 组件库桩：组件与图标都按 identity 在树里认。
 *
 * `Button` 刻意做成 `React.forwardRef` 的**对象形状**（`$$typeof` + `render`），
 * 而不是普通函数——外壳真实导出的就是 forwardRef。以前这里用普通函数，于是
 * 「守门写成 `typeof kit.Button === 'function'`」这个 bug 一路绿灯：真实运行时
 * `typeof` 恒为 `'object'`，整套原语被判不可用，主按钮与图标位全退回字形。
 */
function kitStub() {
  const marker = (name: string) => {
    const C = (props: Record<string, unknown>) => ({ type: C, props: props ?? {}, children: [] })
    C.displayName = name
    return C
  }
  const forwardRef = (name: string) => {
    const render = (props: Record<string, unknown>) => ({ type: render, props: props ?? {}, children: [] })
    return { $$typeof: Symbol.for('react.forward_ref'), render, displayName: name }
  }
  return {
    RiskConfirmation: marker('RiskConfirmation'),
    Button: forwardRef('Button'),
    Tag: marker('Tag'),
    IconPlusOutlineRegular: marker('IconPlusOutlineRegular'),
    IconRefreshOutlineRegular: marker('IconRefreshOutlineRegular'),
    IconChevronDownOutlineRegular: marker('IconChevronDownOutlineRegular'),
  }
}

/** 装载 → apply → 渲染，返回可直接驱动的小世界。 */
function mount(opts: { withKit?: boolean } = {}) {
  const withKit = opts.withKit !== false
  const kit = kitStub()
  const effects: Array<() => void> = []
  const slots: unknown[] = []
  let cursor = 0
  let topCursor = 0
  let component: ((props: Record<string, unknown>) => El) | null = null
  let tree: El | null = null

  const render = () => {
    if (component === null) return
    cursor = 0
    tree = component({ useWorkspaces: (sel: (s: unknown) => unknown) => sel({ items: [{ path: 'E:/proj' }] }) })
    topCursor = cursor
  }

  const React = {
    // React 的真实行为：`type` 是 forwardRef 对象时渲染的是它的 `render`。
    // 测试树里存的 `type` 因此是那个 render 函数，断言用 kit.Button.render 对。
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): El => {
      let resolved: unknown = type
      if (
        typeof type === 'object' &&
        type !== null &&
        (type as { $$typeof?: unknown }).$$typeof === Symbol.for('react.forward_ref')
      ) {
        resolved = (type as { render: unknown }).render
      }
      return { type: resolved, props: props ?? {}, children: children.flat() }
    },
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
      const u = String(url)
      if (u.startsWith('/dsh-memery/workspaces')) {
        return json({ ok: true, workspaces: [{ workspace: 'E:/proj', count: 1 }], global_count: 1 })
      }
      if (u.startsWith('/dsh-memery/projects')) return json({ ok: true, projects: ['全局', 'proj'] })
      if (u.startsWith('/dsh-memery/memories')) return json({ ok: true, memories: [MEMORY] })
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

  const text = (node: unknown = tree): string => JSON.stringify(node ?? null)

  /** 含指定文案的按钮（原生 Button 或自带 button 都认）。 */
  const buttonWith = (needle: string, node: unknown = tree): El[] =>
    findAll(
      (el) =>
        (el.type === 'button' || el.type === kit.Button.render) &&
        el.children.some((c) => typeof c === 'string' && c.includes(needle)),
      node,
    )

  /** 表单子组件元素（打开表单后才在树里）。 */
  const formElement = (): El | undefined =>
    findAll((el) => typeof el.type === 'function' && 'projectOptions' in el.props)[0]

  /** 表单里的「项目」下拉（按宽度样式认，层级下拉没有这个样式）。 */
  const projectSelect = (node: El): El | undefined =>
    findAll((el) => el.type === 'select' && el.props.style?.minWidth === 160, node)[0]

  /** 把表单子组件的内部树也渲染出来（hooks 槽位从顶层渲染用完的位置接着排）。 */
  const renderForm = (): El => {
    const form = formElement()
    assert.ok(form !== undefined, '表单应已在树里')
    cursor = topCursor
    return (form as unknown as { type: (p: Record<string, unknown>) => El }).type(form.props)
  }

  return {
    kit,
    hostUi: () => mod.hostUi(),
    tree: () => tree,
    findAll: (pred: (el: El) => boolean, node?: unknown) => findAll(pred, node ?? tree),
    text,
    buttonWith,
    formElement,
    projectSelect,
    renderForm,
    /** 再 apply 一次，这次带上假的 locale 服务（字典注册与 t 换绑都在这里）。 */
    applyLocale(locale: ReturnType<typeof fakeLocale>) {
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
        locale,
        effect: (factory: () => unknown) => {
          factory()
        },
      })
    },
    /** 跑挂载期副作用（拉数据），然后等 promise 链落地。 */
    async start() {
      for (const fn of effects.splice(0)) fn()
      await tick()
      assert.ok(text().includes(MEMORY.title), '记忆列表应已渲染出来')
    },
    /** 点「添加」打开表单，等 /projects 落地。 */
    async openForm() {
      const add = buttonWith('添加')
      assert.equal(add.length, 1, '工具条上应有且仅有一个添加按钮')
      add[0]!.props.onClick()
      await tick()
      assert.ok(formElement() !== undefined, '点添加后应渲染出表单')
    },
  }
}

const tick = () => new Promise((r) => setTimeout(r, 10))

describe('设置页图标走外壳原子（构建产物 lib/client.js）', () => {
  it('有原语：添加按钮是原生 Button + IconPlusOutlineRegular，文案不带「＋」', async () => {
    const h = mount()
    await h.start()

    const add = h.findAll((el) => el.type === h.kit.Button.render && el.props.variant === 'primary')
    assert.equal(add.length, 1, '添加按钮要渲染成原生 Button')
    assert.equal(add[0]!.props.icon.type, h.kit.IconPlusOutlineRegular, '图标走 Button 的 icon 通道')
    assert.deepEqual(add[0]!.children, ['添加'], '有图标时文案里不再有「＋」')
  })

  it('没有原语：添加按钮仍是自带样式 +「＋ 添加」，不抛错', async () => {
    const h = mount({ withKit: false })
    await h.start()
    assert.equal(h.hostUi(), null, '宿主没有这个模块：组件库按不可用处理，而不是抛错')

    const add = h.buttonWith('＋ 添加')
    assert.equal(add.length, 1, '拿不到原语时必须保留原来的字形文案')
    assert.equal(add[0]!.type, 'button')
    assert.equal(add[0]!.props.className, 'meowmem_btn meowmem_btn_primary')
    assert.equal(
      h.findAll((el) => el.props.icon !== undefined && el.props.icon !== null).length,
      0,
      '降级路径不该出现图标位',
    )
  })

  it('有原语：刷新按钮是原生 Button + IconRefreshOutlineRegular，文案不带「↻」', async () => {
    const h = mount()
    await h.start()

    const refresh = h.findAll((el) => el.type === h.kit.Button.render && el.props.title === '刷新')
    assert.equal(refresh.length, 1, '刷新按钮要渲染成原生 Button')
    assert.equal(refresh[0]!.props.icon.type, h.kit.IconRefreshOutlineRegular)
    assert.deepEqual(refresh[0]!.children, ['刷新'])
  })

  it('没有原语：刷新按钮仍是「↻ 刷新」文字按钮，不抛错', async () => {
    const h = mount({ withKit: false })
    await h.start()
    assert.equal(h.hostUi(), null, '宿主没有这个模块：组件库按不可用处理')

    const refresh = h.findAll((el) => el.type === 'button' && el.props.title === '刷新')
    assert.equal(refresh.length, 1, '刷新按钮只能有一个（工具栏）')
    assert.deepEqual(refresh[0]!.children, ['↻ 刷新'])
  })

  it('有原语：全局徽章用原生 Tag（tone=info），不再手搓 chip', async () => {
    const h = mount()
    await h.start()

    const tags = h.findAll((el) => el.type === h.kit.Tag)
    assert.equal(tags.length, 1, '全局徽章要渲染成原生 Tag')
    assert.equal(tags[0]!.props.tone, 'info', '全局 = 分类信息，不是状态')
    assert.deepEqual(tags[0]!.children, ['全局'])
    assert.equal(h.findAll((el) => el.props.className === 'meowmem_badge_global').length, 0)
  })

  it('没有原语：全局徽章仍是自带 chip，不抛错', async () => {
    const h = mount({ withKit: false })
    await h.start()
    assert.equal(h.hostUi(), null, '宿主没有这个模块：组件库按不可用处理')

    const chips = h.findAll((el) => el.type === 'span' && el.props.className === 'meowmem_badge_global')
    assert.equal(chips.length, 1, '拿不到原生 Tag 时退回手搓 chip')
    assert.deepEqual(chips[0]!.children, ['全局'])
  })

  it('有原语：表单里「选择」按钮是原生 Button + IconChevronDownOutlineRegular，文案不带「▾」', async () => {
    const h = mount()
    await h.start()
    await h.openForm()

    let form = h.renderForm()
    const pick = h.projectSelect(form)
    assert.ok(pick !== undefined, '项目字段默认是下拉选择')
    pick!.props.onChange({ target: { value: '__custom__' } })

    form = h.renderForm()
    const choose = h.findAll((el) => el.type === h.kit.Button.render && el.props.variant === 'ghost', form)
    assert.equal(choose.length, 1, '切到自定义项目后应出现「选择」按钮')
    assert.equal(choose[0]!.props.icon.type, h.kit.IconChevronDownOutlineRegular, '下拉箭头走 Button 的 icon 通道')
    assert.deepEqual(choose[0]!.children, ['选择'])
  })

  it('没有原语：表单里「选择」按钮仍是「▾ 选择」，不抛错', async () => {
    const h = mount({ withKit: false })
    await h.start()
    assert.equal(h.hostUi(), null, '宿主没有这个模块：组件库按不可用处理')
    await h.openForm()

    let form = h.renderForm()
    const pick = h.projectSelect(form)
    assert.ok(pick !== undefined, '项目字段默认是下拉选择')
    pick!.props.onChange({ target: { value: '__custom__' } })

    form = h.renderForm()
    const choose = h.findAll((el) => el.type === 'button' && el.children[0] === '▾ 选择', form)
    assert.equal(choose.length, 1, '拿不到原语时保留原来的字形文案')
  })

  it('locale：无字形文案是独立的键，带字形的旧值逐字节保留，zh/en 键集一致', async () => {
    const locale = fakeLocale('en')
    const h = mount()
    h.applyLocale(locale)

    const { zh, en } = locale.registered[0]!.dicts as Record<string, Record<string, string>>
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh/en 键集必须一致')
    assert.equal(zh.add, '＋ 添加', '带字形的旧值原样保留')
    assert.equal(en.add, '＋ Add')
    assert.equal(zh.refresh, '↻ 刷新')
    assert.equal(en.refresh, '↻ Refresh')
    assert.equal(zh.choose, '▾ 选择')
    assert.equal(en.choose, '▾ Choose')
    assert.equal(zh.addPlain, '添加', '图标路径用无字形文案')
    assert.equal(en.addPlain, 'Add')
    assert.equal(zh.refreshPlain, '刷新')
    assert.equal(en.refreshPlain, 'Refresh')
    assert.equal(zh.choosePlain, '选择')
    assert.equal(en.choosePlain, 'Choose')
    // 空态里引用了「＋ 添加」这个按钮名：图标在位时引用也要跟着无字形。
    assert.equal(zh.emptyGlobal.includes('＋ 添加'), true)
    assert.equal(zh.emptyGlobalPlain.includes('＋'), false)
    assert.equal(en.emptyGlobalPlain.includes('＋'), false)
    assert.equal(zh.emptyWorkspacePlain.includes('＋'), false)
    assert.equal(en.emptyWorkspacePlain.includes('＋'), false)
    assert.equal(zh.emptyGlobalPlain.includes('添加'), true, '无字形版本仍要指得出那个按钮')
    assert.equal(en.emptyWorkspacePlain.includes('Add'), true)
    // 无字形的键里不能出现任何当作图标用的字形，也不能新引入 emoji。
    for (const value of [zh.addPlain, zh.refreshPlain, zh.choosePlain, zh.emptyGlobalPlain, zh.emptyWorkspacePlain]) {
      assert.equal(/[＋▾↻✓✖◈]/u.test(value), false, `无字形文案里不该再有字形：${value}`)
      assert.equal(/[\p{Extended_Pictographic}]/u.test(value), false, `文案不应含 emoji：${value}`)
    }
  })
})

/** 假外壳 locale 服务：与 dsh-client-locale 的 LocaleRuntime 同名同形。 */
function fakeLocale(active: string) {
  const registered: Array<{ ns: string; dicts: Record<string, Record<string, string>> }> = []
  const tables = new Map<string, Record<string, string>>()
  return {
    registered,
    register(ns: string, dicts: Record<string, Record<string, string>>) {
      registered.push({ ns, dicts })
      for (const [id, table] of Object.entries(dicts)) tables.set(`${ns}|${id}`, table)
      return () => {}
    },
    bind(ns: string) {
      return (key: string, params?: Record<string, unknown>) => {
        const table = tables.get(`${ns}|${active}`) ?? {}
        const template = table[key] === undefined ? key : table[key]
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
      }
    },
  }
}
