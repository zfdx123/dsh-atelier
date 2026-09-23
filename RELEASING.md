# 发布流程

## 版本规则

**7 个插件共用一个版本号**（当前 `1.0.2`），`scripts/release-check.mjs` 会强制这一点
——每个 `packages/*/package.json` 的 `version` 必须**等于** `PLUGIN_VERSION`。
meta 包 `@zfdx123/dsh-atelier` 的 7 个依赖也必须写成 `^<插件版本>`。

改版本时：改所有 `packages/*/package.json` 的 `version`，改 `release-check.mjs` 的
`PLUGIN_VERSION`，再把 meta 包的依赖范围提到同一个版本，然后 `npm run check`。

## 一次性准备

1. **npm 账号开 2FA**（Trusted Publisher 要求）。
2. **建 GitHub 仓库** `zfdx123/dsh-atelier`，打上 topic：`dsh-plugin`、`deepseek-harness`
   —— 官方 `CONTRIBUTING.md` 推荐的社区发现方式就是这个 topic。
3. **每个包配 Trusted Publisher**：npmjs.com → 该包 → Settings → Trusted Publisher →
   填 GitHub 仓库 `zfdx123/dsh-atelier` + 工作流文件名 `release.yml`。

## 首次发布（包在 npm 上还不存在时）

Trusted Publisher 的配置入口在**包自己的设置页**，所以 7 个新包必须先存在一次。

**为什么不能交给 CI 自动做**：registry 明确拒绝非交互发布，除非 token 勾了
"Bypass two-factor authentication" —— 而那正是 npm 2027-01 要移除的能力
（实测报错：`403 … Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages`）。
所以首次发布在**你自己的终端**里做，npm 会交互式问你的 2FA 码，**不需要任何长期 token**：

```sh
node scripts/publish-local.mjs dsh-memery     # 先拿一个试通
node scripts/publish-local.mjs                # 其余全部（含入口包，自动排在最后）
```

脚本按「7 个插件 → 入口包」的顺序发（入口包依赖它们，必须先存在），
任何一个失败就立即停止，不会出现"发了一半"的状态。

> 建议先只发 `dsh-memery`，确认三处都对再批量：
> npm 包页面、`npm view @zfdx123/dsh-memery`、`dsh plugin --profile web add @zfdx123/dsh-memery`。

发完 7 个之后，回到 npmjs.com 给每个包配好 Trusted Publisher（见下），之后就再也不用人工介入。

## 配 Trusted Publisher（8 个包各一次）

包页面 → **Settings → Trusted Publisher → GitHub Actions**：

| 字段 | 填 |
|---|---|
| Publisher | `GitHub Actions` |
| Label | 随意，例如 `dsh-atelier` |
| Organization or user | `zfdx123` |
| Repository | `dsh-atelier` |
| Workflow filename | `release.yml`（**只写文件名**，不带路径） |
| Environment name | **留空** |
| **Allowed actions** | ☐ **不勾 "Allow npm publish"** |

**为什么留空那个勾**：勾上等于允许 CI 直接把版本推进公共 registry；不勾则 CI 只能
`npm stage publish` **暂存**，必须由维护者用 2FA 在网页上批准才真正发布。npm 明确推荐不勾——
这样即使工作流被攻破或混进恶意提交，也发不出去。代价是每次发版点一次批准。

> ⚠️ 页面提示 "Cannot be changed later" 是真的：这些值建好即锁死，要改只能删掉重建。
> 文件名 `release.yml` 一个字母都不能错。

## 日常发布（打 tag → 暂存 → 你批准）

```sh
git tag v1.0.2
git push origin v1.0.2
```

`.github/workflows/release.yml` 会：

1. `verify` 作业：`npm run check` → 逐包安装 → 逐包测试；
2. `publish` 作业（仅在 tag 上）：对每个「registry 上还没有这个版本」的包执行
   **`npm stage publish --access public --provenance`**；
3. **你去 npmjs.com 用 2FA 批准**（暂存区里会列出来）。

已发布的版本会被跳过，所以重复打 tag 或只 bump 一个包都是安全的。
工作流里没有任何长期密钥，暂存与批准都带 provenance 签名。

## 为什么不放 npm token

npm 已公告：**2027 年 1 月起移除 bypass-2FA token 的直接发布能力**
（[GitHub changelog, 2026-09-18](https://github.blog/changelog/2026-09-18-stage-only-npm-tokens-for-safer-automation/)）。
现在建一个"能直接发布"的 granular token 只是在给自己攒一笔到期要还的技术债。

如果哪天真需要 token 兜底，那一页应当这样填：

| 字段 | 值 | 理由 |
|---|---|---|
| Permissions | `Read and write (publish and stage)` | 需要发布权；长期自动化应改用 `stage only` |
| Bypass 2FA | **不勾** | 勾了就是高危长期密钥，且 2027-01 后失效 |
| Select packages | `Only select packages and scopes` → 只勾 `@zfdx123` | 别选 All packages |
| Organizations | 不授权 | 不发到组织 scope |
| Allowed IP ranges | **留空** | GitHub Actions 出口 IP 是动态的，填了就发不出去 |
| Expiration | 最短 | 用完即删 |

## 入口包的 patch 为什么必须显式插入 7 行

启动器的 `reconcile()` 只遍历 **profile 清单的直接依赖**
（`dsh-plugin-manager/lib/index.js:44` 的 `Object.keys(after.dependencies)`）。
装入口包时，7 个插件是它的**传递依赖**，不在那个列表里，所以**不会被自动激活**。

> 实测教训：入口包最初用的是空 patch，结果是「装上了，但 `--dump-config` 里一行都没有」——
> 代码到位、组合树为空。这正是端到端测试（装进一个隔离 profile 再 dump）才能发现的问题，
> `npm view` 和发布日志都看不出来。

所以 `packages/dsh-atelier/cordis.patch.yml` 必须逐行 insert 那 7 个插件，
`release-check` 会强制：缺 patch、patch 文件不存在、或没把 7 个插件全插入 → 直接失败。

**不要同时装入口包和它里面的单个插件**：那样同一个 id 会被插两次。
要全套装入口包，要单个装那个包，二选一。

## 版本规则（补充）

- **7 个插件**共用一个版本号，lockstep。
- **入口包独立升版**：它只承载组合清单，改动"这套里有哪些插件"不该逼你重发 7 个没变的包。
  它的依赖范围必须写成 `^<插件版本>`，`release-check` 会核对。

## 回滚

- **发布前**：`npm run check` 已经是闸门；测试不绿就不打 tag。
- **刚发错**：npm 允许 72 小时内 `npm unpublish <pkg>@<version>`，但会留下同名版本的空洞。
  更稳的做法是立刻发一个 patch 版本修掉，并 `npm deprecate <pkg>@<version> "<原因>"`。
- **包整体撤下**：`npm deprecate` 而不是 unpublish —— 已装的人不会突然装不上。
