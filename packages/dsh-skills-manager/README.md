# dsh-skills-manager

DSH 技能管理器：把散落在磁盘上的技能当成**可管理的对象**，并补上官方 provider 缺的那一半。

[English](#english) | 中文

---

## 这个插件解决什么问题

DSH 的技能是磁盘上的 Markdown：`<root>/<name>/SKILL.md`（目录包）或 `<root>/<name>.md`（单文件），
散落在 5 个根目录里按 rank 遮蔽。官方 provider（`@deepseek-ai/dsh-skill-filesystem`）负责**发现并加载**，
但它有几个让作者很难受的特性：

| 官方行为 | 后果 |
|---|---|
| 坏 frontmatter 只 `logger.warn`，然后**静默跳过** | 模型侧分不清「技能不存在」和「技能写坏了」 |
| 会话目录里**看不到**路径、层、rank、遮蔽关系 | 改了文件不生效时，不知道是哪一份在生效 |
| 完全没有写操作 | 新建/改名/开关/搬运只能靠手改文件 |
| `name` 语法、布尔语法、遗留键都是硬规则 | 写错了没提示，技能直接消失 |

本插件补上这些：**诊断 + 读写 + 分层可视化**，并且给模型一个 `skill_manager` 工具。

---

## 交付了什么

| 面 | 位置 | 说明 |
|---|---|---|
| 设置页 | 设置 → **技能管理** | 完整管理台：列表 / 诊断 / 详情编辑 / 新建 / 搬运 / 回收站 |
| 侧栏入口 | 侧栏左下角 **技能** | 就地浮层，随手开关或改正文 |
| 模型工具 | `skill_manager` | 让我在对话里给某类任务现场造技能或修技能 |
| 宿主 API | `/api/skills/manager` | 上面三者共用的唯一数据通道，带回环来源护栏 |

---

## 功能

**诊断（核心价值）**
- 列出磁盘上**全部**技能，包括官方会静默跳过的那批，并说明会被跳过的原因
- 按官方语法逐项校验：`name` kebab-case、`description` 必填、布尔语法、遗留键
  （`modelInvocable` / `userInvocable` / `disableModelInvocation` 会让整条技能被丢弃）
- 标注遮蔽关系：同名多副本时谁是胜者、谁被遮蔽、为什么
- 与 `ctx.skills` 注册表交叉核对，指出「磁盘上有但 DSH 还没认」的技能
- 提示 `frontmatter.name` 与文件/目录名不一致（改名请用「重命名」）

**编辑**
- 新建：名字 + 一句话说明 + 目标根目录 + 形态（目录包 / 单文件），自动写入可用骨架
- 只改正文 → **frontmatter 逐字节保留**（注释、键顺序、本插件读不懂的结构都活着）
- 改字段 → **只重写对应那一行**，其余行不动
- 写盘前先校验：会让 DSH 跳过这个技能的内容**拒绝落盘**，避免把好文件改坏
- 并发保护：`expectedText` 不匹配（文件被外部改过）时拒绝覆盖

**生命周期**
- 开关：一键切换「模型可见」/「`/` 可见」（写官方支持的 `disable-model-invocation` / `user-invocable`）
- 重命名：连同 frontmatter 的 `name` 一起改，不会留下名字与文件不符的坏状态
- 移动 / 复制：跨根目录搬运，复制时同步改写副本的 `name`
- 删除：移入 `<root>/.trash/<时间戳>-<名字>`，**可恢复**；点开头目录天然不会被 provider 扫到

**自定义技能文件夹**
- 把任意目录加成技能根（rank 300）：设置页有输入框 + 「浏览…」（调宿主原生目录选择器）
- 两种扫描方式，每个文件夹独立切换：
  - **一层**（默认，与 DSH 官方一致）——只认 `<目录>/<名称>/SKILL.md` 与 `<目录>/<名称>.md`
  - **递归**——继续向下最多 3 层找 `SKILL.md`，用于**仓库式技能库**：
    技能在 `<集合>/skills/<名称>/SKILL.md` 这种更深的层级时，一层扫描只会认出顶层几个
- 递归的护栏：跳过 `node_modules` 与点开头目录；**命中一个技能后不再下探**
  （它内部的嵌套 `SKILL.md` 属于该技能的资源，如 `references/`，不是独立技能）
- 目录不存在会被拒绝；勾选创建后只在**上级目录已存在**时创建，不会递归造一棵目录树
- 自动去重：重复添加、或该目录已经是内置技能根，都会被明确拒绝
- **移除只解除管理**，绝不动目录与其中的技能文件
- 遮蔽关系即刻生效：同名技能低于项目层、高于用户层
- 设置写在 `skill-manager` 命名空间；多窗口并发添加时有 revision 冲突重试，不会互相覆盖

**把管理的技能真正交给 DSH**
- 注册一个技能提供者（`skills-manager`），管理器里的技能因此**进入 DSH 会话目录、模型可按名加载**
- 为什么必须有这一层：官方 provider 只扫**它自己配置里**的根（组合文件里那一行的 `customSkillDirs`），
  管理器面板添加的目录它根本不知道——不注册提供者的话，面板列出的技能就是「看得见、用不上」
- 提供者与面板共用同一套发现逻辑，所以递归目录里的技能也一并生效
- 每次写操作（新建/改/开关/搬运/删除/增删自定义文件夹）之后立刻让 DSH 重扫目录：
  注册表的目录缓存按 revision 键控，而本提供者没有文件 watcher，不主动失效的话
  面板里删掉的技能仍被广告、刚建的进不去
- `inventory: false` 可关掉登记（只想看、不想让模型加载到）；开关是动态的，改完立即生效

**安全**
- 所有写操作必须落在已解析出的**可写**根目录之内
- 路径段禁止 `..`，点开头目录（`.git` / `.system` / `.trash` 内部）一律拒绝
- bundled 根（安装产物）只读
- 包含关系判定按最严格语义实现：**跨盘符**（Windows 上 `path.relative()` 会返回绝对路径）、
  同级目录、父目录、自身、空值输入一律判「不在里面」——这是所有写护栏的地基
- 原子落盘：同目录临时文件 + rename，避免半截文件被 provider 读到
- HTTP 接口只接受**本机回环**来源，且 Host 头必须指向本机（挡 DNS rebinding）

**界面：与外壳同一套原生组件**
- 弹窗、提示、按钮、输入框、开关、标签、状态点都用外壳自己暴露的 UI 原语
  （`@deepseek-ai/dsh-client-ui-primitives` 的 `Modal` / `Button` / `Input` / `Switch` / `Tag` / `StateDot` / `Toast`），
  不自己抄样式，所以暗色、Esc/点遮罩关闭、焦点行为、动效都与设置页其余部分一致
- 删除 / 移除文件夹 / 重命名 / 移动 / 复制不再用浏览器自带的 `confirm` / `prompt`：
  删除与移除是原生确认弹窗（危险操作用外壳的红字写法），重命名与复制是带输入框的弹窗，
  移动/复制列出可写根目录点选，成功提示是顶部那条会自动淡出的原生 Toast
- 写入过程中弹窗关不掉（遮罩、Esc、× 全部拦下），避免写到一半状态错乱
- 界面上的图标同样取自外壳图标集（`IconPlusOutline16` / `IconCheckOutline16` / `IconWarningOutline16` /
  `IconSkillOutline16`），不再拿 `＋` `✓` `✖` `◈` 这些 Unicode 字形当图标用：
  按钮走 `Button` 的 `icon` 通道，其余直接渲染图标节点
- 拿不到原语（或外壳版本里没有这个图标）时**自动降级**（退回浏览器弹窗 + 自带样式 + 原来的字形），老外壳上不会白屏

---

## 安装

本插件是一个 DSH profile bundle，跟 `dsh-mcp-manager` 同形态。装进哪个 profile 就在哪个 profile 生效。

### 本地 link 安装

```bash
# 1. 把包加进 profile 的依赖
cd ~/.dsh/profiles/web
# 编辑 package.json 的 dependencies，加一行：
#   "@zfdx123/dsh-skills-manager": "link:E:/work/ai/dsh-skills-manager"
# 并把包名加进 dsh.profile.bundles 数组

# 2. 安装（建立符号链接）
pnpm install

# 3. 重启 dsh（组合树在进程启动时装配）
```

### 验证安装

重启后：

1. 设置页应出现 **技能管理**；
2. 侧栏左下应出现 **技能**；
3. 让我调 `skill_manager`（`action: list`）应能列出技能。

如果设置页没出现，先看宿主日志里有没有
`loaded without registering "<id>" via __ModuleLoader__.load` —— 那是客户端注册 id 与包名不一致。

侧栏 **技能** 消失时先看它是不是被裁掉了：外壳的 `sidebar.footer.action` 是一个 nowrap 的横向
flex 动作行，而 `dsh-memery` 这类邻座的入口用 `width:100%`（里面的按钮再向外出血 4px）占满整行，
会把本插件的入口推到侧栏右边缘之外，只剩一截圆角边框。插件注入的规则让这一行可以换行：

```css
:has(> [data-slot="sidebar.footer.action"] > .dsh-skills-manager){flex-wrap:wrap}
```

它从**本插件注册进去的那个 slot 锚点**（`data-slot`，渲染器给每个 slot 出的锚点）出发，并用
`:has()` 要求本插件确实在座，所以外壳自己的其它 `*_footerActions` 行（例如 user-questions 弹窗的
按钮行）不受影响，也不依赖 CSS Module 的局部名。万一锚点变了、或浏览器不认 `:has()`（规则不会
命中），侧栏入口挂载时会在控制台给一条 `[dsh-skills-manager]` 警告——被裁掉这件事不会静默发生。

### 禁用

在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: skill-manager
  disabled: true
```

---

## 配置

设置命名空间 `skill-manager`，全部有默认值，不配也能用：

| 字段 | 默认 | 含义 |
|---|---|---|
| `customSkillDirs` | `[]` | 额外的技能根目录（对应官方 provider 的 `customSkillDirs`，rank 300）——**只扫一层** |
| `deepSkillDirs` | `[]` | **递归扫描**的技能根（rank 300）：向下最多 3 层找 `SKILL.md`，用于仓库式技能库 |
| `bundledSkillDir` | `''` | 捆绑技能根（rank 600，**只读**） |
| `projects` | `[]` | 除了进程 cwd 之外还要管理的项目目录 |
| `inventory` | `true` | 是否把管理的技能登记给 DSH（关掉则只在面板可见，模型加载不到） |

根目录解析规则与官方完全一致（rank 越小越优先）：

| rank | source | 路径 |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | 配置的 `customSkillDirs` |
| 400 | `user-dsh` | `<dshHome>/skills`（跳过 `.system`） |
| 500 | `user-agents` | `<agentsHome>/skills` |
| 600 | `bundled` | 配置的 `bundledSkillDir`（只读） |

`projectRoot` = 最近的含 `.git` 的祖先目录；没有就退回 cwd。

---

## 模型工具 `skill_manager`

工具用 `@deepseek-ai/dsh-tools` 的 `defineTool` 定义（该包 DSH 自带，本包声明为 optional peer，
profile 装依赖时会带上）：下面这张表就是参数 schema 本身，同一份声明既编译成给模型看的 JSON Schema，
也在 `execute` 之前做参数校验——类型或枚举不符的调用会在进入业务代码前被拒，声明与校验不会各写一份。

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

---

## 架构

```
index.js            宿主半：settings 命名空间、/api/skills/manager、skill_manager 工具
client.js           客户端半：设置页整页 + 侧栏浮层（classic script，无构建步骤）
lib/logic.js        纯函数：frontmatter 解析/序列化/行级手术、校验、诊断、遮蔽、面板渲染
lib/roots.js        根目录解析与发现（对齐官方 rank 表与「只认一层」规则）
lib/store.js        受护栏保护的读写：路径校验、原子写、回收站、搬运
lib/schema.js       settings 命名空间 schema（必须是可调用的 schemastery 对象）
test/               node:test 单元测试 + 宿主/客户端装配自检
cordis.patch.yml    bundle patch：往组合树插入本插件的行
```

### 为什么自己解析 frontmatter

官方用 `yaml` 包，但那个包不在 web profile 的解析路径上，而本插件要在**不新增依赖**的前提下工作。
更关键的是诊断：官方遇到坏 frontmatter 只 warn 然后静默跳过，本插件要把这些信息变成可展示的 issue。
所以 `lib/logic.js` 实现了一个**严格对齐官方语法**的读取器
（`SKILL_NAME` 正则、必填字段、`frontmatterBoolean` 的 8 种拼写、遗留键黑名单），
并遵循「读不懂就不猜、原样保留」的原则。

### 数据源

面板读的是**磁盘扫描**，不是 `ctx.skills` 注册表。
注册表已经被 provider 过滤过一遍，用它会漏掉所有被跳过的坏技能——而那正是最需要被看到的东西。
注册表只用来做交叉核对（「DSH 当前认这些」）。

---

## 开发

```bash
npm test        # node --test
```

测试分五层：

- `test/logic.test.js` —— 纯逻辑（解析、校验、序列化保真、诊断、遮蔽）
- `test/store.test.js` —— 真实临时目录上的 I/O（发现、写入保真、搬运、回收站、路径护栏）
- `test/assembly.test.js` —— 宿主装配自检（假 Cordis 上下文：路由、工具、参数校验、护栏、优雅降级、卸载）
- `test/client.test.js` —— 客户端装配自检（假 `__ModuleLoader__` 与假 UI 原语：注册 id、Slot 参数、样式、
  弹窗/Toast 走原生组件、拿不到原语时的降级路径、纯函数）
- `test/manifest.test.js` —— 依赖清单自检（锁文件必须记录 package.json 的每一个运行时依赖）

> Windows 上 `node --test` 会为每个测试文件起子进程；若运行在受限沙箱里会报 `spawn EPERM`，
> 用 `node --test --test-isolation=none` 在同进程里跑即可（本仓库就是这么自测的）。

---

<a id="english"></a>
## English

A skill manager for DeepSeek Harness. Skills are Markdown files on disk
(`<root>/<name>/SKILL.md` bundles or `<root>/<name>.md` flat files) spread across five ranked roots.
The shipped provider discovers and loads them but **silently skips** anything with broken
frontmatter, exposes no paths/ranks/shadowing, and offers no write operations.

This plugin adds the missing half:

- **Diagnostics** — every skill on disk, including the ones DSH skips, with the exact reason
  (kebab-case name grammar, required `description`, the eight accepted boolean spellings,
  and the legacy keys that make DSH discard a whole skill), plus shadowing and a cross-check
  against the live `ctx.skills` registry.
- **Editing that preserves your file** — body-only edits keep the frontmatter block
  byte-identical; field edits rewrite only that one line, so comments, key order and
  unrecognized YAML survive. Writes that would make DSH skip the skill are refused.
- **Lifecycle** — create, toggle model/`/` visibility, rename (syncing `frontmatter.name`),
  move/copy across roots, and recoverable delete into `<root>/.trash/`.
- **Safety** — writes are confined to resolved writable roots, `..` and dot-prefixed path
  segments are rejected, the bundled root is read-only, writes are atomic, and the HTTP API
  accepts loopback origins only with a matching Host header.
- **Model tool** — `skill_manager` lets the agent author and repair skills during a session.

Install it as a profile bundle (same shape as `dsh-mcp-manager`): add the package to the
profile's `dependencies` and `dsh.profile.bundles`, run `pnpm install`, then restart `dsh`.

## License

MIT
