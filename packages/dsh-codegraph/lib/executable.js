// codegraph executable resolution — package-local first, PATH second.
//
// `@colbymchenry/codegraph` is a declared runtime dependency, so npm/pnpm
// install its `codegraph` shim into a `.bin` directory that is NOT on PATH.
// Where that directory sits depends on the installer:
//   - npm, nested    <package>/node_modules/.bin
//   - npm, hoisted   <profile>/node_modules/.bin
//   - pnpm           <store>/<package@version>/node_modules/.bin
// so the search walks up from this package's root and takes the first hit.
// PATH stays the last resort, which keeps a global install
// (`npm i -g @colbymchenry/codegraph`) working.
//
// `DSH_CODEGRAPH_EXECUTABLE` overrides everything: upstream also ships
// install.sh / a "thin shim", and a locally built CLI lives wherever the user
// put it. It is explicit, so a path that does not exist is an error rather
// than a silent fallback to a different binary.
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The CLI this plugin drives. */
export const EXECUTABLE = 'codegraph'

/** Environment variable that pins one executable explicitly. */
export const EXECUTABLE_ENV = 'DSH_CODEGRAPH_EXECUTABLE'

/**
 * The one message every "cannot run codegraph" path ends with. Tests and the
 * shell fallback match on its wording, so treat it as a (soft) contract.
 */
export function executableHint() {
  return '`codegraph` was not found on PATH. Install it once, e.g. `npm i -g @colbymchenry/codegraph` (or use the official install.sh / npm thin shim), then retry.'
}

function overrideHint(value) {
  return `${EXECUTABLE_ENV} points at \`${value}\`, which does not exist. Fix or unset it, then retry.`
}

/** This package's root (`lib/executable.js` → `<package>/`). */
function defaultPackageRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

/** Candidate `.bin` directories, nearest first (own, then every ancestor's). */
function localBinDirs(packageRoot, limit = 12) {
  const dirs = []
  let current = resolve(packageRoot)
  for (let i = 0; i < limit; i++) {
    dirs.push(join(current, 'node_modules', '.bin'))
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return dirs
}

/**
 * Names a `codegraph` shim can carry in a `.bin` directory. Windows npm/pnpm
 * write `codegraph.cmd` (next to an extension-less sh script that Node cannot
 * execute), so the PATHEXT variants are tried first; POSIX writes one
 * extension-less file.
 */
function executableNames(platform, pathExt) {
  if (platform !== 'win32') return [EXECUTABLE]
  const extensions = String(pathExt || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
  return extensions.map((extension) => EXECUTABLE + extension).concat(EXECUTABLE)
}

/**
 * First `codegraph` shim installed with this package (own `node_modules`, then
 * a hoisted ancestor's), or null. Never consults PATH.
 */
export function findLocalExecutable(options = {}) {
  const {
    packageRoot = defaultPackageRoot(),
    platform = process.platform,
    pathExt = process.env.PATHEXT,
    exists = existsSync,
  } = options
  const names = executableNames(platform, pathExt)
  for (const dir of localBinDirs(packageRoot)) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (exists(candidate)) return candidate
    }
  }
  return null
}

/**
 * Resolve the `codegraph` executable to spawn:
 *   1. `DSH_CODEGRAPH_EXECUTABLE` (must exist),
 *   2. the package-local shim (`findLocalExecutable`),
 *   3. PATH, through the caller's `resolveExecutable` (the DSH subprocess
 *      service),
 * and otherwise throw `executableHint()`.
 */
export async function resolveCodegraphExecutable(options = {}) {
  const { packageRoot, resolveExecutable, env = process.env } = options
  const override = env[EXECUTABLE_ENV]
  if (override) {
    if (!existsSync(override)) throw new Error(overrideHint(override))
    return override
  }
  const local = findLocalExecutable(packageRoot === undefined ? {} : { packageRoot })
  if (local !== null) return local
  if (typeof resolveExecutable === 'function') {
    let fromPath
    try {
      fromPath = await resolveExecutable(EXECUTABLE)
    } catch {
      fromPath = undefined
    }
    if (fromPath) return fromPath
  }
  throw new Error(executableHint())
}
