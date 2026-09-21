# @zfdx123/dsh-mcp-manager

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）加一个「设置 → MCP 服务器」页面：在界面上配置 MCP（Model Context Protocol）服务器，**保存即生效**——宿主侧自动挂载/卸载 `@deepseek-ai/dsh-mcp-client` 实例，模型随即拿到或失去 `mcp__<名称>__<工具名>` 形式的工具。无需再手写 `cordis.patch.yml` 里的 MCP 行，也无需重启进程。

## 安装

从 npm 装（`dsh plugin` 会把这条命令转发给 profile 的 pnpm）：

```sh
dsh plugin --profile web add @zfdx123/dsh-mcp-manager
```

一次装齐整套插件用聚合包 `@zfdx123/dsh-atelier`：

```sh
dsh plugin --profile web add @zfdx123/dsh-atelier
```

`dsh plugin add` 会把包安装进 profile 的依赖，并因为本包声明了 `dsh.bundle`，自动把 `@zfdx123/dsh-mcp-manager` 追加到该 profile 的 `dsh.profile.bundles`（即应用本包的 `cordis.patch.yml` 层）。验证组合树：

```sh
dsh --profile web --dump-config   # 应能看到 mcp-manager 行
```

**重启 dsh 进程后生效**（bundle 层在启动时组合；插件代码改动也需要重启，见「开发」）。重启后刷新浏览器页面，打开 设置 → MCP 服务器 即可。

### 开发用：本地 link 安装

改代码直接生效，不必发版：

```sh
dsh plugin --profile web add link:E:/work/ai/dsh-atelier/packages/dsh-mcp-manager
```

`link:` 安装有一个必须知道的副作用（本地 dev 副本会盖住宿主副本），见「已知限制」与「开发」。

### 卸载

```sh
dsh plugin --profile web remove @zfdx123/dsh-mcp-manager
```

（同时移除 profile 依赖与 bundle 层。）

### 从旧包名 `@fishlikewater/dsh-mcp-manager` 升级

本分支**从 0.3.x 起**就不再沿用上游包名，当前包名是 `@zfdx123/dsh-mcp-manager`（版本 **1.0.0**）。若你的 profile 里记的还是旧名，**必须重装一次**——profile 里记的是旧名的依赖键与 bundle 行，只改包内文件会出现「宿主按旧名装载、包内自称新名」的错配（客户端 bundle 的注册 id 校验失败，设置页会消失）：

```sh
dsh plugin --profile web remove @fishlikewater/dsh-mcp-manager
dsh plugin --profile web add @zfdx123/dsh-mcp-manager
# 重启 dsh 进程，刷新页面
```

配置文件（`settings.yaml` 的 `mcp` 命名空间）不受影响，重装后服务器列表与开关状态照旧。

## 快速上手

重启并刷新页面后，打开 设置 → MCP 服务器：列出 / 新增 / 编辑 / 删除服务器，每张卡片上带挂载状态与「开启 / 关闭」按钮。

### 设置页字段

| 字段 | 传输 | 说明 |
|---|---|---|
| 名称（serverName） | 两者 | `[A-Za-z0-9_-]{1,32}`，全局唯一，决定工具名前缀 `mcp__<名称>__…` |
| 传输方式 | 两者 | `stdio` / `streamable-http` |
| 命令（command） | stdio | 可执行文件（支持绝对路径）或 `npx` 之类命令。**只填可执行文件本身** |
| 参数（args） | stdio | 每行一个参数；一行里写了多个词会按引号规则自动拆开（含空格的参数用双引号，如 `"C:\my dir\a.py"`） |
| 环境变量（env） | stdio | 每行 `KEY=VALUE`；值支持 `env:NAME` / `cred:NAME` 引用 |
| 工作目录（cwd） | stdio | 可选 |
| URL | http | 如 `http://localhost:3000/mcp`；内网自签名时用 `https://…` 并配合下面的 TLS 选项 |
| 请求头（headers） | http | 每行 `KEY: VALUE`；值支持 `env:NAME` / `cred:NAME` 引用 |
| 工具调用超时（toolCallTimeoutMs） | 两者 | 毫秒，默认 60000 |
| 启动失败即报错（failOnStartupError） | 两者 | 是否在首次连接/工具同步失败时报错（默认否，自动重连） |
| 断线自动重连（reconnectEnabled） | 两者 | 默认开启（退避重试）；关闭后连接断开不再重试 |
| 最大重连次数（reconnectMaxAttempts） | 两者 | 默认 10；连续失败达到该次数后放弃（日志与状态会提示需重载插件） |
| 允许自签名证书（tlsInsecure） | http | 默认否。开启后**只对该服务器的地址**跳过证书校验 |
| 自定义 CA 文件（tlsCaFile） | http | PEM 绝对路径。填写后用该 CA 严格校验该服务器证书（**推荐**，比关校验安全） |

保存后立即生效；删除后对应工具立即移除。

### 删除、关闭与开关

- 删除与「关闭」都是**先确认再执行**：确认用外壳原生的 `RiskConfirmation`（弹窗 + 必须先勾选「我已了解…」，勾上之前确认动作一直不可用），拿不到这套原生组件的版本退回卡片里的内联确认条（按钮配色与行为不变）。「开启」无副作用，不问。
- 每张服务器卡片上的「关闭 / 开启」按钮会立即停止 / 启动对应实例：关闭后工具马上移除、不再重连；开启后重新挂载并注册工具。
- 开关状态（`enabled`，默认 `true`）随配置一起持久化在 `settings.yaml`，重启 dsh 后保持；只影响被切换的那一台，其余服务器不受影响。

### 示例

`examples/mcp-servers.example.yaml` 给出了 `settings.yaml` 中 `mcp` 命名空间的示例（stdio、streamable-http、内网自签名 HTTPS 各一）。可以直接把它合并进 `$DSH_HOME/settings.yaml` 作为初始配置，再从设置页调整。

## 它做什么

- **设置页管理**：列出 / 新增 / 编辑 / 删除 MCP 服务器，带挂载状态。
- **每台服务器可单独开启/关闭**（`enabled` 开关）：关闭立即停止实例并移除工具，开启重新挂载并注册工具，状态持久化。
- **两种传输**：`stdio`（本地命令）与 `streamable-http`（远程 URL）。
- **内网自签名证书可用**：每台 `streamable-http` 服务器可开 `tlsInsecure`（只对该服务器地址跳过证书校验）或指定 `tlsCaFile`（用指定 CA 严格校验）；其余出站请求（含模型 API）的证书校验完全不变。
- **失败原因看得见**：连接失败不再只显示「连接失败，重试中…」——插件把 `fetch failed` 背后的证书/网络原因展开并给出可操作提示（例如「证书不受信任：开启允许自签名证书或填写 CA 文件」）。
- **真实挂载状态**：连接失败、重连中、重连成功、放弃重连等异步事件实时反映到设置页（截获 mcp-client 日志驱动），不再只显示乐观的「已挂载」。
- **并发保存保护**：GET/POST 携带 `rev` 修订号（乐观锁），配置被其他窗口改过时返回 409 并提示刷新，避免静默覆盖。
- **密钥不入盘**：env / headers 的值支持 `env:NAME`（进程环境变量）与 `cred:NAME`（DSH 凭据）引用，挂载时解析，`settings.yaml` 只存引用。
- **配置持久化在 `settings.yaml` 的 `mcp` 命名空间**（`mcp.servers`），改动热生效。
- **宿主侧按配置动态挂载 `@deepseek-ai/dsh-mcp-client` 实例**（断线自动重连、工具自动注册/注销由它负责）。
- **HTTP 接口不裸奔**：优先注册在 DSH 0.1.5 起提供的 `/api` 共享通道精确 Fetch 路由上（宿主施加 Host/Origin 信任栅栏 + 浏览器鉴权），拿不到 `connection` 服务时才退化为裸 `webServer` 路由并自行施加同样的判定（退到只允许回环来源）。
- **headless profile 也能用**：没有 `webServer` / `connection` 服务时跳过 HTTP 接口，只做实例管理。

### 内网自签名证书（HTTPS MCP 服务器）

典型的失败长相是设置页一直「连接失败，重试中…」，日志里只有一句 `TypeError: fetch failed`——真正的原因是 Node 默认校验证书时对自签名证书抛 `DEPTH_ZERO_SELF_SIGNED_CERT`。两种解法：

1. **推荐**：把服务器证书（或签发它的 CA）导出成 PEM，填进 `tlsCaFile`。证书仍然校验，只是多信任这一个 CA。
2. 临时/应急：把 `tlsInsecure` 设为「是」。此时只对这台服务器的 origin 关闭校验，其它请求（模型 API、web 搜索、其它服务器）不受影响。

两种方式都由宿主侧按 **origin** 定向实施，并且：

- 策略随服务器挂载生效、随卸载/删除释放；全部释放后 `globalThis.fetch` 还原成原函数（可逆，不会长期改变进程行为）；
- 因为 Node 内置 fetch 只接受内置 undici 的 dispatcher，定向分流走的是 npm `undici` 包自己的 `fetch`（本包已声明依赖）；undici 不可用时挂载直接报错，不会静默降级成「连不上但没原因」；
- CA 文件读不到、undici 缺失等失败都会写进日志并在设置页状态里显示。

> 也可以用系统级信任链代替：`NODE_EXTRA_CA_CERTS=<pem>` 或 `node --use-system-ca` 启动 dsh（需重启进程）。那样就不必逐台配置。

连不上时先跑诊断工具，它会分别打印 TLS 握手、证书内容和一次真实 `initialize` 的结果，用来区分「网络不通 / 证书不受信任 / 服务端拒绝」：

```sh
node scripts/probe-mcp-endpoint.mjs https://10.170.17.55:8091/mcp 你的token
```

### stdio 服务器填错了会怎样

常见误用是**把整条命令行粘进「命令」栏**（`...\python ...\server.py` 一行），参数栏里又一行写多个词。这会让 spawn 的 executable 变成「带空格的一整串」→ `ENOENT`，而 MCP 客户端只报 `McpError: MCP error -32000: Connection closed`，完全看不出原因。插件对此做了两件事：

1. **自动归一化**：`command` 里混进来的参数、`args` 每行里的多个 token 都会按引号规则拆开（不解释反斜杠转义，Windows 路径安全；`C:\Program Files\...\node.exe` 这种真实存在的带空格路径不会被误拆，也可用引号显式声明为一个整体）。每次改写都会写一条宿主告警。
2. **启动前置检查**：可执行文件找不到、脚本文件（绝对路径）不存在、工作目录不存在、`command` 里仍含多个 token 时，设置页状态直接给出可照改的一句话，例如
   `启动前置检查未通过：找不到可执行文件：...（路径是否正确？或它在 PATH 里吗？）`

> Windows 上 venv 的可执行文件是 `Scripts\python.exe`；写 `Scripts\python` 也能用（Windows 会补 `.exe`，插件同样识别）。

### 密钥不入盘（`env:` / `cred:` 引用）

密钥引用（`env:NAME` / `cred:NAME`）在挂载时解析：`env:` 读进程环境变量；`cred:` 经 DSH 的 `credentials` 服务解析（`resolve`），服务不可用或未配置时保留字面值并打日志。`settings.yaml` 里始终只存引用文本。

### HTTP 接口（供设置页使用）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/mcp/servers` | 返回 `{ rev, servers, status }`；`rev` 是命名空间修订号（乐观锁），`status` 是 `serverName -> { state: 'ok'\|'error'\|'disabled', message }` |
| POST | `/api/mcp/servers` | 请求体 `{ rev?, servers: [...] }`，整体替换并触发重挂载；`rev` 与当前修订不符返回 409 `{ code: 'conflict', rev }`；校验失败返回 400 `{ error }` |

接口的注册方式（DSH 0.1.5 起的兼容点）：

- 插件优先用 `ctx.connection.fetch.register({ path: '/api/mcp/servers', methods: ['GET','HEAD','POST'], requestBody: 'buffered', fetch })` 注册到 `/api` 共享通道的**精确 Fetch 路由**上。物理载体会先做 Host/Origin 信任栅栏与浏览器鉴权（`connection.requestRejection`），未鉴权的请求在到达插件之前就被 401/403 挡下。
- 只有在拿不到 `connection` 服务时（旧版 DSH 或非 Web 组装），才退回裸 `webServer.register`，并由插件自己调用 `connection.requestRejection`；连它也没有时只接受**本机回环来源**。
- 这条约束很重要：该接口能写入任意 `command`，而宿主会立即执行它。裸注册 + 无鉴权 = 未授权的任意命令执行（`dsh web --host 0.0.0.0` 场景下尤其致命）。

## 配置

配置持久化在 `settings.yaml` 的 `mcp` 命名空间（`mcp.servers`，数组），设置页保存即写入，热生效。文件里的结构与各键默认值：

```yaml
mcp:
  servers:
    - serverName: my-stdio-server
      enabled: true
      transport: stdio            # stdio | streamable-http
      command: npx
      args: ['-y', '@some/mcp-server']
      env:
        SOME_TOKEN: 'env:SOME_TOKEN'   # env:NAME / cred:NAME 引用，密钥不入盘
      cwd: ''
      url: ''
      headers: {}
      toolCallTimeoutMs: 60000
      failOnStartupError: false
      reconnectEnabled: true
      reconnectMaxAttempts: 10
      tlsInsecure: false          # 仅 streamable-http
      tlsCaFile: ''               # 仅 streamable-http，PEM 绝对路径（推荐）
```

| 键 | 默认 | 说明 |
|---|---|---|
| `serverName` | —（必填） | 唯一名，决定工具名前缀 `mcp__<名称>__…` |
| `enabled` | `true` | 关闭后实例停止、工具移除，但配置保留 |
| `transport` | `stdio` | `stdio` / `streamable-http` |
| `command` / `args` / `env` / `cwd` | `''` / `[]` / `{}` / `''` | stdio 传输的连接参数 |
| `url` / `headers` / `tlsInsecure` / `tlsCaFile` | `''` / `{}` / `false` / `''` | streamable-http 传输的连接参数 |
| `toolCallTimeoutMs` | `60000` | 工具调用超时 |
| `failOnStartupError` | `false` | 首次连接/工具同步失败是否直接报错（默认自动重连） |
| `reconnectEnabled` / `reconnectMaxAttempts` | `true` / `10` | 断线重连；只写改过的子键，其余交回 mcp-client 默认值 |

完整示例（含内网自签名 HTTPS 的两种解法）见 `examples/mcp-servers.example.yaml`。

## 前置要求

| 组件 | 版本要求 |
|---|---|
| Node | **`^22.19.0 \|\| >=24.0.0`**（`undici` 8.x 的下限是 22.19.0；`@deepseek-ai/dsh-mcp-client` 依赖 `Promise.withResolvers`） |
| DSH | **`^0.1.6-alpha.1`**（`engines.dsh` 与 peer 范围；本包按 `0.1.6-alpha.2` 的实际接口逐条核对过，`0.1.6-alpha.1` 亦已核对。`0.1.5` 系列也核对过，但已不在声明范围内） |
| `@deepseek-ai/dsh-mcp-client` | `^0.1.6-alpha.1`（peerDependency，由运行时提供；`reconnect` 配置从 0.1.5 起可选，`maxInstructionBytes` 从 0.1.6 起可选、默认 32768） |
| `@deepseek-ai/dsh-settings` | `^0.1.6-alpha.1`（peerDependency，可选：`ctx.settings` 由宿主提供） |
| `@deepseek-ai/cordis` | `^4.0.2`（peerDependency） |
| `dsh` CLI + pnpm | `dsh plugin` 命令转发给 pnpm；本包按 profile 的 pnpm 布局安装 |

普通依赖：`@deepseek-ai/schemastery`（配置 schema）与 `undici`（`^7.0.0 || ^8.0.0`，只用于按 origin 定制 TLS dispatcher）。客户端界面用外壳自带原生组件（`@deepseek-ai/dsh-client-ui-primitives`），拿不到时逐处降级，不会白屏。

## 已知限制

- **日志文案契约是「软」的**：设置页的真实挂载状态靠截获 mcp-client 的日志文案驱动，规则表以「前缀 + 关键词」为键。上游一旦改写文案，翻译就会落空、状态显示失真（历史上就发生过：`failed generation did not close within …` 被改写成 `failed generation could not confirm transport closure …`，导致「永久停止重连」的终态仍显示「已挂载」）。现在有三道防线：规则覆盖新旧措辞、**未识别的 error/warn 一律透传原文**（未知 ≠ 看起来正常）、`test/log-contract.test.js` 扫描上游源码文案，改词即变红。
- **`ns` → `namespace` 风险**：修订号（乐观锁）依赖 `settings` 描述符的 `ns` 字段，而 `dsh-settings` 的 README 已把 `ns`→`namespace` 列为 TODO。字段一旦改名，`currentRev()` 会退回 0，表现为**设置页每次保存都 409「已被其他窗口/页面修改」，保存链路整体不可用**。现在用 `settings/document-updated (ns, revision)` 的推送值兜底（事件参数是位置参数，不受字段改名影响），但这条依赖仍在。
- **HTTP 接口依赖载体**：需要 `connection`（首选）或 `webServer` 服务；headless 组装下两者都没有，此时没有 HTTP 接口，只剩实例管理（设置页也不存在）。
- **安全边界不可放宽**：接口能写入任意 `command` 并由宿主立即执行，所以必须走宿主鉴权/信任栅栏；插件退到裸 `webServer` 路由时会自行施加同样判定，最终退化为**只允许本机回环来源**。
- **请求体上限 1 MiB**：超过返回 413（`BODY_TOO_LARGE`）；上限判定在两条载体上统一，边界值不误杀。
- **导航图标不能自定义**：设置页导航那一行用外壳默认图标——外壳按 section id 硬编码图标且没有第三方注册点（0.2.x 那套 CSS 覆盖依赖外壳类名哈希 `VOzbGW_*`，DSH 0.1.5 的外壳已不输出这些类名，遂删除）。
- **`link:` 安装时本地 dev 副本会盖住宿主副本**：profile 用 `link:` 装本包时，Node 按真实路径解析依赖，插件 `import '@deepseek-ai/dsh-mcp-client'` 拿到的是**本仓库 `node_modules` 里的那份**（可能远旧于宿主实际加载的版本），而**不是**宿主 profile 里的那份。后果：本地跑得很正常，线上（正常的 npm 安装，peer 由宿主提供）才暴露版本差异。缓解办法见「开发」。

## 开发

### 结构

```
├── package.json       # dsh.bundle.patch + dsh.client 双 manifest
├── cordis.patch.yml   # bundle 层：插入 mcp-manager 行
├── index.js           # 宿主侧：settings 注册 + 实例挂载 + HTTP 接口注册（两套载体）
├── lib/logic.js       # 纯逻辑：settings schema、校验、配置构造、指纹、日志翻译、密钥引用
├── lib/api.js         # 纯逻辑：/api/mcp/servers 的请求处理（与载体无关）+ 回环判定
├── lib/tls.js         # 每服务器 TLS 策略 + 定向 fetch 分流 + 失败原因展开
├── client.js          # 客户端 bundle（手写 CJS factory，经 ./client 导出）
├── test/              # node:test 套件（见下）
├── fixtures/          # E2E 用的极简 MCP 服务器（stdio / 自签名 HTTPS），不被打包、不被当作测试执行
├── scripts/           # pack 内容白名单校验、MCP 端点诊断工具
└── examples/
```

### 注意

- **改代码后必须重启 dsh 进程**：Node 的 ESM 模块缓存不会随文件变化失效。配置数据不需要重启（设置页保存即热生效）。
- `client.js` 是给浏览器模块加载器的 bundle（`window.__ModuleLoader__.load` 格式），直接手写维护，不需要打包器。
  **注册 id 必须是包名**（`@zfdx123/dsh-mcp-manager`）：宿主按 `__DSH_BOOT__` 图里的 entry id（= 包名）装载 `/plugins/??<包名>/client.js`，装载后会校验 `__ModuleLoader__` 里存在该 id，写短名会在挂载阶段直接抛错、设置页永远不出现（`test/client-logic.test.js` 有断言守着这条）。
- **改包名时必须同步四处**（漏一处就会出问题）：`package.json` 的 `name`、`cordis.patch.yml` 的 `name`（bundle 行）、`client.js` 里 `__ModuleLoader__.load` 的 `id`（**必须等于包名**）、以及每个已安装 profile 的依赖键与 `dsh.profile.bundles` 列表（重新 `dsh plugin remove/add` 即可）。本分支用 `@zfdx123/` scope 是因为无 scope 的 `dsh-mcp-manager` 已被他人占用。
- 表单/配色分两层：布局与几何走 React 内联样式，颜色走插件自己的 `--mcp-*` 变量（优先取外壳的 `--dsw-alias-*`，令牌缺失时回退到内置亮/暗色）。插件会注入**一小段自有样式**（`<style id="dsh-mcp-manager-style">`，随 fiber 卸载移除），只做内联样式表达不了的事：按 `body[data-ds-dark-theme]` 绑定 `color-scheme`、给原生控件与每个 `<option>` 显式写死背景/文字色、占位符与禁用态定色。外壳自己不声明 `color-scheme`，暗色主题下 `<select>` 下拉弹层 / 数字微调按钮 / 滚动条会退回亮色渲染，浅色文字落在白底弹层上就是「文字与背景同色看不见」。这段样式的选择器只命中本插件自己的 `.dsh-mcp-manager` 容器，不依赖任何外壳类名。
- 交互件优先用外壳原生组件（`@deepseek-ai/dsh-client-ui-primitives` 挂在基线模块表里，直接 `require`，不需要在 `dsh.client` 声明 external/inject）：Button / Input / Switch / Tag / StateDot、删除与关闭的确认框 `RiskConfirmation`，以及图标。取用一律**守卫式**（`loadPrimitives()` 形状校验；单个组件/图标缺失只降级那一处，不把整套原语扔掉），拿不到就退回自带元素与文字字形，绝不白屏。所以「添加服务器」的加号有两条路：有 `IconPlusOutline16` 时走 `Button` 的 `icon` 槽（图标不进 children，无障碍名与文案不被图标污染），文案用字典里不带字形的 `addServerNoIcon`；没有图标时用 `addServer`（值自带全角 ＋），一个字都不改。确认框的勾选项与关闭按钮文案同样归 zh/en 字典（`confirmDeleteAck` / `confirmDisableAck` / `close`）。
- **`link:` 安装下必做的一件事**：用宿主真实加载的副本再跑一遍日志文案契约（因为本地 `node_modules` 的那份可能不是宿主用的那份）：

  ```bash
  # 用宿主真实加载的副本再跑一遍日志文案契约（link 安装下必做）
  DSH_MCP_CLIENT_SRC="C:/Users/<you>/.dsh/profiles/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js" node --test test/log-contract.test.js
  # 逐条打印文案 → 状态翻译结果
  MCP_LOG_CONTRACT_PRINT=1 node test/log-contract.test.js
  ```

  同时把 `devDependencies` 的 `@deepseek-ai/dsh-mcp-client` 钉在宿主当前版本（`^0.1.6-alpha.2`），让本地测试与线上尽量同源。

### 兼容性

| 组件 | 版本要求 |
|---|---|
| Node | **`^22.19.0 \|\| >=24.0.0`** |
| DSH | **`0.1.6-alpha.2`**（本包按该版本的实际接口逐条核对过；`0.1.6-alpha.1` 亦已核对。`0.1.5` 系列也核对过，但 peer 范围已收紧到 `^0.1.6-alpha.1`，不再是声明支持的版本线） |
| `@deepseek-ai/dsh-mcp-client` | `^0.1.6-alpha.1`（peerDependency；`reconnect` 配置从 0.1.5 起可选，`maxInstructionBytes` 从 0.1.6 起可选、默认 32768） |
| `@deepseek-ai/dsh-settings` | `^0.1.6-alpha.1`（peerDependency；`ctx.settings` 由宿主提供） |
| `@deepseek-ai/cordis` | `^4.0.2` |

### 历史修复记录（当前版本 1.0.0）

本包版本已到 **1.0.0**；下面两张表是**历史**版本的修复记录，保留下来是因为它们记录了「代码为什么长这样」。表里引用的 `0.1.5` / `0.1.6-alpha.x` 都是 **DSH 侧**（或 mcp-client 侧）的版本号，不是本包的版本。

#### 0.3.4（历史）：按 DSH 0.1.6-alpha.1 的核对结果做的修复

| 问题 | 影响 | 修法 |
|---|---|---|
| **日志文案漂移**：0.1.6-alpha.1 把 `failed generation did not close within …` 改写成 `failed generation could not confirm transport closure …`（拆卸期文案同样被改写） | 规则以整句英文文案为键 → 匹配落空 → `settleFailedGeneration` 的**终态**（永久停止重连）在设置页不呈现，仍显示「已挂载」 | 规则表改为「前缀 + 关键词」，覆盖新旧两种措辞；**未识别的 error/warn 一律透传原文**（未知 ≠ 看起来正常）；新增 `test/log-contract.test.js` 扫描上游源码文案，改词即 CI 变红 |
| **1 MiB 请求体上限只对一条载体生效**：`connection.fetch` 路径直接 `request.text()`，实际上限是宿主的 300MB | 体积契约形同虚设 | 上限判定下沉到与载体无关的 `lib/api.js`：两条路径统一返回 **413**（`BODY_TOO_LARGE`），边界值不误杀 |
| **`HEAD` 未注册**：处理器实现了 HEAD，路由只注册 `GET/POST` | 已鉴权的 HEAD 落到 404 | `methods: ['GET','HEAD','POST']`（与宿主允许的枚举一致） |
| **apply 阶段同步取 `connection`**：服务尚未激活时静默降级到裸 `webServer` 路由且不留痕迹 | 装配顺序一变就换载体，行为差异不可观测 | 仍在 apply 时优先用 Fetch 路由；取不到时先挂裸路由，再 `ctx.inject(['connection'], …)` 等它出现后**升级并撤掉裸路由**（不把 `connection` 放进顶层 `inject`，否则 TUI/headless 组装会加载失败） |
| **修订号依赖描述符字段名**：`describe()` 的 `ns` 字段一旦被上游改名（`dsh-settings` README 已把 `ns`→`namespace` 列为 TODO），`currentRev()` 退回 0 | 设置页每次保存都 409「已被其他窗口/页面修改」，保存链路整体不可用 | `settings/document-updated (ns, revision)` 的推送值兜底（事件参数是位置参数，不受字段改名影响） |

#### 0.3.0（历史）：针对 DSH 0.1.5 对齐的几处

都是按运行时安装的实际包逐条核对，不是猜的：

1. **客户端 bundle 注册 id**：必须是包名（`@zfdx123/dsh-mcp-manager`）。宿主装完 `/plugins/??<包名>/client.js` 后会校验该 id 的 factory 是否注册过，写短名会抛 `bundle ... loaded without registering "<id>"`，设置页永远不出现。
2. **HTTP 接口载体**：0.1.5 的 `/api` 由 `connection` 插件以 prefix 路由独占，并施加 Host/Origin 信任栅栏 + 浏览器鉴权。插件改用 `connection.fetch.register` 注册精确 Fetch 路由（宿主负责鉴权），不再裸挂 `/api/...`。
3. **`reconnect` 配置**：0.1.5 的 mcp-client `Config` 新增可选项 `reconnect: { enabled, initialDelayMs, maxDelayMs, maxAttempts }`；本插件按需输出该键（只写改过的子键，其余交回 mcp-client 默认值）。
4. **导航图标覆盖移除**：外壳不再输出 `VOzbGW_navList/navCell/navIcon`，CSS 覆盖在任何版本上都不会命中，已删除（连带删除注入 `<style>` 与自检代码）。
5. **同源实例隔离**：mcp-client 用 `activeServerNames` 按 scope 保留 `serverName`，卸载/重挂同名实例必须等旧实例 `dispose()` 完成，否则报 `already in use`——本插件的挂载路径保持串行等待。

### 测试（兼容性）

`npm test`（node:test，无需额外框架）：

- `test/host-logic.test.js`：settings 命名空间 schema、HTTP 校验、mcp-client 配置构造（含 `reconnect`）、配置指纹、mcp-client 日志 → 状态翻译（用真实日志文案做夹具）、密钥引用解析
- `test/api.test.js`：`/api/mcp/servers` 的纯逻辑（GET/POST、rev 409、400 校验、405、回环判定、**请求体上限 413 与边界值**）
- `test/log-contract.test.js`：**日志文案契约快照**——从实际安装的 `@deepseek-ai/dsh-mcp-client` 源码抽出全部 `ctx.logger.*` 文案，逐条过一遍状态翻译，要求每条 error/warn 都被规则表**翻译**（而不是落到"未识别透传"兜底）；上游改词 → 这条先红。可用 `DSH_MCP_CLIENT_SRC` 指向宿主真实加载的副本
- `test/tls.test.js`：TLS 策略提取、定向 fetch 分流（只有登记过的 origin 被分流）、错误链展开与提示、引用计数与可逆性、失败路径不静默
- `test/stdio.test.js`：命令行分词（引号规则、反斜杠不转义）、stdio 配置归一化（粘进来的命令行 / npx 风格 / 带空格路径不被误拆 / 引号保护）、真实文件系统探针（含 Windows 补 `.exe`）、启动前置检查
- `test/client-logic.test.js`：把 `client.js` 加载进 vm 沙箱，测注册契约（id = 包名）、表单渲染契约（stdio 与 streamable-http 的连接参数互斥、通用项都在）、主题样式契约（`color-scheme` 亮/暗两套、option 显式配色、`--mcp-*` 定义与引用一致、样式表注入/卸载）、外壳原生组件契约（kit 路径用原生 Button/Input/Switch/Tag/StateDot/`RiskConfirmation`/图标，且「没有这个包」「同名模块形状不对」「有原语但缺单个组件」三种降级都退回自带元素与文字字形），以及「客户端表单产出 → 宿主校验」的往返契约
- `test/contract.test.js`：用真实的 `@deepseek-ai/dsh-mcp-client` `Config` schema 校验 `buildClientConfig` 的产出——它两边的配置契约一旦偏离，测试先红；同时断言 TLS 字段绝不进入实例配置
- `test/e2e.test.js`：端到端冒烟——内存 Cordis 上下文 + 假 settings/tools/webServer/connection 服务 + 极简 stdio MCP 服务器（`fixtures/fake-mcp-server.mjs`），走真实 HTTP 验证「保存即生效」全链路（挂载、工具注册、真实失败状态、rev 409、开关、引用），并断言接口注册在 `connection.fetch` 上、未鉴权请求 401
- `test/tls-e2e.test.js`：自签名 HTTPS MCP 服务器（`fixtures/tls-mcp-server.mjs` + `fixtures/tls/*.pem`，一次性生成的测试证书）端到端——对照组（不开 TLS 选项）必然失败并记录证书原因；开 `tlsInsecure` 后工具注册；改用 `tlsCaFile` 也能连通；移除后 `globalThis.fetch` 还原

`scripts/check-pack.mjs` 校验打包内容白名单，可单独 `npm run check:pack` 执行。

## 许可

MIT
