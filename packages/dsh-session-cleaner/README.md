# @zfdx123/dsh-session-cleaner

给 DSH（DeepSeek Harness）补上**删除会话**的能力——从**运行中**的 web 运行时里删，不需要重启。

DSH 只有「归档」：`workspace.archiveSession` 把会话 id 加进一个注册表集合，**文件仍留在磁盘上**；不存在
`session.delete`。本插件补上这个缺口。

## 安装

```sh
dsh plugin --profile web add file:E:\work\ai\dsh-session-cleaner\bundle
# 或者发布到 npm / git 之后：
# dsh plugin --profile web add @zfdx123/dsh-session-cleaner
# dsh plugin --profile web add github:<owner>/dsh-session-cleaner

# 然后重启 dsh web（bundle 不做热加载）
```

卸载（可逆）：`dsh plugin --profile web remove @zfdx123/dsh-session-cleaner` + 重启。

安装时 `dsh plugin` 会把带 `dsh.bundle.patch` 的依赖自动补进 `dsh.profile.bundles`。

> **改完代码要重启**：`dsh web` 在启动时装配 bundle，客户端那一半不做热加载，所以改完本目录后
> 重启 + 刷新页面即可生效。
> 本机当前是按**软链**装的（`link:E:\work\ai\dsh-session-cleaner\bundle` → profile 的
> `node_modules/@zfdx123/dsh-session-cleaner`），源码改完 profile 立刻就是新的，**不需要重新 add**。
> 若改用 `dsh plugin --profile web add file:…\bundle`，Windows 上落成的是**拷贝**，那才需要重新 add。

## 用法

### 删除确认框

两个入口共用**同一个确认框**，用的是 DSH 自己的 UI 原语
（`@deepseek-ai/dsh-client-ui-primitives` 的 `Modal` + `Button`），跟「删除工作区」那个确认框同款：
标题 + 一句说明 + `[取消]` / `[删除]`，删除按钮是原生那种**红字描边**（`--dsw-alias-state-error-primary`）。

- **不使用** `window.confirm` / `window.alert`——浏览器原生弹窗在这里既不统一也很丑；
- 删除过程中框内显示「正在删除…」；**被拒绝（会话打开中）时框不关**，错误就显示在框里；
- 只有 `Esc`、点遮罩、点 `[取消]` 或删除成功才会关闭。

### 图标

三个图标同样用 DSH 自己的图标组件，不自绘：搜索框 `IconSearchOutline16`、组头折叠箭头
`IconChevronDownOutline14`、⋮ 菜单里的 `IconTrashOutline16`。（图标组件只收 `{size, className}`，
转发不了 `style`/`aria-hidden`，所以定位、旋转、颜色挂在图标外面那层 box 上，两条路径共用同一个 box。）
⋮ 菜单是命令式 DOM、没有 React 树，组件库又只给组件不给标记，所以那个图标由 React 渲染进一个临时容器、
把 SVG 取出来后再把临时 root 卸掉——菜单项背后不留挂着的 root。

组件库缺席或**缺少其中任一成员**时，插件整体退回自绘 SVG（确认框同时退回 `window.confirm`）：
`loadPrimitives` 的形态检查是**全有或全无**的，所以「只到了一半」的组件库不会让界面变成一半原生一半自绘。

### ⋮ 菜单（侧边栏会话行）

会话行右侧 ⋮ → **「删除会话」**，位置紧跟在**「归档会话」下面**。点击 → 确认框 → 该行立即消失。
会话正在运行时该项置灰；已打开（有 agent 附着）的会话会被服务端拒绝，请先关闭它。

> 菜单是命令式 DOM，没有自己的 React 树，所以这一侧的确认框挂在一个独立的 React root 上
> （`react-dom/client` 的 `createRoot`），用完即卸载；确认框本身与设置页是同一个组件。

### 设置页「会话清理」

列出**全部**会话：workspace 成员、未分组的游离会话、已归档会话、以及旧格式（裸 UUID）会话。

按 **workspace 分组**显示，不再混在一条时间线里：

- 组顺序与侧边栏一致（宿主给的 workspace 顺序），**「未分组」放最后**；组内按最近活动倒序，空组不渲染；
- 组头是 `名称 · N 个会话`，**点一下折叠/展开**（默认展开）；
- **已归档 / 旧格式只是行内徽章**，会话仍留在它所属的 workspace 组里——「归档」是行的属性，不是一个分组；
- 每行可**删除**；已归档的行额外提供**取消归档**。

搜索框：命中**组名**则整组保留，否则按行标题过滤；搜索时命中的组**自动展开**（命中藏在折叠的组里等于没搜到），
组头计数改为 `命中/总数`。

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
{ "ok": true,  "value": { "liveBefore": true, "liveDetached": true,
                          "accounting": { "unarchived": true, "detached": ["…"] },
                          "files": { "root": "…", "removed": ["…"], "failed": [] },
                          "projection": { "ok": true, "deleted": true } } }
{ "ok": false, "error": { "code": "refused", "message": "…" } }
```

状态码：`200` 成功；`400 bad-request`（id 非法 / JSON 坏）；`405 method-not-allowed`（方法不是 POST）；
`415 unsupported-media-type`（`content-type` 不是 `application/json`——两个路由都只收 JSON）；
`409 refused`（会话被打开）；`500 internal`。

## 删除做了什么（四步）

1. **live store**：如果该会话有内存条目就 detach 掉（`SessionStore.enter()` 返回的那个 disposer），
   并把该会话从**前端**的会话列表里摘掉。
   > **踩过的坑：光 detach 不会让前端掉行。** 前端唯一的「会话没了」通知是 `session/disposed`，
   > 而 `SessionStore.detachEntered` 只在 `entry.announced === true` 时才发它——只有 agent 真正
   > 打开过的会话才会置位（`sessions.enter` 只由 agent loop 调用；`session.list` 只是读 live 条目、
   > 其余从持久化 `summarizeCold`，**不会**把冷会话 prepare/enter 进 store）。而本路由**拒绝**一切
   > 有 agent 附着的会话，所以它删掉的会话根本没有内存条目、任何事件都不会发。detach 那一步因此是
   > **防御性**保留的：万一有「agent 已消失、条目还在」的残留，也不能让它变成一个指向已删文件的幽灵行。
   > 真正让界面掉行的是客户端：删完由客户端自己调 `ctx.sessions.handleSessionRemoved(id)`
   > （正是 `api-session/removed` 中继调用的那个方法），再 `refresh()` 跟 host 基线对账——
   > host 基线来自磁盘上的会话日志，已经不含它了。
2. **记账**：从全局归档集合移除，并从每个记账了它的 workspace 移除（host 会据此推 `archived` 帧给前端，
   两个设置页的归档集合因此同步）。
3. **磁盘**：删除 `<sessions 根>/<project>/<sessionId>`（遍历全部 project 目录，只删名字**恰好等于** id 的目录）。
4. **投影缓存**：删除 `session_projcache` 里该会话的行（文件搜索索引是派生的，会自行收敛）。

## 安全

- id 必须匹配 `^(session-)?<uuid>$`，否则直接 `bad-request`，不会进入任何路径拼接；
- **有 agent 附着的会话拒绝删除**（running 或 idle 都算「已打开」）——不会把别人正在用的会话从底下抽走；
- 只删「位于 sessions 根之下、且目录名恰好等于该 id」的目录；
- 删除不可恢复：文件、记账、live 条目、投影缓存行都会消失。

## 为什么是 bundle 而不是动态插件

同样的功能先用动态 Cordis 插件做过一版（未随本仓库发布）。bundle 形态在三点上更好：

| 维度 | 动态插件 | bundle（本包） |
| --- | --- | --- |
| 持久性 | 进程级，DSH 重启即失效 | 装进 profile，**重启仍在** |
| 跨平台 | 沙箱不给 Node API，只能 shell 出去（要分平台写引擎 + 处理引号） | 直接 `node:fs`，**无 shell、无平台分支** |
| 入口 | 只能挂设置页 | 设置页 **+ 侧边栏 ⋮ 菜单** + HTTP 路由 |

## 开发

```sh
node --test test/host.test.js   # node:test 版（host）
node test/run.js                # host + client 全部用例，平铺断言（受限沙箱里也能跑）
```

`test/cases.js` 是 host 用例，只操作 `mkdtemp` 出来的 scratch 目录：`deleteSession` 的第三个参数
`{ root }` 就是为此留的测试缝，**不会碰到真实会话**。
`test/client-cases.js` 是客户端用例：把 `client.js` 挂在一个极简的 `window.__ModuleLoader__` 垫片上、
配一个**照抄真 React 语义**的替身（`props.children`、函数组件即时展开、hook 槽位跨渲染存活并在 setState 时重渲染），
再给 `Modal`/`Button` 提供保持契约的替身（`Modal` 关闭时渲染 `null`），于是设置页可以**无浏览器、无 DOM、无框架**
地被完整驱动——点删除、在确认框里点取消/删除、点组头折叠、往搜索框里打字——并断言它渲染了什么、
对注入的服务做了什么。
⋮ 菜单那一路另配一个迷你 DOM（节点、属性、子节点，以及安装器真正查询的那几个选择器），于是菜单项也能被真正
构建出来、点进去删一次。图标用例的组件库替身分三档（完整 / 缺图标 / 模块表缺失）并记录「哪个图标组件被调用」，
同时区分「React 渲染出来的 svg」与「自绘的 svg」——所以「用原生图标」和「退回自绘」两条路径都有断言。

## 已知边界

- **⋮ 菜单靠 DOM 增强**：DSH 没有给行菜单公开 Slot，所以只能在菜单打开时往里插一项。识别方式是**语义**的
  （同一处新增同时含「归档会话」与「分叉会话/重命名」两个文案才认定为会话行菜单），行通过刚点击的
  ⋮ 触发器定位——不靠时间窗或矩形距离猜测。若 DSH 改了这些文案，该项会静默不出现（设置页仍然可用）。
- **会话 id 从 React fiber 里读**：行的 DOM 上没有任何携带 id 的属性，所以从行元素的
  `__reactFiber$*` 往上找，取 `memoizedProps.node.id`（或 `props.sessionId`）。拿不到才退回标题反查，
   **标题重复时跳过注入**，避免删错。
- 会话打开中（idle agent）时拒绝删除，不代用户关会话。

## License

MIT
