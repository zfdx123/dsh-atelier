// dsh-mcp-manager — host half.
//
// MCP 服务器管理器：服务器列表是本插件 Cordis Config 的 `servers` 字段
// （由 profile 条目的 config 持久化，见 cordis.patch.yml），按配置在宿主侧
// 挂载/卸载 @deepseek-ai/dsh-mcp-client 实例；每个服务器带 `enabled` 开关
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
// 配置读写（DSH 0.1.7 契约，0.1.6 及更早的 `ctx.settings.register` 已移除）：
//   - 读：`config.servers.get()` —— ServersSchema 是 volatile 的，Loader 把
//     它包成可变引用，配置一改就地写入并发出 `loader/volatile-update`。
//   - 写：`ctx.settings.replace(<profile 条目 id>, { servers }, rev)` ——
//     0.1.7 的表单按 **loader 条目 id** 定位（不再按自取命名空间），修订号
//     从 `ctx.settings.describe()` 的 `ns/revision` 取。
//   没有 settings 服务（旧版组装）时降级为只读：工具照常工作，页面写入报错。
//
// 生命周期：路由、TLS 策略、logger exporter 都是本插件 fiber 的 effect，
// 插件被移除时自动清理；每个 mcp-client 实例通过 ctx.plugin() 挂载并持有
// disposer，配置变化时按差异重建（dsh-mcp-client 自身处理断开重连与工具
// 注册/注销）。
//
// 状态的真实性：mcp-client 的连接/工具注册失败是异步的，只出现在它的
// 日志里；本插件通过 Cordis logger exporter 截获 mcp-client 日志并翻译
// 成 mountState（状态转换规则见 lib/logic.js 的 mcpClientLogToStatus）。
//
// 密钥不入盘：env / headers 的值支持 `env:NAME` 与 `cred:NAME` 引用，
// 挂载时解析（进程环境变量 / ctx.credentials），profile config 只存引用。
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

/**
 * 本插件自己的配置 schema。DSH 0.1.7 的 settings 由它投影而来：`servers` 是
 * volatile 字段，因此设置页可以就地改写这一个节点，而不重挂整个插件。
 * Loader 在调用 apply 之前已完成校验与默认值填充，所以 apply 里读到的
 * `config.servers` 永远是一个可变引用（default [] 保证不为 undefined）。
 */
export const Config = ServersSchema

/**
 * 确认窗口（毫秒）：挂载完成到「能证明连上了」之间允许的时间。
 *
 * 两件事要分清：
 *
 * 1. **网络错误本身是会被抓到的**（我原先误判成「要等 30–130 秒」）。实测黑洞
 *    地址（192.0.2.1，包被丢弃）：undici 的 connect timeout 是 **10 秒**，之后
 *    mcp-client 的 catch 打出 `connection attempt failed: … fetch failed ←
 *    UND_ERR_CONNECT_TIMEOUT Connect Timeout Error（网络层失败：…）`，插件把它
 *    翻成带原因链的错误状态，之后每次重试再更新。所以「连不上」早就有反馈，
 *    不需要这里兜底。
 * 2. **这 10 秒里卡片原本是绿的。** `ctx.plugin()` 返回只说明实例建好了；
 *    mcp-client 连接成功不打任何日志，挂载到第一次失败日志之间没有任何信号，
 *    旧实现直接写 `ok` → 这段时间（以及任何不产生失败日志的路径）显示「已挂载」。
 *
 * 所以窗口只负责**覆盖那段没有证据的时间**，并且必须**比传输层自己的超时长**，
 * 否则会在真实原因（UND_ERR_CONNECT_TIMEOUT + 可操作提示）即将到达时，抢先
 * 用一句更含糊的话把它盖掉。20 秒 = 10 秒连接超时 + 重试与派发余量。
 */
export const CONFIRM_TIMEOUT_MS = 20000

/** stdio 的确认窗口：spawn 失败是立即的（ENOENT/EACCES 亚秒级），不必等满 HTTP 那一档。 */
export const CONFIRM_TIMEOUT_STDIO_MS = 5000

/** 该传输的确认窗口（测试可用环境变量缩短）。 */
function confirmTimeoutFor(transport) {
  const raw = Number(process.env.DSH_MCP_MANAGER_CONFIRM_MS)
  if (Number.isFinite(raw) && raw > 0) return raw
  return transport === 'stdio' ? CONFIRM_TIMEOUT_STDIO_MS : CONFIRM_TIMEOUT_MS
}

/** 确认窗口超时后的文案：说清楚「实例在、但没连上」，而不是含糊的「失败」。 */
export function unconfirmedMessage(serverName, timeoutMs) {
  return `已挂载但 ${Math.round(timeoutMs / 1000)} 秒内未确认连上：服务器没有回应，也没有注册任何工具。请确认地址/端口可达、服务已启动、证书受信任（必要时开「允许自签名证书」）。`
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

export function apply(ctx, config) {
  // DSH 0.1.7：表单按 loader 条目 id 定位（不再按插件自取的命名空间）。
  // 条目 id 就是 profile patch 里那一行的 id，例如 `mcp-manager`。
  //
  // 不能在 apply 时取值：Cordis 在插件启动期间才把 loader 条目挂上。
  // 装载器给插件 fiber 挂的是 `ctx.fiber.entry`（`Entry.key` 那个 symbol）；
  // 每次需要时现取，profile 里即与那一行的 id 对齐。
  //
  // `config.entryId` 是给非 loader 载体（单测的内存 cordis）留的显式覆盖，
  // 正常组合不设，所以真实运行时永远走 `ctx.fiber.entry.id`。
  const entryIdOf = () => config?.entryId ?? ctx.fiber?.entry?.id

  /**
   * 读当前服务器列表。`config.servers` 是 Loader 的 volatile 引用：配置一改
   * 就地更新，`.get()` 始终返回最新快照。
   * @returns {Array<object>} 服务器配置数组
   */
  const readServers = () => {
    const value = config?.servers?.get?.()
    return Array.isArray(value) ? value : []
  }

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
  // serverName -> 确认窗口定时器（有正向证据时取消）
  const confirmTimers = new Map()

  // 挂载串行链 + 去抖：同一 tick 多次配置变化合并成一次 sync。
  let syncChain = Promise.resolve()
  let pendingServers = null
  let syncScheduled = false

  const tls = createTlsBridge({ onWarn: (message) => ctx.logger.warn(message) })
  ctx.effect(() => () => tls.dispose(), 'dsh-mcp-manager: TLS 策略')

  // 读取本条目当前的修订号（并发保存的乐观锁依据）。
  //
  // DSH 0.1.7 的表单按 **loader 条目 id** 定位：settings.describe() 返回的
  // 描述符里 `ns` 就是条目 id（例如 `mcp-manager`），revision 是当前修订号。
  //
  // 权威来源是 describe() 的描述符；但它从 describe 的字段名取，上游一旦改名
  // 就静默取不到。那时若退回常量 0，页面上每次保存都会 409「已被其他窗口修改」，
  // 比失去乐观锁更糟。所以用 settings/document-updated 的推送值兜底：事件参数
  // 是位置参数，不受字段改名影响。
  let pushedRev = null
  ctx.on('settings/document-updated', (ns, revision) => {
    if (ns === entryIdOf() && Number.isInteger(revision)) pushedRev = revision
  })
  const currentRev = () => {
    const ns = entryIdOf()
    if (ns !== undefined && typeof ctx.settings.describe === 'function') {
      const descriptor = ctx.settings.describe().find((entry) => entry !== null && entry !== undefined && entry.ns === ns)
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
    cancelConfirmation(serverName)
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

  /**
   * 取消某台服务器的确认窗口（卸载、重挂、或已有正向证据时调用）。
   * @param {string} serverName
   */
  const cancelConfirmation = (serverName) => {
    const timer = confirmTimers.get(serverName)
    if (timer !== undefined) {
      clearTimeout(timer)
      confirmTimers.delete(serverName)
    }
  }

  /**
   * 标记「连上了」：有工具注册或成功日志时的唯一正向信号。取消确认窗口，
   * 并把状态收敛成 ok（除非当前是前置检查写下的判定——那由 mergeMountStatus
   * 的规则处理，不能在这里抢）。
   * @param {string} serverName
   */
  const confirmConnected = (serverName) => {
    cancelConfirmation(serverName)
    const current = mountState.get(serverName)
    if (current === undefined || current.state === 'disabled') return
    if (current.state === 'connecting' || (current.state === 'ok' && current.message === '')) {
      mountState.set(serverName, { state: 'ok', message: '', detail: false })
    }
  }

  /**
   * 开一个确认窗口：窗口内保持连接中，窗口结束仍没有任何证据就转成错误。
   * @param {object} server - 已挂载的服务器配置
   */
  const beginConfirmation = (server) => {
    cancelConfirmation(server.serverName)
    const timeout = confirmTimeoutFor(server.transport)
    const timer = setTimeout(() => {
      confirmTimers.delete(server.serverName)
      const current = mountState.get(server.serverName)
      // 已经被日志改成 error/ok 就不覆盖：日志带来的原因（证书、401…）比
      // 这句「没回应」更具体。
      if (current === undefined || current.state !== 'connecting') return
      mountState.set(server.serverName, {
        state: 'error',
        message: unconfirmedMessage(server.serverName, timeout),
        detail: true,
      })
      ctx.logger.warn(`dsh-mcp-manager: 服务器 "${server.serverName}" 已挂载但未确认连上（${timeout}ms 内无回应）`)
    }, timeout)
    // 不阻塞进程退出。
    if (typeof timer.unref === 'function') timer.unref()
    confirmTimers.set(server.serverName, timer)
  }

  /**
   * 观察工具注册：`mcp__<名>__<工具>` 出现即证明这台服务器**确实连上了**。
   *
   * 为什么需要它：mcp-client 连接成功时**不打任何日志**（只在失败时打），而工具
   * 是在子插件自己的上下文里注册的，管理器看不见。没有这个信号，「挂载完成」
   * 就成了唯一的依据——一台只接受连接、永不响应的服务器会让卡片一直亮绿。
   *
   * 做法是给注入进来的 `tools` 服务包一层 register 观察器（原样转发、原样返回
   * disposer），并在本插件 fiber 卸载时还原。服务缺失时不装：那只损失「提前转
   * 绿」，确认窗口的超时判定照旧兜底。
   */
  const TAP_FLAG = Symbol.for('dsh-mcp-manager.toolRegistrationTap')
  const observeToolRegistration = () => {
    ctx.inject(['tools'], (childCtx) => {
      const tools = childCtx.get('tools')
      if (tools === undefined || tools === null || tools[TAP_FLAG] === true) return
      if (typeof tools.register !== 'function') return
      const original = tools.register
      tools.register = function observedRegister(definition, ...rest) {
        const serverName = mcpToolServerName(definition !== null && typeof definition === 'object' ? definition.name : undefined)
        if (serverName !== null) confirmConnected(serverName)
        return original.call(this, definition, ...rest)
      }
      Object.defineProperty(tools, TAP_FLAG, { value: true, configurable: true })
      childCtx.effect(
        () => () => {
          tools.register = original
          delete tools[TAP_FLAG]
        },
        'dsh-mcp-manager: 工具注册观察器',
      )
    })
  }

  /**
   * 从工具名反解 serverName：`mcp__<serverName>__<tool>`，名字本身可能含下划线，
   * 所以取第一段与最后一段之间的全部（与 mcp-client 的 publicToolName 约定一致）。
   * @param {unknown} name
   * @returns {string|null}
   */
  function mcpToolServerName(name) {
    if (typeof name !== 'string' || !name.startsWith('mcp__')) return null
    const rest = name.slice('mcp__'.length)
    const at = rest.indexOf('__')
    return at <= 0 ? null : rest.slice(0, at)
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
      //
      // 前置检查通过时**不再直接写 ok**：`ctx.plugin()` 返回只说明实例建好了，
      // 不说明连上了（见 CONFIRM_TIMEOUT_MS 的说明）。先写「连接中」，等正向
      // 证据（工具注册 / 成功日志）转绿，超时仍无证据则转错。
      if (problem === null) {
        mountState.set(server.serverName, { state: 'connecting', message: '', detail: false })
        beginConfirmation(server)
      } else {
        mountState.set(server.serverName, {
          state: 'error',
          message: `启动前置检查未通过：${problem}`,
          detail: true,
          preflight: problem,
        })
      }
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
      // 成功日志（重连成功 / 重新同步工具）是「确实连上了」的正向证据，
      // 也是把 connecting 转成 ok 的两条路径之一（另一条是工具注册）。
      if (update.state === 'ok') confirmConnected(update.serverName)
      mountState.set(update.serverName, mergeMountStatus(mountState.get(update.serverName), update))
    },
  })

  // 0.1.7 的配置变化通知：volatile 节点被就地改写后，Loader 发出
  // `loader/volatile-update`（只送到本 fiber 自己的监听器）。路径是相对根
  // 的键路径数组，`[]` 表示根节点本身就是 volatile 节点。
  //
  // 旧版的 `settings/updated` 事件在 0.1.7 已不存在；这里两条都听，配置一变
  // 就按差异对齐实例（去抖合并），在哪个版本上都只需这一处。
  const onConfigChanged = () => scheduleSync(readServers())
  ctx.on('loader/volatile-update', onConfigChanged)
  ctx.on('settings/updated', (ns, next) => {
    if (ns !== entryIdOf() && ns !== 'mcp') return
    scheduleSync(Array.isArray(next?.servers) ? next.servers : readServers())
  })

  // 工具注册观察器必须在第一次挂载**之前**装好：那才是「确实连上了」的正向信号。
  observeToolRegistration()

  // 启动时按当前配置挂载（enabled: false 的服务器只记录为已关闭）。
  scheduleSync(readServers())

  registerHttpApi(
    ctx,
    createApiHandler({
      getServers: readServers,
      getRev: currentRev,
      getStatus: () => Object.fromEntries(mountState),
      replaceServers: async (servers, rev) => {
        const invalid = validateServers(servers)
        if (invalid !== null) throw new Error(invalid)
        // 服务方法要在**调用时**取：装配期 ctx.settings 可能还没把方法暴露出来。
        const replace = ctx.settings?.replace
        const ns = entryIdOf()
        if (process.env.DBG_SETTINGS) console.log('DBG ns=', JSON.stringify(ns), 'replace=', typeof replace)
        if (ns === undefined || typeof replace !== 'function') {
          throw new Error(
            '当前宿主没有可写入的配置表单（settings.replace 不可用）：请在 profile 条目的 config 里直接编辑本插件的 servers。',
          )
        }
        await replace.call(ctx.settings, ns, { servers }, rev)
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
