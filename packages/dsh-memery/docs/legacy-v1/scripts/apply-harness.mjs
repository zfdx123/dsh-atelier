// scripts/apply-harness.mjs — 用假 ctx 跑一遍真实 apply()，看它到底注册了什么 / 抛不抛。
//
// 这是「宿主半到底有没有挂上」的离线判定：不需要重启 dsh，也不需要看进程日志。
// 假 ctx 提供 connection.fetch.register / webServer / workspaceRegistry / logger，
// 并把 register 调用记下来。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire('file:///C:/Users/29154/.dsh/profiles/web/package.json')
// Windows 绝对路径必须先转成 file:// URL，ESM loader 不接受 'e:' 这种裸盘符
const resolved = require.resolve('dsh-memery')
const mod = await import(pathToFileURL(resolved).href)
console.log(`导入成功：${resolved}`)
console.log(`name=${mod.name} inject=${JSON.stringify(mod.inject)}`)

const registered = []
const effects = []
const warnings = []

const connection = {
  fetch: {
    register(route) {
      registered.push({ carrier: 'connection.fetch', path: route.path, methods: route.methods })
      return () => {}
    },
  },
  requestRejection() {
    return undefined
  },
}

const queues = []

// 真实 DSH 里 workspaceRegistry.list() 返回 Workspace[]；用环境变量切换
// 「有工作区 / 空列表」，验证明细逻辑在两种情况下都对。
const WORKSPACES =
  process.env.HARNESS_WORKSPACES === 'empty'
    ? []
    : [{ id: 'w1', path: 'E:\\work\\ai\\dsh-memery', title: 'dsh-memery' }]

const ctx = {
  get(name) {
    if (name === 'connection') return connection
    if (name === 'logger')
      return {
        info: (m) => console.log(`  [logger.info] ${m}`),
        warn: (m) => {
          warnings.push(m)
          console.log(`  [logger.warn] ${m}`)
        },
      }
    if (name === 'workspaceRegistry') return { list: () => WORKSPACES }
    return undefined
  },
  effect(fn, label) {
    effects.push(label)
    const disposer = fn()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  // Cordis 的延迟服务获取：服务就绪后才回调，回调里的 scope 才是真正的持有者。
  // 这里同步调用以模拟「服务已就绪」，但排到微任务里以贴近真实时序。
  inject(names, callback) {
    const scope = {
      get: (n) => ctx.get(n),
      effect: (fn, label) => ctx.effect(fn, label),
    }
    queues.push(Promise.resolve().then(() => callback(scope)))
    return Promise.all(queues)
  },
}

console.log('\n调用 apply() ...')
try {
  mod.apply(ctx)
  console.log('apply() 正常返回，没有抛错')
} catch (error) {
  console.log(`apply() 抛错了：${error && error.stack ? error.stack.split('\n').slice(0, 6).join('\n') : error}`)
  process.exit(1)
}

// registerHttpApi 走的是延迟获取（ctx.inject），回调异步执行；等它跑完再统计，
// 否则会误报「一条都没注册」。
await new Promise((r) => setTimeout(r, 50))

console.log(`\n注册的端点（${registered.length} 条）：`)
for (const r of registered) console.log(`  ${r.carrier}  ${r.path}  [${r.methods.join(',')}]`)

console.log(`\n注册的 effect（${effects.length} 条）：`)
for (const e of effects) console.log(`  ${e}`)

// 真正调用一次 /health 的 fetch 函数，确认它能产出 Response
const healthRoute = registered.find((r) => r.path.endsWith('/health'))
if (!healthRoute) {
  console.log('\n✗ 没有注册 /health —— 这就是面板 404 的原因')
  process.exit(1)
}

// 从 connection.fetch.register 的闭包里把 fetch 取回来：重新注册一次并截获
let captured = null
connection.fetch.register = (route) => {
  if (route.path.endsWith('/health')) captured = route
  return () => {}
}
mod.apply(ctx)
// 注册是延迟的（ctx.inject），必须等回调跑完再断言
await new Promise((r) => setTimeout(r, 50))

if (captured === null) {
  console.log('\n✗ 没能截获 health 路由的 fetch 函数')
  process.exit(1)
}

console.log('\n用假 transport 调用 health 的 fetch（控制面此时不可达，预期 200 + up:false）...')
const response = await captured.fetch(new Request(`http://127.0.0.1:3080${captured.path}`))
const text = await response.text()
console.log(`  status = ${response.status}`)
console.log(`  body   = ${text.slice(0, 300)}`)
console.log(`  content-type = ${response.headers.get('content-type')}`)
