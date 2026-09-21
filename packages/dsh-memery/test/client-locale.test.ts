// 设置页文案跟随外壳语言（构建产物 lib/client.js）：
//   1. settings.section 的 label 必须是 thunk：外壳 resolveSlotLabel 每次渲染现取，
//      切语言不需要重新注册 slot；
//   2. 字典按命名空间 'dsh-memery' 注册（与 section id 同名），zh/en 键集必须一致 ——
//      半截翻译比不翻译更糟；
//   3. ctx.locale 缺席（旧外壳 / 直接调用 apply）时降级为中文：插件照常注册、照常
//      渲染，不抛错（SlotAssemblyError 那条路绝不踩）。
//
// 做法与 client-refresh.test.ts 一致：bundle 装进 vm，用「假 React」渲染成对象树，
// 从树里断言真正显示出来的文案。
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

/** 假 React：createElement 返回普通对象树，hooks 可调用（够用来驱动一次渲染）。 */
function fakeReact() {
  return {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): El => ({
      type,
      props: props ?? {},
      children: children.flat(),
    }),
    Fragment: Symbol('Fragment'),
    useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => {}],
    useEffect: () => {},
    useCallback: (fn: unknown) => fn,
    useMemo: (fn: () => unknown) => fn(),
    useRef: (v: unknown) => ({ current: v }),
  }
}

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

/** 装载 → apply → 渲染一次，返回注册记录与渲染出来的树。 */
function mount(options: { locale?: ReturnType<typeof fakeLocale> } = {}) {
  const locale = options.locale
  let registration: { id: string; factory: (r: (s: string) => unknown) => any } | null = null
  const registrations: Array<{ def: Record<string, any>; component: (p: Record<string, unknown>) => El }> = []

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
    fetch: async () => ({ json: async () => ({ ok: true, memories: [], workspaces: [], global_count: 0 }) }),
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  new vm.Script(bundle).runInContext(sandbox)

  assert.ok(registration !== null, 'bundle 必须调用 __ModuleLoader__.load')
  const mod = (registration as unknown as { factory: (r: (s: string) => unknown) => any }).factory((spec: string) => {
    if (spec === 'react') return fakeReact()
    throw new Error(`unexpected require: ${spec}`)
  })

  const ctx: Record<string, unknown> = {
    slots: {
      inject: (_name: string, fn: () => unknown) => {
        fn()
        return () => {}
      },
      register: (def: Record<string, any>, component: never) => {
        registrations.push({ def, component })
        return () => {}
      },
    },
  }
  if (locale !== undefined) {
    ctx.locale = locale
    ctx.effect = (factory: () => unknown) => {
      factory()
    }
  }
  const disposer = mod.apply(ctx)
  assert.equal(typeof disposer, 'function', 'apply 应返回清理函数')
  assert.equal(registrations.length, 1, 'apply 必须注册 settings.section')

  const tree = registrations[0]!.component({})
  return { mod, registrations, rendered: JSON.stringify(tree) }
}

describe('设置页文案跟随外壳语言（构建产物 lib/client.js）', () => {
  it('inject 同时声明 slots 与 locale', () => {
    const { mod } = mount()
    // 跨 vm realm：数组先拷回宿主 realm 再比结构。
    assert.deepEqual(Array.from(mod.inject as string[]), ['slots', 'locale'])
  })

  it('注册 zh/en 字典（键集一致），label 是随语言现取的 thunk', () => {
    const locale = fakeLocale('en')
    const { registrations, rendered } = mount({ locale })

    assert.equal(locale.registered.length, 1, '应注册且只注册一个命名空间')
    assert.equal(locale.registered[0]!.ns, 'dsh-memery', '命名空间必须等于 settings.section 的 id')
    const { zh, en } = locale.registered[0]!.dicts as Record<string, Record<string, string>>
    assert.deepEqual(Object.keys(zh!).sort(), Object.keys(en!).sort(), 'zh/en 键集必须一致')
    assert.equal(zh!.nav, '记忆', '中文导航文案')
    assert.equal(en!.nav, 'Memory', '英文导航文案')

    const label = registrations[0]!.def.label
    assert.equal(typeof label, 'function', 'label 必须是 thunk')
    assert.equal(label(), 'Memory', 'label 要跟着当前语言')

    // 渲染出来的界面同样是英文（标题、按钮、占位符、空态）。
    assert.equal(rendered.includes('Memory'), true, `标题应为英文，实际 ${rendered.slice(0, 200)}`)
    assert.equal(rendered.includes('＋ Add'), true, '添加按钮应为英文')
    assert.equal(rendered.includes('Search keywords…'), true, '搜索占位符应为英文')
    assert.equal(rendered.includes('全局库还没有记忆'), false, '不该残留中文空态')
    // 文案里不再出现 pictographic emoji（用户要求：记忆插件不要一堆 emoji）。
    assert.equal(
      /[\p{Extended_Pictographic}]/u.test(zh!.nav + zh!.heading + zh!.edit + zh!.globalOption),
      false,
      'zh 文案不应含 emoji',
    )
    assert.equal(
      /[\p{Extended_Pictographic}]/u.test(en!.nav + en!.heading + en!.edit + en!.globalOption),
      false,
      'en 文案不应含 emoji',
    )
  })

  it('ctx.locale 缺席时降级：照常注册，界面仍是中文', () => {
    const { registrations, rendered } = mount()
    const label = registrations[0]!.def.label
    assert.equal(label(), '记忆')
    assert.equal(rendered.includes('记忆'), true)
    assert.equal(rendered.includes('搜索关键词…'), true)
    assert.equal(rendered.includes('＋ 添加'), true)
  })
})
