# dsh-memery：DSH 接入 Memorix + 原生「记忆」侧栏面板 — 设计文档

**日期**：2026-09-15
**状态**：已与用户确认（路线 B：完整接入 + 自建面板；HTTP 常驻；默认 resolve 软隐藏 + 真删二次确认）

## 1. 目标

让 DeepSeek Harness 拥有**可管理的项目记忆**：

1. 模型侧：通过 MCP 使用 Memorix 记忆工具（`mcp__memorix__*`）。
2. 人类侧：在 DSH 界面里直接查看、检索、清理记忆——不必切到 Memorix 自己的 Dashboard。

「可管理」= 列表 / 搜索 / 筛选 / 详情 / 软隐藏(resolve) / 删除 / 打开外部 Dashboard / 服务状态。
**不含**写入记忆：记忆写入仍由模型经 MCP 完成，面板是只读 + 清理控制面。

## 2. 现状事实（已实测，非推测）

| 事实 | 值 / 证据 |
|---|---|
| DSH 版本 | `0.1.5-rc.1`（全局 npm 包） |
| 活动 profile | `web`，路径 `C:\Users\29154\.dsh\profiles\web` |
| 组合装配点 | `profiles/web/package.json` 的 `dsh.profile.bundles` + 各包 `dsh.bundle.patch` |
| MCP 服务器管理 | 已装 `@zfdx123/dsh-mcp-manager` v0.3.3（本地 `E:/work/ai/dsh-mcp-manager`），设置页「MCP 服务器」，配置存 `settings.yaml` 的 `mcp.servers`，**保存即热生效，无需重启** |
| 已有服务器 | `logs`(streamable-http)、`http-inspector`(stdio) |
| Node | v24.19.0（memorix 要求 ≥22.18） |
| memorix | 本次安装 **v1.9.3**（全局 `D:\Development_dependency\npm_prefix\node_modules\memorix`） |
| control plane | 已跑通：`memorix background start` → PID 22164，`http://127.0.0.1:3211`，`/health` 返回 `{"status":"ok","profile":"team"}` |
| 工作区 | `E:\work\ai\dsh-memery`，本次已 `git init`（Memorix 项目身份依赖 Git root） |

### 面板插槽（从宿主已装的 `dsh-lovelyaudit` 实测得来）

- 侧栏折叠面板：`ctx.slots.inject('sidebar.footer.action', …)` — 「黑盒/代审」就是这么挂的
- 设置页分区：`ctx.slots.inject('settings.section', …)`
- 客户端 bundle 契约：`window.__ModuleLoader__.load({ id: '<包名>', factory })`，factory 内 `require('react')` / `require('react/jsx-runtime')`；**注册 id 必须等于包名**，否则宿主校验失败、面板永不出现

### 宿主 HTTP 端点注册契约（从 `dsh-mcp-manager` 实测得来）

```js
ctx.effect(() => connection.fetch.register({
  path: '/api/…', methods: ['GET','POST','DELETE'],
  requestBody: 'buffered',
  fetch: async (request) => new Response(body, { status, headers }),
}), 'label')
```

拿不到 `connection` 时退回 `webServer.register({ kind:'exact', path, handler })`，并由插件自己施加 `connection.requestRejection` 或回环判定。

### Memorix 管理 API（读自安装包的 `src/cli/commands/serve-http.ts`，并实测 200）

| 端点 | 说明 |
|---|---|
| `GET /api/projects` | 项目列表（当前为空数组，因新项目尚无记忆） |
| `GET /api/stats` | 实体/关系/观察计数、类型分布、来源分布、保留状态、embedding 状态 |
| `GET /api/observations` | 当前项目 active 观察列表（**无分页、无搜索参数**） |
| `GET /api/sessions` | 会话摘要 |
| `DELETE /api/observations/:id` | 删除单条；`?project=` 不匹配该条所属项目时返回 403 |
| `POST /api/maintenance/{cleanup,deduplicate,consolidate,retention}/{preview,execute}` | 维护操作，preview/execute 两段式 + token |
| `GET /api/export` | 导出 JSON |

**项目作用域**：所有端点接受 `?project=<projectId>`；省略时落到服务启动目录的默认项目。`projectId` 形如 `<owner>/<repo>`（`resolveRequestProject` 取 `/` 后段作为显示名）。

## 3. 架构

```
DSH 设置 → MCP 服务器 ──mcp-manager 热挂载──▶ mcp-client(streamable-http)
                                                │  http://127.0.0.1:3211/mcp
                                                ▼
                                    memorix control plane（常驻 :3211）
                                      · SQLite 主库
                                      · Dashboard + /api/*
                                                ▲
   DSH 侧栏「记忆」面板 ──▶ 宿主转发端点 ───────┘
     (浏览器)              /api/dsh-memery/*   (服务端→服务端，无 CORS/鉴权栅栏问题)
```

**为什么是宿主转发而不是浏览器直连 3211**：浏览器直连会撞 CORS（Memorix 明确不使用 `*`，走 localhost-only 策略），且绕过 DSH 自身的 Host/Origin 信任栅栏。宿主转发把「谁能访问」交给宿主既有的鉴权，插件不自己发明安全模型。

**为什么 HTTP 而不是 stdio**：面板要读 `:3211/api/*`；control plane 常驻才能让多会话共用一个记忆池并保持 Dashboard 可用。

## 4. 组件

### 4.1 MCP 接入（零代码）

在 `settings.yaml` 的 `mcp.servers` 增加：

```yaml
- serverName: memorix
  enabled: true
  transport: streamable-http
  command: ""
  args: []
  env: {}
  cwd: ""
  url: http://127.0.0.1:3211/mcp
  headers: {}
  toolCallTimeoutMs: 60000
  failOnStartupError: false
  tlsInsecure: false
  tlsCaFile: ""
  reconnectEnabled: true
  reconnectMaxAttempts: 10
```

工具将以 `mcp__memorix__<tool>` 出现。**改 settings.yaml 需重启 dsh 进程**才被 mcp-manager 读入；此后在设置页增删改都热生效。

### 4.2 新插件 `dsh-memery`（本项目）

| 文件 | 职责 |
|---|---|
| `package.json` | name / `dsh.bundle.patch` / `dsh.client`（platform web，inject `@deepseek-ai/dsh-client-ui-sidebar`、`@deepseek-ai/dsh-client-ui-settings`） |
| `cordis.patch.yml` | `- insert: [{ id: dsh-memery, name: dsh-memery }]` |
| `index.js` | 宿主入口：组装端点逻辑 + 注册 HTTP 路由（两套载体） |
| `lib/upstream.js` | memorix 控制面客户端：`getStats/getProjects/listObservations/resolve/deleteById/health`，统一超时与错误映射 |
| `lib/logic.js` | **纯逻辑**：端点路由分发、查询参数校验、筛选/搜索/分页、格式化 |
| `lib/endpoints.js` | 把 `lib/logic` 接到 `lib/upstream`：`api({method, readBody, query}) -> {status, headers, body}` |
| `client.js` | 浏览器 bundle：侧栏「记忆」面板 + 设置页「记忆」分区 |
| `test/*.test.js` | `node --test`：纯逻辑 + 端点（假 upstream）+ 客户端注册契约 |
| `examples/` | settings.yaml 片段，便于复现 |

**分层理由**：`lib/logic.js` 无 IO → 可在无网络、无控制面的情况下快速测；`lib/upstream.js` 是唯一碰网络的地方 → 端点测试用假 upstream 注入，不需要真跑 3211。

### 4.3 面板功能（v1）

| 功能 | 实现 |
|---|---|
| 记忆池概览 | `GET /api/stats` → 总数 / 类型分布 / 来源分布 / 保留状态 / embedding 状态 |
| 列表 | `GET /api/observations`，宿主侧做关键词搜索 + 类型/来源筛选（上游无此参数） |
| 详情 | 选中行展示标题、叙述、事实、涉及文件、概念、时间、来源 |
| 软隐藏 | REST **没有** resolve 端点（已核对全部 `apiPath` 分支），故走 `POST /api/dsh-memery/resolve` → 宿主 spawn CLI **`memorix memory resolve --ids <id> [--status resolved\|archived] --cwd <git-root> --json`**（子命令已实测存在）。CLI 不可用或非零退出时返回明确错误，绝不假装成功 |
| 真删 | `DELETE /api/observations/:id?project=`，二次确认 |
| 打开 Dashboard | 外链 `http://127.0.0.1:3211` |
| 服务状态 / 启停 | `/health` 探活；启停走 `memorix background start|stop` |

> resolve 的兜底实现是本次设计里**唯一未实测的环节**，实现时先验证 `memorix memory resolve --help` 的真实子命令名，若不匹配则改为「引导用户去 Dashboard」并如实记录，绝不静默降级。

### 4.4 维护操作

`/api/maintenance/*/preview` 只读展示；`execute` **不在面板提供**，跳转 Dashboard。避免在 DSH 里放一键破坏性操作。

## 5. 数据流

```
面板点击刷新
  → client.js fetch('/api/dsh-memery/observations?project=<id>&q=<kw>&type=<t>')
  → 宿主 lib/endpoints.js
      → lib/logic.js 校验/归一化参数
      → lib/upstream.js GET http://127.0.0.1:3211/api/observations?project=<id>
      → lib/logic.js 本地搜索/筛选/分页
  → { ok:true, data:{ items, total, counts } }
  → 面板渲染
```

**项目作用域解析**：面板默认作用于工作区 Git 根对应的项目。宿主启动时用 `git rev-parse --show-toplevel` 得到工作区路径，再从 `/api/projects` 里按路径匹配出 `projectId`；匹配不到则回退为「不传 project」（即控制面默认项目）并在 UI 明示当前作用域，避免把 A 项目的记忆显示成 B 项目的。

## 6. 错误处理

统一响应：成功 `{ ok:true, data }`；失败 `{ ok:false, error, hint?, code? }`，HTTP 状态反映语义。

| 情况 | 行为 |
|---|---|
| 3211 不可达 / 连接被拒 | `503`，`code:'control_plane_down'`，面板显示「控制面未运行」+ 一键启动，而不是空白页 |
| 上游 4xx/5xx | 透传状态码与上游 error 文本，附 `hint` |
| 上游响应非 JSON | `502`，`code:'bad_upstream'`，截断原文便于排查 |
| 参数非法（id 非数字、type 非法值、limit 超界） | `400`，**在打上游之前就拒绝** |
| 删除目标属其它项目 | 上游 403 原样透传，`hint` 提示当前作用域 |

## 7. 安全

- 端点只注册在宿主的 `connection.fetch`（宿主施加 Host/Origin 信任栅栏 + 浏览器鉴权）；退化到 `webServer` 时自行调用 `requestRejection`，再退化则只允许回环来源。
- 面板不做记忆写入；删除需显式二次确认；维护类 execute 不在面板暴露。
- 不把 memorix 的任何凭据写入 settings.yaml；控制面仅绑定本机回环。
- 上游 URL 由宿主固定拼接，不接受面板传入任意 URL（避免变成 SSRF 跳板）；`project` 参数只允许 `[A-Za-z0-9._/-]` 字符集。

## 8. 测试策略

- `test/logic.test.js`：参数校验（非法 id/type/limit 必须 400）、搜索/筛选/分页边界、作用域字段透传。
- `test/endpoints.test.js`：注入假 upstream，断言成功包装、上游 404/403/500 映射、非 JSON → 502、控制面不可达 → 503。
- `test/upstream.test.js`：用本地 `node:http` 起极简假 memorix，验证真实 fetch 路径、超时、JSON 解析失败分支。
- `test/client-logic.test.js`：vm 沙箱加载 `client.js`，断言 `__ModuleLoader__.load` 的 **id 等于包名**、注册的 slot 名与 id、以及筛选/格式化纯函数的往返契约。
- 端到端（手工，需真控制面）：面板取到真实 stats；删一条测试记忆后列表减一；停掉控制面后面板显示不可用而不是空列表。

## 9. 前置修复

`E:\work\ai\dsh-memery` 必须先是 Git 仓库，否则 Memorix 项目身份为 `__unresolved__`，记忆无法归属。**本次已 `git init`，仍需首次提交**（`git commit` 需要至少一个文件）。

## 10. 取舍记录

- **面板不做写入**：记忆写入走模型的 MCP 工具，符合 Memorix 的 scope 语义（个人/团队记忆需要 joined identity），避免面板越权写。
- **宿主转发而非浏览器直连**：多一跳，换来 CORS 无关 + 复用宿主鉴权 + 可固定上游 URL。
- **维护操作只预览**：破坏性操作留在有完整确认流程的 Dashboard。
- **不做记忆同步/多设备**：本次范围外（`memorix sync store` 是 opt-in 独立能力）。
