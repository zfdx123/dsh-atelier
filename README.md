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
| [`dsh-hooks-ordering`](packages/dsh-hooks-ordering) | 为 Cordis 的 waterfall / serial 钩子提供确定性的 before/after 排序 | **钩子排序** |
| [`dsh-session-cleaner`](packages/dsh-session-cleaner) | 在运行中的 web 运行时里彻底删除会话：store 条目、工作区记录、磁盘产物、投影缓存 | **会话清理** |
| [`dsh-superpowers`](packages/dsh-superpowers) | 软件开发方法论技能 + 会话引导（移植自 [obra/superpowers](https://github.com/obra/superpowers)） | （技能，无需设置） |

只想装一个：

```sh
dsh plugin --profile web add @zfdx123/dsh-memery
```

## 前置要求

- DSH `^0.2.3-alpha.2`（各包的 `engines.dsh` 与 peer 范围都声明这一条；1.0.20 起**只**支持这一版，`0.1.7-rc.2` / `0.2.0-rc.*` / `0.2.1-alpha.*` / `0.2.1-rc.*` 都不再被接纳）。一条 caret 收不下**跨元组**的 prerelease——严格 semver 只把 prerelease 候选交给「元组相同且自带 prerelease」的比较器，要同时支持两个元组就得写 `a || b`，两条缺一不可。安装期闸门在 `dsh-app-boot`：0.2.1-rc.2 起**有 `engines.dsh` 就只看它、peer 一律忽略**（0.2.3-alpha.2 逐字节未变），所以决定装不装得上的是这一条 caret；它用 `includePrerelease: true` 判定，比严格 semver 宽，范围写宽了不会当场报错，要等到真正装不上才发现
- Node `^24.22.3 || >=26.13.1`（照抄 DSH 0.2.3 的 `engines.node`：内置 undici 首次包含 2026-11 安全修复的版本，早于它的 24.x / 26.x 都不再被支持）
- 客户端界面用外壳自带的原生组件（`@deepseek-ai/dsh-client-ui-primitives`）；拿不到时逐处降级，不会白屏
- peer `@deepseek-ai/cordis ~4.2.0-alpha.1`（照抄 DSH 自己的声明：0.2.3-alpha.2 把四个基础包一起推到新的 prerelease——cordis `4.2.0-alpha.1`、schemastery `3.20.0-alpha.1`、cosmokit `1.10.0-alpha.1`、cordis-plugin-loader/include/group `1.2.0-alpha.1`。范围写旧了 `npm install` 直接 ERESOLVE——`~4.1.0` 的上界是 `<4.2.0-0`，恰好把 `4.2.0-alpha.1` 挡在门外）

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
  dsh-atelier/                # 本入口包（纯聚合，patch 把上面 7 个插件一起插入）
  dsh-codegraph/
  dsh-hooks-ordering/
  dsh-mcp-manager/
  dsh-memery/
  dsh-session-cleaner/
  dsh-skills-manager/
  dsh-superpowers/
```

每个包自带锁文件与测试，可独立安装、独立发布。发布流程见 [RELEASING.md](RELEASING.md)。

## 许可

MIT。`dsh-superpowers` 另含上游 obra/superpowers 的许可，见该包内 `LICENSE.superpowers`。
