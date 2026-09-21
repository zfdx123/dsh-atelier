// test/endpoints.test.js — 端点层：路由、参数校验、错误映射（上游全部注入）。
//
// 不碰网络、不碰真 CLI：假 upstream 注入即可覆盖全部分支。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createApiHandler } from '../lib/endpoints.js'
import { UpstreamError } from '../lib/upstream.js'

const OBS = [
  { id: 2, type: 'gotcha', source: 'git', title: 'WAL locked', narrative: 'sqlite busy' },
  { id: 1, type: 'decision', source: 'agent', title: 'Use HTTP', narrative: 'shared endpoint' },
]

function fakeUpstream(over = {}) {
  return {
    health: async () => ({ up: true, raw: { status: 'ok' } }),
    getStats: async () => ({
      observations: 2,
      typeCounts: { gotcha: 1 },
      sourceCounts: { git: 1 },
      retentionSummary: { active: 2 },
    }),
    getProjects: async () => [{ id: 'local/dsh-memery' }],
    listObservations: async () => OBS,
    getSessions: async () => [{ sessionId: 's1' }],
    deleteObservation: async (id) => ({ ok: true, deleted: id }),
    resolveViaCli: async () => ({ ok: true, stdout: '{}' }),
    baseUrl: 'http://127.0.0.1:3211',
    ...over,
  }
}

const mk = (over, opts = {}) =>
  createApiHandler({
    upstream: fakeUpstream(over),
    resolveProject: async () => 'local/dsh-memery',
    workspaceRoot: 'E:/work/ai/dsh-memery',
    ...opts,
  })

const call = (handler, method, path, { query = {}, body = '' } = {}) =>
  handler({ method, path, query, readBody: async () => body })

const parse = (r) => JSON.parse(r.body)

describe('routing', () => {
  it('GET /health 返回 ok:true 并带作用域信息', async () => {
    const r = await call(mk(), 'GET', '/health')
    assert.equal(r.status, 200)
    const b = parse(r)
    assert.equal(b.ok, true)
    assert.equal(b.data.up, true)
    assert.equal(b.data.project, 'local/dsh-memery')
    assert.equal(b.data.workspaceRoot, 'E:/work/ai/dsh-memery')
  })

  it('GET /health 控制面不可达且自动拉起失败 → 带 hint 与 error', async () => {
    const h = mk(
      { health: async () => ({ up: false, error: 'fetch failed' }) },
      { autostart: { ensureUp: async () => ({ state: 'failed', error: '启动超时' }) } },
    )
    const b = parse(await call(h, 'GET', '/health'))
    assert.equal(b.data.up, false)
    assert.equal(b.data.starting, false)
    assert.equal(b.data.error, 'fetch failed')
    assert.match(b.data.autostartError, /启动超时/, '自动拉起的失败必须单独可见')
    assert.match(b.data.hint, /memorix background start/)
  })

  it('GET /health 自动拉起中 → starting:true 且不给「请手动启动」', async () => {
    const h = mk(
      { health: async () => ({ up: false, error: 'fetch failed' }) },
      { autostart: { ensureUp: async () => ({ state: 'starting' }) } },
    )
    const b = parse(await call(h, 'GET', '/health'))
    assert.equal(b.data.up, false)
    assert.equal(b.data.starting, true)
    assert.equal(b.data.hint, undefined, '正在自动拉起时不该叫用户去手动启动')
  })

  it('GET /health 自动拉起成功后 up:true 并带回版本', async () => {
    let calls = 0
    const h = mk(
      {
        health: async () => {
          calls += 1
          return calls > 1 ? { up: true, raw: { version: '1.9.3' } } : { up: false, error: 'down' }
        },
      },
      { autostart: { ensureUp: async () => ({ state: 'up', started: true }) } },
    )
    const b = parse(await call(h, 'GET', '/health'))
    assert.equal(b.data.up, true)
    assert.equal(b.data.version, '1.9.3')
    assert.equal(b.data.starting, false)
  })

  it('GET /health 不传 autostart 时纯探活、不启动', async () => {
    const b = parse(await call(mk({ health: async () => ({ up: false, error: 'down' }) }), 'GET', '/health'))
    assert.equal(b.data.up, false)
    assert.equal(b.data.starting, false)
  })

  it('GET /stats 走 summarizeStats', async () => {
    const b = parse(await call(mk(), 'GET', '/stats'))
    assert.equal(b.data.observations, 2)
    assert.deepEqual(b.data.retention, { active: 2, stale: 0, archive: 0, immune: 0 })
  })

  it('GET /observations 支持 q 过滤且 project 透传', async () => {
    const seen = []
    const h = mk({
      listObservations: async (p) => {
        seen.push(p)
        return OBS
      },
    })
    const b = parse(await call(h, 'GET', '/observations', { query: { q: 'sqlite' } }))
    assert.equal(b.data.total, 1)
    assert.deepEqual(seen, ['local/dsh-memery'])
  })

  it('GET /projects 与 /sessions 透传', async () => {
    assert.equal(parse(await call(mk(), 'GET', '/projects')).data.length, 1)
    assert.equal(parse(await call(mk(), 'GET', '/sessions')).data.length, 1)
  })

  it('未知路径 404', async () => {
    const r = await call(mk(), 'GET', '/nope')
    assert.equal(r.status, 404)
    assert.equal(parse(r).code, 'not_found')
  })

  it('方法不匹配 405', async () => {
    const r = await call(mk(), 'POST', '/stats')
    assert.equal(r.status, 405)
    assert.equal(parse(r).code, 'method_not_allowed')
  })

  it('DELETE /observations/9 真删', async () => {
    const b = parse(await call(mk(), 'DELETE', '/observations/9'))
    assert.equal(b.data.deleted, 9)
  })

  it('DELETE /observations?id=9 也真删（宿主精确路径注册只能这么寻址）', async () => {
    const seen = []
    const h = mk({
      deleteObservation: async (id, p) => {
        seen.push([id, p])
        return { ok: true, deleted: id }
      },
    })
    const b = parse(await call(h, 'DELETE', '/observations', { query: { id: '9' } }))
    assert.equal(b.data.deleted, 9)
    assert.deepEqual(seen, [[9, 'local/dsh-memery']])
  })

  it('DELETE /observations 不带 id 是 404 而不是删错东西', async () => {
    assert.equal((await call(mk(), 'DELETE', '/observations')).status, 404)
  })

  it('resolveProject 抛错时退化为不指定 project，而不是 500', async () => {
    const seen = []
    const h = mk(
      {
        listObservations: async (p) => {
          seen.push(p)
          return OBS
        },
      },
      {
        resolveProject: async () => {
          throw new Error('cli missing')
        },
      },
    )
    const r = await call(h, 'GET', '/observations')
    assert.equal(r.status, 200)
    assert.deepEqual(seen, [undefined])
  })

  it('显式 project 查询参数覆盖自动解析', async () => {
    const seen = []
    const h = mk({
      listObservations: async (p) => {
        seen.push(p)
        return OBS
      },
    })
    await call(h, 'GET', '/observations', { query: { project: 'local/other' } })
    assert.deepEqual(seen, ['local/other'])
  })
})

describe('validation', () => {
  it('非法查询参数 400 且不打上游', async () => {
    let called = false
    const h = mk({
      listObservations: async () => {
        called = true
        return OBS
      },
    })
    const r = await call(h, 'GET', '/observations', { query: { limit: '9999' } })
    assert.equal(r.status, 400)
    assert.equal(called, false)
    assert.equal(parse(r).code, 'bad_request')
  })

  it('非法 project 400 且不打上游', async () => {
    let called = false
    const h = mk({
      listObservations: async () => {
        called = true
        return OBS
      },
    })
    const r = await call(h, 'GET', '/observations', { query: { project: '../../etc/passwd' } })
    assert.equal(r.status, 400)
    assert.equal(called, false)
  })

  it('DELETE 非数字 id 400', async () => {
    assert.equal((await call(mk(), 'DELETE', '/observations/abc')).status, 400)
  })

  it('DELETE 未匹配的 /observations/ 形式 404', async () => {
    assert.equal((await call(mk(), 'DELETE', '/observations/')).status, 404)
  })

  it('POST /resolve 缺 id 400', async () => {
    const r = await call(mk(), 'POST', '/resolve', { body: '{}' })
    assert.equal(r.status, 400)
  })

  it('POST /resolve body 非法 JSON 400', async () => {
    const r = await call(mk(), 'POST', '/resolve', { body: '{oops' })
    assert.equal(r.status, 400)
  })
})

describe('error mapping', () => {
  it('上游 403 透传状态与文案', async () => {
    const h = mk({
      deleteObservation: async () => {
        throw new UpstreamError('belongs to other project', { status: 403, code: 'upstream_error' })
      },
    })
    const r = await call(h, 'DELETE', '/observations/7')
    assert.equal(r.status, 403)
    assert.match(parse(r).error, /other project/)
  })

  it('控制面不可达 → 503 + control_plane_down + hint', async () => {
    const h = mk({
      getStats: async () => {
        throw new UpstreamError('fetch failed', { code: 'control_plane_down', hint: 'run: memorix background start' })
      },
    })
    const r = await call(h, 'GET', '/stats')
    assert.equal(r.status, 503)
    assert.equal(parse(r).code, 'control_plane_down')
    assert.match(parse(r).hint, /background start/)
  })

  it('未预期异常 → 500 且不泄漏堆栈或内部路径', async () => {
    const h = mk({
      getStats: async () => {
        throw new Error('boom at secret path /x/y')
      },
    })
    const r = await call(h, 'GET', '/stats')
    assert.equal(r.status, 500)
    const b = parse(r)
    assert.equal(b.error, 'internal error')
    assert.ok(!r.body.includes('secret path'))
  })

  it('POST /resolve CLI 失败 → 502 且 hint 指向 Dashboard', async () => {
    const h = mk({ resolveViaCli: async () => ({ ok: false, error: 'no such command' }) })
    const r = await call(h, 'POST', '/resolve', { body: '{"id":5}' })
    assert.equal(r.status, 502)
    const b = parse(r)
    assert.match(b.error, /no such command/)
    assert.ok(b.hint)
  })

  it('POST /resolve 成功 → 200', async () => {
    const h = mk({ resolveViaCli: async ({ id, status }) => ({ ok: true, id, status }) })
    const r = await call(h, 'POST', '/resolve', { body: '{"id":5,"status":"archived"}' })
    assert.equal(r.status, 200)
    assert.deepEqual(parse(r).data, { ok: true, id: 5, status: 'archived' })
  })

  it('上游返回 null 观察列表不抛错', async () => {
    const h = mk({ listObservations: async () => null })
    const r = await call(h, 'GET', '/observations')
    assert.equal(r.status, 200)
    assert.deepEqual(parse(r).data.items, [])
  })
})
