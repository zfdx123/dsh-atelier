# @zfdx123/dsh-atelier

DSH 插件工坊的**入口包**：装上它，下面 7 个插件一起到位。

```sh
dsh plugin --profile web add @zfdx123/dsh-atelier
```

| 插件 | 干什么 |
|---|---|
| `@zfdx123/dsh-mcp-manager` | 在设置页管理 MCP 服务器，宿主侧按配置热挂载/卸载（支持内网自签名证书） |
| `@zfdx123/dsh-skills-manager` | 诊断、新建、编辑、开关、搬运磁盘上的技能，并给模型一个 `skill_manager` 工具 |
| `@zfdx123/dsh-memery` | 跨会话记忆：工作区 sqlite 库 + 首轮注入 + 每轮关键词命中 + `memory_*` 工具 |
| `@zfdx123/dsh-codegraph` | 代码知识图谱：`codegraph_*` 工具 + 结构化提问前的上下文前置 |
| `@zfdx123/dsh-hooks-ordering` | 为 Cordis 的 waterfall / serial 钩子提供确定性的 before/after 排序 |
| `@zfdx123/dsh-session-cleaner` | 在运行中的 web 运行时里彻底删除会话（store 条目 / 工作区记录 / 磁盘产物 / 投影缓存） |
| `@zfdx123/dsh-superpowers` | 软件开发方法论技能 + 会话引导 |

只想装其中一个？直接装那个包即可，不必经过本包。

本包装上后，它的 patch 会把 7 个插件逐行插进组合树。

> 不要再单独装其中的某个插件——那样同一个 id 会被插两次。要单个就只装那一个。

- 仓库：<https://github.com/zfdx123/dsh-atelier>
- 需要 DSH `^0.1.6-alpha.1`、Node `^22.19.0 || >=24.0.0`

MIT
