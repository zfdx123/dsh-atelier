// dsh-memery — 控制面自动拉起。
//
// 设计目标：用户不该为了看一个面板先去终端敲 `memorix background start`。
// 面板发现控制面不可达时，宿主自动把它拉起来（`memorix background start`
// 本身就是设计成后台常驻的），然后探活；起来之前如实告诉面板「正在启动」。
//
// 三条纪律：
//   1. 只在**确认**不可达时才启动（先探活）——绝不因为一次请求超时就 spawn；
//   2. 同一 host 并发/连续请求只 spawn 一次（共享同一个 in-flight promise +
//      冷却期）——否则每开一次面板就多起一个进程；
//   3. 启动失败或超时**如实返回 failed + 原因**，绝不假装成功。

const DEFAULT_COOLDOWN_MS = 60000
const DEFAULT_PROBE_TIMEOUT_MS = 25000
const DEFAULT_PROBE_INTERVAL_MS = 700

// `memorix background start` 实测约 6 秒内就绪；失败时 CLI 会很快非零退出。
const START_ARGS = ['background', 'start']

export function createAutoStarter(options = {}) {
  const runCli = typeof options.runCli === 'function' ? options.runCli : undefined
  const startCli = typeof options.start === 'function' ? options.start : undefined
  const spawnDaemon = typeof options.spawnDaemon === 'function' ? options.spawnDaemon : undefined
  const probeTimeoutMs = Number.isFinite(options.probeTimeoutMs) ? options.probeTimeoutMs : DEFAULT_PROBE_TIMEOUT_MS
  const probeIntervalMs = Number.isFinite(options.probeIntervalMs) ? options.probeIntervalMs : DEFAULT_PROBE_INTERVAL_MS
  const cooldownMs = Number.isFinite(options.cooldownMs) ? options.cooldownMs : DEFAULT_COOLDOWN_MS
  const now = typeof options.now === 'function' ? options.now : () => Date.now()

  /** host -> { at, state, error } 最近一次尝试，用于冷却 */
  const attempts = new Map()
  /** host -> Promise，保证同一 host 只有一个 in-flight spawn */
  const inflight = new Map()

  async function doStart() {
    if (startCli !== undefined) return startCli()
    // 优先用常驻进程 runner：`background start` 会留下守护进程并继承管道，
    // 用 execFile 会永远等不到 EOF（启动卡住）。
    if (spawnDaemon !== undefined) return spawnDaemon(START_ARGS)
    if (runCli === undefined) return { code: 1, stderr: 'no CLI runner configured' }
    return runCli(START_ARGS, { timeoutMs: probeTimeoutMs + 10000 })
  }

  async function startAndWait({ isUp, host }) {
    const started = await doStart()
    if (started && Number.isFinite(started.code) && started.code !== 0 && started.code !== null) {
      const detail = String(started.stderr || started.stdout || '').trim()
      return {
        state: 'failed',
        error: `memorix background start 失败（退出码 ${started.code}）${detail ? `：${detail}` : ''}`,
      }
    }

    const deadline = now() + probeTimeoutMs
    while (now() < deadline) {
      await new Promise((r) => setTimeout(r, probeIntervalMs))
      try {
        if (await isUp()) {
          return { state: 'up', started: true, command: `memorix ${START_ARGS.join(' ')}` }
        }
      } catch {
        // 探活失败本身不是错误：继续等到 deadline
      }
    }
    return {
      state: 'failed',
      error: `已执行 memorix background start，但 ${Math.round(probeTimeoutMs / 1000)} 秒内未就绪（超时）`,
    }
  }

  return {
    /**
     * 确保控制面可用。返回：
     *   { state: 'up' }                                  —— 已经可用，什么都没做
     *   { state: 'up', started: true }                   —— 本次请求把它拉起来了
     *   { state: 'starting' }                            —— 另一个请求正在拉，等它
     *   { state: 'failed', error }                       —— 拉不起来，如实报错
     */
    async ensureUp({ isUp, host }) {
      try {
        if (await isUp()) return { state: 'up' }
      } catch {
        // 探活抛错按不可达处理
      }

      const key = String(host ?? 'default')
      const previous = attempts.get(key)
      if (previous !== undefined && now() - previous.at < cooldownMs) {
        return { state: previous.state, error: previous.error, cooled: true }
      }

      const pending = inflight.get(key)
      if (pending !== undefined) {
        await pending
        const latest = attempts.get(key)
        return latest !== undefined && latest.state === 'failed'
          ? { state: 'failed', error: latest.error }
          : { state: 'starting' }
      }

      const task = (async () => {
        try {
          const result = await startAndWait({ isUp, host })
          attempts.set(key, { at: now(), state: result.state, error: result.error })
          return result
        } catch (error) {
          const failed = { state: 'failed', error: `启动控制面时出错：${error?.message ?? error}` }
          attempts.set(key, { at: now(), state: 'failed', error: failed.error })
          return failed
        } finally {
          inflight.delete(key)
        }
      })()

      inflight.set(key, task)
      const result = await task
      return result.state === 'up' && result.started === true
        ? { state: 'up', started: true, command: result.command }
        : result
    },
  }
}
