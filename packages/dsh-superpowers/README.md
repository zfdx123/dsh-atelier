# @zfdx123/dsh-superpowers

把 [obra/superpowers](https://github.com/obra/superpowers) 的软件开发方法论接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：在 `ctx.skills` 上注册 15 个技能（需求澄清、任务规划、TDD、系统化调试、代码审查、会话诊断等），并把 `using-superpowers` 引导语作为系统提示词段落注入，让它从第一条请求起就生效、在上下文压缩后依然存在。技能是**运行时注册**的、不落盘，所以既不往 `~/.dsh/skills` 复制任何文件，也不要求改动预设或 profile 里的技能目录。当前版本 1.0.9，面向 DSH `^0.1.7-rc.2`。

## 安装

```sh
# 从 npm 安装单个包
dsh plugin --profile web add @zfdx123/dsh-superpowers

# 一次装齐整套（MCP 管理器、技能管理器、记忆、CodeGraph、钩子排序、会话清理、Superpowers）
dsh plugin --profile web add @zfdx123/dsh-atelier

# 本地开发：link: 安装之前先在检出目录装依赖——配置 schema 是运行时依赖
cd /path/to/dsh-atelier/packages/dsh-superpowers && npm install
dsh plugin --profile web add link:/path/to/dsh-atelier/packages/dsh-superpowers
```

装完先停止再重启 `dsh web`（bundle 不做热加载）。装到别的形态就把 `web` 换成 `headless` 或自定义 profile 名，并重启对应形态。

## 快速上手

先确认插件已经挂进 profile：

```sh
dsh --profile web --dump-config
```

输出里应当出现 `id: superpowers`，紧跟其后是 `name: @zfdx123/dsh-superpowers`。然后新建一个会话，直接提一个功能需求：agent 应当先探查现状、再给出问题或设计，而不是立刻开始写代码；它的工具调用里应当出现 `skill`。

如果 bootstrap 始终没有出现，请检查该会话所用的预设——当预设的 persona 独占完整系统提示词时，它按设计就不会下发，见[已知限制](#已知限制)。

## 它做什么

- 在 `ctx.skills` 注册全部 15 个技能。它们出现在技能目录里，并通过原生 `skill` 工具按需加载；`~/.dsh/skills` 不会被写入任何东西。
- 把 `using-superpowers` 注册为 `superpowers:bootstrap` 提示词段落，order 50：位于 persona 前缀（0）之后、计划策略（500）与工具指导（1000+）之前。它在第一条请求就存在，并能在上下文压缩后继续存在——因为它属于系统提示词，而不是一次性会话消息。
- 每个工作区的首个 agent 创建时，若某个内置技能名被项目技能或预设技能遮蔽，会告警一次，并指明模型实际会加载的那份副本（provider、来源与路径）。只报一次，因为同一会话的子 agent 共享同一套组合，重复告警没有信息量。
- 把 Claude Code 风格的工具名映射到 DSH 的工具词汇：`Task` → `subagent`、`TodoWrite` → `todo_write`、`Bash`/`Read`/`Write`/`Edit`/`Glob`/`Grep` → 对应的小写工具等。映射里同时说明当前环境不提供 hooks 与斜杠命令 API，所以遇到「安装 hook / 注册斜杠命令」的指令时，应改用这些工具把活干完。
- 两个注册表都只经 `ctx` 访问（`systemPrompt`、`skills`），因此不依赖任何 `@deepseek-ai/*` 服务包从本包目录解析出来。

## 配置

所有字段都是可选的，在 profile 自己的 `cordis.patch.yml` 里按行覆盖：

```yaml
- id: superpowers
  config:
    bootstrap: false
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `skills` | `true` | 把内置技能注册到 `ctx.skills`。 |
| `bootstrap` | `true` | 注册 `using-superpowers` 提示词段落。 |
| `toolMapping` | `true` | 在 bootstrap 段落里追加 DeepSeek Harness 工具映射。 |
| `order` | `50` | bootstrap 段落的 order：persona 前缀（0）之后、计划策略（500）与工具指导（1000+）之前。 |

每个字段在生效前都会先过插件自己的 schema（`@deepseek-ai/schemastery`）：类型写错时 profile 会直接失败并指出出错字段，而不是把插件注册到一半。设置 `bootstrap: false` 之后技能仍可被发现，但不会再自动触发——模型只在自己决定查询技能目录时才会用到它们。bootstrap 段落给每次请求的系统提示词增加约 1.1k token（实测 4,465 字符）；这段内容是静态的、位于缓存前缀内，不会在每一轮作为新的聊天消息追加，所以 `bootstrap: false` 正是去掉这份固定开销的做法。

## 前置要求

- DeepSeek Harness `^0.1.7-rc.2`（`engines.dsh`）
- Node `^22.19.0 || >=24.0.0`
- peer `@deepseek-ai/cordis ^4.0.4`，以及可选的 peer `@deepseek-ai/dsh-skill`、`@deepseek-ai/dsh-system-prompt`（均为 `^0.1.7-rc.2`）
- 一个运行时依赖 `@deepseek-ai/schemastery`（提供配置 schema）：从 registry 安装会自动带上；用 `link:` 安装需要先在检出目录执行 `npm install`，否则插件加载失败

## 已知限制

**bootstrap 段落会被 complete persona 预设按设计丢掉。** 预设可以独占整个系统提示词：当预设的 persona 声明自己就是完整提示词时——内置的 `minimal` 预设正是如此（`complete: true`）——提示词注册表会在装配结束后只保留那一个段落，丢掉包括 `superpowers:bootstrap` 在内的其他所有段落。这一丢弃是静默的，而且 dsh 不发布任何相关信号：段落的 `complete` 标记不会离开注册表，`system-prompt/assemble` 监听器也无法向存在 complete 段落的 scope 追加提示词文本。因此本插件照常注册该段落、把这种情况写进文档，而不是去猜。

在该类预设下：

- bootstrap 不会下发，技能因此不会自动触发。15 个技能仍注册在 `ctx.skills` 上，但模型能否取到它们由预设决定——预设同时决定有哪些工具：`minimal` 只挂常驻 shell，所以那里也没有 `skill` 工具。
- `bootstrap: true` 不会让它出现，`bootstrap: false` 也不会有任何提示：这个段落本来就不会下发。

要拿到 bootstrap，请使用 persona 不是 complete 的预设。这条限制由可执行探针钉住：`verify/src-02-complete-persona-shadow.mjs` 会挂载真实的 `SystemPrompt`、`SkillRegistry` 与 scope 机制、按加载器的方式应用本插件，并断言「带 complete persona 的 scope 只交付它自己，且任何 `system-prompt/assemble` 监听器都补不回来」；机制一旦变化，探针会失败并提示文档已经过期。

## 开发

```sh
npm test                                         # node --test
node verify/dsh-compat.mjs                       # 运行时与打包契约
node verify/src-01-doc-order-drift.mjs           # 文档里的 order 区间 vs 已安装的段落顺序
node verify/src-02-complete-persona-shadow.mjs   # 上面那条 complete persona 限制的机制
```

`test/` 随发布产物一起发布，所以在安装后的副本里和源码检出里都能直接跑 `npm test`。`verify/` 是维护者专用的探针：不随包发布，需要本机装有 dsh（第一个参数都可传入另一份 dsh 的 `package.json` 路径，`src-01` 的第一个参数则是插件根目录）。

## 许可

`skills/` 下的技能取自 [obra/superpowers](https://github.com/obra/superpowers) v6.4.2，对应 commit [`8ca22db`](https://github.com/obra/superpowers/commit/8ca22dba9a94f28898bbce59f2537ff4d87c747d)；`package.json` 的 `superpowers` 字段记录了确切的上游版本、commit 与仓库地址。**唯一偏离上游的是格式**：`brainstorming/scripts/helper.js`、`brainstorming/scripts/server.cjs`、`systematic-debugging/condition-based-waiting-example.ts`、`writing-skills/render-graphs.js` 这 4 个文件被本仓库的 prettier 重排过（语义未变，上游在 6.4.x 也没动它们），其余文件逐字节同上游。`brainstorming` 的可选视觉组件会从上游网站加载带 Superpowers 版本号的 logo，不包含项目或提示词内容；把 `SUPERPOWERS_DISABLE_TELEMETRY` 设为任一 true 值即可关闭。

这里同时适用两份 MIT 许可声明：适配器版权归其贡献者所有，依据 [LICENSE](LICENSE) 许可；内置技能版权归 Jesse Vincent 与 Superpowers 贡献者所有，依据 [LICENSE.superpowers](LICENSE.superpowers) 许可。中文文档 `README.md` 是本包的主文档，英文版见 [README.en.md](README.en.md)。
