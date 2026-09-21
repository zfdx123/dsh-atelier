// dsh-memery — 宿主半（host half）。
//
// 把 Memorix 的记忆池暴露成 DSH 同源的 HTTP 端点，供客户端面板读取：
//
//   GET    /api/dsh-memery/health        -> { up, controlPlane, project, workspaceRoot }
//   GET    /api/dsh-memery/stats         -> 概览（总数/类型分布/来源分布/保留状态）
//   GET    /api/dsh-memery/observations  -> { items, total, ... }（q/type/source/limit/offset 本地过滤）
//   GET    /api/dsh-memery/projects      -> 项目列表透传
//   GET    /api/dsh-memery/sessions      -> 会话列表透传
//   POST   /api/dsh-memery/resolve       -> 软隐藏（走 memorix CLI）
//   DELETE /api/dsh-memery/observations?id=N -> 真删（走 Memorix REST）
//
// 为什么由宿主转发、而不是浏览器直连 127.0.0.1:3211：
//   1. Memorix 的 Dashboard 明确不使用 `*` CORS（localhost-only 策略），
//      浏览器跨源读会被拦；
//   2. 否则要绕过 DSH 自身的 Host/Origin 信任栅栏与浏览器鉴权。
//   宿主转发让鉴权留在宿主既有的那一套里，插件不自己发明安全模型。
//
// 接口注册照 dsh-mcp-manager 的双载体模式（二选一）：
//   1. `connection.fetch.register` —— /api 共享通道的**精确** Fetch 路由。
//      注意：它是精确匹配（内部 Map<path, route>，无前缀/参数匹配），所以
//      每条路径单独注册，且 delete 的 id 只能走 query（见 lib/endpoints.js）。
//   2. 裸 `webServer.register`（旧版 DSH / 非 Web 组装）—— 由本插件自己调用
//      `connection.requestRejection`；拿不到时退化到只允许回环来源。
//
// 生命周期：所有注册都用 ctx.effect 包裹，随本插件 fiber 卸载自动清理。
import { API_BASE, UPSTREAM_DEFAULT, jsonHeaders } from './lib/logic.js'
import { createApiHandler } from './lib/endpoints.js'
import { createUpstream, spawnDaemonCli } from './lib/upstream.js'
import { createAutoStarter } from './lib/autostart.js'

export const name = 'dsh-memery'
export const inject = []

/** 注册到载体上的精确路径 -> 内部 (method, path) 映射。 */
const ROUTES = [
  { path: `${API_BASE}/health`, methods: ['GET'], method: 'GET', inner: '/health' },
  { path: `${API_BASE}/stats`, methods: ['GET'], method: 'GET', inner: '/stats' },
  { path: `${API_BASE}/observations`, methods: ['GET', 'DELETE'], method: null, inner: '/observations' },
  { path: `${API_BASE}/projects`, methods: ['GET'], method: 'GET', inner: '/projects' },
  { path: `${API_BASE}/sessions`, methods: ['GET'], method: 'GET', inner: '/sessions' },
  { path: `${API_BASE}/resolve`, methods: ['POST'], method: 'POST', inner: '/resolve' },
]

/** 把已解析的配置解析成上游参数。 */
function resolveConfig(ctx) {
  const env = typeof process !== 'undefined' ? process.env : {}
  const baseUrl = String(env.DSH_MEMERY_BASE_URL || UPSTREAM_DEFAULT)
  const parsedTimeout = Number(env.DSH_MEMERY_TIMEOUT_MS)
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 10000
  return { baseUrl, timeoutMs }
}

/**
 * 工作区候选路径，按可信度排序。
 *
 * 踩过的坑：旧实现用 `ctx.get('workspaceRegistry')` **同步**探测，拿不到就
 * 回落 `process.cwd()` —— 那是 dsh **进程**的启动目录（实测是 `C:\Users\<用户>`），
 * 不是用户正在用的工作区。结果项目身份解析成错误的路径，面板永远「项目未解析」。
 *
 * 现在：workspaceRegistry 走延迟获取（和载体一样），并且把「从哪里解析到」也报出来。
 */
function createWorkspaceOrigin(ctx, logger) {
  const env = typeof process !== 'undefined' ? process.env : {}
  const explicit = env.DSH_MEMERY_WORKSPACE_ROOT ? String(env.DSH_MEMERY_WORKSPACE_ROOT) : undefined
  const candidates = explicit === undefined ? [] : [explicit]
  let source = explicit === undefined ? '' : 'env:DSH_MEMERY_WORKSPACE_ROOT'

  ctx.inject(['workspaceRegistry'], (scope) => {
    try {
      const list = scope.get('workspaceRegistry')?.list?.()
      if (Array.isArray(list)) {
        for (const item of list) {
          const p = item && typeof item.path === 'string' ? item.path.trim() : ''
          if (p !== '' && !candidates.includes(p)) candidates.push(p)
        }
        if (candidates.length > 0 && source === '') source = 'workspaceRegistry'
      }
    } catch (error) {
      logger?.warn?.(`dsh-memery: workspaceRegistry 读取失败：${error?.message ?? error}`)
    }
    if (candidates.length === 0) {
      const cwd = typeof process !== 'undefined' && typeof process.cwd === 'function' ? process.cwd() : undefined
      if (cwd !== undefined) {
        candidates.push(cwd)
        source = 'process.cwd（警告：可能不是用户工作区）'
        logger?.warn?.(`dsh-memery: 没有可用工作区，回落到进程 cwd=${cwd}。设 DSH_MEMERY_WORKSPACE_ROOT 可显式指定。`)
      }
    }
    logger?.info?.(`dsh-memery: 工作区来源=${source} 候选=${JSON.stringify(candidates)}`)
  })

  return {
    /** 当前首选工作区（可能随延迟获取而变化，所以每次读）。 */
    primary: () => candidates[0],
    /** 依次尝试每个候选，返回第一个能解析出 Memorix 项目身份的。 */
    async resolveProjectId(upstream) {
      for (const candidate of candidates) {
        const id = await upstream.resolveProjectId(candidate).catch(() => undefined)
        if (typeof id === 'string' && id !== '') {
          logger?.info?.(`dsh-memery: 项目身份 ${id}（来自工作区 ${candidate}）`)
          return id
        }
      }
      logger?.warn?.(
        `dsh-memery: 未能从任何候选工作区解析出项目身份（候选=${JSON.stringify(candidates)}）。` +
          '常见原因：该目录不是 Git 仓库。先 git init && git commit。',
      )
      return undefined
    },
    candidates,
    source: () => source,
  }
}

function isLoopbackRequest(req) {
  const address = req?.socket?.remoteAddress ?? req?.connection?.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function readNodeBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
    })
    req.on('end', () => resolve(data))
    req.on('error', () => resolve(''))
  })
}

/** 把 URLSearchParams 变成 endpoints 层要的 plain object。 */
function queryOf(url) {
  const out = {}
  for (const [key, value] of url.searchParams.entries()) out[key] = value
  return out
}

/**
 * 注册全部精确 Fetch 路由；拿不到 connection 时退回 webServer。
 * @returns {'connection'|'webServer'|'none'} 实际使用的载体（便于日志/自检）
 * 关键（踩过的坑）：载体必须用 `ctx.inject(['connection','webServer'], scope => ...)` **延迟获取**，
 * 不能用 `ctx.get('connection')` 同步探测。后者在本插件装载的那一刻可能还没被注册，
 * 于是两个分支都进不去、**静默什么都不注册** —— 症状就是客户端面板正常显示、
 * 但 `/api/dsh-memery/*` 一律 404（DSH 的共享通道返回裸 "not found"）。
 * 工作正常的 dsh-lovelyaudit 用的就是这个延迟模式。
 */
function registerHttpApi(ctx, handler, logger) {
  ctx.inject(['connection', 'webServer'], (scope) => {
    const connection = scope.get('connection')
    const canConnection =
      connection !== undefined && connection.fetch !== undefined && typeof connection.fetch.register === 'function'
    const webServer = scope.get('webServer')
    const carriers = {
      connection: connection !== undefined,
      connectionFetchRegister: canConnection,
      webServer: webServer !== undefined,
    }
    const carrier = canConnection ? 'connection' : webServer !== undefined ? 'webServer' : 'none'
    // 这一行是排障锚点：它把「哪个载体可用、最终用了哪个」写进宿主日志。
    logger?.info?.(`dsh-memery: 载体探测 ${JSON.stringify(carriers)} -> 采用 ${carrier}`)

    if (canConnection) {
      for (const route of ROUTES) {
        scope.effect(
          () =>
            connection.fetch.register({
              path: route.path,
              methods: route.methods,
              requestBody: 'buffered',
              fetch: async (request) => {
                const url = new URL(request.url, 'http://localhost')
                const method = route.method === null ? String(request.method).toUpperCase() : route.method
                const result = await handler({
                  method,
                  path: route.inner,
                  query: queryOf(url),
                  readBody: () => request.text(),
                })
                return new Response(result.body, { status: result.status, headers: result.headers })
              },
            }),
          `dsh-memery: ${route.path}`,
        )
      }
      logger?.info?.(`dsh-memery: 已注册 ${ROUTES.length} 条精确 Fetch 路由到 ${API_BASE}/*`)
      return
    }

    if (webServer === undefined) {
      logger?.warn?.('dsh-memery: 既无 connection.fetch 也无 webServer，HTTP 端点未注册')
      return
    }
    for (const route of ROUTES) {
      scope.effect(
        () =>
          webServer.register({
            kind: 'exact',
            path: route.path,
            handler: async (req, res) => {
              // 护栏一：有 connection 就复用宿主的 Host/Origin + 浏览器鉴权判定。
              const live = scope.get('connection')
              let rejection
              if (live !== undefined && typeof live.requestRejection === 'function') {
                rejection = live.requestRejection(req)
              } else {
                // 护栏二：拿不到 connection 时只允许本机回环来源。
                rejection = isLoopbackRequest(req) ? undefined : 403
              }
              if (rejection !== undefined) {
                res.writeHead(rejection, jsonHeaders)
                res.end(JSON.stringify({ ok: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' }))
                return
              }
              const url = new URL(req.url || '/', 'http://localhost')
              const method = route.method === null ? String(req.method || 'GET').toUpperCase() : route.method
              const result = await handler({
                method,
                path: route.inner,
                query: queryOf(url),
                readBody: () => readNodeBody(req),
              })
              res.writeHead(result.status, result.headers)
              res.end(result.body)
            },
          }),
        `dsh-memery: ${route.path}`,
      )
    }
    logger?.info?.(`dsh-memery: 已注册 ${ROUTES.length} 条裸路由到 ${API_BASE}/*（自行施加来源护栏）`)
  })
}

export function apply(ctx) {
  const logger = ctx.get?.('logger')
  logger?.info?.('dsh-memery: apply() 开始（宿主半正在加载）')
  try {
    return applyInner(ctx, logger)
  } catch (error) {
    // 宿主半抛错会让整条 fiber 失败，客户端面板却仍然显示（两半独立加载），
    // 结果是「面板在、端点 404」这种最难猜的症状。这里把原因喊出来。
    logger?.warn?.(`dsh-memery: apply() 失败，HTTP 端点不会注册：${error?.stack ?? error}`)
    throw error
  }
}

function applyInner(ctx, logger) {
  const config = resolveConfig(ctx)

  const upstream = createUpstream(config)
  const workspace = createWorkspaceOrigin(ctx, logger)

  // 项目作用域解析一次并缓存（要 spawn 一次 CLI，不该每次请求都付）。
  // 同时支持请求级覆盖：面板会把自己看到的工作区路径用 ?workspace= 带上来，
  // 这样「用户在看哪个工作区」由面板决定，而不是宿主瞎猜。
  const explicitProject = (typeof process !== 'undefined' && process.env.DSH_MEMERY_PROJECT) || undefined
  const projectCache = new Map()

  const resolveProject = (requestedWorkspace) => {
    if (explicitProject !== undefined) return Promise.resolve(explicitProject)
    const requested =
      typeof requestedWorkspace === 'string' && requestedWorkspace.trim() !== '' ? requestedWorkspace.trim() : undefined
    const key = requested ?? workspace.primary() ?? ''
    if (!projectCache.has(key)) {
      const candidates =
        requested === undefined ? undefined : [requested, ...workspace.candidates.filter((c) => c !== requested)]
      const task =
        candidates === undefined
          ? workspace.resolveProjectId(upstream)
          : (async () => {
              for (const candidate of candidates) {
                const id = await upstream.resolveProjectId(candidate).catch(() => undefined)
                if (typeof id === 'string' && id !== '') {
                  logger?.info?.(`dsh-memery: 项目身份 ${id}（来自 ${candidate}）`)
                  return id
                }
              }
              return undefined
            })()
      projectCache.set(key, task)
    }
    return projectCache.get(key)
  }

  const autostart = createAutoStarter({ runCli: upstream.runCli, spawnDaemon: spawnDaemonCli })

  const handler = createApiHandler({
    upstream,
    resolveProject,
    autostart,
    // workspaceRoot 是展示用信息，随请求/环境变化，所以用 getter 而不是快照值
    workspaceRoot: () => workspace.primary(),
  })
  // 注意：注册是**延迟**的（ctx.inject 等 connection/webServer 就绪后才回调），
  // 所以这里拿不到载体名——载体由 registerHttpApi 自己写进日志。
  registerHttpApi(ctx, handler, logger)

  // 启动时就探一次活，并且**直接把它拉起来**——用户不该为了看面板先去终端
  // 敲命令。拉起是幂等的（控制面已跑时 CLI 自己就返回），失败也不阻塞启动。
  autostart
    .ensureUp({ isUp: async () => (await upstream.health()).up === true, host: config.baseUrl })
    .then((result) => {
      if (result.state === 'up') {
        logger?.info?.(
          `dsh-memery: 控制面可用（${config.baseUrl}）${result.started === true ? '［本次自动启动］' : ''}，工作区来源=${workspace.source()}`,
        )
      } else {
        logger?.warn?.(`dsh-memery: 控制面不可用（${config.baseUrl}）：${result.error ?? result.state}。'
          + '手动启动：memorix background start`)
      }
      // 启动时就把项目身份解析一遍，失败立刻可见（而不是等面板第一屏）
      return resolveProject(undefined).then((id) => logger?.info?.(`dsh-memery: 项目身份 = ${id ?? '(未解析)'}`))
    })
    .catch(() => {})
}
