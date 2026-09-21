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
import * as Manager from '../index.js'
import { createTlsMcpServer } from '../fixtures/tls-mcp-server.mjs'

// 测试证书本身即该服务器证书，所以把它当 CA 用可以真正完成校验（不是关闭校验）。
const CA_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'tls', 'localhost-cert.pem')

// 最小 settings 服务（register/get/replace/describe）——与 test/e2e.test.js 同形。
class FakeSettings extends Service {
  registrations = new Map()
  document = {}

  constructor(ctx) {
    super(ctx, 'settings')
  }

  register(ns, schema) {
    const registration = { ns, schema, resolved: schema(this.document[ns]), revision: 0 }
    this.ctx.effect(
      () => {
        this.registrations.set(ns, registration)
        return () => this.registrations.delete(ns)
      },
      `settings.register(${JSON.stringify(ns)})`,
    )
    return { get: () => registration.resolved, replace: (section) => this.replace(ns, section) }
  }

  get(ns) {
    return this.registrations.get(ns)?.resolved
  }

  describe() {
    return [...this.registrations.values()].map((r) => ({ ns: r.ns, revision: r.revision }))
  }

  async replace(ns, section, expectedRevision) {
    const registration = this.registrations.get(ns)
    if (!registration) throw new Error(`settings namespace "${ns}" is not registered`)
    if (expectedRevision !== undefined && expectedRevision !== registration.revision) {
      const error = new Error('settings conflict')
      error.code = 'SETTINGS_CONFLICT'
      throw error
    }
    const before = this.document[ns]
    this.document[ns] = section
    const next = registration.schema(section)
    if (JSON.stringify(before) !== JSON.stringify(section)) registration.revision += 1
    if (JSON.stringify(next) !== JSON.stringify(registration.resolved)) {
      registration.resolved = next
      this.ctx.emit('settings/updated', ns, next)
    }
    return next
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
  let disposer
  let logs
  const originalFetch = globalThis.fetch

  before(async () => {
    mcp = await createTlsMcpServer({ toolName: 'echo' })
    app = new Context()
    settings = new FakeSettings(app)
    tools = new FakeTools(app)
    logs = []
    app.logger.exporter({ levels: { default: 3 }, export: (message) => logs.push(message) })
    disposer = app.plugin(Manager)
    // 让插件的 apply 跑完（settings 命名空间注册 + 启动同步）
    await new Promise((resolve) => setTimeout(resolve, 50))
  })

  after(async () => {
    await disposer.dispose()
    await mcp.close()
  })

  it('对照组：不信任自签名证书时连接失败，工具不注册', async () => {
    await settings.replace('mcp', { servers: [server({ url: mcp.url })] })

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
    await settings.replace('mcp', { servers: [server({ url: mcp.url, tlsInsecure: true })] })

    await waitFor(() => tools.defs.has('mcp__tls__echo'), { label: 'mcp__tls__echo 注册' })
    assert.equal(tools.defs.get('mcp__tls__echo').name, 'mcp__tls__echo')
    assert.deepEqual(Object.keys(tools.defs.get('mcp__tls__echo').parameters.properties), ['text'])
  })

  it('改用 tlsCaFile 指定 CA 同样连通（校验保持开启，只信任指定 CA）', async () => {
    // 换成 CA 文件：同一 origin 的策略变化会重建 Agent（严格校验 + 指定 CA）。
    // 以「工具被重新注册过」为准，而不是「工具还在」——否则老实例没卸载干净
    // 也能让断言通过。
    const before = tools.registerCount
    await settings.replace('mcp', {
      servers: [server({ url: mcp.url, tlsInsecure: false, tlsCaFile: CA_FILE })],
    })
    await waitFor(() => tools.registerCount > before && tools.defs.has('mcp__tls__echo'), {
      label: 'CA 模式下重新挂载并注册工具',
    })
    assert.ok(tools.registerCount > before)
  })

  it('移除服务器后策略释放：globalThis.fetch 被还原、工具注销', async () => {
    assert.notEqual(globalThis.fetch, originalFetch, '挂载期间应处于分流状态')
    await settings.replace('mcp', { servers: [] })
    await waitFor(() => !tools.defs.has('mcp__tls__echo'), { label: '工具注销' })
    await waitFor(() => globalThis.fetch === originalFetch, { label: 'fetch 还原' })
    assert.equal(globalThis.fetch, originalFetch)
  })

  it('CA 文件不存在 → 挂载失败并给出可读原因，不静默连不上', async () => {
    await settings.replace('mcp', {
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
})
