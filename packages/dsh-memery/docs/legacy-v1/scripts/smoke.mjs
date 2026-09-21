// scripts/smoke.mjs — 端到端冒烟：用真实 Memorix 控制面跑通宿主数据路径。
//
// 起一个本地 HTTP server，把 lib/endpoints.js 真正接上 lib/upstream.js，然后
// 逐条打真实请求。**不涉及 DSH 进程**，所以不需要重启就能验证：
//   浏览器 → DSH 宿主 → Memorix 控制面
// 这条链里除 DSH 路由注册之外的每一环。
//
// 用法：node scripts/smoke.mjs
import { createServer } from 'node:http'
import { createUpstream } from '../lib/upstream.js'
import { createApiHandler } from '../lib/endpoints.js'

const baseUrl = process.env.DSH_MEMERY_BASE_URL || 'http://127.0.0.1:3211'
const workspaceRoot = process.env.DSH_MEMERY_WORKSPACE_ROOT || process.cwd()

const upstream = createUpstream({ baseUrl })
const projectId = await upstream.resolveProjectId(workspaceRoot)
console.log(`控制面 : ${baseUrl}`)
console.log(`工作区 : ${workspaceRoot}`)
console.log(`项目   : ${projectId ?? '(未解析 —— 工作区是 Git 仓库吗？)'}`)

const handler = createApiHandler({
  upstream,
  resolveProject: async () => projectId,
  workspaceRoot,
})

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const query = Object.fromEntries(url.searchParams.entries())
  let body = ''
  for await (const chunk of req) body += chunk
  const result = await handler({
    method: String(req.method).toUpperCase(),
    path: url.pathname,
    query,
    readBody: async () => body,
  })
  res.writeHead(result.status, result.headers)
  res.end(result.body)
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const CASES = [
  ['GET', '/health'],
  ['GET', '/stats'],
  ['GET', '/observations'],
  ['GET', '/observations?limit=1'],
  ['GET', '/observations?type=decision'],
  ['GET', '/observations?q=zzz-no-match'],
  ['GET', '/observations?limit=9999'],
  ['GET', '/observations?project=../../etc'],
  ['GET', '/projects'],
  ['GET', '/sessions'],
  ['GET', '/nope'],
  ['POST', '/stats'],
]

let failed = 0
for (const [method, path] of CASES) {
  const res = await fetch(origin + path, { method })
  const text = await res.text()
  const body = (() => {
    try {
      return JSON.parse(text)
    } catch {
      return { raw: text.slice(0, 120) }
    }
  })()
  const summary =
    body.ok === true
      ? `ok data=${JSON.stringify(body.data).slice(0, 110)}`
      : `ok=${body.ok} error=${body.error}${body.code ? ` code=${body.code}` : ''}`
  console.log(`${String(res.status).padEnd(4)} ${method.padEnd(6)} ${path.padEnd(34)} ${summary}`)
}

// 停机路径也必须对：指向一个没人监听的端口，应得 503 + control_plane_down
const downHandler = createApiHandler({
  upstream: createUpstream({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 800 }),
  resolveProject: async () => projectId,
  workspaceRoot,
})
const down = await downHandler({ method: 'GET', path: '/stats', query: {}, readBody: async () => '' })
const downBody = JSON.parse(down.body)
console.log(
  `${down.status}  GET    /stats (控制面停机)              code=${downBody.code} hint=${downBody.hint ? '有' : '无'}`,
)
if (down.status !== 503 || downBody.code !== 'control_plane_down') failed += 1

// 自动拉起路径：用「先不可达、随后转 up」的假 upstream 覆盖 503 → up 的完整
// 转换，并确认 CLI 真的被执行了。用假 upstream 而不是真去
// `memorix background stop`，是为了不打断用户正在用的控制面。
{
  let calls = 0
  const flaky = {
    baseUrl: 'http://127.0.0.1:3211',
    health: async () => {
      calls += 1
      // 第 1 次是判定「不可达」，第 2 次是 probe 的首次；之后转 up
      return calls <= 2
        ? { up: false, error: 'connect ECONNREFUSED 127.0.0.1:3211' }
        : { up: true, raw: { version: '1.9.3', mode: 'control-plane' } }
    },
    getStats: async () => ({ observations: 0, retentionSummary: {} }),
    getProjects: async () => [],
    listObservations: async () => [],
    getSessions: async () => [],
    deleteObservation: async () => ({ ok: true }),
    resolveViaCli: async () => ({ ok: true }),
  }
  let cliArgs = null
  let daemonArgs = null
  const { createAutoStarter } = await import('../lib/autostart.js')
  const autostart = createAutoStarter({
    // 两个 runner 都注入：优先走的应该是 spawnDaemon（常驻进程型）
    spawnDaemon: async (args) => {
      daemonArgs = args
      return { code: 0, spawned: true, pid: 12345 }
    },
    runCli: async (args) => {
      cliArgs = args
      return { code: 0, stdout: 'starting' }
    },
    probeIntervalMs: 10,
    probeTimeoutMs: 800,
  })
  const h2 = createApiHandler({ upstream: flaky, resolveProject: async () => projectId, autostart })
  const r = await h2({ method: 'GET', path: '/health', query: {}, readBody: async () => '' })
  const body = JSON.parse(r.body)
  console.log('\n自动拉起路径：')
  console.log(`  常驻 runner 参数 : ${daemonArgs ? daemonArgs.join(' ') : '(未调用)'}`)
  console.log(`  短命 runner 参数 : ${cliArgs ? cliArgs.join(' ') : '(未调用)'}`)
  console.log(`  /health up       : ${body.data.up}`)
  console.log(`  /health starting : ${body.data.starting}`)
  console.log(`  /health version  : ${body.data.version}`)
  // background start 必须走常驻 runner（stdio ignore + detached），
  // 走 execFile 会因守护进程继承管道而永远等不到 EOF（启动卡住）。
  if (!daemonArgs || daemonArgs.join(' ') !== 'background start') failed += 1
  if (cliArgs !== null) failed += 1
  if (body.data.up !== true || body.data.starting !== false || body.data.version !== '1.9.3') failed += 1
}

server.close()
process.exit(failed === 0 ? 0 : 1)
