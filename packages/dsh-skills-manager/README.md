# @zfdx123/dsh-skills-manager

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）用的**技能管理器**：把散落在磁盘上的技能（`<root>/<name>/SKILL.md` 目录包，或 `<root>/<name>.md` 单文件）当成**可管理的对象**——能诊断、能编辑、能开关、能搬运、能删除，并补上官方 provider 缺的那一半。它同时给模型一个 `skill_manager` 工具，让「给某类任务现场造一个技能」变成对话里的一句话。

## 安装

npm 安装（推荐）：

```sh
dsh plugin --profile web add @zfdx123/dsh-skills-manager
```

想把整套插件（目前 7 个）一次装齐，用聚合包：

```sh
dsh plugin --profile web add @zfdx123/dsh-atelier
```

> 两者**不要同时装**：同一个插件 id 会被插进组合树两次。要单个就只装那一个。

本插件是一个 **profile bundle**（与 `dsh-mcp-manager` 同形态），装进哪个 profile 就在哪个 profile 生效；装完**重启 `dsh web`**（组合树在进程启动时装配）。

本地目录安装（改代码时用）：

```bash
# 1. 把包加进 profile 的依赖
cd ~/.dsh/profiles/web
# 编辑 package.json 的 dependencies，加一行：
#   "@zfdx123/dsh-skills-manager": "link:E:/work/ai/dsh-atelier/packages/dsh-skills-manager"
# 并把包名加进 dsh.profile.bundles 数组

# 2. 安装（建立符号链接）
pnpm install

# 3. 重启 dsh（组合树在进程启动时装配）
```

### 验证安装

重启后：

1. 设置页应出现 **技能管理**；
2. 侧栏左下应出现 **技能**；
3. 让模型调 `skill_manager`（`action: list`）应能列出技能。

如果设置页没出现，先看宿主日志里有没有 `loaded without registering "<id>" via __ModuleLoader__.load`——那是客户端注册 id 与包名不一致（客户端 bundle 的注册 id 必须等于**包名** `@zfdx123/dsh-skills-manager`，写成短名会在挂载阶段直接抛错）。

### 禁用

在 profile 的 `cordis.patch.yml` 里按**插件行 id** `skill-manager` 覆盖：

```yaml
- id: skill-manager
  disabled: true
```

## 快速上手

```sh
# 1) 装 + 重启
dsh plugin --profile web add @zfdx123/dsh-skills-manager

# 2) 打开 设置 → 技能管理：列表顶部就是诊断摘要
#    「N 个技能 · 正常 x · 警告 y · DSH 会跳过 z」
#    有 broken 的先在这一屏修掉——那些技能官方 provider 只会 warn 然后丢掉

# 3) 侧栏左下「技能」：就地浮层，随手开关或改正文，不用跳进设置页

# 4) 想加自己的技能库：设置页「自定义技能文件夹」→ 填目录（或用「浏览…」）
#    仓库式技能库（技能在 <集合>/skills/<名称>/SKILL.md）记得勾「递归」
```

让模型用它：

```
用 skill_manager 列出所有技能，把 DSH 会跳过的那些连同原因一起告诉我。
用 skill_manager 新建一个技能：name=changelog-entry，description=…，写进当前项目根目录。
```

## 它做什么

### 官方 provider 缺的那一半

官方 provider（`@deepseek-ai/dsh-skill-filesystem`）负责**发现并加载**，但它有几个让技能作者很难受的特性：

| 官方行为 | 后果 |
|---|---|
| 坏 frontmatter 只 `logger.warn`，然后**静默跳过** | 模型侧分不清「技能不存在」和「技能写坏了」 |
| 会话目录里**看不到**路径、层、rank、遮蔽关系 | 改了文件不生效时，不知道是哪一份在生效 |
| 完全没有写操作 | 新建/改名/开关/搬运只能靠手改文件 |
| `name` 语法、布尔语法、遗留键都是硬规则 | 写错了没提示，技能直接消失 |

本插件补上这些：**诊断 + 读写 + 分层可视化**。

### 交付了什么

| 面 | 位置 | 说明 |
|---|---|---|
| 设置页 | 设置 → **技能管理** | 完整管理台：列表 / 诊断 / 详情编辑 / 新建 / 搬运 / 回收站 |
| 侧栏入口 | 侧栏左下角 **技能** | 就地浮层，随手开关或改正文 |
| 模型工具 | `skill_manager` | 让模型在对话里给某类任务现场造技能或修技能 |
| 宿主 API | `/api/skills/manager` | 上面三者共用的唯一数据通道，带回环来源护栏 |

### 诊断（核心价值）

- 列出磁盘上**全部**技能，包括官方会静默跳过的那批，并说明会被跳过的原因；
- 按官方语法逐项校验：`name` kebab-case、`description` 必填、布尔语法（`boolean | 1 | 0 | "1" | "0" | true/false/yes/no/on/off`，大小写不敏感）、遗留键（`disableModelInvocation` / `modelInvocable` / `userInvocable` 会让 DSH **整条丢弃**该技能）；
- 标注遮蔽关系：同名多副本时谁是胜者、谁被遮蔽、为什么；
- 与 `ctx.skills` 注册表交叉核对，指出「磁盘上有但 DSH 还没认」的技能；
- 提示 `frontmatter.name` 与文件/目录名不一致（改名请用「重命名」）。

### 编辑

- 新建：名字 + 一句话说明 + 目标根目录 + 形态（目录包 / 单文件），自动写入可用骨架；
- 只改正文 → **frontmatter 逐字节保留**（注释、键顺序、本插件读不懂的结构都活着）；
- 改字段 → **只重写对应那一行**，其余行不动；
- 写盘前先校验：会让 DSH 跳过这个技能的内容**拒绝落盘**，避免把好文件改坏；
- 并发保护：`expectedText` 不匹配（文件被外部改过）时拒绝覆盖。

### 生命周期

- 开关：一键切换「模型可见」/「`/` 可见」（写官方支持的 `disable-model-invocation` / `user-invocable`）；
- 重命名：连同 frontmatter 的 `name` 一起改，不会留下名字与文件不符的坏状态；
- 移动 / 复制：跨根目录搬运，复制时同步改写副本的 `name`；
- 删除：移入 `<root>/.trash/<时间戳>-<名字>`，**可恢复**；点开头目录天然不会被 provider 扫到。

### 自定义技能文件夹

- 把任意目录加成技能根（rank 300）：设置页有输入框 + 「浏览…」（调宿主原生目录选择器；宿主没有 `directoryPickerController` 时会明确提示手填路径）；
- 两种扫描方式，每个文件夹独立切换：
  - **一层**（默认，与 DSH 官方一致）——只认 `<目录>/<名称>/SKILL.md` 与 `<目录>/<名称>.md`；
  - **递归**——继续向下最多 3 层找 `SKILL.md`，用于**仓库式技能库**：技能在 `<集合>/skills/<名称>/SKILL.md` 这种更深的层级时，一层扫描只会认出顶层几个；
- 递归的护栏：跳过 `node_modules` 与点开头目录；**命中一个技能后不再下探**（它内部的嵌套 `SKILL.md` 属于该技能的资源，如 `references/`，不是独立技能）；
- 目录不存在会被拒绝；勾选创建后只在**上级目录已存在**时创建，不会递归造一棵目录树；
- 自动去重：重复添加、或该目录已经是内置技能根，都会被明确拒绝；
- **移除只解除管理**，绝不动目录与其中的技能文件；
- 遮蔽关系即刻生效：自定义目录是 rank 300，低于项目层（100/200）、高于用户层（400/500）；
- 设置写在 `skill-manager` 命名空间；多窗口并发添加时有 revision 冲突重试，不会互相覆盖。

### 把管理的技能真正交给 DSH

- 注册一个技能提供者（`skills-manager`，与官方的 `filesystem` / 保留名不冲突），管理器里的技能因此**进入 DSH 会话目录、模型可按名加载**；
- 为什么必须有这一层：官方 provider 只扫**它自己配置里**的根（组合文件里那一行的 `customSkillDirs`），管理器面板添加的目录它根本不知道——不注册提供者的话，面板列出的技能就是「看得见、用不上」；
- 提供者与面板共用同一套发现逻辑，所以递归目录里的技能也一并生效；
- 每次写操作（新建/改/开关/搬运/删除/增删自定义文件夹）之后立刻让 DSH 重扫目录：注册表的目录缓存按 revision 键控，而本提供者没有文件 watcher，不主动失效的话面板里删掉的技能仍被广告、刚建的进不去；
- `inventory: false` 可关掉登记（只想看、不想让模型加载到）；开关是动态的——提供者每次 `list()` 现读配置，改完立即生效，不用拆装 provider。

### 安全

- 所有写操作必须落在已解析出的**可写**根目录之内；
- 路径段禁止 `..`，点开头目录（`.git` / `.system` / `.trash` 内部）一律拒绝；
- bundled 根（安装产物）只读；
- 包含关系判定按最严格语义实现：**跨盘符**（Windows 上 `path.relative()` 会返回绝对路径）、同级目录、父目录、自身、空值输入一律判「不在里面」——这是所有写护栏的地基；
- 原子落盘：同目录临时文件 + rename，避免半截文件被 provider 读到；
- HTTP 接口只接受**本机回环**来源，且 Host 头必须指向本机（挡 DNS rebinding）。

### 界面：与外壳同一套原生组件

- 弹窗、提示、按钮、输入框、开关、标签、状态点都用外壳自己暴露的 UI 原语（`@deepseek-ai/dsh-client-ui-primitives` 的 `Modal` / `Button` / `Input` / `Switch` / `Tag` / `StateDot` / `Toast`），不自己抄样式，所以暗色、Esc/点遮罩关闭、焦点行为、动效都与设置页其余部分一致；
- 删除 / 移除文件夹 / 重命名 / 移动 / 复制不再用浏览器自带的 `confirm` / `prompt`：删除与移除是原生确认弹窗（危险操作用外壳的红字写法），重命名与复制是带输入框的弹窗，移动/复制列出可写根目录点选，成功提示是顶部那条会自动淡出的原生 Toast；
- 写入过程中弹窗关不掉（遮罩、Esc、× 全部拦下），避免写到一半状态错乱；
- 界面上的图标同样取自外壳图标集（`IconPlusOutline16` / `IconCheckOutline16` / `IconWarningOutline16` / `IconSkillOutline16`）：按钮走 `Button` 的 `icon` 通道，其余直接渲染图标节点；
- 拿不到原语（或外壳版本里没有这个图标）时**自动降级**（退回浏览器弹窗 + 自带样式 + 原来的字形 `＋` / `✓` / `✖` / `◈`），老外壳上不会白屏；
- 文案跟随外壳语言：注册 `skill-manager` 命名空间的 zh/en 两套字典（键集一致）；`ctx.locale` 缺席时回落中文；
- 客户端半体是 classic script、**无构建步骤**，并在 `dsh.client.inject` 里声明它依赖的设置页与侧栏 UI 包。

## 配置

设置命名空间 **`skill-manager`**（由宿主持久化），全部有默认值，不配也能用：

| 字段 | 默认 | 含义 |
|---|---|---|
| `customSkillDirs` | `[]` | 额外的技能根目录（对应官方 provider 的 `customSkillDirs`，rank 300）——**只扫一层** |
| `deepSkillDirs` | `[]` | **递归扫描**的技能根（rank 300）：向下最多 3 层找 `SKILL.md`，用于仓库式技能库 |
| `bundledSkillDir` | `''` | 捆绑技能根（rank 600，**只读**） |
| `projects` | `[]` | 除了进程 cwd 之外还要管理的项目目录 |
| `inventory` | `true` | 是否把管理的技能登记给 DSH（关掉则只在面板可见，模型加载不到） |

前两项就是设置页「自定义技能文件夹」卡片管理的两个列表（含每个文件夹的「一层 / 递归」开关）；后三项没有图形入口，写在设置里即可，`inventory` 改完立即生效。

根目录解析规则与官方完全一致（rank 越小越优先）：

| rank | source | 路径 |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | 配置的 `customSkillDirs` / `deepSkillDirs` |
| 400 | `user-dsh` | `<dshHome>/skills`（跳过 `.system`） |
| 500 | `user-agents` | `<agentsHome>/skills` |
| 600 | `bundled` | 配置的 `bundledSkillDir`（只读） |

`projectRoot` = 最近的含 `.git` 的祖先目录；没有就退回 cwd。`bundledSkillDir` 为空串时不会有第 6 个根。

### 模型工具 `skill_manager`

工具用 `@deepseek-ai/dsh-tools` 的 `defineTool` 定义（该包 DSH 自带，本包声明为 optional peer）：下面这张表就是参数 schema 本身，同一份声明既编译成给模型看的 JSON Schema，也在 `execute` 之前做**参数校验**——类型或枚举不符的调用会在进入业务代码前被拒（未知 `action` 由校验层抛错，而不是靠 `execute` 里的兜底分支），声明与校验不会各写一份。

| action | 必填 | 说明 |
|---|---|---|
| `list` | — | 列出全部技能 + 诊断；`status` 可过滤 `ok` / `warning` / `broken` |
| `roots` | — | 列出根目录、rank、是否可写、各有多少技能 |
| `read` | `path` | 读一条技能的完整内容与诊断 |
| `create` | `name`, `description` | 新建；可选 `rootPath` / `kind` / `whenToUse` / `body` / `modelInvocable` / `userInvocable` |
| `update` | `path` | 改 `description` / `whenToUse` / `body` |
| `toggle` | `path`, `modelInvocable` 或 `userInvocable` | 开关入口 |
| `rename` | `path`, `newName` | 改名 + 同步 frontmatter |
| `move` | `path`, `targetRoot` | 换根目录 |
| `copy` | `path`, `targetRoot` | 复制（可给 `newName`） |
| `delete` | `path` | 移入回收站 |
| `lint` | — | 只列有问题的技能 |
| `dirs` | — | 列出自定义技能文件夹（含「一层/递归」与技能数） |
| `addDir` | `path` | 添加自定义技能文件夹；`create: true` 时目录不存在则创建；`deep: true` 递归扫描 |
| `removeDir` | `path` | 从管理器移除（不改动磁盘文件） |
| `setDirDeep` | `path`, `deep` | 就地切换某个已添加目录的扫描方式 |

## 前置要求

- **DSH `^0.1.6-alpha.1`**（`package.json` 的 `engines.dsh`；`dsh-settings` / `dsh-tools` 两个 peer 的范围同为 `^0.1.6-alpha.1`）；
- **Node ≥ 22**（`engines.node`）；
- 装成 **profile bundle**（`dsh.bundle.patch` → `cordis.patch.yml`），并在 `dsh.client.platform: web` 的前端下使用——设置页整页与侧栏入口都只在 web 前端出现；
- peer：`@deepseek-ai/cordis ^4.0.2`（必需）、`@deepseek-ai/dsh-settings ^0.1.6-alpha.1`（optional）、`@deepseek-ai/dsh-tools ^0.1.6-alpha.1`（optional）；
- 运行时依赖 `@deepseek-ai/schemastery ^3.18.1`（`settings.register` 的 schema 必须是可调用的 schemastery 对象，所以它是**运行时**依赖，锁文件里必须有；`test/manifest.test.js` 会核对）；
- `settings` 服务是**硬依赖**（`inject = ['settings']`），因为它提供可配置的技能根目录；
- 不需要任何外部服务、端口、网络或 API key。

## 已知限制

- **侧栏入口依赖外壳的 `data-slot` 锚点，锚点消失时 CSS 规则是静默空转的**。外壳的 `sidebar.footer.action` 是一个 nowrap 的横向 flex 动作行，而 `dsh-memery` 这类邻座的入口用 `width:100%`（里面的按钮再向外出血 4px）占满整行，会把本插件的入口推到侧栏右边缘之外、只剩一截圆角边框。插件注入的规则让这一行可以换行：

  ```css
  :has(> [data-slot="sidebar.footer.action"] > .dsh-skills-manager){flex-wrap:wrap}
  ```

  它从**本插件注册进去的那个 slot 锚点**（`data-slot`，渲染器给每个 slot 出的锚点）出发，并用 `:has()` 要求本插件确实在座，所以外壳自己的其它 `*_footerActions` 行（例如 user-questions 弹窗的按钮行）不受影响，也不依赖 CSS Module 的局部名——早期版本用的 `[class*="_footerActions"]` 全局片段选择器两个毛病都有，已弃用。代价是：**锚点改名、或浏览器不认 `:has()`，规则就不命中，而且是静默的**。缓解措施只在「入口真的被挤出动作行」时生效——入口挂载时会量一次几何，出界（或找不到锚点）就在浏览器控制台打一条 `[dsh-skills-manager]` 开头的警告；只要没被挤出界，规则失效不会有任何提示，入口看起来一切正常。
- **面板读的是磁盘，不是注册表**。注册表已经被 provider 过滤过一遍，用它做数据源会漏掉所有被跳过的坏技能——而那正是最需要被看到的东西。代价是面板可能列出 DSH 此刻还没加载的技能（提供者刷新延迟，界面会单独标出来）；反过来，**「面板里能看到」不等于「模型现在能用」**。
- **坏 frontmatter 的判定是复刻官方语法，不是调用官方实现**。官方改语法（`SKILL_NAME` 正则、布尔拼写集合、遗留键黑名单）而本插件没跟上时，会出现「面板说没问题、DSH 还是跳过」或反之。判据都集中在 `lib/logic.js`，对齐的是当时的官方实现。
- **frontmatter 是「行级手术」，不是 YAML 引擎**。只改正文时逐字节保留，改字段时只重写那一行；代价是本插件读不懂的 YAML 结构（多行块标量的复杂变体、锚点/别名、嵌套对象）不会被打平或规范化——它保持原样，某些结构下的字段编辑会做不了。
- **写入边界是硬约束**：路径段禁止 `..`，点开头目录一律拒绝——想把技能放进 `.system`、`.hidden` 之类的目录做不到；bundled 根只读；所有写操作必须落在已解析出的可写根内。这些拒绝是设计目标，不是缺陷。
- **单文件上限 2 MiB**（`MAX_SKILL_FILE_BYTES`）：超过这个大小的技能不会被读取，也不会被写入。
- **并发保护是乐观锁**。`expectedText` 不匹配（文件被外部改过）时拒绝覆盖；两个窗口在同一瞬间先后写时，后写者拿到的是新的 `expectedText`，所以它挡的是「外部改动」而不是「同时写入」。
- **HTTP API 的信任边界是「本机」**：只接受回环来源且 Host 头指向本机，因此**不能**通过远程访问或反向代理访问管理界面。这是挡 DNS rebinding 的护栏，也是使用上的限制。
- **原生目录选择器可能不存在**：宿主没有 `directoryPickerController` 时 `pickDir` 返回 `supported: false`，界面提示手填路径——降级而已，不影响添加目录。
- **回收站不自动清理**：删除把文件移进 `<root>/.trash/<时间戳>-<名字>` 就结束，插件不清理、不做保留期；攒多了要自己删。
- **没有文件 watcher**：提供者只在**写操作之后**主动让 DSH 重扫目录缓存；你在编辑器/脚本里改了磁盘，面板要手动刷新才看得到，DSH 的目录也要等下一次写操作或它自己的重扫。
- **`settings` 不可用时功能缩水**：`settings.register` 抛错时插件降级为「全部用默认配置」并记一条 warn（一个可选的技能管理器不该让整个 profile 起不来）；此时改配置不生效，且设置页对只读配置会明确拒绝而不是静默失败。

## 开发

```bash
npm test        # node --test
```

测试分七层（共 **162 项，全绿**）：

- `test/logic.test.js` —— 纯逻辑（解析、校验、序列化保真、诊断、遮蔽）；
- `test/store.test.js` —— 真实临时目录上的 I/O（发现、写入保真、搬运、回收站、路径护栏）；
- `test/deepscan.test.js` —— 递归扫描（层级上限、跳过 `node_modules`/点目录、命中后不再下探）；
- `test/provider.test.js` —— 技能提供者（注册表契约、动态 `inventory`、未知 host / 失败不抛）；
- `test/assembly.test.js` —— 宿主装配自检（假 Cordis 上下文：路由、工具、**参数校验**、护栏、优雅降级、卸载）；
- `test/client.test.js` —— 客户端装配自检（假 `__ModuleLoader__` 与假 UI 原语：注册 id、Slot 参数、样式、弹窗/Toast 走原生组件、拿不到原语时的降级路径、`entryWrapWarning`、纯函数）；
- `test/manifest.test.js` —— 依赖清单自检（锁文件必须记录 package.json 的每一个运行时依赖）。

> Windows 上 `node --test` 会为每个测试文件起子进程；若运行在受限沙箱里会报 `spawn EPERM`，用 `node --test --test-isolation=none` 在同进程里跑即可。

### 代码结构

```
index.js            宿主半：settings 命名空间、/api/skills/manager、skill_manager 工具
client.js           客户端半：设置页整页 + 侧栏浮层（classic script，无构建步骤）
lib/logic.js        纯函数：frontmatter 解析/序列化/行级手术、校验、诊断、遮蔽、面板渲染
lib/roots.js        根目录解析与发现（对齐官方 rank 表、「只认一层」与递归扫描）
lib/store.js        受护栏保护的读写：路径校验、原子写、回收站、搬运
lib/provider.js     技能提供者：把管理器里的技能登记给 DSH（含 inventory 开关）
lib/schema.js       settings 命名空间 schema（必须是可调用的 schemastery 对象）
test/               node:test 单元测试 + 宿主/客户端装配自检
cordis.patch.yml    bundle patch：往组合树插入本插件的行
```

### 两个刻意的设计决定

**为什么自己解析 frontmatter。** 官方用 `yaml` 包，但那个包不在 web profile 的解析路径上，而本插件要在**不新增依赖**的前提下工作。更关键的是诊断：官方遇到坏 frontmatter 只 warn 然后静默跳过，本插件要把这些信息变成可展示的 issue。所以 `lib/logic.js` 实现了一个**严格对齐官方语法**的读取器（`SKILL_NAME` 正则、必填字段、`frontmatterBoolean` 的 8 种拼写、遗留键黑名单），并遵循「读不懂就不猜、原样保留」的原则。

**数据源为什么是磁盘而不是 `ctx.skills`。** 注册表只用来做交叉核对（「DSH 当前认这些」），不用来列表。

## 许可

MIT。完整文本见包内的 [LICENSE](./LICENSE)。
