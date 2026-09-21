/**
 * First publish, run locally.
 *
 * The registry refuses a non-interactive publish unless the token carries
 * "Bypass two-factor authentication" — and npm is retiring that capability in
 * January 2027. So the first release of each new package is done here, in your
 * own terminal, where npm can prompt for the 2FA code. No token is stored.
 *
 * After the first release, configure a Trusted Publisher for each package on
 * npmjs.com and let `.github/workflows/release.yml` publish from a version tag
 * instead (OIDC, no secret). See RELEASING.md.
 *
 * Usage: node scripts/publish-local.mjs [package-name ...]
 * @module scripts/publish-local
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = path.join(root, 'packages')
const AGGREGATOR = 'dsh-atelier'

const all = fs
  .readdirSync(packagesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((n) => fs.existsSync(path.join(packagesDir, n, 'package.json')))
  .sort()

// Plugins first: the aggregator depends on them, so they must exist already.
const order = [...all.filter((n) => n !== AGGREGATOR), AGGREGATOR]

const requested = process.argv.slice(2)
const targets = requested.length > 0 ? order.filter((n) => requested.includes(n)) : order
if (targets.length === 0) {
  console.error(`nothing to publish; known packages: ${all.join(', ')}`)
  process.exit(2)
}

for (const name of targets) {
  const dir = path.join(packagesDir, name)
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  process.stdout.write(`\n=== ${j.name}@${j.version}\n`)
  try {
    // stdio: inherit so npm can prompt for the 2FA code interactively
    execFileSync('npm', ['publish', '--access', 'public', '--registry', 'https://registry.npmjs.org/'], {
      cwd: dir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
  } catch {
    process.stdout.write(`=== ${j.name} failed — stopping so nothing is half-published\n`)
    process.exit(1)
  }
}

process.stdout.write(`\npublished ${targets.length} package(s).\n`)
process.stdout.write('Next: add a Trusted Publisher for each on npmjs.com, then release by tag.\n')
