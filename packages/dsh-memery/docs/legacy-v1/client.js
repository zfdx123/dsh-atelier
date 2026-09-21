// dsh-memery — 客户端 bundle（宿主模块加载器格式）。
//
// 侧栏底部的「记忆」面板 + 设置页「记忆」分区。数据来自本插件宿主半注册的
// 同源端点 /api/dsh-memery/*：浏览器不直连 Memorix 的 3211，所以不需要 CORS，
// 也复用宿主的鉴权栅栏。
//
// 契约要点（错了面板就永远不出现，且只在挂载阶段报错）：
//   · __ModuleLoader__.load 的 id 必须等于包名 'dsh-memery'
//   · 只允许 require('react') 与 require('react/jsx-runtime')
//   · sidebar.footer.action 的注册项必须带 id；owner 只传 { wide }
//
// ── 状态机纪律（修过一个真实的假失败态）────────────────────────────────────
// 旧版把「加载中」渲染成和「失败」一样的样子（地址显示 '-'、错误显示
// 'unknown'），而且请求没有超时——一次卡住的请求就让面板永远停在那个假失败
// 态。现在显式区分四态：loading / connecting（宿主正在自动拉起控制面）/
// ready / failed，每个请求都带 AbortSignal 超时，且每个状态都给出下一步动作。
window.__ModuleLoader__.load({
  id: 'dsh-memery',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const jsx = require('react/jsx-runtime')
    const h = React.createElement

    const API = '/api/dsh-memery'
    const DASHBOARD = 'http://127.0.0.1:3211'
    const REQUEST_TIMEOUT_MS = 20000
    // 控制面首次启动实测约 6 秒；留足余量，轮询到头就停手，改为让用户点重试。
    const MAX_AUTO_RETRIES = 15
    const RETRY_DELAY_MS = 1500

    // ---------------------------------------------------------------- styles
    // 只命中本插件自己的 .dsh-memory 容器，不依赖任何外壳类名哈希。
    // 颜色优先取外壳令牌，缺令牌时回落到内置亮/暗色。
    const CSS = `
.dsh-memory{--dm-bg:var(--dsw-alias-bg-layer-1,#ffffff);--dm-bg2:var(--dsw-alias-bg-layer-2,#f6f7f9);
  --dm-bg3:var(--dsw-alias-bg-base,#ffffff);--dm-overlay:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1,#ffffff));
  --dm-fg:var(--dsw-alias-label-primary,#1f2328);--dm-dim:var(--dsw-alias-label-secondary,#6b7280);
  --dm-line:var(--dsw-alias-border-l1,#e5e7eb);--dm-line2:var(--dsw-alias-border-l2,#d1d5db);
  --dm-brand:var(--dsw-alias-brand-primary,#2563eb);
  --dm-ok:var(--dsw-alias-state-success-primary,#15803d);
  --dm-warn:var(--dsw-alias-state-warn-primary,#b45309);
  --dm-err:var(--dsw-alias-state-error-primary,#b91c1c);
  --dm-tint:color-mix(in srgb, var(--dm-brand) 9%, transparent);
  --dm-tint2:color-mix(in srgb, var(--dm-brand) 5%, transparent);
  --dm-err-tint:color-mix(in srgb, var(--dm-err) 10%, transparent);
  --dm-ok-tint:color-mix(in srgb, var(--dm-ok) 10%, transparent);
  font-family:inherit;font-size:13px;line-height:1.5;color:var(--dm-fg);
  -webkit-font-smoothing:antialiased}
.dsh-memory .dm-trigger{display:inline-flex;align-items:center;gap:8px;width:calc(100% + 4px);
  height:42px;margin:0 -2px;padding:0 10px 0 8px;border:none;border-radius:12px;
  background:transparent;color:var(--dsw-alias-label-primary,var(--dm-fg));font:inherit;font-size:14px;
  cursor:pointer;overflow:hidden;text-align:left}
.dsh-memory .dm-trigger:hover{background:var(--dm-tint2)}
.dsh-memory .dm-trigger[data-open]{background:var(--dm-tint)}
.dsh-memory .dm-trigger:focus-visible{outline:2px solid var(--dm-brand);outline-offset:2px}
.dsh-memory .dm-layer.rail .dm-trigger{justify-content:center;gap:0;width:36px;height:36px;
  padding:0;margin:0;border-radius:50%}
.dsh-memory .dm-trigger .dm-meta{margin-left:auto;font-size:11px;color:var(--dm-dim);
  font-variant-numeric:tabular-nums;flex:none}
.dsh-memory .dm-glyph{font-size:14px;line-height:1;flex:none}
.dsh-memory .dm-chev{transition:transform .16s ease}
.dsh-memory .dm-trigger[data-open] .dm-chev{transform:rotate(180deg)}
.dsh-memory *,.dsh-memory *::before,.dsh-memory *::after{box-sizing:border-box}
.dsh-memory .dm-layer{position:relative;flex:none;display:flex;align-items:center;width:100%;height:42px;margin:8px 0 0}
.dsh-memory .dm-layer.rail{width:36px;height:36px;margin:0}
.dsh-memory .dm-flyout{position:fixed;z-index:60;display:flex;flex-direction:column;
  background:var(--dm-bg);border:1px solid var(--dm-line);border-radius:14px;
  box-shadow:0 18px 44px rgba(0,0,0,.18),0 2px 8px rgba(0,0,0,.06);overflow:hidden;
  color:var(--dm-fg)}
.dsh-memory .dm-head{display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:12px 14px;border-bottom:1px solid var(--dm-line);background:var(--dm-bg)}
.dsh-memory .dm-title{font-weight:600;font-size:13.5px;letter-spacing:.01em;display:flex;align-items:center;gap:7px}
.dsh-memory .dm-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dm-dim);
  box-shadow:0 0 0 3px color-mix(in srgb, var(--dm-dim) 18%, transparent)}
.dsh-memory .dm-dot.ok{background:var(--dm-ok);box-shadow:0 0 0 3px color-mix(in srgb, var(--dm-ok) 20%, transparent)}
.dsh-memory .dm-dot.warn{background:var(--dm-warn);box-shadow:0 0 0 3px color-mix(in srgb, var(--dm-warn) 20%, transparent)}
.dsh-memory .dm-dot.bad{background:var(--dm-err);box-shadow:0 0 0 3px color-mix(in srgb, var(--dm-err) 20%, transparent)}
.dsh-memory .dm-sub{color:var(--dm-dim);font-size:11px;margin-top:2px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-memory .dm-body{overflow:auto;padding:16px 18px;display:flex;flex-direction:column;gap:16px;min-height:0}
.dsh-memory .dm-pills{display:flex;gap:8px;flex-wrap:wrap}
.dsh-memory .dm-pill{padding:3px 9px;border-radius:999px;border:1px solid var(--dm-line);
  background:var(--dm-bg2);color:var(--dm-dim);font-size:11px;white-space:nowrap;line-height:1.7}
.dsh-memory .dm-pill b{color:var(--dm-fg);font-weight:600;font-variant-numeric:tabular-nums;margin-left:2px}
.dsh-memory .dm-controls{display:flex;gap:6px;flex-wrap:wrap}
.dsh-memory input[type=text],.dsh-memory select{font:inherit;font-size:12.5px;padding:6px 9px;border-radius:8px;
  color:var(--dm-fg);background:var(--dm-bg);border:1px solid var(--dm-line);min-width:0}
.dsh-memory input[type=text]::placeholder{color:var(--dm-dim)}
.dsh-memory input[type=text]:hover,.dsh-memory select:hover{border-color:var(--dm-line2)}
.dsh-memory input[type=text]:focus,.dsh-memory select:focus{outline:2px solid var(--dm-brand);outline-offset:-1px}
.dsh-memory .dm-list{display:flex;flex-direction:column;gap:2px;min-height:40px}
.dsh-memory .dm-item{text-align:left;width:100%;appearance:none;cursor:pointer;font:inherit;color:inherit;
  padding:10px 12px;border-radius:10px;border:1px solid transparent;background:transparent;display:block;
  transition:background .12s,border-color .12s;box-sizing:border-box;max-width:100%;overflow:hidden}
.dsh-memory .dm-item:hover{background:var(--dm-bg2)}
.dsh-memory .dm-item.static{cursor:default}
.dsh-memory .dm-item.static:hover{background:transparent}
.dsh-memory .dm-item.on{background:var(--dm-tint);border-color:var(--dm-brand)}
.dsh-memory .dm-item .t{font-weight:600;font-size:13px;line-height:1.45;display:block;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.dsh-memory .dm-item .m{font-size:11px;line-height:1.4;color:var(--dm-dim);display:block;
  margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;
  font-variant-numeric:tabular-nums}
.dsh-memory .dm-detail{display:flex;flex-direction:column;gap:9px;padding:12px;border-radius:12px;
  background:var(--dm-bg2);border:1px solid var(--dm-line)}
.dsh-memory .dm-detail .k{font-size:10px;letter-spacing:.06em;text-transform:uppercase;
  color:var(--dm-dim);font-weight:600}
.dsh-memory .dm-detail .v{white-space:pre-wrap;word-break:break-word;margin-top:2px}
.dsh-memory .dm-detail ul{margin:2px 0 0;padding-left:18px}
.dsh-memory .dm-detail li{margin:1px 0}
.dsh-memory .dm-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dsh-memory button.dm-btn{font:inherit;font-size:12.5px;cursor:pointer;padding:6px 11px;border-radius:8px;
  color:var(--dm-fg);background:var(--dm-bg);border:1px solid var(--dm-line);
  transition:background .12s,border-color .12s;white-space:nowrap}
.dsh-memory button.dm-btn:hover:not(:disabled){background:var(--dm-bg2);border-color:var(--dm-line2)}
.dsh-memory button.dm-btn:focus-visible{outline:2px solid var(--dm-brand);outline-offset:1px}
.dsh-memory button.dm-btn:disabled{opacity:.45;cursor:default}
.dsh-memory button.dm-btn.primary{background:var(--dm-brand);border-color:var(--dm-brand);color:#fff}
.dsh-memory button.dm-btn.primary:hover:not(:disabled){opacity:.9;background:var(--dm-brand)}
.dsh-memory button.dm-btn.danger{color:var(--dm-err);border-color:var(--dm-line)}
.dsh-memory button.dm-btn.danger:hover:not(:disabled){background:var(--dm-err-tint);border-color:var(--dm-err)}
.dsh-memory .dm-state{display:flex;flex-direction:column;gap:8px;align-items:flex-start;
  padding:16px;border-radius:12px;background:var(--dm-bg2);border:1px solid var(--dm-line)}
.dsh-memory .dm-state.bad{border-color:var(--dm-err);background:var(--dm-err-tint)}
.dsh-memory .dm-state.ok{border-color:var(--dm-ok);background:var(--dm-ok-tint)}
.dsh-memory .dm-state .big{font-weight:600;font-size:13.5px}
.dsh-memory .dm-state .why{color:var(--dm-dim);font-size:11.5px;word-break:break-word;line-height:1.6}
.dsh-memory .dm-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;
  background:var(--dm-bg);border:1px solid var(--dm-line);border-radius:6px;padding:2px 6px;user-select:all}
.dsh-memory .dm-snippet{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;
  background:var(--dm-bg);border:1px solid var(--dm-line);border-radius:8px;padding:10px 11px;
  width:100%;user-select:all;word-break:break-word;line-height:1.65;color:var(--dm-fg)}
.dsh-memory .dm-spin{width:14px;height:14px;border-radius:50%;flex:none;
  border:2px solid var(--dm-line);border-top-color:var(--dm-brand);animation:dm-spin .7s linear infinite}
@keyframes dm-spin{to{transform:rotate(360deg)}}
.dsh-memory .dm-foot{font-size:11px;color:var(--dm-dim);line-height:1.6}
.dsh-memory .dm-foot .dm-code{margin:0 2px}
.dsh-memory .dm-err{color:var(--dm-err);background:var(--dm-err-tint);border:1px solid var(--dm-err);
  border-radius:8px;padding:9px 11px;font-size:12px;line-height:1.6}
.dsh-memory .dm-ok{color:var(--dm-ok);background:var(--dm-ok-tint);border:1px solid var(--dm-ok);
  border-radius:8px;padding:9px 11px;font-size:12px;line-height:1.6}
.dsh-memory .dm-empty{color:var(--dm-dim);text-align:center;padding:16px 2px}
.dsh-memory .dm-skel{height:40px;border-radius:10px;background:var(--dm-bg2);animation:dm-pulse 1.2s ease-in-out infinite}
@keyframes dm-pulse{50%{opacity:.45}}
.dsh-memory .dm-sep{height:1px;background:var(--dm-line);margin:2px 0}
.dsh-memory .dm-sectlabel{font-size:10px;letter-spacing:.07em;text-transform:uppercase;
  color:var(--dm-dim);font-weight:600;margin-bottom:-8px}
.dsh-memory a{color:var(--dm-brand);text-decoration:none}
.dsh-memory a:hover{text-decoration:underline}
@media (prefers-reduced-motion:reduce){
  .dsh-memory *,.dsh-memory *::before,.dsh-memory *::after{animation-duration:.01ms!important;transition-duration:.01ms!important}
}
`
    const STYLE_ID = 'dsh-memery-style'

    /**
     * 注入样式表。**必须挂在模块作用域、不随任何组件卸载移除。**
     *
     * 这里踩过一个真实的坑：样式原本注入在侧栏组件的 useEffect 里、并在清理
     * 函数中 remove()。但侧栏与设置页是两个独立挂载的实例，「已存在就跳过」的
     * guard 让第二个实例不注入 —— 于是第一个实例卸载时把 <style> 删掉，而另一个
     * 实例还在用。症状是样式整段失效：pill 没有底色、标题不再省略号而是折行。
     * 多实例共享的资源不能由其中一个实例的生命周期持有。
     */
    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      const host = document.head || document.documentElement
      if (host !== undefined) host.appendChild(style)
    }
    ensureStyle()

    // ------------------------------------------------------------- pure logic
    // 不碰 React 也不碰网络，导出给 vm 单测（见 test/client-logic.test.js）。
    function formatCount(n) {
      const num = Number(n)
      if (!Number.isFinite(num)) return '0'
      return num.toLocaleString('en-US')
    }

    function humanAge(iso, now = Date.now()) {
      const t = Date.parse(iso)
      if (!Number.isFinite(t)) return ''
      const sec = Math.max(0, Math.floor((now - t) / 1000))
      if (sec < 60) return '刚刚'
      if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`
      if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`
      if (sec < 2592000) return `${Math.floor(sec / 86400)} 天前`
      return `${Math.floor(sec / 2592000)} 个月前`
    }

    function detailFields(observation) {
      const o = observation || {}
      const out = []
      if (o.narrative) out.push(['叙述', String(o.narrative)])
      if (Array.isArray(o.facts) && o.facts.length) out.push(['事实', o.facts.map(String)])
      if (Array.isArray(o.filesModified) && o.filesModified.length) out.push(['涉及文件', o.filesModified.map(String)])
      if (Array.isArray(o.concepts) && o.concepts.length) out.push(['概念', o.concepts.map(String)])
      if (o.source) out.push(['来源', String(o.source)])
      if (o.status) out.push(['状态', String(o.status)])
      if (o.createdAt) out.push(['创建', String(o.createdAt)])
      return out
    }

    function deleteConfirmLabel(title) {
      const t = title === undefined || title === null || String(title).trim() === '' ? '这条记忆' : String(title)
      return `确认永久删除「${t}」？此操作不可撤销。`
    }

    /**
     * 把 /health 的响应折算成显式四态之一。
     * 这是面板不再出现「假失败态」的关键：状态互斥，且各有下一步动作。
     */
    function connectionStateOf(health) {
      const d = health || {}
      if (d.up === true) return { kind: 'ready' }
      if (d.starting === true) return { kind: 'connecting', text: '正在启动 Memorix 控制面…' }
      return {
        kind: 'failed',
        why: d.autostartError || d.error || '未知原因',
        hint: d.hint,
      }
    }

    /** 带超时的同源请求。宿主端点用 { ok, data } / { ok:false, error, hint } 信封。 */
    async function request(path, options) {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined
      const timer = controller !== undefined ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : undefined
      let res
      try {
        res = await fetch(API + path, Object.assign({}, options, controller ? { signal: controller.signal } : {}))
      } catch (error) {
        const aborted = error && (error.name === 'AbortError' || error.name === 'TimeoutError')
        throw new Error(
          aborted
            ? `宿主端点请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒无响应）`
            : `无法访问宿主端点：${(error && error.message) || error}`,
        )
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      let payload
      try {
        payload = await res.json()
      } catch {
        throw new Error(`宿主端点返回的不是 JSON（HTTP ${res.status}）`)
      }
      if (payload && payload.ok === true) return payload.data
      const err = new Error((payload && payload.error) || `请求失败（HTTP ${res.status}）`)
      err.hint = payload && payload.hint
      throw err
    }

    const api = {
      health: (workspace) => request(`/health?${withWorkspace(workspace, {})}`),
      stats: (workspace) => request(`/stats?${withWorkspace(workspace, {})}`),
      observations: (params) => request(`/observations?${new URLSearchParams(params).toString()}`),
      resolve: (id, status) =>
        request('/resolve', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, status: status || 'resolved' }),
        }),
      remove: (id) => request(`/observations?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
    }

    // -------------------------------------------------------------- components
    const TYPE_OPTIONS = [
      '',
      'decision',
      'gotcha',
      'problem-solution',
      'how-it-works',
      'what-changed',
      'discovery',
      'why-it-exists',
      'trade-off',
      'reasoning',
      'session-request',
    ]
    const SOURCE_OPTIONS = ['', 'git', 'agent', 'manual']
    const PAGE = 20
    /** 设置页只做预览，完整列表在侧栏面板。 */
    const SETTINGS_PREVIEW = 5

    /**
     * 从面板的 standardProps 里取「用户正在看的工作区路径」，随请求带给宿主。
     *
     * 为什么必须这么做：宿主侧的 workspaceRegistry 只给出工作区**列表**，不给出
     * 「当前是哪一个」；而它回落到 process.cwd() 时拿到的是 dsh 进程的目录
     * （实测 C:\Users\<用户>），于是项目身份解析错、面板永远「项目未解析」。
     * 面板自己最清楚用户在看哪个工作区，所以由它带上。
     *
     * 取不到就返回 undefined——宿主仍会按自己的候选链解析，不是硬依赖。
     */
    function workspacePathOf(props) {
      try {
        const useWorkspaces = props && props.useWorkspaces
        if (typeof useWorkspaces !== 'function') return undefined
        const snapshot = useWorkspaces((s) => s)
        const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : []
        for (const item of items) {
          if (item && typeof item.path === 'string' && item.path.trim() !== '') return item.path.trim()
        }
      } catch {
        // standardProps 的形状随宿主版本变化；取不到不是错误
      }
      return undefined
    }

    /** 把 workspace 参数拼进查询串（宿主据此解析项目身份）。 */
    function withWorkspace(workspace, params) {
      const q = Object.assign({}, params)
      if (typeof workspace === 'string' && workspace !== '') q.workspace = workspace
      return new URLSearchParams(q).toString()
    }

    /**
     * 把浮层锚到触发元素旁边，并夹在视口内。
     *
     * 取触发器的 getBoundingClientRect()，优先摆在它**左侧**（侧栏在左，浮层往
     * 右会盖住主区域）；左边放不下就改摆右侧。上下同样夹取，避免超出视口。
     * 比写死 `left:12 / bottom:62` 可靠：侧栏宽/窄、窗口尺寸、以及设置页里的
     * 嵌入位置都不同。
     */
    /** 视口尺寸。不能只判断 `typeof window !== 'undefined'`：宿主环境里
     *  window 可能存在但没有 innerWidth/innerHeight，那样会算出 NaN。 */
    function viewportSize() {
      const w =
        typeof window !== 'undefined' && Number.isFinite(window.innerWidth) && window.innerWidth > 0
          ? window.innerWidth
          : 1280
      const h =
        typeof window !== 'undefined' && Number.isFinite(window.innerHeight) && window.innerHeight > 0
          ? window.innerHeight
          : 800
      return { vw: w, vh: h }
    }

    function computeAnchor(rect, size) {
      const { vw, vh } = viewportSize()
      const width = size && size.width ? size.width : 400
      const height = size && size.height ? size.height : 520
      const gap = 10
      const pad = 8
      const height_ = Math.min(height, Math.max(240, vh - pad * 2))

      if (rect === null || rect === undefined) {
        return { left: pad, top: Math.max(pad, vh - height_ - 70), width, maxHeight: height_ }
      }

      const leftOfTrigger = rect.left - width - gap
      const fitsLeft = leftOfTrigger >= pad
      const left = fitsLeft ? leftOfTrigger : Math.min(rect.right + gap, vw - width - pad)
      const top = Math.min(Math.max(pad, rect.bottom - height_), vh - height_ - pad)

      return {
        left: Math.max(pad, Math.round(left)),
        top: Math.max(pad, Math.round(top)),
        width,
        maxHeight: height_,
      }
    }

    /** 展开时测量锚点；窗口尺寸变化后重算。 */
    function useAnchor(open, ref, size) {
      const [anchor, setAnchor] = React.useState(null)
      React.useEffect(() => {
        if (!open) return undefined
        const measure = () => {
          const el = ref.current
          setAnchor(computeAnchor(el ? el.getBoundingClientRect() : null, size))
        }
        measure()
        if (typeof window === 'undefined') return undefined
        window.addEventListener('resize', measure)
        return () => window.removeEventListener('resize', measure)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [open])
      return anchor
    }

    function Skeleton() {
      return h(
        'div',
        { className: 'dm-list' },
        [0, 1, 2].map((i) => h('div', { key: i, className: 'dm-skel' })),
      )
    }

    function StateBox({ kind, title, why, hint, onRetry }) {
      return h(
        'div',
        { className: kind === 'failed' ? 'dm-state bad' : 'dm-state' },
        h(
          'div',
          { className: 'dm-actions' },
          kind === 'connecting' ? h('span', { className: 'dm-spin' }) : null,
          h('span', { className: 'big' }, title),
        ),
        why ? h('div', { className: 'why' }, why) : null,
        hint ? h('div', { className: 'why' }, hint) : null,
        h(
          'div',
          { className: 'dm-actions' },
          h('button', { className: 'dm-btn', onClick: onRetry }, '重试'),
          h('a', { className: 'dm-btn', href: DASHBOARD, target: '_blank', rel: 'noreferrer' }, '打开 Dashboard'),
        ),
      )
    }

    /** 面板数据。health 是唯一真相源；ready 之后才拉 stats 与列表。 */
    function useMemoryData(refreshKey, workspace) {
      const [health, setHealth] = React.useState({ loading: true, data: undefined, error: undefined })
      const [detail, setDetail] = React.useState({ loading: false, data: undefined, error: undefined })
      const [nonce, setNonce] = React.useState(0)
      const retries = React.useRef(0)

      const retry = React.useCallback(() => {
        retries.current = 0
        setNonce((n) => n + 1)
      }, [])

      // workspace 变化（用户切工作区）时必须重新解析项目身份并重取数据，
      // 所以它进依赖数组。undefined 是合法值（宿主自己解析）。
      const wsKey = workspace || ''

      // 第一层：health（宿主端会把控制面自动拉起来）
      React.useEffect(() => {
        let alive = true
        let timer
        api.health(wsKey).then(
          (data) => {
            if (!alive) return
            setHealth({ loading: false, data, error: undefined })
            // 控制面正在被拉起 → 自动轮询；轮到头就停手，避免无限请求
            if (connectionStateOf(data).kind === 'connecting' && retries.current < MAX_AUTO_RETRIES) {
              retries.current += 1
              timer = setTimeout(() => {
                if (alive) setNonce((n) => n + 1)
              }, RETRY_DELAY_MS)
            }
          },
          (error) => {
            if (alive) setHealth({ loading: false, data: undefined, error })
          },
        )
        return () => {
          alive = false
          if (timer !== undefined) clearTimeout(timer)
        }
      }, [nonce, refreshKey, wsKey])

      const state = health.loading
        ? { kind: 'loading' }
        : health.data === undefined
          ? { kind: 'failed', why: health.error && health.error.message, hint: health.error && health.error.hint }
          : connectionStateOf(health.data)

      const project = health.data && health.data.project

      // 第二层：内容，只在就绪后拉
      React.useEffect(() => {
        if (state.kind !== 'ready') return undefined
        let alive = true
        setDetail({ loading: true, data: undefined, error: undefined })
        Promise.all([
          api.stats(wsKey),
          api.observations(withWorkspace(wsKey, { limit: String(PAGE), offset: '0' })),
        ]).then(
          ([stats, observations]) => {
            if (alive) setDetail({ loading: false, data: { stats, observations }, error: undefined })
          },
          (error) => {
            if (alive) setDetail({ loading: false, data: undefined, error })
          },
        )
        return () => {
          alive = false
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [state.kind, project, refreshKey, nonce, wsKey])

      return { state, health: health.data, detail, retry, nonce }
    }

    /** 单条记忆行。 */
    /**
     * 单条记忆行。
     * 没有 onToggle 时渲染成静态行而不是按钮——设置页只做预览，一个点了没反应
     * 的按钮比不可点的行更让人困惑。
     */
    function MemoryRow({ item, selected, onToggle }) {
      const meta = [item.type, item.source, item.createdAt ? humanAge(item.createdAt) : '', `#${item.id}`]
        .filter(Boolean)
        .join(' · ')
      const body = [
        h('span', { key: 't', className: 't' }, String(item.title || item.entityName || '(无标题)')),
        h('span', { key: 'm', className: 'm' }, meta),
      ]
      const className = selected ? 'dm-item on' : 'dm-item'
      if (typeof onToggle !== 'function') {
        return h('div', { className: `${className} static` }, body)
      }
      return h('button', { type: 'button', className, onClick: onToggle }, body)
    }

    /**
     * 空状态。以前这里只渲染一行「没有匹配的记忆」，看起来像坏了。
     * 现在把三种「空」分开说清楚，并给出下一步能做什么：
     *   · 有筛选条件 → 没搜到，给「清除筛选」
     *   · 项目没解析 → 说明为什么（工作区不是 Git 仓库）
     *   · 项目是空的 → 告诉用户记忆由模型写，并给出可粘贴的指令
     */
    function EmptyState({ project, workspace, hasFilter, onClearFilter }) {
      if (hasFilter) {
        return h(
          'div',
          { className: 'dm-state' },
          h('div', { className: 'big' }, '没有匹配的记忆'),
          h('div', { className: 'why' }, '当前的关键词/类型/来源筛选没有命中。'),
          h(
            'div',
            { className: 'dm-actions' },
            h('button', { className: 'dm-btn', onClick: onClearFilter }, '清除筛选'),
          ),
        )
      }

      if (!project) {
        return h(
          'div',
          { className: 'dm-state' },
          h('div', { className: 'big' }, '项目未解析'),
          h('div', { className: 'why' }, 'Memorix 用 Git 仓库根判定项目身份，没能从下面这个路径解析出项目：'),
          h('div', { className: 'why' }, h('span', { className: 'dm-code' }, workspace || '(未知)')),
          h(
            'div',
            { className: 'why' },
            '若是新目录，先初始化 Git 仓库；或设 DSH_MEMERY_WORKSPACE_ROOT / DSH_MEMERY_PROJECT 显式指定。',
          ),
        )
      }

      return h(
        'div',
        { className: 'dm-state' },
        h('div', { className: 'big' }, '这个项目还没有记忆'),
        h(
          'div',
          { className: 'why' },
          `项目 ${project} 的记忆池是空的。这是正常的——记忆由模型在干活的过程中写入，不是自动灌入的。`,
        ),
        h('div', { className: 'why' }, '想让模型现在写一条，把下面这句发给它：'),
        h(
          'div',
          { className: 'dm-snippet' },
          `用 mcp__memorix__memorix_store 记一条：entityName=<模块名>, type=decision, title=<标题>, narrative=<为什么这么选>`,
        ),
        h('div', { className: 'why' }, 'MCP 工具没出现在工具列表里，就去 设置 → MCP 服务器 确认 memorix 已挂载。'),
      )
    }

    /**
     * 列表区。把「加载 / 出错 / 空 / 有数据」四个分支拆开写——
     * 之前嵌套三元里漏了一个右括号，嵌套超过三层就不该再硬写了。
     */
    function MemoryList({ list, selected, onSelect, project, workspace, hasFilter, onClearFilter }) {
      if (list.loading) return h(Skeleton, null)
      if (list.error) return h('div', { className: 'dm-err' }, list.error.message)
      const items = (list.data && list.data.items) || []
      if (items.length === 0) {
        return h(EmptyState, { project, workspace, hasFilter, onClearFilter })
      }
      return h(
        'div',
        { className: 'dm-list' },
        items.map((item) =>
          h(MemoryRow, {
            key: String(item.id),
            item,
            selected: selected !== null && selected.id === item.id,
            onToggle: () => onSelect(selected !== null && selected.id === item.id ? null : item),
          }),
        ),
      )
    }

    /**
     * 列表数据 hook。侧栏面板（带筛选/分页）与设置页（只取前几条）共用，
     * 避免两处各写一份取数逻辑而行为漂移。
     */
    function useObservationList({
      enabled,
      workspace,
      q = '',
      type = '',
      source = '',
      page = 0,
      pageSize = PAGE,
      refreshKey = 0,
      nonce = 0,
    }) {
      const [list, setList] = React.useState({ loading: false, data: undefined, error: undefined })
      React.useEffect(() => {
        if (!enabled) return undefined
        let alive = true
        setList({ loading: true, data: undefined, error: undefined })
        api
          .observations(
            withWorkspace(workspace, {
              q,
              type,
              source,
              limit: String(pageSize),
              offset: String(page * pageSize),
            }),
          )
          .then(
            (data) => {
              if (alive) setList({ loading: false, data, error: undefined })
            },
            (error) => {
              if (alive) setList({ loading: false, data: undefined, error })
            },
          )
        return () => {
          alive = false
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [enabled, workspace, q, type, source, page, pageSize, refreshKey, nonce])
      return list
    }

    function MemoryPanel({ onClose, refreshKey, workspace }) {
      const { state, health, detail, retry } = useMemoryData(refreshKey, workspace)
      const [q, setQ] = React.useState('')
      const [type, setType] = React.useState('')
      const [source, setSource] = React.useState('')
      const [page, setPage] = React.useState(0)
      const [selected, setSelected] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)

      const ready = state.kind === 'ready'
      const project = health && health.project

      // 筛选/分页变化时重新取列表（首屏那一份由 useMemoryData 覆盖）
      const list = useObservationList({
        enabled: ready,
        workspace,
        q,
        type,
        source,
        page,
        refreshKey,
      })

      async function act(label, fn) {
        setBusy(true)
        setNotice(null)
        try {
          await fn()
          setNotice({ kind: 'ok', text: label })
          setSelected(null)
          retry()
        } catch (error) {
          setNotice({ kind: 'err', text: error.message, hint: error.hint })
        } finally {
          setBusy(false)
        }
      }

      const stats = (detail.data && detail.data.stats) || {}
      const retention = stats.retention || {}
      // 列表正在加载时用概览里的总数兜底，避免分页器显示 0
      const total = (list.data && list.data.total) || stats.observations || 0
      const pages = Math.max(1, Math.ceil(total / PAGE))
      const dotClass = ready ? 'ok' : state.kind === 'loading' || state.kind === 'connecting' ? 'warn' : 'bad'

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'dm-head' },
          h(
            'div',
            null,
            h('div', { className: 'dm-title' }, h('span', { className: `dm-dot ${dotClass}` }), '记忆'),
            h(
              'div',
              { className: 'dm-sub' },
              ready ? (project ? `项目 ${project}` : '项目未解析（工作区是 Git 仓库吗？）') : 'Memorix',
            ),
          ),
          h(
            'div',
            { className: 'dm-actions' },
            h(
              'button',
              { className: 'dm-btn primary', onClick: retry, disabled: busy || state.kind === 'loading' },
              '刷新',
            ),
            h('a', { className: 'dm-btn', href: DASHBOARD, target: '_blank', rel: 'noreferrer' }, 'Dashboard'),
            onClose ? h('button', { className: 'dm-btn', onClick: onClose }, '收起') : null,
          ),
        ),

        h(
          'div',
          { className: 'dm-body' },
          state.kind === 'loading'
            ? h(
                'div',
                { className: 'dm-state' },
                h(
                  'div',
                  { className: 'dm-actions' },
                  h('span', { className: 'dm-spin' }),
                  h('span', { className: 'big' }, '正在连接…'),
                ),
              )
            : null,

          state.kind === 'connecting'
            ? h(StateBox, {
                kind: 'connecting',
                title: '正在自动启动 Memorix 控制面…',
                why: '首次启动通常几秒，面板会自动重试，不需要你操作。',
                onRetry: retry,
              })
            : null,

          state.kind === 'failed'
            ? h(StateBox, {
                kind: 'failed',
                title: '控制面不可用',
                why: state.why,
                hint: state.hint,
                onRetry: retry,
              })
            : null,

          state.kind === 'failed'
            ? h(
                'div',
                { className: 'dm-foot' },
                '手动启动：',
                h('span', { className: 'dm-code' }, 'memorix background start'),
              )
            : null,

          ready
            ? detail.loading
              ? h(Skeleton, null)
              : h(
                  'div',
                  null,
                  h(
                    'div',
                    { className: 'dm-pills' },
                    h('span', { className: 'dm-pill' }, '记忆 ', h('b', null, formatCount(stats.observations))),
                    h('span', { className: 'dm-pill' }, '活跃 ', h('b', null, formatCount(retention.active))),
                    h('span', { className: 'dm-pill' }, '归档 ', h('b', null, formatCount(retention.archive))),
                    health && health.version
                      ? h('span', { className: 'dm-pill' }, 'v', h('b', null, health.version))
                      : null,
                  ),
                  detail.error ? h('div', { className: 'dm-err' }, detail.error.message) : null,
                )
            : null,

          ready
            ? h(
                'div',
                { className: 'dm-controls' },
                h('input', {
                  type: 'text',
                  placeholder: '搜索标题/叙述…',
                  value: q,
                  style: { flex: '1 1 120px' },
                  onChange: (e) => {
                    setQ(e.target.value)
                    setPage(0)
                    setSelected(null)
                  },
                }),
                h(
                  'select',
                  {
                    value: type,
                    onChange: (e) => {
                      setType(e.target.value)
                      setPage(0)
                      setSelected(null)
                    },
                  },
                  TYPE_OPTIONS.map((t) => h('option', { key: t || 'all', value: t }, t === '' ? '全部类型' : t)),
                ),
                h(
                  'select',
                  {
                    value: source,
                    onChange: (e) => {
                      setSource(e.target.value)
                      setPage(0)
                      setSelected(null)
                    },
                  },
                  SOURCE_OPTIONS.map((t) => h('option', { key: t || 'all', value: t }, t === '' ? '全部来源' : t)),
                ),
              )
            : null,

          notice
            ? h(
                'div',
                { className: notice.kind === 'err' ? 'dm-err' : 'dm-ok' },
                notice.text,
                notice.hint ? ` — ${notice.hint}` : '',
              )
            : null,

          ready
            ? h(MemoryList, {
                list,
                selected,
                onSelect: setSelected,
                project,
                workspace,
                hasFilter: q !== '' || type !== '' || source !== '',
                onClearFilter: () => {
                  setQ('')
                  setType('')
                  setSource('')
                  setPage(0)
                },
              })
            : null,

          selected && ready
            ? h(
                'div',
                { className: 'dm-detail' },
                h('div', { style: { fontWeight: 650 } }, selected.title || `#${selected.id}`),
                detailFields(selected).map(([label, value]) =>
                  h(
                    'div',
                    { key: label },
                    h('div', { className: 'k' }, label),
                    Array.isArray(value)
                      ? h(
                          'ul',
                          null,
                          value.map((v, i) => h('li', { key: i }, v)),
                        )
                      : h('div', { className: 'v' }, value),
                  ),
                ),
                h(
                  'div',
                  { className: 'dm-actions' },
                  h(
                    'button',
                    {
                      className: 'dm-btn',
                      disabled: busy,
                      onClick: () =>
                        act(`已软隐藏 #${selected.id}（可在 Dashboard 恢复）`, () =>
                          api.resolve(selected.id, 'resolved'),
                        ),
                    },
                    '软隐藏',
                  ),
                  h(
                    'button',
                    {
                      className: 'dm-btn',
                      disabled: busy,
                      onClick: () => act(`已归档 #${selected.id}`, () => api.resolve(selected.id, 'archived')),
                    },
                    '归档',
                  ),
                  h(
                    'button',
                    {
                      className: 'dm-btn danger',
                      disabled: busy,
                      onClick: () => {
                        // eslint-disable-next-line no-alert
                        if (
                          typeof window !== 'undefined' &&
                          window.confirm &&
                          !window.confirm(deleteConfirmLabel(selected.title))
                        )
                          return
                        act(`已永久删除 #${selected.id}`, () => api.remove(selected.id))
                      },
                    },
                    '永久删除',
                  ),
                ),
              )
            : null,

          ready
            ? h(
                'div',
                { className: 'dm-actions', style: { justifyContent: 'space-between' } },
                h('button', { className: 'dm-btn', disabled: page <= 0, onClick: () => setPage(page - 1) }, '上一页'),
                h('span', { className: 'dm-foot' }, `第 ${page + 1} / ${pages} 页 · 共 ${formatCount(total)} 条`),
                h(
                  'button',
                  { className: 'dm-btn', disabled: page + 1 >= pages, onClick: () => setPage(page + 1) },
                  '下一页',
                ),
              )
            : null,
        ),
      )
    }

    /**
     * 设置页的「记忆」分区。
     *
     * 之前这里只渲染控制面状态，于是用户在一个叫「记忆」的页里看不到任何记忆
     * —— 这是设计失误。现在它给出概览 + 前几条真实记忆，并明确指向侧栏面板
     * 获取完整列表（筛选/分页/删除都在那边）。
     */
    function MemorySettings({ workspace }) {
      const { state, health, detail, retry, nonce } = useMemoryData(0, workspace)
      const d = health || {}
      const ready = state.kind === 'ready'
      const STATE_LABEL = { ready: '可用', connecting: '启动中', loading: '检测中', failed: '不可用' }
      const label = STATE_LABEL[state.kind] || '不可用'
      const project = d.project

      const list = useObservationList({
        enabled: ready,
        workspace,
        pageSize: SETTINGS_PREVIEW,
        refreshKey: 0,
        nonce,
      })

      const stats = (detail.data && detail.data.stats) || {}
      const retention = stats.retention || {}
      const items = (list.data && list.data.items) || []
      const total = (list.data && list.data.total) || stats.observations || 0

      return h(
        'div',
        { className: 'dm-body' },
        h(
          'div',
          { className: 'dm-pills' },
          h('span', { className: 'dm-pill' }, '控制面 ', h('b', null, label)),
          h('span', { className: 'dm-pill' }, '项目 ', h('b', null, d.project || '未解析')),
          d.version ? h('span', { className: 'dm-pill' }, 'v', h('b', null, d.version)) : null,
        ),
        h(
          'div',
          { className: 'dm-pills' },
          h('span', { className: 'dm-pill' }, '记忆 ', h('b', null, formatCount(stats.observations))),
          h('span', { className: 'dm-pill' }, '活跃 ', h('b', null, formatCount(retention.active))),
          h('span', { className: 'dm-pill' }, '归档 ', h('b', null, formatCount(retention.archive))),
        ),

        state.kind === 'connecting'
          ? h(StateBox, {
              kind: 'connecting',
              title: '正在自动启动控制面…',
              why: '无需操作，几秒后自动就绪。',
              onRetry: retry,
            })
          : null,
        state.kind === 'failed'
          ? h(StateBox, { kind: 'failed', title: '控制面不可用', why: state.why, hint: state.hint, onRetry: retry })
          : null,
        state.kind === 'failed'
          ? h(
              'div',
              { className: 'dm-foot' },
              '手动启动：',
              h('span', { className: 'dm-code' }, 'memorix background start'),
            )
          : null,

        // 概览没数字时（stats 还在路上）用列表自身的 total 兜底判断空不空
        ready
          ? detail.loading || list.loading
            ? h(Skeleton, null)
            : list.error
              ? h('div', { className: 'dm-err' }, list.error.message)
              : items.length === 0
                ? h(EmptyState, { project, workspace })
                : h(
                    'div',
                    null,
                    h('div', { className: 'dm-sectlabel' }, `最近 ${items.length} 条 / 共 ${formatCount(total)} 条`),
                    h(
                      'div',
                      { className: 'dm-list' },
                      items.map((item) =>
                        h(MemoryRow, {
                          key: String(item.id),
                          item,
                          selected: false,
                        }),
                      ),
                    ),
                    total > items.length
                      ? h(
                          'div',
                          { className: 'dm-foot' },
                          `还有 ${formatCount(total - items.length)} 条，展开侧栏「记忆」查看全部。`,
                        )
                      : null,
                  )
          : null,

        h('div', { className: 'dm-sep' }),
        h('div', { className: 'dm-foot' }, `工作区：${d.workspaceRoot || '—'}`),
        h(
          'div',
          { className: 'dm-foot' },
          '记忆写入由模型经 MCP 工具（mcp__memorix__*）完成。完整的筛选、分页、软隐藏与删除在侧栏底部的「记忆」面板里。',
        ),
        h(
          'div',
          { className: 'dm-actions' },
          h('button', { className: 'dm-btn primary', onClick: retry }, '刷新'),
          h('a', { className: 'dm-btn', href: DASHBOARD, target: '_blank', rel: 'noreferrer' }, '打开 Dashboard'),
        ),
      )
    }

    function MemorySidebar(props) {
      const wide = props && props.wide === true
      const [open, setOpen] = React.useState(false)
      const [refreshKey, setRefreshKey] = React.useState(0)
      const triggerRef = React.useRef(null)
      // 面板最清楚用户在看哪个工作区；把它带给宿主，避免宿主解析错项目身份。
      const workspace = workspacePathOf(props)
      const anchor = useAnchor(open, triggerRef, { width: 400, height: 520 })
      // 样式已在模块作用域注入一次（见 ensureStyle）；这里不再持有它。
      React.useEffect(() => {
        ensureStyle()
      }, [])

      return h(
        'div',
        { className: 'dsh-memory' },
        h(
          'div',
          { className: wide ? 'dm-layer' : 'dm-layer rail' },
          open && anchor
            ? h(
                'section',
                {
                  className: 'dm-flyout',
                  style: { left: anchor.left, top: anchor.top, width: anchor.width, maxHeight: anchor.maxHeight },
                  'aria-label': '记忆',
                },
                h(MemoryPanel, { onClose: () => setOpen(false), refreshKey, workspace }),
              )
            : null,
          h(
            'button',
            {
              ref: triggerRef,
              type: 'button',
              className: 'dm-trigger',
              'data-open': open || undefined,
              'aria-label': '记忆',
              'aria-expanded': open,
              onClick: () => {
                setOpen((v) => !v)
                setRefreshKey((k) => k + 1)
              },
              title: 'Memorix 记忆',
            },
            h('span', { className: 'dm-glyph', 'aria-hidden': 'true' }, '🧠'),
            wide ? h('span', null, '记忆') : null,
            wide ? h('span', { className: 'dm-chev', 'aria-hidden': 'true' }, open ? '▾' : '▸') : null,
          ),
        ),
      )
    }

    // ------------------------------------------------------------------- apply
    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'dsh-memory',
            order: 22,
            label: '记忆',
          },
          function BoundSidebar(props) {
            return h(MemorySidebar, Object.assign({}, props, { ctx }))
          },
        ),
      )

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-memory',
            order: 25,
            label: '记忆',
          },
          function BoundSettings(props) {
            return h(MemorySettings, Object.assign({}, props, { ctx, workspace: workspacePathOf(props) }))
          },
        ),
      )
    }

    exports.inject = inject
    exports.apply = apply
    // 仅测试用出口：不注册任何运行时行为。
    exports.__test__ = {
      formatCount,
      humanAge,
      detailFields,
      deleteConfirmLabel,
      connectionStateOf,
      request,
      api,
      TYPE_OPTIONS,
      SOURCE_OPTIONS,
      REQUEST_TIMEOUT_MS,
      workspacePathOf,
      withWorkspace,
      computeAnchor,
    }
    return module.exports
  },
})
