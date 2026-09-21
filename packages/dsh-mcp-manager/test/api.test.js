// lib/api.js 单测：/api/mcp/servers 的纯逻辑（GET/POST、rev 乐观锁、校验、错误码）。
// 载体无关——不涉及 node:http 也不涉及 connection 的 Fetch 路由。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { API_PATH, MAX_BODY_BYTES, createApiHandler, isLoopbackRequest, readNodeBody } from '../lib/api.js'
import { Readable } from 'node:stream'

const STDIO = (name, extra = {}) => ({
  serverName: name,
  enabled: true,
  transport: 'stdio',
  command: 'echo hi',
  args: [],
  env: {},
  cwd: '',
  url: '',
  headers: {},
  toolCallTimeoutMs: 60000,
  failOnStartupError: false,
  ...extra,
})

/** 内存 settings 替身：记录 replace 调用，可注入冲突。 */
function harness({ rev = 0, servers = [], conflict = false } = {}) {
  const state = { servers, rev, replaced: [] }
  const handler = createApiHandler({
    getServers: () => state.servers,
    getRev: () => state.rev,
    getStatus: () => ({ srv: { state: 'ok', message: '' } }),
    replaceServers: async (next, expectedRev) => {
      if (conflict) {
        const error = new Error('settings namespace "mcp" changed since it was read')
        error.code = 'SETTINGS_CONFLICT'
        throw error
      }
      state.replaced.push({ next, expectedRev })
      state.servers = next
      state.rev += 1
    },
  })
  const call = (method, body) =>
    handler({
      method,
      readBody: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    })
  return { handler, call, state }
}

const parse = (result) => ({ status: result.status, data: JSON.parse(result.body) })

describe('API_PATH / MAX_BODY_BYTES', () => {
  it('路径与 DSH 0.1.5 connection.fetch 的约束一致（/api 下的合法端点段）', () => {
    assert.equal(API_PATH, '/api/mcp/servers')
    assert.match(API_PATH.slice('/api/'.length).split('/').join(''), /^[A-Za-z0-9_$.-]+$/)
    assert.equal(MAX_BODY_BYTES, 1024 * 1024)
  })
})

describe('GET /api/mcp/servers', () => {
  it('返回 rev / servers / status', async () => {
    const h = harness({ rev: 7, servers: [STDIO('a')] })
    const { status, data } = parse(await h.call('GET'))
    assert.equal(status, 200)
    assert.equal(data.rev, 7)
    assert.deepEqual(data.servers, [STDIO('a')])
    assert.deepEqual(data.status, { srv: { state: 'ok', message: '' } })
  })

  it('HEAD 与 GET 同形（不读 body）', async () => {
    const h = harness()
    let bodyRead = false
    const result = await h.handler({
      method: 'HEAD',
      readBody: async () => {
        bodyRead = true
        return ''
      },
    })
    assert.equal(result.status, 200)
    assert.equal(bodyRead, false)
  })

  it('content-type 固定为 JSON', async () => {
    const h = harness()
    const result = await h.call('GET')
    assert.equal(result.headers['content-type'], 'application/json; charset=utf-8')
  })
})

describe('POST /api/mcp/servers', () => {
  it('合法提交 → 200，并把 rev 透传给 settings.replace', async () => {
    const h = harness({ rev: 3 })
    const { status, data } = parse(await h.call('POST', { rev: 3, servers: [STDIO('a')] }))
    assert.equal(status, 200)
    assert.deepEqual(data, { ok: true })
    assert.equal(h.state.replaced.length, 1)
    assert.equal(h.state.replaced[0].expectedRev, 3)
  })

  it('不带 rev → 不传乐观锁（undefined）', async () => {
    const h = harness()
    await h.call('POST', { servers: [STDIO('a')] })
    assert.equal(h.state.replaced[0].expectedRev, undefined)
  })

  it('rev 冲突 → 409 + code:conflict + 当前 rev', async () => {
    const h = harness({ rev: 9, conflict: true })
    const { status, data } = parse(await h.call('POST', { rev: 1, servers: [] }))
    assert.equal(status, 409)
    assert.equal(data.code, 'conflict')
    assert.equal(data.rev, 9)
  })

  it('非 JSON / 非对象 / 非法 rev → 400', async () => {
    const h = harness()
    assert.equal(parse(await h.call('POST', 'not json')).status, 400)
    assert.equal(parse(await h.call('POST', [1, 2])).status, 400)
    assert.equal(parse(await h.call('POST', 'null')).status, 400)
    const badRev = parse(await h.call('POST', { rev: -1, servers: [] }))
    assert.equal(badRev.status, 400)
    assert.match(badRev.data.error, /rev 必须是 >= 0 的整数/)
    const floatRev = parse(await h.call('POST', { rev: 1.5, servers: [] }))
    assert.equal(floatRev.status, 400)
    assert.equal(h.state.replaced.length, 0)
  })

  it('servers 校验失败 → 400 且不落盘', async () => {
    const h = harness()
    const dup = parse(await h.call('POST', { servers: [STDIO('a'), STDIO('a')] }))
    assert.equal(dup.status, 400)
    assert.match(dup.data.error, /重复/)
    const noCommand = parse(await h.call('POST', { servers: [STDIO('b', { command: '  ' })] }))
    assert.equal(noCommand.status, 400)
    assert.match(noCommand.data.error, /必须提供 command/)
    assert.equal(h.state.replaced.length, 0)
  })

  it('读 body 失败（超限）→ 400 而不是 500', async () => {
    const h = harness()
    const result = await h.handler({
      method: 'POST',
      readBody: async () => {
        throw new Error('请求体超过 1024KB 上限')
      },
    })
    assert.equal(result.status, 400)
    assert.match(JSON.parse(result.body).error, /超过 1024KB 上限/)
  })

  it('其它方法 → 405', async () => {
    const h = harness()
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      assert.equal(parse(await h.call(method)).status, 405, method)
    }
  })
})

describe('请求体上限（载体无关：两条载体都必须生效）', () => {
  const payloadOf = (bytes) => {
    const base = JSON.stringify({ servers: [STDIO('a')], pad: '' })
    return JSON.stringify({ servers: [STDIO('a')], pad: 'x'.repeat(bytes - Buffer.byteLength(base)) })
  }

  it('超过 MAX_BODY_BYTES → 413，且不落盘', async () => {
    const h = harness()
    const body = payloadOf(MAX_BODY_BYTES + 1)
    const result = await h.handler({ method: 'POST', readBody: async () => body })
    assert.equal(result.status, 413)
    assert.match(JSON.parse(result.body).error, /超过 1024KB 上限/)
    assert.equal(h.state.replaced.length, 0)
  })

  it('恰好等于 MAX_BODY_BYTES → 放行（边界不误杀）', async () => {
    const h = harness()
    const body = payloadOf(MAX_BODY_BYTES)
    assert.equal(Buffer.byteLength(body), MAX_BODY_BYTES)
    const result = await h.handler({ method: 'POST', readBody: async () => body })
    assert.equal(result.status, 200)
  })

  it('底层读取器报超限（带 BODY_TOO_LARGE）→ 413 而不是 400', async () => {
    const h = harness()
    const error = new Error('请求体超过 1024KB 上限')
    error.code = 'BODY_TOO_LARGE'
    const result = await h.handler({
      method: 'POST',
      readBody: async () => {
        throw error
      },
    })
    assert.equal(result.status, 413)
    assert.match(JSON.parse(result.body).error, /超过 1024KB 上限/)
  })
})

describe('readNodeBody', () => {
  const streamOf = (text) => Readable.from([Buffer.from(text, 'utf8')])

  it('正常读完', async () => {
    assert.equal(await readNodeBody(streamOf('hello')), 'hello')
  })

  it('超过上限 → 报错并销毁流', async () => {
    const stream = streamOf('x'.repeat(64))
    await assert.rejects(() => readNodeBody(stream, 16), /超过 0KB 上限/)
  })
})

describe('isLoopbackRequest（没有 connection 栅栏时的退化护栏）', () => {
  const req = (remoteAddress) => ({ socket: { remoteAddress } })

  it('接受 IPv4/IPv6 回环', () => {
    for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '::ffff:127.9.9.9']) {
      assert.equal(isLoopbackRequest(req(address)), true, address)
    }
  })

  it('拒绝非回环来源（这是防「未授权调用即任意命令执行」的最后一道）', () => {
    for (const address of ['10.170.17.55', '192.168.1.10', '::ffff:10.0.0.1', '0.0.0.0', '', undefined]) {
      assert.equal(isLoopbackRequest(req(address)), false, String(address))
    }
    assert.equal(isLoopbackRequest(undefined), false)
    assert.equal(isLoopbackRequest({}), false)
  })
})
