# dsh-atelier

**DSH（DeepSeek Harness）插件工坊**——7 个插件，一条命令装齐。

```sh
dsh plugin --profile web add @zfdx123/dsh-atelier
```

装完重启 DSH，设置页里就会出现各自的入口。

## 都有什么

| 插件 | 干什么 | 设置页入口 |
|---|---|---|
| [`dsh-mcp-manager`](packages/dsh-mcp-manager) | 在设置页配置 MCP 服务器，宿主侧按配置热挂载/卸载，支持内网自签名证书 | **MCP 服务器** |
| [`dsh-skills-manager`](packages/dsh-skills-manager) | 诊断、新建、编辑、开关、搬运磁盘上的技能（SKILL.md），并给模型一个 `skill_manager` 工具 | **技能管理**（另有侧栏入口） |
| [`dsh-memery`](packages/dsh-memery) | 跨会话记忆：工作区 sqlite 库 + 首轮注入 + 每轮关键词命中 + `memory_*` 工具，无外部服务 | **记忆** |
| [`dsh-codegraph`](packages/dsh-codegraph) | 代码知识图谱：把 `codegraph` CLI 包成 `codegraph_*` 工具，结构化提问前自动前置上下文 | （工具，无需设置） |
| [`dsh-plugin-hooks-ordering`](packages/dsh-plugin-hooks-ordering) | 为 Cordis 的 waterfall / serial 钩子提供确定性的 before/after 排序 | **钩子排序** |
| [`dsh-session-cleaner`](packages/dsh-session-cleaner) | 在运行中的 web 运行时里彻底删除会话：store 条目、工作区记录、磁盘产物、投影缓存 | **会话清理** |
| [`dsh-superpowers`](packages/dsh-superpowers) | 软件开发方法论技能 + 会话引导（移植自 [obra/superpowers](https://github.com/obra/superpowers)） | （技能，无需设置） |

只想装一个：

```sh
dsh plugin --profile web add @zfdx123/dsh-memery
```

## 前置要求

- DSH `^0.1.6-alpha.1`（在各包的 `engines.dsh` 与 peer 范围里声明）
- Node `^22.19.0 || >=24.0.0`
- 客户端界面用外壳自带的原生组件（`@deepseek-ai/dsh-client-ui-primitives`）；拿不到时逐处降级，不会白屏

## 装完没生效？

1. **宿主半包改动要重启 DSH 进程**才加载；客户端半包刷新页面即可。
2. 插件清单里的说明是**进程启动时**读的，改过说明也要重启才看得到。
3. 装完先确认 profile 的 bundle 列表里出现了这些包：

   ```sh
   dsh --profile web --dump-config | Select-String 'zfdx123'
   ```

## 仓库结构

```
packages/
  dsh-atelier/                # 本入口包（纯聚合，不注册任何东西）
  dsh-codegraph/
  dsh-mcp-manager/
  dsh-memery/
  dsh-plugin-hooks-ordering/
  dsh-session-cleaner/
  dsh-skills-manager/
  dsh-superpowers/
```

每个包自带锁文件与测试，可独立安装、独立发布。发布流程见 [RELEASING.md](RELEASING.md)。

## 许可

MIT。`dsh-superpowers` 另含上游 obra/superpowers 的许可，见该包内 `LICENSE.superpowers`。
