# dsh-superpowers

[English](README.md) | 中文

dsh-superpowers 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供 [obra/superpowers](https://github.com/obra/superpowers) 适配。它注册 14 个覆盖需求澄清、任务规划、TDD、调试与代码审查的技能，并让 `using-superpowers` bootstrap 在整个会话中保持生效。

## 目录

- [安装](#安装)
- [它做了什么](#它做了什么)
- [验证](#验证)
- [配置](#配置)
- [已知限制](#已知限制)
- [开销](#开销)
- [测试](#测试)
- [环境要求](#环境要求)
- [上游与许可](#上游与许可)

## 安装

把本包作为本地工作区依赖加进 profile，然后重启对应形态：

```sh
cd E:/work/ai/dsh-superpowers && npm install   # 配置 schema 是运行时依赖
dsh plugin --profile web add link:E:/work/ai/dsh-superpowers
```

执行后先停止再重启 `dsh web`。如果要安装到其他形态，可把 `web` 换成 `headless` 或自定义 profile 名，并重启对应形态。

## 它做了什么

- 在 `ctx.skills` 注册全部 14 个 Superpowers 技能。它们会出现在技能目录中，并通过原生 `skill` 工具加载；不会往 `~/.dsh/skills` 复制任何文件。
- 把 `using-superpowers` bootstrap 注册为 `superpowers:bootstrap` 提示词段落，order 为 50。它在第一条请求中生效，并能在上下文压缩后继续存在，因为它属于系统提示词，不是一次性会话消息。若预设独占整个系统提示词，它会被替换，见[已知限制](#已知限制)。
- 每个工作区首个 agent 创建时，若内置技能名被项目或预设技能遮蔽，会报出警告，并指明模型实际加载的那份副本。
- 将 `Task`、`TodoWrite`、`Bash`/`Read`/`Write`/`Edit` 等 Claude Code 风格工具名映射到 DeepSeek Harness 对应工具。映射中也会说明当前环境不提供 hooks 与斜杠命令。

## 验证

先确认插件已挂载到 profile：

```sh
dsh --profile web --dump-config
```

输出中应包含 `id: superpowers`，其后是 `name: @zfdx123/dsh-superpowers`。

然后新建会话并提出一个功能需求。Agent 应先探查，再给出问题或设计，不会立即开始写代码。工具调用中应出现 `skill`。

如果 bootstrap 始终没有出现，请检查会话所用的预设：当预设的 persona 独占完整系统提示词时，它按设计就不会下发，见[已知限制](#已知限制)。

## 配置

所有字段均为可选项，可在 profile 自己的 `cordis.patch.yml` 中覆盖：

```yaml
- id: superpowers
  config:
    bootstrap: false
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `skills` | `true` | 把内置技能注册到 `ctx.skills`。 |
| `bootstrap` | `true` | 注册 `using-superpowers` 提示词段落。 |
| `toolMapping` | `true` | 在 bootstrap 段落中追加 DeepSeek Harness 工具映射。 |
| `order` | `50` | 把 bootstrap 放在 persona 前缀（0）之后、计划策略（500）与工具指导（1000+）之前。 |

所有字段在生效前都会先过插件自己的 schema：类型写错时 profile 会直接失败并指出出错字段，而不是把插件注册到一半。

设置 `bootstrap: false` 后，技能仍可被发现，但不会再自动触发；模型只会在自己决定查询技能目录时使用它们。

## 已知限制

预设可以独占整个系统提示词。当预设的 persona 声明自己就是完整提示词时——内置的 `minimal` 预设正是如此（`complete: true`）——提示词注册表会在装配结束后只保留那一个段落，丢掉包括 `superpowers:bootstrap` 在内的其他所有段落。这一丢弃是静默的，而且 dsh 不发布任何相关信号：段落的 `complete` 标记不会离开注册表，`system-prompt/assemble` 监听器也无法向存在 complete 段落的 scope 追加提示词文本。因此本插件照常注册该段落、把这种情况写进文档，而不是去猜；`verify/src-02-complete-persona-shadow.mjs` 会针对已安装的 dsh 钉住这一机制。

在该类预设下：

- bootstrap 不会下发，技能因此不会自动触发。14 个技能仍注册在 `ctx.skills` 上，但模型能否取到它们由预设决定——预设同时决定有哪些工具：`minimal` 只挂常驻 shell，所以那里也没有 `skill` 工具。
- `bootstrap: true` 不会让它出现，`bootstrap: false` 也不会有任何提示：这个段落本来就不会下发。

要拿到 bootstrap，请使用 persona 不是 complete 的预设。

## 开销

bootstrap 会给每次请求的系统提示词增加约 1.1k token（4,465 字符）。这段内容是静态的，位于缓存前缀内，不会在每一轮作为新的聊天消息追加。设置 `bootstrap: false` 可以保留技能，同时去掉这份固定提示词开销。

## 测试

`npm test` 通过 `node --test` 运行测试。`test/` 会随发布产物一起发布，因此在安装后的副本里和源码检出里都能直接运行。

`verify/` 下是维护者专用的探针，会挂载真实的 dsh 服务类。它们不随包发布，且需要本机装有 dsh（第一个参数可传入另一份 dsh 的 `package.json` 路径）：

- `verify/dsh-compat.mjs` —— 本插件依赖的全部运行时与打包契约。
- `verify/src-01-doc-order-drift.mjs` —— 文档中的 order 区间与已安装段落顺序表的对照。
- `verify/src-02-complete-persona-shadow.mjs` —— [已知限制](#已知限制) 中记录的 complete persona 覆盖机制。

## 环境要求

- DeepSeek Harness `0.1.0-rc.6` 及以上
- Node.js 22.19+ 或 24+
- 一个运行时依赖 `@deepseek-ai/schemastery`，用于提供配置 schema。从 registry 安装会自动带上它；用 `link:` 安装时需要先在检出目录执行 `npm install`，否则插件无法加载。其余注册表都只通过 `ctx` 访问。

## 上游与许可

`skills/` 下的技能原样取自 [obra/superpowers](https://github.com/obra/superpowers) v6.3.0，对应 commit [`b36e082`](https://github.com/obra/superpowers/commit/b36e0829c6d0140e93cfef2ca599b1b07d4a7797)，未做修改；`package.json` 记录了确切的上游版本与 commit。

`brainstorming` 的可选视觉组件会从上游网站加载带 Superpowers 版本号的 logo，不包含项目或提示词内容。把 `SUPERPOWERS_DISABLE_TELEMETRY` 设为任一 true 值即可关闭。

这里同时适用两份 MIT 许可声明：适配器版权归其贡献者所有，依据 [LICENSE](LICENSE) 许可；内置技能版权归 Jesse Vincent 与 Superpowers 贡献者所有，依据 [LICENSE.superpowers](LICENSE.superpowers) 许可。
