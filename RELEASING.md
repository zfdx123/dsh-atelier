# 发布流程

## 版本规则

**所有包共用一个版本号**（当前 `1.0.0`），`scripts/release-check.mjs` 会强制这一点。
meta 包 `@zfdx123/dsh-atelier` 的 7 个依赖也必须写成 `^<同一个版本>`。

改版本时：改所有 `packages/*/package.json` 的 `version`，以及 meta 包的依赖范围，然后 `npm run check`。

## 一次性准备

1. **npm 账号开 2FA**（Trusted Publisher 要求）。
2. **建 GitHub 仓库** `zfdx123/dsh-atelier`，打上 topic：`dsh-plugin`、`deepseek-harness`
   —— 官方 `CONTRIBUTING.md` 推荐的社区发现方式就是这个 topic。
3. **每个包配 Trusted Publisher**：npmjs.com → 该包 → Settings → Trusted Publisher →
   填 GitHub 仓库 `zfdx123/dsh-atelier` + 工作流文件名 `release.yml`。

## 首次发布（包在 npm 上还不存在时）

Trusted Publisher 的配置入口在**包自己的设置页**，所以 7 个新包必须先存在一次。
首次发布在**本地**做，不需要造 token：

```sh
npm login                       # 交互式，带 2FA
cd packages/dsh-memery
npm publish --access public     # 一个一个来
```

> **先拿一个包试通**（建议 `dsh-memery`），确认 npm 页面、`npm view`、以及
> `dsh plugin --profile web add @zfdx123/dsh-memery` 三处都对，再批量发其余 6 个。

发完 7 个之后，回到 npmjs.com 给每个包配好 Trusted Publisher，之后就再也不用 token 了。

## 日常发布（打 tag 自动发）

```sh
git tag v1.0.0
git push origin v1.0.0
```

`.github/workflows/release.yml` 会：

1. `verify` 作业：`npm run check` → 逐包安装 → 逐包测试；
2. `publish` 作业（仅在 tag 上）：逐包 `npm publish --access public --provenance`。

发布走 **OIDC（trusted publishing）**，工作流里没有任何长期密钥。

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

## meta 包的 patch 为什么是空的

`packages/dsh-atelier/cordis.patch.yml` 只有一个 `[]`。原因在启动器的 `reconcile()`：
它会把**每一个新装进来、且声明了 `dsh.bundle` 的依赖**逐个加进 profile 的 bundle 列表。
装 meta 包时 7 个插件作为依赖一起进来，各自带自己的 patch，已经各自注册过了；
meta 再插一遍就是每个插件注册两次。空 patch 的唯一作用是让 meta 被当成 bundle 而不是
被报成 "installed as a plain dependency"。

## 回滚

- **发布前**：`npm run check` 已经是闸门；测试不绿就不打 tag。
- **刚发错**：npm 允许 72 小时内 `npm unpublish <pkg>@<version>`，但会留下同名版本的空洞。
  更稳的做法是立刻发一个 patch 版本修掉，并 `npm deprecate <pkg>@<version> "<原因>"`。
- **包整体撤下**：`npm deprecate` 而不是 unpublish —— 已装的人不会突然装不上。
