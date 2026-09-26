// 无图标按钮的组件库契约（构建产物 lib/client.js）：
//
// 工具条「添加/刷新」、表单「选择」与全局徽章已经走外壳原子；这张单子收尾剩下的
// 手搓按钮 —— 表单的「保存/取消」，卡片上的「编辑/归档/恢复/删除」。它们今天的
// 文案里没有字形，所以**不需要**无字形孪生键：两条路径的字逐字相同，只是画法不同。
//
// 映射（按各自今天的语义挑最接近的视觉族）：
//   保存 = primary（表单主操作，实心高亮）；取消 = outline（次要描边 —— 组件库给
//   对话框 Cancel 的就是这一族）；编辑 = ghost（今天就是无边框文字按钮）；归档 /
//   恢复 = outline（描边中性）；删除 = outline + 错误色文字（组件库没有 danger
//   变体，照外壳自己的写法，见 dsh-skills-manager / dsh-mcp-manager 的 danger 类）。
//
// 两条路径都必须能渲染：拿不到组件库、或这个版本里没有 Button 原子时，逐一退回
// 今天的自带 <button>（同样的类名、文案、处理器、禁用逻辑），且不抛错。
//
// 做法与 client-icons.test.ts 一致：bundle 装进 vm，用「有状态的小 React」渲染成
// 对象树（组件库按需 require，withKit:false 时 require 抛错，omitAtoms 模拟「有
// 组件库但这个原子缺席」）；表单是子组件，测试里直接按元素类型调用它，把内部树
// 也渲染出来。
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

/** 一条活跃记忆 + 一条已归档记忆：同一棵树里同时出现「归档」与「恢复」两个按钮。 */
const ACTIVE = {
  id: 'mem-active',
  level: 'fact',
  title: '活跃记忆',
  content: '活跃记忆正文',
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
const ARCHIVED = { ...ACTIVE, id: 'mem-archived', title: '归档记忆', status: 'archived' }

/** 原生 UI 组件库桩：组件按 identity 在树里认。 */
function kitStub() {
  const marker = (name: string) => {
    const C = (props: Record<string, unknown>) => ({ type: C, props: props ?? {}, children: [] })
    C.displayName = name
    return C
  }
  return {
    RiskConfirmation: marker('RiskConfirmation'),
    Button: marker('Button'),
    Tag: marker('Tag'),
    IconPlusOutline: marker('IconPlusOutline'),
    IconRefreshOutline: marker('IconRefreshOutline'),
    IconChevronDownOutline: marker('IconChevronDownOutline'),
  }
}

/** 装载 → apply → 渲染，返回可直接驱动的小世界。 */
function mount(opts: { withKit?: boolean; omitAtoms?: string[] } = {}) {
  const withKit = opts.withKit !== false
  const kit: Record<string, unknown> = kitStub()
  for (const name of opts.omitAtoms ?? []) delete kit[name]
  const posts: string[] = []
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
    fetch: async (url: string, init?: { method?: string }) => {
      const u = String(url)
      if (init?.method === 'POST') posts.push(u)
      if (u.startsWith('/dsh-memery/workspaces')) {
        return json({ ok: true, workspaces: [{ workspace: 'E:/proj', count: 2 }], global_count: 2 })
      }
      if (u.startsWith('/dsh-memery/projects')) return json({ ok: true, projects: ['全局', 'proj'] })
      if (u.startsWith('/dsh-memery/memories')) return json({ ok: true, memories: [ACTIVE, ARCHIVED] })
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

  /** 按钮文案命中：文案可能带字形前缀（'＋ 添加'、'↻ 刷新'），按子串认。 */
  const hasLabel = (el: El, label: string): boolean =>
    el.children.some((c) => typeof c === 'string' && c.includes(label))

  /** 组件库路径的按钮（原生 Button）。 */
  const kitButtons = (label?: string, node?: unknown): El[] =>
    findAll((el) => el.type === kit.Button && (label === undefined || hasLabel(el, label)), node ?? tree)

  /** 降级路径的按钮（自带 <button>）。 */
  const plainButtons = (label?: string, node?: unknown): El[] =>
    findAll((el) => el.type === 'button' && (label === undefined || hasLabel(el, label)), node ?? tree)

  /** 两条路径都认的按钮：按文案找（组件库路径是 Button，降级路径是 <button>）。 */
  const anyButtons = (label: string, node?: unknown): El[] =>
    findAll((el) => (el.type === 'button' || el.type === kit.Button) && hasLabel(el, label), node ?? tree)

  /** 表单子组件元素（打开表单后才在树里）。 */
  const formElement = (): El | undefined =>
    findAll((el) => typeof el.type === 'function' && 'projectOptions' in el.props)[0]

  /** 把表单子组件的内部树也渲染出来（hooks 槽位从顶层渲染用完的位置接着排）。 */
  const renderForm = (): El => {
    const form = formElement()
    assert.ok(form !== undefined, '表单应已在树里')
    cursor = topCursor
    return (form as unknown as { type: (p: Record<string, unknown>) => El }).type(form.props)
  }

  return {
    kit,
    mod,
    posts,
    hostUi: () => mod.hostUi(),
    hostPlainButton: mod.hostPlainButton as ((props: Record<string, unknown>) => El) | undefined,
    tree: () => tree,
    findAll: (pred: (el: El) => boolean, node?: unknown) => findAll(pred, node ?? tree),
    kitButtons,
    plainButtons,
    anyButtons,
    formElement,
    renderForm,
    /** 跑挂载期副作用（拉数据），然后等 promise 链落地。 */
    async start() {
      for (const fn of effects.splice(0)) fn()
      await tick()
      assert.ok(
        findAll((el) => el.type === 'div' && el.props.className === 'meowmem_card').length === 2,
        '两条记忆都应渲染成卡片',
      )
    },
    /** 点工具条「＋ 添加 / 添加」打开表单，等 /projects 落地。 */
    async openForm() {
      const add = anyButtons('添加')
      assert.equal(add.length, 1, '工具条上应有且仅有一个添加按钮')
      add[0]!.props.onClick()
      await tick()
      assert.ok(formElement() !== undefined, '点添加后应渲染出表单')
    },
  }
}

const tick = () => new Promise((r) => setTimeout(r, 10))

describe('设置页无图标按钮走外壳原子（构建产物 lib/client.js）', () => {
  it('有原语：表单「保存」是原生 Button（primary），文案仍是「保存」', async () => {
    const h = mount()
    await h.start()
    await h.openForm()
    const form = h.renderForm()

    const save = h.kitButtons('保存', form)
    assert.equal(save.length, 1, '保存按钮要渲染成原生 Button')
    assert.equal(save[0]!.props.variant, 'primary', '保存是表单主操作，对应实心的 primary 族')
    assert.equal(save[0]!.props.size, 'sm')
    assert.equal(save[0]!.props.disabled, false, '空闲时不禁用')
    assert.equal(save[0]!.props.className, undefined, '原生路径不叠自带按钮样式，两套皮肤不混用')
    assert.equal(h.plainButtons('保存', form).length, 0, '原生路径不该再手搓 <button>')
  })

  it('有原语：表单「取消」是原生 Button（outline）', async () => {
    const h = mount()
    await h.start()
    await h.openForm()
    const form = h.renderForm()

    const cancel = h.kitButtons('取消', form)
    assert.equal(cancel.length, 1, '取消按钮要渲染成原生 Button')
    assert.equal(cancel[0]!.props.variant, 'outline', '取消是次要操作：描边中性，正是组件库给对话框 Cancel 的族')
    assert.equal(cancel[0]!.props.disabled, false)
    assert.equal(h.plainButtons('取消', form).length, 0)
  })

  it('有原语：卡片「编辑」是原生 Button（ghost），今天它就是无边框文字按钮', async () => {
    const h = mount()
    await h.start()

    const edit = h.kitButtons('编辑')
    assert.equal(edit.length, 2, '两条记忆 = 两个编辑按钮')
    assert.equal(edit[0]!.props.variant, 'ghost', '无边框文字按钮对应 ghost 族')
    assert.equal(edit[0]!.props.disabled, false)
    assert.equal(h.plainButtons('编辑').length, 0)
  })

  it('有原语：卡片「归档」「恢复」是原生 Button（outline）', async () => {
    const h = mount()
    await h.start()

    const archive = h.kitButtons('归档')
    assert.equal(archive.length, 1, '只有活跃那条卡片有「归档」')
    assert.equal(archive[0]!.props.variant, 'outline', '归档是描边中性操作')
    const restore = h.kitButtons('恢复')
    assert.equal(restore.length, 1, '只有已归档那条卡片有「恢复」')
    assert.equal(restore[0]!.props.variant, 'outline')

    assert.equal(h.plainButtons('归档').length, 0)
    assert.equal(h.plainButtons('恢复').length, 0)
  })

  it('有原语：卡片「删除」是原生 Button（outline）+ 错误色文字，组件库没有 danger 变体', async () => {
    const h = mount()
    await h.start()

    const del = h.kitButtons('删除')
    assert.equal(del.length, 2, '两条记忆各一个删除按钮')
    assert.equal(del[0]!.props.variant, 'outline', '破坏性操作照外壳自己的写法：outline 打底')
    assert.equal(del[0]!.props.className, 'meowmem_btn_danger_text', '危险信号落在文字颜色上')
    assert.equal(h.plainButtons('删除').length, 0)
  })

  it('红字有作用域样式：只给组件库按钮上色，不动降级路径的自带类', () => {
    assert.ok(
      bundle.includes('.meowmem_set_page button.meowmem_btn_danger_text{color:var(--dsw-alias-state-error-primary)}'),
      'kit 路径的删除按钮需要作用域化的错误色规则（特异性高过组件库的 .button）',
    )
  })

  it('有原语：禁用逻辑与处理器不变（开表单后卡片编辑禁用；点归档照样发更新请求）', async () => {
    const h = mount()
    await h.start()
    await h.openForm()

    const edit = h.kitButtons('编辑')
    assert.equal(edit.length, 2)
    assert.equal(edit[0]!.props.disabled, true, '表单打开时卡片按钮照旧禁用（busy || form !== null）')

    h.kitButtons('归档')[0]!.props.onClick()
    await tick()
    assert.ok(
      h.posts.some((u) => u.startsWith('/dsh-memery/memory-update')),
      `归档处理器要照旧发 memory-update，实际 ${h.posts.join(' | ')}`,
    )
  })

  it('有原语：点原生「删除」弹的还是原生 RiskConfirmation', async () => {
    const h = mount()
    await h.start()
    h.kitButtons('删除')[0]!.props.onClick()

    const rc = h.findAll((el) => el.type === h.kit.RiskConfirmation)[0]
    assert.ok(rc !== undefined, '删除处理器要照旧打开确认框')
    assert.equal(rc!.props.open, true)
  })

  it('没有原语：六个按钮逐一退回今天的自带 <button>（类名/文案/禁用逻辑逐字保留），不抛错', async () => {
    const h = mount({ withKit: false })
    await h.start()
    assert.equal(h.hostUi(), null, '宿主没有这个模块：组件库按不可用处理，而不是抛错')

    assert.equal(h.plainButtons('编辑')[0]!.props.className, 'meowmem_btn meowmem_btn_text', '编辑今天就是文字按钮')
    assert.equal(h.plainButtons('归档')[0]!.props.className, 'meowmem_btn')
    assert.equal(h.plainButtons('恢复')[0]!.props.className, 'meowmem_btn')
    assert.equal(h.plainButtons('删除')[0]!.props.className, 'meowmem_btn meowmem_btn_danger')
    assert.equal(h.plainButtons('删除')[0]!.props.disabled, false)

    await h.openForm()
    const form = h.renderForm()
    assert.equal(h.plainButtons('保存', form)[0]!.props.className, 'meowmem_btn meowmem_btn_primary')
    assert.equal(h.plainButtons('保存', form)[0]!.children[0], '保存')
    assert.equal(h.plainButtons('取消', form)[0]!.props.className, 'meowmem_btn')
    assert.equal(h.plainButtons('取消', form)[0]!.children[0], '取消')

    assert.equal(
      h.findAll((el) => el.props.variant !== undefined).length,
      0,
      '降级路径不该出现组件库的 props（variant/size/icon）',
    )
    assert.equal(h.kitButtons().length, 0, '降级路径不该出现组件库按钮')
  })

  it('没有原语：降级路径的处理器与禁用逻辑照旧（开表单后编辑禁用；点删除走 window.confirm）', async () => {
    const h = mount({ withKit: false })
    await h.start()
    await h.openForm()

    assert.equal(h.plainButtons('编辑')[0]!.props.disabled, true, '表单打开时卡片按钮照旧禁用')

    h.plainButtons('归档')[0]!.props.onClick()
    await tick()
    assert.ok(
      h.posts.some((u) => u.startsWith('/dsh-memery/memory-update')),
      '归档处理器照旧',
    )

    h.plainButtons('删除')[0]!.props.onClick()
    await tick()
    assert.ok(
      h.posts.some((u) => u.startsWith('/dsh-memery/memory-delete')),
      '取不到组件库时删除退回 window.confirm',
    )
  })

  it('有原语但没有 Button 原子：六个按钮同样退回自带 button，工具条也逐原子降级', async () => {
    const h = mount({ omitAtoms: ['Button'] })
    await h.start()
    assert.equal(h.kit.Button, undefined, '前置：组件库在，但没有 Button 这个原子')

    assert.equal(h.plainButtons('编辑')[0]!.props.className, 'meowmem_btn meowmem_btn_text')
    assert.equal(h.plainButtons('归档')[0]!.props.className, 'meowmem_btn')
    assert.equal(h.plainButtons('恢复')[0]!.props.className, 'meowmem_btn')
    assert.equal(h.plainButtons('删除')[0]!.props.className, 'meowmem_btn meowmem_btn_danger')
    // 工具条那条本来就有的守卫同样不受影响（逐原子判，不回退成「有没有组件库」）。
    assert.equal(
      h.findAll((el) => el.type === 'button' && el.children.includes('＋ 添加')).length,
      1,
      '没有 Button 原子时，添加按钮退回带字形的自带按钮',
    )
    await h.openForm()
    const form = h.renderForm()
    assert.equal(h.plainButtons('保存', form)[0]!.props.className, 'meowmem_btn meowmem_btn_primary')
    assert.equal(h.plainButtons('取消', form)[0]!.props.className, 'meowmem_btn')
  })

  it('降级：seam 直接给出今天的 <button>（导出供测试断言降级前提，与 hostUi 同理）', () => {
    const h = mount({ withKit: false })
    assert.equal(typeof h.hostPlainButton, 'function', '无图标按钮的 seam 必须导出')

    let clicked = 0
    const node = h.hostPlainButton!({
      variant: 'primary',
      className: 'meowmem_btn meowmem_btn_primary',
      label: '保存',
      disabled: true,
      onClick: () => {
        clicked += 1
      },
    })
    assert.equal(node.type, 'button')
    assert.equal(node.props.className, 'meowmem_btn meowmem_btn_primary')
    assert.equal(node.props.disabled, true)
    assert.deepEqual(node.children, ['保存'])
    node.props.onClick()
    assert.equal(clicked, 1, '处理器原样透传')

    const danger = h.hostPlainButton!({
      variant: 'outline',
      className: 'meowmem_btn meowmem_btn_danger',
      kitClassName: 'meowmem_btn_danger_text',
      label: '删除',
      disabled: false,
      onClick: () => {},
    })
    assert.equal(danger.props.className, 'meowmem_btn meowmem_btn_danger', '降级路径不认 kit 专属 class')
  })

  it('locale：这六个按钮没有字形，不需要新键；zh/en 键集一致且仍是 77 键', () => {
    const locale = fakeLocale('en')
    const h = mount()
    h.mod.apply({
      slots: {
        inject: (_name: string, fn: () => unknown) => {
          fn()
          return () => {}
        },
        register: () => () => {},
      },
      locale,
      effect: (factory: () => unknown) => {
        factory()
      },
    })

    const { zh, en } = locale.registered[0]!.dicts as Record<string, Record<string, string>>
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh/en 键集必须一致')
    assert.equal(Object.keys(zh).length, 77, '这次转换不该增删字典键')
    // 六个按钮的文案两条路径共用同一个键：值逐字保留（原本就没有字形，不需要孪生键）。
    assert.deepEqual(
      ['save', 'saving', 'cancel', 'edit', 'archive', 'restore', 'del'].map((k) => [k, zh[k], en[k]]),
      [
        ['save', '保存', 'Save'],
        ['saving', '保存中…', 'Saving…'],
        ['cancel', '取消', 'Cancel'],
        ['edit', '编辑', 'Edit'],
        ['archive', '归档', 'Archive'],
        ['restore', '恢复', 'Restore'],
        ['del', '删除', 'Delete'],
      ],
    )
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
