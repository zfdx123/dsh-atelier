import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { Config, apply } from '../index.js'

const packageRoot = dirname(fileURLToPath(new URL('../index.js', import.meta.url)))

/**
 * Build the smallest context the plugin consumes.
 * @param options - `catalog` replaces the registry's effective view; by default
 *   every registered skill wins, which is the unshadowed deployment.
 * @param options.catalog - the effective skills the registry would report.
 * @returns the context plus the registrations, sections, warnings, and events it observed.
 */
function makeContext(options = {}) {
  const registered = []
  const sections = []
  const warnings = []
  const listeners = new Map()
  return {
    ctx: {
      skills: {
        register(skill) {
          registered.push(skill)
          return () => {}
        },
        async list() {
          if (typeof options.catalog === 'function') return options.catalog()
          if (options.catalog !== undefined) return options.catalog
          return registered.map((skill) => ({
            name: skill.name,
            description: skill.description,
            provider: skill.provider ?? 'runtime',
            source: skill.source,
            path: skill.path,
          }))
        },
      },
      systemPrompt: {
        section(section) {
          sections.push(section)
          return () => {}
        },
      },
      logger: {
        warn(message) {
          warnings.push(message)
        },
      },
      on(event, listener) {
        listeners.set(event, listener)
        return () => {}
      },
    },
    registered,
    sections,
    warnings,
    listeners,
  }
}

/** One agent shape the skill lookup reads: a scope key plus its session cwd. */
function makeAgent(cwd = 'E:/work/ai') {
  return { id: 'agent-1', session: { header: { cwd } } }
}

function readCurrentScalar(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))
  assert.notEqual(match, null, `${key} should exist in source frontmatter`)
  const value = match[1].trim()
  if (value.startsWith('"')) return JSON.parse(value)
  if (value.startsWith("'")) return value.slice(1, -1).replace(/''/g, "'")
  return value
}

async function writeSkill(root, directory, frontmatter, body = '# Fixture\n\nInstructions.') {
  const skillDir = join(root, 'skills', directory)
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}\n`)
}

/**
 * Place a copy of the plugin in a fixture root so `skills/` resolves there.
 * The copy still imports the declared schema dependency, so the fixture needs
 * the same `node_modules` the real module resolves from.
 * @param root - the fixture root that receives `index.mjs` and `node_modules`.
 */
async function copyPluginInto(root) {
  await copyFile(join(packageRoot, 'index.js'), join(root, 'index.mjs'))
  const modules = join(packageRoot, 'node_modules')
  if (existsSync(modules)) await symlink(modules, join(root, 'node_modules'), 'junction')
}

test('registers all vendored skills with source-accurate metadata', async () => {
  const state = makeContext()
  apply(state.ctx)

  const entries = (await readdir(join(packageRoot, 'skills'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))

  assert.equal(entries.length, 14)
  assert.equal(state.registered.length, 14)
  assert.deepEqual(state.warnings, [])
  assert.equal(state.sections.length, 1)
  assert.match(state.sections[0].text, /`interrupt_agent`/)

  for (const entry of entries) {
    const raw = await readFile(join(packageRoot, 'skills', entry.name, 'SKILL.md'), 'utf8')
    const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    assert.notEqual(frontmatter, null)

    const expectedName = readCurrentScalar(frontmatter[1], 'name')
    const expectedDescription = readCurrentScalar(frontmatter[1], 'description')
    const actual = state.registered.find((skill) => skill.name === expectedName)
    assert.notEqual(actual, undefined, `${expectedName} should be registered`)
    assert.equal(actual.description, expectedDescription)
    assert.equal(actual.path, join(packageRoot, 'skills', entry.name, 'SKILL.md'))
    assert.equal(actual.resourceBase.path, join(packageRoot, 'skills', entry.name))
  }
})

test('parses folded and literal YAML block scalars', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-superpowers-parser-'))
  try {
    await copyPluginInto(fixtureRoot)
    await writeSkill(
      fixtureRoot,
      'folded',
      [
        'name: folded',
        'description: >-',
        '  Use when a future release',
        '  wraps its description.',
        '',
        '  Preserve paragraphs.',
        'whenToUse: >-',
        '  During metadata',
        '  compatibility tests.',
      ].join('\n'),
    )
    await writeSkill(
      fixtureRoot,
      'literal',
      ['name: literal', 'description: |-', '  first line', '  second line'].join('\n'),
    )
    await writeSkill(
      fixtureRoot,
      'indented',
      ['name: indented', 'description: >-', '  first', '    indented', '  last'].join('\n'),
    )

    const fixture = await import(`${pathToFileURL(join(fixtureRoot, 'index.mjs')).href}?fixture=${Date.now()}`)
    const state = makeContext()
    fixture.apply(state.ctx, { bootstrap: false })

    assert.deepEqual(state.warnings, [])
    assert.equal(
      state.registered.find((skill) => skill.name === 'folded').description,
      'Use when a future release wraps its description.\nPreserve paragraphs.',
    )
    assert.equal(
      state.registered.find((skill) => skill.name === 'folded').whenToUse,
      'During metadata compatibility tests.',
    )
    assert.equal(state.registered.find((skill) => skill.name === 'literal').description, 'first line\nsecond line')
    assert.equal(state.registered.find((skill) => skill.name === 'indented').description, 'first\n  indented\nlast')
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('warns and skips damaged or duplicate skill metadata', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-superpowers-errors-'))
  try {
    await copyPluginInto(fixtureRoot)
    await writeSkill(fixtureRoot, 'a-valid', 'name: duplicate\ndescription: first')
    await writeSkill(fixtureRoot, 'b-duplicate', 'name: duplicate\ndescription: second')
    await writeSkill(fixtureRoot, 'missing-description', 'name: missing-description')
    await writeSkill(fixtureRoot, 'empty-body', 'name: empty-body\ndescription: empty', '')

    const fixture = await import(`${pathToFileURL(join(fixtureRoot, 'index.mjs')).href}?fixture=${Date.now()}`)
    const state = makeContext()
    fixture.apply(state.ctx, { bootstrap: false })

    assert.deepEqual(
      state.registered.map((skill) => skill.name),
      ['duplicate'],
    )
    assert.equal(state.warnings.length, 3)
    assert.ok(state.warnings.some((message) => message.includes('duplicates skill name "duplicate"')))
    assert.ok(state.warnings.some((message) => message.includes('requires non-empty name and description')))
    assert.ok(state.warnings.some((message) => message.includes('empty instruction body')))
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('does no filesystem or registry work when both features are disabled', () => {
  assert.doesNotThrow(() => apply({}, { skills: false, bootstrap: false }))
})

test('exports a config schema that defaults every documented option', () => {
  assert.deepEqual(Config({}), { skills: true, bootstrap: true, toolMapping: true, order: 50 })
  assert.deepEqual(Config({ bootstrap: false, order: 10 }), {
    skills: true,
    bootstrap: false,
    toolMapping: true,
    order: 10,
  })
})

test('rejects a malformed configuration instead of applying a guess', () => {
  assert.throws(() => Config({ order: 'first' }), TypeError)
  assert.throws(() => Config({ skills: 'yes' }), TypeError)
  assert.throws(() => apply(makeContext().ctx, { order: 'first' }), TypeError)
})

test('warns when a higher-priority skill shadows a bundled one', async () => {
  const state = makeContext({
    catalog: [
      {
        name: 'brainstorming',
        description: 'project copy',
        provider: 'filesystem',
        source: 'project-dsh',
        path: 'E:/work/ai/.dsh/skills/brainstorming/SKILL.md',
      },
    ],
  })
  apply(state.ctx)

  await state.listeners.get('agent/created')({ agent: makeAgent() })

  const report = state.warnings.join('\n')
  assert.match(report, /brainstorming/)
  assert.match(report, /project-dsh/)
  assert.match(report, /filesystem/)
  assert.match(report, /E:\/work\/ai\/\.dsh\/skills\/brainstorming\/SKILL\.md/)
})

test('stays quiet when every bundled skill wins its own name', async () => {
  const state = makeContext()
  apply(state.ctx)

  await state.listeners.get('agent/created')({ agent: makeAgent() })
  await state.listeners.get('agent/created')({ agent: makeAgent('E:/other') })

  assert.deepEqual(state.warnings, [])
})

test('reports one shadowing warning per workspace, not one per agent', async () => {
  const state = makeContext({
    catalog: [
      {
        name: 'brainstorming',
        description: 'project copy',
        provider: 'filesystem',
        source: 'project-dsh',
        path: 'E:/work/ai/.dsh/skills/brainstorming/SKILL.md',
      },
    ],
  })
  apply(state.ctx)

  await state.listeners.get('agent/created')({ agent: makeAgent() })
  await state.listeners.get('agent/created')({ agent: makeAgent() })
  assert.equal(state.warnings.length, 1)

  await state.listeners.get('agent/created')({ agent: makeAgent('E:/elsewhere') })
  assert.equal(state.warnings.length, 2)
})

test('reports a failing skill lookup without failing agent creation', async () => {
  const state = makeContext({
    catalog: () => {
      throw new Error('provider exploded')
    },
  })
  apply(state.ctx)

  await assert.doesNotReject(async () => state.listeners.get('agent/created')({ agent: makeAgent() }))
  assert.equal(state.warnings.length, 1)
  assert.match(state.warnings[0], /provider exploded/)
})

test('documents the prompt-order placement the same way in code and both READMEs', async () => {
  const sources = ['index.js', 'README.md', 'README.en.md']
  for (const source of sources) {
    const text = await readFile(join(packageRoot, source), 'utf8')
    assert.doesNotMatch(text, /100\s*[–-]\s*199/, `${source} still claims the stale tool-guidance band`)
    assert.match(text, /[(（]500[)）]/, `${source} should name the plan policy's order`)
    assert.match(text, /1000\+/, `${source} should state where tool guidance starts`)
  }
})

test('keeps the English and Chinese READMEs structurally in sync', async () => {
  const [chinese, english] = await Promise.all(
    ['README.md', 'README.en.md'].map((file) => readFile(join(packageRoot, file), 'utf8')),
  )
  for (const pattern of [/^#{2,3} /gm, /^\| /gm, /^```/gm, /^```sh$/gm]) {
    assert.equal(
      [...english.matchAll(pattern)].length,
      [...chinese.matchAll(pattern)].length,
      `README.en.md and README.md disagree on ${pattern}`,
    )
  }
})

test('ships every path its test script and manifest reference', async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.scripts.test, 'node --test')
  assert.ok(
    manifest.files.some((entry) => entry === 'test' || entry.startsWith('test/')),
    'package.json files[] must ship test/ so `npm test` finds the suite in the tarball',
  )
  for (const entry of manifest.files) {
    if (entry.includes('*')) continue
    assert.ok(existsSync(join(packageRoot, entry)), `files[] names a missing path: ${entry}`)
  }
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    assert.ok(
      existsSync(join(packageRoot, 'node_modules', ...dependency.split('/'))),
      `declared dependency ${dependency} is not installed in this checkout`,
    )
  }
})
