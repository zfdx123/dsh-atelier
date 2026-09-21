// test/logic.test.js — 纯逻辑：参数校验、搜索/筛选/分页、统计摘要、响应信封。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateQuery, filterObservations, summarizeStats, ok, fail, jsonHeaders } from '../lib/logic.js'

const OBS = [
  { id: 3, projectId: 'local/a', type: 'decision', source: 'agent', title: 'Use HTTP', narrative: 'because shared' },
  { id: 2, projectId: 'local/a', type: 'gotcha', source: 'git', title: 'WAL locked', narrative: 'sqlite busy' },
  { id: 1, projectId: 'local/a', type: 'decision', source: 'manual', title: 'SQLite', narrative: 'single file' },
]

describe('validateQuery', () => {
  it('缺省值合理', () => {
    const r = validateQuery({})
    assert.equal(r.ok, true)
    assert.equal(r.value.limit, 50)
    assert.equal(r.value.offset, 0)
    assert.equal(r.value.type, '')
    assert.equal(r.value.q, '')
  })

  it('接受合法 project', () => {
    const r = validateQuery({ project: 'local/dsh-memery' })
    assert.equal(r.ok, true)
    assert.equal(r.value.project, 'local/dsh-memery')
  })

  it('拒绝非数字 id', () => {
    const r = validateQuery({ id: 'abc' })
    assert.equal(r.ok, false)
    assert.match(r.error, /id/)
  })

  it('拒绝非法 project 字符（防 SSRF/注入）', () => {
    assert.equal(validateQuery({ project: 'a/../../etc' }).ok, false)
    assert.equal(validateQuery({ project: 'http://evil/x' }).ok, false)
    assert.equal(validateQuery({ project: 'a b' }).ok, false)
    assert.equal(validateQuery({ project: 'x'.repeat(201) }).ok, false)
  })

  it('拒绝超界 limit', () => {
    assert.equal(validateQuery({ limit: '0' }).ok, false)
    assert.equal(validateQuery({ limit: '501' }).ok, false)
    assert.equal(validateQuery({ limit: '200' }).ok, true)
  })

  it('拒绝非法 type 与 source', () => {
    assert.equal(validateQuery({ type: 'nope' }).ok, false)
    assert.equal(validateQuery({ type: 'decision' }).ok, true)
    assert.equal(validateQuery({ source: 'nope' }).ok, false)
    assert.equal(validateQuery({ source: 'git' }).ok, true)
  })

  it('接受 URLSearchParams', () => {
    const r = validateQuery(new URLSearchParams('q=sqlite&limit=1'))
    assert.equal(r.ok, true)
    assert.equal(r.value.q, 'sqlite')
    assert.equal(r.value.limit, 1)
  })
})

describe('filterObservations', () => {
  it('按关键词搜标题与叙述（大小写不敏感）', () => {
    const { items, total } = filterObservations(OBS, validateQuery({ q: 'SQLITE' }).value)
    assert.equal(total, 2)
    assert.deepEqual(
      items.map((o) => o.id),
      [2, 1],
    )
  })

  it('按 type 过滤', () => {
    assert.equal(filterObservations(OBS, validateQuery({ type: 'decision' }).value).total, 2)
  })

  it('按 source 过滤', () => {
    const { items } = filterObservations(OBS, validateQuery({ source: 'git' }).value)
    assert.deepEqual(
      items.map((o) => o.id),
      [2],
    )
  })

  it('分页返回 total 为过滤后总数', () => {
    const { items, total } = filterObservations(OBS, validateQuery({ limit: '1', offset: '1' }).value)
    assert.equal(total, 3)
    assert.equal(items.length, 1)
    assert.equal(items[0].id, 2)
  })

  it('结果按 id 降序（新的在前）', () => {
    assert.deepEqual(
      filterObservations(OBS, validateQuery({}).value).items.map((o) => o.id),
      [3, 2, 1],
    )
  })

  it('非数组输入返回空而不是抛错', () => {
    const { items, total } = filterObservations(null, validateQuery({}).value)
    assert.deepEqual(items, [])
    assert.equal(total, 0)
  })

  it('非对象成员被跳过', () => {
    const { total } = filterObservations([null, 7, { id: 1, title: 'ok' }], validateQuery({}).value)
    assert.equal(total, 1)
  })
})

describe('summarizeStats', () => {
  it('抽出面板需要的字段', () => {
    const s = summarizeStats({
      observations: 7,
      typeCounts: { decision: 3 },
      sourceCounts: { git: 1, agent: 2, manual: 4 },
      retentionSummary: { active: 7, stale: 0, archive: 0, immune: 0 },
    })
    assert.equal(s.observations, 7)
    assert.deepEqual(s.typeCounts, { decision: 3 })
    assert.deepEqual(s.retention, { active: 7, stale: 0, archive: 0, immune: 0 })
  })

  it('缺字段时给安全默认值', () => {
    const s = summarizeStats({})
    assert.equal(s.observations, 0)
    assert.deepEqual(s.typeCounts, {})
    assert.deepEqual(s.sourceCounts, { git: 0, agent: 0, manual: 0 })
    assert.deepEqual(s.retention, { active: 0, stale: 0, archive: 0, immune: 0 })
  })

  it('非对象输入不抛错', () => {
    assert.equal(summarizeStats(null).observations, 0)
  })
})

describe('response envelopes', () => {
  it('ok 包成 { ok:true, data } 且 200', () => {
    const r = ok({ a: 1 })
    assert.equal(r.status, 200)
    assert.equal(r.headers['content-type'], jsonHeaders['content-type'])
    assert.deepEqual(JSON.parse(r.body), { ok: true, data: { a: 1 } })
  })

  it('fail 带 code 与 hint', () => {
    const r = fail(503, 'down', 'control_plane_down', 'run memorix background start')
    assert.equal(r.status, 503)
    assert.deepEqual(JSON.parse(r.body), {
      ok: false,
      error: 'down',
      code: 'control_plane_down',
      hint: 'run memorix background start',
    })
  })

  it('fail 省略可选字段时不输出 null', () => {
    const r = fail(404, 'not found')
    assert.deepEqual(JSON.parse(r.body), { ok: false, error: 'not found' })
  })
})
