// test/client-logic.test.js — 在 vm 沙箱里加载 client.js，断言注册契约与纯函数。
//
// 浏览器 bundle 的失败是「静默」的：id 写错、require 了宿主没提供的模块、
// slot 名拼错，宿主都只会在挂载阶段抛错、面板永远不出现。这组测试把这些
// 契约钉住。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { OBSERVATION_TYPES, OBSERVATION_SOURCES } from '../lib/logic.js'

async function loadClient() {
  const src = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const registered = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => registered.push(def) } },
    console,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    Date,
    document: undefined,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  new vm.Script(src, { filename: 'client.js' }).runInContext(sandbox)

  assert.equal(registered.length, 1, 'client.js 必须恰好调用一次 __ModuleLoader__.load')
  const def = registered[0]
  const required = []
  const mod = def.factory((name) => {
    required.push(name)
    if (name === 'react') {
      return {
        createElement: () => null,
        useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
        useEffect: () => {},
        useCallback: (f) => f,
        useRef: () => ({ current: null }),
        useMemo: (f) => f(),
      }
    }
    if (name === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }
    throw new Error(`client.js 不允许 require('${name}')：宿主只提供 react 与 react/jsx-runtime`)
  })
  return { def, mod, required }
}

function fakeCtx() {
  const calls = []
  return {
    calls,
    ctx: {
      slots: {
        inject: (name, fn) => {
          calls.push(`inject:${name}`)
          fn()
        },
        register: (registration) => {
          calls.push(`register:${registration.name}:${registration.id}`)
          return () => {}
        },
      },
    },
  }
}

describe('client bundle contract', () => {
  it('__ModuleLoader__ 的 id 必须等于包名', async () => {
    const { def } = await loadClient()
    assert.equal(def.id, 'dsh-memery')
  })

  it('只 require react 与 react/jsx-runtime', async () => {
    const { required } = await loadClient()
    assert.ok(required.length > 0, '应当 require 了 react')
    for (const name of required) {
      assert.ok(['react', 'react/jsx-runtime'].includes(name), `不允许的依赖：${name}`)
    }
  })

  it('声明 inject slots', async () => {
    const { mod } = await loadClient()
    // vm 沙箱里的数组与宿主 realm 的 Array 不同源，deepEqual 会因为原型不同
    // 而失败（比较的是同一份数据）。按值比较。
    assert.equal([...mod.inject].join(','), 'slots')
  })

  it('在两个插槽各注册一次，且 id 是自己的 id', async () => {
    const { mod } = await loadClient()
    const { ctx, calls } = fakeCtx()
    mod.apply(ctx)
    assert.ok(calls.includes('inject:sidebar.footer.action'), calls.join(','))
    assert.ok(calls.includes('inject:settings.section'), calls.join(','))
    assert.ok(calls.includes('register:sidebar.footer.action:dsh-memory'), calls.join(','))
    assert.ok(calls.includes('register:settings.section:dsh-memory'), calls.join(','))
  })

  it('apply 不抛错，也不触碰网络', async () => {
    const { mod } = await loadClient()
    const { ctx } = fakeCtx()
    assert.doesNotThrow(() => mod.apply(ctx))
  })
})

describe('panel pure functions', () => {
  it('formatCount 千分位且对垃圾输入安全', async () => {
    const { mod } = await loadClient()
    const { formatCount } = mod.__test__
    assert.equal(formatCount(0), '0')
    assert.equal(formatCount(1234), '1,234')
    assert.equal(formatCount(1234567), '1,234,567')
    assert.equal(formatCount(null), '0')
    assert.equal(formatCount('nope'), '0')
  })

  it('humanAge 的相对时间分级', async () => {
    const { mod } = await loadClient()
    const { humanAge } = mod.__test__
    const now = Date.parse('2026-09-15T12:00:00Z')
    assert.equal(humanAge('2026-09-15T11:59:30Z', now), '刚刚')
    assert.equal(humanAge('2026-09-15T11:30:00Z', now), '30 分钟前')
    assert.equal(humanAge('2026-09-15T09:00:00Z', now), '3 小时前')
    assert.equal(humanAge('2026-09-13T12:00:00Z', now), '2 天前')
    assert.equal(humanAge('nonsense', now), '')
  })

  it('detailFields 跳过空字段', async () => {
    const { mod } = await loadClient()
    const { detailFields } = mod.__test__
    assert.equal(detailFields({}).length, 0)
    const fields = detailFields({
      narrative: 'why',
      facts: ['a'],
      filesModified: [],
      concepts: undefined,
      source: 'agent',
    })
    assert.equal(fields.map((f) => f[0]).join(','), '叙述,事实,来源')
  })

  it('deleteConfirmLabel 提示不可撤销', async () => {
    const { mod } = await loadClient()
    const { deleteConfirmLabel } = mod.__test__
    assert.match(deleteConfirmLabel('Use HTTP'), /Use HTTP/)
    assert.match(deleteConfirmLabel(''), /这条记忆/)
    assert.match(deleteConfirmLabel('x'), /不可撤销/)
  })
})

describe('connectionStateOf（面板四态机）', () => {
  const stateOf = async (health) => {
    const { mod } = await loadClient()
    return mod.__test__.connectionStateOf(health)
  }

  it('up:true → ready', async () => {
    assert.equal((await stateOf({ up: true })).kind, 'ready')
  })

  it('starting:true → connecting（显示「正在自动启动」而不是失败）', async () => {
    const s = await stateOf({ up: false, starting: true })
    assert.equal(s.kind, 'connecting')
    assert.match(s.text, /启动/)
  })

  it('不可达且有 autostartError → failed，why 取更可操作的那条', async () => {
    const s = await stateOf({ up: false, error: 'fetch failed', autostartError: '启动超时', hint: '手动启动' })
    assert.equal(s.kind, 'failed')
    assert.equal(s.why, '启动超时')
    assert.equal(s.hint, '手动启动')
  })

  it('不可达且无 autostartError → why 回落到 error', async () => {
    assert.equal((await stateOf({ up: false, error: 'fetch failed' })).why, 'fetch failed')
  })

  it('空响应 → failed 且 why 不是 undefined 字面量', async () => {
    const s = await stateOf(undefined)
    assert.equal(s.kind, 'failed')
    assert.equal(s.why, '未知原因')
  })
})

describe('工作区路径传递（修「项目未解析」）', () => {
  it('workspacePathOf 从 useWorkspaces 快照里取出路径', async () => {
    const { mod } = await loadClient()
    const { workspacePathOf } = mod.__test__
    const props = {
      useWorkspaces: (selector) => selector({ items: [{ id: 'w1', path: 'E:\\work\\ai\\dsh-memery' }] }),
    }
    assert.equal(workspacePathOf(props), 'E:\\work\\ai\\dsh-memery')
  })

  it('workspacePathOf 跳过空路径，取第一个有效项', async () => {
    const { mod } = await loadClient()
    const { workspacePathOf } = mod.__test__
    const props = {
      useWorkspaces: (selector) =>
        selector({
          items: [
            { id: 'w0', path: '  ' },
            { id: 'w1', path: 'E:\\ok' },
          ],
        }),
    }
    assert.equal(workspacePathOf(props), 'E:\\ok')
  })

  it('workspacePathOf 拿不到时返回 undefined，而不是抛错', async () => {
    const { mod } = await loadClient()
    const { workspacePathOf } = mod.__test__
    assert.equal(workspacePathOf(undefined), undefined)
    assert.equal(workspacePathOf({}), undefined)
    assert.equal(workspacePathOf({ useWorkspaces: () => ({}) }), undefined)
    assert.equal(
      workspacePathOf({
        useWorkspaces: () => {
          throw new Error('boom')
        },
      }),
      undefined,
    )
  })

  it('withWorkspace 把路径编进查询串，空值则不加参数', async () => {
    const { mod } = await loadClient()
    const { withWorkspace } = mod.__test__
    const q1 = withWorkspace('E:\\work\\ai\\dsh-memery', { limit: '20' })
    assert.match(q1, /limit=20/)
    assert.match(q1, /workspace=E%3A%5Cwork%5Cai%5Cdsh-memery/)
    assert.equal(withWorkspace(undefined, { limit: '20' }), 'limit=20')
  })
})

describe('浮层锚定 computeAnchor（修「位置靠猜」）', () => {
  const mkRect = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top })

  it('侧栏在左且空间足够时，摆在触发器左侧（不盖住主区域）', async () => {
    const { mod } = await loadClient()
    // 触发器在 x=520（宽侧栏），左侧 400+10 放得下 → 应摆左侧
    const a = mod.__test__.computeAnchor(mkRect(520, 700, 780, 742), { width: 400, height: 500 })
    assert.ok(a.left < 520, `应摆左侧，实际 left=${a.left}`)
    assert.equal(a.left, 520 - 400 - 10)
  })

  it('左侧放不下时改摆右侧', async () => {
    const { mod } = await loadClient()
    const a = mod.__test__.computeAnchor(mkRect(10, 700, 46, 742), { width: 400, height: 500 })
    assert.ok(a.left >= 46, `应摆右侧，实际 left=${a.left}`)
  })

  it('结果始终夹在视口内（左右与上下）', async () => {
    const { mod } = await loadClient()
    for (const rect of [mkRect(0, 0, 40, 40), mkRect(1200, 780, 1270, 800), mkRect(5, 770, 50, 795)]) {
      const a = mod.__test__.computeAnchor(rect, { width: 400, height: 520 })
      assert.ok(a.left >= 8, `left 越界：${a.left}`)
      assert.ok(a.top >= 8, `top 越界：${a.top}`)
      assert.ok(a.width > 0 && a.maxHeight > 0)
    }
  })

  it('拿不到 rect 时退化为左下角安全位置，而不是抛错', async () => {
    const { mod } = await loadClient()
    for (const bad of [null, undefined]) {
      const a = mod.__test__.computeAnchor(bad, { width: 400, height: 520 })
      assert.equal(a.width, 400)
      assert.ok(a.top >= 8 && a.left >= 8)
    }
  })

  it('窗口很矮时 maxHeight 收缩，不会超出视口', async () => {
    const { mod } = await loadClient()
    const a = mod.__test__.computeAnchor(mkRect(300, 700, 560, 742), { width: 400, height: 5000 })
    assert.ok(a.maxHeight <= 800, `maxHeight 应被视口夹住，实际 ${a.maxHeight}`)
  })
})

describe('样式表基础设施（修「CSS 整段失效」）', () => {
  /** 建一个带最小 document 的沙箱，用于观察 <style> 注入行为。 */
  async function loadClientWithDocument() {
    const src = await readFile(new URL('../client.js', import.meta.url), 'utf8')
    const heads = []
    const makeEl = () => {
      const el = {
        id: '',
        textContent: '',
        appendChild() {},
        remove() {
          const i = heads.indexOf(el)
          if (i >= 0) heads.splice(i, 1)
        },
      }
      return el
    }
    const document = {
      head: {
        appendChild: (el) => {
          heads.push(el)
        },
      },
      documentElement: {
        appendChild: (el) => {
          heads.push(el)
        },
      },
      getElementById: (id) => heads.find((el) => el.id === id) || null,
      createElement: () => makeEl(),
    }
    const registered = []
    const sandbox = {
      window: { __ModuleLoader__: { load: (def) => registered.push(def) } },
      document,
      console,
      setTimeout,
      clearTimeout,
      URLSearchParams,
      Date,
    }
    sandbox.globalThis = sandbox
    vm.createContext(sandbox)
    new vm.Script(src, { filename: 'client.js' }).runInContext(sandbox)
    const mod = registered[0].factory((n) => {
      if (n === 'react') {
        return {
          createElement: () => null,
          useState: (v) => [v, () => {}],
          useEffect: () => {},
          useRef: () => ({ current: null }),
          useCallback: (f) => f,
        }
      }
      if (n === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null }
      throw new Error(`unexpected require: ${n}`)
    })
    return { heads, mod }
  }

  it('模块加载时就注入一次样式，不依赖任何组件挂载', async () => {
    const { heads } = await loadClientWithDocument()
    assert.equal(heads.length, 1, `应在模块作用域注入一次，实际 ${heads.length}`)
    assert.equal(heads[0].id, 'dsh-memery-style')
    assert.ok(heads[0].textContent.length > 500, 'CSS 内容应非空')
  })

  it('★ 组件生命周期结束后样式仍在（旧实现把 <style> remove 掉了）', async () => {
    const { heads, mod } = await loadClientWithDocument()
    // 旧实现的样式注入写在组件 useEffect 的清理里；这里跑一遍注册流程，
    // 该 <style> 不应因为任何组件生命周期而消失。
    mod.apply({ slots: { inject: (_n, fn) => fn(), register: () => () => {} } })
    assert.equal(heads.length, 1, '注册流程不应移除或重复注入样式')
    assert.equal(heads[0].id, 'dsh-memery-style')
  })

  it('CSS 覆盖排版关键项（截断、行高、留白）', async () => {
    const { heads } = await loadClientWithDocument()
    const css = heads[0].textContent
    for (const needle of [
      'text-overflow:ellipsis',
      'white-space:nowrap',
      '.dm-item .m',
      'padding:16px 18px',
      'gap:16px',
    ]) {
      assert.ok(css.includes(needle), `CSS 缺少关键规则：${needle}`)
    }
  })

  it('选择器都限定在 .dsh-memory 作用域内，不污染宿主', async () => {
    const { heads } = await loadClientWithDocument()
    const css = heads[0].textContent
    const selectors = css
      .split('}')
      .map((r) => r.split('{')[0].trim())
      .filter((s) => s !== '' && !s.startsWith('@') && !/^(\d+%|to|from)$/.test(s))
    const leaked = selectors.filter((s) => !s.includes('.dsh-memory'))
    assert.deepEqual(leaked, [], `以下选择器未限定作用域：${leaked.join(' | ')}`)
  })
})

describe('client/host 契约交叉校验', () => {
  it('面板的类型下拉不超出宿主允许的 type 集合', async () => {
    const { mod } = await loadClient()
    const { TYPE_OPTIONS } = mod.__test__
    for (const option of TYPE_OPTIONS) {
      if (option === '') continue
      assert.ok(OBSERVATION_TYPES.includes(option), `面板提供了宿主会拒绝的 type：${option}`)
    }
  })

  it('面板的来源下拉不超出宿主允许的 source 集合', async () => {
    const { mod } = await loadClient()
    const { SOURCE_OPTIONS } = mod.__test__
    for (const option of SOURCE_OPTIONS) {
      if (option === '') continue
      assert.ok(OBSERVATION_SOURCES.includes(option), `面板提供了宿主会拒绝的 source：${option}`)
    }
  })
})
