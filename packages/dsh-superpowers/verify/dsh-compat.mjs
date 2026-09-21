#!/usr/bin/env node
/**
 * Compatibility probe: does this plugin's code still satisfy the contracts of
 * the *installed* DeepSeek Harness, using the real DSH service classes rather
 * than hand-written stubs?
 *
 * It is deliberately read-only: it never boots a profile, never writes
 * `$DSH_HOME/profiles/<name>/cordis.yml`, and never touches the network. Every
 * check resolves the same modules the running dsh installation resolves.
 *
 * Usage:
 *   node verify/dsh-compat.mjs [path/to/dsh/package.json]
 *
 * Exit code 0 = every check passed; 1 = at least one contract drifted.
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_PACKAGE = resolvePath(
  process.argv[2] ?? 'D:/Development_dependency/npm_prefix/node_modules/@deepseek-ai/dsh/package.json',
)

/** Resolve a package the way the running dsh resolves it, then import it. */
const dshRequire = createRequire(DSH_PACKAGE)
const load = (specifier) => import(pathToFileURL(dshRequire.resolve(specifier)).href)

const results = []
let failed = 0

/**
 * Record one contract check.
 * @param label - what compatibility property is being asserted.
 * @param ok - whether it held.
 * @param detail - evidence printed beside the verdict.
 */
function check(label, ok, detail = '') {
  results.push({ label, ok, detail })
  if (!ok) failed += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `\n        ${detail}`}\n`)
}

const dshManifest = JSON.parse(readFileSync(DSH_PACKAGE, 'utf8'))
const pluginManifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'))

process.stdout.write(`\ndsh-superpowers compatibility probe\n`)
process.stdout.write(`  plugin      ${pluginManifest.name}@${pluginManifest.version}\n`)
process.stdout.write(`  dsh         ${dshManifest.name}@${dshManifest.version}  (${DSH_PACKAGE})\n`)
process.stdout.write(`  node        ${process.version}\n\n`)

// --- 1. Plugin module shape (what the cordis loader consumes) ---------------
const plugin = await import(pathToFileURL(join(PLUGIN_ROOT, 'index.js')).href)

check(
  'index.js exports the cordis plugin surface (name + inject + apply)',
  typeof plugin.name === 'string' && Array.isArray(plugin.inject) && typeof plugin.apply === 'function',
  `name=${JSON.stringify(plugin.name)} inject=${JSON.stringify(plugin.inject)} apply=${typeof plugin.apply}`,
)

check(
  'the exported Config is a standard schema cordis can validate',
  typeof plugin.Config?.['~standard']?.validate === 'function' &&
    plugin.Config['~standard'].validate({ order: 'first' }).issues?.length === 1 &&
    plugin.Config({}).order === 50,
  `invalid order -> ${JSON.stringify(plugin.Config['~standard'].validate({ order: 'first' }).issues?.[0]?.message)}; defaults -> ${JSON.stringify(plugin.Config({}))}`,
)

// --- 2. Real DSH services, mounted on a real cordis context -----------------
const { Context } = await load('@deepseek-ai/cordis')
const { SkillRegistry } = await load('@deepseek-ai/dsh-skill')
const systemPromptModule = await load('@deepseek-ai/dsh-system-prompt')
const { SystemPrompt, renderPrompt } = systemPromptModule

const ctx = new Context()

check(
  'cordis exposes ctx.logger.warn for plugin diagnostics',
  typeof ctx.logger?.warn === 'function',
  typeof ctx.logger?.warn === 'function' ? 'provided by the runtime' : 'plugin calls ctx.logger.warn on damaged input',
)
if (typeof ctx.logger?.warn !== 'function') ctx.logger = { warn() {} }

new SkillRegistry(ctx)
new SystemPrompt(ctx, { includeHarnessIdentity: false })

const everyInjectedServiceExists = plugin.inject.every((service) => ctx.get(service) !== undefined)
check(
  'every name in `inject` resolves to a real service in this dsh',
  everyInjectedServiceExists,
  plugin.inject.map((service) => `${service}=${ctx.get(service) === undefined ? 'MISSING' : 'ok'}`).join(' '),
)

// --- 3. Apply the plugin exactly as the loader does -------------------------
plugin.apply(ctx)

const registered = await ctx.skills.list()
const bundled = registered.filter((skill) => skill.source === 'bundled')

check(
  'ctx.skills.register() accepted every bundled skill (no throw, no skip)',
  bundled.length === 14,
  `${bundled.length} skills registered with source "bundled"`,
)

const definition = await ctx.skills.get('brainstorming')
check(
  'ctx.skills.get() returns body + resource base for a runtime-registered skill',
  definition !== undefined && definition.content.length > 0 && definition.resourceBase?.kind === 'directory',
  definition === undefined
    ? 'undefined'
    : `content=${definition.content.length} chars, resourceBase=${JSON.stringify(definition.resourceBase)}`,
)

check(
  'runtime registration survives the registry name grammar',
  bundled.every((skill) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name)),
  bundled.map((skill) => skill.name).join(', '),
)

// --- 4. The bootstrap prompt section ---------------------------------------
const assembly = await ctx.systemPrompt.assemble()
const rendered = renderPrompt(assembly)
const order = assembly.sections.map((entry) => entry.name)
const bootstrapAt = order.indexOf('superpowers:bootstrap')
const personaAt = order.indexOf('deployment:persona-prefix')

check(
  'ctx.systemPrompt.section() places the bootstrap after the persona prefix',
  bootstrapAt > personaAt && bootstrapAt !== -1,
  `assembled sections: ${order.join(' | ')}`,
)

// --- 4b. Documented config override against the real services --------------
const quietCtx = new Context()
if (typeof quietCtx.logger?.warn !== 'function') quietCtx.logger = { warn() {} }
new SkillRegistry(quietCtx)
new SystemPrompt(quietCtx, { includeHarnessIdentity: false })
plugin.apply(quietCtx, { bootstrap: false })

const quietAssembly = await quietCtx.systemPrompt.assemble()
check(
  'the documented `config: { bootstrap: false }` override still works',
  (await quietCtx.skills.list()).filter((skill) => skill.source === 'bundled').length === 14 &&
    !quietAssembly.sections.some((entry) => entry.name === 'superpowers:bootstrap'),
  `skills=${(await quietCtx.skills.list()).length}, sections=${quietAssembly.sections.map((s) => s.name).join(' | ')}`,
)

check(
  'the rendered system prompt carries the bootstrap text and the dsh tool mapping',
  rendered.includes('You have superpowers') &&
    rendered.includes('interrupt_agent') &&
    rendered.includes('`str_replace_editor`'),
  `${rendered.length} chars rendered`,
)

// --- 4c. The skill-precedence read the shadow report depends on ------------
// The plugin warns from `ctx.skills.list({cwd, scope})`, the same view the skill
// tool reads, so that read has to report the winner rather than the registration.
const shadowCtx = new Context()
if (typeof shadowCtx.logger?.warn !== 'function') shadowCtx.logger = { warn() {} }
new SkillRegistry(shadowCtx)
new SystemPrompt(shadowCtx, { includeHarnessIdentity: false })

const invocation = { modelInvocable: true, userInvocable: true }
shadowCtx.skills.registerProvider(() => ({
  name: 'probe-project',
  list: async () => [
    {
      name: 'brainstorming',
      description: 'project copy',
      invocation,
      source: 'project-dsh',
      provider: 'probe-project',
      rank: 100,
      locator: {},
    },
  ],
  get: async () => ({
    name: 'brainstorming',
    description: 'project copy',
    invocation,
    source: 'project-dsh',
    provider: 'probe-project',
    content: 'project body',
  }),
}))
plugin.apply(shadowCtx)

const shadowed = (await shadowCtx.skills.list({ cwd: 'E:/work/ai' })).find((skill) => skill.name === 'brainstorming')
check(
  'a project skill outranks the runtime registration in the effective catalog',
  shadowed?.provider === 'probe-project' && shadowed.path === undefined,
  shadowed === undefined ? 'no winner' : `winner=${shadowed.provider} source=${shadowed.source}`,
)

// --- 5. Bundle delivery: manifest field, patch file, patch semantics --------
const appBoot = await load('@deepseek-ai/dsh-app-boot')
const declaredPatch = pluginManifest.dsh?.bundle?.patch

check(
  'package.json declares the `dsh.bundle.patch` field this dsh reads (dsh-app-boot)',
  declaredPatch === './cordis.patch.yml' && existsSync(join(PLUGIN_ROOT, declaredPatch)),
  `dsh.bundle.patch=${JSON.stringify(declaredPatch)}`,
)

const profileDir = resolvePath(
  (process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')),
  'profiles',
  'web',
)
const profileManifestPath = join(profileDir, 'package.json')

if (existsSync(profileManifestPath)) {
  const profileManifest = JSON.parse(readFileSync(profileManifestPath, 'utf8'))
  const bundles = profileManifest.dsh?.profile?.bundles ?? []

  check(
    'the web profile lists this plugin as a bundle',
    bundles.includes(pluginManifest.name),
    bundles.join(' > '),
  )

  try {
    const bundleDir = appBoot.resolveBundleDir('dsh', pluginManifest.name, DSH_PACKAGE, profileDir)
    const composed = appBoot.composeEntries([appBoot.loadOverlayPatches('probe', join(bundleDir, 'cordis.patch.yml'))])
    const row = composed.find((entry) => entry.id === 'superpowers')

    check(
      'the bundle patch composes into a loader row {id: superpowers, name: <package>}',
      row !== undefined && row.name === pluginManifest.name,
      row === undefined ? 'no row inserted' : JSON.stringify(row),
    )
  } catch (error) {
    check('the bundle patch composes into a loader row', false, String(error?.message ?? error))
  }
} else {
  check('profile manifest readable for composition check', false, `missing ${profileManifestPath}`)
}

// --- 6. Loader path: cordis itself resolves `export const inject` ----------
// Calling apply() directly would hide a break in the inject declaration, so
// mount the plugin the way the loader does and watch the deferral happen.
const mounted = new Context()
if (typeof mounted.logger?.warn !== 'function') mounted.logger = { warn() {} }

new SkillRegistry(mounted)
mounted.plugin(plugin)

/** Poll until `predicate` holds or the budget expires. */
const settle = async (predicate, ms = 2000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

await settle(async () => false, 60)
const skillsBeforeSecondService = (await mounted.skills.list()).length

new SystemPrompt(mounted, { includeHarnessIdentity: false })
const appliedAfterBothServices = await settle(async () => (await mounted.skills.list()).length === 14)

check(
  'cordis defers this plugin until BOTH injected services exist, then applies it',
  skillsBeforeSecondService === 0 && appliedAfterBothServices,
  `skills before systemPrompt existed: ${skillsBeforeSecondService}; after: ${(await mounted.skills.list()).length}`,
)

const mountedAssembly = await mounted.systemPrompt.assemble()
check(
  'the mounted plugin contributes the bootstrap section in the live loader path',
  mountedAssembly.sections.some((entry) => entry.name === 'superpowers:bootstrap'),
  mountedAssembly.sections.map((s) => s.name).join(' | '),
)

// --- 7. Surface independence: the same row composes on the headless stack --
// Every shipped template is dsh-base + one app bundle, and the injected
// services come from dsh-base. Compose what a headless profile would mount and
// confirm the plugin's row lands there without a web bundle in the stack.
const bundleLayer = (packageName) => {
  const bundleDir = appBoot.resolveBundleDir('probe', packageName, DSH_PACKAGE, profileDir)
  const declaredPatch = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8')).dsh?.bundle?.patch
  return appBoot.loadOverlayPatches('probe', join(bundleDir, declaredPatch))
}

const pluginBundleDir = appBoot.resolveBundleDir('probe', pluginManifest.name, DSH_PACKAGE, profileDir)
const headlessStack = appBoot.composeEntries([
  bundleLayer('@deepseek-ai/dsh-base'),
  bundleLayer('@deepseek-ai/dsh-headless'),
  appBoot.loadOverlayPatches('probe', join(pluginBundleDir, pluginManifest.dsh.bundle.patch)),
])

const rowById = (id) => headlessStack.find((entry) => entry.id === id)
const serviceRows = ['skill', 'system-prompt'].map((id) => rowById(id))

check(
  'a headless-profile stack still provides both injected services (from dsh-base)',
  serviceRows.every((row) => row !== undefined && row.disabled !== true),
  serviceRows.map((row) => (row === undefined ? 'MISSING' : `${row.id}=${row.name}`)).join(' '),
)

check(
  'the plugin row composes into that headless stack at the root host layer',
  rowById('superpowers')?.name === pluginManifest.name,
  rowById('superpowers') === undefined
    ? 'no row inserted'
    : `root rows: ${headlessStack.map((entry) => entry.id).filter(Boolean).join(', ')}`,
)

process.stdout.write(`\n${failed === 0 ? 'COMPATIBLE' : 'INCOMPATIBLE'}: ${results.length - failed}/${results.length} checks passed\n\n`)
process.exit(failed === 0 ? 0 : 1)
