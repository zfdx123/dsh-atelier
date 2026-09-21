# dsh-plugin-hooks-ordering

为 [Cordis](https://github.com/cordiverse/cordis) 钩子提供确定性的 `before`/`after` 排序。这些钩子的参与者由相互独立、彼此无感知的插件贡献——`waterfall` 与 `serial` 两种派发方式都支持，并附带可选的 [DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness) 层，开箱即可控制真实的 dsh 钩子。

---

## 问题所在

Cordis 按**注册顺序**派发 waterfall 监听器——也就是它们在内部监听器数组中的位置，而 `prepend` 是唯一可用的调节手段。注册顺序又由 `inject` 依赖的激活时机决定，而**互不相关的插件之间的激活顺序是不确定的**。

后果是：插件**无法可靠地声明相对顺序**，比如「让我在那个插件之后运行」。具体来说：

- `ctx.on` 上没有 `before`/`after`/`stage` 声明——只有一个布尔值 `prepend`，而 `prepend` 是**后 prepend 者覆盖先 prepend 者**，所以它也不是稳定的「永远第一」。
- Cordis 提供的唯一可靠的排序原语是 `inject`：如果插件 B 注入了插件 A 提供的服务，B 就在 A 之后激活。但这就把顺序**全局地、单向地**钉死了，并且强迫 B 依赖 A——这在彼此不应互相依赖的不同厂商之间是不可能的。
- 两个插件可能**在不同的钩子上**需要**相反**的相对顺序，单一激活顺序无法表达这一点。

所以真正要紧的顺序——认证先于日志、净化器先于序列化器、指标最后执行——实际上悄悄依赖于没人控制的加载顺序。改一个看似无关的 `inject`，顺序就翻转了。

```
raw ctx.on, load order [auth, logging, metrics]  ->  auth, logging, metrics
raw ctx.on, load order [metrics, logging, auth]  ->  metrics, logging, auth   ← 同一批插件，顺序翻转
```

这不是假设。在 `deepseek-harness` 中，waterfall 钩子 `agent/pre-step` 被十几个互相独立的包订阅，`tools/post-execute` 被六个订阅，`llm/stream` 被五个订阅——而且有多处文档写明它们的相对顺序是承重的，却只由 `prepend` 和注册时序决定（参见[今天在 dsh 里是怎么排序的](#how-ordering-is-done-in-dsh-today-and-the-limits-of-each)）。

## 解决方案

你**不需要**修改或 fork Cordis。本包就是一个普通的 Cordis 插件，它**包住**指定的钩子，并自行决定参与者的顺序，与插件的加载时机无关。

**Waterfall**（`HookOrdering`）用一个 `prepend` 过的监听器包住钩子，并利用洋葱模型：

- 监听器 `next()` **之前**的代码先于整条原生链执行——**`front`** 阶段。
- `next()` **之后**的代码在一切之后执行，包括钩子自带的内置默认行为——**`back`** 阶段。

**Serial**（`SerialHookOrdering`）没有 `next()` 可以包裹，所以它用两个协调器包住钩子：一个 `prepend` 过的 **front** 协调器先于原生链执行（在这里 bail 会短路整次派发），以及一个追加在末尾的 **back** 协调器，尽力最后执行。

两者都是：参与者注册到协调器上（而不是原始钩子），用 `before`/`after` 名字声明约束，再由一个**稳定的拓扑排序**决定它们的顺序。

```
HookOrdering, load order [auth, logging, metrics]  ->  auth, logging, <宿主默认>, metrics
HookOrdering, load order [metrics, logging, auth]  ->  auth, logging, <宿主默认>, metrics   ← 稳定
```

### 为什么它应该是个插件，而不是 Cordis 内核的一部分

Cordis 刻意保持精简：它提供排序的**原语**（数组位置、`prepend`、`next()` 链）。排序的**策略**——数值序号、`before`/`after`、拓扑排序——因钩子而异，不是内核该关心的事。把它做成插件意味着零框架修改，也没有需要长期维护的 fork。

## 分层

本包做了分层，你可以在需要的高度上使用它：

| 层 | 入口 | 提供什么 |
| --- | --- | --- |
| 1. 算法 | `@zfdx123/dsh-plugin-hooks-ordering/topo-sort`、`/dag` | 纯的稳定拓扑排序，以及约束图（JSON）渲染器。零依赖，不涉及 Cordis。 |
| 2. Cordis 服务 | `@zfdx123/dsh-plugin-hooks-ordering/waterfall`、`/serial` | `HookOrdering` 与 `SerialHookOrdering`——可控制任意 Cordis 应用中的任意钩子。 |
| 3. DeepSeek-Harness | `@zfdx123/dsh-plugin-hooks-ordering`（根入口，即插件） | 一个 dsh 插件 + `cordis.patch.yml`，替你控制真实的 dsh 钩子，外加一个浏览器设置页。 |

## 安装

在 dsh profile 中把它作为 **bundle** 安装——`dsh` 会读取 `dsh.bundle.patch` 清单字段，并自行把该包注册进 `dsh.profile.bundles`：

```sh
# 从本地检出安装（本地开发）
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-plugin-hooks-ordering

# 从 registry 安装（发布之后）
dsh plugin --profile <profile> add @zfdx123/dsh-plugin-hooks-ordering
```

**不要再手动把这一行插进 profile 的 `cordis.patch.yml`。**
`dsh` 已经会从 bundle 自带的 patch 里插入它，重复一份会导致启动失败：`duplicate loader entry id: hooks-ordering`。

在 dsh 之外，本包就是一个普通的 Cordis 插件：`pnpm add` 之后直接使用根入口、`/waterfall` 或 `/serial`。`@deepseek-ai/cordis` 是 peer dependency。

## 用法

### Waterfall 钩子

```ts
import HookOrdering from '@zfdx123/dsh-plugin-hooks-ordering/waterfall'

ctx.plugin(HookOrdering)

// 钩子的拥有者（或应用组装方）只接管一次。这里安装唯一的包夹监听器；
// 接管两次会抛错，所以 prepend 竞态不会再回来。
ctx.hooksOrdering.control('request/assemble')

// 厂商 A——只声明自己的约束，不从厂商 B 导入任何东西。
ctx.hooksOrdering.register('request/assemble', 'front', {
  name: 'auth',
  before: ['logging'],
  run: (req) => authenticate(req),
})

// 厂商 B——另一个包，对 A 一无所知。
ctx.hooksOrdering.register('request/assemble', 'front', {
  name: 'logging',
  run: (req) => log(req),
})

// 厂商 C——必须在一切之后运行，包括宿主默认行为。
ctx.hooksOrdering.register('request/assemble', 'back', {
  name: 'metrics',
  run: (req) => emitMetrics(req),
})
```

无论这三个插件以什么顺序加载或注册，`auth` 都在 `logging` 之前运行，`metrics` 最后运行。

### 记录约束 DAG

传入一个 `log` 文件，即可在**每次注册变化**时写出约束图（JSON），因此它始终反映当前状态——在排查意外的顺序或环时非常好用：

```ts
ctx.plugin(HookOrdering, { log: './hooks-ordering-dag.json' })
```

```jsonc
{
  "sections": [
    {
      "hook": "request/assemble",
      "phase": "front",
      "nodes": ["auth", "logging"],
      "edges": [{ "from": "auth", "to": "logging" }]   // auth 在 logging 之前运行
    },
    {
      "hook": "request/assemble",
      "phase": "back",
      "nodes": ["metrics"],
      "edges": []
    }
  ]
}
```

该图是**不做**拓扑排序直接渲染的，所以出现环时会被如实画出，而不是抛错。你还可以随时通过 `ctx.hooksOrdering.dumpDag()`（返回 JSON 字符串）以编程方式读取它。写入失败只会经 `console.warn` 报告，绝不会抛回 fiber。

### Serial 钩子

```ts
import { SerialHookOrdering } from '@zfdx123/dsh-plugin-hooks-ordering'

ctx.plugin(SerialHookOrdering)
ctx.serialHooksOrdering.control('turn/stopping')

// front：先于原生链运行。返回一个 bail 值（除 null/false/undefined 之外的任何值）
// 会短路整次 serial 派发。
ctx.serialHooksOrdering.register('turn/stopping', 'front', {
  name: 'guard',
  run: (turn) => (isAllowed(turn) ? undefined : 'DENIED'),
})

// back：尽力最后执行（见「语义与限制」）。
ctx.serialHooksOrdering.register('turn/stopping', 'back', {
  name: 'audit',
  run: (turn) => recordAudit(turn),
})
```

### 在 DeepSeek-Harness 中使用

根入口是一个 dsh 插件，它挂载上述两个服务，并接管那些被多个包共同贡献、**且返回契约扛得住异步包夹**的 dsh 钩子（`agent/pre-step`、`agent/request`、`agent/request-error`、`system-prompt/assemble`、`tools/pre-execute`、`tools/execute`、`tools/post-execute`、`fs/write-intent`、`fs/edit-intent`、`approval/request` ……以及 serial 的 `agent/turn-stopping`）。两个返回值被调用方**同步**消费的钩子（`llm/stream`、`session-telemetry/record`）不在默认集里，并且拒绝注册参与者——原因见下文「语义与限制」。往你的 profile patch 里加一行：

```yaml
- insert:
    - id: hooks-ordering
      # 裸包名——见下面的说明。`/dsh` 也能作为插件入口，
      # 但那样 dsh 就找不到浏览器端那一半了。
      name: '@zfdx123/dsh-plugin-hooks-ordering'
      config:
        # hooks: ['agent/pre-step', 'tools/post-execute']   # 默认：所有返回契约兼容的 dsh waterfall 钩子
        # serialHooks: ['agent/turn-stopping']              # 默认：[agent/turn-stopping]
        # syncReturnHooks: ['llm/stream']                   # 默认：['llm/stream', 'session-telemetry/record']
        # log: './hooks-ordering-dag.json'                  # 可选的 DAG 日志
```

**这一行必须写包名，不能写子路径。** dsh 会把某一行的 `name` 映射回一个包，以便找到该包的浏览器端那一半（`dsh.client` → 设置页），而它的 `locatePkgJson` 只接受裸包标识符——`exactPackageSpecifier('@scope/name/subpath')` 返回 undefined，因为切分后得到三段。写成 `@zfdx123/dsh-plugin-hooks-ordering/dsh` 的那一行能完美加载宿主插件，然后悄悄地永远找不到客户端 bundle：没有设置页，而且任何地方都没有报错。这就是插件表面放在根入口的原因。

**出于同一类原因，根入口不带 `default` 导出。** 加载器会先用 `exports.default ?? exports` 规范化导入的模块，然后才应用它，所以一个并非该插件本身的 default 导出会劫持这一行：本包当时把 default（waterfall 服务）挂成了插件，`apply` 从未运行，结果是服务活着、却没有控制任何钩子，没有 serial 服务，没有设置命名空间，而且依然悄无声息。`HookOrdering` 从根入口按名字导出，同时仍然是 `/waterfall` 的默认导出。

这一行正是本包自带的 `cordis.patch.yml` 所贡献的内容。只有在该包**没有**作为 bundle 注册时才需要手写——在 dsh profile 里，`dsh plugin add` 已经把它插入了，重复一份会导致启动失败：`duplicate loader entry id: hooks-ordering`。

控制一个没有任何参与者的钩子是透明的直通，所以这一行在某个插件用 `before`/`after` 注册之前不会改变任何行为。

### 从设置页配置

同样这三个字段也能在 dsh 的设置面板里编辑，页面名为左侧导航中的**钩子排序**（命名空间 `hooks-ordering`）——无需改 profile：

| 字段 | 含义 |
| --- | --- |
| `hooks` | 要控制的 waterfall 钩子，一行一个。`[]` 完全禁用 waterfall 服务。 |
| `serialHooks` | 要控制的 serial 钩子，一行一个。`[]` 完全禁用 serial 服务。 |
| `log` | 约束 DAG（JSON）日志文件；留空表示「不记录」。顺序一旦看着不对就能派上用场。 |

第四个组装键 `syncReturnHooks` **刻意不进设置页**：它描述的是*宿主*的派发方式（哪些钩子的返回值被同步消费），而不是用户的偏好，所以它只属于 profile 那一行。表单里给 `hooks` 填上一个同步返回的钩子是安全的——它会被控制，而 `register()` 会在插件试图注册参与者时拒绝，并说明原因。

关于它的接线方式，有三点值得知道：

- **上面那一行是*基础*层。** 解析顺序是 schema 默认值 → `base`（这一行；当这一行为空时是内置钩子集合）→ 用户层。所以表单是在你的组装配置**之上**编辑，「重置为组装配置」会回到组装配置，而不是回到空表单。
- **编辑在重启后生效**（`applies: 'restart'`），这是有意为之：改 `hooks`/`serialHooks` 意味着在活动钩子上安装或移除包夹监听器，重启能干净地应用这些变更，而不是在派发链运行中途重新接线。设置 `log` 本身很廉价，但命名空间是作为一个整体生效的。
- **这个页面是客户端那一半的贡献。** 宿主侧的 `settings.register` 只创建命名空间、它的存储和它的描述符；dsh 从浏览器平面渲染设置，所以是 `client.js` 把页面注册进 `settings.section` 插槽。移除或加载失败客户端那一半，命名空间依然存在——只是没有表单。

该 dsh 插件把 `settings` 声明为**硬依赖**（`export const inject = ['settings']`），这是承重的，而非偶然：cordis 会在一个插件声明的服务存在时立刻激活它，而 `ctx.get('settings')` 只是读取服务存储，**不会**建立那个需求。只做探测而不声明，意味着插件会在第一波加载中、宿主提供 `settings` 之前就加载，命名空间于是从未被注册——悄无声息，没有表单也没有报错。声明它同时也让 prepend 的包夹在启动流程中落得更晚，而排序保证正希望它们在那里。

**本包面向 dsh。** 钩子名是 dsh 的，`settings` 是 dsh 的服务，所以两者都不做成可选的；`/waterfall` 和 `/serial` 才是不带宿主服务要求的入口。

注册本身是降级而不是让挂载失败：如果它抛错，插件会告警并回退到组装配置，因为一个可选的表单绝不能阻止 harness 启动。

## 推荐的挂载顺序

顺序由协调器强制保证，而非由加载位置决定——但协调器的包夹必须在**原生监听器注册之后**被 prepend，所以请**最后**挂载本插件：

- 插件用一个 **prepend** 过的监听器包住它控制的每个钩子；`prepend` 把它放到*到目前为止*已注册的所有监听器之前。最后挂载时，它的 `next()` 就包住了整条原生链——`front` 先于所有原生监听器运行，`back` 在所有原生监听器之后（以及宿主默认行为之后）运行。
- 如果更早挂载，一个稍后用 `{ prepend: true }` 注册的原生插件会落到包夹*之前*并逃逸排序——它「覆盖」了协调器的位置。

参与者不受加载顺序影响：它们用 `before`/`after` 名字向协调器 `register()`，而不是在 `ctx.on` 上抢位置，所以它们从不为 prepend 的位置竞争。

在 dsh profile 里，这意味着把 `hooks-ordering` 那一行放进**用户的 `cordis.patch.yml`**，它会在所有 bundle 层之后应用——于是该插件在构造上就是最后加载的。

## 今天在 dsh 里是怎么排序的（以及每种方式的局限） {#how-ordering-is-done-in-dsh-today-and-the-limits-of-each}

以下是 `deepseek-harness` 中现有的影响钩子顺序的办法——也就是本插件所取代的那些「绕行方案」。每一种都真实存在，也每一种都达不到声明式相对顺序：

1. **在 `ctx.on(...)` 上用 `{ prepend: true }`**——引擎唯一的放置手段（`unshift` 对 `push`，`vendor/cordis/src/events.ts:143`）。它是二元的，并且是*后 prepend 者覆盖先 prepend 者*：两个都 prepend 的插件会互相竞争，而谁都没法说「在前排之中排第一」。例如 `packages/spill/spill-policy/src/index.ts:209` 和 `packages/llm/llm/src/invariant.ts:88` 都在用。
2. **注册 / `ctx.plugin(...)` 的调用顺序**——默认追加使得调用顺序就是执行顺序。这只有在某一个组装点控制所有调用时才有效，一旦互不相关的厂商以没人掌握的顺序加载就失效。`packages/skill/tool-skill/src/index.ts:164` 和 `packages/examples/agent-spine-demo/src/index.ts:257` 是刻意（且脆弱地）依赖这一点的例子。
3. **`inject` 依赖**——用服务可用性来把插件的*激活*卡住（例如 `packages/core/agent-loop/src/index.ts:297` 里的 `static inject = [...]`）。这是把插件相对*服务*排序，**全局且单向**，并且强制一条依赖边。它无法表达已经挂在同一个钩子上的两个监听器之间的相对顺序，也无法表达不同钩子上的相反顺序。
4. **顺序不变量断言**——能在事后发现错误的顺序（`packages/context/time-context/src/invariant.ts:66`），但并不会强制一个顺序。
5. **Profile `cordis.patch.yml` 的行顺序**——明确**不**携带加载语义（“activation is service-availability driven”，`packages/bundle/base/cordis.patch.yml:13`），所以它根本无法给监听器排序。

`HookOrdering`/`SerialHookOrdering` 用单个声明式原语取代以上五种：声明你的 `before`/`after`，注册到协调器，顺序就与加载时机无关地稳定下来——而且出问题时，约束图以 JSON DAG 的形式随时可查。

## API

### `ctx.hooksOrdering` —— `HookOrdering` 服务（waterfall）

| 方法 | 说明 |
| --- | --- |
| `control(hook)` | 在 waterfall 钩子 `hook` 上安装包夹。每个钩子调用一次。返回一个 disposer。若已被控制则抛 `HookControlError`。 |
| `register(hook, phase, entry)` | 往 `'front'` 或 `'back'` 添加一个参与者。返回一个 disposer。若该钩子未被控制、或被列在 `syncReturnHooks` 里（返回值会被调用方同步消费）则抛 `HookControlError`。 |
| `plan(hook, phase)` | 按它们将运行的顺序返回参与者名字——用于测试和诊断。 |
| `dumpDag()` | 以 JSON 字符串返回每个受控钩子的约束 DAG。 |

配置：`ctx.plugin(HookOrdering, { log?: string })`。

### `ctx.serialHooksOrdering` —— `SerialHookOrdering` 服务（serial）

与 `HookOrdering` 表面相同（`control` / `register` / `plan` / `dumpDag`，同样的配置）。其条目的 `run` 可以**返回**一个值：一个 bail 值（除 `null`/`false`/`undefined` 之外的任何值）会短路 serial 派发，并成为它的返回值。

### `HookEntry` / `SerialHookEntry`

| 字段 | 含义 |
| --- | --- |
| `name` | 在同一个 `(hook, phase)` 内唯一。供其他条目的 `before`/`after` 引用。 |
| `before?` | 本条目必须先于的名字。 |
| `after?` | 本条目必须后于的名字。 |
| `run(...payload)` | 以钩子负载调用（waterfall：派发参数，不含 Cordis 末尾的 `next`）。会被 await。serial 的 `run` 可以返回 bail 值。 |

### `topoSort(entries)`（`.../topo-sort`）与 `buildDag(sections)`（`.../dag`）

零依赖的稳定拓扑排序，作为独立导出。并列时保持输入顺序；未知的 `before`/`after` 目标是无操作；出现环时抛 `OrderingCycleError`。`buildDag` 把约束图渲染成普通对象（`{ sections: [{ hook, phase, nodes, edges }] }`）以便 `JSON.stringify`——它从不排序，也永不因环而抛错。

## 语义与限制

- **仅支持 waterfall 与 serial。** waterfall 包夹需要 `next()`；serial 用两个带 bail 语义的协调器。`emit`/`parallel`/`bail` 钩子没有可协调的有序链。
- **受控钩子在没有任何参与者时，返回值不受影响。** Cordis 的 `waterfall` 是*同步*返回最外层监听器的值的，所以当两个阶段都为空时包夹会把整条链直接透传，该钩子的返回类型和以前完全一样。这正是「控制一个钩子是透明的」的原因。
- **一旦钩子有了参与者，它的返回值就变成一个 promise。** 包夹必须 await 它的两个阶段，所以一个调用方**不** await 就直接消费结果的钩子无法承载参与者。dsh 里有两个这样的钩子，它们因此被排除在默认集之外，并且 `register()` 会**拒绝**它们（而不是让返回值悄悄换型）：
  - `llm/stream`——`dsh-llm` 用 `return this.ctx.waterfall(this, 'llm/stream', …)` 派发（不 await），`dsh-session-title-llm` 直接 `for await (const chunk of ctx.llm.stream(options))` 迭代；返回 promise 会让它在 `not async iterable` 上失败。这是个真损失：该钩子有五个互相独立的贡献者，正是本插件存在的理由——但排序它需要 dsh 改为 await 派发，而不是插件侧的绕道。
  - `session-telemetry/record`——`dsh-session-telemetry` 把 waterfall 的返回值直接交给后端，promise 会被当成记录发出去：**静默数据错误，哪里都不报错**。
  
  这两个名字由 `syncReturnHooks` 配置给出，`control()` 仍然允许它们（包夹是透明直通），被拒的是 `register()`：拒绝发生在决策点，且带明确原因。等宿主开始 await 某个钩子后，把 `syncReturnHooks` 覆盖成不含它的集合即可接管。
- **每个钩子一个协调器。** 第二次 `prepend` 会重新引入竞态，所以 `control` 会拒绝重复接管。
- **它只排序它拥有的东西。** 协调器掌控自己的 `front`/`back` 注册表及其内部顺序，并把它们相对原生链放置。它不会在外部监听器**彼此之间**重新排序。
- **waterfall 的 `back` 是精确的；serial 的 `back` 是尽力而为的。** waterfall 的 `back` 通过 `next()` 在整个原生链之后运行。serial 没有 `next()`，所以它的 `back` 协调器在 `control()` 时被追加，并在那时已存在的监听器之后运行——在 `control()` **之后**新增的原生监听器会排在它后面，而任何 bail（原生的或 front 的）都会完全跳过它。
- **未知引用 = 无操作。** 跨厂商的 `after: ['maybe-absent']` 在那个对端未加载时不施加任何约束——跨厂商插件不能假设彼此的存在。
- **环在派发时响亮失败。** 约束冲突会抛 `OrderingCycleError`，并点名被阻塞的条目（同时 `dumpDag()` 仍会把这个环渲染出来供排查）。

## 开发

```sh
pnpm install
pnpm test            # vitest，单元测试 + 真实 cordis 集成测试
pnpm test:coverage   # 逐文件 100% 门槛
pnpm typecheck
pnpm lint
pnpm build           # tsdown -> lib/（ESM + d.ts + sourcemaps）
```

安装会走公共 npm registry（见 `.npmrc`），因为本包发布在那里。

## 许可证

[MIT](./LICENSE)
