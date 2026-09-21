// dsh-codegraph runtime compatibility harness
//
// Loads this checkout's actual lib/index.js, mounts stub cordis services
// (tools / systemPrompt / subprocess / shell), calls apply(), and exercises
// every registered tool against the real `codegraph` CLI on a real fixture
// project. It is the repo's answer to one question: does this plugin still
// speak the harness contract it was written for?
//
// Why the stubs look the way they do:
//   - The plugin imports the REAL `defineTool` / `createUserMessage` /
//     `schemastery` from `node_modules` (see devDependencies), so every
//     argument schema, output schema, and message shape here is validated by
//     the same code the DSH host runs.
//   - `resolveExecutable` / `spawn` / `shell.resolve` / `shell.run` mirror the
//     documented `@deepseek-ai/dsh-subprocess` / `@deepseek-ai/dsh-shell`
//     contracts, including the argv-only (never shell-interpreted) spawn and
//     the collected-stdout reader with `readFrom(0).text`.
//
// Runs on Windows and POSIX, and inside a workspace-confined DSH sandbox (which
// denies child-process pipes — capture is file-backed, see `runProcess`).
// Node >= 22.
//
//   node test/run-plugin-test.mjs
//
// Environment overrides:
//   CG_TEST_DIR=<dir>     fixture project location (default .test-fixture/)
//   CG_EXECUTABLE=<path>  explicit codegraph executable
//   CG_KEEP_FIXTURE=1     leave the fixture (and its index) in place
//   CG_PROFILE_NM=<dir>   test an installed profile's copy instead of this
//                         checkout (dir is the profile's node_modules)

import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

// --- test bookkeeping -------------------------------------------------------
let pass = 0
let fail = 0
let skipped = 0
const ok = (label, detail) => {
  pass++
  console.log(`  \u2705 ${label}${detail ? ` \u2014 ${detail}` : ''}`)
}
const bad = (label, detail, error) => {
  fail++
  console.log(`  \u274c ${label}${detail ? ` \u2014 ${detail}` : ''}${error ? `\n     \u21b3 ${error}` : ''}`)
}
const section = (title) => console.log(`\n=== ${title} ===`)

// --- locate the plugin under test -------------------------------------------
// CG_PROFILE_NM points at a profile's `node_modules`; the package is scoped, so
// its entry sits one directory deeper than an unscoped name would.
const PROFILE_PACKAGE = '@zfdx123/dsh-codegraph'
const profileNodeModules = process.env.CG_PROFILE_NM
const pluginRoot = profileNodeModules ? join(profileNodeModules, ...PROFILE_PACKAGE.split('/')) : REPO_ROOT
if (!existsSync(join(pluginRoot, 'lib', 'index.js'))) {
  console.error(`plugin entry not found: ${join(pluginRoot, 'lib', 'index.js')}`)
  console.error(
    profileNodeModules
      ? `CG_PROFILE_NM=${profileNodeModules} does not contain ${PROFILE_PACKAGE}.`
      : 'Run `npm install` in the repo checkout first (devDependencies provide the DSH peer packages).',
  )
  process.exit(1)
}
// A bare Windows drive path (`E:\...`) is not a valid ESM specifier; dynamic
// import needs a file:// URL on every platform.
const plugin = await import(pathToFileURL(join(pluginRoot, 'lib/index.js')).href)
console.log(`plugin under test: ${pluginRoot}`)

// --- cross-platform process execution ---------------------------------------
// Mirrors @deepseek-ai/dsh-subprocess-local's candidate search: bare PATH name
// plus PATHEXT extensions on Windows.
function executableCandidates(command) {
  const extensions =
    process.platform === 'win32' && extname(command) === ''
      ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
      : ['']
  const directories = (process.env.PATH || '').split(delimiter).filter(Boolean)
  return directories.flatMap((directory) => extensions.map((extension) => resolve(directory, command + extension)))
}

function resolveExecutable(command) {
  if (process.env.CG_EXECUTABLE) return process.env.CG_EXECUTABLE
  for (const candidate of executableCandidates(command)) if (existsSync(candidate)) return candidate
  throw new Error(`not found on PATH: ${command}`)
}

// cmd.exe needs its own quoting; only quote when the token would otherwise be
// split or reinterpreted.
function quoteForCmd(value) {
  const text = String(value)
  return /[\s"&|<>^()]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

// Launch one argv and capture both streams.
//
// Stdio is FILE-backed rather than piped on purpose. A DSH sandbox denies a
// child process the named pipe that `stdio: 'pipe'` opens, so a piped harness
// dies with `spawn EPERM` under the very confinement this plugin ships into —
// the harness has to run where the plugin runs. Files carry the same bytes and
// work everywhere, and the contract under test is
// `collected.stdout.readFrom(0).text`, not the transport.
//
// POSIX executes the resolved path directly. Windows cannot exec a .cmd/.bat
// without a terminal, so those go through cmd.exe — the same hop a real Windows
// executor makes.
const CAPTURE_DIR = join(REPO_ROOT, '.test-capture')
let captureSeq = 0

function runProcess(argv, options = {}) {
  const [exe, ...rest] = argv
  mkdirSync(CAPTURE_DIR, { recursive: true })
  const id = `${process.pid}-${captureSeq++}`
  const stdoutPath = join(CAPTURE_DIR, `${id}.out`)
  const stderrPath = join(CAPTURE_DIR, `${id}.err`)
  const stdoutFd = openSync(stdoutPath, 'w+')
  const stderrFd = openSync(stderrPath, 'w+')
  const sweep = () => {
    closeSync(stdoutFd)
    closeSync(stderrFd)
    rmSync(stdoutPath, { force: true })
    rmSync(stderrPath, { force: true })
  }
  const onWindowsShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe)
  const command = onWindowsShim ? process.env.ComSpec || 'cmd.exe' : exe
  const args = onWindowsShim ? ['/d', '/s', '/c', [exe, ...rest].map(quoteForCmd).join(' ')] : rest
  const child = spawn(command, args, { ...options, stdio: ['ignore', stdoutFd, stderrFd] })
  return new Promise((resolvePromise, rejectPromise) => {
    child.on('error', (error) => {
      sweep()
      rejectPromise(error)
    })
    child.on('close', (exitCode) => {
      const stdout = readFileSync(stdoutPath, 'utf8')
      const stderr = readFileSync(stderrPath, 'utf8')
      sweep()
      resolvePromise({ exitCode, stdout, stderr })
    })
  })
}

section('0) environment')
let codegraphExe
try {
  codegraphExe = resolveExecutable('codegraph')
  const probe = await runProcess([codegraphExe, '--version'])
  if (probe.exitCode === 0 && /\d+\.\d+\.\d+/.test(probe.stdout)) {
    ok('codegraph CLI reachable', `${codegraphExe} \u2192 v${probe.stdout.trim()}`)
  } else {
    bad('codegraph --version produced no version', `exit=${probe.exitCode} ${probe.stderr.trim()}`)
  }
} catch (error) {
  bad('codegraph CLI not found on PATH', null, error.message)
  console.log('\nInstall it first: npm i -g @colbymchenry/codegraph')
  process.exit(1)
}

// --- stub cordis services ---------------------------------------------------
// Every CLI invocation the plugin makes is recorded, so a test can assert not
// just on observable output but on whether the CLI was reached at all. That
// matters for the front-load gate: it swallows every failure by design, so
// "never opened the gate" and "opened it and the CLI failed" look IDENTICAL
// from the outside. Only the invocation record tells them apart.
//
// BOTH execution paths must be recorded: the plugin prefers `subprocess` and
// falls back to `shell`, and the harness mounts `shell`. Recording only one of
// them makes the assertion blind — which is exactly how the first version of
// test 8f passed even with the discriminator reverted.
const spawnedArgv = []
const shellCommands = []
const cliInvocations = () => [...spawnedArgv.map((a) => a.join(' ')), ...shellCommands]
const spawnedMatching = (pattern) => cliInvocations().filter((line) => pattern.test(line))

// The real subprocess service hands the plugin collected readers, not strings.
const subprocessService = {
  async resolveExecutable(name) {
    return resolveExecutable(name)
  },
  spawn({ argv, cwd, signal }) {
    spawnedArgv.push(argv)
    const settle = runProcess(argv, {
      cwd: cwd || undefined,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    })
    const collected = { stdout: undefined, stderr: undefined }
    return {
      collected,
      get done() {
        return settle.then((result) => {
          collected.stdout = {
            readFrom: () => ({ text: result.stdout, nextOffset: result.stdout.length, lossy: false }),
          }
          collected.stderr = {
            readFrom: () => ({ text: result.stderr, nextOffset: result.stderr.length, lossy: false }),
          }
          return { exitCode: result.exitCode }
        })
      },
    }
  },
}

// The shell fallback is a different contract: a command string plus a resolved
// spec, and results that are collected outputs directly.
const POSIX_SHELL = ['/bin/sh', '-c']
const shellService = {
  resolve(request) {
    return {
      command: request.command,
      workdir: request.workdir || process.cwd(),
      timeoutMs: request.timeoutMs || 120000,
      stdoutMaxBytes: request.stdoutMaxBytes || 8 * 1024 * 1024,
      signal: request.signal,
    }
  },
  async run(spec) {
    shellCommands.push(spec.command)
    const argv =
      process.platform === 'win32'
        ? [process.env.ComSpec || 'cmd.exe', '/d', '/s', '/c', spec.command]
        : [...POSIX_SHELL, spec.command]
    const result = await runProcess(argv, { cwd: spec.workdir, signal: spec.signal })
    return {
      exitCode: result.exitCode,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: result.stdout, truncated: false },
      stderr: { text: result.stderr, truncated: false },
    }
  },
}

// --- stub context -----------------------------------------------------------
function makeCtx({ withExecutors = true, sectionOrderTable = true } = {}) {
  const tools = []
  const sections = []
  const listeners = []
  const ctx = {
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
    systemPrompt: {
      section(entry) {
        sections.push(entry)
        return () => {}
      },
    },
    on(event, handler) {
      listeners.push({ event, handler })
      return () => {}
    },
    get(name) {
      if (!withExecutors) return undefined
      if (name === 'subprocess') return subprocessService
      if (name === 'shell') return shellService
      return undefined
    },
  }
  if (sectionOrderTable) {
    // The harness's centrally owned section table, as SystemPrompt exposes it.
    const table = {
      HARNESS_IDENTITY: -1000,
      DEPLOYMENT_PERSONA_PREFIX: 0,
      PLAN_POLICY: 500,
      TEAM_POLICY: 600,
      PTC_ONLY: 800,
      FILE_REFERENCE: 900,
      TOOL_BASH: 1000,
      TOOL_PWSH: 1010,
      TOOL_READ: 1100,
      TOOL_WRITE: 1200,
      TOOL_EDIT: 1300,
      TOOL_GLOB: 1400,
      TOOL_GREP: 1500,
    }
    ctx.systemPrompt.getSectionOrder = (name) => table[name]
  }
  return { ctx, tools, sections, listeners, table: sectionOrderTable }
}

function makeExec(cwd) {
  const controller = new AbortController()
  return {
    agent: { session: { header: cwd ? { cwd } : {} } },
    signal: controller.signal,
    abort: () => controller.abort(),
  }
}

function caller(tools) {
  // Tools default their project root to the session cwd
  // (`exec.agent.session.header.cwd`), which is what a real agent supplies.
  return async (name, args, cwd = FIXTURE_DIR) => {
    const tool = tools.find((entry) => entry.name === name)
    if (!tool) throw new Error(`tool not registered: ${name}`)
    const exec = makeExec(cwd)
    try {
      return await tool.execute(args, exec)
    } finally {
      exec.abort()
    }
  }
}

// --- fixture project --------------------------------------------------------
// Both fixtures live under ONE sandbox root so they can be relocated together.
// They must be isolated from the checkout: the plugin's gate walks up to 12
// ancestors looking for `.codegraph/`, so an index at the repo root (which
// using this very plugin creates) silently turns the "unindexed project" case
// into an indexed one — its premise, and therefore the assertion, stops being
// about what it claims to test.
//
// Default is a temp dir rather than `<repo>/.test-fixture` for exactly that
// reason. CG_TEST_DIR / CG_UNINDEXED_DIR still pin explicit locations.
const SANDBOX_DIR = process.env.CG_TEST_DIR
  ? resolve(process.env.CG_TEST_DIR)
  : mkdtempSync(join(tmpdir(), 'dsh-codegraph-test-'))
// Did we mint the sandbox ourselves? Only then may we delete it wholesale.
const OWNED_SANDBOX = !process.env.CG_TEST_DIR
const FIXTURE_DIR = join(SANDBOX_DIR, 'fixture')
// A directory with no `.codegraph/` anywhere at or above it — the precondition
// for the "unindexed project is a silent no-op" gate.
const UNINDEXED_DIR = process.env.CG_UNINDEXED_DIR
  ? resolve(process.env.CG_UNINDEXED_DIR)
  : join(SANDBOX_DIR, 'unindexed')

// Mirrors lib/index.js `findIndexRoot()`: nearest directory at or above `dir`
// that carries a real index. Walks to the filesystem root exactly as the plugin
// does — an artificial depth cap here would disagree with the code under test.
//
// It matches on the same marker the plugin uses (`codegraph.db`), NOT on bare
// `.codegraph` existence. That matters for the premise check below: CodeGraph's
// `~/.codegraph` store is not an index, and testing for existence alone would
// report a shadow that the plugin itself no longer sees — desynchronizing the
// harness from the code it is meant to verify.
function shadowingIndexRoot(dir) {
  let current = resolve(dir)
  for (;;) {
    if (existsSync(join(current, '.codegraph', 'codegraph.db'))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

// The "unindexed project" gate is the ONE case whose validity depends on the
// fixture's ancestor chain, not on the fixture itself: the plugin walks up to
// the filesystem root looking for `.codegraph/`, so ANY `.codegraph` above the
// fixture silently turns the case into an indexed one and the assertion stops
// testing what it names.
//
// It used to live at `<repo>/.test-unindexed`, so it broke permanently the
// moment anyone ran `codegraph init` in the checkout. It now lives in a temp
// sandbox, but on a typical developer machine the premise may STILL be
// unsatisfiable: CodeGraph keeps its store at `~/.codegraph`, and both the
// system temp dir and most checkouts live under the home directory.
//
// An unsatisfiable precondition is an ENVIRONMENT limit, not a failure of the
// code under test — so the gate case is SKIPPED (visibly, with the reason and a
// fix) rather than reported as a red assertion, and the rest of the suite still
// runs. CG_UNINDEXED_DIR overrides the location when you have a path outside
// any `.codegraph` ancestor.
const UNINDEXED_SHADOW = shadowingIndexRoot(UNINDEXED_DIR)

function writeFixture() {
  rmSync(FIXTURE_DIR, { recursive: true, force: true })
  mkdirSync(join(FIXTURE_DIR, 'src'), { recursive: true })
  writeFileSync(
    join(FIXTURE_DIR, 'src', 'math.ts'),
    [
      'export function multiply(a: number, b: number): number {',
      '  return a * b',
      '}',
      '',
      'export function add(a: number, b: number): number {',
      '  return a + b',
      '}',
      '',
      'export function double(n: number): number {',
      '  return multiply(n, 2)',
      '}',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(FIXTURE_DIR, 'src', 'math.test.ts'),
    [
      "import { double } from './math'",
      '',
      'export function testDouble(): number {',
      '  return double(21)',
      '}',
      '',
    ].join('\n'),
  )
}

writeFixture()
mkdirSync(UNINDEXED_DIR, { recursive: true })

// A `.codegraph/` directory that is NOT an index — CodeGraph's own daemon/store
// shape (`daemons/`, `graph.db`, no `codegraph.db`). The gate must not treat
// this as an indexed project just because the directory exists. The workspace
// sits *inside* it, so a bare-existence check would resolve the fake root as
// the index root and try to explore it.
const FAKE_INDEX_ROOT = join(SANDBOX_DIR, 'fake-index-root')
const FAKE_INDEX_WORKSPACE = join(FAKE_INDEX_ROOT, 'workspace')
mkdirSync(join(FAKE_INDEX_ROOT, '.codegraph', 'daemons'), { recursive: true })
writeFileSync(join(FAKE_INDEX_ROOT, '.codegraph', 'graph.db'), 'not a real index\n')
mkdirSync(FAKE_INDEX_WORKSPACE, { recursive: true })

console.log(`fixture project: ${FIXTURE_DIR}`)
console.log(`unindexed fixture: ${UNINDEXED_DIR}`)
console.log(`fake-index fixture: ${FAKE_INDEX_WORKSPACE}`)

// === 1) mount + default (core) surface ======================================
section('1) apply() mounts, default surface "core"')
const core = makeCtx()
try {
  plugin.apply(core.ctx)
  ok('apply(ctx) did not throw')
} catch (error) {
  bad('apply(ctx) threw', null, error.stack || error.message)
  process.exit(1)
}

const coreNames = core.tools.map((tool) => tool.name).sort()
const expectedCore = ['codegraph_explore', 'codegraph_init', 'codegraph_status', 'codegraph_sync']
if (JSON.stringify(coreNames) === JSON.stringify(expectedCore)) {
  ok('core surface registers exactly status/init/sync/explore', coreNames.join(', '))
} else {
  bad('core surface should register exactly 4 tools', `got [${coreNames.join(', ')}]`)
}

// === 2) prompt guidance =====================================================
section('2) systemPrompt guidance is injected ahead of the tool block')
const guide = core.sections.find((entry) => entry.name === 'tool:codegraph')
if (!guide) {
  bad('no "tool:codegraph" systemPrompt section injected')
} else {
  ok('injected section "tool:codegraph"', `order=${guide.order}, text.length=${guide.text.length}`)
  const toolBlock = core.ctx.systemPrompt.getSectionOrder('TOOL_BASH')
  if (
    guide.order < core.ctx.systemPrompt.getSectionOrder('TOOL_READ') &&
    guide.order < core.ctx.systemPrompt.getSectionOrder('TOOL_GREP')
  ) {
    ok(`order ${guide.order} precedes the built-in tool guidance (TOOL_BASH=${toolBlock})`, null)
  } else {
    bad('order must precede the built-in tool sections', `got ${guide.order}`)
  }
  if (guide.order === toolBlock - 1)
    ok('order is derived from the harness section table, not hard-coded', `${toolBlock} - 1`)
  else bad('order should be one slot before TOOL_BASH', `got ${guide.order}, expected ${toolBlock - 1}`)
}

section('2b) guidance text is imperative and names only core-surface tools')
if (guide) {
  if (
    /codegraph_status/.test(guide.text) &&
    /codegraph_explore/.test(guide.text) &&
    /INSTEAD of grep\/glob\/read/.test(guide.text)
  ) {
    ok('guidance says MUST use explore INSTEAD of grep/glob/read, and names status/explore')
  } else {
    bad('guidance text should instruct codegraph_* usage (status/explore, imperative)')
  }
  if (/Anti-patterns/.test(guide.text) && /not indexed/.test(guide.text))
    ok('guidance carries anti-patterns + the unindexed stop rule')
  else bad('guidance should carry anti-patterns and the unindexed stop rule')
  if (!/codegraph_query|codegraph_node|codegraph_callers/.test(guide.text)) ok('guidance names only core-surface tools')
  else bad('guidance should name only core-surface tools (query/node/callers are full-surface)')
}

section('2c) a harness without the central order table still gets a valid order')
{
  const legacy = makeCtx({ sectionOrderTable: false })
  plugin.apply(legacy.ctx)
  const legacyGuide = legacy.sections.find((entry) => entry.name === 'tool:codegraph')
  if (legacyGuide && Number.isFinite(legacyGuide.order) && legacyGuide.order < 100) {
    ok('falls back to the pre-table literal', `order=${legacyGuide.order}`)
  } else {
    bad('expected a finite fallback order < 100', legacyGuide ? `got ${legacyGuide.order}` : 'no section injected')
  }
}

// === 3) config gating =======================================================
section('3) config: guideSearch:false keeps tools, drops the guidance')
{
  const plain = makeCtx()
  plugin.apply(plain.ctx, { guideSearch: false, surface: 'full' })
  if (plain.tools.length === 13) ok('13 tools registered with guideSearch:false')
  else bad('tools should still register with guideSearch:false', `got ${plain.tools.length}`)
  if (plain.sections.some((entry) => entry.name === 'tool:codegraph'))
    bad('guideSearch:false must NOT inject tool:codegraph')
  else ok('guideSearch:false skips the tool:codegraph prompt section')
}

// === 4) full surface ========================================================
section('4) config: surface "full" registers all 13 tools')
const full = makeCtx()
plugin.apply(full.ctx, { surface: 'full' })
const call = caller(full.tools)
const fullNames = full.tools.map((tool) => tool.name).sort()
console.log(`   registered: ${fullNames.join(', ')}`)
if (fullNames.length === 13 && fullNames.every((name) => name.startsWith('codegraph_'))) {
  ok('13 codegraph_* tools registered')
} else {
  bad('expected 13 codegraph_* tools', `got ${fullNames.length}`)
}

// === 5) index lifecycle through the real CLI ================================
section('5) index lifecycle: status (uninitialized) \u2192 init \u2192 status (initialized)')
try {
  const before = JSON.parse(String(await call('codegraph_status', {})))
  if (before.initialized === false)
    ok('codegraph_status reports initialized:false before init', `projectPath=${before.projectPath}`)
  else bad('fresh fixture should report initialized:false', JSON.stringify(before).slice(0, 120))
} catch (error) {
  bad('codegraph_status (uninitialized)', null, error.message)
}

try {
  const output = String(await call('codegraph_init', {}))
  ok('codegraph_init ran', output.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 100))
} catch (error) {
  bad('codegraph_init', null, error.message)
}

try {
  const after = JSON.parse(String(await call('codegraph_status', {})))
  if (after.initialized === true && after.fileCount === 2 && Array.isArray(after.languages)) {
    ok(
      'codegraph_status reports the built index',
      `files=${after.fileCount} nodes=${after.nodeCount} languages=${after.languages.join(',')}`,
    )
  } else {
    bad('index status incomplete after init', JSON.stringify(after).slice(0, 160))
  }
} catch (error) {
  bad('codegraph_status (initialized)', null, error.message)
}

// === 6) query surface =======================================================
section('6) query / node / explore / files / callers / callees / impact / affected')
try {
  const rows = JSON.parse(String(await call('codegraph_query', { search: 'multiply' })))
  const hit = Array.isArray(rows) && rows.find((row) => row.node && row.node.name === 'multiply')
  if (hit)
    ok(
      'codegraph_query finds a symbol',
      `${hit.node.kind} ${hit.node.name}${hit.node.signature} @ ${hit.node.filePath}:${hit.node.startLine}`,
    )
  else bad('codegraph_query returned no "multiply" node', JSON.stringify(rows).slice(0, 160))
} catch (error) {
  bad('codegraph_query', null, error.message)
}

try {
  const source = String(await call('codegraph_node', { name: 'add' }))
  if (/function add/.test(source)) ok('codegraph_node returns symbol source', `len=${source.length}`)
  else bad('codegraph_node output lacks the symbol source', source.slice(0, 120))
} catch (error) {
  bad('codegraph_node', null, error.message)
}

try {
  const source = String(await call('codegraph_node', { name: 'src/math.ts', file: true, offset: 1, limit: 3 }))
  if (/multiply/.test(source)) ok('codegraph_node file mode reads a line range', `len=${source.length}`)
  else bad('codegraph_node file mode returned nothing useful', source.slice(0, 120))
} catch (error) {
  bad('codegraph_node (file mode)', null, error.message)
}

try {
  // The query must name a real symbol: explore ranks against the index, and a
  // generic phrase ("math helpers") legitimately matches nothing in a two-file
  // fixture.
  const explored = String(await call('codegraph_explore', { query: 'multiply call flow', maxFiles: 2 }))
  if (/multiply/.test(explored) && explored.length > 100)
    ok('codegraph_explore returns source + call paths', `len=${explored.length}`)
  else bad('codegraph_explore returned too little', explored.slice(0, 120))
} catch (error) {
  bad('codegraph_explore', null, error.message)
}

try {
  const files = JSON.parse(String(await call('codegraph_files', {})))
  if (Array.isArray(files) && files.some((file) => file.path === 'src/math.ts'))
    ok('codegraph_files lists indexed files', `${files.length} files`)
  else bad('codegraph_files did not list the fixture', JSON.stringify(files).slice(0, 160))
} catch (error) {
  bad('codegraph_files', null, error.message)
}

try {
  const result = JSON.parse(String(await call('codegraph_callers', { symbol: 'double', limit: 10 })))
  const names = (result.callers || []).map((entry) => entry.name)
  if (names.includes('testDouble')) ok('codegraph_callers finds the calling symbol', `callers=${names.join(',')}`)
  else bad('codegraph_callers missed testDouble', JSON.stringify(result).slice(0, 160))
} catch (error) {
  bad('codegraph_callers', null, error.message)
}

try {
  const result = JSON.parse(String(await call('codegraph_callees', { symbol: 'double', limit: 10 })))
  const names = (result.callees || []).map((entry) => entry.name)
  if (names.includes('multiply')) ok('codegraph_callees finds the called symbol', `callees=${names.join(',')}`)
  else bad('codegraph_callees missed multiply', JSON.stringify(result).slice(0, 160))
} catch (error) {
  bad('codegraph_callees', null, error.message)
}

try {
  const result = JSON.parse(String(await call('codegraph_impact', { symbol: 'multiply', depth: 2 })))
  const serialized = JSON.stringify(result)
  if (serialized.includes('double') || serialized.includes('testDouble')) ok('codegraph_impact reports dependents')
  else bad('codegraph_impact reported no dependents', serialized.slice(0, 160))
} catch (error) {
  bad('codegraph_impact', null, error.message)
}

try {
  const result = JSON.parse(String(await call('codegraph_affected', { files: ['src/math.ts'] })))
  if (Array.isArray(result.affectedTests) && result.affectedTests.includes('src/math.test.ts')) {
    ok('codegraph_affected maps a source change to its test', `tests=${result.affectedTests.join(',')}`)
  } else {
    bad('codegraph_affected missed src/math.test.ts', JSON.stringify(result).slice(0, 160))
  }
} catch (error) {
  bad('codegraph_affected', null, error.message)
}

try {
  const output = String(await call('codegraph_sync', {}))
  ok(
    'codegraph_sync ran',
    (output || '(no output)').split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 80) || '(quiet)',
  )
} catch (error) {
  bad('codegraph_sync', null, error.message)
}

section('6b) explicit `path` argument overrides the session cwd')
try {
  const status = JSON.parse(String(await call('codegraph_status', { path: FIXTURE_DIR }, UNINDEXED_DIR)))
  if (status.initialized === true && resolve(status.projectPath) === FIXTURE_DIR)
    ok('path argument wins over the session cwd')
  else bad('path argument was not honored', JSON.stringify(status).slice(0, 160))
} catch (error) {
  bad('codegraph_status with explicit path', null, error.message)
}

// === 7) error paths =========================================================
section('7) error paths')
try {
  const tool = full.tools.find((entry) => entry.name === 'codegraph_status')
  await tool.execute({}, { agent: { session: { header: {} } }, signal: new AbortController().signal })
  bad('expected a throw when neither cwd nor path is available')
} catch (error) {
  if (/no session workspace/.test(error.message)) ok('throws a clear error without cwd and path')
  else bad('unexpected error text', null, error.message)
}

section('7b) no executor mounted: apply() must not throw (lazy resolution)')
{
  const bare = makeCtx({ withExecutors: false })
  try {
    plugin.apply(bare.ctx, { surface: 'full' })
    ok('apply() mounts without any executor service (boot-order safe)')
  } catch (error) {
    bad('apply() must not throw when executors are missing', null, error.message)
  }
  const tool = bare.tools.find((entry) => entry.name === 'codegraph_status')
  if (!tool) {
    bad('codegraph_status should still register without executors')
  } else {
    try {
      await tool.execute({}, makeExec(FIXTURE_DIR))
      bad('execute should throw the executor hint when no executor is mounted')
    } catch (error) {
      if (/subprocess|shell/.test(error.message)) ok('execute throws the executor hint', error.message.slice(0, 70))
      else bad('execute threw an unexpected error', null, error.message)
    }
  }
}

// === 7c) a process with NO exit code is not an exit-code failure ============
section('7c) killed / timed-out runs report the real cause, never "exited null"')
{
  // `SubprocessOutcome.exitCode` is `number | null`: null means the child died
  // from a signal, and `signal` carries which one (dsh-subprocess
  // types.d.ts:107-112). `ShellRunResult.exitCode` is nullable for the same
  // reason plus the executor's own timeout and the caller's abort, with the
  // first cause classified in `timedOut` / `aborted` and `signal` left null for
  // a preparation expiry (dsh-shell types.d.ts:106-132). Neither case HAS an
  // exit code, so the plugin must classify the cause instead of printing one.
  //
  // The outcomes below are the documented service shapes, not invented ones;
  // the assertion is on the message the tool actually throws, which is what the
  // model reads.
  const reader = (text) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })

  function toolFor(services) {
    const tools = []
    const ctx = {
      tools: {
        register(tool) {
          tools.push(tool)
          return () => {}
        },
      },
      systemPrompt: {
        section() {
          return () => {}
        },
      },
      on() {
        return () => {}
      },
      get(name) {
        return services[name]
      },
    }
    plugin.apply(ctx, { guideSearch: false })
    return tools.find((entry) => entry.name === 'codegraph_status')
  }

  async function messageFrom(tool) {
    try {
      await tool.execute({}, makeExec(FIXTURE_DIR))
      return null
    } catch (error) {
      return error.message
    }
  }

  const subprocessOutcome = (outcome, streams = {}) => ({
    subprocess: {
      async resolveExecutable() {
        return process.execPath
      },
      spawn() {
        return {
          collected: { stdout: reader(streams.stdout || ''), stderr: reader(streams.stderr || '') },
          done: Promise.resolve(outcome),
        }
      },
    },
  })
  const shellResult = (result) => ({
    shell: {
      resolve: (request) => ({ ...request }),
      async run() {
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          timeoutMs: 120000,
          stdout: { text: '' },
          stderr: { text: '' },
          ...result,
        }
      },
    },
  })

  const cases = [
    ['subprocess: killed by a signal', subprocessOutcome({ exitCode: null, signal: 'SIGKILL' }), /killed by SIGKILL/],
    [
      'shell: executor timeout (preparation expiry)',
      shellResult({ exitCode: null, timedOut: true, timeoutMs: 120000 }),
      /timed out after 120000ms/,
    ],
    ['shell: caller abort', shellResult({ exitCode: null, aborted: true }), /cancelled/],
  ]
  for (const [label, services, pattern] of cases) {
    const message = await messageFrom(toolFor(services))
    if (message === null) bad(`${label}: expected a thrown error`)
    else if (/exited\s+null/.test(message)) bad(`${label}: must not report a null exit code as an exit`, message)
    else if (pattern.test(message)) ok(`${label} \u2192 ${message.slice(0, 90)}`)
    else bad(`${label}: message does not name the cause`, message)
  }

  // Regression guard: a real non-zero exit keeps reporting the code + detail —
  // the null-exit path must not have swallowed the ordinary failure path.
  const nonzero = await messageFrom(toolFor(subprocessOutcome({ exitCode: 3, signal: null }, { stderr: 'boom' })))
  if (nonzero && /exited 3/.test(nonzero) && /boom/.test(nonzero)) {
    ok('non-zero exit still reports "exited <code>" + stderr detail')
  } else {
    bad('non-zero exit message regressed', nonzero === null ? 'did not throw' : nonzero)
  }

  // Shell exit 127 keeps its dedicated "not installed" hint.
  const missing = await messageFrom(toolFor(shellResult({ exitCode: 127 })))
  if (missing && /not found on PATH/.test(missing)) ok('shell exit 127 still maps to the install hint')
  else bad('exit 127 lost its install hint', missing === null ? 'did not throw' : missing)
}

// === 8) prompt front-load ===================================================
section('8) front-load listener registration')
const frontloadHandlers = core.listeners.filter((entry) => entry.event === 'agent/inbox/inserted')
if (frontloadHandlers.length === 1) ok('one agent/inbox/inserted listener registered (frontload defaults to true)')
else bad('expected exactly 1 frontload listener', `got ${frontloadHandlers.length}`)

function makeAgent(cwd, promptText, id, source) {
  const message = {
    id,
    role: 'user',
    content: [{ type: 'text', text: promptText }],
    source: source || { kind: 'user' },
  }
  const steered = []
  const agent = {
    // A distinct agent id per case is load-bearing, not decoration: the plugin
    // dedups injections by (agentId, prompt text) for 10 minutes, and several
    // cases below legitimately reuse the same prompt string. Without an id,
    // every agent collapses to the key '' and any case sharing a prompt with an
    // earlier one is deduped away before the gate is ever consulted — a test
    // that then passes no matter what the gate does.
    id: `agent-${id}`,
    session: { header: { cwd } },
    inbox: { nextTurn: [message] },
    steer(entry) {
      steered.push(entry)
    },
  }
  return { agent, message, steered }
}

section('8b) structural prompt on an indexed project \u2192 plugin-sourced context')
{
  const { agent, message, steered } = makeAgent(
    FIXTURE_DIR,
    'multiply \u7684\u8c03\u7528\u6d41\u7a0b\u662f\u600e\u6837\u7684\uff1f\u8c01\u4f1a\u8c03\u7528\u5b83\uff1f',
    'fl-1',
  )
  // The listener is fire-and-forget: it awaits an `explore` subprocess, so poll
  // for the steering instead of assuming it settled with the emit.
  const deadline = Date.now() + 90000
  for (const handler of frontloadHandlers) handler.handler({ agent, message })
  while (steered.length === 0 && Date.now() < deadline)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  if (steered.length === 0) {
    bad('front-load did not steer anything for a structural prompt on an indexed project')
  } else {
    const entry = steered[0]
    const text = (entry.content || []).map((block) => block.text || '').join('\n')
    if (text.includes('<codegraph_context') && /multiply/.test(text)) {
      ok('steered <codegraph_context> carrying explore output', `len=${text.length}`)
    } else {
      bad('steered message is missing <codegraph_context> or the explore content', text.slice(0, 120))
    }
    if (entry.role === 'user' && entry.id) ok('steered message is a valid user-role message (id + role)')
    else bad('steered message malformed')
    // The load-bearing assertion: machine-injected context must declare a
    // plugin source, not forge a user prompt.
    const source = entry.source || {}
    if (source.kind === 'plugin' && source.plugin === 'dsh-codegraph') {
      ok('steered context declares source kind "plugin"', `plugin=${source.plugin}`)
    } else {
      bad('steered context must not forge a user source', `got source.kind=${JSON.stringify(source.kind)}`)
    }
    if (source.form === 'notice' && typeof source.summary === 'string' && source.summary.length > 0) {
      ok('steered context carries the notice form + summary', source.summary.slice(0, 60))
    } else {
      bad('plugin-sourced context should declare form:"notice" with a summary', JSON.stringify(source))
    }
  }
}

section('8c) the same prompt re-sent within the dedup window \u2192 no second injection')
{
  // The plugin's guarantee is per (agent, prompt text): one agent re-sending the
  // same prompt inside the 10-minute window must not inject twice. That is what
  // this drives — one agent, the SAME prompt delivered twice as two distinct
  // message ids, which is how a GUI re-send or a re-parked step actually looks.
  //
  // It previously fired a single fresh agent and asserted no injection, which
  // passed only because every stub agent shared the id '' and an earlier case
  // had already claimed ('', this prompt). That is a dedup keyed on a harness
  // artifact, not on the plugin's contract.
  const promptText =
    'multiply \u7684\u8c03\u7528\u6d41\u7a0b\u662f\u600e\u6837\u7684\uff1f\u8c01\u4f1a\u8c03\u7528\u5b83\uff1f'
  const first = makeAgent(FIXTURE_DIR, promptText, 'fl-1b')
  for (const handler of frontloadHandlers) handler.handler({ agent: first.agent, message: first.message })
  // Wait for the first injection to land before re-sending.
  const deadline = Date.now() + 90000
  while (first.steered.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250))
  if (first.steered.length !== 1) {
    bad('the first delivery of the prompt should inject exactly once', `got ${first.steered.length}`)
  } else {
    ok('first delivery injects once')
  }

  // Re-send the SAME text to the SAME agent under a new message id.
  const resend = {
    id: 'fl-1b-again',
    role: 'user',
    content: [{ type: 'text', text: promptText }],
    source: { kind: 'user' },
  }
  first.agent.inbox.nextTurn = [resend]
  for (const handler of frontloadHandlers) handler.handler({ agent: first.agent, message: resend })
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 6000))
  if (first.steered.length === 1) ok('identical prompt inside the 10min window is deduped')
  else bad(`re-sent prompt produced a duplicate injection (total ${first.steered.length})`)
}

section('8d) gates: non-structural, unindexed, own output, non-user sources')
{
  const cases = [
    ['non-structural prose', makeAgent(FIXTURE_DIR, 'fix this typo please', 'fl-2')],
    [
      'own injected output',
      makeAgent(FIXTURE_DIR, '<codegraph_context>\u2026prior injection\u2026</codegraph_context>', 'fl-4'),
    ],
    [
      'plugin-sourced prompt',
      makeAgent(FIXTURE_DIR, 'multiply \u7684\u8c03\u7528\u6d41\u7a0b\u662f\u600e\u6837\u7684\uff1f', 'fl-5', {
        kind: 'plugin',
        plugin: 'other-plugin',
      }),
    ],
  ]
  // The unindexed case is only meaningful when no `.codegraph` shadows the
  // fixture. When one does, SKIP it visibly — an environment limit must not be
  // reported as a failure of the code under test, and must not hide the fact
  // that this gate went unexercised.
  if (UNINDEXED_SHADOW) {
    skipped++
    console.log(`  \u23ed\ufe0f  skipped "unindexed project" gate — a .codegraph dir shadows the fixture`)
    console.log(`      fixture: ${UNINDEXED_DIR}`)
    console.log(`      shadow:  ${UNINDEXED_SHADOW}\\.codegraph`)
    console.log('      The plugin resolves the index root by walking UP until it finds')
    console.log('      .codegraph/, so this fixture can never present as unindexed.')
    console.log('      Cover it by pointing CG_UNINDEXED_DIR outside any .codegraph ancestor.')
  } else {
    cases.push([
      'unindexed project',
      makeAgent(UNINDEXED_DIR, 'multiply \u7684\u8c03\u7528\u6d41\u7a0b\u662f\u600e\u6837\u7684\uff1f', 'fl-3'),
    ])
  }
  for (const [label, { agent, message, steered }] of cases) {
    for (const handler of frontloadHandlers) handler.handler({ agent, message })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 3000))
    if (steered.length === 0) ok(`${label} \u2192 silent no-op`)
    else bad(`${label} must not front-load`, steered[0].content[0].text.slice(0, 80))
  }
}

section('8e) config: frontload:false registers no listener')
{
  const quiet = makeCtx()
  plugin.apply(quiet.ctx, { frontload: false })
  if (!quiet.listeners.some((entry) => entry.event === 'agent/inbox/inserted'))
    ok('frontload:false skips the inbox listener')
  else bad('frontload:false must NOT register the inbox listener')
}

section('8f) a .codegraph directory that is NOT an index is not an index root')
{
  // Regression: the gate used to test for the mere EXISTENCE of `.codegraph/`.
  // CodeGraph keeps its own daemon/telemetry store at `~/.codegraph` (holding
  // `daemons/`, `graph.db`, and no `codegraph.db`), and `codegraph_status`
  // reports initialized:false for it — so existence alone marked the home
  // directory as an indexed project, and the gate fired an `explore` that could
  // never succeed. `FAKE_INDEX_ROOT` reproduces that shape, with the workspace
  // nested inside it so a bare-existence check resolves the fake root.
  //
  // The assertion is on the SPAWN RECORD, not on the steered output: the gate
  // swallows explore failures by design, so a fake index that opens the gate and
  // then fails produces byte-identical output to never opening it. Asserting on
  // the output alone would pass even with the marker check removed — verified by
  // reverting the fix, which is exactly why this test counts invocations.
  spawnedArgv.length = 0
  shellCommands.length = 0
  const probe = makeAgent(
    FAKE_INDEX_WORKSPACE,
    'multiply \u7684\u8c03\u7528\u6d41\u7a0b\u662f\u600e\u6837\u7684\uff1f\u8c01\u4f1a\u8c03\u7528\u5b83\uff1f',
    'fl-fake',
  )
  for (const handler of frontloadHandlers) handler.handler({ agent: probe.agent, message: probe.message })
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 3000))

  const bogusCalls = spawnedMatching(/fake-index-root/)
  if (bogusCalls.length === 0) {
    ok('fake .codegraph (no codegraph.db) \u2192 gate stays closed, no CLI call made')
  } else {
    bad(
      'a .codegraph dir without an index must NOT gate the front-load open',
      `made ${bogusCalls.length} CLI call(s) against the fake root: ${bogusCalls[0].slice(0, 120)}`,
    )
  }
  if (probe.steered.length === 0) ok('...and nothing was steered')
  else bad('a fake index root must not produce an injection', probe.steered[0].content[0].text.slice(0, 80))
}

// --- cleanup ----------------------------------------------------------------
rmSync(UNINDEXED_DIR, { recursive: true, force: true })
rmSync(CAPTURE_DIR, { recursive: true, force: true })
if (process.env.CG_KEEP_FIXTURE) {
  console.log(`\nfixture kept at ${FIXTURE_DIR} (CG_KEEP_FIXTURE=1)`)
} else {
  rmSync(FIXTURE_DIR, { recursive: true, force: true })
  // Drop the temp sandbox too, but ONLY when we minted it — never delete a
  // caller-supplied CG_TEST_DIR / CG_UNINDEXED_DIR.
  if (OWNED_SANDBOX && !process.env.CG_UNINDEXED_DIR) {
    rmSync(SANDBOX_DIR, { recursive: true, force: true })
  }
}

console.log(`\n========== ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''} ==========\n`)
process.exit(fail === 0 ? 0 : 1)
