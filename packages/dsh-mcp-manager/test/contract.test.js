// 兼容性契约测试：本插件构造的 mcp-client 实例配置必须能被正在使用的
// @deepseek-ai/dsh-mcp-client Config schema 接受（schemastery schema 可直接
// 调用校验：Config(config) 校验并返回归一化结果，不合法时抛错）。
//
// CI 里该测试跑在版本矩阵上（Node 22/24 × dsh-mcp-client
// 0.1.1-rc.2 / 0.1.5-rc.2），任一版本改了配置契约而本插件没跟上时，这里会先红。
// 0.1.5 起 Config 新增可选 reconnect；本测试同时断言 TLS 字段（tlsInsecure /
// tlsCaFile）绝不进入实例配置——它们由 lib/tls.js 在传输层按 origin 施加。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Config } from '@deepseek-ai/dsh-mcp-client'
import { buildClientConfig } from '../lib/logic.js'

describe('buildClientConfig 产出与 mcp-client Config schema 兼容', () => {
  it('stdio 完整配置通过校验，缺省字段被归一化', () => {
    const config = buildClientConfig({
      serverName: 'local',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { A: '1' },
      cwd: '/tmp',
      url: '',
      headers: {},
    })
    const parsed = Config(config)
    assert.equal(parsed.transport, 'stdio')
    assert.equal(parsed.serverName, 'local')
    assert.equal(parsed.command, 'npx')
    assert.deepEqual(parsed.args, ['-y', 'pkg'])
    assert.deepEqual(parsed.env, { A: '1' })
    assert.equal(parsed.cwd, '/tmp')
    assert.equal(parsed.toolCallTimeoutMs, 60000)
    assert.equal(parsed.failOnStartupError, false)
  })

  it('stdio 最小配置（只有 command）也通过校验', () => {
    const config = buildClientConfig({ serverName: 'local', transport: 'stdio', command: 'echo hi' })
    const parsed = Config(config)
    assert.equal(parsed.cwd, '')
    assert.deepEqual(parsed.args, [])
    assert.deepEqual(parsed.env, {})
  })

  it('streamable-http 配置通过校验', () => {
    const config = buildClientConfig({
      serverName: 'remote',
      transport: 'streamable-http',
      url: 'http://localhost:3000/mcp',
      headers: { Authorization: 'Bearer t' },
    })
    const parsed = Config(config)
    assert.equal(parsed.transport, 'streamable-http')
    assert.equal(parsed.url, 'http://localhost:3000/mcp')
    assert.deepEqual(parsed.headers, { Authorization: 'Bearer t' })
  })

  it('schema 校验不是摆设：必填缺失/transport 非法时抛错', () => {
    assert.throws(() => Config({ transport: 'stdio', serverName: 'x' }))
    assert.throws(() => Config({ transport: 'bogus', serverName: 'x' }))
    assert.throws(() => Config({ transport: 'stdio', serverName: 'bad name', command: 'x' }))
  })

  it('多余键不会被拒绝（会保留）——buildClientConfig 必须只输出契约内键', () => {
    const out = Config({ transport: 'stdio', serverName: 'x', command: 'echo', extraKey: 123 })
    assert.equal(out.extraKey, 123)
  })

  it('reconnect（0.1.5 起的可选配置）通过校验，缺省时由 schema 补齐', () => {
    const off = Config(
      buildClientConfig({
        serverName: 'local',
        transport: 'stdio',
        command: 'echo hi',
        reconnectEnabled: false,
        reconnectMaxAttempts: 3,
      }),
    )
    assert.equal(off.reconnect.enabled, false)
    assert.equal(off.reconnect.maxAttempts, 3)
    // 未显式给出的子键由 mcp-client 自己的默认值补齐（契约默认 500/30000）
    assert.equal(off.reconnect.initialDelayMs, 500)
    assert.equal(off.reconnect.maxDelayMs, 30000)

    const def = Config(
      buildClientConfig({
        serverName: 'local',
        transport: 'stdio',
        command: 'echo hi',
        reconnectEnabled: true,
        reconnectMaxAttempts: 10,
      }),
    )
    assert.equal(def.reconnect.enabled, true)
    assert.equal(def.reconnect.maxAttempts, 10)
  })

  it('TLS 选项不进实例配置（由 lib/tls.js 在传输层处理）', () => {
    const config = buildClientConfig({
      serverName: 'remote',
      transport: 'streamable-http',
      url: 'https://10.170.17.55:8091/mcp',
      headers: { 'X-API-Token': 'env:TOKEN' },
      tlsInsecure: true,
      tlsCaFile: 'C:\\certs\\ca.pem',
    })
    assert.equal('tlsInsecure' in config, false)
    assert.equal('tlsCaFile' in config, false)
    const parsed = Config(config)
    assert.equal(parsed.url, 'https://10.170.17.55:8091/mcp')
  })
})

describe('配置契约文档与 engines 声明跟着上游事实走', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const logicSource = readFileSync(new URL('../lib/logic.js', import.meta.url), 'utf8')
  // 只取 lib/logic.js 顶部的契约注释块（到 import 之前）。
  const contractDoc = logicSource.slice(0, logicSource.indexOf('import Schema'))

  it('lib/logic.js 的契约注释覆盖 mcp-client Config 的每一个键', () => {
    const schemaKeys = new Set(Config.list.flatMap((branch) => Object.keys(branch.dict ?? {})))
    const missing = [...schemaKeys].filter((key) => !contractDoc.includes(key))
    assert.deepEqual(missing, [], `lib/logic.js 的配置契约注释漏了：${missing.join(', ')}`)
  })

  it('注释里 maxInstructionBytes 的默认值与 mcp-client 实际补齐的一致', () => {
    // 文档自述不算数：省略该键，看真实 schema 填出什么。
    const parsed = Config(buildClientConfig({ serverName: 'local', transport: 'stdio', command: 'echo hi' }))
    const documented = contractDoc.match(/maxInstructionBytes[^\n]*?(\d+)/)
    assert.ok(documented, 'lib/logic.js 的契约注释没有写 maxInstructionBytes（或其默认值）')
    assert.equal(Number(documented[1]), parsed.maxInstructionBytes)
  })

  it('engines.node 覆盖 undici 的实际下限', () => {
    // undici 是唯一带 Node 下限的运行时依赖（TLS 定向 dispatcher 用），
    // 它一旦抬高下限而 engines 没跟上，插件会在受支持的 Node 上装出一个跑不动的组合。
    const undici = JSON.parse(readFileSync(createRequire(import.meta.url).resolve('undici/package.json'), 'utf8'))
    const floor = String(undici.engines.node).match(/\d+\.\d+\.\d+/)?.[0]
    assert.ok(floor, `undici 不再声明 engines.node？实际为 ${JSON.stringify(undici.engines.node)}`)
    // DSH 生态的统一写法：偶数 LTS 线，24 起整数线全收。
    assert.equal(pkg.engines.node, `^${floor} || >=24.0.0`)
  })
})
