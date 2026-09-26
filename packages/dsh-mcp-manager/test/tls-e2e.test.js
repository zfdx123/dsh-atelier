// TLS 端到端：内网自签名证书的 streamable-http MCP 服务器。
//
// 对照组：不开 tlsInsecure 时 Node 默认校验证书，连接必然失败（记录到日志里的
// 证书错误），工具不会注册；开 tlsInsecure 后同一台服务器立刻挂载成功、工具
// 出现在 ctx.tools 里。最后移除服务器，断言 globalThis.fetch 被还原——证明
// TLS 分流是定向且可逆的，没有把全局证书校验关掉。

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import * as Manager from '../index.js'
import { CONFIRM_TIMEOUT_MS } from '../index.js'
import { createTlsMcpServer } from '../fixtures/tls-mcp-server.mjs'

// 测试证书本身即该服务器证书，所以把它当 CA 用可以真正完成校验（不是关闭校验）。
const CA_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'tls', 'localhost-cert.pem')

/** 测试用的 profile 条目 id（0.1.7 的表单按它定位）。 */
const TEST_ENTRY_ID = 'mcp-manager'

/**
 * 造一个 volatile 配置引用，与 Loader 交给插件的完全同构（真正走
 * `ServersSchema.resolve`，默认值已按 schema 补齐）。
 */
function volatileServersRef(initial = []) {
  const ref = Schema.resolve({ servers: initial }, Manager.Config, {})[0].servers
  if (!isVolatile(ref)) throw new Error('volatileServersRef: ServersSchema.servers 应当是 volatile 引用')
  return ref
}

/** 按 Loader 的 `updateVolatile` 语义把新值就地写进引用。 */
function writeServersRef(ref, servers) {
  updateVolatile(ref, createVolatile(Schema.resolve({ servers }, Manager.Config, {})[0].servers.get()))
}

// 最小 settings 服务，按 DSH 0.1.7 契约：表单按 **loader 条目 id** 定位
// （不再有 register(ns, schema)），describe() 报告条目，replace() 写入并把
// 新值就地写进 volatile 引用（updateVolatile 语义）后发出 loader/volatile-update。
class FakeSettings extends Service {
  /** @type {Map<string, {ns: string, document: unknown, revision: number, ref: object|null}>} */
  entries = new Map()

  constructor(ctx) {
    super(ctx, 'settings')
  }

  /**
   * 登记一个条目，引用取 Loader 真正交给插件的那一个
   * （`fiber.config.servers`，由 cordis 从**原始** config 解析出来的引用）。
   */
  adopt(ns, ref) {
    this.entries.set(ns, { ns, document: ref.get(), revision: 0, ref })
  }
  describe() {
    return [...this.entries.values()].map((entry) => ({
      ns: entry.ns,
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
      const error = new Error('settings conflict')
      error.name = 'SettingsConflictError'
      error.code = 'SETTINGS_CONFLICT'
      throw error
    }
    entry.document = section
    entry.revision += 1
    this.ctx.emit('settings/document-updated', ns, entry.revision)
    if (entry.ref !== null && entry.ref !== undefined) {
      writeServersRef(entry.ref, section.servers ?? [])
      this.ctx.emit('loader/volatile-update', [[]])
    }
    return entry.document
  }
}

class FakeTools extends Service {
  defs = new Map()
  registerCount = 0

  constructor(ctx) {
    super(ctx, 'tools')
  }

  register(definition) {
    this.registerCount += 1
    this.defs.set(definition.name, definition)
    return () => this.defs.delete(definition.name)
  }
}

/** 捕获插件注册的 HTTP 接口，用来读取设置页真正拿到的 status。 */
class FakeWebServer extends Service {
  routes = new Map()

  constructor(ctx) {
    super(ctx, 'webServer')
  }

  register(route) {
    this.routes.set(route.path, route.handler)
    return () => this.routes.delete(route.path)
  }

  /** 以本机回环来源发一次 GET，返回解析后的响应体。 */
  get(path) {
    const handler = this.routes.get(path)
    if (handler === undefined) throw new Error(`no route ${path}`)
    return new Promise((resolve) => {
      const req = {
        method: 'GET',
        url: path,
        headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' },
        socket: { remoteAddress: '127.0.0.1' },
        [Symbol.asyncIterator]: async function* () {},
      }
      const res = {
        status: 0,
        body: '',
        writeHead(status) {
          this.status = status
        },
        end(text) {
          this.body = text ?? ''
          resolve({ status: this.status, body: JSON.parse(this.body || '{}') })
        },
      }
      handler(req, res)
    })
  }
}

async function waitFor(fn, { timeout = 8000, interval = 50, label = '条件' } = {}) {
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() - start > timeout) throw new Error(`等待超时：${label}`)
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

const server = (overrides = {}) => ({
  serverName: 'tls',
  enabled: true,
  transport: 'streamable-http',
  command: '',
  args: [],
  env: {},
  cwd: '',
  url: '',
  headers: {},
  toolCallTimeoutMs: 20000,
  failOnStartupError: true,
  tlsInsecure: false,
  tlsCaFile: '',
  reconnectEnabled: false,
  reconnectMaxAttempts: 1,
  ...overrides,
})

describe('端到端：自签名 HTTPS MCP 服务器（tlsInsecure 定向生效且可逆）', () => {
  let mcp
  let app
  let settings
  let tools
  let web
  let disposer
  let logs
  const originalFetch = globalThis.fetch

  /** 把一台服务器配置进去、等状态不再是「连接中」，读回设置页拿到的 status。 */
  const mountAndRead = async (name, url, extra = {}) => {
    await settings.replace(TEST_ENTRY_ID, { servers: [server({ serverName: name, url, ...extra })] })
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS + 4000
    for (;;) {
      const { body } = await web.get('/api/mcp/servers')
      const status = body.status[name]
      if (status !== undefined && status.state !== 'connecting') return status
      if (Date.now() > deadline) return status
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  before(async () => {
    mcp = await createTlsMcpServer({ toolName: 'echo' })
    app = new Context()
    settings = new FakeSettings(app)
    tools = new FakeTools(app)
    web = new FakeWebServer(app)
    logs = []
    app.logger.exporter({ levels: { default: 3 }, export: (message) => logs.push(message) })
    // config 传原始数组，volatile 引用由 cordis 解析出来（与 Loader 一致）
    disposer = app.plugin(Manager, { servers: [], entryId: TEST_ENTRY_ID })
    // 让插件的 apply 跑完（路由注册 + 启动同步）
    await disposer.await()
    settings.adopt(TEST_ENTRY_ID, disposer.config.servers)
  })

  after(async () => {
    await disposer.dispose()
    await mcp.close()
  })

  it('对照组：不信任自签名证书时连接失败，工具不注册', async () => {
    await settings.replace(TEST_ENTRY_ID, { servers: [server({ url: mcp.url })] })

    const error = await waitFor(
      () =>
        logs.find((message) => {
          const text = String(message.args?.[0] ?? '')
          return /self-signed|SELF_SIGNED|certificate/i.test(text)
        }),
      { label: '日志里出现证书错误' },
    )
    assert.match(String(error.args[0]), /self-signed|SELF_SIGNED|certificate/i)
    assert.equal(tools.defs.has('mcp__tls__echo'), false, '证书校验失败时不应注册工具')
  })

  it('开 tlsInsecure 后同一台服务器挂载成功，工具注册', async () => {
    await settings.replace(TEST_ENTRY_ID, { servers: [server({ url: mcp.url, tlsInsecure: true })] })

    await waitFor(() => tools.defs.has('mcp__tls__echo'), { label: 'mcp__tls__echo 注册' })
    assert.equal(tools.defs.get('mcp__tls__echo').name, 'mcp__tls__echo')
    assert.deepEqual(Object.keys(tools.defs.get('mcp__tls__echo').parameters.properties), ['text'])
  })

  it('改用 tlsCaFile 指定 CA 同样连通（校验保持开启，只信任指定 CA）', async () => {
    // 换成 CA 文件：同一 origin 的策略变化会重建 Agent（严格校验 + 指定 CA）。
    // 以「工具被重新注册过」为准，而不是「工具还在」——否则老实例没卸载干净
    // 也能让断言通过。
    const before = tools.registerCount
    await settings.replace(TEST_ENTRY_ID, {
      servers: [server({ url: mcp.url, tlsInsecure: false, tlsCaFile: CA_FILE })],
    })
    await waitFor(() => tools.registerCount > before && tools.defs.has('mcp__tls__echo'), {
      label: 'CA 模式下重新挂载并注册工具',
    })
    assert.ok(tools.registerCount > before)
  })

  it('移除服务器后策略释放：globalThis.fetch 被还原、工具注销', async () => {
    assert.notEqual(globalThis.fetch, originalFetch, '挂载期间应处于分流状态')
    await settings.replace(TEST_ENTRY_ID, { servers: [] })
    await waitFor(() => !tools.defs.has('mcp__tls__echo'), { label: '工具注销' })
    await waitFor(() => globalThis.fetch === originalFetch, { label: 'fetch 还原' })
    assert.equal(globalThis.fetch, originalFetch)
  })

  it('CA 文件不存在 → 挂载失败并给出可读原因，不静默连不上', async () => {
    await settings.replace(TEST_ENTRY_ID, {
      servers: [server({ url: mcp.url, tlsCaFile: join(dirname(CA_FILE), 'nope.pem') })],
    })
    const error = await waitFor(
      () => logs.find((message) => /读取 CA 文件失败/.test(String(message.args?.[0] ?? ''))),
      {
        label: '日志里出现 CA 读取失败',
      },
    )
    assert.match(String(error.args[0]), /挂载失败/)
    assert.equal(tools.defs.has('mcp__tls__echo'), false, '挂载失败时不应注册工具')
    // 失败路径同样不留下策略：没有生效中的分流
    assert.equal(globalThis.fetch, originalFetch)
  })

  // 「挂载成功」不等于「连上了」。mcp-client 只在**失败**时打日志，连接**成功**
  // 不输出任何日志，所以没有任何正向信号；而挂起（包被静默丢弃）的地址会让
  // 第一次 fetch 一直等下去（真实超时 30–130 秒）。此时若把「挂载完成」直接
  // 当成「已挂载」，卡片就会在服务器根本没回应时长时间亮绿。
  describe('没有证据就不亮绿', () => {
    it('确实连上了（工具注册）→ 转成 ok', async () => {
      await settings.replace(TEST_ENTRY_ID, { servers: [] })
      await new Promise((resolve) => setTimeout(resolve, 200))
      await settings.replace(TEST_ENTRY_ID, { servers: [server({ serverName: 'confirmed', url: mcp.url, tlsInsecure: true })] })
      await waitFor(() => tools.defs.has('mcp__confirmed__echo'), { label: '工具注册' })

      const { body } = await web.get('/api/mcp/servers')
      assert.equal(
        body.status.confirmed.state,
        'ok',
        `工具注册就是「确实连上了」的证据，应转成 ok：${JSON.stringify(body.status.confirmed)}`,
      )
    })

    it('服务器接受连接但永不响应 → 确认窗口后转为错误（而不是一直「已挂载」）', async () => {
      const hangingServer = await createTlsMcpServer({ toolName: 'echo', hang: true })
      const previous = process.env.DSH_MCP_MANAGER_CONFIRM_MS
      try {
        // 这条只验证「窗口开火后的状态」，窗口本身缩短即可（真实默认 20 秒；
        // 真实超时的行为由下面那条黑洞用例守着）。
        process.env.DSH_MCP_MANAGER_CONFIRM_MS = '3000'
        const status = await mountAndRead('hang', hangingServer.url, { tlsInsecure: true })
        assert.equal(tools.defs.has('mcp__hang__echo'), false, '挂起时不会有工具')
        assert.equal(status.state, 'error', `挂起必须在确认窗口后转为错误，实际：${JSON.stringify(status)}`)
        assert.match(status.message, /无回应|未确认/, `错误文案要说明「挂了但没连上」，实际：${status.message}`)
      } finally {
        if (previous === undefined) delete process.env.DSH_MCP_MANAGER_CONFIRM_MS
        else process.env.DSH_MCP_MANAGER_CONFIRM_MS = previous
        await hangingServer.close()
      }
    })

    // 立即被拒（ECONNREFUSED）比挂起快得多：这条守住「失败照旧报错」。
    it('连接被拒 → 仍然报错并带上原因链', async () => {
      const status = await mountAndRead('refused', 'https://127.0.0.1:9/mcp', { tlsInsecure: true })
      assert.equal(status.state, 'error')
      assert.match(status.message, /连接失败|bad port/)
    })
  })

  // 「网络错误超时不能修吗」——能，而且**上游已经修了**：实测黑洞地址（192.0.2.1，
  // 包被丢弃）时 undici 的 connect timeout 是 10 秒，之后 mcp-client 自己就打出
  // `connection attempt failed: … UND_ERR_CONNECT_TIMEOUT Connect Timeout Error
  // （网络层失败：…）`。这条证明真实原因**确实**到达设置页，且确认窗口不会把它
  // 盖掉——那正是把窗口设成 20 秒（比 10 秒超时长）的原因。
  describe('网络超时：真实原因到达设置页，不被确认窗口盖掉', () => {
    it('黑洞地址（包被丢弃）→ 报「连接失败 + 超时原因」，不是一句「未确认」', async () => {
      const previous = process.env.DSH_MCP_MANAGER_CONFIRM_MS
      try {
        // 故意把确认窗口设得**比 undici 的 10 秒连接超时短**：窗口会先开火。
        // 若实现是「窗口直接盖住状态」，用户就只会看到「未确认」；正确实现必须
        // 让随后到达的真实失败原因把它顶掉。
        process.env.DSH_MCP_MANAGER_CONFIRM_MS = '9000'
        await settings.replace(TEST_ENTRY_ID, { servers: [] })
        await new Promise((resolve) => setTimeout(resolve, 200))
        await settings.replace(TEST_ENTRY_ID, {
          servers: [server({ serverName: 'hole', url: 'https://192.0.2.1:8091/mcp', tlsInsecure: true })],
        })

        await waitFor(
          async () => {
            const { body } = await web.get('/api/mcp/servers')
            const current = body.status.hole
            return current !== undefined && current.state === 'error' ? current : undefined
          },
          { timeout: 30000, label: '黑洞地址报错' },
        )
        // 再等一轮重试：重试类固定文案（detail:false）不得把真实原因冲掉。
        await new Promise((resolve) => setTimeout(resolve, 3000))
        const settled = (await web.get('/api/mcp/servers')).body.status.hole

        assert.equal(settled.state, 'error')
        assert.match(
          String(settled.message),
          /TIMEOUT|超时|fetch failed|网络层失败/,
          `必须显示真实网络原因，而不是一句含糊的「未确认」：${settled.message}`,
        )
        assert.doesNotMatch(String(settled.message), /^已挂载但/, `确认窗口的话不该盖住真实原因：${settled.message}`)
      } finally {
        if (previous === undefined) delete process.env.DSH_MCP_MANAGER_CONFIRM_MS
        else process.env.DSH_MCP_MANAGER_CONFIRM_MS = previous
      }
    })
  })
})
