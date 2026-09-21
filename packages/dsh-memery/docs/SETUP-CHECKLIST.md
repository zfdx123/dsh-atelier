# 接入与验收清单

## 已验证（不需要你做任何事）

| 项 | 证据 |
|---|---|
| Memorix 安装 | `memorix --version` → `1.9.3`；`where memorix` 在 PATH 上 |
| 控制面常驻 | `GET http://127.0.0.1:3211/health` → `{"status":"ok","pid":...}` |
| MCP 端点可用 | `initialize` 握手 → `serverInfo {name:"memorix",version:"1.9.3"}` |
| 项目身份 | `project.id = local/dsh-memery`（工作区已 `git init` + 提交） |
| MCP 服务器配置 | `settings.yaml` 的 `mcp.servers` 含 `memorix(streamable-http)`，其余配置完好 |
| 插件已装进 profile | `profiles/web/package.json` 的 `dependencies` + `dsh.profile.bundles` 均含 `dsh-memery` |
| **面板已注册** | 客户端 slot 探针：`sidebar.footer.action` 的 occupants 里有 `{id:"dsh-memory", order:22, active:true}` |
| 宿主端点已注册 | `GET /api/dsh-memery/health` 对未鉴权客户端返回 **401**（= 宿主的信任栅栏在生效） |
| 宿主数据路径 | `node scripts/smoke.mjs`：12 条路径 + 停机分支 + **自动拉起分支**全绿 |
| **控制面自动拉起** | smoke 输出：`CLI 调用参数: background start` → `up: true` |
| 单元测试 | `npm test` → **119 项全过** |

## 修过的两个真实缺陷

面板第一版显示了假的失败态（「控制面 不可用 / 地址 - / 项目 未解析 / unknown」）。
根因有两个，都不是环境问题：

1. **加载中渲染成失败态**：`useAsync` 初值是 `{loading:true, data:undefined}`，而渲染
   用的是 `d.controlPlane || '-'`——加载中和失败长得一模一样，且全链路没有任何超时，
   一次卡住的请求就让面板永远停在那个假失败态。
   → 改为显式四态机 `loading / connecting / ready / failed`（`connectionStateOf`，
   有单测），每个请求带 `AbortSignal` 超时，每个状态都给出下一步动作。
2. **要求用户手动启动**：控制面没跑时只在界面上写「请执行 memorix background start」。
   → 宿主现在**自动把它拉起来**（`lib/autostart.js`）：只对确认不可达的情况启动、
   并发只 spawn 一次、启动失败如实报 `failed` + 原因。面板在拉起期间显示
   「正在自动启动…」并自动重试，不需要用户操作。

## 待你执行：刷新页面

客户端 bundle 改了，**先刷新浏览器页面**（宿主端 HMR 会重新装载 bundle）。
若刷新后仍是旧面板，再重启一次 `dsh web`。

刷新后逐项确认：

- [ ] 侧栏底部「设置」旁边出现**「记忆」**，点开是面板（不再是那一屏 '-' 和 unknown）
- [ ] 面板顶部状态点：绿=可用、黄=启动中、红=不可用
- [ ] 面板显示 `项目 local/dsh-memery`
- [ ] 概览数字与 `http://127.0.0.1:3211/api/stats?project=local/dsh-memery` 一致
- [ ] **设置 → 记忆** 显示「控制面 可用 / v1.9.3」
- [ ] 设置 → MCP 服务器 里 `memorix` 为已挂载；工具列表出现 `mcp__memorix__*`

## 自动拉起的验证方式

```powershell
memorix background stop     # 故意停掉
# 然后点面板的「刷新」
# 期望：先「正在自动启动 Memorix 控制面…」，几秒后自动变为可用，无需你敲命令
```

## 让面板有数据可看（可选）

当前项目记忆是空的（0 条）。写入请让模型用 MCP 工具，例如：

```
用 mcp__memorix__memorix_store 记一条：entityName=dsh-memery, type=decision,
title=走宿主转发而非浏览器直连, narrative=Memorix Dashboard 不用通配 CORS，
浏览器直连会被拦，且绕过宿主鉴权栅栏。
```

写入后刷新面板即可看到；`/api/observations` 只返回 active 记录。

## 控制面生命周期

```powershell
memorix background start   # 启动（Dashboard 与 MCP 同在 :3211）
memorix background stop    # 停止
Get-Content $env:USERPROFILE\.memorix\background.log -Tail 30   # 日志
```

> 正常使用**不需要手动执行**：宿主在启动时、以及面板打开时都会确保控制面可用。

## 回滚

```powershell
dsh plugin --profile web remove dsh-memery

# 撤销 MCP 服务器（或直接在 设置 → MCP 服务器 里关掉 memorix 开关，热生效）
Copy-Item "$env:USERPROFILE\.dsh\settings.yaml.bak-dsh-memery" "$env:USERPROFILE\.dsh\settings.yaml" -Force

memorix background stop   # 可选，不影响 DSH
```
