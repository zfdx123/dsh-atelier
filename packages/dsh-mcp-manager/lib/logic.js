// dsh-mcp-manager — pure host-side logic.
//
// 与 Cordis 运行时无关的纯逻辑（settings namespace schema、HTTP 校验、
// mcp-client 实例配置构造、配置指纹、mcp-client 日志→状态翻译、密钥引用
// 替换），单独成模块以便用 node:test 直接单测，也是「兼容性测试」的锚点：
// lib 产出的配置必须始终能被 @deepseek-ai/dsh-mcp-client 的 Config schema
// 接受（见 test/contract.test.js）。
//
// mcp-client 配置契约（0.1.0-rc.6 起；0.1.5-rc.2 新增可选 reconnect；0.1.6 新增
// 可选 maxInstructionBytes —— server instructions 的字节上限，两个 transport 通用，
// 默认 32768。本插件不输出该键，缺省即走 mcp-client 的默认值）：
//
//   stdio:           { transport: 'stdio', serverName, command,
//                      args: string[] = [], env: dict = {}, cwd = '',
//                      toolCallTimeoutMs = 60000, failOnStartupError = false,
//                      maxInstructionBytes = 32768,
//                      reconnect?: { enabled = true, initialDelayMs = 500,
//                                    maxDelayMs = 30000, maxAttempts = 10 } }
//   streamable-http: { transport: 'streamable-http', serverName, url,
//                      headers: dict = {}, toolCallTimeoutMs = 60000,
//                      failOnStartupError = false, maxInstructionBytes = 32768,
//                      reconnect?: 同上 }
//
// 多余的键 schemastery 不会拒绝、也不会剥离（会原样保留），所以
// buildClientConfig 仍必须只输出契约内的键，避免多余字段被当配置传入
// mcp-client（test/host-logic.test.js 逐键断言 key 集合）。
//
// TLS（tlsInsecure / tlsCaFile）不进 mcp-client 配置：它不是 mcp-client 的
// 契约字段，而是由 lib/tls.js 在传输层按 origin 施加（见该模块说明）。

import Schema from '@deepseek-ai/schemastery'

export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

// 本插件导出给 Cordis 的 Config schema（DSH 0.1.7 起 settings 由插件的
// Config 投影而来，见下方 ServersSchema 的 volatile 说明）。settings 的每个
// 命名空间必须是「键组成的对象」，所以服务器列表包在 `servers` 键下；字段
// 全部带默认值，transport 相关的必填性（stdio 要 command / http 要 url）在
// HTTP 接口里做明确校验。
export const ServerSchema = Schema.object({
  serverName: Schema.string().pattern(SERVER_NAME_PATTERN),
  enabled: Schema.boolean().default(true),
  transport: Schema.union(['stdio', 'streamable-http']),
  command: Schema.string().default(''),
  args: Schema.array(Schema.string()).default([]),
  env: Schema.dict(Schema.string()).default({}),
  cwd: Schema.string().default(''),
  url: Schema.string().default(''),
  headers: Schema.dict(Schema.string()).default({}),
  toolCallTimeoutMs: Schema.number().min(1).default(60000),
  failOnStartupError: Schema.boolean().default(false),
  // TLS：仅 streamable-http 有意义，由 lib/tls.js 按 origin 施加。
  tlsInsecure: Schema.boolean().default(false),
  tlsCaFile: Schema.string().default(''),
  // 断线重连（mcp-client 0.1.5 起的 reconnect 配置）。默认与 mcp-client 一致：
  // 开启、最多 10 次；这里只暴露真正需要调的两项。
  reconnectEnabled: Schema.boolean().default(true),
  reconnectMaxAttempts: Schema.number().step(1).min(1).default(10),
})

// DSH 0.1.7 起 `ctx.settings.register(ns, schema)` 已被移除：settings 现在是
// 「把每个 profile 条目自己的 Config schema 投影成表单」。所以服务器列表必须
// 是本插件 **自己 Config 的字段**，而表单只投影带 `.volatile()` 的节点。
//
// volatile 必须标在 **`servers` 字段**上，不能标在根对象上：
//   - `.volatile()` 的语义是「这个节点整体可被就地改写，不必重挂插件」。
//     Loader 把它包成可变引用（`.get()` 读当前值），配置一改就
//     `updateVolatile()` 就地写入，并发出 `loader/volatile-update`。
//   - 标在根对象上会让**整个 Config 只剩一个引用、把所有字段的默认值一起吃掉**
//     （实测 `resolveConfig` 得到 `servers: undefined`），所以服务器列表必须
//     自己就是那个 volatile 节点。
//   - 这与官方插件同构：dsh-llm-pi-ai 的
//     `providers: z.dict(profile).default({}).volatile()`。
export const ServersSchema = Schema.object({
  servers: Schema.array(ServerSchema).default([]).volatile(),
  /**
   * 兼容字段：**不再**决定设置条目的名字。
   *
   * 0.1.7 的设置 ns 是 loader 条目 id，而那个 id 由**挂载本插件的那一行**决定，
   * 不是插件能知道的东西：同一个包在根下挂是 `dsh-mcp-manager`，挂在 `include`
   * 分组下就变成 `include:dsh-mcp-manager`（实测宿主 192 个条目里绝大多数都是
   * 这种带前缀的形态）。把它当持久键会让保存写到别的 ns 上，宿主回
   * `No configurable plugin entry "include:dsh-mcp-manager"`。
   *
   * 现在改为按**值形状**认领条目（见 lib/claim.js 的 claimEntry），这个字段只
   * 留给手搭内存 cordis 的测试载体当兜底。
   */
  entryId: Schema.string().description('兼容字段；设置条目的名字改为按值形状自动认领'),
})

// 把设置页的一台服务器配置翻译成 mcp-client 实例配置。只输出契约内的键；
// enabled / TLS 由调用方处理，不进入实例配置。
// toolCallTimeoutMs / failOnStartupError 是 0.2.1 起每个服务器可配置的项，
// reconnect 是 0.3.0 起（对应 mcp-client 0.1.5 的 reconnect 配置）；缺省时
// 回落 mcp-client 契约默认值（60000 / false / reconnect 默认开启 10 次）。
export function buildClientConfig(server) {
  const config = {
    serverName: server.serverName,
    transport: server.transport,
    toolCallTimeoutMs:
      Number.isFinite(server.toolCallTimeoutMs) && server.toolCallTimeoutMs >= 1 ? server.toolCallTimeoutMs : 60000,
    failOnStartupError: server.failOnStartupError === true,
  }
  const reconnect = {}
  if (server.reconnectEnabled === false) reconnect.enabled = false
  if (Number.isInteger(server.reconnectMaxAttempts) && server.reconnectMaxAttempts >= 1) {
    reconnect.maxAttempts = server.reconnectMaxAttempts
  }
  if (Object.keys(reconnect).length > 0) config.reconnect = reconnect
  if (server.transport === 'stdio') {
    config.command = server.command
    config.args = Array.isArray(server.args) ? server.args : []
    config.env = server.env && typeof server.env === 'object' ? server.env : {}
    if (server.cwd) config.cwd = server.cwd
  } else {
    config.url = server.url
    config.headers = server.headers && typeof server.headers === 'object' ? server.headers : {}
  }
  return config
}

// HTTP 接口的明确校验（settings schema 的默认值会掩盖缺失字段，所以这里
// 单独做必填与重复检查）。返回错误文案，合法时返回 null。
export function validateServers(servers) {
  if (!Array.isArray(servers)) return 'servers 必须是数组'
  const seen = new Set()
  for (const server of servers) {
    if (!server || typeof server !== 'object') return '每个服务器必须是一个对象'
    if (typeof server.serverName !== 'string' || !SERVER_NAME_PATTERN.test(server.serverName)) {
      return `serverName 无效：应为 1-32 位字母数字下划线连字符，收到 ${JSON.stringify(server.serverName)}`
    }
    if (seen.has(server.serverName)) return `serverName 重复：${server.serverName}`
    seen.add(server.serverName)
    if (server.enabled !== undefined && server.enabled !== null && typeof server.enabled !== 'boolean') {
      return `enabled 必须是布尔值：${JSON.stringify(server.enabled)}`
    }
    if (
      server.toolCallTimeoutMs !== undefined &&
      server.toolCallTimeoutMs !== null &&
      (!Number.isFinite(server.toolCallTimeoutMs) || server.toolCallTimeoutMs < 1)
    ) {
      return `toolCallTimeoutMs 必须是 >= 1 的数字（毫秒）：${JSON.stringify(server.toolCallTimeoutMs)}`
    }
    if (
      server.failOnStartupError !== undefined &&
      server.failOnStartupError !== null &&
      typeof server.failOnStartupError !== 'boolean'
    ) {
      return `failOnStartupError 必须是布尔值：${JSON.stringify(server.failOnStartupError)}`
    }
    if (server.tlsInsecure !== undefined && server.tlsInsecure !== null && typeof server.tlsInsecure !== 'boolean') {
      return `tlsInsecure 必须是布尔值：${JSON.stringify(server.tlsInsecure)}`
    }
    if (server.tlsCaFile !== undefined && server.tlsCaFile !== null && typeof server.tlsCaFile !== 'string') {
      return `tlsCaFile 必须是字符串（PEM 文件路径）：${JSON.stringify(server.tlsCaFile)}`
    }
    if (
      server.reconnectEnabled !== undefined &&
      server.reconnectEnabled !== null &&
      typeof server.reconnectEnabled !== 'boolean'
    ) {
      return `reconnectEnabled 必须是布尔值：${JSON.stringify(server.reconnectEnabled)}`
    }
    if (
      server.reconnectMaxAttempts !== undefined &&
      server.reconnectMaxAttempts !== null &&
      (!Number.isInteger(server.reconnectMaxAttempts) || server.reconnectMaxAttempts < 1)
    ) {
      return `reconnectMaxAttempts 必须是 >= 1 的整数：${JSON.stringify(server.reconnectMaxAttempts)}`
    }
    if (server.transport === 'stdio') {
      if (typeof server.command !== 'string' || server.command.trim() === '') {
        return `stdio 服务器 ${server.serverName} 必须提供 command`
      }
    } else if (server.transport === 'streamable-http') {
      if (typeof server.url !== 'string' || server.url.trim() === '') {
        return `streamable-http 服务器 ${server.serverName} 必须提供 url`
      }
    } else {
      return `transport 无效：${JSON.stringify(server.transport)}（应为 stdio 或 streamable-http）`
    }
  }
  return null
}

// 配置指纹：字段都列出来，忽略键顺序外的噪声；enabled 与新增的可配置项
// 参与比较，这样开关切换/超时变更会被识别为「配置变化」。
export function serverKey(server) {
  return JSON.stringify({
    serverName: server.serverName,
    enabled: server.enabled !== false,
    transport: server.transport,
    command: server.command,
    args: server.args,
    env: server.env,
    cwd: server.cwd,
    url: server.url,
    headers: server.headers,
    toolCallTimeoutMs: server.toolCallTimeoutMs,
    failOnStartupError: server.failOnStartupError,
    tlsInsecure: server.tlsInsecure === true,
    tlsCaFile: typeof server.tlsCaFile === 'string' ? server.tlsCaFile : '',
    reconnectEnabled: server.reconnectEnabled !== false,
    reconnectMaxAttempts: server.reconnectMaxAttempts,
  })
}

// ── mcp-client 日志 → 挂载状态 ──────────────────────────────────────────
//
// mcp-client 的异步失败/恢复只出现在它的日志里（`mcp-client(<serverName>):`，
// 经 Cordis logger exporter 截获，message = { name, type, args }）。这里把
// 日志文本翻译成 mountState 转换，解析规则与 mcp-client 0.1.x 的日志文案
// 绑定（test/host-logic.test.js 用真实文案做夹具）。返回 null 表示无关。
//
// `detail` 标记该条消息是否携带了具体原因（证书、spawn ENOENT、工具注册失败
// 正文…）。mcp-client 的「connection failed; retrying」这类文案是固定短语，
// 若直接覆盖，用户就只剩「连接失败，重试中…」——真正的原因（前一行
// 「connection attempt failed: …」）会被冲掉。mergeMountStatus 用这个标记把
// 原因保住。

// 未识别文案透传时的前缀（test/log-contract.test.js 用它区分「翻译」与「透传」）
export const MCP_UNRECOGNIZED_PREFIX = '未识别的 mcp-client 日志：'

/** cordis 的日志级别：error=0 / info=1 / warn=2 / debug=3。 */
const FAILURE_LEVELS = new Set(['error', 'warn'])
const FAILURE_LEVEL_NUMBERS = new Set([0, 2])

/** 这条日志是不是"失败类"（只有失败类未识别时才透传，info/debug 保持安静）。 */
function isFailureLevel(message) {
  if (typeof message.type === 'string') return FAILURE_LEVELS.has(message.type)
  return FAILURE_LEVEL_NUMBERS.has(message.level)
}

/** 去掉固定前缀与其后的分隔冒号。 */
const after = (content, prefix) => content.slice(prefix.length).replace(/^:\s*/, '').trim()

/**
 * 日志规则表。规则用「前缀 + 关键词」而不是整句字面量匹配——上游把人看的英文
 * 散文当文案演进（0.1.6-alpha.1 就把 `failed generation did not close within …`
 * 改写成了 `failed generation could not confirm transport closure …`），锚定整句
 * 会在上游改词时静默失效。
 *
 * 每条规则必须覆盖上游真实文案；test/log-contract.test.js 会扫描实际安装的
 * mcp-client 源码逐个校验，漏了就变红。
 */
export const MCP_LOG_RULES = [
  {
    name: '连接尝试失败',
    match: (content) => content.startsWith('connection attempt failed:'),
    build: (content) => ({
      state: 'error',
      message: `连接失败：${after(content, 'connection attempt failed:')}`,
      detail: true,
    }),
  },
  {
    name: '连接失败重试中',
    match: (content) => content.startsWith('connection failed; retrying'),
    build: () => ({ state: 'error', message: '连接失败，重试中…', detail: false }),
  },
  {
    name: '连接中断重连中',
    match: (content) => content.startsWith('connection lost; reconnecting'),
    build: () => ({ state: 'error', message: '连接中断，重连中…', detail: false }),
  },
  {
    name: '重连成功',
    match: (content) => content.startsWith('reconnected and re-synced tools'),
    build: () => ({ state: 'ok', message: '', detail: false }),
  },
  {
    name: '放弃重连',
    match: (content) => content.startsWith('giving up after'),
    build: () => ({ state: 'error', message: '连续重连失败已放弃：需重载插件或重启 Host 才能恢复', detail: false }),
  },
  {
    name: '重连已关闭（连接失败）',
    match: (content) => content.includes('connection failed and reconnect is disabled'),
    build: () => ({ state: 'error', message: '连接失败（重连已关闭）：需重载插件或重启 Host', detail: false }),
  },
  {
    name: '重连已关闭（连接中断）',
    match: (content) => content.includes('connection lost and reconnect is disabled'),
    build: () => ({ state: 'error', message: '连接中断（重连已关闭）：已注册工具将失效', detail: false }),
  },
  {
    name: '工具注册失败',
    match: (content) => content.startsWith('tool registration failed, no tools registered'),
    build: (content) => ({
      state: 'error',
      message: `工具注册失败：${after(content, 'tool registration failed, no tools registered') || '(无详情)'}`,
      detail: true,
    }),
  },
  {
    name: '工具列表重新同步失败',
    match: (content) => content.startsWith('tool re-sync failed:'),
    build: (content) => ({
      state: 'error',
      message: `工具列表重新同步失败：${after(content, 'tool re-sync failed:')}`,
      detail: true,
    }),
  },
  {
    // 终态：settleFailedGeneration 直接 return，不再 scheduleReconnect。
    //
    // 只认现行措辞。0.1.7-rc.2 与 0.2.0-rc.1 的 mcp-client 源码**逐字节相同**，
    // 都是 `could not confirm transport closure`；更早的 rc.8 措辞
    // （`did not close within <ms>ms`）已不在受支持范围内，交给下面的未识别透传
    // 兜底——那同样会报成 error 并带上原文，不会变成「看起来正常」。
    name: '世代未确认关闭（终态）',
    match: (content) => /^failed generation could not confirm transport closure/.test(content),
    build: () => ({
      state: 'error',
      message: '连接关闭未能确认，已停止重连：需重载插件或重启 Host 才能恢复',
      detail: false,
    }),
  },
  {
    // 拆卸期没确认关闭。同上：只认现行措辞。
    name: '拆卸期关闭未确认',
    match: (content) => /during disposal/.test(content) && /transport closure could not be confirmed/.test(content),
    build: () => ({ state: 'error', message: '服务进程未在超时内退出（拆卸期）：可能留下残留进程', detail: true }),
  },
]

export function mcpClientLogToStatus(message) {
  if (!message || typeof message !== 'object') return null
  const name = message.name
  if (typeof name !== 'string' || !name.startsWith('mcp-client')) return null
  const text = typeof message.args?.[0] === 'string' ? message.args[0] : ''
  const match = /^mcp-client\(([^)]+)\): ([\s\S]*)$/.exec(text)
  if (!match) return null
  const serverName = match[1]
  const content = match[2].trim()

  for (const rule of MCP_LOG_RULES) {
    if (rule.match(content)) return { serverName, ...rule.build(content) }
  }

  // 兜底：规则表漏掉的 error/warn 透传原文，绝不静默——「未知」不该等于
  // 「看起来一切正常」。上游再改词时用户至少能看到红点与原文，规则表的缺口
  // 则由 test/log-contract.test.js 在 CI 里先变红。
  if (!isFailureLevel(message)) return null
  return { serverName, state: 'error', message: `${MCP_UNRECOGNIZED_PREFIX}${content}`, detail: true }
}

/**
 * 把一次日志翻译结果并入既有挂载状态。
 *
 * 两条规则：
 *
 * 1. **前置检查的判定是持久的**（`preflight`）：它一旦写下，后续的异步失败只能
 *    作为细节并入 `failure`，不能把主文案顶掉——README 承诺「设置页状态直接给出
 *    可照改的一句话」，而那句话原本只活在「mountOne 写下它」到「真实异步失败把它
 *    覆盖掉」之间的窗口里（Windows 实测 ~60ms，Linux <1ms），用户实际看到的是
 *    「连接失败：SdkError: Connection closed」——正是前置检查要替换掉的那句话。
 *    唯一能清掉它的是**连接成功**（state ok）：那说明这个保守启发式这次判断错了，
 *    不该继续对着一个已经连上的服务器喊狼来了。
 * 2. 其余情况沿用原规则：新的「无详情」错误不覆盖已有的原因；恢复成功一律以新
 *    状态为准（消息清空）。
 * @param {{state: string, message: string, detail?: boolean, preflight?: string, failure?: string}|undefined} previous
 * @param {{state: string, message: string, detail?: boolean}|null|undefined} update
 * @returns {{state: string, message: string, detail: boolean, preflight?: string, failure?: string}|undefined}
 */
export function mergeMountStatus(previous, update) {
  if (!update) return previous
  const preflight = previous !== undefined && typeof previous.preflight === 'string' ? previous.preflight : null
  if (preflight !== null && update.state !== 'ok') {
    const merged = { state: update.state, message: previous.message, detail: true, preflight }
    // 细节保留「最近一条带具体原因的失败」：重试类固定文案（detail:false）不该把
    // 上一条真实原因（证书 / ENOENT / Connection closed…）冲掉。
    const failure = update.detail === true ? update.message : previous.failure
    if (typeof failure === 'string' && failure !== '') merged.failure = failure
    return merged
  }

  const keepDetail =
    previous !== undefined &&
    previous.detail === true &&
    previous.state === 'error' &&
    update.state === 'error' &&
    update.detail !== true
  return {
    state: update.state,
    message: keepDetail ? previous.message : update.message,
    detail: update.detail === true || keepDetail,
  }
}

// ── MCP 会话失效（session not found）────────────────────────────────────
//
// 上游 SDK 的 `_send` 对非 2xx 直接 throw（正文就是 `session not found` 这 18 个
// 字节），同时只调 transport.onerror；dsh-mcp-client 只挂 generation.onclose，
// **没有任何会话重置/重初始化逻辑**——重连只在 connect / 工具同步失败时触发，
// 而工具调用失败既不重连也不打日志。于是服务端一重启（session 回收），客户端
// 就一直拿着死 session id 发请求，之后每次调用都失败，直到手动重挂。
//
// 所以这里做两件事：①识别「会话失效」这一类错误；②限流地重挂那一台。

/**
 * 会话失效的文案特征。
 *
 * 不依赖 SDK 内部枚举（拿不到，也不稳定）：只认**正文里带 session 的这几种说法**。
 * 三条都实测过或来自上游实现：
 *   - `Error POSTing to endpoint: session not found`（实测，服务端重启后 404 正文）
 *   - `session expired` / `invalid session`（同类实现的其他措辞）
 *   - `method "tools/list" is invalid during session initialization`（实测，缺 session 头）
 * @type {RegExp[]}
 */
export const MCP_SESSION_INVALID_PATTERNS = [
  /session not found/i,
  /session\s+(?:has\s+)?expired/i,
  /invalid\s+session/i,
  /invalid during session initialization/i,
]

/**
 * 把错误对象摊平成可搜索的文本：message + 整条 cause 链 + 状态码/错误码。
 *
 * SDK 把真正的正文包在 message 里（`Error POSTing to endpoint: session not found`），
 * 而工具层常常再包一层（cause 链）。只读 message 会漏，只读 cause 也会漏。
 * @param {unknown} error
 * @returns {string}
 */
export function describeErrorText(error) {
  const parts = []
  const seen = new Set()
  let current = error
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    if (typeof current === 'object') {
      if (seen.has(current)) break
      seen.add(current)
    }
    if (typeof current === 'string') {
      parts.push(current)
      break
    }
    if (typeof current !== 'object') {
      parts.push(String(current))
      break
    }
    if (typeof current.message === 'string') parts.push(current.message)
    for (const key of ['status', 'statusCode', 'code']) {
      const value = current[key]
      if (typeof value === 'string' || typeof value === 'number') parts.push(String(value))
    }
    current = current.cause
  }
  return parts.join(' | ')
}

/**
 * 这个错误是不是「MCP 会话失效」（服务端把会话回收了，重新初始化才能恢复）。
 *
 * 判据只有一条：错误文本里出现了会话失效的措辞。**不做宽松匹配**——工具调用
 * 本身失败（参数错、超时、服务端 500）绝不能触发重挂，那是把用户的服务器重启
 * 一遍去掩盖一个业务错误。因此也要求文本里确实有 session 这个词。
 * @param {unknown} error
 * @returns {boolean}
 */
export function isSessionInvalidError(error) {
  const text = describeErrorText(error)
  if (text === '') return false
  return MCP_SESSION_INVALID_PATTERNS.some((pattern) => pattern.test(text))
}

/** 会话失效后重新初始化时，写进挂载状态的主文案（用户/模型都能照做）。 */
export const SESSION_RECOVERING_MESSAGE = '会话已失效（服务器重启或回收了会话），正在重新初始化…'

/**
 * 抛给模型的那句话：说清「已自动重新初始化，请重试本次调用」。
 *
 * 不透明重放第一次调用是有意的：SDK 层拿不到新实例的 definition，而且第一次
 * 调用确实没执行成功（404 早于执行），所以重试是安全的——但必须由发起方重试。
 * @param {string} serverName
 * @param {boolean} recovered 是否真的已经发起重挂（false = 超出限流，需人工）
 * @param {number} limit 限流窗口内允许的次数
 * @returns {string}
 */
export function sessionInvalidMessage(serverName, recovered, limit = 3) {
  return recovered
    ? `服务器 "${serverName}" 的 MCP 会话已失效，已自动重新初始化，请重试本次调用。`
    : `服务器 "${serverName}" 的 MCP 会话已失效，且自动重新初始化已达上限（${limit} 次），请在设置页把它「关闭」再「开启」，或重启 Host。`
}

/**
 * 限流判定：滑动窗口内最多 limit 次。
 * @param {number[]} history 既往重挂时间戳（毫秒）
 * @param {number} now
 * @param {{limit?: number, windowMs?: number}} [options]
 * @returns {boolean} 允许再重挂一次
 */
export function recoveryAllowed(history, now, { limit = 3, windowMs = 300000 } = {}) {
  if (!Array.isArray(history)) return true
  const recent = history.filter((at) => Number.isFinite(at) && now - at < windowMs)
  return recent.length < limit
}

// ── 密钥引用 ────────────────────────────────────────────────────────────
//
// env / headers 的「值」可以写成引用，避免密钥明文落盘 settings.yaml：
//   env:NAME  → 进程环境变量 process.env.NAME
//   cred:NAME → DSH 凭据（ctx.credentials.resolve(NAME)，需运行方注入）
// 引用在挂载时解析（不入持久化层），解析失败保留字面值并由调用方告警。

export const SECRET_REF_PATTERN = /^(env|cred):([A-Za-z_][A-Za-z0-9_]*)$/

// resolveOne(name, kind) 返回 Promise<string | undefined>（同步值会被 await）。
// 返回新的配置对象，不改动入参。
export async function substituteSecretRefs(config, resolveOne) {
  const substitute = async (value) => {
    if (typeof value !== 'string') return value
    const match = SECRET_REF_PATTERN.exec(value)
    if (!match) return value
    const resolved = await resolveOne(match[2], match[1])
    return resolved === undefined ? value : resolved
  }
  const next = { ...config }
  if (config.env && typeof config.env === 'object') {
    const env = {}
    for (const [key, value] of Object.entries(config.env)) env[key] = await substitute(value)
    next.env = env
  }
  if (config.headers && typeof config.headers === 'object') {
    const headers = {}
    for (const [key, value] of Object.entries(config.headers)) headers[key] = await substitute(value)
    next.headers = headers
  }
  return next
}
