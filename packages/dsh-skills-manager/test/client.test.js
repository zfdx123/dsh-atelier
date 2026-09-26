// 客户端装配自检：在假的 __ModuleLoader__ / React / document 环境里跑 client.js，
// 验证宿主装载契约（注册 id 必须是包名）与两个 Slot 的注册参数。
//
// 这一步很关键：客户端注册 id 写成短名时，宿主装载阶段会直接抛
// `loaded without registering "<id>" via __ModuleLoader__.load`，整个设置页不会
// 出现，而且不会给出更进一步的线索。所以在改 profile 之前先把契约钉住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// fileURLToPath 而不是 URL.pathname：后者是百分号编码的（检出路径里带空格或非 ASCII
// 就读到别的文件上），而且在 Windows 上会多一个前导斜杠（`/E:/...`）。
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 最小 React 替身：只要支持 createElement 与几个 hook 即可。 */
function fakeReact() {
  const createElement = (type, props, ...children) => ({ type, props, children })
  return {
    createElement,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial }),
  }
}

/** 最小 document 替身：只记录样式注入与事件监听。 */
function fakeDocument() {
  const head = {
    children: [],
    appendChild(node) {
      head.children.push(node)
    },
  }
  const listeners = new Map()
  return {
    head,
    listeners,
    getElementById: (id) => head.children.find((node) => node.id === id) ?? null,
    createElement: () => ({
      id: '',
      textContent: '',
      attributes: {},
      setAttribute(key, value) {
        this.attributes[key] = value
      },
      remove() {},
    }),
    addEventListener: (type, handler) => {
      listeners.set(type, handler)
    },
    removeEventListener: (type) => {
      listeners.delete(type)
    },
  }
}

/**
 * 外壳原生组件的替身。
 *
 * 真身在 Node 里加载不到（由外壳的模块表提供），所以用记录型替身代替：每个组件是一个
 * 带 `primitiveName` 的函数，测试里靠**同一性**比较（`node.type === ui.Button`）断言
 * 「用的确实是原生组件」，而不是靠字符串名字猜。
 */
function fakePrimitives() {
  const make = (name) => {
    const Primitive = (props) => ({ type: `ui:${name}`, props: props ?? {}, children: [] })
    Primitive.primitiveName = name
    return Primitive
  }
  return {
    Modal: make('Modal'),
    Button: make('Button'),
    Input: make('Input'),
    Switch: make('Switch'),
    Tag: make('Tag'),
    StateDot: make('StateDot'),
    Toast: make('Toast'),
    IconCheckOutline: make('IconCheckOutline'),
    IconWarningOutline: make('IconWarningOutline'),
    IconCheckOutline: make('IconCheckOutline'),
    IconPlusOutline: make('IconPlusOutline'),
    IconSkillOutline: make('IconSkillOutline'),
  }
}

/** 在假环境里加载 client.js，返回 factory 的导出与注册记录。 */
async function loadClient(options = {}) {
  const withPrimitives = options.primitives !== false
  const source = await readFile(join(ROOT, 'client.js'), 'utf8')
  const loaded = []
  const window = {
    __ModuleLoader__: {
      load: (entry) => {
        loaded.push(entry)
      },
    },
  }
  // client.js 是 classic script：用 new Function 直接执行，注入 window/React/document。
  const run = new Function('window', 'React', 'document', 'fetch', source)
  run(window, fakeReact(), fakeDocument(), async () => ({ ok: true, json: async () => ({ ok: true, data: {} }) }))

  assert.equal(loaded.length, 1, 'client.js 必须恰好调用一次 __ModuleLoader__.load')
  const entry = loaded[0]
  const module = { exports: {} }
  const ui = fakePrimitives()
  const exports = entry.factory((name) => {
    if (name === 'react') return fakeReact()
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      // primitives:false 模拟「外壳模块表里没有这个包」——此时 require 会抛。
      if (withPrimitives) return ui
      throw new Error(`client-modules: 模块表里没有 ${name}`)
    }
    throw new Error(`unexpected require: ${name}`)
  })
  return { entry, exports: exports ?? module.exports, ui }
}

/** 深度收集元素树里用到的组件类型（元素树是 {type, props, children}）。 */
function collectTypes(node, out = []) {
  if (Array.isArray(node)) {
    node.forEach((child) => collectTypes(child, out))
    return out
  }
  if (node === null || typeof node !== 'object') return out
  out.push(node.type)
  collectTypes(node.children, out)
  return out
}

/** 深度收集满足条件的元素。 */
function findAll(node, pred, out = []) {
  if (Array.isArray(node)) {
    node.forEach((child) => findAll(child, pred, out))
    return out
  }
  if (node === null || typeof node !== 'object') return out
  if (pred(node)) out.push(node)
  findAll(node.children, pred, out)
  return out
}

/**
 * 动作层的测试台：window 的 confirm/prompt 会被记下来。
 *
 * 默认返回「确认」与空输入——测试若断言这两个函数没被调用，就说明走的是原生弹窗。
 */
function actionHarness(exports, options = {}) {
  const calls = { patches: [], host: [], confirmed: 0, prompts: [] }
  const win = {
    confirm(message) {
      calls.confirmed += 1
      calls.confirmMessage = message
      return options.confirm !== false
    },
    prompt(message, initial) {
      calls.prompts.push({ message, initial })
      return options.promptAnswer ?? null
    },
  }
  const UI = options.UI === undefined ? fakePrimitives() : options.UI
  const view = options.view ?? {
    data: {
      roots: [
        { source: 'project-dsh', rank: 100, path: '/p/.dsh/skills', writable: true, exists: true },
        { source: 'user-dsh', rank: 400, path: '/u/skills', writable: true, exists: true },
        { source: 'bundled', rank: 600, path: '/b/skills', writable: false, exists: true },
      ],
    },
    dialog: null,
  }
  const actions = exports.createActions({
    UI,
    win,
    patch: (next) => {
      calls.patches.push(next)
    },
    view,
    callHost: (payload) => {
      calls.host.push(payload)
      return Promise.resolve({})
    },
    alive: { current: true },
    reload: () => Promise.resolve(),
  })
  return { actions, calls, win, UI, view }
}

const SKILL = {
  name: 'demo',
  path: '/u/skills/demo',
  kind: 'bundle',
  status: 'ok',
  source: 'user-dsh',
  rank: 400,
  issues: [],
}

test('client.js 以包名为 id 注册模块（宿主按包名装载）', async () => {
  const { entry } = await loadClient()
  // 必须与 package.json 的 name 一致，否则宿主装载后校验失败。
  assert.equal(entry.id, '@zfdx123/dsh-skills-manager')
  assert.equal(typeof entry.factory, 'function')

  // 三方一致性：package.json 的 name、client.js 的注册 id、cordis.patch.yml 的插入行，
  // 必须是同一个包名。任何一处不一致都会让客户端界面静默不出现，所以钉在这里。
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.name, entry.id)
  const patch = await readFile(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.equal(patch.includes(`name: '${entry.id}'`), true, 'cordis.patch.yml 的 name 必须与包名一致')
})

test('client.js 导出 apply / inject 契约', async () => {
  const { exports } = await loadClient()
  // locale 是外壳提供的文案服务（0.1.6-alpha.2 起）：声明它以后界面文案才能跟壳的语言。
  assert.deepEqual(exports.inject, ['slots', 'locale'])
  assert.equal(typeof exports.apply, 'function')
  assert.equal(exports.API_PATH, '/api/skills/manager')
})

test('apply() 在 settings.section 与 sidebar.footer.action 各注册一个入口', async () => {
  const { exports } = await loadClient()
  const registrations = []
  const injected = []
  const effects = []
  const ctx = {
    effect: (factory) => {
      const disposer = factory()
      effects.push(typeof disposer === 'function' ? disposer : () => {})
    },
    slots: {
      inject: (name, callback) => {
        injected.push(name)
        callback()
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }

  exports.apply(ctx)

  assert.deepEqual(injected, ['settings.section', 'sidebar.footer.action'])
  assert.deepEqual(
    registrations.map((entry) => entry.options.name),
    ['settings.section', 'sidebar.footer.action'],
  )
  for (const entry of registrations) {
    assert.equal(entry.options.id, 'skill-manager')
    assert.equal(typeof entry.options.label === 'function' || typeof entry.options.label === 'string', true)
    assert.equal(typeof entry.component, 'function', '每个 Slot 都要有组件')
  }
  // label 允许是函数（外壳按语言取），调一次确认不抛。
  const label = registrations[0].options.label
  assert.equal(typeof (typeof label === 'function' ? label() : label), 'string')

  // 样式必须挂在本 fiber 的 effect 上，插件停用后要能移除。
  assert.equal(effects.length, 1)
  for (const dispose of effects) dispose()
  // 组件能作为函数调用并返回元素树（不抛错）。
  const element = registrations[0].component({})
  assert.equal(element !== null && element !== undefined, true)
})

test('client.js 自带的样式覆盖了暗色主题与原生控件', async () => {
  const { exports } = await loadClient()
  const css = exports.CSS
  assert.equal(css.includes('data-ds-dark-theme'), true, '必须处理暗色主题')
  assert.equal(css.includes('color-scheme'), true, '必须声明 color-scheme')
  assert.equal(css.includes('option{'), true, '原生下拉弹层必须显式给色')
  assert.equal(css.includes('::placeholder'), true)
  assert.equal(exports.CLASS, 'dsh-skills-manager')
})

test('侧栏脚动作行允许换行：规则只命中本插件在座的那一行', async () => {
  const { exports } = await loadClient()
  const css = exports.CSS
  // 外壳的 footerActions 是 nowrap 的横向 flex（width:100%），而 dsh-memery 这类邻座的
  // 入口用 width:100%（按钮再出血 4px）占满整行。不换行时本插件的入口会被推到侧栏右边缘
  // 之外，被外壳裁掉，只剩一截圆角边框——看上去就像入口消失了。
  // 规则从 slot 锚点（data-slot，渲染器给每个 slot 出的锚点）出发，并用 :has() 要求本插件
  // 确实在座：外壳自己的其它 footerActions 行（例如 user-questions 弹窗的按钮行）不受影响。
  assert.equal(
    /:has\(>\s*\[data-slot="sidebar\.footer\.action"\]\s*>\s*\.dsh-skills-manager\)\{[^}]*flex-wrap:\s*wrap/.test(css),
    true,
    '注入的样式必须让 sidebar.footer.action 所在的动作行可换行，且只作用于这一行',
  )
  // 不得再按 CSS Module 的局部名做全局片段匹配：那会波及外壳的其它同名行，
  // 而且外壳一改局部名规则就静默失效。
  assert.equal(css.includes('_footerActions'), false, '不得依赖外壳 CSS Module 的局部名')
})

test('入口被挤出动作行时给一条控制台警告（静默失效不是选项）', async () => {
  const { exports } = await loadClient()
  const row = { getBoundingClientRect: () => ({ left: 0, right: 240 }) }
  const nodeIn = { closest: () => ({ parentElement: row }), getBoundingClientRect: () => ({ left: 8, right: 51 }) }
  const nodeOut = { closest: () => ({ parentElement: row }), getBoundingClientRect: () => ({ left: 248, right: 277 }) }

  assert.equal(exports.entryWrapWarning(nodeIn), null, '入口在行内时不该出声')
  assert.match(exports.entryWrapWarning(nodeOut), /右边界超出 37px/)
  // 锚点找不到同样是「规则不会命中」：必须点名，而不是静默失效。
  assert.match(exports.entryWrapWarning({ closest: () => null }), /data-slot/)
  // 量不到几何的环境（老外壳、测试替身）不做判断，也不抛错。
  assert.equal(exports.entryWrapWarning(null), null)
  assert.equal(exports.entryWrapWarning({ closest: () => ({ parentElement: null }) }), null)
})

test('侧栏浮层用 fixed 定位，逃出侧栏列的 overflow 裁切', async () => {
  const { exports } = await loadClient()
  const css = exports.CSS
  // 外壳的侧栏列是 `.pI_x6G_sidebarCol{overflow:hidden}`：absolute 的浮层会被切在侧栏
  // 边界上，z-index 改变不了绘制顺序之外的任何事（裁切不看 z-index）。所以浮层必须
  // fixed，位置交给 flyoutAnchor 量。
  assert.match(css, /\.sm-flyout\{[^}]*position:fixed/)
  assert.doesNotMatch(css, /\.sm-flyout\{[^}]*position:absolute/)
})

test('flyoutAnchor 把浮层贴在触发按钮上方，并始终夹在视口内', async () => {
  const { exports } = await loadClient()
  const anchor = exports.flyoutAnchor({ left: 12, top: 700 }, { width: 1440, height: 900 }, 400)
  assert.deepEqual(anchor, { left: 12, bottom: 208, width: 400, maxHeight: 630 })

  // 按钮贴近右边：面板往左拉，宁可错位也不许溢出视口
  const right = exports.flyoutAnchor({ left: 1200, top: 700 }, { width: 1280, height: 900 }, 400)
  assert.equal(right.left, 868)
  assert.equal(right.left + right.width, 1268)

  // 视口比面板还窄：宽度退到「视口 - 两边留白」
  const narrow = exports.flyoutAnchor({ left: 0, top: 700 }, { width: 300, height: 800 }, 400)
  assert.equal(narrow.width, 276)
  assert.equal(narrow.left, 12)

  // 按钮贴近顶部：高度退到按钮上方的剩余空间（但给个下限，不至于成一条缝）
  const shallow = exports.flyoutAnchor({ left: 12, top: 120 }, { width: 1440, height: 900 }, 400)
  assert.equal(shallow.maxHeight, 160)
  assert.equal(shallow.bottom, 788)
})

test('statusColor / groupByRoot 是纯函数且行为稳定', async () => {
  const { exports } = await loadClient()
  assert.equal(exports.statusColor('broken'), 'var(--sm-error)')
  assert.equal(exports.statusColor('warning'), 'var(--sm-warn)')
  assert.equal(exports.statusColor('ok'), 'var(--sm-ok)')

  const skills = [
    { name: 'a', source: 'project-dsh', path: '/p/.dsh/skills/a/SKILL.md' },
    { name: 'b', source: 'user-dsh', path: '/u/skills/b/SKILL.md' },
    { name: 'orphan', source: 'custom', path: '/x/c.md' },
  ]
  const roots = [
    { source: 'project-dsh', rank: 100, path: '/p/.dsh/skills' },
    { source: 'user-dsh', rank: 400, path: '/u/skills' },
  ]
  const groups = exports.groupByRoot(skills, roots)
  assert.equal(groups.length, 3, '未匹配到根的技能要落到兜底分组')
  assert.equal(groups[0].skills[0].name, 'a')
  assert.equal(groups[1].skills[0].name, 'b')
  assert.equal(groups[2].root.source, '?', '兜底分组的 source 是 ?')
  assert.equal(groups[2].skills[0].name, 'orphan')
})

test('CustomDirsCard 渲染目录列表、空态与只读态', async () => {
  const { exports } = await loadClient()
  const Card = exports.CustomDirsCard
  assert.equal(typeof Card, 'function')

  // 空态
  const empty = Card({
    dirs: [],
    writable: true,
    onAdd: async () => {},
    onRemove: async () => {},
    onPick: async () => {},
  })
  assert.ok(empty, '空列表也要能渲染')
  assert.equal(JSON.stringify(empty).includes('还没有添加自定义文件夹'), true)

  // 有目录：路径与技能数都要出现，且有「移除」「浏览」按钮
  const filled = JSON.stringify(
    Card({
      dirs: [
        { path: 'E:/work/skills', exists: true, skillCount: 3 },
        { path: 'E:/gone', exists: false, skillCount: 0 },
      ],
      writable: true,
      onAdd: async () => {},
      onRemove: async () => {},
      onPick: async () => {},
    }),
  )
  assert.equal(filled.includes('E:/work/skills'), true)
  assert.equal(filled.includes('技能 3 个'), true)
  assert.equal(filled.includes('目录不存在'), true)
  assert.equal(filled.includes('移除'), true)
  assert.equal(filled.includes('浏览'), true)

  // 只读：给出提示（添加按钮同时被 disabled）
  const readonly = JSON.stringify(
    Card({
      dirs: [],
      writable: false,
      onAdd: async () => {},
      onRemove: async () => {},
      onPick: async () => {},
    }),
  )
  assert.equal(readonly.includes('settings 不可写'), true)
})

test('CustomDirsCard 渲染本身不触发任何回调（无副作用）', async () => {
  const { exports } = await loadClient()
  const calls = []
  const card = exports.CustomDirsCard({
    dirs: [{ path: 'E:/a', exists: true, skillCount: 1 }],
    writable: true,
    onAdd: (path) => {
      calls.push(['add', path])
      return Promise.resolve({})
    },
    onRemove: (path) => {
      calls.push(['remove', path])
      return Promise.resolve({})
    },
    onPick: () => {
      calls.push(['pick'])
      return Promise.resolve({ supported: false })
    },
  })
  assert.equal(typeof card, 'object')
  assert.deepEqual(calls, [], '渲染不应触发副作用')
})

test('inject 声明 slots 与 locale 两个服务', async () => {
  const { exports } = await loadClient()
  assert.deepEqual(exports.inject, ['slots', 'locale'])
})

/**
 * 假外壳 locale 服务：记录 register 的字典，bind 按「当前语言」查表并做 {name} 替换
 * ——与 dsh-client-locale 的 LocaleRuntime 同名同形，够用来验证接线。
 */
function fakeLocale(active) {
  const registered = []
  const tables = new Map()
  return {
    registered,
    active,
    register(ns, dicts) {
      registered.push({ ns, dicts })
      for (const [id, table] of Object.entries(dicts)) tables.set(`${ns}|${id}`, table)
      return () => {}
    },
    bind(ns) {
      return (key, params) => {
        const table = tables.get(`${ns}|${active}`) ?? {}
        const template = table[key] === undefined ? key : table[key]
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
      }
    },
  }
}

test('locale：注册 zh/en 字典，label 与界面文案跟外壳语言走', async () => {
  const { exports } = await loadClient()
  const locale = fakeLocale('en')
  const registrations = []
  exports.apply({
    effect: (factory) => {
      factory()
    },
    locale,
    slots: {
      inject: (name, callback) => {
        callback()
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  })

  // 命名空间 = settings.section 的 id；两种语言都要齐（缺一个键就是半截界面）。
  assert.equal(locale.registered.length, 1)
  assert.equal(locale.registered[0].ns, 'skill-manager')
  const { zh, en } = locale.registered[0].dicts
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh/en 键集必须一致')
  assert.equal(zh.nav, '技能管理', '中文文案必须与改造前逐字节一致')
  assert.equal(en.nav, 'Skill manager')

  // label 是 thunk：外壳 resolveSlotLabel 每次渲染现取，切语言不必重新注册 slot。
  for (const entry of registrations) {
    assert.equal(typeof entry.options.label, 'function')
    assert.equal(entry.options.label(), 'Skill manager')
  }
  // 组件树里的文案同样走 t：切到 en 后渲染出来的就是英文。
  const view = exports.SkillsView({
    data: { cwd: 'E:/p', roots: [], skills: [], summary: { total: 0, ok: 0, warning: 0, broken: 0, shadowed: 0 } },
    busy: false,
    panel: null,
    dirs: [],
    compact: false,
    onNew() {},
    onReload() {},
    onTrash() {},
    onRead() {},
    onToggle() {},
    onPanel() {},
  })
  const rendered = JSON.stringify(view)
  assert.equal(rendered.includes('No skills found.'), true, '空态应为英文')
  assert.equal(rendered.includes('Refresh'), true, '工具条应为英文')
})

test('locale 不可用时降级：照常注册，界面仍是中文', async () => {
  const { exports } = await loadClient()
  const registrations = []
  const effects = []
  exports.apply({
    effect: (factory) => {
      const disposer = factory()
      effects.push(typeof disposer === 'function' ? disposer : () => {})
    },
    slots: {
      inject: (name, callback) => {
        callback()
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  })

  // 没有 locale 服务就不去注册字典：只留样式那一个 effect。
  assert.equal(effects.length, 1)
  for (const entry of registrations) assert.equal(entry.options.label(), '技能管理')
  const rendered = JSON.stringify(
    exports.SkillsView({
      data: { cwd: 'E:/p', roots: [], skills: [], summary: { total: 0, ok: 0, warning: 0, broken: 0, shadowed: 0 } },
      busy: false,
      panel: null,
      dirs: [],
      compact: false,
      onNew() {},
      onReload() {},
      onTrash() {},
      onRead() {},
      onToggle() {},
      onPanel() {},
    }),
  )
  assert.equal(rendered.includes('没有发现任何技能'), true)
})

test('callHost 在宿主返回错误时抛出带原文的异常', async () => {
  const source = await readFile(join(ROOT, 'client.js'), 'utf8')
  const loaded = []
  const window = { __ModuleLoader__: { load: (entry) => loaded.push(entry) } }
  const failingFetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ ok: false, error: '拒绝写入：目标不在任何可写技能根目录内' }),
  })
  new Function('window', 'React', 'document', 'fetch', source)(window, fakeReact(), fakeDocument(), failingFetch)
  const exports = loaded[0].factory((name) => (name === 'react' ? fakeReact() : undefined))
  await assert.rejects(() => exports.callHost({ action: 'delete', path: '/etc/passwd' }), /拒绝写入/)
})

// ───────────────────────────────────────────────────────────────────────────
// 提示与控件走外壳原生组件（Modal / Button / Input / Switch / Tag / StateDot / Toast）
//
// 背景：以前删除/重命名/移动/复制用的是 window.confirm / window.prompt，长得跟外壳
// 完全不是一套皮。外壳已经把原生组件暴露在模块表里，所以直接调，不自己抄样式。
// 拿不到原语时必须降级（退回浏览器弹窗 + 自带按钮样式），绝不能白屏。

test('从外壳模块表取原生组件；拿不到时 UI 为 null 而不是白屏', async () => {
  const withUI = await loadClient()
  assert.equal(withUI.exports.UI, withUI.ui, 'UI 必须就是外壳给的那个模块对象')

  const without = await loadClient({ primitives: false })
  assert.equal(without.exports.UI, null, 'require 抛错时必须吞掉并降级')
  assert.equal(typeof without.exports.apply, 'function', '降级后插件仍要能装配')
})

test('删除：UI 可用时开原生弹窗，绝不碰 window.confirm', async () => {
  const { exports } = await loadClient()
  const h = actionHarness(exports)
  h.actions.onDelete(SKILL)
  assert.equal(h.calls.confirmed, 0, '有原生组件时不该再用浏览器确认框')
  assert.equal(h.calls.host.length, 0, '开弹窗阶段不该发请求')
  assert.deepEqual(h.calls.patches, [{ dialog: { kind: 'delete', target: SKILL } }])
})

test('删除：拿不到原生组件时退回 window.confirm，确认后照常移入回收站', async () => {
  const { exports } = await loadClient({ primitives: false })
  const h = actionHarness(exports, { UI: null })
  await h.actions.onDelete(SKILL)
  assert.equal(h.calls.confirmed, 1, '降级路径要用浏览器确认框')
  assert.equal(h.calls.confirmMessage.includes('/u/skills/demo'), true, '确认框里要给出路径')
  assert.deepEqual(h.calls.host[0], { action: 'delete', path: SKILL.path, kind: 'bundle' })
})

test('删除：降级路径下用户取消就什么都不做', async () => {
  const { exports } = await loadClient({ primitives: false })
  const h = actionHarness(exports, { UI: null, confirm: false })
  h.actions.onDelete(SKILL)
  assert.equal(h.calls.host.length, 0)
})

test('重命名/移动/复制：UI 可用时开弹窗，不调用 window.prompt', async () => {
  const { exports } = await loadClient()
  const h = actionHarness(exports)
  h.actions.onRename(SKILL)
  h.actions.onMove(SKILL)
  h.actions.onCopy(SKILL)
  assert.deepEqual(h.calls.prompts, [], '有原生组件时不该再用浏览器输入框')
  assert.deepEqual(
    h.calls.patches.map((patch) => patch.dialog.kind),
    ['rename', 'move', 'copy'],
  )
})

test('移动：拿不到原生组件时退回 window.prompt 的序号选择', async () => {
  const { exports } = await loadClient({ primitives: false })
  const h = actionHarness(exports, { UI: null, promptAnswer: '2' })
  await h.actions.onMove(SKILL)
  // 只列可写且存在的根目录：bundled 是只读，不该出现在选项里
  assert.equal(h.calls.prompts[0].message.includes('bundled'), false)
  assert.deepEqual(h.calls.host[0], { action: 'move', path: SKILL.path, kind: 'bundle', targetRoot: '/u/skills' })
})

test('移除自定义文件夹：UI 可用时开弹窗，不再用浏览器确认框', async () => {
  const { exports } = await loadClient()
  const h = actionHarness(exports)
  h.actions.onRemoveDir({ path: 'E:/work/skills', skillCount: 3 })
  assert.equal(h.calls.confirmed, 0)
  assert.equal(h.calls.patches[0].dialog.kind, 'removeDir')
})

test('弹窗确认后按 kind 发对应请求，并在结束后关掉弹窗', async () => {
  const { exports } = await loadClient()
  const h = actionHarness(exports)
  h.view.dialog = { kind: 'move', target: SKILL }
  await h.actions.submitDialog({ name: '', rootPath: '/p/.dsh/skills' })
  assert.deepEqual(h.calls.host[0], { action: 'move', path: SKILL.path, kind: 'bundle', targetRoot: '/p/.dsh/skills' })
  assert.equal(
    h.calls.patches.some((patch) => patch.dialog === null),
    true,
    '结束后要关掉弹窗',
  )
})

test('弹窗确认：复制与重命名会带上新名字', async () => {
  const { exports } = await loadClient()

  const copy = actionHarness(exports)
  copy.view.dialog = { kind: 'copy', target: SKILL }
  await copy.actions.submitDialog({ name: 'demo-copy', rootPath: '/u/skills' })
  assert.deepEqual(copy.calls.host[0], {
    action: 'copy',
    path: SKILL.path,
    kind: 'bundle',
    targetRoot: '/u/skills',
    newName: 'demo-copy',
  })

  const rename = actionHarness(exports)
  rename.view.dialog = { kind: 'rename', target: SKILL }
  await rename.actions.submitDialog({ name: 'renamed' })
  assert.deepEqual(rename.calls.host[0], { action: 'rename', path: SKILL.path, kind: 'bundle', newName: 'renamed' })
})

test('DialogHost 渲染原生 Modal：文案正确，busy 时关不掉', async () => {
  const { exports, ui } = await loadClient()
  let closed = 0
  const host = exports.DialogHost({
    dialog: { kind: 'delete', target: SKILL },
    roots: [],
    busy: false,
    onClose: () => {
      closed += 1
    },
    onConfirm: () => {},
  })

  assert.equal(host.type, ui.Modal)
  assert.equal(host.props.open, true)
  assert.equal(host.props.title, '把「demo」移入回收站？')
  assert.equal(host.props.description.includes('可恢复'), true)
  const [cancel, confirm] = host.props.footer
  assert.equal(cancel.type, ui.Button)
  assert.equal(cancel.props.variant, 'outline')
  assert.equal(confirm.type, ui.Button)
  assert.equal(confirm.children[0], '移入回收站')
  assert.match(confirm.props.className, /dsh-sm-danger/)

  host.props.onClose()
  assert.equal(closed, 1)

  const busyHost = exports.DialogHost({
    dialog: { kind: 'delete', target: SKILL },
    roots: [],
    busy: true,
    onClose: () => {
      closed += 1
    },
    onConfirm: () => {},
  })
  busyHost.props.onClose()
  assert.equal(closed, 1, '写入过程中点遮罩/Esc 不能把弹窗关掉')
  assert.equal(busyHost.props.footer[1].props.disabled, true, '写入过程中确认按钮要禁用')
})

test('DialogHost：移动/复制列出可写根目录，复制给默认副本名', async () => {
  const { exports, ui } = await loadClient()
  const roots = [
    { source: 'project-dsh', rank: 100, path: '/p/.dsh/skills', writable: true, exists: true },
    { source: 'user-dsh', rank: 400, path: '/u/skills', writable: true, exists: true },
  ]
  const move = exports.DialogHost({
    dialog: { kind: 'move', target: SKILL },
    roots,
    busy: false,
    onClose() {},
    onConfirm() {},
  })
  assert.equal(collectTypes(move).includes(ui.Button), true)
  const moveJson = JSON.stringify(move)
  assert.equal(moveJson.includes('/p/.dsh/skills'), true)
  assert.equal(moveJson.includes('/u/skills'), true)

  const copy = exports.DialogHost({
    dialog: { kind: 'copy', target: SKILL },
    roots,
    busy: false,
    onClose() {},
    onConfirm() {},
  })
  assert.equal(JSON.stringify(copy).includes('demo-copy'), true, '复制默认给 <名字>-copy')
})

test('弹窗里的新名字按官方技能名语法校验（kebab-case）', async () => {
  const { exports } = await loadClient()
  assert.equal(exports.isValidSkillName('code-review'), true)
  assert.equal(exports.isValidSkillName(''), false)
  assert.equal(exports.isValidSkillName('Code Review'), false)
  assert.equal(exports.isValidSkillName('a--b'), false)
})

test('run 成功后发原生 Toast；拿不到原语时退回内联绿字', async () => {
  const { exports } = await loadClient()
  const h = actionHarness(exports)
  await h.actions.run({ action: 'toggle', path: SKILL.path }, '已切换开关')
  await h.actions.run({ action: 'toggle', path: SKILL.path }, '又切了一次')

  const toasts = h.calls.patches.filter((patch) => patch.toast).map((patch) => patch.toast)
  assert.equal(toasts.length, 2)
  assert.equal(toasts[0].text, '已切换开关')
  assert.equal(typeof toasts[0].id, 'number', '每条提示要有 id，React 才会重挂并重播动画')
  assert.notEqual(toasts[0].id, toasts[1].id, '连着两次提示不能共用 id')
  assert.equal(
    h.calls.patches.some((patch) => patch.notice !== undefined),
    false,
    '有原生组件时不再往面板里塞绿字',
  )

  const fallback = await loadClient({ primitives: false })
  const f = actionHarness(fallback.exports, { UI: null })
  await f.actions.run({ action: 'toggle', path: SKILL.path }, '已切换开关')
  assert.equal(
    f.calls.patches.some((patch) => patch.notice === '已切换开关'),
    true,
  )
  assert.equal(
    f.calls.patches.some((patch) => patch.toast),
    false,
  )
})

test('失败留在面板里的红字，不发成功 Toast', async () => {
  const { exports } = await loadClient()
  const patches = []
  const actions = exports.createActions({
    UI: fakePrimitives(),
    win: { confirm: () => true, prompt: () => null },
    patch: (next) => {
      patches.push(next)
    },
    view: { data: { roots: [] }, dialog: null },
    callHost: () => Promise.reject(new Error('拒绝写入：目标不在任何可写技能根目录内')),
    alive: { current: true },
    reload: () => Promise.resolve(),
  })
  await assert.rejects(() => actions.run({ action: 'delete', path: '/x' }, '已移入回收站'), /拒绝写入/)
  assert.equal(
    patches.some((patch) => typeof patch.error === 'string' && patch.error.includes('拒绝写入')),
    true,
  )
  assert.equal(
    patches.some((patch) => patch.toast),
    false,
    '失败不该弹成功提示',
  )
})

test('ToastHost 渲染原生 Toast（成功用对勾图标），没有提示时渲染 null', async () => {
  const { exports, ui } = await loadClient()
  const onDone = () => {}
  const host = exports.ToastHost({ toast: { id: 3, text: '已保存' }, anchor: null, onDone })
  assert.equal(host.type, ui.Toast)
  assert.equal(host.props.text, '已保存')
  assert.equal(host.props.icon.type, ui.IconCheckOutline)
  assert.equal(host.props.onDone, onDone)
  assert.equal(exports.ToastHost({ toast: null, anchor: null, onDone }), null)

  const fallback = await loadClient({ primitives: false })
  assert.equal(
    fallback.exports.ToastHost({ toast: { id: 1, text: 'x' }, anchor: null, onDone }),
    null,
    '拿不到原语时不要渲染空的 Toast',
  )
})

test('技能行用原生 StateDot/Tag/Button；删除按钮是红字 outline', async () => {
  const { exports, ui } = await loadClient()
  const row = exports.SkillRow({
    skill: SKILL,
    busy: false,
    onRead() {},
    onToggle() {},
    onRename() {},
    onMove() {},
    onCopy() {},
    onDelete() {},
  })
  const types = collectTypes(row)
  assert.equal(types.includes(ui.StateDot), true)
  assert.equal(types.includes(ui.Tag), true)
  assert.equal(types.includes(ui.Button), true)

  const actions = row.children[1]
  const remove = actions.children[actions.children.length - 1]
  assert.equal(remove.type, ui.Button)
  assert.equal(remove.props.variant, 'outline')
  assert.match(remove.props.className, /dsh-sm-danger/)
  assert.equal(remove.children[0], '删除')
})

test('拿不到原生组件时技能行退回自带按钮样式', async () => {
  const { exports } = await loadClient({ primitives: false })
  const row = exports.SkillRow({
    skill: SKILL,
    busy: false,
    onRead() {},
    onToggle() {},
    onRename() {},
    onMove() {},
    onCopy() {},
    onDelete() {},
  })
  const actions = row.children[1]
  const first = actions.children[0]
  assert.equal(first.type, 'button')
  assert.equal(first.props.className, 'dsh-sm-fallback-btn')
})

test('控制器把弹窗与 Toast 挂在同一个容器里（设置页与侧栏共用）', async () => {
  const { exports } = await loadClient()
  const types = collectTypes(exports.SkillsController({ ctx: {} }))
  assert.equal(types.includes(exports.DialogHost), true)
  assert.equal(types.includes(exports.ToastHost), true)
})

test('弹窗 portal 到 body：危险色与输入框宽度不能依赖 --sm-*', async () => {
  const { exports } = await loadClient()
  const css = exports.CSS
  // Modal / Toast 挂在 body 上，已经不在 .dsh-skills-manager 里：--sm-* 是定义在插件
  // 容器上的，在弹窗里解析不到，所以这几条必须直接用外壳的 --dsw-alias-*。
  assert.match(css, /\.dsh-sm-danger\{[^}]*--dsw-alias-state-error-primary/)
  assert.match(css, /\.dsh-sm-field\{[^}]*width:100%/)
  // 原生 Input 自己会画边框和底色，插件的原生控件配色规则不能盖上去。
  assert.match(css, /input:not\(\[class\]\)/, '原生 Input 必须被排除在插件的 input 配色规则之外')
})

// ── 字形 → 外壳图标 ───────────────────────────────────────────────────────────
//
// 界面里的「＋ / ✓ / ✖ / ! / ◈」原来是当图标用的 Unicode 字符：字形宽度、基线、
// 字体族都跟着系统字体走，跟外壳自己的图标不是一套。改成外壳
// @deepseek-ai/dsh-client-ui-primitives 的图标（按钮走 Button 的 icon 通道，
// 其余直接渲染图标节点），拿不到组件库时逐一退回原字形。
//
// 每个站点两条路径各一个用例：有图标 → 用图标且文案不带字形；没图标 →
// icon() 报「没有」、界面还是原来那个字形，且不抛错（降级绝不白屏）。

/** 空面板的 SkillsView 入参（工具条足够验证新建按钮）。 */
const EMPTY_VIEW = {
  data: { cwd: 'E:/p', roots: [], skills: [], summary: { total: 0, ok: 0, warning: 0, broken: 0, shadowed: 0 } },
  busy: false,
  panel: null,
  dirs: [],
  compact: false,
  onNew() {},
  onReload() {},
  onTrash() {},
  onRead() {},
  onToggle() {},
  onPanel() {},
}

/** 技能行入参（技能本体按用例替换）。 */
const ROW_ARGS = {
  busy: false,
  onRead() {},
  onToggle() {},
  onRename() {},
  onMove() {},
  onCopy() {},
  onDelete() {},
}

/** 带两条诊断的技能（error 一条、warning 一条）。 */
const SKILL_WITH_ISSUES = Object.assign({}, SKILL, {
  issues: [
    { level: 'error', message: '名字不合法' },
    { level: 'warning', message: '缺描述' },
  ],
})

const CHOICE_ROOT = { source: 'project-dsh', rank: 100, path: '/p/.dsh/skills', writable: true, exists: true }
const CHOICE_LABEL = '[project-dsh r100] /p/.dsh/skills'

test('图标（有原语）：新建按钮走 Button 的 icon 通道，文案不再自带「＋」', async () => {
  const { exports, ui } = await loadClient()
  const add = findAll(exports.SkillsView(EMPTY_VIEW), (node) => node.type === ui.Button && node.props.icon)
  assert.equal(add.length, 1, '工具条上的新建按钮要带外壳图标')
  assert.equal(add[0].props.icon.type, ui.IconPlusOutline)
  assert.equal(add[0].children[0], '新建技能', '有真图标时文案里不再重复一个「＋」')
})

test('图标（降级）：拿不到原语时新建按钮仍是「＋ 新建技能」，icon() 报 null 不抛错', async () => {
  const { exports } = await loadClient({ primitives: false })
  assert.equal(exports.icon('IconPlusOutline', 16), null, '没有图标库时图标位必须是 null')
  const plain = findAll(
    exports.SkillsView(EMPTY_VIEW),
    (node) => node.type === 'button' && node.children[0] === '＋ 新建技能',
  )
  assert.equal(plain.length, 1, '拿不到图标时必须保留原来的字形文案')
})

test('图标（有原语）：诊断行用 IconWarningOutline，不再拼「✖ / !」', async () => {
  const { exports, ui } = await loadClient()
  const row = exports.SkillRow(Object.assign({}, ROW_ARGS, { skill: SKILL_WITH_ISSUES }))
  assert.equal(findAll(row, (node) => node.type === ui.IconWarningOutline).length, 2, '两条诊断各带一个图标')
  const rendered = JSON.stringify(row)
  assert.equal(rendered.includes('✖ 名字不合法'), false, '有图标时不再拼字形前缀')
  assert.equal(rendered.includes('! 缺描述'), false)
})

test('图标（降级）：拿不到原语时诊断行仍拼「✖ / !」，icon() 报 null 不抛错', async () => {
  const { exports } = await loadClient({ primitives: false })
  assert.equal(exports.icon('IconWarningOutline', 14), null)
  const rendered = JSON.stringify(exports.SkillRow(Object.assign({}, ROW_ARGS, { skill: SKILL_WITH_ISSUES })))
  assert.equal(rendered.includes('✖ 名字不合法'), true, '拿不到图标时保留原来的字形前缀')
  assert.equal(rendered.includes('! 缺描述'), true)
})

test('图标（有原语）：弹窗里选中的根目录用 IconCheckOutline，文案不带「✓ 」', async () => {
  const { exports, ui } = await loadClient()
  const host = exports.DialogHost({
    dialog: { kind: 'move', target: SKILL },
    roots: [CHOICE_ROOT, { source: 'user-dsh', rank: 400, path: '/u/skills', writable: true, exists: true }],
    busy: false,
    onClose() {},
    onConfirm() {},
  })
  const rows = findAll(host, (node) => node.type === ui.Button && node.props.style && node.props.style.width === '100%')
  assert.equal(rows.length, 2, '每个可写根目录一行')
  assert.equal(rows[0].props.icon.type, ui.IconCheckOutline, '默认选中的第一行用图标代替「✓ 」')
  assert.equal(rows[1].props.icon, null, '没选中的行不带图标')
  assert.equal(rows[0].children[0], CHOICE_LABEL, '有图标时文案里不再有「✓ 」')
})

test('图标（降级）：拿不到原语时根目录行退回自带按钮 +「✓ 」字形', async () => {
  const { exports } = await loadClient({ primitives: false })
  assert.equal(exports.icon('IconCheckOutline', 16), null)
  const chosen = exports.rootChoice(CHOICE_ROOT, true, () => {})
  assert.equal(chosen.type, 'button')
  assert.equal(chosen.props.className, 'dsh-sm-fallback-btn')
  assert.equal(chosen.children[0], '✓ ' + CHOICE_LABEL, '拿不到图标时保留字形前缀')
  assert.equal(exports.rootChoice(CHOICE_ROOT, false, () => {}).children[0], CHOICE_LABEL, '未选中的行没有字形')
})

test('图标（有原语）：侧栏入口用 IconSkillOutline，不再渲染「◈」', async () => {
  const { exports, ui } = await loadClient()
  const entry = exports.SidebarEntry({ ctx: {} })
  assert.equal(findAll(entry, (node) => node.type === ui.IconSkillOutline).length, 1)
  assert.equal(findAll(entry, (node) => node.type === 'span' && node.children[0] === '◈').length, 0)
})

test('图标（降级）：拿不到原语时侧栏入口仍渲染「◈」字形', async () => {
  const { exports } = await loadClient({ primitives: false })
  assert.equal(exports.icon('IconSkillOutline', 14), null)
  const entry = exports.SidebarEntry({ ctx: {} })
  assert.equal(findAll(entry, (node) => node.type === 'span' && node.children[0] === '◈').length, 1, '字形是降级路径')
})

test('locale：无字形文案是独立的键，原有带字形的键逐字节不动', async () => {
  const { exports } = await loadClient()
  const locale = fakeLocale('en')
  exports.apply({
    effect: (factory) => {
      factory()
    },
    locale,
    slots: {
      inject: (name, callback) => {
        callback()
      },
      register: () => () => {},
    },
  })

  const { zh, en } = locale.registered[0].dicts
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh/en 键集必须一致')
  assert.equal(zh.newSkill, '＋ 新建技能', '带字形的旧值原样保留')
  assert.equal(en.newSkill, '＋ New skill')
  assert.equal(zh.newSkillPlain, '新建技能', '图标路径用无字形文案')
  assert.equal(en.newSkillPlain, 'New skill')
})
