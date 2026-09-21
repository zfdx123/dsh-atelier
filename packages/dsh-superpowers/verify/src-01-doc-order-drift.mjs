#!/usr/bin/env node
/**
 * SRC-01 drift probe: do the documented `order` neighbours still match the
 * prompt-section orders of the installed DSH?
 *
 * Why this exists: README.md:64, README.zh.md:64 and the `DEFAULT_ORDER` JSDoc
 * in index.js:36-38 all state that the bootstrap sits after the deployment
 * persona prefix (0) and before the plan policy (500) and tool guidance
 * (1000+). An earlier revision of those three sites claimed the tool guidance
 * lived in 100–199 — that band belongs to `CONTEXT_ORDERS` (dynamic runtime
 * context), and the claim would have led a maintainer to place the section
 * after the tools. The probe therefore checks both halves: that every site
 * still states the current neighbours, and that the installed dsh still has
 * them, so the plugin's default of 50 stays correctly placed.
 *
 * Read-only: reads source files, starts nothing, writes nothing, no network.
 *
 * Usage:
 *   node verify/src-01-doc-order-drift.mjs [plugin-root] [dsh-system-prompt-lib]
 *
 * Exit code 0 = the documented neighbours match the installed DSH.
 * Exit code 1 = drift: a site is stale, or the installed orders moved.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PLUGIN_ROOT = resolve(process.argv[2] ?? 'E:/work/ai/dsh-superpowers')
const DSH_SYSTEM_PROMPT = resolve(
  process.argv[3] ??
    'D:/Development_dependency/npm_prefix/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js',
)
const DSH_PACKAGE = resolve(
  process.argv[3] !== undefined
    ? resolve(process.argv[3], '../../../../../package.json')
    : 'D:/Development_dependency/npm_prefix/node_modules/@deepseek-ai/dsh/package.json',
)

const read = (path) => readFileSync(path, 'utf8')
const failures = []

/** Every source site that states the bootstrap's neighbours. */
const claimSites = [
  { file: 'README.md', match: /^\|\s*`order`\s*\|.*$/m },
  { file: 'README.zh.md', match: /^\|\s*`order`\s*\|.*$/m },
  { file: 'index.js', match: /^ \* \(0\), and before the plan policy.*$/m },
].map((site) => {
  const source = read(resolve(PLUGIN_ROOT, site.file))
  const found = site.match.exec(source)
  const line = found === null ? -1 : source.slice(0, found.index).split('\n').length
  return { ...site, line, text: found === null ? '' : found[0] }
})

/** The numeric value declared on a `NAME: value` row inside the section table. */
const orderOf = (source, name) => {
  const match = new RegExp(`\\b${name}\\s*:\\s*([\\d.e+]+)`).exec(source)
  return match === null ? Number.NaN : Number(match[1])
}

const dshSource = read(DSH_SYSTEM_PROMPT)
const toolOrders = [...dshSource.matchAll(/\bTOOL_[A-Z_]+\s*:\s*([\d.e+]+)/g)].map((match) => Number(match[1]))
const personaPrefix = orderOf(dshSource, 'DEPLOYMENT_PERSONA_PREFIX')
const planPolicy = orderOf(dshSource, 'PLAN_POLICY')
const contextOrders = [...dshSource.matchAll(/\b(?:SANDBOX_POLICY|APPROVAL_POLICY|SUBAGENT_DELEGATION)\s*:\s*([\d.e+]+)/g)].map(
  (match) => Number(match[1]),
)

const pluginSource = read(resolve(PLUGIN_ROOT, 'index.js'))
const pluginDefault = Number(/const DEFAULT_ORDER\s*=\s*(-?\d+)/.exec(pluginSource)[1])
const lowestToolOrder = Math.min(...toolOrders)

const claimedPlanPolicy = 500
const claimedToolFloor = 1000

process.stdout.write(`\nsrc-01 doc/order drift probe\n`)
process.stdout.write(`  dsh              ${JSON.parse(read(DSH_PACKAGE)).version}\n`)
process.stdout.write(`  plugin           ${JSON.parse(read(resolve(PLUGIN_ROOT, 'package.json'))).version}\n\n`)

for (const site of claimSites) {
  process.stdout.write(`  ${site.file}:${site.line}\n    ${site.text.trim()}\n`)
  if (site.text === '') failures.push(`${site.file} no longer states the bootstrap's neighbours`)
  else if (!site.text.includes(String(claimedPlanPolicy)) || !site.text.includes(`${claimedToolFloor}+`)) {
    failures.push(`${site.file}:${site.line} does not state ${claimedPlanPolicy} and ${claimedToolFloor}+`)
  }
}

process.stdout.write(`\n  documented band    : persona prefix (0) < bootstrap < plan policy (${claimedPlanPolicy}) < tool guidance (${claimedToolFloor}+)\n`)
process.stdout.write(
  `  actual TOOL_*      : ${lowestToolOrder} .. ${Math.max(...toolOrders)} (${toolOrders.length} sections)\n`,
)
process.stdout.write(`  CONTEXT_ORDERS band: ${contextOrders.join(', ')}  <- the band the stale claim mistook for tools\n`)
process.stdout.write(`  actual PLAN_POLICY : ${planPolicy}\n`)

if (planPolicy !== claimedPlanPolicy) failures.push(`installed PLAN_POLICY is ${planPolicy}, docs claim ${claimedPlanPolicy}`)
if (lowestToolOrder !== claimedToolFloor) failures.push(`installed tool guidance starts at ${lowestToolOrder}, docs claim ${claimedToolFloor}`)

const defaultStillCorrect =
  pluginDefault > personaPrefix &&
  pluginDefault < planPolicy &&
  pluginDefault < lowestToolOrder
if (!defaultStillCorrect) failures.push(`default order ${pluginDefault} is no longer inside the documented band`)

process.stdout.write(
  `  plugin default     : ${pluginDefault} -> ${personaPrefix} < ${pluginDefault} < ${planPolicy} < ${lowestToolOrder} = ${defaultStillCorrect}\n\n`,
)

process.stdout.write(
  failures.length === 0
    ? `NO DRIFT: every site states the installed neighbours, and default order ${pluginDefault} sits between them.\n\n`
    : `DRIFT: ${failures.map((failure) => `\n  - ${failure}`).join('')}\n\n`,
)

process.exit(failures.length === 0 ? 0 : 1)
