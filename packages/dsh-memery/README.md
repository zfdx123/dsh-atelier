# dsh-memery — 自包含跨会话记忆插件（v2 重写）

> 包名 `@zfdx123/dsh-memery`（npm scope 风格）；插件行 id / 数据目录 / 设置页路由
> 仍是 `dsh-memery`（见下方「安装」）。

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）打造的
跨会话记忆插件。**无外部服务依赖**：记忆库是工作区里的 SQLite 文件，由
`node:sqlite` 驱动（Node ≥22.13 内置）。

> v2 是彻底重写，架构参照 [dsh-meow-memory](https://github.com/Phant0Meow/dsh-meow-memory)
> （成熟的参考实现），并主动放弃了 v1 的 Memorix MCP 方案：
> 不再有外部控制面、端口、CORS、自动拉起、MCP 会话失效 —— 那些正是 v1 反复出 bug 的源头。

## 核心理念

- **双库**：每个工作区一份记忆库 `<workspace>/.dsh-memery/memory.db` +
  一份**跨工作区全局库** `~/.dsh-memery/memory.db`。project 写「全局」→ 全局库
  （所有工作区共享）；写普通项目 → 当前工作区库。读取时两库合并、去重，
  每条标注 `scope: workspace|global`。
- **五层**：`fact / lesson / rules / topic / project`，每次笔记带
  `keywords` + `importance` + `status`。
- **工作区 = 会话 cwd**：`agent.session.header.cwd`，无需探测、无需配置。
- **首轮注入**：会话首条真实用户消息前，注入长期记忆快照（fact/lesson/rules 全量 +
  topic/project 导引），首轮不做关键词命中。
- **每轮命中**：第 2 条起的每条用户消息，BM25 关键词命中 top-2 注入
  （范围 = 全局 + 当前项目），已见记忆不重复。
- **工具集**：`memory_remember` / `memory_search` / `memory_read` /
  `memory_update`（含归档、改 project 自动搬库）/ `memory_delete` / `memory_project`
  —— 完整的管理闭环。
- **设置页**：DSH 设置里「记忆」标签页，**添加 / 编辑 / 搜索 / 归档 / 删除**；
  默认选中**当前打开的对话**所在工作区（useSessions.current → cwd，而非注册表
  第一个）；来源下拉**顶部独立「全局」选项**（选它只看全局库），选具体工作区
  只看该工作区条目（互不混入）；添加表单项目为**下拉选择**：全局 / 当前项目
  （目录名）/ 已有项目 / 自定义；删除走**宿主原生确认框**
  （`RiskConfirmation`：警告行 + 「我已了解此操作不可恢复」勾选后才可确认）；
  图标也取自宿主图标集（`Button` 的 `icon` 通道：添加 `IconPlusOutline16`、
  刷新 `IconRefreshOutline16`、下拉箭头 `IconChevronDownOutline14`），
  「全局」徽章用原生 `Tag`（`tone=info`）——不再拿 `＋` `↻` `▾` 这些 Unicode
  字形当图标、也不手搓徽章；宿主没有这套原子时逐一退回自带按钮样式 + 原字形。
- **遗留迁移**：旧版写在工作区库里的「全局」条目，读取时自动搬进全局库（幂等）。

> ⚠️ 跨工作区共享是**显式选择**：只有 `project` 明确写「全局」的记忆才进全局库；
> 写普通项目的记忆严格锁在当前工作区（其它工作区搜不到、改不了）。涉及敏感
> 上下文的工作区请克制使用「全局」，避免把 A 项目的记忆泄漏进 B 项目。

## 架构

```
                          agent/pre-step 注入
   会话首条 → 长期记忆快照     ──┐
   每条消息 → 关键词 top-2 命中  ─┤  createUserMessage(source:{plugin, form:'snapshot'})
                                ▼
          ~/.dsh-memery/memory.db（全局，跨工作区共享）  ┐
                         <workspace>/.dsh-memery/memory.db ← node:sqlite
                                ▲                        ┘ 读取合并、写入按 project 路由
   memory_* 工具 / 设置页路由 ────┘
```

集成点（均按 DSH 0.1.5-rc.1 实测契约）：
- `ctx.tools.register(ToolDefinition)`
- `ctx.on('agent/pre-step', ...)` — waterfall，把快照拼进 `decision.messages`
- `webServer.register({kind:'exact', path:'/dsh-memery/*'})` — 设置页数据
  （延迟获取：`ctx.inject(['webServer'], ...)`，勿用同步探测）
- client：`slots.inject('settings.section', ...)` 注册设置页标签
- client 原生 UI：`require('@deepseek-ai/dsh-client-ui-primitives')` —— 该名字在
  前端 `PLATFORM_MODULES`（平台模块表）里，拿到的是宿主同款
  `RiskConfirmation` / `Modal` / `Button`。**必须惰性 + try/catch 地取**：顶层
  `require` 在宿主缺该模块时会让 factory 物化抛错 → 插件 `did not activate`；
  取不到就降级（删除确认退回 `window.confirm`），激活不受影响。

## 安装

```sh
dsh plugin --profile web add E:\work\ai\dsh-memery
# 重启 dsh web（profile 的 bundles 清单只在启动时读一次；热重载换不掉包名）
```

改名（`dsh-memery` → `@zfdx123/dsh-memery`）时必须同步三处，否则 web 启动会报
`bundle … loaded without registering "<id>" via __ModuleLoader__.load`：

| 位置 | 值 |
|---|---|
| `package.json` → `name` | `@zfdx123/dsh-memery` |
| `cordis.patch.yml` → 插入行 `name` | `@zfdx123/dsh-memery`（宿主按它解析 bundle 包） |
| `build.mjs` banner → `__ModuleLoader__.load({ id })` | 同上（浏览器侧注册 id） |

（`test/pack.test.ts` 已把这三处锁进测试；插件行 id、数据目录 `.dsh-memery`、
设置页路由前缀 `/dsh-memery/` 与包名无关，改名不动。）

原生 UI 组件库同理，三处必须一致（`test/pack.test.ts` 亦已锁定）：

| 位置 | 值 |
|---|---|
| `package.json` → `dsh.client.external` | `@deepseek-ai/dsh-client-ui-primitives` |
| `build.mjs` → 客户端 `external` | 同上（构建期不解析，原样留给运行期 require） |
| `lib/client.js` → 实际 require 的 id | 同上（运行期按它查平台模块表） |

## 配置（cordis.patch.yml，全部可选）

```yaml
- id: dsh-memery
  name: 'dsh-memery'
  config:
    enabled: true    # 总开关
    dir: '.dsh-memery' # 记忆目录（相对工作区）
    hitTopK: 2       # 每条消息命中注入条数
    titleMax: 40     # 导引标题截断长度
```

## 开发

```sh
npm install          # devDeps（esbuild/typescript/@types/node）
npm run build        # esbuild → lib/index.js + lib/client.js
npm run test         # 构建 + 测试（db/bm25/inject/tools/settings/集成/输出schema）
npm run watch        # 开发热重建
npx tsc --noEmit     # 类型检查
```

结构：

```
├── src/db.ts        # node:sqlite 数据层（五层 + CRUD + 全局库合并/定位/迁移）
├── src/bm25.ts      # 分词 + BM25 检索（关键词字段优先 + 全文）
├── src/inject.ts    # 首轮快照 + 每轮命中 + 已见记账（合并两库）
├── src/tools.ts     # memory_* 六个工具（写入按 project 路由到全局/工作区库）
├── src/settings.ts  # 设置页数据路由（webServer exact + memory-add/update/delete）
├── src/index.ts     # apply 主入口（pre-step 注入 + 工具 + 设置注册）
├── src/client.ts    # 设置页「记忆」标签页（添加/编辑表单）
├── build.mjs        # esbuild 双产物
└── test/            # node:test（经 esbuild 编译；DSH_MEMERY_HOME 指向临时目录）
```

## 与 v1 的差异（v2 删除的东西）

| v1（Memorix 方案） | v2（自包含） |
|---|---|
| 外部 memorix 控制面（:3211） | ❌ 不存在 —— 库在工作区 |
| `mcp__memorix__*` MCP 工具 | ❌ 原生 `memory_*` 工具 |
| `/api/dsh-memery/*` 宿主转发层 | ❌ 仅设置页路由（webServer） |
| 自动拉起 / 探活 / 停机处理 | ❌ 没有服务要管 |
| 侧栏折叠面板 + 手工 CSS | ❌ 设置页标签页（`settings.section`） |

## License

MIT