# @zfdx123/dsh-memery

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）用的**跨会话记忆**插件：让「这个工作区里以前聊出来的结论」在下一轮对话里重新出现在模型眼前。它解决的是「每开一个新会话，之前踩过的坑、定过的方案全都要重讲一遍」——模型在对话中用 `memory_*` 工具主动写入，插件在会话首条消息前注入长期记忆快照、之后每条消息按关键词命中注入相关条目，人则在 DSH 设置页的「记忆」标签里增删改查。**没有任何外部服务**：记忆库就是工作区里的一个 SQLite 文件，由 Node 内置的 `node:sqlite` 驱动。插件行 id、数据目录、设置页路由都叫 `dsh-memery`，只有 npm 包名是 `@zfdx123/dsh-memery`。

## 安装

npm 安装（推荐）：

```sh
dsh plugin --profile web add @zfdx123/dsh-memery
```

想把整套插件（目前 7 个）一次装齐，用聚合包：

```sh
dsh plugin --profile web add @zfdx123/dsh-atelier
```

> 两者**不要同时装**：同一个插件 id 会被插进组合树两次。要单个就只装那一个。

本地目录安装（改代码时用）：

```sh
dsh plugin --profile web add link:E:/work/ai/dsh-atelier/packages/dsh-memery
```

装完**重启 `dsh web`**：profile 的 bundles 清单只在进程启动时读一次，热重载换不掉包名。

### 验证安装

1. 设置页出现标签页 **记忆**（外壳语言是英文时显示 **Memory**）；
2. 浏览器的控制台里有一条 `[dsh-memery] 设置页「记忆」标签已注册（settings.section）`；
3. 让模型调 `memory_search`（例如 `query: "安装"`）应能返回结果而不是报错。

### 包名与插件 id 不是一回事

包是 scoped npm 名 `@zfdx123/dsh-memery`，但**插件行 id / 数据目录 `.dsh-memery` / 路由前缀 `/dsh-memery/` 与包名无关**。改名时必须同步下面三处，漏一处 web 启动就会报 `bundle … loaded without registering "<id>" via __ModuleLoader__.load`：

| 位置 | 值 |
|---|---|
| `package.json` → `name` | `@zfdx123/dsh-memery` |
| `cordis.patch.yml` → 插入行 `name` | 同上（宿主按它解析 bundle 包） |
| `build.mjs` banner → `__ModuleLoader__.load({ id })` | 同上（浏览器侧注册 id） |

（`test/pack.test.ts` 已把这三处锁进测试；宿主入口导出的短名 `dsh-memery` 保持不变。）

原生 UI 组件库同理，三处必须一致（`test/pack.test.ts` 亦已锁定）：

| 位置 | 值 |
|---|---|
| `package.json` → `dsh.client.external` | `@deepseek-ai/dsh-client-ui-primitives` |
| `build.mjs` → 客户端 `external` | 同上（构建期不解析，原样留给运行期 require） |
| `lib/client.js` → 实际 require 的 id | 同上（运行期按它查平台模块表） |

## 快速上手

```sh
# 1) 安装并重启 dsh web
dsh plugin --profile web add @zfdx123/dsh-memery

# 2) 在会话里让模型记一条
#    「用 memory_remember 记一条：project=<当前项目名>，content=…，keywords=…」
#    （不想麻烦就先什么都不做，插件自己会在需要时提示模型去搜）

# 3) 打开 设置 → 记忆：刚写的条目就在列表里，可以搜索 / 编辑 / 归档 / 删除
```

三种写入入口：

| 入口 | 谁在用 | 落到哪 |
|---|---|---|
| `memory_remember` 工具 | 模型在对话里主动沉淀 | `project` 字段决定：`全局` → 全局库，其它 → 当前工作区库 |
| 设置页「＋ 添加」表单 | 人手工补一条 | 表单里选项目：全局 / 当前项目（目录名）/ 已有项目 / 自定义 |
| `memory_update` | 改 `project` 时自动搬库 | 改完立刻搬到语义对应的库（全局库与工作区库之间） |

注入时机（不需要手动触发）：

- **会话首条真实用户消息之前**：注入长期记忆快照（fact/lesson/rules 全量 + topic/project 导引），首轮不跑关键词命中；
- **第 2 条起的每条用户消息之前**：BM25 关键词命中 top-`hitTopK`（默认 2），范围 = 全局库 + 当前项目，已注入过的不重复。

## 它做什么

**双库：每个工作区一份 + 一份跨工作区共享的**

- 工作区库：`<工作区>/.dsh-memery/memory.db`（工作区 = 会话 cwd）；
- 全局库：`~/.dsh-memery/memory.db`（可用 `DSH_MEMERY_HOME` 改根目录，测试就靠它避开真实主目录）；
- 读取时两库合并、按 id 去重（工作区副本优先），每条标注 `scope: workspace|global`；写入按 `project` 字段路由。

**五层记忆 + 三个维度**

- 层：`fact` / `lesson` / `rules` / `topic` / `project`；
- 每条笔记带 `keywords`、`importance`（1-4）、`status`（`active` / `archived` / `stale`）；
- `project` 层还有子类 `overview` / `structure` / `decisions` / `quotes` / `ops` / `todo`；`topic` 层有 `goal`。

**模型工具（六个，闭环）**

| 工具 | 干什么 |
|---|---|
| `memory_remember` | 写入一条记忆（缺 `keywords` 时自动 bigram 提取 8 个） |
| `memory_search` | 关键词检索；可按层级 / 项目 / 最近 N 天过滤，`status: all` 含归档 |
| `memory_read` | 读全文（`search` 只回元数据视图） |
| `memory_update` | 改字段、归档（`status`）、改 `project` 时自动搬库 |
| `memory_delete` | 硬删除（管理界面之外的唯一删除入口） |
| `memory_project` | 项目全景：project 层全量 + 归属该项目的其它层，按子标签分组 |

**设置页「记忆」（设置 → 记忆 / Memory）**

- 添加 / 编辑 / 搜索 / 归档 / 恢复 / 删除；
- **来源下拉顶部是独立的「全局（n）」选项**：选它只看全局库，选具体工作区只看该工作区条目，互不混入；
- 默认选中的是**最近更新过的那个会话所在的工作区**（见「已知限制」里为什么不是「当前会话」）；
- 添加表单的项目是**下拉选择**：全局 / 当前项目（目录名）/ 已有项目 / 自定义；
- 删除走宿主**原生确认框**（`RiskConfirmation`：警告行 + 「我已了解此操作不可恢复」勾选后才可确认），不是 `window.confirm`；
- 文案跟随外壳语言：注册 `dsh-memery` 命名空间的 zh/en 两套字典（各 77 键、键集一致）；`ctx.locale` 缺席时回落中文；
- 界面**不含任何 emoji**（用户明确要求过；`test/client-locale.test.ts` 用 `\p{Extended_Pictographic}` 断言锁住）；
- 图标与徽章取自外壳：`Button` 的 `icon` 通道（`IconPlusOutline16` / `IconRefreshOutline16` / `IconChevronDownOutline14`）、「全局」徽章用原生 `Tag`（`tone=info`）。拿不到这些原子时逐项降级：退回自带按钮样式 + 原来的字形（`＋` / `↻` / `▾`），删除确认退回 `window.confirm`。

**遗留迁移**：旧版写在工作区库里的「全局」条目，在读取时自动搬进全局库（幂等，目标已有同 id 就清掉工作区副本）。

**注入是 fail-open**：`agent/pre-step` 里任何一步抛错都只记一条 warn 然后放行原始消息——记忆注入坏掉不会挡住对话。

### 架构与集成点

```
                          agent/pre-step 注入
   会话首条 → 长期记忆快照     ──┐
   每条消息 → 关键词 top-K 命中  ─┤  createUserMessage(source:{plugin, form:'snapshot'})
                                ▼
          ~/.dsh-memery/memory.db（全局，跨工作区共享）  ┐
                         <工作区>/.dsh-memery/memory.db ← node:sqlite
                                ▲                        ┘ 读取合并、写入按 project 路由
   memory_* 工具 / 设置页路由 ────┘
```

集成点（均按 DSH `^0.1.7-rc.2` 的运行时契约核实；更早的 0.1.5-rc.1 是历史基线）：

- `ctx.tools.register(ToolDefinition)` —— 六个 `memory_*` 工具；
- `ctx.on('agent/pre-step', …)` —— waterfall，把快照/命中拼进 `decision.messages`、插到真实用户消息之前；
- `ctx.inject(['webServer'], …)` + `webServer.register({kind:'exact', path})` —— 设置页数据路由（`/dsh-memery/workspaces`、`/memories`、`/projects`、`/memory-add`、`/memory-update`、`/memory-delete`）。**必须延迟获取**，不要同步探测；
- `ctx.inject(['workspaceRegistry'], …)` 读工作区清单时**每次请求现查**：清单若在激活时快照成数组，之后新增的工作区就永远进不了设置页；
- client：`slots.inject('settings.section', …)` 注册设置页标签页，`label` 写成 thunk，切语言不需要重新注册 slot；
- client 原生 UI：`require('@deepseek-ai/dsh-client-ui-primitives')` —— 该名字在前端 `PLATFORM_MODULES`（平台模块表）里，拿到的是宿主同款 `RiskConfirmation` / `Button` / `Tag` / 图标。**必须惰性 + try/catch 地取**：顶层 `require` 在宿主缺该模块时会让 factory 物化抛错 → 插件 `did not activate`；取不到就逐项降级，激活不受影响。

## 配置

配置写在 profile 的 `cordis.patch.yml`（**没有设置页表单**，改完要重启 `dsh web`）。全部可选：

```yaml
- id: dsh-memery
  name: '@zfdx123/dsh-memery'
  config:
    enabled: true     # 总开关；false 时 apply 直接返回，不注册工具、不注入
    dir: '.dsh-memery' # 记忆目录（相对工作区）
    hitTopK: 2        # 每条消息命中注入条数
    titleMax: 40      # 导引标题截断长度
```

## 前置要求

- **DSH `^0.1.7-rc.2`**（`package.json` 的 `engines.dsh`；peer 范围同为 `^0.1.7-rc.2`）；
- **Node ≥ 22.13**（`node:sqlite` 的免标志下限，理由见「已知限制」）；本仓库整体要求 `^22.19.0 || >=24.0.0`；
- 装成 **profile bundle**（`dsh.bundle.patch` → `cordis.patch.yml`），并在 `dsh.client.platform: web` 的前端下使用——设置页只在 web 前端出现；
- peer：`@deepseek-ai/cordis ^4.0.4`、`@deepseek-ai/dsh-llm ^0.1.7-rc.2`、`@deepseek-ai/dsh-tools ^0.1.7-rc.2`（最后一个声明为 optional peer）；
- 不需要任何外部服务、端口、网络或 API key。

## 已知限制

- **Node 下限是硬约束**。`node:sqlite` 在 Node 22.13 之前要显式加 `--experimental-sqlite`，本插件不会自己加这个标志，因此低于 22.13 的 Node 上插件起不来（`engines.node` 写的就是 `>=22.13`）。另外该模块上游仍标注为 experimental——这是 Node 侧的状态，不是本插件能决定的。
- **「全局」是数据，不是文案**。进全局库的判据是 `project` 字段的字面值 `全局`（或 `global`，去首尾空格、不区分大小写）；这个 token **不参与翻译**，所以英文界面下面板的项目选择器里同样写着 `全局`（en 字典里故意保留原文）。把库里已有的值改成别的写法，那条记忆就变成「项目记忆」而不是全局记忆了。
- **跨工作区共享是显式选择，且没有访问控制**。只有 `project` 明确写「全局」的记忆才进全局库，之后**所有工作区都能搜到、改到、删掉**；写普通项目的记忆严格锁在当前工作区（别的工作区搜不到）。涉及敏感上下文的工作区请克制使用「全局」。把 `project` 从「全局」改成项目名会把记忆搬回工作区库，但已经泄漏出去的历史无法回收。
- **快照只发生在「真首轮」**。只有当会话在本进程里第一次发消息、且历史事件里没有用户消息时才注入快照；从磁盘恢复的会话（已有历史）只走命中链路——它的快照靠上一个进程注入过的那一份。已见记账写在 `<工作区>/.dsh-memery/sessions/<sessionId>.json`，删掉这个文件等于让快照与命中重新注入一次。
- **子代理不注入**。`origin === 'subagent'` 的会话被直接跳过（该标记由 DSH 给出，插件不猜）。
- **设置页的能力依赖外壳，且只降级不报错**。`slots` 服务不可用时设置页不注册（只 warn，工具与注入照常）；平台模块表里没有 UI 原子时逐项退回字形 + 自带样式 + `window.confirm`；`ctx.locale` 不可用时界面固定中文。降级是设计目标，所以**界面上不会提示「你正在用降级路径」**。
- **默认工作区是「最近更新过的会话」，不是「当前会话」**。DSH 0.1.6-alpha.2 的会话列表状态只有 `{ids, byId, phase, subagentsByParent, jobsBySession}`——没有 `current`，选中态是 ui-session 的私有字段，根作用域的 `settings.section` slot 拿不到。插件因此用 `byId` 里 `updatedAt` 最大的那条会话的 `cwd` 近似「当前对话」；一条都取不到时退回工作区注册表的第一个。多窗口、多会话同时开着时可能选到不是你正在看的那个。
- **库文件的并发**：进程内每个库文件只开一个连接（单例 `Map`），没有开 WAL、也没有设置 busy timeout。多个 dsh 进程同时写同一个工作区库时，SQLite 的写锁冲突会以错误的形式冒出来（工具调用失败），插件不会自动重试。
- **记忆目录在你的工作区里**。`<工作区>/.dsh-memery/`（库 + sessions 记账）会出现在该工作区的 `git status` 里；本仓库的 `.gitignore` 只覆盖本仓库，用之前请在你自己的工作区忽略这个目录。
- **检索是关键词，不是语义**。BM25 打分（中文按相邻两字 bigram，英文按词），命中靠 `keywords` 字段与全文；近 30 天半衰、`importance` 加权。写入时没给 `keywords` 会自动提取 8 个——自动提取的关键词不一定是你想要的，重要记忆建议手写。
- **检索范围只有全局库 + 当前项目**。别的项目的记忆搜不到（这是隔离，不是 bug）；同名的两个项目目录会被当成同一个项目名。
- **删除是硬删除**。`memory_delete` 与界面的「删除」都直接从库里删掉；想留退路用「归档」（`status: archived`，默认不出现在检索里，`status: all` 可见）。
- **写入是按内容重写的**：`memory_update` 覆盖字段而不是追加，没有版本历史，也没有撤销。

## 开发

```sh
npm install          # devDeps（esbuild / typescript / @types/node）
npm run build        # esbuild → lib/index.js + lib/client.js
npm test             # 先构建，再跑 test/*.test.ts（经 esbuild 编译到 test-built/）
npm run watch        # 开发热重建
npx tsc --noEmit     # 类型检查
```

测试用 `node:test`，跑之前由 `test.mjs` 把 `test/*.test.ts` 用 esbuild 编到 `test-built/`；测试全程用 `DSH_MEMERY_HOME` 指向临时目录，不碰真实主目录。当前状态：**123 项测试 / 25 个 suite，全绿**（覆盖 db、bm25、inject、tools、settings、集成、输出 schema、打包契约，以及客户端的 locale / 图标 / 降级按钮 / 删除确认 / 默认工作区 / 刷新 / 样式 / bundle 装配）。

结构：

```
├── src/db.ts        # node:sqlite 数据层（五层 + CRUD + 全局库合并/定位/迁移）
├── src/bm25.ts      # 分词 + BM25 检索（关键词字段优先 + 全文）
├── src/inject.ts    # 首轮快照 + 每轮命中 + 已见记账（合并两库）
├── src/tools.ts     # memory_* 六个工具（写入按 project 路由到全局/工作区库）
├── src/settings.ts  # 设置页数据路由（webServer exact + memory-add/update/delete）
├── src/index.ts     # apply 主入口（pre-step 注入 + 工具 + 设置注册）
├── src/client.ts    # 设置页「记忆」标签页（locale 字典 + 原生原子 + 降级）
├── build.mjs        # esbuild 双产物
└── test/            # node:test（经 esbuild 编译；DSH_MEMERY_HOME 指向临时目录）
```

### 历史：v1 是另一套方案

v1 走 Memorix MCP（外部控制面 + 宿主转发层）。v2 是彻底重写，架构参照 [dsh-meow-memory](https://github.com/Phant0Meow/dsh-meow-memory)（成熟的参考实现），主动放弃了 v1 的方案——不再有外部控制面、端口、CORS、自动拉起、MCP 会话失效，那些正是 v1 反复出 bug 的源头。v1 的代码留在 `docs/legacy-v1/` 里，只作历史参考。

| v1（Memorix MCP 方案，历史） | v2（自包含，当前） |
|---|---|
| 外部 memorix 控制面（:3211） | 不存在 —— 库在工作区里 |
| `mcp__memorix__*` MCP 工具 | 原生 `memory_*` 工具 |
| `/api/dsh-memery/*` 宿主转发层 | 只有设置页路由（webServer exact） |
| 自动拉起 / 探活 / 停机处理 | 没有服务要管 |
| 侧栏折叠面板 + 手工 CSS | 设置页标签页（`settings.section`） |

## 许可

MIT。完整文本见包内的 [LICENSE](./LICENSE)。
