// test/upstream.test.js — 用真实 node:http 假 memorix 验证 fetch 路径与错误映射。
//
// 不起真控制面：测试必须能在没有 memorix 的机器上跑通。唯一碰 CLI 的
// 路径（resolveViaCli）全部注入假 runner。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createUpstream, UpstreamError } from '../lib/upstream.js'

let server
let base
let hits = []

before(async () => {
  server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`)
    const u = new URL(req.url, 'http://x')
    const json = (status, body) =>
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))

    if (u.pathname === '/health') return json(200, { status: 'ok' })
    if (u.pathname === '/api/stats') return json(200, { observations: 2 })
    if (u.pathname === '/api/observations') return json(200, [{ id: 1 }, { id: 2 }])
    if (u.pathname === '/api/projects') return json(200, [])
    if (u.pathname === '/api/sessions') return json(200, [{ sessionId: 's1' }])
    if (u.pathname === '/api/observations/9' && req.method === 'DELETE') return json(200, { ok: true, deleted: 9 })
    if (u.pathname === '/api/observations/7') return json(403, { error: 'belongs to other project' })
    if (u.pathname === '/api/notjson')
      return res.writeHead(200, { 'content-type': 'text/html' }).end('<html>nope</html>')
    if (u.pathname === '/api/boom') return res.writeHead(500, { 'content-type': 'text/plain' }).end('x'.repeat(500))
    return json(404, { error: 'nf' })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => server.close())

describe('upstream happy paths', () => {
  it('health 返回 up', async () => {
    const r = await createUpstream({ baseUrl: base }).health()
    assert.equal(r.up, true)
    assert.equal(r.raw.status, 'ok')
  })

  it('health 在不可达时返回 up:false 而不抛', async () => {
    const r = await createUpstream({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 }).health()
    assert.equal(r.up, false)
    assert.ok(r.error)
  })

  it('getStats / listObservations / getProjects / getSessions 解析 JSON', async () => {
    const up = createUpstream({ baseUrl: base })
    assert.deepEqual(await up.getStats(), { observations: 2 })
    assert.equal((await up.listObservations()).length, 2)
    assert.deepEqual(await up.getProjects(), [])
    assert.equal((await up.getSessions()).length, 1)
  })

  it('project 参数进入 query 且被正确编码', async () => {
    hits = []
    await createUpstream({ baseUrl: base }).listObservations('local/dsh-memery')
    assert.ok(hits.includes('GET /api/observations?project=local%2Fdsh-memery'), hits.join(','))
  })

  it('省略 project 时不带 query', async () => {
    hits = []
    await createUpstream({ baseUrl: base }).listObservations()
    assert.ok(hits.includes('GET /api/observations'), hits.join(','))
  })

  it('DELETE 成功路径', async () => {
    const r = await createUpstream({ baseUrl: base }).deleteObservation(9, 'local/x')
    assert.equal(r.deleted, 9)
  })
})

describe('upstream error mapping', () => {
  it('上游 403 映射为 UpstreamError，带 status 与上游原文', async () => {
    await assert.rejects(
      () => createUpstream({ baseUrl: base }).deleteObservation(7),
      (e) => e instanceof UpstreamError && e.status === 403 && /other project/.test(e.message),
    )
  })

  it('非 JSON 的 2xx 响应映射为 bad_upstream', async () => {
    await assert.rejects(
      () => createUpstream({ baseUrl: base }).getJson('/api/notjson'),
      (e) => e instanceof UpstreamError && e.code === 'bad_upstream',
    )
  })

  it('非 JSON 的 5xx 响应不泄漏超长原文（截断）', async () => {
    await assert.rejects(
      () => createUpstream({ baseUrl: base }).getJson('/api/boom'),
      (e) => e.status === 500 && e.message.length < 300,
    )
  })

  it('控制面不可达 → control_plane_down 且带启动提示', async () => {
    await assert.rejects(
      () => createUpstream({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 }).getStats(),
      (e) => e.code === 'control_plane_down' && /background start/.test(e.hint),
    )
  })
})

describe('resolveViaCli', () => {
  it('用注入的 runner，不真跑 CLI；参数形状正确', async () => {
    const calls = []
    const up = createUpstream({
      baseUrl: base,
      runCli: async (args) => {
        calls.push(args)
        return { code: 0, stdout: '{"ok":true}' }
      },
    })
    const r = await up.resolveViaCli({ id: 5, status: 'resolved', workspaceRoot: 'E:/w' })
    assert.equal(r.ok, true)
    assert.deepEqual(calls[0].slice(0, 4), ['memory', 'resolve', '--ids', '5'])
    assert.ok(calls[0].includes('--cwd'))
    assert.ok(calls[0].includes('E:/w'))
    assert.ok(calls[0].includes('--json'))
  })

  it('默认 status 是 resolved', async () => {
    const calls = []
    const up = createUpstream({
      baseUrl: base,
      runCli: async (a) => {
        calls.push(a)
        return { code: 0, stdout: '' }
      },
    })
    await up.resolveViaCli({ id: 1 })
    assert.ok(calls[0].includes('resolved'))
    assert.ok(!calls[0].includes('--cwd'), '未给 workspaceRoot 时不应带 --cwd')
  })

  it('status=archived 被透传', async () => {
    const calls = []
    const up = createUpstream({
      baseUrl: base,
      runCli: async (a) => {
        calls.push(a)
        return { code: 0, stdout: '' }
      },
    })
    await up.resolveViaCli({ id: 1, status: 'archived' })
    assert.ok(calls[0].includes('archived'))
  })

  it('非零退出如实返回失败（不假装成功）', async () => {
    const up = createUpstream({
      baseUrl: base,
      runCli: async () => ({ code: 1, stdout: '', stderr: 'no such command' }),
    })
    const r = await up.resolveViaCli({ id: 5 })
    assert.equal(r.ok, false)
    assert.match(r.error, /no such command/)
  })

  it('非法 status 直接拒绝，不跑 CLI', async () => {
    let called = false
    const up = createUpstream({
      baseUrl: base,
      runCli: async () => {
        called = true
        return { code: 0, stdout: '' }
      },
    })
    const r = await up.resolveViaCli({ id: 1, status: '../../etc' })
    assert.equal(r.ok, false)
    assert.equal(called, false)
  })
})

describe('resolveProjectId', () => {
  it('解析 CLI 的 project.id', async () => {
    const up = createUpstream({
      baseUrl: base,
      runCli: async () => ({ code: 0, stdout: JSON.stringify({ project: { id: 'local/dsh-memery' } }) }),
    })
    assert.equal(await up.resolveProjectId('E:/w'), 'local/dsh-memery')
  })

  it('CLI 失败返回 undefined 而不抛', async () => {
    const up = createUpstream({ baseUrl: base, runCli: async () => ({ code: 1, stdout: '', stderr: 'nope' }) })
    assert.equal(await up.resolveProjectId('E:/w'), undefined)
  })

  it('输出不是 JSON 时返回 undefined 而不抛', async () => {
    const up = createUpstream({ baseUrl: base, runCli: async () => ({ code: 0, stdout: 'not json' }) })
    assert.equal(await up.resolveProjectId('E:/w'), undefined)
  })
})
