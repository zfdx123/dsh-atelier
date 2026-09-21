// dsh-memery — pure logic layer.
//
// 与 Cordis 运行时无关的纯逻辑：查询参数校验、搜索/筛选/分页、统计摘要、
// 响应信封。单独成模块，以便 `node --test` 直接单测（不需要控制面、不需要
// 网络、不需要 DSH 进程）。
//
// 这里是**唯一**的外部输入入口：所有来自 HTTP 的参数都必须先过
// validateQuery。这一层拒绝的参数不会打到 Memorix 上游。

export const API_BASE = '/api/dsh-memery'
export const UPSTREAM_DEFAULT = 'http://127.0.0.1:3211'

/** Memorix 的 observation type（见 docs/API_REFERENCE.md §13）。 */
export const OBSERVATION_TYPES = [
  'session-request',
  'gotcha',
  'problem-solution',
  'how-it-works',
  'what-changed',
  'discovery',
  'why-it-exists',
  'decision',
  'trade-off',
  'reasoning',
]

/** /api/stats 的 sourceCounts 键。 */
export const OBSERVATION_SOURCES = ['git', 'agent', 'manual']

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

export const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' }

// project 形如 `local/dsh-memery`、`owner/repo`。只允许保守字符集：
// 上游会把它拼进 URL query，且它决定读哪个项目的数据目录 —— 过宽的字符集
// 等于把路径穿越/SSRF 的口子开在宿主转发端点后面。
const PROJECT_RE = /^[A-Za-z0-9._/-]{1,200}$/

function toObject(raw) {
  if (raw instanceof URLSearchParams) return Object.fromEntries(raw.entries())
  if (raw !== null && typeof raw === 'object') return raw
  return {}
}

function pickString(value) {
  if (value === undefined || value === null) return ''
  return String(value).trim()
}

/**
 * 校验并归一化查询参数。
 * @param {Record<string, unknown>|URLSearchParams} raw
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
export function validateQuery(raw) {
  const src = toObject(raw)
  const value = {
    project: undefined,
    workspace: undefined,
    id: undefined,
    q: pickString(src.q),
    type: '',
    source: '',
    status: '',
    limit: DEFAULT_LIMIT,
    offset: 0,
  }

  // 面板把自己看到的工作区绝对路径带上来，宿主据此解析项目身份。
  // 这是本地路径、不是 URL：拒绝协议前缀与 ..，避免被当成任意读取或跳板。
  if (src.workspace !== undefined && pickString(src.workspace) !== '') {
    const workspace = pickString(src.workspace)
    if (workspace.length > 400 || workspace.includes('..') || /^[a-z][a-z0-9+.-]*:\/\//i.test(workspace)) {
      return { ok: false, error: 'invalid workspace: expected an absolute local path' }
    }
    value.workspace = workspace
  }

  if (src.project !== undefined && pickString(src.project) !== '') {
    const project = pickString(src.project)
    if (!PROJECT_RE.test(project) || project.includes('..')) {
      return { ok: false, error: 'invalid project: only [A-Za-z0-9._/-] allowed, max 200 chars' }
    }
    value.project = project
  }

  if (src.id !== undefined && pickString(src.id) !== '') {
    const id = Number(pickString(src.id))
    if (!Number.isInteger(id) || id <= 0) {
      return { ok: false, error: 'invalid id: must be a positive integer' }
    }
    value.id = id
  }

  if (src.type !== undefined && pickString(src.type) !== '') {
    const type = pickString(src.type)
    if (!OBSERVATION_TYPES.includes(type)) {
      return { ok: false, error: `invalid type: expected one of ${OBSERVATION_TYPES.join(', ')}` }
    }
    value.type = type
  }

  if (src.source !== undefined && pickString(src.source) !== '') {
    const source = pickString(src.source)
    if (!OBSERVATION_SOURCES.includes(source)) {
      return { ok: false, error: `invalid source: expected one of ${OBSERVATION_SOURCES.join(', ')}` }
    }
    value.source = source
  }

  if (src.status !== undefined && pickString(src.status) !== '') {
    const status = pickString(src.status)
    if (!['active', 'resolved', 'archived', 'all'].includes(status)) {
      return { ok: false, error: 'invalid status: expected active|resolved|archived|all' }
    }
    value.status = status
  }

  if (src.limit !== undefined && pickString(src.limit) !== '') {
    const limit = Number(pickString(src.limit))
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return { ok: false, error: `invalid limit: must be an integer in 1..${MAX_LIMIT}` }
    }
    value.limit = limit
  }

  if (src.offset !== undefined && pickString(src.offset) !== '') {
    const offset = Number(pickString(src.offset))
    if (!Number.isInteger(offset) || offset < 0) {
      return { ok: false, error: 'invalid offset: must be a non-negative integer' }
    }
    value.offset = offset
  }

  return { ok: true, value }
}

function textOf(item) {
  return [item.title, item.narrative, item.entityName, item.summary]
    .filter((v) => typeof v === 'string')
    .join(' ')
    .toLowerCase()
}

/**
 * 本地搜索/筛选/分页。
 *
 * Memorix 的 GET /api/observations **不支持** q/type/source/分页参数（只返回
 * 当前项目的全部 active），所以过滤在宿主侧做。
 * @param {unknown} items 上游返回的观察数组
 * @param {object} query validateQuery 的 value
 * @returns {{items: object[], total: number}}
 */
export function filterObservations(items, query) {
  const list = Array.isArray(items) ? items.filter((o) => o !== null && typeof o === 'object') : []
  const q = (query?.q ?? '').toLowerCase()

  const filtered = list.filter((item) => {
    if (query?.type && item.type !== query.type) return false
    if (query?.source && item.source !== query.source) return false
    if (q && !textOf(item).includes(q)) return false
    return true
  })

  // 新的在前；id 非数字的排在最后。
  const sorted = filtered.slice().sort((a, b) => {
    const ai = Number.isFinite(Number(a.id)) ? Number(a.id) : -1
    const bi = Number.isFinite(Number(b.id)) ? Number(b.id) : -1
    return bi - ai
  })

  const offset = query?.offset ?? 0
  const limit = query?.limit ?? DEFAULT_LIMIT
  return { items: sorted.slice(offset, offset + limit), total: sorted.length }
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/**
 * 把 /api/stats 的原始响应裁成面板需要的字段，并对缺字段给安全默认值。
 * @param {unknown} stats
 */
export function summarizeStats(stats) {
  const s = plainObject(stats)
  const typeCounts = plainObject(s.typeCounts)
  const rawSources = plainObject(s.sourceCounts)
  const retention = plainObject(s.retentionSummary)

  const sourceCounts = {}
  for (const key of OBSERVATION_SOURCES) {
    sourceCounts[key] = Number.isFinite(Number(rawSources[key])) ? Number(rawSources[key]) : 0
  }

  return {
    observations: Number.isFinite(Number(s.observations)) ? Number(s.observations) : 0,
    typeCounts,
    sourceCounts,
    retention: {
      active: Number.isFinite(Number(retention.active)) ? Number(retention.active) : 0,
      stale: Number.isFinite(Number(retention.stale)) ? Number(retention.stale) : 0,
      archive: Number.isFinite(Number(retention.archive)) ? Number(retention.archive) : 0,
      immune: Number.isFinite(Number(retention.immune)) ? Number(retention.immune) : 0,
    },
    searchMode: typeof s.searchMode === 'string' ? s.searchMode : '',
    embedding: plainObject(s.embedding),
  }
}

/** 成功信封。body 是字符串，供 connection.fetch 载体构造 Response。 */
export function ok(data) {
  return { status: 200, headers: jsonHeaders, body: JSON.stringify({ ok: true, data }) }
}

/** 失败信封。省略的可选字段不出现在 body 里（而不是 null）。 */
export function fail(status, error, code, hint) {
  const payload = { ok: false, error }
  if (code !== undefined && code !== null && code !== '') payload.code = code
  if (hint !== undefined && hint !== null && hint !== '') payload.hint = hint
  return { status, headers: jsonHeaders, body: JSON.stringify(payload) }
}
