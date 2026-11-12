/**
 * Release gate: fail before anything reaches the registry.
 *
 * Checks what npm and DSH actually require of each package, plus the two
 * mistakes this repository is most likely to make: a version that drifted
 * between packages, and a package that quietly lost its attribution.
 *
 * Usage: node scripts/release-check.mjs
 * @module scripts/release-check
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = path.join(root, 'packages')
/** The plugins release in lockstep. */
const PLUGIN_VERSION = '1.0.17'
/**
 * The aggregator versions on its own: it only carries the bundle composition, so
 * changing which plugins are in the set must not force a republish of plugins
 * whose code did not change. Its dependency ranges must still admit the
 * plugins' current version.
 */
const AGGREGATOR = 'dsh-atelier'
const EXCLUDED = new Set(['dsh-opencode-go'])
/**
 * 声明支持的 DSH 运行时，**逐条显式**列出。当前只支持 `0.2.2-rc.2`（1.0.17 起
 * 收窄：`0.1.7-rc.2` / `0.2.0-rc.*` / `0.2.1-alpha.*` / `0.2.1-rc.*` 都不再被接纳）。
 *
 * 严格 semver 对 prerelease 的规则：带 prerelease 的**候选**只能被「元组相同且自带
 * prerelease」的比较器接纳。`^0.2.2-rc.2` 展开成 `>=0.2.2-rc.2 <0.3.0-0`
 * （0.x 的 caret 上界落在下一个 minor），于是它严格收下 `0.2.2-rc.2` /
 * `0.2.2` / `0.2.3`，却**不收** `0.2.3-alpha.1`（元组 0.2.3
 * 没有带 prerelease 的比较器）与 `0.2.1-rc.2`（低于下界）。要同时支持两个元组就得
 * 写 `a || b`，两条 caret 缺一不可。
 *
 * 安装期闸门在 `@deepseek-ai/dsh-app-boot`。`evaluatePluginCompatibility` 在
 * 0.2.1-rc.2 改成**先看 `engines.dsh`——有它就只用它、peer 全部忽略**，0.2.2-rc.2
 * 里该函数**逐字节未变**（实测 8/8 manifest 放行 + 3 条阳性对照被拒）。本仓库每个包
 * 都声明了 `engines.dsh`，所以决定「能不能装」的就是下面这一条 caret。判定本身是
 * `semver.satisfies(v, range, { includePrerelease: true })`，比严格 semver 宽——实测
 * `satisfies('0.2.2-rc.2', '^0.2.1-rc.2', { includePrerelease: true }) === true`
 * （旧范围也认新运行时），严格口径则是 false。「只支持一个运行时」靠的是这里把范围
 * 收窄成**恰好一条该运行时的 caret**，而不是指望闸门替我们挡住；反方向是硬的：
 * `satisfies('0.2.1-rc.2', '^0.2.2-rc.2', { includePrerelease: true }) === false`。
 *
 * 这里不重实现 semver：只强制「每个受支持的运行时都有一条显式 caret」，把范围漂移变成
 * 一次刻意修改。真正的 satisfies 判定由 DSH 自己的闸门与隔离 profile 实装核对负责。
 */
const SUPPORTED_DSH = ['^0.2.2-rc.2']
/**
 * 宿主运行时提供的 cordis 版本范围，**照抄 DSH 自己的声明**。
 *
 * 0.2.2-rc.2 树里每个 `@deepseek-ai/dsh-*` 包都写 `peerDependencies["@deepseek-ai/cordis"]
 * = "~4.1.0"`、`@deepseek-ai/schemastery = "~3.19.0"`（0.2.2-rc.2 时是 ~4.1.0 /
 * ~3.19.0）。这一轮基础包**全部转正**：cordis 4.0.6-alpha.1 → 4.1.0、schemastery
 * 3.19.0 → 3.19.0、cosmokit 1.8.7-alpha.1 → 1.9.0、cordis-plugin-* 同步。
 * 下面这条 `~4.1.0` **必须**跟着写：旧的 `~4.1.0` 展开成 `<4.1.0-0`，数值上恰好把
 * 4.1.0 挡在门外（实测 `satisfies('4.1.0', '~4.1.0') === false`）——写旧了
 * `npm install` 直接 ERESOLVE（本轮刷新依赖时实测踩到）。
 * 我们的插件跑在宿主的 cordis 里，peer 范围因此纯粹是兼容性契约：写宽写窄直接决定能不能装、
 * 以及在哪个版本上被验证过；把它钉成常量，范围漂移由闸门拦下。
 */
const SUPPORTED_CORDIS = '~4.1.0'
/** 把 `a || b` 拆成排序去重后的集合，用于比较。 */
const rangeAlternatives = (range) => [
  ...new Set(
    String(range)
      .split('||')
      .map((part) => part.trim())
      .filter((part) => part !== ''),
  ),
].sort()
const SORTED_SUPPORTED_DSH = [...SUPPORTED_DSH].sort().join(' | ')
/**
 * A lockfile must resolve from the registry these packages publish to.
 *
 * npm records the registry it resolved from as an absolute `resolved` URL, so a
 * machine-wide npmrc pointing at a mirror leaks mirror URLs into the committed
 * lockfile. That is not cosmetic: GitHub Actions refuses to fetch them, and
 * `npm ci` dies with
 *
 *   npm error code EALLOWREMOTE
 *   npm error Refusing to fetch "@standard-schema/spec@https://registry.npmmirror.com/..."
 *
 * which fails the verify job before a single test runs. Each package ships an
 * `.npmrc` pinning the public registry; this check catches a lockfile that was
 * regenerated while that pin was missing.
 */
const MIRROR_URL = /https?:\/\/(?:[a-z0-9-]+\.)*(?:npmmirror\.com|taobao\.org|cnpmjs\.org|mirrors\.[a-z0-9.-]+)\//

const problems = []
const notes = []
const fail = (pkg, message) => problems.push(`${pkg}: ${message}`)

/**
 * Does a `^a.b.c` range admit `A.B.C`? True when the majors match and the range's
 * minor.patch is at or below the version's. Deliberately narrow — the aggregator's
 * ranges are written as carets over the plugins' major, nothing else.
 * @param {string} range a caret range such as `^1.0.0`
 * @param {string} version a concrete version such as `1.0.1`
 * @returns {boolean}
 */
function caretAdmits(range, version) {
  const m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range)
  if (m === null) return false
  const [rangeMajor, rangeMinor, rangePatch] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const [major, minor, patch] = version.split('.').map(Number)
  if (rangeMajor !== major) return false
  return rangeMinor < minor || (rangeMinor === minor && rangePatch <= patch)
}

const dirs = fs
  .readdirSync(packagesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort()

const manifests = new Map()
for (const name of dirs) {
  if (EXCLUDED.has(name)) {
    fail(name, 'is excluded from this repository and must not be present')
    continue
  }
  const dir = path.join(packagesDir, name)
  const pj = path.join(dir, 'package.json')
  if (!fs.existsSync(pj)) {
    fail(name, 'has no package.json')
    continue
  }
  let j
  try {
    j = JSON.parse(fs.readFileSync(pj, 'utf8'))
  } catch (error) {
    fail(name, `package.json is not valid JSON: ${error.message}`)
    continue
  }
  manifests.set(name, { j, dir })

  // npm
  if (j.private === true) fail(name, 'is private — npm publish would refuse it')
  if (name === AGGREGATOR) {
    if (!/^\d+\.\d+\.\d+/.test(j.version ?? '')) fail(name, `version "${j.version}" is not semver`)
  } else if (j.version !== PLUGIN_VERSION) {
    fail(name, `version is ${j.version}, expected ${PLUGIN_VERSION}`)
  }
  if (j.publishConfig?.access !== 'public') fail(name, 'publishConfig.access must be "public" (scoped packages default to restricted)')
  if (j.repository === undefined) fail(name, 'has no repository field (npm shows no source link)')
  if (j.license === undefined) fail(name, 'has no license field')
  if (!fs.existsSync(path.join(dir, 'LICENSE'))) fail(name, 'has no LICENSE file')

  // DSH
  if (j.engines?.dsh === undefined) fail(name, 'has no engines.dsh')
  const peers = Object.keys(j.peerDependencies ?? {})
  if (!peers.includes('@deepseek-ai/cordis')) fail(name, 'does not declare the @deepseek-ai/cordis peer')
  // cordis 由宿主运行时提供，所以我们的范围必须**就是**宿主自己声明的那个（见 SUPPORTED_CORDIS）。
  const cordisRange = j.peerDependencies?.['@deepseek-ai/cordis']
  if (cordisRange !== SUPPORTED_CORDIS) {
    fail(
      name,
      `peerDependencies.@deepseek-ai/cordis is "${cordisRange}" — must be "${SUPPORTED_CORDIS}" ` +
        '(the range the supported DSH runtime itself requires; a stale caret here fails `npm install` with ERESOLVE)',
    )
  }

  // 每个受支持的 DSH 运行时都必须有一条显式的 caret；安装期的 peer 兼容性闸门
  // （dsh-app-boot）会按这条范围决定「能不能装」（见 SUPPORTED_DSH 的说明）。
  const dshRanges = [['engines.dsh', j.engines?.dsh]]
  for (const [dep, range] of Object.entries(j.peerDependencies ?? {})) {
    if (/^@deepseek-ai\/dsh(-|$)/.test(dep)) dshRanges.push([`peerDependencies.${dep}`, range])
  }
  for (const [field, range] of dshRanges) {
    const alternatives = rangeAlternatives(range ?? '')
    if (alternatives.join(' | ') !== SORTED_SUPPORTED_DSH) {
      fail(
        name,
        `${field} is "${range}" — must list every supported DSH runtime explicitly (${SORTED_SUPPORTED_DSH}); ` +
          '一条 caret 收不下不同元组的 prerelease（caret 的 prerelease 上界是 <X.Y.Z-0）',
      )
    }
  }

  // copy
  if (!/[\u4e00-\u9fff]/.test(j.description ?? '')) fail(name, 'description is not Chinese')

  // files[] must actually exist, or npm ships an empty or broken package
  for (const entry of j.files ?? []) {
    if (entry.includes('*')) continue
    if (!fs.existsSync(path.join(dir, entry))) fail(name, `files[] lists "${entry}" but it does not exist`)
  }
  if (j.main !== undefined && !fs.existsSync(path.join(dir, j.main))) fail(name, `main "${j.main}" does not exist`)

  // the entry point a DSH client plugin needs
  const clientExport = j.exports?.['./client']
  if (clientExport !== undefined) {
    const rel = typeof clientExport === 'string' ? clientExport : clientExport.default
    if (!fs.existsSync(path.join(dir, rel))) fail(name, `exports["./client"] points at "${rel}" which does not exist`)
  }

  // The lockfile must resolve from the public registry (see MIRROR_URL).
  for (const lock of ['package-lock.json', 'pnpm-lock.yaml']) {
    const lockPath = path.join(dir, lock)
    if (!fs.existsSync(lockPath)) continue
    const mirror = MIRROR_URL.exec(fs.readFileSync(lockPath, 'utf8'))
    if (mirror !== null) {
      fail(
        name,
        `${lock} resolves through a mirror (${mirror[0]}), which npm ci refuses to fetch in CI — ` +
          'regenerate it with the package\'s .npmrc in place (registry=https://registry.npmjs.org/)',
      )
    }
  }
}

// the meta package must depend on exactly the other packages, at the plugins' version
const meta = manifests.get(AGGREGATOR)
if (meta === undefined) {
  fail(AGGREGATOR, 'the aggregator package is missing')
} else {
  const deps = meta.j.dependencies ?? {}
  // dependency keys are package names (scoped); the map is keyed by directory name
  const bare = (n) => n.slice(n.lastIndexOf('/') + 1)
  const expected = [...manifests.keys()].filter((n) => n !== AGGREGATOR).sort()
  const actual = Object.keys(deps).map(bare).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(AGGREGATOR, `dependencies are ${actual.join(', ')} but the packages are ${expected.join(', ')}`)
  }
  for (const [dep, range] of Object.entries(deps)) {
    // The aggregator's range has to ADMIT the plugins' current version, not equal
    // it: `^1.0.0` covers 1.0.1, so a plugin patch bump must not force a new
    // aggregator release. (It is a caret range over the same major.)
    if (!caretAdmits(range, PLUGIN_VERSION)) {
      fail(AGGREGATOR, `dependency ${dep} is "${range}", which does not admit ${PLUGIN_VERSION}`)
    }
  }
  // Without a patch the launcher reports the aggregator as a plain dependency and
  // NOTHING it pulled in gets activated: reconcile() only walks the profile's own
  // direct dependencies, and the plugins arrive as transitive ones.
  const patch = meta.j.dsh?.bundle?.patch
  if (patch === undefined) {
    fail(AGGREGATOR, 'declares no dsh.bundle.patch — installing it would activate nothing')
  } else if (!fs.existsSync(path.join(meta.dir, patch))) {
    fail(AGGREGATOR, `dsh.bundle.patch "${patch}" does not exist`)
  } else {
    const text = fs.readFileSync(path.join(meta.dir, patch), 'utf8')
    const inserted = [...text.matchAll(/^\s*name:\s*'?(@zfdx123\/[a-z0-9-]+)'?\s*$/gm)].map((m) => m[1])
    const missing = expected.map((n) => `@zfdx123/${n}`).filter((n) => !inserted.includes(n))
    if (missing.length > 0) fail(AGGREGATOR, `its patch does not insert: ${missing.join(', ')}`)
  }
}

// no credentials, ever
const secretish = /(ghp_|npm_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/

/**
 * The one place a private key is allowed: a self-signed certificate for
 * `localhost` (CN=localhost, SAN DNS:localhost + 127.0.0.1) that the TLS test
 * uses as both server key and CA. It authenticates nothing but a local test
 * server, and the test needs it to be deterministic.
 */
const KEY_ALLOWLIST = [path.join('packages', 'dsh-mcp-manager', 'fixtures', 'tls') + path.sep]

for (const name of dirs) {
  for (const file of walk(path.join(packagesDir, name))) {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (!secretish.test(text)) continue
    const rel = path.relative(root, file)
    if (KEY_ALLOWLIST.some((prefix) => rel.startsWith(prefix))) {
      notes.push(`private key allowed by design: ${rel} (localhost self-signed test certificate)`)
      continue
    }
    fail(name, `looks like it contains a credential: ${rel}`)
  }
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '.dsh-memery' || e.name === '.codegraph') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(js|mjs|cjs|ts|tsx|json|yml|yaml|md|pem|key|crt|env)$/.test(e.name)) out.push(p)
  }
  return out
}

for (const n of notes) process.stdout.write(`note: ${n}\n`)
if (problems.length > 0) {
  process.stdout.write(`\nrelease-check FAILED (${problems.length}):\n`)
  for (const p of problems) process.stdout.write(`  - ${p}\n`)
  process.exit(1)
}
process.stdout.write(`\nrelease-check passed: ${manifests.size} packages (plugins ${PLUGIN_VERSION}, aggregator ${meta?.j.version ?? '?'})\n`)
