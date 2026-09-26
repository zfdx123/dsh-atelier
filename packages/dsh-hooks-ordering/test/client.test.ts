import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The client half is a classic script with no exports: it announces itself to
 * the harness by calling `window.__ModuleLoader__.load`, exactly as it does in
 * the browser. These tests give it a stub window, a stub React and a stub
 * `document`, then assert the contract the loader depends on.
 */

interface Registration {
  id: string
  factory: (require: (name: string) => unknown) => {
    apply: (ctx: unknown) => void
    inject: string[]
    NS: string
    ZH: Record<string, string>
    EN: Record<string, string>
    UI: unknown
    UI_ERROR: string
    SettingsSection: (props: unknown) => unknown
    saveFailedStatus: (message: string) => unknown
    fromLines: (text: unknown) => string[]
    toLines: (value: unknown) => string
    sameLines: (value: unknown, text: unknown) => boolean
    pickEntry: (list: { ns: string }[]) => { ns: string } | undefined
    unwrapRemote: (answer: unknown) => { ok: boolean; value?: unknown; reason?: string }
  }
}

/** The module-table entry the shell kit lives under (a baseline module). */
const PRIMITIVES = '@deepseek-ai/dsh-client-ui-primitives'

/** A rendered element of the fake React tree. */
interface El {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

const isEl = (node: unknown): node is El =>
  typeof node === 'object' && node !== null && 'type' in node && 'props' in node

const noop = (): void => {}

/**
 * The React double. Besides `createElement` it drives a single mounted
 * component far enough for the settings page to load: `useState` returns a
 * working setter, `useEffect` runs on mount (once) and thereafter whenever its
 * dependency list changes, and pending promises can be flushed. That is what
 * lets a test observe the page after its async descriptor read, which the
 * 0.1.7 Remote requires (`describe()` is not synchronous).
 */
function createReactDouble() {
  interface Mount {
    states: unknown[]
    setters: ((next: unknown) => void)[]
    effects: { deps: unknown[] | undefined; cleanup: (() => void) | undefined }[]
    refs: { current: unknown }[]
    /** Hook position within the current render; React's own bookkeeping. */
    cursor: number
  }
  let active: Mount | null = null

  const freshMount = (): Mount => ({ states: [], setters: [], effects: [], refs: [], cursor: 0 })

  /** The mount a render writes into; one is created for a standalone render. */
  const currentMountForRender = (): Mount => {
    if (active === null) active = freshMount()
    return active
  }

  const depsChanged = (previous: unknown[] | undefined, next: unknown[] | undefined): boolean => {
    if (previous === undefined || next === undefined) return true
    if (previous.length !== next.length) return true
    return previous.some((value, index) => !Object.is(value, next[index]))
  }

  const react = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
      type,
      // children also ride props.children, as React does: the kit stand-in needs
      // them to forward its own children back into the tree.
      props: { ...(props as Record<string, unknown> | undefined), children },
      children,
    }),
    useState: (initial: unknown) => {
      const current = currentMountForRender()
      const index = current.cursor
      current.cursor += 1
      // React's lazy initializer: a function is the initial value only when it
      // is passed as the factory, so resolve it rather than storing the function.
      if (index >= current.states.length) {
        current.states[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
      }
      const setter = (next: unknown): void => {
        current.states[index] =
          typeof next === 'function' ? (next as (prev: unknown) => unknown)(current.states[index]) : next
      }
      if (index >= current.setters.length) current.setters[index] = setter
      return [current.states[index], current.setters[index]]
    },
    useEffect: (callback: () => unknown, deps?: unknown[]) => {
      const current = currentMountForRender()
      const slot = current.cursor
      current.cursor += 1
      const previous = current.effects[slot]
      const run = (): void => {
        current.effects[slot] = { deps, cleanup: (callback() as (() => void) | undefined) ?? undefined }
      }
      if (previous === undefined || depsChanged(previous.deps, deps)) run()
    },
    useRef: (initial: unknown) => {
      const current = currentMountForRender()
      const slot = current.cursor
      current.cursor += 1
      if (current.refs[slot] === undefined) current.refs[slot] = { current: initial }
      return current.refs[slot]
    },
  }

  return {
    react,
    /**
     * Render a component, run its effects, let every pending promise settle,
     * then render again so the tree reflects state the effects set.
     * @param render - renders the component and returns its output.
     * @returns the settled tree plus a function that renders once more.
     */
    async mountAndFlush<T>(render: () => T): Promise<{ tree: T; rerender: () => T }> {
      const renderOnce = (): T => {
        const current = currentMountForRender()
        current.cursor = 0
        return render()
      }
      renderOnce()
      // Effects can queue more promises (a subscribe callback, a second read);
      // flush until the component stops adding work.
      for (let round = 0; round < 6; round += 1) {
        await Promise.resolve()
        await Promise.resolve()
      }
      return { tree: renderOnce(), rerender: renderOnce }
    },
  }
}

/**
 * The shell primitives' stand-in.
 *
 * The real module cannot be loaded here (the shell's module table hands it over
 * in the browser, and it depends on CSS modules), so a recording stand-in takes
 * its place: every atom is a function carrying `primitiveName`, and the tests
 * assert by **identity** (`node.type === kit.Button`) that the shell component
 * is what got rendered — not by guessing at a string name.
 */
function fakePrimitives(): Record<string, unknown> {
  const make = (name: string): ((props?: Record<string, unknown>) => El) => {
    const Primitive = (props?: Record<string, unknown>): El => ({
      type: `ui:${name}`,
      props: props ?? {},
      children: (props?.children as unknown[] | undefined) ?? [],
    })
    ;(Primitive as unknown as Record<string, unknown>).primitiveName = name
    return Primitive
  }
  /**
   * `Button` in the shell is a `React.forwardRef(...)` OBJECT (`$$typeof` +
   * `render`), not a plain function. A stand-in that made it a function is what
   * let the `typeof primitives.Button === 'function'` guard bug stay green here
   * while it threw the whole kit away in production: `typeof` is `'object'` for a
   * forwardRef, so the conjunction was permanently false.
   */
  const forwardRef = (name: string): Record<string, unknown> => ({
    $$typeof: Symbol.for('react.forward_ref'),
    render: (props?: Record<string, unknown>): El => ({
      type: `ui:${name}`,
      props: props ?? {},
      children: (props?.children as unknown[] | undefined) ?? [],
    }),
    primitiveName: name,
  })
  return {
    Button: forwardRef('Button'),
    Input: make('Input'),
    Switch: make('Switch'),
    Tag: make('Tag'),
    StateDot: make('StateDot'),
  }
}

/** Collect every element whose `type` is `target`, in render order (identity compare). */
function collectByType(node: unknown, target: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    node.forEach((child) => collectByType(child, target, out))
    return out
  }
  if (!isEl(node)) return out
  // Identity first: the kit atoms are function components themselves, so they would
  // disappear into the "render once" branch below before being compared.
  if (node.type === target) out.push(node)
  if (typeof node.type === 'function') {
    // Function components render: the plugin's own components have to be expanded
    // to see what is inside them, and an atom stand-in hands its children back.
    collectByType((node.type as (props: unknown) => unknown)(node.props), target, out)
    return out
  }
  collectByType(node.children, target, out)
  return out
}

/** The visible copy of an element: its string descendants joined. */
function textOf(node: unknown): string {
  return collectText(node).join('')
}

/** Every visible string in the tree, in render order. */
function collectText(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    node.forEach((child) => collectText(child, out))
    return out
  }
  if (!isEl(node)) return out
  if (typeof node.type === 'function') {
    collectText((node.type as (props: unknown) => unknown)(node.props), out)
    return out
  }
  collectText(node.children, out)
  return out
}

/** Captured from the one execution of the classic script. */
let captured: Registration | undefined

/** Load client.js the way the browser loader does and return its registration. */
async function loadClient(): Promise<Registration> {
  // The script registers itself exactly once per module instance, so the first
  // call performs the load and every later call reuses what it captured.
  if (captured !== undefined) return captured
  const g = globalThis as unknown as Record<string, unknown>
  const styleElement = { id: '', textContent: '', remove: noop }
  g.document = {
    getElementById: () => undefined,
    createElement: () => styleElement,
    head: { appendChild: noop },
  }
  g.window = {
    __ModuleLoader__: {
      load: (value: Registration) => {
        captured = value
      },
    },
  }
  // A variable specifier keeps TypeScript from type-checking the classic script.
  const clientPath = '../client.js'
  await import(clientPath)
  if (captured === undefined) throw new Error('client.js did not register with the module loader')
  return captured
}

/** A context that records what the plugin registers. */
function recordingContext(): { ctx: unknown; sections: { options: Record<string, unknown> }[] } {
  const sections: { options: Record<string, unknown> }[] = []
  const ctx = {
    effect: (callback: () => () => void) => callback(),
    remote: { settings: fakeSettingsRemote(null).remote },
    slots: {
      inject: (_name: string, callback: () => unknown) => callback(),
      register: (options: Record<string, unknown>) => {
        sections.push({ options })
        return noop
      },
    },
  }
  return { ctx, sections }
}

type Dicts = Record<string, Record<string, string>>

/**
 * A context whose locale service records the registered dictionaries and
 * answers in one fixed language, so the label thunk can be observed switching.
 */
function localeContext(active: 'zh' | 'en'): {
  ctx: unknown
  sections: { options: Record<string, unknown> }[]
  registered: { ns: string; dicts: Dicts }[]
  effects: (string | undefined)[]
} {
  const sections: { options: Record<string, unknown> }[] = []
  const registered: { ns: string; dicts: Dicts }[] = []
  const effects: (string | undefined)[] = []
  const ctx = {
    effect: (callback: () => () => void, label?: string) => {
      effects.push(label)
      return callback()
    },
    remote: { settings: fakeSettingsRemote(null).remote },
    locale: {
      register: (ns: string, dicts: Dicts) => {
        registered.push({ ns, dicts })
        return noop
      },
      bind: (ns: string) => (key: string, params?: Record<string, unknown>) => {
        const template = registered.find((entry) => entry.ns === ns)?.dicts[active]?.[key] ?? key
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
      },
    },
    slots: {
      inject: (_name: string, callback: () => unknown) => callback(),
      register: (options: Record<string, unknown>) => {
        sections.push({ options })
        return noop
      },
    },
  }
  return { ctx, sections, registered, effects }
}

/**
 * Load the factory with a module table that answers the primitives entry as told.
 *
 * @param primitives - the kit to hand back for the primitives entry, or `'missing'`.
 * @param react - the React double this module instance should use. Pass one in
 * when the test needs to drive the component (a double created here would be
 * invisible to the caller).
 */
async function moduleWith(
  primitives: unknown | 'missing',
  react?: unknown,
): Promise<ReturnType<Registration['factory']>> {
  const registration = await loadClient()
  return registration.factory((name) => {
    if (name === PRIMITIVES) {
      if (primitives === 'missing') throw new Error(`client-modules: no module registered for ${name}`)
      return primitives
    }
    return react ?? createReactDouble().react
  })
}

/** One settings-entry view, in the shape the settings Remote answers with. */
interface NamespaceView {
  ns: string
  schema?: unknown
  value: unknown
  revision: number
  autoGenerate?: boolean
  applies?: string
}

/** A fake `ctx.remote.settings`, recording the writes the page sends. */
function fakeSettingsRemote(
  view: NamespaceView | null,
  { writable = true } = {},
): { remote: Record<string, unknown>; calls: { ns: string; ops: unknown; revision: unknown }[] } {
  const calls: { ns: string; ops: unknown; revision: unknown }[] = []
  const remote = {
    describe: async () => ({
      writable,
      hasDocument: true,
      namespaces: view === null ? [] : [view],
    }),
    mutate: async (ns: string, ops: unknown, revision: unknown) => {
      calls.push({ ns, ops, revision })
      return view
    },
    $on: () => noop,
  }
  return { remote, calls }
}

/** The plugin context the section component reads `ctx.remote` from. */
function sectionContext(writable = true, view?: NamespaceView | null): unknown {
  const entry: NamespaceView | null =
    view === undefined
      ? {
          ns: 'hooks-ordering',
          value: { hooks: ['auth'], serialHooks: ['log', 'metrics'], log: '/tmp/hooks-ordering.log' },
          revision: 1,
        }
      : view
  const { remote } = fakeSettingsRemote(entry, { writable })
  return {
    effect: (callback: () => () => void) => callback(),
    remote: { settings: remote },
    slots: { inject: (_name: string, callback: () => unknown) => callback(), register: () => noop },
  }
}

/**
 * Props for {@link Registration.SettingsSection}: the plugin context plus the
 * view the host already resolved. Against the real shell only `ctx` is passed
 * (the page then reads the Remote); supplying `settingsSnapshot` is what a
 * synchronous host — or a test — does.
 */
function sectionProps(writable = true, view?: NamespaceView | null): Record<string, unknown> {
  const entry: NamespaceView | null =
    view === undefined
      ? {
          ns: 'hooks-ordering',
          value: { hooks: ['auth'], serialHooks: ['log', 'metrics'], log: '/tmp/hooks-ordering.log' },
          revision: 1,
        }
      : view
  return {
    ctx: sectionContext(writable, view),
    settingsSnapshot:
      entry === null
        ? { status: 'unavailable', writable: false, value: null, revision: undefined }
        : { status: 'ready', writable, value: entry.value, revision: entry.revision },
  }
}

/**
 * Render a settings section twice over one mount.
 *
 * The first render runs the effects; the component seeds its editor draft from
 * the snapshot in an effect, so only the second render shows the seeded
 * controls. This mirrors React, which re-renders after an effect calls a
 * setter.
 *
 * @param render - renders the component and returns its element tree.
 * @returns the second render's tree.
 */
function renderSettingsSection<T>(render: () => T): T {
  render()
  return render()
}

describe('the client half', () => {
  it('点「恢复组合默认」发出三个 unset，且不报错', async () => {
    // 半个回归。「恢复组合默认无效」的根因在 `settle()` 的成功分支：它只把
    // `dirtyRef.current` 置回 false，而**没有触发重新播种**——`dirtyRef` 是 ref，
    // 写它不会重渲染，重新播种的 effect 又键在 `[revision, snap]`，reset 把值清回
    // `{}` 时 revision 不一定要动，于是表单一直显示刚被重置掉的那份值。修法是成功
    // 时额外 bump 一个 `seedToken` 把它算进 effect 的键。
    //
    // 「界面真的变空」那一段由浏览器验证（见提交说明）：这里的 React 替身只有
    // 位置游标，嵌套组件的 state 槽不可靠，用它断言重渲染后的文本会得到假结论
    // ——这条测试上一版就是这么被骗的。所以这里只锁定替身能可靠证明的部分：
    // 三个字段各发一条 unset，且失败横幅不出现。
    const view: NamespaceView = {
      ns: 'hooks-ordering',
      value: { hooks: ['agent/pre-step', 'agent/custom'], serialHooks: ['agent/turn-stopping'], log: '/tmp/x.log' },
      revision: 1,
    }
    const cleared: NamespaceView = { ns: 'hooks-ordering', value: {}, revision: 1 }
    const calls: { ns: string; ops: unknown }[] = []
    let onDocumentUpdated: () => void = noop
    const remote: Record<string, unknown> = {
      describe: async () => ({ writable: true, hasDocument: true, namespaces: [view] }),
      mutate: async (ns: string, ops: unknown) => {
        calls.push({ ns, ops })
        onDocumentUpdated()
        return { ok: true, value: cleared }
      },
      $on: (event: string, listener: () => void) => {
        if (event === 'settings/document-updated') onDocumentUpdated = listener
        return noop
      },
    }
    const ctx: unknown = {
      effect: (callback: () => () => void) => callback(),
      remote: { settings: remote },
      slots: { inject: (_name: string, callback: () => unknown) => callback(), register: () => noop },
    }

    const double = createReactDouble()
    const mod = (await loadClient()).factory(() => double.react)
    const mounted = await double.mountAndFlush(() => mod.SettingsSection({ ctx }) as unknown)

    const resetButton = collectByType(mounted.tree, 'button').filter((b) => textOf(b).includes('恢复'))[0]
    expect(resetButton).toBeDefined()
    ;(resetButton.props.onClick as () => void)()

    let tree = mounted.rerender()
    for (let round = 0; round < 12; round += 1) {
      await Promise.resolve()
      tree = mounted.rerender()
    }

    // 一次 mutate，三个字段各一条 unset（回到 schema 默认），一个 set 都没有
    expect(calls.length).toBe(1)
    expect(calls[0].ns).toBe('hooks-ordering')
    const ops = calls[0].ops as { op: string; path: string[] }[]
    expect(ops.map((op) => `${op.op}:${op.path.join('.')}`)).toEqual([
      'unset:hooks',
      'unset:serialHooks',
      'unset:log',
    ])

    // 写入成功就不该出现失败横幅
    expect(collectText(tree).join(' ')).not.toContain('保存失败')
  })

  it('registers under the package name, which is what the loader asserts', async () => {
    const registration = await loadClient()
    expect(registration.id).toBe('@zfdx123/dsh-hooks-ordering')
  })

  it('exposes apply + inject once the factory is called with require', async () => {
    const registration = await loadClient()
    const mod = registration.factory(() => createReactDouble().react)
    expect(mod.inject).toEqual(['slots', 'remote', 'remote.settings', 'locale'])
    expect(typeof mod.apply).toBe('function')
  })

  // Regression: the Remote answers with a `RemoteResult` envelope
  // (`{ok:true, value}`) and the client proxy does NOT unwrap it. Reading
  // `answer.namespaces` straight off the answer got `undefined`, which the page
  // reported as "describe() returned no namespaces array" even though the wire
  // exchange was healthy (ok:true, 20 namespaces, including this plugin's).
  it('unwraps the RemoteResult envelope instead of reading fields off it', async () => {
    const mod = (await loadClient()).factory(() => createReactDouble().react)

    const payload = { writable: true, namespaces: [{ ns: 'dsh-plugin-hooks-ordering' }] }
    // the shape the runtime actually delivers
    expect(mod.unwrapRemote({ ok: true, value: payload })).toEqual({ ok: true, value: payload })
    // a refusal must surface as a reason, not as a silent empty form
    const refused = mod.unwrapRemote({ ok: false, error: { code: 'gateway/internal', message: 'boom' } })
    expect(refused.ok).toBe(false)
    expect(String(refused.reason)).toContain('gateway/internal')
    expect(String(refused.reason)).toContain('boom')
    // a plain value keeps working if a future runtime unwraps for us
    expect(mod.unwrapRemote(payload)).toEqual({ ok: true, value: payload })
  })


  // the row that mounted this plugin. The shipped aggregator row is
  // `dsh-plugin-hooks-ordering` while this package's own patch says
  // `hooks-ordering`, so matching on a constant left the form empty ("no
  // settings entry is named …") and every write was refused with
  // `settings/rejected: No configurable plugin entry "hooks-ordering"`.
  it('按值形状认领设置条目，不靠名字猜（含 include 前缀形态）', async () => {
    const mod = (await loadClient()).factory(() => createReactDouble().react)

    // 线上宿主真实返回的条目形状：本插件的是 {hooks, serialHooks, log}，
    // 其余条目的键都不同。名字一律不参与判断 —— 设置 ns 是 loader 条目 id，
    // 由挂载这一行的东西决定，根下挂是 `dsh-plugin-hooks-ordering`，挂在
    // `include` 分组下就变成 `include:dsh-plugin-hooks-ordering`。
    const live = [
      { ns: 'agent-default-model', value: { provider: 'x', model: 'y', reasoningEffort: 'max' } },
      { ns: 'ui-theme', value: { preference: 'light', fontSize: 14 } },
      { ns: 'dsh-mcp-manager', value: { servers: [] } },
      { ns: 'dsh-skills-manager', value: { customSkillDirs: [] } },
      { ns: 'include:dsh-plugin-hooks-ordering', value: { hooks: [], serialHooks: [], log: '' } },
    ]
    expect(mod.pickEntry(live)?.ns).toBe('include:dsh-plugin-hooks-ordering')

    // 根下挂载（无前缀）同样认得出
    expect(mod.pickEntry([{ ns: 'other', value: { servers: [] } }, { ns: 'x', value: { hooks: [] } }])?.ns).toBe('x')

    // 只投影用户设过的键时也要认得出（log 不在就是 log 没设过）
    expect(mod.pickEntry([{ ns: 'y', value: { hooks: ['a'], serialHooks: ['b'] } }])?.ns).toBe('y')

    // 认不出的一律 undefined，绝不赌一个名字写上去
    expect(mod.pickEntry([])).toBeUndefined()
    expect(mod.pickEntry(undefined)).toBeUndefined()
    expect(mod.pickEntry([{ ns: 'agent-default-model', value: { provider: 'x' } }])).toBeUndefined()
    // 空对象不能匹配任何 schema
    expect(mod.pickEntry([{ ns: 'empty', value: {} }])).toBeUndefined()
    // 非对象值
    expect(mod.pickEntry([{ ns: 'z', value: 'hooks' }])).toBeUndefined()
    // 同档歧义 → 拒绝
    expect(mod.pickEntry([{ ns: 'a', value: { hooks: [] } }, { ns: 'b', value: { serialHooks: [] } }])).toBeUndefined()
  })

  it('never injects the removed `settingsScope` service', async () => {
    // Regression: 0.1.7 removed `settingsScope`. While it was still named here
    // cordis reported the plugin as `pending (waiting for service:
    // settingsScope)` forever, the settings page never appeared, and the shell
    // surfaced the whole composition as "Failed to load plugins".
    const mod = (await loadClient()).factory(() => createReactDouble().react)
    expect(mod.inject).not.toContain('settingsScope')
    // The replacement is the settings Remote namespace.
    expect(mod.inject).toContain('remote.settings')
  })

  it('contributes one settings page for the hooks-ordering namespace', async () => {
    const registration = await loadClient()
    const mod = registration.factory(() => createReactDouble().react)
    const { ctx, sections } = recordingContext()
    mod.apply(ctx)
    expect(sections).toHaveLength(1)
    expect(sections[0]!.options).toMatchObject({
      name: 'settings.section',
      id: 'hooks-ordering',
      order: 27,
    })
    // No locale service in this context: the label falls back to the Chinese copy.
    expect((sections[0]!.options.label as () => string)()).toBe('钩子排序')
  })

  it('registers a bilingual dictionary on the effect, under the settings namespace', async () => {
    const registration = await loadClient()
    const mod = registration.factory(() => createReactDouble().react)
    const { ctx, registered, effects } = localeContext('zh')
    mod.apply(ctx)
    expect(registered).toHaveLength(1)
    expect(registered[0]!.ns).toBe('hooks-ordering')
    expect(Object.keys(registered[0]!.dicts)).toHaveLength(2)
    expect(Object.keys(registered[0]!.dicts)).toEqual(expect.arrayContaining(['en', 'zh']))
    // Bilingual balance: the two dictionaries must carry the same key set.
    expect(new Set(Object.keys(registered[0]!.dicts.en!))).toEqual(new Set(Object.keys(registered[0]!.dicts.zh!)))
    expect(effects.some((label) => String(label).includes('dictionaries'))).toBe(true)
  })

  it('the nav label is a thunk through the bound translator, so it follows the locale', async () => {
    const registration = await loadClient()
    const en = localeContext('en')
    registration.factory(() => createReactDouble().react).apply(en.ctx)
    expect((en.sections[0]!.options.label as () => string)()).toBe('Hook ordering')

    const zh = localeContext('zh')
    registration.factory(() => createReactDouble().react).apply(zh.ctx)
    expect((zh.sections[0]!.options.label as () => string)()).toBe('钩子排序')
  })

  it('falls back to Chinese and still registers when ctx.locale is absent', async () => {
    const registration = await loadClient()
    const { ctx, sections } = recordingContext()
    registration.factory(() => createReactDouble().react).apply(ctx)
    expect(sections).toHaveLength(1)
    expect((sections[0]!.options.label as () => string)()).toBe('钩子排序')
  })

  it('still registers the page when the dictionary registration is refused', async () => {
    const registration = await loadClient()
    const { ctx, sections } = localeContext('en')
    ;(ctx as { locale: { register: () => never } }).locale.register = () => {
      throw new Error('locale namespace "hooks-ordering" already has locale "zh"')
    }
    registration.factory(() => createReactDouble().react).apply(ctx)
    expect(sections).toHaveLength(1)
    expect((sections[0]!.options.label as () => string)()).toBe('钩子排序')
  })

  it("every t('key') resolves in both dictionaries (a typo would show the key itself)", async () => {
    const registration = await loadClient()
    const mod = registration.factory(() => createReactDouble().react)
    const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    const keys = [...source.matchAll(/\bt\('([A-Za-z0-9_]+)'/g)].map((match) => match[1]!)
    expect(keys.length).toBeGreaterThanOrEqual(10)
    for (const key of new Set(keys)) {
      expect(Object.prototype.hasOwnProperty.call(mod.ZH, key), `zh is missing ${key}`).toBe(true)
      expect(Object.prototype.hasOwnProperty.call(mod.EN, key), `en is missing ${key}`).toBe(true)
    }
  })

  it('the English dictionary carries no leftover Chinese', async () => {
    const registration = await loadClient()
    const mod = registration.factory(() => createReactDouble().react)
    const cjk = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/
    const leftover = Object.entries(mod.EN).filter(([, value]) => cjk.test(value))
    expect(leftover).toEqual([])
  })

  it('parses and compares the textarea form of a hook list', async () => {
    const registration = await loadClient()
    const mod = registration.factory(() => createReactDouble().react)
    expect(mod.fromLines('a\n\n  b  \n')).toEqual(['a', 'b'])
    expect(mod.toLines(['a', 'b'])).toBe('a\nb')
    expect(mod.toLines(undefined)).toBe('')
    expect(mod.sameLines(['a', 'b'], 'a\nb')).toBe(true)
    expect(mod.sameLines(['a', 'b'], 'a\nc')).toBe(false)
    expect(mod.fromLines(null)).toEqual([])
  })
})

describe('the shell primitives', () => {
  it('takes the kit from the module table when it is there', async () => {
    const kit = fakePrimitives()
    const mod = await moduleWith(kit)
    expect(mod.UI).toBe(kit)
  })

  it('renders the actions and the single-line path field with the shell kit', async () => {
    const kit = fakePrimitives()
    const react = createReactDouble()
    const mod = await moduleWith(kit, react.react)
    const tree = renderSettingsSection(() => mod.SettingsSection(sectionProps()))

    const buttons = collectByType(tree, kit.Button)
    expect(buttons.map(textOf)).toEqual(['保存', '恢复组合默认'])
    expect(buttons.map((button) => button.props.disabled)).toEqual([false, false])
    expect(buttons[0]!.props.variant).toBe('primary')

    // The waterfall/serial lists are multi-line: a textarea is the honest control,
    // so only the single-line log path becomes the shell's Input.
    // (The draft is seeded in an effect, which the stand-in React does not run, so
    // the field's value is the empty draft — the wiring is what can be asserted.)
    const inputs = collectByType(tree, kit.Input)
    expect(inputs).toHaveLength(1)
    expect(inputs[0]!.props.id).toBe('dsh-hooks-ordering-log')
    expect(inputs[0]!.props.type).toBe('text')
    expect(inputs[0]!.props.disabled).toBe(false)
    expect(collectByType(tree, 'textarea').map((area) => area.props.rows)).toEqual([8, 3])
    expect(collectByType(tree, 'input')).toHaveLength(0)

    const texts = collectText(tree)
    for (const copy of [
      '钩子排序',
      'waterfall 钩子（每行一个）',
      '约束 DAG 日志文件（留空即不记录）',
      '保存',
      '恢复组合默认',
    ]) {
      expect(texts).toContain(copy)
    }
  })

  it('renders the read-only banner as a shell Tag and locks the controls', async () => {
    const kit = fakePrimitives()
    const react = createReactDouble()
    const mod = await moduleWith(kit, react.react)
    const tree = renderSettingsSection(() => mod.SettingsSection(sectionProps(false)))

    const tags = collectByType(tree, kit.Tag)
    expect(tags).toHaveLength(1)
    expect(tags[0]!.props.tone).toBe('warning')
    expect(textOf(tags[0])).toBe('当前连接的设置存储是只读的。')
    expect(collectByType(tree, kit.Button).map((button) => button.props.disabled)).toEqual([true, true])
    expect(collectByType(tree, kit.Input)[0]!.props.disabled).toBe(true)
  })

  it('renders the save failure as a shell StateDot + Tag', async () => {
    const kit = fakePrimitives()
    const mod = await moduleWith(kit)
    const tree = mod.saveFailedStatus('disk full')

    expect(collectByType(tree, kit.StateDot).map((dot) => dot.props.state)).toEqual(['error'])
    const tags = collectByType(tree, kit.Tag)
    expect(tags).toHaveLength(1)
    expect(tags[0]!.props.tone).toBe('danger')
    expect(textOf(tags[0])).toBe('保存失败：disk full')
  })

  it('falls back to plain elements when the module table has no primitives, without throwing', async () => {
    const react = createReactDouble()
    const mod = await moduleWith('missing', react.react)
    expect(mod.UI).toBeNull()
    expect(mod.UI_ERROR).toMatch(/no module registered/)

    const tree = renderSettingsSection(() => mod.SettingsSection(sectionProps()))
    const buttons = collectByType(tree, 'button')
    expect(buttons.map(textOf)).toEqual(['保存', '恢复组合默认'])
    expect(buttons[0]!.props.className).toBe('ho-fallback-btn ho-primary')
    expect(buttons.map((button) => button.props.disabled)).toEqual([false, false])
    expect(collectByType(tree, 'input').map((input) => input.props.type)).toEqual(['text'])
    expect(collectByType(tree, 'input')[0]!.props.id).toBe('dsh-hooks-ordering-log')
    expect(collectByType(tree, 'textarea').map((area) => area.props.rows)).toEqual([8, 3])

    // The failure status and the read-only banner still render, in plugin styling.
    expect(textOf(mod.saveFailedStatus('disk full'))).toContain('保存失败：disk full')
    const readonly = renderSettingsSection(() => mod.SettingsSection(sectionProps(false)))
    expect(collectByType(readonly, 'span').map(textOf)).toContain('当前连接的设置存储是只读的。')
  })

  it('falls back when the module table entry is not the shell kit (shape check)', async () => {
    // The stand-in React has no Button/Tag/StateDot: a same-named entry that is
    // not the kit must count as "not available", never as "render undefined".
    const mod = await moduleWith(createReactDouble().react)
    expect(mod.UI).toBeNull()
    expect(mod.UI_ERROR).toBe('')
    expect(collectByType(renderSettingsSection(() => mod.SettingsSection(sectionProps())), 'button').map(textOf)).toEqual([
      '保存',
      '恢复组合默认',
    ])
  })

  it('still registers the page and reports apply/inject on the fallback path', async () => {
    const mod = await moduleWith('missing')
    const { ctx, sections } = recordingContext()
    mod.apply(ctx)
    expect(mod.inject).toEqual(['slots', 'remote', 'remote.settings', 'locale'])
    expect(sections).toHaveLength(1)
    expect(sections[0]!.options).toMatchObject({ name: 'settings.section', id: 'hooks-ordering', order: 27 })
  })
})
