/**
 * Superpowers for DeepSeek Harness.
 *
 * Brings the Superpowers software-development methodology (obra/superpowers) to
 * dsh: the bundled skills are registered as runtime skills on `ctx.skills`, and
 * the `using-superpowers` bootstrap is registered as a prompt section so it is
 * present from the first request and survives context compaction.
 *
 * Both registries are reached through `ctx` alone — a third-party plugin cannot
 * rely on a `@deepseek-ai/*` service package resolving from its own directory,
 * because they are nested inside the dsh installation. The one exception is the
 * config-schema package, which is a declared dependency of this package and
 * therefore resolves from this package's own tree.
 *
 * @module dsh-superpowers
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import Schema from '@deepseek-ai/schemastery'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'superpowers'

/** The prompt and skill registries this plugin registers into. */
export const inject = ['systemPrompt', 'skills']

const packageRoot = dirname(fileURLToPath(import.meta.url))
const skillsDir = resolve(packageRoot, 'skills')
const BOOTSTRAP_SKILL = 'using-superpowers'
const BOOTSTRAP_SECTION = 'superpowers:bootstrap'

/**
 * Prompt order of the bootstrap section: after the deployment persona prefix
 * (0), and before the plan policy (500) and the tool guidance at 1000+.
 * `verify/src-01-doc-order-drift.mjs` re-checks that placement against the
 * installed dsh.
 */
const DEFAULT_ORDER = 50

/**
 * Plugin configuration. Every deployment-varying choice is a validated field:
 * cordis resolves these defaults and rejects a malformed override before
 * {@link apply} runs, instead of failing the fiber halfway through setup.
 */
export const Config = Schema.object({
  /** Register the bundled skills on `ctx.skills`. */
  skills: Schema.boolean().default(true),
  /** Register the `using-superpowers` bootstrap prompt section. */
  bootstrap: Schema.boolean().default(true),
  /** Append the DeepSeek Harness tool mapping to the bootstrap section. */
  toolMapping: Schema.boolean().default(true),
  /** Prompt order of the bootstrap section; the registry rejects a non-finite value. */
  order: Schema.number().default(DEFAULT_ORDER),
})

/**
 * Split a `SKILL.md` into its frontmatter block and body.
 * @param content - the raw file text.
 * @returns the frontmatter text (empty when absent) and the trimmed body.
 */
function splitFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (match === null) return { frontmatter: '', body: content.trim() }
  return { frontmatter: match[1], body: match[2].trim() }
}

/** Count the leading ASCII spaces on one YAML line. */
function leadingSpaces(line) {
  return line.length - line.trimStart().length
}

/**
 * Parse a YAML block-scalar header from a value such as `>-`, `|+`, or `>2-`.
 * @returns the scalar controls, or undefined for an ordinary scalar.
 */
function parseBlockHeader(value) {
  const match = value.match(/^([|>])(?:(?:([1-9])([+-]?))|(?:([+-])([1-9]?)))?(?:\s+#.*)?$/)
  if (match === null) return undefined
  return {
    style: match[1],
    indentation: Number(match[2] || match[5] || 0),
    chomping: match[3] || match[4] || '',
  }
}

/** Fold non-empty YAML lines while preserving paragraph and indented breaks. */
function foldBlockLines(lines, moreIndented) {
  let value = ''
  for (let index = 0; index < lines.length;) {
    if (lines[index] === '') {
      let end = index
      while (end < lines.length && lines[end] === '') end += 1
      value += '\n'.repeat(end - index)
      index = end
      continue
    }

    value += lines[index]
    const next = index + 1
    if (next < lines.length && lines[next] !== '') {
      value += moreIndented[index] || moreIndented[next] ? '\n' : ' '
    }
    index = next
  }
  return value
}

/**
 * Read one top-level YAML block scalar and return the next unconsumed line.
 * This deliberately implements only scalar semantics needed by skill metadata,
 * while covering literal/folded styles, indentation indicators, and chomping.
 */
function readBlockScalar(lines, start, header) {
  let end = start
  while (end < lines.length && (lines[end].trim() === '' || lines[end].startsWith(' '))) {
    end += 1
  }

  const rawLines = lines.slice(start, end)
  const firstContent = rawLines.find((line) => line.trim() !== '')
  const indentation = header.indentation || (firstContent === undefined ? 1 : leadingSpaces(firstContent))

  for (const line of rawLines) {
    if (line.trim() !== '' && leadingSpaces(line) < indentation) {
      throw new Error('invalid block-scalar indentation')
    }
  }

  const contentLines = rawLines.map((line) => (line.trim() === '' ? '' : line.slice(indentation)))
  const moreIndented = rawLines.map((line) => line.trim() !== '' && leadingSpaces(line) > indentation)
  const hasContent = contentLines.some((line) => line !== '')
  let value = header.style === '|' ? contentLines.join('\n') : foldBlockLines(contentLines, moreIndented)

  if (rawLines.length > 0) value += '\n'
  if (header.chomping === '-') {
    value = value.replace(/\n+$/, '')
  } else if (header.chomping !== '+') {
    value = hasContent ? `${value.replace(/\n+$/, '')}\n` : ''
  }

  return { value, nextLine: end }
}

/** Parse one quoted or plain YAML scalar. */
function parseInlineScalar(value) {
  if (value.startsWith('"')) {
    if (!value.endsWith('"')) throw new Error('unterminated double-quoted scalar')
    return JSON.parse(value)
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) throw new Error('unterminated single-quoted scalar')
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value.replace(/\s+#.*$/, '').trim()
}

/**
 * Read the scalar frontmatter keys a Superpowers skill declares. Besides the
 * current one-line metadata, support YAML literal and folded block scalars so
 * a future vendored release cannot silently turn `description: >-` into `>-`.
 * @param frontmatter - the frontmatter text.
 * @returns the parsed string values by key.
 */
function parseFrontmatter(frontmatter) {
  const fields = {}
  const lines = frontmatter.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/)
    if (match === null) continue

    const rawValue = match[2].trim()
    const block = parseBlockHeader(rawValue)
    if (block !== undefined) {
      const parsed = readBlockScalar(lines, index + 1, block)
      fields[match[1]] = parsed.value
      index = parsed.nextLine - 1
      continue
    }

    if (rawValue !== '') fields[match[1]] = parseInlineScalar(rawValue)
  }
  return fields
}

/**
 * Load every bundled skill.
 * @returns one entry per readable skill directory.
 */
function loadBundledSkills() {
  const skills = []
  const issues = []
  let entries
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true })
  } catch (error) {
    issues.push(`cannot read skills directory ${skillsDir}: ${error instanceof Error ? error.message : String(error)}`)
    return { skills, issues }
  }

  const seen = new Map()
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillDir = join(skillsDir, entry.name)
    const skillPath = join(skillDir, 'SKILL.md')
    let raw
    try {
      raw = readFileSync(skillPath, 'utf8')
    } catch (error) {
      issues.push(`cannot read ${skillPath}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }

    const { frontmatter, body } = splitFrontmatter(raw)
    if (frontmatter === '') {
      issues.push(`${skillPath} has no valid frontmatter`)
      continue
    }

    let fields
    try {
      fields = parseFrontmatter(frontmatter)
    } catch (error) {
      issues.push(`cannot parse ${skillPath}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }

    const skillName = fields.name
    const description = fields.description
    if (skillName === undefined || description === undefined || description === '') {
      issues.push(`${skillPath} requires non-empty name and description fields`)
      continue
    }
    if (body === '') {
      issues.push(`${skillPath} has an empty instruction body`)
      continue
    }
    if (seen.has(skillName)) {
      issues.push(`${skillPath} duplicates skill name "${skillName}" from ${seen.get(skillName)}`)
      continue
    }
    seen.set(skillName, skillPath)

    skills.push({
      name: skillName,
      description,
      ...(fields.whenToUse === undefined ? {} : { whenToUse: fields.whenToUse }),
      content: body,
      source: 'bundled',
      path: skillPath,
      resourceBase: { kind: 'directory', path: skillDir },
    })
  }
  return { skills, issues }
}

/**
 * The dsh tool vocabulary Superpowers instructions map onto. Superpowers is
 * written against several harnesses and names Claude Code's PascalCase tools;
 * without this mapping a skill tells the model to call tools that do not exist
 * here.
 * @returns the mapping section text.
 */
function dshToolMapping() {
  return `## DeepSeek Harness tool mapping

Superpowers skills are written for several coding agents. In DeepSeek Harness, use these tools:

- Invoke a skill → the native \`skill\` tool; every Superpowers skill is already in your skill catalog, so never read a \`SKILL.md\` by hand
- Read a file → \`read\` (\`read_image\` for images)
- Create or overwrite a file → \`write\`
- Modify an existing file → \`edit\`, or \`str_replace_editor\` where it is offered
- Run a shell command → \`bash\`; for long work pass \`run_in_background\`, then collect it with \`job_output\`, \`job_list\`, and \`job_kill\`
- Find files by path pattern → \`glob\`
- Search file contents → \`grep\`
- Track tasks → \`todo_write\`
- Ask the human a question → \`ask_user_question\`
- Search the web → \`web_search\`
- Dispatch a subagent → \`subagent\` for a fresh child, \`subagent_fork\` to continue from this session; steer children with \`send_message\`, \`interrupt_agent\`, and \`list_agents\`
- Present a plan for approval → \`exit_plan_mode\`, while the session is in plan mode

Read Claude Code's \`Task\` as \`subagent\`, \`TodoWrite\` as \`todo_write\`, and \`Bash\`/\`Read\`/\`Write\`/\`Edit\`/\`Glob\`/\`Grep\` as their lowercase equivalents above. DeepSeek Harness exposes no hook or slash-command API to skills, so skip instructions that install hooks or register commands and do the work with these tools instead.`
}

/**
 * Build the bootstrap text.
 * @param bootstrapBody - the `using-superpowers` body, without frontmatter.
 * @param includeToolMapping - whether to append the dsh tool mapping.
 * @returns the prompt section text.
 */
function buildBootstrap(bootstrapBody, includeToolMapping) {
  const mapping = includeToolMapping ? `\n\n${dshToolMapping()}` : ''
  return `<EXTREMELY_IMPORTANT>
You have superpowers.

The using-superpowers skill content is included below and is already loaded for this session. Follow it now. Do not load using-superpowers again through the skill tool.

${bootstrapBody}${mapping}
</EXTREMELY_IMPORTANT>`
}

/**
 * Report bundled skills whose name a higher-priority skill owns.
 *
 * The registry resolves precedence when it collects a catalog, and only there:
 * a project skill outranks this plugin's runtime registration, and a preset's
 * own skill outranks it outright. Neither is an error — a deployment may shadow
 * on purpose — but a shadowed skill must not be invisible, which is what this
 * report exists for. It runs once per workspace, because every subagent of a
 * session shares its parent's composition and would repeat the same warning.
 *
 * @param ctx - plugin context; used for the catalog read and the warning.
 * @param agent - the agent whose catalog view to check.
 * @param bundled - the skills this plugin registered.
 * @param reported - signatures already warned about, kept per plugin instance.
 */
async function reportShadowedSkills(ctx, agent, bundled, reported) {
  const cwd = agent?.session?.header?.cwd
  const owned = new Map(bundled.map((skill) => [skill.name, skill.path]))
  const visible = await ctx.skills.list({ cwd, scope: agent })
  const shadowed = visible.filter((skill) => owned.has(skill.name) && skill.path !== owned.get(skill.name))
  if (shadowed.length === 0) return

  const signature = `${cwd ?? ''}\u0000${shadowed
    .map((skill) => `${skill.name}:${skill.provider}:${skill.source}:${skill.path ?? ''}`)
    .sort()
    .join('|')}`
  if (reported.has(signature)) return
  reported.add(signature)

  const winners = shadowed
    .map((skill) => {
      const at = skill.path === undefined ? '' : ` at ${skill.path}`
      return `"${skill.name}" from ${skill.source} (provider "${skill.provider}")${at}`
    })
    .join(', ')
  const where = cwd === undefined ? '' : ` in ${cwd}`
  const count = shadowed.length
  ctx.logger.warn(
    `superpowers: ${count} bundled skill${count === 1 ? '' : 's'} shadowed${where}; the model loads ${winners} instead`,
  )
}

/**
 * Register the bundled skills, the per-agent shadow report, and the bootstrap
 * prompt section.
 * @param ctx - plugin context; every registration is disposed with it.
 * @param config - plugin configuration; unset fields take their schema defaults.
 */
export function apply(ctx, config) {
  const options = Config(config)
  if (!options.skills && !options.bootstrap) return

  const { skills: bundled, issues } = loadBundledSkills()
  for (const issue of issues) ctx.logger.warn(`superpowers: ${issue}`)

  if (bundled.length === 0) {
    ctx.logger.warn(`superpowers: no valid skills found under ${skillsDir}`)
  }

  if (options.skills) {
    for (const skill of bundled) ctx.skills.register(skill)

    const reported = new Set()
    ctx.on('agent/created', async ({ agent }) => {
      try {
        await reportShadowedSkills(ctx, agent, bundled, reported)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`superpowers: cannot check the skill catalog of agent "${agent?.id}": ${reason}`)
      }
    })
  }

  if (!options.bootstrap) return

  const bootstrap = bundled.find((skill) => skill.name === BOOTSTRAP_SKILL)
  if (bootstrap === undefined) {
    ctx.logger.warn(`superpowers: ${BOOTSTRAP_SKILL} is missing; the bootstrap section is not registered`)
    return
  }

  // A preset whose persona declares itself the complete section owns the whole
  // system prompt, and the registry drops this section in that scope without an
  // error; no published API reports that decision, so the registration stands
  // and the limitation is documented in the README instead.
  ctx.systemPrompt.section({
    name: BOOTSTRAP_SECTION,
    order: options.order,
    text: buildBootstrap(bootstrap.content, options.toolMapping),
  })
}
