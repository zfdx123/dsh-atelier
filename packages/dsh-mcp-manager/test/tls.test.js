// lib/tls.js 单测：每服务器 TLS 策略、定向 fetch 分流、错误链展开与可操作提示、
// 引用计数与可逆性。undici 与 CA 文件读取都注入假实现——测试不联网、不依赖真实证书。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mcpOriginFor, tlsPolicyFor, describeErrorChain, explainMcpNetworkError, createTlsBridge } from '../lib/tls.js'

const HTTP_URL = 'https://10.170.17.55:8091/mcp'

/** 假的 undici 模块：记录 Agent 构造参数与 fetch 调用。 */
function fakeUndici() {
  const state = { agents: [], calls: [] }
  class Agent {
    constructor(options) {
      this.options = options
      this.closed = false
      state.agents.push(this)
    }
    async close() {
      this.closed = true
    }
  }
  const fetch = async (input, init) => {
    state.calls.push({ input, init })
    if (state.reject !== undefined) throw state.reject
    return { via: 'undici', status: 200 }
  }
  return { module: { Agent, fetch }, state }
}

function harness(options = {}) {
  const undici = fakeUndici()
  let caReads = 0
  const state = { rejectOriginal: undefined }
  const scope = {
    fetch: async (input) => {
      if (state.rejectOriginal !== undefined) throw state.rejectOriginal
      return { via: 'original', input }
    },
  }
  const original = scope.fetch
  const warnings = []
  const bridge = createTlsBridge({
    loadUndici: async () => {
      if (options.undiciMissing) throw new Error('Cannot find package undici')
      return undici.module
    },
    readCaFile: async (path) => {
      caReads += 1
      if (options.caMissing) throw new Error(`ENOENT: no such file, open '${path}'`)
      return '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----'
    },
    scope,
    onWarn: (message) => warnings.push(message),
  })
  return { bridge, scope, state, original, undici, warnings, caReads: () => caReads }
}

const httpsServer = (extra = {}) => ({
  serverName: 'logs',
  transport: 'streamable-http',
  url: HTTP_URL,
  ...extra,
})

describe('mcpOriginFor', () => {
  it('streamable-http 取 origin；stdio / 非法 url / 空 url → null', () => {
    assert.equal(mcpOriginFor(httpsServer()), 'https://10.170.17.55:8091')
    assert.equal(mcpOriginFor(httpsServer({ url: 'http://127.0.0.1:3000/mcp' })), 'http://127.0.0.1:3000')
    assert.equal(mcpOriginFor({ transport: 'stdio', command: 'x' }), null)
    assert.equal(mcpOriginFor(httpsServer({ url: 'not a url' })), null)
    assert.equal(mcpOriginFor(httpsServer({ url: '   ' })), null)
    assert.equal(mcpOriginFor(null), null)
  })
})

describe('tlsPolicyFor', () => {
  it('stdio / http:// / 未开选项 → 不产生策略', () => {
    assert.equal(tlsPolicyFor({ transport: 'stdio', command: 'x' }), null)
    assert.equal(
      tlsPolicyFor({ transport: 'streamable-http', url: 'http://127.0.0.1:3000/mcp', tlsInsecure: true }),
      null,
    )
    assert.equal(tlsPolicyFor(httpsServer()), null)
    assert.equal(tlsPolicyFor(httpsServer({ tlsCaFile: '   ' })), null)
  })

  it('tlsInsecure / tlsCaFile → 该 origin 的策略（路径去空白）', () => {
    assert.deepEqual(tlsPolicyFor(httpsServer({ tlsInsecure: true })), {
      origin: 'https://10.170.17.55:8091',
      insecure: true,
      caFile: '',
    })
    assert.deepEqual(tlsPolicyFor(httpsServer({ tlsCaFile: ' C:\\certs\\ca.pem ' })), {
      origin: 'https://10.170.17.55:8091',
      insecure: false,
      caFile: 'C:\\certs\\ca.pem',
    })
  })
})

describe('describeErrorChain（undici 把根因放在 cause 上）', () => {
  it('展开整条链条并去重', () => {
    const root = Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
    const middle = new TypeError('fetch failed', { cause: root })
    const top = new Error('initial connection failed', { cause: middle })
    assert.equal(
      describeErrorChain(top),
      'initial connection failed ← fetch failed ← DEPTH_ZERO_SELF_SIGNED_CERT self-signed certificate',
    )
  })

  it('容忍非 Error / 空值 / 自引用环', () => {
    assert.equal(describeErrorChain('boom'), 'boom')
    assert.equal(describeErrorChain(undefined), '')
    const loop = new Error('a')
    loop.cause = loop
    assert.equal(describeErrorChain(loop), 'a')
  })
})

describe('explainMcpNetworkError', () => {
  it('证书类错误 → 提示开自签名开关或填 CA 文件', () => {
    const raw = new TypeError('fetch failed', {
      cause: Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }),
    })
    const explained = explainMcpNetworkError(raw, { origin: 'https://10.0.0.1:8091', tlsRelaxed: false })
    assert.match(explained.message, /self-signed certificate/)
    assert.match(explained.message, /允许自签名证书/)
    assert.equal(explained.cause, raw, '保留原始错误为 cause')
  })

  it('已开 TLS 仍失败 → 提示核对 CA 文件', () => {
    const explained = explainMcpNetworkError(
      new Error('fetch failed', { cause: new Error('unable to verify the first certificate') }),
      {
        origin: 'https://10.0.0.1:8091',
        tlsRelaxed: true,
      },
    )
    assert.match(explained.message, /tlsCaFile/)
  })

  it('连接类错误 → 网络层提示；未知错误只加 origin 前缀', () => {
    const refused = explainMcpNetworkError(
      new Error('fetch failed', { cause: new Error('connect ECONNREFUSED 10.0.0.1:8091') }),
      {
        origin: 'https://10.0.0.1:8091',
        tlsRelaxed: false,
      },
    )
    assert.match(refused.message, /网络层失败/)
    const other = explainMcpNetworkError(new Error('whatever'), { origin: 'https://10.0.0.1:8091', tlsRelaxed: false })
    assert.equal(other.message, 'https://10.0.0.1:8091: whatever')
  })

  it('AbortError 原样返回（用户取消不该被改写）', () => {
    const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
    assert.equal(explainMcpNetworkError(abort, { origin: 'https://x', tlsRelaxed: false }), abort)
  })
})

describe('createTlsBridge：定向分流', () => {
  it('未挂载的 origin 完全不受影响', async () => {
    const h = harness()
    await h.bridge.apply(httpsServer({ tlsInsecure: true }))
    for (const url of [
      'https://api.deepseek.com/v1/chat',
      'https://10.170.17.55:8443/mcp',
      'http://10.170.17.55:8091/mcp',
    ]) {
      const result = await h.scope.fetch(url)
      assert.equal(result.via, 'original', url)
    }
    assert.equal(h.undici.state.calls.length, 0)
  })

  it('配了 TLS 的 origin 走 undici + 定制 dispatcher（同 origin 任意路径）', async () => {
    const h = harness()
    assert.equal(await h.bridge.apply(httpsServer({ tlsInsecure: true })), 'https://10.170.17.55:8091')
    assert.equal((await h.scope.fetch(HTTP_URL, { method: 'POST' })).via, 'undici')
    assert.equal((await h.scope.fetch(new URL('https://10.170.17.55:8091/other'))).via, 'undici')
    assert.equal((await h.scope.fetch({ url: HTTP_URL })).via, 'undici')
    assert.equal(h.undici.state.calls[0].init.dispatcher, h.undici.state.agents[0])
    assert.equal(h.bridge.hasPolicy('https://10.170.17.55:8091'), true)
  })

  it('没配 TLS 的 MCP origin 也登记（只为诊断），请求仍走原 fetch', async () => {
    const h = harness()
    assert.equal(await h.bridge.apply(httpsServer()), 'https://10.170.17.55:8091')
    const result = await h.scope.fetch(HTTP_URL)
    assert.equal(result.via, 'original')
    assert.equal(h.undici.state.calls.length, 0)
    assert.equal(h.undici.state.agents.length, 0)
    assert.equal(h.bridge.hasPolicy('https://10.170.17.55:8091'), false)
  })

  it('分流失败时抛出展开过原因链、带可操作提示的错误', async () => {
    const h = harness()
    await h.bridge.apply(httpsServer({ tlsInsecure: true }))
    h.undici.state.reject = new TypeError('fetch failed', {
      cause: Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }),
    })
    await assert.rejects(
      () => h.scope.fetch(HTTP_URL),
      (error) => {
        assert.match(error.message, /DEPTH_ZERO_SELF_SIGNED_CERT/)
        assert.match(error.message, /允许自签名证书/)
        return true
      },
    )

    // 未登记的 origin 不受影响：原样抛出原错误（不被改写）
    h.state.rejectOriginal = new TypeError('fetch failed')
    await assert.rejects(
      () => h.scope.fetch('https://other.example/x'),
      (error) => {
        assert.equal(error.message, 'fetch failed')
        assert.equal(error.cause, undefined)
        return true
      },
    )
  })

  it('没配 TLS 的 MCP origin 失败时同样展开原因链（诊断不依赖是否放宽校验）', async () => {
    const h = harness()
    await h.bridge.apply(httpsServer())
    h.state.rejectOriginal = new TypeError('fetch failed', {
      cause: Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }),
    })
    await assert.rejects(
      () => h.scope.fetch(HTTP_URL),
      (error) => {
        assert.match(error.message, /self-signed certificate/)
        assert.match(error.message, /允许自签名证书/)
        return true
      },
    )
  })

  it('tlsInsecure → rejectUnauthorized:false；tlsCaFile → ca + 保持校验', async () => {
    const insecure = harness()
    await insecure.bridge.apply(httpsServer({ tlsInsecure: true }))
    assert.deepEqual(insecure.undici.state.agents[0].options, { connect: { rejectUnauthorized: false } })

    const pinned = harness()
    await pinned.bridge.apply(httpsServer({ tlsCaFile: 'C:\\certs\\ca.pem' }))
    assert.equal(pinned.caReads(), 1)
    assert.equal(pinned.undici.state.agents[0].options.connect.rejectUnauthorized, true)
    assert.match(String(pinned.undici.state.agents[0].options.connect.ca), /BEGIN CERTIFICATE/)

    const both = harness()
    await both.bridge.apply(httpsServer({ tlsInsecure: true, tlsCaFile: 'C:\\certs\\ca.pem' }))
    assert.equal(both.undici.state.agents[0].options.connect.rejectUnauthorized, false)
  })

  it('stdio 不进桥（返回 null，且完全不碰 fetch）', async () => {
    const h = harness()
    assert.equal(await h.bridge.apply({ serverName: 's', transport: 'stdio', command: 'x' }), null)
    assert.equal(h.scope.fetch, h.original)
    assert.equal(h.bridge.size, 0)
  })
})

describe('createTlsBridge：引用计数与可逆性', () => {
  it('同 origin 多台服务器共用条目；全部释放后还原 fetch', async () => {
    const h = harness()
    const first = await h.bridge.apply(httpsServer({ tlsInsecure: true }))
    const second = await h.bridge.apply({ ...httpsServer({ tlsInsecure: true }), serverName: 'logs2' })
    assert.equal(first, second)
    assert.equal(h.undici.state.agents.length, 1)
    assert.equal(h.bridge.size, 1)

    await h.bridge.release(first)
    assert.equal(h.bridge.has(first), true, '仍有使用者时条目保留')
    assert.notEqual(h.scope.fetch, h.original, '仍在分流')

    await h.bridge.release(second)
    assert.equal(h.bridge.size, 0)
    assert.equal(h.scope.fetch, h.original, '最后一个使用者释放后还原原 fetch')
    assert.equal(h.undici.state.agents[0].closed, true, 'Agent 已关闭')
  })

  it('同 origin 一台要 TLS、一台不要 → 按需重建并告警', async () => {
    const h = harness()
    await h.bridge.apply(httpsServer({ tlsInsecure: true }))
    await h.bridge.apply(httpsServer())
    assert.equal(h.undici.state.agents[0].closed, true)
    assert.equal(h.bridge.hasPolicy('https://10.170.17.55:8091'), false)
    assert.equal((await h.scope.fetch(HTTP_URL)).via, 'original')
    assert.equal(h.warnings.length, 1)
  })

  it('同 origin 两台服务器策略不同 → 以最新配置重建并告警', async () => {
    const h = harness()
    await h.bridge.apply(httpsServer({ tlsInsecure: true }))
    await h.bridge.apply(httpsServer({ tlsCaFile: 'C:\\certs\\ca.pem' }))
    assert.equal(h.undici.state.agents.length, 2)
    assert.equal(h.undici.state.agents[0].closed, true)
    assert.equal(h.undici.state.agents[1].options.connect.rejectUnauthorized, true)
    assert.equal(h.warnings.length, 1)
    assert.match(h.warnings[0], /不同的 TLS 策略/)
  })

  it('dispose() 释放全部并还原；释放未登记 origin 幂等', async () => {
    const h = harness()
    await h.bridge.apply(httpsServer({ tlsInsecure: true }))
    await h.bridge.apply({
      serverName: 'other',
      transport: 'streamable-http',
      url: 'https://other.example/mcp',
      tlsCaFile: 'x.pem',
    })
    assert.equal(h.bridge.size, 2)
    await h.bridge.dispose()
    assert.equal(h.bridge.size, 0)
    assert.equal(h.scope.fetch, h.original)
    assert.equal(
      h.undici.state.agents.every((agent) => agent.closed),
      true,
    )

    await h.bridge.release('https://nope.example')
    assert.equal(h.scope.fetch, h.original)
  })
})

describe('createTlsBridge：失败路径不静默', () => {
  it('undici 不可用 → 抛出可读错误，且不留条目/不改 fetch', async () => {
    const h = harness({ undiciMissing: true })
    await assert.rejects(
      () => h.bridge.apply(httpsServer({ tlsInsecure: true })),
      /需要 undici 才能为 https:\/\/10\.170\.17\.55:8091 应用 TLS 策略/,
    )
    assert.equal(h.bridge.size, 0)
    assert.equal(h.scope.fetch, h.original)
  })

  it('CA 文件读不到 → 抛出可读错误，且不留条目', async () => {
    const h = harness({ caMissing: true })
    await assert.rejects(
      () => h.bridge.apply(httpsServer({ tlsCaFile: 'C:\\certs\\missing.pem' })),
      /读取 CA 文件失败 C:\\certs\\missing\.pem/,
    )
    assert.equal(h.bridge.size, 0)
    assert.equal(h.scope.fetch, h.original)
  })
})
