// dsh-mcp-manager — client half (classic script, no build step).
//
// 在设置面板注册一个「MCP 服务器」页（settings.section, id: mcp），
// 通过 /api/mcp/servers 与宿主侧管理器通信：列出、新增、编辑、删除
// MCP 服务器配置。改动即时生效（宿主热挂载/卸载实例）。
//
// 注册 id 必须是**包名**：宿主按 __DSH_BOOT__ 图里的 entry id（= 包名）
// 装载 /plugins/??<包名>/client.js，装载后校验 factories 里存在该 id
// （dsh-client-modules：`loaded without registering "<id>" via
// __ModuleLoader__.load`）。写成短名会在挂载阶段直接抛错，设置页不会出现。
//
// 全部用户可见文案走本文件自带的 zh/en 字典（命名空间 'mcp'，与设置命名空间
// 同名），设置页导航标签是一个 thunk，因此跟随外壳语言；ctx.locale 缺席时
// 退回中文，插件照常注册。
window.__ModuleLoader__.load({
  id: '@zfdx123/dsh-mcp-manager',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var useState = React.useState
    var useEffect = React.useEffect

    var API = '/api/mcp/servers'
    var e = React.createElement

    // ── locale ──────────────────────────────────────────────────────────────
    // 设置页导航标签由注册方自己本地化：外壳从不订阅 locale 状态，它只在语言
    // 切换后重新渲染导航并重新调用 label()（settings.section 契约：
    // label 是「registrant-localized display text」）。所以 label 是一个走
    // 翻译函数的 thunk，字典注册挂在 ctx.effect 上（fiber 卸载即摘除）。
    //
    // 命名空间 'mcp' 与本插件的设置命名空间同名。ctx.locale 缺席时（宿主组合
    // 里没有 locale 插件，或测试里的桩 ctx）翻译函数退回本插件自带的中文文案，
    // 页面照常注册、照常渲染，绝不抛错。
    var NS = 'mcp'
    var zh = {
      nav: 'MCP 服务器',
      intro:
        '在这里配置给我用的 MCP 服务器（Model Context Protocol）。保存后立即生效，每台服务器可单独「开启/关闭」：我会拿到 mcp__<名称>__<工具名> 形式的工具。',
      empty: '还没有配置任何 MCP 服务器。',
      // addServer 自带全角 ＋：拿不到外壳图标时它就是那个加号。拿得到图标时改用
      // addServerNoIcon，字形交给 IconPlusOutline16 画（否则一个加号画两遍）。
      addServer: '＋ 添加服务器',
      addServerNoIcon: '添加服务器',
      refresh: '刷新',
      save: '保存',
      saving: '保存中…',
      cancel: '取消',
      // 弹窗右上角关闭按钮的无障碍名：与「关闭服务器」的 disable 同词不同键。
      close: '关闭',
      pending: '处理中…',
      confirmDelete: '删除「{name}」？它的工具会立即移除。',
      confirmDisable: '关闭「{name}」？它的工具会立即移除，配置保留。',
      confirmDeleteAction: '确认删除',
      confirmDisableAction: '确认关闭',
      // 外壳 RiskConfirmation 的必勾项：勾上之前确认动作一直不可用，所以要说清在确认什么。
      confirmDeleteAck: '我已了解，删除后无法恢复',
      confirmDisableAck: '我已了解，关闭后工具会立即移除',
      enable: '开启',
      disable: '关闭',
      edit: '编辑',
      remove: '删除',
      stateMounted: '已挂载',
      stateConnecting: '连接中',
      stateDisabled: '已关闭',
      stateError: '错误',
      tagInsecure: '自签名',
      tagCa: '指定 CA',
      tagNoReconnect: '不重连',
      noticeSaved: '已保存并生效',
      noticeDeleted: '已删除 {name}',
      noticeEnabled: '已开启 {name}',
      noticeDisabled: '已关闭 {name}',
      noticeConflict: '配置已被其他窗口/页面修改，已刷新，请核对后再保存',
      fieldName: '名称（serverName）',
      phName: '如 github / mydb；工具名将是 mcp__<名称>__<工具名>',
      fieldTransport: '传输方式',
      optStdio: 'stdio（本地命令）',
      optHttp: 'streamable-http（远程 URL）',
      groupStdio: '连接参数（stdio）',
      groupHttp: '连接参数（streamable-http）',
      groupGeneral: '通用',
      fieldCommand: '命令（command）',
      phCommand: '如 npx，或可执行文件绝对路径（如 ...\\Scripts\\python.exe）',
      hintCommand: '只填可执行文件本身。整条命令行粘进来也能用（会自动拆分），但参数填到下一栏更清楚',
      fieldArgs: '参数（args，每行一个）',
      hintArgs:
        '每行一个参数；一行里写了多个词会按引号规则自动拆开。参数本身含空格时用双引号括起来，如 "C:\\my dir\\a.py"',
      fieldEnv: '环境变量（env，每行 KEY=VALUE）',
      hintEnv: '值支持 env:NAME（进程环境变量）与 cred:NAME（DSH 凭据）引用，密钥不落盘',
      fieldCwd: '工作目录（cwd，可选）',
      phCwd: '留空则用 Host 进程的工作目录',
      fieldUrl: 'URL',
      fieldHeaders: '请求头（headers，每行 KEY: VALUE）',
      hintHeaders: '值支持 env:NAME 与 cred:NAME 引用，密钥不落盘',
      fieldTlsInsecure: '允许自签名证书（tlsInsecure）',
      optTlsInsecureNo: '否（默认，校验证书）',
      optTlsInsecureYes: '是（仅对该服务器地址跳过校验）',
      hintTlsInsecure: '只对这台服务器的 origin 生效；其余请求（含模型 API）仍按系统信任链校验证书',
      fieldTlsCaFile: '自定义 CA 证书文件（tlsCaFile，PEM 绝对路径，可选）',
      phTlsCaFile: '如 C:\\certs\\syslog-ca.pem；填了就用它严格校验该服务器证书',
      fieldTimeout: '工具调用超时（toolCallTimeoutMs，毫秒）',
      fieldFailOnStartup: '启动失败即报错（failOnStartupError）',
      optFailNo: '否（连接失败自动重连）',
      optFailYes: '是（首次连接/工具同步失败时报错）',
      fieldReconnect: '断线自动重连（reconnect）',
      optReconnectOn: '开启（默认，按退避重试）',
      optReconnectOff: '关闭（连接断开后不再重试）',
      fieldMaxAttempts: '最大重连次数（reconnectMaxAttempts）',
      errName: '名称不能为空',
      errCommand: 'stdio 传输必须填写命令',
      errUrl: 'streamable-http 必须填写 URL',
      errTimeout: '超时必须是 >= 1 的数字（毫秒）',
      errMaxAttempts: '最大重连次数必须是 >= 1 的整数',
    }
    var en = {
      nav: 'MCP servers',
      intro:
        'Configure the MCP (Model Context Protocol) servers available to me here. Saving takes effect immediately, and each server can be enabled or disabled on its own: I receive its tools as mcp__<name>__<tool>.',
      empty: 'No MCP servers configured yet.',
      addServer: '+ Add server',
      addServerNoIcon: 'Add server',
      refresh: 'Refresh',
      save: 'Save',
      saving: 'Saving…',
      cancel: 'Cancel',
      close: 'Close',
      pending: 'Working…',
      confirmDelete: 'Delete “{name}”? Its tools are removed immediately.',
      confirmDisable: 'Disable “{name}”? Its tools are removed immediately; the configuration is kept.',
      confirmDeleteAction: 'Delete',
      confirmDisableAction: 'Disable',
      confirmDeleteAck: 'I understand this cannot be undone',
      confirmDisableAck: 'I understand the tools are removed immediately',
      enable: 'Enable',
      disable: 'Disable',
      edit: 'Edit',
      remove: 'Delete',
      stateMounted: 'Mounted',
      stateConnecting: 'Connecting',
      stateDisabled: 'Disabled',
      stateError: 'Error',
      tagInsecure: 'Self-signed',
      tagCa: 'Custom CA',
      tagNoReconnect: 'No reconnect',
      noticeSaved: 'Saved and applied',
      noticeDeleted: 'Deleted {name}',
      noticeEnabled: 'Enabled {name}',
      noticeDisabled: 'Disabled {name}',
      noticeConflict:
        'The configuration was changed by another window or page; it has been reloaded, please review it before saving',
      fieldName: 'Name (serverName)',
      phName: 'e.g. github / mydb; tool names become mcp__<name>__<tool>',
      fieldTransport: 'Transport',
      optStdio: 'stdio (local command)',
      optHttp: 'streamable-http (remote URL)',
      groupStdio: 'Connection (stdio)',
      groupHttp: 'Connection (streamable-http)',
      groupGeneral: 'General',
      fieldCommand: 'Command (command)',
      phCommand: 'e.g. npx, or the absolute path to an executable (e.g. ...\\Scripts\\python.exe)',
      hintCommand:
        'The executable only. A whole command line pasted here still works (it is split automatically), but putting the arguments in the next field is clearer',
      fieldArgs: 'Arguments (args, one per line)',
      hintArgs:
        'One argument per line; several words on one line are split by the quoting rules. Wrap an argument that contains spaces in double quotes, e.g. "C:\\my dir\\a.py"',
      fieldEnv: 'Environment variables (env, KEY=VALUE per line)',
      hintEnv:
        'Values accept env:NAME (process environment) and cred:NAME (DSH credentials) references; secrets are never written to disk',
      fieldCwd: 'Working directory (cwd, optional)',
      phCwd: 'Leave empty to use the Host process working directory',
      fieldUrl: 'URL',
      fieldHeaders: 'Request headers (headers, KEY: VALUE per line)',
      hintHeaders: 'Values accept env:NAME and cred:NAME references; secrets are never written to disk',
      fieldTlsInsecure: 'Allow self-signed certificates (tlsInsecure)',
      optTlsInsecureNo: 'No (default, verify the certificate)',
      optTlsInsecureYes: 'Yes (skip verification for this server URL only)',
      hintTlsInsecure:
        'Applies to this server origin only; every other request (including model APIs) still verifies against the system trust chain',
      fieldTlsCaFile: 'Custom CA certificate file (tlsCaFile, absolute PEM path, optional)',
      phTlsCaFile: 'e.g. C:\\certs\\syslog-ca.pem; when set, it strictly verifies this server certificate',
      fieldTimeout: 'Tool call timeout (toolCallTimeoutMs, milliseconds)',
      fieldFailOnStartup: 'Fail on startup error (failOnStartupError)',
      optFailNo: 'No (reconnect automatically when the connection fails)',
      optFailYes: 'Yes (report an error when the first connection or tool sync fails)',
      fieldReconnect: 'Reconnect after a disconnect (reconnect)',
      optReconnectOn: 'On (default, retries with backoff)',
      optReconnectOff: 'Off (no retry once the connection drops)',
      fieldMaxAttempts: 'Max reconnect attempts (reconnectMaxAttempts)',
      errName: 'The name cannot be empty',
      errCommand: 'The stdio transport requires a command',
      errUrl: 'streamable-http requires a URL',
      errTimeout: 'The timeout must be a number >= 1 (milliseconds)',
      errMaxAttempts: 'Max reconnect attempts must be an integer >= 1',
    }

    /** {name} 插值，与外壳 LocaleRuntime.translate 的规则一致。 */
    function interpolate(template, params) {
      if (!params) return template
      return String(template).replace(/\{(\w+)\}/g, function (match, name) {
        return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
      })
    }

    /** 兜底翻译：只用本插件自带的中文文案（字典缺键时显示键名，与外壳一致）。 */
    function translateZh(key, params) {
      return interpolate(Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : key, params)
    }

    // 当前翻译函数：默认中文兜底，locale 服务可用时换成它绑定出来的 t。
    // 组件在渲染时读取它，所以语言切换后重新渲染就能拿到新语言的文案。
    var t = translateZh

    /** 注册双语文案并绑定翻译函数；服务缺失或注册失败时保持中文兜底。 */
    function bindLocale(ctx) {
      var locale = ctx && ctx.locale
      if (!locale || typeof locale.register !== 'function' || typeof locale.bind !== 'function') {
        // 没有 locale 服务：一律用本插件自带的中文文案（即使本实例此前绑定过，
        // 也以本次 apply 拿到的 ctx 能力为准）。
        t = translateZh
        return
      }
      try {
        ctx.effect(function () {
          return locale.register(NS, { zh: zh, en: en })
        }, 'mcp-manager: dictionaries')
        t = locale.bind(NS)
      } catch {
        // 例如命名空间已被另一个实例占用。这不该让整个设置页消失。
        t = translateZh
      }
    }

    // ── 外壳原生组件 ──────────────────────────────────────────────────────────
    // 外壳把 UI 原子挂在模块表的基线里（@deepseek-ai/dsh-client-ui-primitives），
    // 所以不需要在 dsh.client 里声明 external/inject，直接 require 就能拿到外壳画
    // 设置页、删除确认用的那套按钮/输入框/开关/标签：焦点环、禁用态、过渡与无障碍
    // 语义自动对齐，不用自己抄一遍样式。
    //
    // 拿不到时必须降级而不是白屏：模块表里没有这个包时 require 会抛，而抛在 factory
    // 里等于整个插件装不上。这里吞掉异常并做形状校验，退回自带样式的原生元素：按钮与
    // 输入框沿用改动前的配色，开关退回原生 checkbox（见下面的 button/textInput/toggle…）。
    var PRIMITIVES = '@deepseek-ai/dsh-client-ui-primitives'
    // 拿不到原语的原因（'' = 拿到了）：留给诊断与测试，证明守卫确实捕获了真错误。
    var PRIMITIVES_ERROR = ''
    var UI = loadPrimitives()

    function loadPrimitives() {
      try {
        var primitives = require(PRIMITIVES)
        if (
          primitives &&
          typeof primitives.Button === 'function' &&
          typeof primitives.Input === 'function' &&
          typeof primitives.Switch === 'function' &&
          typeof primitives.Tag === 'function' &&
          typeof primitives.StateDot === 'function'
        ) {
          return primitives
        }
        return null
      } catch (error) {
        // 模块表里没有这一条（或 require 被拒）：记下原因，控制流一律降级到自带元素。
        PRIMITIVES_ERROR = String((error && error.message) || error)
        return null
      }
    }

    /**
     * 外壳的危险操作确认组件（RiskConfirmation），拿不到时返回 null。
     *
     * 单独判它、而不是加进 loadPrimitives 的形状校验：缺这一个组件不该把整套原语扔掉
     * （Button/Input/Switch 还有用），只把确认这一处降级成内联条。
     */
    function riskConfirmation() {
      return UI !== null && typeof UI.RiskConfirmation === 'function' ? UI.RiskConfirmation : null
    }

    /**
     * 外壳的 16px 图标节点，这一版原语里没有同名图标时返回 null。
     *
     * 图标交给 Button 的 icon 槽（前置图标位），不拼进 children：拼进去就成了「文案里
     * 带图标」，无障碍名、语言切换与图标本身会绑死在一起。
     */
    function iconNode(name) {
      return UI !== null && typeof UI[name] === 'function' ? e(UI[name], {}) : null
    }

    // ── 主题 ────────────────────────────────────────────────────────────────
    // 外壳把设计令牌定义在 <body>（亮色）与 <body[data-ds-dark-theme]>（暗色）
    // 上（dsh-client-ui-theme 的 client bundle；ui-layout 的 ThemePresenter
    // 负责写 data-ds-dark-theme），所以在插件 DOM 里 var(--dsw-alias-*) 是能
    // 解析的。但有两件事必须插件自己处理：
    //
    //   1. 外壳**从不声明 color-scheme**。暗色主题下原生控件的"内部"——
    //      <select> 的下拉弹层、<input type=number> 的微调按钮、滚动条——仍按
    //      亮色渲染，而下拉弹层里的文字继承的是 select 的浅色 color，于是
    //      浅色字落在 UA 的白底弹层上：文字与背景同色，看不见。
    //   2. 令牌可能被改名/替换，那时整条 var() 声明失效，color 退回继承值。
    //
    // 所以这里注入一小段只属于本插件的样式（随 fiber 卸载移除）：绑定
    // color-scheme、给每个 --mcp-* 变量一份带兜底的值、明确写死原生控件的
    // 背景/文字/占位符/禁用态。布局与几何仍走内联样式。
    var CLASS = 'dsh-mcp-manager'
    var STYLE_ID = 'dsh-mcp-manager-style'
    var CSS = [
      '.' + CLASS + '{',
      'color-scheme:light;',
      '--mcp-fg:var(--dsw-alias-label-primary,#0f1115);',
      '--mcp-fg-2:var(--dsw-alias-label-secondary,#61666b);',
      '--mcp-fg-3:var(--dsw-alias-label-tertiary,#81858c);',
      // 主按钮上的文字色（亮色下是白字，暗色下是深字）
      '--mcp-fg-invert:var(--dsw-alias-label-primary-foreground,#fff);',
      '--mcp-border:var(--dsw-alias-border-l2,rgba(0,0,0,.1));',
      '--mcp-border-strong:var(--dsw-alias-border-l3,rgba(0,0,0,.16));',
      '--mcp-field:var(--dsw-alias-bg-layer-2,#f9fafb);',
      '--mcp-error:var(--dsw-alias-state-error-primary,#ef4444);',
      '--mcp-success:var(--dsw-alias-state-success-primary,#22c55e);',
      '--mcp-primary-fill:var(--dsw-alias-button-primary-fill,#0f1115);',
      'color:var(--mcp-fg);',
      '}',
      'body[data-ds-dark-theme] .' + CLASS + '{',
      'color-scheme:dark;',
      '--mcp-fg:var(--dsw-alias-label-primary,#ebeef2);',
      '--mcp-fg-2:var(--dsw-alias-label-secondary,#adb2b8);',
      '--mcp-fg-3:var(--dsw-alias-label-tertiary,#81858c);',
      '--mcp-fg-invert:var(--dsw-alias-label-primary-foreground,#151517);',
      '--mcp-border:var(--dsw-alias-border-l2,rgba(255,255,255,.12));',
      '--mcp-border-strong:var(--dsw-alias-border-l3,rgba(255,255,255,.2));',
      '--mcp-field:var(--dsw-alias-bg-layer-3,#232326);',
      '--mcp-error:var(--dsw-alias-state-error-primary,#f25a5a);',
      '--mcp-success:var(--dsw-alias-state-success-primary,#22c55e);',
      '--mcp-primary-fill:var(--dsw-alias-button-primary-fill,#ebeef2);',
      '}',
      '.' +
        CLASS +
        ' input:not([class]):not([type=checkbox]),.' +
        CLASS +
        ' select,.' +
        CLASS +
        ' textarea{background-color:var(--mcp-field);color:var(--mcp-fg)}',
      // 下拉弹层里的每一项也要显式给色：弹层背景不随 select 的 background 走。
      '.' + CLASS + ' option{background-color:var(--mcp-field);color:var(--mcp-fg)}',
      '.' + CLASS + ' ::placeholder{color:var(--mcp-fg-3);opacity:1}',
      '.' + CLASS + ' textarea{font-family:var(--dsw-font-family,inherit)}',
      // 只给降级路径自带的按钮加 hover/disabled：原生 Button 有自己的 hover/active/
      // disabled 样式，再叠一层 brightness 会跟外壳不一致。
      '.' + CLASS + ' .dsh-mcp-fallback-btn{transition:filter .15s ease}',
      '.' + CLASS + ' .dsh-mcp-fallback-btn:not(:disabled):hover{filter:brightness(1.08)}',
      '.' + CLASS + ' .dsh-mcp-fallback-btn:disabled{opacity:.55;cursor:default}',
      // 原生 Input 的包装层要撑满表单列宽（外壳的 Input 是 inline-flex，宽度由调用方给）。
      '.' + CLASS + ' .dsh-mcp-field{width:100%}',
      // 原生 Button 没有 danger 变体，外壳自己的危险操作写法是 outline + 错误色文字
      // （比降级路径的实心红更轻，且不会让「确认删除」看起来比「取消」更该点）。
      '.' + CLASS + ' button.dsh-mcp-danger{color:var(--dsw-alias-state-error-primary,#ef4444)}',
    ].join('')

    /** 注入插件自有的样式表（已存在则复用，避免 HMR 重复注入）。 */
    function ensureStyles() {
      var existing = document.getElementById(STYLE_ID)
      if (existing) return existing
      var el = document.createElement('style')
      el.id = STYLE_ID
      el.setAttribute('data-plugin', 'dsh-mcp-manager')
      el.textContent = CSS
      document.head.appendChild(el)
      return el
    }

    // ── styles（布局 + 颜色都取自上面定义的 --mcp-* 变量）────────────────────
    var S = {
      section: { maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 12 },
      title: { margin: 0, fontSize: 16, fontWeight: 500, lineHeight: '24px', color: 'var(--mcp-fg)' },
      intro: { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--mcp-fg-3)' },
      error: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--mcp-error)' },
      // 错误状态里的第二行：宿主并入的异步失败细节（failure）。比主文案弱一档，
      // 让「可照改的一句话」保持视觉上的第一顺位。
      errorDetail: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--mcp-fg-3)', wordBreak: 'break-all' },
      ok: { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--mcp-success)' },
      card: {
        border: '1px solid var(--mcp-border)',
        borderRadius: 12,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      },
      rowHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      rowName: { fontSize: 14, fontWeight: 500, lineHeight: '22px', color: 'var(--mcp-fg)' },
      tag: {
        border: '1px solid var(--mcp-border-strong)',
        color: 'var(--mcp-fg-2)',
        borderRadius: 4,
        padding: '1px 6px',
        fontSize: 11,
        lineHeight: '16px',
      },
      detail: { fontSize: 12, lineHeight: '18px', color: 'var(--mcp-fg-3)', wordBreak: 'break-all' },
      statusLine: {
        fontSize: 12,
        lineHeight: '18px',
        color: 'var(--mcp-fg-2)',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      },
      dot: { width: 8, height: 8, borderRadius: '50%', display: 'inline-block', flex: 'none' },
      actions: { display: 'flex', gap: 8, marginTop: 2, alignItems: 'center', flexWrap: 'wrap' },
      // 开关 + 它的动作词（「开启」/「关闭」仍原样显示，只是控件换成了外壳的 Switch）。
      toggleRow: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 13,
        lineHeight: '20px',
        color: 'var(--mcp-fg-2)',
      },
      button: {
        height: 32,
        padding: '0 14px',
        borderRadius: 16,
        border: 'none',
        cursor: 'pointer',
        fontSize: 13,
        lineHeight: '20px',
        background: 'var(--mcp-primary-fill)',
        color: 'var(--mcp-fg-invert)',
      },
      buttonGhost: {
        height: 32,
        padding: '0 14px',
        borderRadius: 16,
        cursor: 'pointer',
        fontSize: 13,
        lineHeight: '20px',
        background: 'transparent',
        color: 'var(--mcp-fg-2)',
        border: '1px solid var(--mcp-border-strong)',
      },
      buttonDanger: {
        height: 32,
        padding: '0 14px',
        borderRadius: 16,
        cursor: 'pointer',
        fontSize: 13,
        lineHeight: '20px',
        background: 'transparent',
        color: 'var(--mcp-error)',
        border: '1px solid var(--mcp-error)',
      },
      // 内联确认条：贴在卡片里取代按钮行，配色与卡片同族（不引入遮罩/弹窗）。
      confirmStrip: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        background: 'var(--mcp-field)',
        border: '1px solid var(--mcp-border-strong)',
        borderRadius: 10,
        padding: '8px 10px',
      },
      confirmText: {
        fontSize: 12,
        lineHeight: '18px',
        color: 'var(--mcp-fg)',
        flex: '1 1 200px',
        minWidth: 0,
        wordBreak: 'break-word',
      },
      buttonDangerSolid: {
        height: 32,
        padding: '0 14px',
        borderRadius: 16,
        border: 'none',
        cursor: 'pointer',
        fontSize: 13,
        lineHeight: '20px',
        background: 'var(--mcp-error)',
        color: 'var(--mcp-fg-invert)',
      },
      buttonSolid: {
        height: 32,
        padding: '0 14px',
        borderRadius: 16,
        border: 'none',
        cursor: 'pointer',
        fontSize: 13,
        lineHeight: '20px',
        background: 'var(--mcp-primary-fill)',
        color: 'var(--mcp-fg-invert)',
      },
      label: { fontSize: 12, lineHeight: '18px', color: 'var(--mcp-fg-2)', display: 'block', marginBottom: 4 },
      hint: { fontSize: 11, lineHeight: '16px', color: 'var(--mcp-fg-3)' },
      input: {
        boxSizing: 'border-box',
        width: '100%',
        height: 32,
        borderRadius: 8,
        border: '1px solid var(--mcp-border)',
        padding: '0 10px',
        fontSize: 13,
      },
      textarea: {
        boxSizing: 'border-box',
        width: '100%',
        minHeight: 56,
        borderRadius: 8,
        border: '1px solid var(--mcp-border)',
        padding: '6px 10px',
        fontSize: 12,
        resize: 'vertical',
      },
      field: { display: 'flex', flexDirection: 'column', gap: 2 },
      // 传输方式相关的字段整组渲染/整组隐藏，避免两种模式的字段同时出现。
      group: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        borderTop: '1px solid var(--mcp-border)',
        paddingTop: 8,
      },
      groupTitle: { fontSize: 12, lineHeight: '18px', color: 'var(--mcp-fg-3)' },
    }

    // ── 控件：外壳原子优先，拿不到就退回自带样式 ──────────────────────────────
    //
    // 这里返回的是**元素**而不是组件：调用方写 button({...}, '保存')，树里就是外壳的
    // Button，不额外包一层，测试也就能直接断言「用的确实是外壳组件」。
    // 降级分支只在 UI === null 时走到，配色与改动前逐项一致。

    /** 插件状态 → 外壳 StateDot 的语义状态（拿不到外观时按老配色画点）。 */
    function dotColor(state) {
      if (state === 'error') return 'var(--mcp-error)'
      // 连接中不是「成功」也不是「失败」：外壳没有 warning 态令牌，用中性灰。
      if (state === 'connecting' || state === 'disabled') return 'var(--mcp-fg-3)'
      return 'var(--mcp-success)'
    }

    /**
     * 插件状态 → 外壳 StateDot 的语义状态。
     * `connecting`（已挂载、尚未确认连上）不能画成 done/绿：那正是「服务器没回应
     * 却显示已挂载」的来源。
     */
    function dotState(state) {
      return state === 'error' ? 'error' : state === 'disabled' ? 'idle' : state === 'connecting' ? 'ongoing' : 'done'
    }

    /** 插件状态 → 外壳 Tag 的语气色。 */
    function stateTone(state) {
      return state === 'error'
        ? 'danger'
        : state === 'disabled'
          ? 'neutral'
          : state === 'connecting'
            ? 'outline'
            : 'success'
    }

    /**
     * 按钮元素。
     *
     * variant 'primary' | 'outline'（默认 outline）；danger 表示破坏性操作——原生
     * Button 没有 danger 变体，外壳自己的写法是 outline + 错误色文字，所以 kit 路径
     * 先按 variant 画、再用 dsh-mcp-danger 上色。icon 是外壳的前置 16px 图标节点
     * （见 iconNode），拿不到图标时为 null，原生 Button 会跳过图标位。
     * 降级路径用 fallbackStyle（只有确认条那两个实心按钮需要，保持改动前的实心配色），
     * 也不认 icon：字形留在字典文案里，别把 icon 透给原生 <button>。
     */
    function button(props, children) {
      var variant = props.variant || 'outline'
      if (UI !== null) {
        return e(
          UI.Button,
          {
            key: props.key,
            variant: variant,
            size: 'sm',
            icon: props.icon,
            className: props.danger ? 'dsh-mcp-danger' : undefined,
            disabled: props.disabled,
            title: props.title,
            onClick: props.onClick,
            'aria-label': props.label,
          },
          children,
        )
      }
      var base =
        props.fallbackStyle || (props.danger ? S.buttonDanger : variant === 'primary' ? S.button : S.buttonGhost)
      return e(
        'button',
        {
          key: props.key,
          type: 'button',
          className: 'dsh-mcp-fallback-btn',
          style: base,
          disabled: props.disabled,
          title: props.title,
          onClick: props.onClick,
          'aria-label': props.label,
        },
        children,
      )
    }

    /**
     * 单行输入框元素。
     *
     * 降级分支故意不给 class：样式表里那条 `input:not([class])` 配色规则靠它区分自带
     * 输入框与原生 Input（原生 Input 的 <input> 自带 class，颜色由外壳自己管）。
     */
    function textInput(props) {
      if (UI !== null) {
        return e(UI.Input, {
          className: 'dsh-mcp-field',
          type: props.type || 'text',
          value: props.value,
          placeholder: props.placeholder,
          onChange: props.onChange,
        })
      }
      return e('input', {
        type: props.type || 'text',
        style: S.input,
        value: props.value,
        placeholder: props.placeholder,
        onChange: props.onChange,
      })
    }

    /** 开关元素：原生 Switch 的回调直接给下一个布尔值，自带的 checkbox 需要转一道。 */
    function toggle(props) {
      if (UI !== null) {
        return e(UI.Switch, {
          checked: props.checked === true,
          onChange: props.onChange,
          label: props.label,
          title: props.title,
          disabled: props.disabled,
        })
      }
      return e('input', {
        type: 'checkbox',
        checked: props.checked === true,
        disabled: props.disabled,
        title: props.title,
        'aria-label': props.label,
        onChange: function (event) {
          props.onChange(event.target.checked)
        },
      })
    }

    /** 标签元素：tone 走外壳的语义色（transport 之类的中性事实用 outline）。 */
    function tag(tone, children, key) {
      if (UI !== null) return e(UI.Tag, { key: key, tone: tone || 'outline' }, children)
      return e('span', { key: key, style: S.tag }, children)
    }

    /** 状态点元素：原生 StateDot 是 aria-hidden 的，文本仍由旁边的 Tag 提供。 */
    function dot(state) {
      if (UI !== null) return e(UI.StateDot, { state: dotState(state), size: 8 })
      return e('span', { style: Object.assign({}, S.dot, { background: dotColor(state) }) })
    }

    // ── helpers ─────────────────────────────────────────────────────────────
    // 设置面板导航图标由外壳按 section id 硬编码，没有第三方注册点。
    // 0.2.x 曾用 CSS 覆盖外壳的哈希类名（.VOzbGW_navList 等）换成链接图标；
    // DSH 0.1.5 的外壳已不再输出这组类名（全量检索 dsh-web-frontend/dist
    // 与所有内置 client bundle 均无 navList/navCell/navIcon），该覆盖在任何
    // 版本上都不会命中，遂删除——设置页那一行现在使用外壳默认图标。

    function parseLines(text) {
      return String(text || '')
        .split(/\r?\n/)
        .map(function (l) {
          return l.trim()
        })
        .filter(Boolean)
    }

    function parseEnv(text) {
      var out = {}
      parseLines(text).forEach(function (line) {
        var idx = line.indexOf('=')
        if (idx <= 0) return
        out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
      })
      return out
    }

    function parseHeaders(text) {
      var out = {}
      parseLines(text).forEach(function (line) {
        var eq = line.indexOf('=')
        var colon = line.indexOf(':')
        var idx = eq > 0 && (colon < 0 || eq < colon) ? eq : colon
        if (idx <= 0) return
        out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
      })
      return out
    }

    function joinEntries(obj) {
      var out = []
      Object.keys(obj || {}).forEach(function (k) {
        out.push(k + '=' + obj[k])
      })
      return out.join('\n')
    }

    // 把表单状态组装成与宿主侧约定一致的服务器对象（见 lib/logic.js 的
    // validateServers）。与宿主校验一一对应，测试里做「客户端产出 →
    // 宿主校验」的往返兼容断言。
    function buildServerObject(f, initial) {
      return {
        serverName: f.serverName.trim(),
        enabled: initial.enabled !== false,
        transport: f.transport,
        command: f.command,
        args: parseLines(f.args),
        env: parseEnv(f.env),
        cwd: f.cwd.trim(),
        url: f.url.trim(),
        headers: parseHeaders(f.headers),
        toolCallTimeoutMs: Number(f.toolCallTimeoutMs),
        failOnStartupError: f.failOnStartupError === true || f.failOnStartupError === 'true',
        tlsInsecure: f.tlsInsecure === true || f.tlsInsecure === 'true',
        tlsCaFile: typeof f.tlsCaFile === 'string' ? f.tlsCaFile.trim() : '',
        reconnectEnabled: !(f.reconnectEnabled === false || f.reconnectEnabled === 'false'),
        // 缺省（旧版表单/未填）回落到与宿主 schema 一致的 10。
        reconnectMaxAttempts:
          f.reconnectMaxAttempts === undefined || f.reconnectMaxAttempts === '' ? 10 : Number(f.reconnectMaxAttempts),
      }
    }

    function loadServers() {
      return fetch(API, { method: 'GET' }).then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status)
          return data
        })
      })
    }

    // rev 是宿主返回的修订号（乐观锁）：提交时带回，若配置已被其他窗口
    // 改过，宿主返回 409（code: conflict），由调用方刷新并提示。
    function saveServers(servers, rev) {
      return fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rev: rev, servers: servers }),
      }).then(function (res) {
        return res.json().then(function (data) {
          var err = new Error(data.error || 'HTTP ' + res.status)
          err.status = res.status
          err.code = data.code
          err.rev = data.rev
          if (!res.ok) throw err
          return data
        })
      })
    }

    // ── components ──────────────────────────────────────────────────────────
    /** 一个「标签 + 控件 + 可选说明」的字段。 */
    function field(label, control, hint) {
      return e(
        'div',
        { style: S.field, key: label },
        e('span', { style: S.label }, label),
        control,
        hint ? e('span', { style: S.hint }, hint) : null,
      )
    }

    // 破坏性操作的确认入口：外壳有原生 RiskConfirmation 就用它（弹窗 + 必勾的确认项，
    // 勾上之前确认动作一直不可用），拿不到才退回下面自己画的内联确认条。
    //
    // 勾选态由调用方持有（外壳契约：acknowledged 是 caller-controlled），所以这里是
    // 纯组件：两条路径都能直接断言渲染结果，不依赖 React 状态。
    function ConfirmPrompt(props) {
      var Risk = riskConfirmation()
      if (Risk === null) return e(ConfirmStrip, props)
      var isDelete = props.action === 'delete'
      return e(Risk, {
        open: true,
        // 标题就是动作词（「删除」/「关闭」），描述沿用原来确认条上的那句话。
        title: isDelete ? t('remove') : t('disable'),
        description: isDelete ? t('confirmDelete', { name: props.name }) : t('confirmDisable', { name: props.name }),
        acknowledgeLabel: isDelete ? t('confirmDeleteAck') : t('confirmDisableAck'),
        cancelLabel: t('cancel'),
        closeLabel: t('close'),
        confirmLabel: props.busy ? t('pending') : isDelete ? t('confirmDeleteAction') : t('confirmDisableAction'),
        acknowledged: props.acknowledged === true,
        disabled: props.busy === true,
        onAcknowledgedChange: props.onAcknowledgedChange,
        onCancel: props.onCancel,
        onConfirm: props.onConfirm,
      })
    }

    /**
     * 勾选态只跟着「正在确认的那一条」走：目标换了（或没有目标）就回到未勾选。
     * 外壳把 acknowledged 交给调用方持有，这里就是那个调用方的判定。
     */
    function isAcknowledged(pending, name) {
      return pending !== null && pending !== undefined && pending.name === name && pending.acknowledged === true
    }

    // 降级路径的内联确认条：拿不到外壳 RiskConfirmation 时，点「删除」「关闭」后就地
    // 展开，取代按钮行。纯组件（无内部状态），调用方给文案与回调——便于测试直接断言
    // 渲染结果。
    //
    // action 决定语气与配色：删除用错误色（kit 路径 = outline + 红字，降级路径沿用改动前
    // 的实心红），关闭用主色（可逆，别喊狼来了）。
    function ConfirmStrip(props) {
      var isDelete = props.action === 'delete'
      var name = props.name
      return e(
        'div',
        { style: S.confirmStrip },
        e(
          'span',
          { style: S.confirmText },
          isDelete ? t('confirmDelete', { name: name }) : t('confirmDisable', { name: name }),
        ),
        button(
          {
            variant: isDelete ? 'outline' : 'primary',
            danger: isDelete,
            fallbackStyle: isDelete ? S.buttonDangerSolid : S.buttonSolid,
            disabled: props.busy === true,
            onClick: props.onConfirm,
          },
          props.busy ? t('pending') : isDelete ? t('confirmDeleteAction') : t('confirmDisableAction'),
        ),
        button({ disabled: props.busy === true, onClick: props.onCancel }, t('cancel')),
      )
    }

    function ServerRow(props) {
      var server = props.server
      var status = props.status
      // 开关（toggling）与删除（deleting）都在途：任一在途都禁用按钮，防重复提交。
      var busy = props.toggling === true || props.deleting === true
      var enabled = server.enabled !== false
      var state = status && status.state
      var transport = server.transport === 'streamable-http' ? 'HTTP' : 'stdio'
      var detail =
        server.transport === 'streamable-http'
          ? server.url
          : (server.command || '') + (server.args && server.args.length ? ' ' + server.args.join(' ') : '')
      var statusText =
        state === 'error'
          ? t('stateError')
          : state === 'disabled'
            ? t('stateDisabled')
            : state === 'connecting'
              ? t('stateConnecting')
              : t('stateMounted')
      // 「开启」/「关闭」既是开关的无障碍名，也是它旁边显示的动作词（与改动前的按钮文案一致）。
      var toggleLabel = enabled ? t('disable') : t('enable')
      return e(
        'div',
        { style: S.card },
        e(
          'div',
          { style: S.rowHead },
          e('span', { style: S.rowName }, server.serverName),
          tag('outline', transport, 'transport'),
          server.tlsInsecure === true ? tag('outline', t('tagInsecure'), 'insecure') : null,
          server.tlsCaFile ? tag('outline', t('tagCa'), 'ca') : null,
          server.reconnectEnabled === false ? tag('outline', t('tagNoReconnect'), 'noreconnect') : null,
          e(
            'span',
            { style: Object.assign({}, S.statusLine, { marginLeft: 'auto' }) },
            dot(state),
            tag(stateTone(state), statusText, 'state'),
          ),
        ),
        e('div', { style: S.detail }, detail),
        // 主文案：宿主给的第一顺位原因（前置检查的判定就在这里——它必须是用户
        // 先看到、且**一直**看得到的那句「可照改的一句话」）。
        status && status.state === 'error' ? e('p', { style: S.error }, status.message) : null,
        // 细节：宿主并入的真实异步失败（连接失败：SdkError: Connection closed…）。
        // 它不再顶掉主文案，但也不能丢——用户排障时两段都要。
        status && status.state === 'error' && status.failure ? e('p', { style: S.errorDetail }, status.failure) : null,
        e(
          'div',
          { style: S.actions },
          props.pending
            ? // 确认态：按钮行整体换成确认入口（外壳原生 RiskConfirmation；拿不到原语的
              // 版本退回内联确认条）。删除不可逆、关闭会立刻卸掉工具，都先问一句；
              // 「开启」无副作用不确认。
              e(ConfirmPrompt, {
                action: props.pending,
                name: server.serverName,
                busy: busy,
                acknowledged: props.acknowledged === true,
                onAcknowledgedChange: props.onAcknowledgedChange,
                onConfirm: props.onConfirm,
                onCancel: props.onCancel,
              })
            : [
                // 开关：关闭会立刻卸掉工具，所以那一侧先走确认；开启无副作用，直接执行。
                e(
                  'span',
                  { key: 'toggle', style: S.toggleRow },
                  toggle({
                    checked: enabled,
                    disabled: busy,
                    label: toggleLabel,
                    title: toggleLabel,
                    onChange: function (next) {
                      next ? props.onToggle(server) : props.onAsk(server, 'disable')
                    },
                  }),
                  e('span', null, toggleLabel),
                ),
                button(
                  {
                    key: 'edit',
                    icon: iconNode('IconEditOutline16'),
                    disabled: busy,
                    onClick: function () {
                      props.onEdit(server)
                    },
                  },
                  t('edit'),
                ),
                button(
                  {
                    key: 'delete',
                    danger: true,
                    icon: iconNode('IconTrashOutline16'),
                    disabled: busy,
                    onClick: function () {
                      props.onAsk(server, 'delete')
                    },
                  },
                  t('remove'),
                ),
              ],
        ),
      )
    }

    function ServerForm(props) {
      var initial = props.initial || {}
      var holder = useState({
        serverName: initial.serverName || '',
        transport: initial.transport || 'stdio',
        command: initial.command || '',
        args: (initial.args || []).join('\n'),
        env: joinEntries(initial.env || {}),
        cwd: initial.cwd || '',
        url: initial.url || '',
        headers: joinEntries(initial.headers || {}),
        toolCallTimeoutMs: String(initial.toolCallTimeoutMs || 60000),
        failOnStartupError: String(initial.failOnStartupError === true),
        tlsInsecure: String(initial.tlsInsecure === true),
        tlsCaFile: initial.tlsCaFile || '',
        reconnectEnabled: String(initial.reconnectEnabled !== false),
        reconnectMaxAttempts: String(initial.reconnectMaxAttempts || 10),
      })
      var f = holder[0]
      var setF = holder[1]
      var set = function (key) {
        return function (ev) {
          var next = Object.assign({}, f)
          next[key] = ev.target.value
          setF(next)
        }
      }

      var text = function (key, placeholder, type) {
        return textInput({
          type: type || 'text',
          value: f[key],
          placeholder: placeholder,
          onChange: set(key),
        })
      }
      // 多行字段（args/env/headers）与下拉（transport/tlsInsecure/…）没有对应的原生
      // 原子：Input 渲染的是单行 <input>，外壳这一版也没有 Select，所以这两类保持
      // 插件自带的元素与配色。
      var area = function (key) {
        return e('textarea', { style: S.textarea, value: f[key], onChange: set(key) })
      }
      var choose = function (key, options) {
        return e(
          'select',
          { style: S.input, value: f[key], onChange: set(key) },
          options.map(function (pair) {
            return e('option', { value: pair[0], key: pair[0] }, pair[1])
          }),
        )
      }

      var isStdio = f.transport === 'stdio'
      // 传输方式决定哪一组字段出现：stdio 与 streamable-http 的连接参数互斥，
      // 同时显示会让用户不知道该填哪一组（切回时保留已填内容，不清空）。
      var transportFields = isStdio
        ? [
            field(t('fieldCommand'), text('command', t('phCommand')), t('hintCommand')),
            field(t('fieldArgs'), area('args'), t('hintArgs')),
            field(t('fieldEnv'), area('env'), t('hintEnv')),
            field(t('fieldCwd'), text('cwd', t('phCwd'))),
          ]
        : [
            field(t('fieldUrl'), text('url', 'https://10.170.17.55:8091/mcp')),
            field(t('fieldHeaders'), area('headers'), t('hintHeaders')),
            field(
              t('fieldTlsInsecure'),
              choose('tlsInsecure', [
                ['false', t('optTlsInsecureNo')],
                ['true', t('optTlsInsecureYes')],
              ]),
              t('hintTlsInsecure'),
            ),
            field(t('fieldTlsCaFile'), text('tlsCaFile', t('phTlsCaFile'))),
          ]

      return e(
        'div',
        { style: S.card },
        field(t('fieldName'), text('serverName', t('phName'))),
        field(
          t('fieldTransport'),
          choose('transport', [
            ['stdio', t('optStdio')],
            ['streamable-http', t('optHttp')],
          ]),
        ),
        e(
          'div',
          { style: S.group },
          e('span', { style: S.groupTitle }, isStdio ? t('groupStdio') : t('groupHttp')),
          transportFields,
        ),
        e(
          'div',
          { style: S.group },
          e('span', { style: S.groupTitle }, t('groupGeneral')),
          field(t('fieldTimeout'), text('toolCallTimeoutMs', '', 'number')),
          field(
            t('fieldFailOnStartup'),
            choose('failOnStartupError', [
              ['false', t('optFailNo')],
              ['true', t('optFailYes')],
            ]),
          ),
          field(
            t('fieldReconnect'),
            choose('reconnectEnabled', [
              ['true', t('optReconnectOn')],
              ['false', t('optReconnectOff')],
            ]),
          ),
          field(t('fieldMaxAttempts'), text('reconnectMaxAttempts', '', 'number')),
        ),
        props.error ? e('p', { style: S.error }, props.error) : null,
        e(
          'div',
          { style: S.actions },
          button(
            {
              variant: 'primary',
              disabled: props.saving,
              onClick: function () {
                var server = buildServerObject(f, initial)
                if (!server.serverName) return props.onError(t('errName'))
                if (f.transport === 'stdio' && !server.command.trim()) return props.onError(t('errCommand'))
                if (f.transport === 'streamable-http' && !server.url) return props.onError(t('errUrl'))
                if (!f.toolCallTimeoutMs || !(Number(f.toolCallTimeoutMs) >= 1)) return props.onError(t('errTimeout'))
                if (!(Number(f.reconnectMaxAttempts) >= 1) || Number(f.reconnectMaxAttempts) % 1 !== 0)
                  return props.onError(t('errMaxAttempts'))
                props.onSave(server)
              },
            },
            props.saving ? t('saving') : t('save'),
          ),
          button({ onClick: props.onCancel }, t('cancel')),
        ),
      )
    }

    function McpSection() {
      var holder = useState({
        servers: [],
        status: {},
        rev: 0,
        loading: true,
        error: '',
        editing: null,
        saving: false,
        formError: '',
        notice: '',
        toggling: null,
        deleting: null,
        pending: null,
      })
      var data = holder[0]
      var setData = holder[1]

      var patch = function (part) {
        setData(function (prev) {
          return Object.assign({}, prev, part)
        })
      }

      var load = function () {
        loadServers()
          .then(function (d) {
            patch({ rev: d.rev || 0, servers: d.servers || [], status: d.status || {}, loading: false, error: '' })
          })
          .catch(function (err) {
            patch({ loading: false, error: String((err && err.message) || err) })
          })
      }

      useEffect(load, [])

      // 乐观锁冲突（409）：别的窗口/页面改过配置，刷新后再让用户确认；
      // 列表已重载，先前展开的确认条对应的配置可能已变，一并收起。
      var onConflict = function () {
        patch({ notice: t('noticeConflict'), error: '', formError: '', pending: null, deleting: null })
        load()
      }

      var save = function (server) {
        var next
        if (data.editing === 'new') {
          next = data.servers.concat([server])
        } else {
          var target = data.editing && data.editing.serverName
          next = data.servers.map(function (s) {
            return s.serverName === target ? server : s
          })
        }
        patch({ saving: true, formError: '' })
        saveServers(next, data.rev)
          .then(function () {
            patch({ saving: false, editing: null, notice: t('noticeSaved'), pending: null, deleting: null })
            load()
          })
          .catch(function (err) {
            if (err && err.code === 'conflict') {
              patch({ saving: false, formError: '' })
              onConflict()
              return
            }
            patch({ saving: false, formError: String((err && err.message) || err) })
          })
      }

      // 删除与「关闭」都先展开确认（在 ServerRow 里：外壳 RiskConfirmation，拿不到原语
      // 的版本退回内联条），确认后才走请求。acknowledged 只属于这一次确认，跟着
      // pending 一起生灭——目标或动作一变就是新的一次确认，从「未勾选」开始。
      var ask = function (server, action) {
        patch({ pending: { name: server.serverName, action: action, acknowledged: false }, error: '', notice: '' })
      }
      var cancelPending = function () {
        patch({ pending: null })
      }
      // RiskConfirmation 的勾选回调（勾上之前它的确认按钮一直是禁用的，这里只存状态）。
      var acknowledge = function (value) {
        if (!data.pending) return
        patch({ pending: Object.assign({}, data.pending, { acknowledged: value === true }) })
      }
      var confirmPending = function () {
        var pending = data.pending
        if (!pending) return
        var target = data.servers.filter(function (s) {
          return s.serverName === pending.name
        })[0]
        if (!target) {
          patch({ pending: null })
          return
        } // 列表已变（别处删掉了）
        if (pending.action === 'delete') remove(target)
        else toggle(target)
      }

      var remove = function (server) {
        var next = data.servers.filter(function (s) {
          return s.serverName !== server.serverName
        })
        patch({ deleting: server.serverName, error: '', notice: '' })
        saveServers(next, data.rev)
          .then(function () {
            patch({ deleting: null, pending: null, notice: t('noticeDeleted', { name: server.serverName }) })
            load()
          })
          .catch(function (err) {
            patch({ deleting: null })
            if (err && err.code === 'conflict') {
              onConflict()
              return
            }
            patch({ error: String((err && err.message) || err) })
          })
      }

      // 开启/关闭某台服务器：只翻转它的 enabled，其余配置原样提交。
      var toggle = function (server) {
        var enabling = server.enabled === false
        var next = data.servers.map(function (s) {
          return s.serverName === server.serverName ? Object.assign({}, s, { enabled: enabling }) : s
        })
        patch({ toggling: server.serverName, error: '', notice: '' })
        saveServers(next, data.rev)
          .then(function () {
            patch({
              toggling: null,
              pending: null,
              notice: enabling
                ? t('noticeEnabled', { name: server.serverName })
                : t('noticeDisabled', { name: server.serverName }),
            })
            load()
          })
          .catch(function (err) {
            patch({ toggling: null })
            if (err && err.code === 'conflict') {
              onConflict()
              return
            }
            patch({ error: String((err && err.message) || err) })
          })
      }

      var cards = data.servers.map(function (server) {
        return e(ServerRow, {
          key: server.serverName,
          server: server,
          status: data.status[server.serverName],
          toggling: data.toggling === server.serverName,
          deleting: data.deleting === server.serverName,
          pending: data.pending && data.pending.name === server.serverName ? data.pending.action : null,
          acknowledged: isAcknowledged(data.pending, server.serverName),
          onAcknowledgedChange: acknowledge,
          onToggle: toggle,
          onAsk: ask,
          onConfirm: confirmPending,
          onCancel: cancelPending,
          onEdit: function (s) {
            patch({ editing: s, formError: '' })
          },
        })
      })

      // 「添加服务器」的加号：外壳这一版有 IconPlusOutline16 就交给它画，否则留给字典
      // 文案里的全角 ＋（两条路都只用一次加号，见下面的按钮）。
      var addIcon = iconNode('IconPlusOutline16')

      return e(
        'div',
        { className: CLASS, style: S.section },
        e('h2', { style: S.title }, t('nav')),
        e('p', { style: S.intro }, t('intro')),
        data.error ? e('p', { style: S.error }, data.error) : null,
        data.notice ? e('p', { style: S.ok }, data.notice) : null,
        cards.length
          ? e('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } }, cards)
          : data.loading
            ? null
            : e('p', { style: S.intro }, t('empty')),
        data.editing
          ? e(ServerForm, {
              key: data.editing === 'new' ? 'new' : data.editing.serverName,
              initial: data.editing === 'new' ? null : data.editing,
              saving: data.saving,
              error: data.formError,
              onSave: save,
              onError: function (msg) {
                patch({ formError: msg })
              },
              onCancel: function () {
                patch({ editing: null, formError: '' })
              },
            })
          : button(
              {
                variant: 'primary',
                // 加号走外壳图标时，文案换成字典里不带字形的那条（addServer 自带全角 ＋，
                // 两者叠加会画出两个加号）；拿不到图标就一字不改地用字形文案。
                icon: addIcon,
                onClick: function () {
                  patch({ editing: 'new', formError: '' })
                },
              },
              addIcon === null ? t('addServer') : t('addServerNoIcon'),
            ),
        e('div', { style: S.actions }, button({ icon: iconNode('IconRefreshOutline16'), onClick: load }, t('refresh'))),
      )
    }

    // ── plugin ──────────────────────────────────────────────────────────────
    // 'locale' 是必需服务：宿主组合里没有 locale 插件时本插件整体不激活（而不是
    // 注册出一个没有文案的设置页）。bindLocale 仍对残缺的 ctx 兜底，见上。
    var inject = ['slots', 'locale']
    function apply(ctx) {
      bindLocale(ctx)
      var style = ensureStyles()
      ctx.effect(function () {
        return function () {
          style.remove()
        }
      })
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'mcp',
            order: 31,
            // thunk：外壳在语言切换后重新渲染导航并再次调用它，所以每次都取当前语言。
            label: function () {
              return t('nav')
            },
          },
          McpSection,
        )
      })
    }
    // 导出解析/组装助手与组件：浏览器加载器只消费 apply/inject，多出的导出
    // 仅用于 node:test 对客户端逻辑做兼容性测试（test/client-logic.test.js）。
    exports.apply = apply
    exports.inject = inject
    exports.MCP_SECTION_ID = 'mcp'
    exports.MCP_NS = NS
    exports.MCP_ZH = zh
    exports.MCP_EN = en
    exports.MCP_CLASS = CLASS
    exports.MCP_CSS = CSS
    exports.MCP_STYLES = S
    // 外壳原生组件（拿不到时为 null）。导出只为了让测试断言走的是哪条路径，
    // MCP_UI_ERROR 带着拿不到的原因。
    exports.MCP_UI = UI
    exports.MCP_UI_ERROR = PRIMITIVES_ERROR
    exports.parseLines = parseLines
    exports.parseEnv = parseEnv
    exports.parseHeaders = parseHeaders
    exports.joinEntries = joinEntries
    exports.buildServerObject = buildServerObject
    exports.ServerForm = ServerForm
    exports.ServerRow = ServerRow
    exports.ConfirmPrompt = ConfirmPrompt
    exports.ConfirmStrip = ConfirmStrip
    exports.isAcknowledged = isAcknowledged
    exports.McpSection = McpSection
    return module.exports
  },
})
