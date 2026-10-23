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
// On Windows npm/pnpm write `codegraph.cmd` (next to an extension-less sh
// script that Node cannot execute). A `.cmd` is NOT directly spawnable: Node
// >= 18.20 refuses `.cmd`/`.bat` without a shell (`spawn EINVAL`, the
// CVE-2024-27980 hardening), and the DSH subprocess service spawns argv
// directly. `buildLaunchArgv` expands such a shim into the program and entry
// script it would have run (`node <entry.js>`), which is spawnable as-is and
// needs no cmd.exe hop or re-quoting. The expansion is read-only; a shim whose
// entry cannot be determined is reported by name instead of failing with a
// bare EINVAL.
//
// `DSH_CODEGRAPH_EXECUTABLE` overrides everything: upstream also ships
// install.sh / a "thin shim", and a locally built CLI lives wherever the user
// put it. It is explicit, so a path that does not exist is an error rather
// than a silent fallback to a different binary.
import { existsSync, readFileSync } from 'node:fs'
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

// ---- Windows launcher shims ------------------------------------------------

const WINDOWS_SHIM_RE = /\.(?:cmd|bat)$/i

/** Is this path a Windows `.cmd`/`.bat` launcher that must be expanded? */
export function isWindowsShim(file) {
  return WINDOWS_SHIM_RE.test(String(file))
}

/**
 * Expand a Windows `.cmd`/`.bat` launcher into the program and entry script it
 * runs, without executing anything.
 *
 * npm/pnpm generate a single-line launcher that forwards its arguments with
 * `%*`; the shape is stable:
 *
 *     ... & "%_prog%"  "%dp0%\..\@colbymchenry\codegraph\npm-shim.js" %*
 *
 * (the platform bundle's own `bin/codegraph.cmd` instead names
 * `%~dp0..\node.exe` and passes flags). The last existing `.js`/`.cjs`/`.mjs`
 * token before `%*` is the entry script; the nearest earlier `%_prog%` token
 * maps to THIS process's Node, and a literal `.exe` token is used as-is.
 *
 * @param {string} shimPath
 * @param {{ execPath?: string, read?: typeof readFileSync, exists?: typeof existsSync }} [options]
 * @returns {{ command: string, args: string[] } | null} argv prefix (`args`
 *   already includes the entry script), or null when the shape is unknown.
 */
export function expandWindowsShim(shimPath, options = {}) {
  const { execPath = process.execPath, read = readFileSync, exists = existsSync } = options
  if (!isWindowsShim(shimPath)) return null
  try {
    const dir = dirname(shimPath)
    const slashDir = dir.endsWith('\\') ? dir : dir + '\\'
    const text = read(shimPath, 'utf8')
    const line = text.split(/\r?\n/).find((candidate) => candidate.includes('%*'))
    if (line === undefined) return null

    // One token, with npm's decorations (`@` prefix, surrounding quotes) and
    // the `%~dp0`/`%dp0%` "directory of this shim" variables resolved.
    const expandToken = (raw) => {
      let token = String(raw).trim()
      if (token.startsWith('@')) token = token.slice(1)
      if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) token = token.slice(1, -1)
      return token.replace(/%~dp0/gi, slashDir).replace(/%dp0%/gi, slashDir)
    }

    const tokens = line.match(/"[^"]*"|\S+/g) || []
    const star = tokens.indexOf('%*')
    const limit = star === -1 ? tokens.length : star

    // Entry script: the LAST existing JS token before `%*` (a launcher may
    // mention helper scripts earlier on the same line).
    let entryIndex = -1
    for (let i = 0; i < limit; i++) {
      const token = expandToken(tokens[i])
      if (!/\.(?:js|cjs|mjs)$/i.test(token)) continue
      if (exists(resolve(dir, token))) entryIndex = i
    }
    if (entryIndex === -1) return null

    // Program: search back from the entry for `%_prog%` (this Node) or a
    // literal `.exe` that exists; keep the flags between it and the entry.
    let command = execPath
    let programIndex = -1
    for (let i = entryIndex - 1; i >= 0; i--) {
      const token = expandToken(tokens[i])
      if (/^%_prog%$/i.test(token) || /^node(?:\.exe)?$/i.test(token)) {
        command = execPath
        programIndex = i
        break
      }
      if (/\.exe$/i.test(token)) {
        const candidate = resolve(dir, token)
        if (exists(candidate)) {
          command = candidate
          programIndex = i
          break
        }
      }
    }

    const flags =
      programIndex === -1
        ? []
        : tokens
            .slice(programIndex + 1, entryIndex)
            .map(expandToken)
            .filter((token) => token.startsWith('-'))
    return { command, args: flags.concat([resolve(dir, expandToken(tokens[entryIndex]))]) }
  } catch {
    return null
  }
}

/**
 * The npm shim's entry script, derived from the `.bin` directory without
 * parsing the shim text. Covers a launcher whose shape `expandWindowsShim`
 * does not recognize (a custom wrapper, a rewritten shim): the dependency's
 * own `npm-shim.js` is still the canonical entry and is spawnable via Node.
 */
function knownNpmShim(shimPath, options) {
  const { exists = existsSync } = options
  let dir = dirname(shimPath)
  for (let i = 0; i < 6; i++) {
    const candidates = [
      join(dir, '..', '@colbymchenry', 'codegraph', 'npm-shim.js'),
      join(dir, 'node_modules', '@colbymchenry', 'codegraph', 'npm-shim.js'),
    ]
    for (const candidate of candidates) {
      const absolute = resolve(candidate)
      if (exists(absolute)) return absolute
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Full argv for one CLI invocation, ready for the DSH subprocess service.
 *
 * Non-Windows (or a non-shim executable): `[executable, ...args]`.
 * Windows `.cmd`/`.bat`: the expanded program/entry (or the dependency's own
 * npm shim) followed by `args`. When neither expansion applies the install is
 * broken and the error names the shim instead of surfacing `spawn EINVAL`.
 *
 * @param {string} executable
 * @param {string[]} args
 * @param {{ platform?: string, execPath?: string, read?: typeof readFileSync, exists?: typeof existsSync }} [options]
 * @returns {string[]}
 */
export function buildLaunchArgv(executable, args, options = {}) {
  const { platform = process.platform } = options
  if (platform !== 'win32' || !isWindowsShim(executable)) return [executable, ...args]

  const expanded = expandWindowsShim(executable, options)
  if (expanded !== null) return [expanded.command, ...expanded.args, ...args]

  const npmShim = knownNpmShim(executable, options)
  if (npmShim !== null) return [options.execPath || process.execPath, npmShim, ...args]

  throw new Error(
    `cannot launch the Windows .cmd/.bat shim \`${executable}\`: its entry script could not be determined. ` +
      'Install @colbymchenry/codegraph normally (`npm i @colbymchenry/codegraph`), ' +
      'or point DSH_CODEGRAPH_EXECUTABLE at a directly executable codegraph.',
  )
}
