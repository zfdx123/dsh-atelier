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
| `@zfdx123/dsh-plugin-hooks-ordering` | 为 Cordis 的 waterfall / serial 钩子提供确定性的 before/after 排序 |
| `@zfdx123/dsh-session-cleaner` | 在运行中的 web 运行时里彻底删除会话（store 条目 / 工作区记录 / 磁盘产物 / 投影缓存） |
| `@zfdx123/dsh-superpowers` | 软件开发方法论技能 + 会话引导 |

只想装其中一个？直接装那个包即可，不必经过本包。

本包自身**不注册任何东西**（它的 `cordis.patch.yml` 是空的，原因见文件内注释）：7 个插件各自带 patch，启动器的 reconcile 会把它们逐个加进 profile 的 bundle 列表。

- 仓库：<https://github.com/zfdx123/dsh-atelier>
- 需要 DSH `^0.1.6-alpha.1`、Node `^22.19.0 || >=24.0.0`

MIT
