#!/usr/bin/env node
/**
 * SRC-02 mechanism probe: does a preset that owns the complete system prompt
 * still drop this plugin's bootstrap section in the installed DSH?
 *
 * Why this exists: README.md "已知限制" and README.en.md "Limitations" record
 * that a preset whose persona declares `complete: true` — the bundled `minimal`
 * preset does — replaces the whole system prompt, so `superpowers:bootstrap` is
 * never delivered there. That claim is about DSH's registry, not about this
 * plugin, so the plugin cannot test it with its own stubs: this probe mounts the
 * REAL `SystemPrompt`, `SkillRegistry`, and scope machinery, applies the plugin
 * exactly as the loader does, and then assembles a scope that carries a complete
 * persona section the way `@deepseek-ai/dsh-persona` registers one.
 *
 * The probe asserts the documented behaviour, including the part that rules out
 * every plugin-side workaround: a `system-prompt/assemble` listener cannot put
 * prompt text back into a scope with a complete section.
 *
 * Read-only: reads source files and mounts in-process services, starts no
 * profile, writes nothing, no network.
 *
 * Usage:
 *   node verify/src-02-complete-persona-shadow.mjs [path/to/dsh/package.json]
 *
 * Exit code 0 = the documented limitation still holds.
 * Exit code 1 = the mechanism changed; the READMEs are now stale.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_PACKAGE = resolve(
  process.argv[2] ?? 'D:/Development_dependency/npm_prefix/node_modules/@deepseek-ai/dsh/package.json',
)

/** Resolve a package the way the running dsh resolves it, then import it. */
const dshRequire = createRequire(DSH_PACKAGE)
const load = (specifier) => import(pathToFileURL(dshRequire.resolve(specifier)).href)

const BOOTSTRAP = 'superpowers:bootstrap'
const PERSONA = 'deployment:persona-prefix'
const failures = []

/**
 * Record one mechanism check.
 * @param label - the documented behaviour being asserted.
 * @param ok - whether it held.
 * @param detail - evidence printed beside the verdict.
 */
const check = (label, ok, detail) => {
  if (!ok) failures.push(label)
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        ${detail}\n`)
}

const dshManifest = JSON.parse(readFileSync(DSH_PACKAGE, 'utf8'))
const pluginManifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'))

process.stdout.write(`\nsrc-02 complete-persona shadow probe\n`)
process.stdout.write(`  dsh         ${dshManifest.name}@${dshManifest.version}\n`)
process.stdout.write(`  plugin      ${pluginManifest.name}@${pluginManifest.version}\n\n`)

const { Context } = await load('@deepseek-ai/cordis')
const { SkillRegistry } = await load('@deepseek-ai/dsh-skill')
const { SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
const { createScope } = await load('@deepseek-ai/dsh-scope')
const plugin = await import(pathToFileURL(join(PLUGIN_ROOT, 'index.js')).href)

const ctx = new Context()
new SkillRegistry(ctx)
new SystemPrompt(ctx, { includeHarnessIdentity: false })
plugin.apply(ctx)

/** Mint one agent-like scope under the host context. */
const mint = (key) => createScope(ctx, key)

const presetKey = { preset: 'minimal' }
const presetScope = mint(presetKey)
presetScope.ctx.systemPrompt.section({
  name: PERSONA,
  order: presetScope.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
  text: 'You are a helpful software engineer assistant.',
  complete: true,
})

const plainKey = { preset: 'standard' }
mint(plainKey)

// A listener that tries to put the bootstrap back, the way a plugin-side
// workaround would have to.
ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
  const assembled = await next()
  return { ...assembled, sections: [...assembled.sections, { name: 'workaround:bootstrap', text: 'You have superpowers.' }] }
})

const hostSections = (await ctx.systemPrompt.assemble()).sections.map((section) => section.name)
const plainSections = (await ctx.systemPrompt.assemble({ scope: plainKey })).sections.map((section) => section.name)
const presetSections = (await ctx.systemPrompt.assemble({ scope: presetKey })).sections.map((section) => section.name)

check(
  'the host scope delivers the bootstrap section',
  hostSections.includes(BOOTSTRAP),
  `sections: ${hostSections.join(' | ')}`,
)
check(
  'a preset scope without a complete persona also delivers it',
  plainSections.includes(BOOTSTRAP),
  `sections: ${plainSections.join(' | ')}`,
)
check(
  'a preset scope with a complete persona delivers that section alone',
  presetSections.length === 1 && presetSections[0] === PERSONA,
  `sections: ${presetSections.join(' | ')}`,
)
check(
  'an assembly listener cannot add prompt text to that scope',
  !presetSections.includes('workaround:bootstrap'),
  `listener-added section survived: ${presetSections.includes('workaround:bootstrap')}`,
)

process.stdout.write(
  failures.length === 0
    ? `\nLIMITATION HOLDS: ${PERSONA} with complete: true is the sole prompt section, so ${BOOTSTRAP} is dropped there and no listener can restore it.\n\n`
    : `\nMECHANISM CHANGED: ${failures.length} documented behaviour(s) no longer hold; update README.md and README.en.md.\n\n`,
)

process.exit(failures.length === 0 ? 0 : 1)
