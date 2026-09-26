// 端到端冒烟测试：内存 Cordis 上下文 + 假 settings/tools/webServer 服务 +
// 极简 stdio MCP 服务器（fixtures/fake-mcp-server.mjs，放 test/ 外以免被
// node --test 默认发现规则当作测试文件执行），走真实 HTTP 接口验证
// 「配置保存即生效」全链路：
//   POST /api/mcp/servers → settings 提交 → settings/updated → 挂载
//   mcp-client → 连接假服务器 → ctx.tools 注册 mcp__\<名称\>__\<工具\>。
// 同时覆盖：真实挂载状态跟踪（日志截获）、rev 乐观锁（409）、enabled 开关、
// 密钥引用保留、failOnStartupError、toolCallTimeoutMs 自定义。
//
// 注意：dsh-mcp-client 内部使用 Promise.withResolvers（Node 22+），在
// Node 18/20 的 CI 矩阵里先做等价 polyfill 再加载。

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createVolatile, isVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import * as Manager from '../index.js'

if (!Promise.withResolvers) {
  Promise.withResolvers = function withResolvers() {
    let resolve
    let reject
    const promise = new Promise((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }
}

const FAKE_SERVER = fileURLToPath(new URL('../fixtures/fake-mcp-server.mjs', import.meta.url))

// 「绝对、且必然不存在」的可执行文件。前置检查的脚本/工作目录分支看
// node:path 的 isAbsolute，但可执行文件分支只看「带分隔符 + 不存在」，所以两边
// 都必须给一个**本平台**的真·绝对路径：原夹具 `/nonexistent-binary-xyz` 在
// Windows 上只是「当前盘根目录下的一个名字」，并不是 Windows 意义上的绝对路径。
// 从系统临时目录派生，两边都真·绝对且不存在。
const MISSING_BINARY = resolve(tmpdir(), 'dsh-mcp-manager-absent', 'nonexistent-binary-xyz')
const STDIO = (name, extra = {}) => ({
  serverName: name,
  enabled: true,
  transport: 'stdio',
  command: process.execPath,
  args: [FAKE_SERVER],
  env: {},
  cwd: '',
  url: '',
  headers: {},
  toolCallTimeoutMs: 60000,
  failOnStartupError: false,
  ...extra,
})

// ── 假服务 ───────────────────────────────────────────────────────────────

// 最小 settings 服务，按 DSH 0.1.7 契约：表单按 **loader 条目 id** 定位
// （不再有 register(ns, schema)），describe() 报告每个条目的 schema/值/修订号，
// replace(ns, section, rev) 写入并按 SETTINGS_CONFLICT 拒绝过期修订。
//
// 写入后按 Loader 的真实行为把新值就地写进 volatile 引用（updateVolatile 语义）
// 并发出 loader/volatile-update —— 插件正是靠它感知配置变化。
class FakeSettings extends Service {
  /** @type {Map<string, {ns: string, document: unknown, revision: number, ref: object}>} */
  entries = new Map()

  constructor(ctx) {
    super(ctx, 'settings')
  }

  /**
   * 登记一个条目，引用取 Loader 真正交给插件的那一个（`fiber.config.servers`，
   * 由 cordis 从**原始** config 解析出来的 volatile 引用）。
   * @param {string} ns profile 条目 id
   * @param {object} ref volatile 引用
   */
  adopt(ns, ref) {
    this.entries.set(ns, { ns, document: ref.get(), revision: 0, ref })
  }
  describe() {
    return [...this.entries.values()].map((entry) => ({
      ns: entry.ns,
      schema: entry.schema,
      value: entry.document,
      revision: entry.revision,
      autoGenerate: true,
      applies: 'live',
    }))
  }

  async replace(ns, section, expectedRevision) {
    const entry = this.entries.get(ns)
    if (entry === undefined) throw new Error(`settings entry "${ns}" does not exist`)
    if (expectedRevision !== undefined && expectedRevision !== entry.revision) {
      const error = new Error(
        `settings entry "${ns}" changed since it was read (expected revision ${expectedRevision}, now ${entry.revision})`,
      )
      error.name = 'SettingsConflictError'
      error.code = 'SETTINGS_CONFLICT'
      throw error
    }
    entry.document = section
    entry.revision += 1
    this.ctx.emit('settings/document-updated', ns, entry.revision)
    // Loader 的 volatile 提交：新值就地写进引用，再通知本 fiber。
    writeServersRef(entry.ref, section.servers ?? [])
    this.ctx.emit('loader/volatile-update', [[]])
    return entry.document
  }
}

// mcp-client 只消费 ctx.tools.register(definition)（返回 disposer）。
class FakeTools extends Service {
  defs = new Map()

  constructor(ctx) {
    super(ctx, 'tools')
  }

  register(definition) {
    this.defs.set(definition.name, definition)
    return () => this.defs.delete(definition.name)
  }
}

// webServer：把路由挂到真实 http.Server 上，handler 收到真实 Node req/res。
class FakeWebServer extends Service {
  routes = new Map()
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://internal').pathname
    const exact = this.routes.get(`exact ${pathname}`)
    if (exact) {
      exact(req, res)
      return
    }
    // 前缀路由：最长前缀优先（与 dsh-host-webserver 的语义一致）
    let best = null
    for (const [key, handler] of this.routes) {
      const [kind, prefix] = key.split(' ')
      if (kind !== 'prefix') continue
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
        if (best === null || prefix.length > best.prefix.length) best = { prefix, handler }
      }
    }
    if (best) {
      best.handler(req, res)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end('{}')
  })

  constructor(ctx) {
    super(ctx, 'webServer')
  }

  register(route) {
    const key = `${route.kind} ${route.path}`
    if (this.routes.has(key)) throw new Error(`duplicate route ${key}`)
    this.routes.set(key, route.handler)
    return () => this.routes.delete(key)
  }

  async listen() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    return this.server.address().port
  }

  async close() {
    await new Promise((resolve) => this.server.close(resolve))
  }
}

// connection：DSH 0.1.5 的 /api 共享通道。宿主在这里施加 Host/Origin 信任
// 栅栏与浏览器鉴权（本测试用 x-test-auth 头模拟已登录的浏览器 Cookie），
// 再把请求交给精确 Fetch 路由。
class FakeConnection extends Service {
  fetchRoutes = new Map()
  rejected = []

  constructor(ctx) {
    super(ctx, 'connection')
    this.fetch = {
      register: (route) => {
        this.fetchRoutes.set(route.path, route)
        return () => this.fetchRoutes.delete(route.path)
      },
    }
  }

  requestRejection(req) {
    const headers = req && req.headers ? req.headers : {}
    return headers['x-test-auth'] === 'ok' ? undefined : 401
  }

  /** 挂到 webServer 的 /api 前缀路由（模拟 dsh-client-connection 的物理载体）。 */
  mount(webServer) {
    return webServer.register({
      kind: 'prefix',
      path: '/api',
      handler: async (req, res) => {
        const rejection = this.requestRejection(req)
        if (rejection !== undefined) {
          this.rejected.push(req.url)
          res.writeHead(rejection, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'unauthorized' }))
          return
        }
        const pathname = new URL(req.url, 'http://internal').pathname
        const route = this.fetchRoutes.get(pathname)
        if (route === undefined || !route.methods.includes(req.method)) {
          res.writeHead(404).end()
          return
        }
        const response = await route.fetch(
          new Request(`http://internal${req.url}`, {
            method: req.method,
            headers: { 'content-type': req.headers['content-type'] || 'application/json' },
            body: req.method === 'POST' ? await readAll(req) : undefined,
          }),
        )
        const text = await response.text()
        res.writeHead(response.status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(text)
      },
    })
  }
}

function readAll(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

// ── 测试主体 ─────────────────────────────────────────────────────────────

/** 测试用的 profile 条目 id（0.1.7 的表单按它定位）。 */
const TEST_ENTRY_ID = 'mcp-manager'

/**
 * 把新值就地写进 volatile 引用，等价于 Loader 的 `updateVolatile(ref, source)`。
 * @param {object} ref 目标 volatile 引用
 * @param {Array<object>} servers 新值（原始数组，默认值由 schema 补齐）
 */
function writeServersRef(ref, servers) {
  updateVolatile(ref, createVolatile(Schema.resolve({ servers }, Manager.Config, {})[0].servers.get()))
}

/**
 * 装配一个内存 harness。插件在这里就装载好，调用方拿 `disposer` 收尾。
 *
 * 关键：config 传的是**原始数组**（`{ servers }`），volatile 引用由 cordis 自己
 * 从原始 config 解析出来 —— 与 Loader 的真实行为一致。解析完成后把
 * `fiber.config.servers` 这个引用交给 FakeSettings，写入时才对同一个引用生效。
 */
function buildHarness({ withConnection = true, servers = [] } = {}) {
  const app = new Context()
  const settings = new FakeSettings(app)
  const tools = new FakeTools(app)
  const webServer = new FakeWebServer(app)
  const connection = withConnection ? new FakeConnection(app) : null
  if (connection) app.effect(() => connection.mount(webServer), 'test: /api carrier')
  const disposer = app.plugin(Manager, { servers, entryId: TEST_ENTRY_ID })
  return {
    app,
    settings,
    tools,
    webServer,
    connection,
    disposer,
    /** 等插件装载完成后登记 volatile 引用与 loader 条目 id，供写入路径使用。 */
    async ready() {
      await disposer.await()
      // 真实 harness 里 fiber.entry 由 loader 提供；这里补上同形的条目，
      // 让插件按条目 id 定位表单（0.1.7 契约）。
      const ref = disposer.config.servers
      if (!isVolatile(ref)) throw new Error('buildHarness: fiber.config.servers 应当是 volatile 引用')
      settings.adopt(TEST_ENTRY_ID, ref)
      return disposer
    },
  }
}

async function waitFor(fn, { timeout = 10000, interval = 50, label = '条件' } = {}) {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeout) throw new Error(`等待超时：${label}`)
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

async function request(base, method, body, { auth = true } = {}) {
  const headers = auth ? AUTH : {}
  const response = await fetch(base, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await response.json()
  if (process.env.DBG_REQ) console.log('DBG', method, response.status, JSON.stringify(data).slice(0, 400))
  return { status: response.status, data }
}

const AUTH = { 'x-test-auth': 'ok' }

describe('端到端：保存即生效（内存 cordis + 假 stdio MCP 服务器）', () => {
  let harness
  let base
  let disposer
  // 管理器自己打出的告警：前置检查的判定只有在这里才是**稳定**可断言的
  // （理由见「状态跟踪：不存在的命令」那条测试）。
  const logs = []

  before(async () => {
    harness = buildHarness()
    harness.app.logger.exporter({ levels: { default: 3 }, export: (m) => logs.push(String(m.args?.[0] ?? '')) })
    disposer = harness.disposer
    await harness.ready()
    base = `http://127.0.0.1:${await harness.webServer.listen()}/api/mcp/servers`
  })

  after(async () => {
    await harness.webServer.close()
    await disposer.dispose()
  })

  it('接口注册在 connection 的精确 Fetch 路由上（DSH 0.1.5 首选载体）', async () => {
    assert.ok(harness.connection.fetchRoutes.has('/api/mcp/servers'), '应注册 Fetch 路由')
    const route = harness.connection.fetchRoutes.get('/api/mcp/servers')
    // 宿主允许 GET/HEAD/POST，处理器也实现了这三者，路由必须一致
    assert.deepEqual(Array.from(route.methods), ['GET', 'HEAD', 'POST'])
    assert.equal(route.requestBody, 'buffered')
    assert.equal(harness.webServer.routes.has('exact /api/mcp/servers'), false, '不应再注册裸 webServer 路由')
  })

  it('未鉴权请求被宿主栅栏挡下（401），不进入管理器逻辑', async () => {
    const anon = await request(base, 'GET', undefined, { auth: false })
    assert.equal(anon.status, 401)
    assert.ok(harness.connection.rejected.length > 0)
  })

  it('HEAD 与 GET 同形（宿主允许 GET/HEAD/POST，路由也要注册 HEAD）', async () => {
    const response = await fetch(base, { method: 'HEAD', headers: AUTH })
    assert.equal(response.status, 200)
  })

  it('初始 GET：rev 0、空列表、空状态', async () => {
    const { status, data } = await request(base, 'GET')
    assert.equal(status, 200)
    assert.equal(data.rev, 0)
    assert.deepEqual(data.servers, [])
    assert.deepEqual(data.status, {})
  })

  it('POST 添加 stdio 服务器 → 工具注册（保存即生效全链路）', async () => {
    const { status } = await request(base, 'POST', { servers: [STDIO('fake')] })
    assert.equal(status, 200)
    const toolName = await waitFor(
      () => harness.tools.defs.has('mcp__fake__echo') && harness.tools.defs.get('mcp__fake__echo'),
      { label: 'mcp__fake__echo 注册' },
    )
    assert.equal(toolName.name, 'mcp__fake__echo')

    const get = await request(base, 'GET')
    assert.equal(get.data.status.fake.state, 'ok', JSON.stringify(get.data.status))
  })

  it('状态跟踪：不存在的命令 → 状态 error（日志截获驱动，异步真实失败）', async () => {
    await request(base, 'POST', {
      servers: [STDIO('fake'), STDIO('broken', { command: MISSING_BINARY, failOnStartupError: true })],
    })
    const brokenStatus = await waitFor(
      async () => {
        const get = await request(base, 'GET')
        return get.data.status.broken && get.data.status.broken.state === 'error' ? get.data.status.broken : undefined
      },
      { label: 'broken 状态变为 error' },
    )
    assert.equal(brokenStatus.state, 'error')

    // 前置检查确实点名了那个不存在的可执行文件——断言打在它**稳定**的载体上。
    //
    // 这里原本断言的是挂载状态里那句 `找不到可执行文件：…`，而那句话只存在于
    // mountOne 写下它、到 mcp-client 真实 spawn 失败把它覆盖掉之间的窗口里。
    // 窗口长度完全取决于平台怎么「启动失败」：Windows 上要去 shell 里试一圈路径
    // （实测有 50~200ms），测试的首次轮询刚好落在窗口内；Linux 的 ENOENT 在同一轮
    // 事件循环里就回来了（实测 <1ms），于是同一个断言在 Linux 上必然只能看到
    // `连接失败：Error: spawn … ENOENT`。也就是说原断言依赖的是「Windows 启动
    // 失败慢」，不是任何平台的差异行为——它在两边不可能同时成立。
    // 前置检查的判定本身由 index.js 打的那条告警承载（先于任何 mcp-client 日志），
    // 这才是可以跨平台稳定断言的地方。
    assert.ok(
      logs.some((line) => line.includes(`启动前置检查未通过：找不到可执行文件：${MISSING_BINARY}`)),
      `应有前置检查告警，最近的日志：${JSON.stringify(logs.slice(-4))}`,
    )

    // fake 服务器不受影响
    const get = await request(base, 'GET')
    assert.equal(get.data.status.fake.state, 'ok')
  })

  it('rev 乐观锁：旧 rev 提交返回 409 conflict；新 rev 成功且 rev 递增', async () => {
    const before = await request(base, 'GET')
    const rev = before.data.rev
    const server = STDIO('fake2')
    const ok = await request(base, 'POST', { rev, servers: [...before.data.servers, server] })
    assert.equal(ok.status, 200)

    // 用旧 rev 再提交 → 409
    const conflict = await request(base, 'POST', {
      rev,
      servers: [...before.data.servers, STDIO('fake3')],
    })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.data.code, 'conflict')

    const after = await request(base, 'GET')
    assert.equal(after.data.rev, rev + 1)
    assert.ok(after.data.servers.some((s) => s.serverName === 'fake2'))
    assert.ok(!after.data.servers.some((s) => s.serverName === 'fake3'))
  })

  it('enabled 开关：关闭后工具移除、状态 disabled；开启恢复', async () => {
    const current = await request(base, 'GET')
    const off = current.data.servers.map((s) => (s.serverName === 'fake2' ? { ...s, enabled: false } : s))
    const { status } = await request(base, 'POST', { rev: current.data.rev, servers: off })
    assert.equal(status, 200)

    await waitFor(() => !harness.tools.defs.has('mcp__fake2__echo'), { label: '关闭后工具移除' })
    // 关掉之后必须**稳定地**读到 disabled：先等卸载收尾（dispose → 状态收敛）落定再读。
    // 早先这里读的是"收尾中"的中间态，快慢不同的机器上会偶发失败（实测 3 次里错 2 次），
    // 而真正的问题是收尾会把 disabled 状态抹掉、设置页于是显示成「已挂载」。
    await new Promise((resolve) => setTimeout(resolve, 300))
    const getOff = await request(base, 'GET')
    assert.equal(
      getOff.data.status.fake2?.state,
      'disabled',
      `关闭后状态应为 disabled，实际：${JSON.stringify(getOff.data.status)}`,
    )

    // 开启恢复
    const current2 = await request(base, 'GET')
    const on = current2.data.servers.map((s) => (s.serverName === 'fake2' ? { ...s, enabled: true } : s))
    await request(base, 'POST', { rev: current2.data.rev, servers: on })
    await waitFor(() => harness.tools.defs.has('mcp__fake2__echo'), { label: '开启后工具恢复' })
  })

  it('toolCallTimeoutMs / failOnStartupError 可配置并随配置往返', async () => {
    const current = await request(base, 'GET')
    const updated = current.data.servers.map((s) =>
      s.serverName === 'fake' ? { ...s, toolCallTimeoutMs: 5000, failOnStartupError: true } : s,
    )
    const { status } = await request(base, 'POST', { rev: current.data.rev, servers: updated })
    assert.equal(status, 200)
    const get = await request(base, 'GET')
    const server = get.data.servers.find((s) => s.serverName === 'fake')
    assert.equal(server.toolCallTimeoutMs, 5000)
    assert.equal(server.failOnStartupError, true)
    // 实例仍活着
    assert.equal(get.data.status.fake.state, 'ok')
  })

  it('密钥引用：未配置的 env/cred 引用保留字面值且不阻断挂载', async () => {
    const current = await request(base, 'GET')
    const updated = current.data.servers.map((s) =>
      s.serverName === 'fake2' ? { ...s, env: { FOO: 'env:MISSING_ENV_XYZ', BAR: 'cred:MISSING_CRED_XYZ' } } : s,
    )
    const { status } = await request(base, 'POST', { rev: current.data.rev, servers: updated })
    assert.equal(status, 200)
    const get = await request(base, 'GET')
    const server = get.data.servers.find((s) => s.serverName === 'fake2')
    assert.equal(server.env.FOO, 'env:MISSING_ENV_XYZ')
    await waitFor(() => harness.tools.defs.has('mcp__fake2__echo'), { label: '带引用的服务器仍挂载' })
  })

  it('校验：非法 toolCallTimeoutMs / 重复 serverName 被 400 拒绝', async () => {
    const badTimeout = await request(base, 'POST', {
      servers: [STDIO('x', { toolCallTimeoutMs: 0 })],
    })
    assert.equal(badTimeout.status, 400)
    assert.match(badTimeout.data.error, /toolCallTimeoutMs/)

    const dup = await request(base, 'POST', {
      servers: [STDIO('fake'), STDIO('fake')],
    })
    assert.equal(dup.status, 400)
    assert.match(dup.data.error, /重复/)
  })
})

describe('端到端：整条命令行粘进表单也能跑通（真实故障回归）', () => {
  let harness
  let base
  let disposer
  const logs = []

  before(async () => {
    harness = buildHarness()
    // 收集插件写出的告警，断言归一化确实发生过（而不是静默改写用户配置）
    harness.app.logger.exporter({ levels: { default: 3 }, export: (m) => logs.push(String(m.args?.[0] ?? '')) })
    disposer = harness.disposer
    await harness.ready()
    base = `http://127.0.0.1:${await harness.webServer.listen()}/api/mcp/servers`
  })

  after(async () => {
    await harness.webServer.close()
    await disposer.dispose()
  })

  it('command 里含脚本路径 + 每个参数行含两个 token → 自动拆分后工具可用', async () => {
    const { status } = await request(base, 'POST', {
      servers: [
        STDIO('pasted', {
          command: `${process.execPath} ${FAKE_SERVER}`,
          args: ['--flag value', '--port 9876'],
        }),
      ],
    })
    assert.equal(status, 200)

    const definition = await waitFor(() => harness.tools.defs.get('mcp__pasted__echo'), {
      label: '粘进来的命令行也能挂载并注册工具',
    })
    assert.ok(definition, '工具应注册')

    // 真正调用一次：子进程把收到的 argv 与脚本路径回传，证明拆分结果原样传下去了
    const result = await definition.execute({ text: 'x' }, {})
    const texts = (result.content || []).map((part) => part.text || '')
    const argvLine = texts.find((text) => text.startsWith('argv='))
    const scriptLine = texts.find((text) => text.startsWith('script='))
    assert.ok(argvLine, `应回传 argv，实际内容：${JSON.stringify(texts)}`)
    // node 的 argv[1] 是被执行的脚本，argv.slice(2) 才是拆分后的参数——
    // 两者合起来才算证明「command 拆对了、args 也拆对了」。
    assert.equal(scriptLine && scriptLine.slice('script='.length), FAKE_SERVER)
    assert.deepEqual(JSON.parse(argvLine.slice('argv='.length)), ['--flag', 'value', '--port', '9876'])
  })

  it('归一化会写一条告警', () => {
    assert.ok(
      logs.some((line) => line.includes('stdio 配置已自动归一化')),
      `应有一条归一化告警，最近的日志：${JSON.stringify(logs.slice(-4))}`,
    )
  })

  it('前置检查：可执行文件不存在时直接给出原因（而不是 -32000 Connection closed）', async () => {
    const { status } = await request(base, 'POST', {
      servers: [STDIO('ghost', { command: MISSING_BINARY, args: [] })],
    })
    assert.equal(status, 200)
    const entry = await waitFor(
      async () => {
        const res = await request(base, 'GET')
        const current = res.data.status.ghost
        return current && current.state === 'error' ? current : undefined
      },
      { label: 'ghost 状态变为 error' },
    )
    assert.equal(entry.state, 'error')
    // 原因断言在管理器自己那条告警上：状态里的前置检查文案是瞬时的，真实的
    // spawn 失败紧接着就把它覆盖掉了（Linux 上在测试来得及轮询之前就没了，
    // 见上一条测试的说明）。
    assert.ok(
      logs.some((line) => line.includes(`启动前置检查未通过：找不到可执行文件：${MISSING_BINARY}`)),
      `应有「找不到可执行文件」的前置检查告警，最近的日志：${JSON.stringify(logs.slice(-4))}`,
    )
  })
})

describe('端到端：没有 connection 服务时的兜底载体（裸 webServer + 护栏）', () => {
  let harness
  let base
  let disposer

  before(async () => {
    harness = buildHarness({ withConnection: false })
    disposer = harness.disposer
    await harness.ready()
    base = `http://127.0.0.1:${await harness.webServer.listen()}/api/mcp/servers`
  })

  after(async () => {
    await harness.webServer.close()
    await disposer.dispose()
  })

  it('退化为裸 webServer 精确路由（旧版 DSH / 非 Web 组装）', () => {
    assert.equal(harness.webServer.routes.has('exact /api/mcp/servers'), true)
  })

  it('回环来源可用；非 GET/POST 方法仍被 405 拒绝', async () => {
    const { status } = await request(base, 'GET')
    assert.equal(status, 200)
    const put = await request(base, 'PUT')
    // FakeWebServer 的精确路由把 PUT 也交给处理器，处理器按 method 判 405
    assert.equal(put.status, 405)
  })

  it('保存即生效链路在这条载体上同样工作', async () => {
    const { status } = await request(base, 'POST', { servers: [STDIO('legacy')] })
    assert.equal(status, 200)
    await waitFor(() => harness.tools.defs.has('mcp__legacy__echo'), { label: 'legacy 服务器挂载' })
  })
})

describe('端到端：connection 服务后到（组合时序兜底）', () => {
  let app
  let webServer
  let tools
  let connection
  let base
  let disposer

  before(async () => {
    app = new Context()
    const settings = new FakeSettings(app)
    tools = new FakeTools(app)
    webServer = new FakeWebServer(app)
    // 插件先装载：此刻 connection 还不存在，于是先走裸路由兜底
    disposer = app.plugin(Manager, { servers: [], entryId: TEST_ENTRY_ID })
    await waitFor(() => webServer.routes.has('exact /api/mcp/servers'), { label: '兜底路由注册' })
    await disposer.await()
    settings.adopt(TEST_ENTRY_ID, disposer.config.servers)
    // connection 稍后才出现（装配顺序变化时就是这个形态）
    connection = new FakeConnection(app)
    app.effect(() => connection.mount(webServer), 'test: /api carrier')
    await waitFor(() => connection.fetchRoutes.has('/api/mcp/servers'), { label: 'Fetch 路由补注册' })
    base = `http://127.0.0.1:${await webServer.listen()}/api/mcp/servers`
  })

  after(async () => {
    await webServer.close()
    await disposer.dispose()
  })

  it('connection 出现后升级到精确 Fetch 路由，并撤掉裸路由（不留下两条载体）', () => {
    assert.equal(connection.fetchRoutes.has('/api/mcp/servers'), true)
    assert.equal(webServer.routes.has('exact /api/mcp/servers'), false)
  })

  it('升级后接口照常工作（保存即生效）', async () => {
    const { status } = await request(base, 'POST', { servers: [STDIO('late')] })
    assert.equal(status, 200)
    await waitFor(() => tools.defs.has('mcp__late__echo'), { label: 'late 服务器挂载' })
  })
})

// ── 前置检查的判定必须是**持久**的 ───────────────────────────────────────
//
// README 承诺「启动前置检查 … 设置页状态直接给出可照改的一句话」。而这句话原本
// 只存在于 mountOne 写下它、到 mcp-client 的真实异步失败把它顶掉之间的窗口里
// （Windows 实测 50~200ms；Linux 的 ENOENT 在同一轮事件循环里就回来了）。用户
// 实际看到的是「连接失败：SdkError: Connection closed」——正是前置检查存在的
// 意义所在要替换掉的那句话。
//
// 这里断言的是持久的事实：等异步失败**确实发生**、且状态收敛之后，状态里仍然
// 带着前置检查那句话；异步失败只能作为细节（failure）并入，不能把它顶掉。
// 两条测试各覆盖一条覆盖路径：mcp-client 日志（logger exporter）与 apply 的 catch 兜底。
describe('端到端：启动前置检查的判定在异步失败之后仍然保留', () => {
  let harness
  let base
  let disposer
  const logs = []

  before(async () => {
    harness = buildHarness()
    harness.app.logger.exporter({ levels: { default: 3 }, export: (m) => logs.push(String(m.args?.[0] ?? '')) })
    disposer = harness.disposer
    await harness.ready()
    base = `http://127.0.0.1:${await harness.webServer.listen()}/api/mcp/servers`
  })

  after(async () => {
    await harness.webServer.close()
    await disposer.dispose()
  })

  /**
   * 读状态直到它**收敛**：连续 400ms 读到同一份快照才算落定——这个窗口远大于
   * Windows 上「前置检查文案被顶掉」的 50~200ms，所以收敛后再断言不可能是
   * 「刚好落在窗口内」的假绿。返回最后一次快照，并把每次变化记进 timeline，
   * 失败时能把「先出现前置检查文案、随后被顶掉」的全过程打出来。
   */
  async function settledStatus(name) {
    const timeline = []
    const started = Date.now()
    let snapshot = null
    let stableSince = Date.now()
    for (;;) {
      const res = await request(base, 'GET')
      const entry = res.data.status[name]
      const text = JSON.stringify(entry)
      if (text !== snapshot) {
        snapshot = text
        stableSince = Date.now()
        timeline.push({ atMs: Date.now() - started, status: entry })
      }
      if (Date.now() - stableSince >= 400) return { entry, timeline }
      if (Date.now() - started > 15000) throw new Error(`状态未收敛：${JSON.stringify(timeline)}`)
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  /** 断言的公共部分：主文案是前置检查那句话，异步失败并入了细节。 */
  function assertPreflightKept(entry, timeline, name) {
    const trail = `收敛时间线：${JSON.stringify(timeline)}`
    assert.equal(entry.state, 'error', trail)
    assert.match(entry.message, /启动前置检查未通过：找不到可执行文件/, `主文案应仍是前置检查的判定。${trail}`)
    assert.ok(entry.message.includes(MISSING_BINARY), `主文案应点名那个不存在的可执行文件。${trail}`)
    // 异步失败没有被丢掉，而是作为细节保留（用户既看到可照改的一句话，也看得到真实错误）
    assert.match(
      String(entry.failure),
      /启动失败|连接失败/,
      `${name} 的异步失败应并入 failure（而不是取代主文案）：${JSON.stringify(entry)}`,
    )
  }

  it('failOnStartupError: true → apply 的 catch 兜底不再无条件覆盖前置检查的判定', async () => {
    await request(base, 'POST', {
      servers: [STDIO('ghost', { command: MISSING_BINARY, args: [], failOnStartupError: true })],
    })
    // 先等异步失败**确实发生**：这条由管理器自己在 catch 里打出，与平台无关。
    await waitFor(() => logs.some((line) => line.includes('mcp-client(ghost) 启动失败')), {
      label: 'ghost 的异步启动失败已发生',
    })
    const { entry, timeline } = await settledStatus('ghost')
    assertPreflightKept(entry, timeline, 'ghost')
  })

  it('failOnStartupError: false → logger exporter 的合并也不再把前置检查的判定冲掉', async () => {
    const current = await request(base, 'GET')
    await request(base, 'POST', {
      rev: current.data.rev,
      servers: [...current.data.servers, STDIO('ghost2', { command: MISSING_BINARY, args: [] })],
    })
    // 等 mcp-client 自己那条「连接尝试失败」日志——它正是 exporter 的输入。
    await waitFor(
      () => logs.some((line) => line.startsWith('mcp-client(ghost2)') && line.includes('connection attempt failed')),
      { label: 'ghost2 的异步连接失败已发生' },
    )
    const { entry, timeline } = await settledStatus('ghost2')
    assertPreflightKept(entry, timeline, 'ghost2')
  })
})

describe('端到端：修订号乐观锁（0.1.7 表单按 loader 条目 id 定位）', () => {
  let harness
  let base
  let disposer

  before(async () => {
    harness = buildHarness()
    disposer = harness.disposer
    await harness.ready()
    base = `http://127.0.0.1:${await harness.webServer.listen()}/api/mcp/servers`
  })

  after(async () => {
    await harness.webServer.close()
    await disposer.dispose()
  })

  it('服务只按 loader 条目 id 登记（没有条目 id 就没有表单）', () => {
    const descriptors = harness.settings.describe()
    assert.deepEqual(
      descriptors.map((entry) => entry.ns),
      [TEST_ENTRY_ID],
      `表单必须登记在 loader 条目 id 上，实际 ${JSON.stringify(descriptors.map((entry) => entry.ns))}`,
    )
  })

  it('GET 返回的是真实修订号，而不是永远 0', async () => {
    const first = await request(base, 'POST', { servers: [STDIO('renamed')] })
    assert.equal(first.status, 200)
    const get = await request(base, 'GET')
    assert.equal(
      get.data.rev,
      1,
      `保存一次后修订号应为 1（describe 的 revision），实际 ${JSON.stringify(get.data)}`,
    )
  })

  it('用返回的修订号提交不再永远冲突（保存链路可用）', async () => {
    const get = await request(base, 'GET')
    const { status } = await request(base, 'POST', {
      rev: get.data.rev,
      servers: [...get.data.servers, STDIO('renamed2')],
    })
    assert.equal(status, 200)
  })
})
