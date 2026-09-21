# dsh-codegraph

让 DSH 会话直接使用 [CodeGraph](https://github.com/colbymchenry/codegraph)
（`@colbymchenry/codegraph`）的预索引代码知识图谱能力。

这是一个 DSH 插件（bundle）：它把 `codegraph` CLI 包装成
**模型可见的原生工具**，模型在分析代码时无需 grep/读大量文件，直接按符号、
按区域、按调用链查询索引，并能自举并维护索引（`init`/`index`/`sync`）。

> 本仓库是上游 [`jiangzhenguo/dsh-codegraph`](https://github.com/jiangzhenguo/dsh-codegraph)
> 的维护分支，按 DSH 0.1.6 一系重新校对过接口契约（见下文「兼容性」）。
> npm 包名为 **`@zfdx123/dsh-codegraph`**，与 `@zfdx123/dsh-mcp-manager`、
> `@zfdx123/dsh-skills-manager` 同属一套；仓库目录名仍是 `dsh-codegraph`。

> **工具面（surface）**：借鉴上游项目「`codegraph_explore` 是唯一稳定赢得模型调用的工具」
> 的实测结论（其官方 MCP server 默认只暴露 explore），本插件**默认只注册 4 个核心工具**
> （`codegraph_status` / `codegraph_init` / `codegraph_sync` / `codegraph_explore`），
> 保持模型工具列表精简、引导集中。需要全部 13 个工具时，在组合层配置
> `surface: 'full'`（见下文「配置」）。

## 提供的工具

| 工具 | 对应 CLI | 用途 |
|---|---|---|
| `codegraph_status` | `status --json` | 索引状态（是否已初始化、版本、文件/节点/边数、待同步变更、建议重建等） |
| `codegraph_init` | `init` | 初始化项目并建立初始索引（`.codegraph/`） |
| `codegraph_index` | `index` | 全量（重）索引；`status` 建议 reindex 时用 |
| `codegraph_sync` | `sync` | 增量同步索引（改代码后调用，让查询反映新代码） |
| `codegraph_uninit` | `uninit -f` | 删除项目索引 |
| `codegraph_query` | `query --json` | 按名称/子串搜索符号，返回结构化 JSON |
| `codegraph_node` | `node` | 单个符号源码 + 调用/被调用轨迹，或带行号读文件 + 依赖 |
| `codegraph_explore` | `explore` | 自然语言探索一块代码区域，直接返回相关文件源码与调用路径 |
| `codegraph_files` | `files --json` | 索引内的项目文件结构 |
| `codegraph_callers` | `callers --json` | 谁调用了某个符号 |
| `codegraph_callees` | `callees --json` | 某个符号调用了什么 |
| `codegraph_impact` | `impact --json` | 改动某个符号会波及哪些代码（重构/改名前用） |
| `codegraph_affected` | `affected --json` | 改动若干源文件后应运行哪些测试文件 |

工具名与 CodeGraph 官方 MCP 工具同名，模型的使用心智与官方文档一致。

## 前置要求

1. 已安装 [DSH](https://github.com/deepseek-ai/deepseek-harness)（本插件为 DSH bundle，随
   DSH web 应用装载）。
2. 已安装 `codegraph` CLI 且其可执行文件在 `PATH` 上（插件在运行时按名字 `codegraph`
   解析可执行文件）：

   ```bash
   npm i -g @colbymchenry/codegraph     # 或按官方 install.sh / npm thin shim 安装
   codegraph --version                  # 确认可用（≥ 1.0）
   ```

## 安装（本地 link）

本仓库以 `link:` 方式装进 profile：改代码直接生效，不必发版。

```bash
dsh plugin --profile web add link:E:/work/ai/dsh-codegraph
```

`dsh plugin add` 会把依赖写进 profile（键为**包名** `@zfdx123/dsh-codegraph`），并因为本包
声明了 `dsh.bundle.patch`，自动把 `@zfdx123/dsh-codegraph` 追加进该 profile 的
`dsh.profile.bundles`（即应用本包的 `cordis.patch.yml` 组合层，不需要手工加）。
重启 DSH 进程后，任意会话里模型即可看到 `codegraph_*` 工具（默认 core 面 4 个）。

> 其他 profile：把 `--profile web` 换成 `--profile tui` 等即可。

`link:` 依赖由 Node 解析到真实路径，因此**本仓库自己必须装好 peer 依赖**
（`@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-llm` / `@deepseek-ai/schemastery`）：

```bash
npm install          # 已在 devDependencies 中固定版本
```

### 卸载

```bash
dsh plugin --profile web remove @zfdx123/dsh-codegraph
```

> 改包名后，旧的无 scope 依赖键 `dsh-codegraph` 不会自动消失：profile 的
> `dependencies` 与 `dsh.profile.bundles` 两处都要改成 scoped 名（`dsh plugin remove`
> 旧名 + `add` 新名，或手工改完再 `dsh plugin --profile web install`）。
> `cordis.patch.yml` 里的 `id` 仍是 `dsh-codegraph`，所以按 id 写的禁用/配置覆盖继续有效。

## 兼容性

本分支对照下列 DSH 版本重新校对过接口契约，并以此作为 `peerDependencies` 的依据：

| 组件 | 已校对版本 |
|---|---|
| DSH CLI | `0.1.5-rc.1`、`0.1.6-alpha.1`、**`0.1.6-alpha.2`**（均已实测） |
| `@deepseek-ai/dsh-tools` / `dsh-llm` 等一方包 | `0.1.5-rc.2`、`0.1.6-alpha.1`、**`0.1.6-alpha.2`**（均已实测） |
| `@colbymchenry/codegraph` CLI | `1.5.0`（13 个子命令与参数逐一核对） |
| Node.js | ≥ 22 |

> `peerDependencies` 与 `engines.dsh` 写的是 `^0.1.6-alpha.1`。semver 的规则是：带 prerelease
> 标签的版本，只能被**元组相同**的比较器接纳，所以这条 caret 既收下 `0.1.6-alpha.1`，也收下
> 同元组的 `0.1.6-alpha.2`（实测 semver 7.8.5：`0.1.6-alpha.1` / `0.1.6-alpha.2` / `0.1.6` /
> `0.1.7` 满足，`0.2.0-alpha.1` / `0.2.0` 不满足）；`0.1.5` 一系已不在声明范围内（表里列出
> 的 `0.1.5-*` 是**校对过**的版本，不等于仍被 peer 范围接纳）。写 `-0` 后缀（如
> `>=0.1.6-alpha.1-0`）是**错的**，实测它连 `0.1.6-alpha.1` 本身都不接纳。

### 重新校对（升级 DSH 后）

```bash
npm install                      # 或在 package.json 里改 devDependencies 版本
npm test                         # 真实 CLI + 真实一方包，跑完整生命周期
```

`npm test` 会拉起真实的 `codegraph` CLI 在临时 fixture 项目上跑完整生命周期
（`status` → `init` → `query`/`node`/`explore`/`files`/`callers`/`callees`/`impact`/`affected`
→ `sync`），因此 CLI 侧参数变更同样会被测出来。若某条断言的失败来自一方包升级，
先看 `lib/index.js` 顶部「Harness contract」列出的那几个易变接口。

要验证「换一条 DSH 版本线还能不能跑」，把依赖换成目标版本再跑即可（本分支就是这样依次
核对了 `0.1.5-rc.2` 与 `0.1.6-alpha.1`，并在 `0.1.6-alpha.2` 上重跑了整套）；`peerDependencies`
只影响安装期校验，不改变解析结果。

### 测试的环境限制（祖先敏感用例）

套件的「未索引项目不注入」门控用例，前提是**夹具目录及其任何祖先都没有 CodeGraph 索引**——
因为插件是靠向上查找索引根来定位项目的。插件与夹具都按**真实索引标记
（`.codegraph/codegraph.db`）**判定，而不是「`.codegraph` 目录是否存在」：CodeGraph 会在
`~/.codegraph` 保留自己的 daemon/store 目录，它**不是**项目索引，不应被当作索引根。

若某个祖先确实有真实索引（例如夹具被放进了另一个已索引的项目里），该用例会**显式 skip
并打印原因**，而不是报一条永远红的断言：

```
⏭️  skipped "unindexed project" gate — a .codegraph dir shadows the fixture
```

此时把夹具指到没有索引祖先的路径即可让它真正跑起来：

```powershell
$env:CG_UNINDEXED_DIR = "D:\tmp\cg-unindexed"   # Windows
```

```bash
export CG_UNINDEXED_DIR=/tmp/cg-unindexed       # POSIX
```

相关环境变量：`CG_TEST_DIR`（夹具沙箱位置）、`CG_UNINDEXED_DIR`（未索引夹具位置）、
`CG_EXECUTABLE`（指定 codegraph 可执行文件）、`CG_KEEP_FIXTURE=1`（保留夹具索引）、
`CG_PROFILE_NM`（改测已安装 profile 里的副本）。

### 校对过程中修掉的旧契约残留

以下几处都是「以前能跑、现在语义不对」的那类问题：

1. **注入上下文的来源标记**：frontload 注入的 `<codegraph_context>` 过去用
   `source: { kind: 'user' }` 伪装成用户 prompt。当前 DSH 的消息来源契约里
   `kind: 'user'` 专指人真正发来的内容（RPC 路径还会进一步细分为 `user-rpc`），
   而机器注入的上下文有专门的 `kind: 'plugin'`（`{ kind: 'plugin', plugin, form }`）。
   伪造 user 来源会让这条 12KB 自动注入在会话记录、标题生成、遥测里与用户输入无法区分。
   现已改为 `kind: 'plugin'` + `form: 'notice'` + `summary`，同时让门控只认真正的用户输入。
2. **系统提示词段落序号**：过去写死 `order: 98`，并在注释/文档里声称「内置工具指引在
   100–104」。当前 DSH 的段落序号由 `SystemPrompt` 集中分配（`TOOL_BASH=1000`、
   `TOOL_READ=1100`、… `TOOL_GREP=1500`），契约是调用
   `systemPrompt.getSectionOrder(...)` 取位置。现改为「取 `TOOL_BASH` 的前一格」
   （当前为 999），表被重新编号也不会错位；仅在没有该 API 的旧 harness 上回退到 98。

另外补齐的工程项：`peerDependencies` 收紧到实际校对过的版本线（原来声明兼容
`0.0.1-rc.1`，无从验证）、补 `engines`/`author`/`scripts.test`、
测试 harness 跨平台化（原版在 Windows 上第一行就崩：ESM 动态 `import` 不接受
`E:\...` 裸路径，且依赖 `which` / `/bin/bash` / `/tmp`）。

## 一装上就会优先调用 codegraph 搜代码

插件不只是一个「把工具放出来」的包，它还会**在系统提示词里注入一条高优先级指引**
（`tool:codegraph`），让模型在搜索/探索代码时**优先用 `codegraph_*` 而不是
grep / glob / read**：

- 位置取「内置工具指引块的前一格」：DSH 的段落序号由 `SystemPrompt` 集中分配
  （`TOOL_BASH=1000`、`TOOL_READ=1100`、`TOOL_WRITE=1200`、`TOOL_EDIT=1300`、
  `TOOL_GLOB=1400`、`TOOL_GREP=1500`），本插件调用
  `systemPrompt.getSectionOrder('TOOL_BASH') - 1`（当前为 **999**）落在这块之前，
  因此模型先看到“优先用 codegraph_* 搜代码”。集中表被重新编号也不会错位。
- 指引措辞采用上游官方 MCP server instructions 的同款策略（软性 "Prefer" 会被模型忽略，
  实测会退回 grep/bash 反射路径）：**命令式**（MUST use `codegraph_explore` INSTEAD of
  grep/glob/read）+ **反模式清单**（不要先 grep「找文件」、不要用 grep 复核 codegraph
  结果——它来自完整 AST 解析）+ **未索引项目的硬停止规则**（不自行初始化时，本会话
  不再调用 codegraph 工具，索引与否是用户的决定）。
- 指引只点名 core surface 的 4 个工具：`codegraph_status` 确认索引 → 未初始化则
  `codegraph_init` → 之后用 `codegraph_explore` 一次拿到相关符号的逐行源码 + 调用链，
  改完代码用 `codegraph_sync`。

也就是说：**装上即生效，无需每个会话单独配置**——其他会话也一样会优先走 codegraph
来完成代码搜索。

## 结构化 prompt 自动前置注入（frontload）

提示词指引仍是「软性」的——模型可能忽略它（上游实测如此）。因此本插件实现了上游
`UserPromptSubmit` prompt-hook 的 DSH 等价物，也是上游验证过最有效的采用率手段：

- 插件监听 `agent/inbox/inserted` 事件；当一条**真实用户 prompt** 进入 agent 的
  next-turn 收件箱时，按置信度分级门控：
  - **高置信**：prompt 含结构性关键词（中/英：「调用 / 流程 / 原理 / 重构 / 影响 /
    依赖 / how does / who calls / refactor / trace …」）→ 直接触发；
  - **中置信**：prompt 含代码形态 token（文件名 / camelCase / PascalCase / snake_case）
    → 先用 `codegraph query` 对照索引验证 token 是真实符号才触发；
  - 其余 prompt（如「fix this typo」）零开销静默跳过。
  - 门控按 `source.kind` 认「谁产出的」：只有 `kind: 'user'`（本地输入或 `user-rpc`）
    才算用户 prompt；插件注入的上下文是 `kind: 'plugin'`，不会触发自己。
- 触发后在会话 cwd 向上找最近的 `.codegraph/` 索引根（找不到 = 未索引 = 静默跳过，
  **是否索引是用户的决定，插件不擅自 init**），预跑 `codegraph_explore`，把结果以
  `<codegraph_context>` 包裹 steer 进当前 turn（上限 12000 字符）。
- 注入消息声明 `source: { kind: 'plugin', plugin: 'dsh-codegraph', form: 'notice',
  summary: … }`——与 DSH 自己的插件注入（如模型切换提示）同一套来源契约，绝不冒充用户输入。
- 于是「模型反射性 grep/read 要找的东西已经在上下文里了」——context 先于工具调用到达。
- **绝不弄坏用户 prompt**：所有失败路径（无索引、门控未命中、CLI 报错）都是静默 no-op；
  注入内容带标记，不会触发自身循环（steer 落在 next-step 边界，监听器只看 next-turn）。
- **去重**：同文 prompt 在 10 分钟内重复进入收件箱（GUI 重发排队消息、step 被拒后重新
  入队——每次消息 id 都是新的）只会注入一次，避免重复上下文。
- 可用配置 `frontload: false` 整体关闭。

## 配置

在组合层（如 `cordis.patch.yml` 的 insert 行）可为插件传配置：

```yaml
- insert:
    - id: dsh-codegraph
      name: '@zfdx123/dsh-codegraph'
      require: '@zfdx123/dsh-codegraph'
      config:
        guideSearch: true    # 默认 true：注入上述系统提示指引；false 只注册工具
        surface: core        # 默认 core：只注册 status/init/sync/explore 共 4 个工具；
                             # 设为 full 注册全部 13 个
        frontload: true      # 默认 true：结构化 prompt 自动前置注入；false 关闭
```

> `name` 与 package.json 的 `name` 必须逐字一致（加载器按它解析）；带 scope 的名字在
> YAML 里**必须加引号**——以 `@` 开头的裸标量是保留指示符。`id` 是覆盖句柄，与包名无关。

## 使用流程

1. 在项目目录开一个新的 DSH 会话（cwd = 项目根）。
2. 让模型先跑 `codegraph_status`：未初始化 → 跑 `codegraph_init`。
3. 之后用 `codegraph_explore` 查代码（一次调用返回相关符号源码 + 调用链）；
   `surface: 'full'` 下还可用 `codegraph_query` / `codegraph_node` /
   `codegraph_callers` / `codegraph_callees` / `codegraph_impact` 做更细的查询。
4. 改动代码后用 `codegraph_sync`，需要跑测试时用 `codegraph_affected`（full）。

所有工具默认作用于调用方会话的 cwd；也可显式传 `path` 指向其他项目。

## 为什么会话级 MCP server 不理想（本插件为何存在）

codegraph 的官方 MCP server 在工作区**未建立索引时暴露 0 个工具**（并提示模型
“不要自己索引”）。本插件始终暴露工具——包括模型自举和维护索引所需的
`init`/`index`/`sync`——因此是比 MCP 更顺手的集成方式。

## 测试

`npm test` 跑 `test/run-plugin-test.mjs`：一个自带**真实 `codegraph` CLI + 桩 cordis 服务**
的运行时兼容性 harness。它加载本仓库的 `lib/index.js`，挂载 `tools` / `systemPrompt` /
`subprocess` / `shell` 服务，`apply()` 后调用每个工具的真实 `execute`（参数校验与输出
schema 由 `node_modules` 里真实的 `defineTool` 执行，不是另外写的假货）。

```bash
npm install     # 装 devDependencies（即被校对版本的一方包）
npm test        # 真实 CLI 生命周期 + 全部工具 + frontload 门控（个别环境相关用例会 skip）
```

覆盖：mount 不抛错、**`tool:codegraph` 段落位置取自 harness 的集中序号表（999 = TOOL_BASH-1）
且无表时回退 98**、指引文本的措辞与工具名范围、**默认 core surface 只注册 4 个工具**、
`surface: 'full'` 下 13 个工具全部注册并真实执行（`status` → `init` → `query` / `node`
（符号模式与文件模式）/ `explore` / `files` / `callers` / `callees` / `impact` / `affected`
→ `sync`）、**frontload**（结构性 prompt 注入 `<codegraph_context>`，且来源必须是
`kind: 'plugin'` + `form: 'notice'`；同文重发去重；非结构性 / 未索引 / 自循环 / 他源
prompt 静默跳过；`frontload:false` 不注册监听器）、**无执行器服务时 apply 不抛错**
（惰性解析，启动顺序安全）、显式 `path` 覆盖会话 cwd、以及「无 cwd 且无 path 时报错」。

夹具默认建在系统临时目录的独立沙箱里（**不在仓库内**）——插件是靠向上查找索引根
定位项目的，夹具留在仓库里会被仓库自身的索引污染。个别祖先敏感用例（「未索引项目不
注入」）在环境无法满足其前提时会**显式 skip**而不会变红，详见上文「测试的环境限制」。

环境变量：`CG_TEST_DIR`（夹具沙箱位置）、`CG_UNINDEXED_DIR`（未索引夹具位置）、
`CG_EXECUTABLE`（指定 codegraph 可执行文件）、`CG_KEEP_FIXTURE=1`（保留 fixture 索引）、
`CG_PROFILE_NM`（改测已安装 profile 里的副本）。

> 实现说明：harness 用**文件**而非管道做 stdio 采集——DSH 沙箱禁止子进程打开命名管道，
> 管道版 harness 会在插件要运行的那种受限环境里以 `spawn EPERM` 直接死掉。

## 仓库结构

```
├── package.json          # DSH bundle 声明（dsh.bundle.patch）+ peer/devDependencies
├── cordis.patch.yml      # 组合层 patch（把本插件的 node half 插入 host 组合）
├── lib/index.js          # 插件实现：注册 codegraph_* 工具（core 4 个 / full 13 个）
└── test/                 # 运行时兼容性 harness（真实 CLI + 桩 cordis 服务）
```

> 根目录曾另存一份 `plugin-host.js`（会话级 host-only 动态版，`cordis_define` 的 host body）：
> 它不是 ES 模块（顶层 `return` 正是 `cordis_define` 要求的 body 形状），因此 Node 解析不了、
> 也不在 `files` 白名单里（不随包发布），并且没有任何测试——`lib/index.js` 修掉的空退出码
> 缺陷它就还留着一份，属于只会漂移的第二实现，故已删除。需要时用
> `git show 0fd8c90:plugin-host.js` 取回。

## 许可

MIT
