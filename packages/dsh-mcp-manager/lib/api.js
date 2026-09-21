// dsh-mcp-manager — /api/mcp/servers 的与载体无关的处理逻辑。
//
// 同一个处理器被两种载体复用：
//   1. DSH 0.1.5 的 connection.fetch 精确路由（走 /api 共享通道，宿主已施加
//      Host/Origin 信任栅栏与浏览器鉴权）—— Web 部署的首选；
//   2. 裸 webServer 路由（旧版 DSH / 非 Web 组装），由 index.js 自行施加
//      requestRejection 或回环校验后调用。
// 这里只做纯逻辑，不碰 req/res，便于单测。
//
// 路由契约：
//   GET  /api/mcp/servers -> { rev, servers: [...], status: {...} }
//   POST /api/mcp/servers <- { rev?, servers: [...] }（rev 乐观锁，冲突 409）

import { validateServers } from './logic.js'

export const API_PATH = '/api/mcp/servers'
export const MAX_BODY_BYTES = 1024 * 1024
/** 超限错误的 code：让两条载体都能把它映射成 413（而不是笼统的 400）。 */
export const BODY_TOO_LARGE = 'BODY_TOO_LARGE'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

const json = (status, body) => ({ status, headers: JSON_HEADERS, body: JSON.stringify(body) })

/** 造一个带 code 的超限错误。 */
function bodyTooLarge(limit) {
  const error = new Error(`请求体超过 ${Math.floor(limit / 1024)}KB 上限`)
  error.code = BODY_TOO_LARGE
  return error
}

/**
 * 请求是否来自本机回环。只有在拿不到宿主的 connection 服务（因而无法调用
 * `requestRejection`）时，才退化为这道来源校验；它只是兜底，不能替代鉴权。
 * @param {{socket?: {remoteAddress?: string}}} req
 * @returns {boolean}
 */
export function isLoopbackRequest(req) {
  const address = req && req.socket ? req.socket.remoteAddress : undefined
  if (typeof address !== 'string' || address === '') return false
  if (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1') return true
  if (address.startsWith('::ffff:')) return address.slice(7).startsWith('127.')
  return address.startsWith('127.')
}

/** 按字节数限制读取一个 Node 可读流；超限抛错。 */ export function readNodeBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(bodyTooLarge(limit))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * 建一个处理器。
 * @param {object} deps
 * @param {() => Array} deps.getServers 当前设置里的服务器列表
 * @param {() => number} deps.getRev 当前命名空间修订号
 * @param {() => object} deps.getStatus serverName -> { state, message }
 * @param {(servers: Array, rev: number|undefined) => Promise<void>} deps.replaceServers 提交
 * @returns {(request: {method: string, readBody: () => Promise<string>}) => Promise<{status: number, headers: object, body: string}>}
 */
export function createApiHandler(deps) {
  return async function handle(request) {
    const method = String(request.method || '').toUpperCase()

    if (method === 'GET' || method === 'HEAD') {
      return json(200, {
        rev: deps.getRev(),
        servers: deps.getServers(),
        status: deps.getStatus(),
      })
    }

    if (method !== 'POST') return json(405, { error: 'method not allowed' })

    let body
    try {
      body = await request.readBody()
    } catch (error) {
      const message = String((error && error.message) || error)
      if (error && error.code === BODY_TOO_LARGE) return json(413, { error: message })
      return json(400, { error: message })
    }

    // 体积上限必须与载体无关。connection.fetch 那条载体由宿主先整包缓冲再交给
    // 这里（宿主自己的上限是 300MB），所以在这里再判一次——否则 lib/api.js 声明的
    // 1MB 契约只对裸 webServer 载体生效。注意这只能"拒收"，宿主缓冲已成事实。
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      return json(413, { error: bodyTooLarge(MAX_BODY_BYTES).message })
    }

    let parsed
    try {
      parsed = JSON.parse(body === '' ? 'null' : body)
    } catch {
      return json(400, { error: '请求体不是合法 JSON' })
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return json(400, { error: '请求体必须是 { servers: [...] }' })
    }

    const { rev } = parsed
    if (rev !== undefined && rev !== null && (!Number.isInteger(rev) || rev < 0)) {
      return json(400, { error: `rev 必须是 >= 0 的整数，收到 ${JSON.stringify(rev)}` })
    }

    const invalid = validateServers(parsed.servers)
    if (invalid !== null) return json(400, { error: invalid })

    try {
      await deps.replaceServers(parsed.servers, rev === undefined ? undefined : rev)
      return json(200, { ok: true })
    } catch (error) {
      if (error && error.code === 'SETTINGS_CONFLICT') {
        return json(409, {
          error: '配置已被其他窗口/页面修改，请刷新后重试',
          code: 'conflict',
          rev: deps.getRev(),
        })
      }
      return json(400, { error: String((error && error.message) || error) })
    }
  }
}
