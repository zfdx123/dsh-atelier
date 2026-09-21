// dsh-mcp-manager — MCP 出站桥：每服务器 TLS 策略 + 网络错误诊断。
//
// 背景：@deepseek-ai/dsh-mcp-client 的 streamable-http 传输由 MCP SDK 用全局
// fetch 建连（`new StreamableHTTPClientTransport(url, { requestInit })`），既
// 没有透出 `fetch` / dispatcher 参数，也没有每服务器的 TLS 选项。两个后果：
//
//   1. 内网自签名证书必然连不上（DEPTH_ZERO_SELF_SIGNED_CERT）；
//   2. 失败信息只剩 `TypeError: fetch failed`——真正的原因（证书、DNS、拒绝
//      连接）藏在 error.cause 链里，mcp-client 只会 `String(error)` 打日志，
//      用户在设置页看到的永远是「连接失败，重试中…」，无从下手。
//
// 本模块只用一条**定向**的 fetch 分流同时解决这两点，不做全局放宽：
//   - 只为已挂载的 MCP streamable-http 服务器的 origin 建立条目；
//   - 该 origin 若显式配了 tlsInsecure / tlsCaFile，走 undici 自带 fetch +
//     定制 dispatcher（Node 内置 fetch 只认内置 undici 的 dispatcher，传外部
//     Agent 会直接 fetch failed，已实测）；否则仍走原 fetch；
//   - 两种情况下都把失败原因展开成完整错误链并附可操作提示后重抛，于是
//     mcp-client 的日志和设置页状态都能显示「自签名证书 + 怎么办」；
//   - 其余所有请求（模型 API、web 搜索…）完全不受影响；条目全部释放后把
//     globalThis.fetch 还原成原来的函数（可逆副作用）。
//
// 未安装 undici 时不会静默降级：apply() 抛出可读错误，由挂载状态呈现给用户。

import { readFile } from 'node:fs/promises'

/** 把 URL 收敛成 origin；非法输入返回 null。 */
function httpsOriginOf(url) {
  try {
    const parsed = new URL(url)
    return parsed.origin
  } catch {
    return null
  }
}

/**
 * 该服务器的出站 origin（诊断/TLS 都用它做键）；stdio 或 url 非法时 null。
 * @param {object} server
 * @returns {string|null}
 */
export function mcpOriginFor(server) {
  if (!server || typeof server !== 'object') return null
  if (server.transport !== 'streamable-http') return null
  if (typeof server.url !== 'string' || server.url.trim() === '') return null
  return httpsOriginOf(server.url)
}

/**
 * 该服务器需要 TLS 策略吗？只对 https + 显式开了 tlsInsecure / tlsCaFile 的
 * 服务器返回策略；明文 http 没有证书可谈，返回 null。
 * @param {object} server
 * @returns {{origin: string, insecure: boolean, caFile: string}|null}
 */
export function tlsPolicyFor(server) {
  const origin = mcpOriginFor(server)
  if (origin === null) return null
  let protocol
  try {
    protocol = new URL(server.url).protocol
  } catch {
    return null
  }
  if (protocol !== 'https:') return null
  const insecure = server.tlsInsecure === true
  const caFile = typeof server.tlsCaFile === 'string' ? server.tlsCaFile.trim() : ''
  if (!insecure && caFile === '') return null
  return { origin, insecure, caFile }
}

function originOfFetchInput(input) {
  try {
    const href =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input && typeof input === 'object' && typeof input.url === 'string'
            ? input.url
            : undefined
    if (href === undefined) return null
    return new URL(href).origin
  } catch {
    return null
  }
}

/**
 * 把错误链展开成一行文本：`fetch failed ← self-signed certificate ← …`。
 * undici / Node 把根因放在 `cause` 上，只取 message 会丢掉全部有用信息。
 * @param {unknown} error
 * @param {number} [maxDepth]
 * @returns {string}
 */
export function describeErrorChain(error, maxDepth = 4) {
  const parts = []
  const seen = new Set()
  let current = error
  for (let depth = 0; depth < maxDepth && current !== undefined && current !== null; depth += 1) {
    if (typeof current === 'object') {
      if (seen.has(current)) break
      seen.add(current)
    }
    const code = typeof current === 'object' && typeof current.code === 'string' ? current.code : ''
    const message = typeof current === 'string' ? current : String(current.message || current)
    const text = [code, message].filter((part) => part !== '').join(' ')
    if (text !== '' && !parts.includes(text)) parts.push(text)
    current = typeof current === 'object' ? current.cause : undefined
  }
  return parts.join(' ← ')
}

/**
 * 给 MCP 出站失败加上可操作的说明（保留原始错误为 cause）。
 * @param {unknown} error
 * @param {{origin: string, tlsRelaxed: boolean}} context
 * @returns {Error}
 */
export function explainMcpNetworkError(error, context) {
  const original = error instanceof Error ? error : new Error(String(error))
  if (original.name === 'AbortError') return original
  const detail = describeErrorChain(original)
  const base = detail === '' ? String(original) : detail
  let hint = ''
  if (/self-signed|SELF_SIGNED|UNABLE_TO_VERIFY|CERT_|certificate|CERTIFICATE/i.test(base)) {
    hint = context.tlsRelaxed
      ? '仍报证书错误：确认 tlsCaFile 指向的 CA 与该服务器证书匹配（或改开「允许自签名证书」）'
      : '证书不受信任：在设置里为这台服务器开启「允许自签名证书」，或填写 CA 文件绝对路径（tlsCaFile）'
  } else if (/ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|UND_ERR_|fetch failed/i.test(base)) {
    hint = '网络层失败：确认地址/端口可达、服务已启动，以及本机是否需要经代理访问'
  }
  const message = hint === '' || base.includes(hint) ? base : `${base}（${hint}）`
  const wrapped = new Error(`${context.origin}: ${message}`, { cause: original })
  wrapped.name = original.name
  return wrapped
}

const defaultLoadUndici = () => import('undici')
const defaultReadCaFile = (path) => readFile(path, 'utf8')

/**
 * 建一座 MCP 出站桥：登记/释放「按 origin 的条目」，在这期间把
 * globalThis.fetch 换成定向分流的版本。
 *
 * @param {object} [options]
 * @param {() => Promise<object>} [options.loadUndici] undici 模块加载器（测试可注入）
 * @param {(path: string) => Promise<string|Buffer>} [options.readCaFile] CA 文件读取器
 * @param {object} [options.scope] 承载 fetch 的对象，默认 globalThis
 * @param {(message: string) => void} [options.onWarn] 非致命告警
 */
export function createTlsBridge(options = {}) {
  const loadUndici = options.loadUndici || defaultLoadUndici
  const readCaFile = options.readCaFile || defaultReadCaFile
  const scope = options.scope || globalThis
  const onWarn = options.onWarn || (() => {})

  /** origin -> { insecure, caFile, agent, undici, refs } */
  const entries = new Map()
  let savedFetch = null

  const shim = function mcpAwareFetch(input, init) {
    const origin = originOfFetchInput(input)
    const entry = origin === null ? undefined : entries.get(origin)
    if (entry === undefined) return savedFetch.call(scope, input, init)
    const run =
      entry.agent === null
        ? // 没有 TLS 策略：照常走原 fetch，只为把失败原因讲清楚。
          () => savedFetch.call(scope, input, init)
        : // 有策略：改用 undici 自带 fetch + 定制 dispatcher。
          () => entry.undici.fetch(input, { ...(init || {}), dispatcher: entry.agent })
    return Promise.resolve()
      .then(run)
      .catch((error) => {
        throw explainMcpNetworkError(error, { origin: entry.origin, tlsRelaxed: entry.agent !== null })
      })
  }

  const installShim = () => {
    if (savedFetch !== null) return
    if (typeof scope.fetch !== 'function') {
      throw new Error('dsh-mcp-manager: 当前运行时没有 globalThis.fetch，无法应用出站策略')
    }
    savedFetch = scope.fetch
    scope.fetch = shim
  }

  const uninstallShim = () => {
    if (savedFetch === null) return
    scope.fetch = savedFetch
    savedFetch = null
  }

  const buildAgent = async (origin, policy) => {
    let undici
    try {
      undici = await loadUndici()
    } catch (error) {
      throw new Error(
        `dsh-mcp-manager: 需要 undici 才能为 ${origin} 应用 TLS 策略（${String((error && error.message) || error)}）。` +
          '请安装 undici，或改用系统信任链（NODE_EXTRA_CA_CERTS / --use-system-ca）后关闭该选项。',
      )
    }
    if (typeof undici.Agent !== 'function' || typeof undici.fetch !== 'function') {
      throw new Error(`dsh-mcp-manager: undici 版本过旧（缺少 Agent/fetch），无法为 ${origin} 应用 TLS 策略`)
    }
    const connect = {}
    if (policy.caFile !== '') {
      let pem
      try {
        pem = await readCaFile(policy.caFile)
      } catch (error) {
        throw new Error(
          `dsh-mcp-manager: 读取 CA 文件失败 ${policy.caFile}（${String((error && error.message) || error)}）`,
        )
      }
      connect.ca = pem
      // 指定 CA = 用该 CA 正常校验证书；只有显式 tlsInsecure 才关校验。
      connect.rejectUnauthorized = !policy.insecure
    } else {
      connect.rejectUnauthorized = false
    }
    return { agent: new undici.Agent({ connect }), undici }
  }

  return {
    /** 当前登记的 origin 数（测试/诊断用）。 */
    get size() {
      return entries.size
    },

    /** 该 origin 当前是否已有条目。 */
    has(origin) {
      return entries.has(origin)
    },

    /** 该 origin 当前是否带 TLS 策略（而非仅诊断）。 */
    hasPolicy(origin) {
      const entry = entries.get(origin)
      return entry !== undefined && entry.agent !== null
    },

    /**
     * 登记一台服务器的 origin（引用计数）：同一 origin 被多台服务器共用时只建
     * 一个条目/Agent。需要 TLS 策略时在这里建好——必须在 mcp-client 建连前完成。
     * @returns {Promise<string|null>} 生效的 origin；stdio / url 非法时返回 null。
     */
    async apply(server) {
      const origin = mcpOriginFor(server)
      if (origin === null) return null
      const policy = tlsPolicyFor(server)
      const existing = entries.get(origin)
      if (existing !== undefined) {
        const samePolicy =
          policy === null
            ? existing.agent === null
            : existing.agent !== null && existing.insecure === policy.insecure && existing.caFile === policy.caFile
        if (samePolicy) {
          existing.refs += 1
          return origin
        }
        // 同一 origin 被两台服务器用不同 TLS 策略登记：以最新配置为准重建。
        onWarn(`dsh-mcp-manager: ${origin} 已被另一台服务器用不同的 TLS 策略登记，改为以最新配置为准`)
        await this.release(origin, { force: true })
      }
      const entry = {
        origin,
        insecure: policy === null ? false : policy.insecure,
        caFile: policy === null ? '' : policy.caFile,
        agent: null,
        undici: null,
        refs: 1,
      }
      if (policy !== null) {
        const built = await buildAgent(origin, policy)
        entry.agent = built.agent
        entry.undici = built.undici
      }
      entries.set(origin, entry)
      try {
        installShim()
      } catch (error) {
        entries.delete(origin)
        if (entry.agent !== null) await entry.agent.close().catch(() => {})
        throw error
      }
      return origin
    },

    /**
     * 释放一次使用；引用归零时关掉 Agent，全部归零时还原 fetch。
     * @param {string} origin
     * @param {{force?: boolean}} [opts] force 时无视引用计数直接释放。
     */
    async release(origin, opts = {}) {
      const entry = entries.get(origin)
      if (entry === undefined) return
      if (opts.force !== true) {
        entry.refs -= 1
        if (entry.refs > 0) return
      }
      entries.delete(origin)
      if (entry.agent !== null) {
        try {
          await entry.agent.close()
        } catch (error) {
          onWarn(`dsh-mcp-manager: 关闭 ${origin} 的 TLS Agent 失败：${String((error && error.message) || error)}`)
        }
      }
      if (entries.size === 0) uninstallShim()
    },

    /** 释放全部条目并还原 fetch（插件卸载用）。 */
    async dispose() {
      for (const origin of Array.from(entries.keys())) {
        await this.release(origin, { force: true })
      }
      uninstallShim()
    },
  }
}
