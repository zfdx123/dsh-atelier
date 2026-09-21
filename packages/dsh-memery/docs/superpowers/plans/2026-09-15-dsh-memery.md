# dsh-memery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 DSH 通过 MCP 使用 Memorix 记忆，并在 DSH 侧栏提供一个原生「记忆」面板用于查看、检索、软隐藏与删除记忆。

**Architecture:** Memorix control plane 常驻 `http://127.0.0.1:3211`（SQLite 主库 + Dashboard + `/api/*`）。模型侧经 `dsh-mcp-manager` 以 `streamable-http` 热挂载 `memorix` MCP 服务器。人类侧是一个新的 DSH 插件 `dsh-memery`：宿主半（`index.js` + `lib/*`）注册 `/api/dsh-memery/*` 转发端点，服务端→服务端调用 3211；客户端半（`client.js`）注册 `sidebar.footer.action` 侧栏面板与 `settings.section` 设置分区。浏览器只与 DSH 同源通信，因此不涉及 CORS，也复用宿主的 Host/Origin 信任栅栏与浏览器鉴权。

**Tech Stack:** Node.js ESM、`node:test`、Cordis 4（`ctx.effect` / `ctx.get` / `ctx.slots`）、React（`react` + `react/jsx-runtime`，由宿主模块加载器提供）、Memorix 1.9.3 CLI + HTTP API。

**Spec:** `docs/superpowers/specs/2026-09-15-dsh-memorix-memory-panel-design.md`

## Global Constraints

- Node `>=22`；本机实测 v24.19.0。
- DSH `0.1.5-rc.1`；活动 profile 为 `web`（`C:\Users\29154\.dsh\profiles\web`）。
- 插件包名、`cordis.patch.yml` 的 bundle `name`、`client.js` 里 `__ModuleLoader__.load({ id })` **三处必须完全一致**，否则宿主校验失败、面板永不出现。
- 客户端半 `require` 只允许 `react` 与 `react/jsx-runtime`（宿主模块加载器提供）。
- 记忆**写入**只走模型侧 MCP 工具；本插件不提供写入端点。
- 上游基址固定为 `http://127.0.0.1:3211`，**不接受客户端传入任意 URL**（避免成为 SSRF 跳板）。
- `project` 查询参数只允许 `[A-Za-z0-9._/-]`，长度 ≤ 200。
- 维护类 `execute` 端点不在面板暴露，只展示 `preview`。
- 所有端点响应体统一 `{ ok: true, data }` / `{ ok: false, error, code?, hint? }`。
- 删除必须能区分「软隐藏（resolve，走 CLI）」与「真删（DELETE）」。

---

### Task 1: 项目骨架与打包清单

**Files:**
- Create: `package.json`
- Create: `cordis.patch.yml`
- Create: `README.md`
- Create: `.gitignore` (already created in this session)
- Test: `test/pack.test.js`

**Interfaces:**
- Consumes: nothing
- Produces: 包名 `dsh-memery`；`dsh.bundle.patch` 指向 `./cordis.patch.yml`；`dsh.client` = `{ platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-settings'] }`；入口 `./index.js`

- [ ] **Step 1: Write the failing test**

```js
// test/pack.test.js — 打包契约：三处 id 必须一致，manifest 必须完整
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const PKG = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

describe('package manifest', () => {
  it('声明 dsh.bundle.patch 与 dsh.client', () => {
    assert.equal(PKG.name, 'dsh-memery')
    assert.equal(PKG.dsh?.bundle?.patch, './cordis.patch.yml')
    assert.equal(PKG.dsh?.client?.platform, 'web')
    assert.deepEqual(PKG.dsh?.client?.inject, [
      '@deepseek-ai/dsh-client-ui-sidebar',
      '@deepseek-ai/dsh-client-ui-settings',
    ])
  })

  it('cordis.patch.yml 的行 name 等于包名', async () => {
    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    assert.match(patch, /name:\s*dsh-memery/)
  })

  it('client.js 的 __ModuleLoader__ id 等于包名', async () => {
    const client = await readFile(new URL('../client.js', import.meta.url), 'utf8')
    assert.match(client, new RegExp(`id:\\s*'${PKG.name}'`))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pack.test.js`
Expected: FAIL — `Cannot find module ... package.json` 或 `client.js` 不存在。

- [ ] **Step 3: Write minimal implementation**

`package.json`:
```json
{
  "name": "dsh-memery",
  "version": "0.1.0",
  "description": "DSH 接入 Memorix：原生「记忆」侧栏面板 + 宿主转发端点",
  "type": "module",
  "main": "./index.js",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./package.json": "./package.json"
  },
  "files": [
    "index.js",
    "client.js",
    "lib/",
    "cordis.patch.yml",
    "README.md",
    "LICENSE"
  ],
  "engines": { "node": ">=22" },
  "license": "MIT",
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-ui-sidebar",
        "@deepseek-ai/dsh-client-ui-settings"
      ]
    }
  },
  "scripts": { "test": "node --test" }
}
```

`cordis.patch.yml`:
```yaml
- insert:
    - id: dsh-memery
      name: dsh-memery
```

`client.js`（本步只需满足契约，面板在 Task 6 实现）:
```js
window.__ModuleLoader__.load({
  id: 'dsh-memery',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    function apply() {}
    exports.inject = []
    exports.apply = apply
    return module.exports
  },
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/pack.test.js`
Expected: PASS（3 项）。

- [ ] **Step 5: Commit**

```bash
git add package.json cordis.patch.yml client.js test/pack.test.js
git commit -m "feat: dsh-memery 项目骨架与打包契约"
```

---

### Task 2: 纯逻辑层 `lib/logic.js`

**Files:**
- Create: `lib/logic.js`
- Test: `test/logic.test.js`

**Interfaces:**
- Consumes: nothing (pure)
- Produces:
  - `const API_BASE = '/api/dsh-memery'`
  - `const UPSTREAM_DEFAULT = 'http://127.0.0.1:3211'`
  - `OBSERVATION_TYPES: string[]`
  - `OBSERVATION_SOURCES = ['git', 'agent', 'manual']`
  - `validateQuery(raw: Record<string,string|undefined>): { ok: true, value: Query } | { ok: false, error: string }`，`Query = { project?: string, id?: number, q: string, type: string, source: string, status: string, limit: number, offset: number }`
  - `filterObservations(items: object[], query: Query): { items: object[], total: number }`
  - `summarizeStats(stats: object): { observations: number, typeCounts: object, sourceCounts: object, retention: object }`
  - `ok(data): { status: 200, headers, body }`
  - `fail(status: number, error: string, code?: string, hint?: string): { status, headers, body }`
  - `jsonHeaders: Record<string,string>`

- [ ] **Step 1: Write the failing test**

```js
// test/logic.test.js — 纯逻辑：参数校验、搜索/筛选/分页、统计摘要
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateQuery, filterObservations, summarizeStats, ok, fail,
} from '../lib/logic.js'

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
  })

  it('拒绝非数字 id', () => {
    const r = validateQuery({ id: 'abc' })
    assert.equal(r.ok, false)
    assert.match(r.error, /id/)
  })

  it('拒绝非法 project 字符（防 SSRF/注入）', () => {
    assert.equal(validateQuery({ project: 'a/../../etc' }).ok, false)
    assert.equal(validateQuery({ project: 'http://evil/x' }).ok, false)
    assert.equal(validateQuery({ project: 'local/dsh-memery' }).ok, true)
  })

  it('拒绝超界 limit', () => {
    assert.equal(validateQuery({ limit: '0' }).ok, false)
    assert.equal(validateQuery({ limit: '501' }).ok, false)
    assert.equal(validateQuery({ limit: '200' }).ok, true)
  })

  it('拒绝非法 type', () => {
    assert.equal(validateQuery({ type: 'nope' }).ok, false)
    assert.equal(validateQuery({ type: 'decision' }).ok, true)
  })
})

describe('filterObservations', () => {
  it('按关键词搜标题与叙述（大小写不敏感）', () => {
    const { items, total } = filterObservations(OBS, validateQuery({ q: 'SQLITE' }).value)
    assert.equal(total, 2)
    assert.deepEqual(items.map((o) => o.id), [2, 1])
  })

  it('按 type 过滤', () => {
    const { total } = filterObservations(OBS, validateQuery({ type: 'decision' }).value)
    assert.equal(total, 2)
  })

  it('按 source 过滤', () => {
    const { items } = filterObservations(OBS, validateQuery({ source: 'git' }).value)
    assert.deepEqual(items.map((o) => o.id), [2])
  })

  it('分页返回 total 为过滤后总数', () => {
    const { items, total } = filterObservations(OBS, validateQuery({ limit: '1', offset: '1' }).value)
    assert.equal(total, 3)
    assert.equal(items.length, 1)
    assert.equal(items[0].id, 2)
  })

  it('非数组输入返回空而不是抛错', () => {
    const { items, total } = filterObservations(null, validateQuery({}).value)
    assert.deepEqual(items, [])
    assert.equal(total, 0)
  })
})

describe('summarizeStats', () => {
  it('抽出面板需要的字段', () => {
    const s = summarizeStats({
      observations: 7, typeCounts: { decision: 3 }, sourceCounts: { git: 1, agent: 2, manual: 4 },
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
  })
})

describe('response envelopes', () => {
  it('ok 包成 { ok:true, data } 且 200', () => {
    const r = ok({ a: 1 })
    assert.equal(r.status, 200)
    assert.deepEqual(JSON.parse(r.body), { ok: true, data: { a: 1 } })
  })

  it('fail 带 code 与 hint', () => {
    const r = fail(503, 'down', 'control_plane_down', 'run memorix background start')
    assert.equal(r.status, 503)
    assert.deepEqual(JSON.parse(r.body), {
      ok: false, error: 'down', code: 'control_plane_down', hint: 'run memorix background start',
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/logic.test.js`
Expected: FAIL — `Cannot find module '../lib/logic.js'`。

- [ ] **Step 3: Write minimal implementation**

`lib/logic.js` —— 实现上述导出。要点：
- `validateQuery` 是唯一入口，所有外部输入先过它；`project` 用 `/^[A-Za-z0-9._/-]{1,200}$/` 且不含 `..`。
- `filterObservations` 对 `title`/`narrative`/`entityName` 做 `toLowerCase().includes(q)`；排序按 `id` 降序（新的在前）；`total` 是过滤后总数，分页只切 `items`。
- `summarizeStats` 只取 `observations`、`typeCounts`、`sourceCounts`、`retentionSummary`，缺省给 `0`/`{}`。
- `ok`/`fail` 返回 `{ status, headers: jsonHeaders, body: JSON.stringify(...) }`；`body` 必须是字符串（`connection.fetch` 载体要用它构造 `Response`）。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/logic.test.js`
Expected: PASS（全部）。

- [ ] **Step 5: Commit**

```bash
git add lib/logic.js test/logic.test.js
git commit -m "feat: lib/logic 纯逻辑层（校验/筛选/分页/信封）"
```

---

### Task 3: 上游客户端 `lib/upstream.js`

**Files:**
- Create: `lib/upstream.js`
- Test: `test/upstream.test.js`

**Interfaces:**
- Consumes: `UPSTREAM_DEFAULT` from `lib/logic.js`
- Produces: `createUpstream({ baseUrl = UPSTREAM_DEFAULT, timeoutMs = 10000, runCli = defaultRunCli, logger } = {})` 返回
  - `async health(): { up: boolean, raw?: object, error?: string }`
  - `async getStats(project?): object`
  - `async getProjects(): object[]`
  - `async listObservations(project?): object[]`
  - `async getSessions(project?): object[]`
  - `async deleteObservation(id: number, project?): object`
  - `async resolveViaCli({ id, project, status, workspaceRoot }): { ok: boolean, stdout?: string, error?: string }`
  - `async resolveProjectId(workspaceRoot): string | undefined`
  - 所有网络方法失败时抛 `UpstreamError`（带 `.status`、`.code`、`.hint`）

- [ ] **Step 1: Write the failing test**

```js
// test/upstream.test.js — 用真实 node:http 假 memorix 验证 fetch 路径与错误映射
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createUpstream, UpstreamError } from '../lib/upstream.js'

let server, base, hits = []

before(async () => {
  server = createServer((req, res) => {
    hits.push(req.method + ' ' + req.url)
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/health') return res.writeHead(200, {'content-type':'application/json'}).end('{"status":"ok"}')
    if (u.pathname === '/api/stats') return res.writeHead(200, {'content-type':'application/json'}).end('{"observations":2}')
    if (u.pathname === '/api/observations') return res.writeHead(200, {'content-type':'application/json'}).end('[{"id":1},{"id":2}]')
    if (u.pathname === '/api/projects') return res.writeHead(200, {'content-type':'application/json'}).end('[]')
    if (u.pathname === '/api/observations/9' && req.method === 'DELETE')
      return res.writeHead(200, {'content-type':'application/json'}).end('{"ok":true,"deleted":9}')
    if (u.pathname === '/api/observations/7') return res.writeHead(403, {'content-type':'application/json'}).end('{"error":"belongs to other project"}')
    if (u.pathname === '/api/notjson') return res.writeHead(200, {'content-type':'text/html'}).end('<html>nope</html>')
    res.writeHead(404, {'content-type':'application/json'}).end('{"error":"nf"}')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())

describe('upstream', () => {
  it('health 返回 up', async () => {
    const r = await createUpstream({ baseUrl: base }).health()
    assert.equal(r.up, true)
  })

  it('getStats / listObservations 解析 JSON', async () => {
    const up = createUpstream({ baseUrl: base })
    assert.deepEqual(await up.getStats(), { observations: 2 })
    assert.equal((await up.listObservations()).length, 2)
  })

  it('project 参数进入 query，且被正确编码', async () => {
    hits = []
    await createUpstream({ baseUrl: base }).listObservations('local/dsh-memery')
    assert.ok(hits.includes('GET /api/observations?project=local%2Fdsh-memery'), hits.join(','))
  })

  it('DELETE 成功路径', async () => {
    const r = await createUpstream({ baseUrl: base }).deleteObservation(9, 'local/x')
    assert.equal(r.deleted, 9)
  })

  it('上游 403 映射为 UpstreamError 且带 status 与上游原文', async () => {
    await assert.rejects(
      () => createUpstream({ baseUrl: base }).deleteObservation(7),
      (e) => e instanceof UpstreamError && e.status === 403 && /other project/.test(e.message),
    )
  })

  it('非 JSON 响应映射为 bad_upstream', async () => {
    const up = createUpstream({ baseUrl: base })
    await assert.rejects(() => up.getJson('/api/notjson'), (e) => e.code === 'bad_upstream')
  })

  it('控制面不可达 → control_plane_down', async () => {
    const up = createUpstream({ baseUrl: 'http://127.0.0.1:1' })
    await assert.rejects(() => up.getStats(), (e) => e.code === 'control_plane_down')
  })

  it('resolveViaCli 用注入的 runner，不真跑 CLI', async () => {
    const calls = []
    const up = createUpstream({ baseUrl: base, runCli: async (args) => { calls.push(args); return { code: 0, stdout: '{"ok":true}' } } })
    const r = await up.resolveViaCli({ id: 5, status: 'resolved', workspaceRoot: 'E:/w' })
    assert.equal(r.ok, true)
    assert.deepEqual(calls[0].slice(0, 4), ['memory', 'resolve', '--ids', '5'])
    assert.ok(calls[0].includes('--cwd'))
  })

  it('resolveViaCli 非零退出如实返回失败', async () => {
    const up = createUpstream({ baseUrl: base, runCli: async () => ({ code: 1, stdout: '', stderr: 'no such command' }) })
    const r = await up.resolveViaCli({ id: 5 })
    assert.equal(r.ok, false)
    assert.match(r.error, /no such command/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/upstream.test.js`
Expected: FAIL — `Cannot find module '../lib/upstream.js'`。

- [ ] **Step 3: Write minimal implementation**

`lib/upstream.js` —— 要点：
- `UpstreamError extends Error`，带 `status`、`code`、`hint`。
- `fetch` 用 `AbortSignal.timeout(timeoutMs)`；捕获 `TypeError`/`AbortError` → `code:'control_plane_down'`，`hint: 'run: memorix background start'`。
- 非 2xx：读 body 尝试 `JSON.parse` 取 `.error`，否则截断原文；`code:'upstream_error'`。
- 非 JSON 但 2xx：`code:'bad_upstream'`（截断前 200 字符进 message）。
- `deleteObservation` 用 `DELETE` + `?project=`。
- `defaultRunCli` 用 `node:child_process` 的 `execFile('memorix', args, { shell: process.platform === 'win32' })`（Windows 上 `memorix` 是 `.ps1`/`.cmd`，需要 shell）——**只在 `resolveViaCli` 使用**；测试全部走注入 runner，不依赖真 CLI。
- `resolveProjectId(workspaceRoot)`：跑 `['memory','recent','--limit','1','--json','--cwd',workspaceRoot]`，解析 `JSON.parse(stdout).project.id`；失败返回 `undefined`（不抛）。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/upstream.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/upstream.js test/upstream.test.js
git commit -m "feat: lib/upstream 控制面客户端（超时/错误映射/CLI 兜底）"
```

---

### Task 4: 端点处理 `lib/endpoints.js`

**Files:**
- Create: `lib/endpoints.js`
- Test: `test/endpoints.test.js`

**Interfaces:**
- Consumes: `lib/logic.js`, `lib/upstream.js`
- Produces: `createApiHandler({ upstream, resolveProject, workspaceRoot })` → `async ({ method, readBody, query }) => { status, headers, body }`
  - `query`: `URLSearchParams` 或 plain object（测试友好）
  - 路由表：
    | method | path | 行为 |
    |---|---|---|
    | GET | `/health` | `{ up, project, workspaceRoot }` |
    | GET | `/stats` | `summarizeStats(await upstream.getStats(project))` |
    | GET | `/observations` | `filterObservations(await upstream.listObservations(project), q)` |
    | GET | `/sessions` | 透传 |
    | GET | `/projects` | 透传 |
    | POST | `/resolve` | body `{ id, status? }` → `upstream.resolveViaCli` |
    | DELETE | `/observations/:id` | `upstream.deleteObservation` |

- [ ] **Step 1: Write the failing test**

```js
// test/endpoints.test.js — 端点层：路由、参数校验、错误映射（上游全部注入）
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
    getStats: async () => ({ observations: 2, typeCounts: { gotcha: 1 }, sourceCounts: {}, retentionSummary: { active: 2 } }),
    getProjects: async () => [{ id: 'local/dsh-memery' }],
    listObservations: async () => OBS,
    getSessions: async () => [{ sessionId: 's1' }],
    deleteObservation: async (id) => ({ ok: true, deleted: id }),
    resolveViaCli: async () => ({ ok: true, stdout: '{}' }),
    ...over,
  }
}

const call = (handler, method, path, { query = {}, body = '' } = {}) =>
  handler({ method, path, query, readBody: async () => body })

const mk = (over, opts = {}) => createApiHandler({
  upstream: fakeUpstream(over), resolveProject: async () => 'local/dsh-memery', workspaceRoot: 'E:/work/ai/dsh-memery', ...opts,
})

describe('routing', () => {
  it('GET /health 返回 ok:true', async () => {
    const r = await call(mk(), 'GET', '/health')
    assert.equal(r.status, 200)
    const b = JSON.parse(r.body)
    assert.equal(b.ok, true)
    assert.equal(b.data.up, true)
  })

  it('GET /stats 走 summarizeStats', async () => {
    const b = JSON.parse((await call(mk(), 'GET', '/stats')).body)
    assert.equal(b.data.observations, 2)
    assert.deepEqual(b.data.retention, { active: 2 })
  })

  it('GET /observations 支持 q 过滤且 project 透传', async () => {
    const seen = []
    const h = mk({ listObservations: async (p) => { seen.push(p); return OBS } })
    const b = JSON.parse((await call(h, 'GET', '/observations', { query: { q: 'sqlite' } })).body)
    assert.equal(b.data.total, 1)
    assert.deepEqual(seen, ['local/dsh-memery'])
  })

  it('未知路径 404', async () => {
    const r = await call(mk(), 'GET', '/nope')
    assert.equal(r.status, 404)
    assert.equal(JSON.parse(r.body).code, 'not_found')
  })

  it('方法不匹配 405', async () => {
    const r = await call(mk(), 'POST', '/stats')
    assert.equal(r.status, 405)
  })
})

describe('validation', () => {
  it('非法查询参数 400 且不打上游', async () => {
    let called = false
    const h = mk({ listObservations: async () => { called = true; return OBS } })
    const r = await call(h, 'GET', '/observations', { query: { limit: '9999' } })
    assert.equal(r.status, 400)
    assert.equal(called, false)
  })

  it('DELETE 非数字 id 400', async () => {
    const r = await call(mk(), 'DELETE', '/observations/abc')
    assert.equal(r.status, 400)
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
    const h = mk({ deleteObservation: async () => { throw new UpstreamError('belongs to other project', { status: 403, code: 'upstream_error' }) } })
    const r = await call(h, 'DELETE', '/observations/7')
    assert.equal(r.status, 403)
    assert.match(JSON.parse(r.body).error, /other project/)
  })

  it('控制面不可达 → 503 + control_plane_down', async () => {
    const h = mk({ getStats: async () => { throw new UpstreamError('fetch failed', { code: 'control_plane_down', hint: 'run: memorix background start' }) } })
    const r = await call(h, 'GET', '/stats')
    assert.equal(r.status, 503)
    assert.equal(JSON.parse(r.body).code, 'control_plane_down')
  })

  it('未预期异常 → 500 且不泄漏堆栈', async () => {
    const h = mk({ getStats: async () => { throw new Error('boom at secret path /x/y') } })
    const r = await call(h, 'GET', '/stats')
    assert.equal(r.status, 500)
    assert.equal(JSON.parse(r.body).error, 'internal error')
  })

  it('POST /resolve CLI 失败 → 502 且 hint 指向 Dashboard', async () => {
    const h = mk({ resolveViaCli: async () => ({ ok: false, error: 'no such command' }) })
    const r = await call(h, 'POST', '/resolve', { body: '{"id":5}' })
    assert.equal(r.status, 502)
    const b = JSON.parse(r.body)
    assert.match(b.error, /no such command/)
    assert.ok(b.hint)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/endpoints.test.js`
Expected: FAIL — `Cannot find module '../lib/endpoints.js'`。

- [ ] **Step 3: Write minimal implementation**

`lib/endpoints.js` —— 要点：
- 规范化 `query`：`URLSearchParams` → `Object.fromEntries`，plain object 直接用。
- 路由匹配用精确字符串 + 一个 `^/observations/(\d+)$` 正则；**先**校验参数（`validateQuery`），**后**打上游。
- `/resolve` 的 body 解析包在 try/catch 里 → 400。
- 错误映射：`UpstreamError` 用其 `status`（默认 502）；`code === 'control_plane_down'` → 503；其它异常统一 `fail(500, 'internal error')`，**不把堆栈或路径放进响应**。
- `/resolve` 的 `id` 从 body 取，必须是正整数。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/endpoints.test.js`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/endpoints.js test/endpoints.test.js
git commit -m "feat: lib/endpoints 端点层（路由/校验/错误映射）"
```

---

### Task 5: 宿主入口 `index.js`

**Files:**
- Create: `index.js`
- Test: 复用 Task 4 的测试（端点层已覆盖）；本任务由 Task 9 端到端验证

**Interfaces:**
- Consumes: `lib/endpoints.js`、`lib/upstream.js`
- Produces: `export const name = 'dsh-memery'`、`export const inject = []`、`export function apply(ctx)`

- [ ] **Step 1: 写实现（本任务无可注入的纯逻辑，故 TDD 落在 Task 2–4；此处按既有模式接线）**

`index.js` —— 要点：
1. 解析基址与超时：`ctx.get('settings')` 可用时读 `dsh-memery` 命名空间（若未注册则退回默认常量）。**不要**注册新 settings 命名空间，避免与将来冲突；v1 用环境变量 `DSH_MEMERY_BASE_URL` / `DSH_MEMERY_TIMEOUT_MS` 覆盖，默认 `http://127.0.0.1:3211` / `10000`。
2. 解析 workspaceRoot：优先 `ctx.get('workspaceRegistry')?.list()?.[0]?.path`，其次 `process.cwd()`。
3. `resolveProject()`：进程内缓存，首次调用 `upstream.resolveProjectId(workspaceRoot)`；失败返回 `undefined`（端点层会退化为「不传 project」）。
4. `registerHttpApi(ctx, api)`：**照抄 `dsh-mcp-manager` 的双载体模式**——
   - 首选 `ctx.get('connection')` 的 `connection.fetch.register({ path: API_BASE + '/*', methods: ['GET','POST','DELETE'], requestBody: 'buffered', fetch })`。

     > 注意：`connection.fetch.register` 是**精确**路径路由。`/api/dsh-memery/*` 需要逐条注册具体路径（`/stats`、`/observations`、`/sessions`、`/projects`、`/resolve`、`/health`）或确认是否存在 prefix 形式。**实现时先实测**：注册一条 `/api/dsh-memery/stats` 并请求验证；若精确路由无法覆盖 `/observations/:id`，则改为在客户端把所有请求走单一 POST 网关端点 `POST /api/dsh-memery/api`（body 带 `{ op, args }`），从而只需注册一条精确路径。二选一以实测为准，并在 README 记录结论。
   - 退化：`ctx.get('webServer')` 的 `webServer.register({ kind:'exact', path, handler })`，并自行施加 `connection.requestRejection(req)`，拿不到则只允许回环来源。
   - 每条注册都用 `ctx.effect(fn, 'dsh-memery: <label>')` 包裹，保证插件卸载时清理。
5. 日志：通过 `ctx.get('logger')`（若可用）记录基址、解析到的 project、注册载体；不可用则静默。

- [ ] **Step 2: 语法与装配自检**

Run: `node --input-type=module -e "await import('./index.js').then(m=>console.log(m.name, typeof m.apply))"`
Expected: 输出 `dsh-memery function`。

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat: 宿主入口，双载体注册 /api/dsh-memery"
```

---

### Task 6: 客户端面板 `client.js`

**Files:**
- Create: `client.js`（替换 Task 1 的桩）
- Test: `test/client-logic.test.js`

**Interfaces:**
- Consumes: `require('react')`、`require('react/jsx-runtime')`；HTTP `GET/POST/DELETE /api/dsh-memery/*`
- Produces: `__ModuleLoader__.load({ id: 'dsh-memery', factory })`；`exports.inject = ['slots']`；注册 `sidebar.footer.action`（id `dsh-memory`，order 30，label `记忆`）与 `settings.section`（id `dsh-memory`，order 25，label `记忆`）

- [ ] **Step 1: Write the failing test**

```js
// test/client-logic.test.js — 在 vm 沙箱里加载 client.js，断言注册契约与纯函数契约
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

async function loadClient() {
  const src = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const registered = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => registered.push(def) } },
    console, setTimeout, clearTimeout, fetch: async () => { throw new Error('no network in test') },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  new vm.Script(src).runInContext(sandbox)
  const def = registered[0]
  const required = []
  const mod = def.factory((name) => {
    required.push(name)
    if (name === 'react') return { createElement: () => null, useState: () => [null, () => {}], useEffect: () => {}, useCallback: (f) => f, useRef: () => ({ current: null }) }
    if (name === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }
    throw new Error('unexpected require: ' + name)
  })
  return { def, mod, required }
}

describe('client bundle contract', () => {
  it('注册 id 必须是包名', async () => {
    const { def } = await loadClient()
    assert.equal(def.id, 'dsh-memery')
  })

  it('只 require react 与 react/jsx-runtime', async () => {
    const { required } = await loadClient()
    for (const n of required) assert.ok(['react', 'react/jsx-runtime'].includes(n), n)
  })

  it('声明 inject slots 并在两个插槽注册', async () => {
    const { mod } = await loadClient()
    assert.deepEqual(mod.inject, ['slots'])
    const regs = []
    const ctx = { slots: { inject: (name, fn) => { regs.push(name); fn() }, register: (def) => { regs.push(def.name + ':' + def.id); return () => {} } } }
    mod.apply(ctx)
    assert.ok(regs.includes('sidebar.footer.action'))
    assert.ok(regs.includes('settings.section'))
    assert.ok(regs.some((r) => r.startsWith('sidebar.footer.action:dsh-memory')), regs.join(','))
  })

  it('面板纯函数：格式化与筛选可独立测试', async () => {
    const { mod } = await loadClient()
    assert.equal(typeof mod.__test__.formatCount, 'function')
    assert.equal(mod.__test__.formatCount(0), '0')
    assert.equal(mod.__test__.formatCount(1234), '1,234')
  })
})
```

> `mod.__test__` 是**仅用于测试**的纯函数出口，不注册任何运行时行为。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/client-logic.test.js`
Expected: FAIL — 桩没有 `__test__`，且 `inject` 为空数组。

- [ ] **Step 3: 实现面板**

`client.js` 结构（照 `dsh-lovelyaudit` 的写法）：
- `window.__ModuleLoader__.load({ id: 'dsh-memery', factory: (require) => { ... } })`
- `const React = require('react')`、`const jsx = require('react/jsx-runtime')`
- 一段 scoped CSS 注入（选择器全部挂在 `.dsh-memory` 容器下，用 `<style id="dsh-memery-style">`，随 fiber 卸载移除），颜色走外壳令牌 `--dsw-alias-*`，并对暗色主题补 `color-scheme`。
- 组件：
  - `MemorySidebar`：折叠按钮 + 展开浮层（照 `AuditSidebar` 的 `open`/`anchor` 形态）。内容：概览统计条、搜索框、type/source 下拉筛选、记忆列表、详情区、操作按钮（软隐藏 / 删除-二次确认）、「打开 Dashboard」链接。
  - `MemorySettings`：控制面地址、探活状态、workspaceRoot、当前解析到的 project、刷新按钮。
- 数据获取：`fetch('/api/dsh-memery/stats')` 等；控制面不可用时显示「控制面未运行」+ 启动提示（读 `hint`）。
- `exports.__test__ = { formatCount, matchesFilter, humanAge, deleteConfirmLabel }`（纯函数，供 vm 测试）。
- `exports.inject = ['slots']`；`apply(ctx)` 里两处 `ctx.slots.inject(...)`。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/client-logic.test.js`
Expected: PASS。

- [ ] **Step 5: 全量测试 + 提交**

Run: `npm test`
Expected: 全部 PASS。
```bash
git add client.js test/client-logic.test.js
git commit -m "feat: 客户端侧栏「记忆」面板与设置分区"
```

---

### Task 7: 接入（MCP 服务器 + 安装插件）

**Files:**
- Modify: `C:\Users\29154\.dsh\settings.yaml`（备份后改）
- Modify: `C:\Users\29154\.dsh\profiles\web`（`dsh plugin add`）

**Interfaces:**
- Consumes: Task 1–6 的产物
- Produces: `mcp__memorix__*` 工具；DSH 侧栏出现「记忆」

- [ ] **Step 1: 备份 settings.yaml**

```powershell
Copy-Item $env:USERPROFILE\.dsh\settings.yaml "$env:USERPROFILE\.dsh\settings.yaml.bak-dsh-memery" -Force
```
Expected: 备份文件存在。

- [ ] **Step 2: 安装插件到 profile**

```powershell
dsh plugin --profile web add E:\work\ai\dsh-memery
```
Expected: `profiles/web/package.json` 的 `dependencies` 出现 `dsh-memery`，`dsh.profile.bundles` 追加 `dsh-memery`。

- [ ] **Step 3: 校验组合树**

```powershell
dsh --profile web --dump-config
```
Expected: 输出里能看到 `dsh-memery` 行。若报「row 未激活」或「published process-global service」，按 `editing-cordis-compositions` 的排查表处理（本插件不该 publish 任何 service；若确实 publish，需包 isolate realm）。

- [ ] **Step 4: 加 memorix MCP 服务器**

在 `settings.yaml` 的 `mcp.servers` 列表追加（**用 YAML 解析器改，不用正则**）：
```yaml
- serverName: memorix
  enabled: true
  transport: streamable-http
  command: ""
  args: []
  env: {}
  cwd: ""
  url: http://127.0.0.1:3211/mcp
  headers: {}
  toolCallTimeoutMs: 60000
  failOnStartupError: false
  tlsInsecure: false
  tlsCaFile: ""
  reconnectEnabled: true
  reconnectMaxAttempts: 10
```

- [ ] **Step 5: 重启 dsh 进程并验证**

> 由用户执行（我无法重启承载自己的进程）。重启后：
> - 设置 → MCP 服务器 应看到 `memorix` 且状态 ok
> - 我的工具列表应出现 `mcp__memorix__*`
> - 侧栏底部出现「记忆」

- [ ] **Step 6: Commit（本仓库内的示例片段）**

```bash
git add examples/settings.memorix.yaml README.md
git commit -m "docs: memorix MCP 服务器配置示例与接入说明"
```

---

### Task 8: `resolve` 软隐藏闭环

**Files:**
- Modify: `lib/upstream.js`（`resolveViaCli` 已在 Task 3 实现；此处做真机验证）
- Modify: `client.js`（软隐藏按钮）

**Interfaces:**
- Consumes: `POST /api/dsh-memery/resolve`
- Produces: 软隐藏后该条从列表消失（`/api/observations` 只返回 active）

- [ ] **Step 1: 真机验证 CLI 子命令与参数**

```powershell
memorix memory store --text "dsh-memery 冒烟测试记忆" --title "smoke" --cwd E:\work\ai\dsh-memery --json
memorix memory recent --limit 3 --cwd E:\work\ai\dsh-memery --json
```
Expected: 返回新观察的 `id`；`recent` 能看到它。

- [ ] **Step 2: 验证 resolve 真的把它移出 active**

```powershell
memorix memory resolve --ids <上一步的 id> --status resolved --cwd E:\work\ai\dsh-memery --json
Invoke-WebRequest 'http://127.0.0.1:3211/api/observations?project=local/dsh-memery' -UseBasicParsing | Select-Object -Expand Content
```
Expected: 该条不再出现在 `/api/observations`（该端点只返回 active）。

- [ ] **Step 3: 若子命令或参数与假设不符**

停下来，把真实用法写进 `lib/upstream.js` 与 README，并在面板上把该按钮的 `hint` 改成实测命令。**不得静默降级成「看起来成功」**。

- [ ] **Step 4: Commit**

```bash
git add lib/upstream.js client.js README.md
git commit -m "feat: 软隐藏闭环（resolve via CLI）"
```

---

### Task 9: 端到端验证

**Files:**
- Create: `test/e2e.md`（手工验证记录）

- [ ] **Step 1: 控制面探活**

```powershell
Invoke-WebRequest 'http://127.0.0.1:3211/health' -UseBasicParsing | Select-Object -Expand Content
```
Expected: `{"status":"ok",...}`。

- [ ] **Step 2: 面板取到真实数据**

重启 dsh 后打开侧栏「记忆」：概览数字应与 `http://127.0.0.1:3211/api/stats?project=local/dsh-memery` 一致。

- [ ] **Step 3: 控制面停机时面板不空转**

```powershell
memorix background stop
```
Expected: 面板显示「控制面未运行」与启动提示，而不是空列表或报错堆栈。恢复：`memorix background start`。

- [ ] **Step 4: 记录结果并提交**

把三项的实际输出贴进 `test/e2e.md`。
```bash
git add test/e2e.md
git commit -m "test: 端到端验证记录"
```

---

## Self-Review

**Spec coverage:**
- §2 现状事实 → Global Constraints + Task 7
- §3 架构（宿主转发、HTTP 常驻）→ Task 4/5 + Task 7 Step 4
- §4.1 MCP 接入 → Task 7 Step 4
- §4.2 插件文件清单 → Task 1/2/3/4/5/6
- §4.3 面板功能 → Task 6（列表/搜索/筛选/详情/软隐藏/真删/打开 Dashboard/服务状态）
- §4.4 维护操作只预览 → Task 6（面板不提供 execute）；**注：v1 未做 preview 展示，属有意的 YAGNI 裁剪，README 需写明**
- §5 数据流与项目作用域解析 → Task 5 Step 1 第 2–3 点
- §6 错误处理 → Task 4「error mapping」
- §7 安全（固定上游、`project` 字符集、宿主鉴权载体）→ Global Constraints + Task 2 `validateQuery` + Task 5 Step 1 第 4 点
- §8 测试策略 → Task 2/3/4/6 + Task 9
- §9 前置 Git → 已完成（`git init` + `local/dsh-memery` 实测通过）
- §10 取舍 → README

**Type consistency:** `createUpstream` 返回的方法名在 Task 3 定义、Task 4 消费、Task 6 经端点间接使用，命名一致（`getStats`/`getProjects`/`listObservations`/`getSessions`/`deleteObservation`/`resolveViaCli`/`resolveProjectId`/`health`）。端点响应对 `{ ok, data }` / `{ ok, error, code, hint }` 一致。

**未决风险（实现时必须实测，不得假设）：**
1. `connection.fetch.register` 是否支持 prefix 路径 —— Task 5 Step 1 第 4 点给出了回退方案（单 POST 网关端点）。
2. `memorix memory resolve` 的真实参数 —— Task 8 Step 1 实测。
3. `ctx.get('logger')` 是否存在 —— 不可用就静默，不阻塞。
