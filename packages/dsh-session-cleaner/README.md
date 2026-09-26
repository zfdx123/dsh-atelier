# @zfdx123/dsh-session-cleaner

给 DSH（DeepSeek Harness）补上**删除会话**的能力——从**运行中**的 web 运行时里删，不需要重启。DSH 只有「归档」：`workspace.archiveSession` 把会话 id 加进一个注册表集合，**文件仍留在磁盘上**；不存在 `session.delete`。本插件补上这个缺口：一次删除会清掉**四个表面**——live store 条目、工作区记账（归档集合与各 workspace 的会话槽）、磁盘产物目录、投影缓存行——并从三个入口暴露出来（侧边栏会话行的 ⋮ 菜单、设置页「会话清理」、一个 HTTP 路由），删除确认框复用 DSH 自己的 UI 原语，与「删除工作区」那个框同款。当前版本 1.0.9，面向 DSH `^0.1.7-rc.2`。

## 安装

```sh
# 从 npm 安装单个包
dsh plugin --profile web add @zfdx123/dsh-session-cleaner

# 一次装齐整套（MCP 管理器、技能管理器、记忆、CodeGraph、钩子排序、会话清理、Superpowers）
dsh plugin --profile web add @zfdx123/dsh-atelier

# 然后重启 dsh web（bundle 不做热加载）
```

安装时 `dsh plugin` 会把带 `dsh.bundle.patch` 的依赖自动补进 `dsh.profile.bundles`。卸载是可逆的：`dsh plugin --profile web remove @zfdx123/dsh-session-cleaner` + 重启。

**宿主那一半改完要重启**：`dsh web` 在启动时装配 bundle，客户端那一半不做热加载，所以改完代码后重启进程 + 刷新页面才会生效。

本地开发有两种装法，区别只在落盘形态：

```sh
# 软链（源码改完 profile 立刻就是新的，只需重启 dsh）
dsh plugin --profile web add link:/absolute/path/to/dsh-atelier/packages/dsh-session-cleaner

# 拷贝（Windows 上 file: 落成的是拷贝，改完要重新 add）
dsh plugin --profile web add file:/absolute/path/to/dsh-atelier/packages/dsh-session-cleaner
```

## 快速上手

### 侧边栏 ⋮ 菜单

会话行右侧 ⋮ → **「删除会话」**，位置紧跟在**「归档会话」下面**。点击 → 确认框 → 该行立即消失。**只有正在运行（`running`）的会话会被拒绝**——等它跑完再删；闲置（`idle`）的会话照删不误，也就是「我在界面里已经离开的会话」都能删。

### 设置页「会话清理」

列出**全部**会话：workspace 成员、未分组的游离会话、已归档会话、以及旧格式（裸 UUID）会话。

按 **workspace 分组**显示，不再混在一条时间线里：

- 组顺序与侧边栏一致（宿主给的 workspace 顺序），**「未分组」放最后**；组内按最近活动倒序，空组不渲染；
- 组头是 `名称 · N 个会话`，**点一下折叠/展开**（默认展开）；
- **已归档 / 旧格式只是行内徽章**，会话仍留在它所属的 workspace 组里——「归档」是行的属性，不是一个分组；
- 每行可**删除**；已归档的行额外提供**取消归档**。

搜索框：命中**组名**则整组保留，否则按行标题过滤；搜索时命中的组**自动展开**（命中藏在折叠的组里等于没搜到），组头计数改为 `命中/总数`。

### HTTP

```http
POST /api-ext/session.delete
Content-Type: application/json

{ "sessionId": "session-1bb8d361-ea6b-4b92-bab2-c858c92e8822" }
```

同源页面里可直接调用：

```js
await fetch('/api-ext/session.delete', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: 'session-…' }),
}).then(r => r.json());
```

响应沿用 host 的 JSON 信封：

```json
{ "ok": true,  "value": { "agentStatus": "idle", "liveBefore": true, "liveDetached": true,
                          "accounting": { "unarchived": true, "detached": ["…"] },
                          "files": { "root": "…", "removed": ["…"], "failed": [] },
                          "projection": { "ok": true, "deleted": true } } }
{ "ok": false, "error": { "code": "refused", "message": "…" } }
```

状态码：`200` 成功；`400 bad-request`（id 非法 / JSON 坏）；`405 method-not-allowed`（方法不是 POST）；`415 unsupported-media-type`（`content-type` 不是 `application/json`——两个路由都只收 JSON）；`409 refused`（会话正在运行）；`500 internal`。

### 排查：诊断路由

菜单项是 DOM 增强（见「已知限制」），所以客户端会把每一步观测 POST 到 `POST /api-ext/session.cleaner.diag`（`{ "report": { "event": "…", "detail": … } }`），同一个路由把这份**内存环形缓冲**（上限 100 条，不落盘）读回来；带一个 `inspect` 字段时还返回该会话的**只读**删除面报告——id 是否合法、sessions 根、会被删的产物目录、有没有 live 条目、agent 状态、是否已归档、属于哪些 workspace：

```js
await fetch('/api-ext/session.cleaner.diag', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ inspect: 'session-…' }),
}).then(r => r.json());
```

报告里还会给出 `agentStatus`——就是决定「删还是拒」的那一个字段（`null` 表示本进程里没有附着 agent，`idle` 可删，`running` 会被拒）。

它不删任何东西，是「插件到底看见了什么」的安全查看方式。

## 它做什么

- **删除四个表面。** 一次 `deleteSession` 依次做四件事：

  1. **live store**：如果该会话有内存条目就 detach 掉（`SessionStore.enter()` 返回的那个 disposer），并把该会话从**前端**的会话列表里摘掉。
     > **为什么会话会出现「有 agent 附着」这件事。** DSH 把一个会话装进内存的唯一入口是 agent：`sessions.enter` 只由 agent loop 调用，`session.list` 只是读 live 条目、其余从持久化 `summarizeCold`，**不会**把冷会话 prepare/enter 进 store。而 agent 一旦建立就**没有退出路径**——唯一的清理是 agent-loop 工厂自己那条生命周期 disposer（`dsh-agent-loop` `lib/index.js` 的 `dispose()`，`detachAgent?.(); detachSession?.()`），它只在 owner fiber 卸载时才跑。所以「在界面里点开过、现在没在跑」的会话，在**这次的 dsh web 进程里**永远带着一个 `status: 'idle'` 的 agent。早期版本因此把「有 agent」当成「被打开」一律拒绝，结果是这类会话**在重启前根本删不掉**（用户看到的是「已关闭的会话点了删除没反应」）——这是 bug，不是设计。
     > **现在只拦真正在跑的。** `agent.status === 'running'`（以及读不出状态这种无法归类的情况）才 `409 refused`；`idle` 照删：先 `detach` 掉 store 条目（`detachEntered` 在 `entry.announced === true` 时会发 `session/disposed`），再删文件。删完之后**磁盘上已不存在可追加的会话**，残留的 idle agent 对象停在记录表里（见「已知限制」）。
     > **踩过的坑：光 detach 不够时靠谁掉行。** 前端唯一的「会话没了」通知是 `session/disposed`，它只在 `entry.announced === true` 时才发。真正让界面掉行的是**客户端**：删完由客户端自己调 `ctx.sessions.handleSessionRemoved(id)`（正是 `api-session/removed` 中继调用的那个方法），再 `refresh()` 跟 host 基线对账——host 基线来自磁盘上的会话日志，已经不含它了。
  2. **记账**：从全局归档集合移除，并从每个记账了它的 workspace 移除（host 会据此推 `archived` 帧给前端，两个设置页的归档集合因此同步）。
  3. **磁盘**：删除 `<sessions 根>/<project>/<sessionId>`（遍历全部 project 目录，只删名字**恰好等于** id 的目录）。
  4. **投影缓存**：删除 `session_projcache` 里该会话的行（文件搜索索引是派生的，会自行收敛）；域没打开时该行保留，只写一条 warn 日志，删除本身仍然成功。

- **三个入口共用同一套语义。** 菜单、设置页、HTTP 都走同一个 `deleteSession`；两个界面入口还共用同一个确认框：用 DSH 自己的 UI 原语（`@deepseek-ai/dsh-client-ui-primitives` 的 `Modal` + `Button`）搭的标题 + 一句说明 + `[取消]` / `[删除]`，删除按钮是原生那种**红字描边**（`--dsw-alias-state-error-primary`）。
  - **不使用** `window.confirm` / `window.alert`——浏览器原生弹窗在这里既不统一也很丑；
  - 删除过程中框内显示「正在删除…」；**被拒绝（会话打开中）时框不关**，错误就显示在框里；
  - 只有 `Esc`、点遮罩、点 `[取消]` 或删除成功才会关闭。
- **⋮ 菜单与图标。** 菜单是命令式 DOM、没有自己的 React 树，所以这一侧的确认框挂在一个独立的 React root 上（`react-dom/client` 的 `createRoot`），用完即卸载；确认框本身与设置页是同一个组件。三个图标同样用 DSH 自己的图标组件，不自绘：搜索框 `IconSearchOutline16`、组头折叠箭头 `IconChevronDownOutline14`、⋮ 菜单里的 `IconTrashOutline16`。（图标组件只收 `{size, className}`，转发不了 `style`/`aria-hidden`，所以定位、旋转、颜色挂在图标外面那层 box 上，两条路径共用同一个 box。）⋮ 菜单里那个图标由 React 渲染进一个临时容器、把 SVG 取出来后再把临时 root 卸掉——菜单项背后不留挂着的 root。
- **组件库缺席就整体降级。** 组件库不存在或**缺少其中任一成员**时，插件整体退回自绘 SVG（确认框同时退回 `window.confirm`）：`loadPrimitives` 的形态检查是**全有或全无**的，所以「只到了一半」的组件库不会让界面变成一半原生一半自绘。
- **安全边界。** id 必须匹配 `^(session-)?<uuid>$`，否则直接 `bad-request`，不会进入任何路径拼接；**正在运行的会话拒绝删除**（`agent.status === 'running'`，以及状态读不出来这种无法归类的情况）——不会把正在跑的活儿从底下抽走；只删「位于 sessions 根之下、且目录名恰好等于该 id」的目录；两个路由都校验 HTTP 方法（POST）**和** JSON content-type（不符返回 415）。
- **sessions 根与宿主同源。** `sessionsRoot()` 复刻宿主的 `DSH_HOME` 处理：`$DSH_HOME` 为空或纯空白视为未设置 → `~/.dsh/sessions`；`~`、`~/`、`~\` 先展开再 `resolve`；相对路径按工作目录解析——所以插件和持久化后端永远指向同一棵树。
- **形态：bundle 而不是动态插件。** 同样的功能先用动态 Cordis 插件做过一版（未随本仓库发布）。bundle 形态在三点上更好：

  | 维度 | 动态插件 | bundle（本包） |
  | --- | --- | --- |
  | 持久性 | 进程级，DSH 重启即失效 | 装进 profile，**重启仍在** |
  | 跨平台 | 沙箱不给 Node API，只能 shell 出去（要分平台写引擎 + 处理引号） | 直接 `node:fs`，**无 shell、无平台分支** |
  | 入口 | 只能挂设置页 | 设置页 **+ 侧边栏 ⋮ 菜单** + HTTP 路由 |

## 前置要求

- DeepSeek Harness `^0.1.7-rc.2`（`engines.dsh`），且是 **web profile**：宿主侧声明 `webServer`、`workspaceRegistry`、`sessions`、`agents`、`storageDomain`，客户端侧要 `slots`/`locale`/`sessions`/`uiWorkspace`
- Node `^22.19.0 || >=24.0.0`
- peer `@deepseek-ai/cordis ^4.0.4`；`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-host-webserver`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-workspace` 为可选 peer（都声明为 `^0.1.7-rc.2`）
- 会话树的位置由 `DSH_HOME` 决定；插件的 `sessionsRoot()` 与宿主解析规则一致

## 已知限制

- **⋮ 菜单靠 DOM 增强。** DSH 没有给行菜单公开 Slot，所以只能在菜单打开时往里插一项。识别方式是**语义**的：菜单里同时含「归档会话」与「分叉会话/重命名」两个文案才认定为会话行菜单，插入点是包含两者的最小元素；行取**刚按下的 ⋮ 触发器**（`aria-label` 前缀或 `rowActions` 容器，3 秒新鲜度窗口），窗口外才退回 `closest('[role="treeitem"]')`——不靠矩形距离猜测。**观察是按需武装的**：空闲时一个 `MutationObserver` 都不建；按下 ⋮（`pointerdown`，或键盘激活按钮产生的 `click`）才在 `document.body` 上开一个**只收顶层插入**（`{ childList: true }`，无 `subtree`）的观察器，菜单落位即断开、最迟 3 秒断开。菜单本身靠 `[role="menu"]` 定位——DSH 的菜单都是挂在 `body` 下的 `role="menu"` portal（取自运行中的页面），所以一次查找只读菜单里那几个条目。这条路径曾经是**常驻的 `subtree` 观察器 + 按文案遍历每个新增子树**：逐元素读 `textContent` 的代价是子树规模的平方，打开一个 5MB 日志的会话实测**单次回调 14.6 秒、主线程冻结 15.3 秒**；改成按需武装后同一场景最长任务 0.72 秒、空闲期回调 0 次。若 DSH 改了这些文案、`role` 或挂载位置，该项会静默不出现（设置页仍然可用），诊断路由会记录跳过原因。
- **会话 id 从 React fiber 里读。** 行的 DOM 上没有任何携带 id 的属性，所以从行元素的 `__reactFiber$*` / `__reactInternalInstance$*` 向上找 10 层，取 `memoizedProps.node.id`（或 `props.sessionId` / `props.node.sessionId`）。拿不到才退回标题反查（走 `/api/session.list` 的目录，标题**重复时跳过注入**，避免删错）；目录取不到时只损失「运行中」标记，行仍可用。
- **正在运行（`running`）的会话拒绝删除**，不代用户中止。
- **删除后会在记录表里留下一个「孤儿」agent 对象（idle）。** 宿主没有对外公开的「卸载单个 agent」入口：能正常收尾的那条路（关持久化句柄、发 `agent/disposed`、把条目移出 `ctx.agents`）是 agent-loop 工厂私有的生命周期 disposer，只挂在 owner fiber 的 teardown 链上；从外面只能拿到 `scope` 或 store 条目，单独 `detach` 会留下一个「agent 还在、store 条目没了」的悬空对象（这正是早期版本要防的幽灵行）。所以本插件**不动它**：删除后该 agent 停在 `idle` 且其会话已从 store 摘除、磁盘已删，不会再跑任何一轮（会话重开也走不到它：`session.list` 只从持久化读列表，日志已不存在）。残留对象随进程结束消失，想立刻清空就重启 `dsh web`。
- **删除不可恢复**：文件、记账、live 条目、投影缓存行都会消失。
- **不广播 `session/disposed`（冷会话场景）。** 被删的会话若没有 live 条目，宿主不会发任何「会话没了」的事件——本页面由客户端自己把行摘掉；**其他已打开的页面/标签页要刷新才会同步**。
- **投影缓存域没打开时那一行会保留**（只写 warn 日志，删除仍返回成功）：缓存是折叠快捷方式而不是权威，下次冷读会自行收敛。
- **宿主半改动要重启进程**；客户端半刷新页面即可，但 bundle 整体不做热加载。

## 开发

```sh
node --test test/host.test.js   # node:test 版（host）
node test/run.js                # host + client 全部用例，平铺断言（受限沙箱里也能跑）
npm test                        # 上面两条依次跑
```

`test/cases.js` 是 host 用例，只操作 `mkdtemp` 出来的 scratch 目录：`deleteSession` 的第三个参数 `{ root }` 就是为此留的测试缝，**不会碰到真实会话**。

`test/client-cases.js` 是客户端用例：把 `client.js` 挂在一个极简的 `window.__ModuleLoader__` 垫片上、配一个**照抄真 React 语义**的替身（`props.children`、函数组件即时展开、hook 槽位跨渲染存活并在 setState 时重渲染），再给 `Modal`/`Button` 提供保持契约的替身（`Modal` 关闭时渲染 `null`），于是设置页可以**无浏览器、无 DOM、无框架**地被完整驱动——点删除、在确认框里点取消/删除、点组头折叠、往搜索框里打字——并断言它渲染了什么、对注入的服务做了什么。⋮ 菜单那一路另配一个迷你 DOM（节点、属性、子节点，以及安装器真正查询的那几个选择器；`MutationObserver` 替身会记下 `observe` 的目标与参数，且只在观察期间投递变更），于是菜单项也能被真正构建出来、点进去删一次。菜单观察这一路另有五条用例钉住代价：**空闲不建观察器**、观察参数只有 `{ childList: true }`、**没过触发器的新增子树一概不碰**（哪怕它带着菜单文案、甚至挂在会话行里）、键盘打开（`click`）也武装、菜单服务完即 `disconnect`。图标用例的组件库替身分三档（完整 / 缺图标 / 模块表缺失）并记录「哪个图标组件被调用」，同时区分「React 渲染出来的 svg」与「自绘的 svg」——所以「用原生图标」和「退回自绘」两条路径都有断言。

## 许可

MIT
