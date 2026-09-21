// dsh-mcp-manager — host half.
//
// MCP 服务器管理器：把 MCP 服务器配置放进 settings 命名空间 `mcp`
// （持久化到 settings.yaml），并按配置在宿主侧挂载/卸载
// @deepseek-ai/dsh-mcp-client 实例；每个服务器带 `enabled` 开关
// （默认 true）：开启/关闭只重建对应实例，其余不受影响；同时注册
// 一个纯 JSON 的 HTTP 接口供设置页读写：
//
//   GET  /api/mcp/servers   -> { rev, servers: [...], status: {...} }
//   POST /api/mcp/servers   <- { rev?, servers: [...] }
//                            （rev 是乐观锁：不匹配当前修订时返回 409）
//
// 接口注册有两套载体，二选一（见 registerHttpApi）：
//   1. DSH 0.1.5 的 `connection.fetch.register`（/api 共享通道的精确 Fetch
//      路由）——宿主已施加 Host/Origin 信任栅栏与浏览器鉴权，这是首选；
//   2. 裸 `webServer.register`（旧版 DSH 或没有 connection 的组装）——此时
//      由本插件自己调用 `connection.requestRejection`，拿不到就退化为回环
//      来源校验。**绝不能注册成无护栏的裸路由**：这台接口能写入任意 command
//      并会被宿主立即执行。
//
// 生命周期：settings.register 的命名空间、路由、TLS 策略、logger exporter
// 都是本插件 fiber 的 effect，插件被移除时自动清理；每个 mcp-client 实例
// 通过 ctx.plugin() 挂载并持有 disposer，配置变化时按差异重建
// （dsh-mcp-client 自身处理断开重连与工具注册/注销）。
//
// 状态的真实性：mcp-client 的连接/工具注册失败是异步的，只出现在它的
// 日志里；本插件通过 Cordis logger exporter 截获 mcp-client 日志并翻译
// 成 mountState（状态转换规则见 lib/logic.js 的 mcpClientLogToStatus）。
//
// 密钥不入盘：env / headers 的值支持 `env:NAME` 与 `cred:NAME` 引用，
// 挂载时解析（进程环境变量 / ctx.credentials），settings.yaml 只存引用。
//
// TLS：内网自签名证书的 MCP 服务器可在设置里按服务器开 `tlsInsecure`
// 或指定 `tlsCaFile`；策略由 lib/tls.js 只对那一个 origin 定向生效，其余
// 出站请求（含模型 API）的证书校验不变。

import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import {
  ServersSchema,
  buildClientConfig,
  serverKey,
  validateServers,
  mcpClientLogToStatus,
  mergeMountStatus,
  substituteSecretRefs,
} from './lib/logic.js'
import { API_PATH, createApiHandler, isLoopbackRequest, readNodeBody } from './lib/api.js'
import { createTlsBridge, describeErrorChain } from './lib/tls.js'
import { normalizeStdioServer, preflightStdioServer } from './lib/stdio.js'

export const name = 'dsh-mcp-manager'
export const inject = ['settings']

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

export function apply(ctx) {
  ctx.settings.register('mcp', ServersSchema)

  // serverName -> ctx.plugin() 的 Fiber
  const handles = new Map()
  // serverName -> 已挂载实例的配置指纹（用于跳过未变化的服务器）
  const handleKeys = new Map()
  // serverName -> { state: 'ok' | 'error' | 'disabled', message: string, detail: boolean,
  //                 preflight?: string, failure?: string }
  // preflight 是启动前置检查的判定（持久的主文案），failure 是并入的异步失败细节；
  // 两者的合并规则见 lib/logic.js 的 mergeMountStatus。
  const mountState = new Map()
  // serverName -> 该实例占用的 TLS 策略 origin
  const tlsOrigins = new Map()

  // 挂载串行链 + 去抖：同一 tick 多次 settings/updated 合并成一次 sync。
  let syncChain = Promise.resolve()
  let pendingServers = null
  let syncScheduled = false

  const tls = createTlsBridge({ onWarn: (message) => ctx.logger.warn(message) })
  ctx.effect(() => () => tls.dispose(), 'dsh-mcp-manager: TLS 策略')

  // 读取 mcp 命名空间的当前修订号（并发保存的乐观锁依据）。
  //
  // 权威来源是 settings.describe() 的描述符（字段名 ns + revision）；但它按字段名
  // 取，上游一旦改名（dsh-settings README 已把 ns→namespace 列为 TODO）就静默取不到。
  // 那时若退回常量 0，页面上每次保存都会 409「已被其他窗口修改」，比失去乐观锁更糟。
  // 所以用 settings/document-updated 的推送值兜底：事件参数是位置参数，不受字段改名影响。
  let pushedRev = null
  ctx.on('settings/document-updated', (ns, revision) => {
    if (ns === 'mcp' && Number.isInteger(revision)) pushedRev = revision
  })
  const currentRev = () => {
    if (typeof ctx.settings.describe === 'function') {
      const descriptor = ctx.settings.describe().find((entry) => entry && entry.ns === 'mcp')
      if (descriptor !== undefined && Number.isInteger(descriptor.revision)) {
        pushedRev = descriptor.revision
        return descriptor.revision
      }
    }
    return pushedRev === null ? 0 : pushedRev
  }

  const disposeHandle = async (serverName) => {
    const handle = handles.get(serverName)
    handles.delete(serverName)
    handleKeys.delete(serverName)
    if (handle) {
      // 必须等旧实例 dispose 完成：mcp-client 把 serverName 做成「活跃命名
      // 保留」（activeServerNames），快速卸载/重挂同一名字时若不等它的
      // 异步收尾，新实例会报 already in use。
      try {
        await handle.dispose()
      } catch (error) {
        /* already disposed */
      }
    }
  }

  const unmountOne = async (serverName, { keepStatus = false } = {}) => {
    await disposeHandle(serverName)
    // 服务器被移出配置时才清状态；enabled:false 的「关闭」要保留 disabled 状态，
    // 否则卸载收尾会把它刚写下的 disabled 抹掉，设置页对这台已关闭的服务器
    // 就退回默认显示「已挂载」（绿点）——状态与事实相反。
    if (!keepStatus) mountState.delete(serverName)
    const origin = tlsOrigins.get(serverName)
    if (origin !== undefined) {
      tlsOrigins.delete(serverName)
      await tls.release(origin)
    }
  }

  // `env:NAME` → 进程环境变量；`cred:NAME` → DSH 凭据。解析失败保留字面值。
  const secretResolver = async (name, kind) => {
    if (kind === 'env') {
      const value = process.env[name]
      if (value === undefined) {
        ctx.logger.warn(`dsh-mcp-manager: 环境变量 "${name}" 未设置，env 引用保留字面值`)
      }
      return value
    }
    const credentials = ctx.get('credentials')
    if (credentials === undefined) {
      ctx.logger.warn(`dsh-mcp-manager: credentials 服务不可用，cred 引用 "${name}" 保留字面值`)
      return undefined
    }
    const resolved = await credentials.resolve(name)
    if (resolved === undefined) {
      ctx.logger.warn(`dsh-mcp-manager: 凭据 "${name}" 未配置，cred 引用保留字面值`)
      return undefined
    }
    return resolved.value
  }

  const mountOne = async (server) => {
    if (server.enabled === false) {
      // 立即呈现 disabled 状态（UI 即时反馈），实例收尾在后台完成；
      // keepStatus 保证收尾不会把这个状态删掉。
      mountState.set(server.serverName, { state: 'disabled', message: '', detail: false })
      await unmountOne(server.serverName, { keepStatus: true })
      return
    }
    // 串行化：先等该服务器的旧实例完全收尾（dispose + TLS 策略释放）再建新实例。
    await unmountOne(server.serverName)
    try {
      // TLS 策略必须先于实例建连生效（MCP SDK 在 connect 时就用全局 fetch）。
      const origin = await tls.apply(server)
      if (origin !== null) tlsOrigins.set(server.serverName, origin)
      // stdio 配置归一化：把「整条命令行粘进 command/args」还原成 exe + args[]，
      // 否则 spawn 出来的是「带空格的可执行文件名」，只会得到 ENOENT 或
      // argparse 退出，而 mcp-client 把它们都报成 -32000 Connection closed。
      const normalized = normalizeStdioServer(server)
      if (normalized.changes.length > 0) {
        ctx.logger.warn(
          `dsh-mcp-manager: 服务器 "${server.serverName}" 的 stdio 配置已自动归一化：${normalized.changes.join('；')}`,
        )
      }
      const effective = normalized.server
      // 前置检查：可执行文件/脚本/工作目录不存在时，直接给出可照改的原因。
      const problem = preflightStdioServer(effective)
      if (problem !== null) {
        ctx.logger.warn(`dsh-mcp-manager: 服务器 "${server.serverName}" 启动前置检查未通过：${problem}`)
      }
      const config = await substituteSecretRefs(buildClientConfig(effective), secretResolver)
      const handle = ctx.plugin(
        {
          name: 'mcp-client',
          inject: ['tools'],
          apply: (childCtx, config) =>
            McpClient.apply(childCtx, config).catch((error) => {
              // failOnStartupError: true 时 apply 会因首次连接/工具同步失败而
              // 抛错。这里吞掉：连接 supervisor 仍在后台重连，错误细节已经由
              // 日志跟踪（logger exporter）呈现到挂载状态。避免未处理的
              // rejection 打到 Cordis fiber 上。
              //
              // 兜底把状态置为 error，并展开整条原因链：failOnStartupError +
              // 关闭重连时 mcp-client 只会打一条 "connection failed and reconnect
              // is disabled"，真正的原因（证书、DNS、401…）在 cause 链里，不展开
              // 用户看到的就只有一句 "fetch failed"。
              const message = String((error && error.message) || error)
              const cause = describeErrorChain(error && error.cause ? error.cause : error)
              if (mountState.has(server.serverName)) {
                // 走 mergeMountStatus 而不是无条件 set：前置检查已经写下的判定是
                // **持久**的主文案，这里的真实启动失败只能作为细节（failure）并入，
                // 不能把它顶掉——否则设置页又会退回「启动失败：…Connection closed」
                // 这类用户照不了改的话（见 lib/logic.js 的 mergeMountStatus）。
                mountState.set(
                  server.serverName,
                  mergeMountStatus(mountState.get(server.serverName), {
                    state: 'error',
                    message: cause === '' ? `启动失败：${message}` : `启动失败：${message}（${cause}）`,
                    detail: true,
                  }),
                )
              }
              ctx.logger.warn(
                `dsh-mcp-manager: mcp-client(${server.serverName}) 启动失败：${message}${cause === '' ? '' : `（${cause}）`}（实例保持存活以继续重连）`,
              )
            }),
        },
        config,
      )
      handles.set(server.serverName, handle)
      handleKeys.set(server.serverName, serverKey(server))
      // 前置检查没过就不要显示成「已挂载」——那会让用户以为差的是别的地方。
      // 判定同时写进 preflight：客户端/合并逻辑据此把它当作**持久的主文案**，
      // 之后 mcp-client 的真实异步失败只能作为细节并入（见 mergeMountStatus）。
      mountState.set(
        server.serverName,
        problem === null
          ? { state: 'ok', message: '', detail: false }
          : { state: 'error', message: `启动前置检查未通过：${problem}`, detail: true, preflight: problem },
      )
    } catch (error) {
      // 挂载失败（含 TLS 策略失败：缺 undici / CA 文件读不到）也要把刚登记
      // 的策略收回，避免留下无人释放的 origin。
      const origin = tlsOrigins.get(server.serverName)
      if (origin !== undefined) {
        tlsOrigins.delete(server.serverName)
        await tls.release(origin)
      }
      const message = String((error && error.message) || error)
      mountState.set(server.serverName, { state: 'error', message, detail: true })
      // 这类失败没有 mcp-client 实例参与，不会有任何它的日志——不在这里打一条，
      // 用户在 Host 日志里就完全看不到原因。
      ctx.logger.warn(`dsh-mcp-manager: 服务器 "${server.serverName}" 挂载失败：${message}`)
    }
  }

  // 把内存实例与最新配置对齐：新增/变更的服务器重建，被移除的卸载，
  // 未变化的保持不动——开启/关闭某台服务器只影响它自己。不同名字的
  // 操作并行，同一名字由 unmountOne 的 await 保证串行。
  const sync = async (servers) => {
    const seen = new Set()
    const jobs = []
    for (const server of servers) {
      seen.add(server.serverName)
      const mounted = handles.has(server.serverName)
      if (mounted && handleKeys.get(server.serverName) === serverKey(server)) continue
      jobs.push(mountOne(server))
    }
    for (const serverName of Array.from(new Set([...handles.keys(), ...mountState.keys()]))) {
      if (!seen.has(serverName)) jobs.push(unmountOne(serverName))
    }
    await Promise.all(jobs)
  }

  const scheduleSync = (servers) => {
    pendingServers = servers || []
    if (syncScheduled) return
    syncScheduled = true
    queueMicrotask(() => {
      syncScheduled = false
      const list = pendingServers
      pendingServers = null
      syncChain = syncChain
        .then(() => sync(list))
        .catch((error) => {
          ctx.logger.warn(`dsh-mcp-manager: 同步挂载失败：${String((error && error.message) || error)}`)
        })
    })
  }

  // 日志驱动的真实挂载状态：mcp-client 的异步失败/恢复只出现在它的日志里
  // （失败多为 warn 级）。exporter 默认只转发 <= info 级别的消息，这里显式
  // 声明 levels.default = 3 接收全部级别。exporter 随本插件 fiber 一起释放；
  // 只更新仍在管理中的服务器。合并规则见 mergeMountStatus：重试类固定文案
  // 不会把上一行携带的具体原因（证书/ENOENT/401…）冲掉，也**不会**把启动前置
  // 检查写下的判定冲掉——那条判定是持久的主文案，异步失败只并入 failure。
  ctx.logger.exporter({
    levels: { default: 3 },
    export: (message) => {
      const update = mcpClientLogToStatus(message)
      if (!update || !mountState.has(update.serverName)) return
      mountState.set(update.serverName, mergeMountStatus(mountState.get(update.serverName), update))
    },
  })

  // settings/updated 是提交后的事件：配置一变，按差异对齐实例（去抖合并）。
  ctx.on('settings/updated', (ns, next) => {
    if (ns !== 'mcp') return
    scheduleSync(next && Array.isArray(next.servers) ? next.servers : [])
  })

  // 启动时按当前配置挂载（enabled: false 的服务器只记录为已关闭）。
  const current = ctx.settings.get('mcp')
  scheduleSync(current && Array.isArray(current.servers) ? current.servers : [])

  registerHttpApi(
    ctx,
    createApiHandler({
      getServers: () => {
        const value = ctx.settings.get('mcp')
        return value && Array.isArray(value.servers) ? value.servers : []
      },
      getRev: currentRev,
      getStatus: () => Object.fromEntries(mountState),
      replaceServers: async (servers, rev) => {
        const invalid = validateServers(servers)
        if (invalid !== null) throw new Error(invalid)
        await ctx.settings.replace('mcp', { servers }, rev)
      },
    }),
  )
}

/**
 * 注册 /api/mcp/servers。优先用 connection 的精确 Fetch 路由（宿主负责信任
 * 栅栏 + 浏览器鉴权）；否则退回裸 webServer 路由，并自行施加同等护栏。
 * 若 apply 时 connection 还没激活，先挂裸路由，等它出现再升级并撤掉裸路由。
 * @param {object} ctx 插件上下文
 * @param {(request: object) => Promise<{status: number, headers: object, body: string}>} api
 */
function registerHttpApi(ctx, api) {
  const hasFetchRoute = (candidate) =>
    candidate !== undefined && candidate.fetch !== undefined && typeof candidate.fetch.register === 'function'

  // methods 必须与 lib/api.js 的处理器一致：宿主允许 GET/HEAD/POST，处理器也
  // 实现了 HEAD（少注册 HEAD 会让已鉴权的 HEAD 落到 404）。
  const registerFetchRoute = (connection) =>
    ctx.effect(
      () =>
        connection.fetch.register({
          path: API_PATH,
          methods: ['GET', 'HEAD', 'POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            const result = await api({ method: request.method, readBody: () => request.text() })
            return new Response(result.body, { status: result.status, headers: result.headers })
          },
        }),
      'dsh-mcp-manager: /api/mcp/servers fetch route',
    )

  const connection = ctx.get('connection')
  if (hasFetchRoute(connection)) {
    registerFetchRoute(connection)
    return
  }

  const webServer = ctx.get('webServer')
  let webRoute = null
  if (webServer !== undefined) {
    webRoute = ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: API_PATH,
          handler: async (req, res) => {
            // 护栏一：有 connection 就用宿主的 Host/Origin + 浏览器鉴权判定。
            const live = ctx.get('connection')
            let rejection
            if (live !== undefined && typeof live.requestRejection === 'function') {
              rejection = live.requestRejection(req)
            } else {
              // 护栏二：拿不到 connection 时只允许本机回环来源。
              rejection = isLoopbackRequest(req) ? undefined : 403
            }
            if (rejection !== undefined) {
              res.writeHead(rejection, JSON_HEADERS)
              res.end(JSON.stringify({ error: rejection === 401 ? 'unauthorized' : 'forbidden' }))
              return
            }
            const method = String(req.method || '').toUpperCase()
            const result = await api({
              method,
              readBody: () => (method === 'POST' ? readNodeBody(req) : Promise.resolve('')),
            })
            res.writeHead(result.status, result.headers)
            res.end(result.body)
          },
        }),
      'dsh-mcp-manager: http api',
    )
  }

  // 组合时序兜底：apply 阶段 connection 还没就绪时先走裸路由，等它出现再升级为
  // 精确 Fetch 路由并撤掉裸路由——否则两条载体同时应答，实际行为（体积上限、
  // HEAD 语义、缓存头）会因命中哪条而异。用 ctx.inject 而不是把 'connection'
  // 加进顶层 inject 数组：后者会让插件在没有 connection 的组装（TUI/headless）
  // 里直接加载失败。
  ctx.inject(['connection'], (childCtx) => {
    const late = childCtx.get('connection')
    if (!hasFetchRoute(late)) return
    registerFetchRoute(late)
    if (webRoute !== null) {
      webRoute()
      webRoute = null
    }
  })
}
