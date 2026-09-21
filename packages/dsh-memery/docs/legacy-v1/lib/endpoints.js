// dsh-memery — 端点层（载体无关）。
//
// 把 pure logic（lib/logic.js）接到 Memorix 客户端（lib/upstream.js）。
// 与 HTTP 载体无关：index.js 负责把 `{method, path, query, readBody}` 喂进来，
// 并把返回的 `{status, headers, body}` 变成 Response / node 响应。
// 这样同一份逻辑同时支持 connection.fetch 与 webServer 两套载体，且可单测。
//
// 纪律：**先校验、后打上游**。被拒绝的参数绝不产生任何上游请求。
import {
  validateQuery, filterObservations, summarizeStats, ok, fail, jsonHeaders,
} from './logic.js'
import { UpstreamError } from './upstream.js'

export { jsonHeaders }

const DELETE_RE = /^\/observations\/([^/]+)$/

const RESOLVE_FALLBACK_HINT = 'Memorix REST 面没有 resolve 端点，此操作走 memorix CLI。'
  + '若 CLI 不可用，请在 Dashboard 里处理：http://127.0.0.1:3211'

/**
 * @param {{
 *   upstream: object,
 *   resolveProject: () => Promise<string|undefined>,
 *   workspaceRoot?: string | (() => string|undefined),
 *   autostart?: { ensureUp: (ctx: {isUp: () => Promise<boolean>, host: string}) => Promise<object> },
 * }} deps
 */
export function createApiHandler({ upstream, resolveProject, workspaceRoot, autostart } = {}) {
  /**
   * 解析本次请求的作用域：显式 project 参数优先，否则交给宿主自动解析。
   * workspace 由面板带上来（用户在看哪个工作区），透传给宿主作为首选候选。
   */
  async function scopeFor(value) {
    if (value.project) return value.project
    try {
      const resolved = await resolveProject?.(value.workspace)
      return typeof resolved === 'string' && resolved !== '' ? resolved : undefined
    } catch {
      return undefined
    }
  }

  /** workspaceRoot 同时支持字面值与 getter（宿主里是后者，随延迟获取变化）。 */
  function currentWorkspaceRoot() {
    try {
      return typeof workspaceRoot === 'function' ? workspaceRoot() : workspaceRoot
    } catch {
      return undefined
    }
  }

  return async function handle(request) {
    const method = String(request?.method ?? 'GET').toUpperCase()
    const path = String(request?.path ?? '/')
    const readBody = typeof request?.readBody === 'function' ? request.readBody : async () => ''

    const parsed = validateQuery(request?.query ?? {})
    if (!parsed.ok) return fail(400, parsed.error, 'bad_request')
    const query = parsed.value

    try {
      if (method === 'GET' && path === '/health') {
        // 这一个端点就是面板的「单一真相源」：连接状态、作用域、版本、以及
        // 必要时**自动拉起控制面**。面板只打这一个请求，不做多请求竞态。
        let health = await upstream.health()
        let autostartInfo

        if (health.up !== true && autostart !== undefined) {
          try {
            autostartInfo = await autostart.ensureUp({
              isUp: async () => (await upstream.health()).up === true,
              host: upstream.baseUrl ?? '',
            })
          } catch (error) {
            autostartInfo = { state: 'failed', error: String(error?.message ?? error) }
          }
          if (autostartInfo?.state === 'up') health = await upstream.health()
        }

        const project = await scopeFor(query)
        const starting = (autostartInfo?.state === 'starting' || autostartInfo?.started === true)
          && health.up !== true
        const failed = health.up !== true && autostartInfo?.state === 'failed'

        return ok({
          up: health.up === true,
          starting,
          controlPlane: upstream.baseUrl ?? undefined,
          workspaceRoot: currentWorkspaceRoot() ?? undefined,
          project: project ?? null,
          version: health.raw?.version ?? undefined,
          mode: health.raw?.mode ?? undefined,
          // error 始终是「连不上」的原因；自动拉起的失败单独放在 autostartError，
          // 因为那才是用户能采取行动的那一条（改 PATH、看 CLI 报错）。
          error: health.up === true ? undefined : health.error,
          autostartError: failed ? (autostartInfo?.error ?? '自动启动失败') : undefined,
          // 只有自动拉起也失败时才把「请手动启动」当作建议给出去
          hint: failed
            ? `自动启动失败：${autostartInfo?.error ?? 'unknown'}。手动执行：memorix background start`
            : undefined,
        })
      }

      if (method === 'GET' && path === '/stats') {
        const project = await scopeFor(query)
        return ok(summarizeStats(await upstream.getStats(project)))
      }

      if (method === 'GET' && path === '/observations') {
        const project = await scopeFor(query)
        const raw = await upstream.listObservations(project)
        const { items, total } = filterObservations(raw, query)
        return ok({ items, total, offset: query.offset, limit: query.limit, project: project ?? null })
      }

      if (method === 'GET' && path === '/projects') {
        return ok(await upstream.getProjects())
      }

      if (method === 'GET' && path === '/sessions') {
        const project = await scopeFor(query)
        return ok(await upstream.getSessions(project))
      }

      if (method === 'POST' && path === '/resolve') {
        const text = await readBody()
        let body
        try {
          body = text === '' ? {} : JSON.parse(text)
        } catch {
          return fail(400, 'invalid JSON body', 'bad_request')
        }
        const id = Number(body?.id)
        if (!Number.isInteger(id) || id <= 0) {
          return fail(400, 'invalid id: must be a positive integer', 'bad_request')
        }
        const status = body?.status === undefined ? 'resolved' : String(body.status)
        const project = await scopeFor(query)
        const result = await upstream.resolveViaCli({ id, status, project, workspaceRoot: currentWorkspaceRoot() })
        if (result?.ok !== true) {
          return fail(
            502,
            result?.error ?? 'resolve failed',
            result?.code ?? 'cli_failed',
            result?.hint ?? RESOLVE_FALLBACK_HINT,
          )
        }
        return ok(result)
      }

      // 删除有两种寻址方式，都必须支持：
      //   DELETE /observations/9        —— 便于单测与直接调用
      //   DELETE /observations?id=9     —— 宿主的 connection.fetch.register
      //                                    只支持**精确路径**（其内部是
      //                                    Map<path, route>，无前缀/参数匹配），
      //                                    所以 index.js 只能注册固定路径，
      //                                    id 必须走 query。
      const deleteMatch = DELETE_RE.exec(path)
      const deleteByQuery = method === 'DELETE' && path === '/observations' && query.id !== undefined
      if (deleteMatch || deleteByQuery) {
        if (method !== 'DELETE') return fail(405, 'method not allowed', 'method_not_allowed')
        const rawId = deleteMatch ? deleteMatch[1] : String(query.id)
        const id = Number(rawId)
        // 形状对但 id 不合法 → 400（比 404 更能说明问题；且不打上游）
        if (!/^\d+$/.test(rawId) || !Number.isSafeInteger(id) || id <= 0) {
          return fail(400, `invalid id: ${rawId} (expected a positive integer)`, 'bad_request')
        }
        const project = await scopeFor(query)
        return ok(await upstream.deleteObservation(id, project))
      }

      // 路径存在但方法不对 → 405；否则 404。
      // `/observations` 的 GET 是合法列表路由，而 DELETE 缺 id 属于「请求形状
      // 不对」而非「路径不存在」，也不该被当成 405 —— 让它落到 404，避免把
      // 一次拼错的删除请求说成「方法不允许」。
      const KNOWN = ['/health', '/stats', '/projects', '/sessions', '/resolve']
      if (KNOWN.includes(path)) return fail(405, 'method not allowed', 'method_not_allowed')
      return fail(404, `unknown path: ${path}`, 'not_found')
    } catch (error) {
      if (error instanceof UpstreamError) {
        const status = error.code === 'control_plane_down' ? 503 : (error.status ?? 502)
        return fail(status, error.message, error.code, error.hint)
      }
      // 未预期异常：只回固定文案，绝不把堆栈或内部路径送给客户端。
      return fail(500, 'internal error', 'internal_error')
    }
  }
}
