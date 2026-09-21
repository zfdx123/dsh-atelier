/**
 * Run one command across every package, using each package's own package manager.
 *
 * The packages keep their own lockfiles on purpose: they were developed and are
 * released independently, and forcing them into one workspace lockfile would
 * re-resolve seven dependency trees at once for no release benefit. The root
 * manifest therefore declares no `workspaces`, and this script is the fan-out.
 *
 * Usage: node scripts/run-all.mjs install|test
 * @module scripts/run-all
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const action = process.argv[2]

if (action !== 'install' && action !== 'test') {
  console.error('usage: node scripts/run-all.mjs install|test')
  process.exit(2)
}

const packages = fs
  .readdirSync(path.join(root, 'packages'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .filter((name) => fs.existsSync(path.join(root, 'packages', name, 'package.json')))
  .sort()

/**
 * Packages with nothing to build or test are skipped.
 *
 * The aggregator is the only one: it ships no code, and its dependencies are the
 * sibling packages themselves, which do not exist on the registry until the
 * first release has been published. Installing it here would fail the whole
 * verify job on the very tag that creates them.
 */
function hasOwnWork(dir) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  return typeof j.scripts?.test === 'string'
}

/** Install with the manager this package was locked with. */
function installCommand(dir) {
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return ['pnpm', ['install', '--frozen-lockfile']]
  if (fs.existsSync(path.join(dir, 'package-lock.json'))) return ['npm', ['ci']]
  return ['npm', ['install']]
}

const failures = []
const skipped = []
for (const name of packages) {
  const dir = path.join(root, 'packages', name)
  if (!hasOwnWork(dir)) {
    skipped.push(name)
    continue
  }
  const [cmd, args] = action === 'install' ? installCommand(dir) : ['npm', ['test']]
  process.stdout.write(`\n=== ${name} :: ${cmd} ${args.join(' ')}\n`)
  try {
    execFileSync(cmd, args, { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' })
  } catch (error) {
    failures.push(name)
    process.stdout.write(`=== ${name} FAILED (${error.status ?? 'spawn error'})\n`)
  }
}

const ran = packages.length - skipped.length
if (skipped.length > 0) process.stdout.write(`\nskipped (no test script): ${skipped.join(', ')}\n`)
process.stdout.write(`${ran - failures.length}/${ran} packages passed ${action}\n`)
if (failures.length > 0) {
  process.stdout.write(`failed: ${failures.join(', ')}\n`)
  process.exit(1)
}
