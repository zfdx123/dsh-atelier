// dsh-memery — Memorix control plane 客户端（唯一碰网络的地方）。
//
// 所有请求都打到固定的本机控制面（默认 http://127.0.0.1:3211）。基址由宿主
// 配置决定，**绝不接受请求方传入的 URL** —— 否则这个转发端点就成了 SSRF
// 跳板。
//
// 错误一律抛 UpstreamError，并带三类信息：
//   status  —— 映射给调用方的 HTTP 状态码
//   code    —— 机器可读分类（control_plane_down / bad_upstream / upstream_error）
//   hint    —— 给人看的下一步（例如「跑 memorix background start」）
import { execFile, spawn } from 'node:child_process'
import { UPSTREAM_DEFAULT } from './logic.js'

export class UpstreamError extends Error {
  constructor(message, { status = 502, code = 'upstream_error', hint } = {}) {
    super(message)
    this.name = 'UpstreamError'
    this.status = status
    this.code = code
    this.hint = hint
  }
}

const CLI_HINT = 'Memorix 控制面未运行。启动：memorix background start（或 memorix serve-http --port 3211）'
const RESOLVE_HINT = 'REST 无 resolve 端点，此操作走 memorix CLI。若 CLI 不可用，请在 Memorix Dashboard 里处理：http://127.0.0.1:3211'

const RESOLVE_STATUSES = ['resolved', 'archived']

function truncate(text, max = 200) {
  const s = String(text ?? '')
  return s.length > max ? `${s.slice(0, max)}…` : s
}

/**
 * 解析一次要执行的可执行文件与参数。
 *
 * Windows 上 npm 的全局 bin 是 .cmd/.ps1 包装，Node 22+ 不能再直接 exec
 * （EINVAL），走 `shell: true` 又会让 Node 打印 DEP0190（args 是拼接而非转义）。
 * 这里改为显式经 cmd.exe 调用：既避开弃用警告，也让参数保持独立传递。
 *
 * 参数全部是**受控值**（id 已 Number() 化、status 已枚举校验、cwd 来自宿主配置），
 * 且每个含特殊字符的参数单独做引号包裹，不存在用户可控字符串注入命令行的路径。
 */
export function buildCliCommand(args) {
  if (process.platform !== 'win32') return { file: 'memorix', args: [...args] }
  const escaped = args.map((a) => {
    const s = String(a)
    return /[\s&|<>^"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  })
  return { file: 'cmd.exe', args: ['/d', '/s', '/c', 'memorix', ...escaped] }
}

/**
 * 短命 CLI 调用：需要读回 stdout/stderr（`memory recent`、`memory resolve`）。
 * 返回 { code, stdout, stderr }，**不抛**。
 */
export function defaultRunCli(args, { timeoutMs = 15000, cwd } = {}) {
  const { file, args: argv } = buildCliCommand(args)
  return new Promise((resolve) => {
    const child = execFile(
      file,
      argv,
      { timeout: timeoutMs, cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code: error === null || error === undefined ? 0 : (typeof error.code === 'number' ? error.code : 1),
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? (error?.message ?? '')),
        })
      },
    )
    child.on('error', (error) => resolve({ code: 1, stdout: '', stderr: String(error?.message ?? error) }))
  })
}

/**
 * 常驻进程型调用的通用原语：stdio ignore + detached + unref。
 *
 * 关键在 `stdio: 'ignore'`：不建管道，Node 就不会等 EOF，调用方立刻拿回控制权。
 * 只要建了管道而子孙进程继承了它，execFile/spawn 的等待就永不结束。
 */
export function spawnDetachedDaemon(file, args, { cwd, env } = {}) {
  try {
    const child = spawn(file, args, { cwd, env, windowsHide: true, detached: true, stdio: 'ignore' })
    child.unref()
    return new Promise((resolve) => {
      let settled = false
      const done = (result) => { if (!settled) { settled = true; resolve(result) } }
      child.once('spawn', () => done({ code: 0, spawned: true, pid: child.pid }))
      child.once('error', (error) => done({ code: 1, spawned: false, stderr: String(error?.message ?? error) }))
      // 兜底：极端情况下 spawn 事件不来，也不该挂住调用方
      setTimeout(() => done({ code: 0, spawned: true, pid: child.pid, assumeSpawned: true }), 2000)
    })
  } catch (error) {
    return Promise.resolve({ code: 1, spawned: false, stderr: String(error?.message ?? error) })
  }
}

/**
 * 常驻进程型 CLI 调用：`memorix background start`。
 *
 * **绝不能用 execFile。** 卡住的机制：该命令会 spawn 一个长期后台守护进程，
 * 守护进程继承父进程的 stdout/stderr 管道；而 Node 的 execFile 要等管道 EOF
 * 才回调，于是 Promise 永远不 resolve —— 表现为「启动卡住」。
 *
 * 守护进程是否就绪由随后的 /health 轮询判定，不依赖它的输出。
 */
export function spawnDaemonCli(args, options = {}) {
  const { file, args: argv } = options.command ?? buildCliCommand(args)
  return spawnDetachedDaemon(file, argv, options)
}

/**
 * @param {{baseUrl?: string, timeoutMs?: number, runCli?: Function}} [options]
 */
export function createUpstream(options = {}) {
  const baseUrl = String(options.baseUrl || UPSTREAM_DEFAULT).replace(/\/+$/, '')
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 10000
  const runCli = typeof options.runCli === 'function' ? options.runCli : defaultRunCli

  function url(path, project) {
    const u = new URL(baseUrl + path)
    if (project !== undefined && project !== null && project !== '') {
      u.searchParams.set('project', String(project))
    }
    return u
  }

  function parseJson(text, path) {
    try {
      return JSON.parse(text)
    } catch {
      throw new UpstreamError(`上游返回的不是 JSON（${path}）：${truncate(text)}`, {
        status: 502,
        code: 'bad_upstream',
      })
    }
  }

  function errorFromResponse(res, text, path) {
    let message = ''
    try {
      const parsed = JSON.parse(text)
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.error === 'string') {
        message = parsed.error
      }
    } catch {
      // 非 JSON 错误体：截断原文，避免把大段 HTML 塞进响应
      message = truncate(text)
    }
    const hint = res.status === 403
      ? '该记忆不属于当前项目作用域。检查面板顶部的 project 标识。'
      : undefined
    return new UpstreamError(
      message || `上游返回 ${res.status}（${path}）`,
      { status: res.status, code: 'upstream_error', hint },
    )
  }

  async function request(method, path, { project, body } = {}) {
    let res
    try {
      res = await fetch(url(path, project), {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      // 连接被拒、DNS、超时 —— 都归为「控制面不可达」
      throw new UpstreamError(`无法连接 Memorix 控制面（${baseUrl}）：${truncate(error?.message ?? error)}`, {
        status: 503,
        code: 'control_plane_down',
        hint: CLI_HINT,
      })
    }
    const text = await res.text()
    if (!res.ok) throw errorFromResponse(res, text, path)
    return text
  }

  async function getJson(path, project) {
    return parseJson(await request('GET', path, { project }), path)
  }

  return {
    baseUrl,
    timeoutMs,
    /** 供 autostart 复用同一个 CLI runner（测试里可注入假 runner）。 */
    runCli,
    /** 探活。**不抛**：面板需要区分「没数据」和「服务没起来」。 */
    async health() {
      try {
        const raw = await getJson('/health')
        return { up: true, raw }
      } catch (error) {
        return { up: false, error: error?.message ?? String(error), code: error?.code }
      }
    },

    getJson,

    async getStats(project) {
      return getJson('/api/stats', project)
    },

    async getProjects() {
      return getJson('/api/projects')
    },

    async listObservations(project) {
      return getJson('/api/observations', project)
    },

    async getSessions(project) {
      return getJson('/api/sessions', project)
    },

    async deleteObservation(id, project) {
      const path = `/api/observations/${Number(id)}`
      return parseJson(await request('DELETE', path, { project }), path)
    },

    /**
     * 软隐藏（resolve）。Memorix 的 REST 面**没有** resolve 端点，所以走 CLI。
     * CLI 不可用或非零退出时如实返回失败 —— 绝不静默当成成功。
     */
    async resolveViaCli({ id, project, status = 'resolved', workspaceRoot } = {}) {
      const numericId = Number(id)
      if (!Number.isInteger(numericId) || numericId <= 0) {
        return { ok: false, error: 'invalid id: must be a positive integer', code: 'bad_request' }
      }
      if (!RESOLVE_STATUSES.includes(status)) {
        return { ok: false, error: `invalid status: expected ${RESOLVE_STATUSES.join('|')}`, code: 'bad_request' }
      }

      const args = ['memory', 'resolve', '--ids', String(numericId), '--status', status, '--json']
      if (workspaceRoot) args.push('--cwd', String(workspaceRoot))

      const result = await runCli(args, { })
      if (result.code !== 0) {
        return {
          ok: false,
          code: 'cli_failed',
          error: truncate(result.stderr || result.stdout || `memorix 退出码 ${result.code}`),
          hint: RESOLVE_HINT,
          command: `memorix ${args.join(' ')}`,
        }
      }
      return { ok: true, stdout: truncate(result.stdout, 1000), command: `memorix ${args.join(' ')}`, scope: project }
    },

    /**
     * 由工作区路径解析 Memorix 的 projectId（形如 `local/dsh-memery`）。
     * 失败返回 undefined：端点层会退化成「不指定 project」，即控制面默认项目。
     */
    async resolveProjectId(workspaceRoot) {
      const args = ['memory', 'recent', '--limit', '1', '--json']
      if (workspaceRoot) args.push('--cwd', String(workspaceRoot))
      const result = await runCli(args)
      if (result.code !== 0) return undefined
      try {
        const parsed = JSON.parse(result.stdout)
        const id = parsed?.project?.id
        return typeof id === 'string' && id !== '' ? id : undefined
      } catch {
        return undefined
      }
    },
  }
}
