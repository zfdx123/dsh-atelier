// 客户端 bundle 兼容性测试：把 client.js（浏览器模块加载器格式的手写 bundle）
// 加载进 vm 沙箱，验证注册契约（id 必须等于包名）、表单渲染契约（两种传输的
// 字段互斥）、主题样式契约（原生控件配色/暗色变体）与「客户端表单产出 →
// 宿主侧校验」的往返契约。

import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { validateServers, buildClientConfig } from '../lib/logic.js'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

let captured = null
const styleTags = []

/** 外壳原生组件所在的那条模块表条目（基线模块，插件不需要声明 external）。 */
const PRIMITIVES_ID = '@deepseek-ai/dsh-client-ui-primitives'

/** 极简 React 替身：createElement 产出可遍历的树，便于断言渲染出了哪些字段。 */
const fakeReact = {
  useState: (init) => [init, () => {}],
  useEffect: () => {},
  createElement: function createElement(type, props) {
    const children = Array.prototype.slice
      .call(arguments, 2)
      .flat(Infinity)
      .filter((child) => child !== null && child !== undefined && child !== false)
    // children 同时挂到 props.children（与 React 一致）：原语替身靠它把子节点透传
    // 出来，collectText 才能像遍历插件自己的组件那样展开外壳组件。
    return { type, props: Object.assign({}, props || {}, { children }), children }
  },
}

/**
 * 外壳原生组件的替身。
 *
 * 真身在 Node 里加载不到（由外壳的模块表提供，且依赖 CSS module），所以用记录型
 * 替身代替：每个原子是一个带 `primitiveName` 的函数，测试里靠**同一性**比较
 * （`node.type === kit.Button`）断言「用的确实是外壳组件」，而不是靠字符串名字猜。
 *
 * 带图标与 RiskConfirmation：插件把图标节点交给 Button 的 icon 槽、把确认交给
 * RiskConfirmation，两者都要能被断言到，所以替身里必须有同名导出。
 */
function fakePrimitives() {
  const make = (name) => {
    const Primitive = (props) => ({ type: `ui:${name}`, props: props || {}, children: (props && props.children) || [] })
    Primitive.primitiveName = name
    return Primitive
  }
  return {
    Button: make('Button'),
    Input: make('Input'),
    Switch: make('Switch'),
    Tag: make('Tag'),
    StateDot: make('StateDot'),
    RiskConfirmation: make('RiskConfirmation'),
    IconPlusOutline16: make('IconPlusOutline16'),
    IconRefreshOutline16: make('IconRefreshOutline16'),
    IconEditOutline16: make('IconEditOutline16'),
    IconTrashOutline16: make('IconTrashOutline16'),
  }
}

/**
 * 在 vm 沙箱里装载 client.js。
 *
 * options.primitives：
 *   省略      —— 模块表里没有原语包（require 抛错），走降级路径；
 *   'broken'  —— 表里有个同名模块但不是外壳那一套（形状不对），同样要降级；
 *   模块对象  —— 外壳交出来的那个模块对象，走 kit 路径。
 * options.react：替换 React 替身（用来给某个组件喂一份指定的初始 state，
 *   见「McpSection 的勾选通道」那条——默认替身的 setState 是空操作）。
 */
function loadClientBundle(options = {}) {
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (mod) => {
          captured = mod
        },
      },
    },
    document: {
      getElementById: (id) => styleTags.find((tag) => tag.id === id) || null,
      createElement: () => {
        const tag = {
          id: '',
          textContent: '',
          attrs: {},
          removed: false,
          setAttribute(k, v) {
            this.attrs[k] = v
          },
          remove() {
            this.removed = true
          },
        }
        styleTags.push(tag)
        return tag
      },
      head: { appendChild: () => {} },
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  assert.ok(captured, 'client.js 应调用 window.__ModuleLoader__.load')
  const mod = captured.factory((name) => {
    if (name === 'react') return options.react || fakeReact
    if (name === PRIMITIVES_ID) {
      if (options.primitives === 'broken') return { Button: 'not-a-function' }
      if (options.primitives) return options.primitives
    }
    throw new Error(`测试沙箱不支持 require('${name}')`)
  })
  return mod
}

const client = loadClientBundle()

/** 收集一棵（假）React 树里的全部文本，用来断言渲染了哪些字段。 */
function collectText(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    node.forEach((child) => collectText(child, out))
    return out
  }
  // e(SomeComponent, props) 只是元素描述；像 React 那样先把它渲染出来再遍历，
  // 否则子组件内部的文字/按钮对断言不可见（ServerRow → ConfirmStrip）。
  if (typeof node.type === 'function') {
    collectText(node.type(node.props), out)
    return out
  }
  collectText(node.children, out)
  return out
}

/** 渲染一次 ServerForm，返回它渲染出的所有文字。 */
function renderFormTexts(initial) {
  const tree = client.ServerForm({ initial, saving: false, error: '', onSave() {}, onError() {}, onCancel() {} })
  return collectText(tree)
}

/** 收集一棵（假）React 树里的全部 <button> 节点（顺序即渲染顺序）。 */
function collectButtons(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') return out
  if (Array.isArray(node)) {
    node.forEach((child) => collectButtons(child, out))
    return out
  }
  if (typeof node.type === 'function') {
    collectButtons(node.type(node.props), out)
    return out
  }
  if (node.type === 'button') out.push(node)
  collectButtons(node.children, out)
  return out
}

/**
 * 收集树里所有 `type === target` 的元素（顺序即渲染顺序）。
 *
 * 用来按**同一性**找外壳原子（target 传替身组件本身，而不是名字），也用来找
 * 仍由插件自己渲染的原生元素（target 传 'textarea' / 'input' / 'select'）。
 */
function collectByType(node, target, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') return out
  if (Array.isArray(node)) {
    node.forEach((child) => collectByType(child, target, out))
    return out
  }
  // 先比同一性：外壳原子本身也是函数组件，落到下面那条「渲染一次」的分支里就找不到它。
  if (node.type === target) out.push(node)
  if (typeof node.type === 'function') {
    collectByType(node.type(node.props), target, out)
    return out
  }
  collectByType(node.children, target, out)
  return out
}

/** 元素的可见文案（子节点里的字符串拼起来）。 */
const textOf = (node) => collectText(node).join('')

/** 渲染一次内联确认条，返回它的文案与按钮。 */
function renderConfirm(props) {
  const tree = client.ConfirmStrip(props)
  return { texts: collectText(tree), buttons: collectButtons(tree) }
}

// vm 沙箱里创建的对象属于沙箱 realm，原型与宿主不同，deepStrictEqual 永远
// 不相等；这里把沙箱值复制成宿主 realm 的普通对象/数组再比较。
function host(value) {
  if (Array.isArray(value)) return Array.from(value)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) out[key] = value[key]
    return out
  }
  return value
}

describe('client bundle 契约', () => {
  it('导出 apply/inject 以外的解析与组装助手', () => {
    for (const key of ['apply', 'parseLines', 'parseEnv', 'parseHeaders', 'joinEntries', 'buildServerObject']) {
      assert.equal(typeof client[key], 'function', key)
    }
    assert.ok(Array.isArray(client.inject), 'inject 应为数组')
  })

  it('__ModuleLoader__ 注册 id 必须等于包名（否则宿主按图装载后找不到 factory 直接抛错）', () => {
    assert.equal(captured.id, pkg.name)
    assert.equal(pkg.dsh.client.platform, 'web')
  })

  it('客户端只需要 react 这一个基线模块（不声明额外 external/inject）', () => {
    assert.deepEqual(pkg.dsh.client.inject, [])
    assert.equal('external' in pkg.dsh.client, false)
  })
})

describe('表单：两种传输的字段互斥（回归：曾经同时显示）', () => {
  const STDIO_INITIAL = { transport: 'stdio', command: 'npx' }
  const HTTP_INITIAL = { transport: 'streamable-http', url: 'https://10.0.0.1:8091/mcp' }

  // 标签是独立的文本节点，用精确匹配——否则 "URL" 会命中传输方式下拉里的
  // "streamable-http（远程 URL）" 而误判为渲染了 URL 字段。
  const has = (texts, needle) => texts.includes(needle)

  it('stdio：只出现 stdio 连接参数，不出现 URL/请求头/TLS', () => {
    const texts = renderFormTexts(STDIO_INITIAL)
    for (const label of [
      '名称（serverName）',
      '传输方式',
      '命令（command）',
      '参数（args，每行一个）',
      '环境变量（env，每行 KEY=VALUE）',
      '工作目录（cwd，可选）',
    ]) {
      assert.equal(has(texts, label), true, `应渲染：${label}`)
    }
    for (const label of [
      'URL',
      '请求头（headers，每行 KEY: VALUE）',
      '允许自签名证书（tlsInsecure）',
      '自定义 CA 证书文件（tlsCaFile，PEM 绝对路径，可选）',
    ]) {
      assert.equal(has(texts, label), false, `不该渲染：${label}`)
    }
    assert.equal(has(texts, '连接参数（stdio）'), true)
  })

  it('streamable-http：只出现 http 连接参数 + TLS，不出现 command/args/env/cwd', () => {
    const texts = renderFormTexts(HTTP_INITIAL)
    for (const label of [
      'URL',
      '请求头（headers，每行 KEY: VALUE）',
      '允许自签名证书（tlsInsecure）',
      '自定义 CA 证书文件（tlsCaFile，PEM 绝对路径，可选）',
    ]) {
      assert.equal(has(texts, label), true, `应渲染：${label}`)
    }
    for (const label of [
      '命令（command）',
      '参数（args，每行一个）',
      '环境变量（env，每行 KEY=VALUE）',
      '工作目录（cwd，可选）',
    ]) {
      assert.equal(has(texts, label), false, `不该渲染：${label}`)
    }
    assert.equal(has(texts, '连接参数（streamable-http）'), true)
  })

  it('两种传输都渲染的通用字段（超时/启动失败/重连）', () => {
    for (const initial of [STDIO_INITIAL, HTTP_INITIAL]) {
      const texts = renderFormTexts(initial)
      for (const label of [
        '工具调用超时（toolCallTimeoutMs，毫秒）',
        '启动失败即报错（failOnStartupError）',
        '断线自动重连（reconnect）',
        '最大重连次数（reconnectMaxAttempts）',
      ]) {
        assert.equal(has(texts, label), true, `${initial.transport} 应渲染：${label}`)
      }
    }
  })

  it('默认（新建，无 transport）按 stdio 渲染', () => {
    const texts = renderFormTexts(null)
    assert.equal(has(texts, '命令（command）'), true)
    assert.equal(has(texts, 'URL'), false)
  })
})

describe('主题样式契约（回归：文字与背景同色）', () => {
  const css = client.MCP_CSS

  it('亮/暗两套变量都声明了 color-scheme（原生下拉/微调按钮/滚动条跟随主题）', () => {
    assert.match(css, /\.dsh-mcp-manager\{[^}]*color-scheme:light/)
    assert.match(css, /body\[data-ds-dark-theme\] \.dsh-mcp-manager\{[^}]*color-scheme:dark/)
  })

  it('自带控件与下拉项显式给背景/文字色（暗色下弹层默认是白底，只继承文字色会看不见）', () => {
    // input:not([class]) 只命中降级路径自带的输入框（原生 Input 的 <input> 自带 class，
    // 配色由外壳管）；checkbox 交给 color-scheme 走系统外观，不刷底色。
    assert.match(
      css,
      /\.dsh-mcp-manager input:not\(\[class\]\):not\(\[type=checkbox\]\),\.dsh-mcp-manager select,\.dsh-mcp-manager textarea\{background-color:var\(--mcp-field\);color:var\(--mcp-fg\)\}/,
    )
    assert.match(css, /\.dsh-mcp-manager option\{background-color:var\(--mcp-field\);color:var\(--mcp-fg\)\}/)
  })

  it('降级按钮自己带 hover/disabled，原生 Button 不叠滤镜（外壳有自己的过渡与禁用态）', () => {
    assert.match(css, /\.dsh-mcp-manager \.dsh-mcp-fallback-btn\{transition:filter/)
    assert.match(css, /\.dsh-mcp-manager \.dsh-mcp-fallback-btn:disabled\{opacity/)
    assert.equal(/\.dsh-mcp-manager button\{/.test(css), false, '不该再有命中所有 button 的规则')
  })

  it('危险操作的原生 Button 用错误色（原生 Button 没有 danger 变体）', () => {
    assert.match(css, /\.dsh-mcp-manager button\.dsh-mcp-danger\{color:var\(--dsw-alias-state-error-primary/)
  })

  it('暗色块在亮色块之后（同优先级下后者生效）', () => {
    assert.ok(css.indexOf('body[data-ds-dark-theme]') > css.indexOf('.dsh-mcp-manager{'), '暗色覆盖必须排在基础块之后')
  })

  it('组件的每个 --mcp-* 变量都在样式表里有定义（防拼错导致整条声明失效）', () => {
    const defined = new Set(Array.from(css.matchAll(/(--mcp-[a-z0-9-]+)\s*:/g), (m) => m[1]))
    const used = new Set(
      Array.from(JSON.stringify(client.MCP_STYLES).matchAll(/var\((--mcp-[a-z0-9-]+)\)/g), (m) => m[1]),
    )
    assert.ok(used.size >= 6, '应至少有若干变量被使用')
    for (const name of used) assert.equal(defined.has(name), true, `未定义：${name}`)
  })

  it('自定义属性都带兜底色（令牌缺失时仍可读）', () => {
    for (const name of ['--mcp-fg', '--mcp-fg-2', '--mcp-fg-3', '--mcp-field', '--mcp-border']) {
      assert.match(css, new RegExp(`${name}:var\\(--dsw-alias-[a-z0-9-]+,[^)]+\\)`), name)
    }
  })

  it('apply() 注入样式表并在卸载时移除', () => {
    styleTags.length = 0
    const effects = []
    const registered = []
    const ctx = {
      effect: (fn) => {
        effects.push(fn())
      },
      slots: { inject: (_key, cb) => cb(), register: (options) => registered.push(options) },
    }
    client.apply(ctx)
    assert.equal(styleTags.length, 1, '应注入一个样式表')
    assert.equal(styleTags[0].id, 'dsh-mcp-manager-style')
    assert.equal(styleTags[0].textContent, client.MCP_CSS)
    assert.equal(registered[0].id, 'mcp')
    effects.forEach((dispose) => dispose())
    assert.equal(styleTags[0].removed, true, '卸载时应移除样式表')
  })
})

describe('删除/关闭的内联确认（回归：window.confirm 系统弹窗）', () => {
  const noop = () => {}
  const strip = (overrides = {}) =>
    renderConfirm({
      action: 'delete',
      name: 'github',
      busy: false,
      onConfirm: noop,
      onCancel: noop,
      ...overrides,
    })
  const labels = (buttons) => buttons.map((b) => collectText(b).join(''))

  it('导出 ConfirmStrip 组件', () => {
    assert.equal(typeof client.ConfirmStrip, 'function')
  })

  it('删除态：说明后果并给出确认/取消两个按钮', () => {
    const { texts, buttons } = strip()
    assert.ok(
      texts.some((t) => t.includes('github')),
      '文案应点名服务器',
    )
    assert.ok(
      texts.some((t) => t.includes('立即移除')),
      '应说明工具会立即移除',
    )
    assert.deepEqual(labels(buttons), ['确认删除', '取消'])
  })

  it('关闭态：文案说关闭与该服务器工具被移除，确认按钮不叫「删除」', () => {
    const { texts, buttons } = strip({ action: 'disable', name: 'logs' })
    assert.ok(
      texts.some((t) => t.includes('logs')),
      '文案应点名服务器',
    )
    assert.ok(
      texts.some((t) => t.includes('关闭')),
      '应说明是关闭',
    )
    assert.ok(
      texts.some((t) => t.includes('移除')),
      '应说明工具会移除',
    )
    assert.deepEqual(labels(buttons), ['确认关闭', '取消'])
  })

  it('点确认只回调 onConfirm，点取消只回调 onCancel', () => {
    let confirmed = 0
    let cancelled = 0
    const { buttons } = strip({
      onConfirm: () => {
        confirmed++
      },
      onCancel: () => {
        cancelled++
      },
    })
    buttons[0].props.onClick()
    assert.equal(confirmed, 1)
    assert.equal(cancelled, 0)
    buttons[1].props.onClick()
    assert.equal(cancelled, 1)
    assert.equal(confirmed, 1)
  })

  it('busy 时两个按钮都禁用（请求在途不可重复提交、不可取消）', () => {
    const { buttons } = strip({ busy: true })
    assert.deepEqual(
      buttons.map((b) => b.props.disabled),
      [true, true],
    )
  })

  it('确认按钮按语义取色：删除用错误色，关闭用主色', () => {
    assert.equal(strip().buttons[0].props.style.background, 'var(--mcp-error)')
    const disableStyle = strip({ action: 'disable' }).buttons[0].props.style.background
    assert.notEqual(disableStyle, 'var(--mcp-error)')
  })
})

describe('ServerRow：确认态与请求在途（回归：删除在途时可重复点确认）', () => {
  const noop = () => {}
  const server = { serverName: 'github', transport: 'stdio', command: 'npx', args: [], enabled: true }
  const row = (overrides = {}) =>
    client.ServerRow({
      server,
      status: { state: 'ok' },
      toggling: false,
      deleting: false,
      pending: null,
      onToggle: noop,
      onAsk: noop,
      onConfirm: noop,
      onCancel: noop,
      onEdit: noop,
      ...overrides,
    })

  it('常态：开关 + 编辑/删除两个按钮，确认条不出现', () => {
    const tree = row()
    assert.deepEqual(
      collectButtons(tree).map((b) => collectText(b).join('')),
      ['编辑', '删除'],
    )
    // 开启/关闭的文案仍然可见：开关旁边就是原来的动作词。
    assert.equal(collectText(tree).includes('关闭'), true)
    assert.equal(
      collectText(tree).some((t) => t.includes('？')),
      false,
    )
  })

  it('pending=delete：按钮行换成确认条，只留确认/取消', () => {
    const { buttons } = { buttons: collectButtons(row({ pending: 'delete' })) }
    assert.deepEqual(
      buttons.map((b) => collectText(b).join('')),
      ['确认删除', '取消'],
    )
  })

  it('pending=disable：确认条标题说明是关闭', () => {
    const buttons = collectButtons(row({ pending: 'disable' }))
    assert.deepEqual(
      buttons.map((b) => collectText(b).join('')),
      ['确认关闭', '取消'],
    )
  })

  it('删除请求在途（deleting）：确认条两个按钮都禁用', () => {
    const buttons = collectButtons(row({ pending: 'delete', deleting: true }))
    assert.deepEqual(
      buttons.map((b) => b.props.disabled),
      [true, true],
    )
  })

  it('开关请求在途（toggling）：确认条两个按钮都禁用', () => {
    const buttons = collectButtons(row({ pending: 'disable', toggling: true }))
    assert.deepEqual(
      buttons.map((b) => b.props.disabled),
      [true, true],
    )
  })
})

// 前置检查的判定是**主文案**，异步失败只能作为细节。README 承诺的「设置页状态
// 直接给出可照改的一句话」最终就落在这两行渲染上：宿主把两段都放进状态，设置页
// 必须先显示可照改的那句，而不是只显示（或先显示）「连接失败：SdkError:
// Connection closed」——那正是前置检查存在的意义所在要替换掉的那句话。
describe('ServerRow：前置检查的判定在前、异步失败作为细节在后（回归：可照改的一句话被冲掉）', () => {
  const noop = () => {}
  const server = { serverName: 'ghost', transport: 'stdio', command: 'nope-binary', args: [], enabled: true }
  const row = (status) =>
    client.ServerRow({
      server,
      status,
      toggling: false,
      deleting: false,
      pending: null,
      onToggle: noop,
      onAsk: noop,
      onConfirm: noop,
      onCancel: noop,
      onEdit: noop,
    })

  const PROBLEM = '找不到可执行文件：C:\\gone\\python.exe（路径是否正确？或它在 PATH 里吗？）'
  const PREFLIGHT = `启动前置检查未通过：${PROBLEM}`
  const FAILURE = '连接失败：SdkError: Connection closed'

  it('两段都渲染，可照改的那句在前', () => {
    const texts = collectText(
      row({ state: 'error', message: PREFLIGHT, detail: true, preflight: PROBLEM, failure: FAILURE }),
    )
    assert.ok(texts.includes(PREFLIGHT), `应显示前置检查那句话，实际渲染：${JSON.stringify(texts)}`)
    assert.ok(texts.includes(FAILURE), `异步失败应作为细节保留，实际渲染：${JSON.stringify(texts)}`)
    assert.ok(
      texts.indexOf(PREFLIGHT) < texts.indexOf(FAILURE),
      `前置检查那句应排在异步失败前面：${JSON.stringify(texts)}`,
    )
  })

  it('没有 failure 时只渲染主文案一行（不凭空多一行）', () => {
    const texts = collectText(row({ state: 'error', message: FAILURE, detail: true }))
    assert.deepEqual(
      texts.filter((text) => text.includes('SdkError')),
      [FAILURE],
    )
  })

  it('ok / disabled 状态不渲染 failure（历史错误不留在绿点上）', () => {
    for (const state of ['ok', 'disabled']) {
      const texts = collectText(row({ state, message: '', detail: false, failure: FAILURE }))
      assert.equal(
        texts.some((text) => text.includes('SdkError')),
        false,
        `${state} 状态不应渲染 failure：${JSON.stringify(texts)}`,
      )
    }
  })
})

describe('外壳原生控件：kit 路径与降级路径', () => {
  const noop = () => {}
  const server = { serverName: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], enabled: true }
  const rowProps = (overrides = {}) => ({
    server,
    status: { state: 'ok' },
    toggling: false,
    deleting: false,
    pending: null,
    onToggle: noop,
    onAsk: noop,
    onConfirm: noop,
    onCancel: noop,
    onEdit: noop,
    ...overrides,
  })
  const formProps = (overrides = {}) => ({
    initial: { transport: 'stdio', command: 'npx' },
    saving: false,
    error: '',
    onSave: noop,
    onError: noop,
    onCancel: noop,
    ...overrides,
  })

  it('模块表提供原语时取用它：MCP_UI 就是外壳给的那个模块对象', () => {
    const kit = fakePrimitives()
    const mod = loadClientBundle({ primitives: kit })
    assert.equal(mod.MCP_UI, kit, 'MCP_UI 必须就是外壳给的那个模块对象')
  })

  it('kit 路径：行内控件走原生 Switch / StateDot / Tag / Button', () => {
    const kit = fakePrimitives()
    const mod = loadClientBundle({ primitives: kit })
    const tree = mod.ServerRow(rowProps())
    const types = collectByType(tree, kit.Button).length

    assert.equal(collectByType(tree, kit.Switch).length, 1, '开关应用原生 Switch')
    assert.equal(collectByType(tree, kit.StateDot).length, 1, '状态点应用原生 StateDot')
    assert.equal(collectByType(tree, kit.Tag).length, 2, '传输方式与状态标签应用原生 Tag')
    assert.equal(types, 2, '操作按钮应用原生 Button')
    // 文案逐字未变，只是挂到了原生组件上。
    const texts = collectText(tree)
    for (const copy of ['github', 'stdio', '关闭', '已挂载', '编辑', '删除']) {
      assert.equal(texts.includes(copy), true, `应保留文案：${copy}`)
    }
  })

  it('kit 路径：开关的语义与原来的动作按钮一致（关闭先确认，开启直接执行）', () => {
    const kit = fakePrimitives()
    const mod = loadClientBundle({ primitives: kit })
    const toggles = []
    const asks = []
    const tree = mod.ServerRow(
      rowProps({
        onToggle: (s) => toggles.push(s.serverName),
        onAsk: (s, action) => asks.push(`${s.serverName}:${action}`),
      }),
    )
    const toggle = collectByType(tree, kit.Switch)[0]
    assert.equal(toggle.props.checked, true)
    assert.equal(toggle.props.label, '关闭')
    toggle.props.onChange(false)
    assert.deepEqual(asks, ['github:disable'], '要求关闭 → 先走确认')
    assert.deepEqual(toggles, [])
    toggle.props.onChange(true)
    assert.deepEqual(toggles, ['github'], '要求开启 → 无副作用，直接执行')

    const off = collectByType(mod.ServerRow(rowProps({ server: { ...server, enabled: false } })), kit.Switch)[0]
    assert.equal(off.props.checked, false)
    assert.equal(off.props.label, '开启')
  })

  it('kit 路径：状态点与状态标签按语义取原生状态/语气', () => {
    const kit = fakePrimitives()
    const mod = loadClientBundle({ primitives: kit })
    const statusDot = (state) => collectByType(mod.ServerRow(rowProps({ status: { state } })), kit.StateDot)[0]
    const statusTag = (state) => collectByType(mod.ServerRow(rowProps({ status: { state } })), kit.Tag).pop()

    assert.equal(statusDot('ok').props.state, 'done')
    assert.equal(statusDot('disabled').props.state, 'idle')
    assert.equal(statusDot('error').props.state, 'error')
    assert.equal(statusTag('ok').props.tone, 'success')
    assert.equal(statusTag('disabled').props.tone, 'neutral')
    assert.equal(statusTag('error').props.tone, 'danger')
    assert.equal(textOf(statusTag('disabled')), '已关闭')

    // 「已挂载、尚未确认连上」不能画成成功：绿色 + 「已挂载」正是用户报的
    // 「连不上却显示已挂载」。
    assert.equal(statusDot('connecting').props.state, 'ongoing', '连接中不可以用 done 绿点')
    assert.equal(statusTag('connecting').props.tone, 'outline', '连接中不可以用 success 语气')
    assert.equal(textOf(statusTag('connecting')), '连接中')
  })

  it('降级路径：连接中用中性灰，不是成功绿', () => {
    const mod = loadClientBundle({ primitives: null })
    const html = JSON.stringify(mod.ServerRow(rowProps({ status: { state: 'connecting' } })))
    const ok = JSON.stringify(mod.ServerRow(rowProps({ status: { state: 'ok' } })))
    assert.ok(html.includes('--mcp-fg-3'), '连接中的点应是中性色')
    assert.ok(!html.includes('--mcp-success'), '连接中不得出现成功色')
    assert.ok(ok.includes('--mcp-success'), '已确认连接仍是成功色')
  })

  it('kit 路径：表单单行字段走原生 Input，多行与下拉保持插件自己的元素', () => {
    const kit = fakePrimitives()
    const mod = loadClientBundle({ primitives: kit })
    const tree = mod.ServerForm(formProps())

    const inputs = collectByType(tree, kit.Input)
    assert.equal(inputs.length, 5, 'serverName / command / cwd / toolCallTimeoutMs / reconnectMaxAttempts 走原生 Input')
    assert.equal(inputs[4].props.type, 'number', 'number 字段的类型原样透传')
    assert.equal(collectByType(tree, 'textarea').length, 2, 'args / env 是多行文本，原生 Input 表达不了')
    assert.equal(collectByType(tree, 'select').length, 3, '下拉没有对应的原生原子')
    assert.deepEqual(collectByType(tree, kit.Button).map(textOf), ['保存', '取消'])

    const texts = collectText(tree)
    for (const copy of ['名称（serverName）', '命令（command）', '参数（args，每行一个）', '保存']) {
      assert.equal(texts.includes(copy), true, `应保留文案：${copy}`)
    }
  })

  it('kit 路径：内联确认条的两个按钮走原生 Button（不加确认勾选框、不弹遮罩）', () => {
    const kit = fakePrimitives()
    const mod = loadClientBundle({ primitives: kit })
    const tree = mod.ConfirmStrip({ action: 'delete', name: 'github', busy: false, onConfirm: noop, onCancel: noop })

    assert.deepEqual(collectByType(tree, kit.Button).map(textOf), ['确认删除', '取消'])
    assert.equal(collectButtons(tree).length, 0, 'kit 路径下不该再出现手写 button')
    assert.equal(
      collectText(tree).some((t) => t.includes('github')),
      true,
    )
    assert.equal(collectByType(tree, kit.Button)[0].props.danger === undefined, true, '危险色由 className 表达')
    assert.equal(collectByType(tree, kit.Button)[0].props.className, 'dsh-mcp-danger')
  })

  it('降级（模块表里没有这个包）：MCP_UI 为 null，控件退回原生元素且渲染不抛错', () => {
    const mod = loadClientBundle()
    assert.equal(mod.MCP_UI, null, 'require 抛错时必须吞掉并降级')
    assert.match(mod.MCP_UI_ERROR, /不支持 require/, '降级的原因要留下来，别把错误吞得无声无息')
    assert.equal(typeof mod.apply, 'function', '降级后插件仍要能装配')

    const tree = mod.ServerRow(rowProps())
    assert.deepEqual(collectButtons(tree).map(textOf), ['编辑', '删除'])
    assert.equal(collectText(tree).includes('关闭'), true, '降级路径同样保留可见文案')
    const toggle = collectByType(tree, 'input')[0]
    assert.equal(toggle.props.type, 'checkbox')
    assert.equal(toggle.props.checked, true)
    assert.equal(toggle.props.disabled, false)
    assert.equal(toggle.props['aria-label'], '关闭')

    const form = mod.ServerForm(formProps())
    assert.equal(collectByType(form, 'input').length, 5, 'serverName / command / cwd / 两个数字字段回到自带 input')
    assert.deepEqual(collectButtons(form).map(textOf), ['保存', '取消'])
  })

  it('降级（表里同名模块形状不对）：同样退回原生元素，不白屏', () => {
    const mod = loadClientBundle({ primitives: 'broken' })
    assert.equal(mod.MCP_UI, null, '形状不符时必须当作拿不到')
    assert.equal(mod.MCP_UI_ERROR, '', '形状不符不是异常，只是拒绝')
    assert.deepEqual(collectButtons(mod.ServerRow(rowProps())).map(textOf), ['编辑', '删除'])
  })

  it('降级路径照常注册设置页并注入样式表', () => {
    styleTags.length = 0
    const mod = loadClientBundle()
    const effects = []
    const registered = []
    mod.apply({
      effect: (fn) => {
        effects.push(fn())
      },
      slots: { inject: (_key, cb) => cb(), register: (options) => registered.push(options) },
    })
    assert.equal(styleTags.length, 1)
    assert.equal(registered.length, 1)
    assert.equal(registered[0].id, 'mcp')
    assert.equal(registered[0].order, 31)
    assert.equal(registered[0].label(), 'MCP 服务器')
    effects.forEach((dispose) => dispose())
  })
})

describe('危险操作确认：外壳原生 RiskConfirmation（kit 路径）与内联确认条（降级路径）', () => {
  const noop = () => {}
  const server = { serverName: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], enabled: true }
  const rowProps = (overrides = {}) => ({
    server,
    status: { state: 'ok' },
    toggling: false,
    deleting: false,
    pending: null,
    acknowledged: false,
    onToggle: noop,
    onAsk: noop,
    onConfirm: noop,
    onCancel: noop,
    onAcknowledgedChange: noop,
    onEdit: noop,
    ...overrides,
  })
  const promptProps = (overrides = {}) => ({
    action: 'delete',
    name: 'github',
    busy: false,
    acknowledged: false,
    onAcknowledgedChange: noop,
    onConfirm: noop,
    onCancel: noop,
    ...overrides,
  })

  it('kit 路径：确认换外壳原生 RiskConfirmation，插件不再自己拼确认条', () => {
    const kit = fakePrimitives()
    const mod = loadClientBundle({ primitives: kit })
    assert.equal(typeof mod.ConfirmPrompt, 'function', '确认入口应是 ConfirmPrompt（按动作分派两条路径）')

    const tree = mod.ConfirmPrompt(promptProps())
    const risks = collectByType(tree, kit.RiskConfirmation)
    assert.equal(risks.length, 1, '必须渲染外壳原生 RiskConfirmation（同一性比较，不靠名字猜）')
    assert.equal(collectByType(tree, mod.ConfirmStrip).length, 0, 'kit 路径不该再用内联条')
    assert.equal(collectByType(tree, kit.Button).length, 0, '确认/取消按钮由原生组件内部渲染')
    assert.equal(collectButtons(tree).length, 0, 'kit 路径不该再出现手写 button')

    const p = risks[0].props
    assert.equal(p.open, true)
    assert.equal(p.title, '删除')
    assert.equal(p.description, '删除「github」？它的工具会立即移除。')
    assert.equal(p.acknowledgeLabel, '我已了解，删除后无法恢复')
    assert.equal(p.cancelLabel, '取消')
    assert.equal(p.closeLabel, '关闭')
    assert.equal(p.confirmLabel, '确认删除')
    assert.equal(p.acknowledged, false, '未勾选 → 确认动作由外壳保持不可用')
    assert.equal(p.disabled, false)
  })

  it('kit 路径：「关闭」走同一入口，文案按动作分派（描述说清配置保留）', () => {
    const kit = fakePrimitives()
    const mod = loadClientBundle({ primitives: kit })
    const p = collectByType(mod.ConfirmPrompt(promptProps({ action: 'disable' })), kit.RiskConfirmation)[0].props
    assert.equal(p.title, '关闭')
    assert.equal(p.description, '关闭「github」？它的工具会立即移除，配置保留。')
    assert.equal(p.confirmLabel, '确认关闭')
    assert.equal(p.acknowledgeLabel, '我已了解，关闭后工具会立即移除')
  })

  it('kit 路径：勾选态由调用方持有（acknowledged 原样透传），回调都接上', () => {
    const kit = fakePrimitives()
    const mod = loadClientBundle({ primitives: kit })
    const acks = []
    const fired = []
    const tree = mod.ConfirmPrompt(
      promptProps({
        acknowledged: true,
        onAcknowledgedChange: (value) => acks.push(value),
        onConfirm: () => fired.push('confirm'),
        onCancel: () => fired.push('cancel'),
      }),
    )
    const p = collectByType(tree, kit.RiskConfirmation)[0].props
    assert.equal(p.acknowledged, true, '外壳只在 acknowledged 为真时放行确认')
    p.onAcknowledgedChange(true)
    assert.deepEqual(acks, [true])
    p.onConfirm()
    p.onCancel()
    assert.deepEqual(fired, ['confirm', 'cancel'])
  })

  it('kit 路径：在途请求时整条确认禁用、确认按钮文案换成「处理中…」', () => {
    const kit = fakePrimitives()
    const mod = loadClientBundle({ primitives: kit })
    const p = collectByType(mod.ConfirmPrompt(promptProps({ busy: true })), kit.RiskConfirmation)[0].props
    assert.equal(p.disabled, true)
    assert.equal(p.confirmLabel, '处理中…')
  })

  it('降级（模块表里没有原语）：确认退回今天的按钮行内联条，不白屏', () => {
    const mod = loadClientBundle()
    assert.equal(mod.MCP_UI, null)
    assert.equal(typeof mod.ConfirmPrompt, 'function', '降级路径要有同一个确认入口')
    const tree = mod.ConfirmPrompt(promptProps())
    const buttons = collectButtons(tree)
    assert.deepEqual(buttons.map(textOf), ['确认删除', '取消'], '降级路径保持今天的确认条按钮')
    assert.equal(buttons[0].props.style, mod.MCP_STYLES.buttonDangerSolid, '实心红确认色一字不改')
    assert.equal(buttons[1].props.style, mod.MCP_STYLES.buttonGhost)
    assert.equal(
      collectText(tree).some((text) => text.includes('github')),
      true,
      '确认条要说清在确认哪一台服务器',
    )
  })

  it('降级（表里同名模块形状不对）：确认同样退回内联条', () => {
    const mod = loadClientBundle({ primitives: 'broken' })
    assert.equal(mod.MCP_UI, null)
    assert.deepEqual(collectButtons(mod.ConfirmPrompt(promptProps())).map(textOf), ['确认删除', '取消'])
  })

  it('部分降级（有原语但没有 RiskConfirmation）：退回内联条，件件仍用得到的原生组件', () => {
    const kit = fakePrimitives()
    delete kit.RiskConfirmation
    const mod = loadClientBundle({ primitives: kit })
    assert.equal(mod.MCP_UI, kit, '缺一个组件不该把整套原语扔掉')
    const tree = mod.ConfirmPrompt(promptProps())
    assert.deepEqual(collectByType(tree, kit.Button).map(textOf), ['确认删除', '取消'])
    assert.equal(collectButtons(tree).length, 0)
  })

  it('ServerRow 的确认入口接上勾选通道（哪一行在确认，只有它拿到 ack）', () => {
    const kit = fakePrimitives()
    const mod = loadClientBundle({ primitives: kit })
    const tree = mod.ServerRow(rowProps({ pending: 'delete', acknowledged: true }))
    const p = collectByType(tree, kit.RiskConfirmation)[0].props
    assert.equal(p.description.includes('github'), true)
    assert.equal(p.acknowledged, true)
    // 没在确认的行不该冒出确认框（pending: null → 确认入口整个不渲染）。
    const idle = mod.ServerRow(rowProps())
    assert.equal(collectByType(idle, kit.RiskConfirmation).length, 0)
    assert.equal(
      collectText(idle).some((text) => text.includes('确认')),
      false,
    )
  })

  it('勾选态跟着确认目标走：换一条服务器 / 换一个动作就回到未勾选', () => {
    const mod = loadClientBundle()
    assert.equal(typeof mod.isAcknowledged, 'function', '勾选态迁移应是可单测的纯函数')
    assert.equal(mod.isAcknowledged({ name: 'github', acknowledged: true }, 'github'), true)
    assert.equal(mod.isAcknowledged({ name: 'github' }, 'github'), false, '没有 ack 字段 = 未勾选')
    assert.equal(
      mod.isAcknowledged({ name: 'other', acknowledged: true }, 'github'),
      false,
      '别的服务器勾了不算（勾选不跨目标残留）',
    )
    assert.equal(mod.isAcknowledged(null, 'github'), false)
    assert.equal(mod.isAcknowledged({ name: 'github', acknowledged: 'true' }, 'github'), false, '只认布尔真')
  })

  // 默认 React 替身的 setState 是空操作，测不到「勾上 → 重新渲染后确认动作才可用」这条链。
  // 这里喂一份指定的初始 state，并把 patch 的更新函数真的应用一次，看它写出什么。
  function renderSection(state) {
    const updates = []
    let current = null
    const react = {
      createElement: fakeReact.createElement,
      useEffect: () => {},
      useState: (init) => {
        current = Object.assign({}, init, state)
        return [current, (updater) => updates.push(typeof updater === 'function' ? updater(current) : updater)]
      },
    }
    const kit = fakePrimitives()
    const mod = loadClientBundle({ primitives: kit, react })
    const tree = mod.McpSection({})
    return { kit, mod, tree, updates, row: collectByType(tree, mod.ServerRow)[0] }
  }
  const sectionState = (pending) => ({
    servers: [server],
    status: {},
    rev: 1,
    loading: false,
    editing: null,
    pending,
  })

  it('McpSection：勾选写回 pending，确认框跟着解锁（未勾选时 acknowledged 为假）', () => {
    const { kit, tree, updates, row } = renderSection(sectionState({ name: 'github', action: 'delete' }))
    assert.ok(row, '应以「正在确认删除」的状态渲染出服务器行')
    assert.equal(row.props.pending, 'delete')
    assert.equal(row.props.acknowledged, false, '新的一次确认从未勾选开始')
    assert.equal(collectByType(tree, kit.RiskConfirmation)[0].props.acknowledged, false)

    row.props.onAcknowledgedChange(true)
    assert.equal(updates.length, 1, '勾选要落到状态里（否则勾了也没用）')
    assert.deepEqual(host(updates[0].pending), { name: 'github', action: 'delete', acknowledged: true })
  })

  it('McpSection：已勾选的状态原样透传给确认框（只有正在确认的那一行）', () => {
    const { kit, tree, row } = renderSection(sectionState({ name: 'github', action: 'delete', acknowledged: true }))
    assert.equal(row.props.acknowledged, true)
    const risk = collectByType(tree, kit.RiskConfirmation)[0]
    assert.equal(risk.props.acknowledged, true, '外壳据此放行确认动作')
    assert.equal(risk.props.title, '删除')

    // 确认目标是别的服务器时，这一行不该被当成「正在确认」。
    const other = renderSection(sectionState({ name: 'logs', action: 'delete', acknowledged: true }))
    assert.equal(other.row.props.pending, null)
    assert.equal(other.row.props.acknowledged, false)
    assert.equal(collectByType(other.tree, kit.RiskConfirmation).length, 0)
  })
})

describe('按钮图标：外壳原生图标走 Button 的 icon 槽（降级路径保留文字字形）', () => {
  const noop = () => {}
  const server = { serverName: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], enabled: true }
  const rowProps = (overrides = {}) => ({
    server,
    status: { state: 'ok' },
    toggling: false,
    deleting: false,
    pending: null,
    acknowledged: false,
    onToggle: noop,
    onAsk: noop,
    onConfirm: noop,
    onCancel: noop,
    onAcknowledgedChange: noop,
    onEdit: noop,
    ...overrides,
  })
  const withText = (kit, tree, text) => collectByType(tree, kit.Button).find((node) => textOf(node) === text)
  // 图标挂在 Button 的 icon 槽（props）上，不在 children 里，所以 collectByType 找不到
  // 它——按同一性断言「icon 槽里就是外壳那个图标组件」才是真正的证据。
  const iconOf = (kit, tree, text) => withText(kit, tree, text).props.icon

  it('kit 路径：「添加服务器」用原生 IconPlusOutline16，文案里不再带全角 ＋', () => {
    const kit = fakePrimitives()
    const mod = loadClientBundle({ primitives: kit })
    const tree = mod.McpSection({})
    const add = withText(kit, tree, '添加服务器')
    assert.ok(add, 'kit 路径的按钮文案应是字典里不带字形的那条')
    assert.equal(iconOf(kit, tree, '添加服务器').type, kit.IconPlusOutline16, 'icon 槽里是外壳的原生加号')
    assert.equal(
      collectText(tree).some((text) => text.includes('＋')),
      false,
      'kit 路径不该再出现全角加号',
    )
  })

  it('kit 路径：刷新走原生 IconRefreshOutline16（刷新文案本来就不带字形）', () => {
    const kit = fakePrimitives()
    const mod = loadClientBundle({ primitives: kit })
    const refresh = withText(kit, mod.McpSection({}), '刷新')
    assert.ok(refresh, '刷新按钮文案不变')
    assert.equal(iconOf(kit, mod.McpSection({}), '刷新').type, kit.IconRefreshOutline16)
  })

  it('kit 路径：行内「编辑 / 删除」也走原生图标', () => {
    const kit = fakePrimitives()
    const mod = loadClientBundle({ primitives: kit })
    const tree = mod.ServerRow(rowProps())
    assert.equal(iconOf(kit, tree, '编辑').type, kit.IconEditOutline16)
    assert.equal(iconOf(kit, tree, '删除').type, kit.IconTrashOutline16)
    assert.equal(textOf(withText(kit, tree, '删除')), '删除', '字形只由图标画，文案就是动作词')
  })

  it('部分降级（有 Button 但没有加号图标）：退回带字形的文案，按钮不空', () => {
    const kit = fakePrimitives()
    delete kit.IconPlusOutline16
    const mod = loadClientBundle({ primitives: kit })
    const tree = mod.McpSection({})
    const add = withText(kit, tree, '＋ 添加服务器')
    assert.ok(add, '没有图标就必须保留字形，否则「添加服务器」前什么都不剩')
    assert.equal(add.props.icon, null)
    assert.equal(withText(kit, tree, '添加服务器'), undefined)
  })

  it('降级（没有原语）：字形留在文案里、原生 button 不带 icon', () => {
    const mod = loadClientBundle()
    assert.equal(mod.MCP_UI, null)
    const tree = mod.McpSection({})
    const labels = collectButtons(tree).map(textOf)
    assert.deepEqual(labels, ['＋ 添加服务器', '刷新'])
    for (const node of collectButtons(tree)) {
      assert.equal('icon' in node.props, false, '降级路径不能把 icon 透给原生 <button>（React 会告警未知属性）')
    }
    for (const node of collectButtons(mod.ServerRow(rowProps()))) {
      assert.equal('icon' in node.props, false)
    }
  })

  it('字典：带字形的 addServer 原样保留，另配一条不带字形的 addServerNoIcon', () => {
    assert.equal(client.MCP_ZH.addServer, '＋ 添加服务器', '带字形的旧键不能改：降级路径还在用它')
    assert.equal(client.MCP_ZH.addServerNoIcon, '添加服务器', 'kit 路径用无字形键，字形由外壳图标画')
    assert.equal(client.MCP_EN.addServer, '+ Add server')
    assert.equal(client.MCP_EN.addServerNoIcon, 'Add server')
  })
})

describe('parseLines', () => {
  it('兼容 \\n 与 \\r\\n 混排，去空行去首尾空白', () => {
    assert.deepEqual(host(client.parseLines(' a \r\n\r\n  b\nc  ')), ['a', 'b', 'c'])
  })
  it('空输入 → []', () => {
    assert.deepEqual(host(client.parseLines(undefined)), [])
    assert.deepEqual(host(client.parseLines('')), [])
  })
})

describe('parseEnv', () => {
  it('KEY=VALUE 解析并 trim', () => {
    assert.deepEqual(host(client.parseEnv(' A = 1 \nB = x=y z')), { A: '1', B: 'x=y z' })
  })
  it('无 = 的行被跳过', () => {
    assert.deepEqual(host(client.parseEnv('A=1\nbogus\n')), { A: '1' })
  })
})

describe('parseHeaders', () => {
  it('同时接受 KEY: VALUE 与 KEY=VALUE', () => {
    assert.deepEqual(host(client.parseHeaders('Authorization: Bearer t\nX-Api = k')), {
      Authorization: 'Bearer t',
      'X-Api': 'k',
    })
  })
  it('= 比 : 优先（两者都出现时取更靠前的分隔符）', () => {
    assert.equal(client.parseHeaders('A=b:c')['A'], 'b:c')
  })
  it('无分隔符的行被跳过', () => {
    assert.deepEqual(host(client.parseHeaders('just-a-line\nB: v')), { B: 'v' })
  })
})

describe('joinEntries × parseEnv 往返', () => {
  it('对象 → 文本 → 对象 无损', () => {
    const original = { A: '1', B: 'x=y' }
    assert.deepEqual(host(client.parseEnv(client.joinEntries(original))), original)
  })
})

describe('buildServerObject（表单 → 服务器对象）', () => {
  const form = () => ({
    serverName: '  my-srv  ',
    transport: 'stdio',
    command: 'npx',
    args: '-y\npkg',
    env: 'A=1\nB=2',
    cwd: ' /tmp ',
    url: '',
    headers: '',
    toolCallTimeoutMs: '30000',
    failOnStartupError: 'true',
    tlsInsecure: 'false',
    tlsCaFile: '',
    reconnectEnabled: 'true',
    reconnectMaxAttempts: '10',
  })

  it('trim serverName/cwd/url，不做 command；enabled 默认 true（新建）', () => {
    const server = client.buildServerObject(form(), {})
    assert.equal(server.serverName, 'my-srv')
    assert.equal(server.command, 'npx')
    assert.equal(server.cwd, '/tmp')
    assert.equal(server.enabled, true)
    assert.deepEqual(host(server.args), ['-y', 'pkg'])
    assert.deepEqual(host(server.env), { A: '1', B: '2' })
  })

  it('新增可配置项：toolCallTimeoutMs 转数字、failOnStartupError 字符串转布尔', () => {
    const server = client.buildServerObject(form(), {})
    assert.equal(server.toolCallTimeoutMs, 30000)
    assert.equal(server.failOnStartupError, true)
    // 空字符串 → Number('') === 0 → 交给宿主校验拒绝（>= 1）
    const relaxed = client.buildServerObject({ ...form(), toolCallTimeoutMs: '', failOnStartupError: 'false' }, {})
    assert.equal(relaxed.toolCallTimeoutMs, 0)
    assert.equal(relaxed.failOnStartupError, false)
    assert.match(validateServers([relaxed]), /toolCallTimeoutMs/)
  })

  it('TLS / 重连字段：字符串转布尔、路径 trim、次数转数字', () => {
    const server = client.buildServerObject(
      {
        ...form(),
        tlsInsecure: 'true',
        tlsCaFile: '  C:\\certs\\ca.pem  ',
        reconnectEnabled: 'false',
        reconnectMaxAttempts: '3',
      },
      {},
    )
    assert.equal(server.tlsInsecure, true)
    assert.equal(server.tlsCaFile, 'C:\\certs\\ca.pem')
    assert.equal(server.reconnectEnabled, false)
    assert.equal(server.reconnectMaxAttempts, 3)
    assert.equal(validateServers([server]), null)
  })

  it('缺省（旧版表单没有这些输入）时回落到默认值，不产生非法值', () => {
    const legacyForm = {
      serverName: 'local',
      transport: 'stdio',
      command: 'npx',
      args: '',
      env: '',
      cwd: '',
      url: '',
      headers: '',
      toolCallTimeoutMs: '60000',
      failOnStartupError: 'false',
    }
    const server = client.buildServerObject(legacyForm, {})
    assert.equal(server.tlsInsecure, false)
    assert.equal(server.tlsCaFile, '')
    assert.equal(server.reconnectEnabled, true)
    assert.equal(server.reconnectMaxAttempts, 10)
    assert.equal(validateServers([server]), null)
  })

  it('编辑时保留原 enabled（关闭中的服务器保存后仍关闭）', () => {
    const server = client.buildServerObject(form(), { enabled: false })
    assert.equal(server.enabled, false)
  })
})

describe('客户端 → 宿主往返契约', () => {
  const form = (overrides = {}) => ({
    serverName: 'local',
    transport: 'stdio',
    command: 'npx',
    args: '-y\npkg',
    env: 'TOKEN=abc',
    cwd: '/work',
    url: '',
    headers: '',
    toolCallTimeoutMs: '60000',
    failOnStartupError: 'false',
    ...overrides,
  })

  it('表单产出的 stdio/http 服务器都能通过宿主校验并构造 mcp-client 配置', () => {
    const stdio = client.buildServerObject(form(), {})
    const http = client.buildServerObject(
      {
        serverName: 'remote',
        transport: 'streamable-http',
        url: '  http://localhost:3000/mcp  ',
        headers: 'Authorization: Bearer t',
        command: '',
        args: '',
        env: '',
        cwd: '',
        toolCallTimeoutMs: '60000',
        failOnStartupError: 'false',
      },
      {},
    )
    assert.equal(validateServers([stdio, http]), null)
    assert.equal(buildClientConfig(stdio).command, 'npx')
    assert.equal(buildClientConfig(http).url, 'http://localhost:3000/mcp')
  })

  it('自签名内网服务器的表单产出：TLS 字段通过宿主校验但不进 mcp-client 配置', () => {
    const form = client.buildServerObject(
      {
        serverName: 'logs',
        transport: 'streamable-http',
        url: 'https://10.170.17.55:8091/mcp',
        headers: 'X-API-Token: env:SYSLOG_TOKEN',
        command: '',
        args: '',
        env: '',
        cwd: '',
        toolCallTimeoutMs: '60000',
        failOnStartupError: 'false',
        tlsInsecure: 'true',
        tlsCaFile: '',
        reconnectEnabled: 'true',
        reconnectMaxAttempts: '5',
      },
      {},
    )
    assert.equal(validateServers([form]), null)
    assert.equal(form.tlsInsecure, true)
    const config = buildClientConfig(form)
    assert.equal(config.url, 'https://10.170.17.55:8091/mcp')
    assert.equal('tlsInsecure' in config, false)
    assert.deepEqual(config.reconnect, { maxAttempts: 5 })
  })

  it('漏填必填字段的客户端产物被宿主侧拒绝（信息一致）', () => {
    const broken = client.buildServerObject(form({ command: '  ' }), {})
    assert.match(validateServers([broken]), /必须提供 command/)
  })

  it('非法超时的客户端产物被宿主侧拒绝', () => {
    const broken = client.buildServerObject(form({ toolCallTimeoutMs: '-5' }), {})
    assert.match(validateServers([broken]), /toolCallTimeoutMs/)
  })
})

describe('locale：设置页导航与页面文案跟随外壳语言', () => {
  // 设置页导航标签由注册方本地化：外壳不订阅 locale 状态，只在语言切换后
  // 重新渲染导航并再次调用 label()。所以这里断言 label 是走翻译函数的 thunk。
  const noop = () => {}

  /** 记录字典注册、并按指定语言作答的 locale 服务替身。 */
  function localeStub(active) {
    const registered = []
    return {
      registered,
      locale: {
        register: (ns, dicts) => {
          registered.push({ ns, dicts })
          return noop
        },
        bind: (ns) => (key, params) => {
          const entry = registered.find((r) => r.ns === ns)
          const template = (entry && entry.dicts[active] && entry.dicts[active][key]) || key
          if (params === undefined) return template
          return String(template).replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m))
        },
      },
    }
  }

  /** 一个收集注册结果与 effect 标签的插件上下文。 */
  function ctxWith(locale) {
    const sections = []
    const effects = []
    const ctx = {
      effect: (fn, label) => {
        effects.push(label)
        return fn()
      },
      locale,
      slots: {
        inject: (_key, cb) => cb(),
        register: (options) => {
          sections.push(options)
          return noop
        },
      },
    }
    return { ctx, sections, effects }
  }

  it('inject 声明 locale 服务（否则不激活，而不是注册一个没有文案的页面）', () => {
    assert.ok(client.inject.includes('locale'), 'client.inject 应包含 locale')
    assert.ok(client.inject.includes('slots'))
  })

  it('在 ctx.effect 里注册 zh/en 双字典，命名空间与设置页一致', () => {
    const { locale, registered } = localeStub('zh')
    const { ctx, effects } = ctxWith(locale)
    client.apply(ctx)
    assert.equal(registered.length, 1, '应注册一个命名空间')
    assert.equal(registered[0].ns, client.MCP_NS)
    assert.equal(registered[0].ns, client.MCP_SECTION_ID, '命名空间应与设置页 id 同名')
    assert.deepEqual(Object.keys(registered[0].dicts).sort(), ['en', 'zh'])
    // 双语平衡：两本字典键集必须完全一致（少一个键就是漏译）。
    assert.deepEqual(
      Object.keys(registered[0].dicts.en).sort(),
      Object.keys(registered[0].dicts.zh).sort(),
      'zh/en 键集必须一致',
    )
    assert.ok(
      effects.some((label) => String(label).includes('dictionaries')),
      '字典注册应挂在 effect 上',
    )
  })

  it('label 是 thunk：语言切换后重新调用即拿到新语言', () => {
    const en = ctxWith(localeStub('en').locale)
    client.apply(en.ctx)
    assert.equal(en.sections[0].label(), 'MCP servers')

    const zh = ctxWith(localeStub('zh').locale)
    client.apply(zh.ctx)
    assert.equal(zh.sections[0].label(), 'MCP 服务器')
  })

  it('页面文案也跟随语言（确认条与表单标签，不留半翻译页面）', () => {
    const { ctx } = ctxWith(localeStub('en').locale)
    client.apply(ctx)
    const strip = client.ConfirmStrip({
      action: 'delete',
      name: 'github',
      busy: false,
      onConfirm: noop,
      onCancel: noop,
    })
    assert.deepEqual(
      collectButtons(strip).map((b) => collectText(b).join('')),
      ['Delete', 'Cancel'],
    )
    const texts = renderFormTexts({ transport: 'stdio', command: 'npx' })
    assert.equal(texts.includes('Command (command)'), true, '应渲染英文标签')
    assert.equal(texts.includes('命令（command）'), false, '不该残留中文标签')
  })

  it('ctx.locale 缺席时退回中文、照常注册且不抛错（降级）', () => {
    const { ctx, sections } = ctxWith(undefined)
    client.apply(ctx)
    assert.equal(sections.length, 1)
    assert.equal(sections[0].id, 'mcp')
    assert.equal(sections[0].order, 31)
    assert.equal(sections[0].label(), 'MCP 服务器')
    assert.equal(renderFormTexts({ transport: 'stdio', command: 'npx' }).includes('命令（command）'), true)
  })

  it('字典注册被拒（命名空间已被占用）时仍注册页面并退回中文', () => {
    const { ctx, sections } = ctxWith({
      register: () => {
        throw new Error('locale namespace "mcp" already has locale "zh"')
      },
      bind: () => () => 'BROKEN',
    })
    client.apply(ctx)
    assert.equal(sections.length, 1)
    assert.equal(sections[0].label(), 'MCP 服务器')
  })

  it("每个 t('key') 在 zh/en 里都有键（键名打错会直接把键名显示给用户）", () => {
    const keys = [...source.matchAll(/\bt\('([A-Za-z0-9_]+)'/g)].map((m) => m[1])
    assert.ok(keys.length >= 50, `应能扫到大量 t() 调用，实际 ${keys.length}`)
    for (const key of new Set(keys)) {
      assert.ok(Object.prototype.hasOwnProperty.call(client.MCP_ZH, key), `zh 缺键：${key}`)
      assert.ok(Object.prototype.hasOwnProperty.call(client.MCP_EN, key), `en 缺键：${key}`)
    }
  })

  it('en 字典里没有残留中文（半翻译页面比不翻译更糟）', () => {
    const cjk = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/
    const leftover = Object.entries(client.MCP_EN).filter(([, value]) => cjk.test(value))
    assert.deepEqual(leftover, [], 'en 值里不该出现汉字')
  })
})
