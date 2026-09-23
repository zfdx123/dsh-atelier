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
const PLUGIN_VERSION = '1.0.2'
/**
 * The aggregator versions on its own: it only carries the bundle composition, so
 * changing which plugins are in the set must not force a republish of plugins
 * whose code did not change. Its dependency ranges must still admit the
 * plugins' current version.
 */
const AGGREGATOR = 'dsh-atelier'
const EXCLUDED = new Set(['dsh-opencode-go'])

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
