// 注入样式表的契约（构建产物 lib/client.js）：
//
// 1. 刷新：客户端半体在 bundle/HMR 重载时会在同一份 document 上重新物化 ——
//    再跑一次 __ModuleLoader__.load → factory → 模块顶层 ensureStyle()。只按
//    「<head> 里有没有我们的 style」跳过的话，旧样式表永远留着，CSS 改动要整页
//    刷新才生效。所以按插件 id 找到旧元素替换掉（旧版写的是属性值 "true"，
//    因此按属性存在判定，不按值）。
// 2. 颜色：界面配色必须走 alpha.2 的设计令牌；没有语义令牌的（全局徽章的天空蓝）
//    保留色相但用 light-dark() 跟着 color-scheme 走，不能是固定字面量。
//
// 做法：同一份假 document 上先后物化两份 bundle（第一份把标题字号改成哨兵值，
// 冒充上一次物化的旧 CSS），断言最终只剩一个 <style> 且内容是新的。
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'lib', 'client.js')

/** 新旧 CSS 哨兵：同一选择器的字号，够区分「哪一份样式表生效」。 */
const FRESH_CSS = '.meowmem_set_title{font-size:17px'
const STALE_CSS = '.meowmem_set_title{font-size:99px'

let bundle: string
before(() => {
  bundle = readFileSync(bundlePath, 'utf8')
  assert.ok(bundle.includes(FRESH_CSS), `构建产物里应能找到 ${FRESH_CSS}（CSS 改了请同步哨兵）`)
})

interface StyleEl {
  tagName: string
  attributes: Record<string, string>
  textContent: string
  setAttribute(name: string, value: string): void
  remove(): void
}

/** 假 document：只实现注入路径用到的少量 API 与属性选择器。 */
function fakeDocument() {
  const styles: StyleEl[] = []
  const head = {
    appendChild: (node: StyleEl) => {
      styles.push(node)
      return node
    },
  }
  const matches = (node: StyleEl, selector: string): boolean => {
    const m = /^style\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector)
    if (m === null) throw new Error(`假 DOM 不支持的选择器：${selector}`)
    if (node.tagName !== 'style') return false
    const value = node.attributes[m[1] as string]
    return value !== undefined && (m[2] === undefined || m[2] === value)
  }
  const createElement = (tagName: string): StyleEl => {
    const node: StyleEl = {
      tagName,
      attributes: {},
      textContent: '',
      setAttribute(name, value) {
        node.attributes[name] = value
      },
      remove() {
        const i = styles.indexOf(node)
        if (i >= 0) styles.splice(i, 1)
      },
    }
    return node
  }
  return {
    styles,
    doc: {
      querySelector: (selector: string) => styles.find((s) => matches(s, selector)) ?? null,
      querySelectorAll: (selector: string) => styles.filter((s) => matches(s, selector)),
      createElement,
      head,
      documentElement: undefined,
    },
  }
}

/** 在给定 document 上物化一次 bundle（模块顶层代码在 factory 调用时执行）。 */
function materialize(source: string, doc: unknown): void {
  let registration: { id: string; factory: (r: (s: string) => unknown) => unknown } | null = null
  const sandbox: Record<string, unknown> = {
    window: {
      __ModuleLoader__: {
        load: (d: never) => {
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
  new vm.Script(source).runInContext(sandbox)

  assert.ok(registration !== null, 'bundle 必须调用 __ModuleLoader__.load')
  ;(registration as unknown as { factory: (r: (s: string) => unknown) => unknown }).factory((spec: string) => {
    if (spec === 'react') {
      return {
        createElement: () => null,
        Fragment: Symbol('Fragment'),
        useState: (v: unknown) => [typeof v === 'function' ? (v as () => unknown)() : v, () => {}],
        useEffect: () => {},
        useCallback: (f: never) => f,
        useMemo: (f: () => unknown) => f(),
        useRef: (v: unknown) => ({ current: v }),
      }
    }
    throw new Error(`unexpected require: ${spec}`)
  })
}

describe('注入样式表（构建产物 lib/client.js）', () => {
  it('重新物化时替换旧样式表，CSS 改动不需要整页刷新', () => {
    const { doc, styles } = fakeDocument()
    materialize(bundle.replace(FRESH_CSS, STALE_CSS), doc) // 上一次物化的产物（旧 CSS）
    assert.equal(styles.length, 1, '首次物化应注入样式表')
    assert.ok(styles[0]!.textContent.includes('font-size:99px'), '前置：旧 CSS 已在文档里')

    materialize(bundle, doc) // bundle/HMR 重载：同一份 document 上再物化一次

    assert.equal(styles.length, 1, '重载后不能留下第二份样式表，旧的那份要被替换掉')
    assert.equal(styles[0]!.textContent.includes('font-size:17px'), true, '生效的样式表必须是最新 CSS')
    assert.equal(styles[0]!.textContent.includes('font-size:99px'), false, '旧 CSS 不能残留')
  })

  it('旧版本注入的样式表（属性值为 true）也会被替换，不留第二份', () => {
    const { doc, styles } = fakeDocument()
    // 当前已发布的客户端写的属性值是 "true"：升级后第一次重载会遇到这种残留。
    const legacy = doc.createElement('style')
    legacy.setAttribute('data-dsh-memery-css', 'true')
    legacy.textContent = '.meowmem_set_title{font-size:99px}'
    doc.head.appendChild(legacy)
    assert.equal(styles.length, 1)

    materialize(bundle, doc)

    assert.equal(styles.length, 1, '旧版残留应被替换，而不是与新样式表并存')
    assert.equal(styles[0]!.textContent.includes('font-size:17px'), true, '生效的样式表必须是最新 CSS')
    assert.equal(styles[0]!.textContent.includes('font-size:99px'), false)
  })

  it('配色走 alpha.2 设计令牌 / 主题感知色，不写死调色板字面量', () => {
    const { doc, styles } = fakeDocument()
    materialize(bundle, doc)
    const css = styles[0]!.textContent

    assert.ok(css.includes('var(--dsw-alias-state-error-primary)'), '危险操作要状态错误令牌')
    assert.ok(css.includes('var(--dsw-alias-state-success-primary)'), '成功提示要状态成功令牌')
    assert.ok(css.includes('var(--dsw-alias-bg-overlay'), '下拉选项底色要浮层令牌')

    for (const literal of ['#f43f5e', '#34d399', '#ffffff', '#17181a', '#1c1c1e', '#e8e8ea']) {
      assert.equal(css.includes(literal), false, `${literal} 没有语义令牌，必须换成令牌或主题感知色`)
    }

    const badge = /\.meowmem_badge_global\{([^}]*)\}/.exec(css)?.[1] ?? ''
    assert.ok(badge.includes('light-dark('), `全局徽章没有对应令牌，须用 light-dark() 跟随主题，实际 ${badge}`)
    assert.equal(/:\s*#38bdf8\b/.test(badge), false, '徽章的天空蓝不能是固定字面量')
  })
})
